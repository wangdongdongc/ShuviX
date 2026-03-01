export type { Session } from '../dao/types'
import type { Session } from '../dao/types'

/** 会话完整信息（含 service 层计算属性，用于 IPC 返回给渲染进程） */
export interface SessionInfo extends Session {
  /** 项目工作目录（由 service 层填充） */
  workingDirectory?: string | null
  /** 当前生效的工具列表（由 service 层解析：session > project > all） */
  enabledTools?: string[]
  /** 项目 AGENT.md 是否存在并已加载 */
  agentMdLoaded?: boolean
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

/** IPC: 更新会话级配置参数 */
export interface SessionUpdateSettingsParams {
  id: string
  settings: string
}
