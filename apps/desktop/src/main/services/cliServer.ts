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
 *   request:  { token, command, params, sessionId?, sessionKey? }
 *   response: { success: true, data } | { success: false, error }
 *
 * 会话：命令环境里的 SHUVIX_SESSION_ID 与 SHUVIX_SESSION_KEY 由 CLI 带上，核对见 cliSession.ts ——
 * 对不上就当这次调用不属于任何会话（不能凭一个自报的 id 去动别的会话）。
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
  callWidgetOp,
  WidgetApiError
} from './widget'
import * as widgetWindowService from './widgetWindowService'
import { parsePreviewSizes, parsePreviewTheme, previewWidget } from './widgetPreviewService'
import { sessionAcl } from './acl'
import { verifiedCliSession } from './cliSession'
import { issueWidgetToken } from './widget/widgetToken'
import { getDesktopSecurityContext } from './toolContext'
import { resolve as resolvePath } from 'path'
import { stopBgTaskByAgent } from './bgTaskService'
import { runPolicyCheck, type PolicyCheckDeps } from './policyCheck'

const log = createLogger('cliServer')

interface Request {
  token: string
  command: string
  params?: Record<string, unknown>
  /** 可选：调用方所属 ShuviX 会话 id，由 bash 工具通过 env 注入到 CLI */
  sessionId?: string
  /** 与 sessionId 配对的会话 key（cliSession.ts）；对不上 sessionId 就不算数 */
  sessionKey?: string
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
  /** `shuvix policy check` 的宿主依赖（主入口注入：策略服务 / 网络状态 / 安全上下文 —— 直接 import 会成环） */
  private policyCheckDeps: (() => PolicyCheckDeps) | null = null

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

  setPolicyCheckDeps(deps: (() => PolicyCheckDeps) | null): void {
    this.policyCheckDeps = deps
  }

  // ────────────────────── paths ──────────────────────

  /**
   * 本次启动的鉴权 token（`~/.shuvix/cli-token` 的内容）。Chrome 桥服务与 CLI 共用它：
   * 原生消息宿主读的是同一个文件。start 之前为空串（桥服务据此拒绝一切连接）。
   */
  getToken(): string {
    return this.token
  }

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

    const sessionId = verifiedCliSession(req.sessionId, req.sessionKey)
    if (req.sessionId && !sessionId) {
      log.warn(
        `CLI request claims session ${req.sessionId} without a matching key; treated as no session`
      )
    }

    try {
      const data = await handler(req.params || {}, sessionId)
      this.respond(sock, { success: true, data })
    } catch (e) {
      this.respond(sock, { success: false, error: (e as Error).message })
    }
  }

  // ────────────────────── handlers ──────────────────────

  private registerHandlers(): void {
    // 停本会话的一条后台任务：沙箱里的命令够不到上一条命令起的进程（见 bgTaskService.stopBgTaskByAgent）
    this.handlers.set('task.stop', async (p, sessionId) => {
      if (!sessionId)
        throw new Error('SHUVIX_SESSION_ID is not set — run this from a ShuviX command')
      const raw = p.pid
      const pid =
        typeof raw === 'number'
          ? raw
          : typeof raw === 'string' && /^\d+$/.test(raw)
            ? Number(raw)
            : NaN
      if (!Number.isInteger(pid) || pid <= 0) throw new Error('pid must be a positive integer')
      const result = stopBgTaskByAgent(sessionId, pid)
      if (result === 'not-found')
        throw new Error(`no background task with pid ${pid} in this session`)
      return result === 'stopped' ? `stopping background task ${pid}` : `task ${pid} is not running`
    })

    // 核对一份远程访问策略（policyCheck.ts）：文件由 CLI 进程自己读（受沙箱 / 策略约束），这里只收全文
    this.handlers.set('policy.check', async (p) => {
      const deps = this.policyCheckDeps?.()
      if (!deps) throw new Error('policy check is not available in this ShuviX')
      const raw = p.file as { path?: unknown; text?: unknown } | undefined
      const file =
        raw && typeof raw.path === 'string' && typeof raw.text === 'string'
          ? { path: raw.path, text: raw.text }
          : undefined
      const flags = (Array.isArray(p.flags) ? p.flags : []).filter(
        (pair): pair is [string, string] =>
          Array.isArray(pair) && typeof pair[0] === 'string' && typeof pair[1] === 'string'
      )
      return runPolicyCheck({ ...(file ? { file } : {}), flags }, deps)
    })

    this.handlers.set('widget.init', async (p, sessionId) => {
      const id = String(p.id ?? '')
      const name = String(p.name ?? '')
      const description = String(p.description ?? '')
      if (!id) throw new Error('id required')
      if (!name) throw new Error('name required')
      const result = await widgetService.init({ id, name, description, template: 'blank' })
      if (sessionId) {
        sessionAcl.grantPath(sessionId, result.projectDir, 'write', {
          source: 'widget',
          sourceKey: id
        })
      }
      // 智能体在 shell 里检查数据库要的令牌（`cli` 范围：用不了 fs/，见 widget/widgetToken.ts）
      return { ...result, token: issueWidgetToken(id, 'cli') }
    })

    this.handlers.set('widget.build', async (p, sessionId) => {
      const id = String(p.id ?? '')
      if (!id) throw new Error('id required')
      // 先校验再授权：授权是持久写进会话的，而 id 原样拼进路径 —— `../..` 这类 id 会把
      // 任意目录的读写授权记到会话上（widgetService.build 自己的校验在授权之后才跑）
      widgetService.validateId(id)
      const dir = widgetService.getWidgetDir(id)
      if (sessionId) {
        sessionAcl.grantPath(sessionId, dir, 'write', { source: 'widget', sourceKey: id })
      }
      const message = typeof p.message === 'string' ? p.message : undefined
      const built = await widgetService.build(id, { message })
      return { ...built, token: issueWidgetToken(id, 'cli') }
    })

    // 在 widget 自己的窗口里打开（已开则聚焦）—— 技能只让 agent 在用户要它打开时用。构建 / URL 由窗口内
    // shell 自行完成，这里不等待，也不走 widgetService.open —— 避免与 shell 重复计一次打开数。
    this.handlers.set('widget.open', async (p) => {
      const id = String(p.id ?? '')
      if (!id) throw new Error('id required')
      widgetWindowService.open(id)
      return { id, opened: true }
    })

    // agent 自查排版：在看不见的窗口里按几种尺寸渲染、各截一张图（不弹窗口、不计打开），截图写进本会话的
    // tool_results（会话目录，read 读得到）
    this.handlers.set('widget.preview', async (p, sessionId) => {
      const id = String(p.id ?? '')
      if (!id) throw new Error('id required')
      return await previewWidget(id, {
        sizes: parsePreviewSizes(p.size),
        theme: parsePreviewTheme(p.theme),
        sessionId
      })
    })

    this.handlers.set('widget.export', async (p, sessionId) => {
      const id = String(p.id ?? '')
      const targetPath = String(p.targetPath ?? '')
      if (!id) throw new Error('id required')
      if (!targetPath) throw new Error('targetPath required')
      // 先归一化成最终 zip 路径再校验 —— 校验对象必须与真正写入的路径一致
      const zipPath = resolveExportZipPath(id, resolvePath(targetPath))
      // 准入：按调用会话的权限表与安全策略判这次写（导出目标须是会话免询问可写的地方）。CLI 没有询问
      // 通道，弹不出询问卡 —— 要问的一律拒绝；不属于任何会话的调用没有权限表，一律拒绝
      if (!sessionId) {
        throw new Error('widget export must run from a ShuviX session command')
      }
      const verdict = getDesktopSecurityContext({ sessionId }).judgeGate(
        'write',
        { type: 'path', path: zipPath, displayPath: zipPath },
        { tool: { name: 'shuvix-cli', operation: 'widget.export' } }
      )
      if (!verdict.allowed) {
        throw new Error(
          `target "${zipPath}" is not writable for this session without asking — export into the working directory or another path in the session's permission table`
        )
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
      const result = await widgetService.dbQuery(id, sql)
      if (result.error) {
        return { stdout: '', stderr: result.error, exitCode: 1 }
      }
      return { stdout: result.output, stderr: '', exitCode: 0 }
    })

    // 调组件 API 的一个操作（造组件时测试用；调用方是本会话的 agent）。结果以 JSON 打到 stdout，
    // 操作失败（参数不对、ctx.fail …）退出码 1；--dry-run 让写操作最后回滚
    this.handlers.set('widget.call', async (p, sessionId) => {
      const id = String(p.id ?? '')
      const op = String(p.op ?? '')
      if (!id || !op) throw new Error('id and operation required')
      widgetService.validateId(id)
      if (!widgetService.getById(id)) throw new Error(`widget "${id}" not found`)
      let args: unknown = {}
      if (typeof p.args === 'string' && p.args.trim()) {
        try {
          args = JSON.parse(p.args)
        } catch (e) {
          throw new Error(`--args is not valid JSON: ${(e as Error).message}`)
        }
      }
      const dryRun = p.dryRun === true
      try {
        const { mode, result } = await callWidgetOp(
          id,
          op,
          args,
          { kind: 'agent', ...(sessionId ? { sessionId } : {}), actor: 'cli', label: 'cli' },
          { dryRun }
        )
        const outcome = result.outcome
        const body = {
          op,
          mode,
          ...(dryRun ? { dryRun: true } : {}),
          ...(outcome.ok ? { result: outcome.value } : { error: outcome.error }),
          ...(result.logs.length > 0 ? { logs: result.logs } : {})
        }
        return { stdout: JSON.stringify(body, null, 2), stderr: '', exitCode: outcome.ok ? 0 : 1 }
      } catch (e) {
        if (e instanceof WidgetApiError) {
          return { stdout: '', stderr: `[${e.code}] ${e.message}`, exitCode: 1 }
        }
        throw e
      }
    })

    // 浏览器自动化不再走 CLI —— agent 统一用内置 `browser` 工具（services/browser 的 backend）。
  }
}

export const cliServer = new CliServer()
