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
  DISPATCH_TOOL_NAME,
  LAZY_CONNECT_TIMEOUT_MS,
  renderKnowledgeGuide,
  type AgentHostAdapter,
  type AnyAgentTool,
  type PromptVars,
  type PromptVarsCtx,
  type SubAgentModelConfig,
  type ToolResolveRequest
} from '@shuvix/agent-runtime'
import type { ChatEvent } from '@shuvix/chat-protocol/events'
import { resolveModelRef } from '@shuvix/chat-protocol/agentModelRef'
import { isChromeTabSessionSettings } from '@shuvix/chat-protocol/chromeTabSession'
import type { ModelCapabilities } from '@shuvix/chat-protocol/types/provider'
import { existsSync } from 'fs'
import { join } from 'path'
import { type as osType, release as osRelease, platform } from 'os'
import { app } from 'electron'
import i18next from 'i18next'
import { formatLanguageDisplay, renderVisualCraft, renderVisualGuide } from '@shuvix/agent-runtime'
import { getBuiltinToolEntries } from '../services/toolRegistry'
import { SkillTool } from '../services/skillTool'
import { skillService } from '../services/skillService'
import { mcpService } from '../services/mcpService'
import { resolveModel } from '../services/agentModelResolver'
import { providerOAuthService } from '../services/providerOAuthService'
import { providerDao } from '../dao/providerDao'
import { sessionRecords } from '../services/sessionRecords'
import { projectDao } from '../dao/projectDao'
import { ensureSessionTree } from '../services/sessionStorage'
import { resolveInstructionContent } from '../services/instruction'
import { resolveProjectMemoryIndex } from '../services/memory'
import { httpLogService } from '../services/httpLogService'
import { llmNetwork } from '../services/llmNetwork'
import { chatFrontendRegistry } from '../frontend/core'
import {
  wrapToolOutput,
  getOutputStrategy,
  type ProcessToolOutputOverrides
} from '../services/wrapToolOutput'
import {
  electronEventSink,
  electronToolResultTransform,
  runtimeLogger
} from '../services/agentRuntimeAdapters'
import {
  getDesktopSecurityContext,
  resolveProjectConfig,
  type ToolContext
} from '../services/toolContext'
import type { Project } from '../types'
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node'
import { createAgentTool } from './AgentTool'
import { enabledBaseChoices } from '../services/knowledge'

/** 会话所属项目（变量表/注入解析与 SkillTool 的同源查询；无项目会话返回 undefined） */
function sessionProject(
  sessionId: string
): Pick<Project, 'name' | 'path' | 'systemPrompt' | 'settings'> | undefined {
  const session = sessionRecords.pick(sessionId, ['projectId'])
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

async function resolveDesktopTools(req: ToolResolveRequest): Promise<AnyAgentTool[]> {
  const ctx: ToolContext = {
    // 询问/项目配置/fileTime/输出落盘归属：root=自身，spawned=根会话（与旧两路一致）
    sessionId: req.rootSessionId,
    requestUserInput: req.requestUserInput,
    emitChatEvent: (event) =>
      chatFrontendRegistry.broadcast({ ...event, sessionId: req.rootSessionId } as ChatEvent),
    // agent 元数据线程化：档案名 + root/spawned + 惰性模型（知识库溯源章 `generated.by` 用）
    agent: { profileName: req.profile.name, kind: req.kind, getModelConfig: req.getModelConfig }
  }
  // L1 全工具门的评估门面（每次 evaluate 现读，实例可复用）；MCP/skill/dispatch 等
  // 无专属客体的工具由它统一获得"可设门"能力
  const security = getDesktopSecurityContext(ctx)
  // 超长输出落盘后给的是「用 read 取全文」——没有 read 的 agent（如 Chrome 标签页会话的 `tab`）
  // 取不回来，就只在内存里截断：它至少拿到截断上限那么多，而不是一段指向它没有的工具的预览
  const spill = req.names.includes('read')
  const wrap = (tool: object): AnyAgentTool =>
    wrapToolOutput(
      tool as PiAgentTool<TSchema, unknown>,
      req.rootSessionId,
      getOutputStrategy(tool),
      { ...pickOverrides(tool), spill },
      security
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
    if (name === DISPATCH_TOOL_NAME) continue // 统一在内置名单之后注入（见下）
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

  // agent 派发工具：白名单 opt-in；root 恒可派发，spawned 受深度上限（canSpawn）
  if (req.names.includes(DISPATCH_TOOL_NAME) && (req.kind === 'root' || req.spawn?.canSpawn)) {
    tools.push(
      wrap(
        createAgentTool(
          { sessionId: req.selfSessionId, requestUserInput: req.requestUserInput },
          { modelConfig: req.getModelConfig, rootSessionId: req.rootSessionId }
        )
      )
    )
  }

  // SkillTool：名单里点了名的 skill 才上架 —— 档案声明的（含内置的 `skill:builtin:drawing`）
  // 与会话勾选的一视同仁，root / spawned 同一条规则；带 projectPath（派生 agent 可见项目级
  // skills）。只有当这一次真有 skill 可给时才挂上：空手的工具只是噪音。
  const projectPath = sessionProject(req.rootSessionId)?.path
  if (skillNames.length > 0) {
    const skillTool = new SkillTool(skillNames, projectPath)
    if (skillTool.hasSkills) tools.push(wrap(skillTool))
  }

  // MCP 惰性启动：勾选的服务器到这一刻才连（并发；上次失败的在这里自动再试一次）。
  // 连不上就少这台的工具，Agent 照常创建 —— 但失败要让人看见：往会话里落一条错误提示，
  // 用户刚发出的那条消息就在眼前，不至于以为工具凭空消失了。
  const attempts = await Promise.all(
    mcpServers.map(async (server) => {
      // 连接期间把状态推给会话：占位卡上写明「正在连接 MCP」，用户知道这段等待在等什么。
      // 已连上的不报 —— 它瞬间落定，报了只会闪一下
      const notify = (connecting: boolean): void =>
        chatFrontendRegistry.broadcast({
          type: 'mcp_connecting',
          sessionId: req.rootSessionId,
          server,
          connecting
        })
      const announce = mcpService.statusByName(server, req.rootSessionId) !== 'connected'
      if (announce) notify(true)
      try {
        return {
          server,
          result: await mcpService.ensureServerByName(server, {
            timeoutMs: LAZY_CONNECT_TIMEOUT_MS,
            // 内置能力服务器按会话实例化；根会话 id 与 ToolContext.sessionId 同源，
            // 于是派生 agent 与根 agent 共用同一份实例（ssh 连接、CDP tab 都该是会话级的）
            sessionId: req.rootSessionId
          })
        }
      } finally {
        if (announce) notify(false)
      }
    })
  )
  for (const { server, result } of attempts) {
    if (!result.ok) {
      // 没 error = 这台已不在启用列表里（勾选早被 filterAvailableTools 滤掉，属边角情况），静默跳过
      if (result.error) {
        chatFrontendRegistry.broadcast({
          type: 'error',
          sessionId: req.rootSessionId,
          error: i18next.t('chat.mcpConnectFailed', { name: server, error: result.error })
        })
      }
      continue
    }
    // 实例按根会话取（派生 agent 与根 agent 共用一份），调用方身份按**这一个** agent 带：
    // 内置 server 要靠它把「谁看过哪份快照」之类的状态分开
    for (const mcpTool of mcpService.getAgentToolsByServerName(server, req.rootSessionId, {
      callerId: req.selfSessionId
    })) {
      tools.push(wrap(mcpTool))
    }
  }

  // 已实例化的附加工具（派发结果契约的 next 等）：与内置工具同样包装（截断 + L1 门），
  // 同名以 extraTools 为准 —— 先移除解析产物里的同名者再追加
  if (req.extraTools?.length) {
    const extraNames = new Set(
      req.extraTools.map((tool) => (tool as { name?: string }).name).filter(Boolean)
    )
    const kept = tools.filter((tool) => !extraNames.has((tool as { name?: string }).name))
    kept.push(...req.extraTools.map((tool) => wrap(tool as object)))
    return kept
  }
  return tools
}

// ─── 创建期变量表（{{shuvix:*}} 占位符取值；原 environment/workspace 段拆解而来） ───

/** 内置作图技能在档案 `shuvix-tools` 里的写法 */
const DRAWING_SKILL = 'skill:builtin:drawing'
/**
 * artifact 工具的名字（tools/artifact.ts）。这里只拿它比对名单，不为一个字符串去引入工具模块 ——
 * 工具模块加载即自注册。工具名本身就是档案 md 里写的契约，不会悄悄改
 */
const ARTIFACT_TOOL_NAME = 'artifact'

/**
 * 这个 agent 的货架上真有作图技能：名单点了它的名，且没在侧栏停用。与 SkillTool 上架是同一个
 * 判断（名单 ∩ findEnabled）—— 提示里的「先加载 builtin:drawing」因此只出现在加载得到的地方。
 *
 * 差一处，写明而不穿线：这里不带项目路径（派生 agent 的 ctx.sessionId 是 agentId，解析不出根会话的
 * 项目），SkillTool 带。两边只在「某个项目级 skill 的 frontmatter 自称 `builtin:drawing`、在那个
 * 项目里顶替了内置那份」时才可能分岔 —— 那是有人故意撞内置命名空间，不值得为它改变量表的入参。
 *
 * 名单里没点名时不去扫技能目录：大多数 agent（titler、explore…）走的是这条短路。
 */
function hasDrawingSkill(names: readonly string[]): boolean {
  if (!names.includes(DRAWING_SKILL)) return false
  const name = DRAWING_SKILL.slice('skill:'.length)
  return skillService.findEnabled().some((s) => s.name === name)
}

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
  // 作图说明的两个开关按**这一个 agent** 的名单判，与 resolveTools 读的是同一份（ctx.toolNames）：
  // 技能在架才有这份说明（契约与手艺都在技能里，常驻的只有「先加载」），否则整份不出；
  // 手里有 artifact 才教 adopt。
  // 这样说明里提到的每样东西都真在它手里 —— 派发出来的、覆盖了档案的、在侧栏停用了技能的都一样
  const visual = {
    drawingSkill: hasDrawingSkill(ctx.toolNames),
    artifact: ctx.toolNames.includes(ARTIFACT_TOOL_NAME),
    // 交互块不看名单，看回复落在哪儿：只有根 agent 的回复会显示成一条对话（派生 agent 的回复是
    // 交回父 agent 的工具结果），而 Chrome 标签页会话显示在扩展侧栏里 —— 那里的 CSP 跑不了它
    interactive:
      ctx.kind === 'root' &&
      !isChromeTabSessionSettings(sessionRecords.pickSettings(ctx.sessionId, ['chromeTab']))
  }
  return {
    workingDirectory: ctx.cwd,
    isGitRepo: existsSync(join(cwd, '.git')) ? 'Yes' : 'No',
    platform: platform(),
    shell: shellName,
    os: `${osType()} ${osRelease()}`,
    date: new Date().toISOString().slice(0, 10),
    language: formatLanguageDisplay(i18next.language),
    appVersion,
    // 内联作图：```svg 围栏是什么 + 「本会话第一张图前先加载作图技能」（契约与手艺都在技能里），
    // 技能不在架时为空串、占位符整块消失。与 body 同语言：界面语言是宿主的权威，档案构建期挑 body
    // 用的也是这一个。
    visualGuide: renderVisualGuide(i18next.language, visual),
    visualCraft: renderVisualCraft(i18next.language, visual),
    projectName: project?.name ?? '',
    // 根会话供给 {{shuvix:notebookPath}}（笔记本会话的根 Agent 走 notebook 基座档案）：
    // 非笔记本会话为空串 → 占位块收敛消失。派生 ctx.sessionId 是 agentId，无从解析 —— 不供给，
    // 占位符原样保留并 warn（派生档案本就不该引用它）
    ...(ctx.kind === 'root'
      ? {
          notebookPath:
            sessionRecords.pickSettings(ctx.sessionId, ['notebookPath'])?.notebookPath ?? ''
        }
      : {})
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
  // 订阅登录（OAuth）优先于 API Key —— 与 pi 的「存了凭据就归它管」同义：两者都配了时，
  // 用户配订阅显然是想用订阅额度。刷新失败这里会抛，不静默回退到 Key：一个「今天走订阅、
  // 明天悄悄走 API 计费」的降级，比一条要求重新登录的报错难查得多。
  getApiKey: async (p) => {
    const token = await providerOAuthService.getAccessToken(p)
    if (token) return token
    return providerDao.pick(p, ['apiKey'])?.apiKey || undefined
  },
  openSessionTree: (sessionId, cwd) => ensureSessionTree(sessionId, cwd),
  createExecutionEnv: (cwd) => new NodeExecutionEnv({ cwd }),
  eventSink: electronEventSink,
  network: llmNetwork,
  transformToolResult: electronToolResultTransform,
  httpLog: {
    logRequest: (params) => httpLogService.logRequest(params),
    updateUsage: (logId, input, output, total, responseJson) =>
      httpLogService.updateUsage(logId, input, output, total, responseJson)
  },
  logger: runtimeLogger,
  // 候选清单来自 agent 档案；sessionId 恒为根会话 id（派生按根会话解析），
  // cwd 空串（派生）时按会话项目配置兜底
  resolveInstruction: (sessionId, cwd, candidates) =>
    resolveInstructionContent(cwd || resolveProjectConfig(sessionId).workingDirectory, candidates),
  resolveProjectPrompt: (sessionId) => {
    return sessionProject(sessionId)?.systemPrompt?.trim() || null
  },
  // 无项目会话返回 null（不注入）—— 与项目提示词同一种降级
  resolveProjectMemory: (sessionId) => resolveProjectMemoryIndex(sessionId),
  // 知识库引导：只列这条会话启用了哪几个库（不扫库、不数条目、不给路径 —— 路径只由 knowledge
  // 工具发放），一个都没启用就回 null、整段不注入。档案带不带 knowledge 工具那道门在 createAgent 里
  resolveKnowledgeBases: (sessionId) => renderKnowledgeGuide(enabledBaseChoices(sessionId))
}

/** 桌面唯一 agent 工厂：根会话（AgentSession）与派生（AgentManager）共用 */
export const agentFactory = createAgentFactory(desktopAgentHost)
