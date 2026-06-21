/**
 * 临时会话的 OPFS 工作目录 —— 镜像桌面 getTempWorkspace(sessionId)。
 *
 * 桌面临时会话的工作目录是 userData/temp_workspace/{sessionId}（Node fs），删除会话时清理。
 * 浏览器用 OPFS（Origin Private File System，源私有、沙箱、可按路径读写）等价实现：
 * navigator.storage.getDirectory() → sessions/{sessionId}/。每个会话独立隔离。
 *
 * 返回的 FileSystemDirectoryHandle 与用户 FSA 文件夹是同一类型，createFsaPort 可原样消费。
 */

/** OPFS 临时工作目录的父目录名 */
const SESSIONS_DIR = 'sessions'

/** 取（或惰性创建）某临时会话的 OPFS 工作目录句柄 */
export async function getTempWorkspaceHandle(
  sessionId: string
): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory()
  const sessions = await root.getDirectoryHandle(SESSIONS_DIR, { create: true })
  return sessions.getDirectoryHandle(sessionId, { create: true })
}

/** 删除某临时会话的 OPFS 工作目录（会话删除时调用；幂等、best-effort） */
export async function deleteTempWorkspace(sessionId: string): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory()
    const sessions = await root.getDirectoryHandle(SESSIONS_DIR, { create: true })
    await sessions.removeEntry(sessionId, { recursive: true })
  } catch {
    /* 目录可能从未创建 / 已删除，忽略 */
  }
}
