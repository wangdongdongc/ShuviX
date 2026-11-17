import type { ToolSettings } from '../dao/types'

export type { Project, ProjectEnvVar, ProjectSettings, ToolSettings } from '../dao/types'

/** IPC: 创建项目参数 */
export interface ProjectCreateParams {
  name?: string
  path: string
  systemPrompt?: string
  enabledTools?: string[]
  tool?: ToolSettings
  archived?: boolean
}

/** IPC: 更新项目参数 */
export interface ProjectUpdateParams {
  id: string
  name?: string
  path?: string
  systemPrompt?: string
  enabledTools?: string[]
  /** 新会话缺省启用的用户知识库（不给 = 不动） */
  knowledgeBases?: string[]
  tool?: ToolSettings
  archived?: boolean
}

/** IPC: 删除项目参数 */
export interface ProjectDeleteParams {
  id: string
}
