/**
 * 内置子智能体定义
 *
 * 内置 sub-agent 的所有信息由代码定义，不写入数据库。
 * - displayName / shortDescription 通过 i18n key 懒加载（随语言切换实时更新）
 * - systemPrompt / llmDescription 保持英文（LLM 训练语料主要是英文，英文提示效果更稳）
 * - 用户的启用/禁用偏好存储在 settings 表的 `subagent.builtinDisabled` 键
 */

export interface BuiltinSubAgentDef {
  /** 稳定 ID（工具名），如 'explore'、'research' */
  readonly name: string
  /** i18n key 用于 UI 展示的显示名，如 'subAgent.explore.displayName' */
  readonly displayNameKey: string
  /** i18n key 用于 UI 简短描述（列表项副标题） */
  readonly shortDescriptionKey: string
  /** 给主 Agent LLM 看的工具描述（英文，稳定不随语言切换） */
  readonly llmDescription: string
  /** 子智能体系统提示词（英文，稳定不随语言切换） */
  readonly systemPrompt: string
  /** 工具白名单：内置工具名 / 'mcp:serverName' / 'skill:skillName' */
  readonly tools: readonly string[]
  /** agent loop 最大轮次 */
  readonly maxTurns: number
  /**
   * 强依赖的内置 MCP server 名称列表。
   * 执行前会检查这些 server 是否已连接，任一未连接都直接返回提示，
   * 不进入 agent loop。
   */
  readonly requiredMcp?: readonly string[]
}
