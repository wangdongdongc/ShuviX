/**
 * PanelLink 的请求失败带上连接类的 code（chat-protocol connectionErrors）：发出去了没等到结果 vs 根本没发出去。
 *
 *   PL-1 在途的请求：端口断开 / 状态离开 ready / 回包是「桌面不在」→ 消息不变（BRIDGE_ERROR_DESKTOP_OFFLINE），lost
 *   PL-2 没有端口 / postMessage 抛 → not-sent
 *   PL-3 别的错误回包 → 原样的消息，不算连接类（空错误给兜底文案）
 *
 * PanelLink 是真的，端口是假的 chrome.runtime.connect（同 channelApiSync.test.ts）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BRIDGE_ERROR_DESKTOP_OFFLINE } from '@shuvix/chat-protocol/chromeBridge'
import { connectionFailureOf } from '@shuvix/chat-protocol/connectionErrors'
import type { PanelToWorker, WorkerToPanel } from '../../shared/panelLink'
import { PanelLink } from '../panelLink'

class FakeSwPort {
  readonly posted: PanelToWorker[] = []
  private readonly messageListeners: Array<(message: WorkerToPanel) => void> = []
  private readonly disconnectListeners: Array<() => void> = []
  readonly onMessage = {
    addListener: (fn: (message: WorkerToPanel) => void): void => {
      this.messageListeners.push(fn)
    }
  }
  readonly onDisconnect = {
    addListener: (fn: () => void): void => {
      this.disconnectListeners.push(fn)
    }
  }
  postMessage = (message: PanelToWorker): void => {
    this.posted.push(message)
  }
  push(message: WorkerToPanel): void {
    for (const fn of this.messageListeners) fn(message)
  }
  drop(): void {
    for (const fn of this.disconnectListeners) fn()
  }
  /** 最近一个请求的 id */
  lastId(): number {
    const last = this.posted.at(-1)
    if (last?.kind !== 'request') throw new Error('no request posted')
    return last.id
  }
}

let port: FakeSwPort

/** 发一个请求，回它的错误（断言落定） */
const request = (link: PanelLink): Promise<unknown> =>
  link
    .request('agent.prompt' as never, {} as never)
    .then(() => {
      throw new Error('expected a rejection')
    })
    .catch((error: unknown) => error)

beforeEach(() => {
  // 重连定时器不留到用例之外
  vi.useFakeTimers()
  port = new FakeSwPort()
  vi.stubGlobal('chrome', { runtime: { connect: () => port } })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('PanelLink 的连接类失败', () => {
  it.each<[string, (p: FakeSwPort) => void]>([
    ['the port disconnects', (p) => p.drop()],
    ['a non-ready status', (p) => p.push({ kind: 'status', state: 'desktop-offline' })],
    [
      'a desktop-offline response',
      (p) =>
        p.push({ kind: 'response', id: p.lastId(), ok: false, error: BRIDGE_ERROR_DESKTOP_OFFLINE })
    ]
  ])('PL-1 in flight when %s: the message is unchanged, lost', async (_label, fail) => {
    const link = new PanelLink(5)
    port.push({ kind: 'status', state: 'ready' })
    const failed = request(link)
    fail(port)
    const error = (await failed) as Error
    expect(error.message).toBe(BRIDGE_ERROR_DESKTOP_OFFLINE)
    expect(connectionFailureOf(error)).toBe('lost')
  })

  it('PL-2 no port: not-sent, the message is unchanged', async () => {
    const link = new PanelLink(5)
    port.drop()
    const error = (await request(link)) as Error
    expect(error.message).toBe(BRIDGE_ERROR_DESKTOP_OFFLINE)
    expect(connectionFailureOf(error)).toBe('not-sent')
  })

  it('PL-2 postMessage throws: not-sent, and a later status does not reject it twice', async () => {
    const link = new PanelLink(5)
    port.push({ kind: 'status', state: 'ready' })
    port.postMessage = () => {
      throw new Error('port closed')
    }
    const error = (await request(link)) as Error
    expect(connectionFailureOf(error)).toBe('not-sent')
    expect(() => port.push({ kind: 'status', state: 'desktop-offline' })).not.toThrow()
  })

  it.each<[string, string, string]>([
    ['an ordinary error', 'boom', 'boom'],
    ['an empty error', '', 'ShuviX reported an error.']
  ])('PL-3 %s: the plain message, not a connection failure', async (_label, sent, shown) => {
    const link = new PanelLink(5)
    port.push({ kind: 'status', state: 'ready' })
    const failed = request(link)
    port.push({ kind: 'response', id: port.lastId(), ok: false, error: sent })
    const error = (await failed) as Error
    expect(error.message).toBe(shown)
    expect(connectionFailureOf(error)).toBeNull()
  })
})
