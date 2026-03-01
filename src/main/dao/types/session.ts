/** 会话数据结构（对应 DB 表 sessions） */
export interface Session {
  id: string
  title: string
  /** 所属项目 ID（null 表示临时会话） */
  projectId: string | null
  provider: string
  model: string
  systemPrompt: string
  /** 模型相关设置（JSON：思考深度等） */
  modelMetadata: string
  /** 会话级配置（JSON：sshAutoApprove 等） */
  settings: string
  createdAt: number
  updatedAt: number
}
