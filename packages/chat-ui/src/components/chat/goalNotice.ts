/**
 * 旧目标模式（v0.2.58–v0.2.60）留在会话里的目标通知的解析：那时宿主写给模型的 `<goal-…>` 信封，解出转写里那一行要说
 * 的事 —— 第几次续跑、判定理由、暂停原因、结局。现在不再写这些通知了（目标改由管理员会话推动，
 * docs/goal-mode-design.md §16），这里只为旧会话照旧显示。
 *
 * 文案是模型面向的英文，格式属于 agent-runtime；这里只做「够看」的解析：认不出的部分留空，行上退回只有标签的样子，
 * 原文照旧在展开态里。插进信封的文字都转义过（`&` `<` `>`，属性值另加 `"`），解出来的要反转义。
 */
import {
  GOAL_NOTICE_TAGS,
  systemNoticeBlockRe,
  type GoalNoticeKind
} from '@shuvix/chat-protocol/systemNoticeContract'

/** 旧目标模式的暂停原因（`<goal-status event="paused" reason="…">`） */
export const GOAL_PAUSE_REASONS = [
  'user',
  'stopped',
  'restart',
  'forked',
  'turns',
  'stalled',
  'wall-clock',
  'judge-unavailable',
  'run-error'
] as const
export type GoalPauseReason = (typeof GOAL_PAUSE_REASONS)[number]

/** `<goal-status event="…">` 的几种结局 */
export const GOAL_STATUS_EVENTS = ['met', 'impossible', 'paused', 'cleared', 'replaced'] as const
export type GoalStatusEventKind = (typeof GOAL_STATUS_EVENTS)[number]

export interface GoalNoticeInfo {
  kind: GoalNoticeKind
  goalId?: string
  /** goal-continue：宿主为目标续跑到第几轮 */
  turn?: number
  /** goal-continue：用户点了「继续」（不是判定没达成） */
  resumed: boolean
  /** goal-checkin：后台工作等了多久（原样，如 `30m`） */
  waited?: string
  /** goal-status：结局 */
  event?: GoalStatusEventKind
  /** goal-status event=paused：暂停原因 */
  pauseReason?: GoalPauseReason
  /** 判定理由：续跑的 `Checker:`、恢复时的 `Last check:`、达成 / 做不到的理由 */
  reason?: string
  /** 续跑：判定建议的下一步 */
  nextStep?: string
  /** 续跑、检查、目标改了：通知里重述的目标原文 */
  objective?: string
}

const ATTR_RE = /([\w-]+)="([^"]*)"/g

/** 反转义（`escapeGoalText` / `escapeGoalAttr` 的逆）；`&amp;` 最后换，免得 `&amp;lt;` 被换两次 */
export function unescapeGoalText(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
}

function attrsOf(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of raw.matchAll(ATTR_RE)) out[m[1]] = unescapeGoalText(m[2])
  return out
}

function capture(re: RegExp, text: string): string | undefined {
  const value = re.exec(text)?.[1]?.trim()
  return value ? unescapeGoalText(value) : undefined
}

function isGoalTag(tag: string): tag is GoalNoticeKind {
  return (GOAL_NOTICE_TAGS as readonly string[]).includes(tag)
}

/** 正文里第一个目标通知块的要点；没有目标通知块 → null */
export function parseGoalNotice(content: string): GoalNoticeInfo | null {
  for (const m of content.matchAll(systemNoticeBlockRe())) {
    const [, tag, rawAttrs, inner] = m
    if (!isGoalTag(tag)) continue
    const attrs = attrsOf(rawAttrs)
    const info: GoalNoticeInfo = {
      kind: tag,
      resumed: attrs.resumed === 'true',
      ...(attrs.id ? { goalId: attrs.id } : {})
    }
    const objective = capture(/<objective>\n?([\s\S]*?)\n?<\/objective>/, inner)
    if (objective) info.objective = objective
    switch (tag) {
      case 'goal-continue': {
        const turn = Number.parseInt(attrs.turn ?? '', 10)
        if (Number.isFinite(turn)) info.turn = turn
        if (info.resumed) {
          info.reason = capture(/Last check: ([\s\S]*?)\nUsed: /, inner)
        } else {
          info.reason = capture(/Checker: ([\s\S]*?)(?:\nSuggested next step: |\nUsed: )/, inner)
          info.nextStep = capture(/Suggested next step: ([\s\S]*?)\nUsed: /, inner)
        }
        break
      }
      case 'goal-checkin':
        if (attrs.waited) info.waited = attrs.waited
        break
      case 'goal-status': {
        const event = attrs.event as GoalStatusEventKind
        if ((GOAL_STATUS_EVENTS as readonly string[]).includes(event)) info.event = event
        if (event === 'paused') {
          const reason = attrs.reason as GoalPauseReason
          if ((GOAL_PAUSE_REASONS as readonly string[]).includes(reason)) info.pauseReason = reason
        }
        if (event === 'met' || event === 'impossible') {
          info.reason = capture(
            /judged the goal (?:met|impossible): ([\s\S]*?)\s*Stop working on it\.\s*$/,
            inner
          )
        }
        break
      }
      default:
        break
    }
    if (info.reason === undefined) delete info.reason
    if (info.nextStep === undefined) delete info.nextStep
    return info
  }
  return null
}

/** 投影带来的 `noticeKind` 是不是目标通知 */
export function isGoalNoticeKind(kind: string | undefined): kind is GoalNoticeKind {
  return kind !== undefined && isGoalTag(kind)
}

/** 取文案（useTranslation 的 t） */
export type GoalNoticeTranslate = (key: string, opts?: Record<string, unknown>) => string

/**
 * 一行要说的：标签（发生了什么）+ 摘要（判定理由 / 暂停原因 / 新的原文）。纯函数，单测直接测它。
 * 认不出的部分不编：摘要留空，标签退回「目标」
 */
export function goalNoticeText(
  info: GoalNoticeInfo | null,
  t: GoalNoticeTranslate
): { label: string; detail?: string } {
  if (!info) return { label: t('goal.notice.generic') }
  switch (info.kind) {
    case 'goal-continue':
      if (info.resumed) {
        return { label: t('goal.notice.resumed'), detail: info.reason }
      }
      return {
        label:
          info.turn !== undefined
            ? t('goal.notice.continue', { turn: info.turn })
            : t('goal.notice.continueBare'),
        detail: info.reason ? t('goal.notice.notMet', { reason: info.reason }) : undefined
      }
    case 'goal-checkin':
      return {
        label: t('goal.notice.checkin'),
        detail: info.waited ? t('goal.notice.waited', { waited: info.waited }) : undefined
      }
    // 花费越线的收尾通知：如今不再写，v0.2.58–v0.2.59 的会话里还有
    case 'goal-budget':
      return { label: t('goal.notice.budget') }
    case 'goal-updated':
      return { label: t('goal.notice.updated'), detail: info.objective }
    case 'goal-status':
      switch (info.event) {
        case 'met':
          return { label: t('goal.notice.met'), detail: info.reason }
        case 'impossible':
          return { label: t('goal.notice.impossible'), detail: info.reason }
        case 'paused':
          return {
            label: t('goal.notice.paused'),
            detail: info.pauseReason ? t(`goal.reason.${info.pauseReason}`) : undefined
          }
        case 'cleared':
          return { label: t('goal.notice.cleared') }
        case 'replaced':
          return { label: t('goal.notice.replaced') }
        default:
          return { label: t('goal.notice.generic') }
      }
  }
}
