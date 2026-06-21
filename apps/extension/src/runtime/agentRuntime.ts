/**
 * 浏览器 Agent 运行时 —— 用 @shuvix/agent-runtime 的 RuntimeSession 在 Side Panel 进程内
 * 驱动 pi-agent-core Agent。每个会话一个 RuntimeSession，事件经 eventBus 派发给 chat-ui。
 *
 * 与桌面 AgentSession 的对应：这里是「扩展宿主 wrapper」，提供浏览器适配器（messageStore /
 * eventBus / chrome.storage 模型解析），并组装工具集（共享 ask + 已连接 MCP 工具）。
 */
import { Agent, type AgentMessage } from '@earendil-works/pi-agent-core'
import {
  RuntimeSession,
  resolveModel,
  createAskTool,
  type RuntimeEnv,
  type RuntimeEventSink,
  type RuntimePersistence,
  type ResolveModelProviderInfo,
  type RuntimeLogger,
  type SpillSink
} from '@shuvix/agent-runtime'
import type { ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'
import type { ModelCapabilities } from '@shuvix/chat-protocol/types/provider'
import type { ThinkingLevel } from '@shuvix/chat-protocol/types/thinking'
import { messageStore } from '../storage/messageStore'
import { sessionStore } from '../storage/sessionStore'
import { settingsStore } from '../storage/settingsStore'
import { projectStore } from '../storage/projectStore'
import { getTempWorkspaceHandle } from '../storage/opfsWorkspace'
import { eventBus } from './eventBus'
import { mcpManager } from './mcpRuntime'
import { createFileTools } from './fileTools'
import { browserTools } from './browserTools'
import { createSpillSink } from './opfsSpillSink'
import { wrapToolsOutput } from './wrapToolOutput'

const BROWSER_PROMPT = `You can inspect and operate the user's open browser tabs. To open a web page, use
open_tab (it opens a NEW tab and returns its id) — never use navigate to open a fresh page. Reading:
list_tabs to enumerate open content tabs, read_page to read a tab's live rendered content (works on
logged-in pages and SPAs). Operating a tab (this shows a "being debugged" banner on it): snapshot to get
interactive elements with uids, then click/fill by uid, key to press a key (e.g. Enter), navigate to move
an EXISTING tab to a different URL, screenshot to see it. Always snapshot before click/fill, and
re-snapshot after the page changes; call release_tab when you finish operating a tab to remove the banner.
You cannot target the ShuviX app tab itself. You can also fetch public URLs (the "read" tool with an
http/https URL).`

/** 临时会话：拥有一个私有的隔离工作目录（OPFS），可用 read/write/edit 作为暂存空间 */
const DEFAULT_SYSTEM_PROMPT = `You are ShuviX, a helpful AI assistant running inside a Chrome extension.
You have a private, isolated scratch working directory. You can read, write, and edit files in it using
the file tools (paths are relative to the directory root; you cannot escape it) — use it for intermediate
results, notes, or generated content.
${BROWSER_PROMPT}
You can ask clarifying questions (the "ask" tool) and use any configured MCP tools.
You do not have access to a shell or SSH. Keep answers concise and useful.`

/** 绑定了项目文件夹的会话：可用 read/write/edit 操作该文件夹 */
function projectSystemPrompt(folderName: string): string {
  return `You are ShuviX, a helpful AI assistant running inside a Chrome extension.
You are working inside the project folder "${folderName}". You can read, write, and edit files within
this folder using the file tools (paths are relative to the folder root; you cannot escape it).
${BROWSER_PROMPT}
You can ask clarifying questions (the "ask" tool) and use any configured MCP tools.
You do not have access to a shell or SSH. Keep answers concise and useful.`
}

const browserEnv: RuntimeEnv = { setApiKey: () => {} }

const eventSink: RuntimeEventSink = {
  broadcast: (event) => eventBus.emit(event),
  hasUserInputCapability: () => eventBus.hasListeners()
}

const browserPersistence: RuntimePersistence = {
  listMessages: (sessionId) => messageStore.list(sessionId),
  add: (p) => messageStore.add(p),
  addAssistantText: (p) => messageStore.addAssistantText(p),
  addToolUse: (p) => messageStore.addToolUse(p),
  completeToolUse: (p) => messageStore.completeToolUse(p),
  addStepThinking: (p) => messageStore.addStepThinking(p),
  addStepText: (p) => messageStore.addStepText(p)
}

const logger: RuntimeLogger = {
  info: (m) => console.info('[shuvix]', m),
  warn: (m) => console.warn('[shuvix]', m),
  error: (m) => console.error('[shuvix]', m)
}

const sessions = new Map<string, RuntimeSession>()

/** 把已存历史的「文本轮次」恢复为 Agent 上下文（MVP：仅 user/assistant 文本，跳过工具/步骤） */
function restoreAgentMessages(msgs: ChatMessage[]): AgentMessage[] {
  const out: AgentMessage[] = []
  for (const m of msgs) {
    if (m.type === 'text' && (m.role === 'user' || m.role === 'assistant') && m.content) {
      out.push({
        role: m.role,
        content: [{ type: 'text', text: m.content }],
        timestamp: m.createdAt
      } as AgentMessage)
    }
  }
  return out
}

function capsFor(model: string): ModelCapabilities {
  const row = settingsStore.listAvailableModels().find((m) => m.modelId === model)
  if (!row?.capabilities) return {}
  try {
    return JSON.parse(row.capabilities) as ModelCapabilities
  } catch {
    return {}
  }
}

/** 获取（或惰性创建）某会话的 RuntimeSession */
export async function ensureRuntimeSession(sessionId: string): Promise<{
  runtime: RuntimeSession
  created: boolean
  provider: string
  model: string
  caps: ModelCapabilities
}> {
  const session = await sessionStore.getById(sessionId)
  const provider = session?.provider ?? 'anthropic'
  const model = session?.model ?? 'claude-opus-4-8'
  const caps = capsFor(model)

  const existing = sessions.get(sessionId)
  if (existing) return { runtime: existing, created: false, provider, model, caps }

  // 工作目录句柄：项目会话=用户 FSA 文件夹；临时会话=隔离的 OPFS 目录（镜像桌面 temp_workspace）。
  // 两类都注入 read/write/edit（共享 createFileTools），区别仅在根句柄与权限校验。
  await projectStore.loadState()
  const projectHandle = session?.projectId ? projectStore.getHandle(session.projectId) : undefined
  let fileTools: ReturnType<typeof createFileTools>
  let systemPrompt: string
  let spillSink: SpillSink
  // 沙箱审批挂起原语（扩展夹内不弹，仅为将来越界能力预留）；runtime 后置赋值，闭包捕获
  const requestUserInput = (req: Parameters<RuntimeSession['requestUserInput']>[0]) =>
    runtime.requestUserInput(req)
  if (projectHandle) {
    fileTools = createFileTools(projectHandle, { requestUserInput })
    systemPrompt = projectSystemPrompt(projectHandle.name)
    // 项目根 spill 落 .shuvix/（写 .gitignore 避免污染仓库）
    spillSink = createSpillSink(projectHandle, { writeGitignore: true })
  } else {
    // 临时会话：OPFS 工作目录始终可用，跳过 FSA 权限校验
    const tempHandle = await getTempWorkspaceHandle(sessionId)
    fileTools = createFileTools(tempHandle, { requiresPermission: false, requestUserInput })
    systemPrompt = DEFAULT_SYSTEM_PROMPT
    spillSink = createSpillSink(tempHandle)
  }

  const providerRow = await settingsStore.getProviderWithKey(provider)
  const providerInfo: ResolveModelProviderInfo | null = providerRow
    ? {
        id: providerRow.id,
        name: providerRow.name,
        isBuiltin: !!providerRow.isBuiltin,
        apiKey: providerRow.apiKey,
        baseUrl: providerRow.baseUrl,
        apiProtocol: providerRow.apiProtocol,
        metadata: providerRow.metadata
      }
    : null

  const resolvedModel = resolveModel({
    provider,
    model,
    capabilities: caps,
    providerInfo,
    env: browserEnv
  })

  // eslint-disable-next-line prefer-const
  let runtime: RuntimeSession
  // 共享 ask 工具 + 浏览器操控工具（始终可用）+ 文件工具 + 已连接 MCP 工具；
  // 全部经 wrapToolsOutput 统一截断/落盘（大输出落工作目录 .shuvix/，agent 用 read 取回）
  const tools = wrapToolsOutput(
    [
      createAskTool({
        requestUserInput: (req) => runtime.requestUserInput(req),
        abortError: 'TOOL_ABORTED'
      }),
      ...browserTools,
      ...fileTools,
      ...mcpManager.getAllAgentTools()
    ],
    spillSink
  )

  const agent = new Agent({
    initialState: {
      systemPrompt,
      model: resolvedModel,
      thinkingLevel: caps.reasoning
        ? (session?.modelMetadata?.thinkingLevel as ThinkingLevel) || 'medium'
        : 'off',
      messages: [],
      tools
    },
    getApiKey: async (p) => (await settingsStore.getApiKey(p)) || undefined
  })

  runtime = new RuntimeSession({
    sessionId,
    agent,
    eventSink,
    persistence: browserPersistence,
    shouldDeferToolDisplay: (toolName) => toolName === 'ask',
    logger
  })

  // 恢复历史文本轮次
  const history = await messageStore.list(sessionId)
  for (const m of restoreAgentMessages(history)) {
    agent.state.messages.push(m)
  }

  sessions.set(sessionId, runtime)
  return { runtime, created: true, provider, model, caps }
}

export function getRuntimeSession(sessionId: string): RuntimeSession | undefined {
  return sessions.get(sessionId)
}

/** 切换会话模型：持久化 + 若运行时已存在则即时 applyModel */
export async function setSessionModel(
  sessionId: string,
  provider: string,
  model: string
): Promise<void> {
  await sessionStore.updateModelConfig(sessionId, provider, model)
  const runtime = sessions.get(sessionId)
  if (!runtime) return
  const caps = capsFor(model)
  const providerRow = await settingsStore.getProviderWithKey(provider)
  const providerInfo: ResolveModelProviderInfo | null = providerRow
    ? {
        id: providerRow.id,
        name: providerRow.name,
        isBuiltin: !!providerRow.isBuiltin,
        apiKey: providerRow.apiKey,
        baseUrl: providerRow.baseUrl,
        apiProtocol: providerRow.apiProtocol,
        metadata: providerRow.metadata
      }
    : null
  const resolvedModel = resolveModel({
    provider,
    model,
    capabilities: caps,
    providerInfo,
    env: browserEnv
  })
  runtime.applyModel(resolvedModel, caps.reasoning ? 'medium' : 'off')
}

export function removeRuntimeSession(sessionId: string): void {
  sessions.delete(sessionId)
}
