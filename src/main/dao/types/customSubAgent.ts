/** 自定义子智能体扩展元数据 */
export interface CustomSubAgentMetadata {
  [key: string]: unknown
}

/** 自定义子智能体（对应 DB 表 custom_sub_agents） */
export interface CustomSubAgent {
  id: string
  /** 工具标识符（小写英文+连字符，如 'code-reviewer'） */
  name: string
  /** UI 显示名 */
  displayName: string
  /** 给 LLM 的工具描述 */
  description: string
  /** 子智能体系统提示词 */
  systemPrompt: string
  /** 可用工具列表：内置工具名 / 'mcp:serverName' / 'skill:skillName' */
  tools: string[]
  /** 最大 agent loop 轮次 */
  maxTurns: number
  /** 是否为内置子智能体（不可编辑/删除） */
  isBuiltin: boolean
  /** 是否启用（关闭后不出现在工具选择器中） */
  isEnabled: boolean
  /** 扩展元数据 */
  metadata: CustomSubAgentMetadata
  createdAt: number
  updatedAt: number
}
