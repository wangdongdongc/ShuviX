/**
 * 浏览器 Agent 运行时 —— 根会话经统一创建管线（runtime/agentHost 的 extensionAgentFactory
 * + 'default' 档案）在 Side Panel 进程内驱动 pi AgentHarness，事件经 eventBus 派发给 chat-ui。
 *
 * 与桌面 AgentSession 的对应：这里是「扩展宿主 wrapper」——生命周期簿记（SessionManager）
 * 与运行配置读写；工具装配 / systemPrompt 组装 / instruction 懒注入全部收敛在 agentHost。
 * instruction 注入方式与桌面统一：custom_message entry（懒注入、压缩后重注入），
 * 不再拼进 systemPrompt 字符串。
 *
 * buildSessionTools 仅供笔记本一次性子智能体与用户直发的工具池回填使用
 * （chatApiAdapter.notebookPrompt / dispatchPrompt）。
 */
import {
  DEFAULT_PROFILE_NAME,
  SessionManager,
  createAskTool,
  createBrowserTool,
  resolveInitialThinkingLevel,
  toInProcessAgentType,
  type CreatedAgent,
  type SpillSink
} from '@shuvix/agent-runtime'
import {
  appendModelChange,
  readSessionRunConfig,
  setSessionTreePinned
} from '../storage/sessionEntryStore'
import type { ModelCapabilities } from '@shuvix/chat-protocol/types/provider'
import type { SessionModelMetadata } from '@shuvix/chat-protocol/chatApi'
import { sessionStore } from '../storage/sessionStore'
import { settingsStore } from '../storage/settingsStore'
import { projectStore } from '../storage/projectStore'
import { getTempWorkspaceHandle } from '../storage/opfsWorkspace'
import { mcpManager } from './mcpRuntime'
import { createFileTools } from './fileTools'
import { extensionBrowserBackend } from './browserBackend'
import { createSpillSink } from './opfsSpillSink'
import { wrapToolsOutput } from './wrapToolOutput'
import { capsFor } from './resolveSessionModel'
import { titlerFor } from './titleRuntime'
import { extensionAgentFactory, renderNotebookSystemPrompt } from './agentHost'
import { clearSessionTools, extensionSubAgentRegistry, subAgentManager } from './subAgent'

/**
 * 会话运行时生命周期由共享 SessionManager 托管（Map + 懒创建 + 失效/销毁）。
 * 构造经 buildRuntimeSession 注入（异步：FSA/OPFS + 档案解析）；清理 dispose 销毁子代理 + 工具注册表。
 */
const manager = new SessionManager<CreatedAgent>({
  create: (sessionId) => buildRuntimeSession(sessionId),
  dispose: (sessionId) => {
    subAgentManager.destroyAll(sessionId)
    clearSessionTools(sessionId)
  }
})

// 会话树共享缓存的逐出保护：有运行时（或创建中）的会话，树实例与 harness 共享，LRU 不得回收
setSessionTreePinned((sessionId) => manager.tracked(sessionId))

/**
 * 解析会话的 provider/model/caps（**不创建运行时**）—— 供 agent.init 同步元信息。
 * Agent 运行时延迟到首次发送消息（ensureRuntimeSession）才创建，故仅打开会话/笔记本不启动 Agent。
 */
export async function resolveSessionMeta(sessionId: string): Promise<{
  provider: string
  model: string
  caps: ModelCapabilities
  modelMetadata: SessionModelMetadata
}> {
  await settingsStore.loadState()
  const def = settingsStore.getDefaultSelection()
  // 运行配置的唯一事实源是会话树；树上没有（新会话）才回落活跃选择
  const tree = await readSessionRunConfig(sessionId)
  const provider = tree.provider ?? def.provider
  const model = tree.model ?? def.model
  return {
    provider,
    model,
    caps: capsFor(model),
    modelMetadata: {
      ...(tree.thinkingLevel ? { thinkingLevel: tree.thinkingLevel } : {}),
      ...(tree.enabledTools ? { enabledTools: tree.enabledTools } : {})
    }
  }
}

/** 取（或惰性创建）某会话的运行时（懒创建经 SessionManager） */
export function ensureRuntimeSession(sessionId: string): Promise<CreatedAgent | undefined> {
  return manager.ensure(sessionId)
}

type RequestUserInput = (
  req: Parameters<CreatedAgent['runtime']['requestUserInput']>[0]
) => ReturnType<CreatedAgent['runtime']['requestUserInput']>

/**
 * 构建笔记本一次性子智能体的「基础工具集 + systemPrompt + 模型信息」（不含 Agent 派发
 * 工具、不建运行时）—— 根会话的装配已收敛到 agentHost.resolveTools。systemPrompt 取
 * notebook 基座档案 body（笔记路径就地替换；instruction/项目提示词由创建管线按档案开关追加）。
 * includeAsk=false 时不含 ask 工具（笔记本面板只读、无法应答交互式提问）。
 */
export async function buildSessionTools(
  sessionId: string,
  opts: { requestUserInput: RequestUserInput; includeAsk: boolean; notebookPath: string }
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
  await settingsStore.loadState()
  const def = settingsStore.getDefaultSelection()
  // 运行配置读会话树；树上没有则回落活跃选择
  const tree = await readSessionRunConfig(sessionId)
  const provider = tree.provider ?? def.provider
  const model = tree.model ?? def.model
  const caps = capsFor(model)

  // 工作目录句柄：项目会话=用户 FSA 文件夹；临时会话=隔离的 OPFS 目录（镜像桌面 temp_workspace）。
  await projectStore.loadState()
  const projectHandle = session?.projectId ? projectStore.getHandle(session.projectId) : undefined
  let fileTools: ReturnType<typeof createFileTools>
  let spillSink: SpillSink
  if (projectHandle) {
    fileTools = createFileTools(projectHandle, { requestUserInput: opts.requestUserInput })
    spillSink = createSpillSink(projectHandle, { writeGitignore: true })
  } else {
    const tempHandle = await getTempWorkspaceHandle(sessionId)
    fileTools = createFileTools(tempHandle, {
      requiresPermission: false,
      requestUserInput: opts.requestUserInput
    })
    spillSink = createSpillSink(tempHandle)
  }

  // 统一 browser 工具（multiplex，共享 @shuvix/agent-runtime）；无审批门控
  const browser = createBrowserTool({
    backend: extensionBrowserBackend,
    abortError: 'TOOL_ABORTED'
  })

  // hook 输入的 cwd（虚拟标签）：项目会话用文件夹名，临时会话用 'scratch'
  const cwd = projectHandle?.name ?? 'scratch'
  // notebook 基座档案 body（{{shuvix:notebookPath}} 就地替换）
  const systemPrompt = await renderNotebookSystemPrompt(sessionId, cwd, opts.notebookPath)

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

/** 构造某会话的根运行时（SessionManager.create 注入）—— 统一创建管线 + 'default' 档案 */
async function buildRuntimeSession(sessionId: string): Promise<CreatedAgent> {
  const { provider, model, caps } = await resolveSessionMeta(sessionId)
  const session = await sessionStore.getById(sessionId)
  await projectStore.loadState()
  const projectHandle = session?.projectId ? projectStore.getHandle(session.projectId) : undefined
  // 工作目录（虚拟标签）：项目会话用文件夹名，临时会话用 'scratch'
  const cwd = projectHandle?.name ?? 'scratch'

  // 会话档案（`/<agentName>` 斜杠命令切换，粘性存 settings.agentProfile）；
  // 缺省 / 档案已不存在 → 回落 'default'（扩展注册表无用户档案，内置兜底恒存在）
  const profileName = session?.settings?.agentProfile
  const profile = toInProcessAgentType(
    (profileName ? extensionSubAgentRegistry.getProfile(profileName) : undefined) ??
      extensionSubAgentRegistry.getProfile(DEFAULT_PROFILE_NAME)!
  )

  return await extensionAgentFactory.createAgent({
    kind: 'root',
    sessionId,
    profile,
    model: { provider, model, capabilities: caps },
    thinkingLevel: resolveInitialThinkingLevel({
      persisted: (await readSessionRunConfig(sessionId)).thinkingLevel ?? undefined,
      reasoning: caps.reasoning
    }),
    cwd,
    // UserPromptSubmit 通过、正式派发前触发首轮快速标题（与桌面同一时序 + 同一策略内核）
    onPromptAccepted: (text) => void titlerFor(sessionId).quick(text)
  })
}

export function getRuntimeSession(sessionId: string): CreatedAgent | undefined {
  return manager.get(sessionId)
}

/**
 * 切换会话模型 —— 唯一写入口。
 *
 * Agent 已创建 → 统一管线 applyModel（harness 自己往会话树追加 model_change，
 * 并同步更新派发工具的当前模型配置）；未创建 → 直接往树上追加，不为了记一次配置把 Agent 拉起来。
 */
export async function setSessionModel(
  sessionId: string,
  provider: string,
  model: string
): Promise<void> {
  const created = manager.get(sessionId)
  if (!created) {
    await appendModelChange(sessionId, provider, model)
    return
  }
  await created.applyModel({ provider, model, capabilities: capsFor(model) })
}

export function removeRuntimeSession(sessionId: string): void {
  // 销毁子代理 + 清理工具注册表由 SessionManager 的 dispose 处理
  manager.remove(sessionId, 'remove')
}
