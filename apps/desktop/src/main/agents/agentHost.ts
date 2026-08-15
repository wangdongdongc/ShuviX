/**
 * 桌面 AgentHostAdapter —— 统一创建管线（createAgentFactory）的端适配，唯一 agentFactory 实例。
 *
 * resolveTools 合并旧 buildTools（注册表 defaultEnabled 驱动，根会话）与
 * buildSubAgentTools（白名单驱动，派生）两条装配路径为单一「按名解析」：
 * 根会话名单来自 default 档案 tools（+ 会话勾选 overlay），派生来自各自档案 ——
 * defaultEnabled 概念已由 default 档案的显式工具清单取代（注册表字段已删除）。
 * 工具顺序与旧根会话一致：名单序内置 → Agent 派发 → SkillTool → MCP。
 *
 * 与旧派生装配的两点有意差异（随统一落地的修复）：
 * - SkillTool 带 projectPath：派生 agent 现在能看到项目级 .claude/skills/；
 * - 派发工具 modelConfig 走惰性 getter：跟随会话当前模型/思考档位（原为构造时快照）。
 */
import type { AgentTool as PiAgentTool } from '@earendil-works/pi-agent-core'
import type { TSchema } from 'typebox'
import {
  createAgentFactory,
  renderProfileSystemPrompt,
  toInProcessAgentType,
  NOTEBOOK_PROFILE_NAME,
  type AgentHostAdapter,
  type AnyAgentTool,
  type PromptVars,
  type PromptVarsCtx,
  type SubAgentModelConfig,
  type ToolResolveRequest
} from '@shuvix/agent-runtime'
import type { ChatEvent } from '@shuvix/chat-protocol/events'
import { resolveModelRef } from '@shuvix/chat-protocol/agentModelRef'
import type { ModelCapabilities } from '@shuvix/chat-protocol/types/provider'
import { existsSync } from 'fs'
import { join } from 'path'
import { type as osType, release as osRelease, platform } from 'os'
import { app } from 'electron'
import i18next from 'i18next'
import { formatLanguageDisplay } from '@shuvix/agent-runtime'
import { getBuiltinToolEntries } from '../services/toolRegistry'
import { agentService } from '../services/agentService'
import { SkillTool } from '../services/skillTool'
import { mcpService } from '../services/mcpService'
import { resolveModel } from '../services/agentModelResolver'
import { providerDao } from '../dao/providerDao'
import { sessionDao } from '../dao/sessionDao'
import { projectDao } from '../dao/projectDao'
import { ensureSessionTree } from '../services/sessionStorage'
import { resolveInstructionContent } from '../services/instruction'
import { hookService } from '../services/hooks'
import { httpLogService } from '../services/httpLogService'
import { chatFrontendRegistry } from '../frontend/core'
import {
  wrapToolOutput,
  getOutputStrategy,
  type ProcessToolOutputOverrides
} from '../services/wrapToolOutput'
import {
  electronEventSink,
  electronToolResultTransform,
  createShouldDeferToolDisplay,
  runtimeLogger
} from '../services/agentRuntimeAdapters'
import { resolveProjectConfig, type ToolContext } from '../services/toolContext'
import type { Project } from '../types'
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node'
import { createAgentTool } from './AgentTool'

/** 会话所属项目（变量表/注入解析与 SkillTool 的同源查询；无项目会话返回 undefined） */
function sessionProject(
  sessionId: string
): Pick<Project, 'name' | 'path' | 'systemPrompt' | 'settings'> | undefined {
  const session = sessionDao.pick(sessionId, ['projectId'])
  return session?.projectId
    ? projectDao.pick(session.projectId, ['name', 'path', 'systemPrompt', 'settings'])
    : undefined
}

/** 从 tool 上读取可选的 maxBytes / maxLines 覆写（原 agentToolBuilder / AgentManager 两份重复实现合一） */
function pickOverrides(tool: object): ProcessToolOutputOverrides | undefined {
  const t = tool as { outputMaxBytes?: number; outputMaxLines?: number }
  if (t.outputMaxBytes == null && t.outputMaxLines == null) return undefined
  return { maxBytes: t.outputMaxBytes, maxLines: t.outputMaxLines }
}

// ─── 工具解析（root/spawned 统一按名解析） ──────────────────────

function resolveDesktopTools(req: ToolResolveRequest): AnyAgentTool[] {
  const ctx: ToolContext = {
    // 审批/项目配置/fileTime/输出落盘归属：root=自身，spawned=根会话（与旧两路一致）
    sessionId: req.rootSessionId,
    requestUserInput: req.requestUserInput,
    emitChatEvent: (event) =>
      chatFrontendRegistry.broadcast({ ...event, sessionId: req.rootSessionId } as ChatEvent)
  }
  const wrap = (tool: object): AnyAgentTool =>
    wrapToolOutput(
      tool as PiAgentTool<TSchema, unknown>,
      req.rootSessionId,
      getOutputStrategy(tool),
      pickOverrides(tool)
    ) as unknown as AnyAgentTool

  const builtinMap = new Map(
    getBuiltinToolEntries()
      .filter((e) => e.factory)
      .map((e) => [e.name, e])
  )
  const tools: AnyAgentTool[] = []
  const skillNames: string[] = []
  const mcpServers: string[] = []

  for (const name of req.names) {
    if (name === 'Agent') continue // 统一在内置名单之后注入（见下）
    if (name.startsWith('mcp:')) {
      mcpServers.push(name.slice(4))
      continue
    }
    if (name.startsWith('skill:')) {
      skillNames.push(name.slice(6))
      continue
    }
    const entry = builtinMap.get(name)
    // 未知名静默跳过（与旧派生白名单语义一致；宿主缺失的工具名在此自然缺位）
    if (entry?.factory) tools.push(wrap(entry.factory(ctx)))
  }

  // Agent 派发工具：白名单 opt-in；root 恒可派发，spawned 受深度上限（canSpawn）
  if (req.names.includes('Agent') && (req.kind === 'root' || req.spawn?.canSpawn)) {
    tools.push(
      wrap(
        createAgentTool(
          { sessionId: req.selfSessionId, requestUserInput: req.requestUserInput },
          { modelConfig: req.getModelConfig, rootSessionId: req.rootSessionId }
        )
      )
    )
  }

  // SkillTool：root 有项目即注入（空名单也注入 —— 项目级 skills 兜底）；
  // spawned 仅具名注入，但带 projectPath（修复：派生 agent 可见项目级 skills）
  const projectPath = sessionProject(req.rootSessionId)?.path
  if (skillNames.length > 0 || (req.kind === 'root' && projectPath)) {
    tools.push(wrap(new SkillTool(skillNames, projectPath)))
  }

  for (const server of mcpServers) {
    for (const mcpTool of mcpService.getAgentToolsByServerName(server)) {
      tools.push(wrap(mcpTool))
    }
  }
  return tools
}

// ─── 创建期变量表（{{shuvix:*}} 占位符取值；原 environment/workspace 段拆解而来） ───

/**
 * 桌面变量表：environment 类标量（git/平台/shell/os/日期/语言/版本，取值逻辑自原
 * environment 段平移）+ 工作目录 + 项目名。文本本身（标题/标签/句式）已内化进
 * agent md body；项目提示词不是变量 —— 走上下文注入（见下方 resolveProjectPrompt）。
 */
function desktopPromptVars(ctx: PromptVarsCtx): PromptVars {
  const cwd = ctx.cwd || process.cwd()
  const shell = process.env.SHELL || 'unknown'
  const shellName = shell.includes('zsh')
    ? 'zsh'
    : shell.includes('bash')
      ? 'bash'
      : shell.includes('fish')
        ? 'fish'
        : shell
  const appVersion = (() => {
    try {
      return app.getVersion()
    } catch {
      return 'unknown'
    }
  })()
  const project = sessionProject(ctx.sessionId)
  return {
    workingDirectory: ctx.cwd,
    isGitRepo: existsSync(join(cwd, '.git')) ? 'Yes' : 'No',
    platform: platform(),
    shell: shellName,
    os: `${osType()} ${osRelease()}`,
    date: new Date().toISOString().slice(0, 10),
    language: formatLanguageDisplay(i18next.language),
    appVersion,
    projectName: project?.name ?? ''
  }
}

/**
 * 档案 `shuvix-model` 的值 → 可用模型表里的一条（含能力点）。不可用返回 null。
 *
 * 目录只取「已启用提供商的已启用模型」：档案指向一个被停用的模型时视为不可用，
 * 由调用方回落（spawned 回落派发方模型 / 切档案时不写种子），而不是在这里硬拉起
 * 一个用户已经关掉的模型。派生创建（AgentHostAdapter）与切档案种子共用此函数。
 */
export function resolveProfileModelSpec(spec: string): SubAgentModelConfig | null {
  const hit = resolveModelRef(spec, providerDao.findAllEnabledModels())
  if (!hit) return null
  let capabilities: ModelCapabilities = {}
  try {
    capabilities = hit.capabilities ? JSON.parse(hit.capabilities) : {}
  } catch {
    /* 能力点解析失败按空能力处理，与 resolveSessionAgentContext 同口径 */
  }
  return { provider: hit.providerId, model: hit.modelId, capabilities }
}

// ─── 宿主适配面 + 唯一工厂实例 ──────────────────────────────────

const desktopAgentHost: AgentHostAdapter = {
  resolveTools: resolveDesktopTools,
  promptVars: desktopPromptVars,
  buildModel: (config, extra) =>
    resolveModel({
      provider: config.provider,
      model: config.model,
      capabilities: config.capabilities,
      baseUrl: extra?.baseUrl,
      apiProtocol: extra?.apiProtocol
    }),
  resolveProfileModel: resolveProfileModelSpec,
  getApiKey: (p) => providerDao.pick(p, ['apiKey'])?.apiKey || undefined,
  openSessionTree: (sessionId, cwd) => ensureSessionTree(sessionId, cwd),
  createExecutionEnv: (cwd) => new NodeExecutionEnv({ cwd }),
  eventSink: electronEventSink,
  shouldDeferToolDisplay: (sessionId) => createShouldDeferToolDisplay(sessionId),
  transformToolResult: electronToolResultTransform,
  hooks: hookService,
  httpLog: {
    logRequest: (params) => httpLogService.logRequest(params),
    updateUsage: (logId, input, output, total, responseJson) =>
      httpLogService.updateUsage(logId, input, output, total, responseJson)
  },
  logger: runtimeLogger,
  // sessionId 恒为根会话 id（派生按根会话解析）；cwd 空串（派生）时按会话项目配置兜底
  resolveInstruction: (sessionId, cwd) =>
    resolveInstructionContent(sessionId, cwd || resolveProjectConfig(sessionId).workingDirectory),
  resolveProjectPrompt: (sessionId) => {
    return sessionProject(sessionId)?.systemPrompt?.trim() || null
  }
}

/** 桌面唯一 agent 工厂：根会话（AgentSession）与派生（AgentManager）共用 */
export const agentFactory = createAgentFactory(desktopAgentHost)

/**
 * 组装笔记本一次性子代理的完整系统提示（sessionService.buildNotebookRunParams 调用）。
 *
 * 走 notebook 基座档案而非 default —— 笔记任务与「软件工程助手」人格错位。
 * 这里就地渲染而不是交给 createAgent：派生 agent 的 promptVars ctx 拿到的是 agentId
 * 而非会话 id，宿主无从解析 notebookPath；渲染后的文本作为派生档案的 systemPrompt 下传，
 * createAgent 里的第二次替换对已无占位符的文本是 no-op。
 */
export async function renderNotebookSystemPrompt(
  sessionId: string,
  cwd: string,
  notebookPath: string
): Promise<string> {
  const profile = toInProcessAgentType(agentService.getProfile(NOTEBOOK_PROFILE_NAME)!)
  return renderProfileSystemPrompt(
    profile,
    { ...desktopPromptVars({ sessionId, kind: 'root', cwd }), notebookPath },
    runtimeLogger
  )
}
