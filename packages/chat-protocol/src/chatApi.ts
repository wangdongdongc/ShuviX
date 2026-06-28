/**
 * ChatApi —— 可复用聊天前端与后端之间的唯一接口契约（宿主无关）。
 *
 * 这是前↔后端协议的单一来源，与 events.ts(ChatEvent) / types/chatMessage.ts(ChatMessage)
 * 并列。任何宿主（Electron preload 的 window.api、WebUI 的 HTTP/WS shim、Chrome 扩展的
 * 进程内 adapter）都实现本接口即可驱动 chat-ui。
 *
 * 这里的数据形状（Session / Project / *Params …）是「前端 IPC 视图」，与 main/dao 的
 * DB 行类型平行；Electron 侧通过编译期断言（renderer/src/host/chatApiContract.ts）保证
 * window.api 结构满足本契约，从而零漂移。
 */
import type { LucideIconName, ThemeColor } from './theme'
import type { AppEvent } from './appEvents'
import type { FileReadResult } from './types/filePreview'
import type { ChatMessage, ErrorEventMessage, MessageMetadata } from './types/chatMessage'
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
import type { InstructionFileEntry } from './types/instructionFile'
import type { ProjectPromptSection } from './types/promptSection'
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
  autoApprove?: boolean
  allowList?: string[]
  telegramBotId?: string
  enabledInstructionFiles?: string[]
  /** 笔记本会话绑定的 md 文件（相对项目根，forward-slash）；非空即为笔记本会话（纯预览，无对话/Agent） */
  notebookPath?: string
}

export interface Session {
  id: string
  title: string
  projectId: string | null
  provider: string
  model: string
  systemPrompt: string
  modelMetadata: SessionModelMetadata
  settings: SessionSettings
  createdAt: number
  updatedAt: number
}

export interface SessionInfo extends Session {
  workingDirectory?: string | null
  enabledTools?: string[]
}

export interface ReferenceDir {
  path: string
  note?: string
  access?: 'readonly' | 'readwrite'
}

export interface ProjectEnvVar {
  key: string
  value: string
  sensitive: boolean
}

export interface ToolSettings {
  pglitePersist?: boolean
  envVars?: ProjectEnvVar[]
}

export interface ProjectSettings {
  enabledTools?: string[]
  referenceDirs?: ReferenceDir[]
  tool?: ToolSettings
}

export interface Project {
  id: string
  name: string
  path: string
  promptSections: ProjectPromptSection[]
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

/** Web UI 共享模式 */
export type ShareMode = 'readonly' | 'chat' | 'full'

/** Telegram Bot 信息（返回给前端，不含 token） */
export interface TelegramBotInfo {
  id: string
  name: string
  username: string
  allowedUsers: number[]
  isEnabled: boolean
  running: boolean
  boundSessionId: string | null
  boundSessionTitle: string | null
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

/**
 * 笔记本会话发送：不走主会话，每次 prompt 开启一个独立子智能体；
 * 子智能体上下文注入「当前笔记本文件路径 + 如需正文先用 read 读取」（路径后端由会话配置解析）。
 */
export interface AgentNotebookPromptParams {
  sessionId: string
  text: string
  images?: ImageContentParam[]
}

/** 继续与已存在子代理对话：向其追加一轮用户消息（复用该子会话的 Agent 与历史） */
export interface AgentSubAgentPromptParams {
  subSessionId: string
  text: string
}

export interface AgentSteerParams {
  sessionId: string
  text: string
}

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
  promptSections?: ProjectPromptSection[]
  enabledTools?: string[]
  referenceDirs?: ReferenceDir[]
  tool?: ToolSettings
  archived?: boolean
}

export interface ProjectUpdateParams {
  id: string
  name?: string
  path?: string
  promptSections?: ProjectPromptSection[]
  enabledTools?: string[]
  referenceDirs?: ReferenceDir[]
  tool?: ToolSettings
  archived?: boolean
}

export interface ProjectDeleteParams {
  id: string
}

export interface SessionCreateParams {
  /** 所属项目 ID（null/缺省 = 临时会话） */
  projectId?: string | null
  /** 绑定的 md 文件（相对项目根）；提供则创建笔记本会话 */
  notebookPath?: string
  /** 会话标题；缺省时聊天会话用默认标题、笔记本会话用文件 basename */
  title?: string
}

export interface SessionUpdateTitleParams {
  id: string
  title: string
}

export interface SessionUpdateModelConfigParams {
  id: string
  provider: string
  model: string
}

export interface SessionUpdateProjectParams {
  id: string
  projectId: string | null
}

export interface SessionUpdateThinkingLevelParams {
  id: string
  thinkingLevel: string
}

export interface SessionUpdateEnabledToolsParams {
  id: string
  enabledTools: string[]
}

export interface SessionUpdateAutoApproveParams {
  id: string
  autoApprove: boolean
}

export interface SessionAllowListAddParams {
  id: string
  toolType: 'bash' | 'ssh' | 'read' | 'write'
  patterns: string[]
}

export interface SessionAllowListRemoveParams {
  id: string
  entry: string
}

export type MessageRole = 'user' | 'assistant' | 'tool' | 'system' | 'system_notify'
export type MessageType =
  | 'text'
  | 'tool_use'
  | 'step_text'
  | 'step_thinking'
  | 'steer'
  | 'error_event'

export interface MessageAddParams {
  sessionId: string
  role: MessageRole
  type?: MessageType
  content: string
  metadata?: MessageMetadata | null
  model?: string
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
  isEnabled?: boolean
}

export interface TelegramBindSessionParams {
  botId: string
  sessionId: string
}

export interface TelegramUnbindSessionParams {
  sessionId: string
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
  summaryField?: string
  formItems?: Array<{
    field: string
    label?: string
    renderer?: { type: 'code'; language?: string } | { type: 'text' }
  }>
}

export interface SlashCommandInfo {
  commandId: string
  name: string
  description: string
  template: string
  filePath: string
}

// ─────────────────────────── 契约分层 ───────────────────────────
//
// 三层正交契约（见 docs / 设计讨论）：
//
//   SessionChannelApi  ── 「把单个会话同步给某个渠道」所需的最小操作集：看 + 发。
//                         每个端（桌面 / WebUI / Telegram / 扩展）都实现。纯会话维度，
//                         全部只读或发消息，**不含任何改配置 / 管理类能力**。
//   HostApi            ── 应用级管理能力（provider / project / settings / mcp / pinChat /
//                         update / config / compact，以及所有会改持久状态的方法）。
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
    /** 笔记本会话发送：每次开启独立子智能体（fire-and-forget，进展走事件流） */
    notebookPrompt: (params: AgentNotebookPromptParams) => Promise<{ success: boolean }>
    /** 继续与已存在子代理对话：追加一轮用户消息（fire-and-forget，进展走事件流） */
    subAgentPrompt: (params: AgentSubAgentPromptParams) => Promise<{ success: boolean }>
    steer: (params: AgentSteerParams) => Promise<{ success: boolean }>
    abort: (sessionId: string) => Promise<{ success: boolean; savedMessage?: ChatMessage }>
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
    countArchived: (sessionId: string) => Promise<number>
    listArchived: (params: {
      sessionId: string
      limit: number
      offset: number
    }) => Promise<ChatMessage[]>
  }
  runtime: {
    statuses: (sessionId: string) => Promise<Record<string, RuntimeStatus>>
  }
  tools: {
    list: (sessionId?: string) => Promise<ToolInfo[]>
    presentations: () => Promise<Record<string, ToolPresentation>>
  }
  command: {
    list: (params: { sessionId: string | null }) => Promise<SlashCommandInfo[]>
  }
  /** 工作目录文件浏览（只读）：扫描 + 预览读取。回写属 HostApi。 */
  files: {
    scan: (params: { sessionId: string }) => Promise<{
      paths: string[]
      truncated: boolean
      root: string | null
    }>
    read: (params: { sessionId: string; path: string }) => Promise<FileReadResult>
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
 * 含应用管理（provider/project/settings/mcp/pinChat/update/config/compact）
 * 以及一切会改持久状态的方法（会话配置 setter、消息写操作、文件回写、模型切换等）。
 * 渠道端取不到（getHostApi() 返回 null），对应 UI 自动隐藏。
 */
export interface HostApi {
  app: {
    openSettings: (tab?: string) => Promise<{ success: boolean }>
    openFolder: (folderPath: string) => Promise<{ success: boolean }>
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
    updateModelConfig: (params: SessionUpdateModelConfigParams) => Promise<{ success: boolean }>
    updateProject: (params: SessionUpdateProjectParams) => Promise<{ success: boolean }>
    updateThinkingLevel: (params: SessionUpdateThinkingLevelParams) => Promise<{ success: boolean }>
    updateEnabledTools: (params: SessionUpdateEnabledToolsParams) => Promise<{ success: boolean }>
    updateAutoApprove: (params: SessionUpdateAutoApproveParams) => Promise<{ success: boolean }>
    previewAllowPatterns: (params: {
      command: string
      sessionId?: string
      toolType?: 'bash' | 'ssh' | 'read' | 'write'
    }) => Promise<string[]>
    addAllowListPatterns: (params: SessionAllowListAddParams) => Promise<{ success: boolean }>
    removeAllowListEntry: (params: SessionAllowListRemoveParams) => Promise<{ success: boolean }>
    generateTitle: (params: {
      sessionId: string
      conversationText: string
    }) => Promise<{ title: string | null }>
    delete: (id: string) => Promise<{ success: boolean }>
    scanInstructionFiles: (sessionId: string) => Promise<InstructionFileEntry[]>
    updateInstructionFiles: (params: {
      id: string
      filenames: string[]
    }) => Promise<{ success: boolean }>
  }
  message: {
    add: (params: MessageAddParams) => Promise<ChatMessage>
    addErrorEvent: (params: { sessionId: string; content: string }) => Promise<ErrorEventMessage>
    deleteErrorEvent: (params: {
      sessionId: string
      messageId: string
    }) => Promise<{ success: boolean }>
    clear: (sessionId: string) => Promise<{ success: boolean }>
    rollback: (params: { sessionId: string; messageId: string }) => Promise<{ success: boolean }>
    deleteFrom: (params: { sessionId: string; messageId: string }) => Promise<{ success: boolean }>
  }
  settings: {
    getAll: () => Promise<Record<string, string>>
    get: (key: string) => Promise<string | undefined>
    set: (params: SettingsSetParams) => Promise<{ success: boolean }>
    getKnownKeys: () => Promise<Record<string, ConfigMeta>>
    listBuiltinSections: () => Promise<
      Array<{
        id: string
        title: string
        content: string | null
        disabled: boolean
        dynamic: boolean
      }>
    >
    setBuiltinDisabled: (ids: string[]) => Promise<{ success: boolean }>
    getCustomSections: () => Promise<ProjectPromptSection[]>
    setCustomSections: (sections: ProjectPromptSection[]) => Promise<{ success: boolean }>
    previewBuiltinSection: (params: { id: string; sessionId?: string }) => Promise<string>
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
  /** 文件回写（属管理类，渠道端无权） */
  files: {
    write: (params: {
      sessionId: string
      path: string
      content: string
    }) => Promise<{ ok: true } | { ok: false; error: string }>
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
  compact: {
    start: (sessionId: string) => Promise<unknown>
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
