/**
 * PGLite 插件 — 提供基于 PGLite WASM 的 PostgreSQL 运行时
 */

import type { ShuviXPlugin, PluginContext, PluginContribution, HostEvent } from '../../plugin-api'
import { PgliteTool } from './pgliteTool'
import { PgliteWorkerManager } from './workerManager'

let workerManager: PgliteWorkerManager | null = null

const pglitePlugin: ShuviXPlugin = {
  id: 'pglite',
  name: 'PGLite SQL',
  version: '1.0.0',

  activate(ctx: PluginContext): PluginContribution {
    workerManager = new PgliteWorkerManager(ctx)
    const tool = new PgliteTool(ctx, workerManager)

    return {
      tools: [tool],
      purpose: {
        key: 'sql',
        icon: 'Database',
        labelKey: 'purposeSQL',
        tipKey: 'purposeTipSql',
        i18n: {
          zh: {
            purposeSQL: '数据分析',
            purposeTipSql:
              '在内置的 Postgres 数据库中运行 SQL。支持将项目文件夹中的 CSV 导入数据库，适合数据分析。'
          },
          en: {
            purposeSQL: 'Data Analysis',
            purposeTipSql:
              'Run SQL in the built-in Postgres database. Supports importing CSV files from the project folder, great for data analysis.'
          }
        },
        enabledTools: ['read', 'sql', 'ask']
      },
      onEvent(event: HostEvent): void {
        if (event.type === 'runtime:destroy' && event.runtimeId === 'sql') {
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

export default pglitePlugin
