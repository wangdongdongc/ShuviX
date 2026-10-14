/**
 * 侧边栏 channelApi 里经桥的那几条：
 *
 *   PS-1 （pi 1.2）`sync` 是一条链路渠道：`send(link, frame)` → 端口上的 `{kind:'sync.link', link, frame}`
 *        （没就绪不发）；`onFrame` 只收 `sync.link`、带链路 id；`isUp` / `onDown` / `onUp` 跟着 PanelLink 的状态
 *   PS-2 真的 syncClient 跑在 `createPanelSyncChannel` 上（真的 PanelLink、假的 SW 端口，「桌面」是 chat-ui 的
 *        fakeServer 宿主、每个链路 id 一条 FrameLink）：ready → live；desktop-offline → loading、值清空、断着时
 *        端口上一帧都不发；再 ready → 新链路 id 的 hello、新快照、live
 *   PS-3 SW 端口断开（SW 被回收）→ connecting → down；500 ms 后侧边栏重连 → ready → 新链路
 *   PS-4 断着时登记的监听器不会收到假的 down；同样的状态再来一次什么也不发
 *   P3-11-10 （翻面）`withdrawQueued` → `channel.call('agent.withdrawQueued', params)`；agent 上没有「下一轮」
 *   P3-12-08 `continue(sid)` → `channel.call('agent.continue', sid)`，回包原样
 *
 * PanelLink 是真的（端口是假的 chrome.runtime.connect）：帧从 SW 的消息一路走到 onFrame 的回调。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JsonValue, SyncTarget } from '@shuvix/chat-protocol/sync'
import { emptySessionView, type SessionView } from '@shuvix/chat-protocol/types/sessionView'
import type { PanelToWorker, WorkerToPanel } from '../../shared/panelLink'
import { createPanelChannelApi, createPanelSyncChannel } from '../channelApi'
import { PanelLink } from '../panelLink'
import {
  createSyncClient,
  type SyncClient
} from '../../../../../packages/chat-ui/src/sync/syncClient'
import {
  fakeServer,
  type FakeServer
} from '../../../../../packages/chat-ui/src/sync/__tests__/support/fakeServer'

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

describe('PS-1 侧边栏的 sync 链路渠道', () => {
  it('PS-1 send → 端口上的 sync.link（就绪才发）；onFrame 只收 sync.link、带链路 id；注销只摘自己那份', () => {
    const link = new PanelLink(5)
    const api = createPanelChannelApi(link)
    api.sync.send('L1', { t: 'ping', n: 1 })
    expect(port.posted.filter((m) => m.kind === 'sync.link')).toEqual([])
    port.push({ kind: 'status', state: 'ready' })
    api.sync.send('L1', { t: 'ping', n: 2 })
    expect(port.posted.filter((m) => m.kind === 'sync.link')).toEqual([
      { kind: 'sync.link', link: 'L1', frame: { t: 'ping', n: 2 } }
    ])
    const got: unknown[] = []
    const stop = api.sync.onFrame((id, frame) => got.push([id, frame]))
    port.push({ kind: 'sync.link', link: 'L1', frame: { t: 'pong', n: 2 } })
    port.push({ kind: 'chat.event', event: { type: 'x' } })
    stop()
    stop()
    port.push({ kind: 'sync.link', link: 'L1', frame: { t: 'pong', n: 3 } })
    expect(got).toEqual([['L1', { t: 'pong', n: 2 }]])
  })

  it('PS-1 isUp / onDown / onUp 跟着 PanelLink 的状态（离开 ready = down，回到 ready = up）', () => {
    const link = new PanelLink(5)
    const api = createPanelChannelApi(link)
    const sync = api.sync
    const events: string[] = []
    sync.onDown!((reason) => events.push(`down:${reason}`))
    sync.onUp!(() => events.push('up'))
    expect(sync.isUp!()).toBe(false)
    port.push({ kind: 'status', state: 'ready' })
    expect(sync.isUp!()).toBe(true)
    port.push({ kind: 'status', state: 'desktop-offline' })
    expect(sync.isUp!()).toBe(false)
    port.push({ kind: 'status', state: 'ready' })
    expect(events).toEqual(['up', 'down:side panel link desktop-offline', 'up'])
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

// ─── PS-2 … PS-4：真的 syncClient 跑在侧边栏的渠道上 ─────────────────────

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function until(check: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timeout: ${what}`)
    await sleep(2)
  }
}

/**
 * 「桌面」：chat-ui 的 fakeServer 宿主（同样的 `shuvix.session-view` 契约），侧边栏的每个链路 id 在它那头一条
 * FrameLink。SW 的端口把侧边栏的 `sync.link` 帧交给它，它的帧经此刻的端口回到侧边栏；桌面不在（桥断了）时两个方向
 * 都丢。
 */
class Desktop {
  readonly server: FakeServer = fakeServer()
  online = true
  port: SwPort | undefined

  constructor() {
    this.server.channel.onFrame((link, frame) => {
      if (this.online) this.port?.push({ kind: 'sync.link', link, frame })
    })
  }

  fromPanel(link: string, frame: unknown): void {
    if (this.online) this.server.channel.send(link, frame as JsonValue)
  }

  /** 桥连接断了：桌面那头的链路随之结束（与链路表的 closeConnection 一样） */
  endLinks(ids: string[]): void {
    for (const id of ids) this.server.channel.send(id, { t: 'bye', reason: 'Chrome disconnected' })
  }
}

/** SW 那头的端口：侧边栏的 `sync.link` 帧转给桌面，别的只记下 */
class SwPort {
  readonly posted: PanelToWorker[] = []
  private readonly messageListeners: Array<(message: WorkerToPanel) => void> = []
  private readonly disconnectListeners: Array<() => void> = []
  disconnected = false

  constructor(private readonly desktop: Desktop) {}

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
    if (this.disconnected) throw new Error('port disconnected')
    this.posted.push(message)
    if (message.kind === 'sync.link') this.desktop.fromPanel(message.link, message.frame)
  }
  push(message: WorkerToPanel): void {
    if (this.disconnected) return
    for (const fn of this.messageListeners) fn(message)
  }
  /** SW 被回收 / 重启：端口断开 */
  drop(): void {
    this.disconnected = true
    for (const fn of this.disconnectListeners) fn()
  }
  /** 侧边栏发出的链路帧 */
  syncFrames(): Array<{ link: string; frame: unknown }> {
    return this.posted
      .filter((m): m is Extract<PanelToWorker, { kind: 'sync.link' }> => m.kind === 'sync.link')
      .map(({ link, frame }) => ({ link, frame }))
  }
}

const S5: SyncTarget = { kind: 'session', sessionId: 's5' }

function view5(): SessionView {
  return { ...emptySessionView('s5'), source: 'durable', conversationId: 1 }
}

describe('PS-2 … PS-4 真的 syncClient 跑在侧边栏的渠道上', () => {
  let desktop: Desktop
  let ports: SwPort[]
  let clients: SyncClient[]

  beforeEach(() => {
    desktop = new Desktop()
    desktop.server.serve(S5, view5())
    ports = []
    clients = []
    vi.stubGlobal('chrome', {
      runtime: {
        connect: () => {
          const next = new SwPort(desktop)
          ports.push(next)
          desktop.port = next
          return next
        }
      }
    })
  })

  afterEach(() => {
    for (const client of clients) client.dispose()
  })

  function clientOf(link: PanelLink): SyncClient {
    const client = createSyncClient({
      channel: createPanelSyncChannel(link),
      idPrefix: 'tab5',
      reconnectDelayMs: 5,
      logger: { warn: () => {} }
    })
    clients.push(client)
    return client
  }

  it('PS-2 ready → live；desktop-offline → loading、值清空、断着时不发帧；再 ready → 新链路的 hello、新快照', async () => {
    const link = new PanelLink(5)
    const sw = ports[0]
    sw.push({ kind: 'status', state: 'ready' })
    const sub = clientOf(link).acquire<SessionView>(S5)
    const statuses: string[] = []
    sub.subscribe((event) => {
      if (event.kind === 'status') statuses.push(event.state.status)
    })
    await until(() => sub.state().status === 'live', 'live')
    expect(sub.value()).toEqual(view5())
    const firstLink = sw.syncFrames()[0].link
    expect(firstLink).toMatch(/^tab5\./)
    expect(sw.syncFrames()[0].frame).toMatchObject({ t: 'hello' })

    // 桌面不在了：桥断了，桌面那头的链路随之结束；侧边栏回到 loading，旧值作废
    desktop.online = false
    desktop.endLinks([firstLink])
    sw.push({ kind: 'status', state: 'desktop-offline' })
    expect(sub.state()).toEqual({ status: 'loading' })
    expect(sub.value()).toBeUndefined()

    // 断着的时候会话往前走了；侧边栏一帧也不往端口上发（退避时间早过了也不发）
    desktop.server.change(S5, (draft) => {
      draft.run = { state: 'busy' }
    })
    const sentBefore = sw.syncFrames().length
    await sleep(40)
    expect(sw.syncFrames().length).toBe(sentBefore)
    expect(sub.state()).toEqual({ status: 'loading' })

    // 再 ready：新链路 id 的 hello 先发出去，然后是新快照
    desktop.online = true
    sw.push({ kind: 'status', state: 'ready' })
    await until(() => sub.state().status === 'live', 'live again')
    const fresh = sw.syncFrames().slice(sentBefore)
    expect(fresh[0].link).not.toBe(firstLink)
    expect(fresh[0].link).toMatch(/^tab5\./)
    expect(fresh[0].frame).toMatchObject({ t: 'hello' })
    expect(new Set(fresh.map((f) => f.link))).toEqual(new Set([fresh[0].link]))
    expect(sub.value()?.run).toEqual({ state: 'busy' })
    expect(desktop.server.subscriptions(S5)).toHaveLength(1)
    expect(statuses).toEqual(['live', 'loading', 'live'])
  })

  it('PS-3 SW 端口断开 → connecting → down；500 ms 后重连 → ready → 新链路', async () => {
    const link = new PanelLink(5)
    const first = ports[0]
    first.push({ kind: 'status', state: 'ready' })
    const sub = clientOf(link).acquire<SessionView>(S5)
    await until(() => sub.state().status === 'live', 'live')
    const firstLink = first.syncFrames()[0].link

    const t0 = Date.now()
    first.drop()
    desktop.endLinks([firstLink])
    expect(link.state).toBe('connecting')
    expect(sub.state()).toEqual({ status: 'loading' })
    expect(sub.value()).toBeUndefined()

    // 侧边栏隔 500 ms 重连
    await until(() => ports.length === 2, 'reconnected', 3000)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(450)
    const second = ports[1]
    expect(link.state).toBe('connecting')
    await sleep(20)
    expect(second.syncFrames()).toEqual([])

    desktop.server.change(S5, (draft) => {
      draft.run = { state: 'busy' }
    })
    second.push({ kind: 'status', state: 'ready' })
    await until(() => sub.state().status === 'live', 'live again')
    const fresh = second.syncFrames()
    expect(fresh[0].frame).toMatchObject({ t: 'hello' })
    expect(fresh[0].link).not.toBe(firstLink)
    expect(sub.value()?.run).toEqual({ state: 'busy' })
    // 旧端口断开之后什么也没往它上面写
    expect(first.syncFrames().every((f) => f.link === firstLink)).toBe(true)
  })

  it('PS-4 断着时登记的监听器不收假的 down；同样的状态再来一次什么也不发', () => {
    vi.useFakeTimers()
    try {
      const link = new PanelLink(5)
      const port = ports[0]
      const sync = createPanelSyncChannel(link)
      const early: string[] = []
      sync.onDown!((reason) => early.push(`down:${reason}`))
      sync.onUp!(() => early.push('up'))

      // 一直没就绪：换来换去都是「不在」，谁也不报 down
      port.push({ kind: 'status', state: 'desktop-offline' })
      port.push({ kind: 'status', state: 'host-missing' })
      port.push({ kind: 'status', state: 'host-missing' })
      expect(early).toEqual([])

      port.push({ kind: 'status', state: 'ready' })
      port.push({ kind: 'status', state: 'ready' })
      expect(early).toEqual(['up'])

      // 就绪时登记的：重复的 ready 不报 up
      const late: string[] = []
      const stopLateDown = sync.onDown!((reason) => late.push(`down:${reason}`))
      sync.onUp!(() => late.push('up'))
      port.push({ kind: 'status', state: 'ready' })
      expect(late).toEqual([])

      // 离开 ready 报一次 down；之后再换别的「不在」状态、端口断开（connecting）都不再报
      port.push({ kind: 'status', state: 'desktop-offline' })
      port.push({ kind: 'status', state: 'mismatch' })
      port.push({ kind: 'status', state: 'desktop-offline' })
      port.drop()
      expect(link.state).toBe('connecting')
      expect(early).toEqual(['up', 'down:side panel link desktop-offline'])
      expect(late).toEqual(['down:side panel link desktop-offline'])

      // 断着时登记的监听器：500 ms 后重连、就绪 → 一次 up，没有先来一个假的 down
      const whileDown: string[] = []
      sync.onDown!((reason) => whileDown.push(`down:${reason}`))
      sync.onUp!(() => whileDown.push('up'))
      stopLateDown()
      vi.advanceTimersByTime(499)
      expect(ports).toHaveLength(1)
      vi.advanceTimersByTime(1)
      expect(ports).toHaveLength(2)
      ports[1].push({ kind: 'status', state: 'connecting' })
      ports[1].push({ kind: 'status', state: 'ready' })
      ports[1].push({ kind: 'status', state: 'ready' })
      expect(whileDown).toEqual(['up'])
      expect(early).toEqual(['up', 'down:side panel link desktop-offline', 'up'])

      // 注销了的 down 监听器不再收
      ports[1].push({ kind: 'status', state: 'desktop-offline' })
      expect(late).toEqual(['down:side panel link desktop-offline', 'up'])
      expect(whileDown).toEqual(['up', 'down:side panel link desktop-offline'])
      expect(sync.isUp!()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
