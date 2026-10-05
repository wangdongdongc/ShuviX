/**
 * mcpService 的 transport 工厂 —— 桌面注入给共享 McpManager 的唯一宿主差异（另一处是 store）。
 *
 * 钉三件事：
 *  - stdio 走桌面自己的 McpStdioTransport（stderr 留尾、进程组整组收掉），环境经 buildSpawnEnv 补齐，
 *    而且**造它不起进程** —— 进程在 McpManager 握手时的 start() 里才起，超时 / 断开才收得到它；
 *  - http 只有 Streamable HTTP：曾经的「构造失败回退 SSE」从来走不到（构造函数不会因网络失败而抛），
 *    已删掉，不该悄悄回来；
 *  - 不认识的类型、没有会话的内置服务器直接抛，而不是造出一个半成品；
 *  - 内置服务器的 scope 带 `agentOf`（P2-07-50）：每次调用现问启动时注册的解析器
 *    （会话, 对话）→ 调用方 agent，不在建连时快照；没注册 = 认不出、不抛。
 *
 * 工厂是模块私有的，只经单例 McpManager 的私有字段取得到（白盒）；import 图里的 DB / 内置服务器 /
 * 日志一律换成假件，只留 agent-runtime 与 SDK 是真的。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { McpServer } from '@shuvix/chat-protocol/types/mcp'
import type { BuiltinMcpScope } from '@shuvix/agent-runtime'
import { McpStdioTransport } from '../../utils/mcpStdioTransport'
import { builtinMcpRegistry, mcpService, setBuiltinMcpAgentResolver } from '../mcpService'
import type { DesktopBuiltinMcpScope } from '../builtinMcp/types'

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

describe('P2-07-50 内置服务器的 scope：agentOf 每次现问注册着的解析器', () => {
  afterEach(() => {
    setBuiltinMcpAgentResolver(null)
    vi.restoreAllMocks()
  })

  /** 造一次 inproc transport，交回内置注册表收到的 scope */
  async function scopeOf(sessionId = 's1'): Promise<DesktopBuiltinMcpScope> {
    const spy = vi
      .spyOn(builtinMcpRegistry, 'createClientTransport')
      .mockResolvedValue({} as unknown as Transport)
    await createTransport(
      row({ id: 'builtin-mcp-ssh', name: 'ssh', type: 'inproc', isBuiltin: 1 }),
      { sessionId }
    )
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0]).toBe('ssh')
    return spy.mock.calls[0][1]
  }

  it('P2-07-50 scope 带 sessionId / requestUserInput / emitChatEvent / agentOf；agentOf(c) = 解析器(会话, c)', async () => {
    const WORK = { profileName: 'work', kind: 'root' as const }
    const r = vi.fn((_sid: string, c: number) => (c === 2 ? WORK : undefined))
    setBuiltinMcpAgentResolver(r)

    const scope = await scopeOf('s1')
    expect(scope.sessionId).toBe('s1')
    expect(scope.requestUserInput).toBeTypeOf('function')
    expect(scope.emitChatEvent).toBeTypeOf('function')
    expect(scope.agentOf).toBeTypeOf('function')
    // 建连时不问
    expect(r).not.toHaveBeenCalled()

    expect(scope.agentOf!(2)).toBe(WORK)
    expect(r).toHaveBeenCalledWith('s1', 2)
    expect(scope.agentOf!(7)).toBeUndefined()
  })

  it('P2-07-50 每次调用现问：解析器换了 / 答案变了，同一份 scope 交回新值', async () => {
    const first = { profileName: 'work', kind: 'root' as const }
    const second = { profileName: 'explore', kind: 'spawned' as const, callerId: 'sub-a1' }
    let answer: typeof first | typeof second = first
    setBuiltinMcpAgentResolver(() => answer)

    const scope = await scopeOf()
    expect(scope.agentOf!(2)).toBe(first)
    answer = second
    expect(scope.agentOf!(2)).toBe(second)

    const replaced = { profileName: 'bot', kind: 'root' as const }
    setBuiltinMcpAgentResolver(() => replaced)
    expect(scope.agentOf!(2)).toBe(replaced)
  })

  it('P2-07-50 没注册解析器 → agentOf 交回 undefined，不抛', async () => {
    setBuiltinMcpAgentResolver(null)
    const scope = await scopeOf()
    expect(() => scope.agentOf!(2)).not.toThrow()
    expect(scope.agentOf!(2)).toBeUndefined()
  })
})
