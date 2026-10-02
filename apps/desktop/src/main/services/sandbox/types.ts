/**
 * 命令沙箱的平台无关契约。
 *
 * 分层：spec.ts 把「这个会话是谁、在哪儿」算成一份 {@link SandboxSpec}（纯数据、与平台无关），
 * 各平台后端（backends/<os>/）只负责两件事——把 spec 编译成自己的机制、如实报告能不能用。
 *
 * **沙箱只做一件事：把命令的文件访问收进本会话的目录**（2026-10-01 用户裁定，取代此前「尽量把
 * 功能圈在沙箱里」的方针）。稍复杂的命令 —— 要读家目录里的配置（git 读 ~/.gitconfig）、装依赖、
 * 用缓存 —— 不再靠一张越来越长的放行清单圈进来，而是直接申请到沙箱外执行，交给自动审查。
 * 文件工具的询问（外部目录访问策略）与沙箱用**同一份**会话目录清单（{@link sessionDirsFor}），
 * 所以「沙箱拒绝的」恰好就是「文件工具要问的」。
 */
import type { ShellInvocation } from '../../utils/toolUtils/shell'

/** 宿主环境里与会话无关的路径（管理器现取，spec.ts 只收数据） */
export interface SandboxHostPaths {
  home: string
  /** Electron userData：数据库、会话转写、临时工作区、工具结果都在里面 */
  userData: string
  /** ~/.shuvix */
  shuvixHome: string
  /** 工具大结果 / 后台任务日志的根（userData/tool_results）；本会话的那一格是会话目录 */
  toolResultsBase: string
  uid: number
  /** shuvix CLI 连主进程的 unix socket（沙箱里唯一放行连接的宿主 socket） */
  cliSocket: string
  /** shuvix CLI 鉴权读的 token 文件（在家目录里，单独放行可读 —— CLI 在沙箱里必须能用） */
  cliToken: string
  /**
   * ShuviX 自己的程序所在（Electron 应用包、CLI 入口与包装脚本的目录）：沙箱里的 `shuvix` 命令要
   * 读得到它们。开发态它们在仓库里（常在家目录内），打包后在应用包里。
   */
  appPaths: string[]
  /** 每会话临时目录的父目录（短路径：AF_UNIX 路径上限 104 字节） */
  tmpRoot: string
}

/**
 * 会话设置决定的那部分会话目录（宿主现算：sandbox 模块读不到知识库选择与技能目录）。
 * 不是要人维护的白名单 —— 跟着用户在会话里勾的东西走。
 */
export interface SessionDirExtras {
  /** 可读可写：本会话勾选的知识库目录（知识库的改动本来就逐次提交进它自己的 git，可以回退） */
  readWrite: readonly string[]
  /** 只读：技能目录（技能是 agent 自己要遵守的指令，改它照旧询问）、只读的内置知识库 */
  readOnly: readonly string[]
}

/** 一个会话的输入 */
export interface SandboxSessionInput {
  sessionId: string
  workingDirectory: string
  /** 会话设置决定的会话目录（缺省 = 没有） */
  extras?: SessionDirExtras
  /** 会话「允许并记住」的读授权（allowList 里的 Read(...)）—— 沙箱放它们可读 */
  grantedRead: readonly string[]
  /** 会话「允许并记住」的写授权（allowList 里的 Write(...)）—— 沙箱放它们可读可写 */
  grantedWrite: readonly string[]
}

/**
 * 一次命令执行的沙箱规格。所有路径都已 realpath（Seatbelt 按解析后的路径比对：
 * `/var` 实为 `/private/var`，`/tmp` 实为 `/private/tmp`）。
 *
 * 读：家目录以外全读（程序要读自己的可执行文件、库与系统配置 —— 只放行工作目录的话连 `ls` 都找不到）；
 * 家目录里只有 readableRoots 可读，readableRoots 的上级目录只放行元数据（否则路径解析失败）。
 * 写：只有 writableRoots。
 */
export interface SandboxSpec {
  sessionId: string
  workingDirectory: string
  /** 家目录：它里面默认不可读 */
  home: string
  /** 本会话的目录（工作目录、本会话临时目录、artifacts、工具结果、勾选的知识库）—— 可读可写 */
  sessionDirs: string[]
  /** 本会话只读的目录（技能目录、内置知识库） */
  sessionReadDirs: string[]
  /** 可读的根（会话目录 + 只读会话目录 + 读写授权 + ShuviX 自己的程序） */
  readableRoots: string[]
  /** 可读的单个文件（cli-token） */
  readableFiles: string[]
  /** 可读根里落在家目录内的那些，它们的上级目录（只放行元数据，不能列内容） */
  metadataPaths: string[]
  /** 可写的根（会话目录 + 写授权） */
  writableRoots: string[]
  /** 允许连接的具体 socket 文件 */
  unixSockets: string[]
  /** 允许建立并连接 socket 的目录（本会话临时目录、工作区） */
  unixSocketDirs: string[]
  /** 本会话临时目录（经 TMPDIR/TMP/TEMP 交给命令） */
  tmpDir: string
}

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
