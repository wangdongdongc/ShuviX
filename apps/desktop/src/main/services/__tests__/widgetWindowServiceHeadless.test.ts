/**
 * widgetWindowService —— 无头运行（`shuvix --headless`，docs/headless/design.md）时不在这台电脑上开 widget 窗口。
 *
 * 契约：`open(id)` 抛 `headlessWindowError`（`code: 'headless'`，消息点名 `widget window for "<id>"`）—— CLI 的
 * `shuvix widget open` 据此回一个失败；在此之前不查 widget、不建窗口。
 * electron 的 BrowserWindow 是构造 spy；widget 服务、日志、rendererPage、appEventBus、settingsDao、externalOpen 都是替身。
 * 模块不重置（静态导入），`utils/headless` 与被测模块同一份实例；afterEach 回到桌面模式。
 *
 *   WW-H1 无头运行：open('demo') 抛 code 'headless'、消息含 `widget window for "demo"`；widgetService.getById 没被调、
 *         没构造 BrowserWindow、没装守卫、没加载页面；对照：桌面应用照常先查 widget（查不到 → not found）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  constructed: vi.fn(),
  getById: vi.fn(),
  stopWidget: vi.fn(),
  guardAppWindow: vi.fn(),
  loadRendererPage: vi.fn(),
  subscribe: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: class {
    constructor(options: unknown) {
      mocks.constructed(options)
    }
  }
}))
vi.mock('../widget', () => ({
  widgetService: { getById: mocks.getById, stopWidget: mocks.stopWidget }
}))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))
vi.mock('../../utils/rendererPage', () => ({ loadRendererPage: mocks.loadRendererPage }))
vi.mock('../../utils/appEventBus', () => ({
  appEventBus: { subscribe: mocks.subscribe, publish: vi.fn() }
}))
vi.mock('../../dao/settingsDao', () => ({
  settingsDao: { findByKey: vi.fn(), upsert: vi.fn() }
}))
vi.mock('../externalOpen', () => ({ guardAppWindow: mocks.guardAppWindow }))

import { open } from '../widgetWindowService'
import { enableHeadlessMode, resetHeadlessModeForTests } from '../../utils/headless'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getById.mockReturnValue(undefined)
})

afterEach(() => {
  resetHeadlessModeForTests()
})

describe('WW-H1 无头运行不开 widget 窗口', () => {
  it('WW-H1 open(demo) 抛 code headless、点名 widget；不查 widget、不建窗口', () => {
    enableHeadlessMode()
    let caught: unknown
    try {
      open('demo')
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as { code?: unknown }).code).toBe('headless')
    expect((caught as Error).message).toContain('widget window for "demo"')

    expect(mocks.getById).not.toHaveBeenCalled()
    expect(mocks.constructed).not.toHaveBeenCalled()
    expect(mocks.guardAppWindow).not.toHaveBeenCalled()
    expect(mocks.loadRendererPage).not.toHaveBeenCalled()
  })

  it('WW-H1 对照：桌面应用先查 widget（查不到 → not found，不带 headless 码）', () => {
    let caught: unknown
    try {
      open('demo')
    } catch (error) {
      caught = error
    }
    expect((caught as Error).message).toBe('Widget "demo" not found')
    expect((caught as { code?: unknown }).code).toBeUndefined()
    expect(mocks.getById).toHaveBeenCalledWith('demo')
    expect(mocks.constructed).not.toHaveBeenCalled()
  })
})
