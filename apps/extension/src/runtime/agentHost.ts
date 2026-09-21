/**
 * 扩展 AgentHostAdapter —— 统一创建管线（createAgentFactory）的浏览器端适配。
 *
 * root（根会话）：按会话基座档案（work / chat / notebook）的名单装配工具（ask/read/write/edit；
 * bash/ls/grep/glob/ssh/database 等宿主缺失名自动跳过）+ 全部已启用 MCP（宿主策略，
 * 等价旧「全量注入不过滤」；服务器惰性启动 —— 就在这一刻连）—— 浏览器就在这里：它是一台
 * 恒启用的内置 MCP 能力服务器（mcp__browser__*），不再是按名装配的内置工具；工具池登记进 sessionTools 供派生复用；systemPrompt 经
 * persona/workspace 两个具名段组装（'project' 段扩展不注册 → 引用时跳过）；
 * instruction 与桌面统一走 entry 懒注入（不再拼进 systemPrompt）。
 *
 * spawned（派生）：沿用扩展既有模型 —— **复用父会话已实例化的工具**（sessionTools
 * 查表；与根 Agent 同工作目录/同询问范围），names 白名单按名筛选。派发工具注入策略
 * 与旧实现一致：默认子代理（names 空）无条件可再派发、具名定义须显式白名单 'agent'
 * （层级由内核 canSpawn 约束）。
 */
import type { AgentTool } from '@earendil-works/pi-agent-core'
import i18next from 'i18next'
import {
  createAgentFactory,
  formatLanguageDisplay,
  renderVisualCraft,
  renderVisualGuide,
  DISPATCH_TOOL_NAME,
  LAZY_CONNECT_TIMEOUT_MS,
  createAskTool,
  createStubExecutionEnv,
  type AgentHostAdapter,
  type AnyAgentTool,
  type PromptVars,
  type PromptVarsCtx,
  type RuntimeLogger,
  type ToolResolveRequest
} from '@shuvix/agent-runtime'
import type { InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import { settingsStore } from '../storage/settingsStore'
import { sessionStore } from '../storage/sessionStore'
import { projectStore } from '../storage/projectStore'
import { ensureSessionTree } from '../storage/sessionEntryStore'
import { getTempWorkspaceHandle } from '../storage/opfsWorkspace'
import { eventBus } from './eventBus'
import { mcpManager } from './mcpRuntime'
import { createFileTools } from './fileTools'
import { createSpillSink } from './opfsSpillSink'
import { setSessionInputChannel } from './userInputBroker'
import { wrapToolsOutput } from './wrapToolOutput'
import { createExtensionSecurityContext } from './securityProvider'
import { resolveSessionModel, capsFor } from './resolveSessionModel'
import { resolveModelRef } from '@shuvix/chat-protocol/agentModelRef'
import { resolveInstructionForSession } from './instructionFilesRuntime'
import { getSessionTools, registerSessionTools, createExtensionDispatchTool } from './subAgent'

const logger: RuntimeLogger = {
  info: (m) => console.info('[shuvix]', m),
  warn: (m) => console.warn('[shuvix]', m),
  error: (m) => console.error('[shuvix]', m)
}

// ─── workspaceIntro 变量的条件开头句（browser/ask/无 shell 的共享尾巴已内化进 default body） ───

/** 临时会话：私有隔离工作目录（OPFS）的开头句 */
const SCRATCH_INTRO = `You have a private, isolated scratch working directory. You can read, write, and edit files in it using
the file tools (paths are relative to the directory root; you cannot escape it) — use it for intermediate
results, notes, or generated content.`

/** 项目会话：绑定文件夹的开头句 */
function projectIntro(folderName: string): string {
  return `You are working inside the project folder "${folderName}". You can read, write, and edit files within
this folder using the file tools (paths are relative to the folder root; you cannot escape it).`
}

/** 会话 → 项目句柄（无项目/句柄失效返回 undefined） */
async function projectHandleForSession(
  sessionId: string
): Promise<FileSystemDirectoryHandle | undefined> {
  const session = await sessionStore.getById(sessionId)
  await projectStore.loadState()
  return session?.projectId ? projectStore.getHandle(session.projectId) : undefined
}

// ─── 创建期变量表（{{shuvix:*}} 占位符取值；原 environment/workspace 段拆解而来） ───

/**
 * 扩展变量表：environment 类标量（浏览器变体）+ 工作目录标签 + workspaceIntro
 * （scratch/项目两种条件开头句 —— 唯一保留的条件文本；共享尾巴静态在 body 里）。
 */
async function extensionPromptVars(ctx: PromptVarsCtx): Promise<PromptVars> {
  const handle = await projectHandleForSession(ctx.sessionId)
  const appVersion = (() => {
    try {
      return chrome.runtime.getManifest().version
    } catch {
      return 'unknown'
    }
  })()
  return {
    workingDirectory: handle?.name ?? 'scratch',
    platform: 'Chrome Extension',
    date: new Date().toISOString().slice(0, 10),
    language: formatLanguageDisplay(i18next.language),
    appVersion,
    // 内联作图的规矩与调色板 token（自含块）—— 围栏渲染在共用的 chat-ui 里，两端都成立。
    // 两个开关都不开：这一端没有 SkillTool（下面 resolveTools 直接丢弃 `skill:` 名）、也没有
    // artifact 工具 —— 于是手艺整段留在提示里，也不教 adopt。开了就是指向这里不存在的东西
    visualGuide: renderVisualGuide(i18next.language),
    visualCraft: renderVisualCraft(i18next.language),
    workspaceIntro: handle ? projectIntro(handle.name) : SCRATCH_INTRO,
    // 根会话供给 {{shuvix:notebookPath}}（笔记本会话的根 Agent 走 notebook 基座档案）：
    // 非笔记本会话为空串 → 占位块收敛消失。派生 ctx.sessionId 是 agentId，无从解析 —— 不供给
    ...(ctx.kind === 'root'
      ? { notebookPath: (await sessionStore.getById(ctx.sessionId))?.settings?.notebookPath ?? '' }
      : {})
  }
}

// ─── 工具解析 ───

/** root：按名单装配（宿主缺失名跳过）+ 全量 MCP + 工具池登记 + 派发工具 */
async function resolveRootTools(req: ToolResolveRequest): Promise<AnyAgentTool[]> {
  const sessionId = req.rootSessionId
  const requestUserInput =
    req.requestUserInput ??
    ((): Promise<InputResponse> => Promise.reject(new Error('NO_INTERACTIVE_INPUT')))
  // 内置能力服务器（browser）的安全门按会话取询问通道 —— 在这里登记，运行时销毁时注销
  setSessionInputChannel(sessionId, requestUserInput)
  const projectHandle = await projectHandleForSession(sessionId)

  let fileSuite: AgentTool[]
  let spillSink: ReturnType<typeof createSpillSink>
  if (projectHandle) {
    fileSuite = createFileTools(projectHandle, { requestUserInput })
    spillSink = createSpillSink(projectHandle, { writeGitignore: true })
  } else {
    const tempHandle = await getTempWorkspaceHandle(sessionId)
    fileSuite = createFileTools(tempHandle, { requiresPermission: false, requestUserInput })
    spillSink = createSpillSink(tempHandle)
  }

  const built: AgentTool[] = []
  for (const name of req.names) {
    if (name === DISPATCH_TOOL_NAME || name.startsWith('mcp:') || name.startsWith('skill:'))
      continue
    if (name === 'ask') {
      built.push(createAskTool({ requestUserInput, abortError: 'TOOL_ABORTED' }) as AgentTool)
      continue
    }
    const fileTool = fileSuite.find((t) => (t as { name?: string }).name === name)
    if (fileTool) built.push(fileTool)
    // 其余（bash/ls/grep/glob/ssh/database…）宿主缺失 → 静默跳过
  }
  // MCP 惰性启动：装配工具这一刻才连全部已启用 server（扩展没有会话级勾选，全量注入），
  // 上次失败的在这里自动再试一次。连不上就少这台的工具，并往会话里落一条错误提示 ——
  // 用户刚发出的那条消息就在眼前，不至于以为工具凭空消失了
  // 连接期间把状态推给会话：占位卡上写明「正在连接 MCP」；已连上的不报（瞬间落定，只会闪一下）
  const pendingServers = mcpManager
    .getEnabledToolNames()
    .map((n) => n.slice('mcp:'.length))
    .filter((n) => mcpManager.statusByName(n, sessionId) !== 'connected')
  const notify = (connecting: boolean): void => {
    for (const server of pendingServers) {
      eventBus.emit({ type: 'mcp_connecting', sessionId, server, connecting })
    }
  }
  notify(true)
  let mcpResults: Awaited<ReturnType<typeof mcpManager.ensureEnabled>>
  try {
    // 带上会话：内置能力服务器（browser）按会话实例化，没有会话就没有它
    mcpResults = await mcpManager.ensureEnabled({ timeoutMs: LAZY_CONNECT_TIMEOUT_MS, sessionId })
  } finally {
    notify(false)
  }
  for (const { name, result } of mcpResults) {
    if (result.error) {
      eventBus.emit({
        type: 'error',
        sessionId,
        error: i18next.t('chat.mcpConnectFailed', { name, error: result.error })
      })
    }
  }
  // 只取全局 server + 本会话的内置实例（别的会话的 browser 实例不能混进来）；调用方身份是根会话 ——
  // 扩展的默认子代理复用这份工具池，与根 agent 同一个身份（与改动前的共享工具实例一致）
  built.push(...(mcpManager.getAllAgentTools(sessionId, { callerId: sessionId }) as AgentTool[]))

  // L1 全工具门（安全模块）：MCP 等无专属客体的工具由它统一获得"可设门"能力
  const security = createExtensionSecurityContext(sessionId, requestUserInput)
  const tools = wrapToolsOutput(built, spillSink, security)
  // 登记工具池（不含 agent 派发工具）—— 派生 agent 经 sessionTools 查表复用
  registerSessionTools(sessionId, tools as unknown as AnyAgentTool[])

  if (req.names.includes(DISPATCH_TOOL_NAME)) {
    tools.push(
      ...wrapToolsOutput(
        [
          createExtensionDispatchTool(
            sessionId,
            req.getModelConfig,
            // 默认子代理继承组装后的完整系统提示（body + environment/workspace）
            req.systemPrompt
          ) as unknown as AgentTool
        ],
        spillSink,
        security
      )
    )
  }
  return tools as unknown as AnyAgentTool[]
}

/** spawned：复用父会话工具池（与桌面「按名重实例化」有意不同，见文件头） */
function resolveSpawnedTools(req: ToolResolveRequest): AnyAgentTool[] {
  const map = getSessionTools(req.rootSessionId)
  if (!map) return []
  const whitelist = req.names.filter((n) => !n.startsWith('mcp:') && !n.startsWith('skill:'))
  const named = whitelist.length > 0
  const tools = [...map.values()].filter((t) => {
    const name = (t as { name?: string }).name ?? ''
    if (name === DISPATCH_TOOL_NAME) return false
    return named ? whitelist.includes(name) : true
  })
  // 派发工具：默认子代理（names 空）全员可派发；具名定义须显式白名单 'agent'
  if (req.spawn?.canSpawn && (!named || whitelist.includes(DISPATCH_TOOL_NAME))) {
    tools.push(
      createExtensionDispatchTool(
        req.selfSessionId,
        req.getModelConfig,
        // 嵌套默认子代理继承本 agent 的完整系统提示（与旧实现一致）
        req.systemPrompt
      ) as unknown as AnyAgentTool
    )
  }
  return tools
}

const extensionAgentHost: AgentHostAdapter = {
  resolveTools: async (req) => {
    const tools = await (req.kind === 'root' ? resolveRootTools(req) : resolveSpawnedTools(req))
    // 已实例化的附加工具（派发结果契约的 next 等）：同名让位后追加。
    // 扩展现阶段没有传 resultContract 的调用方，此处只为保持 seam 契约与桌面一致。
    if (!req.extraTools?.length) return tools
    const extraNames = new Set(
      req.extraTools.map((tool) => (tool as { name?: string }).name).filter(Boolean)
    )
    return [
      ...tools.filter((tool) => !extraNames.has((tool as { name?: string }).name)),
      ...req.extraTools
    ]
  },
  promptVars: extensionPromptVars,
  buildModel: (config) => resolveSessionModel(config.provider, config.model, config.capabilities),
  // 档案声明的模型（`shuvix-model`）→ 可用模型表里的一条；不可用返回 null 由创建管线回落
  resolveProfileModel: (spec) => {
    const hit = resolveModelRef(spec, settingsStore.listAvailableModels())
    if (!hit) return null
    return { provider: hit.providerId, model: hit.modelId, capabilities: capsFor(hit.modelId) }
  },
  getApiKey: async (p) => (await settingsStore.getApiKey(p)) || undefined,
  openSessionTree: (sessionId, cwd) => ensureSessionTree(sessionId, cwd),
  createExecutionEnv: (cwd) => createStubExecutionEnv(cwd),
  eventSink: {
    broadcast: (event) => eventBus.emit(event),
    hasUserInputCapability: () => eventBus.hasListeners()
  },
  logger,
  // 候选清单来自 agent 档案；sessionId 恒为根会话 id（派生按根会话解析）
  resolveInstruction: (sessionId, _cwd, candidates) =>
    resolveInstructionForSession(sessionId, candidates),
  resolveProjectPrompt: async (sessionId) => {
    const session = await sessionStore.getById(sessionId)
    if (!session?.projectId) return null
    await projectStore.loadState()
    return projectStore.getById(session.projectId)?.systemPrompt?.trim() || null
  }
}

/** 扩展唯一 agent 工厂：派生（subAgentManager）与根会话（buildRuntimeSession）共用 */
export const extensionAgentFactory = createAgentFactory(extensionAgentHost)
