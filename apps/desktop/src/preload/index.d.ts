import { ElectronAPI } from '@electron-toolkit/preload'
import type { LucideIconName, ThemeColor } from '@shuvix/chat-protocol/theme'
import type { ShuvixMdValidation } from '@shuvix/chat-protocol/shuvixMdContract'
import type { KnowledgeEntry, KnowledgeMentionEntry } from '@shuvix/chat-protocol/knowledge'
import type { BgTaskLogChunk } from '@shuvix/chat-protocol/types/bgTask'
import type { TaskInfo } from '@shuvix/chat-protocol/types/task'
import type {
  AgentInitParams,
  AgentInitResult,
  AgentRuntimeInfo,
  AgentPromptParams,
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
  ProviderOAuthStatusInfo,
  ProviderOAuthUiEvent,
  SessionUpdateModelConfigParams,
  SessionUpdateThinkingLevelParams,
  SessionUpdateEnabledToolsParams,
  SessionUpdateKnowledgeBasesParams,
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
  Skill,
  SkillUpdateParams,
  SkillDir,
  SkillGroup,
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

/** 知识库「新建」的回包：失败时 error 是已本地化的人读原因 */
interface KnowledgeCreateReply {
  success: boolean
  /** 新建出来的 id：知识库 / 文件夹是目录 id，条目是条目 id */
  id?: string
  error?: string
}

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
    /** 这个项目里新会话缺省启用哪几个知识库（用户库名 / 保留名 `project`）；没设过 = 全部用户库 + 项目库 */
    knowledgeBases?: string[]
    tool?: ToolSettings
  }

  /** 项目类型 */
  interface Project {
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

  /** 模型相关元数据 */
  interface SessionModelMetadata {
    thinkingLevel?: string
  }

  /** 会话级配置 */
  interface SessionSettings {
    autoAllow?: boolean
    allowList?: string[]
    /** 扩展能力勾选（mcp:/skill:）；只在创建 Agent 时读一次，运行时存在期间只读 */
    enabledTools?: string[]
    /** 子会话被父级钉下的档案名（session 工具 agent_profile）；根会话的档案由形态推导，不读它 */
    agentProfile?: string
  }

  /** 会话类型（对应 DB 表 sessions） */
  interface Session {
    id: string
    title: string
    /** 所属项目 ID（null 表示临时会话） */
    projectId: string | null
    /** 父会话 ID（null = 顶层会话）；非空即子会话，侧栏渲染在父会话下面 */
    parentId: string | null
    provider: string
    model: string
    systemPrompt: string
    modelMetadata: SessionModelMetadata
    /** 会话级配置（SSH 免询问等） */
    settings: SessionSettings
    createdAt: number
    updatedAt: number
    lastActiveAt: number
  }

  /** 会话完整信息（含计算属性） */
  interface SessionInfo extends Session {
    /** 项目工作目录（由后端填充） */
    workingDirectory?: string | null
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
    /** 被同名遮蔽、当前不生效（被用户策略压过的内置，或同名用户文件里没胜出的那几份；仅展示） */
    overridden?: boolean
    /** 压过它的那份用户文件的文件名 */
    overriddenBy?: string
  }

  /**
   * 无法解析的用户策略文件（设置页「无法解析」分组，点开就是它的笔记本）。
   * 身份是文件名 —— 它解析不出 name，删除走 policy.deleteByFile。
   */
  interface InvalidPolicyFile {
    fileName: string
    /** 解析器给出的人读原因（多条以换行连接） */
    error: string
  }

  /** Hook 元信息（文件系统驱动；与主进程 HookListItem 对齐） */
  interface HookInfo {
    name: string
    /** 显示名（shuvix-displayName；缺省 = name） */
    displayName: string
    /** 一句话摘要 */
    description: string
    /** 派发的 agent 名（shuvix-hook-agent） */
    agent: string
    /** 绑定的埋点 id 列表（至少一条） */
    triggers: string[]
    source: 'builtin' | 'user'
    /** 用户文件路径（内置为空串） */
    basePath: string
    /** 被同名遮蔽、当前不生效（被用户 hook 压过的内置，或同名用户文件里没胜出的那几份；仅展示） */
    overridden?: boolean
    /** 压过它的那份用户文件的文件名 */
    overriddenBy?: string
  }

  /** 无法解析的用户 hook 文件（结构非法），删除走 hook.deleteByFile */
  interface InvalidHookFile {
    fileName: string
    /** 人读原因：解析器拒绝原因 */
    error: string
  }

  /**
   * Bot 列表项（`~/.shuvix/bots/<name>.md`）。只有身份三项 —— 没有管线、没有槽位、没有工具与模型
   * （那些由基座档案 `bot` 统一规定）；正文不外传，编辑就是打开它的笔记本会话（bot.openNote）。
   */
  interface BotInfo {
    name: string
    displayName: string
    description: string
    /** 文件路径 */
    basePath: string
    /** bots 目录下的文件名 —— 笔记本会话按它认（名字随编辑在变，文件名不变） */
    fileName: string
  }

  /** 同名的另一份压过了它、当前不生效的 bot 文件（侧栏照常列出，换一种样子；按文件名删除） */
  interface ShadowedBotInfo extends BotInfo {
    /** 压过它的那份文件的文件名 */
    shadowedBy: string
  }

  /** 无法解析的 bot 文件，按文件名打开（bot.openNote）/ 删除（bot.deleteByFile） */
  interface InvalidBotFile {
    fileName: string
    /** 人读原因：解析器的拒绝理由 */
    error: string
  }

  /** 无法解析的用户 agent 档案文件（设置页「无法解析」分组），删除走 subAgent.deleteByFile */
  interface InvalidAgentFile {
    fileName: string
    /** 人读原因：读取失败或解析器的拒绝理由 */
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
    /** 被同名遮蔽、当前不生效（被自定义档案压过的内置，或同名自定义文件里没胜出的那几份；仅设置页展示） */
    overridden?: boolean
    /** 压过它的那份自定义文件的文件名 */
    overriddenBy?: string
    /** 项目指令文件清单（shuvix-instruction-files），顺序即优先级；空 = 不注入 */
    instructionFiles: string[]
    /** 项目感知：是否注入项目提示词与项目记忆索引（shuvix-project-awareness） */
    projectAwareness: boolean
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
      oauthStatus: (id: string) => Promise<ProviderOAuthStatusInfo>
      oauthLogin: (id: string) => Promise<{ success: boolean; error?: string }>
      oauthCancel: (id: string) => Promise<{ success: boolean }>
      oauthLogout: (id: string) => Promise<{ success: boolean }>
      onOAuthEvent: (callback: (event: ProviderOAuthUiEvent) => void) => () => void
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
      /** 改扩展能力勾选；会话已有 Agent 运行时则拒绝（success: false） */
      updateEnabledTools: (params: SessionUpdateEnabledToolsParams) => Promise<{ success: boolean }>
      /** 改这条会话启用的知识库（整份替换）；不锁 —— 改完下一次工具调用就生效 */
      updateKnowledgeBases: (
        params: SessionUpdateKnowledgeBasesParams
      ) => Promise<{ success: boolean }>
      updateAutoAllow: (params: SessionUpdateAutoAllowParams) => Promise<{ success: boolean }>
      removeAllowListEntry: (params: SessionAllowListRemoveParams) => Promise<{ success: boolean }>
      delete: (id: string) => Promise<{ success: boolean }>
      /** 获取单个会话（含计算属性） */
      getById: (id: string) => Promise<SessionInfo | null>
    }
    /** 桌面日历：按 session_day_prompts 开口日查询（扩展无此命名空间） */
    calendar: {
      daysInMonth: (params: { year: number; month: number }) => Promise<string[]>
      sessionsOnDay: (params: { day: string }) => Promise<Session[]>
      firstEntryOnDay: (params: { sessionId: string; day: string }) => Promise<string | null>
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
      /** 目录里无法解析的档案文件（身份是文件名） */
      listInvalid: () => Promise<InvalidAgentFile[]>
      deleteByFile: (params: { fileName: string }) => Promise<{ success: boolean; error?: string }>
      /** md 原文（用户读文件；内置回写等价 md —— 只读查看与覆盖副本初值） */
      getSource: (params: {
        name: string
        source: 'builtin' | 'user'
      }) => Promise<{ text: string } | { error: string }>
      createSource: (params: {
        text: string
      }) => Promise<{ success: boolean; name?: string; error?: string }>
      /** 打开 / 复用一份档案文件的笔记本会话（一文件至多一会话）；回带工作目录 */
      openNote: (params: { fileName: string; title?: string }) => Promise<SessionInfo>
      /**
       * 打开 / 复用一份**内置**档案的只读笔记本 —— 内置 md 随包发布（`Resources/builtin-agents/`），
       * 运行时读的就是它；按名给，当前语言那一版的文件名由主进程挑（与运行时同一次回退）。
       */
      openBuiltinNote: (params: { name: string; title?: string }) => Promise<SessionInfo>
      openFolder: () => Promise<{ success: boolean }>
    }
    policy: {
      list: () => Promise<PolicyInfo[]>
      /** md 原文（用户读文件；内置回写等价 md —— 只读查看与覆盖副本初值） */
      getSource: (params: {
        name: string
        source: 'builtin' | 'user'
      }) => Promise<{ text: string } | { error: string }>
      create: (params: {
        text: string
      }) => Promise<{ success: boolean; name?: string; error?: string }>
      delete: (params: { name: string }) => Promise<{ success: boolean; error?: string }>
      listInvalid: () => Promise<InvalidPolicyFile[]>
      deleteByFile: (params: { fileName: string }) => Promise<{ success: boolean; error?: string }>
      /** 打开 / 复用一份策略文件的笔记本会话（一文件至多一会话）；回带工作目录 */
      openNote: (params: { fileName: string; title?: string }) => Promise<SessionInfo>
      /**
       * 打开 / 复用一份**内置**策略的只读笔记本 —— 内置 md 随包发布（`Resources/builtin-policies/`），
       * 运行时读的就是它；按名给，当前语言那一版的文件名由主进程挑（与运行时同一次回退）。
       */
      openBuiltinNote: (params: { name: string; title?: string }) => Promise<SessionInfo>
      openFolder: () => Promise<{ success: boolean }>
    }
    bot: {
      /** 合法 + 非法两拨一次取齐（侧栏一次扫描就够） */
      list: () => Promise<{
        /** 生效的 bot（同名裁决的胜出者）—— 绑定会话、新建会话、身份胶囊都只认这一拨 */
        bots: BotInfo[]
        /** 被同名压过、当前不生效的那几份（只给侧栏分组列出来） */
        shadowed: ShadowedBotInfo[]
        invalid: InvalidBotFile[]
      }>
      /** 打开 / 复用一份 bot 文件（合法或解析不过都行）的笔记本会话 */
      openNote: (params: { fileName: string; title?: string }) => Promise<SessionInfo>
      /** 按模板新建一份 bot 文件（名字取第一个没被占用的 my-bot / my-bot-2 ……） */
      createNew: () => Promise<{
        success: boolean
        name?: string
        fileName?: string
        error?: string
      }>
      delete: (params: { name: string }) => Promise<{ success: boolean; error?: string }>
      deleteByFile: (params: { fileName: string }) => Promise<{ success: boolean; error?: string }>
      openFolder: () => Promise<{ success: boolean }>
    }
    hook: {
      list: () => Promise<HookInfo[]>
      /** md 原文（用户读文件；内置回 bundle 原文 —— 只读查看与覆盖副本初值） */
      getSource: (params: {
        name: string
        source: 'builtin' | 'user'
      }) => Promise<{ text: string } | { error: string }>
      create: (params: {
        text: string
      }) => Promise<{ success: boolean; name?: string; error?: string }>
      delete: (params: { name: string }) => Promise<{ success: boolean; error?: string }>
      listInvalid: () => Promise<InvalidHookFile[]>
      deleteByFile: (params: { fileName: string }) => Promise<{ success: boolean; error?: string }>
      /** 打开 / 复用一份 hook 文件的笔记本会话（一文件至多一会话）；回带工作目录 */
      openNote: (params: { fileName: string; title?: string }) => Promise<SessionInfo>
      /**
       * 打开 / 复用一份**内置** hook 的只读笔记本 —— 内置 md 随包发布（`Resources/builtin-hooks/`），
       * 运行时读的就是它；按名给，当前语言那一版的文件名由主进程挑（与运行时同一次回退）。
       */
      openBuiltinNote: (params: { name: string; title?: string }) => Promise<SessionInfo>
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
      connect: (id: string) => Promise<{ success: boolean; error?: string }>
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
    download: {
      /** 监听下载进度事件 */
      onProgress: (callback: (progress: DownloadProgress) => void) => () => void
      /** 取消下载任务 */
      cancel: (taskId: string) => Promise<{ success: boolean }>
    }
    bgTask: {
      list: (params: { sessionId: string }) => Promise<TaskInfo[]>
      readLog: (params: {
        toolCallId: string
        fromByte?: number
        maxBytes?: number
      }) => Promise<BgTaskLogChunk>
      stop: (params: { toolCallId: string; force?: boolean }) => Promise<{ success: boolean }>
      dismiss: (params: { toolCallId: string }) => Promise<{ success: boolean }>
      clearDone: (params: { sessionId: string }) => Promise<{ cleared: number }>
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
      listTabs: () => Promise<
        Array<{
          id: string
          url: string
          title: string
          active: boolean
          cdpAttached: boolean
          cdpIntercepting: boolean
        }>
      >
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
      onTabCdpState: (
        callback: (payload: {
          tabId: string
          cdpAttached: boolean
          cdpIntercepting: boolean
        }) => void
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
      /** 打开 / 复用一个技能的 SKILL.md 笔记本（一份文件至多一条会话）；内置那份只读 */
      openNote: (params: { name: string; title?: string }) => Promise<SessionInfo>
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
      scanDir: (params: { sessionId: string; dir: string }) => Promise<{
        files: string[]
        dirs: string[]
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
    }
    knowledge: {
      /** 全部条目（视图形状，不含正文）+ 两个根的绝对路径（root = knowledge-shuvix，userRoot = 用户根）；只读 */
      list: () => Promise<{
        entries: KnowledgeEntry[]
        root: string
        userRoot: string
        /** 库与库内目录的 id（空目录也在其中） */
        dirs: string[]
        /** bundle id → 显示名（项目库：项目当前的名字；内置库：ShuviX） */
        bundleNames: Record<string, string>
        /** bundle id → 绝对目录，只给两个根拼不出来的那些（内置库） */
        bundleDirs: Record<string, string>
      }>
      /** 打开条目笔记：一文件至多一笔记本会话，已存在则复用返回；title 为条目显示名 */
      openNote: (params: { path: string; title?: string }) => Promise<Session>
      /** 打开用户知识库根目录（OS 文件管理器；不存在先建） */
      openFolder: () => Promise<{ success: boolean }>
      /** 在文件夹中显示条目文件（条目 id；落不进任何 bundle 的路径忽略） */
      revealFile: (params: { path: string }) => Promise<{ success: boolean }>
      /** 配置界面用：候选知识库 + 这条会话此刻生效的选择（不给 sessionId 只回候选项） */
      baseOptions: (params?: { sessionId?: string }) => Promise<{
        options: { name: string; label: string }[]
        selected: string[]
        explicit: boolean
      }>
      /** 新建用户知识库（用户根下一个目录）；失败回已本地化的 error */
      createBase: (params: { name: string }) => Promise<KnowledgeCreateReply>
      /** 在某个目录（库本身或库里的一层）下新建文件夹 */
      createFolder: (params: { dir: string; name: string }) => Promise<KnowledgeCreateReply>
      /** 在某个目录下新建条目：元数据由宿主拼，文件名按标题派生 */
      createEntry: (params: { dir: string; title: string }) => Promise<KnowledgeCreateReply>
    }
    /** 聊天输入框 @ 引用多源数据（知识库源候选；文件源走 files.scan） */
    mentions: {
      /** 该会话启用库内的知识条目视图（含 knowledge 工具指针 baseName/bundlePath）；未启用任何库返回空 */
      listKnowledgeEntries: (params: { sessionId: string }) => Promise<KnowledgeMentionEntry[]>
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
