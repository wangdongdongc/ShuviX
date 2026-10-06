/**
 * 侧边栏 channelApi 里经桥的那几条（P3-09，docs/pi-durable/p3-0809-test-design.md）：
 *
 *   P3-09-10 `sync.invoke(t, c)` → `link.request('channel.call', {path:'sync.invoke', args:[t, c]})` 恰一次；
 *            信封 ok → value；信封 ok:false → 带 `.code` 的 Error；桥这一层的失败（desktop-offline …）→ Error，
 *            `.code` = 那段错误文本（PIN-13）。`onFrame` 只收 `sync.frame`；注销只摘自己那份、重复注销无事
 *   P3-09-11 （P3-05-12 翻面）不再以 `unsupported` 拒绝：一次 `channel.call`
 *   P3-11-10 （翻面）`withdrawQueued` → `channel.call('agent.withdrawQueued', params)`；agent 上没有「下一轮」
 *   P3-12-08 `continue(sid)` → `channel.call('agent.continue', sid)`，回包原样
 *   P3-09-13 （侧边栏那一半，PIN-10）`resetSyncOnReconnect`：只在「非 ready → ready」时 resetAll，第一次就绪不算
 *
 * PanelLink 是真的（端口是假的 chrome.runtime.connect）：帧从 SW 的消息一路走到 onFrame 的回调。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PanelLinkState, WorkerToPanel } from '../../shared/panelLink'
import { createPanelChannelApi, createPanelSyncChannel } from '../channelApi'
import { PanelLink } from '../panelLink'
import { resetSyncOnReconnect } from '../syncReset'

/** SW 那头的端口替身：记下侧边栏发出的请求，可以推消息、断开 */
class FakeSwPort {
  readonly posted: Array<{ kind: string; id: number; method: string; params: unknown }> = []
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
  postMessage = (message: { kind: string; id: number; method: string; params: unknown }): void => {
    this.posted.push(message)
  }
  push(message: WorkerToPanel): void {
    for (const fn of this.messageListeners) fn(message)
  }
  /** 回最近一个请求 */
  answer(reply: { ok: boolean; result?: unknown; error?: string }): void {
    const last = this.posted.at(-1)!
    this.push({ kind: 'response', id: last.id, ...reply })
  }
}

let port: FakeSwPort

beforeEach(() => {
  port = new FakeSwPort()
  vi.stubGlobal('chrome', { runtime: { connect: () => port } })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const target = { kind: 'session' as const, sessionId: 's1' }
const call = {
  serviceId: '$chord.service',
  member: 'subscribe',
  args: ['tab5.n#1', 'x', 'singleton']
}

describe('P3-09-10 / P3-09-11 侧边栏的 sync 渠道', () => {
  it('P3-09-11 / P3-09-10 invoke 恰发一次 channel.call {path:sync.invoke, args:[target, call]}；信封 ok → value', async () => {
    const link = new PanelLink(5)
    const api = createPanelChannelApi(link)
    const pending = api.sync.invoke(target, call)
    expect(port.posted).toEqual([
      {
        kind: 'request',
        id: 1,
        method: 'channel.call',
        params: { path: 'sync.invoke', args: [target, call] }
      }
    ])
    port.answer({ ok: true, result: { ok: true, value: { snapshot: 1 } } })
    await expect(pending).resolves.toEqual({ snapshot: 1 })
    expect(port.posted).toHaveLength(1)
  })

  it('P3-09-10 信封 ok:true 但没有 value（退订）→ undefined', async () => {
    const link = new PanelLink(5)
    const pending = createPanelSyncChannel(link).invoke(target, call)
    port.answer({ ok: true, result: { ok: true } })
    await expect(pending).resolves.toBeUndefined()
  })

  it('P3-09-10 信封 ok:false → 带 .code 的 Error（chord 的错误码）；没有码就不带', async () => {
    const link = new PanelLink(5)
    const sync = createPanelSyncChannel(link)
    let pending = sync.invoke(target, call)
    port.answer({
      ok: true,
      result: { ok: false, error: { code: 'service_not_found', message: 'Session s1 was deleted' } }
    })
    let error = (await pending.catch((e: unknown) => e)) as Error & { code?: string }
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe('Session s1 was deleted')
    expect(error.code).toBe('service_not_found')

    pending = sync.invoke(target, call)
    port.answer({ ok: true, result: { ok: false, error: { message: 'bad call' } } })
    error = (await pending.catch((e: unknown) => e)) as Error & { code?: string }
    expect(error.message).toBe('bad call')
    expect(error.code).toBeUndefined()
  })

  it('P3-09-10 桥这一层失败（SW 回 desktop-offline / 归属核对没过）→ Error，.code = 那段错误文本（PIN-13）', async () => {
    const link = new PanelLink(5)
    const sync = createPanelSyncChannel(link)
    let pending = sync.invoke(target, call)
    port.answer({ ok: false, error: 'desktop-offline' })
    let error = (await pending.catch((e: unknown) => e)) as Error & { code?: string }
    expect(error.message).toBe('desktop-offline')
    expect(error.code).toBe('desktop-offline')

    const refusal = 'This session does not belong to this Chrome tab.'
    pending = sync.invoke(target, call)
    port.answer({ ok: false, error: refusal })
    error = (await pending.catch((e: unknown) => e)) as Error & { code?: string }
    expect(error.code).toBe(refusal)

    // 连接状态掉了：挂着的调用一律 desktop-offline
    pending = sync.invoke(target, call)
    port.push({ kind: 'status', state: 'desktop-offline' })
    error = (await pending.catch((e: unknown) => e)) as Error & { code?: string }
    expect(error.code).toBe('desktop-offline')
  })

  it('P3-09-10 回包不是信封 → 拒绝（不当成值交给 chord）', async () => {
    const link = new PanelLink(5)
    const pending = createPanelSyncChannel(link).invoke(target, call)
    port.answer({ ok: true, result: null })
    await expect(pending).rejects.toThrow('malformed')
  })

  it('P3-09-10 onFrame 只收 sync.frame 的载荷；注销只摘自己那份，重复注销无事', () => {
    const link = new PanelLink(5)
    const sync = createPanelChannelApi(link).sync
    const a = vi.fn()
    const b = vi.fn()
    const offA = sync.onFrame(a)
    sync.onFrame(b)
    const frame = { target, subscriptionId: 'tab5.n#1', update: { type: 'state' } }
    port.push({ kind: 'chat.event', event: { type: 'agent_start' } })
    port.push({ kind: 'app.event', event: { type: 'settings.changed' } })
    port.push({ kind: 'sync.frame', frame })
    expect(a.mock.calls).toEqual([[frame]])
    expect(b.mock.calls).toEqual([[frame]])
    offA()
    offA()
    port.push({ kind: 'sync.frame', frame: { n: 2 } })
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(2)
  })

  it('P3-09-10 同一个回调登记两次是两份：注销一份另一份照收', () => {
    const link = new PanelLink(5)
    const sync = createPanelSyncChannel(link)
    const cb = vi.fn()
    const off1 = sync.onFrame(cb)
    sync.onFrame(cb)
    off1()
    port.push({ kind: 'sync.frame', frame: 1 })
    expect(cb).toHaveBeenCalledTimes(1)
  })
})

describe('P3-11-10 / P3-12-08 撤回与继续经桥', () => {
  it('P3-11-10 withdrawQueued → channel.call(agent.withdrawQueued, params)，回包原样；agent 上没有「下一轮」', async () => {
    const link = new PanelLink(5)
    const api = createPanelChannelApi(link)
    const pending = api.agent.withdrawQueued({ sessionId: 's1', submissionId: 3 })
    expect(port.posted.at(-1)).toMatchObject({
      method: 'channel.call',
      params: { path: 'agent.withdrawQueued', args: [{ sessionId: 's1', submissionId: 3 }] }
    })
    port.answer({ ok: true, result: { result: 'aborted' } })
    await expect(pending).resolves.toEqual({ result: 'aborted' })
    expect(Object.keys(api.agent).filter((key) => /turn/i.test(key))).toEqual([])
  })

  it('P3-12-08 continue(sid) → channel.call(agent.continue, sid)，回包原样（含失败的分类码）', async () => {
    const link = new PanelLink(5)
    const api = createPanelChannelApi(link)
    let pending = api.agent.continue('s1')
    expect(port.posted.at(-1)).toMatchObject({
      method: 'channel.call',
      params: { path: 'agent.continue', args: ['s1'] }
    })
    port.answer({ ok: true, result: { success: true } })
    await expect(pending).resolves.toEqual({ success: true })
    pending = api.agent.continue('s1')
    port.answer({ ok: true, result: { success: false, error: 'no model', code: 'no_model' } })
    await expect(pending).resolves.toEqual({ success: false, error: 'no model', code: 'no_model' })
  })
})

describe('P3-09-13 重连之后重绑（侧边栏那一半，PIN-10）', () => {
  /** 连接状态的替身 */
  function fakeLink(initial: PanelLinkState): {
    state: PanelLinkState
    onState: (fn: (s: PanelLinkState) => void) => () => void
    set: (s: PanelLinkState) => void
  } {
    const listeners = new Set<(s: PanelLinkState) => void>()
    const link = {
      state: initial,
      onState: (fn: (s: PanelLinkState) => void) => {
        listeners.add(fn)
        return () => listeners.delete(fn)
      },
      set: (s: PanelLinkState) => {
        link.state = s
        for (const fn of [...listeners]) fn(s)
      }
    }
    return link
  }

  it('P3-09-13 第一次就绪不算重连；ready → desktop-offline → ready 才 resetAll，一次', () => {
    const link = fakeLink('connecting')
    const client = { resetAll: vi.fn() }
    resetSyncOnReconnect(link, client)
    link.set('ready')
    expect(client.resetAll).not.toHaveBeenCalled()
    link.set('desktop-offline')
    expect(client.resetAll).not.toHaveBeenCalled()
    link.set('connecting')
    link.set('ready')
    expect(client.resetAll).toHaveBeenCalledTimes(1)
    // 一直就绪着不会再叫
    link.set('ready')
    expect(client.resetAll).toHaveBeenCalledTimes(1)
  })

  it('P3-09-13 挂上时已经就绪：之后掉线再回来算一次重连；从没就绪过的掉线不算', () => {
    const ready = fakeLink('ready')
    const a = { resetAll: vi.fn() }
    resetSyncOnReconnect(ready, a)
    ready.set('mismatch')
    ready.set('ready')
    expect(a.resetAll).toHaveBeenCalledTimes(1)

    const never = fakeLink('host-missing')
    const b = { resetAll: vi.fn() }
    resetSyncOnReconnect(never, b)
    never.set('desktop-offline')
    never.set('ready')
    expect(b.resetAll).not.toHaveBeenCalled()
  })

  it('P3-09-13 真的 PanelLink：SW 推来的状态驱动它；readyEpoch 每次进入 ready 加一；注销之后不再叫', () => {
    const link = new PanelLink(5)
    const client = { resetAll: vi.fn() }
    const off = resetSyncOnReconnect(link, client)
    expect(link.readyEpoch).toBe(0)
    port.push({ kind: 'status', state: 'ready' })
    expect(link.readyEpoch).toBe(1)
    port.push({ kind: 'status', state: 'desktop-offline' })
    port.push({ kind: 'status', state: 'ready' })
    expect(link.readyEpoch).toBe(2)
    expect(client.resetAll).toHaveBeenCalledTimes(1)
    off()
    port.push({ kind: 'status', state: 'connecting' })
    port.push({ kind: 'status', state: 'ready' })
    expect(client.resetAll).toHaveBeenCalledTimes(1)
  })
})
