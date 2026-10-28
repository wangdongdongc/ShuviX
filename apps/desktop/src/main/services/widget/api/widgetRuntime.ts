/**
 * 主进程侧的组件宿主管理（设计稿 docs/widget-tool-design.md §6）。
 *
 * 组件宿主是一个子进程（out/main/widgetHost.js，`ELECTRON_RUN_AS_NODE`），所有 SQLite 组件的 QuickJS 沙箱和数据库连接都在里面。
 * 这里负责：第一次有请求时拉起它、按 id 配对请求与应答、请求超时就 SIGKILL 整个进程（better-sqlite3 没有暴露
 * `sqlite3_interrupt`，进程内打断不了一条执行很久的语句；SIGKILL 2 ms 生效，WAL 让没提交的事务下次打开时回滚）、
 * 进程没了就让所有在途请求失败。下一次请求重新拉起。宿主空闲几分钟会自己退出。
 */
import { fork, type ChildProcess } from 'child_process'
import { join } from 'path'
import { createLogger } from '../../../logger'
import type {
  CallResult,
  HostRequestBody,
  HostResponse,
  OpMode,
  WidgetCaller,
  WidgetHostTarget
} from './hostProtocol'
import type { ApiManifest } from './sandboxRuntime'

const log = createLogger('WidgetRuntime')

/** 一次调用的总时长上限（含排队），超了就杀宿主 */
export const CALL_TIMEOUT_MS = 30_000
/** 沙箱里纯计算的上限：比总时长短，让纯 JS 死循环由 QuickJS 自己中断，不必杀整个进程 */
export const CALL_CPU_MS = 20_000
/** 宿主启动的上限 */
const START_TIMEOUT_MS = 15_000

export class WidgetRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (err: WidgetRuntimeError) => void
  timer: ReturnType<typeof setTimeout>
}

export interface WidgetRuntimeOptions {
  /** 宿主脚本；缺省与主进程 bundle 同目录的 widgetHost.js */
  hostPath?: string
  /** 用哪个可执行文件跑它（以 `ELECTRON_RUN_AS_NODE` 当 Node 用）；缺省当前进程 */
  execPath?: string
  /** 一次调用的总时长上限；缺省 {@link CALL_TIMEOUT_MS}（测试用短一点的值验杀进程） */
  callTimeoutMs?: number
  /** 沙箱里纯计算的上限；缺省 {@link CALL_CPU_MS} */
  callCpuMs?: number
}

export interface CallParams {
  target: WidgetHostTarget
  bundlePath: string
  bundleHash: string
  op: string
  mode: OpMode
  args: unknown
  caller: WidgetCaller
  dryRun?: boolean
}

export class WidgetRuntime {
  private child: ChildProcess | null = null
  private starting: Promise<ChildProcess> | null = null
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private readonly hostPath: string
  private readonly execPath: string
  private readonly callTimeoutMs: number
  private readonly callCpuMs: number

  constructor(options: WidgetRuntimeOptions = {}) {
    this.hostPath = options.hostPath ?? join(__dirname, 'widgetHost.js')
    this.execPath = options.execPath ?? process.execPath
    this.callTimeoutMs = options.callTimeoutMs ?? CALL_TIMEOUT_MS
    this.callCpuMs = options.callCpuMs ?? CALL_CPU_MS
  }

  /** 宿主进程在不在 */
  get running(): boolean {
    return this.child !== null
  }

  call(params: CallParams): Promise<CallResult> {
    return this.request<CallResult>(
      { type: 'call', ...params, cpuMs: this.callCpuMs },
      this.callTimeoutMs
    )
  }

  /** 在临时沙箱里执行刚打好的 API 包，取清单 */
  manifest(bundleCode: string): Promise<ApiManifest> {
    return this.request<ApiManifest>(
      { type: 'manifest', bundleCode, cpuMs: 10_000 },
      this.callTimeoutMs
    )
  }

  query(target: WidgetHostTarget, sql: string): Promise<{ output: string }> {
    return this.request({ type: 'query', target, sql }, 60_000)
  }

  /** 扔掉组件的热上下文、关掉它的连接（宿主没在跑就什么都不用做） */
  async forget(widgetId: string): Promise<void> {
    if (!this.child) return
    // 排在这个组件在途的调用后面执行，那次调用最多 CALL_TIMEOUT_MS：别比它先超时（超时会杀掉整个宿主）
    await this.request({ type: 'forget', widgetId }, this.callTimeoutMs + 10_000)
  }

  /** 关掉宿主（应用退出时） */
  dispose(): void {
    this.kill(new WidgetRuntimeError('host_stopped', 'The widget host was stopped.'))
  }

  // ────────────────────────────── 内部 ──────────────────────────────

  private async request<T>(body: HostRequestBody, timeoutMs: number): Promise<T> {
    const child = await this.ensureChild()
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const entry = this.pending.get(id)
        if (!entry) return
        this.pending.delete(id)
        entry.reject(
          new WidgetRuntimeError(
            'timeout',
            `The widget operation did not finish within ${Math.round(timeoutMs / 1000)} seconds and was stopped.`
          )
        )
        log.warn(`request ${body.type} timed out after ${timeoutMs}ms — restarting the widget host`)
        this.kill(
          new WidgetRuntimeError(
            'interrupted',
            'Another widget operation ran too long, so the widget host was restarted. Try again.'
          )
        )
      }, timeoutMs)
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer
      })
      child.send({ ...body, id }, (err) => {
        if (!err) return
        const entry = this.pending.get(id)
        if (!entry) return
        this.pending.delete(id)
        clearTimeout(entry.timer)
        entry.reject(new WidgetRuntimeError('host_unavailable', err.message))
      })
    })
  }

  private ensureChild(): Promise<ChildProcess> {
    if (this.child) return Promise.resolve(this.child)
    if (!this.starting) {
      this.starting = this.start().finally(() => {
        this.starting = null
      })
    }
    return this.starting
  }

  private start(): Promise<ChildProcess> {
    return new Promise<ChildProcess>((resolve, reject) => {
      let child: ChildProcess
      try {
        child = fork(this.hostPath, [], {
          execPath: this.execPath,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
          serialization: 'json'
        })
      } catch (e) {
        reject(new WidgetRuntimeError('host_unavailable', (e as Error).message))
        return
      }
      const forward = (stream: NodeJS.ReadableStream | null, level: 'info' | 'warn'): void => {
        stream?.setEncoding('utf8')
        stream?.on('data', (chunk: string) => {
          for (const line of chunk.split('\n')) if (line.trim()) log[level](`[host] ${line}`)
        })
      }
      forward(child.stdout, 'info')
      forward(child.stderr, 'warn')

      let settled = false
      const startTimer = setTimeout(() => {
        if (settled) return
        settled = true
        child.kill('SIGKILL')
        reject(new WidgetRuntimeError('host_unavailable', 'The widget host did not start in time.'))
      }, START_TIMEOUT_MS)

      child.on('message', (msg) => {
        if (!settled) {
          if ((msg as { ready?: unknown })?.ready === true) {
            settled = true
            clearTimeout(startTimer)
            this.child = child
            resolve(child)
          }
          return
        }
        this.onResponse(msg as HostResponse)
      })
      // 一直挂着：子进程的 'error' 没有监听者会变成主进程里的未捕获异常
      child.on('error', (err) => {
        if (settled) {
          log.warn(`widget host error: ${err.message}`)
          return
        }
        settled = true
        clearTimeout(startTimer)
        reject(new WidgetRuntimeError('host_unavailable', err.message))
      })
      child.once('exit', (code, signal) => {
        clearTimeout(startTimer)
        if (!settled) {
          settled = true
          reject(
            new WidgetRuntimeError(
              'host_unavailable',
              `The widget host exited while starting (code ${code}, signal ${signal}).`
            )
          )
          return
        }
        if (this.child === child) {
          this.child = null
          this.failAll(
            new WidgetRuntimeError(
              'host_exited',
              `The widget host stopped unexpectedly (code ${code}, signal ${signal}). Try again.`
            )
          )
        }
      })
    })
  }

  private onResponse(msg: HostResponse): void {
    if (typeof msg?.id !== 'number') return
    const entry = this.pending.get(msg.id)
    if (!entry) return
    this.pending.delete(msg.id)
    clearTimeout(entry.timer)
    if (msg.ok) entry.resolve(msg.result)
    else entry.reject(new WidgetRuntimeError(msg.error.code, msg.error.message))
  }

  private failAll(err: WidgetRuntimeError): void {
    for (const [id, entry] of this.pending) {
      this.pending.delete(id)
      clearTimeout(entry.timer)
      entry.reject(err)
    }
  }

  private kill(err: WidgetRuntimeError): void {
    const child = this.child
    this.child = null
    this.failAll(err)
    if (child && child.exitCode === null) child.kill('SIGKILL')
  }
}

/** 主进程里唯一的组件宿主 */
export const widgetRuntime = new WidgetRuntime()
