import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { info, warn, error, getAppMetrics } = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  getAppMetrics: vi.fn()
}))
// 不 mock 的话 electron-log 会写进真实的用户日志
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info, warn, error }),
  default: { transports: { file: { getFile: () => ({ path: '/x/logs/main.log' }) } } }
}))
vi.mock('electron', () => ({ app: { getAppMetrics } }))

import { formatLaunchTiming } from '../launchTiming'

const T0_GLOBAL = '__SHUVIX_MAIN_T0__'
const globals = globalThis as Record<string, unknown>

describe('formatLaunchTiming', () => {
  it('formats the full timeline', () => {
    expect(
      formatLaunchTiming({
        processCreatedAt: 1000,
        timeOrigin: 1089,
        firstJsMs: 482.4,
        appModulesMs: 2320.6,
        readyMs: 2588
      })
    ).toBe(
      'launch timing: process created 89ms before Node time origin → first JS +482ms → ' +
        'app modules start +2321ms → ready +2588ms'
    )
  })

  it('marks missing segments as unknown', () => {
    expect(formatLaunchTiming({ timeOrigin: 5, readyMs: 100 })).toBe(
      'launch timing: process creation time unknown → first JS ? → app modules ? → ready +100ms'
    )
  })
})

describe('logLaunchTiming', () => {
  let now = 0

  /** 模块级状态（appModulesStartMs）每个用例从头来 */
  async function load(): Promise<typeof import('../launchTiming')> {
    vi.resetModules()
    return import('../launchTiming')
  }

  beforeEach(() => {
    now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    info.mockReset()
    getAppMetrics.mockReset()
    getAppMetrics.mockReturnValue([
      { type: 'Tab', creationTime: 1 },
      { type: 'Browser', creationTime: performance.timeOrigin - 50 }
    ])
  })
  afterEach(() => {
    delete globals[T0_GLOBAL]
    vi.restoreAllMocks()
  })

  it('logs process creation, first JS, app modules start and ready', async () => {
    const m = await load()
    globals[T0_GLOBAL] = 12.3
    now = 40
    m.recordAppModulesStart()
    now = 99
    m.logLaunchTiming()
    expect(info.mock.calls).toEqual([
      [
        'launch timing: process created 50ms before Node time origin → first JS +12ms → ' +
          'app modules start +40ms → ready +99ms'
      ]
    ])
  })

  it('recordAppModulesStart keeps the first value', async () => {
    const m = await load()
    now = 40
    m.recordAppModulesStart()
    now = 70
    m.recordAppModulesStart()
    now = 99
    m.logLaunchTiming()
    expect(info.mock.calls[0][0]).toContain('app modules start +40ms')
  })

  it.each([
    [
      'getAppMetrics throws',
      () =>
        getAppMetrics.mockImplementation(() => {
          throw new Error('not ready')
        })
    ],
    [
      'Browser creationTime is NaN',
      () => getAppMetrics.mockReturnValue([{ type: 'Browser', creationTime: Number.NaN }])
    ],
    ['no Browser entry', () => getAppMetrics.mockReturnValue([{ type: 'Tab', creationTime: 1 }])]
  ])('process creation time unknown when %s', async (_name, arrange) => {
    const m = await load()
    arrange()
    now = 99
    expect(() => m.logLaunchTiming()).not.toThrow()
    expect(info.mock.calls[0][0]).toMatch(/^launch timing: process creation time unknown → /)
  })

  it.each([
    ['missing', undefined],
    ['a string', '12.3']
  ])('first JS ? when the T0 global is %s', async (_name, value) => {
    const m = await load()
    if (value !== undefined) globals[T0_GLOBAL] = value
    now = 99
    m.logLaunchTiming()
    expect(info.mock.calls[0][0]).toContain('→ first JS ? →')
  })

  it('never throws, even when the logger does', async () => {
    const m = await load()
    info.mockImplementation(() => {
      throw new Error('log failed')
    })
    expect(() => m.logLaunchTiming()).not.toThrow()
  })
})
