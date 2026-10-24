/**
 * 内置 timer 触发源（实验）—— 触发源是一项系统设置（设置 → 触发源）：今天只有这一个实例，开箱即开，每分钟
 * 触发一次 `timer.fired`（全局埋点，见 agent-runtime triggerPoints），订阅它的 bot 在 CEL `when` 里比时间
 * （`event.local.time == '18:00'`）。用户不用先配一个 timer 就能驱动 bot。
 *
 *  - **对齐整分钟**：每次排到下一分钟的起点（多等几十毫秒，免得落在上一分钟的尾巴上）；
 *  - **按分钟去重**：同一分钟（按真实时刻，即 `firedAt`）只触发一次 —— 睡眠唤醒、计时器提前 / 推迟都可能让同一分钟
 *    进来两次。夏令时回拨的那一小时里，本地时刻会重复出现一遍：那是两个不同的真实分钟，各触发一次；
 *  - **错过就错过**：电脑睡着、app 没开的那些分钟不补。唤醒后迟到的那一次按**当下**这一分钟算；
 *  - 开关是设置项 `triggers.timer.enabled`（缺省开），每次触发现读：关掉之后计时器照走，只是不发事件。
 *
 * 主进程（桌面与无头）在 main 启动时 `start`，退出时 `stop`。
 */
import type { TimerFiredPayload } from '@shuvix/agent-runtime'
import { settingsService } from './settingsService'
import { createLogger } from '../logger'

const log = createLogger('TimerSource')

/** 内置 timer 实例的 id（事件里的 `sourceId`、来源记录里的 `sourceId`） */
export const BUILTIN_TIMER_ID = 'timer:builtin:minute'

/** 内置 timer 的开关（缺省开；写坏的值按开） */
export const TIMER_ENABLED_KEY = 'triggers.timer.enabled'

/** 排到下一分钟起点之后再多等一点，免得计时器提前几毫秒醒来、落在上一分钟里 */
const ALIGN_SLACK_MS = 50

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** 某一刻所在的本地分钟 → 事件 payload */
export function timerPayloadAt(at: Date, sourceId: string = BUILTIN_TIMER_ID): TimerFiredPayload {
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

/** 内置 timer 此刻开着没有 */
export function isBuiltinTimerEnabled(): boolean {
  return settingsService.get(TIMER_ENABLED_KEY) !== 'false'
}

export class TimerSource {
  private handle: ReturnType<typeof setTimeout> | null = null
  /** 上一次触发的那一分钟（`firedAt`，真实时刻）—— 按分钟去重 */
  private lastMinute: string | null = null
  /** 上一次真正发出事件的时刻（设置页显示用；进程内） */
  private lastFired: TimerFiredPayload | null = null
  private listener: ((payload: TimerFiredPayload) => void) | null = null

  constructor(
    private readonly enabled: () => boolean = isBuiltinTimerEnabled,
    private readonly now: () => Date = () => new Date()
  ) {}

  start(listener: (payload: TimerFiredPayload) => void): void {
    this.stop()
    this.listener = listener
    this.scheduleNext()
  }

  stop(): void {
    if (this.handle) clearTimeout(this.handle)
    this.handle = null
    this.listener = null
  }

  /** 上一次发出的事件（没发过 → null） */
  get lastFiredPayload(): TimerFiredPayload | null {
    return this.lastFired
  }

  private scheduleNext(): void {
    const now = this.now()
    const delay = 60_000 - (now.getSeconds() * 1000 + now.getMilliseconds()) + ALIGN_SLACK_MS
    this.handle = setTimeout(() => this.tick(), delay)
    // 不为一个计时器把进程留住（退出流程照常走）
    this.handle.unref?.()
  }

  /** 到点：同一本地分钟只发一次，然后排下一次（发事件的异常不打断计时） */
  tick(): void {
    this.handle = null
    try {
      const payload = timerPayloadAt(this.now())
      if (payload.firedAt !== this.lastMinute) {
        this.lastMinute = payload.firedAt
        if (this.enabled() && this.listener) {
          this.lastFired = payload
          this.listener(payload)
        }
      }
    } catch (err) {
      log.warn(`timer tick failed: ${err instanceof Error ? err.message : err}`)
    } finally {
      if (this.listener) this.scheduleNext()
    }
  }
}

/** 主进程里唯一的内置 timer */
export const builtinTimer = new TimerSource()
