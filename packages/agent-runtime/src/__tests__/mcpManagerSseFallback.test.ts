/**
 * McpManager 的旧版 HTTP+SSE 回退 —— 规范向后兼容一节的做法：`type: 'http'` 先走 Streamable HTTP，
 * 握手被回 404/405 才换旧版 SSE 再试一次；走通了记进 metadata，下次直接走 SSE；记着 SSE 的被回
 * 404/405（或 400）就换回 Streamable HTTP 试一次，走通了把记忆清掉。
 *
 * 为什么用真 HTTP server：回退判据是 SDK 两种 transport 各自的错误类与状态码（StreamableHTTPError /
 * SseError 的 `code`），手写假 transport 只能证明「假件抛了我们以为它会抛的东西」。这里起一台本机
 * `node:http`，按用例给 POST / GET 指定答法，背后是 SDK 自己的 SSEServerTransport（旧版）与无状态的
 * StreamableHTTPServerTransport；客户端一侧是 SDK 的两种真 transport，由测试里的 createTransport
 * 照桌面宿主的样子造（`{ sse: true }` → SSEClientTransport）。
 *
 *   SSE-1  POST 404 → 换 SSE：连上、工具能调、记下 `transport: 'sse'`
 *   SSE-2  POST 405 → 同上
 *   SSE-3  401 / 403 不回退：报的就是原来那句，一个 GET 都不发，什么都不记
 *   SSE-4  网络错误（没人在听）不回退
 *   SSE-5  宿主没声明 legacySse：404 照原样报，不发 GET
 *   SSE-6  两种都不通：报头一种的错误，后面跟着 SSE 的
 *   SSE-7  记着 SSE：第一下就是 GET，一个 POST /mcp 都不发，不重复记
 *   SSE-8  记着 SSE、server 已换成 Streamable HTTP（GET 405 / 400）→ 换回去，记忆清掉
 *   SSE-9  记着 SSE、GET 401 → 不换回去，原样报，记忆不动
 *   SSE-10 宿主没声明 legacySse：记忆不算数，直接 Streamable HTTP
 *   SSE-11 换到 SSE 之后等不到（GET 一直悬着）→ 超时失败，那条 SSE 流被关掉，不留着
 *   SSE-12 记不下（store 抛）不让已经连上的这次失败
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { parseMcpServerMetadata, type McpServer } from '@shuvix/chat-protocol/types/mcp'
import { McpManager, type McpStore, type McpTransportOptions } from '../mcpManager'

// ─── 本机 HTTP server ────────────────────────────────────────────────────

/** 某一种请求怎么答：真的去服务、回一个状态码，或（GET）一直悬着不答 */
type Answer = 'serve' | 'hang' | number

interface FixtureServer {
  url: string
  /** 到达的请求（`POST /mcp`、`GET /mcp`、`POST /messages`），按先后 */
  hits: string[]
  /** 悬着的 GET 被客户端关掉了几条 */
  hungClosed: () => number
  close: () => Promise<void>
}

const ERROR_BODY: Record<number, string> = {
  400: 'Bad Request: No valid session ID provided',
  401: '{"error":"unauthorized"}',
  403: '{"error":"forbidden"}',
  404: 'Not Found',
  405: 'Method Not Allowed'
}

/** 一台只有 `ping` 的 MCP server；回执里带着自己走的是哪种 transport */
function fixtureMcp(via: string): Server {
  const server = new Server({ name: 'fixture', version: '0.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: 'ping', inputSchema: { type: 'object' as const, properties: {} } }]
  }))
  server.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [{ type: 'text' as const, text: `pong via ${via}` }]
  }))
  return server
}

function reject(res: http.ServerResponse, status: number): void {
  const headers: Record<string, string> = { 'content-type': 'text/plain' }
  if (status === 401) headers['www-authenticate'] = 'Bearer realm="fixture"'
  res.writeHead(status, headers).end(ERROR_BODY[status] ?? `HTTP ${status}`)
}

const servers: FixtureServer[] = []

/**
 * `/mcp`：POST 是 Streamable HTTP（无状态，每个请求一份 transport），GET 是旧版 SSE 的流
 * （`endpoint` 事件指向 `/messages?sessionId=…`）。各自按 `answers` 答。
 */
async function startServer(answers: { post: Answer; get: Answer }): Promise<FixtureServer> {
  const hits: string[] = []
  const sse = new Map<string, SSEServerTransport>()
  let hungClosed = 0
  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    hits.push(`${req.method} ${url.pathname}`)
    void (async () => {
      if (req.method === 'POST' && url.pathname === '/messages') {
        const transport = sse.get(url.searchParams.get('sessionId') ?? '')
        if (!transport) return reject(res, 404)
        return transport.handlePostMessage(req, res)
      }
      if (url.pathname !== '/mcp') return reject(res, 404)
      const answer = req.method === 'GET' ? answers.get : req.method === 'POST' ? answers.post : 405
      if (answer === 'hang') {
        res.on('close', () => hungClosed++)
        return
      }
      if (typeof answer === 'number') return reject(res, answer)
      if (req.method === 'GET') {
        const transport = new SSEServerTransport('/messages', res)
        sse.set(transport.sessionId, transport)
        res.on('close', () => sse.delete(transport.sessionId))
        return fixtureMcp('sse').connect(transport)
      }
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true
      })
      const mcp = fixtureMcp('streamable http')
      res.on('close', () => {
        void transport.close()
        void mcp.close()
      })
      await mcp.connect(transport)
      await transport.handleRequest(req, res)
    })().catch((err: unknown) => {
      if (!res.headersSent) res.writeHead(500)
      res.end(String(err))
    })
  })
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  const { port } = httpServer.address() as AddressInfo
  const fixture: FixtureServer = {
    url: `http://127.0.0.1:${port}/mcp`,
    hits,
    hungClosed: () => hungClosed,
    close: () =>
      new Promise<void>((resolve) => {
        httpServer.closeAllConnections()
        httpServer.close(() => resolve())
      })
  }
  servers.push(fixture)
  return fixture
}

// ─── 管理器 ──────────────────────────────────────────────────────────────

function row(url: string, metadata: Record<string, unknown> = {}): McpServer {
  return {
    id: 'remote-id',
    name: 'remote',
    type: 'http',
    command: '',
    args: '[]',
    env: '{}',
    url,
    headers: '{}',
    metadata: JSON.stringify(metadata),
    isEnabled: 1,
    isBuiltin: 0,
    cachedTools: '[]',
    createdAt: 0,
    updatedAt: 0
  }
}

interface Harness {
  mgr: McpManager
  rows: Map<string, McpServer>
  remember: Mock<(id: string, transport: 'sse' | undefined) => void>
  /** 每次造 transport 时要的是哪一种 */
  made: Array<'sse' | 'streamable'>
}

const managers: McpManager[] = []

function setup(
  server: McpServer,
  opts: { legacySse?: boolean; remember?: (id: string, t: 'sse' | undefined) => void } = {}
): Harness {
  const rows = new Map([[server.id, server]])
  // 与桌面 mcpDao.mergeMetadata 同一个口径：只并这一个键，别的键（cwd …）原样留着
  const remember = vi.fn(
    opts.remember ??
      ((id: string, transport: 'sse' | undefined) => {
        const r = rows.get(id)
        if (!r) return
        const next = { ...parseMcpServerMetadata(r.metadata) }
        if (transport) next.transport = transport
        else delete next.transport
        r.metadata = JSON.stringify(next)
      })
  )
  const store: McpStore = {
    findById: (id) => rows.get(id),
    findEnabled: () => [...rows.values()],
    findAll: () => [...rows.values()],
    updateCachedTools: () => {},
    rememberTransport: remember
  }
  const made: Harness['made'] = []
  // 照桌面宿主的样子造（mcpService.createTransport 的 http 分支）
  const createTransport = (
    s: McpServer,
    _scope?: unknown,
    transportOpts?: McpTransportOptions
  ): Transport => {
    made.push(transportOpts?.sse ? 'sse' : 'streamable')
    return transportOpts?.sse
      ? new SSEClientTransport(new URL(s.url))
      : new StreamableHTTPClientTransport(new URL(s.url))
  }
  const mgr = new McpManager({
    store,
    createTransport,
    legacySse: opts.legacySse ?? true
  })
  managers.push(mgr)
  return { mgr, rows, remember, made }
}

const metadataOf = (h: Harness): Record<string, unknown> =>
  parseMcpServerMetadata(h.rows.get('remote-id')!.metadata)

async function callPing(h: Harness): Promise<string> {
  const result = await h.mgr.callTool('remote-id', 'ping', {})
  return (result.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('')
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.disconnectAll()))
  await Promise.all(servers.splice(0).map((s) => s.close()))
})

// ─── 用例 ────────────────────────────────────────────────────────────────

describe('先 Streamable HTTP，被回 404/405 才换旧版 SSE', () => {
  it.each([404, 405])(
    'SSE-1/2 POST 回 %i → 换 SSE：连上、工具能调、记下 transport: sse（别的键留着）',
    async (status) => {
      const fixture = await startServer({ post: status, get: 'serve' })
      const h = setup(row(fixture.url, { cwd: '/kept' }))

      expect(await h.mgr.connect('remote-id')).toEqual({ ok: true })
      expect(h.mgr.getStatus('remote-id')).toBe('connected')
      expect(h.mgr.getError('remote-id')).toBeUndefined()
      expect(fixture.hits.slice(0, 2)).toEqual(['POST /mcp', 'GET /mcp'])
      // 换过去之后再也不碰 Streamable HTTP 的端点
      expect(fixture.hits.filter((hit) => hit === 'POST /mcp')).toHaveLength(1)
      expect(h.made).toEqual(['streamable', 'sse'])

      expect(h.remember).toHaveBeenCalledTimes(1)
      expect(h.remember).toHaveBeenCalledWith('remote-id', 'sse')
      expect(metadataOf(h)).toEqual({ cwd: '/kept', transport: 'sse' })

      expect(await callPing(h)).toBe('pong via sse')
    }
  )

  it.each([401, 403])(
    'SSE-3 POST 回 %i 不回退：报的就是 Streamable HTTP 那句，一个 GET 都不发，什么都不记',
    async (status) => {
      const fixture = await startServer({ post: status, get: 'serve' })
      const h = setup(row(fixture.url))

      const result = await h.mgr.connect('remote-id')

      expect(result).toEqual({
        ok: false,
        error: `Streamable HTTP error: Error POSTing to endpoint: ${ERROR_BODY[status]}`
      })
      expect(h.mgr.getStatus('remote-id')).toBe('error')
      expect(fixture.hits).toEqual(['POST /mcp'])
      expect(h.made).toEqual(['streamable'])
      expect(h.remember).not.toHaveBeenCalled()
    }
  )

  it('SSE-4 网络错误（没人在听）不回退', async () => {
    const fixture = await startServer({ post: 404, get: 'serve' })
    await fixture.close()
    servers.length = 0
    const h = setup(row(fixture.url))

    const result = await h.mgr.connect('remote-id')

    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
    expect(h.made).toEqual(['streamable'])
    expect(h.remember).not.toHaveBeenCalled()
  })

  it('SSE-5 宿主没声明 legacySse：404 照原样报，不发 GET', async () => {
    const fixture = await startServer({ post: 404, get: 'serve' })
    const h = setup(row(fixture.url), { legacySse: false })

    expect(await h.mgr.connect('remote-id')).toEqual({
      ok: false,
      error: 'Streamable HTTP error: Error POSTing to endpoint: Not Found'
    })
    expect(fixture.hits).toEqual(['POST /mcp'])
    expect(h.remember).not.toHaveBeenCalled()
  })

  it('SSE-6 两种都不通：报头一种的错误，后面跟着 SSE 的；什么都不记', async () => {
    const fixture = await startServer({ post: 404, get: 404 })
    const h = setup(row(fixture.url))

    const result = await h.mgr.connect('remote-id')

    expect(result.ok).toBe(false)
    expect(result.error).toBe(
      'Streamable HTTP error: Error POSTing to endpoint: Not Found ' +
        '(legacy SSE fallback also failed: SSE error: Non-200 status code (404))'
    )
    expect(fixture.hits).toEqual(['POST /mcp', 'GET /mcp'])
    expect(h.remember).not.toHaveBeenCalled()
    expect(metadataOf(h)).toEqual({})
  })
})

describe('记着 SSE 的 server', () => {
  it('SSE-7 第一下就是 GET，一个 POST /mcp 都不发；记忆本来就对，不重复记', async () => {
    const fixture = await startServer({ post: 404, get: 'serve' })
    const h = setup(row(fixture.url, { transport: 'sse' }))

    expect(await h.mgr.connect('remote-id')).toEqual({ ok: true })
    expect(fixture.hits[0]).toBe('GET /mcp')
    expect(fixture.hits).not.toContain('POST /mcp')
    expect(h.made).toEqual(['sse'])
    expect(h.remember).not.toHaveBeenCalled()
    expect(await callPing(h)).toBe('pong via sse')
  })

  it.each([405, 404, 400])(
    'SSE-8 server 已换成 Streamable HTTP（GET 回 %i）→ 换回去连上，记忆清掉、别的键留着',
    async (status) => {
      const fixture = await startServer({ post: 'serve', get: status })
      const h = setup(row(fixture.url, { transport: 'sse', addedBy: 'someone' }))

      expect(await h.mgr.connect('remote-id')).toEqual({ ok: true })
      expect(fixture.hits.slice(0, 2)).toEqual(['GET /mcp', 'POST /mcp'])
      expect(h.made).toEqual(['sse', 'streamable'])
      expect(h.remember).toHaveBeenCalledTimes(1)
      expect(h.remember).toHaveBeenCalledWith('remote-id', undefined)
      expect(metadataOf(h)).toEqual({ addedBy: 'someone' })

      expect(await callPing(h)).toBe('pong via streamable http')

      // 下一次连接直接走 Streamable HTTP
      await h.mgr.disconnect('remote-id')
      fixture.hits.length = 0
      expect(await h.mgr.connect('remote-id')).toEqual({ ok: true })
      expect(h.made.slice(2)).toEqual(['streamable'])
      expect(fixture.hits).toContain('POST /mcp')
    }
  )

  it('SSE-9 GET 回 401 → 不换回去，原样报，记忆不动', async () => {
    const fixture = await startServer({ post: 'serve', get: 401 })
    const h = setup(row(fixture.url, { transport: 'sse' }))

    expect(await h.mgr.connect('remote-id')).toEqual({
      ok: false,
      error: 'SSE error: Non-200 status code (401)'
    })
    expect(fixture.hits).toEqual(['GET /mcp'])
    expect(h.remember).not.toHaveBeenCalled()
    expect(metadataOf(h)).toEqual({ transport: 'sse' })
  })

  it('SSE-10 宿主没声明 legacySse：记忆不算数，直接 Streamable HTTP', async () => {
    const fixture = await startServer({ post: 'serve', get: 405 })
    const h = setup(row(fixture.url, { transport: 'sse' }), { legacySse: false })

    expect(await h.mgr.connect('remote-id')).toEqual({ ok: true })
    expect(fixture.hits[0]).toBe('POST /mcp')
    expect(h.made).toEqual(['streamable'])
    expect(h.remember).not.toHaveBeenCalled()
  })
})

describe('回退途中的意外', () => {
  it('SSE-11 换到 SSE 之后等不到（GET 一直悬着）→ 超时失败，那条 SSE 流被关掉，不留着', async () => {
    const fixture = await startServer({ post: 404, get: 'hang' })
    const h = setup(row(fixture.url))

    const result = await h.mgr.connect('remote-id', { timeoutMs: 300 })

    expect(result).toEqual({ ok: false, error: 'connect timed out after 300ms' })
    expect(fixture.hits).toEqual(['POST /mcp', 'GET /mcp'])
    await vi.waitFor(() => expect(fixture.hungClosed()).toBe(1))
    expect(h.remember).not.toHaveBeenCalled()
  })

  it('SSE-12 记不下（store 抛）不让已经连上的这次失败', async () => {
    const fixture = await startServer({ post: 405, get: 'serve' })
    const h = setup(row(fixture.url), {
      remember: () => {
        throw new Error('database is locked')
      }
    })

    expect(await h.mgr.connect('remote-id')).toEqual({ ok: true })
    expect(h.remember).toHaveBeenCalledWith('remote-id', 'sse')
    expect(await callPing(h)).toBe('pong via sse')
  })
})
