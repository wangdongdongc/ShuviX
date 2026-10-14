/**
 * 视图同步经 IPC 的整条链（pi 1.2 / chord2）—— 每个窗口里一个真的 syncClient（preload 的 `createSyncBridge` 上）
 * → 假 ipcRenderer → 真的窗口链路表（`createIpcLinkHub`）→ 真的视图服务端（`createViewServer`），服务端的宿主面是
 * 真的 `createSyncHubHost`：peek 交给 viewRig 的假会话宿主，开 / 关钩子经主进程唯一的扇出 `sessionHostHooks`。
 *
 *   SI-1（旧 P3-05-25）窗口 7 订阅并流式 → 帧只发给 wc7；窗口 8 晚到 → 它的快照就是此刻的值；wc7 销毁 → 仍经
 *        窗口 8 钉着、改动只到 wc8；`sessionHostHooks.closed('s1','remove')` → 静态的最后一个值；`deleteSession`
 *        → 窗口 8 `unavailable`、钉住松开；每一帧都能 JSON 往返
 *   SI-2 窗口 7 重载（did-navigate）而窗口 8 在看 → 窗口 7 的持有放掉、窗口 8 不受影响、窗口 7 的新页面拿到新快照
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createViewServer, type SessionHost, type ViewServer } from '@shuvix/agent-runtime'
import type { SyncTarget } from '@shuvix/chat-protocol/sync'
import type { SessionView } from '@shuvix/chat-protocol/types/sessionView'
import type {
  ViewEvent,
  ViewSubscription
} from '../../../../../../../packages/chat-ui/src/sync/syncClient'
import {
  fakeViewHost,
  stream,
  type FakeViewHost
} from '../../../../../../../packages/agent-runtime/src/sync/__tests__/support/viewRig'
import { createIpcLinkHub, type IpcLinkHub } from '../ipcLink'
import {
  FakeIpcMain,
  FakeWebContents,
  jsonRoundTrips,
  settle,
  syncWindow,
  until,
  wireHub,
  type SyncWindow
} from './support/ipcLinkRig'

vi.mock('electron', () => ({
  ipcMain: { on: vi.fn(), handle: vi.fn() },
  webContents: { fromId: vi.fn(() => undefined) }
}))
// 宿主面的 peek / sealed 显式交给假宿主；真的会话宿主模块（连带数据库）不加载
vi.mock('../../../services/sessionHost', () => ({
  getSessionHost: () => {
    throw new Error('the real session host is not used here')
  },
  peekSessionHost: () => undefined
}))
vi.mock('../../../services/sessionRecords', () => ({
  sessionRecords: { pick: () => undefined }
}))
vi.mock('../../../services/sessionStorage', () => ({
  readLegacyTranscript: () => null
}))
vi.mock('../../../agents/AgentManager', () => ({
  agentManager: { locate: () => undefined }
}))
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
}))

import { createSyncHubHost, sessionHostHooks } from '../syncWiring'

const S1: SyncTarget = { kind: 'session', sessionId: 's1' }
const S2: SyncTarget = { kind: 'session', sessionId: 's2' }

interface Rig {
  readonly host: FakeViewHost
  readonly server: ViewServer
  readonly hub: IpcLinkHub
  readonly ipcMain: FakeIpcMain
  /** 渲染端发出的每一帧（原样，进 IPC 之前） */
  readonly up: unknown[]
}

let servers: ViewServer[] = []
let windows: SyncWindow[] = []

afterEach(async () => {
  for (const window of windows) window.client.dispose()
  await settle()
  for (const server of servers) await server.dispose()
  servers = []
  windows = []
})

function rig(): Rig {
  const host = fakeViewHost()
  host.add('s1')
  host.add('s2')
  const server = createViewServer({
    // 假宿主的 peek 交 SyncSession（服务端只用这一面）；真宿主的类型交 DurableSession
    host: createSyncHubHost({
      current: () => host,
      host: () => host as unknown as Pick<SessionHost, 'peek'>
    }),
    legacyView: host.legacyView,
    resolveAgent: host.resolveAgent
  })
  host.server = server
  servers.push(server)
  const hub = createIpcLinkHub({ accept: (link, principal) => server.accept(link, principal) })
  const ipcMain = new FakeIpcMain()
  wireHub(ipcMain, hub)
  return { host, server, hub, ipcMain, up: [] }
}

/** 窗口里的一个页面；它发出的帧原样记进 `r.up` */
function page(r: Rig, wc: FakeWebContents): SyncWindow {
  const window = syncWindow(wc, r.ipcMain)
  const send = window.renderer.send.bind(window.renderer)
  window.renderer.send = (channel, ...args) => {
    r.up.push(args[1])
    send(channel, ...args)
  }
  windows.push(window)
  return window
}

/** 页面没了：它再也发不出帧 */
function kill(window: SyncWindow): void {
  window.renderer.send = () => {}
  window.client.dispose()
}

async function live(...subs: ViewSubscription<SessionView>[]): Promise<void> {
  await until(() => subs.every((sub) => sub.state().status === 'live'), 'live')
}

function record(sub: ViewSubscription<SessionView>): ViewEvent<SessionView>[] {
  const events: ViewEvent<SessionView>[] = []
  sub.subscribe((event) => events.push(event))
  return events
}

describe('SI-1 two windows over IPC (P3-05-25)', () => {
  it('SI-1 stream to one window, late join, window gone, session closed, session deleted; every frame is JSON', async () => {
    const r = rig()
    const wc7 = new FakeWebContents(7)
    const wc8 = new FakeWebContents(8)
    const w7 = page(r, wc7)
    const w8 = page(r, wc8)
    const session = r.host.session('s1')!

    // 窗口 7 订阅、流式：帧只发给 wc7
    const sub7 = w7.client.acquire<SessionView>(S1)
    await live(sub7)
    stream.start(session.root.state)
    stream.append(session.root.state, 'Hel')
    await until(() => sub7.value()?.live?.message.content === 'Hel', 'window 7 streams')
    expect(wc7.frames().length).toBeGreaterThan(0)
    expect(wc8.sent).toEqual([])

    // 窗口 8 晚到：它的快照就是此刻的值（流到一半）
    stream.append(session.root.state, 'lo')
    const sub8 = w8.client.acquire<SessionView>(S1)
    const events8 = record(sub8)
    await live(sub8)
    expect(sub8.value()).toEqual(session.root.value)
    expect(sub8.value()!.live!.message.content).toBe('Hello')
    // 交来的第一个（也是唯一一个）值就是它 —— 没有先交一份空视图
    const values8 = events8.filter((event) => event.kind === 'value')
    expect(values8).toHaveLength(1)
    expect(values8[0]).toMatchObject({ kind: 'value', delivery: 'hydrate' })
    expect(values8[0]!.kind === 'value' && values8[0]!.value).toEqual(session.root.value)
    expect(r.host.peeks).toEqual(['s1'])

    // wc7 销毁：仍经窗口 8 钉着，之后的改动只到 wc8
    const sentTo7 = wc7.sent.length
    wc7.destroy()
    kill(w7)
    await settle()
    expect(r.hub.linkCount(7)).toBe(0)
    expect(r.server.hasSubscribers('s1')).toBe(true)
    stream.append(session.root.state, ' world')
    await until(
      () => sub8.value()?.live?.message.content === 'Hello world',
      'window 8 keeps streaming'
    )
    expect(wc7.sent).toHaveLength(sentTo7)

    // 会话关了（不是销毁）：停在最后一个值，句柄不断、不回 loading
    const projector = session.currentRoot()!
    const last = session.root.value
    const before = events8.length
    sessionHostHooks.closed('s1', 'remove')
    await settle()
    expect(sub8.state().status).toBe('live')
    expect(sub8.value()).toEqual(last)
    expect(events8.slice(before)).toEqual([])
    expect(projector.refs).toBe(0)
    expect(r.host.log).toContain(`release:${projector.id}`)
    expect(r.server.hasSubscribers('s1')).toBe(true)

    // 会话删了：窗口 8 unavailable，钉住当场松开
    r.server.deleteSession('s1')
    expect(r.server.hasSubscribers('s1')).toBe(false)
    await until(() => sub8.state().status === 'unavailable', 'window 8 unavailable')
    expect(sub8.value()).toBeUndefined()

    // 每一帧（两个方向，进 IPC 之前的原样）都能 JSON 往返
    const down = [...wc7.sent, ...wc8.sent]
    expect(down.length).toBeGreaterThan(0)
    expect(r.up.length).toBeGreaterThan(0)
    for (const [channel, ...args] of down) {
      expect(channel).toBe('sync:frame')
      expect(jsonRoundTrips(args)).toBe(true)
    }
    for (const frame of r.up) expect(jsonRoundTrips(frame)).toBe(true)
  })
})

describe('SI-2 a reload while another window views', () => {
  it('SI-2 window 7 reloads: its holds are released, window 8 is unaffected, the new page gets a fresh snapshot', async () => {
    const r = rig()
    const wc7 = new FakeWebContents(7)
    const wc8 = new FakeWebContents(8)
    const w7 = page(r, wc7)
    const w8 = page(r, wc8)
    const a1 = w7.client.acquire<SessionView>(S1)
    const a2 = w7.client.acquire<SessionView>(S2)
    const b1 = w8.client.acquire<SessionView>(S1)
    await live(a1, a2, b1)
    const s2Projector = r.host.session('s2')!.currentRoot()!
    const events8 = record(b1)

    // 重载落定：旧页面的链路结束，它的持有放掉
    wc7.navigate()
    kill(w7)
    expect(r.hub.linkCount(7)).toBe(0)
    await until(() => !r.server.hasSubscribers('s2'), 'window 7 holds released')
    expect(s2Projector.refs).toBe(0)
    expect(r.host.log).toContain(`release:${s2Projector.id}`)
    expect(r.server.hasSubscribers('s1')).toBe(true)

    // 窗口 8 不受影响：状态没动过，改动照样到
    stream.answer(r.host.session('s1')!.root.state, ['after ', 'reload'], 10)
    await until(() => b1.value()?.messages.length === 1, 'window 8 sees the answer')
    expect(events8.filter((event) => event.kind === 'status')).toEqual([])
    expect(b1.state().status).toBe('live')

    // 窗口 7 的新页面：新链路、新快照（s1 的共享记录还在，s2 重新 peek）
    const w7b = page(r, wc7)
    const c1 = w7b.client.acquire<SessionView>(S1)
    const c2 = w7b.client.acquire<SessionView>(S2)
    const events7 = record(c1)
    await live(c1, c2)
    expect(r.hub.linkCount(7)).toBe(1)
    expect(c1.value()).toEqual(r.host.session('s1')!.root.value)
    expect(c1.value()!.messages.map((message) => message.content)).toEqual(['after reload'])
    expect(events7.find((event) => event.kind === 'value')).toMatchObject({ delivery: 'hydrate' })
    expect(c2.value()).toEqual(r.host.session('s2')!.root.value)
    expect(r.host.peeks.filter((id) => id === 's1')).toHaveLength(1)
    expect(r.host.peeks.filter((id) => id === 's2')).toHaveLength(2)
    expect(wc7.windowListenerCounts()).toEqual({
      destroyed: 1,
      'render-process-gone': 1,
      'did-navigate': 1
    })
  })
})
