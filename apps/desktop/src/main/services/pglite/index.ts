/**
 * Pglite 模块入口
 *
 * 唯一消费者是 widget 共享库（services/widget/widgetDb.ts 直接用 workerManager）。
 * 模块层只提供应用退出钩子。
 */

import { pgliteWorkerManager } from './workerManager'

/** 终止所有 SQL worker（应用退出时调用） */
export function disposePglite(): void {
  pgliteWorkerManager.terminateAll()
}
