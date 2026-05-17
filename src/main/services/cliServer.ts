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
import { widgetService, exportWidget, WidgetExportError } from './widget'
import { sessionService } from './sessionService'
import {
  resolveProjectConfig,
  isPathWithinWorkspace,
  isPathWithinReadwriteReferenceDirs
} from './toolContext'
import { resolve as resolvePath } from 'path'
import { chatFrontendRegistry } from '../frontend/core'
import {
  browserCdpService,
  snapshotAction,
  screenshotAction,
  printToPdfAction,
  clickAction,
  fillAction,
  typeAction,
  pressKeyAction,
  scrollAction,
  evaluateAction,
  waitForAction,
  navigateAction,
  getNetworkRequestsAction,
  getConsoleMessagesAction
} from './browser'
import { pyodideWorkerManager, type ExecuteRequest } from './pyodide/workerManager'
import { parseShuvixPythonArgv, splitPythonPath } from './pyodide/argvParser'
import type { AgentToolResult } from '@mariozechner/pi-agent-core'
import type { BrowserToolDetails } from '../../shared/types/chatMessage'

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
        sessionService.addAllowListPatterns(sessionId, 'read', [result.projectDir])
        sessionService.addAllowListPatterns(sessionId, 'write', [result.projectDir])
      }
      return result
    })

    this.handlers.set('widget.build', async (p, sessionId) => {
      const id = String(p.id ?? '')
      if (!id) throw new Error('id required')
      const dir = widgetService.getWidgetDir(id)
      if (sessionId) {
        sessionService.addAllowListPatterns(sessionId, 'read', [dir])
        sessionService.addAllowListPatterns(sessionId, 'write', [dir])
      }
      return await widgetService.build(id)
    })

    this.handlers.set('widget.export', async (p, sessionId) => {
      const id = String(p.id ?? '')
      const targetPath = String(p.targetPath ?? '')
      if (!id) throw new Error('id required')
      if (!targetPath) throw new Error('targetPath required')
      const absolutePath = resolvePath(targetPath)
      // 沙箱：导出目标必须落在调用会话的 workingDirectory 或 readwrite 参考目录内
      // CLI 路径无 interactive approval 通道，越界直接拒绝
      if (sessionId) {
        const config = resolveProjectConfig(sessionId)
        const inWorkspace = isPathWithinWorkspace(absolutePath, config.workingDirectory)
        const inReadwriteRef = isPathWithinReadwriteReferenceDirs(
          absolutePath,
          config.referenceDirs
        )
        if (!inWorkspace && !inReadwriteRef) {
          throw new Error(
            `targetPath "${absolutePath}" is outside the session sandbox (workingDirectory + readwrite referenceDirs)`
          )
        }
      }
      try {
        return await exportWidget({ id, targetPath: absolutePath })
      } catch (e) {
        if (e instanceof WidgetExportError) {
          throw new Error(`[${e.code}] ${e.message}`)
        }
        throw e
      }
    })

    this.handlers.set('widget.list', async (p) => {
      if (p.archived) return widgetService.listArchived()
      return widgetService.listActive()
    })

    // ────────────────── browser.* ──────────────────
    // 浏览器面板是全局单例（挂在主窗口上），devtools 操作直接打 CDP。
    // open/close 走 chat event 给 renderer 显示/隐藏面板，必须有 sessionId。

    this.handlers.set('browser.open', async (p, sessionId) => {
      const url = String(p.url ?? '')
      if (!url) throw new Error('url required')
      if (!sessionId) throw new Error('browser.open must be invoked from a ShuviX session')
      chatFrontendRegistry.broadcast({
        type: 'browser_event',
        sessionId,
        action: 'open',
        url
      })
      return `Browser panel opened at ${url}.`
    })

    this.handlers.set('browser.close', async (_p, sessionId) => {
      if (!sessionId) throw new Error('browser.close must be invoked from a ShuviX session')
      chatFrontendRegistry.broadcast({ type: 'browser_event', sessionId, action: 'close' })
      browserCdpService.detach()
      return 'Browser panel closed.'
    })

    this.handlers.set('browser.snapshot', async () => {
      return await this.devtoolsResult(() => snapshotAction())
    })

    this.handlers.set('browser.screenshot', async (p, sessionId) => {
      if (!sessionId) throw new Error('browser.screenshot must be invoked from a ShuviX session')
      return await this.devtoolsResult(() => screenshotAction(p, sessionId))
    })

    this.handlers.set('browser.pdf', async (p, sessionId) => {
      if (!sessionId) throw new Error('browser.pdf must be invoked from a ShuviX session')
      return await this.devtoolsResult(() => printToPdfAction(p, sessionId))
    })

    this.handlers.set('browser.click', async (p) => {
      return await this.devtoolsResult(() => clickAction(p))
    })

    this.handlers.set('browser.fill', async (p) => {
      return await this.devtoolsResult(() => fillAction(p))
    })

    this.handlers.set('browser.type', async (p) => {
      return await this.devtoolsResult(() => typeAction(p))
    })

    this.handlers.set('browser.press-key', async (p) => {
      return await this.devtoolsResult(() => pressKeyAction(p))
    })

    this.handlers.set('browser.scroll', async (p) => {
      return await this.devtoolsResult(() => scrollAction(p))
    })

    this.handlers.set('browser.evaluate', async (p) => {
      return await this.devtoolsResult(() => evaluateAction(p))
    })

    this.handlers.set('browser.wait-for', async (p) => {
      return await this.devtoolsResult(() => waitForAction(p))
    })

    this.handlers.set('browser.navigate', async (p) => {
      return await this.devtoolsResult(() => navigateAction(p))
    })

    this.handlers.set('browser.network', async () => {
      return await this.devtoolsResult(() => getNetworkRequestsAction())
    })

    this.handlers.set('browser.console', async () => {
      return await this.devtoolsResult(() => getConsoleMessagesAction())
    })

    // ────────────────── python.* ──────────────────
    // `shuvix python` CLI 调用入口。CLI 端把 raw argv / stdin / cwd / PYTHONPATH
    // 一并发上来；这里翻译成 ExecuteRequest 后交给长驻 Pyodide worker 跑。
    // 沙箱挂载来自 session 的 ProjectConfig（workerManager.buildMounts 内置）。

    this.handlers.set('python.run', async (p, sessionId) => {
      if (!sessionId) throw new Error('python.run requires SHUVIX_SESSION_ID')

      const argv = Array.isArray(p.argv) ? (p.argv as string[]) : []
      const stdinContent = typeof p.stdin === 'string' ? (p.stdin as string) : undefined
      const cwd = typeof p.cwd === 'string' ? (p.cwd as string) : undefined
      const pythonPathRaw = typeof p.pythonPath === 'string' ? (p.pythonPath as string) : undefined
      const timeoutMs = typeof p.timeoutMs === 'number' ? (p.timeoutMs as number) : 60_000

      const parsed = parseShuvixPythonArgv(argv, stdinContent !== undefined)
      if (parsed.helpText !== undefined) {
        return { stdout: parsed.helpText, stderr: '', exitCode: 0 }
      }
      if (parsed.error !== undefined) {
        return { stdout: '', stderr: parsed.error, exitCode: 2 }
      }
      if (!parsed.request) {
        return { stdout: '', stderr: 'shuvix python: internal parse failure', exitCode: 1 }
      }

      const request: ExecuteRequest = { ...parsed.request }
      if (request.mode === 'stdin' && stdinContent !== undefined) {
        request.code = stdinContent
      }
      if (cwd) request.cwd = cwd
      const pathDirs = splitPythonPath(pythonPathRaw)
      if (pathDirs.length > 0) request.pythonPathDirs = pathDirs

      await pyodideWorkerManager.ensureReady(sessionId)
      const execId = `cli-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
      const resp = await pyodideWorkerManager.execute(sessionId, execId, request, timeoutMs)

      return {
        stdout: resp.stdout ?? '',
        stderr: resp.stderr ?? resp.error ?? '',
        exitCode: resp.exitCode ?? (resp.type === 'error' ? 1 : 0)
      }
    })
  }

  /**
   * 把 devtools action 的 AgentToolResult 压平成 CLI 友好的字符串：
   * - 取 content 里的 text 块拼成单字符串
   * - 若 details.error 被设置（参数错误 / 超时 / 未知 action 等），抛出 Error
   *   让 cliServer 把它包成 { success: false } 响应，CLI 以 exit 1 退出
   */
  private async devtoolsResult(
    run: () => Promise<AgentToolResult<BrowserToolDetails>>
  ): Promise<string> {
    const result = await run()
    const text = result.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .filter((s) => s.length > 0)
      .join('\n')
    const details = result.details as (BrowserToolDetails & { error?: string }) | undefined
    if (details && details.error) {
      throw new Error(text || details.error)
    }
    return text
  }
}

export const cliServer = new CliServer()
