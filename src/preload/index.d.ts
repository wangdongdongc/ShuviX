import { ElectronAPI } from '@electron-toolkit/preload'
import type {
  AgentInitParams,
  AgentInitResult,
  AgentPromptParams,
  AgentSetModelParams,
  AgentSetThinkingLevelParams,
  HttpLog,
  HttpLogListParams,
  HttpLogSummary,
  MessageAddParams,
  ModelCapabilities,
  ProjectCreateParams,
  ProjectUpdateParams,
  ProjectDeleteParams,
  ProviderAddModelParams,
  ProviderAddParams,
  ProviderDeleteParams,
  ProviderSyncModelsParams,
  ProviderToggleEnabledParams,
  ProviderToggleModelEnabledParams,
  ProviderUpdateConfigParams,
  ProviderUpdateModelCapabilitiesParams,
  SessionUpdateModelConfigParams,
  SessionUpdateModelMetadataParams,
  SessionUpdateProjectParams,
  SessionUpdateTitleParams,
  SettingsSetParams,
  McpServerAddParams,
  McpServerUpdateParams,
  McpServerInfo,
  McpToolInfo,
  Skill,
  SkillAddParams,
  SkillUpdateParams
} from '../main/types'

declare global {

/** Agent 事件流类型 */
interface AgentStreamEvent {
  type: 'text_delta' | 'text_end' | 'thinking_delta' | 'agent_start' | 'agent_end' | 'error' | 'tool_start' | 'tool_end' | 'docker_event' | 'tool_approval_request' | 'user_input_request'
  sessionId: string
  data?: string
  error?: string
  toolCallId?: string
  toolName?: string
  toolArgs?: any
  toolResult?: any
  toolIsError?: boolean
  approvalRequired?: boolean
  userInputRequired?: boolean
  userInputPayload?: { question: string; options: Array<{ label: string; description: string }>; allowMultiple: boolean }
}

/** 项目类型 */
interface Project {
  id: string
  name: string
  path: string
  systemPrompt: string
  dockerEnabled: number
  dockerImage: string
  sandboxEnabled: number
  settings: string
  archivedAt: number
  createdAt: number
  updatedAt: number
}

/** 会话类型 */
interface Session {
  id: string
  title: string
  /** 所属项目 ID（null 表示临时会话） */
  projectId: string | null
  provider: string
  model: string
  systemPrompt: string
  modelMetadata: string
  createdAt: number
  updatedAt: number
  /** 项目工作目录（计算属性，由后端填充） */
  workingDirectory?: string | null
  /** 当前生效的工具列表（计算属性，由后端解析：session > project > all） */
  enabledTools?: string[]
  /** 项目 AGENT.md 是否存在并已加载（计算属性） */
  agentMdLoaded?: boolean
  /** 项目 CLAUDE.md 是否存在并已加载（计算属性） */
  claudeMdLoaded?: boolean
}

/** 消息类型 */
interface ChatMessage {
  id: string
  sessionId: string
  role: 'user' | 'assistant' | 'system' | 'tool' | 'system_notify'
  type: 'text' | 'tool_call' | 'tool_result' | 'docker_event' | 'error_event'
  content: string
  metadata: string | null
  model: string
  createdAt: number
}

/** 提供商类型 */
interface ProviderInfo {
  id: string
  name: string
  /** 用户友好的显示名称（内置提供商使用，如 "OpenAI"） */
  displayName: string
  apiKey: string
  baseUrl: string
  apiProtocol: 'openai-completions' | 'anthropic-messages' | 'google-generative-ai'
  isBuiltin: number
  isEnabled: number
  sortOrder: number
  createdAt: number
  updatedAt: number
}

/** 提供商模型类型 */
interface ProviderModelInfo {
  id: string
  providerId: string
  modelId: string
  isEnabled: number
  sortOrder: number
  capabilities: string
}

/** 可用模型（含提供商名称） */
interface AvailableModel extends ProviderModelInfo {
  providerName: string
}

/** 配置项元数据（设置 key / 项目字段共用） */
interface ConfigMeta {
  labelKey: string
  desc: string
}

/** 暴露给 Renderer 的 API 类型 */
interface ShuviXAPI {
  app: {
    /** 当前运行平台 */
    platform: 'darwin' | 'win32' | 'linux'
    openSettings: () => Promise<{ success: boolean }>
    /** 用系统默认浏览器打开外部链接 */
    openExternal: (url: string) => Promise<{ success: boolean }>
    /** 用系统默认应用打开 base64 图片 */
    openImage: (dataUrl: string) => Promise<{ success: boolean }>
    /** 用系统文件管理器打开指定文件夹 */
    openFolder: (folderPath: string) => Promise<{ success: boolean }>
    /** 通知主进程渲染已就绪，可以显示窗口 */
    windowReady: () => void
    onSettingsChanged: (callback: () => void) => () => void
  }
  agent: {
    init: (params: AgentInitParams) => Promise<AgentInitResult>
    prompt: (params: AgentPromptParams) => Promise<{ success: boolean }>
    abort: (sessionId: string) => Promise<{ success: boolean; savedMessage?: ChatMessage }>
    setModel: (params: AgentSetModelParams) => Promise<{ success: boolean }>
    setThinkingLevel: (params: AgentSetThinkingLevelParams) => Promise<{ success: boolean }>
    /** 响应工具审批请求（沙箱模式下 bash 命令需用户确认） */
    approveToolCall: (params: { toolCallId: string; approved: boolean; reason?: string }) => Promise<{ success: boolean }>
    /** 响应 ask 工具的用户选择 */
    respondToAsk: (params: { toolCallId: string; selections: string[] }) => Promise<{ success: boolean }>
    /** 动态更新启用工具集 */
    setEnabledTools: (params: { sessionId: string; tools: string[] }) => Promise<{ success: boolean }>
    onEvent: (callback: (event: AgentStreamEvent) => void) => () => void
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
    syncModels: (params: ProviderSyncModelsParams) => Promise<{ providerId: string; total: number; added: number }>
    add: (params: ProviderAddParams) => Promise<ProviderInfo>
    delete: (params: ProviderDeleteParams) => Promise<{ success: boolean }>
    addModel: (params: ProviderAddModelParams) => Promise<{ success: boolean }>
    deleteModel: (id: string) => Promise<{ success: boolean }>
    updateModelCapabilities: (params: ProviderUpdateModelCapabilitiesParams) => Promise<{ success: boolean }>
  }
  project: {
    list: () => Promise<Project[]>
    listArchived: () => Promise<Project[]>
    getById: (id: string) => Promise<Project | null>
    create: (params: ProjectCreateParams) => Promise<Project>
    update: (params: ProjectUpdateParams) => Promise<{ success: boolean }>
    delete: (params: ProjectDeleteParams) => Promise<{ success: boolean }>
    /** 获取已知项目字段的元数据（labelKey + desc） */
    getKnownFields: () => Promise<Record<string, ConfigMeta>>
  }
  session: {
    list: () => Promise<Session[]>
    create: (params?: Partial<Session>) => Promise<Session>
    updateTitle: (params: SessionUpdateTitleParams) => Promise<{ success: boolean }>
    updateModelConfig: (params: SessionUpdateModelConfigParams) => Promise<{ success: boolean }>
    updateProject: (params: SessionUpdateProjectParams) => Promise<{ success: boolean }>
    updateModelMetadata: (params: SessionUpdateModelMetadataParams) => Promise<{ success: boolean }>
    generateTitle: (params: { sessionId: string; userMessage: string; assistantMessage: string }) => Promise<{ title: string | null }>
    delete: (id: string) => Promise<{ success: boolean }>
    /** 获取单个会话（含 workingDirectory） */
    getById: (id: string) => Promise<Session | null>
  }
  message: {
    list: (sessionId: string) => Promise<ChatMessage[]>
    add: (params: MessageAddParams) => Promise<ChatMessage>
    clear: (sessionId: string) => Promise<{ success: boolean }>
    /** 回退到指定消息（保留该消息，删除之后的所有消息，使 Agent 失效） */
    rollback: (params: { sessionId: string; messageId: string }) => Promise<{ success: boolean }>
    /** 从指定消息开始删除（含该消息本身，使 Agent 失效） */
    deleteFrom: (params: { sessionId: string; messageId: string }) => Promise<{ success: boolean }>
  }
  settings: {
    getAll: () => Promise<Record<string, string>>
    get: (key: string) => Promise<string | undefined>
    set: (params: SettingsSetParams) => Promise<{ success: boolean }>
    /** 获取已知设置 key 的元数据（labelKey + desc） */
    getKnownKeys: () => Promise<Record<string, ConfigMeta>>
  }
  httpLog: {
    list: (params?: HttpLogListParams) => Promise<HttpLogSummary[]>
    get: (id: string) => Promise<HttpLog | undefined>
    clear: () => Promise<{ success: boolean }>
  }
  docker: {
    validate: (params?: { image?: string }) => Promise<{ ok: boolean; error?: string }>
  }
  tools: {
    list: () => Promise<Array<{ name: string; label: string; group?: string; serverStatus?: 'connected' | 'disconnected' | 'connecting' | 'error'; isEnabled?: boolean }>>
  }
  mcp: {
    list: () => Promise<McpServerInfo[]>
    add: (params: McpServerAddParams) => Promise<{ success: boolean; id: string }>
    update: (params: McpServerUpdateParams) => Promise<{ success: boolean }>
    delete: (id: string) => Promise<{ success: boolean }>
    connect: (id: string) => Promise<{ success: boolean }>
    disconnect: (id: string) => Promise<{ success: boolean }>
    getTools: (id: string) => Promise<McpToolInfo[]>
  }
  skill: {
    list: () => Promise<Skill[]>
    add: (params: SkillAddParams) => Promise<Skill>
    update: (params: SkillUpdateParams) => Promise<{ success: boolean }>
    delete: (name: string) => Promise<{ success: boolean }>
    parseMarkdown: (text: string) => Promise<{ name: string; description: string; content: string } | null>
    importFromDir: () => Promise<{ success: boolean; skill?: Skill; reason?: string }>
    getDir: () => Promise<string>
  }
}

  interface Window {
    electron: ElectronAPI
    api: ShuviXAPI
  }
} // declare global
