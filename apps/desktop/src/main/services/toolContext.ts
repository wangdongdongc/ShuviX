/**
 * 工具上下文与路径询问 —— 供所有工具与服务共享的运行时基础设施
 * 所有工具通过 ToolContext + resolveProjectConfig 获取运行时项目配置
 */

import { resolve, sep } from 'path'
import { existsSync, statSync } from 'fs'
import { homedir } from 'os'
import { projectDao } from '../dao/projectDao'
import { sessionDao } from '../dao/sessionDao'
import { sessionService } from './sessionService'
import {
  getTempWorkspace,
  getToolResultsBase,
  getDefaultSkillsDir,
  getMemoryRootDir,
  getBuiltinSkillsDir
} from '../utils/paths'
import { skillService } from './skillService'
import { shellParser } from './shellParserService'
import { policyService } from './policyService'
import {
  createSecurityContext,
  type SecurityContext,
  type SecurityHostProvider
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
  SshCredentialsInputRequest,
  AskResponse,
  ChoiceResponse,
  SshCredentialsResponse,
  CancelResponse,
  InputRequestKind,
  SshCredentialPayload
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
}

/** 检查路径是否在工作目录内（路径越界检查） */
export function isPathWithinWorkspace(absolutePath: string, workingDirectory: string): boolean {
  const resolved = resolve(absolutePath)
  const base = resolve(workingDirectory)
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
 * Windows 的系统目录（protect-system 策略的 {{systemDirs}} 变量）——
 * 来自环境变量，POSIX 系统返回空（策略里的 POSIX/darwin 前缀是字面量）。
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
 * 桌面 SecurityHostProvider —— 把平台细节注入共享安全模块：
 *   - 变量表：workspace / tool_results / skills 目录 / home（策略 match/lets 里的 vars.*）
 *   - 会话授权：SQLite autoAllow + allowList
 *   - 用户策略：~/.shuvix/policies 现扫（policyService）
 *   - persistGrant 写 allowList、statSync 判目录、前端 requestUserInput 透传
 *
 * 全部成员每次评估现读 —— 不跨调用缓存。context 实例在建会话时创建一次、整会话复用
 * （buildTools → makeDesktopFileToolDeps），若在此缓存 autoAllow/allowList，则会话中途
 * 开启「免询问」或「允许并记住」写入 SQLite 后，复用的实例仍持旧快照 → 反复弹询问。
 */
export function makeDesktopSecurityProvider(
  ctx: Pick<ToolContext, 'sessionId' | 'requestUserInput'>,
  getConfig: () => ProjectConfig
): SecurityHostProvider {
  return {
    host: 'desktop',
    pathSep: sep,
    getVars: () => ({
      workspace: getConfig().workingDirectory,
      toolResultsBase: getToolResultsBase(),
      skillsDirs: [
        getDefaultSkillsDir(),
        getBuiltinSkillsDir(),
        ...skillService.listExternalDirs().map((d) => d.path)
      ],
      memoryDirs: [getMemoryRootDir()],
      home: homedir(),
      systemDirs: windowsSystemDirs()
    }),
    getSessionGrants: () => {
      const s = sessionDao.pickSettings(ctx.sessionId, ['autoAllow', 'allowList'])
      return { autoAllow: !!s?.autoAllow, allowList: s?.allowList ?? [] }
    },
    // 仅影响内置策略的人读面（description/body/规则 prompt）；规则的判定字段恒取 en
    getLanguage: () => i18next.language,
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
    logger: securityLog
  }
}

/**
 * 桌面 SecurityContext（PEP 门面，agent 主体）。getConfig 缺省为按 sessionId 动态解析
 * （每次评估现查 —— 会话配置可变）。
 * 主体信息：ToolContext 尚未携带 agent 档案元数据，暂以 root 会话身份上报
 * （profile/agentKind 维度的规则匹配是扩展位，宿主线程化 agent 信息后即可启用）。
 */
export function getDesktopSecurityContext(
  ctx: Pick<ToolContext, 'sessionId' | 'requestUserInput'>,
  getConfig?: () => ProjectConfig
): SecurityContext {
  const cfg = getConfig ?? ((): ProjectConfig => resolveProjectConfig(ctx.sessionId))
  return createSecurityContext(
    { kind: 'agent', sessionId: ctx.sessionId, agentKind: 'root' },
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

  // 无项目（临时会话） → 使用 temp workspace
  return {
    workingDirectory: getTempWorkspace(sessionId)
  }
}
