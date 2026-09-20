/**
 * 桌面日历 IPC（session_day_prompts）——
 * prompt 落树后 daysInMonth / sessionsOnDay / firstEntryOnDay 对齐 message.list
 * 第一条 user id；rollback（moveTo）不删索引；delete 后当天列表不含它。
 *
 * CAL-03 + CAL-22 + CAL-24 共用一次冷启动。断言全走 window.api.*，无 DOM。
 * 隔离实例无 API key，prompt 允许失败，但 user_message 必须落到树上才继续。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchApp, type E2EApp } from '../../harness/launch'
import { createAgentSession, promptAndListMessages } from '../../harness/seed'

interface ListedMessage {
  id: string
  role: string
  content?: unknown
}

interface DaySession {
  id: string
}

const PROMPT = 'CAL 日历开口'

let app: E2EApp
let sid = ''
let userEntryId = ''
let day = ''
let year = 0
let month = 0

const localDay = (ts = Date.now()): { day: string; year: number; month: number } => {
  const d = new Date(ts)
  const y = d.getFullYear()
  const m = d.getMonth() + 1
  return {
    year: y,
    month: m,
    day: `${y}-${String(m).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
}

const daysInMonth = (): Promise<string[]> =>
  app.main.eval<string[]>(`window.api.calendar.daysInMonth(${JSON.stringify({ year, month })})`)

const sessionsOnDay = (): Promise<DaySession[]> =>
  app.main.eval<DaySession[]>(`window.api.calendar.sessionsOnDay(${JSON.stringify({ day })})`)

const firstEntryOnDay = (): Promise<string | null> =>
  app.main.eval<string | null>(
    `window.api.calendar.firstEntryOnDay(${JSON.stringify({ sessionId: sid, day })})`
  )

beforeAll(async () => {
  app = await launchApp()
})
afterAll(async () => {
  await app.stop()
})

describe('桌面日历 IPC（session_day_prompts）', () => {
  it('CAL-03 promptAndListMessages 后 calendar 对齐第一条 user id', async () => {
    sid = (await createAgentSession(app.main, { title: 'CAL-开口' })).sid
    const messages = (await promptAndListMessages(app.main, sid, PROMPT)) as ListedMessage[]
    const firstUser = messages.find((m) => m.role === 'user')
    expect(firstUser, 'the user message landed on the tree').toBeDefined()
    expect(firstUser!.content).toBe(PROMPT)
    userEntryId = firstUser!.id

    const today = localDay()
    year = today.year
    month = today.month
    day = today.day

    expect(await daysInMonth()).toContain(day)
    expect((await sessionsOnDay()).map((s) => s.id)).toContain(sid)
    expect(await firstEntryOnDay()).toBe(userEntryId)
  })

  it('CAL-22 rollback 后索引仍在，calendar 仍返回该 session 与原 entryId', async () => {
    expect(
      await app.main.eval(
        `window.api.message.rollback(${JSON.stringify({ sessionId: sid, messageId: userEntryId })})`
      )
    ).toEqual({ success: true })
    expect((await sessionsOnDay()).map((s) => s.id)).toContain(sid)
    expect(await firstEntryOnDay()).toBe(userEntryId)
    expect(await daysInMonth()).toContain(day)
  })

  it('CAL-24 delete 后 sessionsOnDay 不含它', async () => {
    await app.main.eval(`window.api.session.delete(${JSON.stringify(sid)})`)
    expect((await sessionsOnDay()).map((s) => s.id)).not.toContain(sid)
    expect(await firstEntryOnDay()).toBeNull()
  })
})
