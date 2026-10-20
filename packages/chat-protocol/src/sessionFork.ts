/**
 * 会话 fork（把一条会话复制成一条新会话，从整段对话或某条回复分支）—— 宿主与界面共用的契约。
 *
 * fork 是一条**新的普通会话**，放在源会话旁边（同一个项目或同样不属于任何项目；源会话是子会话时挂在同一个
 * 父会话下），带着源会话此刻的对话（或到那条回复为止），之后两条各走各的。源会话不受影响。源会话还没有对话
 * （从没发过消息）时 fork 就是一条抄了它设置的空会话。
 *
 * **工作目录共用**：项目会话的工作目录本来就是项目根；不属于项目的会话（临时会话）的 fork 与源会话共用
 * 同一个工作目录（用户 2026-10-20）—— 源会话的临时工作区，直到用它的最后一条会话被删才删。
 */
import { isChromeTabSessionSettings } from './chromeTabSession'
import { isHiddenProjectId } from './hiddenProjects'
import { capabilitiesOfStorageKind, storageKindOf } from './sessionStorageKind'

/** 判定 fork 资格要看的那几样（`Session` 的子集，宿主的行与界面的列表项都满足） */
export interface ForkableSessionShape {
  projectId: string | null
  /** 存储类型（缺省按旧格式理解，见 sessionStorageKind.ts） */
  storageKind?: string | null
  settings?: { notebookPath?: string; chromeTab?: unknown } | null
}

/**
 * 这条会话的形态能不能 fork：项目会话与临时会话（不属于任何项目）都给；承载笔记本的隐藏项目里的会话、
 * 笔记本会话、Chrome 标签页会话不给。
 *
 * 存储类型也在这里看：旧格式（只读）的会话不能 fork —— 拷贝要在源会话的运行时里取样，只读存储没有运行时。
 * 有没有内容、此刻忙不忙由宿主在执行时判（内存会话也由宿主拒绝）。
 */
export function isForkableSessionShape(session: ForkableSessionShape): boolean {
  if (isHiddenProjectId(session.projectId)) return false
  if (session.settings?.notebookPath) return false
  if (isChromeTabSessionSettings(session.settings)) return false
  return capabilitiesOfStorageKind(storageKindOf(session)).rollback
}

export interface SessionForkParams {
  /** 源会话 */
  sessionId: string
  /**
   * 从哪条回复分支：一条助手消息的 id（一张卡的最后一条），fork 带着到它为止、连同它的工具结果的对话。
   * 缺省 = 整段当前对话。
   */
  messageId?: string
}

/**
 * fork 被拒的原因（拒绝时什么都没建）：
 *  - `no_session`：源会话不存在；
 *  - `not_forkable`：形态不给（`isForkableSessionShape`，含旧格式只读的存储）；
 *  - `busy`：源会话此刻有工作在跑或被中断（停下之后再 fork）；
 *  - `invalid_target`：`messageId` 不是当前对话里看得见的一条助手消息；
 *  - `failed`：拷贝 / 打开时出错（已建的半成品已删掉）。
 */
export type SessionForkRefusal =
  | 'no_session'
  | 'not_forkable'
  | 'busy'
  | 'invalid_target'
  | 'failed'

export type SessionForkResult =
  | { success: true; sessionId: string }
  | { success: false; reason: SessionForkRefusal }
