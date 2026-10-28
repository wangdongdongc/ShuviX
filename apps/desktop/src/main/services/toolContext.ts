/**
 * 工具上下文与路径询问 —— 供所有工具与服务共享的运行时基础设施
 * 所有工具通过 ToolContext + resolveProjectConfig 获取运行时项目配置
 */

import { isAbsolute, resolve, sep } from 'path'
import { existsSync, statSync } from 'fs'
import { homedir } from 'os'
import { projectDao } from '../dao/projectDao'
import { sessionRecords } from './sessionRecords'
import { sessionAcl } from './acl'
import { sessionService } from './sessionService'
import {
  getTempWorkspace,
  getToolResultsBase,
  getDefaultSkillsDir,
  getDefaultBotsDir,
  getDefaultPoliciesDir,
  getDefaultAgentsDir,
  getDefaultHooksDir,
  getBuiltinSkillsDir,
  getBuiltinKnowledgeDir,
  getSessionArtifactsDir,
  getDefaultDailyDir,
  getDefaultTrackingDir,
  isSafeSessionId
} from '../utils/paths'
import { resolveRealPath } from '../utils/toolUtils/realPath'
import { resolveToCwd } from '../utils/toolUtils/pathUtils'
import { skillService } from './skillService'
import { shellParser } from './shellParserService'
import { policyService } from './policyService'
import { botService } from './botService'
import { restoredCategoriesOf } from './redaction/restoredCalls'
import {
  type CommandRisk,
  createSecurityContext,
  type CallOwner,
  type EnforceOpts,
  type SecurityContext,
  type SecurityHostProvider,
  type SecuritySubject,
  type SessionObjectInput,
  type WidgetObjectInput,
  type UserPolicyFile
} from '@shuvix/agent-runtime'
import type { ProjectEnvVar } from '../types'
import { withCallAgent, type ToolAgentIdentity } from './toolAgent'
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
   *   该字段处理副作用(如写入会话权限表)
   */
  requestUserInput?: (request: InputRequest) => Promise<InputResponse>
  /** 工具运行时单向通知（容器、SSH 连接、预览面板等生命周期事件） */
  emitChatEvent?: (event: ChatEventPayload) => void
  /**
   * 本工具实例固定属于的 agent（按 agent 装配的工具才有）。会话级装配的工具（`shuvix.builtin`）
   * 不带它 —— 它们被同一会话的每个 agent 共用，身份按调用现取（`agentOf` + withCallAgent）。
   */
  agent?: ToolAgentIdentity
  /**
   * 按 durable 对话认出发起调用的 agent（会话级装配时由宿主给；phase 1 = 锁住的根 agent）。
   * 认不出交回 undefined —— 用的地方落回 `agent`，再落回各自的兜底。别直接读：经 withCallAgent。
   */
  agentOf?: (conversationId: number) => ToolAgentIdentity | undefined
  /**
   * 命令沙箱钉子（会话级装配时由宿主给：锁里的那一个）。bash 按它决定 schema / 描述 / 套不套沙箱；
   * 缺省 = 按此刻的全局开关给一份占位（还没有 agent 时的那份内置工具）。
   */
  sandboxed?: boolean
  /**
   * 根 agent 的技能货架（会话级装配时由宿主给：创建时解析出来的 / 锁里记着的；还没有 agent 时缺省）。会话级的
   * 内置工具被同一会话的每个 agent 共用，`widget` 工具据此决定描述里讲不讲造组件的那组动作（调用时再按发起
   * 调用的 agent 自己的货架核对一次）
   */
  rootSkills?: readonly string[]
}

// 调用方身份的两个纯函数住在 toolAgent.ts（不带任何服务依赖 —— 工具模块与它们的单测直接引那里）
export { agentActorOf, withCallAgent } from './toolAgent'
export type { ToolAgentIdentity } from './toolAgent'

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
  displayPath?: string,
  /** 这次调用的 durable 归属（taskId / conversationId，见 callOwnerOf）；询问与审查按它认人 */
  owner?: CallOwner
): Promise<void> {
  await getDesktopSecurityContext(ctx, () => config).enforcePath('read', absolutePath, {
    toolCallId,
    ...owner,
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
 * 主体同样是 **user**：内置 agent 门（ask-on-external-path 等）不生效 → 默认放行
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
  displayPath?: string,
  /** 这次调用的 durable 归属（taskId / conversationId，见 callOwnerOf）；询问与审查按它认人 */
  owner?: CallOwner
): Promise<void> {
  await getDesktopSecurityContext(ctx, () => config).enforcePath('write', absolutePath, {
    toolCallId,
    ...owner,
    toolName,
    displayPath,
    abortError: TOOL_ABORTED
  })
}

/**
 * 会话交互的 PEP（`session` 工具每个指向一条别的会话 —— 不是自己子会话 —— 的动作都过这里）：read = 查看，write =
 * 对话。出厂的 ask-on-session-access 在不是自己发起的那一轮、又不在会话权限表里时询问；「允许并记住」记进权限表
 * （persistSessionGrant）。拒绝 / 取消 / 反馈时抛错，文案给模型。
 */
/**
 * 会话客体里宿主补的事实（调用方只给 id / 标题 / ownTurn）：最后一次有用户消息的时刻、绑定的 bot。读不到的会话
 * （行已经没了）给建成时刻缺省的 epoch 与空串 —— 按时间放行的规则对它恒不命中
 */
export function sessionObjectFacts(sessionId: string): { lastActiveAt: string; bot: string } {
  const row = sessionRecords.pick(sessionId, ['lastActiveAt', 'createdAt'])
  const at = row?.lastActiveAt ?? row?.createdAt ?? 0
  return { lastActiveAt: new Date(at).toISOString(), bot: botService.identityOf(sessionId) }
}

export async function assertSessionAccess(
  ctx: ToolContext,
  access: 'read' | 'write',
  object: Omit<SessionObjectInput, 'lastActiveAt' | 'bot'>,
  opts: {
    toolCallId: string
    toolName: string
    /** `session` 工具的动作名（策略里的 tool.operation） */
    operation: string
    owner?: CallOwner
    signal?: AbortSignal
    /** 要发进那条会话的话（对话类动作）：卡片原样摆出来 */
    message?: string
  }
): Promise<void> {
  await getDesktopSecurityContext(ctx).enforceSession(
    access,
    { ...object, ...sessionObjectFacts(object.sessionId) },
    {
      toolCallId: opts.toolCallId,
      ...opts.owner,
      toolName: opts.toolName,
      operation: opts.operation,
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.message?.trim() ? { preview: { kind: 'message', text: opts.message } } : {}),
      abortError: TOOL_ABORTED
    }
  )
}

/**
 * 组件使用的 PEP（`widget` 工具每个要授权的动作都过这里）：read = 调读操作、预览；write = 调写操作、改组件
 * （构建、跑 SQL、导出）。出厂的 ask-on-widget-access 在会话权限表里没有覆盖这次访问的组件行时询问；「允许并
 * 记住」记进权限表（persistWidgetGrant）。拒绝 / 取消 / 反馈时抛错，文案给模型。
 */
export async function assertWidgetAccess(
  ctx: ToolContext,
  access: 'read' | 'write',
  object: WidgetObjectInput,
  opts: {
    toolCallId: string
    toolName: string
    /** `widget` 工具的动作名（策略里的 tool.operation） */
    operation: string
    owner?: CallOwner
    signal?: AbortSignal
  }
): Promise<void> {
  await getDesktopSecurityContext(ctx).enforceWidget(access, object, {
    toolCallId: opts.toolCallId,
    ...opts.owner,
    toolName: opts.toolName,
    operation: opts.operation,
    ...(opts.signal ? { signal: opts.signal } : {}),
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

/** 宿主提供的策略变量里与会话目录无关的那部分（多是留给用户自写策略引用的事实变量） */
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
      ...skillService.listExternalDirs().map((d) => d.path),
      ...skillService.listSharedDirs().map((d) => d.path)
    ],
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
    // 本会话自己的 artifacts 目录（事实变量；它也是权限表 vars.aclWrite 的一项）。按会话 id 取，与 artifact
    // 工具落盘用的是同一个 id。坏 id 给空串（inDir 对空串恒不命中）：空 id 会放大到所有会话的
    // artifacts，`..` 会放大到 ~/.shuvix（里面有 policies/）
    sessionArtifactsDir: isSafeSessionId(sessionId) ? getSessionArtifactsDir(sessionId) : '',
    home: homedir(),
    systemDirs: windowsSystemDirs(),
    // 此刻（ISO 8601，UTC）—— 按时间放行的规则拿它比：`timestamp(object.lastActiveAt) > timestamp(vars.now) - duration('168h')`
    now: new Date().toISOString(),
    // 日报与跟踪项目录（事实变量）：给 bot 放行读写它们的策略引用（内置日报 bot 的那份就是）
    dailyDir: getDefaultDailyDir(),
    trackingDir: getDefaultTrackingDir()
  }
}

/**
 * 桌面 SecurityHostProvider —— 把平台细节注入共享安全模块：
 *   - 变量表：会话权限表 aclRead / aclWrite（与命令沙箱同一份，见 services/acl）、aclSessionRead /
 *     aclSessionWrite（可以查看 / 对话的别的会话）、aclWidgetRead / aclWidgetWrite（可以只读 / 读写的组件）/
 *     home / workspace 等
 *     事实变量（策略 match/lets 里的 vars.*）
 *   - 真实路径：realPath（符号链接 / `..` / 盘上大小写）—— 安全模块拿它解析路径客体与 inDir 比较的
 *     每个目录，两边都按位置比。变量表因此照写法给即可：工作区、临时工作区（macOS 的
 *     /var → /private/var 这类系统级链接）由 inDir 现解析，不在这里预先 realpath
 *   - 内置策略：随包发布的 `builtin-policies/` 目录现读（policyService.readBuiltinPolicyMd）
 *   - 用户策略：~/.shuvix/policies 现扫（policyService）
 *   - persistGrant / persistSessionGrant / persistWidgetGrant 写进会话权限表（「允许并记住」）、statSync 判目录、前端 requestUserInput 透传
 *
 * 全部成员每次评估现读 —— 不跨调用缓存。context 实例在建会话时创建一次、整会话复用
 * （buildTools → makeDesktopFileToolDeps），若在此缓存权限表，则会话中途
 * 「允许并记住」写入之后，复用的实例仍持旧快照 → 反复弹询问。
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
      // 会话权限表（外部目录访问策略读 aclRead / aclWrite）：与命令沙箱同一份，所以文件工具在这以外
      // 询问，恰好就是沙箱里的命令读写不到的地方。不看沙箱开没开 —— 没有沙箱的平台一样只在这以外询问
      const acl = sessionAcl.pathView(ctx.sessionId)
      // 会话种类的行（ask-on-session-access 读 aclSessionRead / aclSessionWrite）：这条会话可以查看 / 对话的别的会话
      const sessions = sessionAcl.sessionView(ctx.sessionId)
      // 组件种类的行（ask-on-widget-access 读 aclWidgetRead / aclWidgetWrite）：这条会话可以只读 / 读写的组件
      const widgets = sessionAcl.widgetView(ctx.sessionId)
      return {
        ...hostPolicyVars(ctx.sessionId, workingDirectory),
        aclRead: acl.read,
        aclWrite: acl.write,
        aclSessionRead: sessions.read,
        aclSessionWrite: sessions.write,
        aclWidgetRead: widgets.read,
        aclWidgetWrite: widgets.write
      }
    },
    // 仅影响内置策略的人读面（description/body/规则 prompt）；规则的判定字段恒取 en
    getLanguage: () => i18next.language,
    // 内置策略 md：随包发布的目录现读（Resources/builtin-policies；缺席即装配期 throw，见 assemble）
    readBuiltinPolicyMd: (fileName) => policyService.readBuiltinPolicyMd(fileName),
    getUserPolicies: () => policyService.getUserPolicies(),
    isPolicyDisabled: (policy) => policyService.isDisabled(policy),
    shellParser,
    isDirectory: (p) => {
      try {
        return existsSync(p) && statSync(p).isDirectory()
      } catch {
        return false
      }
    },
    persistGrant: (mode, p) => void sessionAcl.grantPath(ctx.sessionId, p, mode),
    persistSessionGrant: (mode, id) => void sessionAcl.grantSession(ctx.sessionId, id, mode),
    persistWidgetGrant: (mode, id) => void sessionAcl.grantWidget(ctx.sessionId, id, mode),
    requestUserInput: ctx.requestUserInput,
    // 每次调用现取注入的审查者（provider 可整会话复用，注入发生在启动时）
    onPermissionRequest: (event, signal) =>
      permissionReviewer ? permissionReviewer(event, signal) : Promise.resolve(null),
    // 命令风险分类同样现取注入的那份（设置里没选分类模型时它自己交回 null）
    classifyCommand: (input, opts) =>
      commandClassifier
        ? commandClassifier(input, { ...opts, sessionId: ctx.sessionId })
        : Promise.resolve(null),
    logger: securityLog
  }
}

/**
 * 询问点的审查者（安全模块 onPermissionRequest 接缝的桌面实现，见 permissionReview.ts）。由 main
 * 启动时注入：直接 import 会经 hookService → AgentManager → agentHost 绕回本文件。
 * 没注入 = 没有审查，一律问人（单测默认如此）。
 *
 * `isReviewer` 认出审查员自己（判定型 hook 派出的 agent）：它的工具调用拿不到询问通道，会询问的一律按
 * fail-closed 拒绝 —— 审查员读文件是为了判断，读不到就当看不见，不能反过来去问人。没注入 = 谁都不是。
 */
type PermissionReviewer = NonNullable<SecurityHostProvider['onPermissionRequest']>
type ReviewerCheck = (agent: ToolAgentIdentity) => boolean
let permissionReviewer: PermissionReviewer | null = null
let isReviewer: ReviewerCheck = () => false

export function setPermissionReviewer(
  reviewer: PermissionReviewer | null,
  reviewerCheck: ReviewerCheck = () => false
): void {
  permissionReviewer = reviewer
  isReviewer = reviewerCheck
}

/**
 * 命令风险分类（安全模块 classifyCommand 接缝的桌面实现，见 commandClassifier.ts）。和审查者一样由
 * main 启动时注入 —— 它要模型注册表，直接 import 会把 models 拉进本文件的依赖。没注入 = 不分类。
 */
type CommandClassifierFn = (
  input: Parameters<NonNullable<SecurityHostProvider['classifyCommand']>>[0],
  opts: { signal?: AbortSignal; toolCallId?: string; sessionId: string }
) => Promise<CommandRisk | null>
let commandClassifier: CommandClassifierFn | null = null

export function setCommandClassifier(classifier: CommandClassifierFn | null): void {
  commandClassifier = classifier
}

/**
 * 桌面 SecurityContext（PEP 门面，agent 主体）。getConfig 缺省为按 sessionId 动态解析
 * （每次评估现查 —— 会话配置可变）。
 * 主体信息：报这个 agent 的档案名与 root / spawned —— 询问点的审查靠它认出「审查员自己在要权限」
 * （防递归），审查员的输入也要知道是哪个 agent 在做这件事。认不出（调用没带对话、宿主没接 agentOf、
 * 还没有锁）按 root 上报。内置 MCP 能力服务器同样交上 scope 的 agentOf，并把 `_meta` 里的
 * taskId / conversationId 并进 opts（P2-07）。sessionId 恒为根会话（派生 agent 的工具 ctx 也是），会话授权
 * 因此对派生 agent 同样生效。
 *
 * ctx 带 `agentOf`（会话级装配的工具，同一会话的每个 agent 共用一份）：每次 enforce 按 opts 里这次
 * 调用的 `conversationId` 现取主体（withCallAgent）—— 各 PEP 调用点本就把 callOwnerOf(call) 并进了
 * opts。evaluate / evaluateReadOnly（被动 UI，不带调用）用 ctx 自己的 `agent`。
 */
export function getDesktopSecurityContext(
  ctx: Pick<ToolContext, 'sessionId' | 'requestUserInput' | 'agent' | 'agentOf'>,
  getConfig?: () => ProjectConfig
): SecurityContext {
  const cfg = getConfig ?? ((): ProjectConfig => resolveProjectConfig(ctx.sessionId))
  const provider = makeDesktopSecurityProvider(ctx, cfg)
  // 审查员的调用：同一个 provider，只是既不送审查也没有询问通道 —— ask 一律按 fail-closed 拒绝
  // （见 setPermissionReviewer），这条性质在这里自己成立，不靠审查接缝对它交回 null
  const providerFor = (agent: ToolAgentIdentity | undefined): SecurityHostProvider =>
    agent && isReviewer(agent)
      ? { ...provider, onPermissionRequest: undefined, requestUserInput: undefined }
      : provider
  const contextFor = (agent: ToolAgentIdentity | undefined): SecurityContext =>
    createSecurityContext(
      {
        kind: 'agent',
        sessionId: ctx.sessionId,
        agentKind: agent?.kind ?? 'root',
        ...(agent?.profileName ? { profileName: agent.profileName } : {}),
        // 开放属性（惰性：没有规则引用就不算）。`subject.bot` = 这条会话绑定的 bot（对象 id，没有 id 时是名字；
        // 不是 bot 会话为空串）—— 写给某个 bot 放行 / 收紧的策略用它认人，不用档案名（任何会话都能把子会话钉成
        // 同一个档案）
        attrs: {
          get bot(): string {
            return botService.identityOf(ctx.sessionId)
          }
        }
      },
      {
        host: 'desktop',
        platform: process.platform,
        get workspaceDir() {
          return cfg().workingDirectory
        }
      },
      providerFor(agent)
    )
  const base = contextFor(ctx.agent)
  const forCall = (opts: { conversationId?: number }): SecurityContext => {
    if (!ctx.agentOf) return base
    const agent = withCallAgent(ctx, opts).agent
    return agent === ctx.agent ? base : contextFor(agent)
  }
  // 自动脱敏：这次工具调用的参数里还原了哪些类别（包装层记下的），补进 tool.restored（§3.5）
  const withRestored = <T extends EnforceOpts>(opts: T): T => {
    if (opts.restored !== undefined) return opts
    const restored = restoredCategoriesOf(ctx.sessionId, opts.taskId)
    return restored === undefined ? opts : { ...opts, restored }
  }
  return {
    evaluate: (action, object, opts) => base.evaluate(action, object, opts),
    evaluateReadOnly: (action, object, opts) => base.evaluateReadOnly(action, object, opts),
    judgeGate: (action, object, opts) => base.judgeGate(action, object, opts),
    enforcePath: (mode, resolvedPath, opts) =>
      forCall(opts).enforcePath(mode, resolvedPath, withRestored(opts)),
    enforceCommand: (object, opts) => forCall(opts).enforceCommand(object, withRestored(opts)),
    enforceGitOp: (object, opts) => forCall(opts).enforceGitOp(object, withRestored(opts)),
    enforceDatabase: (object, opts) => forCall(opts).enforceDatabase(object, withRestored(opts)),
    enforceUrl: (object, opts) => forCall(opts).enforceUrl(object, withRestored(opts)),
    enforceSession: (mode, object, opts) =>
      forCall(opts).enforceSession(mode, object, withRestored(opts)),
    enforceWidget: (mode, object, opts) =>
      forCall(opts).enforceWidget(mode, object, withRestored(opts)),
    enforceInvocation: (opts) => forCall(opts).enforceInvocation(withRestored(opts))
  }
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

/** 网络主体的宿主事实变量复用多久：与会话无关、几秒内不会变，而每个网络请求都要判一次 */
const NETWORK_VARS_TTL_MS = 5000
let networkVars: { at: number; vars: ReturnType<SecurityHostProvider['getVars']> } | null = null

/**
 * 远程访问的网络主体 SecurityContext（`frontend/network/policyGate.ts` 用，subject.kind = 'network'）。
 * 没有会话：vars 只有宿主事实（home、配置目录、技能目录……），没有会话目录、没有「允许并记住」；只用
 * judgeGate（不能询问的点位：ask 降级为拒绝），所以也不接询问通道与审查。用户策略读统一缓存，与 agent 同一份。
 *
 * `trial`（`shuvix policy check`）：用户策略换成给定的一份清单（某份草稿顶替同名文件之后的样子），告警交给
 * 调用方收集（求值出错的规则要原样报给 agent）。其余 —— 内置、停用开关、变量 —— 与真实检查同一份。
 */
export function getDesktopNetworkSecurityContext(
  subject: SecuritySubject,
  trial?: {
    userPolicies: UserPolicyFile[]
    logger: NonNullable<SecurityHostProvider['logger']>
  }
): SecurityContext {
  const base = makeDesktopSecurityProvider({ sessionId: '' }, () => ({ workingDirectory: '' }))
  const provider: SecurityHostProvider = {
    ...base,
    getVars: () => {
      const now = Date.now()
      if (networkVars === null || now - networkVars.at > NETWORK_VARS_TTL_MS) {
        networkVars = { at: now, vars: hostPolicyVars('', '') }
      }
      return networkVars.vars
    },
    ...(trial ? { getUserPolicies: () => trial.userPolicies, logger: trial.logger } : {})
  }
  return createSecurityContext(subject, { host: 'desktop', platform: process.platform }, provider)
}

/**
 * `shuvix policy check --redaction` 的试算：agent 主体（普通会话的根 agent；给了 bot 就是那个 bot 的），按给定的
 * 用户策略判。不属于任何会话：会话表、权限表都是空的（自动脱敏出口的两层用不到它们），也没有询问通道。
 */
export function getDesktopAgentTrialSecurityContext(
  subject: { bot?: string },
  trial: {
    userPolicies: UserPolicyFile[]
    logger: NonNullable<SecurityHostProvider['logger']>
  }
): SecurityContext {
  const base = makeDesktopSecurityProvider({ sessionId: '' }, () => ({ workingDirectory: '' }))
  const provider: SecurityHostProvider = {
    ...base,
    getVars: () => hostPolicyVars('', ''),
    getUserPolicies: () => trial.userPolicies,
    logger: trial.logger,
    onPermissionRequest: undefined,
    requestUserInput: undefined
  }
  return createSecurityContext(
    {
      kind: 'agent',
      sessionId: '',
      agentKind: 'root',
      profileName: 'work',
      attrs: { bot: subject.bot ?? '' }
    },
    { host: 'desktop', platform: process.platform },
    provider
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

/**
 * 笔记本会话自己那份文档的绝对路径（notebookPath 按会话工作目录解析）；不是笔记本会话 → null。
 * doc_* 的磁盘回落读写它；write / edit 不许碰它（只经 doc_* 改，见 fileToolDeps 的 refuseWrite）。
 */
export function resolveSessionDocument(sessionId: string): string | null {
  const notebookPath = sessionRecords.pickSettings(sessionId, ['notebookPath'])?.notebookPath
  if (!notebookPath) return null
  return resolveToCwd(notebookPath, resolveProjectConfig(sessionId).workingDirectory)
}

/** 这个路径是不是这条会话自己那份文档（跟过链接、按文件系统的大小写规则比） */
export function isSessionDocument(sessionId: string, path: string): boolean {
  const doc = resolveSessionDocument(sessionId)
  if (!doc) return false
  return resolve(doc) === resolve(path) || resolveRealPath(doc) === resolveRealPath(path)
}
