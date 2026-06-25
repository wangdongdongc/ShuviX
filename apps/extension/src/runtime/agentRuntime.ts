/**
 * 浏览器 Agent 运行时 —— 用 @shuvix/agent-runtime 的 RuntimeSession 在 Side Panel 进程内
 * 驱动 pi-agent-core Agent。每个会话一个 RuntimeSession，事件经 eventBus 派发给 chat-ui。
 *
 * 与桌面 AgentSession 的对应：这里是「扩展宿主 wrapper」，提供浏览器适配器（messageStore /
 * eventBus / chrome.storage 模型解析），并组装工具集（共享 ask + 已连接 MCP 工具）。
 */
import { Agent, type AgentMessage, type AgentTool } from '@earendil-works/pi-agent-core'
import {
  RuntimeSession,
  createAskTool,
  type RuntimeEventSink,
  type RuntimePersistence,
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
import { systemPromptStore } from '../storage/systemPromptStore'
import { eventBus } from './eventBus'
import { mcpManager } from './mcpRuntime'
import { createFileTools } from './fileTools'
import { browserTools } from './browserTools'
import { createSpillSink } from './opfsSpillSink'
import { wrapToolsOutput } from './wrapToolOutput'
import { resolveSessionModel } from './resolveSessionModel'
import {
  registerSessionTools,
  clearSessionTools,
  createExtensionDispatchTool,
  subAgentManager
} from './subAgent'

const BROWSER_PROMPT = `You can inspect and operate the user's open browser tabs. To open a web page, use
open_tab (it opens a NEW tab and returns its id) — never use navigate to open a fresh page. Reading:
list_tabs to enumerate open content tabs, read_page to read a tab's live rendered content (works on
logged-in pages and SPAs). Operating a tab (this shows a "being debugged" banner on it): snapshot to get
interactive elements with uids, then click/fill by uid, key to press a key (e.g. Enter), navigate to move
an EXISTING tab to a different URL, screenshot to see it. Always snapshot before click/fill, and
re-snapshot after the page changes; call release_tab when you finish operating a tab to remove the banner.
You cannot target the ShuviX app tab itself. You can also fetch public URLs (the "read" tool with an
http/https URL).`

// 「人设」段（identity/tone 等）由上下文管理设置装配（systemPromptStore.renderPersona，全量对齐桌面，
// 总开关开启时完全替换默认人设）；以下是平台「操作上下文」段——与人设无关、始终追加，
// 保证浏览器/文件工具的操作指令与工作目录说明不丢（镜像桌面「工作目录指引在开关外恒生效」）。

/** 临时会话：私有隔离工作目录（OPFS）的操作上下文 */
const SCRATCH_CONTEXT_PROMPT = `You have a private, isolated scratch working directory. You can read, write, and edit files in it using
the file tools (paths are relative to the directory root; you cannot escape it) — use it for intermediate
results, notes, or generated content.
${BROWSER_PROMPT}
You can ask clarifying questions (the "ask" tool) and use any configured MCP tools.
You do not have access to a shell or SSH. Keep answers concise and useful.`

/** 项目会话：绑定文件夹的操作上下文 */
function projectContextPrompt(folderName: string): string {
  return `You are working inside the project folder "${folderName}". You can read, write, and edit files within
this folder using the file tools (paths are relative to the folder root; you cannot escape it).
${BROWSER_PROMPT}
You can ask clarifying questions (the "ask" tool) and use any configured MCP tools.
You do not have access to a shell or SSH. Keep answers concise and useful.`
}

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
export function restoreAgentMessages(msgs: ChatMessage[]): AgentMessage[] {
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

export function capsFor(model: string): ModelCapabilities {
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
  // 会话通常已带 provider/model（session.create 用活跃选择）；兜底取首个已启用模型而非写死
  await settingsStore.loadState()
  const def = settingsStore.getDefaultSelection()
  const provider = session?.provider || def.provider
  const model = session?.model || def.model
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
  // 用户可配置人设（上下文管理设置）；空串表示总开关关闭。操作上下文随后恒追加。
  const persona = await systemPromptStore.renderPersona({})
  if (projectHandle) {
    fileTools = createFileTools(projectHandle, { requestUserInput })
    systemPrompt = [persona, projectContextPrompt(projectHandle.name)].filter(Boolean).join('\n\n')
    // 项目根 spill 落 .shuvix/（写 .gitignore 避免污染仓库）
    spillSink = createSpillSink(projectHandle, { writeGitignore: true })
  } else {
    // 临时会话：OPFS 工作目录始终可用，跳过 FSA 权限校验
    const tempHandle = await getTempWorkspaceHandle(sessionId)
    fileTools = createFileTools(tempHandle, { requiresPermission: false, requestUserInput })
    systemPrompt = [persona, SCRATCH_CONTEXT_PROMPT].filter(Boolean).join('\n\n')
    spillSink = createSpillSink(tempHandle)
  }

  const resolvedModel = resolveSessionModel(provider, model, caps)

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
  // 注册本会话的工具（含 ask/浏览器/文件/MCP，不含下方的 Agent 派发工具）——
  // 子代理直接复用这「全部工具」（同一沙箱/工作目录），见 subAgent.resolveTools
  registerSessionTools(sessionId, tools)
  // Agent 派发工具始终注入：subagent_type 可选，省略即用默认子代理 —— 继承父会话全部工具
  // （resolveTools 已排除 Agent 防递归）+ 同一份 systemPrompt。注册表里的具名定义是可选附加。
  tools.push(
    ...wrapToolsOutput(
      [
        createExtensionDispatchTool(
          sessionId,
          { provider, model, capabilities: caps },
          systemPrompt
        ) as unknown as AgentTool
      ],
      spillSink
    )
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
  const resolvedModel = resolveSessionModel(provider, model, caps)
  runtime.applyModel(resolvedModel, caps.reasoning ? 'medium' : 'off')
}

export function removeRuntimeSession(sessionId: string): void {
  subAgentManager.destroyAll(sessionId)
  clearSessionTools(sessionId)
  sessions.delete(sessionId)
}
