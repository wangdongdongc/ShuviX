export type { Session, SessionModelMetadata, SessionSettings } from '../dao/types'
import type { Session } from '../dao/types'

/** 会话完整信息（含 service 层计算属性，用于 IPC 返回给渲染进程） */
export interface SessionInfo extends Session {
  /** 项目工作目录（由 service 层填充） */
  workingDirectory?: string | null
  /** 当前生效的工具列表（由 service 层解析：session > project > all） */
  enabledTools?: string[]
}

/** IPC: 创建会话参数（notebookPath 非空则创建笔记本会话） */
export interface SessionCreateParams {
  projectId?: string | null
  notebookPath?: string
  /** 项目记忆笔记本的 slug（由 services/memory 传入；见 SessionSettings.memorySlug） */
  memorySlug?: string
  title?: string
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

/** IPC: 更新会话思考深度参数 */
export interface SessionUpdateThinkingLevelParams {
  id: string
  thinkingLevel: string
}

/** IPC: 更新会话启用工具列表参数 */
export interface SessionUpdateEnabledToolsParams {
  id: string
  enabledTools: string[]
}

/** IPC: 更新命令免询问参数 */
export interface SessionUpdateAutoAllowParams {
  id: string
  autoAllow: boolean
}

/** IPC: 移除允许列表条目（仅路径条目 `Read(...)`/`Write(...)`） */
export interface SessionAllowListRemoveParams {
  id: string
  entry: string
}
