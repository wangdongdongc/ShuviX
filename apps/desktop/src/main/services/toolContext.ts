/**
 * 工具上下文与路径询问 —— 供所有工具与服务共享的运行时基础设施
 * 所有工具通过 ToolContext + resolveProjectConfig 获取运行时项目配置
 */

import { isAbsolute, resolve, sep } from 'path'
import { existsSync, statSync } from 'fs'
import { homedir } from 'os'
import { projectDao } from '../dao/projectDao'
import { sessionRecords } from './sessionRecords'
import { sessionView, workspaceWriteView } from './sandbox'
import { sessionService } from './sessionService'
import {
  getTempWorkspace,
  getToolResultsBase,
  getDefaultSkillsDir,
  getDefaultBotsDir,
  getDefaultPoliciesDir,
  getDefaultAgentsDir,
  getDefaultHooksDir,
  getMemoryRootDir,
  getBuiltinSkillsDir,
  getBuiltinKnowledgeDir,
  getSessionArtifactsDir,
  isSafeSessionId
} from '../utils/paths'
import { resolveRealPath } from '../utils/toolUtils/realPath'
import { skillService } from './skillService'
import { shellParser } from './shellParserService'
import { policyService } from './policyService'
import {
  createSecurityContext,
  parseAllowEntry,
  resolvePolicyLet,
  type SecurityContext,
  type SecurityHostProvider,
  type SubAgentModelConfig
} from '@shuvix/agent-runtime'
import type { ProjectEnvVar } from '../types'
import type { ChatEvent } from '@shuvix/chat-protocol/events'
import i18next from 'i18next'
import { createLogger } from '../logger'

import type { InputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'

export type {
  InputRequest,
  InputResponse,
  AskInputRequest,
  ChoiceInputRequest,
  AskResponse,
  ChoiceResponse,
  CancelResponse,
  InputRequestKind
} from '@shuvix/chat-protocol/types/inputRequest'

/** ChatEvent 去掉 sessionId 后的有效载荷（分布式 Omit，保留判别联合结构） */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never
export type ChatEventPayload = DistributiveOmit<ChatEvent, 'sessionId'>

/** 中止操作的统一错误消息（用于 sentinel 检查） */
export const TOOL_ABORTED = 'Aborted'

/** 项目配置（工具执行时动态查询） */
export interface ProjectConfig {
  /** 项目工作目录（宿主机路径） */
  workingDirectory: string
  /** 项目环境变量（注入 bash 进程） */
  envVars?: Record<string, string>
}

/** 工具上下文 — 所有工具共享的运行时信息 */
export interface ToolContext {
  /** 当前会话 ID（通过它查询项目配置等） */
  sessionId: string
  /**
   * 统一的"请求用户输入"入口。所有需要用户介入的工具(命令询问 / 选择题 / SSH 凭证)
   * 都通过此方法挂起,后端按 InputRequest.kind 路由,前端按 kind 渲染表单。
   *
   * - 永不超时:Promise 只能由用户响应或 agent.abort 触发 resolve
   * - 取消:返回 `{kind: 'cancel'}`,工具自行决定 throw 还是 fallback
   * - 副作用:用户响应可携带 `extra` 字段(如 `{rememberPath: true}`),工具根据
   *   该字段处理副作用(如写入 allowList)
   */
  requestUserInput?: (request: InputRequest) => Promise<InputResponse>
  /** 工具运行时单向通知（容器、SSH 连接、预览面板等生命周期事件） */
  emitChatEvent?: (event: ChatEventPayload) => void
  /**
   * 本工具实例所属 agent 的元数据（宿主在 resolveTools 时线程化）：档案名、root/spawned、
   * 惰性模型配置（会话中途换模型也跟得上）。目前只有知识库的溯源章（`generated.by`）读它；
   * 缺省 = 未知（主体维度的策略匹配是扩展位，见 getDesktopSecurityContext 的注）。
   */
  agent?: {
    profileName: string
    kind: 'root' | 'spawned'
    getModelConfig?: () => SubAgentModelConfig
  }
}

function actorToken(value: string | undefined, fallback: string): string {
  const cleaned = (value ?? '').trim().replace(/\s+/g, '-')
  return cleaned || fallback
}

/**
 * 本工具实例所属 agent 的 actor 字符串（OKF §5.2 约定 `<producer>/<version>`）：
 * `shuvix-<profile>/<model>`。模型惰性取 —— 会话中途换模型也跟得上；元数据缺失时回落
 * `shuvix-agent/unknown`：章要盖，但不能编。知识库的 `generated.by` 与提交 trailer 用它。
 */
export function agentActorOf(ctx: Pick<ToolContext, 'agent'>): string {
  const profile = actorToken(ctx.agent?.profileName, 'agent')
  let model: string | undefined
  try {
    model = ctx.agent?.getModelConfig?.().model
  } catch {
    model = undefined
  }
  return `shuvix-${profile}/${actorToken(model, 'unknown')}`
}

/**
 * 检查路径是否在工作目录内（路径越界检查）—— 按**位置**比：两边都先解析成真正通向的地方
 * （与安全模块的路径策略同一个解析，见 makeDesktopSecurityProvider 的 realPath）。
 * 按写法比的话，工作区里一条指向别处的链接会被当成「区内」，git 就绕过路径门去读写那个位置。
 * 绝对路径原样交给解析（不先 resolve）：`..` 要跟着链接走物理父目录，字面折叠会把它折回区内。
 */
export function isPathWithinWorkspace(absolutePath: string, workingDirectory: string): boolean {
  const real = (p: string): string => resolveRealPath(isAbsolute(p) ? p : resolve(p))
  const resolved = real(absolutePath)
  const base = real(workingDirectory)
  return resolved === base || resolved.startsWith(base + sep)
}

/**
 * 询问守卫：只读访问（workspace 内放行）
 * 用于 read、ls、grep、glob 等只读工具。
 * 薄封装 —— 判定与执行已收敛到 @shuvix/agent-runtime 的安全模块（evaluate + enforce）。
 */
export async function assertReadAllowed(
  ctx: ToolContext,
  config: ProjectConfig,
  toolCallId: string,
  toolName: string,
  absolutePath: string,
  displayPath?: string
): Promise<void> {
  await getDesktopSecurityContext(ctx, () => config).enforcePath('read', absolutePath, {
    toolCallId,
    toolName,
    displayPath,
    abortError: TOOL_ABORTED
  })
}

/**
 * 只读准入判定 —— 永不弹询问。
 * 被动 UI（预览面板、tooltip）专用：调用方需要"在准入范围内就读、不在就显示占位"的同步语义。
 *
 * 主体是 **user**（用户亲手在 UI 里查看文件），经引擎按多主体模型判定：
 * 内置防护策略限定 subject.kind: [agent] 对此不生效 → 默认全放行；
 * 用户可写 subject.kind: [user] 的策略约束 UI 面（如 deny 某目录的预览）。
 */
export function isPathReadAllowed(config: ProjectConfig, absolutePath: string): boolean {
  return getDesktopUserSecurityContext(() => config).evaluateReadOnly('read', {
    type: 'path',
    path: absolutePath,
    displayPath: absolutePath
  })
}

/**
 * 同步写入准入判定（不弹询问）—— 被动 UI 专用，对应 isPathReadAllowed 的写侧
 * （笔记本「打开 .md 直接编辑 + 自动保存」）。
 *
 * 主体同样是 **user**：内置 agent 门（ask-on-write 等）不生效 → 默认放行
 * （较迁移前的 workspace 硬边界放宽 —— 用户主权原则下用户经 UI 写自己的文件无需围栏，
 * 想约束时写 subject.kind: [user] 的策略即可）。
 */
export function isPathWriteAllowed(config: ProjectConfig, absolutePath: string): boolean {
  return getDesktopUserSecurityContext(() => config).evaluateReadOnly('write', {
    type: 'path',
    path: absolutePath,
    displayPath: absolutePath
  })
}

/**
 * 询问守卫：写入访问 —— 薄封装，同 assertReadAllowed。
 * 用于 write、edit 等写入工具
 */
export async function assertWriteAllowed(
  ctx: ToolContext,
  config: ProjectConfig,
  toolCallId: string,
  toolName: string,
  absolutePath: string,
  displayPath?: string
): Promise<void> {
  await getDesktopSecurityContext(ctx, () => config).enforcePath('write', absolutePath, {
    toolCallId,
    toolName,
    displayPath,
    abortError: TOOL_ABORTED
  })
}

const securityLog = createLogger('Security')

/**
 * Windows 的系统目录（`vars.systemDirs`）—— 事实变量：出厂的 protect-system 已删除（2026-10-01），
 * 留给用户自写「系统目录拒写」这类策略引用。来自环境变量，POSIX 系统返回空。
 * 同时给出小写变体近似 Windows 的大小写不敏感匹配（前缀匹配本身不做大小写归一，
 * 见 allowEntries 的红线注释；C:\\WINDOWS 之类的中间大小写变体不在覆盖内 —— 已知弱化）。
 */
function windowsSystemDirs(): string[] {
  if (process.platform !== 'win32') return []
  const dirs = [
    process.env.SystemRoot ?? 'C:\\Windows',
    process.env.ProgramFiles ?? 'C:\\Program Files',
    process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
    process.env.ProgramData ?? 'C:\\ProgramData'
  ]
  return [...new Set([...dirs, ...dirs.map((d) => d.toLowerCase())])]
}

/**
 * 会话「允许并记住」的路径授权（allowList 的 Write(...) / Read(...)）—— 命令沙箱把写授权当作
 * 可写根、读授权放回可读。与安全模块 buildPolicyVars 同一个解析（历史遗留的 Bash(...) 条目解析为
 * null，不授予任何东西）。
 */
export function getSessionPathGrants(sessionId: string): {
  grantedWrite: string[]
  grantedRead: string[]
} {
  const grantedWrite: string[] = []
  const grantedRead: string[] = []
  const allowList = sessionRecords.pickSettings(sessionId, ['allowList'])?.allowList ?? []
  for (const entry of allowList) {
    const parsed = parseAllowEntry(entry)
    if (!parsed) continue
    if (parsed.toolType === 'write') grantedWrite.push(parsed.path)
    else grantedRead.push(parsed.path)
  }
  return { grantedWrite, grantedRead }
}

/**
 * 宿主提供的策略变量里与沙箱无关的那部分 —— getVars 的主体。凭据清单也只用它求值：沙箱视图本身
 * 要用凭据清单（sessionCredentialPaths），不能反过来依赖沙箱视图。
 */
function hostPolicyVars(
  sessionId: string,
  workingDirectory: string
): ReturnType<SecurityHostProvider['getVars']> {
  return {
    workspace: workingDirectory,
    toolResultsBase: getToolResultsBase(),
    skillsDirs: [
      getDefaultSkillsDir(),
      getBuiltinSkillsDir(),
      ...skillService.listExternalDirs().map((d) => d.path)
    ],
    memoryDirs: [getMemoryRootDir()],
    // 以下三个是事实变量：引用它们的出厂策略（protect-bot-files / protect-shuvix-config /
    // protect-system）已于 2026-10-01 删除，留给用户自写的策略引用 —— 想把「bot 改自己的文件」
    // 或「改 ShuviX 自己的规矩」（策略、agent、hook、技能；权限审查员与 auto-review 就是其中的
    // 一份 agent md 与一份 hook md）加回恒询问，写一份 force-ask 引用它们即可
    botsDir: getDefaultBotsDir(),
    shuvixConfigDirs: [
      getDefaultPoliciesDir(),
      getDefaultAgentsDir(),
      getDefaultHooksDir(),
      getDefaultSkillsDir()
    ],
    // 随应用发布的内置知识库目录 —— 事实变量，内置策略已不用它，留给用户自写的策略引用
    builtinKnowledgeDir: getBuiltinKnowledgeDir(),
    // 本会话自己的 artifacts 目录：ask-on-write 对它免询问。认领下来的图与交互块是
    // 这场对话自己的文件、不在用户的项目里，改一张刚画的图也逐次询问只会把人训练成闭眼点允许。
    // 按会话 id 取，与 artifact 工具落盘用的是同一个 id（子会话有自己的目录，见 artifacts/store）。
    // 坏 id 给空串（inDir 对空串恒不命中 = 不豁免）：空 id 会把豁免放大到所有会话的 artifacts，
    // `..` 会放大到 ~/.shuvix（里面有 policies/）
    sessionArtifactsDir: isSafeSessionId(sessionId) ? getSessionArtifactsDir(sessionId) : '',
    home: homedir(),
    systemDirs: windowsSystemDirs()
  }
}

/**
 * 本会话生效的凭据清单 —— protect-credentials 的 `credentialDirs`（用户的同名覆盖优先）。命令沙箱对它们
 * 读写都拒（main 启动时经 setSandboxCredentialReader 注入）：沙箱不自己定哪些是凭据，策略改了清单，
 * 命令那边跟着变；策略被覆盖掉、规则被清空或没有这个 let，沙箱也就不管 —— 但覆盖里的清单**写错了**
 * （求值出错）时改用出厂那份，不因一处笔误把凭据放给命令。只留绝对路径：相对路径在
 * 策略里对不上任何客体路径，沙箱里也不该按主进程的 cwd 去解析它。
 */
export function sessionCredentialPaths(sessionId: string, workingDirectory: string): string[] {
  const value = resolvePolicyLet(
    {
      pathSep: sep,
      getLanguage: () => i18next.language,
      readBuiltinPolicyMd: (fileName) => policyService.readBuiltinPolicyMd(fileName),
      getUserPolicies: () => policyService.getUserPolicies(),
      logger: securityLog
    },
    'protect-credentials',
    'credentialDirs',
    hostPolicyVars(sessionId, workingDirectory),
    { fallbackToBuiltinOnError: true }
  )
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string' && isAbsolute(v))
    : []
}

/**
 * 桌面 SecurityHostProvider —— 把平台细节注入共享安全模块：
 *   - 变量表：workspace / tool_results / skills 目录 / home（策略 match/lets 里的 vars.*）
 *   - 真实路径：realPath（符号链接 / `..` / 盘上大小写）—— 安全模块拿它解析路径客体与 inDir 比较的
 *     每个目录，两边都按位置比。变量表因此照写法给即可：工作区、临时工作区（macOS 的
 *     /var → /private/var 这类系统级链接）由 inDir 现解析，不在这里预先 realpath
 *   - 会话授权：SQLite allowList（「允许并记住」）
 *   - 内置策略：随包发布的 `builtin-policies/` 目录现读（policyService.readBuiltinPolicyMd）
 *   - 用户策略：~/.shuvix/policies 现扫（policyService）
 *   - persistGrant 写 allowList、statSync 判目录、前端 requestUserInput 透传
 *
 * 全部成员每次评估现读 —— 不跨调用缓存。context 实例在建会话时创建一次、整会话复用
 * （buildTools → makeDesktopFileToolDeps），若在此缓存 allowList，则会话中途
 * 「允许并记住」写入 SQLite 后，复用的实例仍持旧快照 → 反复弹询问。
 */
export function makeDesktopSecurityProvider(
  ctx: Pick<ToolContext, 'sessionId' | 'requestUserInput'>,
  getConfig: () => ProjectConfig
): SecurityHostProvider {
  return {
    host: 'desktop',
    pathSep: sep,
    realPath: resolveRealPath,
    getVars: () => {
      const workingDirectory = getConfig().workingDirectory
      return {
        ...hostPolicyVars(ctx.sessionId, workingDirectory),
        // 沙箱的那一面（ask-on-write 读）：与本会话命令实际受的限制同源，所以文件工具的免询问范围
        // 恰好是命令能写的范围；沙箱没套上时是一组空值，策略退回老行为
        ...sessionView(ctx.sessionId, workingDirectory),
        // 与沙箱开没开无关的那一半：文件工具在工作区里写入免询问（受保护位置照旧问；Windows 不给）
        ...workspaceWriteView(ctx.sessionId, workingDirectory)
      }
    },
    getSessionGrants: () => {
      const s = sessionRecords.pickSettings(ctx.sessionId, ['allowList'])
      return { allowList: s?.allowList ?? [] }
    },
    // 仅影响内置策略的人读面（description/body/规则 prompt）；规则的判定字段恒取 en
    getLanguage: () => i18next.language,
    // 内置策略 md：随包发布的目录现读（Resources/builtin-policies；缺席即装配期 throw，见 assemble）
    readBuiltinPolicyMd: (fileName) => policyService.readBuiltinPolicyMd(fileName),
    getUserPolicies: () => policyService.getUserPolicies(),
    shellParser,
    isDirectory: (p) => {
      try {
        return existsSync(p) && statSync(p).isDirectory()
      } catch {
        return false
      }
    },
    persistGrant: (mode, p) => sessionService.addAllowListPaths(ctx.sessionId, mode, [p]),
    requestUserInput: ctx.requestUserInput,
    // 每次调用现取注入的审查者（provider 可整会话复用，注入发生在启动时）
    onPermissionRequest: (event, signal) =>
      permissionReviewer ? permissionReviewer(event, signal) : Promise.resolve(null),
    logger: securityLog
  }
}

/**
 * 询问点的审查者（安全模块 onPermissionRequest 接缝的桌面实现，见 permissionReview.ts）。由 main
 * 启动时注入：直接 import 会经 hookService → AgentManager → agentHost 绕回本文件。
 * 没注入 = 没有审查，一律问人（单测默认如此）。
 */
type PermissionReviewer = NonNullable<SecurityHostProvider['onPermissionRequest']>
let permissionReviewer: PermissionReviewer | null = null

export function setPermissionReviewer(reviewer: PermissionReviewer | null): void {
  permissionReviewer = reviewer
}

/**
 * 桌面 SecurityContext（PEP 门面，agent 主体）。getConfig 缺省为按 sessionId 动态解析
 * （每次评估现查 —— 会话配置可变）。
 * 主体信息：ctx.agent 在（resolveTools 线程化进来的工具）就报档案名与 root / spawned —— 询问点
 * 的审查靠它认出「审查员自己在要权限」（防递归），审查员的输入也要知道是哪个 agent 在做这件事；
 * 不在（MCP 能力服务器等自建 ctx 的调用点）按 root 上报。sessionId 恒为根会话（派生 agent 的
 * 工具 ctx 也是），会话授权因此对派生 agent 同样生效。
 */
export function getDesktopSecurityContext(
  ctx: Pick<ToolContext, 'sessionId' | 'requestUserInput' | 'agent'>,
  getConfig?: () => ProjectConfig
): SecurityContext {
  const cfg = getConfig ?? ((): ProjectConfig => resolveProjectConfig(ctx.sessionId))
  return createSecurityContext(
    {
      kind: 'agent',
      sessionId: ctx.sessionId,
      agentKind: ctx.agent?.kind ?? 'root',
      ...(ctx.agent?.profileName ? { profileName: ctx.agent.profileName } : {})
    },
    {
      host: 'desktop',
      platform: process.platform,
      get workspaceDir() {
        return cfg().workingDirectory
      }
    },
    makeDesktopSecurityProvider(ctx, cfg)
  )
}

/**
 * 桌面 user 主体 SecurityContext —— 用户亲手的 UI 操作（预览面板取文件、
 * 笔记本自动保存…）经同一引擎判定，但主体是 'user'：内置防护策略全部
 * 显式限定 subject.kind: [agent]，对用户主体不生效（用户即管理员）；
 * 用户可自行写 subject.kind: [user] 的策略来约束 UI 面。永不弹询问。
 */
function getDesktopUserSecurityContext(getConfig: () => ProjectConfig): SecurityContext {
  return createSecurityContext(
    { kind: 'user', sessionId: '' },
    {
      host: 'desktop',
      platform: process.platform,
      get workspaceDir() {
        return getConfig().workingDirectory
      }
    },
    makeDesktopSecurityProvider({ sessionId: '' }, getConfig)
  )
}

/** ProjectEnvVar[] → Record<string, string>，过滤空 key */
function envVarsToRecord(envVars?: ProjectEnvVar[]): Record<string, string> | undefined {
  if (!envVars?.length) return undefined
  const result: Record<string, string> = {}
  for (const v of envVars) {
    if (v.key) result[v.key] = v.value
  }
  return Object.keys(result).length > 0 ? result : undefined
}

/** 通过 sessionId 查询当前项目配置（每次工具执行时调用，获取最新值） */
export function resolveProjectConfig(sessionId: string): ProjectConfig {
  const session = sessionService.getById(sessionId)
  const project = session?.projectId
    ? projectDao.pick(session.projectId, ['id', 'path', 'settings'])
    : undefined

  if (project) {
    // 有项目 → 使用项目配置
    return {
      workingDirectory: session?.workingDirectory ?? project.path,
      envVars: envVarsToRecord(project.settings?.tool?.envVars)
    }
  }

  // 无项目（临时会话） → 会话自带的工作目录（从系统打开的 md 窗口：文件所在目录），否则 temp workspace。
  // 口径与 sessionService.getById 同一处（workingDirectoryOf）；会话不存在时仍回落临时工作区
  return {
    workingDirectory: session?.workingDirectory ?? getTempWorkspace(sessionId)
  }
}
