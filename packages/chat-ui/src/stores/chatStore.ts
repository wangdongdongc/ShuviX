/**
 * 对话域 store（chat-ui）。
 *
 * **会话内容是派生的**（phase 3，P3-08）：一条会话「现在长什么样」由服务端的会话视图（`SessionView`，经
 * 视图同步订阅，见 `sync/syncClient` 与 `useSessionView`）给出，store 里的会话切片 —— 当前会话的
 * `messages`、各会话的 `sessionStreams` / `sessionToolExecutions` / `sessionPendingInputs`、
 * `usedContextTokens` —— 全部只由 **`applySessionView`** 写（唯一的写入口）。选择器名字保持不变，组件不用改。
 * 排着的输入不另派生：队列面板直接读视图的 `queue`（`selectSessionQueueItems`，P3-11）。
 *
 * 视图之外只剩几样**本端叠加**（不进服务端、不跨窗口）：
 *  - 乐观占位的用户消息（`sessionPendingPrompt`，Q-P3-07）：发送那一刻顶上，视图里出现一条发送时还没有的
 *    用户消息即在同一次更新里撤下（PIN-17），发送调用落定时兜底撤下；
 *  - 本地错误行（`sessionLocalErrors`，PIN-02）：没有条目的 `error` 事件，挂在它到达时的最后一条消息后面，
 *    熬过视图更新，切会话即清；
 *  - 自动审查的「审查中」（`sessionToolReviewing`，PIN-04）：`tool_review` 可能先于视图里的工具进度到，
 *    先记下，工具一出现就叠上去；
 *  - 没人订阅视图的会话的运行标记（侧栏转圈，`agent_start` / `agent_end` 余项）与询问计数（`ask_count`，
 *    PIN-01）。
 *
 * 草稿、输入框、各种 UI 信号与之前一样。
 */
import { create } from 'zustand'
import type { InlineToken, ToolResultDetails } from '@shuvix/chat-protocol/types/chatMessage'
import type { ToolPresentation } from '@shuvix/chat-protocol/types/toolPresentation'
import { DEFAULT_THINKING_LEVEL } from '@shuvix/chat-protocol/types/thinking'
import {
  emptySessionView,
  type QueuedInputView,
  type RunView,
  type SessionView,
  type SessionViewCapabilities,
  type SessionViewSource
} from '@shuvix/chat-protocol/types/sessionView'
import {
  EMPTY_IMAGES,
  EMPTY_COMPLETED_TOOL_CALLS,
  EMPTY_TOOLS,
  deriveStream,
  deriveToolExecutions,
  emptyStream,
  firstNewUserMessage,
  isFinalAssistant,
  mergeLocalRows,
  shareStructure,
  type LocalErrorRow,
  type SessionStreamState,
  type ToolExecution
} from './viewDerivation'
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
import type {
  AssistantMessage,
  ChatMessage,
  ErrorEventMessage,
  UserTextMessage,
  UserTextMeta
} from '@shuvix/chat-protocol/types/chatMessage'
export type { ToolResultDetails }
export type { LocalErrorRow, SessionStreamState, ToolExecution } from './viewDerivation'

/** 重新导出统一的用户输入请求类型,UI 直接消费 */
export type {
  InputRequest,
  InputResponse,
  AskInputRequest,
  ChoiceInputRequest,
  AskResponse,
  ChoiceResponse,
  CancelResponse
} from '@shuvix/chat-protocol/types/inputRequest'
import type { InputRequest } from '@shuvix/chat-protocol/types/inputRequest'

/** 模型相关元数据 */
export interface SessionModelMetadata {
  thinkingLevel?: string
}

/** 会话级配置 */
export interface SessionSettings {
  allowList?: string[]
  /** 扩展能力勾选（mcp:/skill:）；只在创建 Agent 时读一次，运行时存在期间只读（见 useSessionTools） */
  enabledTools?: string[]
  /** 绑定的 bot；有值即为 bot 会话（普通有根会话，根档案 bot）。判定经 chat-protocol 的 isBotSessionSettings */
  bot?: string
  /** 子会话被父级钉下的档案名（session 工具 agent_profile）；根会话的档案由形态推导，不读它 */
  agentProfile?: string
  /** 笔记本会话绑定的 md 文件（相对项目根，forward-slash；项目记忆为绝对路径）；非空即为笔记本会话（根 Agent 钉死 notebook 基座档案，对话经输入卡片的抽屉呈现） */
  notebookPath?: string
  /**
   * 项目记忆笔记本：该会话绑定的是 `~/.shuvix/memory/<projectId>/<slug>.md`。
   * 侧栏据此把它归入项目组下的「项目记忆」子文件夹，而不是并排混进会话列表
   * （同一条记忆在同一处出现两次，比少一处入口更糟）。
   */
  memorySlug?: string
}

/** 会话类型（持久化字段，不含运行时计算属性） */
/**
 * 会话业务记录（与 chat-protocol 的 Session 同构）。
 *
 * 不含 provider / model / thinkingLevel —— 运行配置的唯一事实源是
 * 会话树，前端从 `agent.init` 拿当前值并存在本 store 的顶层字段里
 * （activeProvider / activeModel / thinkingLevel）。扩展能力勾选在 `settings.enabledTools`。
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
  /** 会话级配置（路径授权、扩展能力勾选等） */
  settings: SessionSettings
  createdAt: number
  /** 账本时间：改 title / projectId / settings 就 bump。日历和侧栏不读它。 */
  updatedAt: number
  /**
   * 用户在这条会话上动过手的时间。侧栏按它倒序；扩展日历单日落点；桌面日历不读它。
   * 缺省时读侧把 updatedAt 当回落（扩展 IndexedDB 旧行）。
   */
  lastActiveAt: number
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
 * 注：md live-preview 仅经「笔记本会话」进入（普通会话选择，中间区据 session.settings.notebookPath
 * 决定渲染 NotebookView 还是 ChatView），不再有独立的「临时打开任意文件」激活态 —— bot 这类注册表
 * md 也一样，打开它就是打开它的笔记本会话（隐藏项目，见 chat-protocol registryNotes）。
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
   * 触发方：笔记本 [[双链]] / Files 面板点击文件。
   * 消费方：宿主经 usePreviewRequestBridge 落为预览目标并揭示自己的预览面板
   * （桌面右侧 preview tab / 扩展与悬浮窗 PreviewOverlay）。
   * 含 nonce 以便重复请求同一文件也能触发（值变化）。
   */
  filePreviewRequest: { absPath: string; nonce: number; openedBy: 'agent' | 'user' } | null
  /**
   * 请求在后台任务面板里亮出某条任务的信号（对话流里那张工具卡的行尾状态被点了）。
   *
   * 派生 agent 的转写搬进面板之后，工具卡上不再有内容可展开 —— 这个信号就是从卡片
   * 回到那份转写的路。消费方：宿主的 useSessionPanelReveal 展开面板并切到任务页，
   * 面板据 taskId 独占展开那一条。含 nonce 以便重复点同一条也能触发。
   */
  taskRevealRequest: { taskId: string; nonce: number } | null
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
   * 请求滚到某条消息（日历点进某天会话：当天第一条用户消息）。
   * 消费方：Conversation 等消息列表渲染后再 querySelector `[data-msg-id]`。
   * 含 nonce 以便重复点同一条也能触发。entry 不在当前上下文（被 moveTo 切掉）时滚动失败就停顶部。
   */
  scrollToMessageRequest: { sessionId: string; messageId: string; nonce: number } | null
  /**
   * 当前会话的消息列表 —— 派生值：当前会话视图的 `messages` + 本地错误行（PIN-02）− 本端关掉的行。
   * 只有 `applySessionView` / 切会话写它
   */
  messages: ChatMessage[]
  /**
   * 各会话此刻订阅着的视图（结构共享过的原值，P3-08）—— 运行状态 / 队列 / 能力 / 来源从这里读
   * （`selectSessionRun` 等，P3-11 / P3-12 的接缝）。只有 `applySessionView` 写；退订即删
   */
  sessionViews: Record<string, SessionView>
  /**
   * 各 session 的流式状态（按 sessionId 隔离）。订阅着视图的会话由视图派生；没人订阅的会话只有
   * `isStreaming`，由 `agent_start` / `agent_end` 余项维护（侧栏转圈）
   */
  sessionStreams: Record<string, SessionStreamState>
  /**
   * 各 session 的运行时关停状态（按 sessionId 隔离）。
   *
   * 一个会话同一时刻只允许有一个 Agent 运行时：回退/切档案/清空都要先把旧运行时**彻底**
   * 停下才解绑，新的要等它停完才出生。这段时间发消息没有意义，UI 呈现「正在停止」并禁用发送。
   * 通常一瞬间；工具卡住不返回时会明显可见 —— 这正是要显式呈现它的原因。
   */
  sessionClosing: Record<string, boolean>
  /**
   * 各 session 此刻是否有 Agent 运行时（`agent.init` 的 created 打底，`agent_created` /
   * `agent_closing{false}` 事件维护）。扩展能力勾选只在创建运行时那一刻读一次 —— 有运行时
   * 期间，工具选择器与会话设置里的扩展能力都是只读的。
   */
  sessionAgentCreated: Record<string, boolean>
  /**
   * 欢迎页（还没有会话）上勾的扩展能力（mcp:/skill:）—— 直接发送新建会话时写进那条会话的
   * `settings.enabledTools`，随后清空。没有会话就没有可写的地方，所以先记在这里。
   */
  welcomeEnabledTools: string[]
  /**
   * 各 session 正在发送、还没被会话受理的那条用户消息（乐观占位，Q-P3-07；**只在发送方本端**）。
   *
   * 创建运行时（含 MCP 惰性连接）可能要花几秒，这几秒里输入框已清空、列表里却没有那句话 —— 像是消息
   * 丢了。占位气泡先顶上：视图里出现一条发送那一刻还没有的用户消息，就在同一次更新里撤下（PIN-17）；
   * 发送调用落定（含出错）时兜底撤下。
   */
  sessionPendingPrompt: Record<string, UserTextMessage>
  /** 各 session 创建运行时期间正在连接的 MCP server 名（`mcp_connecting` 事件维护，`agent_created` 清空） */
  sessionMcpConnecting: Record<string, string[]>
  /** 各 session 的工具执行实时状态（视图的 `toolRuns` + 工具块 + 审查叠加，派生） */
  sessionToolExecutions: Record<string, ToolExecution[]>
  /**
   * 各 session 里「自动审查中」的工具调用（`tool_review` 事件的本地叠加，PIN-04）：事件可能先于视图里的
   * 工具进度到达，先记在这里，工具一出现就叠到它的执行记录上。`reviewing:false`、工具做完、本轮结束即清
   */
  sessionToolReviewing: Record<string, Record<string, true>>
  /** 当前模型是否支持深度思考 */
  modelSupportsReasoning: boolean
  /** 当前思考深度 */
  thinkingLevel: string
  /** 当前模型是否支持图片输入 */
  modelSupportsVision: boolean
  /** 当前模型最大上下文 token 数 */
  maxContextTokens: number
  /** 当前会话已占用上下文 token 数（当前会话视图的 `context.usedTokens`；换模型时由 ModelPicker 清空） */
  usedContextTokens: number | null
  /** 待发送的图片列表（base64），按会话隔离 */
  pendingImages: PendingImage[]
  /** 输入框内容 */
  inputText: string
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
   * 各 session 挂着的用户输入请求（订阅着视图的会话 = 视图的 `asks`，派生）。
   * 命令询问 / 选择题 / SSH 凭证全部走这一张表。
   */
  sessionPendingInputs: Record<string, InputRequest[]>
  /**
   * 各 session 挂着几条询问（`ask_count` 余项，PIN-01）—— 给没人订阅视图的会话用（侧栏徽标、后台任务面板
   * 的「卡在等人」）。订阅着的会话以视图为准
   */
  sessionAskCounts: Record<string, number>
  /**
   * 各 session 中各 request 的草稿状态(按 sessionId+requestId 隔离)。
   * 切换会话或切换 tab 时不清除,询问从视图里消失时才清。
   */
  sessionInputDrafts: Record<string, Record<string, unknown>>
  /**
   * 各 session 当前正在处理的那条 pending 请求 id(多条 pending 时的步进器位置)。
   * 待处理面板与输入框共用:面板据此渲染表单,输入框据此决定描边色与「其它」反馈的投递目标。
   * 选中项从视图里消失时清除,选择器回落到列表首条。
   */
  sessionActiveInputId: Record<string, string>
  /** 各 session 的本地错误行（PIN-02；只给当前会话记，切走即清） */
  sessionLocalErrors: Record<string, LocalErrorRow[]>
  /**
   * 各 session 的对话抽屉展开态（笔记本会话：输入框卡片顶部的限高对话面板）。
   * 缺键 = 折叠；活动（流式/审批）的上升沿由 ThreadDrawer 自动置 true，手动折叠置 false。
   */
  sessionThreadOpen: Record<string, boolean>

  // Actions
  setSessions: (sessions: Session[]) => void
  setActiveSessionId: (id: string | null) => void
  /** 请求打开某文件预览（绝对路径）；笔记本 [[wiki-link]] / Files 面板点击触发。
   *  openedBy 缺省 'user'。 */
  requestFilePreview: (absPath: string, openedBy?: 'agent' | 'user') => void
  /** 请求在后台任务面板里亮出某条任务（工具卡行尾状态点击触发） */
  revealTask: (taskId: string) => void
  /** 请求把历史用户消息重建为输入框草稿（消息回退触发）；由 InputArea 消费后 clear */
  requestDraftRestore: (content: string, inlineTokens?: Record<string, InlineToken>) => void
  clearDraftRestore: () => void
  /** 请求滚到某条消息（日历点进某天）；Conversation 等消息列表渲染后消费 */
  requestScrollToMessage: (sessionId: string, messageId: string) => void
  /** 滚完或目标不在当前上下文后清掉，避免 visibleItems 再变时把用户弹回去 */
  clearScrollToMessage: () => void
  /** 本端关掉一行（错误行的关闭按钮）：本地错误行直接删掉；视图里的行在这个会话里不再显示，切走即恢复 */
  removeMessage: (id: string) => void
  /** 标记某会话的运行时正在关停 / 关停完毕（后端 agent_closing 事件驱动） */
  setAgentClosing: (sessionId: string, closing: boolean) => void
  /** 标记某会话此刻有 / 没有 Agent 运行时（agent.init 与 agent_created / agent_closing 驱动） */
  setAgentCreated: (sessionId: string, created: boolean) => void
  /** 整份替换欢迎页的扩展能力勾选 */
  setWelcomeEnabledTools: (tools: string[]) => void
  /** 设 / 撤某会话的乐观占位用户消息（null = 撤）。设的那一刻记下视图里已有的消息 id（PIN-17） */
  setPendingPrompt: (sessionId: string, message: UserTextMessage | null) => void
  /** 某会话创建运行时期间：某台 MCP 开始连 / 落定（`mcp_connecting` 事件驱动） */
  setMcpConnecting: (sessionId: string, server: string, connecting: boolean) => void
  /** 清空某会话的 MCP 连接态（agent_created / agent_end / error） */
  clearMcpConnecting: (sessionId: string) => void
  /**
   * 没人订阅视图的会话：`agent_start` / `agent_end` 余项置 / 清它的运行标记（侧栏转圈）。订阅着视图的会话
   * 不受影响 —— 余项从不抢在视图前面翻转 `isStreaming`（P3-08-30 / -40）
   */
  markSessionRunning: (sessionId: string, running: boolean) => void
  /** `ask_count` 余项：某会话挂着几条询问（PIN-01） */
  setAskCount: (sessionId: string, count: number) => void
  /** 本地错误行（没有条目的 `error` 事件，PIN-02）：只给当前会话记，挂在此刻最后一条消息后面 */
  addLocalError: (sessionId: string, content: string) => void
  setInputText: (text: string) => void
  setModelSupportsReasoning: (supports: boolean) => void
  setThinkingLevel: (level: string) => void
  setModelSupportsVision: (supports: boolean) => void
  setMaxContextTokens: (tokens: number) => void
  /** 换模型时清空上下文占用显示（ModelPicker）；会话视图的 `context.usedTokens` 随后照常覆盖 */
  setUsedContextTokens: (tokens: number | null) => void
  addPendingImage: (image: PendingImage) => void
  removePendingImage: (index: number) => void
  clearPendingImages: () => void
  updateSessionTitle: (id: string, title: string) => void
  updateSessionProject: (id: string, projectId: string | null) => void
  updateSessionSettings: (id: string, patch: Partial<SessionSettings>) => void
  /** 用户动手：把该条 lastActiveAt 提到现在并按活动时间重排（侧栏上浮）。发消息的乐观路径用。 */
  touchSessionActive: (id: string) => void
  removeSession: (id: string) => void
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
  /** 设置/更新某个请求的草稿 */
  setInputDraft: (sessionId: string, requestId: string, draft: unknown) => void
  /** 选中某条 pending 请求(待处理面板的步进器) */
  setActiveInputId: (sessionId: string, requestId: string) => void
  /** 设置某会话对话抽屉的展开/折叠态 */
  setThreadOpen: (sessionId: string, open: boolean) => void
  /**
   * 自动审查开始 / 落定（`tool_review` 事件）：只改审查叠加（PIN-04），不碰卡片 —— 审查是工具执行中的
   * 一段过程态，结论另有落点（details / 红行 / 询问卡片）。事件先于视图里的工具进度到也记下
   */
  setToolReviewing: (sessionId: string, toolCallId: string, reviewing: boolean) => void
}

// ========== 派生选择器（UI 组件通过这些选择器从底层 map 读取当前活跃会话的状态） ==========

export const selectStreamingContent = (s: ChatState): string =>
  s.activeSessionId ? s.sessionStreams[s.activeSessionId]?.content || '' : ''

export const selectStreamingThinking = (s: ChatState): string =>
  s.activeSessionId ? s.sessionStreams[s.activeSessionId]?.thinking || '' : ''

export const selectIsStreaming = (s: ChatState): boolean =>
  s.activeSessionId ? s.sessionStreams[s.activeSessionId]?.isStreaming || false : false

/** 当前会话的运行时是否正在关停（关停期间不能发送，见 sessionClosing） */
export const selectIsAgentClosing = (s: ChatState): boolean =>
  s.activeSessionId ? s.sessionClosing[s.activeSessionId] || false : false

/** 当前会话正在发送、还没被受理的用户消息（乐观占位）；没有则 null */
export const selectPendingPrompt = (s: ChatState): UserTextMessage | null =>
  (s.activeSessionId && s.sessionPendingPrompt[s.activeSessionId]) || null

/** 空列表常量：选择器不能每次返回新引用（zustand 按引用判等，否则次次重渲染） */
const NO_SERVERS: string[] = []

/** 当前会话创建运行时期间正在连接的 MCP server 名 */
export const selectMcpConnecting = (s: ChatState): string[] =>
  (s.activeSessionId && s.sessionMcpConnecting[s.activeSessionId]) || NO_SERVERS

/** 乐观占位的用户消息 id：尚未被受理，视图里出现真实条目就撤 —— 这个 id 不会进 messages */
export const PENDING_PROMPT_ID = 'pending-prompt'

/** 构造乐观占位的用户消息：与真实 entry 同形，气泡组件不必区分 */
export function pendingPromptMessage(
  sessionId: string,
  content: string,
  metadata: Pick<UserTextMeta, 'inlineTokens' | 'images'> = {}
): UserTextMessage {
  return {
    id: PENDING_PROMPT_ID,
    sessionId,
    role: 'user',
    type: 'text',
    content,
    model: '',
    createdAt: Date.now(),
    metadata
  }
}

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

export const selectCompletedStreamingToolCalls = (
  s: ChatState
): Array<{ toolName: string; args?: Record<string, unknown> }> =>
  s.activeSessionId
    ? s.sessionStreams[s.activeSessionId]?.completedStreamingToolCalls || EMPTY_COMPLETED_TOOL_CALLS
    : EMPTY_COMPLETED_TOOL_CALLS

export const selectToolExecutions = (s: ChatState): ToolExecution[] =>
  s.activeSessionId ? s.sessionToolExecutions[s.activeSessionId] || EMPTY_TOOLS : EMPTY_TOOLS

export { EMPTY_TOOLS }

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
 * 全局 pending 计数(供 Sidebar 一次读取所有会话的待处理数)：订阅着视图的会话按视图的询问数，
 * 其余按 `ask_count` 余项（PIN-01）。
 *
 * ⚠️ zustand + useSyncExternalStore 要求 selector 在数据未变时返回稳定引用,
 * 否则触发"getSnapshot should be cached"错误并陷入无限重渲染循环。
 * 用 module-scope cache 缓存上次的两个输入引用和输出对象,输入引用不变时直接返回上次的输出。
 */
const EMPTY_PENDING_COUNTS: Record<string, number> = {}
let _lastPendingInputs: ChatState['sessionPendingInputs'] | null = null
let _lastAskCounts: ChatState['sessionAskCounts'] | null = null
let _lastViews: ChatState['sessionViews'] | null = null
let _lastPendingCountsOutput: Record<string, number> = EMPTY_PENDING_COUNTS
export const selectAllPendingCounts = (s: ChatState): Record<string, number> => {
  if (
    s.sessionPendingInputs === _lastPendingInputs &&
    s.sessionAskCounts === _lastAskCounts &&
    (s.sessionViews === _lastViews || sameKeys(s.sessionViews, _lastViews))
  ) {
    _lastViews = s.sessionViews
    return _lastPendingCountsOutput
  }
  _lastPendingInputs = s.sessionPendingInputs
  _lastAskCounts = s.sessionAskCounts
  _lastViews = s.sessionViews
  const result: Record<string, number> = {}
  for (const [sid, count] of Object.entries(s.sessionAskCounts)) {
    if (count > 0 && !(sid in s.sessionViews)) result[sid] = count
  }
  for (const [sid, list] of Object.entries(s.sessionPendingInputs)) {
    if (list && list.length > 0) result[sid] = list.length
  }
  const next = Object.keys(result).length > 0 ? result : EMPTY_PENDING_COUNTS
  if (!sameCounts(next, _lastPendingCountsOutput)) _lastPendingCountsOutput = next
  return _lastPendingCountsOutput
}

function sameKeys(a: Record<string, unknown>, b: Record<string, unknown> | null): boolean {
  if (b === null) return false
  const ak = Object.keys(a)
  return ak.length === Object.keys(b).length && ak.every((k) => k in b)
}

function sameCounts(a: Record<string, number>, b: Record<string, number>): boolean {
  if (a === b) return true
  const ak = Object.keys(a)
  return ak.length === Object.keys(b).length && ak.every((k) => a[k] === b[k])
}

/** 某会话此刻挂着几条询问（订阅着视图 → 视图；否则 `ask_count`）—— 后台任务面板的「卡在等人」 */
export const selectSessionAskCount =
  (sessionId: string) =>
  (s: ChatState): number =>
    sessionId in s.sessionViews
      ? (s.sessionPendingInputs[sessionId]?.length ?? 0)
      : (s.sessionAskCounts[sessionId] ?? 0)

/**
 * 各会话是否在跑（侧栏转圈）：`sessionStreams[id].isStreaming` 的只读快照，值不变时引用稳定 ——
 * 流式追加只改正文，侧栏不该跟着每个 token 重渲染
 */
let _lastStreamsInput: ChatState['sessionStreams'] | null = null
let _lastStreamingFlags: Record<string, boolean> = {}
export const selectStreamingSessions = (s: ChatState): Record<string, boolean> => {
  if (s.sessionStreams === _lastStreamsInput) return _lastStreamingFlags
  _lastStreamsInput = s.sessionStreams
  const next: Record<string, boolean> = {}
  for (const [sid, st] of Object.entries(s.sessionStreams)) if (st.isStreaming) next[sid] = true
  const prev = _lastStreamingFlags
  const same =
    Object.keys(next).length === Object.keys(prev).length && Object.keys(next).every((k) => prev[k])
  if (!same) _lastStreamingFlags = next
  return _lastStreamingFlags
}

/** 取某个会话中某个请求的草稿 */
export const selectInputDraft = (s: ChatState, sessionId: string, requestId: string): unknown =>
  s.sessionInputDrafts[sessionId]?.[requestId]

// ─── 视图接缝（P3-08 → P3-10b / P3-11 / P3-12，PIN-23） ───

const IDLE_RUN: RunView = { state: 'idle' }
const EMPTY_QUEUE_ITEMS: QueuedInputView[] = []
/** 还没收到视图时的能力（与「还没有存储」的新会话同口径：能发第一条，不能回退 / 继续） */
const DEFAULT_CAPABILITIES: SessionViewCapabilities = emptySessionView('').capabilities

/** 某会话此刻订阅着的视图（没订阅 / 还没到 → undefined） */
export const selectSessionViewOf =
  (sessionId: string) =>
  (s: ChatState): SessionView | undefined =>
    s.sessionViews[sessionId]

/** 当前会话的视图（没有 → null） */
export const selectActiveSessionView = (s: ChatState): SessionView | null =>
  (s.activeSessionId ? s.sessionViews[s.activeSessionId] : undefined) ?? null

/** 当前会话视图的运行状态（`state` / `retry` / `compacting`）；没有视图 → 空闲 */
export const selectSessionRun = (s: ChatState): RunView =>
  selectActiveSessionView(s)?.run ?? IDLE_RUN

/**
 * 当前会话视图里排着的输入（带 `submissionId` / `mode`，撤回要用；视图的次序）。值相等的视图之间引用不变
 * （`applySessionView` 的结构共享），空队列 / 没有视图 → 稳定的空数组 —— 可直接当 selector 用。
 */
export const selectSessionQueueItems = (s: ChatState): QueuedInputView[] =>
  selectActiveSessionView(s)?.queue ?? EMPTY_QUEUE_ITEMS

/** 当前会话能做什么（按存储种类）；还没收到视图 → 新会话的口径（PIN-16：只给选择器，禁用输入框归 P3-12） */
export const selectSessionCapabilities = (s: ChatState): SessionViewCapabilities =>
  selectActiveSessionView(s)?.capabilities ?? DEFAULT_CAPABILITIES

/** 当前会话视图的来源（durable / legacy / none）；还没收到视图 → null */
export const selectSessionSource = (s: ChatState): SessionViewSource | null =>
  selectActiveSessionView(s)?.source ?? null

// ─── 本端叠加的模块状态（不进 store：只有写入口读它们） ───

/** 乐观占位发出那一刻，视图里已有的消息 id（PIN-17） */
const pendingBaselines = new Map<string, Set<string>>()
/** 本端关掉的行（当前会话；切走即清） */
const dismissedRows = new Map<string, Set<string>>()
/** 没人订阅视图的会话的运行标记（余项维护） */
const residueRunning = new Set<string>()
/** 一轮开始那一刻视图里已有的消息 id（运行收尾检测：TTS 等，PIN-03） */
const runBaselines = new Map<string, Set<string>>()

function idsOf(messages: readonly ChatMessage[] | undefined): Set<string> {
  return new Set((messages ?? []).map((m) => m.id))
}

/** 没有视图的会话的流式状态：只有运行标记（余项 / 乐观占位） */
function residueStream(
  sessionId: string,
  pending: boolean,
  prev: SessionStreamState | undefined
): SessionStreamState {
  const isStreaming = residueRunning.has(sessionId) || pending
  if (prev && prev.isStreaming === isStreaming) return prev
  return prev ? { ...prev, isStreaming } : emptyStream(isStreaming)
}

function withKey<T>(map: Record<string, T>, key: string, value: T | undefined): Record<string, T> {
  if (value === undefined) {
    if (!(key in map)) return map
    const next = { ...map }
    delete next[key]
    return next
  }
  if (map[key] === value) return map
  return { ...map, [key]: value }
}

/** 当前会话的界面消息：视图消息 + 本地错误行 − 本端关掉的行 */
function displayMessages(
  state: Pick<ChatState, 'sessionViews' | 'sessionLocalErrors'>,
  sessionId: string | null,
  viewMessages?: ChatMessage[]
): ChatMessage[] {
  if (!sessionId) return NO_MESSAGES
  const messages = viewMessages ?? state.sessionViews[sessionId]?.messages ?? NO_MESSAGES
  return mergeLocalRows(messages, state.sessionLocalErrors[sessionId], dismissedRows.get(sessionId))
}
const NO_MESSAGES: ChatMessage[] = []

export const useChatStore = create<ChatState>((set, get) => ({
  sessions: [],
  ...deriveActive(null),
  filePreviewRequest: null,
  taskRevealRequest: null,
  draftRestoreRequest: null,
  scrollToMessageRequest: null,
  messages: [],
  sessionViews: {},
  sessionStreams: {},
  sessionClosing: {},
  sessionAgentCreated: {},
  welcomeEnabledTools: [],
  sessionPendingPrompt: {},
  sessionMcpConnecting: {},
  sessionToolExecutions: {},
  sessionToolReviewing: {},
  sessionPendingInputs: {},
  sessionAskCounts: {},
  sessionInputDrafts: {},
  sessionActiveInputId: {},
  sessionLocalErrors: {},
  sessionThreadOpen: {},
  modelSupportsReasoning: false,
  thinkingLevel: DEFAULT_THINKING_LEVEL,
  modelSupportsVision: false,
  maxContextTokens: 0,
  usedContextTokens: null,
  pendingImages: [],
  inputText: '',
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
    // 本地错误行与本端关掉的行只活在当前会话的这一段里（PIN-02：与从前「切回来重新拉列表」同效）
    const previous = state.activeSessionId
    let sessionLocalErrors = state.sessionLocalErrors
    if (previous && previous !== id) {
      sessionLocalErrors = withKey(sessionLocalErrors, previous, undefined)
      dismissedRows.delete(previous)
    }
    const view = id ? state.sessionViews[id] : undefined
    // 选中/新建会话即把 active 切到 session（互斥由 deriveActive 保证）；消息列表同一次换成新会话的
    // （还没收到视图 → 空），绝不出现「激活的是 B、列表里是 A」（P3-08-13）
    set({
      ...deriveActive(id ? { type: 'session', id } : null),
      inputText: draft?.inputText ?? '',
      pendingImages: draft?.pendingImages ?? [],
      sessionLocalErrors,
      messages: displayMessages({ sessionViews: state.sessionViews, sessionLocalErrors }, id),
      usedContextTokens: view?.context.usedTokens ?? null
    })
  },
  requestFilePreview: (absPath, openedBy = 'user') =>
    set((state) => ({
      filePreviewRequest: { absPath, nonce: (state.filePreviewRequest?.nonce ?? 0) + 1, openedBy }
    })),
  revealTask: (taskId) =>
    set((state) => ({
      taskRevealRequest: { taskId, nonce: (state.taskRevealRequest?.nonce ?? 0) + 1 }
    })),
  requestDraftRestore: (content, inlineTokens) =>
    set((state) => ({
      draftRestoreRequest: {
        content,
        inlineTokens,
        nonce: (state.draftRestoreRequest?.nonce ?? 0) + 1
      }
    })),
  requestScrollToMessage: (sessionId, messageId) =>
    set((state) => ({
      scrollToMessageRequest: {
        sessionId,
        messageId,
        nonce: (state.scrollToMessageRequest?.nonce ?? 0) + 1
      }
    })),
  clearScrollToMessage: () => set({ scrollToMessageRequest: null }),
  clearDraftRestore: () => set({ draftRestoreRequest: null }),
  removeMessage: (id) =>
    set((state) => {
      const sid = state.activeSessionId
      if (!sid) return {}
      let dismissed = dismissedRows.get(sid)
      if (!dismissed) {
        dismissed = new Set()
        dismissedRows.set(sid, dismissed)
      }
      dismissed.add(id)
      const local = state.sessionLocalErrors[sid]
      const kept = local?.filter((row) => row.message.id !== id)
      const sessionLocalErrors =
        local && kept && kept.length !== local.length
          ? withKey(state.sessionLocalErrors, sid, kept.length > 0 ? kept : undefined)
          : state.sessionLocalErrors
      const view = state.sessionViews[sid]
      return {
        sessionLocalErrors,
        messages: view
          ? displayMessages({ sessionViews: state.sessionViews, sessionLocalErrors }, sid)
          : state.messages.filter((m) => m.id !== id)
      }
    }),

  setAgentClosing: (sessionId, closing) =>
    set((state) => {
      if (!!state.sessionClosing[sessionId] === closing) return {}
      const next = { ...state.sessionClosing }
      if (closing) next[sessionId] = true
      else delete next[sessionId]
      return { sessionClosing: next }
    }),

  setAgentCreated: (sessionId, created) =>
    set((state) => {
      if (!!state.sessionAgentCreated[sessionId] === created) return {}
      const next = { ...state.sessionAgentCreated }
      if (created) next[sessionId] = true
      else delete next[sessionId]
      return { sessionAgentCreated: next }
    }),

  setWelcomeEnabledTools: (tools) => set({ welcomeEnabledTools: tools }),

  setPendingPrompt: (sessionId, message) =>
    set((state) => {
      if (!message && !state.sessionPendingPrompt[sessionId]) return {}
      if (message) pendingBaselines.set(sessionId, idsOf(state.sessionViews[sessionId]?.messages))
      else pendingBaselines.delete(sessionId)
      const sessionPendingPrompt = withKey(
        state.sessionPendingPrompt,
        sessionId,
        message ?? undefined
      )
      const view = state.sessionViews[sessionId]
      const prevStream = state.sessionStreams[sessionId]
      const stream = view
        ? deriveStream(view, !!message, prevStream)
        : residueStream(sessionId, !!message, prevStream)
      return {
        sessionPendingPrompt,
        sessionStreams: withKey(state.sessionStreams, sessionId, stream)
      }
    }),

  setMcpConnecting: (sessionId, server, connecting) =>
    set((state) => {
      const prev = state.sessionMcpConnecting[sessionId] ?? []
      if (connecting === prev.includes(server)) return {}
      const list = connecting ? [...prev, server] : prev.filter((s) => s !== server)
      const next = { ...state.sessionMcpConnecting }
      if (list.length > 0) next[sessionId] = list
      else delete next[sessionId]
      return { sessionMcpConnecting: next }
    }),

  clearMcpConnecting: (sessionId) =>
    set((state) => {
      if (!state.sessionMcpConnecting[sessionId]) return {}
      const next = { ...state.sessionMcpConnecting }
      delete next[sessionId]
      return { sessionMcpConnecting: next }
    }),

  markSessionRunning: (sessionId, running) =>
    set((state) => {
      if (running) residueRunning.add(sessionId)
      else residueRunning.delete(sessionId)
      // 订阅着视图：运行状态以视图为准，余项只记下（退订之后接着用）
      if (sessionId in state.sessionViews) return {}
      const prev = state.sessionStreams[sessionId]
      const stream = residueStream(sessionId, !!state.sessionPendingPrompt[sessionId], prev)
      if (stream === prev) return {}
      return { sessionStreams: { ...state.sessionStreams, [sessionId]: stream } }
    }),

  setAskCount: (sessionId, count) =>
    set((state) => {
      const value = count > 0 ? count : undefined
      const next = withKey(state.sessionAskCounts, sessionId, value)
      return next === state.sessionAskCounts ? {} : { sessionAskCounts: next }
    }),

  addLocalError: (sessionId, content) =>
    set((state) => {
      if (sessionId !== state.activeSessionId) return {}
      const message: ErrorEventMessage = {
        id: `local-error-${Date.now()}-${Math.round(Math.random() * 1e9)}`,
        sessionId,
        content,
        model: '',
        createdAt: Date.now(),
        role: 'system_notify',
        type: 'error_event',
        metadata: null
      }
      const viewMessages = state.sessionViews[sessionId]?.messages ?? NO_MESSAGES
      const row: LocalErrorRow = {
        afterId: viewMessages.length > 0 ? viewMessages[viewMessages.length - 1].id : null,
        message
      }
      const sessionLocalErrors = {
        ...state.sessionLocalErrors,
        [sessionId]: [...(state.sessionLocalErrors[sessionId] ?? []), row]
      }
      return {
        sessionLocalErrors,
        messages: displayMessages(
          { sessionViews: state.sessionViews, sessionLocalErrors },
          sessionId
        )
      }
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
  touchSessionActive: (id) =>
    set((state) => {
      const now = Date.now()
      const sessions = state.sessions.map((s) => (s.id === id ? { ...s, lastActiveAt: now } : s))
      sessions.sort((a, b) => (b.lastActiveAt || b.updatedAt) - (a.lastActiveAt || a.updatedAt))
      return { sessions }
    }),
  removeSession: (id) =>
    set((state) => ({
      sessions: state.sessions.filter((s) => s.id !== id),
      // 删除的是当前激活会话才清空 active
      ...(state.active?.type === 'session' && state.active.id === id
        ? { ...deriveActive(null), messages: NO_MESSAGES }
        : {})
    })),
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

  setThreadOpen: (sessionId, open) =>
    set((state) =>
      state.sessionThreadOpen[sessionId] === open
        ? {}
        : { sessionThreadOpen: { ...state.sessionThreadOpen, [sessionId]: open } }
    ),

  setToolReviewing: (sessionId, toolCallId, reviewing) =>
    set((state) => {
      const current = state.sessionToolReviewing[sessionId]
      if (!!current?.[toolCallId] === reviewing) return {}
      let overlay: Record<string, true> | undefined
      if (reviewing) overlay = { ...current, [toolCallId]: true }
      else {
        overlay = { ...current }
        delete overlay[toolCallId]
        if (Object.keys(overlay).length === 0) overlay = undefined
      }
      const sessionToolReviewing = withKey(state.sessionToolReviewing, sessionId, overlay)
      const view = state.sessionViews[sessionId]
      if (!view) return { sessionToolReviewing }
      const tools = deriveToolExecutions(view, overlay, state.sessionToolExecutions[sessionId])
      return {
        sessionToolReviewing,
        sessionToolExecutions: withKey(
          state.sessionToolExecutions,
          sessionId,
          tools === EMPTY_TOOLS ? undefined : tools
        )
      }
    })
}))

// ─────────────────────────── 唯一的写入口 ───────────────────────────

/** 一轮运行以一张新的终答收尾（PIN-03：TTS 从这里起，不再读 `agent_end` 的载荷） */
export type RunSettledListener = (sessionId: string, finalAnswer: AssistantMessage) => void
const runSettledListeners = new Set<RunSettledListener>()

/** 订阅「一轮以新终答收尾」（视图从在跑转为不在跑、且出现了一条这一轮之前没有的终答）；返回退订 */
export function onSessionRunSettled(listener: RunSettledListener): () => void {
  runSettledListeners.add(listener)
  return () => {
    runSettledListeners.delete(listener)
  }
}

/** 一轮的收尾检测：在跑时记下开跑那一刻的消息；不在跑且出现新消息时判一次 */
function detectRunSettled(
  sessionId: string,
  prev: SessionView | undefined,
  next: SessionView
): AssistantMessage | undefined {
  if (next.run.state === 'busy') {
    // 新一轮（上一帧不在跑）：重记基线
    if (!runBaselines.has(sessionId) || prev?.run.state !== 'busy') {
      runBaselines.set(sessionId, idsOf(prev?.messages ?? next.messages))
    }
    return undefined
  }
  const baseline = runBaselines.get(sessionId)
  if (baseline === undefined) return undefined
  const fresh = next.messages.filter((m) => !baseline.has(m.id))
  // 运行已停、终答还没到（两路先后不定）：留着基线等它
  if (fresh.length === 0) return undefined
  runBaselines.delete(sessionId)
  const last = next.messages[next.messages.length - 1]
  return isFinalAssistant(last) && !baseline.has(last.id) ? last : undefined
}

/**
 * 把一份视图镜像进 store —— 会话切片的**唯一写入口**（P3-08）。`view === null` = 视图不可用（会话被删，
 * PIN-14）：派生切片回到空视图的值，本地叠加保留。
 *
 * 一次调用至多一次 `set`：视图先与上一份做结构共享（整份相等 → 什么都不写），再推导流式状态、工具执行、
 * 询问、队列，当前会话的消息与上下文占用；乐观占位若遇到一条发送时还没有的用户消息，在同一次更新里撤下。
 */
export function applySessionView(sessionId: string, view: SessionView | null): void {
  const incoming = view ?? emptySessionView(sessionId)
  let settled: AssistantMessage | undefined
  useChatStore.setState((state) => {
    const prevView = state.sessionViews[sessionId]
    const shared = shareStructure(prevView, incoming)
    if (shared === prevView) return state
    const patch: Partial<ChatState> = {
      sessionViews: { ...state.sessionViews, [sessionId]: shared }
    }

    // 乐观占位：视图里出现发送那一刻还没有的用户消息 → 同一次更新撤下（PIN-17）
    let pending = !!state.sessionPendingPrompt[sessionId]
    if (pending) {
      const baseline = pendingBaselines.get(sessionId) ?? new Set<string>()
      if (firstNewUserMessage(shared.messages, baseline) !== undefined) {
        pending = false
        pendingBaselines.delete(sessionId)
        patch.sessionPendingPrompt = withKey(state.sessionPendingPrompt, sessionId, undefined)
      }
    }

    // 流式状态
    const prevStream = state.sessionStreams[sessionId]
    const stream = deriveStream(shared, pending, prevStream)
    if (stream !== prevStream)
      patch.sessionStreams = { ...state.sessionStreams, [sessionId]: stream }

    // 审查叠加：工具做完 / 本轮结束即清（PIN-04）
    let overlay: Record<string, true> | undefined = state.sessionToolReviewing[sessionId]
    if (overlay) {
      const runEnded = prevView?.run.state === 'busy' && shared.run.state !== 'busy'
      const kept: Record<string, true> | undefined = runEnded
        ? undefined
        : Object.fromEntries(
            Object.keys(overlay)
              .filter((id) => shared.toolRuns[id]?.status !== 'done')
              .map((id) => [id, true as const])
          )
      const next = kept && Object.keys(kept).length > 0 ? kept : undefined
      if (next === undefined || Object.keys(next).length !== Object.keys(overlay).length) {
        overlay = next
        patch.sessionToolReviewing = withKey(state.sessionToolReviewing, sessionId, overlay)
      }
    }

    // 工具执行
    const tools = deriveToolExecutions(shared, overlay, state.sessionToolExecutions[sessionId])
    const nextTools = withKey(
      state.sessionToolExecutions,
      sessionId,
      tools === EMPTY_TOOLS ? undefined : tools
    )
    if (nextTools !== state.sessionToolExecutions) patch.sessionToolExecutions = nextTools

    // 询问：视图里没了的那几条，草稿与步进器选中项一并清掉
    const asks = shared.asks.length > 0 ? shared.asks : undefined
    const nextInputs = withKey(state.sessionPendingInputs, sessionId, asks)
    if (nextInputs !== state.sessionPendingInputs) {
      patch.sessionPendingInputs = nextInputs
      const live = new Set(shared.asks.map((r) => r.id))
      const drafts = state.sessionInputDrafts[sessionId]
      if (drafts && Object.keys(drafts).some((id) => !live.has(id))) {
        const kept = Object.fromEntries(Object.entries(drafts).filter(([id]) => live.has(id)))
        patch.sessionInputDrafts = withKey(
          state.sessionInputDrafts,
          sessionId,
          Object.keys(kept).length > 0 ? kept : undefined
        )
      }
      const selected = state.sessionActiveInputId[sessionId]
      if (selected !== undefined && !live.has(selected)) {
        patch.sessionActiveInputId = withKey(state.sessionActiveInputId, sessionId, undefined)
      }
    }

    // 当前会话：消息列表与上下文占用
    if (sessionId === state.activeSessionId) {
      const messages = displayMessages(state, sessionId, shared.messages)
      if (messages !== state.messages) patch.messages = messages
      if (shared.context.usedTokens !== state.usedContextTokens) {
        patch.usedContextTokens = shared.context.usedTokens
      }
    }

    settled = detectRunSettled(sessionId, prevView, shared)
    return patch
  })
  if (settled !== undefined) {
    for (const listener of [...runSettledListeners]) {
      try {
        listener(sessionId, settled)
      } catch {
        /* 一个监听器出错不影响其它 */
      }
    }
  }
}

/**
 * 退订之后：丢掉这个会话的视图与由它派生的工具 / 询问 / 队列切片（之后由余项接手：运行标记、询问计数）。
 * 流式状态只留运行标记（侧栏转圈接着对），草稿与乐观占位保留。
 */
export function releaseSessionView(sessionId: string): void {
  const view = useChatStore.getState().sessionViews[sessionId]
  if (view === undefined) return
  if (view.run.state === 'busy') residueRunning.add(sessionId)
  else residueRunning.delete(sessionId)
  runBaselines.delete(sessionId)
  useChatStore.setState((state) => {
    const prevStream = state.sessionStreams[sessionId]
    const stream = residueStream(sessionId, !!state.sessionPendingPrompt[sessionId], undefined)
    return {
      sessionViews: withKey(state.sessionViews, sessionId, undefined),
      sessionToolExecutions: withKey(state.sessionToolExecutions, sessionId, undefined),
      sessionPendingInputs: withKey(state.sessionPendingInputs, sessionId, undefined),
      sessionStreams: withKey(
        state.sessionStreams,
        sessionId,
        prevStream && prevStream.isStreaming === stream.isStreaming && !prevStream.content
          ? prevStream
          : stream
      )
    }
  })
}

/** 仅供单测：清掉写入口的模块状态（store 本身由各测试自己 setState） */
export function resetSessionViewStateForTests(): void {
  pendingBaselines.clear()
  dismissedRows.clear()
  residueRunning.clear()
  runBaselines.clear()
  runSettledListeners.clear()
}
