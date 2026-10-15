/**
 * notificationService —— 无头运行（`shuvix --headless`，docs/headless/design.md）时桌面通知不弹。
 *
 * 契约：决策器交给宿主的 `notifier.show` 在无头运行时不构造原生 Notification（服务器上没有桌面），只记一行日志；
 * 桌面应用照常构造并弹出。
 * 决策器是替身：从 `createNotificationCenter` 的入参里取出 `notifier.show`；electron 的 Notification 是记账的假类
 * （isSupported 为真、构造是 spy）。每条用例一个新模块（resetModules + 动态 import），`utils/headless` 在重置之后导入，
 * 与被测模块同一份实例。
 *
 *   NT-H1 无头运行：show({kind:'done', sessionId:'s1', key, …}) 不构造 Notification、不弹；（白盒）logger.info 记的一行
 *         带 kind 与 's1'；对照：桌面应用构造恰一个、按标题正文构造、show 一次
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentNotification } from '@shuvix/chat-protocol/notification'

const mocks = vi.hoisted(() => {
  const constructed = vi.fn<(options: Record<string, unknown>) => void>()
  const shown = vi.fn()
  class FakeNotification {
    static isSupported(): boolean {
      return true
    }
    readonly on = vi.fn()
    readonly show = shown
    readonly close = vi.fn()
    constructor(options: Record<string, unknown>) {
      constructed(options)
    }
  }
  return {
    FakeNotification,
    constructed,
    shown,
    createNotificationCenter: vi.fn(),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  }
})

vi.mock('electron', () => ({
  app: { focus: vi.fn() },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  Notification: mocks.FakeNotification
}))
vi.mock('@shuvix/agent-runtime', () => ({
  createNotificationCenter: mocks.createNotificationCenter
}))
vi.mock('../../dao/sessionDao', () => ({
  sessionDao: { pickSettings: vi.fn(() => ({})), findById: vi.fn() }
}))
vi.mock('../../dao/settingsDao', () => ({ settingsDao: { findByKey: vi.fn() } }))
vi.mock('../pinnedChatService', () => ({ focusFloating: vi.fn(), isPinned: vi.fn(() => false) }))
vi.mock('../../i18n', () => ({ t: (key: string) => key }))
vi.mock('../../logger', () => ({ createLogger: () => mocks.log }))

type Show = (notification: AgentNotification) => void
let show: Show
let headless: typeof import('../../utils/headless')

const DONE: AgentNotification = {
  key: 'run:s1',
  kind: 'done',
  sessionId: 's1',
  title: 'Session one',
  body: 'Finished'
}

beforeEach(async () => {
  mocks.constructed.mockReset()
  mocks.shown.mockReset()
  mocks.log.info.mockReset()
  mocks.createNotificationCenter.mockReset()
  mocks.createNotificationCenter.mockImplementation((deps: { notifier: { show: Show } }) => {
    show = deps.notifier.show
    return {
      handleEvent: vi.fn(),
      askRaised: vi.fn(),
      askResolved: vi.fn(),
      runEnded: vi.fn(),
      sessionOpened: vi.fn()
    }
  })
  vi.resetModules()
  // 重置之后导入：与 notificationService 同一份模块实例
  headless = await import('../../utils/headless')
  const service = await import('../notificationService')
  service.initNotificationService({ getMainWindow: () => null, ensureMainWindow: () => {} })
})

afterEach(() => {
  headless.resetHeadlessModeForTests()
})

describe('NT-H1 无头运行不弹桌面通知', () => {
  it("NT-H1 show({kind:'done', sessionId:'s1'}) → 不构造 Notification；日志带 kind 与 s1", () => {
    headless.enableHeadlessMode()
    show(DONE)
    expect(mocks.constructed).not.toHaveBeenCalled()
    expect(mocks.shown).not.toHaveBeenCalled()

    const lines = mocks.log.info.mock.calls.map((args) => args.map(String).join(' '))
    expect(lines.some((line) => line.includes('done') && line.includes('s1'))).toBe(true)
  })

  it('NT-H1 对照：桌面应用构造恰一个 Notification 并弹出', () => {
    show(DONE)
    expect(mocks.constructed).toHaveBeenCalledTimes(1)
    expect(mocks.constructed.mock.calls[0][0]).toMatchObject({
      title: 'Session one',
      body: 'Finished'
    })
    expect(mocks.shown).toHaveBeenCalledTimes(1)
  })
})
