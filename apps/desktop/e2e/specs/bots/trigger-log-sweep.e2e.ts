/**
 * 触发日志的补记（TSE-1，triggerLogService.sweepInterrupted）：上个进程没收尾的运行，下次启动记成 interrupted。
 *
 * 正在跑的运行只活在进程里：崩溃、强杀、退出时超时之后，日志那一行一直是 started，读作「还在跑」。这里走真启动：
 * 「停机 → 改库 → 用同一个 HOME 再起」（`launchApp({ home })` / `stop({ keepHome: true })`，无 LLM），一条 started 一条
 * completed，看库与设置 → 触发源 一页。库用系统 sqlite3 CLI 只在停机时写。
 */
import { rmSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import ja from '@shuvix/chat-protocol/i18n/locales/ja.json'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import { until, type CdpClient } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import { sqlite, sqliteJson, sqlLit, waitRendererReady } from '../../harness/seed'
import { triggerSettingsPane } from '../../harness/pages'

const LOCALES = [en, zh, ja]
const STARTED = 'tse-started'
const COMPLETED = 'tse-completed'
const STAMP = 1_700_000_000_000
const LEFT_ERROR = 'left over from the run'

interface LogRow {
  id: string
  outcome: string
  createdAt: number
  updatedAt: number
  error: string
}

const seedRow = (id: string, outcome: string, error: string): string =>
  `INSERT INTO trigger_logs (id, createdAt, updatedAt, trigger, bot, botDisplayName, botFile, outcome, error)
     VALUES (${sqlLit(id)}, ${STAMP}, ${STAMP}, 'timer.fired', 'ghost', ${sqlLit(`Ghost ${id}`)}, 'ghost.md', ${sqlLit(outcome)}, ${sqlLit(error)});`

let app: E2EApp | undefined
let home = ''
let settings: CdpClient | undefined

beforeAll(async () => {
  app = await launchApp()
  home = app.home
  await waitRendererReady(app.main)
  await app.stop({ keepHome: true })
  app = undefined

  sqlite(
    home,
    [seedRow(STARTED, 'started', LEFT_ERROR), seedRow(COMPLETED, 'completed', '')].join('\n')
  )
  // 前提：改库真的落下了
  expect(
    sqlite(home, `SELECT outcome FROM trigger_logs WHERE id = ${sqlLit(STARTED)}`).trim()
  ).toBe('started')

  app = await launchApp({ home })
  await waitRendererReady(app.main)
}, 180_000)

afterAll(async () => {
  if (app) await app.stop()
  else if (home) rmSync(home, { recursive: true, force: true })
})

describe('trigger log after a restart', () => {
  it('TSE-1 a row still started becomes interrupted, in the database and on the Triggers page; a finished row is unchanged', async () => {
    const rows = sqliteJson<LogRow>(
      home,
      'SELECT id, outcome, createdAt, updatedAt, error FROM trigger_logs ORDER BY id'
    )
    expect(rows).toHaveLength(2)
    const started = rows.find((row) => row.id === STARTED)!
    expect(started).toMatchObject({ outcome: 'interrupted', createdAt: STAMP, error: LEFT_ERROR })
    expect(started.updatedAt).toBeGreaterThan(STAMP)
    expect(rows.find((row) => row.id === COMPLETED)).toStrictEqual({
      id: COMPLETED,
      outcome: 'completed',
      createdAt: STAMP,
      updatedAt: STAMP,
      error: ''
    })

    settings = await app!.openSettings('triggers')
    const triggers = triggerSettingsPane(settings)
    await until(async () => (await triggers.logRows())?.length === 2, 'the two log rows')
    const shots = (await triggers.logRows())!
    const shot = (id: string): (typeof shots)[number] => shots.find((row) => row.id === id)!
    expect(shot(STARTED).outcome).toBe('interrupted')
    expect(LOCALES.map((l) => l.settings.triggerLogInterrupted)).toContain(
      shot(STARTED).outcomeLabel
    )
    expect(shot(COMPLETED).outcome).toBe('completed')
    expect(LOCALES.map((l) => l.settings.triggerLogCompleted)).toContain(
      shot(COMPLETED).outcomeLabel
    )
  })
})
