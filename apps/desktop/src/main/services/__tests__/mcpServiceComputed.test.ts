/**
 * mcpService 的 store = 配置行 + 算出来的行（组件，一个组件一台，见 builtinMcp/widgetMcpServer.ts）。设置页和配置分享直接读 mcpDao，
 * 只看得到前者；连接、可用性、tool_search 走 McpManager，两样都看得到。工厂同样按名字现算（builtinMcpRegistry.setResolver）。
 *
 *   MSC-1 没注册算出来的行 = 没有（不抛）；注册了：findEnabled / findAll 接在配置行后面，findById 找不到配置行时问它
 *   MSC-2 算出来的行没了（归档）：不再可用；回来（恢复）就又可用
 *   MSC-3 连接：经解析器造实例（按会话一份），真的 tools/list；updateCachedTools 对它是无害的空写
 *   MSC-4 retireServer 配合算出来的行：之后的调用重连并重新列；行没了就报没连上
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { McpServer } from '@shuvix/chat-protocol/types/mcp'

const mocks = vi.hoisted(() => ({
  rows: [] as unknown[],
  updateCachedTools: vi.fn()
}))

vi.mock('../../dao/mcpDao', () => ({
  mcpDao: {
    findById: (id: string) => (mocks.rows as Array<{ id: string }>).find((r) => r.id === id),
    findEnabled: () => mocks.rows,
    findAll: () => mocks.rows,
    updateCachedTools: mocks.updateCachedTools
  }
}))
vi.mock('../builtinMcp', () => ({ BUILTIN_MCP_FACTORIES: {} }))
vi.mock('../userInputBroker', () => ({ requestUserInputFor: vi.fn() }))
vi.mock('../../frontend/core/ChatFrontendRegistry', () => ({
  chatFrontendRegistry: { broadcast: vi.fn() }
}))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('../../utils/paths', () => ({ buildSpawnEnv: vi.fn(() => ({})) }))

import { builtinMcpRegistry, mcpService, setComputedMcpServers } from '../mcpService'

function row(patch: Partial<McpServer> & { id: string; name: string }): McpServer {
  return {
    type: 'stdio',
    command: 'npx',
    args: '[]',
    env: '{}',
    url: '',
    headers: '{}',
    metadata: '{}',
    isEnabled: 1,
    isBuiltin: 0,
    cachedTools: '[]',
    createdAt: 0,
    updatedAt: 0,
    ...patch
  }
}

const DB_ROW = row({ id: 'u1', name: 'mine' })
const WIDGET_ROW = row({
  id: 'widget-server:a-b',
  name: 'widget-a-b',
  type: 'inproc',
  isBuiltin: 1,
  command: '',
  cachedTools: JSON.stringify([{ name: 'listBooks' }])
})

let computed: McpServer[] = []
let listed: string[] = []

beforeEach(() => {
  mocks.rows = [DB_ROW]
  mocks.updateCachedTools.mockReset()
  computed = [WIDGET_ROW]
  listed = ['listBooks']
  setComputedMcpServers(() => computed)
  builtinMcpRegistry.setResolver((name) =>
    name !== 'widget-a-b'
      ? undefined
      : async (_scope, transport) => {
          const server = new Server({ name, version: '1' }, { capabilities: { tools: {} } })
          server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: listed.map((tool) => ({ name: tool, inputSchema: { type: 'object' as const } }))
          }))
          server.setRequestHandler(CallToolRequestSchema, async (request) => ({
            content: [{ type: 'text' as const, text: `ran ${request.params.name}` }]
          }))
          await server.connect(transport)
        }
  )
})

afterEach(async () => {
  await mcpService.disconnectAll()
  setComputedMcpServers(() => [])
  builtinMcpRegistry.setResolver(() => undefined)
})

describe('mcpService 算出来的行', () => {
  it('MSC-1 没注册 = 没有，不抛', () => {
    setComputedMcpServers(() => [])
    expect(mcpService.getEnabledToolNames()).toEqual(['mcp:mine'])
    expect(mcpService.getServerToolInfos('widget-server:a-b')).toEqual([])
  })

  it('MSC-1 findEnabled / findAll：配置行在前；findById 找不到配置行时问它', () => {
    expect(mcpService.getEnabledToolNames()).toEqual(['mcp:mine', 'mcp:widget-a-b'])
    expect(mcpService.configuredServers().map((s) => s.name)).toEqual(['mine', 'widget-a-b'])
    expect(mcpService.getAllToolInfos().map((info) => info.group)).toEqual([
      'mcp:mine',
      'mcp:widget-a-b'
    ])
    expect(mcpService.getServerToolInfos('widget-server:a-b').map((t) => t.name)).toEqual([
      'mcp__widget-a-b__listBooks'
    ])
  })

  it('MSC-2 行没了（归档）就不可用；回来就又可用', () => {
    computed = []
    expect(mcpService.getEnabledToolNames()).toEqual(['mcp:mine'])
    computed = [WIDGET_ROW]
    expect(mcpService.getEnabledToolNames()).toContain('mcp:widget-a-b')
  })

  it('MSC-3 连接：经解析器造实例，真的 tools/list，按会话一份；对配置表的写是无害的空写', async () => {
    await expect(mcpService.ensureServerByName('widget-a-b', { sessionId: 's1' })).resolves.toEqual(
      { ok: true }
    )
    expect(mcpService.declarationsOf('widget-a-b', 's1').map((d) => d.name)).toEqual(['listBooks'])
    expect(mcpService.declarationsOf('widget-a-b', 's2')).toEqual([])
    expect(mcpService.getStatus('widget-server:a-b', 's1')).toBe('connected')
    expect(mocks.updateCachedTools).toHaveBeenCalledWith('widget-server:a-b', expect.any(String))
    // 声明可信：调用归属和读写提示靠这一位
    expect(mcpService.declarationsOf('widget-a-b', 's1')[0].trusted).toBe(true)
  })

  it('MSC-4 retireServer 之后：下一次调用重连并重新列', async () => {
    await mcpService.ensureServerByName('widget-a-b', { sessionId: 's1' })
    listed = ['listBooks', 'fresh']

    mcpService.retireServer('widget-server:a-b')
    const result = await mcpService.callTool('widget-server:a-b#s1', 'listBooks', {})

    expect(result.content).toEqual([{ type: 'text', text: 'ran listBooks' }])
    expect(mcpService.declarationsOf('widget-a-b', 's1').map((d) => d.name)).toEqual([
      'listBooks',
      'fresh'
    ])
  })

  it('MSC-4 行没了再退役（归档 / 删除）：调用报没连上，不再造实例', async () => {
    await mcpService.ensureServerByName('widget-a-b', { sessionId: 's1' })
    computed = []
    mcpService.retireServer('widget-server:a-b')

    await expect(mcpService.callTool('widget-server:a-b#s1', 'listBooks', {})).rejects.toThrow(
      'is not connected'
    )
  })
})
