/**
 * MCP stdio 客户端 transport（桌面）—— 换掉 SDK 自带的 StdioClientTransport，为的是它做不到的两件事：
 *
 *  1. **stderr 接管道、留最近一段**（`McpStderrSource`）：连接失败、调用中途进程退出时，McpManager
 *     把它拼进报错。SDK 默认 `inherit`，打到 Electron 主进程的 stderr 上 —— 打包后谁也看不见，
 *     用户只能读到一句「Connection closed」。
 *  2. **子进程自成进程组，关闭时整组收掉**（POSIX `detached`）：`npx` / `uvx` 只是包装器，真正的
 *     server 是它的子进程，SDK 只杀直接子进程，server 就成了孤儿。工具调用发现掉线会原地重连，
 *     每留下一个孤儿就多一份。Windows 没有进程组，走 `taskkill /T`。
 *
 * 其余照搬 SDK：消息分帧用它的 ReadBuffer / serializeMessage（换行分隔的 JSON-RPC），spawn 用同一个
 * cross-spawn（Windows 上 `npx.cmd` 这类包装器靠它），关闭顺序按规范：先关 stdin 让 server 自己退，
 * 再 SIGTERM，再 SIGKILL。参照 pi 的 `packages/mcp/src/transports/stdio.ts`。
 */
import spawn from 'cross-spawn'
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import type { McpStderrSource } from '@shuvix/agent-runtime'

/** stderr 留多少字节（取尾部）。报错只拼最后 2000 字符，多留一些给日志与多字节字符的余量 */
const DEFAULT_MAX_STDERR_BYTES = 16 * 1024
/** SIGTERM 之后等多久再 SIGKILL */
const DEFAULT_CLOSE_TIMEOUT_MS = 2000
/** 关掉 stdin 之后给 server 多久自己退出，再发 SIGTERM */
const STDIN_CLOSE_GRACE_MS = 500
const USE_PROCESS_GROUPS = process.platform !== 'win32'

/** 还活着的进程组（组长 pid）—— 应用没来得及逐个关就退出时，由退出钩子统一收掉 */
const liveGroups = new Set<number>()
let exitHookInstalled = false

function installExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  // before-quit 里的 disconnectAll 是异步的，进程往往等不到它关完就退了；
  // detached 的组又不会随父进程收到终端的信号 —— 这里是最后一道
  process.once('exit', () => {
    for (const pid of liveGroups) {
      try {
        process.kill(-pid, 'SIGTERM')
      } catch {
        // 组已经空了
      }
    }
  })
}

/**
 * 给 server 的整棵进程树发信号：POSIX 发给进程组（负 pid）；Windows 只有 taskkill /T（一律强杀）。
 *
 * 组长退出之后 pid 可能已被别的进程复用，所以任何「只认 pid」的兜底都只能走 `child.kill` ——
 * Node 对已经退出的子进程不会再发信号。进程组不同：只要组里还有成员，组号就不会被复用。
 */
function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid
  if (pid === undefined) return
  const exited = child.exitCode !== null || child.signalCode !== null
  if (!USE_PROCESS_GROUPS) {
    if (exited) return
    try {
      nodeSpawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true
      }).on('error', () => {})
    } catch {
      // taskkill 起不来：至少收掉直接子进程
      child.kill(signal)
    }
    return
  }
  try {
    process.kill(-pid, signal)
  } catch {
    // 组已经空了（或从没建成）—— 退回只发给组长本身（已退出时是空操作）
    try {
      child.kill(signal)
    } catch {
      // 忽略
    }
  }
}

export interface McpStdioTransportOptions {
  command: string
  args?: string[]
  /** 子进程的完整环境（桌面传 buildSpawnEnv 的结果）；不给就继承本进程的 */
  env?: Record<string, string>
  cwd?: string
  /** stderr 留多少字节（取尾部），默认 16KB */
  maxStderrBytes?: number
  /** SIGTERM 之后等多久再 SIGKILL，默认 2000ms */
  closeTimeoutMs?: number
}

export class McpStdioTransport implements Transport, McpStderrSource {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void

  private child: ChildProcess | undefined
  private readonly readBuffer = new ReadBuffer()
  private stderrBuffer = Buffer.alloc(0)
  private started = false
  private closed = false
  private closeEmitted = false

  constructor(private readonly options: McpStdioTransportOptions) {}

  /** 子进程 pid（启动之后才有；进程退出后回 undefined） */
  get pid(): number | undefined {
    return this.child?.pid
  }

  stderrTail(): string {
    return this.stderrBuffer.toString('utf8')
  }

  async start(): Promise<void> {
    if (this.started) throw new Error('McpStdioTransport already started')
    if (this.closed) throw new Error('McpStdioTransport is closed')
    this.started = true
    const child = spawn(this.options.command, this.options.args ?? [], {
      env: this.options.env ?? (process.env as Record<string, string>),
      cwd: this.options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      // 自成进程组：关闭时才能连包装器底下的真 server 一起收掉
      detached: USE_PROCESS_GROUPS
    })
    this.child = child
    const pid = child.pid
    if (USE_PROCESS_GROUPS && pid !== undefined) {
      installExitHook()
      liveGroups.add(pid)
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      try {
        this.readBuffer.append(chunk)
      } catch (err) {
        // 一行超过 ReadBuffer 上限：这条流已经没法再对齐了
        this.onerror?.(err as Error)
        void this.close()
        return
      }
      this.drainMessages()
    })
    child.stdout?.on('error', (err) => this.onerror?.(err))
    child.stdin?.on('error', (err) => {
      if (!this.closed) this.onerror?.(err)
    })
    child.stderr?.on('data', (chunk: Buffer) => this.keepStderr(chunk))
    child.stderr?.on('error', (err) => this.onerror?.(err))
    child.on('close', () => {
      this.child = undefined
      this.readBuffer.clear()
      if (pid !== undefined) {
        liveGroups.delete(pid)
        // 组长退了、stdio 也都关了 —— 组里剩下的（包装器留下的 server）已经没人在跟它说话
        signalTree(child, 'SIGTERM')
      }
      this.emitClose()
    })

    await new Promise<void>((resolve, reject) => {
      const onSpawn = (): void => {
        child.off('error', onError)
        resolve()
      }
      const onError = (err: Error): void => {
        child.off('spawn', onSpawn)
        reject(err)
      }
      child.once('spawn', onSpawn)
      child.once('error', onError)
    })
    child.on('error', (err) => {
      if (!this.closed) this.onerror?.(err)
    })
  }

  send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      const stdin = this.child?.stdin
      if (this.closed || !stdin?.writable) {
        reject(new Error('Not connected'))
        return
      }
      if (stdin.write(serializeMessage(message))) {
        resolve()
        return
      }
      // 管道满了等 drain；等的时候进程没了，drain 永远不会来 —— 不能让这次发送一直悬着
      const onDrain = (): void => {
        stdin.off('close', onClose)
        resolve()
      }
      const onClose = (): void => {
        stdin.off('drain', onDrain)
        reject(new Error('Not connected'))
      }
      stdin.once('drain', onDrain)
      stdin.once('close', onClose)
    })
  }

  /**
   * 按规范收尾：关 stdin 让 server 自己退出；不退就 SIGTERM 整组，再不退 SIGKILL 整组。
   * 组长退了之后组里还剩的（无视 stdin 关闭的子进程）也一并 SIGTERM（见 start 里的 close 监听）。
   *
   * 只在 close 事件（stdio 全关）上收尾，不在组长 exit 上：组长退了而 stdio 还被组里别的进程
   * 攥着，说明真 server 还在、还在这条管道上说话 —— 那条连接是好的。
   */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const child = this.child
    if (!child) {
      this.emitClose()
      return
    }
    if (child.pid === undefined) {
      this.emitClose()
      return
    }
    const closeTimeoutMs = this.options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS
    // 组长已经退了、stdio 还被组里别的进程攥着（所以 close 事件还没来）：不必再给宽限，直接收
    const leaderExited = child.exitCode !== null || child.signalCode !== null
    const grace = leaderExited ? 0 : Math.min(STDIN_CLOSE_GRACE_MS, closeTimeoutMs)
    await new Promise<void>((resolve) => {
      const timers = [
        setTimeout(() => signalTree(child, 'SIGTERM'), grace),
        setTimeout(() => signalTree(child, 'SIGKILL'), grace + closeTimeoutMs),
        // 连 SIGKILL 都等不到 close 事件（stdio 被组外的进程攥着）：不再等，也不挂住调用方
        setTimeout(resolve, grace + closeTimeoutMs + 1000)
      ]
      child.once('close', () => {
        for (const timer of timers) clearTimeout(timer)
        resolve()
      })
      try {
        child.stdin?.end()
      } catch {
        // stdin 已经坏了：交给上面的计时器
      }
    })
  }

  private drainMessages(): void {
    for (;;) {
      let message: JSONRPCMessage | null
      try {
        message = this.readBuffer.readMessage()
      } catch (err) {
        // 一行不是 JSON-RPC（server 往 stdout 打了日志）：这一行已经被消费掉，接着读下一行
        this.onerror?.(err as Error)
        continue
      }
      if (message === null) return
      this.onmessage?.(message)
    }
  }

  private keepStderr(chunk: Buffer): void {
    const max = this.options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES
    this.stderrBuffer = Buffer.concat([this.stderrBuffer, chunk])
    if (this.stderrBuffer.length > max) this.stderrBuffer = this.stderrBuffer.subarray(-max)
  }

  private emitClose(): void {
    if (this.closeEmitted) return
    this.closeEmitted = true
    this.onclose?.()
  }
}
