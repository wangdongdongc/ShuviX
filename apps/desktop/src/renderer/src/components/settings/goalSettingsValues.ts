/**
 * 设置 → 通用 → 目标（GoalSettings）的值换算：设置里存的字符串 ↔ 输入框里的字。纯函数。
 * 读不出的值按内置缺省回落，与主进程 goalService.defaultLimits 同一条规则。
 */
import { DEFAULT_GOAL_LIMITS } from '@shuvix/chat-protocol/types/goal'

export interface GoalDefaults {
  turns: string
  stall: string
}

/** 设置值 → 输入框文字（读不出就用内置缺省，与主进程同一条回落） */
export function goalDefaultsOf(raw: {
  turns: string | undefined
  stall: string | undefined
}): GoalDefaults {
  const positive = (value: string | undefined): number | undefined => {
    const n = Number(value)
    return value !== undefined && value.trim() !== '' && Number.isFinite(n) && n > 0 ? n : undefined
  }
  return {
    turns: String(Math.round(positive(raw.turns) ?? DEFAULT_GOAL_LIMITS.maxTurns)),
    stall: String(Math.round(positive(raw.stall) ?? DEFAULT_GOAL_LIMITS.stallTurns))
  }
}

/** 输入框文字 → 要写的设置值；不合法 → null（不写） */
export function goalSettingValue(text: string): string | null {
  const n = Number(text.trim())
  return Number.isInteger(n) && n >= 1 ? String(n) : null
}

/** 两个设置键（主进程 goalService 同名） */
export const GOAL_SETTING_KEYS: Record<keyof GoalDefaults, string> = {
  turns: 'goal.defaultMaxTurns',
  stall: 'goal.stallTurns'
}
