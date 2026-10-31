export type { Session, SessionModelMetadata, SessionSettings } from '../dao/types'
import type { Session } from '../dao/types'
import type { ChromeTabBinding } from '@shuvix/chat-protocol/chromeTabSession'

/** 会话完整信息（含 service 层计算属性，用于 IPC 返回给渲染进程） */
export interface SessionInfo extends Session {
  /** 项目工作目录（由 service 层填充） */
  workingDirectory?: string | null
}

/** IPC: 创建会话参数（notebookPath 非空则创建笔记本会话；parentId 非空则创建子会话） */
export interface SessionCreateParams {
  projectId?: string | null
  /**
   * 父会话 ID —— 提供则创建子会话（projectId 恒随父会话）。
   * 只有 `session` 工具走这条路，UI 的新建入口不传。
   */
  parentId?: string
  notebookPath?: string
  title?: string
  /** 绑定的 bot 名；提供则创建 bot 会话（普通有根会话，见 SessionSettings.bot） */
  bot?: string
  /**
   * bot 会话的工作位置：一个项目 id（不给 = 临时工作区）。bot 会话不当项目的成员，这个项目记成引用
   * （SessionSettings.workProject）；同时给了 `projectId` 也按引用处理。不是 bot 会话时不看
   */
  workProject?: string
  /**
   * 挂着的 Chrome 标签页；提供则创建 Chrome 标签页会话（无项目、不进列表，见 SessionSettings.chromeTab）。
   * 只有 Chrome 前端（frontend/chrome）走这条路，渲染层的新建入口不传、IPC 也会滤掉。
   */
  chromeTab?: ChromeTabBinding
}

/** IPC: 更新会话标题参数 */
export interface SessionUpdateTitleParams {
  id: string
  title: string
}

/** IPC: 更新会话所属项目参数 */
export interface SessionUpdateProjectParams {
  id: string
  projectId: string | null
}

/** IPC: 修改扩展能力勾选参数（整份替换；会话已有 Agent 运行时则被拒绝） */
export interface SessionUpdateEnabledToolsParams {
  id: string
  enabledTools: string[]
}

/** IPC: 改这条会话启用的知识库（整份替换；不看有没有运行时 —— 改完下一次工具调用就生效） */
export interface SessionUpdateKnowledgeBasesParams {
  id: string
  knowledgeBases: string[]
}

/** IPC: 会话权限表（形状与规则见 chat-protocol 的 sessionAcl.ts） */
export type {
  AclEntry,
  SessionAclGrantParams,
  SessionAclRemoveParams,
  SessionAclSetAccessParams
} from '@shuvix/chat-protocol/sessionAcl'
