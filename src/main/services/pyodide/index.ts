/**
 * Pyodide 模块入口
 *
 * `python` 已从内置 tool 降级为 skill + `shuvix python` CLI 形态。
 * 模块层只暴露 worker 生命周期管理给 cliServer 用，并提供应用退出钩子。
 */

import { pyodideWorkerManager } from './workerManager'

/** 终止所有 Python worker（应用退出时调用） */
export function disposePyodide(): void {
  pyodideWorkerManager.terminateAll()
}
