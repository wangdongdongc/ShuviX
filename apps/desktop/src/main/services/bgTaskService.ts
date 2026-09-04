/**
 * 后台任务服务 —— `bash({ run_in_background: true })` 起的长驻进程
 *
 * 设计要点（详见 docs/background-tasks-design.md）：
 *
 *  1. **输出不经 Node**。子进程的 stdout/stderr 直接重定向到一个已打开的文件描述符
 *     （`tool_results/<sessionId>/<toolCallId>.log`），由操作系统写盘，主进程一个字节都不碰。
 *     换来的性质：单一事实源（模型 read 与面板轮询读的是同一个文件）、零背压、没人看时成本为零。
 *     代价是 stdout / stderr 合并（等价 shell 的 `2>&1`）、日志上限只能靠定期 fstat 近似卡。
 *
 *  2. **落点选在 `tool_results/` 是有意的**。该目录已在内置策略 ask-on-read 的豁免区
 *     （`!inDir(object.path, vars.toolResultsBase)`），模型 read 它不弹询问；且这是模型
 *     早已熟悉的约定（任何超长工具输出都落在这里、以 toolCallId 命名）。用 `.log` 而非
 *     `.txt` 从根上排除与 processToolOutput 截断落盘的撞名。
 *
 *  3. **任务身份就是 toolCallId**，不另发明 id。
 *
 *  4. **不接工具的 AbortSignal**。用户点「停止生成」不该杀后台任务 —— 那正是后台的意义。
 *     只有删除会话（sessionService.delete）与应用退出（before-quit）才级联杀。
 *
 *  5. **没有 stdin**。子进程的 fd 0 是 /dev/null，与前台形态完全一致 —— 读 stdin 立刻拿到 EOF。
 *     这里曾留一个管道供用户在面板上向任务输入，撤销了，两个理由：
 *       (a) 没人能可靠判断一个任务是不是正卡在等输入 —— 提示符常常不带换行，「在等输入」
 *           和「跑得慢」在日志里长得一模一样。那个输入框因此实际上没人用得上，
 *           而它的存在会让人以为后台任务支持交互。
 *       (b) libuv 在 Unix 上用 socketpair() 实现 'pipe' stdio，而 socket 型 stdin 会让 macOS
 *           的 bash 误判自己是被 sshd 拉起的，从而抢先执行用户的 ~/.bashrc（见 shell.ts 的
 *           BASH_ARGS 注释）。那条路已由 `--norc` 独立堵死，此处改成 /dev/null 是把触发条件
 *           本身也一并移除 —— 前台之所以从来不受影响，正是因为它的 stdin 是 /dev/null。
 *     需要真人参与的命令就不该跑在这里：把命令交给用户，让他在自己的终端里执行。
 *
 * 本服务只管四件事：起进程、持句柄、定期 fstat、进程退出时记录状态。数据完全不经手。
 */

import { spawn, type ChildProcess } from 'child_process'
import { openSync, closeSync, readSync, statSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { getShellConfig, killProcessTree, sanitizeBinaryOutput } from '../utils/toolUtils/shell'
import { buildSpawnEnv, getToolResultsDir } from '../utils/paths'
import { createLogger } from '../logger'
import { chatFrontendRegistry } from '../frontend/core/ChatFrontendRegistry'
import type { BgTaskInfo, BgTaskLogChunk, BgTaskStatus } from '@shuvix/chat-protocol/types/bgTask'

export type { BgTaskInfo, BgTaskLogChunk, BgTaskStatus }

const log = createLogger('BgTask')

// ─── 常量 ────────────────────────────────────────────

/** 预热窗口：启动后等这么久，期间退出的命令按前台形态返回（打错命令 / 缺依赖即刻可见） */
const WARMUP_MS = 2000
/** 每会话同时运行的后台任务上限 —— 防止在循环里起 dev server 的智能体把机器打挂 */
export const MAX_RUNNING_PER_SESSION = 8
/** 停止时 SIGINT 到 SIGKILL 的升级等待 */
const KILL_ESCALATE_MS = 3000
/** 日志体检间隔（仅对 running 任务） */
const FSTAT_INTERVAL_MS = 30_000
/** 日志告警阈值：面板标注 + 计入退出通知 */
const LOG_WARN_BYTES = 50 * 1024 * 1024
/** 日志硬上限：自动停止。远超任何正常 dev server 日志，防的是无人值守的智能体循环写满磁盘 */
const LOG_KILL_BYTES = 1024 * 1024 * 1024
/** 退出通知里回显的日志尾部读取窗口（从中再取最后 NOTIFY_TAIL_LINES 行） */
const NOTIFY_TAIL_BYTES = 4096

// ─── 类型 ────────────────────────────────────────────

interface BgTask extends BgTaskInfo {
  child: ChildProcess
  /**
   * 已向前端宣告过 started。
   *
   * started 事件在**预热窗口结束后**才发（窗口内退出的命令按前台形态回话，不该进面板）。
   * 但子进程的 exit 回调可能先于竞态 resolve 跑完 —— 若那时无条件广播 exited，前端就会
   * 收到一条自己从没见过 started 的任务，把它加进面板；紧接着主进程把任务与日志一起清掉，
   * 该条目就永远卡在「日志文件已不存在」。所以：没宣告过的任务，退出时也不广播。
   */
  announced: boolean
  /** 已请求停止 —— 退出时据此把 status 记为 killed 而非 exited */
  stopRequested: boolean
  /** SIGINT → SIGKILL 的升级定时器 */
  escalateTimer: NodeJS.Timeout | null
}

/** 启动结果：预热窗口内退出 → 前台形态；否则转入后台 */
export type BgTaskStartResult =
  | { kind: 'settled'; info: BgTaskInfo; output: string }
  | { kind: 'background'; info: BgTaskInfo; logBytes: number }

export interface StartBgTaskParams {
  sessionId: string
  toolCallId: string
  command: string
  description: string
  cwd: string
  /** 注入子进程的额外环境变量（项目 env + SHUVIX_SESSION_ID） */
  extraEnv?: Record<string, string>
}

// ─── 退出通知钩子 ────────────────────────────────────

/** 任务结束时把结果告知智能体；由 sessionService 在启动时注入 */
export type BgTaskNotifier = (sessionId: string, text: string) => void

let notifier: BgTaskNotifier | null = null

/**
 * 注入退出通知实现。
 *
 * 用注入而不是直接 import sessionService：后者已经 import 本模块（删会话时级联杀任务），
 * 直连会成环。
 */
export function setBgTaskNotifier(fn: BgTaskNotifier): void {
  notifier = fn
}

/** 退出通知里回显的日志行数上限 —— 通知会打断智能体当前思路，必须短 */
const NOTIFY_TAIL_LINES = 20

/**
 * 退出通知文案。带上日志绝对路径而不只是尾部若干行：智能体要看全的话
 * read 那个文件是免询问的，比让它去猜路径便宜得多。
 */
function formatExitNotice(task: BgTask, tail: string): string {
  const status =
    task.status === 'killed'
      ? 'stopped by the user'
      : task.signal
        ? `killed by ${task.signal}`
        : `exited with code ${task.exitCode}`
  const seconds = Math.round(((task.endedAt ?? Date.now()) - task.startedAt) / 1000)
  const lines = [
    `<background-task pid="${task.pid}" status="${status}" duration="${seconds}s">`,
    task.command
  ]
  const trimmed = tail.trimEnd()
  if (trimmed) {
    lines.push('Last output:')
    lines.push(...trimmed.split('\n').slice(-NOTIFY_TAIL_LINES))
  }
  lines.push(`Full log: ${task.logPath}`, '</background-task>')
  return lines.join('\n')
}

// ─── 注册表 ──────────────────────────────────────────

/** toolCallId → BgTask */
const tasks = new Map<string, BgTask>()

let fstatTimer: NodeJS.Timeout | null = null

function toInfo(task: BgTask): BgTaskInfo {
  const { child: _child, stopRequested: _s, escalateTimer: _e, ...info } = task
  return { ...info }
}

/** 状态变更广播 —— 低频（每任务 2 次），输出增量不走这条路 */
function broadcast(task: BgTask): void {
  task.announced = true
  chatFrontendRegistry.broadcast({
    type: 'bg_task',
    sessionId: task.sessionId,
    task: toInfo(task)
  })
}

/** 当前会话正在运行的任务数 */
export function runningCount(sessionId: string): number {
  let n = 0
  for (const task of tasks.values()) {
    if (task.sessionId === sessionId && task.status === 'running') n++
  }
  return n
}

/** 会话的全部任务（含已结束的，按启动时间正序） */
export function listBgTasks(sessionId: string): BgTaskInfo[] {
  return [...tasks.values()]
    .filter((t) => t.sessionId === sessionId)
    .sort((a, b) => a.startedAt - b.startedAt)
    .map(toInfo)
}

export function getBgTask(toolCallId: string): BgTaskInfo | undefined {
  const task = tasks.get(toolCallId)
  return task ? toInfo(task) : undefined
}

// ─── 日志读取 ────────────────────────────────────────

/**
 * 按字节范围读日志。面板轮询与启动回执共用。
 * 文件被外部删除时返回空而不抛（用户可能手动清了 tool_results）。
 */
export function readBgTaskLog(params: {
  toolCallId: string
  fromByte?: number
  maxBytes?: number
}): BgTaskLogChunk {
  const task = tasks.get(params.toolCallId)
  const logPath = task?.logPath
  if (!logPath || !existsSync(logPath)) {
    return { exists: false, text: '', fromByte: 0, nextByte: 0, size: 0 }
  }
  let size = 0
  try {
    size = statSync(logPath).size
  } catch {
    return { exists: false, text: '', fromByte: 0, nextByte: 0, size: 0 }
  }
  const maxBytes = params.maxBytes ?? 200 * 1024
  // fromByte 缺省 = 取尾部窗口；越界（日志被截断/重建）时回退到窗口起点
  const from =
    params.fromByte === undefined || params.fromByte > size
      ? Math.max(0, size - maxBytes)
      : Math.max(0, params.fromByte)
  const end = Math.min(size, from + maxBytes)
  if (end <= from) return { exists: true, text: '', fromByte: from, nextByte: from, size }

  const buf = readRange(logPath, from, end)
  return {
    exists: true,
    text: sanitizeBinaryOutput(buf.toString('utf-8')),
    fromByte: from,
    nextByte: end,
    size
  }
}

/** 同步读取文件的 [start, end) 区间 */
function readRange(path: string, start: number, end: number): Buffer {
  const fd = openSync(path, 'r')
  try {
    const length = end - start
    const buf = Buffer.allocUnsafe(length)
    let read = 0
    while (read < length) {
      const n = readSync(fd, buf, read, length - read, start + read)
      if (n <= 0) break
      read += n
    }
    return buf.subarray(0, read)
  } finally {
    closeSync(fd)
  }
}

/** 读日志尾部若干字节（丢弃可能被切断的首行） */
function readTail(logPath: string, maxBytes: number): string {
  if (!existsSync(logPath)) return ''
  let size = 0
  try {
    size = statSync(logPath).size
  } catch {
    return ''
  }
  if (size === 0) return ''
  const start = Math.max(0, size - maxBytes)
  const text = sanitizeBinaryOutput(readRange(logPath, start, size).toString('utf-8'))
  // 从中间切进去的话首行多半是半截，丢掉
  return start > 0 ? text.slice(text.indexOf('\n') + 1) : text
}

/** 读整个日志（预热窗口内退出时用；此时文件必然很小） */
function readWhole(logPath: string): string {
  if (!existsSync(logPath)) return ''
  try {
    const size = statSync(logPath).size
    if (size === 0) return ''
    return sanitizeBinaryOutput(readRange(logPath, 0, size).toString('utf-8'))
  } catch {
    return ''
  }
}

// ─── 启动 ────────────────────────────────────────────

/**
 * 起一个后台任务。**调用方须已通过安全模块的命令门**（enforceCommand）——
 * 本服务不做准入判断，只负责执行与簿记。
 *
 * 预热窗口内（2s）若进程已退出，任务不进注册表、日志文件删除，
 * 返回 `settled` 让调用方按前台形态回话 —— 打错的命令即刻可见，
 * 面板也不会被一堆秒退的僵尸条目污染。
 */
export async function startBgTask(params: StartBgTaskParams): Promise<BgTaskStartResult> {
  const { sessionId, toolCallId, command, description, cwd, extraEnv } = params
  const logPath = join(getToolResultsDir(sessionId), `${toolCallId}.log`)
  const { shell, args } = getShellConfig()

  // 'a' 打开：子进程独占追加写。父进程 dup 给子进程后立即关掉自己这份，避免 fd 泄漏。
  const fd = openSync(logPath, 'a')
  let child: ChildProcess
  try {
    child = spawn(shell, [...args, command], {
      cwd,
      env: buildSpawnEnv(extraEnv),
      // stdin 关成 /dev/null，与前台形态一致（见文件头第 5 点）；stdout/stderr 同一个 fd
      stdio: ['ignore', fd, fd],
      detached: process.platform !== 'win32'
    })
  } finally {
    // uv_spawn 在 spawn() 内部同步把 fd dup 进子进程，此处关闭是安全的
    try {
      closeSync(fd)
    } catch {
      /* 忽略 */
    }
  }

  const task: BgTask = {
    toolCallId,
    sessionId,
    command,
    description,
    cwd,
    pid: child.pid ?? -1,
    logPath,
    status: 'running',
    exitCode: null,
    signal: null,
    startedAt: Date.now(),
    endedAt: null,
    logCapped: false,
    notifyAgent: true,
    child,
    announced: false,
    stopRequested: false,
    escalateTimer: null
  }
  tasks.set(toolCallId, task)
  log.info(`start ${toolCallId} pid=${task.pid} session=${sessionId}: ${command.slice(0, 80)}`)

  const settled = new Promise<void>((resolve) => {
    child.once('exit', (code, signal) => {
      finishTask(task, code, signal)
      resolve()
    })
    child.once('error', (err) => {
      log.error(`spawn failed ${toolCallId}: ${err.message}`)
      finishTask(task, -1, null)
      resolve()
    })
  })

  ensureFstatTimer()

  // ── 预热窗口 ──
  const exitedEarly = await Promise.race([
    settled.then(() => true),
    new Promise<false>((r) => setTimeout(() => r(false), WARMUP_MS))
  ])

  if (exitedEarly) {
    const output = readWhole(logPath)
    tasks.delete(toolCallId)
    try {
      rmSync(logPath, { force: true })
    } catch {
      /* 忽略 */
    }
    log.info(`settled-in-warmup ${toolCallId} exit=${task.exitCode}`)
    return { kind: 'settled', info: toInfo(task), output }
  }

  broadcast(task)
  let logBytes = 0
  try {
    logBytes = statSync(logPath).size
  } catch {
    /* 忽略 */
  }
  return { kind: 'background', info: toInfo(task), logBytes }
}

function finishTask(task: BgTask, code: number | null, signal: NodeJS.Signals | null): void {
  if (task.status !== 'running') return
  if (task.escalateTimer) {
    clearTimeout(task.escalateTimer)
    task.escalateTimer = null
  }
  task.status = task.stopRequested ? 'killed' : 'exited'
  task.exitCode = code
  task.signal = signal
  task.endedAt = Date.now()
  log.info(`exit ${task.toolCallId} status=${task.status} code=${code} signal=${signal}`)
  // 从没宣告过 started 的任务（预热窗口内就退出）不广播 exited —— 否则前端会凭空多出
  // 一条随即被主进程清掉的幽灵条目。见 BgTask.announced 的说明。
  if (task.announced && tasks.get(task.toolCallId) === task) {
    broadcast(task)
    // 只对宣告过的任务通知 —— 预热窗口内退出的已经按前台形态把完整输出交给模型了，
    // 再通知一次纯属重复
    if (task.notifyAgent) {
      notifier?.(task.sessionId, formatExitNotice(task, readTail(task.logPath, NOTIFY_TAIL_BYTES)))
    }
  }
  maybeStopFstatTimer()
}

// ─── 控制 ────────────────────────────────────────────

/**
 * 停止任务。默认先 SIGINT 给进程清理机会，3 秒未退再 killProcessTree。
 * Windows 无进程组信号，直接走 taskkill /T /F。
 */
export function stopBgTask(toolCallId: string, force = false): boolean {
  const task = tasks.get(toolCallId)
  if (!task || task.status !== 'running') return false
  task.stopRequested = true

  if (force || process.platform === 'win32') {
    killProcessTree(task.pid)
    return true
  }

  try {
    // 负 pid = 整个进程组（spawn 时 detached，pid 即 pgid）
    process.kill(-task.pid, 'SIGINT')
  } catch {
    try {
      process.kill(task.pid, 'SIGINT')
    } catch {
      /* 已退出 */
    }
  }
  task.escalateTimer = setTimeout(() => {
    if (task.status === 'running') {
      log.warn(`escalate to SIGKILL ${toolCallId}`)
      killProcessTree(task.pid)
    }
  }, KILL_ESCALATE_MS)
  task.escalateTimer.unref?.()
  return true
}

/** 设置「完成时通知 AI」开关 */
export function setBgTaskNotify(toolCallId: string, enabled: boolean): boolean {
  const task = tasks.get(toolCallId)
  if (!task) return false
  task.notifyAgent = enabled
  return true
}

/** 移除一条已结束的任务（连同日志文件）。运行中的任务不移除 */
export function dismissBgTask(toolCallId: string): boolean {
  const task = tasks.get(toolCallId)
  if (!task || task.status === 'running') return false
  tasks.delete(toolCallId)
  try {
    rmSync(task.logPath, { force: true })
  } catch {
    /* 忽略 */
  }
  return true
}

/** 清空会话内所有已结束的任务 */
export function clearFinishedBgTasks(sessionId: string): number {
  let n = 0
  for (const task of [...tasks.values()]) {
    if (task.sessionId === sessionId && task.status !== 'running' && dismissBgTask(task.toolCallId))
      n++
  }
  return n
}

// ─── 级联清理 ────────────────────────────────────────

/**
 * 杀掉会话的全部任务并清空注册表（删除会话时调用）。
 * 日志文件不在此删除 —— sessionService.delete 会整目录 rm 掉 tool_results/<sid>。
 */
export function killBySession(sessionId: string): void {
  for (const task of [...tasks.values()]) {
    if (task.sessionId !== sessionId) continue
    if (task.status === 'running') {
      task.stopRequested = true
      killProcessTree(task.pid)
    }
    if (task.escalateTimer) clearTimeout(task.escalateTimer)
    tasks.delete(task.toolCallId)
  }
  maybeStopFstatTimer()
}

/** 应用退出：杀掉全部后台任务 */
export function killAllBgTasks(): void {
  for (const task of tasks.values()) {
    if (task.status === 'running') {
      task.stopRequested = true
      killProcessTree(task.pid)
    }
    if (task.escalateTimer) clearTimeout(task.escalateTimer)
  }
  tasks.clear()
  maybeStopFstatTimer()
}

// ─── 日志体检 ────────────────────────────────────────

/**
 * 输出不经 Node，字节数只能事后量。每 30s 对 running 任务 fstat 一次：
 * 超告警阈值标记 logCapped（面板提示 + 计入退出通知），超硬上限直接停止。
 */
function checkLogSizes(): void {
  for (const task of tasks.values()) {
    if (task.status !== 'running') continue
    let size = 0
    try {
      size = statSync(task.logPath).size
    } catch {
      continue
    }
    if (!task.logCapped && size >= LOG_WARN_BYTES) {
      task.logCapped = true
      log.warn(`log exceeds warn threshold ${task.toolCallId} size=${size}`)
    }
    if (size >= LOG_KILL_BYTES) {
      log.error(`log exceeds hard cap, stopping ${task.toolCallId} size=${size}`)
      stopBgTask(task.toolCallId, true)
    }
  }
}

function ensureFstatTimer(): void {
  if (fstatTimer) return
  fstatTimer = setInterval(checkLogSizes, FSTAT_INTERVAL_MS)
  // 不要因为这个定时器把进程留住
  fstatTimer.unref?.()
}

function maybeStopFstatTimer(): void {
  if (!fstatTimer) return
  for (const task of tasks.values()) if (task.status === 'running') return
  clearInterval(fstatTimer)
  fstatTimer = null
}

// ─── 回执文案 ────────────────────────────────────────

/** 停止该任务的命令（逐字给模型，它不需要知道 pgid 是怎么来的） */
export function stopCommandFor(info: BgTaskInfo): string {
  return process.platform === 'win32' ? `taskkill /T /F /PID ${info.pid}` : `kill -- -${info.pid}`
}

/** 停止命令的模板形态 —— 供参数 schema 描述使用（见 formatStartReceipt 关于指令归属的说明） */
export function stopCommandHint(): string {
  return process.platform === 'win32' ? 'taskkill /T /F /PID <pid>' : 'kill -- -<pid>'
}

/**
 * 启动回执 —— **只放模型无从得知的稳定事实**：pid、日志绝对路径，以及一个不引用内容的
 * 活性信号（预热窗口内已写入的字节数）。
 *
 * 刻意不放的四样，以及为什么：
 *
 *  - **日志内容采样（曾是尾部 5 行）**：t≈2s 的尾部是对启动输出的随机采样，与"命令成没
 *    成功"没有语义保证，却落在模型注意力最高的通道（工具结果）里 —— 一行 error 长相的
 *    启动噪音就足以把智能体带去排查一个不存在的问题；且结果永久留在上下文、每步重发，
 *    噪音会被一直重申。快速失败已由预热窗口的 settled 路径全量接住；readiness 则该由
 *    智能体在使用服务前 read 日志确认（这条引导写在 run_in_background 的参数 schema 里，
 *    走 prompt cache）。
 *  - **命令与 description**：模型自己刚写进 tool call 参数，纯重复。
 *  - **"用 read 读它 / 用 kill 停它" 这类指令**：指令属于参数 schema（每次请求随 tools 块
 *    发一份，走 prompt cache），不属于结果。工具结果会永久留在上下文里、被 agent loop
 *    每一步重发 —— 把用法说明写进结果等于按任务数征收永久 token 税。
 *  - **"其它还在跑的任务"**：那些任务自己的回执还在上下文里、pid 都带着；此处重列只多
 *    告诉模型"它们还活着"，而那正是退出通知（P4）负责的事。
 */
export function formatStartReceipt(info: BgTaskInfo, logBytes: number): string {
  const activity = logBytes > 0 ? `${logBytes} bytes of output so far` : 'no output yet'
  return `Background task started, pid ${info.pid} (${activity}). Output is being appended to:\n${info.logPath}`
}
