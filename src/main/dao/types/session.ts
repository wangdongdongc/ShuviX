/** 模型相关元数据（DB 中以 JSON 字符串存储，DAO 层负责序列化/反序列化） */
export interface SessionModelMetadata {
  /** 思考深度 */
  thinkingLevel?: string
  /** 会话级启用的工具列表 */
  enabledTools?: string[]
}

/** 会话级配置（DB 中以 JSON 字符串存储，DAO 层负责序列化/反序列化） */
export interface SessionSettings {
  /** SSH 命令免审批 */
  sshAutoApprove?: boolean
  /** 绑定的 Telegram Bot ID（null/undefined = 未绑定） */
  telegramBotId?: string
}

/** 会话数据结构（对应 DB 表 sessions） */
export interface Session {
  id: string
  title: string
  /** 所属项目 ID（null 表示临时会话） */
  projectId: string | null
  provider: string
  model: string
  systemPrompt: string
  /** 模型相关设置（思考深度、工具列表等） */
  modelMetadata: SessionModelMetadata
  /** 会话级配置（SSH 免审批等） */
  settings: SessionSettings
  createdAt: number
  updatedAt: number
}
