/**
 * 后台任务服务 —— `bash({ run_in_background: true })` 起的长驻进程
 * （Windows 上是 `powershell`，同一条路径；下文的「bash 任务」泛指两者，任务 kind 也都记作 'bash'）
 *
 * **簿记不在这里**：任务的身份、状态、等待者与完成通知归后台任务枢纽
 * （`services/taskRegistry` → `@shuvix/agent-runtime` 的 task/registry），bash、派生 agent
 * 与子会话三条线共用同一份。本文件只剩进程这一半：起进程、持句柄、定期 fstat、
 * 退出时把结果交回枢纽。设计见 docs/background-task-hub-design.md。
 *
 * 保留在这里的设计要点：
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
 *  3. **任务身份就是 toolCallId**，不另发明 id —— 枢纽接受调用方传入的 id，正为此。
 *
 *  4. **预热窗口就是一次同步等待**。`join(maxWait: 2s, onTimeout: 'detach')`：窗口内退出的
 *     命令按前台形态把完整输出回话（打错的命令即刻可见），到点还活着就转异步、进面板。
 *     「前台 / 后台」因此不是两套机制，只是这次 join 的两组参数。
 *
 *  5. **不接工具的 AbortSignal**。用户点「停止生成」不该杀后台任务 —— 那正是后台的意义。
 *     只有删除会话（sessionService.delete）与应用退出（before-quit）才级联杀。
 *
 *  6. **没有 stdin**。子进程的 fd 0 是 /dev/null，与前台形态完全一致 —— 读 stdin 立刻拿到 EOF。
 *     这里曾留一个管道供用户在面板上向任务输入，撤销了，两个理由：
 *       (a) 没人能可靠判断一个任务是不是正卡在等输入 —— 提示符常常不带换行，「在等输入」
 *           和「跑得慢」在日志里长得一模一样。那个输入框因此实际上没人用得上，
 *           而它的存在会让人以为后台任务支持交互。
 *       (b) libuv 在 Unix 上用 socketpair() 实现 'pipe' stdio，而 socket 型 stdin 会让 macOS
 *           的 bash 误判自己是被 sshd 拉起的，从而抢先执行用户的 ~/.bashrc（见 shell.ts 的
 *           BASH_ARGS 注释）。那条路已由 `--norc` 独立堵死，此处改成 /dev/null 是把触发条件
 *           本身也一并移除 —— 前台之所以从来不受影响，正是因为它的 stdin 是 /dev/null。
 *     需要真人参与的命令就不该跑在这里：把命令交给用户，让他在自己的终端里执行。
 */

import { spawn, type ChildProcess } from 'child_process'
import {
  openSync,
  closeSync,
  readSync,
  statSync,
  existsSync,
  rmSync,
  appendFileSync
} from 'node:fs'
import { join } from 'node:path'
import type { TaskInfo } from '@shuvix/agent-runtime'
import {
  killProcessTree,
  sanitizeBinaryOutput,
  shellInvocation,
  type ShellKind
} from '../utils/toolUtils/shell'
import { buildSpawnEnv, getToolResultsDir } from '../utils/paths'
import { createLogger } from '../logger'
import { taskRegistry, toBgTaskInfo, setTaskNotifier, type TaskNotifier } from './taskRegistry'
import type { BgTaskInfo, BgTaskLogChunk, BgTaskStatus } from '@shuvix/chat-protocol/types/bgTask'

export type { BgTaskInfo, BgTaskLogChunk, BgTaskStatus }

const log = createLogger('BgTask')

// ─── 常量 ────────────────────────────────────────────

/** 预热窗口：异步形态启动后等这么久，期间退出的命令当场回话（打错命令 / 缺依赖即刻可见） */
const WARMUP_MS = 2000
/**
 * 同步形态跑够这么久才进面板。
 *
 * 一条 `ls` 不该在面板里留下痕迹，而一条跑了半分钟的 `npm test` 该让人看得见、
 * 看得到实时输出、也停得掉。阈值取得和预热窗口一样，纯属两件事恰好都是「2 秒还没完
 * 就不是一次性的小命令了」。
 */
const ANNOUNCE_SYNC_MS = 2000
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
/** 退出通知里回显的日志行数上限 —— 通知会打断智能体当前思路，必须短 */
const NOTIFY_TAIL_LINES = 20

// ─── 进程簿记 ────────────────────────────────────────

/**
 * 本服务只持有枢纽表达不了的那一半：子进程句柄、日志路径、升级定时器。
 * 状态、通知开关、等待者全在枢纽里，**不在这里留第二份**。
 */
interface BgProc {
  sessionId: string
  /** 异步形态（调用方会放手）—— 后台并发上限只卡这一类 */
  background: boolean
  child: ChildProcess
  logPath: string
  /** 已请求停止 —— 退出时据此把状态记为 killed 而非 exited */
  stopRequested: boolean
  /** SIGINT → SIGKILL 的升级定时器 */
  escalateTimer: NodeJS.Timeout | null
}

/** toolCallId → 进程簿记 */
const procs = new Map<string, BgProc>()

let fstatTimer: NodeJS.Timeout | null = null

/**
 * 一次命令的结局。
 *
 * `settled` = 这次调用等到了结果（含被超时/中止杀掉的），`output` 是日志全文；
 * `background` = 它还活着，本次调用不再等。两者是**同一条路径的两种等待策略**，
 * 不是两种命令。
 */
export type CommandOutcome =
  | {
      kind: 'settled'
      info: BgTaskInfo
      output: string
      /** 'finished' 自己跑完的；'timeout' 到点被杀；'abort' 用户点了停止生成 */
      reason: 'finished' | 'timeout' | 'abort'
    }
  | { kind: 'background'; info: BgTaskInfo; logBytes: number }

export interface RunCommandParams {
  sessionId: string
  toolCallId: string
  /** 跑命令的 shell —— 与发起它的命令工具同名（bash / powershell），各自只在自己的平台上存在 */
  shell: ShellKind
  command: string
  description: string
  cwd: string
  /** 注入子进程的额外环境变量（项目 env + SHUVIX_SESSION_ID） */
  extraEnv?: Record<string, string>
  /**
   * 异步形态：预热窗口内没落定就转后台、脱离本次调用。
   * 同步形态（false）等到命令结束，到点按 `timeoutMs` 杀。
   */
  background: boolean
  /** 同步形态的上限（毫秒）；省略或 <=0 = 不限时。异步形态忽略它（恒用预热窗口） */
  timeoutMs?: number
  /** 同步形态的中止信号。异步形态刻意不接 —— 那正是后台的意义（见文件头第 5 点） */
  signal?: AbortSignal
}

/** 退出通知实现的注入口 —— 保留旧名，转接到枢纽（调用方是 sessionService） */
export type BgTaskNotifier = TaskNotifier
export function setBgTaskNotifier(fn: BgTaskNotifier): void {
  setTaskNotifier(fn)
}

// ─── 查询 ────────────────────────────────────────────

/**
 * 当前会话**脱离了调用方**的运行中任务数（后台形态的并发上限按它卡）。
 *
 * 同步形态的命令不算：它占着一次工具调用，并发度早被模型自己的调用数卡死了，
 * 而把它算进来会让「同时跑两条 npm test」莫名其妙地撞上后台任务的上限。
 */
export function runningCount(sessionId: string): number {
  let n = 0
  for (const [toolCallId, proc] of procs) {
    if (!proc.background || proc.sessionId !== sessionId) continue
    if (taskRegistry.get(toolCallId)?.endedAt === null) n++
  }
  return n
}

/** 会话的全部任务（含已结束的，按启动时间正序） */
export function listBgTasks(sessionId: string): BgTaskInfo[] {
  return taskRegistry
    .list(sessionId)
    .map(toBgTaskInfo)
    .filter((info): info is BgTaskInfo => info !== null)
}

export function getBgTask(toolCallId: string): BgTaskInfo | undefined {
  const task = taskRegistry.get(toolCallId)
  return task ? (toBgTaskInfo(task) ?? undefined) : undefined
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
  const logPath = procs.get(params.toolCallId)?.logPath
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

// ─── 退出通知文案 ────────────────────────────────────

/**
 * 退出通知文案。带上日志绝对路径而不只是尾部若干行：智能体要看全的话
 * read 那个文件是免询问的，比让它去猜路径便宜得多。
 */
function formatExitNotice(task: TaskInfo, tail: string): string {
  if (task.subject.kind !== 'bash') return ''
  const { pid, command, logPath, signal, exitCode } = task.subject
  const status =
    task.status === 'killed'
      ? 'stopped by the user'
      : signal
        ? `killed by ${signal}`
        : `exited with code ${exitCode}`
  const seconds = Math.round(((task.endedAt ?? Date.now()) - task.startedAt) / 1000)
  const lines = [
    `<background-task pid="${pid}" status="${status}" duration="${seconds}s">`,
    command
  ]
  const trimmed = tail.trimEnd()
  if (trimmed) {
    lines.push('Last output:')
    lines.push(...trimmed.split('\n').slice(-NOTIFY_TAIL_LINES))
  }
  lines.push(`Full log: ${logPath}`, '</background-task>')
  return lines.join('\n')
}

// ─── 启动 ────────────────────────────────────────────

/**
 * 跑一条命令。**调用方须已通过安全模块的命令门**（enforceCommand）——
 * 本服务不做准入判断，只负责执行与簿记。
 *
 * **同步与异步是同一条路径的两组等待参数**（见文件头第 4 点），spawn / 日志 / 杀进程
 * 三件事只有一份实现：
 *
 *   同步：`join(maxWait: timeoutMs, onTimeout: 'kill', signal, onAbort: 'kill')`
 *         —— 到点或被中止就下死手（调用方正等着结果，先温和再升级只是让它多等几秒）；
 *         跑够 `ANNOUNCE_SYNC_MS` 才进面板，于是能看实时输出、也能从面板停掉。
 *   异步：`join(maxWait: WARMUP_MS, onTimeout: 'detach')`
 *         —— 窗口内退出的当场把全文回话（打错的命令即刻可见，面板不留秒退的僵尸条目）。
 *
 * 两种形态都把 stdout+stderr 合并写进同一个日志文件：输出不经 Node，**交错顺序是真的**
 * （旧的同步形态分别收集两条管道再拼，交错从那时就丢了）。
 */
export async function runCommand(params: RunCommandParams): Promise<CommandOutcome> {
  const { sessionId, toolCallId, command, description, cwd, extraEnv, background } = params
  const logPath = join(getToolResultsDir(sessionId), `${toolCallId}.log`)
  const invocation = shellInvocation(params.shell, command)

  // Windows 上不能用 'a'：libuv 以 append-only 访问权（FILE_APPEND_DATA，无 FILE_WRITE_DATA）
  // 打开 O_APPEND 文件，而 MSYS2/cygwin 程序（Git for Windows 带的 ls / grep 等，PowerShell 里
  // 照样能调到）对磁盘文件按偏移写，往这种继承句柄写字节拿不到 —— 日志恒为空，且最后一次
  // 写失败会把退出码带成 1。
  // logPath 按 toolCallId 唯一、不存在跨调用追加的场景，'w' 与 'a' 等价；POSIX 保持 'a'。
  // 回归测试：services/__tests__/bgTaskService.test.ts
  const fd = openSync(logPath, process.platform === 'win32' ? 'w' : 'a')
  let child: ChildProcess
  try {
    child = spawn(invocation.file, invocation.args, {
      cwd,
      env: buildSpawnEnv(extraEnv),
      // stdin 恒为 /dev/null（见文件头第 6 点）；stdout/stderr 同一个 fd
      stdio: ['ignore', fd, fd],
      detached: process.platform !== 'win32',
      // Windows：GUI 进程（Electron）拉起控制台程序（powershell.exe）时，不带 CREATE_NO_WINDOW
      // 就会给它新开一个可见的控制台窗口 —— 每条命令闪一下黑框。隐藏后子进程拿到的是
      // 无窗口的控制台，命令里再起的 git/node 等继承它，也不会各自再弹。POSIX 上无作用
      windowsHide: true
    })
  } finally {
    // uv_spawn 在 spawn() 内部同步把 fd dup 进子进程，此处关闭是安全的
    try {
      closeSync(fd)
    } catch {
      /* 忽略 */
    }
  }

  const proc: BgProc = {
    sessionId,
    background,
    child,
    logPath,
    stopRequested: false,
    escalateTimer: null
  }
  procs.set(toolCallId, proc)

  taskRegistry.create({
    taskId: toolCallId,
    kind: 'bash',
    sessionId,
    // 面板行的标题用 description 而非命令：命令太长、前缀又常常雷同
    title: description,
    subject: {
      kind: 'bash',
      command,
      cwd,
      pid: child.pid ?? -1,
      logPath,
      exitCode: null,
      signal: null,
      logCapped: false
    },
    // 异步形态：预热窗口内退出的不该进面板（完整输出已当场回话），而转异步那一刻
    // 枢纽会无条件宣告，所以这里不设阈值；同步形态：跑够阈值才值得占一行
    announceAfter: background ? Number.POSITIVE_INFINITY : ANNOUNCE_SYNC_MS,
    formatNotice: (task) => formatExitNotice(task, readTail(logPath, NOTIFY_TAIL_BYTES)),
    stop: (force) => killProc(toolCallId, force)
  })
  log.info(
    `start ${toolCallId} pid=${child.pid} session=${sessionId} ` +
      `${background ? 'background' : 'sync'}: ${command.slice(0, 80)}`
  )

  child.once('exit', (code, signal) => finishTask(toolCallId, code, signal))
  child.once('error', (err) => {
    log.error(`spawn failed ${toolCallId}: ${err.message}`)
    // 失败原因写进日志：同步形态的结果就是日志全文，不写的话模型只拿到一个空输出 + exit -1
    try {
      appendFileSync(logPath, `[spawn failed] ${err.message}\n`)
    } catch {
      /* 忽略 */
    }
    finishTask(toolCallId, -1, null)
  })

  ensureFstatTimer()

  const timeoutMs = params.timeoutMs
  const outcome = await taskRegistry.join(
    toolCallId,
    background
      ? { maxWait: WARMUP_MS, onTimeout: 'detach' }
      : {
          maxWait: timeoutMs && timeoutMs > 0 ? timeoutMs : undefined,
          onTimeout: 'kill',
          killForce: true,
          signal: params.signal,
          onAbort: 'kill'
        }
  )
  const info = outcome && toBgTaskInfo(outcome.task)
  if (!info) throw new Error(`Command task ${toolCallId} vanished while starting`)

  if (outcome.kind === 'detached') {
    let logBytes = 0
    try {
      logBytes = statSync(logPath).size
    } catch {
      /* 忽略 */
    }
    return { kind: 'background', info, logBytes }
  }

  const output = readWhole(logPath)
  // 没进过面板的任务连日志一起销掉 —— 它在界面上从不存在，留着只是垃圾；
  // 进过面板的留着，那一行还要能展开看输出（用户点「移除」或「清空」时才收）
  if (!isAnnounced(toolCallId)) dismissBgTask(toolCallId)
  log.info(`settled ${toolCallId} reason=${outcome.reason} exit=${info.exitCode}`)
  return { kind: 'settled', info, output, reason: outcome.reason }
}

/** 这条任务进没进过面板（枢纽的 list 只给宣告过的） */
function isAnnounced(toolCallId: string): boolean {
  const task = taskRegistry.get(toolCallId)
  return !!task && taskRegistry.list(task.sessionId).some((t) => t.taskId === toolCallId)
}

/** 进程退出：把结果交回枢纽（解挂等待者，没人等的话由枢纽发通知） */
function finishTask(toolCallId: string, code: number | null, signal: NodeJS.Signals | null): void {
  const proc = procs.get(toolCallId)
  if (!proc) return
  if (proc.escalateTimer) {
    clearTimeout(proc.escalateTimer)
    proc.escalateTimer = null
  }
  const status = proc.stopRequested ? 'killed' : code === 0 ? 'done' : 'error'
  log.info(`exit ${toolCallId} status=${status} code=${code} signal=${signal}`)
  taskRegistry.settle(toolCallId, { status, subject: { exitCode: code, signal } })
  maybeStopFstatTimer()
}

// ─── 控制 ────────────────────────────────────────────

/**
 * 停止实现（注入给枢纽）。默认先 SIGINT 给进程清理机会，3 秒未退再 killProcessTree。
 * Windows 无进程组信号，直接走 taskkill /T /F。
 */
function killProc(toolCallId: string, force: boolean): void {
  const proc = procs.get(toolCallId)
  if (!proc) return
  proc.stopRequested = true

  if (force || process.platform === 'win32') {
    killProcessTree(proc.child.pid ?? -1)
    return
  }

  const pid = proc.child.pid ?? -1
  try {
    // 负 pid = 整个进程组（spawn 时 detached，pid 即 pgid）
    process.kill(-pid, 'SIGINT')
  } catch {
    try {
      process.kill(pid, 'SIGINT')
    } catch {
      /* 已退出 */
    }
  }
  proc.escalateTimer = setTimeout(() => {
    if (taskRegistry.get(toolCallId)?.endedAt === null) {
      log.warn(`escalate to SIGKILL ${toolCallId}`)
      killProcessTree(pid)
    }
  }, KILL_ESCALATE_MS)
  proc.escalateTimer.unref?.()
}

/** 用户从面板停止任务（停完仍会通知智能体 —— 停它的不是它自己） */
export function stopBgTask(toolCallId: string, force = false): boolean {
  return taskRegistry.stop(toolCallId, { by: 'user', force })
}

/** 丢掉本地簿记（可选连日志文件一起删） */
function forget(toolCallId: string, opts: { removeLog?: boolean } = {}): void {
  const proc = procs.get(toolCallId)
  if (!proc) return
  if (proc.escalateTimer) clearTimeout(proc.escalateTimer)
  procs.delete(toolCallId)
  if (opts.removeLog) {
    try {
      rmSync(proc.logPath, { force: true })
    } catch {
      /* 忽略 */
    }
  }
}

/** 移除一条已结束的任务（连同日志文件）。运行中的任务不移除 */
export function dismissBgTask(toolCallId: string): boolean {
  if (!taskRegistry.dismiss(toolCallId)) return false
  forget(toolCallId, { removeLog: true })
  return true
}

/**
 * 清空会话内所有已结束的任务 —— **三类都清**（面板的「清空」按钮是整张表的）。
 * bash 那些顺带把日志文件删掉，其余的枢纽自己销账即可。
 */
export function clearFinishedBgTasks(sessionId: string): number {
  for (const [toolCallId, proc] of [...procs.entries()]) {
    if (proc.sessionId !== sessionId) continue
    if (taskRegistry.get(toolCallId)?.endedAt !== null) forget(toolCallId, { removeLog: true })
  }
  return taskRegistry.clearFinished(sessionId)
}

// ─── 级联清理 ────────────────────────────────────────

/**
 * 杀掉会话的全部任务并清空簿记（删除会话时调用）。
 * 日志文件不在此删除 —— sessionService.delete 会整目录 rm 掉 tool_results/<sid>。
 */
export function killBySession(sessionId: string): void {
  // 枢纽会对每条运行中的任务回调 killProc(force=true)，本地不再重复杀
  taskRegistry.killBySession(sessionId)
  for (const [toolCallId, proc] of [...procs.entries()]) {
    if (proc.sessionId === sessionId) forget(toolCallId)
  }
  maybeStopFstatTimer()
}

/** 应用退出：杀掉全部后台任务 */
export function killAllBgTasks(): void {
  taskRegistry.killAll()
  for (const toolCallId of [...procs.keys()]) forget(toolCallId)
  maybeStopFstatTimer()
}

// ─── 日志体检 ────────────────────────────────────────

/**
 * 输出不经 Node，字节数只能事后量。每 30s 对 running 任务 fstat 一次：
 * 超告警阈值标记 logCapped（面板提示 + 计入退出通知），超硬上限直接停止。
 */
function checkLogSizes(): void {
  for (const [toolCallId, proc] of procs.entries()) {
    const task = taskRegistry.get(toolCallId)
    if (!task || task.endedAt !== null || task.subject.kind !== 'bash') continue
    let size = 0
    try {
      size = statSync(proc.logPath).size
    } catch {
      continue
    }
    if (!task.subject.logCapped && size >= LOG_WARN_BYTES) {
      taskRegistry.update(toolCallId, { subject: { logCapped: true } })
      log.warn(`log exceeds warn threshold ${toolCallId} size=${size}`)
    }
    if (size >= LOG_KILL_BYTES) {
      log.error(`log exceeds hard cap, stopping ${toolCallId} size=${size}`)
      // 按「用户停的」记 —— 智能体没停过它，这条结束必须通知到它
      stopBgTask(toolCallId, true)
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
  for (const toolCallId of procs.keys()) {
    if (taskRegistry.get(toolCallId)?.endedAt === null) return
  }
  clearInterval(fstatTimer)
  fstatTimer = null
}

// ─── 回执文案 ────────────────────────────────────────

/** 停止该任务的命令（逐字给模型，它不需要知道 pgid 是怎么来的） */
export function stopCommandFor(info: BgTaskInfo): string {
  return process.platform === 'win32' ? `taskkill /T /F /PID ${info.pid}` : `kill -- -${info.pid}`
}

/**
 * 停止命令的模板形态 —— 供参数 schema 描述使用（见 formatStartReceipt 关于指令归属的说明）。
 * 按 shell 而不是按当前平台给：设置页在任何平台上都要展示两个工具各自真实的描述。
 */
export function stopCommandHint(shell: ShellKind): string {
  return shell === 'powershell' ? 'taskkill /T /F /PID <pid>' : 'kill -- -<pid>'
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
