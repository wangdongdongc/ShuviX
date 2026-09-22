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
 *     存的语言 → i18next 当前语言 → en）。
 *
 * 会话层（tabSessions）与对话接口（channel）换成 spy；ChromeFrontend 与 i18next 是真的。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
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
  connectionOwnsSession: vi.fn()
}))

vi.mock('../../core', () => ({ chatFrontendRegistry: { bind: mocks.bind } }))
vi.mock('../../../utils/appEventBus', () => ({ appEventBus: { subscribe: mocks.subscribe } }))
vi.mock('../../../dao/settingsDao', () => ({
  settingsDao: { findByKey: (key: string) => mocks.settings.get(key) }
}))
vi.mock('../../../services/chromeBridge', () => ({
  chromeBridge: { setHandlers: mocks.setHandlers, readyConnections: mocks.readyConnections }
}))
vi.mock('../channel', () => ({ callPanelChannel: mocks.callPanelChannel }))
vi.mock('../tabSessions', () => ({
  openTabSession: mocks.openTabSession,
  closeTabSession: mocks.closeTabSession,
  sweepTabSessions: mocks.sweepTabSessions,
  connectionOwnsSession: mocks.connectionOwnsSession
}))

import { panelAppearance, registerChromeFrontend } from '../index'
import { ChromeFrontend } from '../ChromeFrontend'

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

beforeAll(() => {
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
    mocks.connectionOwnsSession
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
