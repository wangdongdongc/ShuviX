/**
 * 远端任务 —— ssh `exec` 的命令跑在远端一个脱离连接的 runner 里，本机用可重连的轮询把结果取回来。
 *
 * 设计见 docs/ssh-background-task-design.md。要点：
 *
 *  1. **网络断了命令照跑，结果不丢**。runner 把输出写进远端文件、退出码经 `exit.tmp` + `mv` 落盘；
 *     本机这一侧只是一个轮询者，连接断了就退避重连、从上次的字节偏移接着取（脚本见 sshRemoteScripts）。
 *  2. **前台 / 后台只是 join 的两组参数**，与本机命令（bgTaskService）同构：任务登记在同一个枢纽里
 *     （kind 'bash'，subject 带 `host`），前台等到结束或超时（超时 = 停掉远端进程组），后台在启动窗口后
 *     脱离、进面板、结束时由枢纽发 `<background-task host=…>` 通知。
 *  3. **日志镜像到本机** `tool_results/<sessionId>/<taskId>.log`：每轮轮询把新字节追加进去。于是 agent 用
 *     read 读（免询问）、面板实时输出、通知尾部全部是本机任务那一套，远端只多一个 host 标签。
 *  4. **寿命跟本机后台任务走**（用户裁定 2026-10-31）：本机任务只在内存里、退出即杀，所以远端任务在 App
 *     退出、会话删除时经**脱离的** ssh 停掉并删目录（不拖慢退出）；崩溃时来不及的，由下一轮运行第一次连这台
 *     主机时的清理（探测脚本里的 sweep）补上。
 *  5. **不是每台远端都跑得了**：探测失败（Windows、受限 shell、home 不可写、连进程组都建不了）就回退到
 *     原来的直连 exec，由 sshServer 决定（hostMode）。
 *
 * 本模块是 builtinMcp 这个内聚模块的一部分，不能反向依赖 services/ 根目录的平铺服务：枢纽实例、设置读写与
 * 镜像目录由启动时注入（setRemoteTaskHost）—— 也让本模块不碰数据库与 Electron，单测直接起得来。
 */
import { createHash, randomBytes, randomUUID } from 'crypto'
import {
  appendFileSync,
  closeSync,
  existsSync,
  openSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import { hostname, userInfo } from 'os'
import { join } from 'path'
import type { TaskInfo, TaskRegistry, TaskStatus } from '@shuvix/agent-runtime'
import { sanitizeBinaryOutput } from '../../utils/toolUtils/shell'
import { createLogger } from '../../logger'
import { classifySshFailure, sshScript, sshScriptDetached, type SshExecResult } from './sshControl'
import {
  ORIGIN_SCHEMA,
  TASK_SCHEMA,
  buildKillScript,
  buildLaunchScript,
  buildPollScript,
  buildProbeScript,
  buildReapScript,
  buildStopScript,
  parseProbe,
  parseReport,
  remoteTaskDirName,
  type ProbeResult,
  type RemoteReport
} from './sshRemoteScripts'

const log = createLogger('ssh:tasks')

/** 启动时远端原地等多久（秒）：窗口内结束的一个来回就回话，远端不留东西 */
let LAUNCH_WAIT_SEC = 2
/** 一轮长轮询远端至多等多久（秒） */
let POLL_WAIT_SEC = 25
/** 一轮带回的日志上限（字节）；超过的下一轮立刻接着取 */
const CAP_BYTES = 1024 * 1024
/** 前台命令跑够这么久才进面板（与本机前台命令同一个阈值） */
const ANNOUNCE_SYNC_MS = 2000
/** 每会话同时运行的远端后台任务上限（与本机后台任务同值） */
export const MAX_REMOTE_BACKGROUND_PER_SESSION = 8
/** 请求停止后这么久还没收到远端确认：本机先按「已停」落定，停止指令在后台接着送 */
let STOP_CONFIRM_MS = 10_000
/** 日志告警 / 自动停止阈值（与本机后台任务同值） */
const LOG_WARN_BYTES = 50 * 1024 * 1024
const LOG_KILL_BYTES = 1024 * 1024 * 1024
/** 清理：本安装上一轮运行留下的任务多久没人 poll 算没人管（秒）；结束多久的任务删掉（天） */
const SWEEP_STALE_SEC = 120
const SWEEP_GC_DAYS = 7
/** 退出通知里回显的日志尾部 */
const NOTIFY_TAIL_BYTES = 4096
const NOTIFY_TAIL_LINES = 20
/** 收全之后请远端删目录，试这么多次还不成就留给下一轮运行的清理（7 天） */
const REAP_ATTEMPTS = 8
/** 重连退避（毫秒），用到最后一档就一直用它 */
let BACKOFF_MS = [1000, 2000, 4000, 8000, 15_000, 30_000, 60_000]

const INSTALL_ID_KEY = 'ssh.remoteInstallId'

// ─── 身份 ────────────────────────────────────────────

/** 启动时注入的宿主能力 */
export interface RemoteTaskHost {
  /** 后台任务枢纽（services/taskRegistry 的那一份） */
  registry: TaskRegistry
  /** 设置表读写（存本安装的 id） */
  settings: { get(key: string): string | undefined; set(key: string, value: string): void }
  /** 会话的 tool_results 目录（镜像日志放这里，与本机后台任务的日志同处） */
  toolResultsDir(sessionId: string): string
}

let host: RemoteTaskHost | null = null
let hub: TaskRegistry | null = null

/** 启动时注入；没注入 = 只能走直连 */
export function setRemoteTaskHost(h: RemoteTaskHost | null): void {
  host = h
  hub = h?.registry ?? null
  installIdCache = undefined
}

let installIdCache: string | undefined

/**
 * 本安装的 id —— 远端目录 `~/.shuvix-ssh/<installId>/` 的名字。每个数据目录生成一次（dev / 正式版 / e2e
 * 各不相同），于是两个 ShuviX（包括远端自己装的那一个）在同一台机器上各管各的目录。
 */
export function remoteInstallId(): string {
  if (installIdCache) return installIdCache
  const stored = host?.settings.get(INSTALL_ID_KEY)
  if (stored && /^[A-Za-z0-9_-]{1,80}$/.test(stored)) {
    installIdCache = stored
    return stored
  }
  const id = randomUUID()
  host?.settings.set(INSTALL_ID_KEY, id)
  installIdCache = id
  return id
}

/** 本次运行的 id：清理据它认出「上一轮运行留下的」 */
export const REMOTE_RUN_ID = randomUUID()

// ─── 探测 ────────────────────────────────────────────

export type HostMode =
  | { kind: 'runner'; probe: ProbeResult; systemd: boolean; note?: string }
  /** quiet：本宿主根本没有远端任务（没注入），不是这台主机跑不了 —— 不必提醒 agent */
  | { kind: 'direct'; reason: string; quiet?: true }
  /** 连不上（ssh 自己失败）：不缓存，原样交回调用方翻译 */
  | { kind: 'unreachable'; result: SshExecResult }

/** 每台主机每次运行探测一次（连不上的不缓存） */
const probes = new Map<string, Promise<HostMode>>()

function probeKey(alias: string, configPath: string | undefined): string {
  return `${configPath ?? ''}\0${alias}`
}

/**
 * 这台远端怎么跑命令。第一次问时连上去探测，顺手清理本安装上一轮运行留下的任务（一个来回）。
 */
export function hostMode(opts: {
  sessionId: string
  alias: string
  configPath?: string
}): Promise<HostMode> {
  if (!hub) {
    return Promise.resolve({
      kind: 'direct',
      reason: 'remote tasks are not available',
      quiet: true
    })
  }
  const key = probeKey(opts.alias, opts.configPath)
  const cached = probes.get(key)
  if (cached) return cached
  const pending = probeHost(opts).then((mode) => {
    if (mode.kind === 'unreachable') probes.delete(key)
    return mode
  })
  probes.set(key, pending)
  return pending
}

async function probeHost(opts: {
  sessionId: string
  alias: string
  configPath?: string
}): Promise<HostMode> {
  let result: SshExecResult
  try {
    result = await sshScript({
      sessionId: opts.sessionId,
      alias: opts.alias,
      configPath: opts.configPath,
      script: buildProbeScript({
        installId: remoteInstallId(),
        runId: REMOTE_RUN_ID,
        staleSec: SWEEP_STALE_SEC,
        gcDays: SWEEP_GC_DAYS
      }),
      timeoutSec: 30
    })
  } catch (e) {
    return { kind: 'direct', reason: e instanceof Error ? e.message : String(e) }
  }
  const probe = parseProbe(result.stdout)
  if (!probe) {
    if (result.exitCode === 255 || result.timedOut) return { kind: 'unreachable', result }
    log.info(`probe ${opts.alias}: no POSIX sh, direct exec`)
    return { kind: 'direct', reason: 'it has no POSIX shell that ShuviX can drive' }
  }
  log.info(
    `probe ${opts.alias}: os=${probe.os} group=${probe.group} home=${probe.homeWritable} ` +
      `kup=${probe.killUserProcesses} linger=${probe.linger} orphaned=${probe.orphaned} gc=${probe.collected}`
  )
  if (!probe.homeWritable) return { kind: 'direct', reason: 'its home folder is not writable' }
  if (probe.group === 'none') {
    return { kind: 'direct', reason: 'it has neither setsid nor bash to run a command as a group' }
  }
  if (probe.killUserProcesses && probe.linger && probe.systemdRun) {
    return { kind: 'runner', probe, systemd: true }
  }
  if (probe.killUserProcesses) {
    return {
      kind: 'runner',
      probe,
      systemd: false,
      note: `On "${opts.alias}" the system stops a user's processes when their login session ends, so a dropped connection stops commands there. Running \`loginctl enable-linger\` on that machine (no root needed for yourself) lets them keep running.`
    }
  }
  return { kind: 'runner', probe, systemd: false }
}

// ─── 任务簿记 ────────────────────────────────────────

interface Entry {
  taskId: string
  sessionId: string
  alias: string
  configPath?: string
  /** 远端目录名 */
  dir: string
  command: string
  background: boolean
  /** 本机镜像 */
  logPath: string
  /** 镜像里已有的字节数 = 下一轮从哪儿接着取 */
  mirrored: number
  /** 远端 out.log 最近一次报的大小 */
  remoteSize: number
  /** 结束了、字节也收全了：只剩请远端删目录 */
  complete: boolean
  /** 远端目录已删（收全后的 reap，或远端早已没有这个目录） */
  reaped: boolean
  /** 枢纽已落定 */
  settled: boolean
  /** 有人要它停（超时、中止、面板、智能体） */
  stopWanted: boolean
  stopDelivered: boolean
  stopInFlight: boolean
  /** 删会话 / 退出：不再轮询，结局不再关心 */
  closed: boolean
  /** 结果尾部要附上的说明（前台回话 / 退出通知） */
  notes: string[]
}

const entries = new Map<string, Entry>()

function hashId(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

/** 这条会话运行中的远端后台任务数 */
export function runningRemoteBackgroundCount(sessionId: string): number {
  let n = 0
  for (const e of entries.values()) {
    if (e.sessionId === sessionId && e.background && !e.settled) n++
  }
  return n
}

// ─── 运行 ────────────────────────────────────────────

export interface RemoteRunParams {
  sessionId: string
  toolCallId: string
  alias: string
  configPath?: string
  command: string
  description: string
  background: boolean
  /** 前台的总时限（秒） */
  timeoutSec: number
  /** 前台的中止信号；后台刻意不接（与本机后台任务同理） */
  signal?: AbortSignal
  mode: Extract<HostMode, { kind: 'runner' }>
}

export type RemoteRunOutcome =
  | {
      kind: 'settled'
      /** 日志全文（已清洗）+ 说明 */
      output: string
      exitCode: number | null
      reason: 'finished' | 'timeout' | 'abort'
      status: TaskStatus
    }
  | { kind: 'background'; taskId: string; logPath: string; logBytes: number }
  /** 起不来：ssh 连不上、远端建不了目录、runner 没起来 */
  | { kind: 'failed'; message: string }

/**
 * 在远端跑一条命令。调用方须已通过安全模块的命令门（enforceCommand）。
 */
export async function runRemoteCommand(p: RemoteRunParams): Promise<RemoteRunOutcome> {
  const registry = hub
  if (!registry || !host) return { kind: 'failed', message: 'Remote tasks are not available.' }
  const startedAt = Date.now()
  const installId = remoteInstallId()
  const callSuffix = randomBytes(3).toString('hex')
  const dir = remoteTaskDirName(p.toolCallId, hashId, callSuffix)
  // 任务 id 就是 tool call id（与本机命令一样）；有的供应商每轮从头编号，同一个 id 还被前一条占着时
  // 加上这次调用的后缀 —— 否则后一条会冲掉前一条的镜像、面板行与簿记，前一条结束时谁也不知道
  const taskId =
    registry.get(p.toolCallId) || entries.has(p.toolCallId)
      ? `${p.toolCallId}~${callSuffix}`
      : p.toolCallId
  const logPath = join(host.toolResultsDir(p.sessionId), `${taskId}.log`)
  writeFileSync(logPath, '')

  const e: Entry = {
    taskId,
    sessionId: p.sessionId,
    alias: p.alias,
    configPath: p.configPath,
    dir,
    command: p.command,
    background: p.background,
    logPath,
    mirrored: 0,
    remoteSize: 0,
    complete: false,
    reaped: false,
    settled: false,
    stopWanted: false,
    stopDelivered: false,
    stopInFlight: false,
    closed: false,
    notes: p.mode.note ? [p.mode.note] : []
  }
  entries.set(e.taskId, e)

  const launch = buildLaunchScript({
    installId,
    runId: REMOTE_RUN_ID,
    dir,
    waitSec: LAUNCH_WAIT_SEC,
    capBytes: CAP_BYTES,
    manifest: {
      schema: TASK_SCHEMA,
      kind: 'ssh-command',
      mode: p.background ? 'background' : 'foreground',
      installId,
      runId: REMOTE_RUN_ID,
      taskId: p.toolCallId,
      sessionId: p.sessionId,
      description: p.description,
      command: p.command,
      origin: { hostname: hostname(), user: safeUser() },
      startedAt: new Date(startedAt).toISOString()
    },
    origin: {
      schema: ORIGIN_SCHEMA,
      installId,
      hostname: hostname(),
      user: safeUser(),
      app: 'ShuviX',
      firstSeen: new Date(startedAt).toISOString()
    },
    command: p.command,
    systemdUnit: p.mode.systemd
      ? `shuvix-task-${hashId(`${installId}/${dir}`).slice(0, 16)}`
      : undefined,
    random: () => randomBytes(8).toString('hex')
  })

  // 启动：连不上（指纹、认证、解析、拒绝、超时）当场交回；连上之后断了的，启动脚本可重放，接着试
  const deadline = p.background ? startedAt + 60_000 : startedAt + p.timeoutSec * 1000
  const first = await launchWithRetry(e, launch, deadline, p.signal)
  if (first.kind === 'failed') {
    entries.delete(e.taskId)
    rmSync(logPath, { force: true })
    // 脚本可能已经送到、命令可能已经起来了（断线、超时、中止都分不清）：停掉它。本轮运行的清理不会再
    // 来管它（探测一轮只一次，清理也不碰本轮的任务）
    if (first.maybeStarted) sendKill(e)
    return { kind: 'failed', message: first.message }
  }
  // 启动途中会话被删 / App 在退出：那次停止可能早于目录建好，再停一次；不登记、不等
  if (e.closed) {
    entries.delete(e.taskId)
    rmSync(logPath, { force: true })
    sendKill(e)
    return { kind: 'failed', message: 'The session closed while the command was starting.' }
  }

  // 启动成功才登记：起不来的不该在面板里留一行，更不该在落定时发一条「后台任务结束」的通知
  registry.create({
    taskId: e.taskId,
    kind: 'bash',
    sessionId: p.sessionId,
    title: p.description,
    subject: {
      kind: 'bash',
      command: p.command,
      // 面板的终端视图把它画成提示符：一眼看出这条命令在哪台机器上
      cwd: `${p.alias}:~`,
      pid: -1,
      logPath,
      exitCode: null,
      signal: null,
      logCapped: false,
      host: p.alias
    },
    announceAfter: p.background
      ? Number.POSITIVE_INFINITY
      : Math.max(0, ANNOUNCE_SYNC_MS - (Date.now() - startedAt)),
    formatNotice: (task) => formatRemoteNotice(e, task),
    stop: () => requestStop(e)
  })

  // 先挂上等待者、再收第一轮回执：窗口内就结束的，落定时有人在等 → 结果由这次调用交回，不发通知
  const remaining = Math.max(0, deadline - Date.now())
  const joined = registry.join(
    e.taskId,
    p.background
      ? { maxWait: 0, onTimeout: 'detach' }
      : {
          maxWait: remaining,
          onTimeout: 'kill',
          killForce: true,
          signal: p.signal,
          onAbort: 'kill'
        }
  )
  applyReport(e, first.report)
  // 轮询直到结束；结束了也要它来请远端删目录（窗口内结束的同样如此）
  void drive(e)
  const outcome = await joined
  if (!outcome) return { kind: 'failed', message: 'The remote task vanished while starting.' }
  if (outcome.kind === 'detached') {
    return { kind: 'background', taskId: e.taskId, logPath, logBytes: e.mirrored }
  }

  const output = readMirror(logPath) + (e.notes.length ? `\n\n${e.notes.join('\n')}` : '')
  const exitCode = outcome.task.subject.kind === 'bash' ? outcome.task.subject.exitCode : null
  // 没进过面板的连镜像一起销掉 —— 它在界面上从不存在（与本机前台命令同一条规矩）
  if (!registry.list(p.sessionId).some((t) => t.taskId === e.taskId)) {
    registry.dismiss(e.taskId)
    rmSync(logPath, { force: true })
  }
  return { kind: 'settled', output, exitCode, reason: outcome.reason, status: outcome.task.status }
}

function safeUser(): string {
  try {
    return userInfo().username
  } catch {
    return ''
  }
}

type LaunchResult =
  | { kind: 'ok'; report: RemoteReport }
  /** maybeStarted：脚本可能已经送到、命令可能已经在跑 —— 调用方要停掉它 */
  | { kind: 'failed'; message: string; maybeStarted: boolean }

async function launchWithRetry(
  e: Entry,
  script: string,
  deadline: number,
  signal: AbortSignal | undefined
): Promise<LaunchResult> {
  for (let attempt = 0; ; attempt++) {
    let res: SshExecResult
    try {
      res = await sshScript({
        sessionId: e.sessionId,
        alias: e.alias,
        configPath: e.configPath,
        script,
        timeoutSec: LAUNCH_WAIT_SEC + 60,
        // 卡住的启动也要停得下来（ssh 子进程被杀；远端那一半由调用方补一次停止）
        signal
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { kind: 'failed', message, maybeStarted: message === 'Aborted' }
    }
    const report = res.exitCode === 0 && res.stdoutBytes ? parseReport(res.stdoutBytes) : null
    if (report) {
      if (report.state.kind === 'error') {
        const detail = report.body.toString('utf-8').trim()
        return {
          kind: 'failed',
          message: `The command could not be started on "${e.alias}" (${report.state.reason}).${detail ? `\n${detail}` : ''}`,
          maybeStarted: false
        }
      }
      return { kind: 'ok', report }
    }
    if (res.exitCode === 255) {
      // 根本没连上 —— 指纹、认证、解析、拒绝、建连超时：脚本一个字节都没送到，没有可重放的
      const explained = classifySshFailure(e.alias, res.stderr, res.stdout)
      if (explained) return { kind: 'failed', message: explained, maybeStarted: false }
    } else if (!res.timedOut) {
      return {
        kind: 'failed',
        message: `Unexpected reply from "${e.alias}" while starting the command (exit ${res.exitCode}): ${(res.stderr || res.stdout).trim().slice(0, 500)}`,
        maybeStarted: true
      }
    }
    if (signal?.aborted) return { kind: 'failed', message: 'Aborted', maybeStarted: true }
    if (Date.now() >= deadline) {
      return {
        kind: 'failed',
        message: `Lost the connection to "${e.alias}" while starting the command and could not reconnect in time. In case it had started, ShuviX has asked "${e.alias}" to stop it.`,
        maybeStarted: true
      }
    }
    log.warn(`launch ${e.taskId} on ${e.alias}: connection lost, retrying`)
    await sleep(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)])
  }
}

/** 收下一轮回执：追加镜像、记大小、判阈值；结束且字节收全就落定 */
function applyReport(e: Entry, report: RemoteReport): void {
  if (report.body.length > 0) {
    appendFileSync(e.logPath, report.body)
    e.mirrored += report.body.length
  }
  e.remoteSize = report.size
  const state = report.state
  if (state.kind === 'running') {
    checkLogSize(e)
    return
  }
  if (state.kind === 'gone') {
    // 远端已经没有这个目录了：没得取、也没得删
    e.complete = true
    e.reaped = true
    e.notes.push(
      `[The command's task folder on "${e.alias}" disappeared, so its result is unknown]`
    )
    settle(e, 'error', null)
    return
  }
  // 结束了还没取完 → 下一轮立刻接着取；取完才落定（之后由 drive 请远端删目录）
  if (e.mirrored < report.size) return
  e.complete = true
  if (state.kind === 'exit') {
    if (state.orphaned)
      e.notes.push(`[Stopped on "${e.alias}" by a cleanup after ShuviX restarted]`)
    settle(e, state.stopped ? 'killed' : state.code === 0 ? 'done' : 'error', state.code)
  } else {
    e.notes.push(
      `[The command on "${e.alias}" ended without an exit code: the process running it is gone (the machine may have restarted, or the process was killed)]`
    )
    settle(e, 'error', null)
  }
}

function settle(
  e: Entry,
  status: Exclude<TaskStatus, 'running' | 'waiting-input'>,
  code: number | null
): void {
  if (e.settled) return
  e.settled = true
  hub?.settle(e.taskId, { status, subject: { exitCode: code } })
}

function checkLogSize(e: Entry): void {
  const task = hub?.get(e.taskId)
  if (!task || task.subject.kind !== 'bash') return
  if (!task.subject.logCapped && e.remoteSize >= LOG_WARN_BYTES) {
    hub?.update(e.taskId, { subject: { logCapped: true } })
  }
  if (e.remoteSize >= LOG_KILL_BYTES && !e.stopWanted) {
    log.error(`remote log over hard cap, stopping ${e.taskId}`)
    e.notes.push('[Stopped: the output passed 1 GB]')
    // 按「用户停的」记 —— 智能体没停过它，这条结束必须通知到它
    hub?.stop(e.taskId, { by: 'user', force: true })
  }
}

/** 轮询循环：直到结束、收全、远端目录删掉（或会话没了） */
async function drive(e: Entry): Promise<void> {
  let failures = 0
  while (!e.closed && !e.reaped) {
    if (e.complete) {
      // 收全了才删：这一步与带回结果的那一轮分开，回执丢在路上时重发的 poll 还拿得到东西
      if (await reap(e)) {
        e.reaped = true
        break
      }
      failures++
      if (failures >= REAP_ATTEMPTS) {
        log.warn(`reap ${e.taskId} on ${e.alias} gave up; the cleanup of a later run removes it`)
        break
      }
      await sleep(BACKOFF_MS[Math.min(failures - 1, BACKOFF_MS.length - 1)])
      continue
    }
    if (e.stopWanted && !e.stopDelivered) void deliverStop(e)
    const terminal = e.remoteSize > e.mirrored
    let res: SshExecResult | undefined
    try {
      res = await sshScript({
        sessionId: e.sessionId,
        alias: e.alias,
        configPath: e.configPath,
        script: buildPollScript({
          installId: remoteInstallId(),
          dir: e.dir,
          // 还有没取完的字节就不等，立刻接着取
          waitSec: terminal ? 0 : POLL_WAIT_SEC,
          fromByte: e.mirrored,
          capBytes: CAP_BYTES
        }),
        timeoutSec: POLL_WAIT_SEC + 90
      })
    } catch (err) {
      log.warn(`poll ${e.taskId}: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (e.closed) return
    const report =
      res && res.exitCode === 0 && res.stdoutBytes ? parseReport(res.stdoutBytes) : null
    if (!report) {
      failures++
      if (failures === 1 || failures % 10 === 0) {
        log.warn(`poll ${e.taskId} on ${e.alias} failed (${failures}), reconnecting`)
      }
      await sleep(BACKOFF_MS[Math.min(failures - 1, BACKOFF_MS.length - 1)])
      continue
    }
    failures = 0
    applyReport(e, report)
  }
  if (e.settled) entries.delete(e.taskId)
}

/** 请远端删目录；远端复核「结束了、日志不比我收到的长」才删（可重放） */
async function reap(e: Entry): Promise<boolean> {
  try {
    const res = await sshScript({
      sessionId: e.sessionId,
      alias: e.alias,
      configPath: e.configPath,
      script: buildReapScript({ installId: remoteInstallId(), dir: e.dir, fromByte: e.mirrored }),
      timeoutSec: 30
    })
    return res.exitCode === 0 && res.stdout.includes('REAPED')
  } catch (err) {
    log.warn(`reap ${e.taskId}: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

/** 停掉并删掉一条任务的远端目录，发出去就不管（脱离的 ssh） */
function sendKill(e: Entry): void {
  try {
    sshScriptDetached({
      alias: e.alias,
      configPath: e.configPath,
      script: buildKillScript({ installId: remoteInstallId(), dirs: [e.dir] })
    })
  } catch (err) {
    log.warn(`kill ${e.taskId} on ${e.alias}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// ─── 停止 ────────────────────────────────────────────

/** 枢纽的停止实现：超时、中止、面板、智能体 */
function requestStop(e: Entry): void {
  if (e.closed || e.settled) return
  e.stopWanted = true
  void deliverStop(e)
  // 远端够不着时不能让等它的那次调用一直挂着：先按「停了」落定，停止指令由轮询循环接着送
  setTimeout(() => {
    if (e.settled || e.closed) return
    e.notes.push(
      `[Could not reach "${e.alias}" to confirm the stop; ShuviX keeps trying while it is running]`
    )
    settle(e, 'killed', null)
  }, STOP_CONFIRM_MS).unref()
}

async function deliverStop(e: Entry): Promise<void> {
  if (e.stopInFlight || e.stopDelivered || e.closed) return
  e.stopInFlight = true
  try {
    const res = await sshScript({
      sessionId: e.sessionId,
      alias: e.alias,
      configPath: e.configPath,
      script: buildStopScript({ installId: remoteInstallId(), dir: e.dir }),
      timeoutSec: 30
    })
    if (res.exitCode === 0 && res.stdout.includes('STOPPED')) e.stopDelivered = true
  } catch (err) {
    log.warn(`stop ${e.taskId}: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    e.stopInFlight = false
  }
}

/**
 * 删会话 / App 退出：停掉并删除远端目录，经**脱离的** ssh 发出去 —— 不等网络、App 退了照样送到。
 * 之后枢纽级联停这些任务时，它们已是 closed，停止实现什么也不做。
 */
function killWhere(pred: (e: Entry) => boolean): number {
  const groups = new Map<string, Entry[]>()
  for (const e of entries.values()) {
    if (!pred(e) || e.closed) continue
    e.closed = true
    if (e.reaped) continue
    const key = probeKey(e.alias, e.configPath)
    groups.set(key, [...(groups.get(key) ?? []), e])
  }
  let sent = 0
  for (const group of groups.values()) {
    const { alias, configPath } = group[0]
    try {
      sshScriptDetached({
        alias,
        configPath,
        script: buildKillScript({ installId: remoteInstallId(), dirs: group.map((g) => g.dir) })
      })
      sent += group.length
    } catch (err) {
      log.warn(`kill on ${alias}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  for (const [id, e] of entries) if (e.closed) entries.delete(id)
  return sent
}

/** 删会话：停掉它在各台远端上的任务（在枢纽的级联之前调） */
export function killRemoteTasksBySession(sessionId: string): number {
  return killWhere((e) => e.sessionId === sessionId)
}

/** App 退出：停掉所有远端任务（在枢纽的级联之前调） */
export function killAllRemoteTasks(): number {
  return killWhere(() => true)
}

// ─── 文案 ────────────────────────────────────────────

/** 后台任务结束时给智能体的通知（与本机任务同一个信封，多一个 host、用任务 id 代替 pid） */
function formatRemoteNotice(e: Entry, task: TaskInfo): string {
  if (task.subject.kind !== 'bash') return ''
  const { exitCode } = task.subject
  const status =
    task.status === 'killed'
      ? 'stopped'
      : exitCode === null
        ? 'ended without an exit code'
        : `exited with code ${exitCode}`
  const seconds = Math.round(((task.endedAt ?? Date.now()) - task.startedAt) / 1000)
  const lines = [
    `<background-task host="${e.alias}" task="${e.taskId}" status="${status}" duration="${seconds}s">`,
    e.command
  ]
  const tail = readTail(e.logPath, NOTIFY_TAIL_BYTES).trimEnd()
  if (tail) {
    lines.push('Last output:')
    lines.push(...tail.split('\n').slice(-NOTIFY_TAIL_LINES))
  }
  lines.push(...e.notes)
  lines.push(`Full log: ${e.logPath}`, '</background-task>')
  return lines.join('\n')
}

/** 后台任务的启动回执：只放模型无从得知的事实（同 bgTaskService.formatStartReceipt 的理由） */
export function formatRemoteStartReceipt(
  alias: string,
  taskId: string,
  logPath: string,
  logBytes: number
): string {
  const activity = logBytes > 0 ? `${logBytes} bytes of output so far` : 'no output yet'
  return `Background task started on "${alias}", task id ${taskId} (${activity}). Its output is being copied to:\n${logPath}`
}

function readMirror(path: string): string {
  try {
    return sanitizeBinaryOutput(readRange(path, 0, statSync(path).size).toString('utf-8'))
  } catch {
    return ''
  }
}

function readTail(path: string, maxBytes: number): string {
  try {
    const size = statSync(path).size
    const start = Math.max(0, size - maxBytes)
    const text = sanitizeBinaryOutput(readRange(path, start, size).toString('utf-8'))
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text
  } catch {
    return ''
  }
}

function readRange(path: string, start: number, end: number): Buffer {
  if (!existsSync(path) || end <= start) return Buffer.alloc(0)
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.allocUnsafe(end - start)
    let read = 0
    while (read < buf.length) {
      const n = readSync(fd, buf, read, buf.length - read, start + read)
      if (n <= 0) break
      read += n
    }
    return buf.subarray(0, read)
  } finally {
    closeSync(fd)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.())
}

/** 仅测试：清空进程级状态，可调小各段时长 */
export function __resetRemoteTasksForTests(timing?: {
  launchWaitSec?: number
  pollWaitSec?: number
  stopConfirmMs?: number
  backoffMs?: number[]
}): void {
  probes.clear()
  entries.clear()
  installIdCache = undefined
  LAUNCH_WAIT_SEC = timing?.launchWaitSec ?? 2
  POLL_WAIT_SEC = timing?.pollWaitSec ?? 25
  STOP_CONFIRM_MS = timing?.stopConfirmMs ?? 10_000
  BACKOFF_MS = timing?.backoffMs ?? [1000, 2000, 4000, 8000, 15_000, 30_000, 60_000]
}
