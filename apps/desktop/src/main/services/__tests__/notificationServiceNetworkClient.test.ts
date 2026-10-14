/**
 * notificationService —— 没有窗口的客户端（局域网里的浏览器，server mode phase B）上报当前会话。
 *
 * 契约：`reportActiveSession(null, sid)` 照记「它看到了这个会话」（撤掉该会话名下的通知 → 决策器的 `sessionOpened`），
 * 但不进「窗口 → 会话」表：浏览器没有焦点可言，从不算「用户正看着」，桌面通知照常弹。
 * 决策器是替身：从 `createNotificationCenter` 的入参里取出 `isForeground`，`sessionOpened` 是 spy。
 * 每条用例一个新模块（resetModules + 动态 import）：窗口表与决策器都是模块级状态。
 *
 *   NH-14 `reportActiveSession(null, 's1')` → sessionOpened('s1')；isForeground('s1') 为假、不为它查窗口；
 *         对照：`reportActiveSession(7, 's1')` 且 webContents 7 的窗口有焦点 → 为真
 *   NH-15 `reportActiveSession(null, null)` → 不调 sessionOpened、不抛
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createNotificationCenter: vi.fn(),
  sessionOpened: vi.fn(),
  getAllWindows: vi.fn((): unknown[] => [])
}))

vi.mock('electron', () => ({
  app: { focus: vi.fn() },
  BrowserWindow: { getAllWindows: mocks.getAllWindows },
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
  sessionDao: { pickSettings: vi.fn(() => ({})), findById: vi.fn() }
}))
vi.mock('../../dao/settingsDao', () => ({ settingsDao: { findByKey: vi.fn() } }))
vi.mock('../pinnedChatService', () => ({ focusFloating: vi.fn(), isPinned: vi.fn(() => false) }))
vi.mock('../../i18n', () => ({ t: (key: string) => key }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

type NotificationModule = typeof import('../notificationService')
let service: NotificationModule
let isForeground: (sessionId: string) => boolean

beforeEach(async () => {
  mocks.createNotificationCenter.mockReset()
  mocks.sessionOpened.mockReset()
  mocks.getAllWindows.mockReset().mockImplementation(() => [])
  mocks.createNotificationCenter.mockImplementation(
    (deps: { isForeground: (sessionId: string) => boolean }) => {
      isForeground = deps.isForeground
      return {
        handleEvent: vi.fn(),
        askRaised: vi.fn(),
        askResolved: vi.fn(),
        runEnded: vi.fn(),
        sessionOpened: mocks.sessionOpened
      }
    }
  )
  vi.resetModules()
  service = await import('../notificationService')
  service.initNotificationService({ getMainWindow: () => null, ensureMainWindow: () => {} })
})

const focusedWindow = (webContentsId: number, focused: boolean): unknown => ({
  isDestroyed: () => false,
  isFocused: () => focused,
  webContents: { id: webContentsId }
})

describe('NH-14 没有窗口的客户端报会话', () => {
  it("NH-14 reportActiveSession(null, 's1') → sessionOpened；从不算前台、不查窗口", () => {
    mocks.getAllWindows.mockImplementation(() => [focusedWindow(7, true)])
    service.reportActiveSession(null, 's1')
    expect(mocks.sessionOpened).toHaveBeenCalledTimes(1)
    expect(mocks.sessionOpened).toHaveBeenCalledWith('s1')
    expect(isForeground('s1')).toBe(false)
    expect(mocks.getAllWindows).not.toHaveBeenCalled()
  })

  it("NH-14 对照：reportActiveSession(7, 's1') 且窗口 7 有焦点 → 前台", () => {
    mocks.getAllWindows.mockImplementation(() => [focusedWindow(7, true)])
    service.reportActiveSession(7, 's1')
    expect(isForeground('s1')).toBe(true)
    expect(mocks.getAllWindows).toHaveBeenCalled()
    // 网络客户端随后报别的会话：窗口表不动
    service.reportActiveSession(null, 's2')
    expect(isForeground('s1')).toBe(true)
    expect(isForeground('s2')).toBe(false)
  })
})

describe('NH-15 没有会话', () => {
  it('NH-15 reportActiveSession(null, null) → 不调 sessionOpened、不抛', () => {
    expect(() => service.reportActiveSession(null, null)).not.toThrow()
    expect(mocks.sessionOpened).not.toHaveBeenCalled()
  })
})
