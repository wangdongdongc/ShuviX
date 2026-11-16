// @vitest-environment jsdom
/**
 * useUnattendedSeed —— 补「这一轮无人值守」的状态（会话头部的图标读它；docs/unattended-run-design.md §6）。
 * `unattended` 是事件：窗口重建、web 客户端连上来之前发的都错过了。契约：挂载时取一份 `agent.unattended()`、
 * `session.listChanged` 时再取一份、换到另一条会话时再取一份，整份换进 store；取失败保持现状；宿主没有这个查询
 * （Chrome 侧栏）就什么都不做。
 *
 *   US-1 挂载取一次，填进 store
 *   US-2 session.listChanged 重取：整份换掉（不再无人值守的会话的键消失）；别的事件不取
 *   US-3 拒绝：表不动、没有未处理的拒绝；下一个信号补好
 *   US-4 宿主没有 `agent.unattended`：不调用、不抛
 *   US-5 真 createWsConnection + 假 socket：连上发 `agent:unattended` 一帧；重连后的 listChanged 再取一次
 *   US-6 先回种子、后到事件：事件站得住；在途的旧种子后到会盖掉更新的事件（与询问计数同一个已知行为，这里钉住现状）
 *   US-7 换当前会话再取一次；卸载之后不再取
 *
 * store、hook 与 `@shuvix/chat-ui` 都是真的；只有后端是假的。桌面 vitest 对渲染层只收 `*.test.ts`，一律 createElement。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { setChatApi, useChatStore } from '@shuvix/chat-ui'
import type { AppEvent } from '@shuvix/chat-protocol/appEvents'
import type { ChatApi } from '@shuvix/chat-protocol/chatApi'
import {
  decodeClientMessage,
  encodeServerMessage,
  type ClientMessage,
  type ServerMessage
} from '../../../../shared/networkEnvelope'
import { useUnattendedSeed } from '../useUnattendedSeed'
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
  useUnattendedSeed()
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
const table = (): Record<string, true> => useChatStore.getState().sessionUnattended

beforeEach(() => {
  useChatStore.setState({ sessionUnattended: {}, activeSessionId: null, active: null })
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  unmount()
  container.remove()
})

describe('useUnattendedSeed · 假后端', () => {
  let unattended: ReturnType<typeof vi.fn<() => Promise<string[]>>>
  let subscribers: Set<(event: AppEvent) => void>
  const emit = (event: AppEvent): void => {
    for (const subscriber of [...subscribers]) act(() => subscriber(event))
  }
  const listChanged: AppEvent = { type: 'session.listChanged' }
  const events = {
    subscribe: (callback: (event: AppEvent) => void) => {
      subscribers.add(callback)
      return () => void subscribers.delete(callback)
    }
  }

  beforeEach(() => {
    unattended = vi.fn(async () => [])
    subscribers = new Set()
    setChatApi({ agent: { unattended }, events } as unknown as ChatApi)
  })

  it('US-1 挂载取一次，填进 store', async () => {
    unattended.mockResolvedValue(['a', 'b'])
    mount()
    await flush()
    expect(unattended).toHaveBeenCalledTimes(1)
    expect(unattended).toHaveBeenCalledWith()
    expect(table()).toStrictEqual({ a: true, b: true })
  })

  it('US-2 session.listChanged 重取：整份换掉；别的事件不取', async () => {
    unattended.mockResolvedValueOnce(['done', 'running'])
    mount()
    await flush()
    expect(table()).toStrictEqual({ done: true, running: true })

    emit({ type: 'settings.changed' } as AppEvent)
    await flush()
    expect(unattended).toHaveBeenCalledTimes(1)

    unattended.mockResolvedValueOnce(['running'])
    emit(listChanged)
    await flush()
    expect(unattended).toHaveBeenCalledTimes(2)
    expect(table()).toStrictEqual({ running: true })

    unattended.mockResolvedValueOnce([])
    emit(listChanged)
    await flush()
    expect(table()).toStrictEqual({})
  })

  it.each([
    ['not_connected', Object.assign(new Error('not connected'), { code: 'not_connected' })],
    ['disconnected', Object.assign(new Error('disconnected'), { code: 'disconnected' })],
    ['handler error', new Error('boom')]
  ])('US-3 拒绝（%s）：表不动、没有未处理的拒绝；下一个信号补好', async (_name, error) => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => void unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    try {
      unattended.mockResolvedValueOnce(['a'])
      mount()
      await flush()
      const before = table()

      unattended.mockRejectedValueOnce(error)
      emit(listChanged)
      await flush()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(unattended).toHaveBeenCalledTimes(2)
      expect(table()).toBe(before)
      expect(unhandled).toEqual([])

      unattended.mockResolvedValueOnce(['b'])
      emit(listChanged)
      await flush()
      expect(table()).toStrictEqual({ b: true })
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('US-4 宿主没有 agent.unattended（Chrome 侧栏）：不抛、表不动；信号来了也一样', async () => {
    setChatApi({ agent: {}, events } as unknown as ChatApi)
    act(() => useChatStore.getState().setUnattended('kept', true))
    expect(mount).not.toThrow()
    await flush()
    emit(listChanged)
    await flush()
    expect(table()).toStrictEqual({ kept: true })
  })

  it('US-6 先回种子、后到事件：事件站得住', async () => {
    unattended.mockResolvedValueOnce(['a'])
    mount()
    await flush()
    act(() => useChatStore.getState().setUnattended('a', false))
    act(() => useChatStore.getState().setUnattended('b', true))
    await flush()
    expect(table()).toStrictEqual({ b: true })
  })

  it('US-6 在途的旧种子后到：盖掉这期间到的事件（已知，与询问计数相同；下一次种子补正）', async () => {
    let resolveSeed!: (ids: string[]) => void
    unattended.mockImplementationOnce(
      () => new Promise<string[]>((resolve) => (resolveSeed = resolve))
    )
    mount()
    await flush()
    act(() => useChatStore.getState().setUnattended('a', false))
    await act(async () => resolveSeed(['a']))
    await flush()
    expect(table()).toStrictEqual({ a: true })

    unattended.mockResolvedValueOnce([])
    emit(listChanged)
    await flush()
    expect(table()).toStrictEqual({})
  })

  it('US-7 换到另一条会话时再取一次；同一条不重取', async () => {
    mount()
    await flush()
    expect(unattended).toHaveBeenCalledTimes(1)

    unattended.mockResolvedValueOnce(['s2'])
    act(() => useChatStore.getState().setActiveSessionId('s2'))
    await flush()
    expect(unattended).toHaveBeenCalledTimes(2)
    expect(table()).toStrictEqual({ s2: true })

    act(() => useChatStore.getState().setActiveSessionId('s2'))
    await flush()
    expect(unattended).toHaveBeenCalledTimes(2)

    act(() => useChatStore.getState().setActiveSessionId(null))
    await flush()
    expect(unattended).toHaveBeenCalledTimes(3)
  })

  it('US-7 卸载之后不再取', async () => {
    mount()
    await flush()
    unmount()
    emit(listChanged)
    act(() => useChatStore.getState().setActiveSessionId('later'))
    await flush()
    expect(subscribers.size).toBe(0)
    expect(unattended).toHaveBeenCalledTimes(1)
  })
})

describe('US-5 真 createWsConnection + 假 socket', () => {
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
    frames(): Extract<ClientMessage, { t: 'invoke' }>[] {
      return this.sent
        .map((text) => decodeClientMessage(text)!)
        .filter(
          (frame): frame is Extract<ClientMessage, { t: 'invoke' }> =>
            frame.t === 'invoke' && frame.channel === 'agent:unattended'
        )
    }
    answer(result: string[]): void {
      this.serverSend({ t: 'result', id: this.frames().at(-1)!.id, ok: true, value: result })
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

  it('US-5 连上发排着的那一帧（恰一次、不带参数）；回答填进 store', async () => {
    mount()
    await flush()
    const first = sockets[0]!
    expect(first.sent).toEqual([])
    act(() => first.open())
    expect(first.frames()).toHaveLength(1)
    expect(first.frames()[0]!.args).toEqual([])
    await act(async () => first.answer(['s1']))
    await flush()
    expect(first.frames()).toHaveLength(1)
    expect(table()).toStrictEqual({ s1: true })
  })

  it('US-5 重连再取一次：断线期间转回有人值守的消失，新的出现', async () => {
    mount()
    const first = sockets[0]!
    act(() => first.open())
    await act(async () => first.answer(['old']))
    await flush()
    expect(table()).toStrictEqual({ old: true })

    act(() => first.drop())
    await flush()
    expect(table()).toStrictEqual({ old: true })

    const fire = reconnect
    reconnect = undefined
    expect(fire).toBeDefined()
    fire!()
    const second = sockets.at(-1)!
    act(() => second.open())
    expect(second.frames()).toHaveLength(1)
    await act(async () => second.answer(['fresh']))
    await flush()
    expect(table()).toStrictEqual({ fresh: true })
  })
})
