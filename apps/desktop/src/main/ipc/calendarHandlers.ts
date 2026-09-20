import { ipcMain } from 'electron'
import { daysInMonth, firstEntryOnDay, sessionsOnDay } from '../services/sessionDayPromptService'

/**
 * 桌面日历 IPC —— 按 session_day_prompts 查开口日 / 当天会话 / 当天第一条用户消息。
 * 扩展没有这张表，不实现对应 ChatApi.calendar。
 */
export function registerCalendarHandlers(): void {
  ipcMain.handle('calendar:daysInMonth', (_event, params: { year: number; month: number }) =>
    daysInMonth(params.year, params.month)
  )
  ipcMain.handle('calendar:sessionsOnDay', (_event, params: { day: string }) =>
    sessionsOnDay(params.day)
  )
  ipcMain.handle('calendar:firstEntryOnDay', (_event, params: { sessionId: string; day: string }) =>
    firstEntryOnDay(params.sessionId, params.day)
  )
}
