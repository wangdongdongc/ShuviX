import { ElectronAPI } from '@electron-toolkit/preload'
import type { LucideIconName, ThemeColor } from '@shuvix/chat-protocol/theme'
import type {
  AgentInitParams,
  AgentInitResult,
  AgentRuntimeInfo,
  AgentPromptParams,
  AgentNotebookPromptParams,
  AgentDispatchPromptParams,
  AgentSubAgentPromptParams,
  AgentSteerParams,
  AgentSetModelParams,
  AgentSetThinkingLevelParams,
  HttpLog,
  HttpLogListParams,
  HttpLogSummary,
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
  SessionUpdateThinkingLevelParams,
  SessionUpdateEnabledToolsParams,
  SessionUpdateProjectParams,
  SessionUpdateAutoApproveParams,
  SessionAllowListRemoveParams,
  SessionUpdateTitleParams,
  SessionCreateParams,
  SettingsSetParams,
  McpServerAddParams,
  McpServerUpdateParams,
  McpServerInfo,
  McpToolInfo,
  McpHostStatus,
  McpHostToolDesc,
  McpHostLogSummary,
  Skill,
  SkillUpdateParams,
  SkillDir,
  SkillGroup,
  SshCredential,
  SshCredentialAddParams,
  SshCredentialUpdateParams,
  DbCredential,
  DbCredentialAddParams,
  DbCredentialUpdateParams,
  DbCredentialTestParams,
  TelegramBotAddParams,
  TelegramBotUpdateParams,
  TelegramBotInfo,
  TelegramBindSessionParams,
  TelegramUnbindSessionParams,
  ToolResultDetails
} from '../main/types'
import type {
  ConfigSharePayload,
  ExportOptions,
  ExportSnapshot,
  ImportPlan,
  ImportResult,
  ImportSelection
} from '@shuvix/chat-protocol/types/configShare'
import type { ResolvedHook, HookFileStatus } from '@shuvix/chat-protocol/types/hook'

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
  interface ChatStepEndEvent extends ChatEventBase {
    type: 'step_end'
    messageId: string
    message?: string
  }
  interface ChatAgentEndEvent extends ChatEventBase {
    type: 'agent_end'
    message?: string
    usage?: {
      input: number
      output: number
      cacheRead: number
      cacheWrite: number
      total: number
      details: Array<{
        input: number
        output: number
        cacheRead: number
        cacheWrite: number
        total: number
        stopReason: string
      }>
    }
  }
  interface ChatTokenUsageEvent extends ChatEventBase {
    type: 'token_usage'
    promptTokens: number
  }
  interface ChatToolCallGeneratingEvent extends ChatEventBase {
    type: 'toolcall_generating'
    toolName: string
    argsDelta?: string
  }
  interface ChatToolStartEvent extends ChatEventBase {
    type: 'tool_start'
    toolCallId: string
    toolName: string
    toolArgs?: Record<string, unknown>
    messageId?: string
    turnIndex?: number
  }
  interface ChatToolEndEvent extends ChatEventBase {
    type: 'tool_end'
    toolCallId: string
    toolName: string
    result?: string
    isError?: boolean
    messageId?: string
    /** 工具特定的结构化详情（edit diff 等），按 type 判别 */
    details?: ToolResultDetails
  }
  interface ChatInputRequestEvent extends ChatEventBase {
    type: 'input_request'
    request: import('@shuvix/chat-protocol/types/inputRequest').InputRequest
  }
  interface ChatInputRequestResolvedEvent extends ChatEventBase {
    type: 'input_request_resolved'
    requestId: string
  }
  interface ChatImageDataEvent extends ChatEventBase {
    type: 'image_data'
    image: string
  }
  interface RuntimeStatus {
    label: string
    icon?: LucideIconName
    color?: ThemeColor
    description?: string
  }
  interface ChatRuntimeEvent extends ChatEventBase {
    type: 'runtime_event'
    runtimeId: string
    status: RuntimeStatus | null
  }
  interface ChatBrowserEvent extends ChatEventBase {
    type: 'browser_event'
    action: 'open' | 'close'
    url?: string
    title?: string
  }
  interface ChatFilePreviewEvent extends ChatEventBase {
    type: 'file_preview'
    /** 要预览的文件绝对路径（须位于会话工作目录内） */
    absPath: string
  }
  interface ChatSubSessionRegisterEvent extends ChatEventBase {
    type: 'sub_session_register'
    parentSessionId: string
    subAgentName: string
    displayName: string
    description: string
    systemPrompt: string
    prompt: string
    /** 派生层级（直接派生=1，嵌套派生依次递增） */
    depth?: number
    /** 所属根会话 id（嵌套派生时 parentSessionId 是另一个派生 agent） */
    rootSessionId?: string
  }
  interface ChatSubSessionEndEvent extends ChatEventBase {
    type: 'sub_session_end'
    parentSessionId: string
    result: string
    isError?: boolean
  }
  interface ChatMessagesReloadedEvent extends ChatEventBase {
    type: 'messages_reloaded'
  }
  interface ChatInstructionsInjectedEvent extends ChatEventBase {
    type: 'instructions_injected'
    messages: string[]
  }
  interface ChatErrorEvent extends ChatEventBase {
    type: 'error'
    error: string
  }
  interface ChatUserMessageEvent extends ChatEventBase {
    type: 'user_message'
    message: string
  }

  type ChatEvent =
    | ChatAgentStartEvent
    | ChatTextDeltaEvent
    | ChatThinkingDeltaEvent
    | ChatTextEndEvent
    | ChatStepEndEvent
    | ChatAgentEndEvent
    | ChatTokenUsageEvent
    | ChatToolCallGeneratingEvent
    | ChatToolStartEvent
    | ChatToolEndEvent
    | ChatInputRequestEvent
    | ChatInputRequestResolvedEvent
    | ChatImageDataEvent
    | ChatRuntimeEvent
    | ChatBrowserEvent
    | ChatFilePreviewEvent
    | ChatSubSessionRegisterEvent
    | ChatSubSessionEndEvent
    | ChatMessagesReloadedEvent
    | ChatInstructionsInjectedEvent
    | ChatErrorEvent
    | ChatUserMessageEvent

  /** 自动更新事件判别联合 */
  type UpdateEvent = import('../main/types').UpdateEvent

  /** 下载进度信息 */
  interface DownloadProgress {
    taskId: string
    percent: number
    downloadedBytes: number
    totalBytes: number
    speedBytesPerSec: number
    etaSeconds: number
  }

  /** 参考目录条目 */
  interface ReferenceDir {
    path: string
    note?: string
    access?: 'readonly' | 'readwrite'
  }

  /** 项目环境变量 */
  interface ProjectEnvVar {
    key: string
    value: string
    sensitive: boolean
  }

  /** 工具扩展配置 */
  interface ToolSettings {
    pglitePersist?: boolean
    envVars?: ProjectEnvVar[]
  }

  /** 项目扩展配置 */
  interface ProjectSettings {
    enabledTools?: string[]
    referenceDirs?: ReferenceDir[]
    tool?: ToolSettings
  }

  /** 项目类型 */
  interface Project {
    id: string
    name: string
    path: string
    promptSections: import('@shuvix/chat-protocol/types/promptSection').ProjectPromptSection[]
    settings: ProjectSettings
    archivedAt: number
    createdAt: number
    updatedAt: number
  }

  /** 模型相关元数据 */
  interface SessionModelMetadata {
    thinkingLevel?: string
    enabledTools?: string[]
  }

  /** 会话级配置 */
  interface SessionSettings {
    autoApprove?: boolean
    allowList?: string[]
    telegramBotId?: string
    /** 注入的项目指令文件（单选）：undefined = 按优先级自动选，null = 不注入 */
    instructionFile?: string | null
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
    modelMetadata: SessionModelMetadata
    /** 会话级配置（SSH 免审批等） */
    settings: SessionSettings
    createdAt: number
    updatedAt: number
  }

  /** 会话完整信息（含计算属性） */
  interface SessionInfo extends Session {
    /** 项目工作目录（由后端填充） */
    workingDirectory?: string | null
    /** 当前生效的工具列表（由后端解析：session > project > all） */
    enabledTools?: string[]
  }

  // ---- 消息相关类型（从 shared 统一引用，消除重复定义） ----
  type ImageMeta = import('@shuvix/chat-protocol/types/chatMessage').ImageMeta
  type UsageInfo = import('@shuvix/chat-protocol/types/chatMessage').UsageInfo
  type MessageMetadata = import('@shuvix/chat-protocol/types/chatMessage').MessageMetadata
  type UserTextMeta = import('@shuvix/chat-protocol/types/chatMessage').UserTextMeta
  type AssistantTextMeta = import('@shuvix/chat-protocol/types/chatMessage').AssistantTextMeta
  type ToolUseMeta = import('@shuvix/chat-protocol/types/chatMessage').ToolUseMeta
  type StepTextMeta = import('@shuvix/chat-protocol/types/chatMessage').StepTextMeta
  type StepThinkingMeta = import('@shuvix/chat-protocol/types/chatMessage').StepThinkingMeta
  type MessageBase = import('@shuvix/chat-protocol/types/chatMessage').MessageBase
  type UserTextMessage = import('@shuvix/chat-protocol/types/chatMessage').UserTextMessage
  type AssistantTextMessage = import('@shuvix/chat-protocol/types/chatMessage').AssistantTextMessage
  type ToolUseMessage = import('@shuvix/chat-protocol/types/chatMessage').ToolUseMessage
  type StepTextMessage = import('@shuvix/chat-protocol/types/chatMessage').StepTextMessage
  type StepThinkingMessage = import('@shuvix/chat-protocol/types/chatMessage').StepThinkingMessage
  type SteerMessage = import('@shuvix/chat-protocol/types/chatMessage').SteerMessage
  type ErrorEventMessage = import('@shuvix/chat-protocol/types/chatMessage').ErrorEventMessage
  type ChatMessage = import('@shuvix/chat-protocol/types/chatMessage').ChatMessage

  /** 提供商类型 */
  // 单一源在 @shuvix/chat-protocol/types/provider；此处仅作全局别名，供 renderer 免 import 使用
  type ProviderInfo = import('@shuvix/chat-protocol/types/provider').ProviderInfo
  type ProviderModelInfo = import('@shuvix/chat-protocol/types/provider').ProviderModelInfo
  type AvailableModel = import('@shuvix/chat-protocol/types/provider').AvailableModel

  /** 配置项元数据（设置 key / 项目字段共用） */
  interface ConfigMeta {
    labelKey: string
    desc: string
  }

  /** Sub-agent 元信息（文件系统驱动；与主进程 AgentDefinition 对齐） */
  interface SubAgentInfo {
    name: string
    displayName: string
    whenToUse: string
    systemPrompt: string
    tools: string[]
    source: 'builtin' | 'user'
    requiredMcp?: string[]
    basePath: string
    isEnabled: boolean
  }

  /** 暴露给 Renderer 的 API 类型 */
  interface ShuviXAPI {
    app: {
      /** 当前运行平台 */
      platform: 'darwin' | 'win32' | 'linux' | 'web'
      openSettings: (tab?: string) => Promise<{ success: boolean }>
      /** 用系统默认浏览器打开外部链接 */
      openExternal: (url: string) => Promise<{ success: boolean }>
      /** 用系统文件管理器打开指定文件夹 */
      openFolder: (folderPath: string) => Promise<{ success: boolean }>
      /** 在系统文件管理器中定位并选中该文件（与 openFolder 不同：会高亮文件本身） */
      revealPath: (filePath: string) => Promise<{ success: boolean }>
      /** 调整主窗口宽度（delta > 0 变宽，< 0 变窄） */
      adjustWindowWidth: (delta: number) => Promise<void>
      /** 设置浏览器面板宽度偏移（保存窗口尺寸时扣除） */
      setBrowserOffset: (offset: number) => Promise<void>
      /** 通知主进程渲染已就绪，可以显示窗口 */
      windowReady: () => void
      onNewChat: (callback: () => void) => () => void
      onNewProject: (callback: () => void) => () => void
    }
    agent: {
      init: (params: AgentInitParams) => Promise<AgentInitResult>
      prompt: (params: AgentPromptParams) => Promise<{ success: boolean }>
      notebookPrompt: (params: AgentNotebookPromptParams) => Promise<{ success: boolean }>
      dispatchPrompt: (params: AgentDispatchPromptParams) => Promise<{ success: boolean }>
      subAgentPrompt: (params: AgentSubAgentPromptParams) => Promise<{ success: boolean }>
      subSessionDestroy: (subSessionId: string) => Promise<{ success: boolean }>
      subSessionInterrupt: (subSessionId: string) => Promise<{ success: boolean }>
      steer: (params: AgentSteerParams) => Promise<{ success: boolean }>
      abort: (sessionId: string) => Promise<{ success: boolean; savedMessage?: ChatMessage }>
      /** 压缩会话历史（harness 内建滚动式部分压缩） */
      compact: (sessionId: string) => Promise<{ success: boolean; error?: string }>
      setModel: (params: AgentSetModelParams) => Promise<{ success: boolean }>
      setThinkingLevel: (params: AgentSetThinkingLevelParams) => Promise<{ success: boolean }>
      /** 读取运行时 Agent 对象的实时信息（systemPrompt/工具/模型）；Agent 未创建返回 null */
      getInfo: (sessionId: string) => Promise<AgentRuntimeInfo | null>
      /**
       * 统一的"用户输入响应"入口。命令审批 / 选择题 / SSH 凭证 / 用户取消都通过该方法路由。
       */
      respondToInput: (params: {
        sessionId: string
        requestId: string
        response: import('@shuvix/chat-protocol/types/inputRequest').InputResponse
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
      create: (params?: SessionCreateParams) => Promise<Session>
      updateTitle: (params: SessionUpdateTitleParams) => Promise<{ success: boolean }>
      updateModelConfig: (params: SessionUpdateModelConfigParams) => Promise<{ success: boolean }>
      updateProject: (params: SessionUpdateProjectParams) => Promise<{ success: boolean }>
      updateThinkingLevel: (
        params: SessionUpdateThinkingLevelParams
      ) => Promise<{ success: boolean }>
      updateEnabledTools: (params: SessionUpdateEnabledToolsParams) => Promise<{ success: boolean }>
      updateAutoApprove: (params: SessionUpdateAutoApproveParams) => Promise<{ success: boolean }>
      removeAllowListEntry: (params: SessionAllowListRemoveParams) => Promise<{ success: boolean }>
      generateTitle: (params: {
        sessionId: string
        conversationText: string
      }) => Promise<{ title: string | null }>
      delete: (id: string) => Promise<{ success: boolean }>
      /** 获取单个会话（含计算属性） */
      getById: (id: string) => Promise<SessionInfo | null>
      scanInstructionFiles: (
        sessionId: string
      ) => Promise<import('@shuvix/chat-protocol/types/instructionFile').InstructionFileEntry[]>
      updateInstructionFile: (params: {
        id: string
        filename: string | null
      }) => Promise<{ success: boolean }>
    }
    message: {
      list: (sessionId: string) => Promise<ChatMessage[]>
      clear: (sessionId: string) => Promise<{ success: boolean }>
      /** 回退到指定消息之前（entry 树 leaf 移到其父节点，使 Agent 失效） */
      rollback: (params: { sessionId: string; messageId: string }) => Promise<{ success: boolean }>
      /** 统计已归档消息数 */
      countArchived: (sessionId: string) => Promise<number>
      /** 分页加载已归档消息（含 steps） */
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
      /** 获取已知设置 key 的元数据（labelKey + desc） */
      getKnownKeys: () => Promise<Record<string, ConfigMeta>>
      /** 列出全部内置系统提示词卡片 */
      listBuiltinSections: () => Promise<
        Array<{
          id: string
          title: string
          content: string | null
          disabled: boolean
          dynamic: boolean
        }>
      >
      /** 写入被禁用的内置卡片 id 列表 */
      setBuiltinDisabled: (ids: string[]) => Promise<{ success: boolean }>
      /** 读取用户自定义系统提示词卡片 */
      getCustomSections: () => Promise<
        import('@shuvix/chat-protocol/types/promptSection').ProjectPromptSection[]
      >
      /** 写入用户自定义系统提示词卡片 */
      setCustomSections: (
        sections: import('@shuvix/chat-protocol/types/promptSection').ProjectPromptSection[]
      ) => Promise<{ success: boolean }>
      /** 预览内置卡片实际内容 */
      previewBuiltinSection: (params: { id: string; sessionId?: string }) => Promise<string>
    }
    httpLog: {
      list: (params?: HttpLogListParams) => Promise<HttpLogSummary[]>
      get: (id: string) => Promise<HttpLog | undefined>
      clear: () => Promise<{ success: boolean }>
    }
    runtime: {
      statuses: (sessionId: string) => Promise<Record<string, RuntimeStatus>>
      destroy: (params: { sessionId: string; runtimeId: string }) => Promise<{ success: boolean }>
    }
    sshCredential: {
      list: () => Promise<SshCredential[]>
      add: (params: SshCredentialAddParams) => Promise<{ id: string }>
      update: (params: SshCredentialUpdateParams) => Promise<{ success: boolean }>
      delete: (id: string) => Promise<{ success: boolean }>
      listNames: () => Promise<string[]>
    }
    dbCredential: {
      list: () => Promise<Omit<DbCredential, 'password'>[]>
      add: (params: DbCredentialAddParams) => Promise<{ id: string }>
      update: (params: DbCredentialUpdateParams) => Promise<{ success: boolean }>
      delete: (id: string) => Promise<{ success: boolean }>
      testConnection: (
        params: DbCredentialTestParams
      ) => Promise<{ success: boolean; error?: string }>
    }
    subAgent: {
      list: () => Promise<SubAgentInfo[]>
      refresh: () => Promise<{ success: boolean }>
      setEnabled: (params: {
        name: string
        enabled: boolean
      }) => Promise<{ success: boolean; error?: string }>
      openFolder: () => Promise<{ success: boolean }>
    }
    tools: {
      list: (sessionId?: string) => Promise<
        Array<{
          name: string
          label: string
          hint?: string
          group?: string
          defaultEnabled?: boolean
          serverStatus?: 'connected' | 'disconnected' | 'connecting' | 'error'
          isEnabled?: boolean
        }>
      >
      presentations: () => Promise<
        Record<
          string,
          {
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
        >
      >
      definitions: () => Promise<
        Array<{
          name: string
          label: string
          group: string
          icon?: string
          iconColor?: string
          description: string
          parameters: {
            type?: string
            properties?: Record<string, Record<string, unknown>>
            required?: string[]
          }
        }>
      >
    }
    mcpServer: {
      getStatus: () => Promise<McpHostStatus>
      start: () => Promise<McpHostStatus>
      stop: () => Promise<McpHostStatus>
      getTools: () => Promise<McpHostToolDesc[]>
      enableFeature: (feature: string) => Promise<McpHostStatus>
      disableFeature: (feature: string) => Promise<McpHostStatus>
      listLogs: (params?: {
        clientName?: string
        toolName?: string
        limit?: number
      }) => Promise<McpHostLogSummary[]>
      getLog: (id: string) => Promise<
        | {
            id: string
            sessionId: string
            clientName: string
            clientVersion: string
            toolName: string
            arguments: string
            result: string
            isError: number
            durationMs: number
            createdAt: number
          }
        | undefined
      >
      clearLogs: () => Promise<void>
    }
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
      /** 切换指定 session 的分享状态（仅查看） */
      setShared: (params: { sessionId: string; shared: boolean }) => Promise<{ success: boolean }>
      /** 查询单个 session 是否已分享 */
      isShared: (sessionId: string) => Promise<boolean>
      /** 获取所有已分享的 session id 列表 */
      listShared: () => Promise<string[]>
      /** 获取 WebUI 服务器状态 */
      serverStatus: () => Promise<{
        running: boolean
        port?: number
        urls?: string[]
      }>
    }
    telegram: {
      /** 列出所有注册的 Bot（含运行时状态） */
      listBots: () => Promise<TelegramBotInfo[]>
      /** 添加 Bot（自动验证 token） */
      addBot: (params: TelegramBotAddParams) => Promise<TelegramBotInfo>
      /** 更新 Bot 配置 */
      updateBot: (params: TelegramBotUpdateParams) => Promise<{ success: boolean }>
      /** 删除 Bot */
      deleteBot: (id: string) => Promise<{ success: boolean }>
      /** 验证 Bot Token */
      validateToken: (token: string) => Promise<{
        valid: boolean
        username?: string
        id?: number
        error?: string
      }>
      /** 绑定 session 到 bot */
      bindSession: (params: TelegramBindSessionParams) => Promise<{ success: boolean }>
      /** 解绑 session */
      unbindSession: (params: TelegramUnbindSessionParams) => Promise<{ success: boolean }>
      /** 获取 session 绑定的 bot ID */
      getSessionBotId: (sessionId: string) => Promise<string | null>
      /** 启动指定 Bot */
      startBot: (botId: string) => Promise<{ success: boolean }>
      /** 停止指定 Bot */
      stopBot: (botId: string) => Promise<{ success: boolean }>
      /** 获取 Bot 运行状态 */
      getBotStatus: (botId: string) => Promise<{ running: boolean }>
    }
    command: {
      /**
       * 获取斜杠命令列表
       * - sessionId 非空：返回项目命令 + 全部 skill 命令
       * - sessionId 为 null：仅返回不依赖项目的命令（欢迎页等无会话场景）
       */
      list: (params: { sessionId: string | null }) => Promise<
        Array<{
          commandId: string
          name: string
          description: string
          template: string
          filePath: string
        }>
      >
    }
    tts: {
      /** TTS 切片合成 — 每片完成通过 onChunk 事件推送 */
      speakOnce: (params: { text: string }) => Promise<void>
      /** 中止当前 TTS 合成 */
      abortTts: () => Promise<void>
      /** 监听合成片段完成事件 */
      onChunk: (callback: (data: { filePath: string; index: number }) => void) => () => void
      /** 获取 Qwen3 本地 TTS 状态 */
      getQwen3Status: () => Promise<{
        ready: boolean
        hasPython: boolean
        hasDeps: boolean
        hasModel: boolean
        modelSizeMB: number | null
        platformSupported: boolean
      }>
      /** 获取 Qwen3 可用语音列表 */
      getQwen3Voices: () => Promise<
        Array<{ id: string; name: string; language: string; gender: string }>
      >
      /** 安装 Qwen3 本地 TTS 环境 */
      setupQwen3: () => Promise<{ success: boolean }>
      /** 中止 Qwen3 安装 */
      cancelSetupQwen3: () => Promise<{ success: boolean }>
      /** 监听 Qwen3 安装进度 */
      onSetupProgress: (
        callback: (progress: { step: string; messageKey: string; percent: number }) => void
      ) => () => void
    }
    stt: {
      /** 调用 Whisper 转写音频 */
      transcribe: (params: {
        audioData: string
        pcmf32?: string
        language?: string
      }) => Promise<{ text: string }>
      /** 获取本地 Whisper 状态（模型列表） */
      getLocalStatus: () => Promise<{
        models: Array<{
          id: string
          name: string
          sizeMB: number
          description: string
          recommended: boolean
          downloaded: boolean
        }>
      }>
      /** 下载指定模型 */
      downloadModel: (modelId: string) => Promise<{ success: boolean }>
      /** 删除指定模型 */
      deleteModel: (modelId: string) => Promise<{ success: boolean }>
    }
    download: {
      /** 监听下载进度事件 */
      onProgress: (callback: (progress: DownloadProgress) => void) => () => void
      /** 取消下载任务 */
      cancel: (taskId: string) => Promise<{ success: boolean }>
    }
    terminal: {
      create: (params: {
        cwd?: string
        cols?: number
        rows?: number
      }) => Promise<{ terminalId: string }>
      write: (params: { terminalId: string; data: string }) => void
      resize: (params: { terminalId: string; cols: number; rows: number }) => void
      destroy: (terminalId: string) => Promise<{ success: boolean }>
      onData: (callback: (payload: { terminalId: string; data: string }) => void) => () => void
      onExit: (callback: (payload: { terminalId: string; exitCode: number }) => void) => () => void
    }
    browserView: {
      createTab: (url?: string) => Promise<string>
      closeTab: (tabId: string) => Promise<void>
      activateTab: (tabId: string) => Promise<void>
      listTabs: () => Promise<Array<{ id: string; url: string; title: string; active: boolean }>>
      navigate: (tabId: string, url: string) => Promise<void>
      goBack: (tabId: string) => Promise<void>
      goForward: (tabId: string) => Promise<void>
      reload: (tabId: string) => Promise<void>
      stop: (tabId: string) => Promise<void>
      getUrl: (tabId: string) => Promise<string>
      updateBounds: (bounds: { x: number; y: number; width: number; height: number }) => void
      setVisible: (visible: boolean) => void
      onTabCreated: (
        callback: (payload: { tabId: string; url: string; active: boolean }) => void
      ) => () => void
      onTabClosed: (
        callback: (payload: { tabId: string; activeTabId: string | null }) => void
      ) => () => void
      onTabActivated: (callback: (payload: { tabId: string }) => void) => () => void
      onTabTitleUpdated: (
        callback: (payload: { tabId: string; title: string }) => void
      ) => () => void
      onTabFaviconUpdated: (
        callback: (payload: { tabId: string; favicon?: string }) => void
      ) => () => void
      onDidStartLoading: (callback: (payload: { tabId: string; url: string }) => void) => () => void
      onDidNavigate: (callback: (payload: { tabId: string; url: string }) => void) => () => void
      onDidFinishLoad: (callback: (payload: { tabId: string }) => void) => () => void
      onDidFailLoad: (
        callback: (payload: {
          tabId: string
          errorCode: number
          errorDescription: string
          url: string
        }) => void
      ) => () => void
    }
    browserData: {
      listSites: () => Promise<Array<{ host: string; cookieCount: number }>>
      clearSite: (host: string) => Promise<void>
      clearAll: () => Promise<void>
    }
    skill: {
      list: () => Promise<Skill[]>
      listGrouped: () => Promise<SkillGroup[]>
      update: (params: SkillUpdateParams) => Promise<{ success: boolean }>
      deleteDefault: (name: string) => Promise<{ success: boolean }>
      parseMarkdown: (
        text: string
      ) => Promise<{ name: string; description: string; content: string } | null>
      getDefaultDir: () => Promise<string>
      listExternalDirs: () => Promise<SkillDir[]>
      pickExternalDir: () => Promise<{ success: boolean; path?: string; reason?: string }>
      addExternalDir: (dir: SkillDir) => Promise<{ success: boolean; reason?: string }>
      removeExternalDir: (name: string) => Promise<{ success: boolean }>
      setGroupEnabled: (params: {
        dirName: string
        isEnabled: boolean
      }) => Promise<{ success: boolean }>
    }
    hook: {
      list: (opts?: { includeBuiltin?: boolean }) => Promise<ResolvedHook[]>
      status: () => Promise<{ global: HookFileStatus; project: HookFileStatus }>
      reload: () => Promise<{ success: boolean }>
      openConfigFile: (
        scope: 'global' | 'project',
        projectDir?: string
      ) => Promise<{ success: boolean; path?: string; reason?: string }>
    }
    update: {
      /** 检查更新 */
      check: () => Promise<{ success: boolean }>
      /** 开始下载更新 */
      download: () => Promise<{ success: boolean }>
      /** 安装更新并重启 */
      install: () => Promise<{ success: boolean }>
      /** 获取最后一次更新事件（用于新打开的窗口同步状态） */
      getLastEvent: () => Promise<UpdateEvent | null>
      /** 监听更新状态事件，返回取消监听函数 */
      onEvent: (callback: (event: UpdateEvent) => void) => () => void
    }
    contextMenu: {
      popup: (
        request: import('@shuvix/chat-protocol/types/contextMenu').ContextMenuRequest
      ) => Promise<import('@shuvix/chat-protocol/types/contextMenu').ContextMenuResult>
    }
    widget: {
      list: () => Promise<WidgetSummary[]>
      listArchived: () => Promise<WidgetSummary[]>
      open: (
        id: string
      ) => Promise<
        { success: true; url: string; widget: WidgetSummary } | { success: false; error: string }
      >
      rename: (params: {
        id: string
        name: string
        description?: string
      }) => Promise<{ success: boolean }>
      setArchived: (params: { id: string; archived: boolean }) => Promise<{ success: boolean }>
      delete: (id: string) => Promise<{ success: boolean }>
      getServerStatus: () => Promise<{
        running: boolean
        port: number
        widgetCount: number
        registeredIds: string[]
      }>
      stopServer: () => Promise<{ success: boolean }>
      startWidget: (
        id: string
      ) => Promise<
        { success: true; url: string; buildSuccess: boolean } | { success: false; error: string }
      >
      stopWidget: (id: string) => Promise<{ success: true }>
      pickExportTarget: (params: {
        id: string
      }) => Promise<{ success: true; path: string } | { success: false; reason: string }>
      exportAsVite: (params: {
        id: string
        targetPath: string
      }) => Promise<
        | { success: true; zipPath: string; entryCount: number }
        | { success: false; code: string; error: string }
      >
      revealExport: (zipPath: string) => Promise<{ success: true }>
    }
    widgetWindow: {
      /** 在独立窗口打开 widget（已开则聚焦） */
      open: (id: string) => Promise<{ success: true } | { success: false; error: string }>
      /** 关闭指定 widget 的独立窗口 */
      close: (id: string) => Promise<{ success: true }>
      /** 切换独立窗口"始终置顶" */
      setAlwaysOnTop: (params: { id: string; value: boolean }) => Promise<{ alwaysOnTop: boolean }>
      /** 查询独立窗口"始终置顶"状态 */
      getAlwaysOnTop: (id: string) => Promise<{ alwaysOnTop: boolean }>
    }
    files: {
      scan: (params: { sessionId: string }) => Promise<{
        paths: string[]
        truncated: boolean
        root: string | null
      }>
      watch: (params: { sessionId: string; path: string }) => Promise<void>
      unwatch: (params: { sessionId: string; path: string }) => Promise<void>
      read: (params: {
        sessionId: string
        path: string
      }) => Promise<import('@shuvix/chat-protocol/types/filePreview').FileReadResult>
      write: (params: {
        sessionId: string
        path: string
        content: string
      }) => Promise<{ ok: true } | { ok: false; error: string }>
      /** 二进制另存为（图表导出 PNG / SVG）：弹系统保存对话框，落点由用户当场指定 */
      saveAs: (params: {
        defaultPath: string
        dataBase64: string
      }) => Promise<
        { ok: true; path: string } | { ok: false; canceled: true } | { ok: false; error: string }
      >
    }
    preview: {
      /** 图表渲染验证回执（响应 AppEvent 'preview.validateChart'） */
      reportRender: (params: {
        validationId: string
        ok: boolean
        error?: string
      }) => Promise<{ accepted: boolean }>
    }
    wiki: {
      /** 扫描 wiki 根目录下全部 markdown 文件（相对路径，遵循 .gitignore） */
      listFiles: () => Promise<{ paths: string[]; truncated: boolean; root: string }>
      /** 打开 wiki 笔记：一文件至多一笔记本会话，已存在则复用返回 */
      openNote: (params: { path: string }) => Promise<Session>
    }
    events: {
      subscribe: (
        callback: (event: import('@shuvix/chat-protocol/appEvents').AppEvent) => void
      ) => () => void
    }
    pinChat: {
      /** 把指定 session 提到悬浮窗口（已悬浮则 focus） */
      pin: (sessionId: string) => Promise<{ success: boolean }>
      /** 取消指定 session 的悬浮，恢复到主窗口 */
      unpin: (sessionId: string) => Promise<{ success: boolean }>
      /** 聚焦指定 session 的悬浮窗口 */
      focus: (sessionId: string) => Promise<{ success: boolean }>
      /** 主动查询当前所有悬浮会话 */
      getState: () => Promise<{ pinnedSessionIds: string[] }>
      /** 切换悬浮窗"始终置顶"特性,false 即让窗口降为普通窗口 */
      setAlwaysOnTop: (params: {
        sessionId: string
        value: boolean
      }) => Promise<{ alwaysOnTop: boolean }>
      /** 查询当前悬浮窗的"始终置顶"状态 */
      getAlwaysOnTop: (sessionId: string) => Promise<{ alwaysOnTop: boolean }>
    }
  }

  interface WidgetSummary {
    id: string
    name: string
    description: string
    createdAt: number
    updatedAt: number
    lastOpenedAt: number
    archivedAt: number
  }

  interface Window {
    electron: ElectronAPI
    api: ShuviXAPI
  }
} // declare global
