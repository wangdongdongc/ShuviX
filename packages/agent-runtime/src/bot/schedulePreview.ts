/**
 * bot 文件的排期预演 —— 写进 bot 文件之后，回执里说每条 `timer.fired` 绑定接下来几次在什么本地时刻触发。
 *
 * 为什么要有：`when` 的语法错在解析时就报，可「语法对、意思错」没人报 —— `event.local.weekday == 'Sunday'`
 * 解析得过，却永远不会命中（weekday 是数字），用户要等到那个周日什么都没发生才知道。2026-10-31 的真模型演练里
 * 一个模型这么写了，另一个为了确认自己写对了，翻了数据库、写了一堆测试文件。预演把「它到底什么时候跑」直接摆出来：
 * 按真的 timer 的 payload（timerPayloadAt）逐分钟求同一个 `when`（evaluateWhen），从下一分钟起看 14 天。
 *
 * `activeSessions(date)` 一律按「那天有会话」（1）算 —— 将来的日子有没有人用 ShuviX 谁也不知道；用到它的绑定
 * 回执里会说明这个假设。`project` 由宿主回答这个名字现在对得上几个项目（对不上或不止一个，那次运行会被跳过）。
 */
import type { TimerFiredPayload } from '../hook/triggerPoints'
import { timerPayloadAt } from '../hook/timerPayload'
import { evaluateWhen } from '../hook/when'
import type { BotBinding } from './botFile'

const TIMER_TRIGGER = 'timer.fired'
const DEFAULT_SOURCE_ID = 'timer:builtin:minute'
const DEFAULT_DAYS = 14
const DEFAULT_LIMIT = 3
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

export type TimerBindingPreview =
  /**
   * 窗口里命中的前几分钟（至多 limit 个，按先后）。`error` = 另有些分钟求值出错（第一次的错误第一行）：真的触发源
   * 把出错的那一分钟当作不命中、照样往下走，所以 `x || 出错` 这种条件在 x 为真的分钟照样触发
   */
  | { kind: 'fires'; at: TimerFiredPayload[]; error?: string }
  /** 窗口里一分钟都不命中 */
  | { kind: 'never' }
  /** 窗口里没有命中、且求值出过错 —— 真的触发源按「不命中」处置，也就是从不触发 */
  | { kind: 'error'; message: string }

export interface SchedulePreviewOptions {
  /** 从这一刻的下一分钟起看 */
  now: Date
  /** 看多少天（缺省 14） */
  days?: number
  /** 至多列几次（缺省 3） */
  limit?: number
  /** 求值时的 `env`（宿主与真的触发源给的一样） */
  env?: Record<string, unknown>
  /** 事件里的 `sourceId`（缺省内置 timer 的 id） */
  sourceId?: string
}

/** 一条绑定的 `when` 在窗口里哪几分钟命中（没有 `when` = 每分钟都命中） */
export function previewTimerBinding(
  when: string | undefined,
  options: SchedulePreviewOptions
): TimerBindingPreview {
  const days = options.days ?? DEFAULT_DAYS
  const limit = options.limit ?? DEFAULT_LIMIT
  const sourceId = options.sourceId ?? DEFAULT_SOURCE_ID
  const env = options.env ?? {}
  const first = Math.floor(options.now.getTime() / 60_000) * 60_000 + 60_000
  const hits: TimerFiredPayload[] = []
  let error: string | undefined
  for (let i = 0; i < days * 1440 && hits.length < limit; i++) {
    const payload = timerPayloadAt(new Date(first + i * 60_000), sourceId)
    if (when === undefined) {
      hits.push(payload)
      continue
    }
    try {
      const event = { ...payload, trigger: TIMER_TRIGGER }
      if (evaluateWhen(when, { event, env }, { activeSessions: () => 1 })) hits.push(payload)
    } catch (err) {
      // 与真的触发源一样：这一分钟算不命中，接着看下一分钟。CEL 的错误带着源码与插入符，回执里只要第一行
      error ??= (err instanceof Error ? err.message : String(err)).split('\n')[0].trim()
    }
  }
  if (hits.length > 0)
    return error === undefined ? { kind: 'fires', at: hits } : { kind: 'fires', at: hits, error }
  return error === undefined ? { kind: 'never' } : { kind: 'error', message: error }
}

function stamp(p: TimerFiredPayload): string {
  return `${WEEKDAYS[p.local.weekday]} ${p.local.date} ${p.local.time}`
}

const FIELDS_HINT =
  "event.local has date 'YYYY-MM-DD', time 'HH:MM' (24-hour), weekday 0–6 (0 = Sunday, a number), hour and minute (numbers), all local time"

/** `activeSessions(` 前面允许空白（CEL 认 `activeSessions (d)`） */
const ACTIVE_SESSIONS_CALL = /\bactiveSessions\s*\(/

const daysText = (days: number): string => `${days} day${days === 1 ? '' : 's'}`

export interface ScheduleNoteOptions extends SchedulePreviewOptions {
  /** 宿主：这个名字此刻对得上几个（没归档的）项目；不给就不查 */
  projectMatches?: (name: string) => number
}

/**
 * 一份 bot 文件的绑定 → 回执里那一段（模型面英文）；没有 `timer.fired` 绑定回 null。
 * 每条绑定一行：接下来几次的本地时刻，或「14 天里一次都不触发」/「求值出错」并附上本地字段的形状；
 * 写了 `project` 而这个名字对不上恰好一个项目的，再加一行
 */
export function botScheduleNote(
  bindings: readonly BotBinding[],
  options: ScheduleNoteOptions
): string | null {
  const days = options.days ?? DEFAULT_DAYS
  const lines: string[] = []
  let assumesSessions = false
  bindings.forEach((binding, index) => {
    if (binding.trigger !== TIMER_TRIGGER) return
    const label = `binding #${index} (${TIMER_TRIGGER})`
    // 空串与没写一样（真的触发源 `if (!binding.when)` 当它每分钟都命中）
    const when = binding.when || undefined
    if (when !== undefined && ACTIVE_SESSIONS_CALL.test(when)) assumesSessions = true
    const preview = previewTimerBinding(when, options)
    if (preview.kind === 'fires') {
      lines.push(
        when === undefined
          ? `- ${label}: no \`when\`, so it fires every minute.`
          : `- ${label}: next at ${preview.at.map(stamp).join(', ')}.` +
              (preview.error
                ? ` On other minutes its \`when\` fails to evaluate (${preview.error}), which counts as not firing.`
                : '')
      )
    } else if (preview.kind === 'never') {
      lines.push(
        `- ${label}: never fires in the next ${daysText(days)}. Check its \`when\` — ${FIELDS_HINT}.`
      )
    } else {
      lines.push(
        `- ${label}: its \`when\` fails to evaluate (${preview.message}), so it never fires. ${FIELDS_HINT}.`
      )
    }
    if (binding.project !== undefined && options.projectMatches) {
      const matches = options.projectMatches(binding.project)
      if (matches === 0) {
        lines.push(
          `- ${label}: no project is named "${binding.project}", so every run would be skipped.`
        )
      } else if (matches > 1) {
        lines.push(
          `- ${label}: more than one project is named "${binding.project}", so every run would be skipped.`
        )
      }
    }
  })
  if (lines.length === 0) return null
  const assumption = assumesSessions ? ', counting every day as one with sessions' : ''
  return `Schedule check (local time, the next ${daysText(days)}${assumption}):\n${lines.join('\n')}`
}
