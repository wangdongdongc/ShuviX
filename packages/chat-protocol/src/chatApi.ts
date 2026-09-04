/**
 * ChatApi —— 可复用聊天前端与后端之间的唯一接口契约（宿主无关）。
 *
 * 这是前↔后端协议的单一来源，与 events.ts(ChatEvent) / types/chatMessage.ts(ChatMessage)
 * 并列。任何宿主（Electron preload 的 window.api、Chrome 扩展的
 * 进程内 adapter）都实现本接口即可驱动 chat-ui。
 *
 * 这里的数据形状（Session / Project / *Params …）是「前端 IPC 视图」，与 main/dao 的
 * DB 行类型平行；Electron 侧通过编译期断言（renderer/src/host/chatApiContract.ts）保证
 * window.api 结构满足本契约，从而零漂移。
 */
import type { LucideIconName, ThemeColor } from './theme'
import type { AppEvent } from './appEvents'
import type { ShuvixMdValidation } from './shuvixMdContract'
import type { FileReadResult } from './types/filePreview'
import type { ChatMessage } from './types/chatMessage'
import type { BgTaskInfo, BgTaskLogChunk } from './types/bgTask'
import type {
  ProviderInfo,
  ProviderModelInfo,
  AvailableModel,
  ApiProtocol,
  ModelCapabilities
} from './types/provider'
import type { ThinkingLevel } from './types/thinking'
import type {
  McpServerInfo,
  McpServerAddParams,
  McpServerUpdateParams,
  McpToolInfo
} from './types/mcp'
import type { InputResponse } from './types/inputRequest'
import type { InlineToken } from './types/chatMessage'
import type { ChatEvent, RuntimeStatus } from './events'
import type {
  ConfigSharePayload,
  ExportOptions,
  ExportSnapshot,
  ImportPlan,
  ImportResult,
  ImportSelection
} from './types/configShare'

// ─────────────────────────── 前端 IPC 视图数据形状 ───────────────────────────

export interface SessionModelMetadata {
  thinkingLevel?: string
  enabledTools?: string[]
}

export interface SessionSettings {
  autoAllow?: boolean
  allowList?: string[]
  /**
   * 聊天会话的成员 bot 名单（`~/.shuvix/bots/<name>.md`）。**非空即为聊天会话**：
   * 它没有根 Agent —— 用户消息由成员各自的管线应答，`resolveAgentProfileName` 因此返回 null。
   * 判定一律用 `bots?.length`：settings 的 JSON patch 没有删键路径，「移除全部成员」只能
   * 写 `[]`，而空数组是 truthy。
   */
  bots?: string[]

  /**
   * 会话根 Agent 采用的档案名（`~/.shuvix/agents/<name>.md` 或内置档案）。
   * 缺省 / 档案已不存在 → 回落 'default'。经 `/<agentName>` 斜杠命令切换，粘性生效：
   * 系统提示词与内置工具白名单随之更换（会话历史不受影响，切换即重建运行时）。
   */
  agentProfile?: string
  /** 笔记本会话绑定的 md 文件（相对项目根，forward-slash；项目记忆为绝对路径）；非空即为笔记本会话（根 Agent 钉死 notebook 基座档案，对话经输入卡片的抽屉呈现） */
  notebookPath?: string
  /**
   * 项目记忆笔记本：该会话绑定的是 `~/.shuvix/memory/<projectId>/<slug>.md`。
   * 侧栏据此把它归入项目组下的「项目记忆」子文件夹，而不是并排混进会话列表
   * （同一条记忆在同一处出现两次，比少一处入口更糟）。
   */
  memorySlug?: string
  /** 标题最近一次由谁写入：'user' = UI 重命名，'auto' = 自动化（session 工具）。缺省视同 'user' */
  titleOrigin?: 'user' | 'auto'
  /**
   * 聊天会话的未读 bot 回复数（A4）。bot 落树 +1（settings 写顺带 touch updatedAt，
   * 列表按它排序 —— 上浮与未读同一笔账）；`session.markRead` 清零。仅聊天会话在维护，
   * 有根会话恒缺省。
   */
  unreadCount?: number
  /**
   * **聊天会话专属**的运行配置（v2）：它没有根 Agent，也没有会话树，所以模型/思考深度
   * 存在这里，而不是像有根会话那样表达为树上的 model_change entry。两种形态互斥不相交。
   * 不含 enabledTools —— 工具来自 bot 各槽位里那份 agent md，会话层没有可勾的东西。
   */
  chatRunConfig?: {
    provider: string
    model: string
    thinkingLevel?: string
  }
}

/**
 * 会话业务记录。
 *
 * 刻意**不含** provider / model / thinkingLevel / enabledTools / systemPrompt ——
 * 这些是「运行配置」，唯一事实源是会话树（JSONL 的 model_change /
 * thinking_level_change / active_tools_change entry）。想读当前值走 `agent.init`，
 * 想改走 `agent.setModel` / `setThinkingLevel` / `setEnabledTools`。
 */
export interface Session {
  id: string
  title: string
  projectId: string | null
  /**
   * 父会话 ID（null = 顶层会话）。非空即子会话 —— 除了侧栏渲染在父会话下面之外，
   * 与顶层会话完全一致（见 docs/sub-session-design.md）。
   */
  parentId: string | null
  settings: SessionSettings
  createdAt: number
  updatedAt: number
}

export interface SessionInfo extends Session {
  workingDirectory?: string | null
  enabledTools?: string[]
}

export interface ProjectEnvVar {
  key: string
  value: string
  sensitive: boolean
}

export interface ToolSettings {
  envVars?: ProjectEnvVar[]
}

export interface ProjectSettings {
  enabledTools?: string[]
  tool?: ToolSettings
}

export interface Project {
  id: string
  name: string
  path: string
  /** 项目提示词（纯文本；经 shuvix-project-awareness 开关注入会话上下文） */
  systemPrompt: string
  settings: ProjectSettings
  archivedAt: number
  createdAt: number
  updatedAt: number
}

/** 配置项元数据（设置 key / 项目字段共用） */
export interface ConfigMeta {
  labelKey: string
  desc: string
}

/**
 * 可切换的会话档案（输入框档案选择器的列表项）——只带选择器要显示的字段。
 *
 * 刻意不复用桌面 preload 的 SubAgentInfo：那个带 systemPrompt 全文，内置档案每个都是
 * 一整页提示词，打开一次选择器要把六七页文本拷进渲染进程；选择器只需要这几项。
 */
export interface AgentProfileSummary {
  name: string
  displayName: string
  description: string
  source: 'builtin' | 'user'
  /** 档案声明的模型（`shuvix-model` 原样值）；选择器据此提示「选它会换模型」 */
  model?: string
}

/** 自动更新事件判别联合 */
export type UpdateEvent =
  | { type: 'checking' }
  | { type: 'up-to-date'; version: string }
  | { type: 'available'; version: string; releaseDate: string; releaseNotes?: string | null }
  | {
      type: 'downloading'
      percent: number
      bytesPerSecond: number
      transferred: number
      total: number
    }
  | { type: 'ready'; version: string }
  | { type: 'error'; message: string }

/** Telegram Bot 信息（返回给前端，不含 token） */
/** 已登记的 Telegram Bot —— 纯登记信息，无运行时状态（不轮询、不绑定会话） */
export interface TelegramBotInfo {
  id: string
  name: string
  username: string
  allowedUsers: number[]
  createdAt: number
  updatedAt: number
}

// ─────────────────────────── IPC 参数类型 ───────────────────────────

export interface AgentInitParams {
  sessionId: string
}

export interface AgentInitResult {
  success: boolean
  created: boolean
  provider: string
  model: string
  capabilities: ModelCapabilities
  modelMetadata: SessionModelMetadata
  workingDirectory: string
  enabledTools: string[]
}

/** Agent 运行时装载的单个工具（直接读自 agent.state.tools，与实际下发给 LLM 的一致） */
export interface AgentRuntimeToolInfo {
  name: string
  label: string
  /** 与发给 LLM 完全一致的工具描述 */
  description: string
  /** 参数名列表（来自参数 JSON Schema 的 properties） */
  parameters: string[]
}

/**
 * Agent 运行时信息快照 —— 由后端直接从**内存中的 Agent 对象**（agent.state）读取，
 * 保证与实际请求 LLM 时使用的 systemPrompt / 工具集 / 模型零漂移。
 * Agent 懒创建（首次发送消息时），未创建时 getInfo 返回 null（除非传 ensure）。
 */
export interface AgentRuntimeInfo {
  systemPrompt: string
  model: {
    provider: string
    id: string
    name: string
    api: string
    contextWindow: number
    maxTokens: number
    reasoning: boolean
    input: string[]
  }
  thinkingLevel: ThinkingLevel
  tools: AgentRuntimeToolInfo[]
  /** Agent 内存上下文中的消息条数 */
  messageCount: number
  isStreaming: boolean
}

export interface ImageContentParam {
  type: 'image'
  data: string
  mimeType: string
}

export interface AgentPromptParams {
  sessionId: string
  text: string
  images?: ImageContentParam[]
  inlineTokens?: Record<string, InlineToken>
}

/** 继续与已存在子代理对话：向其追加一轮用户消息（复用该子会话的 Agent 与历史） */
export interface AgentSubAgentPromptParams {
  subSessionId: string
  /** 含内联 Token 标记的展示文本（slash 命令展开为 {{shuvixInlineToken:uid}} 标记 + 参数） */
  text: string
  /** 前端展开的内联 Token（slash 命令等）；后端据此解析发给 Agent 的真实文本并回填消息 metadata */
  inlineTokens?: Record<string, InlineToken>
}

export interface AgentSteerParams {
  sessionId: string
  text: string
}

/**
 * 追加 / 下轮入队参数 —— 与 steer 同形（一条纯文本用户消息）。
 * 三者的差别只在 pi 把它插进 agent loop 的时机，消息本身完全一致。
 */
export type AgentFollowUpParams = AgentSteerParams
export type AgentNextTurnParams = AgentSteerParams

export interface AgentSetModelParams {
  sessionId: string
  provider: string
  model: string
  baseUrl?: string
  apiProtocol?: string
}

export interface AgentSetThinkingLevelParams {
  sessionId: string
  level: ThinkingLevel
}

export interface ProviderUpdateConfigParams {
  id: string
  name?: string
  apiKey?: string
  baseUrl?: string
  apiProtocol?: ApiProtocol
  metadata?: string
}

export interface ProviderToggleEnabledParams {
  id: string
  isEnabled: boolean
}

export interface ProviderToggleModelEnabledParams {
  id: string
  isEnabled: boolean
}

export interface ProviderSyncModelsParams {
  providerId: string
}

export interface ProviderAddParams {
  name: string
  baseUrl: string
  apiKey: string
  apiProtocol: ApiProtocol
  metadata?: string
}

export interface ProviderDeleteParams {
  id: string
}

export interface ProviderAddModelParams {
  providerId: string
  modelId: string
}

export interface ProviderUpdateModelCapabilitiesParams {
  id: string
  capabilities: ModelCapabilities
}

export interface ProjectCreateParams {
  name?: string
  path: string
  systemPrompt?: string
  enabledTools?: string[]
  tool?: ToolSettings
  archived?: boolean
}

export interface ProjectUpdateParams {
  id: string
  name?: string
  path?: string
  systemPrompt?: string
  enabledTools?: string[]
  tool?: ToolSettings
  archived?: boolean
}

export interface ProjectDeleteParams {
  id: string
}

export interface SessionCreateParams {
  /** 所属项目 ID（null/缺省 = 临时会话） */
  projectId?: string | null
  /**
   * 父会话 ID —— 提供则创建子会话（projectId 恒随父会话，传了也以父会话为准）。
   * 仅 `session` 工具使用；UI 的新建入口不传。
   */
  parentId?: string
  /** 绑定的 md 文件（相对项目根）；提供则创建笔记本会话 */
  notebookPath?: string
  /** 会话标题；缺省时聊天会话用默认标题、笔记本会话用文件 basename */
  title?: string
  /** 成员 bot 名单；非空则创建聊天会话（无根会话，见 SessionSettings.bots） */
  bots?: string[]
}

export interface SessionUpdateTitleParams {
  id: string
  title: string
}

export interface SessionUpdateProjectParams {
  id: string
  projectId: string | null
}

export interface SessionUpdateAutoAllowParams {
  id: string
  autoAllow: boolean
}

export interface SessionAllowListRemoveParams {
  id: string
  entry: string
}

export interface SettingsSetParams {
  key: string
  value: string
}

export interface TelegramBotAddParams {
  token: string
}

export interface TelegramBotUpdateParams {
  id: string
  name?: string
  token?: string
  allowedUsers?: number[]
}

export interface ToolInfo {
  name: string
  label: string
  hint?: string
  group?: string
  defaultEnabled?: boolean
  serverStatus?: 'connected' | 'disconnected' | 'connecting' | 'error'
  isEnabled?: boolean
}

export interface ToolPresentation {
  icon?: LucideIconName
  iconColor?: ThemeColor
  formItems?: Array<{
    field: string
    label?: string
    renderer?:
      | { type: 'code'; language?: string; wrap?: boolean; lineNumbers?: boolean }
      | { type: 'text' }
  }>
  showUndeclaredFields?: boolean
}

export interface SlashCommandInfo {
  commandId: string
  name: string
  description: string
  template: string
  filePath: string
  /** 依赖的工具名（选中命令时自动启用这些工具） */
  requiredTools?: string[]
  /** 命令来源（'project' = .claude/commands/，'skill' = SKILL.md） */
  kind?: 'project' | 'skill'
}

/**
 * 单个内置工具的「发给 LLM」定义 —— name + description + 参数 schema，与 agent 实际下发给模型的一致。
 * 供「LLM 工具」设置页只读展示工具机制（各端共享，数据由各宿主后端按自身运行时枚举）。
 * 不含 MCP 工具（另由 mcp 契约提供）。
 */
export interface BuiltinToolDefinition {
  name: string
  label: string
  group: string
  /** 折叠图标名（lucide），来自工具 presentation */
  icon?: string
  iconColor?: string
  /** 与发给 LLM 完全一致的工具描述 */
  description: string
  /** 与发给 LLM 完全一致的参数 schema（JSON Schema / TypeBox 序列化后） */
  parameters: {
    type?: string
    properties?: Record<string, Record<string, unknown>>
    required?: string[]
  }
}

// ─────────────────────────── 契约分层 ───────────────────────────
//
// 三层正交契约（见 docs / 设计讨论）：
//
//   SessionChannelApi  ── 「把单个会话同步给某个渠道」所需的最小操作集：看 + 发。
//                         每个端（桌面 / Telegram / 扩展）都实现。纯会话维度，
//                         全部只读或发消息，**不含任何改配置 / 管理类能力**。
//   HostApi            ── 应用级管理能力（provider / project / settings / mcp / pinChat /
//                         update / config，以及所有会改持久状态的方法）。
//                         仅完整宿主（桌面）实现；渠道端取不到 → 相关 UI 自动隐藏。
//   ChannelBindingApi  ── 宿主侧「把会话绑到哪些渠道」（见 ./channelBindingApi.ts）。桌面专属。
//
//   ChatApi = SessionChannelApi & HostApi —— 完整宿主对外暴露的全集（形状与历史一致）。
//
// 渠道端只需实现 SessionChannelApi；chat-ui 对话核心仅依赖它，宿主功能经 getHostApi() 降级。

/**
 * 单会话渠道契约 —— 渲染并驱动**一个**会话所需的最小后端能力（只读 + 发消息）。
 * 注意：这里**没有**任何 setModel / 改配置 / 新建删除会话 / 应用设置 —— 渠道端无权这些。
 */
export interface SessionChannelApi {
  app: {
    platform: 'darwin' | 'win32' | 'linux' | 'web'
    /** 用系统默认浏览器打开外部链接 */
    openExternal: (url: string) => Promise<{ success: boolean }>
  }
  agent: {
    init: (params: AgentInitParams) => Promise<AgentInitResult>
    prompt: (params: AgentPromptParams) => Promise<{ success: boolean }>
    /** 继续与已存在子代理对话：追加一轮用户消息（fire-and-forget，进展走事件流） */
    subAgentPrompt: (params: AgentSubAgentPromptParams) => Promise<{ success: boolean }>
    /** 销毁子会话：中止其 Agent 循环并从注册表移除（面板里彻底消失）。子代理基础能力，各端必须实现。 */
    subSessionDestroy: (subSessionId: string) => Promise<{ success: boolean }>
    /** 中断子会话：软停止当前生成、保留已产出，子会话以「已完成」收尾。子代理基础能力，各端必须实现。 */
    subSessionInterrupt: (subSessionId: string) => Promise<{ success: boolean }>
    steer: (params: AgentSteerParams) => Promise<{ success: boolean }>
    /** 本轮本应结束时续跑同一次运行（pi followUp 队列） */
    followUp: (params: AgentFollowUpParams) => Promise<{ success: boolean }>
    /** 排队到下一次 prompt 之前（pi nextTurn 队列；不被 abort 清空） */
    nextTurn: (params: AgentNextTurnParams) => Promise<{ success: boolean }>
    abort: (sessionId: string) => Promise<{ success: boolean }>
    /**
     * per-bot 停止（聊天会话，A2）：中止某成员对**某条消息**的应答；该成员的排队与
     * 其它消息不受影响。可选 —— 渠道端缺省即不渲染停止钮。
     */
    abortBot?: (params: {
      sessionId: string
      botName: string
      messageId: string
    }) => Promise<{ aborted: boolean }>
    respondToInput: (params: {
      sessionId: string
      requestId: string
      response: InputResponse
    }) => Promise<{ success: boolean }>
    onEvent: (callback: (event: ChatEvent) => void) => () => void
  }
  session: {
    /** 只读单个会话（含计算属性）。渠道端不得 list/create/delete/改配置 */
    getById: (id: string) => Promise<SessionInfo | null>
  }
  message: {
    list: (sessionId: string) => Promise<ChatMessage[]>
  }
  runtime: {
    statuses: (sessionId: string) => Promise<Record<string, RuntimeStatus>>
  }
  /**
   * 后台任务（bash run_in_background）只读面。输出**不经事件总线** —— 子进程的
   * stdout/stderr 由 OS 直接写日志文件，前端要实时输出就按字节范围轮询 readLog；
   * 任务状态变更走 `bg_task` ChatEvent。见 docs/background-tasks-design.md。
   */
  bgTask: {
    /** 会话内全部任务（含已结束）—— 挂载 / 切会话时补快照，之后靠事件增量维护 */
    list: (params: { sessionId: string }) => Promise<BgTaskInfo[]>
    /** 按字节范围读日志；fromByte 省略 = 取尾部窗口 */
    readLog: (params: {
      toolCallId: string
      fromByte?: number
      maxBytes?: number
    }) => Promise<BgTaskLogChunk>
  }
  tools: {
    list: (sessionId?: string) => Promise<ToolInfo[]>
    presentations: () => Promise<Record<string, ToolPresentation>>
    /** 所有内置工具的完整定义（name/description/参数），供设置页只读展示工具机制 */
    definitions: () => Promise<BuiltinToolDefinition[]>
  }
  command: {
    list: (params: { sessionId: string | null }) => Promise<SlashCommandInfo[]>
  }
  /** 工作目录文件浏览（只读）：扫描 + 预览读取 + 单文件内容监听。回写属 HostApi。 */
  files: {
    scan: (params: { sessionId: string }) => Promise<{
      paths: string[]
      truncated: boolean
      root: string | null
    }>
    read: (params: { sessionId: string; path: string }) => Promise<FileReadResult>
    /** 监听某个已打开文件的内容变更（笔记本 / 预览自动刷新）；变更经 events.subscribe 广播。
     *  仅监听「当前打开的文件」，不监听整个工作目录。无文件系统的渠道端可 no-op。 */
    watch: (params: { sessionId: string; path: string }) => Promise<void>
    unwatch: (params: { sessionId: string; path: string }) => Promise<void>
  }
  /** shuvix 契约 md 的解析器级校验（frontmatter 属性卡消费；两端实现共用 agent-runtime） */
  shuvixMd: {
    validate: (params: { type: string; text: string; name?: string }) => Promise<ShuvixMdValidation>
  }
  /** 通用内部事件订阅（后端发布的会话级/全局状态事件）。见 docs/internal-events.md */
  events: {
    subscribe: (callback: (event: AppEvent) => void) => () => void
  }
  /** 语音转文字 */
  stt: {
    transcribe: (params: {
      audioData: string
      pcmf32?: string
      language?: string
    }) => Promise<{ text: string }>
  }
  /** 文字转语音 */
  tts: {
    speakOnce: (params: { text: string }) => Promise<void>
    abortTts: () => Promise<void>
    onChunk: (callback: (data: { filePath: string; index: number }) => void) => () => void
  }
}

/**
 * 宿主应用级能力 —— 仅完整宿主（桌面）实现。
 * 含应用管理（provider/project/settings/mcp/pinChat/update/config）
 * 以及一切会改持久状态的方法（会话配置 setter、消息写操作、文件回写、模型切换等）。
 * 渠道端取不到（getHostApi() 返回 null），对应 UI 自动隐藏。
 */
export interface HostApi {
  app: {
    openSettings: (tab?: string) => Promise<{ success: boolean }>
    openFolder: (folderPath: string) => Promise<{ success: boolean }>
    /** 在系统文件管理器中定位并选中该文件（不同于 openFolder：会高亮文件本身） */
    revealPath: (filePath: string) => Promise<{ success: boolean }>
    adjustWindowWidth: (delta: number) => Promise<void>
    setBrowserOffset: (offset: number) => Promise<void>
    windowReady: () => void
    onNewChat: (callback: () => void) => () => void
    onNewProject: (callback: () => void) => () => void
  }
  agent: {
    setModel: (params: AgentSetModelParams) => Promise<{ success: boolean }>
    setThinkingLevel: (params: AgentSetThinkingLevelParams) => Promise<{ success: boolean }>
    setEnabledTools: (params: { sessionId: string; tools: string[] }) => Promise<{
      success: boolean
    }>
    /**
     * 读取运行时 Agent 对象的实时信息（systemPrompt/工具/模型）；Agent 未创建返回 null。
     * `ensure: true` 时先按会话配置懒创建 Agent 再取快照 —— 给「没发过消息也要看到 Agent
     * 真实配置」的调用方（如 e2e 的「建 Agent 而不触发 LLM」）用；创建本身不请求 LLM，
     * 会话不存在/创建失败仍返回 null。
     */
    getInfo: (sessionId: string, options?: { ensure?: boolean }) => Promise<AgentRuntimeInfo | null>
  }
  provider: {
    listAll: () => Promise<ProviderInfo[]>
    listEnabled: () => Promise<ProviderInfo[]>
    getById: (id: string) => Promise<ProviderInfo | undefined>
    updateConfig: (params: ProviderUpdateConfigParams) => Promise<{ success: boolean }>
    toggleEnabled: (params: ProviderToggleEnabledParams) => Promise<{ success: boolean }>
    listModels: (providerId: string) => Promise<ProviderModelInfo[]>
    listAvailableModels: () => Promise<AvailableModel[]>
    toggleModelEnabled: (params: ProviderToggleModelEnabledParams) => Promise<{ success: boolean }>
    syncModels: (
      params: ProviderSyncModelsParams
    ) => Promise<{ providerId: string; total: number; added: number }>
    add: (params: ProviderAddParams) => Promise<ProviderInfo>
    delete: (params: ProviderDeleteParams) => Promise<{ success: boolean }>
    addModel: (params: ProviderAddModelParams) => Promise<{ success: boolean }>
    deleteModel: (id: string) => Promise<{ success: boolean }>
    updateModelCapabilities: (
      params: ProviderUpdateModelCapabilitiesParams
    ) => Promise<{ success: boolean }>
  }
  project: {
    list: () => Promise<Project[]>
    listArchived: () => Promise<Project[]>
    getById: (id: string) => Promise<Project | null>
    create: (params: ProjectCreateParams) => Promise<Project>
    update: (params: ProjectUpdateParams) => Promise<{ success: boolean }>
    delete: (params: ProjectDeleteParams) => Promise<{ success: boolean }>
    getKnownFields: () => Promise<Record<string, ConfigMeta>>
  }
  session: {
    list: () => Promise<Session[]>
    create: (params?: SessionCreateParams) => Promise<Session>
    updateTitle: (params: SessionUpdateTitleParams) => Promise<{ success: boolean }>
    updateProject: (params: SessionUpdateProjectParams) => Promise<{ success: boolean }>
    updateAutoAllow: (params: SessionUpdateAutoAllowParams) => Promise<{ success: boolean }>
    /** 移除允许列表条目（仅路径条目：命令类工具无允许列表，逐条询问） */
    removeAllowListEntry: (params: SessionAllowListRemoveParams) => Promise<{ success: boolean }>
    delete: (id: string) => Promise<{ success: boolean }>
    /** 可切换的会话档案（含切回基座用的 default，不含 notebook）。纯文件系统驱动，每次现扫 */
    listAgentProfiles: () => Promise<AgentProfileSummary[]>
    /**
     * 切换会话根 Agent 的档案。粘性生效：写入 settings.agentProfile 并失效当前运行时，
     * 下一条消息按新档案的系统提示词 + 内置工具白名单重建（会话历史/会话树不变）。
     * 未知档案名返回 `success: false` + error。
     *
     * 切换同时把档案声明的运行配置作为**种子**写进会话树（与手动改模型/工具同一路径），
     * 经 `applied` 回传供调用方就地更新选择器：
     *  - `model`：`shuvix-model` 解析成功时的模型；未声明则缺省（会话模型不变），
     *    声明了但不可用时另经 `modelUnavailable` 回传原始值供前端提示；
     *  - `tools`：`shuvix-tools` 里的 mcp:/skill: 条目，**替换**（不是叠加）会话勾选 ——
     *    档案对三类工具是完整声明，切过去就是它说的那套，之后用户可在工具选择器里增删。
     *
     * 种子只在切换这一刻应用：之后模型/工具以会话树为准，档案不会在重建时再次覆盖。
     */
    updateAgentProfile: (params: { id: string; name: string }) => Promise<{
      success: boolean
      error?: string
      applied?: {
        model?: { provider: string; model: string; capabilities: ModelCapabilities }
        /** 切换后的会话工具勾选（可能是空数组 = 档案没声明任何 mcp:/skill:） */
        tools: string[]
      }
      /** 档案声明了模型但当前不可用（提供商停用 / 模型已删）时回传原始值 */
      modelUnavailable?: string
    }>
    /**
     * 改聊天会话的成员名单。
     *
     * **只对聊天会话生效，且名单不得为空** —— 「有没有 bots」决定的是会话形态
     * （无根 / 有根），把它清空等于中途换一种会话，那不是「管理成员」这个动作该做的事。
     *
     * 名单里的名字**不校验是否存在**（与 create 同口径）：bot md 是纯 md 驱动的，
     * 用户随时可能删掉一个。缺失成员由后续里程碑的降级表处理（L0 剔除、会话头部标灰），
     * 历史消息靠署名侧车自带的 displayName 永不裂。这个接口本身就是名单写坏之后的逃生口。
     *
     * 新加入的成员会补一条开场白落树（只对**新增**的成员，不重播老成员的）。
     */
    updateBots: (params: { id: string; bots: string[] }) => Promise<{
      success: boolean
      error?: string
      /** 实际落库的名单 */
      bots?: string[]
      /** 本次新加入、并因此落了开场白的成员 */
      added?: string[]
    }>
    /**
     * 清零聊天会话的未读计数（A4）。可选 —— 渠道端缺省即不维护未读。
     * 幂等：已为 0 时不写库不广播。
     */
    markRead?: (id: string) => Promise<{ success: boolean }>
    // 注：updateModelConfig / updateThinkingLevel / updateEnabledTools 已移除 ——
    // 运行配置的唯一事实源是会话树，改动统一走 agent.setModel / setThinkingLevel /
    // setEnabledTools（Agent 未创建时后端直接往树上追加对应 entry）。
  }
  /**
   * 消息写入口已全部移除（AgentHarness 迁移）：消息只能由 harness 在运行中产生并
   * 落成 entry，外部不再能凭空 add / 删单条。剩下的两个都是**结构性**操作：
   *  - clear    清空整棵 entry 树
   *  - rollback 把会话树的 leaf 移到目标消息的父节点（原 deleteFrom 与之语义重合，已并入）
   */
  message: {
    clear: (sessionId: string) => Promise<{ success: boolean }>
    rollback: (params: { sessionId: string; messageId: string }) => Promise<{ success: boolean }>
  }
  settings: {
    getAll: () => Promise<Record<string, string>>
    get: (key: string) => Promise<string | undefined>
    set: (params: SettingsSetParams) => Promise<{ success: boolean }>
    getKnownKeys: () => Promise<Record<string, ConfigMeta>>
  }
  /** 配置分享：Provider + MCP 配置导出/导入为可粘贴串 */
  config: {
    buildExportSnapshot: () => Promise<ExportSnapshot>
    buildExportPayload: (options: ExportOptions) => Promise<string>
    parseImportPayload: (encoded: string) => Promise<ConfigSharePayload>
    planImport: (payload: ConfigSharePayload) => Promise<ImportPlan>
    applyImport: (params: {
      payload: ConfigSharePayload
      selection: ImportSelection
    }) => Promise<ImportResult>
  }
  runtime: {
    destroy: (params: { sessionId: string; runtimeId: string }) => Promise<{ success: boolean }>
  }
  /** 后台任务的管理动作（渠道端无权）。注意 write 是**用户**往 stdin 写 —— 智能体没有这条通道 */
  bgTask: {
    /** 停止：先 SIGINT，3 秒未退升级 SIGKILL；force 直接 SIGKILL */
    stop: (params: { toolCallId: string; force?: boolean }) => Promise<{ success: boolean }>
    /**
     * 用户往任务 stdin 写入（干涉）。**故意不开给智能体** —— 那等于让它往一个已被
     * ask-on-command 批准的 shell 里再喂任意命令，绕过整道门。见设计文档 §7。
     */
    write: (params: { toolCallId: string; data: string }) => Promise<{ success: boolean }>
    /** 移除一条已结束的任务（连同日志文件）；运行中的不移除 */
    dismiss: (params: { toolCallId: string }) => Promise<{ success: boolean }>
    /** 清空会话内所有已结束的任务 */
    clearDone: (params: { sessionId: string }) => Promise<{ cleared: number }>
    /** 「完成时通知 AI」开关 */
    setNotify: (params: { toolCallId: string; enabled: boolean }) => Promise<{ success: boolean }>
  }
  /** 文件回写（属管理类，渠道端无权） */
  files: {
    write: (params: {
      sessionId: string
      path: string
      content: string
    }) => Promise<{ ok: true } | { ok: false; error: string }>
    /**
     * 二进制另存为：弹宿主的系统保存对话框（defaultPath 预填），用户确认后落盘。
     * 落点由用户在对话框里当场指定，故不走工作目录准入 —— 与 widget 导出 zip 同一模型。
     * 取不到 HostApi 的端由调用方退化为浏览器原生下载。
     */
    saveAs: (params: {
      /** 建议保存路径（绝对路径，含文件名） */
      defaultPath: string
      /** 文件内容（base64） */
      dataBase64: string
    }) => Promise<
      { ok: true; path: string } | { ok: false; canceled: true } | { ok: false; error: string }
    >
  }
  /** MCP 客户端：服务器 CRUD + 连接控制 + 工具查询 */
  mcp: {
    list: () => Promise<McpServerInfo[]>
    add: (params: McpServerAddParams) => Promise<{ success: boolean }>
    update: (params: McpServerUpdateParams) => Promise<{ success: boolean }>
    delete: (id: string) => Promise<{ success: boolean }>
    connect: (id: string) => Promise<{ success: boolean }>
    disconnect: (id: string) => Promise<{ success: boolean }>
    getTools: (id: string) => Promise<McpToolInfo[]>
  }
  pinChat: {
    pin: (sessionId: string) => Promise<{ success: boolean }>
    unpin: (sessionId: string) => Promise<{ success: boolean }>
    focus: (sessionId: string) => Promise<{ success: boolean }>
    getState: () => Promise<{ pinnedSessionIds: string[] }>
    setAlwaysOnTop: (params: {
      sessionId: string
      value: boolean
    }) => Promise<{ alwaysOnTop: boolean }>
    getAlwaysOnTop: (sessionId: string) => Promise<{ alwaysOnTop: boolean }>
  }
  update: {
    check: () => Promise<{ success: boolean }>
    download: () => Promise<{ success: boolean }>
    install: () => Promise<{ success: boolean }>
    getLastEvent: () => Promise<UpdateEvent | null>
    onEvent: (callback: (event: UpdateEvent) => void) => () => void
  }
}

/**
 * 完整宿主契约 = 单会话渠道能力 + 应用级管理能力。
 * 形状与历史 ChatApi 一致（混合命名空间如 app/agent/session/message/runtime/files
 * 由两侧交集合并），故现有消费方无感。
 */
export type ChatApi = SessionChannelApi & HostApi
