/** 思考深度级别（跨进程协议值，UI 与后端共享） */
// 'max' 由 pi 0.80.10 起可能回传，协议层需要能承载（UI 暂不主动提供该档）
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/**
 * 新建会话的默认思考深度 —— 用户没在「设置 → 通用 → 默认模型」里配过 `general.defaultThinkingLevel`
 * 时的那一档（配过就以配置为准，见 `defaultThinkingLevelOf`）
 */
export const DEFAULT_THINKING_LEVEL: SelectableThinkingLevel = 'medium'

/**
 * 用户能选的思考档位 —— 输入框的思考选择器与 agent md 的 `shuvix-thinking` 共用这一份。
 * 两边各写一份就会漂移：md 里写得出、选择器却显示不了的档位，用户在子会话里看到的是一个空白选项。
 * 不含 'minimal'（界面从未提供）与 'max'（只在协议层承载 pi 回传的值）。
 */
export const SELECTABLE_THINKING_LEVELS = [
  'off',
  'low',
  'medium',
  'high',
  'xhigh'
] as const satisfies readonly ThinkingLevel[]

export type SelectableThinkingLevel = (typeof SELECTABLE_THINKING_LEVELS)[number]

export function isSelectableThinkingLevel(value: unknown): value is SelectableThinkingLevel {
  return (SELECTABLE_THINKING_LEVELS as readonly unknown[]).includes(value)
}

/** 每个可选档位的界面文案键 —— 输入框的思考选择器与设置里的默认思考等级共用 */
export const THINKING_LEVEL_LABEL_KEYS: Record<SelectableThinkingLevel, string> = {
  off: 'input.thinkOff',
  low: 'input.thinkLow',
  medium: 'input.thinkMedium',
  high: 'input.thinkHigh',
  xhigh: 'input.thinkXHigh'
}

/**
 * 设置项 `general.defaultThinkingLevel` 的存值 → 可选档位；没设过 / 写坏了 → DEFAULT_THINKING_LEVEL。
 * 只收可选档位：设置页画不出来的值（'minimal' / 'max'）存进去了也按没设过处理。
 */
export function defaultThinkingLevelOf(raw: unknown): SelectableThinkingLevel {
  return isSelectableThinkingLevel(raw) ? raw : DEFAULT_THINKING_LEVEL
}
