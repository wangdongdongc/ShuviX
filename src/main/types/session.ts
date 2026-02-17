/** 会话数据结构 */
export interface Session {
  id: string
  title: string
  provider: string
  model: string
  systemPrompt: string
  workingDirectory: string
  dockerEnabled: number
  dockerImage: string
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

/** IPC: 更新会话工作目录参数 */
export interface SessionUpdateWorkingDirParams {
  id: string
  workingDirectory: string
}

/** IPC: 更新会话 Docker 配置参数 */
export interface SessionUpdateDockerParams {
  id: string
  dockerEnabled: boolean
  dockerImage?: string
}

/** IPC: 更新会话模型元数据参数 */
export interface SessionUpdateModelMetadataParams {
  id: string
  modelMetadata: string
}
