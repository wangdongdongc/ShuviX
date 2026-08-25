/**
 * CLI 服务 —— 暴露一组本地 IPC 端点，供随 app 一起分发的 `shuvix-cli` 调用。
 *
 * 传输：
 *   - POSIX：Unix domain socket，路径 ~/.shuvix/cli.sock（mode 0600）
 *   - Windows：named pipe，路径 \\.\pipe\shuvix-cli-<username>
 *
 * 鉴权：随 app 启动生成 32 字节随机 token，写入 ~/.shuvix/cli-token（mode 0600）。
 *      CLI 客户端在请求 JSON 里附带 token；不匹配立刻断开。
 *
 * 协议：每条消息一行 JSON
 *   request:  { token, command, params, sessionId? }
 *   response: { success: true, data } | { success: false, error }
 */

import { createServer, type Server, type Socket } from 'net'
import { randomBytes } from 'crypto'
import { writeFileSync, unlinkSync, existsSync, chmodSync, mkdirSync, type PathLike } from 'fs'
import { join } from 'path'
import { homedir, platform, userInfo } from 'os'
import { createLogger } from '../logger'
import {
  widgetService,
  exportWidget,
  resolveExportZipPath,
  WidgetExportError,
  runWidgetDbQuery
} from './widget'
import * as widgetWindowService from './widgetWindowService'
import { sessionService } from './sessionService'
import { resolveProjectConfig, isPathWithinWorkspace } from './toolContext'
import { resolve as resolvePath } from 'path'

const log = createLogger('cliServer')

interface Request {
  token: string
  command: string
  params?: Record<string, unknown>
  /** 可选：调用方所属 ShuviX 会话 id，由 bash 工具通过 env 注入到 CLI */
  sessionId?: string
}

interface Response {
  success: boolean
  data?: unknown
  error?: string
}

type Handler = (params: Record<string, unknown>, sessionId: string | undefined) => Promise<unknown>

class CliServer {
  private server: Server | null = null
  private token: string = ''
  private socketPathCache: string | null = null
  private handlers = new Map<string, Handler>()

  constructor() {
    this.registerHandlers()
  }

  // ────────────────────── lifecycle ──────────────────────

  async start(): Promise<void> {
    this.token = randomBytes(32).toString('hex')
    const tp = this.tokenPath()
    this.ensureDir(homedir() + '/.shuvix')
    writeFileSync(tp, this.token, 'utf-8')
    if (!this.isWindows()) {
      try {
        chmodSync(tp, 0o600)
      } catch (e) {
        log.warn('chmod token failed:', e)
      }
    }

    const sp = this.socketPath()
    if (!this.isWindows() && existsSync(sp as PathLike)) {
      // 旧 socket 残留：直接 unlink 后重建
      try {
        unlinkSync(sp as PathLike)
      } catch (e) {
        log.warn('unlink stale socket failed:', e)
      }
    }

    this.server = createServer((sock) => this.handleConnection(sock))
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(sp, () => {
        this.server!.removeListener('error', reject)
        if (!this.isWindows()) {
          try {
            chmodSync(sp as PathLike, 0o600)
          } catch (e) {
            log.warn('chmod socket failed:', e)
          }
        }
        log.info(`CLI server listening at ${sp}`)
        resolve()
      })
    })
  }

  stop(): void {
    if (this.server) {
      try {
        this.server.close()
      } catch (e) {
        log.warn('close server failed:', e)
      }
      this.server = null
    }
    if (!this.isWindows()) {
      const sp = this.socketPath()
      if (existsSync(sp as PathLike)) {
        try {
          unlinkSync(sp as PathLike)
        } catch (e) {
          log.warn('unlink socket on stop failed:', e)
        }
      }
      const tp = this.tokenPath()
      if (existsSync(tp)) {
        try {
          unlinkSync(tp)
        } catch (e) {
          log.warn('unlink token on stop failed:', e)
        }
      }
    }
  }

  // ────────────────────── paths ──────────────────────

  /** 给 bash 工具注入 env 时用：返回 CLI 套接字 / token 文件路径 */
  getPaths(): { socketPath: string; tokenPath: string } {
    return { socketPath: this.socketPath(), tokenPath: this.tokenPath() }
  }

  private isWindows(): boolean {
    return platform() === 'win32'
  }

  private socketPath(): string {
    if (this.socketPathCache) return this.socketPathCache
    if (this.isWindows()) {
      const user = userInfo().username || 'shuvix'
      this.socketPathCache = `\\\\.\\pipe\\shuvix-cli-${user}`
    } else {
      this.socketPathCache = join(homedir(), '.shuvix', 'cli.sock')
    }
    return this.socketPathCache
  }

  private tokenPath(): string {
    return join(homedir(), '.shuvix', 'cli-token')
  }

  private ensureDir(dir: string): void {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
  }

  // ────────────────────── connection / dispatch ──────────────────────

  private handleConnection(sock: Socket): void {
    let buf = ''
    sock.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf-8')
      // 简化：协议规定一条请求一行 JSON，处理后立即关闭连接
      const newlineIdx = buf.indexOf('\n')
      if (newlineIdx === -1) return
      const line = buf.slice(0, newlineIdx)
      buf = ''
      this.processRequest(line, sock).catch((err) => {
        log.warn('processRequest failed:', err)
        try {
          this.respond(sock, { success: false, error: (err as Error).message })
        } catch {
          /* ignore */
        }
      })
    })
    sock.on('error', (err) => log.warn('socket error:', err))
  }

  private respond(sock: Socket, resp: Response): void {
    try {
      sock.end(JSON.stringify(resp) + '\n')
    } catch (e) {
      log.warn('respond failed:', e)
    }
  }

  private async processRequest(line: string, sock: Socket): Promise<void> {
    let req: Request
    try {
      req = JSON.parse(line)
    } catch {
      this.respond(sock, { success: false, error: 'invalid JSON' })
      return
    }

    if (!this.token || req.token !== this.token) {
      this.respond(sock, { success: false, error: 'invalid token' })
      return
    }

    const handler = this.handlers.get(req.command)
    if (!handler) {
      this.respond(sock, { success: false, error: `unknown command: ${req.command}` })
      return
    }

    try {
      const data = await handler(req.params || {}, req.sessionId)
      this.respond(sock, { success: true, data })
    } catch (e) {
      this.respond(sock, { success: false, error: (e as Error).message })
    }
  }

  // ────────────────────── handlers ──────────────────────

  private registerHandlers(): void {
    this.handlers.set('widget.init', async (p, sessionId) => {
      const id = String(p.id ?? '')
      const name = String(p.name ?? '')
      const description = String(p.description ?? '')
      if (!id) throw new Error('id required')
      if (!name) throw new Error('name required')
      const result = await widgetService.init({ id, name, description, template: 'blank' })
      if (sessionId) {
        sessionService.addAllowListPaths(sessionId, 'read', [result.projectDir])
        sessionService.addAllowListPaths(sessionId, 'write', [result.projectDir])
      }
      return result
    })

    this.handlers.set('widget.build', async (p, sessionId) => {
      const id = String(p.id ?? '')
      if (!id) throw new Error('id required')
      const dir = widgetService.getWidgetDir(id)
      if (sessionId) {
        sessionService.addAllowListPaths(sessionId, 'read', [dir])
        sessionService.addAllowListPaths(sessionId, 'write', [dir])
      }
      return await widgetService.build(id)
    })

    // widget 的"预览"就是把它当独立小应用打开（已开则聚焦）。构建 / URL 由窗口内 shell
    // 自行完成，这里不等待，也不走 widgetService.open —— 避免与 shell 重复计一次打开数。
    this.handlers.set('widget.open', async (p) => {
      const id = String(p.id ?? '')
      if (!id) throw new Error('id required')
      widgetWindowService.open(id)
      return { id, opened: true }
    })

    this.handlers.set('widget.export', async (p, sessionId) => {
      const id = String(p.id ?? '')
      const targetPath = String(p.targetPath ?? '')
      if (!id) throw new Error('id required')
      if (!targetPath) throw new Error('targetPath required')
      // 先归一化成最终 zip 路径再校验 —— 校验对象必须与真正写入的路径一致
      const zipPath = resolveExportZipPath(id, resolvePath(targetPath))
      // 准入：导出目标必须落在调用会话的 workingDirectory 内
      // CLI 路径无交互询问通道，弹不出询问卡，越界只能直接拒绝
      if (sessionId) {
        const config = resolveProjectConfig(sessionId)
        if (!isPathWithinWorkspace(zipPath, config.workingDirectory)) {
          throw new Error(`target "${zipPath}" is outside the session working directory`)
        }
      }
      try {
        return await exportWidget({ id, targetPath: zipPath })
      } catch (e) {
        if (e instanceof WidgetExportError) {
          throw new Error(`[${e.code}] ${e.message}`)
        }
        throw e
      }
    })

    this.handlers.set('widget.list', async (p) => {
      const list = p.archived ? widgetService.listArchived() : widgetService.listActive()
      // 消费方是 agent —— 补上 projectDir，省掉一次"这个 widget 的源码在哪"的猜测
      return list.map((w) => ({ ...w, projectDir: widgetService.getWidgetDir(w.id) }))
    })

    this.handlers.set('widget.db-init', async (p) => {
      const id = String(p.id ?? '')
      const sql = String(p.sql ?? '')
      if (!id) throw new Error('id required')
      if (!sql.trim()) throw new Error('sql required (use --sql "<DDL>" or --file <path>)')
      return await widgetService.setDbSchema(id, sql)
    })

    this.handlers.set('widget.db-query', async (p) => {
      const id = String(p.id ?? '')
      const sql = String(p.sql ?? '')
      if (!id) throw new Error('id required')
      if (!sql.trim()) throw new Error('sql required (use --sql "<SQL>" or --file <path>)')
      // 校验 widget 存在 —— 否则 query 会落到一个不存在的 widget 的 schema
      const widget = widgetService.getById(id)
      if (!widget) throw new Error(`widget "${id}" not found`)
      const result = await runWidgetDbQuery(id, sql)
      if (result.error) {
        return { stdout: '', stderr: result.error, exitCode: 1 }
      }
      return { stdout: result.output, stderr: '', exitCode: 0 }
    })

    // 浏览器自动化不再走 CLI —— agent 统一用内置 `browser` 工具（services/browser 的 backend）。
  }
}

export const cliServer = new CliServer()
