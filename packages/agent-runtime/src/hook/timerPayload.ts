/**
 * 某一刻所在的本地分钟 → `timer.fired` 的 payload。内置 timer 每分钟发一次的就是它，bot 文件的排期预演
 * （bot/schedulePreview）也拿它造事件 —— 两边同一个函数，预演说「会在 20:00 触发」时真的 timer 才会这么判。
 */
import type { TimerFiredPayload } from './triggerPoints'

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

export function timerPayloadAt(at: Date, sourceId: string): TimerFiredPayload {
  // 按真实时刻取整到分钟（不用 setSeconds：它按本地时间算，夏令时回拨那一小时里的两个 01:30 会被并成一个）
  const minute = new Date(Math.floor(at.getTime() / 60_000) * 60_000)
  const date = `${minute.getFullYear()}-${pad(minute.getMonth() + 1)}-${pad(minute.getDate())}`
  const time = `${pad(minute.getHours())}:${pad(minute.getMinutes())}`
  return {
    sourceId,
    firedAt: minute.toISOString(),
    local: {
      date,
      time,
      weekday: minute.getDay(),
      hour: minute.getHours(),
      minute: minute.getMinutes()
    }
  }
}
