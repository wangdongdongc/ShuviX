import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { UpdateEvent } from '../main/types'
import type {
  AgentInitParams,
  AgentPromptParams,
  AgentSteerParams,
  AgentSetModelParams,
  AgentSetThinkingLevelParams,
  HttpLogListParams,
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
  SessionUpdateThinkingLevelParams,
  SessionUpdateEnabledToolsParams,
  SessionUpdateProjectParams,
  SessionUpdateAutoApproveParams,
  SessionAllowListAddParams,
  SessionAllowListRemoveParams,
  SessionUpdateTitleParams,
  SettingsSetParams,
  McpServerAddParams,
  McpServerUpdateParams,
  SkillUpdateParams,
  SshCredentialAddParams,
  SshCredentialUpdateParams,
  DbCredentialAddParams,
  DbCredentialUpdateParams,
  DbCredentialTestParams,
  CustomSubAgentAddParams,
  CustomSubAgentUpdateParams,
  ShareMode,
  TelegramBotAddParams,
  TelegramBotUpdateParams,
  TelegramBindSessionParams,
  TelegramUnbindSessionParams
} from '../main/types'
import type { ChatEvent } from '../main/frontend/core/types'
import type {
  ConfigSharePayload,
  ExportOptions,
  ExportSnapshot,
  ImportPlan,
  ImportResult,
  ImportSelection
} from '../shared/types/configShare'

/** 暴露给 Renderer 的 API */
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
    /** 通知主进程渲染已就绪，可以显示窗口 */
    windowReady: () => ipcRenderer.send('app:window-ready'),
    /** 调整主窗口宽度（delta > 0 变宽，< 0 变窄） */
    adjustWindowWidth: (delta: number) => ipcRenderer.invoke('app:adjust-window-width', delta),
    /** 设置浏览器面板宽度偏移（保存窗口尺寸时扣除） */
    setBrowserOffset: (offset: number) => ipcRenderer.invoke('app:set-browser-offset', offset),
    /** 监听设置变更（设置窗口关闭后主窗口收到通知） */
    onSettingsChanged: (callback: () => void) => {
      const handler = (): void => callback()
      ipcRenderer.on('app:settings-changed', handler)
      return () => ipcRenderer.removeListener('app:settings-changed', handler)
    },
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

    /** 向运行中的 Agent 发送 steer 消息（引导/纠正方向） */
    steer: (params: AgentSteerParams) => ipcRenderer.invoke('agent:steer', params),

    /** 中止指定 session 的生成 */
    abort: (sessionId: string) => ipcRenderer.invoke('agent:abort', sessionId),

    /** 切换模型 */
    setModel: (params: AgentSetModelParams) => ipcRenderer.invoke('agent:setModel', params),

    /** 设置思考深度 */
    setThinkingLevel: (params: AgentSetThinkingLevelParams) =>
      ipcRenderer.invoke('agent:setThinkingLevel', params),

    /**
     * 统一的"用户输入响应"入口。
     * 命令审批 / 选择题 / SSH 凭证 / 用户取消都通过该方法路由到对应的工具挂起 Promise。
     */
    respondToInput: (params: {
      sessionId: string
      requestId: string
      response: import('../shared/types/inputRequest').InputResponse
    }) => ipcRenderer.invoke('agent:respondToInput', params),

    /** 动态更新启用工具集 */
    setEnabledTools: (params: { sessionId: string; tools: string[] }) =>
      ipcRenderer.invoke('agent:setEnabledTools', params),

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
      ipcRenderer.invoke('provider:updateModelCapabilities', params)
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
    getKnownFields: () => ipcRenderer.invoke('project:getKnownFields'),
    /** 监听项目列表变更（创建/更新/删除/归档后触发） */
    onChanged: (callback: () => void) => {
      const handler = (): void => callback()
      ipcRenderer.on('project:changed', handler)
      return () => ipcRenderer.removeListener('project:changed', handler)
    }
  },

  // ============ 会话管理 ============
  session: {
    list: () => ipcRenderer.invoke('session:list'),
    create: (projectId?: string | null) => ipcRenderer.invoke('session:create', projectId),
    updateTitle: (params: SessionUpdateTitleParams) =>
      ipcRenderer.invoke('session:updateTitle', params),
    updateModelConfig: (params: SessionUpdateModelConfigParams) =>
      ipcRenderer.invoke('session:updateModelConfig', params),
    updateProject: (params: SessionUpdateProjectParams) =>
      ipcRenderer.invoke('session:updateProject', params),
    updateThinkingLevel: (params: SessionUpdateThinkingLevelParams) =>
      ipcRenderer.invoke('session:updateThinkingLevel', params),
    updateEnabledTools: (params: SessionUpdateEnabledToolsParams) =>
      ipcRenderer.invoke('session:updateEnabledTools', params),
    updateAutoApprove: (params: SessionUpdateAutoApproveParams) =>
      ipcRenderer.invoke('session:updateAutoApprove', params),
    previewAllowPatterns: (params: {
      command: string
      sessionId?: string
      toolType?: 'bash' | 'ssh' | 'read' | 'write'
    }) => ipcRenderer.invoke('session:previewAllowPatterns', params),
    addAllowListPatterns: (params: SessionAllowListAddParams) =>
      ipcRenderer.invoke('session:addAllowListPatterns', params),
    removeAllowListEntry: (params: SessionAllowListRemoveParams) =>
      ipcRenderer.invoke('session:removeAllowListEntry', params),
    generateTitle: (params: { sessionId: string; conversationText: string }) =>
      ipcRenderer.invoke('session:generateTitle', params),
    delete: (id: string) => ipcRenderer.invoke('session:delete', id),
    /** 获取单个会话（含 workingDirectory） */
    getById: (id: string) => ipcRenderer.invoke('session:getById', id),
    scanInstructionFiles: (sessionId: string) =>
      ipcRenderer.invoke('session:scanInstructionFiles', sessionId),
    updateInstructionFiles: (params: { id: string; filenames: string[] }) =>
      ipcRenderer.invoke('session:updateInstructionFiles', params),
    /** 监听会话配置变更（如 LAN 分享 / Telegram 绑定切换） */
    onConfigChanged: (callback: (payload: { sessionId: string }) => void) => {
      const handler = (_e: unknown, payload: { sessionId: string }): void => callback(payload)
      ipcRenderer.on('session:configChanged', handler)
      return () => ipcRenderer.removeListener('session:configChanged', handler)
    }
  },

  // ============ 消息管理 ============
  message: {
    list: (sessionId: string) => ipcRenderer.invoke('message:list', sessionId),
    add: (params: MessageAddParams) => ipcRenderer.invoke('message:add', params),
    addErrorEvent: (params: { sessionId: string; content: string }) =>
      ipcRenderer.invoke('message:addErrorEvent', params),
    deleteErrorEvent: (params: { sessionId: string; messageId: string }) =>
      ipcRenderer.invoke('message:deleteErrorEvent', params),
    clear: (sessionId: string) => ipcRenderer.invoke('message:clear', sessionId),
    rollback: (params: { sessionId: string; messageId: string }) =>
      ipcRenderer.invoke('message:rollback', params),
    deleteFrom: (params: { sessionId: string; messageId: string }) =>
      ipcRenderer.invoke('message:deleteFrom', params),
    /** 统计已归档消息数 */
    countArchived: (sessionId: string) =>
      ipcRenderer.invoke('message:countArchived', sessionId) as Promise<number>,
    /** 分页加载已归档消息（含 steps） */
    listArchived: (params: { sessionId: string; limit: number; offset: number }) =>
      ipcRenderer.invoke('message:listArchived', params)
  },

  // ============ 设置管理 ============
  settings: {
    getAll: () => ipcRenderer.invoke('settings:getAll'),
    get: (key: string) => ipcRenderer.invoke('settings:get', key),
    set: (params: SettingsSetParams) => ipcRenderer.invoke('settings:set', params),
    /** 获取已知设置 key 的元数据（labelKey + desc） */
    getKnownKeys: () => ipcRenderer.invoke('settings:getKnownKeys')
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
  sshCredential: {
    list: () => ipcRenderer.invoke('sshCredential:list'),
    add: (params: SshCredentialAddParams) => ipcRenderer.invoke('sshCredential:add', params),
    update: (params: SshCredentialUpdateParams) =>
      ipcRenderer.invoke('sshCredential:update', params),
    delete: (id: string) => ipcRenderer.invoke('sshCredential:delete', id),
    listNames: () => ipcRenderer.invoke('sshCredential:listNames')
  },

  // ============ 数据库凭据管理 ============
  dbCredential: {
    list: () => ipcRenderer.invoke('dbCredential:list'),
    add: (params: DbCredentialAddParams) => ipcRenderer.invoke('dbCredential:add', params),
    update: (params: DbCredentialUpdateParams) => ipcRenderer.invoke('dbCredential:update', params),
    delete: (id: string) => ipcRenderer.invoke('dbCredential:delete', id),
    testConnection: (params: DbCredentialTestParams) =>
      ipcRenderer.invoke('dbCredential:testConnection', params)
  },

  // ============ 自定义子智能体管理 ============
  customSubAgent: {
    list: () => ipcRenderer.invoke('customSubAgent:list'),
    add: (params: CustomSubAgentAddParams) => ipcRenderer.invoke('customSubAgent:add', params),
    update: (params: CustomSubAgentUpdateParams) =>
      ipcRenderer.invoke('customSubAgent:update', params),
    delete: (id: string) => ipcRenderer.invoke('customSubAgent:delete', id),
    toggle: (params: { id: string; enabled: boolean }) =>
      ipcRenderer.invoke('customSubAgent:toggle', params)
  },

  // ============ 临时子会话（右侧 Sub-agent 面板） ============
  subSession: {
    /** 销毁指定子会话 — 中止运行中的 Agent 并清理服务端 registry */
    destroy: (subSessionId: string) => ipcRenderer.invoke('subSession:destroy', subSessionId)
  },

  // ============ 工具 ============
  tools: {
    list: (sessionId?: string) => ipcRenderer.invoke('tools:list', sessionId),
    presentations: () => ipcRenderer.invoke('tools:presentations')
  },

  // ============ MCP Host（ShuviX 对外 MCP 服务） ============
  mcpServer: {
    /** 获取 MCP Server 状态 */
    getStatus: () => ipcRenderer.invoke('mcpServer:getStatus'),
    /** 启动 MCP Server */
    start: () => ipcRenderer.invoke('mcpServer:start'),
    /** 停止 MCP Server */
    stop: () => ipcRenderer.invoke('mcpServer:stop'),
    /** 获取已注册的工具列表 */
    getTools: () => ipcRenderer.invoke('mcpServer:getTools'),
    /** 动态启用功能 */
    enableFeature: (feature: string) => ipcRenderer.invoke('mcpServer:enableFeature', feature),
    /** 动态禁用功能 */
    disableFeature: (feature: string) => ipcRenderer.invoke('mcpServer:disableFeature', feature),
    /** 列出日志 */
    listLogs: (params?: { clientName?: string; toolName?: string; limit?: number }) =>
      ipcRenderer.invoke('mcpServer:listLogs', params),
    /** 获取日志详情 */
    getLog: (id: string) => ipcRenderer.invoke('mcpServer:getLog', id),
    /** 清空日志 */
    clearLogs: () => ipcRenderer.invoke('mcpServer:clearLogs')
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

  // ============ WebUI 分享 ============
  webui: {
    /** 切换指定 session 的分享状态 */
    setShared: (params: { sessionId: string; shared: boolean; mode?: ShareMode }) =>
      ipcRenderer.invoke('webui:setShared', params),
    /** 查询单个 session 是否已分享 */
    isShared: (sessionId: string) => ipcRenderer.invoke('webui:isShared', sessionId),
    /** 获取指定 session 的分享模式 */
    getShareMode: (sessionId: string) => ipcRenderer.invoke('webui:getShareMode', sessionId),
    /** 获取所有已分享的 session 列表（含模式） */
    listShared: () => ipcRenderer.invoke('webui:listShared'),
    /** 获取 WebUI 服务器状态 */
    serverStatus: () => ipcRenderer.invoke('webui:serverStatus')
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
    validateToken: (token: string) => ipcRenderer.invoke('telegram:validateToken', token),
    /** 绑定 session 到 bot */
    bindSession: (params: TelegramBindSessionParams) =>
      ipcRenderer.invoke('telegram:bindSession', params),
    /** 解绑 session */
    unbindSession: (params: TelegramUnbindSessionParams) =>
      ipcRenderer.invoke('telegram:unbindSession', params),
    /** 获取 session 绑定的 bot ID */
    getSessionBotId: (sessionId: string) =>
      ipcRenderer.invoke('telegram:getSessionBotId', sessionId),
    /** 启动指定 Bot */
    startBot: (botId: string) => ipcRenderer.invoke('telegram:startBot', botId),
    /** 停止指定 Bot */
    stopBot: (botId: string) => ipcRenderer.invoke('telegram:stopBot', botId),
    /** 获取 Bot 运行状态 */
    getBotStatus: (botId: string) => ipcRenderer.invoke('telegram:getBotStatus', botId)
  },

  // ============ 压缩归档 ============
  compact: {
    /** 触发 Full Compaction */
    start: (sessionId: string) => ipcRenderer.invoke('compact:start', sessionId)
  },

  // ============ 斜杠命令 ============
  command: {
    /** 获取当前会话可用的斜杠命令列表 */
    list: (params: { sessionId: string }) => ipcRenderer.invoke('command:list', params)
  },

  // ============ 语音转文字 ============
  stt: {
    /** 调用 Whisper 转写音频 */
    transcribe: (params: { audioData: string; pcmf32?: string; language?: string }) =>
      ipcRenderer.invoke('stt:transcribe', params),
    /** 获取本地 Whisper 状态（模型列表） */
    getLocalStatus: () => ipcRenderer.invoke('stt:getLocalStatus'),
    /** 下载指定模型 */
    downloadModel: (modelId: string) => ipcRenderer.invoke('stt:downloadModel', modelId),
    /** 删除指定模型 */
    deleteModel: (modelId: string) => ipcRenderer.invoke('stt:deleteModel', modelId)
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

  // ============ Browser WebContentsView ============
  browserView: {
    navigate: (url: string) => ipcRenderer.invoke('browser-view:navigate', url),
    goBack: () => ipcRenderer.invoke('browser-view:go-back'),
    goForward: () => ipcRenderer.invoke('browser-view:go-forward'),
    reload: () => ipcRenderer.invoke('browser-view:reload'),
    stop: () => ipcRenderer.invoke('browser-view:stop'),
    getUrl: () => ipcRenderer.invoke('browser-view:get-url') as Promise<string>,
    updateBounds: (bounds: { x: number; y: number; width: number; height: number }) =>
      ipcRenderer.send('browser-view:update-bounds', bounds),
    setVisible: (visible: boolean) => ipcRenderer.send('browser-view:set-visible', visible),
    /** WebContentsView 开始加载 */
    onDidStartLoading: (callback: (url: string) => void) => {
      const handler = (_: unknown, url: string): void => callback(url)
      ipcRenderer.on('browser-view:did-start-loading', handler)
      return () => ipcRenderer.removeListener('browser-view:did-start-loading', handler)
    },
    /** WebContentsView 导航完成（URL 变化） */
    onDidNavigate: (callback: (url: string) => void) => {
      const handler = (_: unknown, url: string): void => callback(url)
      ipcRenderer.on('browser-view:did-navigate', handler)
      return () => ipcRenderer.removeListener('browser-view:did-navigate', handler)
    },
    /** WebContentsView 加载完成 */
    onDidFinishLoad: (callback: () => void) => {
      const handler = (): void => callback()
      ipcRenderer.on('browser-view:did-finish-load', handler)
      return () => ipcRenderer.removeListener('browser-view:did-finish-load', handler)
    },
    /** WebContentsView 加载失败（含证书错误、DNS 错误等） */
    onDidFailLoad: (
      callback: (info: { errorCode: number; errorDescription: string; url: string }) => void
    ) => {
      const handler = (
        _: unknown,
        info: { errorCode: number; errorDescription: string; url: string }
      ): void => callback(info)
      ipcRenderer.on('browser-view:did-fail-load', handler)
      return () => ipcRenderer.removeListener('browser-view:did-fail-load', handler)
    }
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
    removeExternalDir: (name: string) => ipcRenderer.invoke('skill:removeExternalDir', name)
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
    popup: (request: {
      items: Array<{ id: string; label: string; type?: string; enabled?: boolean }>
    }) => ipcRenderer.invoke('contextMenu:popup', request)
  },

  // ============ Widgets ============
  widget: {
    /** 获取所有未归档 widget */
    list: () => ipcRenderer.invoke('widget:list'),
    /** 获取已归档 widget */
    listArchived: () => ipcRenderer.invoke('widget:listArchived'),
    /** 打开 widget：懒启动 server + 注册 + 计数，返回 URL */
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
              openCount: number
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
    /** 删除 widget（目录 + DB 记录） */
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
    /** 弹出文件夹选择器（返回所选路径；用户取消返回 canceled） */
    pickExportDir: () =>
      ipcRenderer.invoke('widget:pickExportDir') as Promise<
        { success: true; path: string } | { success: false; reason: string }
      >,
    /** 导出 widget 为独立 Vite 项目 */
    exportAsVite: (params: { id: string; targetPath: string }) =>
      ipcRenderer.invoke('widget:exportAsVite', params) as Promise<
        | { success: true; filesWritten: string[]; targetPath: string }
        | { success: false; code: string; error: string }
      >,
    /** 监听 widget 列表 / 服务器状态变更 */
    onChanged: (callback: () => void) => {
      const handler = (): void => callback()
      ipcRenderer.on('widget:changed', handler)
      return () => ipcRenderer.removeListener('widget:changed', handler)
    }
  },

  // ============ Files (会话工作目录文件树) ============
  files: {
    /** 扫描当前会话工作目录下的所有文件路径（遵循 .gitignore），同时启动文件监听 */
    scan: (params: { sessionId: string }) =>
      ipcRenderer.invoke('files:scan', params) as Promise<{
        paths: string[]
        truncated: boolean
        root: string | null
      }>,
    /** 监听工作目录文件变动事件（按 root 路径标识，同项目内多会话共享） */
    onChanged: (callback: (payload: { root: string }) => void) => {
      const handler = (_: Electron.IpcRendererEvent, payload: { root: string }): void =>
        callback(payload)
      ipcRenderer.on('files:changed', handler)
      return () => ipcRenderer.removeListener('files:changed', handler)
    }
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
