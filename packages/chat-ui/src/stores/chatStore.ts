import { create } from 'zustand'
import type { InlineToken, ToolResultDetails } from '@shuvix/chat-protocol/types/chatMessage'
import type { ToolPresentation } from '@shuvix/chat-protocol/types/toolPresentation'
import { DEFAULT_THINKING_LEVEL } from '@shuvix/chat-protocol/types/thinking'
import type { ChatQueuedMessage } from '@shuvix/chat-protocol/events'
export type {
  ToolPresentation,
  ToolFormItem,
  ToolFormItemRenderer as FormItemRenderer
} from '@shuvix/chat-protocol/types/toolPresentation'

// 消息相关类型从 @shuvix/chat-protocol 导入（ChatMessage 判别联合 + per-type 接口），
// 不再依赖宿主的全局环境声明。
export type {
  ChatMessage,
  UserTextMessage,
  AssistantMessage,
  AssistantBlock,
  AssistantToolBlock,
  ErrorEventMessage,
  MessageMetadata,
  ImageMeta,
  UsageInfo,
  UserTextMeta,
  AssistantMeta
} from '@shuvix/chat-protocol/types/chatMessage'
import type { ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'
import { fillToolResult, upsertMessage } from './messageOps'
export type { ToolResultDetails }

/** 工具执行实时状态（流式期间的临时状态） */
export interface ToolExecution {
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
  status: 'running' | 'done' | 'error'
  result?: string
  /** 工具特定的结构化详情（edit diff 等） */
  details?: ToolResultDetails
  messageId?: string
}

/** 重新导出统一的用户输入请求类型,UI 直接消费 */
export type {
  InputRequest,
  InputResponse,
  AskInputRequest,
  ChoiceInputRequest,
  SshCredentialsInputRequest,
  AskResponse,
  ChoiceResponse,
  SshCredentialsResponse,
  CancelResponse
} from '@shuvix/chat-protocol/types/inputRequest'
import type { InputRequest } from '@shuvix/chat-protocol/types/inputRequest'

/** 模型相关元数据 */
export interface SessionModelMetadata {
  thinkingLevel?: string
  enabledTools?: string[]
}

/** 会话级配置 */
export interface SessionSettings {
  autoAllow?: boolean
  allowList?: string[]
  /** 成员 bot 名单；非空即为聊天会话（无根会话）。判定用 `bots?.length`，空数组不算 */
  bots?: string[]
  /** 会话根 Agent 采用的档案名（`/<agentName>` 切换）；缺省 / 档案已不存在 → 回落 'default' */
  agentProfile?: string
  /** 笔记本会话绑定的 md 文件（相对项目根，forward-slash；项目记忆为绝对路径）；非空即为笔记本会话（根 Agent 钉死 notebook 基座档案，对话经输入卡片的抽屉呈现） */
  notebookPath?: string
  /**
   * 项目记忆笔记本：该会话绑定的是 `~/.shuvix/memory/<projectId>/<slug>.md`。
   * 侧栏据此把它归入项目组下的「项目记忆」子文件夹，而不是并排混进会话列表
   * （同一条记忆在同一处出现两次，比少一处入口更糟）。
   */
  memorySlug?: string
  /** 聊天会话的未读 bot 回复数（A4）；bot 落树 +1、markRead 清零。有根会话恒缺省 */
  unreadCount?: number
}

/** 会话类型（持久化字段，不含运行时计算属性） */
/**
 * 会话业务记录（与 chat-protocol 的 Session 同构）。
 *
 * 不含 provider / model / thinkingLevel / enabledTools —— 运行配置的唯一事实源是
 * 会话树，前端从 `agent.init` 拿当前值并存在本 store 的顶层字段里
 * （activeProvider / activeModel / thinkingLevel / enabledTools）。
 */
export interface Session {
  id: string
  title: string
  /** 所属项目 ID（null 表示临时会话） */
  projectId: string | null
  /**
   * 父会话 ID（null = 顶层会话）。非空即子会话：agent 经 `session` 工具自建的一条
   * **普通会话**，侧栏渲染在父会话下面，其余行为与顶层会话完全一致。
   */
  parentId: string | null
  /** 会话级配置（SSH 免询问等） */
  settings: SessionSettings
  createdAt: number
  updatedAt: number
}

/** 每个 session 的流式状态 */
interface SessionStreamState {
  content: string
  thinking: string
  isStreaming: boolean
  images: Array<{ data: string; mimeType: string }>
  /** 当前正在生成的工具调用（LLM 流式输出 tool_use 块期间） */
  streamingToolCall: {
    toolName: string
    /** 累积的原始参数 JSON 文本 */
    argsText: string
  } | null
  /** 已完成生成但尚未开始执行的工具调用（多工具顺序生成时累积） */
  completedStreamingToolCalls: Array<{
    toolName: string
    args?: Record<string, unknown>
  }>
}

/** Buffered streaming deltas for rAF batching (used by useAgentEvents) */
export interface StreamingDeltaBuffer {
  content: string
  thinking: string
  toolCallArgsDelta: string
}

/** 运行时资源状态信息 */
export interface RuntimeInfo {
  label: string
  icon?: string
  color?: string
  description?: string
}

/** 每个 session 的活跃运行时资源（runtimeId → info） */
export interface SessionResourceInfo {
  runtimes: Record<string, RuntimeInfo>
}

/** 空数组常量，避免选择器每次返回新引用 */
const EMPTY_TOOLS: ToolExecution[] = []

/** 每个会话的输入框草稿状态 */
type PendingImage = { data: string; mimeType: string; preview: string }
interface SessionDraft {
  inputText: string
  pendingImages: PendingImage[]
}

/** 按 sessionId 暂存输入框草稿，切换会话时自动保存/恢复 */
const sessionDrafts = new Map<string, SessionDraft>()

/**
 * 当前激活目标的唯一来源：会话 / 无。
 * 单一来源（active）派生出所有镜像字段，杜绝多个独立「激活字段」相互竞争。
 * 注：md live-preview 现仅经「笔记本会话」进入（普通会话选择，中间区据 session.settings.notebookPath
 * 决定渲染 NotebookView 还是 ChatView），不再有独立的「临时打开任意文件」激活态。
 */
export type ActiveView = { type: 'session'; id: string } | null

/** 由 active 派生出镜像字段，所有写入都经此，保证状态一致、无竞争 */
function deriveActive(active: ActiveView): {
  active: ActiveView
  activeSessionId: string | null
} {
  return {
    active,
    activeSessionId: active?.type === 'session' ? active.id : null
  }
}

interface ChatState {
  /** 所有会话 */
  sessions: Session[]
  /** 当前激活目标（唯一来源）：会话 / 无，其余字段皆由其派生 */
  active: ActiveView
  /** 当前活跃会话 ID —— 由 active 派生的只读镜像，勿直接 set */
  activeSessionId: string | null
  /**
   * 请求打开某文件预览的信号（绝对路径 + 单调 nonce）—— 独立预览面板的唯一入口。
   * 触发方：preview 工具事件（useAgentEvents）/ 笔记本 [[wiki-link]] / Files 面板点击文件。
   * 消费方：宿主经 usePreviewRequestBridge 落为预览目标并揭示自己的预览面板
   * （桌面右侧 preview tab / 扩展与悬浮窗 PreviewOverlay）。
   * 含 nonce 以便重复请求同一文件也能触发（值变化）。
   */
  filePreviewRequest: { absPath: string; nonce: number; openedBy: 'agent' | 'user' } | null
  /**
   * 请求把一条历史用户消息重建为输入框草稿的信号（消息回退触发）。
   * content 含 {{shuvixInlineToken}} 标记、inlineTokens 为其元数据；由 InputArea 消费：
   * 重建可编辑明文并重新登记粘贴芯片/@ 引用，避免裸标记落入输入框导致 token 失效丢信息。
   * 含 nonce 以便连续回退相同内容也能触发。
   */
  draftRestoreRequest: {
    content: string
    inlineTokens?: Record<string, InlineToken>
    nonce: number
  } | null
  /**
   * 欢迎页（还没有会话）选好的档案：会话是发送时才懒创建的，此时无处可写会话设置，
   * 故先记在这里，`session.create` 时一并带上并清空。有会话时一律以会话设置为准。
   */
  pendingAgentProfile: string | null
  /** 当前会话的消息列表 */
  messages: ChatMessage[]
  /** 各 session 的流式状态（按 sessionId 隔离） */
  sessionStreams: Record<string, SessionStreamState>
  /**
   * 各 session 的运行时关停状态（按 sessionId 隔离）。
   *
   * 一个会话同一时刻只允许有一个 Agent 运行时：回退/切档案/清空都要先把旧运行时**彻底**
   * 停下才解绑，新的要等它停完才出生。这段时间发消息没有意义，UI 呈现「正在停止」并禁用发送。
   * 通常一瞬间；工具卡住不返回时会明显可见 —— 这正是要显式呈现它的原因。
   */
  sessionClosing: Record<string, boolean>
  /** 各 session 的工具执行实时状态（按 sessionId 隔离） */
  sessionToolExecutions: Record<string, ToolExecution[]>
  /** 当前模型是否支持深度思考 */
  modelSupportsReasoning: boolean
  /** 当前思考深度 */
  thinkingLevel: string
  /** 当前模型是否支持图片输入 */
  modelSupportsVision: boolean
  /** 当前模型最大上下文 token 数 */
  maxContextTokens: number
  /** 当前会话已占用上下文 token 数（来自最近一次 LLM 请求的 input usage） */
  usedContextTokens: number | null
  /** 待发送的图片列表（base64），按会话隔离 */
  pendingImages: PendingImage[]
  /** 输入框内容 */
  inputText: string
  /** 当前会话启用的工具列表 */
  enabledTools: string[]
  /** 插件工具的渲染配置（toolName → presentation，启动时加载一次） */
  toolPresentations: Record<string, ToolPresentation>
  /** 当前会话的项目工作目录 */
  projectPath: string | null
  /** 当前会话可用的斜杠命令 */
  slashCommands: Array<{
    commandId: string
    name: string
    description: string
    template: string
    requiredTools?: string[]
    /** 命令来源（'project' = .claude/commands/，'skill' = SKILL.md） */
    kind?: 'project' | 'skill'
  }>
  /** 各 session 的活跃运行时资源（SSH / DB 等） */
  sessionResources: Record<string, SessionResourceInfo>
  /**
   * 各 session 的待处理用户输入请求列表(按 sessionId 隔离)。
   * 命令询问 / 选择题 / SSH 凭证全部走这一张表。
   */
  sessionPendingInputs: Record<string, InputRequest[]>
  /**
   * 各 session 中各 request 的草稿状态(按 sessionId+requestId 隔离)。
   * 切换会话或切换 tab 时不清除,仅在 request resolved/abort 后才清。
   */
  sessionInputDrafts: Record<string, Record<string, unknown>>
  /**
   * 各 session 当前正在处理的那条 pending 请求 id(多条 pending 时的步进器位置)。
   * 待处理面板与输入框共用:面板据此渲染表单,输入框据此决定描边色与「其它」反馈的投递目标。
   * 选中项被 resolve 后清除,选择器回落到列表首条。
   */
  sessionActiveInputId: Record<string, string>
  /** 各 session 的 pi 消息队列快照（queue_update 事件镜像；只读） */
  sessionQueues: Record<string, SessionQueueSnapshot>
  /**
   * 各 session 的对话抽屉展开态（笔记本会话：输入框卡片顶部的限高对话面板）。
   * 缺键 = 折叠；活动（流式/审批）的上升沿由 ThreadDrawer 自动置 true，手动折叠置 false。
   */
  sessionThreadOpen: Record<string, boolean>
  /**
   * 聊天会话（bots）：各 session 在飞的成员活动（bot_activity 事件镜像，键 botName）。
   * ended/silent 相位即删键 —— 这里只保留「正在发生」的相位，驱动对话尾部的占位卡。
   * bot 会话没有 agent_end / finishStreaming，生命周期由事件自身 + messages_reloaded 收口。
   */
  sessionBotActivities: Record<string, Record<string, BotActivitySnapshot>>
  /** 聊天会话：各 session 各成员的 mailbox 快照（bot_mailbox 整份镜像；空快照即删键） */
  sessionBotMailbox: Record<string, Record<string, BotMailboxSnapshot>>

  // Actions
  setSessions: (sessions: Session[]) => void
  setActiveSessionId: (id: string | null) => void
  /** 请求打开某文件预览（绝对路径）；preview 工具事件 / 笔记本 [[wiki-link]] / Files 面板点击触发。
   *  openedBy 缺省 'user'：只有智能体事件那条路显式传 'agent'（预览面板据此亮出来源横幅）。 */
  requestFilePreview: (absPath: string, openedBy?: 'agent' | 'user') => void
  /** 请求把历史用户消息重建为输入框草稿（消息回退触发）；由 InputArea 消费后 clear */
  requestDraftRestore: (content: string, inlineTokens?: Record<string, InlineToken>) => void
  clearDraftRestore: () => void
  /** 欢迎页选档案（尚无会话）；null 清除 */
  setPendingAgentProfile: (name: string | null) => void
  setMessages: (messages: ChatMessage[]) => void
  addMessage: (message: ChatMessage) => void
  removeMessage: (id: string) => void
  replaceMessage: (id: string, message: ChatMessage) => void
  appendStreamingContent: (sessionId: string, delta: string) => void
  appendStreamingThinking: (sessionId: string, delta: string) => void
  appendStreamingImage: (sessionId: string, image: { data: string; mimeType: string }) => void
  clearStreamingContent: (sessionId: string) => void
  setIsStreaming: (sessionId: string, streaming: boolean) => void
  /** 标记某会话的运行时正在关停 / 关停完毕（后端 agent_closing 事件驱动） */
  setAgentClosing: (sessionId: string, closing: boolean) => void
  getSessionStreamContent: (sessionId: string) => string
  getSessionStreamThinking: (sessionId: string) => string
  setStreamingToolCall: (
    sessionId: string,
    toolCall: { toolName: string; argsText: string } | null
  ) => void
  appendStreamingToolCallDelta: (sessionId: string, delta: string) => void
  /** 将当前 streamingToolCall 移入 completedStreamingToolCalls 并清除 */
  finalizeStreamingToolCall: (sessionId: string) => void
  addToolExecution: (sessionId: string, exec: ToolExecution) => void
  updateToolExecution: (
    sessionId: string,
    toolCallId: string,
    updates: Partial<ToolExecution>
  ) => void
  clearToolExecutions: (sessionId: string) => void
  setInputText: (text: string) => void
  setModelSupportsReasoning: (supports: boolean) => void
  setThinkingLevel: (level: string) => void
  setModelSupportsVision: (supports: boolean) => void
  setMaxContextTokens: (tokens: number) => void
  setUsedContextTokens: (tokens: number | null) => void
  addPendingImage: (image: PendingImage) => void
  removePendingImage: (index: number) => void
  clearPendingImages: () => void
  updateSessionTitle: (id: string, title: string) => void
  updateSessionProject: (id: string, projectId: string | null) => void
  updateSessionSettings: (id: string, patch: Partial<SessionSettings>) => void
  removeSession: (id: string) => void
  setEnabledTools: (tools: string[]) => void
  setToolPresentations: (presentations: Record<string, ToolPresentation>) => void
  setProjectPath: (path: string | null) => void
  setSlashCommands: (
    commands: Array<{
      commandId: string
      name: string
      description: string
      template: string
      requiredTools?: string[]
      kind?: 'project' | 'skill'
    }>
  ) => void
  /** 设置/删除运行时资源状态（info 为 null 时删除） */
  setRuntime: (sessionId: string, runtimeId: string, info: RuntimeInfo | null) => void
  /** 批量设置运行时资源状态（session 初始化时使用） */
  setRuntimes: (sessionId: string, runtimes: Record<string, RuntimeInfo>) => void
  /** 添加一个新的 pending 输入请求 */
  addPendingInput: (sessionId: string, request: InputRequest) => void
  /** 移除某个已解决的 pending 请求(同时清掉草稿) */
  removePendingInput: (sessionId: string, requestId: string) => void
  /** 清空指定 session 的全部 pending(用于会话切换/失效) */
  clearPendingInputs: (sessionId: string) => void
  /** 设置/更新某个请求的草稿 */
  setInputDraft: (sessionId: string, requestId: string, draft: unknown) => void
  /** 选中某条 pending 请求(待处理面板的步进器) */
  setActiveInputId: (sessionId: string, requestId: string) => void
  /** 整体替换某会话的队列快照（queue_update 事件唯一写入点） */
  setSessionQueue: (sessionId: string, queue: SessionQueueSnapshot) => void
  /** 设置某会话对话抽屉的展开/折叠态 */
  setThreadOpen: (sessionId: string, open: boolean) => void
  /** bot_activity 事件唯一写入点：live 相位 upsert，ended/silent 删键；started 顺带清沉默提示 */
  handleBotActivity: (
    sessionId: string,
    ev: { botName: string; displayName: string; phase: string; messageId?: string }
  ) => void
  /** bot_mailbox 事件唯一写入点：按 botName 整份替换；空快照即删键 */
  setBotMailbox: (sessionId: string, botName: string, snapshot: BotMailboxSnapshot) => void
  /** 清某会话全部 bot live 态（messages_reloaded：回退/清空后一切在飞展示作废） */
  clearBotLiveState: (sessionId: string) => void
  /** Batch-apply buffered streaming deltas in a single set() (rAF optimization) */
  flushStreamingDeltas: (buffers: Map<string, StreamingDeltaBuffer>) => void
  /**
   * 原子处理 assistant_message：清除流式内容 + 按 id upsert 这张卡（单次 set，避免闪空）。
   * upsert 而非 append —— 同一条消息会被广播两次（message_end 一次，agent_end 兜底一次）。
   */
  handleAssistantMessage: (sessionId: string, message: ChatMessage | null) => void
  /** 原子处理 tool_start：清除流式工具调用 + 记录执行状态（单次 set，避免闪烁） */
  handleToolStart: (sessionId: string, exec: ToolExecution) => void
  /**
   * 原子处理 tool_end：更新执行状态 + 把结果回填进对应卡片的工具块（单次 set）。
   * 工具结果不是独立消息，回填目标由 toolCallId 决定（messageId 只用来先缩小查找范围）。
   */
  handleToolEnd: (
    sessionId: string,
    toolCallId: string,
    execUpdates: Partial<ToolExecution>,
    messageId?: string
  ) => void
  /** 原子完成流式：清除流式状态 + 工具执行 + 添加最终消息（单次 set，避免页面闪动） */
  finishStreaming: (sessionId: string, finalMessage?: ChatMessage) => void
}

// ========== 派生选择器（UI 组件通过这些选择器从底层 map 读取当前活跃会话的状态） ==========

/** 以本地时区按"YYYY-MM-DD"分组会话；用 updatedAt（最后活跃时间）作为落点。
 *  不是 zustand selector——每次调用都返回新 Map，需在组件内用 useMemo 包裹。 */
export const groupSessionsByDay = (sessions: Session[]): Map<string, Session[]> => {
  const map = new Map<string, Session[]>()
  for (const session of sessions) {
    const d = new Date(session.updatedAt)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const arr = map.get(key)
    if (arr) arr.push(session)
    else map.set(key, [session])
  }
  return map
}

export const selectStreamingContent = (s: ChatState): string =>
  s.activeSessionId ? s.sessionStreams[s.activeSessionId]?.content || '' : ''

export const selectStreamingThinking = (s: ChatState): string =>
  s.activeSessionId ? s.sessionStreams[s.activeSessionId]?.thinking || '' : ''

export const selectIsStreaming = (s: ChatState): boolean =>
  s.activeSessionId ? s.sessionStreams[s.activeSessionId]?.isStreaming || false : false

/** 当前会话的运行时是否正在关停（关停期间不能发送，见 sessionClosing） */
export const selectIsAgentClosing = (s: ChatState): boolean =>
  s.activeSessionId ? s.sessionClosing[s.activeSessionId] || false : false

/** 空图片数组常量，避免选择器每次返回新引用 */
const EMPTY_IMAGES: Array<{ data: string; mimeType: string }> = []

export const selectStreamingImages = (s: ChatState): Array<{ data: string; mimeType: string }> =>
  s.activeSessionId ? s.sessionStreams[s.activeSessionId]?.images || EMPTY_IMAGES : EMPTY_IMAGES

/**
 * 当前流式是否已经产出了可见内容（正文 / 思考 / 工具调用 / 图片）。
 *
 * 用来决定「渲染一张流式占位卡」还是「只显示等待动画」：刚发出请求、首 token
 * 未到时占位卡里什么都没有，画出来就是一张空卡。
 */
export const selectHasLiveStreamContent = (s: ChatState): boolean => {
  const st = s.activeSessionId ? s.sessionStreams[s.activeSessionId] : undefined
  if (!st) return false
  return !!(
    st.content ||
    st.thinking ||
    st.streamingToolCall ||
    st.completedStreamingToolCalls.length > 0 ||
    st.images.length > 0
  )
}

export const selectStreamingToolCall = (
  s: ChatState
): { toolName: string; argsText: string } | null =>
  s.activeSessionId ? (s.sessionStreams[s.activeSessionId]?.streamingToolCall ?? null) : null

const EMPTY_COMPLETED_TOOL_CALLS: Array<{
  toolName: string
  args?: Record<string, unknown>
}> = []

export const selectCompletedStreamingToolCalls = (
  s: ChatState
): Array<{ toolName: string; args?: Record<string, unknown> }> =>
  s.activeSessionId
    ? s.sessionStreams[s.activeSessionId]?.completedStreamingToolCalls || EMPTY_COMPLETED_TOOL_CALLS
    : EMPTY_COMPLETED_TOOL_CALLS

export const selectToolExecutions = (s: ChatState): ToolExecution[] =>
  s.activeSessionId ? s.sessionToolExecutions[s.activeSessionId] || EMPTY_TOOLS : EMPTY_TOOLS

/**
 * 某会话三条 pi 消息队列的只读快照。
 *
 * 队列由 pi 独占：只能入队，没有出队/改序/改档 —— 前端只镜像不操作。
 * harness 每次变动都重发全量，所以整体替换即可。
 */
export interface SessionQueueSnapshot {
  steer: ChatQueuedMessage[]
  followUp: ChatQueuedMessage[]
  nextTurn: ChatQueuedMessage[]
}

const EMPTY_QUEUE: SessionQueueSnapshot = { steer: [], followUp: [], nextTurn: [] }

/** 当前会话的队列快照（无队列时返回稳定的空对象引用，可安全用作 selector） */
export const selectSessionQueue = (s: ChatState): SessionQueueSnapshot =>
  (s.activeSessionId ? s.sessionQueues[s.activeSessionId] : undefined) ?? EMPTY_QUEUE

/** 队列总条数 */
export const selectSessionQueueCount = (s: ChatState): number => {
  const q = selectSessionQueue(s)
  return q.steer.length + q.followUp.length + q.nextTurn.length
}

/**
 * 聊天会话：一个成员的在飞活动（bot_activity 的 live 相位镜像）。
 * started = 意图段判断中；claimed = 赢下本条消息；queued = 在 mailbox 排队；working = 独占段执行中。
 */
export interface BotActivitySnapshot {
  botName: string
  displayName: string
  phase: 'started' | 'queued' | 'working'
  /** 本轮用户消息的 entry id（占位卡定位/停止钮参数） */
  messageId?: string
  /** 该相位事件到达时刻（本地钟，仅供展示） */
  at: number
}

/** 聊天会话：一个成员的 mailbox 快照（形状与 ChatBotMailboxEvent 同源） */
export interface BotMailboxSnapshot {
  active: { messageSeq: number; messageId: string } | null
  queued: Array<{ messageSeq: number; messageId: string; queuedAt: number }>
}

const EMPTY_BOT_ACTIVITIES: Record<string, BotActivitySnapshot> = {}
/** 当前会话的在飞成员活动（无活动时返回稳定空对象引用） */
export const selectBotActivities = (s: ChatState): Record<string, BotActivitySnapshot> =>
  (s.activeSessionId ? s.sessionBotActivities[s.activeSessionId] : undefined) ??
  EMPTY_BOT_ACTIVITIES

const EMPTY_BOT_MAILBOX: Record<string, BotMailboxSnapshot> = {}
/** 当前会话各成员的 mailbox 快照（无排队时返回稳定空对象引用） */
export const selectBotMailbox = (s: ChatState): Record<string, BotMailboxSnapshot> =>
  (s.activeSessionId ? s.sessionBotMailbox[s.activeSessionId] : undefined) ?? EMPTY_BOT_MAILBOX

/** 当前会话的所有 pending 输入请求(按时间序) */
const EMPTY_INPUT_REQUESTS: InputRequest[] = []
export const selectPendingInputs = (s: ChatState): InputRequest[] =>
  s.activeSessionId
    ? s.sessionPendingInputs[s.activeSessionId] || EMPTY_INPUT_REQUESTS
    : EMPTY_INPUT_REQUESTS

/**
 * 当前会话正在处理的那条 pending 请求(步进器选中项;未选或已失效时回落到首条)。
 * 返回的是列表内的元素引用 —— 数据不变时引用稳定,可安全用作 zustand selector。
 */
export const selectActivePendingInput = (s: ChatState): InputRequest | null => {
  const list = selectPendingInputs(s)
  if (list.length === 0) return null
  const id = s.activeSessionId ? s.sessionActiveInputId[s.activeSessionId] : undefined
  return list.find((r) => r.id === id) ?? list[0]
}

/**
 * 全局 pending 计数(供 Sidebar 一次读取所有会话的待处理数)。
 *
 * ⚠️ zustand + useSyncExternalStore 要求 selector 在数据未变时返回稳定引用,
 * 否则触发"getSnapshot should be cached"错误并陷入无限重渲染循环。
 * 用 module-scope cache 缓存上次的输入(sessionPendingInputs 引用)和输出对象,
 * 输入引用不变时直接返回上次的输出。
 */
const EMPTY_PENDING_COUNTS: Record<string, number> = {}
let _lastPendingCountsInput: ChatState['sessionPendingInputs'] | null = null
let _lastPendingCountsOutput: Record<string, number> = EMPTY_PENDING_COUNTS
export const selectAllPendingCounts = (s: ChatState): Record<string, number> => {
  if (s.sessionPendingInputs === _lastPendingCountsInput) return _lastPendingCountsOutput
  _lastPendingCountsInput = s.sessionPendingInputs
  const result: Record<string, number> = {}
  let nonEmpty = false
  for (const [sid, list] of Object.entries(s.sessionPendingInputs)) {
    if (list && list.length > 0) {
      result[sid] = list.length
      nonEmpty = true
    }
  }
  _lastPendingCountsOutput = nonEmpty ? result : EMPTY_PENDING_COUNTS
  return _lastPendingCountsOutput
}

/** 取某个会话中某个请求的草稿 */
export const selectInputDraft = (s: ChatState, sessionId: string, requestId: string): unknown =>
  s.sessionInputDrafts[sessionId]?.[requestId]

export const useChatStore = create<ChatState>((set, get) => ({
  sessions: [],
  ...deriveActive(null),
  filePreviewRequest: null,
  draftRestoreRequest: null,
  pendingAgentProfile: null,
  messages: [],
  sessionStreams: {},
  sessionClosing: {},
  sessionToolExecutions: {},
  sessionPendingInputs: {},
  sessionInputDrafts: {},
  sessionActiveInputId: {},
  sessionQueues: {},
  sessionThreadOpen: {},
  sessionBotActivities: {},
  sessionBotMailbox: {},
  modelSupportsReasoning: false,
  thinkingLevel: DEFAULT_THINKING_LEVEL,
  modelSupportsVision: false,
  maxContextTokens: 0,
  usedContextTokens: null,
  pendingImages: [],
  inputText: '',
  enabledTools: [],
  toolPresentations: {},
  projectPath: null,
  slashCommands: [],
  sessionResources: {},

  setSessions: (sessions) => set({ sessions }),
  setActiveSessionId: (id) => {
    const state = get()
    // 保存当前会话的输入框草稿
    if (state.activeSessionId) {
      sessionDrafts.set(state.activeSessionId, {
        inputText: state.inputText,
        pendingImages: state.pendingImages
      })
    }
    // 恢复目标会话的草稿（无则清空）
    const draft = id ? sessionDrafts.get(id) : undefined
    // 选中/新建会话即把 active 切到 session（互斥由 deriveActive 保证）
    set({
      ...deriveActive(id ? { type: 'session', id } : null),
      inputText: draft?.inputText ?? '',
      pendingImages: draft?.pendingImages ?? []
    })
  },
  requestFilePreview: (absPath, openedBy = 'user') =>
    set((state) => ({
      filePreviewRequest: { absPath, nonce: (state.filePreviewRequest?.nonce ?? 0) + 1, openedBy }
    })),
  requestDraftRestore: (content, inlineTokens) =>
    set((state) => ({
      draftRestoreRequest: {
        content,
        inlineTokens,
        nonce: (state.draftRestoreRequest?.nonce ?? 0) + 1
      }
    })),
  clearDraftRestore: () => set({ draftRestoreRequest: null }),
  setPendingAgentProfile: (name) => set({ pendingAgentProfile: name }),
  setMessages: (messages) => set({ messages }),
  addMessage: (message) =>
    set((state) =>
      state.messages.some((m) => m.id === message.id)
        ? state
        : { messages: [...state.messages, message] }
    ),
  removeMessage: (id) => set((state) => ({ messages: state.messages.filter((m) => m.id !== id) })),
  replaceMessage: (id, message) =>
    set((state) => ({
      messages: state.messages.map((m) => (m.id === id ? message : m))
    })),

  appendStreamingContent: (sessionId, delta) =>
    set((state) => {
      const prev = state.sessionStreams[sessionId] || {
        content: '',
        thinking: '',
        isStreaming: false,
        images: [],
        streamingToolCall: null,
        completedStreamingToolCalls: []
      }
      const updated = { ...prev, content: prev.content + delta }
      return { sessionStreams: { ...state.sessionStreams, [sessionId]: updated } }
    }),

  appendStreamingThinking: (sessionId, delta) =>
    set((state) => {
      const prev = state.sessionStreams[sessionId] || {
        content: '',
        thinking: '',
        isStreaming: false,
        images: [],
        streamingToolCall: null,
        completedStreamingToolCalls: []
      }
      const updated = { ...prev, thinking: prev.thinking + delta }
      return { sessionStreams: { ...state.sessionStreams, [sessionId]: updated } }
    }),

  appendStreamingImage: (sessionId, image) =>
    set((state) => {
      const prev = state.sessionStreams[sessionId] || {
        content: '',
        thinking: '',
        isStreaming: false,
        images: [],
        streamingToolCall: null,
        completedStreamingToolCalls: []
      }
      const updated = { ...prev, images: [...prev.images, image] }
      return { sessionStreams: { ...state.sessionStreams, [sessionId]: updated } }
    }),

  clearStreamingContent: (sessionId) =>
    set((state) => {
      const prev = state.sessionStreams[sessionId]
      if (!prev) return {}
      // 注意：不清除 streamingToolCall，等 tool_start 事件到达时再清除
      const updated = { ...prev, content: '', thinking: '', images: [] }
      return { sessionStreams: { ...state.sessionStreams, [sessionId]: updated } }
    }),

  setIsStreaming: (sessionId, streaming) =>
    set((state) => {
      const prev = state.sessionStreams[sessionId] || {
        content: '',
        thinking: '',
        isStreaming: false,
        images: [],
        streamingToolCall: null,
        completedStreamingToolCalls: []
      }
      const updated = { ...prev, isStreaming: streaming }
      return { sessionStreams: { ...state.sessionStreams, [sessionId]: updated } }
    }),

  setAgentClosing: (sessionId, closing) =>
    set((state) => {
      if (!!state.sessionClosing[sessionId] === closing) return {}
      const next = { ...state.sessionClosing }
      if (closing) next[sessionId] = true
      else delete next[sessionId]
      return { sessionClosing: next }
    }),

  getSessionStreamContent: (sessionId) => {
    return get().sessionStreams[sessionId]?.content || ''
  },

  getSessionStreamThinking: (sessionId) => {
    return get().sessionStreams[sessionId]?.thinking || ''
  },

  setStreamingToolCall: (sessionId, toolCall) =>
    set((state) => {
      const prev = state.sessionStreams[sessionId] || {
        content: '',
        thinking: '',
        isStreaming: false,
        images: [],
        streamingToolCall: null,
        completedStreamingToolCalls: []
      }
      // 设为 null 时同时清除已完成列表（生成阶段结束）
      const updated = toolCall
        ? { ...prev, streamingToolCall: toolCall }
        : { ...prev, streamingToolCall: null, completedStreamingToolCalls: [] }
      return { sessionStreams: { ...state.sessionStreams, [sessionId]: updated } }
    }),

  appendStreamingToolCallDelta: (sessionId, delta) =>
    set((state) => {
      const prev = state.sessionStreams[sessionId]
      if (!prev?.streamingToolCall) return {}
      const updated = {
        ...prev,
        streamingToolCall: {
          ...prev.streamingToolCall,
          argsText: prev.streamingToolCall.argsText + delta
        }
      }
      return { sessionStreams: { ...state.sessionStreams, [sessionId]: updated } }
    }),

  finalizeStreamingToolCall: (sessionId) =>
    set((state) => {
      const prev = state.sessionStreams[sessionId]
      if (!prev?.streamingToolCall) return {}
      // 尝试解析完整的 argsText 为结构化参数
      let parsedArgs: Record<string, unknown> | undefined
      try {
        parsedArgs = JSON.parse(prev.streamingToolCall.argsText)
      } catch {
        /* 解析失败则不带 args */
      }
      const completed = {
        toolName: prev.streamingToolCall.toolName,
        args: parsedArgs
      }
      const updated = {
        ...prev,
        streamingToolCall: null,
        completedStreamingToolCalls: [...prev.completedStreamingToolCalls, completed]
      }
      return { sessionStreams: { ...state.sessionStreams, [sessionId]: updated } }
    }),

  addToolExecution: (sessionId, exec) =>
    set((state) => {
      const prev = state.sessionToolExecutions[sessionId] || []
      return {
        sessionToolExecutions: { ...state.sessionToolExecutions, [sessionId]: [...prev, exec] }
      }
    }),

  updateToolExecution: (sessionId, toolCallId, updates) =>
    set((state) => {
      const prev = state.sessionToolExecutions[sessionId] || []
      const updated = prev.map((t) => (t.toolCallId === toolCallId ? { ...t, ...updates } : t))
      return { sessionToolExecutions: { ...state.sessionToolExecutions, [sessionId]: updated } }
    }),

  clearToolExecutions: (sessionId) =>
    set((state) => {
      const rest = { ...state.sessionToolExecutions }
      delete rest[sessionId]
      return { sessionToolExecutions: rest }
    }),

  setInputText: (text) => set({ inputText: text }),
  setModelSupportsReasoning: (supports) => set({ modelSupportsReasoning: supports }),
  setThinkingLevel: (level) => set({ thinkingLevel: level }),
  setModelSupportsVision: (supports) => set({ modelSupportsVision: supports }),
  setMaxContextTokens: (tokens) => set({ maxContextTokens: tokens }),
  setUsedContextTokens: (tokens) => set({ usedContextTokens: tokens }),
  addPendingImage: (image) => set((state) => ({ pendingImages: [...state.pendingImages, image] })),
  removePendingImage: (index) =>
    set((state) => ({ pendingImages: state.pendingImages.filter((_, i) => i !== index) })),
  clearPendingImages: () => set({ pendingImages: [] }),
  updateSessionTitle: (id, title) =>
    set((state) => ({
      sessions: state.sessions.map((s) => (s.id === id ? { ...s, title } : s))
    })),
  updateSessionProject: (id, projectId) =>
    set((state) => ({
      sessions: state.sessions.map((s) => (s.id === id ? { ...s, projectId } : s))
    })),
  updateSessionSettings: (id, patch) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === id ? { ...s, settings: { ...s.settings, ...patch } } : s
      )
    })),
  removeSession: (id) =>
    set((state) => ({
      sessions: state.sessions.filter((s) => s.id !== id),
      // 删除的是当前激活会话才清空 active
      ...(state.active?.type === 'session' && state.active.id === id ? deriveActive(null) : {})
    })),
  setEnabledTools: (tools) => set({ enabledTools: tools }),
  setToolPresentations: (presentations) => set({ toolPresentations: presentations }),
  setProjectPath: (path) => set({ projectPath: path }),
  setSlashCommands: (commands) => set({ slashCommands: commands }),

  setRuntime: (sessionId, runtimeId, info) =>
    set((state) => {
      const prev = state.sessionResources[sessionId]?.runtimes || {}
      const runtimes = { ...prev }
      if (info) {
        runtimes[runtimeId] = info
      } else {
        delete runtimes[runtimeId]
      }
      return {
        sessionResources: {
          ...state.sessionResources,
          [sessionId]: { runtimes }
        }
      }
    }),

  setRuntimes: (sessionId, runtimes) =>
    set((state) => ({
      sessionResources: {
        ...state.sessionResources,
        [sessionId]: { runtimes }
      }
    })),

  addPendingInput: (sessionId, request) =>
    set((state) => {
      const prev = state.sessionPendingInputs[sessionId] || []
      // 同一 id 已存在则更新而非追加(避免事件去重边界情况)
      const exists = prev.findIndex((r) => r.id === request.id)
      const next =
        exists >= 0 ? prev.map((r, i) => (i === exists ? request : r)) : [...prev, request]
      return {
        sessionPendingInputs: { ...state.sessionPendingInputs, [sessionId]: next }
      }
    }),

  removePendingInput: (sessionId, requestId) =>
    set((state) => {
      const prev = state.sessionPendingInputs[sessionId]
      if (!prev) return {}
      const nextList = prev.filter((r) => r.id !== requestId)
      const nextMap = { ...state.sessionPendingInputs }
      if (nextList.length > 0) {
        nextMap[sessionId] = nextList
      } else {
        delete nextMap[sessionId]
      }
      // 同时清掉对应草稿
      const sessionDrafts = state.sessionInputDrafts[sessionId]
      let nextDrafts = state.sessionInputDrafts
      if (sessionDrafts && requestId in sessionDrafts) {
        const { [requestId]: _drop, ...rest } = sessionDrafts
        nextDrafts = { ...state.sessionInputDrafts, [sessionId]: rest }
        if (Object.keys(rest).length === 0) {
          const { [sessionId]: _drop2, ...other } = nextDrafts
          nextDrafts = other
        }
      }
      // 选中的就是被解决的那条 → 清除选中,选择器回落到剩余列表首条
      let nextActive = state.sessionActiveInputId
      if (nextActive[sessionId] === requestId) {
        const { [sessionId]: _dropA, ...restA } = nextActive
        nextActive = restA
      }
      return {
        sessionPendingInputs: nextMap,
        sessionInputDrafts: nextDrafts,
        sessionActiveInputId: nextActive
      }
    }),

  clearPendingInputs: (sessionId) =>
    set((state) => {
      const nextMap = { ...state.sessionPendingInputs }
      delete nextMap[sessionId]
      const nextDrafts = { ...state.sessionInputDrafts }
      delete nextDrafts[sessionId]
      const nextActive = { ...state.sessionActiveInputId }
      delete nextActive[sessionId]
      return {
        sessionPendingInputs: nextMap,
        sessionInputDrafts: nextDrafts,
        sessionActiveInputId: nextActive
      }
    }),

  setInputDraft: (sessionId, requestId, draft) =>
    set((state) => {
      const sessionDrafts = state.sessionInputDrafts[sessionId] || {}
      return {
        sessionInputDrafts: {
          ...state.sessionInputDrafts,
          [sessionId]: { ...sessionDrafts, [requestId]: draft }
        }
      }
    }),

  setActiveInputId: (sessionId, requestId) =>
    set((state) => ({
      sessionActiveInputId: { ...state.sessionActiveInputId, [sessionId]: requestId }
    })),

  setSessionQueue: (sessionId, queue) =>
    set((state) => {
      const empty = !queue.steer.length && !queue.followUp.length && !queue.nextTurn.length
      // 三条都空时删键而不是存空对象 —— 选择器回落到稳定的 EMPTY_QUEUE 引用
      if (empty) {
        if (!state.sessionQueues[sessionId]) return {}
        const rest = { ...state.sessionQueues }
        delete rest[sessionId]
        return { sessionQueues: rest }
      }
      return { sessionQueues: { ...state.sessionQueues, [sessionId]: queue } }
    }),

  setThreadOpen: (sessionId, open) =>
    set((state) =>
      state.sessionThreadOpen[sessionId] === open
        ? {}
        : { sessionThreadOpen: { ...state.sessionThreadOpen, [sessionId]: open } }
    ),

  handleBotActivity: (sessionId, ev) =>
    set((state) => {
      const live = ev.phase === 'started' || ev.phase === 'queued' || ev.phase === 'working'
      const cur = state.sessionBotActivities[sessionId]
      const patch: Partial<ChatState> = {}
      if (live) {
        patch.sessionBotActivities = {
          ...state.sessionBotActivities,
          [sessionId]: {
            ...(cur ?? {}),
            [ev.botName]: {
              botName: ev.botName,
              displayName: ev.displayName,
              phase: ev.phase as BotActivitySnapshot['phase'],
              messageId: ev.messageId,
              at: Date.now()
            }
          }
        }
      } else {
        // ended / silent（以及未来未知相位）：该成员的在飞展示收摊
        if (!cur?.[ev.botName]) return {}
        const nextBots = { ...cur }
        delete nextBots[ev.botName]
        const next = { ...state.sessionBotActivities }
        if (Object.keys(nextBots).length) next[sessionId] = nextBots
        else delete next[sessionId]
        patch.sessionBotActivities = next
      }
      return patch
    }),

  setBotMailbox: (sessionId, botName, snapshot) =>
    set((state) => {
      const empty = !snapshot.active && snapshot.queued.length === 0
      const cur = state.sessionBotMailbox[sessionId]
      if (empty) {
        if (!cur?.[botName]) return {}
        const nextBots = { ...cur }
        delete nextBots[botName]
        const next = { ...state.sessionBotMailbox }
        if (Object.keys(nextBots).length) next[sessionId] = nextBots
        else delete next[sessionId]
        return { sessionBotMailbox: next }
      }
      return {
        sessionBotMailbox: {
          ...state.sessionBotMailbox,
          [sessionId]: { ...(cur ?? {}), [botName]: snapshot }
        }
      }
    }),

  clearBotLiveState: (sessionId) =>
    set((state) => {
      const patch: Partial<ChatState> = {}
      if (state.sessionBotActivities[sessionId]) {
        const next = { ...state.sessionBotActivities }
        delete next[sessionId]
        patch.sessionBotActivities = next
      }
      if (state.sessionBotMailbox[sessionId]) {
        const next = { ...state.sessionBotMailbox }
        delete next[sessionId]
        patch.sessionBotMailbox = next
      }
      return patch
    }),

  flushStreamingDeltas: (buffers) =>
    set((state) => {
      const newStreams = { ...state.sessionStreams }

      for (const [sessionId, buf] of buffers) {
        if (buf.content || buf.thinking || buf.toolCallArgsDelta) {
          const prev = newStreams[sessionId] || {
            content: '',
            thinking: '',
            isStreaming: false,
            images: [],
            streamingToolCall: null,
            completedStreamingToolCalls: []
          }
          const updated = { ...prev }
          if (buf.content) updated.content = prev.content + buf.content
          if (buf.thinking) updated.thinking = prev.thinking + buf.thinking
          if (buf.toolCallArgsDelta && updated.streamingToolCall) {
            updated.streamingToolCall = {
              ...updated.streamingToolCall,
              argsText: updated.streamingToolCall.argsText + buf.toolCallArgsDelta
            }
          }
          newStreams[sessionId] = updated
        }
      }

      return { sessionStreams: newStreams }
    }),

  handleAssistantMessage: (sessionId, message) =>
    set((state) => {
      const messages = message ? upsertMessage(state.messages, message) : state.messages
      const prev = state.sessionStreams[sessionId]
      if (!prev) return { messages }
      // 单次 set：清除流式内容与工具占位（正文和工具块都已落进这张卡）+ upsert 卡片
      const updatedStream = {
        ...prev,
        content: '',
        thinking: '',
        images: [],
        streamingToolCall: null,
        completedStreamingToolCalls: []
      }
      return {
        sessionStreams: { ...state.sessionStreams, [sessionId]: updatedStream },
        messages
      }
    }),

  handleToolStart: (sessionId, exec) =>
    set((state) => {
      // 1. 清除流式工具调用状态（工具块已经在卡片里，不需要流式占位）
      const prevStream = state.sessionStreams[sessionId]
      const updatedStream = prevStream
        ? { ...prevStream, streamingToolCall: null, completedStreamingToolCalls: [] }
        : undefined
      const newStreams = updatedStream
        ? { ...state.sessionStreams, [sessionId]: updatedStream }
        : state.sessionStreams

      // 2. 记录工具执行状态（工具面板 / 中断处理消费）
      const prevExecs = state.sessionToolExecutions[sessionId] || []
      return {
        sessionStreams: newStreams,
        sessionToolExecutions: {
          ...state.sessionToolExecutions,
          [sessionId]: [...prevExecs, exec]
        }
      }
    }),

  handleToolEnd: (sessionId, toolCallId, execUpdates, messageId) =>
    set((state) => {
      // 1. 更新工具执行状态
      const prevExecs = state.sessionToolExecutions[sessionId] || []
      const newExecs = prevExecs.map((t) =>
        t.toolCallId === toolCallId ? { ...t, ...execUpdates } : t
      )

      // 2. 结果回填进卡片的工具块
      return {
        sessionToolExecutions: { ...state.sessionToolExecutions, [sessionId]: newExecs },
        messages: fillToolResult(state.messages, toolCallId, messageId, {
          result: execUpdates.result ?? '',
          isError: execUpdates.status === 'error' || undefined,
          details: execUpdates.details
        })
      }
    }),

  finishStreaming: (sessionId, finalMessage) =>
    set((state) => {
      // 清除该 session 的流式内容
      const prevStream = state.sessionStreams[sessionId]
      const updatedStream = prevStream
        ? {
            ...prevStream,
            content: '',
            thinking: '',
            isStreaming: false,
            images: [],
            streamingToolCall: null,
            completedStreamingToolCalls: []
          }
        : undefined
      const newStreams = updatedStream
        ? { ...state.sessionStreams, [sessionId]: updatedStream }
        : state.sessionStreams

      // 清除该 session 的工具执行状态
      const restToolExecs = { ...state.sessionToolExecutions }
      delete restToolExecs[sessionId]

      // 清除该 session 的待处理用户输入(以及对应草稿和步进器选中项)
      const restPendingInputs = { ...state.sessionPendingInputs }
      delete restPendingInputs[sessionId]
      const restInputDrafts = { ...state.sessionInputDrafts }
      delete restInputDrafts[sessionId]
      const restActiveInputId = { ...state.sessionActiveInputId }
      delete restActiveInputId[sessionId]

      // 终答卡在 message_end 时已经 upsert 过，这里是兜底（同 id 覆盖，不会重复）
      const newMessages =
        finalMessage && sessionId === state.activeSessionId
          ? upsertMessage(state.messages, finalMessage)
          : state.messages

      return {
        sessionStreams: newStreams,
        sessionToolExecutions: restToolExecs,
        sessionPendingInputs: restPendingInputs,
        sessionInputDrafts: restInputDrafts,
        sessionActiveInputId: restActiveInputId,
        messages: newMessages
      }
    })
}))
