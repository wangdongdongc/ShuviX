/**
 * 桌面窗口链路（`frontend/sync/ipcLink`，pi 1.2 / chord2）—— 每个窗口里一个**真的** syncClient（preload 的
 * `createSyncBridge` 上），主进程这头是真的窗口链路表 + 真的视图服务端（会话宿主是 viewRig 的假宿主）；只关心链路
 * 表自己的那些用例给一个记录用的 `accept`。IL-1 / IL-2 在 `ipcLink.smoke.test.ts`。
 *
 *   IL-3  `destroyed` → 这个窗口的链路全部结束、经它们的持有放掉、三个监听器摘掉；别的窗口不受影响
 *   IL-4  `render-process-gone` → 同 IL-3
 *   IL-5  `did-start-navigation` / `did-navigate-in-page` / `did-frame-navigate` 什么都不改（视图照样活着）
 *   IL-6  导航之后同一个 webContents 的新 `hello` → 监听器恰好重新挂一次，拿到新快照
 *   IL-7  `accept` 拿到的主体是 `{kind:'window', webContentsId}`，帧里写什么都不算
 *   IL-8  同一个链路 id 的第二个 `hello` → 旧链路结束（持有放掉）、不给渲染端发 bye；新链路接受；链路数还是 1
 *   IL-9  每个窗口的链路数上限：超出的 `hello` 拒收（不 accept、记一笔 warn、之后的帧丢掉）；有链路结束就又能开；
 *         各窗口各算各的
 *   IL-10 坏链路 id（非字符串 / 空 / 201 个字符）与非对象 / 数组帧丢掉，不挂任何窗口监听器
 *   IL-11 销毁了的发送方的帧不理；发帧时 webContents 已销毁 / `send` 抛错 → 链路以 `transport error` 结束、服务端
 *         放掉持有；`receive` 不往外抛
 *   IL-12 webContents 换了（同 id、新对象）→ 旧对象的链路结束、监听器摘掉
 *   IL-13 窗口 A 的帧永远到不了窗口 B
 *   IL-14 闲置关闭 5 轮之后每个事件的监听器还是 1 个（不泄漏）
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Link } from '@earendil-works/chord'
import type { ViewPrincipal, ViewServer } from '@shuvix/agent-runtime'
import type { SyncTarget } from '@shuvix/chat-protocol/sync'
import type { SessionView } from '@shuvix/chat-protocol/types/sessionView'
import type { ViewSubscription } from '../../../../../../../packages/chat-ui/src/sync/syncClient'
import {
  fakeViewHost,
  serverFor,
  stream,
  type FakeViewHost
} from '../../../../../../../packages/agent-runtime/src/sync/__tests__/support/viewRig'
import { createIpcLinkHub, type IpcLinkHub, type IpcLinkHubDeps } from '../ipcLink'
import {
  FakeIpcMain,
  FakeWebContents,
  settle,
  syncWindow,
  until,
  wireHub,
  type SyncWindow
} from './support/ipcLinkRig'

const S1: SyncTarget = { kind: 'session', sessionId: 's1' }
const S2: SyncTarget = { kind: 'session', sessionId: 's2' }

const HELLO = { t: 'hello', name: 'renderer', kind: 'client', epoch: 1 } as const
const NO_LISTENERS = { destroyed: 0, 'render-process-gone': 0, 'did-navigate': 0 }
const ONE_LISTENER = { destroyed: 1, 'render-process-gone': 1, 'did-navigate': 1 }

/** 一条被接受的链路：它、它的主体、它结束的原因 */
interface Accepted {
  readonly link: Link
  readonly principal: ViewPrincipal
  readonly reasons: string[]
}

interface Rig {
  readonly host: FakeViewHost
  readonly server: ViewServer
  readonly hub: IpcLinkHub
  readonly ipcMain: FakeIpcMain
  readonly accepted: Accepted[]
  readonly warnings: string[]
}

let servers: ViewServer[] = []
let windows: SyncWindow[] = []

afterEach(async () => {
  for (const window of windows) {
    try {
      window.client.dispose()
    } catch {
      // 已经丢掉了
    }
  }
  await settle()
  for (const server of servers) await server.dispose().catch(() => undefined)
  servers = []
  windows = []
})

/** 真的视图服务端（会话 s1 / s2 有存储）+ 窗口链路表；`accept` 记下每条链路再交给服务端 */
function rig(
  options: Partial<Pick<IpcLinkHubDeps, 'maxLinksPerWindow'>> & {
    authorize?: (principal: ViewPrincipal, target: SyncTarget) => boolean
  } = {}
): Rig {
  const host = fakeViewHost()
  host.add('s1')
  host.add('s2')
  const server = serverFor(host, options.authorize ? { authorize: options.authorize } : {})
  servers.push(server)
  const accepted: Accepted[] = []
  const warnings: string[] = []
  const hub = createIpcLinkHub({
    accept: (link, principal) => {
      const record: Accepted = { link, principal, reasons: [] }
      link.onClose((reason) => record.reasons.push(reason))
      accepted.push(record)
      server.accept(link, principal)
    },
    logger: { warn: (message) => warnings.push(message) },
    ...(options.maxLinksPerWindow === undefined
      ? {}
      : { maxLinksPerWindow: options.maxLinksPerWindow })
  })
  const ipcMain = new FakeIpcMain()
  wireHub(ipcMain, hub)
  return { host, server, hub, ipcMain, accepted, warnings }
}

/** 窗口里的一个页面：真的 syncClient，链路 id 是 `<prefix>.<序号>` */
function page(r: Rig, wc: FakeWebContents, prefix: string): SyncWindow {
  const window = syncWindow(wc, r.ipcMain, { idPrefix: prefix })
  windows.push(window)
  return window
}

/** 页面没了：它再也发不出帧（之后的 dispose 只是收拾客户端自己，什么都到不了主进程） */
function kill(window: SyncWindow): void {
  window.renderer.send = () => {}
  window.client.dispose()
}

async function live(...subs: ViewSubscription<SessionView>[]): Promise<void> {
  await until(() => subs.every((sub) => sub.state().status === 'live'), 'live')
}

/** 只关心链路表自己时的 `accept`：记下链路与主体，链路收到的帧也记下 */
function recordingHub(options: Partial<IpcLinkHubDeps> = {}): {
  hub: IpcLinkHub
  accept: ReturnType<typeof vi.fn<IpcLinkHubDeps['accept']>>
  warn: ReturnType<typeof vi.fn<(message: string) => void>>
  received: Map<Link, unknown[]>
} {
  const received = new Map<Link, unknown[]>()
  const accept = vi.fn<IpcLinkHubDeps['accept']>((link) => {
    const frames: unknown[] = []
    received.set(link, frames)
    link.receive((frame) => frames.push(frame))
  })
  const warn = vi.fn<(message: string) => void>()
  const hub = createIpcLinkHub({ accept, logger: { warn }, ...options })
  return { hub, accept, warn, received }
}

/** 页面没了的两种方式：IL-3 / IL-4 共用 */
async function windowGoneCase(
  trigger: (wc: FakeWebContents) => void,
  reason: string
): Promise<void> {
  const r = rig()
  const wc7 = new FakeWebContents(7)
  const wc8 = new FakeWebContents(8)
  const a = page(r, wc7, 'a')
  const b = page(r, wc7, 'b')
  const c = page(r, wc8, 'c')
  const a1 = a.client.acquire<SessionView>(S1)
  const b2 = b.client.acquire<SessionView>(S2)
  const c1 = c.client.acquire<SessionView>(S1)
  await live(a1, b2, c1)
  expect(r.hub.linkCount(7)).toBe(2)
  expect(r.hub.linkCount(8)).toBe(1)
  expect(wc7.windowListenerCounts()).toEqual(ONE_LISTENER)
  const s2Projector = r.host.session('s2')!.currentRoot()!
  const sentTo7 = wc7.sent.length

  trigger(wc7)

  // 窗口 7 的两条链路当场结束（不发 bye：页面已经没了），监听器摘掉
  expect(r.hub.linkCount(7)).toBe(0)
  expect(wc7.windowListenerCounts()).toEqual(NO_LISTENERS)
  const of7 = r.accepted.filter((entry) => entry.principal.webContentsId === 7)
  expect(of7).toHaveLength(2)
  for (const entry of of7) {
    expect(entry.link.closed).toBe(true)
    expect(entry.reasons).toEqual([reason])
  }
  // 只有窗口 7 持有的 s2：持有放掉、钉住松开、投影器的租约还掉
  await until(() => !r.server.hasSubscribers('s2'), 's2 released')
  expect(s2Projector.refs).toBe(0)
  expect(r.host.log).toContain(`release:${s2Projector.id}`)
  // s1 还经窗口 8 钉着
  expect(r.server.hasSubscribers('s1')).toBe(true)

  // 窗口 8 不受影响：链路、监听器都在，改动照样到
  expect(r.hub.linkCount(8)).toBe(1)
  expect(wc8.windowListenerCounts()).toEqual(ONE_LISTENER)
  stream.answer(r.host.session('s1')!.root.state, ['still ', 'here'], 10)
  await until(() => c1.value()?.messages.length === 1, 'window 8 sees the answer')
  expect(c1.value()!.messages[0]!.content).toBe('still here')
  expect(c1.state().status).toBe('live')
  // 没了的窗口 7 一帧都没再收到
  expect(wc7.sent).toHaveLength(sentTo7)
  kill(a)
  kill(b)
}

describe('IL-3 / IL-4 the window goes away', () => {
  it('IL-3 destroyed ends every link of that window, releases its holds and detaches its listeners; window 8 is unaffected', async () => {
    await windowGoneCase((wc) => wc.destroy(), 'webContents destroyed')
  })

  it('IL-4 render-process-gone does the same as destroyed', async () => {
    await windowGoneCase((wc) => wc.crash(), 'render process gone')
  })
})

describe('IL-5 navigations that are not a cross-document main-frame commit', () => {
  it('IL-5 did-start-navigation, did-navigate-in-page and did-frame-navigate change nothing; the view stays live', async () => {
    const r = rig()
    const wc = new FakeWebContents(7)
    const window = page(r, wc, 'a')
    const sub = window.client.acquire<SessionView>(S1)
    await live(sub)

    wc.emit('did-start-navigation', {}, 'https://example.com/', false, true)
    wc.emit('did-navigate-in-page', {}, 'app://index#/other', true)
    wc.emit('did-frame-navigate', {}, 'https://frame.example/', 200, 'OK', false)
    await settle()

    expect(r.hub.linkCount(7)).toBe(1)
    expect(r.accepted).toHaveLength(1)
    expect(r.accepted[0]!.link.closed).toBe(false)
    expect(r.server.hasSubscribers('s1')).toBe(true)
    expect(wc.windowListenerCounts()).toEqual(ONE_LISTENER)
    expect(wc.listenerCount('did-start-navigation')).toBe(0)
    expect(wc.listenerCount('did-navigate-in-page')).toBe(0)
    expect(wc.listenerCount('did-frame-navigate')).toBe(0)

    stream.answer(r.host.session('s1')!.root.state, ['live'], 10)
    await until(() => sub.value()?.messages.length === 1, 'answer arrives')
    expect(sub.state().status).toBe('live')
  })
})

describe('IL-6 a new page after a navigation', () => {
  it('IL-6 the new hello re-attaches the listeners exactly once and gets a fresh snapshot', async () => {
    const r = rig()
    const wc = new FakeWebContents(7)
    const first = page(r, wc, 'a')
    const sub = first.client.acquire<SessionView>(S1)
    await live(sub)

    wc.navigate()
    expect(wc.windowListenerCounts()).toEqual(NO_LISTENERS)
    expect(r.hub.linkCount(7)).toBe(0)
    expect(r.accepted[0]!.reasons).toEqual(['page navigated'])
    kill(first)
    await until(() => !r.server.hasSubscribers('s1'), 'old page released')

    // 没人看的时候会话往前走了
    stream.answer(r.host.session('s1')!.root.state, ['while ', 'reloading'], 10)

    const second = page(r, wc, 'b')
    const fresh = second.client.acquire<SessionView>(S1)
    await live(fresh)
    // hello、hold、sub ……一串帧之后监听器每个事件恰好一个
    expect(wc.windowListenerCounts()).toEqual(ONE_LISTENER)
    expect(r.hub.linkCount(7)).toBe(1)
    expect(r.accepted).toHaveLength(2)
    expect(fresh.value()).toEqual(r.host.session('s1')!.root.value)
    expect(fresh.value()!.messages.map((m) => m.content)).toEqual(['while reloading'])
    // 新快照是重新 peek 来的
    expect(r.host.peeks).toEqual(['s1', 's1'])
  })
})

describe('IL-7 the principal', () => {
  it('IL-7 accept gets {kind:"window", webContentsId: wc.id} whatever the hello carries', () => {
    const { hub, accept } = recordingHub()
    const wc = new FakeWebContents(7)
    hub.receive(wc, 'L1', {
      ...HELLO,
      principal: { kind: 'chrome', installId: 'i', runId: 'r', tabId: 3 },
      webContentsId: 99,
      kind: 'client'
    })
    expect(accept).toHaveBeenCalledTimes(1)
    expect(accept.mock.calls[0]![1]).toEqual({ kind: 'window', webContentsId: 7 })
  })

  it('IL-7 the view server authorizes with the stamped window principal', async () => {
    const seen: Array<[ViewPrincipal, SyncTarget]> = []
    const r = rig({
      authorize: (principal, target) => {
        seen.push([principal, target])
        return true
      }
    })
    const wc = new FakeWebContents(12)
    const window = page(r, wc, 'a')
    const sub = window.client.acquire<SessionView>(S1)
    await live(sub)
    expect(r.accepted.map((entry) => entry.principal)).toEqual([
      { kind: 'window', webContentsId: 12 }
    ])
    expect(seen).toEqual([[{ kind: 'window', webContentsId: 12 }, S1]])
  })
})

describe('IL-8 a second hello on the same link id', () => {
  it('IL-8 ends the old link (holds released) without a bye to the renderer; the new link is accepted; linkCount stays 1', async () => {
    const r = rig()
    const wc = new FakeWebContents(7)
    const before = page(r, wc, 'p')
    const old = before.client.acquire<SessionView>(S1)
    await live(old)
    // 客户端重新开始了（同一个前缀 → 同一个链路 id `p.1`）；旧的那个什么都不再发
    kill(before)
    expect(r.hub.linkCount(7)).toBe(1)
    const framesBefore = wc.frames().length

    const after = page(r, wc, 'p')
    const fresh = after.client.acquire<SessionView>(S2)
    await live(fresh)

    expect(r.accepted).toHaveLength(2)
    expect(r.accepted[0]!.link.closed).toBe(true)
    expect(r.accepted[0]!.reasons).toEqual(['superseded by a new hello'])
    expect(r.accepted[1]!.link.closed).toBe(false)
    expect(r.hub.linkCount(7)).toBe(1)
    expect(r.hub.linkCount()).toBe(1)
    await until(() => !r.server.hasSubscribers('s1'), 'old link holds released')
    expect(r.server.hasSubscribers('s2')).toBe(true)
    // 一帧 bye 都没发给渲染端；帧全在 `p.1` 上
    const later = wc.frames().slice(framesBefore)
    expect(later.length).toBeGreaterThan(0)
    expect(later.some(([, frame]) => (frame as { t?: unknown }).t === 'bye')).toBe(false)
    expect(wc.frames().every(([link]) => link === 'p.1')).toBe(true)
    // 监听器没有重挂
    expect(wc.windowListenerCounts()).toEqual(ONE_LISTENER)
  })
})

describe('IL-9 the per-window link budget', () => {
  it('IL-9 a hello past maxLinksPerWindow is refused and its frames dropped; a link ending frees a slot; windows have separate budgets', () => {
    const { hub, accept, warn, received } = recordingHub({ maxLinksPerWindow: 2 })
    const wc7 = new FakeWebContents(7)
    const wc8 = new FakeWebContents(8)
    hub.receive(wc7, 'L1', HELLO)
    hub.receive(wc7, 'L2', HELLO)
    expect(accept).toHaveBeenCalledTimes(2)
    expect(warn).not.toHaveBeenCalled()

    hub.receive(wc7, 'L3', HELLO)
    expect(accept).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain('window 7')
    expect(warn.mock.calls[0]![0]).toContain('L3')
    expect(hub.linkCount(7)).toBe(2)
    // 被拒的链路之后的帧丢掉：哪条链路都收不到
    hub.receive(wc7, 'L3', { t: 'ping', n: 1 })
    expect(hub.linkCount(7)).toBe(2)
    expect([...received.values()].flat()).toEqual([HELLO, HELLO])

    // 别的窗口各算各的
    hub.receive(wc8, 'L1', HELLO)
    hub.receive(wc8, 'L2', HELLO)
    expect(accept).toHaveBeenCalledTimes(4)
    expect(hub.linkCount(8)).toBe(2)
    expect(accept.mock.calls.map((call) => call[1].webContentsId)).toEqual([7, 7, 8, 8])

    // 一条链路结束（客户端发了 bye）→ 又能开一条
    hub.receive(wc7, 'L1', { t: 'bye', reason: 'client closed' })
    expect(hub.linkCount(7)).toBe(1)
    hub.receive(wc7, 'L3', HELLO)
    expect(accept).toHaveBeenCalledTimes(5)
    expect(hub.linkCount(7)).toBe(2)
    expect(warn).toHaveBeenCalledTimes(1)

    // 满额时同一个 id 的 hello 是替换（旧的先收掉），不算超额
    hub.receive(wc7, 'L2', HELLO)
    expect(accept).toHaveBeenCalledTimes(6)
    expect(hub.linkCount(7)).toBe(2)
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe('IL-10 malformed input', () => {
  it('IL-10 bad link ids and non-object frames are dropped and attach no window listeners', () => {
    const { hub, accept } = recordingHub()
    const wc = new FakeWebContents(7)
    for (const id of [42, null, undefined, {}, ['L1'], true, '', 'x'.repeat(201)]) {
      hub.receive(wc, id, HELLO)
    }
    for (const frame of [null, undefined, 'hello', 7, true, [HELLO], ['hello'], []]) {
      hub.receive(wc, 'L1', frame)
    }
    expect(accept).not.toHaveBeenCalled()
    expect(hub.linkCount()).toBe(0)
    expect(wc.windowListenerCounts()).toEqual(NO_LISTENERS)
    expect(wc.eventNames()).toEqual([])

    // 边界：200 个字符的 id 照收
    hub.receive(wc, 'x'.repeat(200), HELLO)
    expect(accept).toHaveBeenCalledTimes(1)
    expect(wc.windowListenerCounts()).toEqual(ONE_LISTENER)
  })
})

describe('IL-11 dead webContents and failing sends', () => {
  it('IL-11 a frame from a destroyed sender is ignored (isDestroyed throwing counts as destroyed)', () => {
    const { hub, accept } = recordingHub()
    const gone = new FakeWebContents(7)
    gone.destroyed = true
    hub.receive(gone, 'L1', HELLO)
    const broken = new FakeWebContents(8)
    broken.isDestroyed = () => {
      throw new Error('object has been destroyed')
    }
    expect(() => hub.receive(broken, 'L1', HELLO)).not.toThrow()
    expect(accept).not.toHaveBeenCalled()
    expect(hub.linkCount()).toBe(0)
    expect(gone.windowListenerCounts()).toEqual(NO_LISTENERS)
    expect(broken.windowListenerCounts()).toEqual(NO_LISTENERS)
  })

  it('IL-11 transmitting to a destroyed webContents ends the link with "transport error" and the server releases its holds', async () => {
    const r = rig()
    const wc = new FakeWebContents(7)
    const window = page(r, wc, 'a')
    const sub = window.client.acquire<SessionView>(S1)
    await live(sub)
    const sent = wc.sent.length

    // 已经销毁、`destroyed` 还没报到：服务端的下一帧（一个增量）发不出去
    wc.destroyed = true
    stream.start(r.host.session('s1')!.root.state)
    await until(() => r.accepted[0]!.link.closed, 'link ended')
    expect(r.accepted[0]!.reasons).toEqual(['transport error'])
    expect(r.hub.linkCount(7)).toBe(0)
    expect(wc.sent).toHaveLength(sent)
    await until(() => !r.server.hasSubscribers('s1'), 'holds released')
    // 迟到的 destroyed 把监听器摘干净
    wc.emit('destroyed')
    expect(wc.windowListenerCounts()).toEqual(NO_LISTENERS)
    kill(window)
  })

  it('IL-11 send throwing ends the link with "transport error"; receive does not throw', async () => {
    const r = rig()
    const wc = new FakeWebContents(7)
    const window = page(r, wc, 'a')
    const sub = window.client.acquire<SessionView>(S1)
    await live(sub)

    // chord 当场回 pong → send 抛错：不往外抛，链路结束
    wc.throwOnSend = true
    expect(() => r.hub.receive(wc, 'a.1', { t: 'ping', n: 99 })).not.toThrow()
    expect(r.accepted[0]!.link.closed).toBe(true)
    expect(r.accepted[0]!.reasons).toEqual(['transport error'])
    expect(r.hub.linkCount(7)).toBe(0)
    await until(() => !r.server.hasSubscribers('s1'), 'holds released')
    kill(window)
  })

  it('IL-11 a hello whose answer cannot be sent ends at once; receive does not throw', () => {
    const r = rig()
    const wc = new FakeWebContents(7)
    wc.throwOnSend = true
    expect(() => r.hub.receive(wc, 'L1', HELLO)).not.toThrow()
    expect(r.accepted).toHaveLength(1)
    expect(r.accepted[0]!.link.closed).toBe(true)
    expect(r.accepted[0]!.reasons).toEqual(['transport error'])
    expect(r.hub.linkCount(7)).toBe(0)
  })
})

describe('IL-12 a replaced webContents', () => {
  it('IL-12 same id, new object: the old object loses its links and its listeners', async () => {
    const r = rig()
    const old = new FakeWebContents(7)
    const before = page(r, old, 'a')
    const oldSub = before.client.acquire<SessionView>(S1)
    await live(oldSub)
    kill(before)

    const replacement = new FakeWebContents(7)
    const after = page(r, replacement, 'b')
    const sub = after.client.acquire<SessionView>(S2)
    await live(sub)

    expect(r.accepted).toHaveLength(2)
    expect(r.accepted[0]!.link.closed).toBe(true)
    expect(r.accepted[0]!.reasons).toEqual(['webContents replaced'])
    expect(old.windowListenerCounts()).toEqual(NO_LISTENERS)
    expect(replacement.windowListenerCounts()).toEqual(ONE_LISTENER)
    expect(r.hub.linkCount(7)).toBe(1)
    await until(() => !r.server.hasSubscribers('s1'), 'old object holds released')
    expect(r.server.hasSubscribers('s2')).toBe(true)

    // 旧对象之后的事件碰不到新的窗口
    old.destroy()
    expect(r.hub.linkCount(7)).toBe(1)
    expect(r.accepted[1]!.link.closed).toBe(false)
    stream.answer(r.host.session('s2')!.root.state, ['ok'], 10)
    await until(() => sub.value()?.messages.length === 1, 'replacement still live')
  })
})

describe('IL-13 isolation between windows', () => {
  it("IL-13 window A's frames never reach window B", async () => {
    const r = rig()
    const wcA = new FakeWebContents(7)
    const wcB = new FakeWebContents(8)
    const sendB = vi.spyOn(wcB, 'send')
    const a = page(r, wcA, 'a')
    const subA = a.client.acquire<SessionView>(S1)
    await live(subA)
    stream.answer(r.host.session('s1')!.root.state, ['one ', 'two'], 10)
    await until(() => subA.value()?.messages.length === 1, 'A sees the answer')
    expect(sendB).not.toHaveBeenCalled()

    // B 开了自己的链路（另一条会话）：A 的帧照样到不了 B，B 的帧也到不了 A
    const b = page(r, wcB, 'b')
    const subB = b.client.acquire<SessionView>(S2)
    await live(subB)
    stream.answer(r.host.session('s1')!.root.state, ['three'], 11)
    await until(() => subA.value()?.messages.length === 2, 'A sees the second answer')
    await settle()
    expect(wcB.frames().length).toBeGreaterThan(0)
    expect(wcB.frames().every(([link]) => link.startsWith('b.'))).toBe(true)
    expect(wcA.frames().every(([link]) => link.startsWith('a.'))).toBe(true)
    expect(subB.value()!.messages).toEqual([])
  })
})

describe('IL-14 no listener leak', () => {
  it('IL-14 five link cycles via idle close keep one listener per event', async () => {
    const r = rig()
    const wc = new FakeWebContents(7)
    const window = page(r, wc, 'a')
    for (let cycle = 1; cycle <= 5; cycle++) {
      const sub = window.client.acquire<SessionView>(S1)
      await live(sub)
      expect(r.hub.linkCount(7)).toBe(1)
      expect(wc.windowListenerCounts()).toEqual(ONE_LISTENER)
      sub.release()
      await until(() => r.hub.linkCount(7) === 0, `idle close ${cycle}`)
      await until(() => !r.server.hasSubscribers('s1'), `released ${cycle}`)
    }
    expect(r.accepted).toHaveLength(5)
    expect(r.accepted.map((entry) => entry.reasons)).toEqual(Array(5).fill(['idle']))
    expect(wc.windowListenerCounts()).toEqual(ONE_LISTENER)
    expect([...new Set(wc.frames().map(([link]) => link))]).toEqual([
      'a.1',
      'a.2',
      'a.3',
      'a.4',
      'a.5'
    ])
  })
})
