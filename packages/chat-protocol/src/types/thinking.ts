/** 思考深度级别（跨进程协议值，UI 与后端共享） */
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/**
 * 新建会话的默认思考深度 —— 用户没在「设置 → 通用 → 默认模型」里配过 `general.defaultThinkingLevel`
 * 时的那一档（配过就以配置为准，见 `defaultThinkingLevelOf`）
 */
export const DEFAULT_THINKING_LEVEL: SelectableThinkingLevel = 'medium'

/**
 * 用户能选的思考档位 —— 输入框的思考选择器与 agent md 的 `shuvix-thinking` 共用这一份。
 * 两边各写一份就会漂移：md 里写得出、选择器却显示不了的档位，用户在子会话里看到的是一个空白选项。
 * 不含 'minimal'（界面从未提供）。'max' 2026-10-29 起可选（用户裁定）：pi 1.2 在多数 Claude / GPT /
 * DeepSeek / Kimi / GLM 模型上有这一档；模型没有的档位由 pi 换成相近的一档（先往高找，再往低找）。
 * 界面上直接显示档位名本身（不翻译，2026-10-29 用户裁定：用户熟悉的就是 low / high / xhigh 这些英文名，
 * 也是 md 里写的那个值）。
 */
export const SELECTABLE_THINKING_LEVELS = [
  'off',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
] as const satisfies readonly ThinkingLevel[]

export type SelectableThinkingLevel = (typeof SELECTABLE_THINKING_LEVELS)[number]

export function isSelectableThinkingLevel(value: unknown): value is SelectableThinkingLevel {
  return (SELECTABLE_THINKING_LEVELS as readonly unknown[]).includes(value)
}

/**
 * 设置项 `general.defaultThinkingLevel` 的存值 → 可选档位；没设过 / 写坏了 → DEFAULT_THINKING_LEVEL。
 * 只收可选档位：设置页画不出来的值（'minimal'）存进去了也按没设过处理。
 */
export function defaultThinkingLevelOf(raw: unknown): SelectableThinkingLevel {
  return isSelectableThinkingLevel(raw) ? raw : DEFAULT_THINKING_LEVEL
}
