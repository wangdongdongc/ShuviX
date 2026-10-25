/**
 * 触发源一览（设置 → 触发源页，实验）—— `triggerSourcesStatus()`。
 *
 * 今天只有内置 timer 一个实例：开关现读设置项，「上一次触发」与「上一次的原始事件」取进程内的
 * `builtinTimer.lastFiredPayload`（事件 = 载荷加上 `trigger`，就是 bot 的 `when` 里看到的 `event`）。
 * **不列订阅者**：触发源与 bot 解绑（用户 2026-10-24），bots 目录里有什么都不影响这一行 —— TS-2 钉住这一点。
 * builtinTimer 是真的单例：fake timers 下 start → 走到下一分钟 → stop。
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'

const dirs = vi.hoisted(() => {
  const tmp = (process.env.TMPDIR || process.env.TEMP || '/tmp').replace(/[\\/]+$/, '')
  const base = `${tmp}/shuvix-trigstatus-${process.pid}`
  return { base, bots: `${base}/bots` }
})

const mocks = vi.hoisted(() => ({
  getSetting: vi.fn<(key: string) => string | undefined>()
}))

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }))
vi.mock('../../utils/paths', () => ({ getDefaultBotsDir: () => dirs.bots }))
vi.mock('../../dao/sessionDao', () => ({
  sessionDao: { findAll: () => [], pick: () => undefined, updateSettings: vi.fn() }
}))
vi.mock('../../utils/sessionConfigBroadcast', () => ({
  broadcastSessionConfigChanged: vi.fn()
}))
vi.mock('../settingsService', () => ({ settingsService: { get: mocks.getSetting } }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

import { triggerSourcesStatus } from '../triggerStatus'
import { builtinTimer } from '../triggerTimer'

/** 一份 bot md；`on` 是 `shuvix-bot-on` 下的原样 YAML 行 */
function botMd(name: string, displayName: string, on?: string[]): string {
  const lines = ['---', 'shuvix: bot v2', `name: ${name}`, `shuvix-displayName: ${displayName}`]
  if (on) lines.push('shuvix-bot-on:', ...on)
  lines.push('---', '', `${name} 的人设。`)
  return lines.join('\n')
}

function put(fileName: string, text: string): void {
  mkdirSync(dirs.bots, { recursive: true })
  writeFileSync(join(dirs.bots, fileName), text)
}

beforeEach(() => {
  rmSync(dirs.base, { recursive: true, force: true })
  mocks.getSetting.mockReset()
})

afterEach(() => {
  builtinTimer.stop()
  vi.useRealTimers()
})

afterAll(() => {
  rmSync(dirs.base, { recursive: true, force: true })
})

describe('triggerSourcesStatus —— 内置 timer 这一行', () => {
  it('TS-1 形状：一行内置 timer；enabled 每次现读设置；没触发过不带 lastFiredAt / lastEvent，触发后 = 最后一次的 firedAt 与事件', () => {
    expect(triggerSourcesStatus()).toStrictEqual([
      { id: 'timer:builtin:minute', kind: 'timer', builtin: true, enabled: true }
    ])
    mocks.getSetting.mockReturnValue('false')
    expect(triggerSourcesStatus()[0].enabled).toBe(false)
    mocks.getSetting.mockReturnValue('true')
    expect(triggerSourcesStatus()[0].enabled).toBe(true)
    expect(triggerSourcesStatus()[0]).not.toHaveProperty('lastFiredAt')
    expect(triggerSourcesStatus()[0]).not.toHaveProperty('lastEvent')

    // 真单例走两分钟
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 9, 24, 17, 59, 30))
    const fired: Array<Record<string, unknown>> = []
    builtinTimer.start((p) => fired.push(p as unknown as Record<string, unknown>))
    vi.advanceTimersByTime(30_000 + 50)
    expect(triggerSourcesStatus()[0].lastFiredAt).toBe(new Date(2026, 9, 24, 18, 0).toISOString())
    vi.advanceTimersByTime(60_000)
    builtinTimer.stop()
    expect(fired).toHaveLength(2)
    const [status] = triggerSourcesStatus()
    expect(status.lastFiredAt).toBe(fired[1].firedAt)
    // 原始事件 = 最后一次的载荷 + trigger（when 里的 event 长这样）
    expect(status.lastEvent).toStrictEqual({ ...fired[1], trigger: 'timer.fired' })
    expect((status.lastEvent?.local as { time: string }).time).toBe('18:01')
  })
})

describe('triggerSourcesStatus —— 与 bot 解绑', () => {
  it('TS-2 bots 目录里有绑定 timer.fired 的 bot，这一行照样只有触发源自身（没有 subscribers 之类的键）', () => {
    put(
      'ticker.md',
      botMd('ticker', 'Ticker', [
        '  - trigger: timer.fired',
        '    message: Tick.',
        '  - trigger: timer.fired',
        `    when: "event.local.time == '18:00'"`,
        '    message: Evening.'
      ])
    )
    const list = triggerSourcesStatus()
    expect(list).toHaveLength(1)
    // 单例 timer 可能留着前面用例触发过的 lastFiredAt / lastEvent —— 只核对键的集合：没有一个键说到 bot
    const allowed = ['id', 'kind', 'builtin', 'enabled', 'lastFiredAt', 'lastEvent']
    expect(Object.keys(list[0]).filter((key) => !allowed.includes(key))).toEqual([])
    expect(list[0]).toMatchObject({ id: 'timer:builtin:minute', kind: 'timer', builtin: true })
  })
})
