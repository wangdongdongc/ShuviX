/**
 * 扩展 AgentHostAdapter —— 统一创建管线（createAgentFactory）的浏览器端适配。
 *
 * root（根会话）：按 default 档案名单装配工具（ask/browser/read/write/edit；
 * bash/ls/grep/glob/ssh/database 等宿主缺失名自动跳过）+ 全部已连接 MCP（宿主策略，
 * 等价旧「全量注入不过滤」）；工具池登记进 sessionTools 供派生复用；systemPrompt 经
 * persona/workspace 两个具名段组装（'project' 段扩展不注册 → 引用时跳过）；
 * instruction 与桌面统一走 entry 懒注入（不再拼进 systemPrompt）。
 *
 * spawned（派生）：沿用扩展既有模型 —— **复用父会话已实例化的工具**（sessionTools
 * 查表；与根 Agent 同工作目录/同审批范围），names 白名单按名筛选、preview 不在根
 * 工具池、白名单声明时就地构建。派发工具注入策略与旧实现一致：默认子代理（names 空）
 * 无条件可再派发、具名定义须显式白名单 'Agent'（层级由内核 canSpawn 约束）。
 */
import type { AgentTool } from '@earendil-works/pi-agent-core'
import i18next from 'i18next'
import {
  createAgentFactory,
  formatLanguageDisplay,
  renderProfileSystemPrompt,
  toInProcessAgentType,
  NOTEBOOK_PROFILE_NAME,
  createAskTool,
  createBrowserTool,
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
import { hookEngine } from './hooks'
import { mcpManager } from './mcpRuntime'
import { createFileTools } from './fileTools'
import { extensionBrowserBackend } from './browserBackend'
import { createSpillSink } from './opfsSpillSink'
import { wrapToolsOutput } from './wrapToolOutput'
import { resolveSessionModel, capsFor } from './resolveSessionModel'
import { resolveModelRef } from '@shuvix/chat-protocol/agentModelRef'
import { resolveInstructionForSession } from './instructionFilesRuntime'
import { createExtensionPreviewTool } from './previewTool'
import {
  getSessionTools,
  registerSessionTools,
  createExtensionDispatchTool,
  extensionSubAgentRegistry
} from './subAgent'

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
    workspaceIntro: handle ? projectIntro(handle.name) : SCRATCH_INTRO
  }
}

// ─── 工具解析 ───

/** root：按名单装配（宿主缺失名跳过）+ 全量 MCP + 工具池登记 + 派发工具 */
async function resolveRootTools(req: ToolResolveRequest): Promise<AnyAgentTool[]> {
  const sessionId = req.rootSessionId
  const requestUserInput =
    req.requestUserInput ??
    ((): Promise<InputResponse> => Promise.reject(new Error('NO_INTERACTIVE_INPUT')))
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
  const cwd = projectHandle?.name ?? 'scratch'

  const built: AgentTool[] = []
  for (const name of req.names) {
    if (name === 'Agent' || name.startsWith('mcp:') || name.startsWith('skill:')) continue
    if (name === 'ask') {
      built.push(createAskTool({ requestUserInput, abortError: 'TOOL_ABORTED' }) as AgentTool)
      continue
    }
    if (name === 'browser') {
      built.push(
        createBrowserTool({
          backend: extensionBrowserBackend,
          abortError: 'TOOL_ABORTED'
        }) as AgentTool
      )
      continue
    }
    const fileTool = fileSuite.find((t) => (t as { name?: string }).name === name)
    if (fileTool) built.push(fileTool)
    // 其余（bash/ls/grep/glob/ssh/database…）宿主缺失 → 静默跳过
  }
  // MCP：全部已连接工具（宿主策略；扩展无会话级勾选，等价旧「全量注入」）
  built.push(...(mcpManager.getAllAgentTools() as AgentTool[]))

  const tools = wrapToolsOutput(built, spillSink, { sessionId, cwd })
  // 登记工具池（不含 Agent 派发工具）—— 派生 agent 经 sessionTools 查表复用
  registerSessionTools(sessionId, tools as unknown as AnyAgentTool[])

  if (req.names.includes('Agent')) {
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
        { sessionId, cwd }
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
    if (name === 'Agent') return false
    return named ? whitelist.includes(name) : true
  })
  if (named && whitelist.includes('preview')) {
    tools.push(createExtensionPreviewTool(req.rootSessionId) as unknown as AnyAgentTool)
  }
  // 派发工具：默认子代理（names 空）全员可派发；具名定义须显式白名单 'Agent'
  if (req.spawn?.canSpawn && (!named || whitelist.includes('Agent'))) {
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
  resolveTools: (req) => (req.kind === 'root' ? resolveRootTools(req) : resolveSpawnedTools(req)),
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
  shouldDeferToolDisplay: () => (toolName) => toolName === 'ask',
  hooks: hookEngine,
  logger,
  // sessionId 恒为根会话 id（派生按根会话解析）
  resolveInstruction: (sessionId) => resolveInstructionForSession(sessionId),
  resolveProjectPrompt: async (sessionId) => {
    const session = await sessionStore.getById(sessionId)
    if (!session?.projectId) return null
    await projectStore.loadState()
    return projectStore.getById(session.projectId)?.systemPrompt?.trim() || null
  }
}

/** 扩展唯一 agent 工厂：派生（subAgentManager）与根会话（buildRuntimeSession）共用 */
export const extensionAgentFactory = createAgentFactory(extensionAgentHost)

/**
 * 组装笔记本一次性子代理的完整系统提示（agentRuntime.buildSessionTools 调用）。
 * 走 notebook 基座档案而非 default；笔记路径经 {{shuvix:notebookPath}} 就地替换 ——
 * 派生 agent 的 promptVars ctx 拿到的是 agentId，宿主无从解析该路径（与桌面同口径）。
 */
export async function renderNotebookSystemPrompt(
  sessionId: string,
  cwd: string,
  notebookPath: string
): Promise<string> {
  const profile = toInProcessAgentType(extensionSubAgentRegistry.getProfile(NOTEBOOK_PROFILE_NAME)!)
  return renderProfileSystemPrompt(
    profile,
    { ...(await extensionPromptVars({ sessionId, kind: 'root', cwd })), notebookPath },
    logger
  )
}
