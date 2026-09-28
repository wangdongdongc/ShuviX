/**
 * 命令沙箱 —— 管理器（对外唯一入口）。
 *
 * 平台相关的一切都在本目录：选哪个后端、探测、每会话的临时目录、给 bash 的执行计划、给安全策略的
 * 变量。agent 运行时只知道一件事：命令客体上的 `sandboxed`（这次执行有没有真套上）。
 * 新增一个平台 = 在 backends/ 下实现 SandboxBackend，再在 {@link BACKENDS} 里注册一行。
 *
 * 「未圈住」一律退回今天的「命令逐条询问」，绝不变成「不套沙箱又不问」：没有后端、开关关闭、
 * 探测失败（例如 ShuviX 自己跑在别的沙箱里）、会话的工作区或授权根不适合套（见 spec.ts）。
 *
 * **按会话固定**：bash 工具构造时 {@link pinSession} 记下「本会话是否启用」，planFor 与策略变量
 * 都读这个固定值，运行时销毁时 {@link unpinSession}。否则会话中途切开关，同一个 runtime 里
 * 工具参数说有 `dangerouslyDisableSandbox`、说明里写着受限，实际执行却不受限（或反过来）。
 */
import { mkdirSync, lstatSync, chmodSync, realpathSync, rmSync } from 'fs'
import { homedir } from 'os'
import { basename, dirname, join, resolve } from 'path'
import { app } from 'electron'
import { createLogger } from '../../logger'
import { isSafeSessionId } from '../../utils/paths'
import type { ShellInvocation } from '../../utils/toolUtils/shell'
import { createSeatbeltBackend } from './backends/seatbelt'
import { explainSandboxDenial } from './classify'
import {
  buildSandboxSpec,
  protectedWritePatterns,
  sessionTmpName,
  toPolicyView,
  type SpecResult
} from './spec'
import {
  INACTIVE_VIEW,
  type ProbeResult,
  type SandboxBackend,
  type SandboxHostPaths,
  type SandboxPlan,
  type SessionSandboxView
} from './types'

export type { SandboxPlan, SessionSandboxView } from './types'
export { INACTIVE_VIEW } from './types'

const log = createLogger('Sandbox')

/** 设置键：现读、缺省开，只有字面 'false' 才关（纯文本键值，写坏的值不该把保护关掉） */
export const SANDBOX_ENABLED_KEY = 'sandbox.enabled'

/** 平台 → 后端。没有条目的平台上，命令一律「未圈住」 */
const BACKENDS: Partial<Record<NodeJS.Platform, () => SandboxBackend>> = {
  darwin: createSeatbeltBackend
}

let backend: SandboxBackend | null | undefined
let probeResult: ProbeResult | undefined
let probedAt = 0
/** 探测失败后多久重探一次：成功的结果缓存到退出，失败的不能让所有会话一直逐条询问到重启 */
const PROBE_RETRY_MS = 60_000

function getBackend(): SandboxBackend | null {
  if (backend === undefined) backend = BACKENDS[process.platform]?.() ?? null
  return backend
}

/**
 * 开关的读取由主进程启动时注入（index.ts → settingsService.get）。本模块不直接碰设置表：
 * 模块在导入时就会被 bash / bgTaskService / toolContext 连带加载，碰 DAO 就等于把数据库初始化
 * 塞进了它们的导入链。**没注入 = 关闭**：只有真正起来的应用才会套沙箱，单测默认不受影响。
 */
let readEnabledSetting: (() => string | undefined) | null = null

export function setSandboxSettingReader(reader: () => string | undefined): void {
  readEnabledSetting = reader
}

function isEnabledSetting(): boolean {
  if (!readEnabledSetting) return false
  try {
    return readEnabledSetting()?.trim() !== 'false'
  } catch {
    return false
  }
}

// ─── 路径 ─────────────────────────────────────────────

/** realpath；不存在的部分按最近的已存在祖先拼回（授权根、缓存目录常常还不存在） */
function realpathLoose(p: string): string {
  const abs = resolve(p)
  try {
    return realpathSync.native(abs)
  } catch {
    const parent = dirname(abs)
    if (parent === abs) return abs
    return join(realpathLoose(parent), basename(abs))
  }
}

const realCache = new Map<string, string>()
function real(p: string): string {
  const hit = realCache.get(p)
  if (hit !== undefined) return hit
  const value = realpathLoose(p)
  // 很小的表（工作区、授权根、固定清单）；防御性封顶，不做 LRU
  if (realCache.size > 512) realCache.clear()
  realCache.set(p, value)
  return value
}

function currentUid(): number {
  return process.getuid?.() ?? 0
}

/** 每会话临时目录的父目录：/private/tmp/shuvix-<uid>（短路径，远在 AF_UNIX 的 104 字节上限以内） */
function tmpRootPath(): string {
  return `/private/tmp/shuvix-${currentUid()}`
}

function hostPaths(): SandboxHostPaths {
  const home = homedir()
  const uid = currentUid()
  return {
    home,
    userData: app.getPath('userData'),
    shuvixHome: join(home, '.shuvix'),
    uid,
    // 与 cliServer 的 socketPath 同一个位置（POSIX）；沙箱里 shuvix CLI 要连它
    cliSocket: join(home, '.shuvix', 'cli.sock'),
    tmpRoot: tmpRootPath()
  }
}

/** 本机 cli-token 的位置（策略变量用：沙箱放它可读，read 工具不该把它读进上下文） */
function cliTokenPath(): string {
  return join(homedir(), '.shuvix', 'cli-token')
}

// ─── 状态 ─────────────────────────────────────────────

export interface SandboxStatus {
  /** 这个平台有没有后端 */
  supported: boolean
  /** 后端能不能用（探测结果） */
  available: boolean
  /** 设置开关 */
  enabled: boolean
  /** 不可用的原因（给设置页看） */
  reason?: string
}

function probe(): ProbeResult {
  const b = getBackend()
  if (!b) return { available: false, reason: 'no sandbox backend for this platform' }
  if (!probeResult || (!probeResult.available && Date.now() - probedAt > PROBE_RETRY_MS)) {
    probedAt = Date.now()
    probeResult = b.probe(hostPaths())
    if (probeResult.available) log.info(`sandbox backend "${b.id}" available`)
    else log.warn(`sandbox backend "${b.id}" unavailable: ${probeResult.reason}`)
  }
  return probeResult
}

export function sandboxStatus(): SandboxStatus {
  const supported = getBackend() !== null
  const result = probe()
  return {
    supported,
    available: result.available,
    enabled: isEnabledSetting(),
    ...(result.available ? {} : { reason: result.reason })
  }
}

/** 全局：此刻新建的会话 runtime 会不会套沙箱（设置页的工具说明读它） */
export function sandboxGloballyActive(): boolean {
  return isEnabledSetting() && probe().available
}

type UnpinnedReason = 'unsupported' | 'disabled' | 'unavailable'

/** 此刻没套沙箱的原因（只读已有事实，不触发探测） */
function reasonNow(): UnpinnedReason {
  if (!getBackend()) return 'unsupported'
  if (!isEnabledSetting()) return 'disabled'
  return 'unavailable'
}

/**
 * 一个没套沙箱的 bash 工具实例为什么没套（命令客体的 `unconfinedReason`，给审查员与策略看）：
 * 这台机器没有后端 → unsupported；设置关着 → disabled；否则就是探测没通过 → unavailable。
 * 会话固定成不套时取固定那一刻的原因 —— 之后用户打开了沙箱，这条会话的命令仍是因为「当时关着」
 * 才没套，不该改口成 unavailable。**不触发探测**：这是每条命令都会走的路径，不该为一句说明去起进程。
 */
export function whyUnconfined(sessionId: string): UnpinnedReason {
  return pinReasons.get(sessionId) ?? reasonNow()
}

// ─── 按会话固定 ────────────────────────────────────────

const pins = new Map<string, boolean>()
/** 固定成不套的会话，固定那一刻的原因 */
const pinReasons = new Map<string, UnpinnedReason>()

/**
 * bash 工具构造时调用：第一次记下「本会话此刻是否启用沙箱」，之后同一 runtime 里构造的
 * 工具（派生 agent 用的也是根会话 id）都拿到同一个答案。
 */
export function pinSession(sessionId: string): boolean {
  let value = pins.get(sessionId)
  if (value === undefined) {
    value = sandboxGloballyActive()
    pins.set(sessionId, value)
    if (!value) pinReasons.set(sessionId, reasonNow())
  }
  return value
}

/** 会话 runtime 失效 / 销毁时调用：下一次创建按当时的开关重新决定 */
export function unpinSession(sessionId: string): void {
  pins.delete(sessionId)
  pinReasons.delete(sessionId)
}

// ─── 会话规格 ──────────────────────────────────────────

function specFor(
  sessionId: string,
  workingDirectory: string,
  grants: { grantedWrite: readonly string[]; grantedRead: readonly string[] }
): SpecResult {
  return buildSandboxSpec(hostPaths(), { sessionId, workingDirectory, ...grants }, real)
}

/**
 * 策略变量（desktop getVars 展开进 `vars.*`）。只有被固定为启用、且工作区适合套沙箱的会话
 * 才是「启用」—— 与 planFor 同一套判定，所以文件工具的免询问范围就是命令实际能碰的范围。
 * 授权根不进这里：会话授权由 session-grants 策略直接放行，不需要沙箱的免询问来叠加。
 */
export function sessionView(sessionId: string, workingDirectory: string): SessionSandboxView {
  if (!pins.get(sessionId)) return INACTIVE_VIEW
  const built = specFor(sessionId, workingDirectory, { grantedWrite: [], grantedRead: [] })
  if (!built.ok) return INACTIVE_VIEW
  return toPolicyView(built.spec, real(cliTokenPath()))
}

/**
 * 文件工具在工作区里写入免询问的范围（ask-on-write 读 `vars.workspace*`）—— **不看沙箱开没开**。
 *
 * 沙箱没套上时（设置关着、探测没过、Linux），命令照样逐条交给审查；但文件工具知道确切的路径，而在
 * 工作区里改文件是编码工作的主体，每一次都审一遍不值。受保护的位置（git 自己会执行的元数据、`.git`
 * 本身、项目根的 .vscode / .claude 等、shell 启动文件、凭据目录）照旧询问 —— 与沙箱视图同一组。
 *
 * 判定用的是沙箱的同一份规格：工作区是 `/`、覆盖家目录、是 ShuviX 自己的配置或应用数据、严格包含
 * 敏感目录时，一样不给免询问（与「不套沙箱」同一批理由）。**Windows 不给**：受保护模式是按 `/` 写的
 * 正则，在 `\` 路径上会静默不匹配 —— 宁可每次写入都交给审查，也不能悄悄放过 `.git\hooks`。
 */
export interface WorkspaceWriteView {
  workspaceWritable: string[]
  workspaceWriteDenied: string[]
  workspaceProtectedPatterns: string[]
}

const NO_WORKSPACE_WRITES: WorkspaceWriteView = Object.freeze({
  workspaceWritable: [],
  workspaceWriteDenied: [],
  workspaceProtectedPatterns: []
}) as WorkspaceWriteView

export function workspaceWriteView(
  sessionId: string,
  workingDirectory: string
): WorkspaceWriteView {
  if (process.platform === 'win32') return NO_WORKSPACE_WRITES
  try {
    const built = specFor(sessionId, workingDirectory, { grantedWrite: [], grantedRead: [] })
    if (!built.ok) return NO_WORKSPACE_WRITES
    return {
      workspaceWritable: [built.spec.workingDirectory],
      workspaceWriteDenied: built.spec.writeDeniedFinal,
      workspaceProtectedPatterns: protectedWritePatterns(built.spec)
    }
  } catch (err) {
    // 算不出规格（路径解析失败之类）就不给免询问 —— 照旧问，绝不因此放行
    log.warn(`workspace write view unavailable: ${(err as Error).message}`)
    return NO_WORKSPACE_WRITES
  }
}

/** 建本会话临时目录：父目录 0700 且属于当前用户（/private/tmp 人人可写，别人可以抢先建同名目录） */
function ensureTmpDir(tmpRoot: string, dir: string, uid: number): boolean {
  try {
    mkdirSync(tmpRoot, { recursive: true, mode: 0o700 })
    const st = lstatSync(tmpRoot)
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== uid) {
      log.warn(`sandbox tmp root ${tmpRoot} is not ours; running unconfined`)
      return false
    }
    if ((st.mode & 0o077) !== 0) chmodSync(tmpRoot, 0o700)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    return true
  } catch (err) {
    log.warn(`cannot create sandbox tmp dir ${dir}: ${(err as Error).message}`)
    return false
  }
}

export interface PlanRequest {
  sessionId: string
  workingDirectory: string
  /** 会话「允许并记住」的写 / 读授权路径（调用方从会话设置里解析好交进来） */
  grantedWrite: readonly string[]
  grantedRead: readonly string[]
  /** 本工具实例带不带 `dangerouslyDisableSandbox` —— 决定拒绝说明里能不能教模型用它 */
  offerEscalation: boolean
}

/**
 * 一条命令的执行计划；null = 这条命令不套沙箱（调用方据此上报 `sandboxed: false`，
 * ask-on-command 照常询问）。
 *
 * 只有**被固定为沙箱模式的工具实例**会来要计划（见 shellCommand），所以这里不再查会话的 pin：
 * 运行时失效后 pin 已清，但还在收尾的旧工具实例的说明写的是「受限」，就该继续受限 ——
 * 而不是悄悄变成逐条询问、与它自己的说明对不上。
 */
export function planFor(request: PlanRequest): SandboxPlan | null {
  const { sessionId, workingDirectory, offerEscalation } = request
  const b = getBackend()
  if (!b || !probe().available) return null
  const built = specFor(sessionId, workingDirectory, request)
  if (!built.ok) {
    log.info(`session ${sessionId} runs unconfined: ${built.reason}`)
    return null
  }
  const spec = built.spec
  const paths = hostPaths()
  if (!ensureTmpDir(paths.tmpRoot, spec.tmpDir, paths.uid)) return null
  return {
    spec,
    env: { TMPDIR: spec.tmpDir + '/', TMP: spec.tmpDir, TEMP: spec.tmpDir },
    wrap: (invocation: ShellInvocation) => b.wrap(spec, invocation),
    explain: (outputTail, exitCode) => {
      const failure = b.startupFailure(outputTail, exitCode)
      if (failure) {
        log.error(`sandbox failed to start for session ${sessionId}: ${failure}`)
        return `[sandbox] The sandbox could not start (${failure}); the command did not run. This is a ShuviX problem, not the command's — tell the user.`
      }
      return explainSandboxDenial({ spec, outputTail, exitCode, offerEscalation })
    }
  }
}

/** 会话删除时清掉它的临时目录 */
export function cleanupSession(sessionId: string): void {
  unpinSession(sessionId)
  if (!isSafeSessionId(sessionId) || !getBackend()) return
  try {
    rmSync(join(tmpRootPath(), sessionTmpName(sessionId)), { recursive: true, force: true })
  } catch {
    /* 忽略：/private/tmp 本来就会被系统清理 */
  }
}
