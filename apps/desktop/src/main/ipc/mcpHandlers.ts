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
    return servers.map((s) => {
      // 工具数取 cachedTools（上次连上时发现的）：惰性启动下多数服务器此刻并没有连接，
      // 按活连接数算会让设置页上的每台都显示 0 个工具
      let toolCount = 0
      try {
        toolCount = JSON.parse(s.cachedTools || '[]').length
      } catch {
        /* 缓存坏了就当没有 */
      }
      return {
        ...s,
        status: mcpService.getStatus(s.id),
        error: mcpService.getError(s.id),
        toolCount
      }
    })
  })

  /** 添加 MCP Server（不连接 —— 惰性启动，等哪条会话用到它再连） */
  ipcMain.handle('mcp:add', (_event, params: McpServerAddParams) => {
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
      metadata: '{}',
      isEnabled: 1,
      isBuiltin: 0,
      cachedTools: '[]',
      createdAt: now,
      updatedAt: now
    }
    mcpDao.insert(server)

    return { success: true, id: server.id }
  })

  /** 更新 MCP Server 配置 */
  ipcMain.handle('mcp:update', async (_event, params: McpServerUpdateParams) => {
    const existing = mcpDao.pick(params.id, ['isBuiltin'])
    const isBuiltin = existing?.isBuiltin === 1

    const fields: Record<string, unknown> = {}
    // 内置 server: 仅允许修改 env / isEnabled / headers；其余字段忽略
    if (!isBuiltin) {
      if (params.name !== undefined) fields.name = params.name
      if (params.type !== undefined) fields.type = params.type
      if (params.command !== undefined) fields.command = params.command
      if (params.args !== undefined) fields.args = JSON.stringify(params.args)
      if (params.url !== undefined) fields.url = params.url
    }
    if (params.env !== undefined) fields.env = JSON.stringify(params.env)
    if (params.headers !== undefined) fields.headers = JSON.stringify(params.headers)
    if (params.isEnabled !== undefined) fields.isEnabled = params.isEnabled ? 1 : 0

    mcpDao.update(params.id, fields)

    // 配置变更只断开：旧连接按旧配置建的，留着就错了；新配置等下次用到时自然连上
    await mcpService.disconnect(params.id)

    return { success: true }
  })

  /** 删除 MCP Server（内置 server 不可删除） */
  ipcMain.handle('mcp:delete', async (_event, id: string) => {
    const existing = mcpDao.pick(id, ['isBuiltin', 'name'])
    if (existing?.isBuiltin === 1) {
      return { success: false, error: `Built-in MCP server "${existing.name}" cannot be deleted` }
    }
    await mcpService.disconnect(id)
    mcpDao.deleteById(id)
    return { success: true }
  })

  /** 手动连接（设置页的连接/重连按钮）—— 不设超时：用户在旁边等着，首次冷启动慢是可以等的 */
  ipcMain.handle('mcp:connect', async (_event, id: string) => {
    const { ok, error } = await mcpService.connect(id)
    return { success: ok, error }
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
