/**
 * 命令沙箱的平台无关契约。
 *
 * 分层：spec.ts 把「这个会话是谁、在哪儿」算成一份 {@link SandboxSpec}（纯数据、与平台无关），
 * 各平台后端（backends/<os>/）只负责两件事——把 spec 编译成自己的机制、如实报告能不能用。
 * 策略引擎看到的是 {@link SessionSandboxView}：从**同一份** spec 投影出来的路径清单，
 * 所以文件工具的免询问范围与命令实际能碰的范围不会各自漂移。
 */
import type { ShellInvocation } from '../../utils/toolUtils/shell'

/** 宿主环境里与会话无关的路径（管理器现取，spec.ts 只收数据） */
export interface SandboxHostPaths {
  home: string
  /** Electron userData：数据库、会话转写、临时工作区、工具结果都在里面 */
  userData: string
  /** ~/.shuvix */
  shuvixHome: string
  uid: number
  /** shuvix CLI 连主进程的 unix socket（沙箱里唯一放行连接的宿主 socket） */
  cliSocket: string
  /** 每会话临时目录的父目录（短路径：AF_UNIX 路径上限 104 字节） */
  tmpRoot: string
}

/** 一个会话的输入 */
export interface SandboxSessionInput {
  sessionId: string
  workingDirectory: string
  /** 会话「允许并记住」的写授权（allowList 里的 Write(...)）—— 沙箱把它们当作可写根 */
  grantedWrite: readonly string[]
  /** 会话的读授权（Read(...)）—— 敏感目录里被授权的部分放回可读 */
  grantedRead: readonly string[]
}

/** 需要按正则拒绝的写入：同一条规则的两种方言，由 tables.ts 的段表一处生成 */
export interface SandboxPattern {
  /** SBPL 正则（不含 #"…" 外壳） */
  sbpl: string
  /** JS 正则源码（cel-js 的 `matches` 就是 `new RegExp(p).test(s)`） */
  js: string
}

/**
 * 一次命令执行的沙箱规格。所有路径都已 realpath（Seatbelt 按解析后的路径比对：
 * `/var` 实为 `/private/var`，`/tmp` 实为 `/private/tmp`）。
 *
 * 写入按四层求值（后面的层覆盖前面的）：
 *   1. writableRoots 可写
 *   2. writeDenied 拒写（整片：~/.shuvix、userData）
 *   3. writeAllowBack 放回（严格落在第 2 层里的根：本会话临时工作区、本会话 artifacts、授权根）
 *   4. writeDeniedFinal / writeDeniedPatterns / gitRoots 上的 .git 规则 —— 最后一层，谁也放不回
 * 读取同理：全读 → readDenied 拒读内容 → readAllowBack 放回 → readDeniedFinal 连元数据都拒。
 */
export interface SandboxSpec {
  sessionId: string
  workingDirectory: string
  writableRoots: string[]
  writeDenied: string[]
  writeAllowBack: string[]
  writeDeniedFinal: string[]
  writeDeniedPatterns: SandboxPattern[]
  /** .git 元数据保护只在这些根里生效（工作区 + 授权根），不波及 tmp / 缓存里 clone 下来的依赖 */
  gitRoots: string[]
  readDenied: string[]
  readAllowBack: string[]
  readDeniedFinal: string[]
  /** 允许连接的具体 socket 文件 */
  unixSockets: string[]
  /** 允许建立并连接 socket 的目录（本会话临时目录、工作区） */
  unixSocketDirs: string[]
  /** 本会话临时目录（经 TMPDIR/TMP/TEMP 交给命令） */
  tmpDir: string
}

/**
 * 策略引擎看的那一面（desktop getVars 展开进 `vars.*`）。
 * 沙箱没套上时恒为 {@link INACTIVE_VIEW}：内置策略据此退回「每次都问」的老行为。
 */
export interface SessionSandboxView {
  sandboxActive: boolean
  sandboxWritableRoots: string[]
  sandboxWriteDenied: string[]
  sandboxProtectedPatterns: string[]
  sandboxReadDenied: string[]
  sandboxReadAllowed: string[]
}

export const INACTIVE_VIEW: SessionSandboxView = Object.freeze({
  sandboxActive: false,
  sandboxWritableRoots: [],
  sandboxWriteDenied: [],
  sandboxProtectedPatterns: [],
  sandboxReadDenied: [],
  sandboxReadAllowed: []
}) as SessionSandboxView

/** 探测结果 */
export type ProbeResult = { available: true } | { available: false; reason: string }

/** 平台后端。新增平台 = 实现它 + 在 index.ts 的表里注册一行 */
export interface SandboxBackend {
  readonly id: string
  /** 同步探测（管理器缓存结果）：用与真实 profile 同形的规格跑一次空命令 */
  probe(paths: SandboxHostPaths): ProbeResult
  /** 把一次 shell 调用包进沙箱 */
  wrap(spec: SandboxSpec, invocation: ShellInvocation): ShellInvocation
  /** 从命令输出里认出「沙箱本身没能起来」（与命令自己的失败区分），认不出返回 null */
  startupFailure(output: string, exitCode: number | null): string | null
}

/** 一次命令的执行计划（shellCommand 取，bgTaskService 用） */
export interface SandboxPlan {
  readonly spec: SandboxSpec
  /** 注入命令环境（TMPDIR 等） */
  readonly env: Record<string, string>
  wrap(invocation: ShellInvocation): ShellInvocation
  /**
   * 命令结束后追加进日志的说明（没有可说的返回 null）：沙箱没起来，或输出里的拒绝
   * 能对上沙箱规则。前台结果与后台退出通知都读日志，所以两边都看得到。
   */
  explain(outputTail: string, exitCode: number | null): string | null
}
