/**
 * 集成用例的时钟：`now()` = 真实时间 + 可调偏移（永远在走 —— durable 的重试 / 压缩退避按 Harness 的
 * `now` 睡，冻住的时钟会让退避永远到不了，F13），`today()` 是另一根独立可改的日期弦。
 * 两者都是「世界级」的：重启（换进程）沿用同一份。
 */
export interface WorldClock {
  /** Harness 的时钟：Date.now() + offset */
  now(): number
  /** 今天的本地日期（YYYY-MM-DD；日期通知按它判「新的一天」） */
  today(): string
  /** 往前拨（毫秒） */
  advance(ms: number): void
  setToday(date: string): void
}

export function worldClock(today = '2026-10-04'): WorldClock {
  let offset = 0
  let date = today
  return {
    now: () => Date.now() + offset,
    today: () => date,
    advance: (ms) => {
      offset += ms
    },
    setToday: (next) => {
      date = next
    }
  }
}
