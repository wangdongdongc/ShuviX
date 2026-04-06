import { ipcMain } from 'electron'
import { mcpServerService } from '../services/mcpServerService'
import { mcpServerLogDao } from '../dao/mcpServerLogDao'
import { settingsDao } from '../dao/settingsDao'
import type { McpHostConfig, McpHostFeature } from '../types'

/** 从 settings 构建 MCP Server 配置（enabled 不持久化，始终由用户手动启动） */
function buildConfig(): McpHostConfig {
  return {
    enabled: true,
    transport: 'http',
    port: Number(settingsDao.findByKey('mcpServer.port')) || 3399,
    features: {
      database: settingsDao.findByKey('mcpServer.features.database') === 'true',
      ssh: settingsDao.findByKey('mcpServer.features.ssh') === 'true'
    }
  }
}

/**
 * MCP Server（ShuviX 对外服务）IPC 处理器
 */
export function registerMcpServerHandlers(): void {
  /** 获取 MCP Server 状态 */
  ipcMain.handle('mcpServer:getStatus', () => {
    return mcpServerService.getStatus()
  })

  /** 启动 MCP Server */
  ipcMain.handle('mcpServer:start', async () => {
    const config = buildConfig()
    await mcpServerService.start(config)
    return mcpServerService.getStatus()
  })

  /** 停止 MCP Server */
  ipcMain.handle('mcpServer:stop', async () => {
    await mcpServerService.stop()
    return mcpServerService.getStatus()
  })

  /** 获取已注册的工具列表 */
  ipcMain.handle('mcpServer:getTools', () => {
    return mcpServerService.getRegisteredTools()
  })

  /** 动态启用功能 */
  ipcMain.handle('mcpServer:enableFeature', (_event, feature: McpHostFeature) => {
    mcpServerService.enableFeature(feature)
    settingsDao.upsert(`mcpServer.features.${feature}`, 'true')
    return mcpServerService.getStatus()
  })

  /** 动态禁用功能 */
  ipcMain.handle('mcpServer:disableFeature', (_event, feature: McpHostFeature) => {
    mcpServerService.disableFeature(feature)
    settingsDao.upsert(`mcpServer.features.${feature}`, 'false')
    return mcpServerService.getStatus()
  })

  /** 列出 MCP Server 日志 */
  ipcMain.handle(
    'mcpServer:listLogs',
    (_event, params?: { clientName?: string; toolName?: string; limit?: number }) => {
      return mcpServerLogDao.list(params)
    }
  )

  /** 获取日志详情 */
  ipcMain.handle('mcpServer:getLog', (_event, id: string) => {
    return mcpServerLogDao.getById(id)
  })

  /** 清空日志 */
  ipcMain.handle('mcpServer:clearLogs', () => {
    mcpServerLogDao.clear()
  })
}
