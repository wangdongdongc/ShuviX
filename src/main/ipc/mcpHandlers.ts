import { ipcMain } from 'electron'
import { v7 as uuidv7 } from 'uuid'
import { mcpService } from '../services/mcpService'
import { mcpDao } from '../dao/mcpDao'
import type { McpServerAddParams, McpServerUpdateParams, McpServerInfo } from '../types'

/**
 * MCP Server 管理 IPC 处理器
 */
export function registerMcpHandlers(): void {
  /** 列出所有 MCP Server（含运行时状态） */
  ipcMain.handle('mcp:list', (): McpServerInfo[] => {
    const servers = mcpDao.findAll()
    return servers.map((s) => ({
      ...s,
      status: mcpService.getStatus(s.id),
      error: mcpService.getError(s.id),
      toolCount: mcpService.getServerTools(s.id).length
    }))
  })

  /** 添加 MCP Server */
  ipcMain.handle('mcp:add', async (_event, params: McpServerAddParams) => {
    const now = Date.now()
    const server = {
      id: uuidv7(),
      name: params.name,
      type: params.type,
      command: params.command ?? '',
      args: JSON.stringify(params.args ?? []),
      env: JSON.stringify(params.env ?? {}),
      url: params.url ?? '',
      headers: JSON.stringify(params.headers ?? {}),
      isEnabled: 1,
      createdAt: now,
      updatedAt: now
    }
    mcpDao.insert(server)

    // 自动连接
    await mcpService.connect(server.id)

    return { success: true, id: server.id }
  })

  /** 更新 MCP Server 配置 */
  ipcMain.handle('mcp:update', async (_event, params: McpServerUpdateParams) => {
    const fields: Record<string, unknown> = {}
    if (params.name !== undefined) fields.name = params.name
    if (params.type !== undefined) fields.type = params.type
    if (params.command !== undefined) fields.command = params.command
    if (params.args !== undefined) fields.args = JSON.stringify(params.args)
    if (params.env !== undefined) fields.env = JSON.stringify(params.env)
    if (params.url !== undefined) fields.url = params.url
    if (params.headers !== undefined) fields.headers = JSON.stringify(params.headers)
    if (params.isEnabled !== undefined) fields.isEnabled = params.isEnabled ? 1 : 0

    mcpDao.update(params.id, fields)

    // 配置变更后重连
    const server = mcpDao.findById(params.id)
    if (server && server.isEnabled) {
      await mcpService.disconnect(params.id)
      await mcpService.connect(params.id)
    } else {
      await mcpService.disconnect(params.id)
    }

    return { success: true }
  })

  /** 删除 MCP Server */
  ipcMain.handle('mcp:delete', async (_event, id: string) => {
    await mcpService.disconnect(id)
    mcpDao.deleteById(id)
    return { success: true }
  })

  /** 手动连接 */
  ipcMain.handle('mcp:connect', async (_event, id: string) => {
    await mcpService.connect(id)
    return { success: true }
  })

  /** 手动断开 */
  ipcMain.handle('mcp:disconnect', async (_event, id: string) => {
    await mcpService.disconnect(id)
    return { success: true }
  })

  /** 获取指定 server 已发现的工具列表 */
  ipcMain.handle('mcp:getTools', (_event, id: string) => {
    return mcpService.getServerToolInfos(id)
  })
}
