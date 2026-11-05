// @vitest-environment jsdom
/**
 * useBgTaskSeed —— 补侧栏的「后台任务还在跑」（`bg_task` 是事件：窗口重建、web 客户端连上来之前发的都错过了，切会话的快照
 * 又只补当前那一条）。契约：挂载时取一份 `bgTask.listAll()`、`session.listChanged` 时再取一份，整张表换掉；取失败保持现状。
 *
 *   BGS-1 挂载取一次：不是当前会话的任务也进 store，selectBgBusySessions 亮
 *   BGS-2 session.listChanged 重取：结束了 / 没了的任务键随之消失；别的事件不取
 *   BGS-3 拒绝（not_connected / disconnected / 处理函数报错）：同一个 tasks 引用、没有未处理的拒绝；下一个信号补好
 *   BGS-4 卸载之后不再取
 *   BGS-5 真 createWsConnection + 假 socket：第一次连上发排着的那次（恰一次，args 是空的）；重连再取（断线期间结束的灭、新的亮）；
 *         断着时挂载当场被拒（没发帧）、重连补好；服务端回来时注册表已空 → 表清空
 *
 * store、hook 与 `@shuvix/chat-ui` 都是真的；只有后端是假的（BGS-5 是线协议上的假服务端）。桌面 vitest 对渲染层只收
 * `*.test.ts`（本文件自己切 jsdom），不带 react 插件 —— 一律 createElement。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { selectBgBusySessions, setChatApi, useBgTaskStore } from '@shuvix/chat-ui'
import type { AppEvent } from '@shuvix/chat-protocol/appEvents'
import type { ChatApi } from '@shuvix/chat-protocol/chatApi'
import type { TaskInfo } from '@shuvix/chat-protocol/types/task'
import {
  decodeClientMessage,
  encodeServerMessage,
  type ClientMessage,
  type ServerMessage
} from '../../../../shared/networkEnvelope'
import { useBgTaskSeed } from '../useBgTaskSeed'
import { createWebApi } from '../../web/webApi'
import {
  createWsConnection,
  type WebSocketLike,
  type WsConnection,
  type WsTimers
} from '../../web/wsConnection'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root | undefined

function Harness(): null {
  useBgTaskSeed()
  return null
}

const mount = (): void => {
  root = createRoot(container)
  act(() => root!.render(createElement(Harness)))
}
const unmount = (): void => {
  act(() => root?.unmount())
  root = undefined
}
const flush = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve()
  })
}
const busy = (): Record<string, boolean> => selectBgBusySessions(useBgTaskStore.getState())

function running(taskId: string, sessionId: string): TaskInfo {
  return {
    taskId,
    kind: 'bash',
    sessionId,
    title: taskId,
    status: 'running',
    detached: true,
    startedAt: 1,
    endedAt: null,
    subject: {
      kind: 'bash',
      command: 'sleep 9',
      cwd: '/tmp',
      pid: 1,
      logPath: '/tmp/x.log',
      exitCode: null,
      signal: null,
      logCapped: false
    }
  }
}
const finished = (task: TaskInfo): TaskInfo => ({ ...task, status: 'done', endedAt: 2 })

beforeEach(() => {
  useBgTaskStore.setState({ tasks: {} })
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  unmount()
  container.remove()
})

describe('useBgTaskSeed · 假后端', () => {
  let listAll: ReturnType<typeof vi.fn<() => Promise<TaskInfo[]>>>
  let subscribers: Set<(event: AppEvent) => void>
  const emit = (event: AppEvent): void => {
    for (const subscriber of [...subscribers]) act(() => subscriber(event))
  }
  const listChanged: AppEvent = { type: 'session.listChanged' }

  beforeEach(() => {
    listAll = vi.fn(async () => [])
    subscribers = new Set()
    setChatApi({
      bgTask: { listAll },
      events: {
        subscribe: (callback: (event: AppEvent) => void) => {
          subscribers.add(callback)
          return () => void subscribers.delete(callback)
        }
      }
    } as unknown as ChatApi)
  })

  it('BGS-1 挂载取一次：别的会话的任务也进 store，选择器亮', async () => {
    const task = running('t1', 'not-the-active-one')
    listAll.mockResolvedValue([task])
    mount()
    await flush()
    expect(listAll).toHaveBeenCalledTimes(1)
    expect(listAll.mock.calls[0]).toEqual([])
    expect(useBgTaskStore.getState().tasks).toEqual({ t1: task })
    expect(busy()).toEqual({ 'not-the-active-one': true })
  })

  it.each<[string, TaskInfo[]]>([
    ['结束了', [finished(running('t1', 'a'))]],
    ['没了', []]
  ])('BGS-2 session.listChanged 重取，任务%s：键消失', async (_label, snapshot) => {
    listAll.mockResolvedValueOnce([running('t1', 'a')])
    mount()
    await flush()
    expect(busy()).toEqual({ a: true })

    listAll.mockResolvedValueOnce(snapshot)
    emit(listChanged)
    await flush()
    expect(listAll).toHaveBeenCalledTimes(2)
    expect(busy()).toEqual({})
  })

  it('BGS-2 别的事件不取', async () => {
    mount()
    await flush()
    expect(listAll).toHaveBeenCalledTimes(1)
    for (const event of [
      { type: 'settings.changed' },
      { type: 'bot.changed' },
      { type: 'widget.changed' }
    ] as AppEvent[]) {
      emit(event)
    }
    await flush()
    expect(listAll).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['not_connected', Object.assign(new Error('not connected'), { code: 'not_connected' })],
    ['disconnected', Object.assign(new Error('disconnected'), { code: 'disconnected' })],
    ['handler error', Object.assign(new Error('boom'), { code: 'handler_error' })]
  ])('BGS-3 拒绝（%s）：表不动、没有未处理的拒绝；下一个信号补好', async (_name, error) => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => void unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    try {
      listAll.mockResolvedValueOnce([running('t1', 'a')])
      mount()
      await flush()
      const before = useBgTaskStore.getState().tasks

      listAll.mockRejectedValueOnce(error)
      emit(listChanged)
      await flush()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(listAll).toHaveBeenCalledTimes(2)
      expect(useBgTaskStore.getState().tasks).toBe(before)
      expect(busy()).toEqual({ a: true })
      expect(unhandled).toEqual([])

      listAll.mockResolvedValueOnce([running('t2', 'b')])
      emit(listChanged)
      await flush()
      expect(busy()).toEqual({ b: true })
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('BGS-4 卸载之后不再取', async () => {
    mount()
    await flush()
    expect(listAll).toHaveBeenCalledTimes(1)
    unmount()
    emit(listChanged)
    await flush()
    expect(subscribers.size).toBe(0)
    expect(listAll).toHaveBeenCalledTimes(1)
  })
})

describe('BGS-5 真 createWsConnection + 假 socket', () => {
  class FakeSocket implements WebSocketLike {
    readyState = 0
    readonly sent: string[] = []
    onopen: ((event: unknown) => void) | null = null
    onclose: ((event: unknown) => void) | null = null
    onerror: ((event: unknown) => void) | null = null
    onmessage: ((event: { data: unknown }) => void) | null = null
    send(data: string): void {
      this.sent.push(data)
    }
    close(): void {
      this.readyState = 3
    }
    open(): void {
      this.readyState = 1
      this.onopen?.({})
    }
    drop(): void {
      this.readyState = 3
      this.onclose?.({})
    }
    serverSend(message: ServerMessage): void {
      this.onmessage?.({ data: encodeServerMessage(message) })
    }
    listAllFrames(): Extract<ClientMessage, { t: 'invoke' }>[] {
      return this.sent
        .map((text) => decodeClientMessage(text)!)
        .filter(
          (frame): frame is Extract<ClientMessage, { t: 'invoke' }> =>
            frame.t === 'invoke' && frame.channel === 'bgTask:listAll'
        )
    }
    /** 回答最后一次 listAll */
    answer(result: TaskInfo[]): void {
      this.serverSend({
        t: 'result',
        id: this.listAllFrames().at(-1)!.id,
        ok: true,
        value: result
      })
    }
  }

  let sockets: FakeSocket[]
  let connection: WsConnection
  let reconnect: (() => void) | undefined

  const timers: WsTimers = {
    setTimeout: (fn) => {
      reconnect = fn
      return 1
    },
    clearTimeout: () => {
      reconnect = undefined
    }
  }

  const reconnectNow = (): FakeSocket => {
    const fire = reconnect
    reconnect = undefined
    expect(fire).toBeDefined()
    fire!()
    return sockets.at(-1)!
  }

  beforeEach(() => {
    sockets = []
    reconnect = undefined
    connection = createWsConnection({
      url: 'ws://x/ws',
      createSocket: () => {
        const socket = new FakeSocket()
        sockets.push(socket)
        return socket
      },
      timers
    })
    setChatApi(createWebApi(connection) as unknown as ChatApi)
  })

  afterEach(() => {
    connection.dispose()
  })

  it('BGS-5 第一次连上发排着的那一次（恰一次，args 是空的）；回答填进 store', async () => {
    mount()
    await flush()
    const first = sockets[0]!
    expect(first.sent).toEqual([])
    act(() => first.open())
    expect(first.listAllFrames()).toHaveLength(1)
    expect(first.listAllFrames()[0]).toMatchObject({ args: [] })
    await act(async () => first.answer([running('t1', 'a')]))
    await flush()
    expect(first.listAllFrames()).toHaveLength(1)
    expect(busy()).toEqual({ a: true })
  })

  it('BGS-5 重连再取一次：断线期间结束的灭，新的亮', async () => {
    mount()
    const first = sockets[0]!
    act(() => first.open())
    const ended = running('ended', 'a')
    await act(async () => first.answer([ended]))
    await flush()
    expect(busy()).toEqual({ a: true })

    act(() => first.drop())
    await flush()
    expect(busy()).toEqual({ a: true })

    const second = reconnectNow()
    act(() => second.open())
    expect(second.listAllFrames()).toHaveLength(1)
    await act(async () => second.answer([finished(ended), running('fresh', 'b')]))
    await flush()
    expect(busy()).toEqual({ b: true })
  })

  it('BGS-5 断着时挂载：这次调用当场被拒（没发帧）、表不动、没有未处理的拒绝；重连补好', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => void unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    try {
      const first = sockets[0]!
      first.open()
      first.drop()
      act(() => useBgTaskStore.getState().upsert(running('t1', 'a')))
      const before = useBgTaskStore.getState().tasks

      mount()
      await flush()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(first.listAllFrames()).toEqual([])
      expect(useBgTaskStore.getState().tasks).toBe(before)
      expect(unhandled).toEqual([])

      const second = reconnectNow()
      act(() => second.open())
      expect(second.listAllFrames()).toHaveLength(1)
      await act(async () => second.answer([running('t2', 'b')]))
      await flush()
      expect(busy()).toEqual({ b: true })
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('BGS-5 服务端回来时注册表已空（重启过）：表清空', async () => {
    mount()
    const first = sockets[0]!
    act(() => first.open())
    await act(async () => first.answer([running('t1', 'a')]))
    await flush()
    expect(busy()).toEqual({ a: true })

    act(() => first.drop())
    const second = reconnectNow()
    act(() => second.open())
    expect(second.listAllFrames()).toHaveLength(1)
    await act(async () => second.answer([]))
    await flush()
    expect(useBgTaskStore.getState().tasks).toEqual({})
    expect(busy()).toEqual({})
  })
})
