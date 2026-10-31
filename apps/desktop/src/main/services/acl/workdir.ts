/**
 * 一条会话的工作目录 —— 只读会话行与项目行，不经 sessionService（会话权限表在 sessionService 之下，
 * 直接引它会成环）。口径与 sessionService 的 workingDirectoryOf / toolContext 的 resolveProjectConfig
 * 同一个：属于项目（或 bot 会话引用的工作项目，chat-protocol `projectContextIdOf`）= 项目根；否则会话自带的
 * 工作目录（从系统打开的 md 窗口、fork 与临时会话的子会话共用的临时工作区、工作项目被删后的路径快照），
 * 再否则本会话的临时工作区。
 *
 * 只算路径、**不建目录**（getTempWorkspace 缺省会建，这里传 `create: false`）：权限表在建会话时就对账，临时工作区要等第一次真用到才建 ——
 * 从没用过的会话删除时不该留下一个空目录。
 */
import { projectContextIdOf } from '@shuvix/chat-protocol/botSession'
import { projectDao } from '../../dao/projectDao'
import { getTempWorkspace } from '../../utils/paths'
import { sessionRecords } from '../sessionRecords'

export function sessionWorkingDirectory(sessionId: string): string {
  const row = sessionRecords.pick(sessionId, ['projectId', 'settings'])
  const projectId = projectContextIdOf(row)
  const projectPath = projectId ? projectDao.pick(projectId, ['path'])?.path : undefined
  return (
    projectPath || row?.settings?.workingDirectory || getTempWorkspace(sessionId, { create: false })
  )
}
