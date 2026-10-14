/**
 * SW 的侧边栏转发（background/panels.ts）—— 视图同步链路那一半（pi 1.2 / chord2）与事件路由：
 *
 *   SL-1 侧边栏的 `{kind:'sync.link', link, frame}` → 桥事件 `sync.link {panelId, link, frame}`（panelId = 端口名）；
 *        连接没就绪就丢
 *   SL-2 桌面的 `sync.link` 只给 `panelId` 那个侧边栏；没有那个侧边栏 / 形状不对 → 丢掉
 *   SL-3 端口断开 → 替它在用过的每条链路上补一帧 `bye`；连接没就绪不补；连接断过一次，旧记账作废
 *   SL-4 chat.event 照旧按会话、app.event 照旧给所有侧边栏
 *   SL-5 页面刷新（同一标签页、新端口）→ 桌面的帧给新端口；旧端口断开只替旧端口的链路补 bye
 *   SL-6 forgetTab 之后，桌面发给那个侧边栏的 sync.link 丢掉
 *   SL-7 每个端口最多 64 条链路：第 65 个 id 不转，前 64 个照转，断开只补这 64 条的 bye
 *   SL-8 转发一帧 bye（侧边栏发的或桌面发的）就把那个 id 划掉：不再占名额，断开时也不再补第二帧 bye
 *   SL-9 链路 id 不是字符串 / 为空 → 不转、不记（不占名额、断开不补 bye）
 *   SL-10 原生连接离开 ready：挂着的请求照旧以 desktop-offline 失败，链路记账清零（名额也回来了）
 *
 * nativeLink 换成可控的替身（连接状态、发往桌面的消息）；chrome.runtime.Port 是假的。模块级状态每条用例
 * resetModules 后重新 import 一份。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BridgeMessage } from '@shuvix/chat-protocol/chromeBridge'
import type { PanelLinkState, WorkerToPanel } from '../../shared/panelLink'

const link = vi.hoisted(() => ({
  state: 'ready' as PanelLinkState,
  listeners: new Set<(state: PanelLinkState) => void>(),
  sent: [] as BridgeMessage[]
}))

vi.mock('../nativeLink', () => ({
  linkState: () => link.state,
  onLinkState: (fn: (state: PanelLinkState) => void) => {
    link.listeners.add(fn)
    return () => link.listeners.delete(fn)
  },
  sendToDesktop: (message: BridgeMessage) => {
    link.sent.push(message)
    return link.state === 'ready'
  },
  ensureNativeLink: () => {}
}))

type Panels = typeof import('../panels')

/** 侧边栏那条 chrome.runtime 端口的替身 */
class FakePort {
  readonly posted: WorkerToPanel[] = []
  private readonly messageListeners: Array<(message: unknown) => void> = []
  private readonly disconnectListeners: Array<() => void> = []
  constructor(readonly name: string) {}
  readonly onMessage = {
    addListener: (fn: (message: unknown) => void): void => {
      this.messageListeners.push(fn)
    }
  }
  readonly onDisconnect = {
    addListener: (fn: () => void): void => {
      this.disconnectListeners.push(fn)
    }
  }
  postMessage = (message: WorkerToPanel): void => {
    this.posted.push(message)
  }
  disconnect = (): void => {}
  /** 侧边栏发来一条 */
  send(message: unknown): void {
    for (const fn of this.messageListeners) fn(message)
  }
  /** 侧边栏关了 / 刷新了 */
  close(): void {
    for (const fn of this.disconnectListeners) fn()
  }
  of(kind: WorkerToPanel['kind']): WorkerToPanel[] {
    return this.posted.filter((m) => m.kind === kind)
  }
}

let panels: Panels
let nextId = 0

beforeEach(async () => {
  vi.resetModules()
  link.state = 'ready'
  link.listeners.clear()
  link.sent.length = 0
  nextId = 0
  panels = await import('../panels')
})

const asPort = (p: FakePort): chrome.runtime.Port => p as unknown as chrome.runtime.Port

/** 开一个挂着会话 sid 的侧边栏（tabSession.open 的应答让 SW 记下标签页 → 会话） */
function openPanel(tabId: number, sessionId: string): FakePort {
  const port = new FakePort(`panel:${tabId}`)
  panels.acceptPanelPort(asPort(port))
  request(port, 'tabSession.open', { tabId })
  const bridge = link.sent.at(-1) as { id: string }
  panels.deliverResponse({ type: 'response', id: bridge.id, ok: true, result: { sessionId } })
  return port
}

/** 侧边栏发一个请求（回发往桌面的那条桥请求） */
function request(port: FakePort, method: string, params: unknown): BridgeMessage {
  port.send({ kind: 'request', id: ++nextId, method, params })
  return link.sent.at(-1)!
}

/** 侧边栏发一帧链路帧 */
function linkFrame(port: FakePort, link: string, frame: unknown): void {
  port.send({ kind: 'sync.link', link, frame })
}

/** 发往桌面的 `sync.link` 事件 */
const syncEvents = (from = 0): BridgeMessage[] =>
  link.sent.slice(from).filter((m) => m.type === 'event' && m.name === 'sync.link')

describe('SL-1 侧边栏的链路帧 → 桥事件', () => {
  it('SL-1 补上 panelId 原样转给桌面；连接没就绪就丢', () => {
    const p1 = openPanel(1, 'sA')
    const hello = { t: 'hello', name: 'client', kind: 'client', epoch: 1 }
    linkFrame(p1, 'tab1.x.1', hello)
    expect(syncEvents()).toEqual([
      {
        type: 'event',
        name: 'sync.link',
        params: { panelId: 'panel:1', link: 'tab1.x.1', frame: hello }
      }
    ])
    link.state = 'desktop-offline'
    const before = link.sent.length
    linkFrame(p1, 'tab1.x.1', { t: 'ping', n: 1 })
    expect(syncEvents(before)).toEqual([])
  })
})

describe('SL-2 桌面的链路帧 → 那个侧边栏', () => {
  it('SL-2 只给 panelId 那个侧边栏；没有那个侧边栏 / 形状不对 → 丢掉', () => {
    const p1 = openPanel(1, 'sA')
    const p2 = openPanel(2, 'sB')
    const frame = { t: 'state', id: 1, ops: [] }
    panels.deliverDesktopEvent({
      type: 'event',
      name: 'sync.link',
      params: { panelId: 'panel:2', link: 'L', frame }
    })
    expect(p1.of('sync.link')).toEqual([])
    expect(p2.of('sync.link')).toEqual([{ kind: 'sync.link', link: 'L', frame }])
    for (const params of [
      { panelId: 'panel:9', link: 'L', frame },
      { panelId: 'tab:1', link: 'L', frame },
      { panelId: 'panel:1', frame },
      undefined
    ]) {
      panels.deliverDesktopEvent({ type: 'event', name: 'sync.link', params })
    }
    expect(p1.of('sync.link')).toEqual([])
  })
})

describe('SL-3 侧边栏关了、标签页还在：SW 替它关链路', () => {
  it('SL-3 端口断开 → 用过的每条链路各补一帧 bye', () => {
    const p1 = openPanel(1, 'sA')
    linkFrame(p1, 'L1', { t: 'hello', name: 'c', kind: 'client', epoch: 1 })
    linkFrame(p1, 'L2', { t: 'hello', name: 'c', kind: 'client', epoch: 1 })
    linkFrame(p1, 'L2', { t: 'ping', n: 1 })
    const before = link.sent.length
    p1.close()
    expect(syncEvents(before).map((m) => (m as { params: unknown }).params)).toEqual([
      { panelId: 'panel:1', link: 'L1', frame: { t: 'bye', reason: 'side panel closed' } },
      { panelId: 'panel:1', link: 'L2', frame: { t: 'bye', reason: 'side panel closed' } }
    ])
  })

  it('SL-3 连接没就绪时断开不补；连接断过一次，旧记账作废', () => {
    const p1 = openPanel(1, 'sA')
    linkFrame(p1, 'L1', { t: 'hello', name: 'c', kind: 'client', epoch: 1 })
    link.state = 'desktop-offline'
    for (const fn of link.listeners) fn('desktop-offline')
    link.state = 'ready'
    for (const fn of link.listeners) fn('ready')
    const before = link.sent.length
    p1.close()
    expect(syncEvents(before)).toEqual([])

    const p2 = openPanel(2, 'sB')
    linkFrame(p2, 'L9', { t: 'hello', name: 'c', kind: 'client', epoch: 1 })
    link.state = 'desktop-offline'
    const after = link.sent.length
    p2.close()
    expect(syncEvents(after)).toEqual([])
  })
})

describe('SL-4 事件路由', () => {
  it('SL-4 chat.event 照旧按会话、app.event 照旧给所有侧边栏', () => {
    const p1 = openPanel(1, 'sA')
    const p2 = openPanel(2, 'sB')
    const event = { type: 'agent_start', sessionId: 'sB' }
    panels.deliverDesktopEvent({
      type: 'event',
      name: 'chat.event',
      params: { sessionId: 'sB', event }
    })
    expect(p1.of('chat.event')).toEqual([])
    expect(p2.of('chat.event')).toEqual([{ kind: 'chat.event', event }])
    const appEvent = { type: 'settings.changed' }
    panels.deliverDesktopEvent({ type: 'event', name: 'app.event', params: { event: appEvent } })
    expect(p1.of('app.event')).toEqual([{ kind: 'app.event', event: appEvent }])
    expect(p2.of('app.event')).toEqual([{ kind: 'app.event', event: appEvent }])
  })
})

const HELLO = { t: 'hello', name: 'c', kind: 'client', epoch: 1 }
const BYE_CLOSED = { t: 'bye', reason: 'side panel closed' }

/** 发往桌面的 sync.link 事件的参数 */
const syncParams = (from = 0): Array<{ panelId: string; link: string; frame: unknown }> =>
  syncEvents(from).map(
    (m) => (m as { params: { panelId: string; link: string; frame: unknown } }).params
  )

/** 桌面推一帧 sync.link 给某个侧边栏 */
function desktopFrame(panelId: string, link: string, frame: unknown): void {
  panels.deliverDesktopEvent({ type: 'event', name: 'sync.link', params: { panelId, link, frame } })
}

/** 原生连接的状态变了（SW 收到 onLinkState） */
function setLinkState(state: PanelLinkState): void {
  link.state = state
  for (const fn of [...link.listeners]) fn(state)
}

describe('SL-5 页面刷新：同一标签页换了一条端口', () => {
  it('SL-5 桌面的帧给新端口；旧端口断开只补旧端口用过的链路的 bye，新端口照常收', () => {
    const oldPort = openPanel(1, 'sA')
    linkFrame(oldPort, 'A.1', HELLO)
    const newPort = openPanel(1, 'sA')
    linkFrame(newPort, 'B.1', HELLO)

    desktopFrame('panel:1', 'B.1', { t: 'state', id: 1, ops: [] })
    expect(newPort.of('sync.link')).toEqual([
      { kind: 'sync.link', link: 'B.1', frame: { t: 'state', id: 1, ops: [] } }
    ])
    expect(oldPort.of('sync.link')).toEqual([])

    const before = link.sent.length
    oldPort.close()
    expect(syncParams(before)).toEqual([{ panelId: 'panel:1', link: 'A.1', frame: BYE_CLOSED }])

    // 旧端口走了，路由还指着新端口
    desktopFrame('panel:1', 'B.1', { t: 'pong', n: 1 })
    expect(newPort.of('sync.link').at(-1)).toEqual({
      kind: 'sync.link',
      link: 'B.1',
      frame: { t: 'pong', n: 1 }
    })
    expect(oldPort.of('sync.link')).toEqual([])

    const after = link.sent.length
    newPort.close()
    expect(syncParams(after)).toEqual([{ panelId: 'panel:1', link: 'B.1', frame: BYE_CLOSED }])
  })
})

describe('SL-6 标签页关了', () => {
  it('SL-6 forgetTab 之后，桌面发给那个侧边栏的 sync.link 丢掉', () => {
    const p1 = openPanel(1, 'sA')
    const p2 = openPanel(2, 'sB')
    linkFrame(p1, 'L1', HELLO)
    panels.forgetTab(1)
    desktopFrame('panel:1', 'L1', { t: 'state', id: 1, ops: [] })
    desktopFrame('panel:2', 'L9', { t: 'pong', n: 1 })
    expect(p1.of('sync.link')).toEqual([])
    expect(p2.of('sync.link')).toEqual([
      { kind: 'sync.link', link: 'L9', frame: { t: 'pong', n: 1 } }
    ])

    // 端口随后断开：它用过的链路照样补 bye（桌面那头的链路不会漏着）
    const before = link.sent.length
    p1.close()
    expect(syncParams(before)).toEqual([{ panelId: 'panel:1', link: 'L1', frame: BYE_CLOSED }])
  })
})

describe('SL-7 每个端口的链路数上限', () => {
  it('SL-7 第 65 个不同的链路 id 不转；前 64 个照转；断开只补这 64 条的 bye', () => {
    const p1 = openPanel(1, 'sA')
    const ids = Array.from({ length: 64 }, (_, index) => `L${index}`)
    for (const id of ids) linkFrame(p1, id, HELLO)
    expect(syncParams().map((p) => p.link)).toEqual(ids)

    let before = link.sent.length
    linkFrame(p1, 'L64', HELLO)
    linkFrame(p1, 'L64', { t: 'hold', id: 1 })
    expect(syncParams(before)).toEqual([])

    // 已记着的照转
    linkFrame(p1, 'L0', { t: 'ping', n: 1 })
    linkFrame(p1, 'L63', { t: 'ping', n: 2 })
    expect(syncParams(before).map((p) => [p.link, p.frame])).toEqual([
      ['L0', { t: 'ping', n: 1 }],
      ['L63', { t: 'ping', n: 2 }]
    ])

    before = link.sent.length
    p1.close()
    const byes = syncParams(before)
    expect(byes.map((p) => p.link)).toEqual(ids)
    expect(byes.every((p) => JSON.stringify(p.frame) === JSON.stringify(BYE_CLOSED))).toBe(true)
  })

  it('SL-7 名额按端口算：另一个侧边栏有自己的 64 条', () => {
    const p1 = openPanel(1, 'sA')
    const p2 = openPanel(2, 'sB')
    for (let index = 0; index < 64; index++) linkFrame(p1, `L${index}`, HELLO)
    const before = link.sent.length
    linkFrame(p2, 'L0', HELLO)
    expect(syncParams(before)).toEqual([{ panelId: 'panel:2', link: 'L0', frame: HELLO }])
  })
})

describe('SL-8 关掉的链路不再占名额、不补第二帧 bye', () => {
  it('SL-8 侧边栏自己发了 bye 的链路：腾出名额；断开时不再替它补 bye', () => {
    const p1 = openPanel(1, 'sA')
    for (let index = 0; index < 64; index++) linkFrame(p1, `L${index}`, HELLO)
    let before = link.sent.length
    linkFrame(p1, 'L0', { t: 'bye', reason: 'idle' })
    expect(syncParams(before)).toEqual([
      { panelId: 'panel:1', link: 'L0', frame: { t: 'bye', reason: 'idle' } }
    ])

    // 腾出来的名额给新链路
    before = link.sent.length
    linkFrame(p1, 'L64', HELLO)
    expect(syncParams(before)).toEqual([{ panelId: 'panel:1', link: 'L64', frame: HELLO }])
    // 名额又满了
    before = link.sent.length
    linkFrame(p1, 'L65', HELLO)
    expect(syncParams(before)).toEqual([])

    before = link.sent.length
    p1.close()
    const byes = syncParams(before).map((p) => p.link)
    expect(byes).toHaveLength(64)
    expect(byes).not.toContain('L0')
    expect(byes).toContain('L64')
  })

  it('SL-8 桌面关掉的链路（桌面发来 bye）同样划掉：腾出名额、断开不补', () => {
    const p1 = openPanel(1, 'sA')
    for (let index = 0; index < 64; index++) linkFrame(p1, `L${index}`, HELLO)
    desktopFrame('panel:1', 'L5', { t: 'bye', reason: 'view server disposed' })
    expect(p1.of('sync.link').at(-1)).toEqual({
      kind: 'sync.link',
      link: 'L5',
      frame: { t: 'bye', reason: 'view server disposed' }
    })

    let before = link.sent.length
    linkFrame(p1, 'L64', HELLO)
    expect(syncParams(before).map((p) => p.link)).toEqual(['L64'])

    before = link.sent.length
    p1.close()
    const byes = syncParams(before).map((p) => p.link)
    expect(byes).toHaveLength(64)
    expect(byes).not.toContain('L5')
  })

  it('SL-8 一条链路反复开关（同一个 id 先 bye 再 hello）：只占一个名额，断开只补一次', () => {
    const p1 = openPanel(1, 'sA')
    for (let round = 0; round < 100; round++) {
      linkFrame(p1, `R${round}`, HELLO)
      linkFrame(p1, `R${round}`, { t: 'bye', reason: 'idle' })
    }
    linkFrame(p1, 'last', HELLO)
    const before = link.sent.length
    p1.close()
    expect(syncParams(before)).toEqual([{ panelId: 'panel:1', link: 'last', frame: BYE_CLOSED }])
  })
})

describe('SL-9 链路 id 不对', () => {
  it('SL-9 不是字符串 / 为空 → 不转、不记：不占名额，断开也不替它补 bye', () => {
    const p1 = openPanel(1, 'sA')
    const before = link.sent.length
    for (const bad of ['', 5, null, undefined, {}, ['L1']]) {
      for (let index = 0; index < 20; index++) {
        p1.send({ kind: 'sync.link', link: bad, frame: HELLO })
      }
    }
    expect(syncParams(before)).toEqual([])

    // 一个名额都没被吃掉：64 条正常的链路照转
    for (let index = 0; index < 64; index++) linkFrame(p1, `L${index}`, HELLO)
    expect(syncParams(before)).toHaveLength(64)

    const after = link.sent.length
    p1.close()
    expect(syncParams(after).map((p) => p.link)).toEqual(
      Array.from({ length: 64 }, (_, index) => `L${index}`)
    )
  })
})

describe('SL-10 原生连接离开 ready', () => {
  it('SL-10 挂着的请求以 desktop-offline 失败；链路记账清零（断开不补 bye，名额回来）', () => {
    const p1 = openPanel(1, 'sA')
    for (let index = 0; index < 64; index++) linkFrame(p1, `L${index}`, HELLO)
    const pendingBridge = request(p1, 'channel.call', { path: 'agent.init', args: [] }) as {
      id: string
    }
    const requestId = nextId

    setLinkState('desktop-offline')
    expect(p1.of('status').at(-1)).toEqual({ kind: 'status', state: 'desktop-offline' })
    expect(p1.of('response').at(-1)).toEqual({
      kind: 'response',
      id: requestId,
      ok: false,
      error: 'desktop-offline'
    })
    // 迟到的应答：没人等了
    expect(
      panels.deliverResponse({ type: 'response', id: pendingBridge.id, ok: true, result: {} })
    ).toBe(false)
    // 没就绪时的链路帧：丢
    let before = link.sent.length
    linkFrame(p1, 'L0', { t: 'ping', n: 1 })
    expect(syncParams(before)).toEqual([])

    setLinkState('ready')
    expect(p1.of('status').at(-1)).toEqual({ kind: 'status', state: 'ready' })
    // 记账清零：64 条新链路照转（旧的那 64 条不再占名额）
    before = link.sent.length
    for (let index = 0; index < 64; index++) linkFrame(p1, `N${index}`, HELLO)
    expect(syncParams(before)).toHaveLength(64)

    // 断开：只替就绪之后的新链路补 bye（旧链路随连接一起没了）
    before = link.sent.length
    p1.close()
    const byes = syncParams(before).map((p) => p.link)
    expect(byes).toEqual(Array.from({ length: 64 }, (_, index) => `N${index}`))
  })
})
