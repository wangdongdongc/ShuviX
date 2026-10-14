/**
 * Chrome 前端的接线（frontend/chrome/index.ts）：桥上的三种请求、握手与浏览器事件、应用事件转发，
 * 以及侧边栏外观。
 *
 * 契约：
 *   - `registerChromeFrontend` 只装一次（桥处理器 + 应用事件订阅各一份）；
 *   - `tabSession.open` → openTabSession(conn, {tabId, title?})，再把这条连接绑成这条会话的前端
 *     （同一连接同一会话的前端 id 相同 —— 重开面板是覆盖，不会重复推送），回 {sessionId}；
 *     `channel.call` → callPanelChannel(conn, path, args)；`panel.appearance` → panelAppearance()；
 *     别的方法拒绝；
 *   - 握手 → 清孤儿（sweepTabSessions(hello)）；`tabs.removed` → closeTabSession；别的浏览器事件
 *     与会话层无关；
 *   - 应用事件只转侧边栏该看的：设置变化发给每条就绪连接；本连接标签页会话的标题 / 配置变化只发给
 *     拥有它的连接；项目、会话列表、知识库、bot 之类一概不出桌面进程；
 *   - 外观：与桌面渲染层同一套取值与缺省（dark / github-dark / github-light / 14 / 专注开 /
 *     存的语言 → i18next 当前语言 → en）；
 *   - 视图同步（pi 1.2）：装好之后登记了 `chrome` 主体的核对（只能看本浏览器这一轮的标签页会话）；装它不建
 *     视图服务端（第一条链路的第一帧才建，P3-05 PIN-12）；
 *   - CX-1 扩展的 `sync.link` 事件 → 链路表（hello 建链路，主体取自那条连接）；`tabs.removed` 照旧；
 *     CX-2 `chromeBridge.onConnectionClosed` 只登记一次，它一响那条连接的链路全部结束；
 *     CX-3 `chromeViewAllowed`：派生 agent 目标一律同步 false（不解析 agent），会话目标缺 installId / runId → false。
 *
 * 会话层（tabSessions）与对话接口（channel）换成 spy；ChromeFrontend、i18next 与 syncWiring 是真的
 * （会话宿主、行表、旧格式读取器、派生 agent 路由换成替身 —— syncWiring 只在建 hub 时才碰它们）。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import i18next from 'i18next'
import type { AppEvent } from '@shuvix/chat-protocol/appEvents'
import type { BridgeHello } from '@shuvix/chat-protocol/chromeBridge'
import type { ChromeBridgeHandlers, BridgeConnection } from '../../../services/chromeBridge'

const mocks = vi.hoisted(() => ({
  setHandlers: vi.fn(),
  subscribe: vi.fn(),
  readyConnections: vi.fn(),
  bind: vi.fn(),
  settings: new Map<string, string>(),
  callPanelChannel: vi.fn(),
  openTabSession: vi.fn(),
  closeTabSession: vi.fn(),
  sweepTabSessions: vi.fn(),
  connectionOwnsSession: vi.fn(),
  tabSessionOwnedBy: vi.fn(),
  connectionById: vi.fn(),
  onConnectionClosed: vi.fn(),
  getSessionHost: vi.fn(),
  locate: vi.fn()
}))

vi.mock('../../core', () => ({ chatFrontendRegistry: { bind: mocks.bind } }))
vi.mock('../../../utils/appEventBus', () => ({ appEventBus: { subscribe: mocks.subscribe } }))
vi.mock('../../../dao/settingsDao', () => ({
  settingsDao: { findByKey: (key: string) => mocks.settings.get(key) }
}))
vi.mock('../../../services/chromeBridge', () => ({
  chromeBridge: {
    setHandlers: mocks.setHandlers,
    readyConnections: mocks.readyConnections,
    connectionById: mocks.connectionById,
    onConnectionClosed: mocks.onConnectionClosed
  }
}))
vi.mock('../../../services/sessionHost', () => ({
  getSessionHost: mocks.getSessionHost,
  peekSessionHost: () => undefined
}))
vi.mock('../../../services/sessionRecords', () => ({ sessionRecords: { pick: () => undefined } }))
vi.mock('../../../services/sessionStorage', () => ({ readLegacyTranscript: () => undefined }))
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
}))
vi.mock('../../../agents/AgentManager', () => ({ agentManager: { locate: mocks.locate } }))
vi.mock('../channel', () => ({ callPanelChannel: mocks.callPanelChannel }))
vi.mock('../tabSessions', () => ({
  openTabSession: mocks.openTabSession,
  closeTabSession: mocks.closeTabSession,
  sweepTabSessions: mocks.sweepTabSessions,
  connectionOwnsSession: mocks.connectionOwnsSession,
  tabSessionOwnedBy: mocks.tabSessionOwnedBy
}))

import { chromeViewAllowed, panelAppearance, registerChromeFrontend } from '../index'
import { ChromeFrontend } from '../ChromeFrontend'
import { authorizeView, getSyncHub, peekSyncHub, resetSyncHubForTests } from '../../sync/syncWiring'

interface FakeConn {
  id: string
  ready: boolean
  info: { installId: string; runId: string }
  emit: ReturnType<typeof vi.fn>
}

const fakeConn = (id: string): FakeConn => ({
  id,
  ready: true,
  info: { installId: 'i1', runId: 'r1' },
  emit: vi.fn()
})
const asConn = (c: FakeConn): BridgeConnection => c as unknown as BridgeConnection

let handlers: ChromeBridgeHandlers
let onAppEvent: (event: AppEvent) => void
let registerCounts: { setHandlers: number; subscribe: number }
let chromeAllowedBeforeRegister: unknown

beforeAll(() => {
  chromeAllowedBeforeRegister = authorizeView(
    { kind: 'chrome', installId: 'i1', runId: 'r1' },
    { kind: 'session', sessionId: 's1' }
  )
  registerChromeFrontend()
  registerChromeFrontend()
  registerCounts = {
    setHandlers: mocks.setHandlers.mock.calls.length,
    subscribe: mocks.subscribe.mock.calls.length
  }
  handlers = mocks.setHandlers.mock.calls[0][0]
  onAppEvent = mocks.subscribe.mock.calls[0][0]
})

let c1: FakeConn
let c2: FakeConn

beforeEach(() => {
  for (const m of [
    mocks.readyConnections,
    mocks.bind,
    mocks.callPanelChannel,
    mocks.openTabSession,
    mocks.closeTabSession,
    mocks.sweepTabSessions,
    mocks.connectionOwnsSession,
    mocks.tabSessionOwnedBy,
    mocks.connectionById,
    mocks.locate
  ]) {
    m.mockReset()
  }
  mocks.settings.clear()
  c1 = fakeConn('c1')
  c2 = fakeConn('c2')
  mocks.readyConnections.mockReturnValue([c1, c2])
  mocks.openTabSession.mockResolvedValue('tab-s1')
  mocks.closeTabSession.mockResolvedValue(undefined)
  mocks.sweepTabSessions.mockResolvedValue(undefined)
  // c1 拥有 s1；别的组合都不拥有
  mocks.connectionOwnsSession.mockImplementation(
    (conn: FakeConn, sid: unknown) => conn === c1 && sid === 's1'
  )
})

describe('IX-1 registerChromeFrontend 只装一次', () => {
  it('IX-1 调两次：桥处理器与应用事件订阅各装一份', () => {
    expect(registerCounts).toEqual({ setHandlers: 1, subscribe: 1 })
    expect(typeof handlers.onRequest).toBe('function')
    expect(typeof handlers.onReady).toBe('function')
    expect(typeof handlers.onEvent).toBe('function')
  })
})

describe('视图同步的 chrome 主体核对', () => {
  it('装好之后才有 chrome 的核对；import 与装它都不建视图服务端、不碰会话宿主', () => {
    expect(chromeAllowedBeforeRegister).toBe(false)
    expect(peekSyncHub()).toBeUndefined()
    expect(mocks.getSessionHost).not.toHaveBeenCalled()
  })

  it('会话目标按 installId + runId 核对标签页会话的归属', () => {
    mocks.tabSessionOwnedBy.mockImplementation(
      (sid: unknown, installId: string, runId: string) =>
        sid === 's1' && installId === 'i1' && runId === 'r1'
    )
    const principal = { kind: 'chrome', installId: 'i1', runId: 'r1', connId: 'c1', tabId: 5 }
    expect(authorizeView(principal, { kind: 'session', sessionId: 's1' })).toBe(true)
    expect(authorizeView(principal, { kind: 'session', sessionId: 's2' })).toBe(false)
    expect(authorizeView({ ...principal, runId: 'r0' }, { kind: 'session', sessionId: 's1' })).toBe(
      false
    )
  })
})

describe('IX-2 … IX-5 扩展发来的请求', () => {
  const request = (method: string, params: unknown, conn: FakeConn = c1): Promise<unknown> =>
    handlers.onRequest!(asConn(conn), method, params)

  it('IX-2 tabSession.open：开会话、把这条连接绑成它的前端、回 {sessionId}', async () => {
    expect(await request('tabSession.open', { tabId: 5, title: 'T' })).toStrictEqual({
      sessionId: 'tab-s1'
    })
    expect(mocks.openTabSession.mock.calls).toEqual([[c1, { tabId: 5, title: 'T' }]])
    expect(mocks.bind).toHaveBeenCalledTimes(1)
    const [sid, frontend] = mocks.bind.mock.calls[0]
    expect(sid).toBe('tab-s1')
    expect(frontend).toBeInstanceOf(ChromeFrontend)
    expect(frontend.id).toBe('chrome:c1:tab-s1')
  })

  it('IX-2 标题不是字符串 → 按没给传 undefined；tabId 原样交给 openTabSession 去判', async () => {
    await request('tabSession.open', { tabId: '5', title: 42 })
    expect(mocks.openTabSession.mock.calls).toEqual([[c1, { tabId: '5', title: undefined }]])
  })

  it('IX-2 同一连接开两次同一会话 → 绑的是同一个前端 id（覆盖而不是叠加）', async () => {
    await request('tabSession.open', { tabId: 5 })
    await request('tabSession.open', { tabId: 5 })
    const ids = mocks.bind.mock.calls.map(([, f]) => f.id)
    expect(ids).toEqual(['chrome:c1:tab-s1', 'chrome:c1:tab-s1'])
  })

  it('IX-2 开会话失败 → 请求失败，不绑任何前端', async () => {
    mocks.openTabSession.mockRejectedValue(new Error('not-ready'))
    await expect(request('tabSession.open', { tabId: 5 })).rejects.toThrow('not-ready')
    expect(mocks.bind).not.toHaveBeenCalled()
  })

  it('IX-3 channel.call → callPanelChannel(conn, path, args)，结果原样回', async () => {
    mocks.callPanelChannel.mockResolvedValue({ ok: 1 })
    expect(await request('channel.call', { path: 'message.list', args: ['s1'] })).toEqual({ ok: 1 })
    expect(mocks.callPanelChannel.mock.calls).toEqual([[c1, 'message.list', ['s1']]])

    await request('channel.call', undefined)
    expect(mocks.callPanelChannel.mock.calls[1]).toEqual([c1, undefined, undefined])
  })

  it('IX-3 channel.call 的拒绝原样传回扩展', async () => {
    mocks.callPanelChannel.mockRejectedValue(
      new Error('This session does not belong to this Chrome tab.')
    )
    await expect(request('channel.call', { path: 'agent.init', args: [] })).rejects.toThrow(
      'This session does not belong to this Chrome tab.'
    )
  })

  it('IX-4 panel.appearance → panelAppearance()', async () => {
    mocks.settings.set('general.theme', 'light')
    expect(await request('panel.appearance', {})).toEqual(panelAppearance())
    expect((await request('panel.appearance', {})) as { theme: string }).toMatchObject({
      theme: 'light'
    })
  })

  it.each(['x', 'agent.prompt', 'session.list', ''])('IX-5 未知方法 %s → 拒绝', async (method) => {
    await expect(request(method, {})).rejects.toThrow(`Unknown method "${method}".`)
    expect(mocks.callPanelChannel).not.toHaveBeenCalled()
    expect(mocks.openTabSession).not.toHaveBeenCalled()
  })
})

describe('IX-6 / IX-7 握手与浏览器事件', () => {
  const hello: BridgeHello = {
    type: 'hello',
    protocol: 1,
    extensionVersion: '0.1.0',
    installId: 'i1',
    runId: 'r2',
    browser: 'Chrome 140',
    openTabIds: [5, 7]
  }

  it('IX-6 握手通过 → 按这次 hello 清孤儿', () => {
    handlers.onReady!(asConn(c1), hello)
    expect(mocks.sweepTabSessions.mock.calls).toEqual([[hello]])
  })

  it('IX-7 tabs.removed → closeTabSession(conn, tabId)', () => {
    handlers.onEvent!(asConn(c1), 'tabs.removed', { tabId: 5 })
    expect(mocks.closeTabSession.mock.calls).toEqual([[c1, 5]])
  })

  it.each([
    ['debugger.event', { tabId: 5, method: 'Network.requestWillBeSent', params: {} }],
    ['debugger.detached', { tabId: 5, reason: 'canceled_by_user' }],
    ['something.else', {}]
  ])('IX-7 %s → 会话层什么也不做', (name, params) => {
    handlers.onEvent!(asConn(c1), name, params)
    expect(mocks.closeTabSession).not.toHaveBeenCalled()
    expect(mocks.sweepTabSessions).not.toHaveBeenCalled()
    expect(mocks.openTabSession).not.toHaveBeenCalled()
  })
})

describe('IX-8 应用事件只转侧边栏该看的', () => {
  const emitted = (c: FakeConn): unknown[] => c.emit.mock.calls.map(([name, p]) => [name, p])

  it('IX-8 settings.changed → 每条就绪连接都收到', () => {
    const event: AppEvent = { type: 'settings.changed', keys: ['general.theme'] }
    onAppEvent(event)
    expect(emitted(c1)).toEqual([['app.event', { event }]])
    expect(emitted(c2)).toEqual([['app.event', { event }]])
  })

  it.each<AppEvent>([
    { type: 'session.titleChanged', sessionId: 's1', title: 'New' },
    { type: 'session.configChanged', sessionId: 's1' }
  ])('IX-8 本连接标签页会话的 $type → 只发给拥有它的连接', (event) => {
    onAppEvent(event)
    expect(emitted(c1)).toEqual([['app.event', { event }]])
    expect(c2.emit).not.toHaveBeenCalled()
  })

  it.each<AppEvent>([
    { type: 'session.titleChanged', sessionId: 'desktop-1', title: 'Secret plan' },
    { type: 'session.configChanged', sessionId: 'desktop-1' }
  ])('IX-8 桌面会话的 $type → 谁也不发', (event) => {
    onAppEvent(event)
    expect(c1.emit).not.toHaveBeenCalled()
    expect(c2.emit).not.toHaveBeenCalled()
  })

  it.each<AppEvent>([
    { type: 'project.changed' },
    { type: 'session.listChanged' },
    { type: 'knowledge.changed' },
    { type: 'bot.changed' },
    { type: 'providers.changed' },
    { type: 'files.changed', root: '/work' },
    { type: 'agent.changed' },
    { type: 'chromeExtension.changed' }
  ])('IX-8 $type → 不出桌面进程', (event) => {
    onAppEvent(event)
    expect(c1.emit).not.toHaveBeenCalled()
    expect(c2.emit).not.toHaveBeenCalled()
    expect(mocks.connectionOwnsSession).not.toHaveBeenCalled()
  })

  it('IX-8 没有就绪连接 → 什么也不发、不抛', () => {
    mocks.readyConnections.mockReturnValue([])
    expect(() => onAppEvent({ type: 'settings.changed' })).not.toThrow()
  })
})

// ─── 外观 ───────────────────────────────────────────────────────────────────

describe('PA-1 / PA-2 panelAppearance', () => {
  let savedLanguage: string

  beforeEach(() => {
    savedLanguage = i18next.language
  })
  afterEach(() => {
    i18next.language = savedLanguage
  })

  it('PA-1 什么都没存 → 桌面的缺省，语言取 i18next 当前语言', () => {
    i18next.language = 'ja'
    expect(panelAppearance()).toStrictEqual({
      theme: 'dark',
      darkTheme: 'github-dark',
      lightTheme: 'github-light',
      fontSize: 14,
      focusMode: true,
      language: 'ja'
    })
  })

  it('PA-1 i18next 也没有语言 → en', () => {
    i18next.language = ''
    expect(panelAppearance().language).toBe('en')
    i18next.language = undefined as unknown as string
    expect(panelAppearance().language).toBe('en')
  })

  it.each([
    ['light', 'light'],
    ['system', 'system'],
    ['dark', 'dark'],
    ['weird', 'dark'],
    ['', 'dark']
  ])('PA-2 general.theme = %s → %s', (stored, expected) => {
    mocks.settings.set('general.theme', stored)
    expect(panelAppearance().theme).toBe(expected)
  })

  it('PA-2 旧的主题名 dark / light 换成 github-dark / github-light，其余原样', () => {
    mocks.settings.set('general.darkTheme', 'dark')
    mocks.settings.set('general.lightTheme', 'light')
    expect(panelAppearance()).toMatchObject({
      darkTheme: 'github-dark',
      lightTheme: 'github-light'
    })
    mocks.settings.set('general.darkTheme', 'dracula')
    mocks.settings.set('general.lightTheme', 'solarized-light')
    expect(panelAppearance()).toMatchObject({ darkTheme: 'dracula', lightTheme: 'solarized-light' })
  })

  it.each([
    ['16', 16],
    ['12.5', 12.5],
    ['abc', 14],
    ['', 14],
    ['0', 14]
  ])('PA-2 general.fontSize = %j → %d', (stored, expected) => {
    mocks.settings.set('general.fontSize', stored)
    expect(panelAppearance().fontSize).toBe(expected)
  })

  it.each([
    ['false', false],
    ['true', true],
    ['0', true],
    ['', true]
  ])('PA-2 appearance.focusMode = %j → %s（只有字面 false 才关）', (stored, expected) => {
    mocks.settings.set('appearance.focusMode', stored)
    expect(panelAppearance().focusMode).toBe(expected)
  })

  it('PA-2 存了语言 → 压过 i18next', () => {
    i18next.language = 'ja'
    mocks.settings.set('general.language', 'zh')
    expect(panelAppearance().language).toBe('zh')
  })
})

// ─── 视图同步的链路（pi 1.2 / chord2） ─────────────────────────────────────────

describe('CX-1 … CX-3 侧边栏的视图同步链路与 chrome 主体', () => {
  /** chord 客户端宿主的 hello（侧边栏那条链路的第一帧） */
  const HELLO = { t: 'hello', name: 'client:tab5', kind: 'client', epoch: 0 }
  const onEvent = (conn: FakeConn, name: string, params: unknown): void =>
    handlers.onEvent!(asConn(conn), name, params)
  const onClosed = (conn: FakeConn): void =>
    (mocks.onConnectionClosed.mock.calls[0][0] as (c: BridgeConnection) => void)(asConn(conn))
  const isClosed = (link: unknown): boolean => (link as { closed: boolean }).closed

  afterAll(() => {
    resetSyncHubForTests()
  })

  it('CX-1 sync.link 的 hello → 按这条连接盖章建链路（视图服务端在同一条连接上回 hello）；tabs.removed 照旧', () => {
    const conn = fakeConn('cx1')
    conn.info = { installId: 'i9', runId: 'r9' }
    const accept = vi.spyOn(getSyncHub(), 'accept')
    try {
      onEvent(conn, 'sync.link', { panelId: 'panel:5', link: 'L1', frame: HELLO, tabId: 1 })
      expect(accept).toHaveBeenCalledTimes(1)
      expect(accept.mock.calls[0][1]).toStrictEqual({
        kind: 'chrome',
        installId: 'i9',
        runId: 'r9',
        connId: 'cx1',
        tabId: 5
      })
      expect(isClosed(accept.mock.calls[0][0])).toBe(false)
      // 视图服务端（chord 宿主 main）在同一条连接、同一个侧边栏的同一条链路上回了自己的 hello
      expect(conn.emit).toHaveBeenCalledWith('sync.link', {
        panelId: 'panel:5',
        link: 'L1',
        frame: expect.objectContaining({ t: 'hello', kind: 'host', name: 'main' })
      })
      expect(mocks.closeTabSession).not.toHaveBeenCalled()

      // 形状不对的 sync.link：不建链路
      onEvent(conn, 'sync.link', { panelId: 'tab:5', link: 'L2', frame: HELLO })
      onEvent(conn, 'sync.link', { panelId: 'panel:5', link: 'L3', frame: { t: 'hold', id: 1 } })
      expect(accept).toHaveBeenCalledTimes(1)

      // 浏览器事件照旧：tabs.removed → closeTabSession；它不碰链路
      onEvent(conn, 'tabs.removed', { tabId: 5 })
      expect(mocks.closeTabSession.mock.calls).toEqual([[conn, 5]])
      expect(accept).toHaveBeenCalledTimes(1)
      expect(isClosed(accept.mock.calls[0][0])).toBe(false)
    } finally {
      onClosed(conn)
      accept.mockRestore()
    }
  })

  it('CX-2 onConnectionClosed 只登记一次；它一响，那条连接的链路全部结束、不发帧，别的连接不动', () => {
    expect(mocks.onConnectionClosed).toHaveBeenCalledTimes(1)
    const a = fakeConn('cx2a')
    const b = fakeConn('cx2b')
    const accept = vi.spyOn(getSyncHub(), 'accept')
    try {
      onEvent(a, 'sync.link', { panelId: 'panel:5', link: 'L1', frame: HELLO })
      onEvent(a, 'sync.link', { panelId: 'panel:7', link: 'L1', frame: HELLO })
      onEvent(b, 'sync.link', { panelId: 'panel:5', link: 'L1', frame: HELLO })
      const links = accept.mock.calls.map(([link]) => link)
      expect(links).toHaveLength(3)
      const emittedOnA = a.emit.mock.calls.length

      onClosed(a)
      expect(links.map(isClosed)).toEqual([true, true, false])
      expect(a.emit.mock.calls.length).toBe(emittedOnA)
      // a 上旧链路 id 的迟到帧：丢，不建链路
      onEvent(a, 'sync.link', { panelId: 'panel:5', link: 'L1', frame: { t: 'ping', n: 1 } })
      expect(accept).toHaveBeenCalledTimes(3)

      onClosed(b)
      expect(isClosed(links[2])).toBe(true)
      expect(() => onClosed(b)).not.toThrow()
    } finally {
      onClosed(a)
      onClosed(b)
      accept.mockRestore()
    }
  })

  it('CX-3 派生 agent 目标：同步回 false（是布尔值，不是 promise），从不解析 agent、不核对会话归属', () => {
    // 哪怕 agent 认得、根会话正是这个浏览器这一轮的标签页会话
    mocks.locate.mockResolvedValue({ sessionId: 's1', conversationId: 2 })
    mocks.tabSessionOwnedBy.mockReturnValue(true)
    const principal = { kind: 'chrome', installId: 'i1', runId: 'r1', connId: 'c1', tabId: 5 }
    for (const agentId of ['ag-own', 'ag-elsewhere', 'ag-unknown']) {
      const direct = chromeViewAllowed(principal, { kind: 'agent', agentId })
      expect(direct).toBe(false)
      expect(typeof direct).toBe('boolean')
      const viaServer = authorizeView(principal, { kind: 'agent', agentId })
      expect(viaServer).toBe(false)
    }
    expect(mocks.locate).not.toHaveBeenCalled()
    expect(mocks.tabSessionOwnedBy).not.toHaveBeenCalled()
  })

  it('CX-3 会话目标：主体缺 installId / runId（或不是字符串）→ 按空串核对 → false；齐全且归属 → true', () => {
    // 与真的 tabSessionOwnedBy 同一口径：任何一项为空都不归属
    mocks.tabSessionOwnedBy.mockImplementation(
      (sid: unknown, installId: string, runId: string) =>
        sid === 's1' && installId === 'i1' && runId === 'r1'
    )
    const target = { kind: 'session' as const, sessionId: 's1' }
    expect(chromeViewAllowed({ kind: 'chrome', installId: 'i1', runId: 'r1' }, target)).toBe(true)
    expect(chromeViewAllowed({ kind: 'chrome', runId: 'r1', tabId: 5 }, target)).toBe(false)
    expect(chromeViewAllowed({ kind: 'chrome', installId: 'i1', tabId: 5 }, target)).toBe(false)
    expect(chromeViewAllowed({ kind: 'chrome', installId: 5, runId: 'r1' }, target)).toBe(false)
    expect(chromeViewAllowed({ kind: 'chrome', installId: 'i1', runId: null }, target)).toBe(false)
    expect(chromeViewAllowed({ kind: 'chrome' }, target)).toBe(false)
    expect(mocks.tabSessionOwnedBy.mock.calls).toEqual([
      ['s1', 'i1', 'r1'],
      ['s1', '', 'r1'],
      ['s1', 'i1', ''],
      ['s1', '', 'r1'],
      ['s1', 'i1', ''],
      ['s1', '', '']
    ])
    expect(mocks.locate).not.toHaveBeenCalled()
  })
})
