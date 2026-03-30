/**
 * MCP Server 服务 — 将 ShuviX 作为 MCP Server 对外暴露能力
 * 使用 Streamable HTTP 传输协议，支持动态注册/注销功能模块
 *
 * 关键设计：每个客户端 session 创建独立的 McpServer 实例
 * （MCP SDK 要求每个 transport 连接对应一个 McpServer 实例）
 */

import {
  createServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse
} from 'node:http'
import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import * as z from 'zod/v4'
import { dbManager } from './dbManager'
import { dbCredentialDao } from '../dao/dbCredentialDao'
import { mcpServerLogDao } from '../dao/mcpServerLogDao'
import { createLogger } from '../logger'
import type { McpHostConfig, McpHostStatus, McpHostFeature, McpHostToolDesc } from '../types'

const log = createLogger('McpServerService')

/** 每个客户端 session 的运行时状态 */
interface SessionEntry {
  server: McpServer
  transport: StreamableHTTPServerTransport
}

class McpServerServiceImpl {
  private httpServer: HttpServer | null = null
  private sessions = new Map<string, SessionEntry>()
  private config: McpHostConfig | null = null
  /** 当前已启用的功能集（用于新 session 创建时注册工具） */
  private enabledFeatures = new Set<McpHostFeature>()

  /** 启动 MCP Server */
  async start(config: McpHostConfig): Promise<void> {
    if (this.httpServer) {
      await this.stop()
    }
    this.config = config
    this.enabledFeatures.clear()
    if (config.features.database) {
      this.enabledFeatures.add('database')
    }

    // 启动 HTTP Server
    this.httpServer = createServer((req, res) => this.handleHttpRequest(req, res))

    await new Promise<void>((resolve, reject) => {
      this.httpServer!.on('error', (err) => {
        log.error(`HTTP server error: ${err.message}`)
        reject(err)
      })
      this.httpServer!.listen(config.port, '127.0.0.1', () => {
        log.info(`MCP Server listening on http://127.0.0.1:${config.port}/mcp`)
        resolve()
      })
    })
  }

  /** 停止 MCP Server */
  async stop(): Promise<void> {
    // 关闭所有 session
    for (const [sid, entry] of this.sessions) {
      try {
        await entry.transport.close()
      } catch {
        // ignore
      }
      try {
        await entry.server.close()
      } catch {
        // ignore
      }
      dbManager.disconnect(`mcp-${sid}`).catch(() => {})
    }
    this.sessions.clear()
    this.enabledFeatures.clear()

    // 关闭 HTTP server
    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => resolve())
      })
      this.httpServer = null
    }

    this.config = null
    log.info('MCP Server stopped')
  }

  isRunning(): boolean {
    return this.httpServer !== null && this.httpServer.listening
  }

  getStatus(): McpHostStatus {
    return {
      running: this.isRunning(),
      transport: 'http',
      port: this.config?.port ?? 3399,
      features: [...this.enabledFeatures]
    }
  }

  /** 获取当前已注册的工具描述列表 */
  getRegisteredTools(): McpHostToolDesc[] {
    const tools: McpHostToolDesc[] = []
    if (this.enabledFeatures.has('database')) {
      tools.push({
        name: 'database_query',
        description: this.getDatabaseToolDescription(),
        inputSchema: {
          type: 'object',
          properties: {
            credentialName: { type: 'string', description: 'Name of a saved database credential' },
            sql: { type: 'string', description: 'SQL statement to execute' },
            description: {
              type: 'string',
              description: 'Brief description of what this query does'
            }
          },
          required: ['credentialName', 'sql']
        }
      })
    }
    return tools
  }

  /** 动态启用功能（对已有 session 立即生效） */
  enableFeature(feature: McpHostFeature): void {
    if (this.enabledFeatures.has(feature)) return
    this.enabledFeatures.add(feature)
    // 注意：已有 session 的 McpServer 不会自动更新
    // 新功能仅对新 session 生效，这是合理的行为
  }

  /** 动态禁用功能 */
  disableFeature(feature: McpHostFeature): void {
    this.enabledFeatures.delete(feature)
  }

  // ────────────────────────────────────────────────────────────────
  // McpServer 工厂
  // ────────────────────────────────────────────────────────────────

  /** 为新 session 创建独立的 McpServer 实例并注册当前已启用的工具 */
  private createMcpServer(): McpServer {
    const server = new McpServer(
      { name: 'ShuviX', version: '0.1.0' },
      { capabilities: { logging: {} } }
    )

    if (this.enabledFeatures.has('database')) {
      this.registerDatabaseToolsOn(server)
    }

    return server
  }

  // ────────────────────────────────────────────────────────────────
  // HTTP 请求处理
  // ────────────────────────────────────────────────────────────────

  private async handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
    if (url.pathname !== '/mcp') {
      res.writeHead(404).end('Not Found')
      return
    }

    // CORS headers for local access
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, mcp-session-id')
    res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id')

    if (req.method === 'OPTIONS') {
      res.writeHead(204).end()
      return
    }

    try {
      const sessionId = req.headers['mcp-session-id'] as string | undefined

      if (sessionId && this.sessions.has(sessionId)) {
        // 复用已有 session 的 transport
        const entry = this.sessions.get(sessionId)!
        await entry.transport.handleRequest(req, res)
      } else if (!sessionId && req.method === 'POST') {
        // 可能是初始化请求，先解析 body
        const body = await this.parseBody(req)
        if (isInitializeRequest(body)) {
          await this.handleNewSession(req, res, body)
        } else {
          res.writeHead(400).end(
            JSON.stringify({
              jsonrpc: '2.0',
              error: {
                code: -32000,
                message: 'Bad Request: No session ID and not an initialization request'
              },
              id: null
            })
          )
        }
      } else if (sessionId && !this.sessions.has(sessionId)) {
        res.writeHead(404).end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32001, message: 'Session not found' },
            id: null
          })
        )
      } else {
        res.writeHead(400).end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Bad Request' },
            id: null
          })
        )
      }
    } catch (err) {
      log.error(`HTTP request error: ${err instanceof Error ? err.message : err}`)
      if (!res.headersSent) {
        res.writeHead(500).end('Internal Server Error')
      }
    }
  }

  private async handleNewSession(
    req: IncomingMessage,
    res: ServerResponse,
    body: unknown
  ): Promise<void> {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId: string) => {
        log.info(`New MCP client session: ${sessionId}`)
        this.sessions.set(sessionId, { server, transport })
      }
    })

    transport.onclose = () => {
      const sid = transport.sessionId
      if (sid) {
        log.info(`MCP client session closed: ${sid}`)
        this.sessions.delete(sid)
        dbManager.disconnect(`mcp-${sid}`).catch(() => {})
      }
    }

    // 为此 session 创建独立的 McpServer
    const server = this.createMcpServer()
    await server.connect(transport)
    await transport.handleRequest(req, res, body)
  }

  private parseBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')))
        } catch {
          reject(new Error('Invalid JSON'))
        }
      })
      req.on('error', reject)
    })
  }

  // ────────────────────────────────────────────────────────────────
  // Database 工具注册
  // ────────────────────────────────────────────────────────────────

  private getDatabaseToolDescription(): string {
    const creds = dbCredentialDao.findAllNamesWithType()
    let desc =
      'Query remote MySQL/PostgreSQL databases. Connection is managed automatically — just provide a credential name and SQL.'
    if (creds.length > 0) {
      const credList = creds
        .map((c) => `"${c.name}" (${c.dbType}${c.readonly ? ', readonly' : ''})`)
        .join(', ')
      desc += ` Available connections: [${credList}].`
    } else {
      desc += ' No credentials configured yet.'
    }
    return desc
  }

  /** 在指定的 McpServer 实例上注册 database 工具 */
  private registerDatabaseToolsOn(server: McpServer): void {
    server.registerTool(
      'database_query',
      {
        description: this.getDatabaseToolDescription(),
        inputSchema: {
          credentialName: z.string().describe('Name of a saved database credential'),
          sql: z
            .string()
            .describe(
              'SQL statement to execute (SELECT and read-only statements only for readonly connections)'
            ),
          description: z.string().optional().describe('Brief description of what this query does')
        }
      },
      async (args, extra) => {
        const startTime = Date.now()
        const mcpSessionId = `mcp-${extra.sessionId ?? 'default'}`
        let isError = false
        let resultText: string

        try {
          resultText = await dbManager.connectAndQuery(mcpSessionId, args.credentialName, args.sql)
        } catch (err: unknown) {
          isError = true
          resultText = err instanceof Error ? err.message : String(err)
        }

        const durationMs = Date.now() - startTime

        // 记录日志
        try {
          const clientInfo = server.server.getClientVersion?.()
          mcpServerLogDao.insert({
            id: randomUUID(),
            sessionId: extra.sessionId ?? 'unknown',
            clientName: clientInfo?.name ?? 'unknown',
            clientVersion: clientInfo?.version ?? '',
            toolName: 'database_query',
            arguments: JSON.stringify(args),
            result: resultText.slice(0, 10000),
            isError: isError ? 1 : 0,
            durationMs,
            createdAt: Date.now()
          })
        } catch (logErr) {
          log.error(`Failed to write MCP server log: ${logErr}`)
        }

        if (isError) {
          return {
            content: [{ type: 'text' as const, text: `Error: ${resultText}` }],
            isError: true
          }
        }

        return {
          content: [{ type: 'text' as const, text: resultText }]
        }
      }
    )
  }
}

export const mcpServerService = new McpServerServiceImpl()
