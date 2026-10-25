import { defineHandler } from './registry'
import { daysInMonth, firstEntryOnDay, sessionsOnDay } from '../services/sessionDayPromptService'
import { deleteReport, openReport, reportDaysInMonth, reportOnDay } from '../services/dailyNotes'

/**
 * 桌面日历 IPC —— 按 session_day_prompts 查开口日 / 当天会话 / 当天第一条用户消息；
 * 外加每天的日报（`~/.shuvix/daily`，见 services/dailyNotes）：哪些天写了、那天的摘录、打开那天、
 * 删掉那天的日报。扩展没有这张表，不实现对应 ChatApi.calendar。
 */
export function registerCalendarHandlers(): void {
  defineHandler('calendar:daysInMonth', (_ctx, params: { year: number; month: number }) =>
    daysInMonth(params.year, params.month)
  )
  defineHandler('calendar:sessionsOnDay', (_ctx, params: { day: string }) =>
    sessionsOnDay(params.day)
  )
  defineHandler('calendar:firstEntryOnDay', (_ctx, params: { sessionId: string; day: string }) =>
    firstEntryOnDay(params.sessionId, params.day)
  )
  defineHandler('calendar:reportDaysInMonth', (_ctx, params: { year: number; month: number }) =>
    reportDaysInMonth(params.year, params.month)
  )
  defineHandler('calendar:reportOnDay', (_ctx, params: { day: string }) => reportOnDay(params.day))
  defineHandler('calendar:openReport', (_ctx, params: { day: string }) => openReport(params.day))
  defineHandler('calendar:deleteReport', (_ctx, params: { day: string }) =>
    deleteReport(params.day)
  )
}
