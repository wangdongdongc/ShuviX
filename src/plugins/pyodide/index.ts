/**
 * Pyodide 插件 — 提供基于 Pyodide WASM 的 Python 运行时
 */

import type { ShuviXPlugin, PluginContext, PluginContribution, HostEvent } from '../../plugin-api'
import { PyodideTool } from './pyodideTool'
import { PyodideWorkerManager } from './workerManager'

let workerManager: PyodideWorkerManager | null = null

const pyodidePlugin: ShuviXPlugin = {
  id: 'pyodide',
  name: 'Pyodide Python',
  version: '1.0.0',

  activate(ctx: PluginContext): PluginContribution {
    workerManager = new PyodideWorkerManager(ctx)
    const tool = new PyodideTool(ctx, workerManager)

    return {
      tools: [tool],
      onEvent(event: HostEvent): void {
        if (event.type === 'runtime:destroy' && event.runtimeId === 'python') {
          tool.destroySession(event.sessionId)
        }
      }
    }
  },

  deactivate(): void {
    workerManager?.terminateAll()
    workerManager = null
  }
}

export default pyodidePlugin
