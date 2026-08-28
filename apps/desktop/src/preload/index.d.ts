import { ElectronAPI } from '@electron-toolkit/preload'
import type { LucideIconName, ThemeColor } from '@shuvix/chat-protocol/theme'
import type { ShuvixMdValidation } from '@shuvix/chat-protocol/shuvixMdContract'
import type { BgTaskInfo, BgTaskLogChunk } from '@shuvix/chat-protocol/types/bgTask'
import type {
  AgentInitParams,
  AgentInitResult,
  AgentRuntimeInfo,
  AgentPromptParams,
  AgentNotebookPromptParams,
  AgentSubAgentPromptParams,
  AgentSteerParams,
  AgentFollowUpParams,
  AgentNextTurnParams,
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
  SessionUpdateAutoAllowParams,
  SessionAllowListRemoveParams,
  SubAgentCreateParams,
  SubAgentSaveParams,
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
  interface ChatAssistantMessageEvent extends ChatEventBase {
    type: 'assistant_message'
    messageId: string
    message: string
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
    | ChatAssistantMessageEvent
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

  /** 项目环境变量 */
  interface ProjectEnvVar {
    key: string
    value: string
    sensitive: boolean
  }

  /** 工具扩展配置 */
  interface ToolSettings {
    envVars?: ProjectEnvVar[]
  }

  /** 项目扩展配置 */
  interface ProjectSettings {
    enabledTools?: string[]
    tool?: ToolSettings
  }

  /** 项目类型 */
  interface Project {
    id: string
    name: string
    path: string
    /** 项目提示词（纯文本；经 shuvix-project-prompt 开关注入会话上下文） */
    systemPrompt: string
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
    autoAllow?: boolean
    allowList?: string[]
    /** 会话根 Agent 采用的档案名；缺省 / 档案已不存在 → 回落 'default' */
    agentProfile?: string
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
    /** 会话级配置（SSH 免询问等） */
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
  type AssistantMeta = import('@shuvix/chat-protocol/types/chatMessage').AssistantMeta
  type AssistantBlock = import('@shuvix/chat-protocol/types/chatMessage').AssistantBlock
  type AssistantToolBlock = import('@shuvix/chat-protocol/types/chatMessage').AssistantToolBlock
  type MessageBase = import('@shuvix/chat-protocol/types/chatMessage').MessageBase
  type UserTextMessage = import('@shuvix/chat-protocol/types/chatMessage').UserTextMessage
  type AssistantMessage = import('@shuvix/chat-protocol/types/chatMessage').AssistantMessage
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

  /** 安全策略单条规则（与 agent-runtime security 的 PolicyRuleSpec 对齐，序列化安全） */
  /** 结构化条件（键即 CEL 路径；列表内 OR、字段间 AND，再与 match AND） */
  type PolicyConditionsInfo = Partial<
    Record<'subject.kind' | 'action' | 'object.type' | 'env.host' | 'tool.name', string[]>
  >

  interface PolicyRuleInfo {
    /** 强弱 deny > force-ask > force-allow > ask > allow（force- 压过不带前缀的同名档） */
    effect: 'allow' | 'force-allow' | 'ask' | 'force-ask' | 'deny'
    /** 规则级结构化条件；与策略级 scope 取交后与 match AND */
    conditions?: PolicyConditionsInfo
    /** CEL 匹配表达式（对整份请求文档求值）；省略 = 结构化条件即全部条件 */
    match?: string
  }

  /** 安全策略元信息（文件系统驱动；与主进程 PolicyListItem 对齐） */
  interface PolicyInfo {
    name: string
    /** 显示名（shuvix-displayName；缺省 = name；内置策略按当前界面语言） */
    displayName: string
    /** 一句话摘要（内置策略按当前界面语言） */
    description: string
    /** 策略级共同条件（shuvix-policy-scope）—— AND 进本策略每条规则 */
    scope?: PolicyConditionsInfo
    /** 策略级 let 绑定（名字 → CEL 值表达式，装配时求值、注入规则 match 上下文） */
    lets?: Record<string, string>
    rules: PolicyRuleInfo[]
    /** 正文 —— 纯人读说明（Rationale），引擎不评估 */
    body: string
    source: 'builtin' | 'user'
    /** 用户策略文件路径（内置为空串） */
    basePath: string
    /** 该内置已被同名用户策略遮蔽（仅展示，不生效） */
    overridden?: boolean
  }

  /**
   * 无法解析的用户策略文件（设置页显示为可点开修复的告警项）。
   * 身份是文件名 —— 它解析不出 name，读写走 policy.*ByFile 一组接口。
   */
  interface InvalidPolicyFile {
    fileName: string
    /** 解析器给出的人读原因（多条以换行连接） */
    error: string
  }

  /** Sub-agent 元信息（文件系统驱动；与主进程 AgentProfile 对齐） */
  interface SubAgentInfo {
    name: string
    displayName: string
    description: string
    systemPrompt: string
    tools: string[]
    /** 指定模型（`shuvix-model`）：`<modelId>` 或 `<provider>/<modelId>`；省略 = 跟随会话 */
    model?: string
    /** 该内置已被同名自定义档案遮蔽（仅设置页展示,不生效） */
    overridden?: boolean
    /** 项目指令文件清单（shuvix-instruction-files），顺序即优先级；空 = 不注入 */
    instructionFiles: string[]
    /** 是否注入项目提示词（shuvix-project-prompt） */
    projectPrompt: boolean
    projectMemory: boolean
    /** 只可派发、不可切换为会话档案（shuvix-dispatch-only）；GUI 暂不提供开关,原样透传保存 */
    dispatchOnly: boolean
    source: 'builtin' | 'user'
    basePath: string
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
      subAgentPrompt: (params: AgentSubAgentPromptParams) => Promise<{ success: boolean }>
      subSessionDestroy: (subSessionId: string) => Promise<{ success: boolean }>
      subSessionInterrupt: (subSessionId: string) => Promise<{ success: boolean }>
      steer: (params: AgentSteerParams) => Promise<{ success: boolean }>
      followUp: (params: AgentFollowUpParams) => Promise<{ success: boolean }>
      nextTurn: (params: AgentNextTurnParams) => Promise<{ success: boolean }>
      abort: (sessionId: string) => Promise<{ success: boolean }>
      setModel: (params: AgentSetModelParams) => Promise<{ success: boolean }>
      setThinkingLevel: (params: AgentSetThinkingLevelParams) => Promise<{ success: boolean }>
      /** 读取运行时 Agent 对象的实时信息（systemPrompt/工具/模型）；Agent 未创建返回 null，
       *  传 ensure 则先懒创建（不请求 LLM）再取快照 */
      getInfo: (
        sessionId: string,
        options?: { ensure?: boolean }
      ) => Promise<AgentRuntimeInfo | null>
      /** 智能体监控：全部活跃 agent 运行时快照（含派生 agent）。不遍历会话树，可轮询 */
      monitorList: () => Promise<
        import('@shuvix/chat-protocol/types/agentMonitor').AgentMonitorEntry[]
      >
      /** 智能体监控：单条 agent 的完整运行时快照（系统提示词/工具定义/上下文消息数）。
       *  展开某条时拉一次（要重建上下文，不进轮询）；已销毁的 agentId 返回 null */
      monitorDetail: (agentId: string) => Promise<AgentRuntimeInfo | null>
      /**
       * 统一的"用户输入响应"入口。命令询问 / 选择题 / SSH 凭证 / 用户取消都通过该方法路由。
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
      updateAutoAllow: (params: SessionUpdateAutoAllowParams) => Promise<{ success: boolean }>
      removeAllowListEntry: (params: SessionAllowListRemoveParams) => Promise<{ success: boolean }>
      generateTitle: (params: {
        sessionId: string
        conversationText: string
      }) => Promise<{ title: string | null }>
      delete: (id: string) => Promise<{ success: boolean }>
      /** 获取单个会话（含计算属性） */
      getById: (id: string) => Promise<SessionInfo | null>
      /** 可切换的会话档案（含 default，不含 notebook 基座） */
      listAgentProfiles: () => Promise<
        import('@shuvix/chat-protocol/chatApi').AgentProfileSummary[]
      >
      /**
       * 切换会话根 Agent 的档案（粘性；未知档案名返回 success:false + error）。
       * 档案声明的模型与 mcp:/skill: 工具作为种子写进会话树并经 applied 回传
       * （工具是替换语义；模型不可用时经 modelUnavailable 回传原始值）。
       */
      updateAgentProfile: (params: { id: string; name: string }) => Promise<{
        success: boolean
        error?: string
        applied?: {
          model?: { provider: string; model: string; capabilities: ModelCapabilities }
          tools: string[]
        }
        modelUnavailable?: string
      }>
    }
    message: {
      list: (sessionId: string) => Promise<ChatMessage[]>
      clear: (sessionId: string) => Promise<{ success: boolean }>
      /** 回退到指定消息之前（entry 树 leaf 移到其父节点，使 Agent 失效） */
      rollback: (params: { sessionId: string; messageId: string }) => Promise<{ success: boolean }>
    }
    settings: {
      getAll: () => Promise<Record<string, string>>
      get: (key: string) => Promise<string | undefined>
      set: (params: SettingsSetParams) => Promise<{ success: boolean }>
      /** 获取已知设置 key 的元数据（labelKey + desc） */
      getKnownKeys: () => Promise<Record<string, ConfigMeta>>
      /** 列出全部内置系统提示词卡片 */
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
      save: (params: SubAgentSaveParams) => Promise<{ success: boolean; error?: string }>
      create: (
        params: SubAgentCreateParams
      ) => Promise<{ success: boolean; name?: string; error?: string }>
      delete: (params: { name: string }) => Promise<{ success: boolean; error?: string }>
      getSource: (params: {
        name: string
        source: 'builtin' | 'user'
      }) => Promise<{ text: string } | { error: string }>
      saveSource: (params: {
        originalName: string
        text: string
      }) => Promise<{ success: boolean; error?: string }>
      createSource: (params: {
        text: string
      }) => Promise<{ success: boolean; name?: string; error?: string }>
      openFolder: () => Promise<{ success: boolean }>
    }
    policy: {
      list: () => Promise<PolicyInfo[]>
      getSource: (params: {
        name: string
        source: 'builtin' | 'user'
      }) => Promise<{ text: string } | { error: string }>
      save: (params: {
        originalName: string
        text: string
      }) => Promise<{ success: boolean; error?: string }>
      create: (params: {
        text: string
      }) => Promise<{ success: boolean; name?: string; error?: string }>
      delete: (params: { name: string }) => Promise<{ success: boolean; error?: string }>
      listInvalid: () => Promise<Array<{ fileName: string; error: string }>>
      getSourceByFile: (params: {
        fileName: string
      }) => Promise<{ text: string } | { error: string }>
      saveByFile: (params: {
        fileName: string
        text: string
      }) => Promise<{ success: boolean; error?: string }>
      deleteByFile: (params: { fileName: string }) => Promise<{ success: boolean; error?: string }>
      openFolder: () => Promise<{ success: boolean }>
    }
    shuvixMd: {
      validate: (params: {
        type: string
        text: string
        name?: string
      }) => Promise<ShuvixMdValidation>
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
    telegram: {
      /** 列出所有已登记的 Bot */
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
    bgTask: {
      list: (params: { sessionId: string }) => Promise<BgTaskInfo[]>
      readLog: (params: {
        toolCallId: string
        fromByte?: number
        maxBytes?: number
      }) => Promise<BgTaskLogChunk>
      stop: (params: { toolCallId: string; force?: boolean }) => Promise<{ success: boolean }>
      write: (params: { toolCallId: string; data: string }) => Promise<{ success: boolean }>
      dismiss: (params: { toolCallId: string }) => Promise<{ success: boolean }>
      clearDone: (params: { sessionId: string }) => Promise<{ cleared: number }>
      setNotify: (params: { toolCallId: string; enabled: boolean }) => Promise<{ success: boolean }>
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
      setLayout: (
        entries: Array<{
          tabId: string
          bounds: { x: number; y: number; width: number; height: number }
          zoom?: number
        }>
      ) => void
      capture: (tabId: string) => Promise<string>
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
      onDidStartLoading: (callback: (payload: { tabId: string }) => void) => () => void
      onDidNavigate: (callback: (payload: { tabId: string; url: string }) => void) => () => void
      onDidStopLoading: (callback: (payload: { tabId: string }) => void) => () => void
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
    memory: {
      /** 列出某项目的记忆条目（视图形状，不含正文）；无记忆返回空数组 */
      list: (params: {
        projectId: string
      }) => Promise<import('@shuvix/chat-protocol/types/memory').ProjectMemoryEntry[]>
      /** 打开一条记忆：一条至多一个笔记本会话，已存在则复用；文件已不在返回 null */
      openNote: (params: { projectId: string; slug: string }) => Promise<Session | null>
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

    notification: {
      /** 上报本窗口当前展示的会话（null = 无）；主进程据此判断是否该弹通知 */
      reportActiveSession: (sessionId: string | null) => Promise<{ success: boolean }>
      /** 取走「通知点击时主窗尚未就绪」暂存的跳转目标（取后即清） */
      consumePendingOpenSession: () => Promise<string | null>
      /** 监听通知点击要求打开的会话；返回取消订阅函数 */
      onOpenSession: (callback: (sessionId: string) => void) => () => void
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
