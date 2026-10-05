/**
 * notificationService —— Chrome 标签页会话的事件不进桌面通知。
 *
 * 契约：
 *   - 标签页会话的对话在 Chrome 侧边栏里（用户在那边看、在那边答询问）：它的 ChatEvent 与询问
 *     （`notifyAskRaised` / `notifyAskResolved`，P3-08 起询问走钩子，P3-08-55）一条都不交给决策器；
 *     普通会话照旧交；
 *   - 判定是「这条会话是不是标签页会话」，记一次就够（chromeTab 创建时定死、会话 id 不复用）——
 *     事件逐 token 来，不能每条都读库：同一条会话只按 `(sid, ['chromeTab'])` 查一次；
 *   - 记忆表有上限：记满 1000 条就整个清掉重记（清掉之后早先那条会话会再查一次）；
 *   - 决策器还没初始化时来的事件静默丢掉，不抛。
 *
 * 每条用例一个新模块（resetModules + 动态 import）：记忆表与决策器都是模块级状态。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatEvent } from '@shuvix/chat-protocol/events'

const mocks = vi.hoisted(() => ({
  handleEvent: vi.fn(),
  askRaised: vi.fn(),
  askResolved: vi.fn(),
  createNotificationCenter: vi.fn(),
  pickSettings: vi.fn<(id: string, keys: string[]) => Record<string, unknown> | undefined>(),
  tabSessions: new Set<string>()
}))

vi.mock('electron', () => ({
  app: { focus: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
  Notification: class {
    static isSupported(): boolean {
      return false
    }
  }
}))
vi.mock('@shuvix/agent-runtime', () => ({
  createNotificationCenter: mocks.createNotificationCenter
}))
vi.mock('../../dao/sessionDao', () => ({
  sessionDao: { pickSettings: mocks.pickSettings, findById: vi.fn() }
}))
vi.mock('../../dao/settingsDao', () => ({ settingsDao: { findByKey: vi.fn() } }))
vi.mock('../pinnedChatService', () => ({ focusFloating: vi.fn(), isPinned: vi.fn(() => false) }))
vi.mock('../../i18n', () => ({ t: (key: string) => key }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

type NotificationModule = typeof import('../notificationService')
let service: NotificationModule

const deps = { getMainWindow: () => null, ensureMainWindow: () => {} }

beforeEach(async () => {
  mocks.handleEvent.mockReset()
  mocks.askRaised.mockReset()
  mocks.askResolved.mockReset()
  mocks.createNotificationCenter.mockReset()
  mocks.createNotificationCenter.mockReturnValue({
    handleEvent: mocks.handleEvent,
    askRaised: mocks.askRaised,
    askResolved: mocks.askResolved,
    runEnded: vi.fn(),
    sessionOpened: vi.fn()
  })
  mocks.tabSessions.clear()
  mocks.pickSettings.mockReset()
  mocks.pickSettings.mockImplementation((id) =>
    mocks.tabSessions.has(id)
      ? { chromeTab: { installId: 'i1', runId: 'r1', tabId: 5 } }
      : { chromeTab: undefined }
  )
  vi.resetModules()
  service = await import('../notificationService')
})

const delta = (sessionId: string): ChatEvent => ({ type: 'ask_count', sessionId, count: 1 })
const end = (sessionId: string): ChatEvent => ({ type: 'agent_end', sessionId, reason: 'ok' })
const askReq = {
  id: 'tc-1',
  kind: 'ask',
  toolName: 'mcp__chrome__click',
  command: 'click',
  createdAt: 1
} as const

describe('NT-1 标签页会话的事件不交给决策器', () => {
  it('NT-1 / P3-08-55 标签页会话的一轮结束与询问 → 不交；普通会话 → 原样交', () => {
    service.initNotificationService(deps)
    mocks.tabSessions.add('tab-1')
    service.notifyOnChatEvent(end('tab-1'))
    service.notifyAskRaised('tab-1', askReq)
    service.notifyAskResolved('tab-1', 'tc-1')
    expect(mocks.handleEvent).not.toHaveBeenCalled()
    expect(mocks.askRaised).not.toHaveBeenCalled()
    expect(mocks.askResolved).not.toHaveBeenCalled()

    const desktopEnd = end('desk-1')
    service.notifyOnChatEvent(desktopEnd)
    service.notifyAskRaised('desk-1', askReq)
    service.notifyAskResolved('desk-1', 'tc-1')
    expect(mocks.handleEvent.mock.calls).toEqual([[desktopEnd]])
    expect(mocks.askRaised.mock.calls).toEqual([['desk-1', askReq]])
    expect(mocks.askResolved.mock.calls).toEqual([['desk-1', 'tc-1']])
  })

  it('NT-1 绑定不合法的会话算普通会话，照交', () => {
    service.initNotificationService(deps)
    mocks.pickSettings.mockReturnValue({ chromeTab: { installId: 'i1', runId: 'r1', tabId: '5' } })
    service.notifyOnChatEvent(end('odd-1'))
    expect(mocks.handleEvent).toHaveBeenCalledTimes(1)
  })
})

describe('NT-2 每条会话只查一次库', () => {
  it('NT-2 同一条会话的 100 条事件 → pickSettings 恰一次，按 (sid, [chromeTab])', () => {
    service.initNotificationService(deps)
    mocks.tabSessions.add('tab-1')
    for (let i = 0; i < 100; i++) service.notifyOnChatEvent(delta('tab-1'))
    for (let i = 0; i < 100; i++) service.notifyOnChatEvent(delta('desk-1'))
    expect(mocks.pickSettings.mock.calls).toEqual([
      ['tab-1', ['chromeTab']],
      ['desk-1', ['chromeTab']]
    ])
    expect(mocks.handleEvent).toHaveBeenCalledTimes(100)
  })

  it('NT-2 记下的是第一次的判定：之后行变了也不重查（chromeTab 创建时定死）', () => {
    service.initNotificationService(deps)
    service.notifyOnChatEvent(delta('s-1'))
    mocks.tabSessions.add('s-1')
    service.notifyOnChatEvent(delta('s-1'))
    expect(mocks.pickSettings).toHaveBeenCalledTimes(1)
    expect(mocks.handleEvent).toHaveBeenCalledTimes(2)
  })
})

describe('NT-3 决策器还没初始化', () => {
  it('NT-3 事件静默丢掉，不抛；初始化之后不补发', () => {
    expect(() => service.notifyOnChatEvent(end('desk-1'))).not.toThrow()
    expect(() => service.notifyOnChatEvent(end('tab-1'))).not.toThrow()
    service.initNotificationService(deps)
    expect(mocks.handleEvent).not.toHaveBeenCalled()
    service.notifyOnChatEvent(end('desk-1'))
    expect(mocks.handleEvent).toHaveBeenCalledTimes(1)
  })
})

describe('NT-4 记忆表有上限', () => {
  it('NT-4 记满 1000 条后，下一条新会话进来前整表清空：早先那条会再查一次', () => {
    service.initNotificationService(deps)
    for (let i = 0; i < 1000; i++) service.notifyOnChatEvent(delta(`s-${i}`))
    expect(mocks.pickSettings).toHaveBeenCalledTimes(1000)

    // 记满但还没有新会话：老的仍在表里
    service.notifyOnChatEvent(delta('s-0'))
    expect(mocks.pickSettings).toHaveBeenCalledTimes(1000)

    // 第 1001 条会话：先清表再记它
    service.notifyOnChatEvent(delta('s-1000'))
    expect(mocks.pickSettings).toHaveBeenCalledTimes(1001)
    service.notifyOnChatEvent(delta('s-1000'))
    expect(mocks.pickSettings).toHaveBeenCalledTimes(1001)
    service.notifyOnChatEvent(delta('s-0'))
    expect(mocks.pickSettings).toHaveBeenCalledTimes(1002)
    expect(mocks.pickSettings.mock.calls.at(-1)).toEqual(['s-0', ['chromeTab']])
  })

  it('NT-4 清表不改判定：清掉之后标签页会话照样不通知', () => {
    service.initNotificationService(deps)
    mocks.tabSessions.add('tab-early')
    service.notifyOnChatEvent(end('tab-early'))
    for (let i = 0; i < 1000; i++) service.notifyOnChatEvent(delta(`s-${i}`))
    mocks.handleEvent.mockClear()
    service.notifyOnChatEvent(end('tab-early'))
    expect(mocks.handleEvent).not.toHaveBeenCalled()
  })
})
