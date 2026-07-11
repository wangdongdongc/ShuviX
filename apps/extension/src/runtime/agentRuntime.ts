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
  SessionManager,
  createAskTool,
  createBrowserTool,
  resolveInitialThinkingLevel,
  type RuntimeEventSink,
  type RuntimePersistence,
  type RuntimeLogger,
  type SpillSink
} from '@shuvix/agent-runtime'
import type { ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'
import type { ModelCapabilities } from '@shuvix/chat-protocol/types/provider'
import { messageStore } from '../storage/messageStore'
import { sessionStore } from '../storage/sessionStore'
import { settingsStore } from '../storage/settingsStore'
import { projectStore } from '../storage/projectStore'
import { getTempWorkspaceHandle } from '../storage/opfsWorkspace'
import { systemPromptStore } from '../storage/systemPromptStore'
import { eventBus } from './eventBus'
import { mcpManager } from './mcpRuntime'
import { createFileTools } from './fileTools'
import { buildInstructionPromptSection } from './instructionFilesRuntime'
import { extensionBrowserBackend } from './browserBackend'
import { createSpillSink } from './opfsSpillSink'
import { wrapToolsOutput } from './wrapToolOutput'
import { hookEngine } from './hooks'
import { resolveSessionModel } from './resolveSessionModel'
import {
  registerSessionTools,
  clearSessionTools,
  createExtensionDispatchTool,
  subAgentManager
} from './subAgent'

const BROWSER_PROMPT = `You can inspect and operate the user's open browser tabs via the "browser" tool. To open a web
page use action:"open_tab" (opens a NEW tab and returns its id) — never use navigate to open a fresh page.
Reading: action:"list_tabs" to enumerate open content tabs, action:"read_page" to read a tab's live rendered
content (works on logged-in pages and SPAs). Operating a tab (this shows a "being debugged" banner on it):
action:"snapshot" to get interactive elements with uids, then click/fill by uid. Always snapshot before
click/fill, and re-snapshot after the page changes. Use action:"help" for the full manual. You cannot target
the ShuviX app tab itself. You can also fetch public URLs (the "read" tool with an http/https URL).`

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

/**
 * 会话运行时生命周期由共享 SessionManager 托管（Map + 懒创建 + 失效/销毁）。
 * 构造经 buildRuntimeSession 注入（异步：FSA/OPFS + 历史恢复）；清理 dispose 销毁子代理 + 工具注册表。
 */
const manager = new SessionManager<RuntimeSession>({
  create: (sessionId) => buildRuntimeSession(sessionId),
  dispose: (sessionId) => {
    subAgentManager.destroyAll(sessionId)
    clearSessionTools(sessionId)
  }
})

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

/**
 * 解析会话的 provider/model/caps（**不创建 RuntimeSession**）—— 供 agent.init 同步元信息。
 * Agent 运行时延迟到首次发送消息（ensureRuntimeSession）才创建，故仅打开会话/笔记本不启动 Agent。
 */
export async function resolveSessionMeta(sessionId: string): Promise<{
  provider: string
  model: string
  caps: ModelCapabilities
}> {
  const session = await sessionStore.getById(sessionId)
  await settingsStore.loadState()
  const def = settingsStore.getDefaultSelection()
  const provider = session?.provider || def.provider
  const model = session?.model || def.model
  return { provider, model, caps: capsFor(model) }
}

/** 取（或惰性创建）某会话的 RuntimeSession（懒创建经 SessionManager；session 异常时由 build 兜底默认模型） */
export function ensureRuntimeSession(sessionId: string): Promise<RuntimeSession | undefined> {
  return manager.ensure(sessionId)
}

type RequestUserInput = (
  req: Parameters<RuntimeSession['requestUserInput']>[0]
) => ReturnType<RuntimeSession['requestUserInput']>

/**
 * 构建某会话的「基础工具集 + systemPrompt + 模型信息」（不含 Agent 派发工具、不建 RuntimeSession）。
 * 供 buildRuntimeSession（主会话）与笔记本一次性子智能体（chatApiAdapter.notebookPrompt）共用。
 * includeAsk=false 时不含 ask 工具（笔记本面板只读、无法应答交互式提问）。
 */
export async function buildSessionTools(
  sessionId: string,
  opts: { requestUserInput: RequestUserInput; includeAsk: boolean }
): Promise<{
  tools: ReturnType<typeof wrapToolsOutput>
  systemPrompt: string
  provider: string
  model: string
  caps: ModelCapabilities
  spillSink: SpillSink
  /** hook 输入的 cwd（虚拟工作目录标签；OPFS/FSA 无真实路径） */
  cwd: string
}> {
  const session = await sessionStore.getById(sessionId)
  // 会话通常已带 provider/model（session.create 用活跃选择）；兜底取首个已启用模型而非写死
  await settingsStore.loadState()
  const def = settingsStore.getDefaultSelection()
  const provider = session?.provider || def.provider
  const model = session?.model || def.model
  const caps = capsFor(model)

  // 工作目录句柄：项目会话=用户 FSA 文件夹；临时会话=隔离的 OPFS 目录（镜像桌面 temp_workspace）。
  await projectStore.loadState()
  const projectHandle = session?.projectId ? projectStore.getHandle(session.projectId) : undefined
  let fileTools: ReturnType<typeof createFileTools>
  let systemPrompt: string
  let spillSink: SpillSink
  const persona = await systemPromptStore.renderPersona({})
  // 已启用的项目指令文件（AGENTS.md/CLAUDE.md）内容段，追加进系统提示（空 = 不注入，镜像桌面）
  const instructionSection = await buildInstructionPromptSection(
    sessionId,
    session?.settings?.enabledInstructionFiles ?? []
  )
  if (projectHandle) {
    fileTools = createFileTools(projectHandle, { requestUserInput: opts.requestUserInput })
    systemPrompt = [persona, projectContextPrompt(projectHandle.name), instructionSection]
      .filter(Boolean)
      .join('\n\n')
    spillSink = createSpillSink(projectHandle, { writeGitignore: true })
  } else {
    const tempHandle = await getTempWorkspaceHandle(sessionId)
    fileTools = createFileTools(tempHandle, {
      requiresPermission: false,
      requestUserInput: opts.requestUserInput
    })
    systemPrompt = [persona, SCRATCH_CONTEXT_PROMPT, instructionSection]
      .filter(Boolean)
      .join('\n\n')
    spillSink = createSpillSink(tempHandle)
  }

  // 统一 browser 工具（multiplex，共享 @shuvix/agent-runtime）。mutating 操作的 autoApprove
  // 门控仅交互式会话（includeAsk）启用——笔记本一次性子任务无审批 UI，按原行为透传。
  // 门控读会话 settings.autoApprove（默认关 → 逐次确认）。
  const browser = createBrowserTool({
    backend: extensionBrowserBackend,
    approval: opts.includeAsk
      ? {
          isAutoApprove: () => sessionStore.getSettingsSync(sessionId).autoApprove === true,
          requestUserInput: opts.requestUserInput
        }
      : undefined,
    abortError: 'TOOL_ABORTED'
  })

  // hook 输入的 cwd（虚拟标签）：项目会话用文件夹名，临时会话用 'scratch'
  const cwd = projectHandle?.name ?? 'scratch'

  // ask（可选）+ 浏览器 + 文件 + 已连接 MCP；全部经 wrapToolsOutput 统一截断/落盘 + Pre/PostToolUse hook
  const tools = wrapToolsOutput(
    [
      ...(opts.includeAsk
        ? [createAskTool({ requestUserInput: opts.requestUserInput, abortError: 'TOOL_ABORTED' })]
        : []),
      browser,
      ...fileTools,
      ...mcpManager.getAllAgentTools()
    ],
    spillSink,
    { sessionId, cwd }
  )
  return { tools, systemPrompt, provider, model, caps, spillSink, cwd }
}

/** 构造某会话的 RuntimeSession（SessionManager.create 注入；已存在判断与入表由 manager 负责） */
async function buildRuntimeSession(sessionId: string): Promise<RuntimeSession> {
  const session = await sessionStore.getById(sessionId)
  // eslint-disable-next-line prefer-const
  let runtime: RuntimeSession
  // 沙箱审批挂起原语（扩展夹内不弹，仅为将来越界能力预留）；runtime 后置赋值，闭包捕获
  const requestUserInput: RequestUserInput = (req) => runtime.requestUserInput(req)
  const parts = await buildSessionTools(sessionId, { requestUserInput, includeAsk: true })

  // 注册本会话的工具（含 ask/浏览器/文件/MCP，不含 Agent 派发工具）——子代理经 resolveTools 复用
  registerSessionTools(sessionId, parts.tools)
  // Agent 派发工具始终注入（resolveTools 已排除 Agent 防递归）+ 同一份 systemPrompt
  const tools = [
    ...parts.tools,
    ...wrapToolsOutput(
      [
        createExtensionDispatchTool(
          sessionId,
          { provider: parts.provider, model: parts.model, capabilities: parts.caps },
          parts.systemPrompt
        ) as unknown as AgentTool
      ],
      parts.spillSink,
      { sessionId, cwd: parts.cwd }
    )
  ]

  const resolvedModel = resolveSessionModel(parts.provider, parts.model, parts.caps)
  const agent = new Agent({
    initialState: {
      systemPrompt: parts.systemPrompt,
      model: resolvedModel,
      thinkingLevel: resolveInitialThinkingLevel({
        persisted: session?.modelMetadata?.thinkingLevel,
        reasoning: parts.caps.reasoning
      }),
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
    logger,
    // 统一生命周期 hook：注入扩展的 HookEngine（仅 builtin）；SessionStart/UserPromptSubmit/Stop
    // 与桌面同源，由 RuntimeSession 触发
    hooks: hookEngine,
    getCwd: () => parts.cwd
  })

  // 恢复历史文本轮次
  const history = await messageStore.list(sessionId)
  for (const m of restoreAgentMessages(history)) {
    agent.state.messages.push(m)
  }

  // 入表由 SessionManager 负责
  return runtime
}

export function getRuntimeSession(sessionId: string): RuntimeSession | undefined {
  return manager.get(sessionId)
}

/** 切换会话模型：持久化 + 若运行时已存在则即时 applyModel */
export async function setSessionModel(
  sessionId: string,
  provider: string,
  model: string
): Promise<void> {
  await sessionStore.updateModelConfig(sessionId, provider, model)
  const runtime = manager.get(sessionId)
  if (!runtime) return
  const caps = capsFor(model)
  const resolvedModel = resolveSessionModel(provider, model, caps)
  // 切模型保留当前思考深度（省略第二参 → 保持不变，思考与能力点解绑）
  runtime.applyModel(resolvedModel)
}

export function removeRuntimeSession(sessionId: string): void {
  // 销毁子代理 + 清理工具注册表由 SessionManager 的 dispose 处理
  manager.remove(sessionId, 'remove')
}
