/**
 * mcpService 的 transport 工厂 —— 桌面注入给共享 McpManager 的唯一宿主差异（另一处是 store）。
 *
 * 钉三件事：
 *  - stdio 走桌面自己的 McpStdioTransport（stderr 留尾、进程组整组收掉），环境经 buildSpawnEnv 补齐，
 *    而且**造它不起进程** —— 进程在 McpManager 握手时的 start() 里才起，超时 / 断开才收得到它；
 *  - http 只有 Streamable HTTP：曾经的「构造失败回退 SSE」从来走不到（构造函数不会因网络失败而抛），
 *    已删掉，不该悄悄回来；
 *  - 不认识的类型、没有会话的内置服务器直接抛，而不是造出一个半成品。
 *
 * 工厂是模块私有的，只经单例 McpManager 的私有字段取得到（白盒）；import 图里的 DB / 内置服务器 /
 * 日志一律换成假件，只留 agent-runtime 与 SDK 是真的。
 */
import { describe, expect, it, vi } from 'vitest'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { McpServer } from '@shuvix/chat-protocol/types/mcp'
import type { BuiltinMcpScope } from '@shuvix/agent-runtime'
import { McpStdioTransport } from '../../utils/mcpStdioTransport'
import { mcpService } from '../mcpService'

const mocks = vi.hoisted(() => ({
  buildSpawnEnv: vi.fn((extra?: Record<string, string>) => ({ PATH: '/usr/bin', ...extra }))
}))

vi.mock('../../dao/mcpDao', () => ({ mcpDao: {} }))
vi.mock('../builtinMcp', () => ({ BUILTIN_MCP_FACTORIES: {} }))
vi.mock('../userInputBroker', () => ({ requestUserInputFor: vi.fn() }))
vi.mock('../../frontend/core/ChatFrontendRegistry', () => ({
  chatFrontendRegistry: { broadcast: vi.fn() }
}))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('../../utils/paths', () => ({ buildSpawnEnv: mocks.buildSpawnEnv }))

type CreateTransport = (
  server: McpServer,
  scope?: BuiltinMcpScope
) => Transport | Promise<Transport>
const createTransport = (mcpService as unknown as { createTransport: CreateTransport })
  .createTransport

function row(patch: Partial<McpServer>): McpServer {
  return {
    id: 'x-id',
    name: 'x',
    type: 'http',
    command: '',
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

describe('mcpService.createTransport', () => {
  it('MCPS-U-11: 拿得到单例 McpManager 里的那个工厂（白盒前提）', () => {
    expect(typeof createTransport).toBe('function')
  })

  it('MCPS-U-11: http 行 → Streamable HTTP transport，不是旧版 SSE', () => {
    const t = createTransport(
      row({ type: 'http', url: 'https://mcp.example.test/mcp', headers: '{"X-Api-Key":"k"}' })
    )
    expect(t).toBeInstanceOf(StreamableHTTPClientTransport)
    expect(t).not.toBeInstanceOf(SSEClientTransport)
  })

  it('MCPS-U-11: stdio 行 → McpStdioTransport；造它不起进程，环境经 buildSpawnEnv 补齐', () => {
    const t = createTransport(
      row({ type: 'stdio', command: process.execPath, args: '["-e","0"]', env: '{"FOO":"1"}' })
    )
    expect(t).toBeInstanceOf(McpStdioTransport)
    const stdio = t as McpStdioTransport
    // 进程在握手的 start() 里才起：此刻就起了的话，连接超时 / 被断开时收不到它
    expect(stdio.pid).toBeUndefined()
    // McpManager 靠这个方法把进程临死前的 stderr 拼进报错
    expect(typeof stdio.stderrTail).toBe('function')
    expect(mocks.buildSpawnEnv).toHaveBeenCalledWith({ FOO: '1' })
  })

  it('MCPS-U-11: 不认识的类型直接抛', () => {
    expect(() => createTransport(row({ type: 'bogus' as unknown as McpServer['type'] }))).toThrow(
      /不支持的 MCP transport 类型/
    )
  })

  it('MCPS-U-11: 内置服务器（inproc）没有会话上下文直接抛', () => {
    expect(() =>
      createTransport(row({ id: 'builtin-mcp-ssh', name: 'ssh', type: 'inproc', isBuiltin: 1 }))
    ).toThrow(/需要会话上下文/)
  })
})
