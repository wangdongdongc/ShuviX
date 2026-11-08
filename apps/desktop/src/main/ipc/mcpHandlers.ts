import { isAbsolute } from 'node:path'
import { isReservedMcpServerName } from '@shuvix/chat-protocol/widgetServers'
import { defineHandler } from './registry'
import { v7 as uuidv7 } from 'uuid'
import { mcpService } from '../services/mcpService'
import { mcpDao, type McpMetadataPatch } from '../dao/mcpDao'
import type { McpServerAddParams, McpServerUpdateParams, McpServerInfo } from '../types'

/**
 * 设置页填的工作目录 → 存进 metadata 的值（`''` = 不设）。相对路径直接拒：没有一个基准目录可以拿来解析它
 * （ShuviX 自己的工作目录随启动方式变，打包后是 `/`），存下来只会在某一次启动时指向一个意想不到的地方。
 */
function cwdOf(raw: string): { cwd: string } | { error: string } {
  const cwd = raw.trim()
  if (cwd && !isAbsolute(cwd)) {
    return { error: `The working directory must be an absolute path, got "${cwd}"` }
  }
  return { cwd }
}

/**
 * MCP Server 管理 IPC 处理器
 */
export function registerMcpHandlers(): void {
  /** 列出所有 MCP Server（含运行时状态） */
  defineHandler('mcp:list', (): McpServerInfo[] => {
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

  /**
   * 名字是工具名前缀（`mcp__<name>__<tool>`）：必须唯一（表上有 UNIQUE，但让它抛出来的是一条
   * 生 SQLite 错误），也不能含 `__` —— 那会让工具名的拼接有两种读法，还能让一台自定义 server
   * 的工具以 `mcp__browser__` 开头、冒充内置浏览器。
   */
  const nameProblem = (name: string, selfId?: string): string | undefined => {
    const trimmed = name.trim()
    if (!trimmed) return 'An MCP server needs a name'
    if (trimmed.includes('__')) return `An MCP server name cannot contain "__"`
    if (isReservedMcpServerName(trimmed))
      return `Names starting with "widget-" are kept for widgets`
    const taken = mcpDao.findAll().some((s) => s.name === trimmed && s.id !== selfId)
    return taken ? `An MCP server named "${trimmed}" already exists` : undefined
  }

  /** 添加 MCP Server（不连接 —— 惰性启动，等哪条会话用到它再连） */
  defineHandler('mcp:add', (ctx, params: McpServerAddParams) => {
    const problem = nameProblem(params.name)
    if (problem) return { success: false, error: problem }
    const dir = cwdOf(params.cwd ?? '')
    if ('error' in dir) return { success: false, error: dir.error }
    const now = Date.now()
    const server = {
      id: uuidv7(),
      // 与 nameProblem 查的是同一个写法：带空格存进去，查重时就对不上了
      name: params.name.trim(),
      type: params.type,
      command: params.command ?? '',
      args: JSON.stringify(params.args ?? []),
      env: JSON.stringify(params.env ?? {}),
      url: params.url ?? '',
      headers: JSON.stringify(params.headers ?? {}),
      metadata: JSON.stringify({
        ...(dir.cwd ? { cwd: dir.cwd } : {}),
        // agent 经 `shuvix` 工具加的：记下是哪条会话、什么时候（只是信息，设置页据此说明这一台的来历）
        ...(ctx.client.kind === 'agent'
          ? { addedBy: { sessionId: ctx.client.sessionId, at: now } }
          : {})
      }),
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
  defineHandler('mcp:update', async (_ctx, params: McpServerUpdateParams) => {
    const existing = mcpDao.pick(params.id, ['isBuiltin', 'type', 'url'])
    const isBuiltin = existing?.isBuiltin === 1

    const fields: Record<string, unknown> = {}
    /** metadata 只并要改的键（DAO 合并）：别人写的键（记住的 transport、addedBy……）不能被设置页抹掉 */
    const metadata: McpMetadataPatch = {}
    // 内置 server: 仅允许修改 env / isEnabled / headers；其余字段（含工作目录）忽略
    if (!isBuiltin) {
      if (params.name !== undefined) {
        const problem = nameProblem(params.name, params.id)
        if (problem) return { success: false, error: problem }
        fields.name = params.name.trim()
      }
      if (params.cwd !== undefined) {
        const dir = cwdOf(params.cwd)
        if ('error' in dir) return { success: false, error: dir.error }
        metadata.cwd = dir.cwd || undefined
      }
      if (params.type !== undefined) fields.type = params.type
      if (params.command !== undefined) fields.command = params.command
      if (params.args !== undefined) fields.args = JSON.stringify(params.args)
      if (params.url !== undefined) fields.url = params.url
      // 换了地址或类型，记住的「这台走旧版 SSE」就不再是这台的了：清掉，下次重新先试 Streamable HTTP
      const moved =
        (params.url !== undefined && params.url !== existing?.url) ||
        (params.type !== undefined && params.type !== existing?.type)
      if (moved) metadata.transport = undefined
    }
    if (params.env !== undefined) fields.env = JSON.stringify(params.env)
    if (params.headers !== undefined) fields.headers = JSON.stringify(params.headers)
    if (params.isEnabled !== undefined) fields.isEnabled = params.isEnabled ? 1 : 0
    if (Object.keys(metadata).length > 0) fields.metadata = metadata

    mcpDao.update(params.id, fields)

    // 配置变更只断开：旧连接按旧配置建的，留着就错了；新配置等下次用到时自然连上
    await mcpService.disconnect(params.id)

    return { success: true }
  })

  /** 删除 MCP Server（内置 server 不可删除） */
  defineHandler('mcp:delete', async (_ctx, id: string) => {
    const existing = mcpDao.pick(id, ['isBuiltin', 'name'])
    if (existing?.isBuiltin === 1) {
      return { success: false, error: `Built-in MCP server "${existing.name}" cannot be deleted` }
    }
    await mcpService.disconnect(id)
    mcpDao.deleteById(id)
    return { success: true }
  })

  /** 手动连接（设置页的连接/重连按钮）—— 不设超时：用户在旁边等着，首次冷启动慢是可以等的 */
  defineHandler('mcp:connect', async (_ctx, id: string) => {
    const { ok, error } = await mcpService.connect(id)
    return { success: ok, error }
  })

  /** 手动断开 */
  defineHandler('mcp:disconnect', async (_ctx, id: string) => {
    await mcpService.disconnect(id)
    return { success: true }
  })

  /** 获取指定 server 已发现的工具列表 */
  defineHandler('mcp:getTools', (_ctx, id: string) => {
    return mcpService.getServerToolInfos(id)
  })
}
