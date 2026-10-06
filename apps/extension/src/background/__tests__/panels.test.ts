/**
 * SW 的侧边栏转发（background/panels.ts）—— 视图同步那一半（P3-09，docs/pi-durable/p3-0809-test-design.md）：
 *
 *   P3-09-09 `sync.frame {sessionId, frame}` 只给挂着那条会话的侧边栏（`{kind:'sync.frame', frame}`）；
 *            没有侧边栏挂着就丢掉；chat.event / app.event 的路由不变
 *   P3-09-14 （SW 那一侧，PIN-11）每个端口开着的订阅记账；端口断开就替它补发退订（同一个形状、目标原样）；
 *            侧边栏自己退订过的不再补；连接没就绪不补；连接断过一次，旧记账作废
 *   SYNC-T   syncTracking 认的线上形状与 chord 的 `createServiceSubscribeCall` / `createServiceUnsubscribeCall`
 *            一致（SW 不引 chord，形状由这里钉住）
 *
 * nativeLink 换成可控的替身（连接状态、发往桌面的消息）；chrome.runtime.Port 是假的。模块级状态每条用例
 * resetModules 后重新 import 一份。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createServiceSubscribeCall, createServiceUnsubscribeCall } from '@earendil-works/chord'
import type { BridgeMessage } from '@shuvix/chat-protocol/chromeBridge'
import { CHAT_VIEW_SERVICE_ID } from '@shuvix/chat-protocol/sync'
import type { PanelLinkState, WorkerToPanel } from '../../shared/panelLink'
import { PortSubscriptions, syncControlOf, syncUnsubscribeParams } from '../syncTracking'

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

const target = (sessionId: string): unknown => ({ kind: 'session', sessionId })
const subscribe = (sessionId: string, id: string): { path: string; args: unknown[] } => ({
  path: 'sync.invoke',
  args: [target(sessionId), createServiceSubscribeCall(id, CHAT_VIEW_SERVICE_ID, 'singleton')]
})
const unsubscribe = (sessionId: string, id: string): { path: string; args: unknown[] } => ({
  path: 'sync.invoke',
  args: [target(sessionId), createServiceUnsubscribeCall(id)]
})

/** 发往桌面的补发退订（SW 自己发的那几条） */
const syntheticUnsubscribes = (from = 0): BridgeMessage[] =>
  link.sent.slice(from).filter((m) => {
    if (m.type !== 'request' || m.method !== 'channel.call') return false
    return syncControlOf(m.params)?.type === 'unsubscribe'
  })

describe('P3-09-09 sync.frame 按会话送给侧边栏', () => {
  it('P3-09-09 帧只给挂着那条会话的侧边栏；别的侧边栏收不到', () => {
    const p1 = openPanel(1, 'sA')
    const p2 = openPanel(2, 'sB')
    const frame = {
      target: { kind: 'session', sessionId: 'sA' },
      subscriptionId: 't1#1',
      update: {}
    }
    panels.deliverDesktopEvent({
      type: 'event',
      name: 'sync.frame',
      params: { sessionId: 'sA', frame }
    })
    expect(p1.of('sync.frame')).toEqual([{ kind: 'sync.frame', frame }])
    expect(p2.of('sync.frame')).toEqual([])
  })

  it('P3-09-09 没有侧边栏挂着的会话（或信封没有会话 id）→ 丢掉，谁也不给', () => {
    const p1 = openPanel(1, 'sA')
    panels.deliverDesktopEvent({
      type: 'event',
      name: 'sync.frame',
      params: { sessionId: 'nobody', frame: {} }
    })
    panels.deliverDesktopEvent({ type: 'event', name: 'sync.frame', params: { frame: {} } })
    panels.deliverDesktopEvent({ type: 'event', name: 'sync.frame' })
    expect(p1.of('sync.frame')).toEqual([])
  })

  it('P3-09-09 侧边栏关了之后它的会话的帧不再送；标签页关了（forgetTab）同样', () => {
    const p1 = openPanel(1, 'sA')
    const p2 = openPanel(2, 'sB')
    p1.close()
    panels.forgetTab(2)
    for (const sessionId of ['sA', 'sB']) {
      panels.deliverDesktopEvent({
        type: 'event',
        name: 'sync.frame',
        params: { sessionId, frame: { x: 1 } }
      })
    }
    expect(p1.of('sync.frame')).toEqual([])
    expect(p2.of('sync.frame')).toEqual([])
  })

  it('P3-09-09 chat.event 照旧按会话、app.event 照旧给所有侧边栏', () => {
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

describe('P3-09-14 侧边栏关了、标签页还在：SW 替它退订（PIN-11）', () => {
  it('P3-09-14 端口断开 → 每个还开着的订阅补发一条退订（目标原样、形状与侧边栏自己退订时一样）', () => {
    const p1 = openPanel(1, 'sA')
    request(p1, 'channel.call', subscribe('sA', 'tab1.n#1'))
    request(p1, 'channel.call', subscribe('sA', 'tab1.n#2'))
    const from = link.sent.length
    p1.close()
    const sent = syntheticUnsubscribes(from)
    expect(sent.map((m) => (m as { params: unknown }).params)).toEqual([
      unsubscribe('sA', 'tab1.n#1'),
      unsubscribe('sA', 'tab1.n#2')
    ])
    // 各有自己的桥请求 id，不撞侧边栏的那些
    const ids = link.sent.map((m) => (m as { id?: string }).id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('P3-09-14 侧边栏自己退订过的不再补；别的侧边栏的订阅不碰', () => {
    const p1 = openPanel(1, 'sA')
    const p2 = openPanel(2, 'sB')
    request(p1, 'channel.call', subscribe('sA', 'tab1.n#1'))
    request(p1, 'channel.call', subscribe('sA', 'tab1.n#2'))
    request(p2, 'channel.call', subscribe('sB', 'tab2.m#1'))
    request(p1, 'channel.call', unsubscribe('sA', 'tab1.n#1'))
    const from = link.sent.length
    p1.close()
    expect(syntheticUnsubscribes(from).map((m) => (m as { params: unknown }).params)).toEqual([
      unsubscribe('sA', 'tab1.n#2')
    ])
    const again = link.sent.length
    p2.close()
    expect(syntheticUnsubscribes(again).map((m) => (m as { params: unknown }).params)).toEqual([
      unsubscribe('sB', 'tab2.m#1')
    ])
  })

  it('P3-09-14 页面刷新（同一个标签页换了新端口）：只替旧端口退它自己的', () => {
    const old = openPanel(1, 'sA')
    request(old, 'channel.call', subscribe('sA', 'tab1.old#1'))
    const fresh = openPanel(1, 'sA')
    request(fresh, 'channel.call', subscribe('sA', 'tab1.new#1'))
    const from = link.sent.length
    old.close()
    expect(syntheticUnsubscribes(from).map((m) => (m as { params: unknown }).params)).toEqual([
      unsubscribe('sA', 'tab1.old#1')
    ])
    // 新端口照常收帧
    panels.deliverDesktopEvent({
      type: 'event',
      name: 'sync.frame',
      params: { sessionId: 'sA', frame: 1 }
    })
    expect(fresh.of('sync.frame')).toEqual([{ kind: 'sync.frame', frame: 1 }])
  })

  it('P3-09-14 连接没就绪时端口断开 → 不补发（桌面那头的客户端已经随连接没了）', () => {
    const p1 = openPanel(1, 'sA')
    request(p1, 'channel.call', subscribe('sA', 'tab1.n#1'))
    link.state = 'desktop-offline'
    const from = link.sent.length
    p1.close()
    expect(link.sent.slice(from)).toEqual([])
  })

  it('P3-09-14 连接断过一次（非 ready），旧记账作废：之后端口断开也不再补那些', () => {
    const p1 = openPanel(1, 'sA')
    request(p1, 'channel.call', subscribe('sA', 'tab1.n#1'))
    link.state = 'desktop-offline'
    for (const fn of link.listeners) fn('desktop-offline')
    link.state = 'ready'
    for (const fn of link.listeners) fn('ready')
    // 重连之后侧边栏重订（resetAll）
    request(p1, 'channel.call', subscribe('sA', 'tab1.n#2'))
    const from = link.sent.length
    p1.close()
    expect(syntheticUnsubscribes(from).map((m) => (m as { params: unknown }).params)).toEqual([
      unsubscribe('sA', 'tab1.n#2')
    ])
  })

  it('P3-09-14 连接不 ready 时侧边栏发来的订阅当场以 desktop-offline 失败，也不记账', () => {
    const p1 = openPanel(1, 'sA')
    link.state = 'connecting'
    p1.send({ kind: 'request', id: 99, method: 'channel.call', params: subscribe('sA', 'x#1') })
    expect(p1.of('response').at(-1)).toMatchObject({ id: 99, ok: false, error: 'desktop-offline' })
    link.state = 'ready'
    const from = link.sent.length
    p1.close()
    expect(syntheticUnsubscribes(from)).toEqual([])
  })
})

describe('SYNC-T syncTracking 认的线上形状', () => {
  it('SYNC-T 补发的退订与 chord 的 createServiceUnsubscribeCall 逐字相同；订阅 / 退订都认得出', () => {
    const params = syncUnsubscribeParams(target('sA'), 'tab1.n#7')
    expect(params).toEqual({
      path: 'sync.invoke',
      args: [target('sA'), JSON.parse(JSON.stringify(createServiceUnsubscribeCall('tab1.n#7')))]
    })
    expect(syncControlOf(subscribe('sA', 'a#1'))).toEqual({
      type: 'subscribe',
      subscriptionId: 'a#1',
      target: target('sA')
    })
    expect(syncControlOf(params)).toEqual({
      type: 'unsubscribe',
      subscriptionId: 'tab1.n#7',
      target: target('sA')
    })
  })

  it.each([
    ['别的路径', { path: 'message.list', args: ['sA'] }],
    ['args 不是数组', { path: 'sync.invoke', args: 'x' }],
    [
      '成员调用（不是控制调用）',
      {
        path: 'sync.invoke',
        args: [target('sA'), { serviceId: 'shuvix.chat.view', member: 'view', args: [] }]
      }
    ],
    [
      '目录调用',
      {
        path: 'sync.invoke',
        args: [target('sA'), { serviceId: '$chord.service', member: 'catalogue', args: [] }]
      }
    ],
    [
      '订阅 id 是空串',
      {
        path: 'sync.invoke',
        args: [
          target('sA'),
          { serviceId: '$chord.service', member: 'subscribe', args: ['', 'x', 'singleton'] }
        ]
      }
    ],
    ['没有参数', undefined]
  ])('SYNC-T %s → 不是订阅 / 退订', (_label, params) => {
    expect(syncControlOf(params)).toBeUndefined()
    const subs = new PortSubscriptions()
    subs.observe(params)
    expect(subs.size).toBe(0)
  })

  it('SYNC-T drain 交出并清空；clear 只清空', () => {
    const subs = new PortSubscriptions()
    subs.observe(subscribe('sA', 'a#1'))
    subs.observe(subscribe('sA', 'a#2'))
    expect(subs.drain()).toEqual([
      { subscriptionId: 'a#1', target: target('sA') },
      { subscriptionId: 'a#2', target: target('sA') }
    ])
    expect(subs.drain()).toEqual([])
    subs.observe(subscribe('sA', 'a#3'))
    subs.clear()
    expect(subs.size).toBe(0)
  })
})
