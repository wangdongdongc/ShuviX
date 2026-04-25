/**
 * Pyodide 模块入口
 *
 * - PyodideTool (name='python') 在模块 load 时通过 registerBuiltinTool 自注册
 * - 导出 destroyPythonSession / disposePyodide / getPythonRuntimeStatus 给上层调用
 */

import './pyodideTool'
import { pyodideWorkerManager } from './workerManager'
import { setPythonRuntimeDestroyed, getPythonRuntimeStatus } from './runtimeStatus'

/** 销毁指定 session 的 Python worker + 广播运行时销毁事件 */
export function destroyPythonSession(sessionId: string): void {
  if (!pyodideWorkerManager.isActive(sessionId)) return
  pyodideWorkerManager.terminate(sessionId)
  setPythonRuntimeDestroyed(sessionId)
}

/** 终止所有 Python worker（应用退出时调用） */
export function disposePyodide(): void {
  pyodideWorkerManager.terminateAll()
}

export { getPythonRuntimeStatus }
