// @vitest-environment jsdom
/**
 * useAskCountSeed —— 补侧栏的询问徽标（询问一直等人，`ask_count` 是事件：窗口重建、web 客户端连上来之前发的都错过了）。
 * 契约：挂载时取一份 `agent.askCounts()`、`session.listChanged` 时再取一份，整份换进 store；取失败保持现状。
 *
 *   SEED-1 挂载取一次，填进 store
 *   SEED-2 session.listChanged 重取；已经落定的会话的键随之消失；别的事件不取
 *   SEED-3 拒绝（not_connected / disconnected / 处理函数报错）：表不动、没有未处理的拒绝；下一个信号补好
 *   SEED-4 先应答、后 ask_count：事件站得住；卸载之后不再取
 *   SEED-5 真 createWsConnection + 假 socket：第一次连上发排着的那次；重连再取一次；断着时的调用被拒、重连补好
 *
 * store、hook 与 `@shuvix/chat-ui` 都是真的；只有后端是假的（SEED-5 是线协议上的假服务端）。桌面 vitest 对渲染层只收
 * `*.test.ts`（本文件自己切 jsdom），不带 react 插件 —— 一律 createElement。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { selectAllPendingCounts, setChatApi, useChatStore } from '@shuvix/chat-ui'
import type { AppEvent } from '@shuvix/chat-protocol/appEvents'
import type { ChatApi } from '@shuvix/chat-protocol/chatApi'
import {
  decodeClientMessage,
  encodeServerMessage,
  type ClientMessage,
  type ServerMessage
} from '../../../../shared/networkEnvelope'
import { useAskCountSeed } from '../useAskCountSeed'
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
  useAskCountSeed()
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
const counts = (): Record<string, number> => selectAllPendingCounts(useChatStore.getState())

beforeEach(() => {
  useChatStore.setState({ sessionAskCounts: {}, sessionViews: {}, sessionPendingInputs: {} })
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  unmount()
  container.remove()
})

describe('useAskCountSeed · 假后端', () => {
  let askCounts: ReturnType<typeof vi.fn<() => Promise<Record<string, number>>>>
  let subscribers: Set<(event: AppEvent) => void>
  const emit = (event: AppEvent): void => {
    for (const subscriber of [...subscribers]) act(() => subscriber(event))
  }
  const listChanged: AppEvent = { type: 'session.listChanged' }

  beforeEach(() => {
    askCounts = vi.fn(async () => ({}))
    subscribers = new Set()
    setChatApi({
      agent: { askCounts },
      events: {
        subscribe: (callback: (event: AppEvent) => void) => {
          subscribers.add(callback)
          return () => void subscribers.delete(callback)
        }
      }
    } as unknown as ChatApi)
  })

  it('SEED-1 挂载取一次，填进 store', async () => {
    askCounts.mockResolvedValue({ a: 1, b: 2 })
    mount()
    await flush()
    expect(askCounts).toHaveBeenCalledTimes(1)
    expect(useChatStore.getState().sessionAskCounts).toEqual({ a: 1, b: 2 })
    expect(counts()).toEqual({ a: 1, b: 2 })
  })

  it('SEED-2 session.listChanged 重取：落定的会话的键没了；别的事件不取', async () => {
    askCounts.mockResolvedValueOnce({ settled: 1, waiting: 2 })
    mount()
    await flush()
    expect(counts()).toEqual({ settled: 1, waiting: 2 })

    emit({ type: 'settings.changed' } as AppEvent)
    await flush()
    expect(askCounts).toHaveBeenCalledTimes(1)

    askCounts.mockResolvedValueOnce({ waiting: 2 })
    emit(listChanged)
    await flush()
    expect(askCounts).toHaveBeenCalledTimes(2)
    expect(useChatStore.getState().sessionAskCounts).toEqual({ waiting: 2 })
    expect(counts()).toEqual({ waiting: 2 })
  })

  it.each([
    ['not_connected', Object.assign(new Error('not connected'), { code: 'not_connected' })],
    ['disconnected', Object.assign(new Error('disconnected'), { code: 'disconnected' })],
    ['handler error', Object.assign(new Error('boom'), { code: 'handler_error' })]
  ])('SEED-3 拒绝（%s）：表不动、没有未处理的拒绝；下一个信号补好', async (_name, error) => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => void unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    try {
      askCounts.mockResolvedValueOnce({ a: 1 })
      mount()
      await flush()
      const before = useChatStore.getState().sessionAskCounts

      askCounts.mockRejectedValueOnce(error)
      emit(listChanged)
      await flush()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(askCounts).toHaveBeenCalledTimes(2)
      expect(useChatStore.getState().sessionAskCounts).toBe(before)
      expect(unhandled).toEqual([])

      askCounts.mockResolvedValueOnce({ b: 3 })
      emit(listChanged)
      await flush()
      expect(counts()).toEqual({ b: 3 })
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('SEED-4 先回种子、后到 ask_count：事件站得住；卸载之后不再取', async () => {
    askCounts.mockResolvedValueOnce({ a: 1 })
    mount()
    await flush()
    act(() => useChatStore.getState().setAskCount('a', 4))
    expect(counts()).toEqual({ a: 4 })
    await flush()
    expect(counts()).toEqual({ a: 4 })

    unmount()
    emit(listChanged)
    await flush()
    expect(subscribers.size).toBe(0)
    expect(askCounts).toHaveBeenCalledTimes(1)
  })
})

describe('SEED-5 真 createWsConnection + 假 socket', () => {
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
    askCountFrames(): Extract<ClientMessage, { t: 'invoke' }>[] {
      return this.sent
        .map((text) => decodeClientMessage(text)!)
        .filter(
          (frame): frame is Extract<ClientMessage, { t: 'invoke' }> =>
            frame.t === 'invoke' && frame.channel === 'agent:askCounts'
        )
    }
    /** 回答最后一次询问计数 */
    answer(result: Record<string, number>): void {
      this.serverSend({
        t: 'result',
        id: this.askCountFrames().at(-1)!.id,
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

  it('SEED-5 第一次连上发排着的那一次（恰一次）；回答填进 store', async () => {
    mount()
    await flush()
    const first = sockets[0]!
    expect(first.sent).toEqual([])
    act(() => first.open())
    expect(first.askCountFrames()).toHaveLength(1)
    await act(async () => first.answer({ s1: 1 }))
    await flush()
    expect(first.askCountFrames()).toHaveLength(1)
    expect(counts()).toEqual({ s1: 1 })
  })

  it('SEED-5 重连再取一次：断线期间答掉的徽标消失，新的出现', async () => {
    mount()
    const first = sockets[0]!
    act(() => first.open())
    await act(async () => first.answer({ answered: 1 }))
    await flush()
    expect(counts()).toEqual({ answered: 1 })

    act(() => first.drop())
    await flush()
    expect(counts()).toEqual({ answered: 1 })

    const second = reconnectNow()
    act(() => second.open())
    expect(second.askCountFrames()).toHaveLength(1)
    await act(async () => second.answer({ raised: 2 }))
    await flush()
    expect(counts()).toEqual({ raised: 2 })
  })

  it('SEED-5 断着时挂载：这次调用当场被拒（没发帧）、表不动、没有未处理的拒绝；重连补好', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => void unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    try {
      const first = sockets[0]!
      first.open()
      first.drop()
      act(() => useChatStore.getState().setAskCounts({ a: 1 }))

      mount()
      await flush()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(first.askCountFrames()).toEqual([])
      expect(counts()).toEqual({ a: 1 })
      expect(unhandled).toEqual([])

      const second = reconnectNow()
      act(() => second.open())
      expect(second.askCountFrames()).toHaveLength(1)
      await act(async () => second.answer({ b: 2 }))
      await flush()
      expect(counts()).toEqual({ b: 2 })
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})
