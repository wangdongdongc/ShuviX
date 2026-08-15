/**
 * 模型相关元数据。
 *
 * 已不再落库（v15 删掉了 sessions.modelMetadata）——唯一事实源是会话树上的
 * thinking_level_change / active_tools_change entry。这个类型保留是因为它仍是
 * `agent.init` 返回给前端的形状。
 */
export interface SessionModelMetadata {
  /** 思考深度 */
  thinkingLevel?: string
  /** 会话级启用的工具列表 */
  enabledTools?: string[]
}

/** 会话级配置（DB 中以 JSON 字符串存储，DAO 层负责序列化/反序列化） */
export interface SessionSettings {
  /** 命令免审批（bash + ssh 统一开关） */
  autoApprove?: boolean
  /** 命令允许列表，格式 Bash(pattern) / SSH(pattern) */
  allowList?: string[]
  /** 绑定的 Telegram Bot ID（null/undefined = 未绑定） */
  /** 注入的项目指令文件（单选）：undefined = 按 AGENTS.md → CLAUDE.md 优先级自动选，null = 不注入 */
  instructionFile?: string | null
  /**
   * 会话根 Agent 采用的档案名（内置档案或 `~/.shuvix/agents/<name>.md`）。
   * 缺省 / 档案已不存在 → 回落 'default'（见 sessionService.resolveAgentProfileName）。
   */
  agentProfile?: string
  /** 笔记本会话绑定的 md 文件（相对项目根，forward-slash）；非空即为笔记本会话（纯预览，无对话/Agent） */
  notebookPath?: string
}

/** 会话数据结构（对应 DB 表 sessions） */
export interface Session {
  id: string
  title: string
  /** 所属项目 ID（null 表示临时会话） */
  projectId: string | null
  /** 会话级配置（SSH 免审批等） */
  settings: SessionSettings
  createdAt: number
  updatedAt: number
}
