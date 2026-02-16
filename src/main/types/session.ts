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
