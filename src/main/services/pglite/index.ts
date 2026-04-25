/**
 * PGLite 模块入口
 *
 * - PgliteTool (name='postgres') 在模块 load 时通过 registerBuiltinTool 自注册
 * - 导出 destroySqlSession / disposePglite / getSqlRuntimeStatus 给上层（gateway, IPC, 主进程 lifecycle）调用
 */

import './pgliteTool'
import { pgliteWorkerManager } from './workerManager'
import { setSqlRuntimeDestroyed, getSqlRuntimeStatus } from './runtimeStatus'

/** 销毁指定 session 的 SQL worker + 广播运行时销毁事件 */
export function destroySqlSession(sessionId: string): void {
  if (!pgliteWorkerManager.isActive(sessionId)) return
  pgliteWorkerManager.terminate(sessionId)
  setSqlRuntimeDestroyed(sessionId)
}

/** 终止所有 SQL worker（应用退出时调用） */
export function disposePglite(): void {
  pgliteWorkerManager.terminateAll()
}

export { getSqlRuntimeStatus }
