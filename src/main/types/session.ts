/** 会话数据结构 */
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
  createdAt: number
  updatedAt: number
}

/** IPC: 更新会话标题参数 */
export interface SessionUpdateTitleParams {
  id: string
  title: string
}

/** IPC: 更新会话模型配置参数 */
export interface SessionUpdateModelConfigParams {
  id: string
  provider: string
  model: string
}

/** IPC: 更新会话所属项目参数 */
export interface SessionUpdateProjectParams {
  id: string
  projectId: string | null
}

/** IPC: 更新会话模型元数据参数 */
export interface SessionUpdateModelMetadataParams {
  id: string
  modelMetadata: string
}
