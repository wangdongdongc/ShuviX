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
  SessionUpdateSettingsParams,
  SessionUpdateTitleParams,
  SettingsSetParams,
  McpServerAddParams,
  McpServerUpdateParams,
  McpServerInfo,
  McpToolInfo,
  Skill,
  SkillAddParams,
  SkillUpdateParams,
  SshCredential,
  SshCredentialAddParams,
  SshCredentialUpdateParams
} from '../main/types'

declare global {
  /** ChatEvent 判别联合 — 后端 → 前端通信协议 */
  interface ChatEventBase {
    sessionId: string
  }
  interface ChatAgentStartEvent extends ChatEventBase {
    type: 'agent_start'
  }
  interface ChatTextDeltaEvent extends ChatEventBase {
    type: 'text_delta'
    delta: string
  }
  interface ChatThinkingDeltaEvent extends ChatEventBase {
    type: 'thinking_delta'
    delta: string
  }
  interface ChatTextEndEvent extends ChatEventBase {
    type: 'text_end'
  }
  interface ChatAgentEndEvent extends ChatEventBase {
    type: 'agent_end'
    message?: string
    usage?: {
      input: number
      output: number
      cacheRead: number
      total: number
      details: Array<{
        input: number
        output: number
        cacheRead: number
        total: number
        stopReason: string
      }>
    }
  }
  interface ChatToolStartEvent extends ChatEventBase {
    type: 'tool_start'
    toolCallId: string
    toolName: string
    toolArgs?: Record<string, unknown>
    messageId?: string
    turnIndex?: number
    approvalRequired?: boolean
    userInputRequired?: boolean
    sshCredentialRequired?: boolean
  }
  interface ChatToolEndEvent extends ChatEventBase {
    type: 'tool_end'
    toolCallId: string
    toolName: string
    result?: string
    isError?: boolean
    messageId?: string
  }
  interface ChatApprovalRequestEvent extends ChatEventBase {
    type: 'tool_approval_request'
    toolCallId: string
    toolName: string
    toolArgs?: Record<string, unknown>
  }
  interface ChatInputRequestEvent extends ChatEventBase {
    type: 'user_input_request'
    toolCallId: string
    toolName: string
    payload: {
      question: string
      options: Array<{ label: string; description: string }>
      allowMultiple: boolean
    }
  }
  interface ChatCredentialRequestEvent extends ChatEventBase {
    type: 'ssh_credential_request'
    toolCallId: string
    toolName: string
  }
  interface ChatImageDataEvent extends ChatEventBase {
    type: 'image_data'
    image: string
  }
  interface ChatDockerEvent extends ChatEventBase {
    type: 'docker_event'
    messageId: string
  }
  interface ChatSshEvent extends ChatEventBase {
    type: 'ssh_event'
    messageId: string
  }
  interface ChatErrorEvent extends ChatEventBase {
    type: 'error'
    error: string
  }

  type ChatEvent =
    | ChatAgentStartEvent
    | ChatTextDeltaEvent
    | ChatThinkingDeltaEvent
    | ChatTextEndEvent
    | ChatAgentEndEvent
    | ChatToolStartEvent
    | ChatToolEndEvent
    | ChatApprovalRequestEvent
    | ChatInputRequestEvent
    | ChatCredentialRequestEvent
    | ChatImageDataEvent
    | ChatDockerEvent
    | ChatSshEvent
    | ChatErrorEvent

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

  /** 会话类型（对应 DB 表 sessions） */
  interface Session {
    id: string
    title: string
    /** 所属项目 ID（null 表示临时会话） */
    projectId: string | null
    provider: string
    model: string
    systemPrompt: string
    modelMetadata: string
    /** 会话级配置（JSON：sshAutoApprove 等） */
    settings: string
    createdAt: number
    updatedAt: number
  }

  /** 会话完整信息（含计算属性） */
  interface SessionInfo extends Session {
    /** 项目工作目录（由后端填充） */
    workingDirectory?: string | null
    /** 当前生效的工具列表（由后端解析：session > project > all） */
    enabledTools?: string[]
    /** 项目 AGENT.md 是否存在并已加载 */
    agentMdLoaded?: boolean
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
      platform: 'darwin' | 'win32' | 'linux' | 'web'
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
      approveToolCall: (params: {
        toolCallId: string
        approved: boolean
        reason?: string
      }) => Promise<{ success: boolean }>
      /** 响应 ask 工具的用户选择 */
      respondToAsk: (params: {
        toolCallId: string
        selections: string[]
      }) => Promise<{ success: boolean }>
      /** 响应 SSH 凭据输入（凭据不经过大模型） */
      respondToSshCredentials: (params: {
        toolCallId: string
        credentials: {
          host: string
          port: number
          username: string
          password?: string
          privateKey?: string
          passphrase?: string
        } | null
      }) => Promise<{ success: boolean }>
      /** 动态更新启用工具集 */
      setEnabledTools: (params: {
        sessionId: string
        tools: string[]
      }) => Promise<{ success: boolean }>
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
      toggleModelEnabled: (
        params: ProviderToggleModelEnabledParams
      ) => Promise<{ success: boolean }>
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
      /** 获取已知项目字段的元数据（labelKey + desc） */
      getKnownFields: () => Promise<Record<string, ConfigMeta>>
    }
    session: {
      list: () => Promise<Session[]>
      create: (params?: Partial<Session>) => Promise<Session>
      updateTitle: (params: SessionUpdateTitleParams) => Promise<{ success: boolean }>
      updateModelConfig: (params: SessionUpdateModelConfigParams) => Promise<{ success: boolean }>
      updateProject: (params: SessionUpdateProjectParams) => Promise<{ success: boolean }>
      updateModelMetadata: (
        params: SessionUpdateModelMetadataParams
      ) => Promise<{ success: boolean }>
      updateSettings: (params: SessionUpdateSettingsParams) => Promise<{ success: boolean }>
      generateTitle: (params: {
        sessionId: string
        userMessage: string
        assistantMessage: string
      }) => Promise<{ title: string | null }>
      delete: (id: string) => Promise<{ success: boolean }>
      /** 获取单个会话（含计算属性） */
      getById: (id: string) => Promise<SessionInfo | null>
    }
    message: {
      list: (sessionId: string) => Promise<ChatMessage[]>
      add: (params: MessageAddParams) => Promise<ChatMessage>
      clear: (sessionId: string) => Promise<{ success: boolean }>
      /** 回退到指定消息（保留该消息，删除之后的所有消息，使 Agent 失效） */
      rollback: (params: { sessionId: string; messageId: string }) => Promise<{ success: boolean }>
      /** 从指定消息开始删除（含该消息本身，使 Agent 失效） */
      deleteFrom: (params: {
        sessionId: string
        messageId: string
      }) => Promise<{ success: boolean }>
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
      sessionStatus: (sessionId: string) => Promise<{ containerId: string; image: string } | null>
      destroySession: (sessionId: string) => Promise<{ success: boolean }>
    }
    ssh: {
      sessionStatus: (
        sessionId: string
      ) => Promise<{ host: string; port: number; username: string } | null>
      disconnectSession: (sessionId: string) => Promise<{ success: boolean }>
    }
    sshCredential: {
      list: () => Promise<SshCredential[]>
      add: (params: SshCredentialAddParams) => Promise<{ id: string }>
      update: (params: SshCredentialUpdateParams) => Promise<{ success: boolean }>
      delete: (id: string) => Promise<{ success: boolean }>
      listNames: () => Promise<string[]>
    }
    tools: {
      list: () => Promise<
        Array<{
          name: string
          label: string
          group?: string
          serverStatus?: 'connected' | 'disconnected' | 'connecting' | 'error'
          isEnabled?: boolean
        }>
      >
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
    webui: {
      /** 切换指定 session 的分享状态 */
      setShared: (params: {
        sessionId: string
        shared: boolean
      }) => Promise<{ success: boolean }>
      /** 查询单个 session 是否已分享 */
      isShared: (sessionId: string) => Promise<boolean>
      /** 获取所有已分享的 session ID 列表 */
      listShared: () => Promise<string[]>
      /** 获取 WebUI 服务器状态 */
      serverStatus: () => Promise<{
        running: boolean
        port?: number
        urls?: string[]
      }>
    }
    skill: {
      list: () => Promise<Skill[]>
      add: (params: SkillAddParams) => Promise<Skill>
      update: (params: SkillUpdateParams) => Promise<{ success: boolean }>
      delete: (name: string) => Promise<{ success: boolean }>
      parseMarkdown: (
        text: string
      ) => Promise<{ name: string; description: string; content: string } | null>
      importFromDir: () => Promise<{ success: boolean; skill?: Skill; reason?: string }>
      getDir: () => Promise<string>
    }
  }

  interface Window {
    electron: ElectronAPI
    api: ShuviXAPI
  }
} // declare global
