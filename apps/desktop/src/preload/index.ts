import type { ChromeExtensionStatus } from '@shuvix/chat-protocol/chromeBridge'
import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { UpdateEvent } from '../main/types'
import type {
  AgentInitParams,
  AgentPromptParams,
  AgentSubAgentPromptParams,
  AgentSteerParams,
  AgentFollowUpParams,
  AgentNextTurnParams,
  AgentSetModelParams,
  AgentSetThinkingLevelParams,
  HttpLogListParams,
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
  SkillUpdateParams,
  DbCredentialAddParams,
  DbCredentialUpdateParams,
  DbCredentialTestParams,
  TelegramBotAddParams,
  TelegramBotUpdateParams
} from '../main/types'
import type { ChatEvent } from '@shuvix/chat-protocol/events'
import type { KnowledgeEntry, KnowledgeMentionEntry } from '@shuvix/chat-protocol/knowledge'
import type { BgTaskLogChunk } from '@shuvix/chat-protocol/types/bgTask'
import type { TaskInfo } from '@shuvix/chat-protocol/types/task'
import type {
  ConfigSharePayload,
  ExportOptions,
  ExportSnapshot,
  ImportPlan,
  ImportResult,
  ImportSelection
} from '@shuvix/chat-protocol/types/configShare'
import type { ContextMenuRequest } from '@shuvix/chat-protocol/types/contextMenu'
import type { ProjectMemoryEntry } from '@shuvix/chat-protocol/types/memory'
import type { AppEvent } from '@shuvix/chat-protocol/appEvents'

/**
 * AppEvent 扇出：整页只在 'app:event' 通道挂 **一个** ipcRenderer 监听，再派发给本地订阅者集合。
 * 否则每个 events.subscribe（= 每个 useAppEvent）都会新挂一个 ipcRenderer 监听，>10 个并存时触发
 * MaxListenersExceededWarning，且 1:1 累积本身也是浪费。单监听在页面生命周期内常驻，无需回收。
 */
const appEventListeners = new Set<(event: AppEvent) => void>()
let appEventBridged = false
function subscribeAppEvent(callback: (event: AppEvent) => void): () => void {
  if (!appEventBridged) {
    appEventBridged = true
    ipcRenderer.on('app:event', (_e, event: AppEvent) => {
      // 复制一份再派发：回调内退订不影响本轮
      for (const cb of [...appEventListeners]) {
        try {
          cb(event)
        } catch {
          /* 单个订阅者抛错不影响其它 */
        }
      }
    })
  }
  appEventListeners.add(callback)
  return () => {
    appEventListeners.delete(callback)
  }
}

/** browserView 事件订阅辅助：单 payload 透传 + 返回 cleanup */
function onBrowserViewEvent<T>(channel: string, callback: (payload: T) => void): () => void {
  const handler = (_: unknown, payload: T): void => callback(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

/** 暴露给 Renderer 的 API */
/** 知识库「新建」的回包：失败时 error 是已本地化的人读原因 */
interface KnowledgeCreateReply {
  success: boolean
  /** 新建出来的 id：知识库 / 文件夹是目录 id，条目是条目 id */
  id?: string
  error?: string
}

const api = {
  // ============ 应用事件 ============
  app: {
    /** 当前运行平台 */
    platform: process.platform as 'darwin' | 'win32' | 'linux',
    /** 打开独立设置窗口（可指定初始 tab，如 'providers'） */
    openSettings: (tab?: string) => ipcRenderer.invoke('app:open-settings', tab),
    /** 用系统默认浏览器打开外部链接 */
    openExternal: (url: string) => ipcRenderer.invoke('app:open-external', url),
    /** 用系统文件管理器打开指定文件夹 */
    openFolder: (folderPath: string) => ipcRenderer.invoke('app:open-folder', folderPath),
    revealPath: (filePath: string) => ipcRenderer.invoke('app:reveal-path', filePath),
    /** 通知主进程渲染已就绪，可以显示窗口 */
    windowReady: () => ipcRenderer.send('app:window-ready'),
    /** 调整主窗口宽度（delta > 0 变宽，< 0 变窄） */
    adjustWindowWidth: (delta: number) => ipcRenderer.invoke('app:adjust-window-width', delta),
    /** 设置浏览器面板宽度偏移（保存窗口尺寸时扣除） */
    setBrowserOffset: (offset: number) => ipcRenderer.invoke('app:set-browser-offset', offset),
    /** 监听菜单栏「新建对话」 */
    onNewChat: (callback: () => void) => {
      const handler = (): void => callback()
      ipcRenderer.on('app:new-chat', handler)
      return () => ipcRenderer.removeListener('app:new-chat', handler)
    },
    /** 监听菜单栏「新建项目」 */
    onNewProject: (callback: () => void) => {
      const handler = (): void => callback()
      ipcRenderer.on('app:new-project', handler)
      return () => ipcRenderer.removeListener('app:new-project', handler)
    }
  },

  // ============ Agent 操作 ============
  agent: {
    /** 初始化 Agent */
    init: (params: AgentInitParams) => ipcRenderer.invoke('agent:init', params),

    /** 向指定 session 发送消息 */
    prompt: (params: AgentPromptParams) => ipcRenderer.invoke('agent:prompt', params),

    /** 继续与已存在子代理对话：追加一轮用户消息 */
    subAgentPrompt: (params: AgentSubAgentPromptParams) =>
      ipcRenderer.invoke('agent:subAgentPrompt', params),

    /** 销毁子会话 — 中止运行中的 Agent 并清理服务端 registry */
    subSessionDestroy: (subSessionId: string) =>
      ipcRenderer.invoke('subSession:destroy', subSessionId),

    /** 中断子会话 — 软停止生成、保留部分结果，子会话以「已完成」收尾 */
    subSessionInterrupt: (subSessionId: string) =>
      ipcRenderer.invoke('subSession:interrupt', subSessionId),

    /** 向运行中的 Agent 发送 steer 消息（引导/纠正方向） */
    steer: (params: AgentSteerParams) => ipcRenderer.invoke('agent:steer', params),
    /** 本轮本应结束时续跑同一次运行（pi followUp 队列） */
    followUp: (params: AgentFollowUpParams) => ipcRenderer.invoke('agent:followUp', params),
    /** 排队到下一次 prompt 之前（pi nextTurn 队列；不被 abort 清空） */
    nextTurn: (params: AgentNextTurnParams) => ipcRenderer.invoke('agent:nextTurn', params),

    /** 中止指定 session 的生成 */
    abort: (sessionId: string) => ipcRenderer.invoke('agent:abort', sessionId),

    /** 切换模型 */
    setModel: (params: AgentSetModelParams) => ipcRenderer.invoke('agent:setModel', params),

    /** 设置思考深度 */
    setThinkingLevel: (params: AgentSetThinkingLevelParams) =>
      ipcRenderer.invoke('agent:setThinkingLevel', params),

    /** 读取运行时 Agent 对象的实时信息（systemPrompt/工具/模型）；Agent 未创建返回 null，
     *  传 ensure 则先懒创建（不请求 LLM）再取快照 */
    getInfo: (sessionId: string, options?: { ensure?: boolean }) =>
      ipcRenderer.invoke('agent:getInfo', sessionId, options),

    /**
     * 智能体监控：全部活跃 agent 运行时快照（含派生 agent）。
     * 只读 pi 原生 getter + 注册中心的事件影子，不遍历会话树，可轮询。
     */
    monitorList: (): Promise<
      import('@shuvix/chat-protocol/types/agentMonitor').AgentMonitorEntry[]
    > => ipcRenderer.invoke('agentMonitor:list'),

    /**
     * 智能体监控：单条 agent 的完整运行时快照（系统提示词 / 工具定义 / 上下文消息数）。
     * 展开某条时拉一次 —— 要重建上下文，不进轮询列表。已销毁的 agentId 返回 null。
     */
    monitorDetail: (
      agentId: string
    ): Promise<import('@shuvix/chat-protocol/chatApi').AgentRuntimeInfo | null> =>
      ipcRenderer.invoke('agentMonitor:detail', agentId),

    /**
     * 统一的"用户输入响应"入口。
     * 命令询问 / 选择题 / SSH 凭证 / 用户取消都通过该方法路由到对应的工具挂起 Promise。
     */
    respondToInput: (params: {
      sessionId: string
      requestId: string
      response: import('@shuvix/chat-protocol/types/inputRequest').InputResponse
    }) => ipcRenderer.invoke('agent:respondToInput', params),

    /** 监听 Agent 事件流 */
    onEvent: (callback: (event: ChatEvent) => void) => {
      const handler = (_: Electron.IpcRendererEvent, event: ChatEvent): void => callback(event)
      ipcRenderer.on('agent:event', handler)
      return () => ipcRenderer.removeListener('agent:event', handler)
    }
  },

  // ============ 提供商管理 ============
  provider: {
    listAll: () => ipcRenderer.invoke('provider:listAll'),
    listEnabled: () => ipcRenderer.invoke('provider:listEnabled'),
    getById: (id: string) => ipcRenderer.invoke('provider:getById', id),
    updateConfig: (params: ProviderUpdateConfigParams) =>
      ipcRenderer.invoke('provider:updateConfig', params),
    toggleEnabled: (params: ProviderToggleEnabledParams) =>
      ipcRenderer.invoke('provider:toggleEnabled', params),
    listModels: (providerId: string) => ipcRenderer.invoke('provider:listModels', providerId),
    listAvailableModels: () => ipcRenderer.invoke('provider:listAvailableModels'),
    toggleModelEnabled: (params: ProviderToggleModelEnabledParams) =>
      ipcRenderer.invoke('provider:toggleModelEnabled', params),
    syncModels: (params: ProviderSyncModelsParams) =>
      ipcRenderer.invoke('provider:syncModels', params),
    add: (params: ProviderAddParams) => ipcRenderer.invoke('provider:add', params),
    delete: (params: ProviderDeleteParams) => ipcRenderer.invoke('provider:delete', params),
    addModel: (params: ProviderAddModelParams) => ipcRenderer.invoke('provider:addModel', params),
    deleteModel: (id: string) => ipcRenderer.invoke('provider:deleteModel', id),
    updateModelCapabilities: (params: ProviderUpdateModelCapabilitiesParams) =>
      ipcRenderer.invoke('provider:updateModelCapabilities', params),

    // ---- 订阅登录（OAuth）----
    oauthStatus: (id: string) => ipcRenderer.invoke('provider:oauthStatus', id),
    /** 发起设备码登录：Promise 一直挂到用户批准/超时/取消 */
    oauthLogin: (id: string) => ipcRenderer.invoke('provider:oauthLogin', id),
    oauthCancel: (id: string) => ipcRenderer.invoke('provider:oauthCancel', id),
    oauthLogout: (id: string) => ipcRenderer.invoke('provider:oauthLogout', id),
    /** 监听登录过程事件（设备码、进度） */
    onOAuthEvent: (callback: (event: ProviderOAuthUiEvent) => void) => {
      const handler = (_: Electron.IpcRendererEvent, event: ProviderOAuthUiEvent): void =>
        callback(event)
      ipcRenderer.on('provider:oauth-event', handler)
      return () => ipcRenderer.removeListener('provider:oauth-event', handler)
    }
  },

  // ============ 项目管理 ============
  project: {
    list: () => ipcRenderer.invoke('project:list'),
    listArchived: () => ipcRenderer.invoke('project:listArchived'),
    getById: (id: string) => ipcRenderer.invoke('project:getById', id),
    create: (params: ProjectCreateParams) => ipcRenderer.invoke('project:create', params),
    update: (params: ProjectUpdateParams) => ipcRenderer.invoke('project:update', params),
    delete: (params: ProjectDeleteParams) => ipcRenderer.invoke('project:delete', params),
    /** 获取已知项目字段的元数据（labelKey + desc） */
    getKnownFields: () => ipcRenderer.invoke('project:getKnownFields')
    // 项目变更订阅已并入 events.subscribe（AppEvent 'project.changed'）
  },

  // ============ 会话管理 ============
  session: {
    list: () => ipcRenderer.invoke('session:list'),
    create: (params?: SessionCreateParams) => ipcRenderer.invoke('session:create', params),
    updateTitle: (params: SessionUpdateTitleParams) =>
      ipcRenderer.invoke('session:updateTitle', params),
    updateModelConfig: (params: SessionUpdateModelConfigParams) =>
      ipcRenderer.invoke('session:updateModelConfig', params),
    updateProject: (params: SessionUpdateProjectParams) =>
      ipcRenderer.invoke('session:updateProject', params),
    updateThinkingLevel: (params: SessionUpdateThinkingLevelParams) =>
      ipcRenderer.invoke('session:updateThinkingLevel', params),
    /** 改扩展能力勾选；会话已有 Agent 运行时则拒绝（success: false） */
    updateEnabledTools: (params: SessionUpdateEnabledToolsParams) =>
      ipcRenderer.invoke('session:updateEnabledTools', params),
    /** 改这条会话启用的知识库（整份替换）；不锁 —— 改完下一次工具调用就生效 */
    updateKnowledgeBases: (params: SessionUpdateKnowledgeBasesParams) =>
      ipcRenderer.invoke('session:updateKnowledgeBases', params),
    updateAutoAllow: (params: SessionUpdateAutoAllowParams) =>
      ipcRenderer.invoke('session:updateAutoAllow', params),
    removeAllowListEntry: (params: SessionAllowListRemoveParams) =>
      ipcRenderer.invoke('session:removeAllowListEntry', params),
    delete: (id: string) => ipcRenderer.invoke('session:delete', id),
    /** 获取单个会话（含 workingDirectory） */
    getById: (id: string) => ipcRenderer.invoke('session:getById', id)
    // 配置变更订阅已并入 events.subscribe（AppEvent 'session.configChanged'）
  },

  // ============ 桌面日历（session_day_prompts：同一会话可出现在多个开口日） ============
  calendar: {
    daysInMonth: (params: { year: number; month: number }) =>
      ipcRenderer.invoke('calendar:daysInMonth', params) as Promise<string[]>,
    sessionsOnDay: (params: { day: string }) =>
      ipcRenderer.invoke('calendar:sessionsOnDay', params),
    firstEntryOnDay: (params: { sessionId: string; day: string }) =>
      ipcRenderer.invoke('calendar:firstEntryOnDay', params) as Promise<string | null>
  },

  // ============ 消息管理 ============
  message: {
    list: (sessionId: string) => ipcRenderer.invoke('message:list', sessionId),

    clear: (sessionId: string) => ipcRenderer.invoke('message:clear', sessionId),
    rollback: (params: { sessionId: string; messageId: string }) =>
      ipcRenderer.invoke('message:rollback', params)
  },

  // ============ 设置管理 ============
  settings: {
    getAll: () => ipcRenderer.invoke('settings:getAll'),
    get: (key: string) => ipcRenderer.invoke('settings:get', key),
    set: (params: SettingsSetParams) => ipcRenderer.invoke('settings:set', params),
    /** 获取已知设置 key 的元数据（labelKey + desc） */
    getKnownKeys: () => ipcRenderer.invoke('settings:getKnownKeys')
    /** 列出全部内置系统提示词卡片 */
  },

  // ============ HTTP 日志 ============
  httpLog: {
    list: (params?: HttpLogListParams) => ipcRenderer.invoke('httpLog:list', params),
    get: (id: string) => ipcRenderer.invoke('httpLog:get', id),
    clear: () => ipcRenderer.invoke('httpLog:clear')
  },

  // ============ Runtime (统一资源) ============
  runtime: {
    statuses: (sessionId: string) => ipcRenderer.invoke('runtime:statuses', sessionId),
    destroy: (params: { sessionId: string; runtimeId: string }) =>
      ipcRenderer.invoke('runtime:destroy', params)
  },

  // ============ SSH 凭据管理 ============

  // ============ 数据库凭据管理 ============
  dbCredential: {
    list: () => ipcRenderer.invoke('dbCredential:list'),
    add: (params: DbCredentialAddParams) => ipcRenderer.invoke('dbCredential:add', params),
    update: (params: DbCredentialUpdateParams) => ipcRenderer.invoke('dbCredential:update', params),
    delete: (id: string) => ipcRenderer.invoke('dbCredential:delete', id),
    testConnection: (params: DbCredentialTestParams) =>
      ipcRenderer.invoke('dbCredential:testConnection', params)
  },

  // ============ 子智能体（文件系统驱动；用户档案的编辑是它的笔记本会话） ============
  subAgent: {
    list: () => ipcRenderer.invoke('subAgent:list'),
    save: (params: SubAgentSaveParams) => ipcRenderer.invoke('subAgent:save', params),
    create: (params: SubAgentCreateParams) => ipcRenderer.invoke('subAgent:create', params),
    delete: (params: { name: string }) => ipcRenderer.invoke('subAgent:delete', params),
    listInvalid: () => ipcRenderer.invoke('subAgent:listInvalid'),
    deleteByFile: (params: { fileName: string }) =>
      ipcRenderer.invoke('subAgent:deleteByFile', params),
    getSource: (params: { name: string; source: 'builtin' | 'user' }) =>
      ipcRenderer.invoke('subAgent:getSource', params),
    createSource: (params: { text: string }) => ipcRenderer.invoke('subAgent:createSource', params),
    openNote: (params: { fileName: string; title?: string }) =>
      ipcRenderer.invoke('subAgent:openNote', params),
    /** 内置档案的只读笔记本（随包发布的那份 md —— 运行时读的就是它） */
    openBuiltinNote: (params: { name: string; title?: string }) =>
      ipcRenderer.invoke('subAgent:openBuiltinNote', params),
    openFolder: () => ipcRenderer.invoke('subAgent:openFolder')
  },

  // ============ 安全策略（文件系统驱动；用户策略的编辑是它的笔记本会话） ============
  policy: {
    list: () => ipcRenderer.invoke('policy:list'),
    getSource: (params: { name: string; source: 'builtin' | 'user' }) =>
      ipcRenderer.invoke('policy:getSource', params),
    create: (params: { text: string }) => ipcRenderer.invoke('policy:create', params),
    delete: (params: { name: string }) => ipcRenderer.invoke('policy:delete', params),
    listInvalid: () => ipcRenderer.invoke('policy:listInvalid'),
    deleteByFile: (params: { fileName: string }) =>
      ipcRenderer.invoke('policy:deleteByFile', params),
    openNote: (params: { fileName: string; title?: string }) =>
      ipcRenderer.invoke('policy:openNote', params),
    /** 内置策略的只读笔记本（随包发布的那份 md —— 运行时读的就是它） */
    openBuiltinNote: (params: { name: string; title?: string }) =>
      ipcRenderer.invoke('policy:openBuiltinNote', params),
    openFolder: () => ipcRenderer.invoke('policy:openFolder')
  },

  // ============ Hooks（文件系统驱动；用户 hook 的编辑是它的笔记本会话；无启用开关） ============
  hook: {
    list: () => ipcRenderer.invoke('hook:list'),
    getSource: (params: { name: string; source: 'builtin' | 'user' }) =>
      ipcRenderer.invoke('hook:getSource', params),
    create: (params: { text: string }) => ipcRenderer.invoke('hook:create', params),
    delete: (params: { name: string }) => ipcRenderer.invoke('hook:delete', params),
    listInvalid: () => ipcRenderer.invoke('hook:listInvalid'),
    deleteByFile: (params: { fileName: string }) => ipcRenderer.invoke('hook:deleteByFile', params),
    openNote: (params: { fileName: string; title?: string }) =>
      ipcRenderer.invoke('hook:openNote', params),
    /** 内置 hook 的只读笔记本（随包发布的那份 md —— 运行时读的就是它） */
    openBuiltinNote: (params: { name: string; title?: string }) =>
      ipcRenderer.invoke('hook:openBuiltinNote', params),
    openFolder: () => ipcRenderer.invoke('hook:openFolder')
  },

  // ============ Bots（文件系统驱动；打开一份 bot 就是打开它的笔记本会话；无启用开关） ============
  bot: {
    list: () => ipcRenderer.invoke('bot:list'),
    openNote: (params: { fileName: string; title?: string }) =>
      ipcRenderer.invoke('bot:openNote', params),
    createNew: () => ipcRenderer.invoke('bot:createNew'),
    delete: (params: { name: string }) => ipcRenderer.invoke('bot:delete', params),
    deleteByFile: (params: { fileName: string }) => ipcRenderer.invoke('bot:deleteByFile', params),
    openFolder: () => ipcRenderer.invoke('bot:openFolder')
  },

  // ============ shuvix 契约 md 校验（frontmatter 属性卡） ============
  shuvixMd: {
    validate: (params: { type: string; text: string; name?: string }) =>
      ipcRenderer.invoke('shuvixMd:validate', params)
  },

  // ============ 工具 ============
  tools: {
    list: (sessionId?: string) => ipcRenderer.invoke('tools:list', sessionId),
    presentations: () => ipcRenderer.invoke('tools:presentations'),
    definitions: () => ipcRenderer.invoke('tools:definitions')
  },

  // ============ 配置导出/导入 ============
  config: {
    /** 构建 Dialog 渲染用的"已开启候选集" */
    buildExportSnapshot: (): Promise<ExportSnapshot> =>
      ipcRenderer.invoke('config:buildExportSnapshot'),
    /** 按用户勾选构建并编码 payload */
    buildExportPayload: (options: ExportOptions): Promise<string> =>
      ipcRenderer.invoke('config:buildExportPayload', options),
    /** 解码并校验粘贴的分享串 */
    parseImportPayload: (encoded: string): Promise<ConfigSharePayload> =>
      ipcRenderer.invoke('config:parseImportPayload', encoded),
    /** 预计算每项将执行的动作 */
    planImport: (payload: ConfigSharePayload): Promise<ImportPlan> =>
      ipcRenderer.invoke('config:planImport', payload),
    /** 执行导入 */
    applyImport: (params: {
      payload: ConfigSharePayload
      selection: ImportSelection
    }): Promise<ImportResult> => ipcRenderer.invoke('config:applyImport', params)
  },

  // ============ MCP 客户端管理 ============
  mcp: {
    /** 列出所有 MCP Server（含运行时状态） */
    list: () => ipcRenderer.invoke('mcp:list'),
    /** 添加 MCP Server */
    add: (params: McpServerAddParams) => ipcRenderer.invoke('mcp:add', params),
    /** 更新 MCP Server 配置 */
    update: (params: McpServerUpdateParams) => ipcRenderer.invoke('mcp:update', params),
    /** 删除 MCP Server */
    delete: (id: string) => ipcRenderer.invoke('mcp:delete', id),
    /** 手动连接 */
    connect: (id: string) => ipcRenderer.invoke('mcp:connect', id),
    /** 手动断开 */
    disconnect: (id: string) => ipcRenderer.invoke('mcp:disconnect', id),
    /** 获取指定 server 已发现的工具列表 */
    getTools: (id: string) => ipcRenderer.invoke('mcp:getTools', id)
  },

  // ============ Telegram Bot（多 Bot） ============
  telegram: {
    /** 列出所有注册的 Bot（含运行时状态） */
    listBots: () => ipcRenderer.invoke('telegram:listBots'),
    /** 添加 Bot（自动验证 token） */
    addBot: (params: TelegramBotAddParams) => ipcRenderer.invoke('telegram:addBot', params),
    /** 更新 Bot 配置 */
    updateBot: (params: TelegramBotUpdateParams) =>
      ipcRenderer.invoke('telegram:updateBot', params),
    /** 删除 Bot */
    deleteBot: (id: string) => ipcRenderer.invoke('telegram:deleteBot', id),
    /** 验证 Bot Token */
    validateToken: (token: string) => ipcRenderer.invoke('telegram:validateToken', token)
  },

  // ============ 斜杠命令 ============
  command: {
    /**
     * 获取斜杠命令列表
     * - sessionId 非空：返回项目命令 + 全部 skill 命令
     * - sessionId 为 null：仅返回不依赖项目的命令（欢迎页等无会话场景）
     */
    list: (params: { sessionId: string | null }) => ipcRenderer.invoke('command:list', params)
  },

  // ============ 文字转语音 ============
  tts: {
    /** TTS 切片合成 — 每片完成通过 onChunk 事件推送 */
    speakOnce: (params: { text: string }) =>
      ipcRenderer.invoke('tts:speakOnce', params) as Promise<void>,
    /** 中止当前 TTS 合成 */
    abortTts: () => ipcRenderer.invoke('tts:abort') as Promise<void>,
    /** 监听合成片段完成事件 */
    onChunk: (callback: (data: { filePath: string; index: number }) => void) => {
      const handler = (
        _: Electron.IpcRendererEvent,
        data: { filePath: string; index: number }
      ): void => callback(data)
      ipcRenderer.on('tts:chunk', handler)
      return (): void => {
        ipcRenderer.removeListener('tts:chunk', handler)
      }
    },
    /** 获取 Qwen3 本地 TTS 状态 */
    getQwen3Status: () => ipcRenderer.invoke('tts:getQwen3Status'),
    /** 获取 Qwen3 可用语音列表 */
    getQwen3Voices: () => ipcRenderer.invoke('tts:getQwen3Voices'),
    /** 安装 Qwen3 本地 TTS 环境（Python + 依赖 + 模型） */
    setupQwen3: () => ipcRenderer.invoke('tts:setupQwen3'),
    /** 中止 Qwen3 安装 */
    cancelSetupQwen3: () => ipcRenderer.invoke('tts:cancelSetupQwen3'),
    /** 监听 Qwen3 安装进度 */
    onSetupProgress: (
      callback: (progress: { step: string; messageKey: string; percent: number }) => void
    ) => {
      const handler = (
        _: Electron.IpcRendererEvent,
        progress: { step: string; messageKey: string; percent: number }
      ): void => callback(progress)
      ipcRenderer.on('tts:setupProgress', handler)
      return (): void => {
        ipcRenderer.removeListener('tts:setupProgress', handler)
      }
    }
  },

  // ============ 下载管理 ============
  download: {
    /** 监听下载进度事件 */
    onProgress: (
      callback: (progress: {
        taskId: string
        percent: number
        downloadedBytes: number
        totalBytes: number
        speedBytesPerSec: number
        etaSeconds: number
      }) => void
    ) => {
      const handler = (
        _: Electron.IpcRendererEvent,
        progress: {
          taskId: string
          percent: number
          downloadedBytes: number
          totalBytes: number
          speedBytesPerSec: number
          etaSeconds: number
        }
      ): void => callback(progress)
      ipcRenderer.on('download:progress', handler)
      return () => ipcRenderer.removeListener('download:progress', handler)
    },
    /** 取消下载任务 */
    cancel: (taskId: string) => ipcRenderer.invoke('download:cancel', taskId)
  },

  // ============ 后台任务 (bash run_in_background) ============
  // 只有只读面 + 管理动作，没有输出流通道 —— 输出在日志文件里，用 readLog 按字节范围轮询。
  bgTask: {
    list: (params: { sessionId: string }) =>
      ipcRenderer.invoke('bgTask:list', params) as Promise<TaskInfo[]>,
    readLog: (params: { toolCallId: string; fromByte?: number; maxBytes?: number }) =>
      ipcRenderer.invoke('bgTask:readLog', params) as Promise<BgTaskLogChunk>,
    stop: (params: { toolCallId: string; force?: boolean }) =>
      ipcRenderer.invoke('bgTask:stop', params) as Promise<{ success: boolean }>,
    dismiss: (params: { toolCallId: string }) =>
      ipcRenderer.invoke('bgTask:dismiss', params) as Promise<{ success: boolean }>,
    clearDone: (params: { sessionId: string }) =>
      ipcRenderer.invoke('bgTask:clearDone', params) as Promise<{ cleared: number }>
  },

  // ============ Terminal (node-pty) ============
  terminal: {
    create: (params: { cwd?: string; cols?: number; rows?: number }) =>
      ipcRenderer.invoke('terminal:create', params) as Promise<{ terminalId: string }>,
    write: (params: { terminalId: string; data: string }) =>
      ipcRenderer.send('terminal:write', params),
    resize: (params: { terminalId: string; cols: number; rows: number }) =>
      ipcRenderer.send('terminal:resize', params),
    destroy: (terminalId: string) => ipcRenderer.invoke('terminal:destroy', terminalId),
    onData: (callback: (payload: { terminalId: string; data: string }) => void) => {
      const handler = (
        _: Electron.IpcRendererEvent,
        payload: { terminalId: string; data: string }
      ): void => callback(payload)
      ipcRenderer.on('terminal:data', handler)
      return () => ipcRenderer.removeListener('terminal:data', handler)
    },
    onExit: (callback: (payload: { terminalId: string; exitCode: number }) => void) => {
      const handler = (
        _: Electron.IpcRendererEvent,
        payload: { terminalId: string; exitCode: number }
      ): void => callback(payload)
      ipcRenderer.on('terminal:exit', handler)
      return () => ipcRenderer.removeListener('terminal:exit', handler)
    }
  },

  // ============ Browser WebContentsView（多 tab） ============
  browserView: {
    // ---- tab 生命周期 ----
    createTab: (url?: string) =>
      ipcRenderer.invoke('browser-view:create-tab', url) as Promise<string>,
    closeTab: (tabId: string) => ipcRenderer.invoke('browser-view:close-tab', tabId),
    activateTab: (tabId: string) => ipcRenderer.invoke('browser-view:activate-tab', tabId),
    listTabs: () =>
      ipcRenderer.invoke('browser-view:list-tabs') as Promise<
        Array<{
          id: string
          url: string
          title: string
          active: boolean
          cdpAttached: boolean
          cdpIntercepting: boolean
        }>
      >,
    // ---- 导航（按 tab） ----
    navigate: (tabId: string, url: string) =>
      ipcRenderer.invoke('browser-view:navigate', tabId, url),
    goBack: (tabId: string) => ipcRenderer.invoke('browser-view:go-back', tabId),
    goForward: (tabId: string) => ipcRenderer.invoke('browser-view:go-forward', tabId),
    reload: (tabId: string) => ipcRenderer.invoke('browser-view:reload', tabId),
    stop: (tabId: string) => ipcRenderer.invoke('browser-view:stop', tabId),
    getUrl: (tabId: string) => ipcRenderer.invoke('browser-view:get-url', tabId) as Promise<string>,
    // ---- 布局（一次提交全部同屏 tab；未列出的 tab 会被隐藏） ----
    setLayout: (
      entries: Array<{
        tabId: string
        bounds: { x: number; y: number; width: number; height: number }
        zoom?: number
      }>
    ) => ipcRenderer.send('browser-view:set-layout', entries),
    /** 抓 tab 当前画面（dataURL；平铺墙滚动时的占位图） */
    capture: (tabId: string) =>
      ipcRenderer.invoke('browser-view:capture', tabId) as Promise<string>,
    setVisible: (visible: boolean) => ipcRenderer.send('browser-view:set-visible', visible),
    // ---- 事件（payload 均带 tabId，返回 cleanup） ----
    onTabCreated: (callback: (payload: { tabId: string; url: string; active: boolean }) => void) =>
      onBrowserViewEvent('browser-view:tab-created', callback),
    onTabClosed: (callback: (payload: { tabId: string; activeTabId: string | null }) => void) =>
      onBrowserViewEvent('browser-view:tab-closed', callback),
    onTabActivated: (callback: (payload: { tabId: string }) => void) =>
      onBrowserViewEvent('browser-view:tab-activated', callback),
    onTabTitleUpdated: (callback: (payload: { tabId: string; title: string }) => void) =>
      onBrowserViewEvent('browser-view:tab-title-updated', callback),
    onTabFaviconUpdated: (callback: (payload: { tabId: string; favicon?: string }) => void) =>
      onBrowserViewEvent('browser-view:tab-favicon-updated', callback),
    /** tab 的 CDP 状态变化（agent 接入/断开、请求拦截开/关）——卡片上的 AI 标识 */
    onTabCdpState: (
      callback: (payload: { tabId: string; cdpAttached: boolean; cdpIntercepting: boolean }) => void
    ) => onBrowserViewEvent('browser-view:tab-cdp-state', callback),
    /** tab spinner 开始转（Chromium 加载位置真） */
    onDidStartLoading: (callback: (payload: { tabId: string }) => void) =>
      onBrowserViewEvent('browser-view:did-start-loading', callback),
    /** tab URL 变化（导航开始 / 提交 / 页内跳转） */
    onDidNavigate: (callback: (payload: { tabId: string; url: string }) => void) =>
      onBrowserViewEvent('browser-view:did-navigate', callback),
    /** tab spinner 停转（成功/失败/中止/崩溃都会到） */
    onDidStopLoading: (callback: (payload: { tabId: string }) => void) =>
      onBrowserViewEvent('browser-view:did-stop-loading', callback),
    /** tab 加载失败（含证书错误、DNS 错误等） */
    onDidFailLoad: (
      callback: (payload: {
        tabId: string
        errorCode: number
        errorDescription: string
        url: string
      }) => void
    ) => onBrowserViewEvent('browser-view:did-fail-load', callback)
  },

  // ============ Chrome 扩展（侧边栏会话 + 用户的 Chrome） ============
  chromeExtension: {
    /** 桥服务在不在听、连着哪些浏览器、最近一次装本地组件的结果 */
    status: () => ipcRenderer.invoke('chromeExtension:status') as Promise<ChromeExtensionStatus>,
    /** 重装本地组件（原生消息宿主的启动脚本 + 各浏览器的清单），回新的状态 */
    repair: () => ipcRenderer.invoke('chromeExtension:repair') as Promise<ChromeExtensionStatus>
  },

  // ============ Browser 分区数据 ============
  browserData: {
    /** 列出内置浏览器分区中"写过 cookie 的 host"，按字母序 */
    listSites: () =>
      ipcRenderer.invoke('browser-data:list-sites') as Promise<
        Array<{ host: string; cookieCount: number }>
      >,
    /** 清除指定 host 的全部存储数据（cookies / localStorage / IndexedDB / cache） */
    clearSite: (host: string) =>
      ipcRenderer.invoke('browser-data:clear-site', host) as Promise<void>,
    /** 清除浏览器分区下全部数据（所有 origin） */
    clearAll: () => ipcRenderer.invoke('browser-data:clear-all') as Promise<void>
  },

  // ============ Skill 管理 ============
  skill: {
    /** 打开 / 复用一个技能的 SKILL.md 笔记本（内置那份只读） */
    openNote: (params: { name: string; title?: string }) =>
      ipcRenderer.invoke('skill:openNote', params),
    /** 获取所有 Skill */
    list: () => ipcRenderer.invoke('skill:list'),
    /** 获取按目录分组的 Skill 列表 */
    listGrouped: () => ipcRenderer.invoke('skill:listGrouped'),
    /** 更新 Skill */
    update: (params: SkillUpdateParams) => ipcRenderer.invoke('skill:update', params),
    /** 删除 Skill（按名称） */
    deleteDefault: (name: string) => ipcRenderer.invoke('skill:deleteDefault', name),
    /** 解析 SKILL.md 文本 */
    parseMarkdown: (text: string) => ipcRenderer.invoke('skill:parseMarkdown', text),
    /** 获取默认 skills 目录路径 */
    getDefaultDir: () => ipcRenderer.invoke('skill:getDefaultDir'),
    /** 获取外部 skill 目录列表 */
    listExternalDirs: () => ipcRenderer.invoke('skill:listExternalDirs'),
    /** 弹出文件夹选择器（仅返回路径） */
    pickExternalDir: () => ipcRenderer.invoke('skill:pickExternalDir'),
    /** 添加外部 skill 源目录 */
    addExternalDir: (dir: { name: string; path: string }) =>
      ipcRenderer.invoke('skill:addExternalDir', dir),
    /** 移除外部 skill 源目录 */
    removeExternalDir: (name: string) => ipcRenderer.invoke('skill:removeExternalDir', name),
    /** 切换分组总开关 */
    setGroupEnabled: (params: { dirName: string; isEnabled: boolean }) =>
      ipcRenderer.invoke('skill:setGroupEnabled', params)
  },

  // ============ 自动更新 ============
  update: {
    /** 检查更新 */
    check: (): Promise<{ success: boolean }> => ipcRenderer.invoke('update:check'),
    /** 开始下载更新 */
    download: (): Promise<{ success: boolean }> => ipcRenderer.invoke('update:download'),
    /** 安装更新并重启 */
    install: (): Promise<{ success: boolean }> => ipcRenderer.invoke('update:install'),
    /** 获取最后一次更新事件（用于新打开的窗口同步状态） */
    getLastEvent: (): Promise<UpdateEvent | null> => ipcRenderer.invoke('update:getLastEvent'),
    /** 监听更新状态事件，返回取消监听函数 */
    onEvent: (callback: (event: UpdateEvent) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, event: UpdateEvent): void => callback(event)
      ipcRenderer.on('update:event', handler)
      return () => ipcRenderer.removeListener('update:event', handler)
    }
  },

  // ============ 上下文菜单 ============
  contextMenu: {
    popup: (request: ContextMenuRequest) => ipcRenderer.invoke('contextMenu:popup', request)
  },

  // ============ Widgets ============
  widget: {
    /** 获取所有未归档 widget */
    list: () => ipcRenderer.invoke('widget:list'),
    /** 获取已归档 widget */
    listArchived: () => ipcRenderer.invoke('widget:listArchived'),
    /** 打开 widget：懒启动 server + 注册 + 刷新最近打开时间，返回 URL */
    open: (id: string) =>
      ipcRenderer.invoke('widget:open', id) as Promise<
        | {
            success: true
            url: string
            widget: {
              id: string
              name: string
              description: string
              createdAt: number
              updatedAt: number
              lastOpenedAt: number
              archivedAt: number
            }
          }
        | { success: false; error: string }
      >,
    /** 重命名 widget（同时更新 description，若提供） */
    rename: (params: { id: string; name: string; description?: string }) =>
      ipcRenderer.invoke('widget:rename', params),
    /** 归档 / 取消归档 */
    setArchived: (params: { id: string; archived: boolean }) =>
      ipcRenderer.invoke('widget:setArchived', params),
    /** 删除 widget（目录 + 账目条目 + 其数据库 schema） */
    delete: (id: string) => ipcRenderer.invoke('widget:delete', id),
    /** 获取 widget HTTP 服务器状态 */
    getServerStatus: () =>
      ipcRenderer.invoke('widget:getServerStatus') as Promise<{
        running: boolean
        port: number
        widgetCount: number
        registeredIds: string[]
      }>,
    /** 停止 widget HTTP 服务器（下次打开时自动重启） */
    stopServer: () => ipcRenderer.invoke('widget:stopServer'),
    /** 启动单个 widget —— 注册到 server 并返回 URL，不打开浏览器 */
    startWidget: (id: string) =>
      ipcRenderer.invoke('widget:startWidget', id) as Promise<
        { success: true; url: string; buildSuccess: boolean } | { success: false; error: string }
      >,
    /** 停止单个 widget —— 从 server 注销，不影响其他 widget */
    stopWidget: (id: string) =>
      ipcRenderer.invoke('widget:stopWidget', id) as Promise<{ success: true }>,
    /** 弹出保存对话框选择 zip 落点（返回所选路径；用户取消返回 canceled） */
    pickExportTarget: (params: { id: string }) =>
      ipcRenderer.invoke('widget:pickExportTarget', params) as Promise<
        { success: true; path: string } | { success: false; reason: string }
      >,
    /** 导出 widget 为独立 Vite 工程 zip */
    exportAsVite: (params: { id: string; targetPath: string }) =>
      ipcRenderer.invoke('widget:exportAsVite', params) as Promise<
        | { success: true; zipPath: string; entryCount: number }
        | { success: false; code: string; error: string }
      >,
    /** 在系统文件管理器中定位导出的 zip */
    revealExport: (zipPath: string) =>
      ipcRenderer.invoke('widget:revealExport', zipPath) as Promise<{ success: true }>
    // widget 变更订阅已并入 events.subscribe（AppEvent 'widget.changed'）
  },

  // ============ Widget 独立窗口（widget app window） ============
  widgetWindow: {
    /** 在独立窗口打开 widget（已开则聚焦）；构建 / URL 获取由窗口内 shell 调 widget.open 完成 */
    open: (id: string) =>
      ipcRenderer.invoke('widgetWindow:open', id) as Promise<
        { success: true } | { success: false; error: string }
      >,
    /** 关闭指定 widget 的独立窗口 */
    close: (id: string) =>
      ipcRenderer.invoke('widgetWindow:close', id) as Promise<{ success: true }>,
    /** 切换独立窗口"始终置顶"，持久化到 per-widget 窗口状态 */
    setAlwaysOnTop: (params: { id: string; value: boolean }) =>
      ipcRenderer.invoke('widgetWindow:setAlwaysOnTop', params) as Promise<{
        alwaysOnTop: boolean
      }>,
    /** 查询独立窗口"始终置顶"状态 */
    getAlwaysOnTop: (id: string) =>
      ipcRenderer.invoke('widgetWindow:getAlwaysOnTop', id) as Promise<{ alwaysOnTop: boolean }>
  },

  // ============ 悬浮聊天（Floating Pin Chat） ============
  // 多窗模型：每个 sessionId 对应一个独立的悬浮窗口；多个会话可同时悬浮、并行运行 Agent。
  pinChat: {
    /** 把指定 session 提到悬浮窗口（已悬浮则 focus） */
    pin: (sessionId: string) => ipcRenderer.invoke('pinChat:pin', sessionId),
    /** 取消指定 session 的悬浮，恢复到主窗口 */
    unpin: (sessionId: string) => ipcRenderer.invoke('pinChat:unpin', sessionId),
    /** 聚焦指定 session 的悬浮窗口 */
    focus: (sessionId: string) => ipcRenderer.invoke('pinChat:focus', sessionId),
    /** 主动查询当前所有悬浮会话（窗口刚加载时同步用） */
    getState: () =>
      ipcRenderer.invoke('pinChat:getState') as Promise<{ pinnedSessionIds: string[] }>,
    /** 切换悬浮窗"始终置顶"特性,false 即让窗口降为普通窗口 */
    setAlwaysOnTop: (params: { sessionId: string; value: boolean }) =>
      ipcRenderer.invoke('pinChat:setAlwaysOnTop', params) as Promise<{ alwaysOnTop: boolean }>,
    /** 查询当前悬浮窗的"始终置顶"状态 */
    getAlwaysOnTop: (sessionId: string) =>
      ipcRenderer.invoke('pinChat:getAlwaysOnTop', sessionId) as Promise<{ alwaysOnTop: boolean }>
    // 悬浮状态变更订阅已并入 events.subscribe（AppEvent 'pinChat.changed'）
  },

  // ============ 通知（系统通知 ↔ 会话定位） ============
  notification: {
    /**
     * 上报本窗口当前展示的会话 —— 主进程据此 + 窗口焦点判断「用户是否已经看着它了」，
     * 看着就不弹通知。null = 当前无会话。
     */
    reportActiveSession: (sessionId: string | null) =>
      ipcRenderer.invoke('notification:reportActiveSession', sessionId),
    /** 取走「通知点击时主窗尚未就绪」暂存的跳转目标（取后即清） */
    consumePendingOpenSession: () =>
      ipcRenderer.invoke('notification:consumePendingOpenSession') as Promise<string | null>,
    /** 监听通知点击要求打开的会话 */
    onOpenSession: (callback: (sessionId: string) => void) => {
      const handler = (_e: unknown, sessionId: string): void => callback(sessionId)
      ipcRenderer.on('notification:open-session', handler)
      return () => ipcRenderer.removeListener('notification:open-session', handler)
    }
  },

  // ============ Files (会话工作目录文件树) ============
  /** 会话 Artifacts —— 目前只有渲染端读内容这一条（```artifact 引用围栏） */
  artifact: {
    /** 按名字取一件的内容；不存在返回 null */
    read: (params: { sessionId: string; name: string }) =>
      ipcRenderer.invoke('artifact:read', params) as Promise<{
        name: string
        title: string
        content: string
      } | null>
  },
  files: {
    /** 扫描当前会话工作目录下的所有文件路径（遵循 .gitignore） */
    scan: (params: { sessionId: string }) =>
      ipcRenderer.invoke('files:scan', params) as Promise<{
        paths: string[]
        truncated: boolean
        root: string | null
      }>,
    /** 按目录浅扫描（文件树懒加载）：dir 相对工作目录，空串 = 根；无截断、后端排序 */
    scanDir: (params: { sessionId: string; dir: string }) =>
      ipcRenderer.invoke('files:scanDir', params) as Promise<{
        files: string[]
        dirs: string[]
        root: string | null
      }>,
    /** 开始监听某个已打开文件的内容变更（笔记本 / 预览自动刷新）；变更经 events.subscribe 广播 */
    watch: (params: { sessionId: string; path: string }) =>
      ipcRenderer.invoke('files:watch', params) as Promise<void>,
    /** 停止监听某个文件 */
    unwatch: (params: { sessionId: string; path: string }) =>
      ipcRenderer.invoke('files:unwatch', params) as Promise<void>,
    /** 读取文件内容用于面板预览。准入范围外路径返回 not-allowed，不弹询问 */
    read: (params: { sessionId: string; path: string }) =>
      ipcRenderer.invoke('files:read', params) as Promise<
        import('@shuvix/chat-protocol/types/filePreview').FileReadResult
      >,
    /** 回写文件内容（中间区 Markdown 编辑器自动保存）。准入范围外路径返回 ok:false，不弹询问 */
    write: (params: { sessionId: string; path: string; content: string }) =>
      ipcRenderer.invoke('files:write', params) as Promise<
        { ok: true } | { ok: false; error: string }
      >
    // 文件变动订阅已并入 events.subscribe（AppEvent 'files.changed'）
  },

  // ============ 知识库 v2（OKF bundle：侧栏「知识库」分组，隐藏承载项目 __knowledge__ / __knowledge_user__） ============
  knowledge: {
    /** 全部条目（视图形状，不含正文）+ 两个根的绝对路径（root = knowledge-shuvix，userRoot = 用户根）；只读，不建任何东西 */
    list: () =>
      ipcRenderer.invoke('knowledge:list') as Promise<{
        entries: KnowledgeEntry[]
        root: string
        userRoot: string
        dirs: string[]
        bundleNames: Record<string, string>
        bundleDirs: Record<string, string>
      }>,
    /** 打开条目笔记：一文件至多一笔记本会话，已存在则复用返回；title 为条目显示名 */
    openNote: (params: { path: string; title?: string }) =>
      ipcRenderer.invoke('knowledge:openNote', params),
    /** 打开用户知识库根目录（OS 文件管理器；不存在先建） */
    openFolder: () => ipcRenderer.invoke('knowledge:openFolder'),
    /** 在文件夹中显示条目文件（条目 id：`projects/<id>/…` / `knowledge/<库名>/…`） */
    revealFile: (params: { path: string }) => ipcRenderer.invoke('knowledge:revealFile', params),
    /** 配置界面用：候选知识库 + 这条会话此刻生效的选择（不给 sessionId 只回候选项） */
    baseOptions: (params?: { sessionId?: string }) =>
      ipcRenderer.invoke('knowledge:baseOptions', params ?? {}) as Promise<{
        options: { name: string; label: string }[]
        selected: string[]
        explicit: boolean
      }>,
    /** 新建用户知识库（用户根下一个目录） */
    createBase: (params: { name: string }) =>
      ipcRenderer.invoke('knowledge:createBase', params) as Promise<KnowledgeCreateReply>,
    /** 在某个目录（库本身或库里的一层）下新建文件夹 */
    createFolder: (params: { dir: string; name: string }) =>
      ipcRenderer.invoke('knowledge:createFolder', params) as Promise<KnowledgeCreateReply>,
    /** 在某个目录下新建条目：元数据由宿主拼，文件名按标题派生 */
    createEntry: (params: { dir: string; title: string }) =>
      ipcRenderer.invoke('knowledge:createEntry', params) as Promise<KnowledgeCreateReply>
  },

  // ============ 聊天输入框 @ 引用多源（知识库源候选；文件源走 files.scan） ============
  mentions: {
    /** 该会话启用库内的知识条目视图（含 knowledge 工具指针 baseName/bundlePath）；未启用任何库返回空 */
    listKnowledgeEntries: (params: { sessionId: string }) =>
      ipcRenderer.invoke('knowledge:mentionEntries', params) as Promise<KnowledgeMentionEntry[]>
  },

  // ============ 项目记忆（侧栏项目组下的「项目记忆」子文件夹） ============
  memory: {
    /** 列出某项目的记忆条目（视图形状，不含正文）；无记忆返回空数组 */
    list: (params: { projectId: string }) =>
      ipcRenderer.invoke('memory:list', params) as Promise<ProjectMemoryEntry[]>,
    /** 打开一条记忆：一条至多一个笔记本会话，已存在则复用；文件已不在返回 null */
    openNote: (params: { projectId: string; slug: string }) =>
      ipcRenderer.invoke('memory:openNote', params)
  },
  /** 通用内部事件订阅（main 经 'app:event' 广播 AppEvent，与 agent:event 并列） */
  events: {
    // 单一 ipcRenderer 监听 + 本地扇出（见上方 subscribeAppEvent），避免 app:event 监听器泄漏告警
    subscribe: (callback: (event: AppEvent) => void) => subscribeAppEvent(callback)
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
