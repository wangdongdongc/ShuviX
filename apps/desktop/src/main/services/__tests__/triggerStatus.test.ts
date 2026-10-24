/**
 * 触发源一览（设置 → 触发源页，实验）—— `triggerSourcesStatus()`。
 *
 * 今天只有内置 timer 一个实例：开关现读设置项，「上一次触发」取进程内的 `builtinTimer.lastFiredPayload`；
 * 订阅者是生效 bot 的 `shuvix-bot-on` 里绑定 `timer.fired` 的那几条（一条绑定一行）。
 *
 * bots 目录是**真的**临时目录、botService 是真的 —— 「被同名遮蔽的那份、解析不过的文件不列」靠的是
 * 扫描的裁决，换成假的 listAll 就测不到。builtinTimer 也是真的单例：fake timers 下 start → 走到下一分钟 → stop。
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
  it('TS-1 形状：一行内置 timer；enabled 每次现读设置；没触发过不带 lastFiredAt，触发后 = 最后一次的 firedAt', () => {
    // 没有 bots 目录：订阅者为空
    expect(triggerSourcesStatus()).toStrictEqual([
      { id: 'timer:builtin:minute', kind: 'timer', builtin: true, enabled: true, subscribers: [] }
    ])
    mocks.getSetting.mockReturnValue('false')
    expect(triggerSourcesStatus()[0].enabled).toBe(false)
    mocks.getSetting.mockReturnValue('true')
    expect(triggerSourcesStatus()[0].enabled).toBe(true)
    expect(triggerSourcesStatus()[0]).not.toHaveProperty('lastFiredAt')

    // 真单例走两分钟
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 9, 24, 17, 59, 30))
    const fired: string[] = []
    builtinTimer.start((p) => fired.push(p.firedAt))
    vi.advanceTimersByTime(30_000 + 50)
    expect(triggerSourcesStatus()[0].lastFiredAt).toBe(new Date(2026, 9, 24, 18, 0).toISOString())
    vi.advanceTimersByTime(60_000)
    builtinTimer.stop()
    expect(fired).toHaveLength(2)
    expect(triggerSourcesStatus()[0].lastFiredAt).toBe(fired[1])
    expect(fired[1]).toBe(new Date(2026, 9, 24, 18, 1).toISOString())
  })
})

describe('triggerSourcesStatus —— 订阅者', () => {
  it('TS-2 生效 bot 的每条 timer.fired 绑定一行（when 只在有时带）；未知埋点的绑定、被同名遮蔽的那份、解析不过的文件不列', () => {
    put(
      'ticker.md',
      botMd('ticker', 'Ticker', [
        '  - trigger: timer.fired',
        '    message: Tick.',
        '  - trigger: timer.fired',
        `    when: "event.local.time == '18:00'"`,
        '    message: Evening.',
        '  - trigger: webhook.received',
        '    message: Hook.'
      ])
    )
    // 同名的复制品：被 ticker.md 遮蔽
    put(
      'ticker copy.md',
      botMd('ticker', 'Ticker Copy', [
        '  - trigger: timer.fired',
        '    when: "true"',
        '    message: Copy.'
      ])
    )
    // 绑了会话域埋点：整份文件非法
    put(
      'broken.md',
      botMd('broken', 'Broken', ['  - trigger: session.turn-completed', '    message: Nope.'])
    )
    // 没有绑定的 bot
    put('quiet.md', botMd('quiet', 'Quiet'))
    put(
      'nightly.md',
      botMd('nightly', '夜班', [
        '  - trigger: timer.fired',
        `    when: "event.local.hour == 2"`,
        '    message: Night.'
      ])
    )

    const [status] = triggerSourcesStatus()
    expect(status.subscribers).toStrictEqual([
      { bot: 'nightly', displayName: '夜班', when: 'event.local.hour == 2' },
      { bot: 'ticker', displayName: 'Ticker' },
      { bot: 'ticker', displayName: 'Ticker', when: "event.local.time == '18:00'" }
    ])
  })
})
