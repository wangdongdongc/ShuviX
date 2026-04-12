/**
 * 工具共享类型与辅助函数
 * 所有工具通过 ToolContext + resolveProjectConfig 获取运行时项目配置
 */

import { resolve, sep } from 'path'
import { existsSync, statSync } from 'fs'
import type { TSchema, Static } from '@sinclair/typebox'
import type { AgentToolResult } from '@mariozechner/pi-agent-core'
import { projectDao } from '../dao/projectDao'
import { sessionDao } from '../dao/sessionDao'
import { sessionService } from '../services/sessionService'
import { getTempWorkspace, getToolResultsBase, getDefaultSkillsDir } from '../utils/paths'
import { skillService } from '../services/skillService'
import { buildAllowEntry, isPathAllowedUnified } from './utils/allowList'
import type { ReferenceDir, ProjectEnvVar } from '../types'
import type { ChatEvent } from '../frontend/core/types'

import type { InputRequest, InputResponse } from '../../shared/types/inputRequest'

export type {
  InputRequest,
  InputResponse,
  ApprovalInputRequest,
  ChoiceInputRequest,
  SshCredentialsInputRequest,
  ApprovalResponse,
  ChoiceResponse,
  SshCredentialsResponse,
  CancelResponse,
  InputRequestKind,
  SshCredentialPayload
} from '../../shared/types/inputRequest'

/** ChatEvent 去掉 sessionId 后的有效载荷（分布式 Omit，保留判别联合结构） */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never
export type ChatEventPayload = DistributiveOmit<ChatEvent, 'sessionId'>

/** 中止操作的统一错误消息（用于 sentinel 检查） */
export const TOOL_ABORTED = 'Aborted'

/** 项目配置（工具执行时动态查询） */
export interface ProjectConfig {
  /** 项目工作目录（宿主机路径） */
  workingDirectory: string
  /** 参考目录列表（按 access 属性控制读写权限） */
  referenceDirs: ReferenceDir[]
  /** PGLite 持久化存储开关 */
  pglitePersist?: boolean
  /** 项目 ID（持久化模式下用作 worker 共享 key） */
  projectId?: string
  /** 项目根目录路径（用于计算 PGLite dataDir） */
  projectPath?: string
  /** 项目环境变量（注入 bash 进程） */
  envVars?: Record<string, string>
}

/** 工具上下文 — 所有工具共享的运行时信息 */
export interface ToolContext {
  /** 当前会话 ID（通过它查询项目配置 + Docker 容器管理） */
  sessionId: string
  /** 并行执行协调器的 key 覆盖（默认使用 sessionId；子智能体使用独立 key 避免冲突） */
  parallelSessionKey?: string
  /**
   * 统一的"请求用户输入"入口。所有需要用户介入的工具(命令审批 / 选择题 / SSH 凭证)
   * 都通过此方法挂起,后端按 InputRequest.kind 路由,前端按 kind 渲染表单。
   *
   * - 永不超时:Promise 只能由用户响应或 agent.abort 触发 resolve
   * - 取消:返回 `{kind: 'cancel'}`,工具自行决定 throw 还是 fallback
   * - 副作用:用户响应可携带 `extra` 字段(如 `{rememberPattern: true}`),工具根据
   *   该字段处理副作用(如写入 allowList)
   */
  requestUserInput?: (request: InputRequest) => Promise<InputResponse>
  /** 工具运行时单向通知（容器、SSH 连接、预览面板等生命周期事件） */
  emitChatEvent?: (event: ChatEventPayload) => void
}

/** 检查路径是否在工作目录内（沙箱路径越界检查） */
export function isPathWithinWorkspace(absolutePath: string, workingDirectory: string): boolean {
  const resolved = resolve(absolutePath)
  const base = resolve(workingDirectory)
  return resolved === base || resolved.startsWith(base + sep)
}

/** 检查路径是否在任一参考目录内 */
export function isPathWithinReferenceDirs(
  absolutePath: string,
  referenceDirs: ReferenceDir[]
): boolean {
  const resolved = resolve(absolutePath)
  return referenceDirs.some((dir) => {
    const base = resolve(dir.path)
    return resolved === base || resolved.startsWith(base + sep)
  })
}

/** 检查路径是否在某个 readwrite 参考目录内 */
export function isPathWithinReadwriteReferenceDirs(
  absolutePath: string,
  referenceDirs: ReferenceDir[]
): boolean {
  const resolved = resolve(absolutePath)
  return referenceDirs.some((dir) => {
    if ((dir.access ?? 'readonly') !== 'readwrite') return false
    const base = resolve(dir.path)
    return resolved === base || resolved.startsWith(base + sep)
  })
}

/**
 * 沙箱守卫：只读访问（workspace + referenceDirs 均允许）
 * 用于 read、ls、grep、glob 等只读工具
 */
export async function assertSandboxRead(
  ctx: ToolContext,
  config: ProjectConfig,
  toolCallId: string,
  toolName: string,
  absolutePath: string,
  displayPath?: string
): Promise<void> {
  if (isPathWithinWorkspace(absolutePath, config.workingDirectory)) return
  if (isPathWithinReferenceDirs(absolutePath, config.referenceDirs)) return
  // 允许读取持久化的工具大结果文件
  if (absolutePath.startsWith(getToolResultsBase() + sep)) return
  // 允许读取全局 skills 目录（skill 工具加载后 AI 需读取伴随文件）
  if (absolutePath.startsWith(getDefaultSkillsDir() + sep)) return
  // 允许读取用户配置的外部 skill 目录
  if (skillService.listExternalDirs().some((d) => absolutePath.startsWith(d.path + sep))) return

  // 走会话级 autoApprove + allowList 检查
  const sess = sessionDao.pickSettings(ctx.sessionId, ['autoApprove', 'allowList'])
  if (sess?.autoApprove) return
  if (isPathAllowedUnified(sess?.allowList, 'read', absolutePath)) return

  await requestPathApproval(ctx, {
    toolCallId,
    toolName,
    mode: 'read',
    absolutePath,
    displayPath
  })
}

/**
 * 沙箱守卫：写入访问（workspace + readwrite 参考目录允许）
 * 用于 write、edit 等写入工具
 */
export async function assertSandboxWrite(
  ctx: ToolContext,
  config: ProjectConfig,
  toolCallId: string,
  toolName: string,
  absolutePath: string,
  displayPath?: string
): Promise<void> {
  if (isPathWithinWorkspace(absolutePath, config.workingDirectory)) return
  if (isPathWithinReadwriteReferenceDirs(absolutePath, config.referenceDirs)) return

  const sess = sessionDao.pickSettings(ctx.sessionId, ['autoApprove', 'allowList'])
  if (sess?.autoApprove) return
  if (isPathAllowedUnified(sess?.allowList, 'write', absolutePath)) return

  // 在只读参考目录内时,审批描述显式说明"批准会授予写权限"
  const isInsideReadonlyRef = isPathWithinReferenceDirs(absolutePath, config.referenceDirs)
  await requestPathApproval(ctx, {
    toolCallId,
    toolName,
    mode: 'write',
    absolutePath,
    displayPath,
    description: isInsideReadonlyRef
      ? 'This path is inside a read-only reference directory. Approving will grant write access.'
      : undefined
  })
}

/**
 * 路径越界 → 通过统一的 ApprovalInputRequest 机制等待用户批准。
 *
 * - 不通过 → throw(让 AI 收到 tool error 自行决定下一步)
 * - 通过 → return(单次放行)
 * - 通过 + extra.rememberPattern → 把 absolutePath 写入会话 allowList(read/write)
 * - **目录场景特殊**:read 模式下若 absolutePath 是目录,无论用户是否勾选"记住",
 *   都自动加入 allowList。这样后续访问该目录下的任何文件不再重复弹审批。
 */
async function requestPathApproval(
  ctx: ToolContext,
  params: {
    toolCallId: string
    toolName: string
    mode: 'read' | 'write'
    absolutePath: string
    displayPath?: string
    description?: string
  }
): Promise<void> {
  if (!ctx.requestUserInput) {
    // 无前端 → 直接拒绝
    const p = params.displayPath ?? params.absolutePath
    throw new Error(`Sandbox: access denied to path outside workspace: ${p}`)
  }
  // 探测路径类型 — 仅 read 关心目录(write 通常指向具体文件,目录 vs 文件不影响 UX)
  let pathIsDirectory = false
  if (params.mode === 'read') {
    try {
      pathIsDirectory =
        existsSync(params.absolutePath) && statSync(params.absolutePath).isDirectory()
    } catch {
      /* 路径不存在或权限不足 — 当作非目录处理 */
    }
  }
  // command 字段直接复用 allowList 条目格式 — 既是审批面板的展示文本,
  // 也是用户勾选"允许并记住"时写入 allowList 的字面值
  const command = buildAllowEntry(params.mode, params.absolutePath)
  const response = await ctx.requestUserInput({
    id: params.toolCallId,
    kind: 'approval',
    toolName: params.toolName,
    command,
    description: params.description,
    pathIsDirectory,
    createdAt: Date.now()
  })

  if (response.kind === 'cancel') {
    throw new Error(TOOL_ABORTED)
  }
  if (response.kind === 'other') {
    const p = params.displayPath ?? params.absolutePath
    throw new Error(`User declined access to ${p} and provided feedback instead: ${response.text}`)
  }
  if (response.kind !== 'approval' || !response.approved) {
    const p = params.displayPath ?? params.absolutePath
    throw new Error(
      (response.kind === 'approval' && response.reason) || `User denied access to ${p}`
    )
  }
  // 通过审批 — 仅当用户在前端明确确认"允许并记住"(预览态 → Confirm)时才写入 allowList
  if (response.extra?.rememberPattern) {
    sessionService.addAllowListPatterns(ctx.sessionId, params.mode, [params.absolutePath])
  }
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
      referenceDirs: project.settings?.referenceDirs || [],
      pglitePersist: project.settings?.tool?.pglitePersist,
      projectId: project.id,
      projectPath: project.path,
      envVars: envVarsToRecord(project.settings?.tool?.envVars)
    }
  }

  // 无项目（临时会话） → 使用 temp workspace
  return {
    workingDirectory: getTempWorkspace(sessionId),
    referenceDirs: []
  }
}

/**
 * 工具基类 — 所有内置工具必须继承此类
 * 生命周期：preExecute → execute（securityCheck → executeInternal）
 */
export abstract class BaseTool<TParams extends TSchema = TSchema> {
  abstract readonly name: string
  abstract readonly label: string
  abstract readonly description: string
  abstract readonly parameters: TParams

  /** 资源初始化（容器创建、连接建立等），在 execute 之前调用 */
  abstract preExecute(toolCallId: string, params: Record<string, unknown>): Promise<void>

  /**
   * 安全检查 — 沙箱路径越界等确定性校验，抛异常即阻止执行。
   * 动态/条件性审批（requestApproval）应留在 executeInternal 中。
   */
  protected abstract securityCheck(
    toolCallId: string,
    params: Static<TParams>,
    signal?: AbortSignal
  ): Promise<void>

  /** 工具核心逻辑 — securityCheck 通过后调用 */
  protected abstract executeInternal(
    toolCallId: string,
    params: Static<TParams>,
    signal?: AbortSignal,
    onUpdate?: (partialResult: AgentToolResult<unknown>) => void
  ): Promise<AgentToolResult<unknown>>

  /** 模板方法 — 固定顺序：securityCheck → executeInternal，子类不应覆写 */
  async execute(
    toolCallId: string,
    params: Static<TParams>,
    signal?: AbortSignal,
    onUpdate?: (partialResult: AgentToolResult<unknown>) => void
  ): Promise<AgentToolResult<unknown>> {
    await this.securityCheck(toolCallId, params, signal)
    return this.executeInternal(toolCallId, params, signal, onUpdate)
  }
}
