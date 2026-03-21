/**
 * PluginContextFactory — 为插件构造 PluginContext
 *
 * 将主程序内部实现注入到 PluginContext 接口中，
 * 使插件无需直接依赖 Electron、DAO 或主程序服务。
 */

import { join, resolve } from 'path'
import { app } from 'electron'
import type { PluginContext } from '../../plugin-api/types'
import type { PluginEvent } from '../../plugin-api/events'
import { resolveProjectConfig } from '../tools/types'
import { chatFrontendRegistry } from '../frontend/core/ChatFrontendRegistry'
import { createLogger } from '../logger'

/**
 * 创建指定插件的 PluginContext（全局唯一，不绑定特定 session）
 */
export function createPluginContext(pluginId: string): PluginContext {
  const logger = createLogger(`plugin:${pluginId}`)

  return {
    getWorkingDirectory(sessionId: string): string {
      return resolveProjectConfig(sessionId).workingDirectory
    },

    emitEvent(sessionId: string, event: PluginEvent): void {
      logger.info(`PluginEvent → main: ${event.type}`, event)
      switch (event.type) {
        case 'plugin:panel_open':
          chatFrontendRegistry.broadcast({
            type: 'preview_event' as const,
            sessionId,
            action: 'open' as const,
            url: event.url,
            title: event.title
          })
          break
        case 'plugin:panel_close':
          chatFrontendRegistry.broadcast({
            type: 'preview_event' as const,
            sessionId,
            action: 'close' as const
          })
          break
      }
    },

    getResourcePath(relativePath: string): string {
      const base = app.isPackaged
        ? join(process.resourcesPath, 'plugins', pluginId)
        : resolve(__dirname, '../../resources/plugins', pluginId)
      return join(base, relativePath)
    },

    logger
  }
}
