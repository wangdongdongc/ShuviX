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

// ─────────────────────────── ChatApi 接口契约 ───────────────────────────

/** 聊天前端实际依赖的后端命名空间子集 */
export interface ChatApi {
  app: {
    platform: 'darwin' | 'win32' | 'linux' | 'web'
    openSettings: (tab?: string) => Promise<{ success: boolean }>
    openExternal: (url: string) => Promise<{ success: boolean }>
    openFolder: (folderPath: string) => Promise<{ success: boolean }>
    adjustWindowWidth: (delta: number) => Promise<void>
    setBrowserOffset: (offset: number) => Promise<void>
    windowReady: () => void
    // 设置变更订阅已并入通用 events.subscribe（AppEvent 'settings.changed'）
    onNewChat: (callback: () => void) => () => void
    onNewProject: (callback: () => void) => () => void
  }
  agent: {
    init: (params: AgentInitParams) => Promise<AgentInitResult>
    prompt: (params: AgentPromptParams) => Promise<{ success: boolean }>
    steer: (params: AgentSteerParams) => Promise<{ success: boolean }>
    abort: (sessionId: string) => Promise<{ success: boolean; savedMessage?: ChatMessage }>
    setModel: (params: AgentSetModelParams) => Promise<{ success: boolean }>
    setThinkingLevel: (params: AgentSetThinkingLevelParams) => Promise<{ success: boolean }>
    respondToInput: (params: {
      sessionId: string
      requestId: string
      response: InputResponse
    }) => Promise<{ success: boolean }>
    setEnabledTools: (params: { sessionId: string; tools: string[] }) => Promise<{
      success: boolean
    }>
    onEvent: (callback: (event: ChatEvent) => void) => () => void
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
    // 变更订阅已并入通用 events.subscribe（AppEvent 'project.changed'）
  }
  session: {
    list: () => Promise<Session[]>
    create: (projectId?: string | null) => Promise<Session>
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
    getById: (id: string) => Promise<SessionInfo | null>
    scanInstructionFiles: (sessionId: string) => Promise<InstructionFileEntry[]>
    updateInstructionFiles: (params: {
      id: string
      filenames: string[]
    }) => Promise<{ success: boolean }>
    // 配置变更订阅已并入通用 events.subscribe（AppEvent 'session.configChanged'）
  }
  message: {
    list: (sessionId: string) => Promise<ChatMessage[]>
    add: (params: MessageAddParams) => Promise<ChatMessage>
    addErrorEvent: (params: { sessionId: string; content: string }) => Promise<ErrorEventMessage>
    deleteErrorEvent: (params: {
      sessionId: string
      messageId: string
    }) => Promise<{ success: boolean }>
    clear: (sessionId: string) => Promise<{ success: boolean }>
    rollback: (params: { sessionId: string; messageId: string }) => Promise<{ success: boolean }>
    deleteFrom: (params: { sessionId: string; messageId: string }) => Promise<{ success: boolean }>
    countArchived: (sessionId: string) => Promise<number>
    listArchived: (params: {
      sessionId: string
      limit: number
      offset: number
    }) => Promise<ChatMessage[]>
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
  /** 配置分享：Provider + MCP 配置导出/导入为可粘贴串（桌面 DAO / 扩展 chrome.storage） */
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
    statuses: (sessionId: string) => Promise<Record<string, RuntimeStatus>>
    destroy: (params: { sessionId: string; runtimeId: string }) => Promise<{ success: boolean }>
  }
  tools: {
    list: (sessionId?: string) => Promise<ToolInfo[]>
    presentations: () => Promise<Record<string, ToolPresentation>>
  }
  command: {
    list: (params: { sessionId: string | null }) => Promise<SlashCommandInfo[]>
  }
  /** MCP 客户端：服务器 CRUD + 连接控制 + 工具查询（桌面 window.api.mcp / 扩展 chrome.storage） */
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
  webui: {
    setShared: (params: {
      sessionId: string
      shared: boolean
      mode?: ShareMode
    }) => Promise<{ success: boolean }>
    isShared: (sessionId: string) => Promise<boolean>
    getShareMode: (sessionId: string) => Promise<ShareMode | null>
    listShared: () => Promise<Array<{ sessionId: string; mode: ShareMode }>>
    serverStatus: () => Promise<{ running: boolean; port?: number; urls?: string[] }>
  }
  telegram: {
    listBots: () => Promise<TelegramBotInfo[]>
    addBot: (params: TelegramBotAddParams) => Promise<TelegramBotInfo>
    updateBot: (params: TelegramBotUpdateParams) => Promise<{ success: boolean }>
    deleteBot: (id: string) => Promise<{ success: boolean }>
    validateToken: (token: string) => Promise<{
      valid: boolean
      username?: string
      id?: number
      error?: string
    }>
    bindSession: (params: TelegramBindSessionParams) => Promise<{ success: boolean }>
    unbindSession: (params: TelegramUnbindSessionParams) => Promise<{ success: boolean }>
    getSessionBotId: (sessionId: string) => Promise<string | null>
    startBot: (botId: string) => Promise<{ success: boolean }>
    stopBot: (botId: string) => Promise<{ success: boolean }>
    getBotStatus: (botId: string) => Promise<{ running: boolean }>
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
    // 悬浮状态变更订阅已并入通用 events.subscribe（AppEvent 'pinChat.changed'）
  }
  update: {
    check: () => Promise<{ success: boolean }>
    download: () => Promise<{ success: boolean }>
    install: () => Promise<{ success: boolean }>
    getLastEvent: () => Promise<UpdateEvent | null>
    onEvent: (callback: (event: UpdateEvent) => void) => () => void
  }
  /** 通用内部事件订阅（后端发布的全局状态事件，与 agent.onEvent 并列）。见 docs/internal-events.md */
  events: {
    subscribe: (callback: (event: AppEvent) => void) => () => void
  }
  /** 工作目录文件浏览（右侧面板 Files tab）。桌面走 Node fs + 文件监听；
   *  扩展走 File System Access（无原生监听 → onChanged 为空操作，靠手动刷新）。 */
  files: {
    /** 扫描当前会话工作目录下的所有文件相对路径（遵循忽略规则），root 为工作目录标识 */
    scan: (params: { sessionId: string }) => Promise<{
      paths: string[]
      truncated: boolean
      root: string | null
    }>
    /** 读取文件内容用于面板预览（沙箱外返回 not-allowed，不弹审批） */
    read: (params: { sessionId: string; path: string }) => Promise<FileReadResult>
    /** 回写文件内容（沙箱外返回 ok:false，不弹审批） */
    write: (params: {
      sessionId: string
      path: string
      content: string
    }) => Promise<{ ok: true } | { ok: false; error: string }>
    // 文件变动订阅已并入通用 events.subscribe（AppEvent 'files.changed'），见 docs/internal-events.md
  }
  /** 语音转文字 —— chat-ui 仅用 transcribe（其余 stt 能力由宿主自行扩展） */
  stt: {
    transcribe: (params: {
      audioData: string
      pcmf32?: string
      language?: string
    }) => Promise<{ text: string }>
  }
  /** 文字转语音 —— chat-ui 仅用 onChunk/speakOnce/abortTts */
  tts: {
    speakOnce: (params: { text: string }) => Promise<void>
    abortTts: () => Promise<void>
    onChunk: (callback: (data: { filePath: string; index: number }) => void) => () => void
  }
}
