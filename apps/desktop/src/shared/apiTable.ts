/**
 * `window.api` 的通道表（server mode phase A，docs/server/phase-a-channel-registry.md §1）—— 渲染端 API 的**唯一来源**：
 * 每个成员是哪种调用、走哪条通道、带几个参数。纯数据 + 三个构造小函数，preload / 渲染层 / 主进程都能引。
 *
 *  - `invoke`：`(…args) => Promise<result>`（主进程 `defineHandler`）；
 *  - `send`：`(…args) => void`（主进程 `defineListener`）；
 *  - `event`：`(callback) => unsubscribe`，主进程推过来的通道；回调只收载荷（不带 IPC 事件）。
 *
 * `args` 把今天每个成员的行为钉死：invoke / send 转发**恰好** `args` 个参数（调用方多给的丢掉、少给的补
 * undefined —— 与改造前每个成员显式列出形参再原样转发一致）；event 交给回调的载荷个数（0 = `callback()`，
 * 1 = `callback(第一个载荷)`）。通道名一律沿用改造前的（不全是 `namespace:method`：`app:*` / `browser-view:*`
 * 是 kebab，`agent.subSession*` → `subSession:*`，`agent.monitor*` → `agentMonitor:*` 等）。
 *
 * 不是简单透传的成员（`app.platform`、`events.subscribe` 的扇出、`liveDoc.respond` 的打包、`knowledge.baseOptions`
 * 的缺省、整个 `sync`）不在表里：它们由各宿主作为 override 交给 `buildApi`（见 `buildApi.ts`），底下用到的通道
 * 列在 `API_OVERRIDE_CHANNELS`，让守卫照样看得见。
 *
 * 类型面仍是 `src/preload/index.d.ts` 的 `ShuviXAPI`。建出来的对象与表是否一致由 `src/preload/__tests__/apiTable.test.ts`
 * 在运行时核对；它的键、种类与参数个数是否与 `ShuviXAPI` 一致由 `src/renderer/src/host/__tests__/apiTableTypes.test.ts`
 * 在 typecheck:web 里核对（`ShuviXAPI` 在 tsconfig.node 下看不见）。主进程每条请求通道恰有一个定义由
 * `src/main/ipc/__tests__/channelGuard.test.ts` 核对。
 */

/** invoke / send：转发的参数个数；event：交给回调的载荷个数 */
export type ApiArity = 0 | 1 | 2

export type ApiMemberKind = 'invoke' | 'send' | 'event'

export interface ApiMember<K extends ApiMemberKind = ApiMemberKind, N extends ApiArity = ApiArity> {
  readonly kind: K
  readonly channel: string
  readonly args: N
}

/** 表的形状：命名空间 → 成员 → 条目 */
export type ApiTable = Readonly<Record<string, Readonly<Record<string, ApiMember>>>>

const invoke = <N extends ApiArity>(channel: string, args: N): ApiMember<'invoke', N> => ({
  kind: 'invoke',
  channel,
  args
})

const send = <N extends ApiArity>(channel: string, args: N): ApiMember<'send', N> => ({
  kind: 'send',
  channel,
  args
})

const event = <N extends ApiArity>(channel: string, args: N): ApiMember<'event', N> => ({
  kind: 'event',
  channel,
  args
})

export const API_TABLE = {
  /** 应用 / 窗口 */
  app: {
    openSettings: invoke('app:open-settings', 1),
    /** 带草稿打开会话：主窗口切到它、草稿等它来取（桌面专属；web 在本地实现） */
    openSessionWithDraft: invoke('app:open-session-draft', 1),
    /** 取走一条会话待填进输入框的草稿（没有 → null） */
    takeSessionDraft: invoke('app:take-session-draft', 1),
    openExternal: invoke('app:open-external', 1),
    openFolder: invoke('app:open-folder', 1),
    revealPath: invoke('app:reveal-path', 1),
    windowReady: send('app:window-ready', 0),
    adjustWindowWidth: invoke('app:adjust-window-width', 1),
    setBrowserOffset: invoke('app:set-browser-offset', 1),
    onNewChat: event('app:new-chat', 0),
    onNewProject: event('app:new-project', 0),
    getVersion: invoke('app:version', 0),
    openDirectoryDialog: invoke('dialog:openDirectory', 0)
  },
  /** Agent 操作 */
  agent: {
    init: invoke('agent:init', 1),
    prompt: invoke('agent:prompt', 1),
    subAgentPrompt: invoke('agent:subAgentPrompt', 1),
    subSessionDestroy: invoke('subSession:destroy', 1),
    subSessionInterrupt: invoke('subSession:interrupt', 1),
    steer: invoke('agent:steer', 1),
    followUp: invoke('agent:followUp', 1),
    withdrawQueued: invoke('agent:withdrawQueued', 1),
    abort: invoke('agent:abort', 1),
    continue: invoke('agent:continue', 1),
    setModel: invoke('agent:setModel', 1),
    destroy: invoke('agent:destroy', 1),
    setThinkingLevel: invoke('agent:setThinkingLevel', 1),
    getInfo: invoke('agent:getInfo', 2),
    monitorList: invoke('agentMonitor:list', 0),
    monitorDetail: invoke('agentMonitor:detail', 1),
    respondToInput: invoke('agent:respondToInput', 1),
    onEvent: event('agent:event', 1)
  },
  /** 提供商（含订阅登录） */
  provider: {
    listAll: invoke('provider:listAll', 0),
    listEnabled: invoke('provider:listEnabled', 0),
    getById: invoke('provider:getById', 1),
    updateConfig: invoke('provider:updateConfig', 1),
    toggleEnabled: invoke('provider:toggleEnabled', 1),
    listModels: invoke('provider:listModels', 1),
    listAvailableModels: invoke('provider:listAvailableModels', 0),
    listClassifierModels: invoke('provider:listClassifierModels', 0),
    toggleModelEnabled: invoke('provider:toggleModelEnabled', 1),
    syncModels: invoke('provider:syncModels', 1),
    add: invoke('provider:add', 1),
    delete: invoke('provider:delete', 1),
    addModel: invoke('provider:addModel', 1),
    deleteModel: invoke('provider:deleteModel', 1),
    updateModelCapabilities: invoke('provider:updateModelCapabilities', 1),
    oauthStatus: invoke('provider:oauthStatus', 1),
    oauthLogin: invoke('provider:oauthLogin', 1),
    oauthCancel: invoke('provider:oauthCancel', 1),
    oauthLogout: invoke('provider:oauthLogout', 1),
    oauthAnswer: invoke('provider:oauthAnswer', 1),
    onOAuthEvent: event('provider:oauth-event', 1)
  },
  /** 项目 */
  project: {
    list: invoke('project:list', 0),
    listArchived: invoke('project:listArchived', 0),
    getById: invoke('project:getById', 1),
    create: invoke('project:create', 1),
    update: invoke('project:update', 1),
    delete: invoke('project:delete', 1),
    getKnownFields: invoke('project:getKnownFields', 0)
  },
  /** 会话 */
  session: {
    list: invoke('session:list', 0),
    create: invoke('session:create', 1),
    updateTitle: invoke('session:updateTitle', 1),
    updateProject: invoke('session:updateProject', 1),
    updateEnabledTools: invoke('session:updateEnabledTools', 1),
    updateKnowledgeBases: invoke('session:updateKnowledgeBases', 1),
    listAcl: invoke('session:listAcl', 1),
    grantAcl: invoke('session:grantAcl', 1),
    setAclAccess: invoke('session:setAclAccess', 1),
    removeAclEntry: invoke('session:removeAclEntry', 1),
    fork: invoke('session:fork', 1),
    delete: invoke('session:delete', 1),
    getById: invoke('session:getById', 1)
  },
  /** 桌面日历 */
  calendar: {
    daysInMonth: invoke('calendar:daysInMonth', 1),
    sessionsOnDay: invoke('calendar:sessionsOnDay', 1),
    firstEntryOnDay: invoke('calendar:firstEntryOnDay', 1),
    reportDaysInMonth: invoke('calendar:reportDaysInMonth', 1),
    reportOnDay: invoke('calendar:reportOnDay', 1),
    openReport: invoke('calendar:openReport', 1),
    deleteReport: invoke('calendar:deleteReport', 1)
  },
  /** 消息 */
  message: {
    list: invoke('message:list', 1),
    clear: invoke('message:clear', 1),
    rollback: invoke('message:rollback', 1)
  },
  /** 设置 */
  settings: {
    getAll: invoke('settings:getAll', 0),
    get: invoke('settings:get', 1),
    set: invoke('settings:set', 1),
    getKnownKeys: invoke('settings:getKnownKeys', 0),
    sandboxStatus: invoke('settings:sandboxStatus', 0)
  },
  /** LLM 请求日志 */
  httpLog: {
    list: invoke('httpLog:list', 1),
    get: invoke('httpLog:get', 1),
    clear: invoke('httpLog:clear', 0)
  },
  /** 分类器调用日志 */
  classifierLog: {
    list: invoke('classifierLog:list', 1),
    get: invoke('classifierLog:get', 1),
    scenes: invoke('classifierLog:scenes', 0),
    clear: invoke('classifierLog:clear', 0)
  },
  /** 运行时资源 */
  runtime: {
    statuses: invoke('runtime:statuses', 1),
    destroy: invoke('runtime:destroy', 1)
  },
  /** 数据库凭据 */
  dbCredential: {
    list: invoke('dbCredential:list', 0),
    add: invoke('dbCredential:add', 1),
    update: invoke('dbCredential:update', 1),
    delete: invoke('dbCredential:delete', 1),
    testConnection: invoke('dbCredential:testConnection', 1)
  },
  /** 智能体档案 */
  subAgent: {
    list: invoke('subAgent:list', 0),
    save: invoke('subAgent:save', 1),
    create: invoke('subAgent:create', 1),
    delete: invoke('subAgent:delete', 1),
    listInvalid: invoke('subAgent:listInvalid', 0),
    deleteByFile: invoke('subAgent:deleteByFile', 1),
    getSource: invoke('subAgent:getSource', 1),
    createSource: invoke('subAgent:createSource', 1),
    openNote: invoke('subAgent:openNote', 1),
    openBuiltinNote: invoke('subAgent:openBuiltinNote', 1),
    openFolder: invoke('subAgent:openFolder', 0)
  },
  /** 安全策略 */
  policy: {
    list: invoke('policy:list', 0),
    getSource: invoke('policy:getSource', 1),
    create: invoke('policy:create', 1),
    delete: invoke('policy:delete', 1),
    listInvalid: invoke('policy:listInvalid', 0),
    deleteByFile: invoke('policy:deleteByFile', 1),
    openNote: invoke('policy:openNote', 1),
    openBuiltinNote: invoke('policy:openBuiltinNote', 1),
    openFolder: invoke('policy:openFolder', 0)
  },
  /** Hooks */
  hook: {
    list: invoke('hook:list', 0),
    getSource: invoke('hook:getSource', 1),
    create: invoke('hook:create', 1),
    delete: invoke('hook:delete', 1),
    listInvalid: invoke('hook:listInvalid', 0),
    deleteByFile: invoke('hook:deleteByFile', 1),
    openNote: invoke('hook:openNote', 1),
    openBuiltinNote: invoke('hook:openBuiltinNote', 1),
    openFolder: invoke('hook:openFolder', 0)
  },
  /** Bots */
  bot: {
    list: invoke('bot:list', 0),
    openNote: invoke('bot:openNote', 1),
    createNew: invoke('bot:createNew', 0),
    delete: invoke('bot:delete', 1),
    deleteByFile: invoke('bot:deleteByFile', 1),
    openFolder: invoke('bot:openFolder', 0)
  },
  /** 跟踪项（实验）：侧栏 Library 的「跟踪项」分组 */
  tracking: {
    list: invoke('tracking:list', 0),
    openNote: invoke('tracking:openNote', 1),
    openFolder: invoke('tracking:openFolder', 0)
  },
  /** 触发源（实验）：设置 → 触发源页的状态 */
  trigger: {
    status: invoke('trigger:status', 0),
    logs: invoke('trigger:logs', 1),
    clearLogs: invoke('trigger:clearLogs', 0)
  },
  /** shuvix 契约 md 校验 */
  shuvixMd: {
    validate: invoke('shuvixMd:validate', 1)
  },
  /** md 扩展元数据 */
  mdMeta: {
    get: invoke('mdMeta:get', 1),
    setFill: invoke('mdMeta:setFill', 1),
    unsetFill: invoke('mdMeta:unsetFill', 1),
    setEnabled: invoke('mdMeta:setEnabled', 1)
  },
  /** 工具 */
  tools: {
    list: invoke('tools:list', 2),
    presentations: invoke('tools:presentations', 0),
    definitions: invoke('tools:definitions', 0)
  },
  /** 配置导出 / 导入 */
  config: {
    buildExportSnapshot: invoke('config:buildExportSnapshot', 0),
    buildExportPayload: invoke('config:buildExportPayload', 1),
    parseImportPayload: invoke('config:parseImportPayload', 1),
    planImport: invoke('config:planImport', 1),
    applyImport: invoke('config:applyImport', 1)
  },
  /** MCP 客户端 */
  mcp: {
    list: invoke('mcp:list', 0),
    add: invoke('mcp:add', 1),
    update: invoke('mcp:update', 1),
    delete: invoke('mcp:delete', 1),
    connect: invoke('mcp:connect', 1),
    disconnect: invoke('mcp:disconnect', 1),
    getTools: invoke('mcp:getTools', 1)
  },
  /** Telegram Bot */
  telegram: {
    listBots: invoke('telegram:listBots', 0),
    addBot: invoke('telegram:addBot', 1),
    updateBot: invoke('telegram:updateBot', 1),
    deleteBot: invoke('telegram:deleteBot', 1),
    validateToken: invoke('telegram:validateToken', 1)
  },
  /** 斜杠命令 */
  command: {
    list: invoke('command:list', 1)
  },
  /** 文字转语音 */
  tts: {
    speakOnce: invoke('tts:speakOnce', 1),
    abortTts: invoke('tts:abort', 0),
    onChunk: event('tts:chunk', 1),
    getQwen3Status: invoke('tts:getQwen3Status', 0),
    getQwen3Voices: invoke('tts:getQwen3Voices', 0),
    setupQwen3: invoke('tts:setupQwen3', 0),
    cancelSetupQwen3: invoke('tts:cancelSetupQwen3', 0),
    onSetupProgress: event('tts:setupProgress', 1)
  },
  /** 下载 */
  download: {
    onProgress: event('download:progress', 1),
    cancel: invoke('download:cancel', 1)
  },
  /** 后台任务 */
  bgTask: {
    list: invoke('bgTask:list', 1),
    readLog: invoke('bgTask:readLog', 1),
    stop: invoke('bgTask:stop', 1),
    dismiss: invoke('bgTask:dismiss', 1),
    clearDone: invoke('bgTask:clearDone', 1),
    readInvocation: invoke('bgTask:readInvocation', 1)
  },
  /** 终端（node-pty） */
  terminal: {
    create: invoke('terminal:create', 1),
    write: send('terminal:write', 1),
    resize: send('terminal:resize', 1),
    destroy: invoke('terminal:destroy', 1),
    onData: event('terminal:data', 1),
    onExit: event('terminal:exit', 1)
  },
  /** 内置浏览器（多 tab） */
  browserView: {
    openWindow: invoke('browser-view:open-window', 0),
    isWindowOpen: invoke('browser-view:is-window-open', 0),
    createTab: invoke('browser-view:create-tab', 1),
    closeTab: invoke('browser-view:close-tab', 1),
    reopenClosedTab: invoke('browser-view:reopen-closed-tab', 0),
    activateTab: invoke('browser-view:activate-tab', 1),
    listTabs: invoke('browser-view:list-tabs', 0),
    navigate: invoke('browser-view:navigate', 2),
    goBack: invoke('browser-view:go-back', 1),
    goForward: invoke('browser-view:go-forward', 1),
    reload: invoke('browser-view:reload', 1),
    stop: invoke('browser-view:stop', 1),
    getUrl: invoke('browser-view:get-url', 1),
    setLayout: send('browser-view:set-layout', 1),
    capture: invoke('browser-view:capture', 2),
    zoom: invoke('browser-view:zoom', 2),
    openSession: invoke('browser-view:open-session', 1),
    openSettings: invoke('browser-view:open-settings', 0),
    openInternal: invoke('browser-view:open-internal', 1),
    proceedUnsafe: invoke('browser-view:proceed-unsafe', 1),
    setVisible: send('browser-view:set-visible', 1),
    openDevtools: invoke('browser-view:devtools-open', 2),
    closeDevtools: invoke('browser-view:devtools-close', 1),
    setDevtoolsLayout: send('browser-view:set-devtools-layout', 1),
    agentDevtools: invoke('browser-view:agent-devtools', 1),
    clearAgentDevtools: invoke('browser-view:agent-devtools-clear', 1),
    onTabCreated: event('browser-view:tab-created', 1),
    onTabClosed: event('browser-view:tab-closed', 1),
    onTabActivated: event('browser-view:tab-activated', 1),
    onTabTitleUpdated: event('browser-view:tab-title-updated', 1),
    onTabFaviconUpdated: event('browser-view:tab-favicon-updated', 1),
    onTabCdpState: event('browser-view:tab-cdp-state', 1),
    onTabAgent: event('browser-view:tab-agent', 1),
    onTabZoom: event('browser-view:tab-zoom', 1),
    onTabDevtools: event('browser-view:tab-devtools', 1),
    onAgentDevtoolsChanged: event('browser-view:agent-devtools-changed', 1),
    onCommand: event('browser-view:command', 1),
    onDidStartLoading: event('browser-view:did-start-loading', 1),
    onDidNavigate: event('browser-view:did-navigate', 1),
    onDidStopLoading: event('browser-view:did-stop-loading', 1),
    onDidFailLoad: event('browser-view:did-fail-load', 1)
  },
  /** Chrome 扩展 */
  chromeExtension: {
    status: invoke('chromeExtension:status', 0),
    repair: invoke('chromeExtension:repair', 0)
  },
  /** 内置浏览器分区数据 */
  browserData: {
    listSites: invoke('browser-data:list-sites', 0),
    clearSite: invoke('browser-data:clear-site', 1),
    siteDetails: invoke('browser-data:site-details', 1),
    clearSiteCategory: invoke('browser-data:clear-site-category', 2),
    clearOrigin: invoke('browser-data:clear-origin', 1),
    removeCookie: invoke('browser-data:remove-cookie', 1),
    clearAll: invoke('browser-data:clear-all', 0),
    siteInfo: invoke('browser-data:site-info', 1),
    clearSiteData: invoke('browser-data:clear-site-data', 1),
    certExceptions: invoke('browser-data:cert-exceptions', 0)
  },
  /** 技能 */
  skill: {
    openNote: invoke('skill:openNote', 1),
    list: invoke('skill:list', 0),
    listGrouped: invoke('skill:listGrouped', 0),
    update: invoke('skill:update', 1),
    deleteDefault: invoke('skill:deleteDefault', 1),
    parseMarkdown: invoke('skill:parseMarkdown', 1),
    getDefaultDir: invoke('skill:getDefaultDir', 0),
    listExternalDirs: invoke('skill:listExternalDirs', 0),
    pickExternalDir: invoke('skill:pickExternalDir', 0),
    addExternalDir: invoke('skill:addExternalDir', 1),
    removeExternalDir: invoke('skill:removeExternalDir', 1),
    setGroupEnabled: invoke('skill:setGroupEnabled', 1)
  },
  /** 自动更新 */
  update: {
    check: invoke('update:check', 0),
    download: invoke('update:download', 0),
    install: invoke('update:install', 0),
    getLastEvent: invoke('update:getLastEvent', 0),
    onEvent: event('update:event', 1)
  },
  /** 上下文菜单 */
  contextMenu: {
    popup: invoke('contextMenu:popup', 1)
  },
  /** Widgets */
  widget: {
    list: invoke('widget:list', 0),
    listArchived: invoke('widget:listArchived', 0),
    open: invoke('widget:open', 1),
    rename: invoke('widget:rename', 1),
    setArchived: invoke('widget:setArchived', 1),
    delete: invoke('widget:delete', 1),
    getServerStatus: invoke('widget:getServerStatus', 0),
    stopServer: invoke('widget:stopServer', 0),
    startWidget: invoke('widget:startWidget', 1),
    stopWidget: invoke('widget:stopWidget', 1),
    pickExportTarget: invoke('widget:pickExportTarget', 1),
    exportAsVite: invoke('widget:exportAsVite', 1),
    revealExport: invoke('widget:revealExport', 1),
    exportForDownload: invoke('widget:exportForDownload', 1)
  },
  /** Widget 独立窗口 */
  widgetWindow: {
    open: invoke('widgetWindow:open', 1),
    close: invoke('widgetWindow:close', 1),
    status: invoke('widgetWindow:status', 1),
    setPreferWindow: invoke('widgetWindow:setPreferWindow', 1),
    setAlwaysOnTop: invoke('widgetWindow:setAlwaysOnTop', 1),
    getAlwaysOnTop: invoke('widgetWindow:getAlwaysOnTop', 1)
  },
  /** 悬浮聊天 */
  pinChat: {
    pin: invoke('pinChat:pin', 1),
    unpin: invoke('pinChat:unpin', 1),
    focus: invoke('pinChat:focus', 1),
    getState: invoke('pinChat:getState', 0),
    setAlwaysOnTop: invoke('pinChat:setAlwaysOnTop', 1),
    getAlwaysOnTop: invoke('pinChat:getAlwaysOnTop', 1)
  },
  /** 通知 */
  notification: {
    reportActiveSession: invoke('notification:reportActiveSession', 1),
    consumePendingOpenSession: invoke('notification:consumePendingOpenSession', 0),
    onOpenSession: event('notification:open-session', 1)
  },
  /** 协作编辑（笔记本的编辑器） */
  liveDoc: {
    attach: invoke('liveDoc:attach', 1),
    detach: invoke('liveDoc:detach', 1),
    onRequest: event('liveDoc:request', 1),
    onCancel: event('liveDoc:cancel', 1)
  },
  /** 会话 Artifacts */
  artifact: {
    read: invoke('artifact:read', 1)
  },
  /** 会话工作目录文件 */
  files: {
    scan: invoke('files:scan', 1),
    scanDir: invoke('files:scanDir', 1),
    watch: invoke('files:watch', 1),
    unwatch: invoke('files:unwatch', 1),
    read: invoke('files:read', 1),
    open: invoke('files:open', 1),
    write: invoke('files:write', 1)
  },
  /** 知识库 */
  knowledge: {
    list: invoke('knowledge:list', 0),
    openNote: invoke('knowledge:openNote', 1),
    openFolder: invoke('knowledge:openFolder', 0),
    revealFile: invoke('knowledge:revealFile', 1),
    createBase: invoke('knowledge:createBase', 1),
    createFolder: invoke('knowledge:createFolder', 1),
    createEntry: invoke('knowledge:createEntry', 1)
  },
  /** 输入框 @ 引用 */
  mentions: {
    listKnowledgeEntries: invoke('knowledge:mentionEntries', 1),
    listSessions: invoke('session:mentionEntries', 1)
  },
  /** 网络访问（server mode phase B：局域网里的浏览器经 WebSocket 用同一张表） */
  network: {
    status: invoke('network:status', 0),
    setEnabled: invoke('network:setEnabled', 1),
    setPort: invoke('network:setPort', 1)
  },
  /** 服务端文件系统（server mode phase D：web 客户端的目录浏览器、「在文件管理器中打开」的路径） */
  fs: {
    listDirectories: invoke('fs:listDirectories', 1),
    locateFolder: invoke('fs:locateFolder', 1)
  }
} as const satisfies ApiTable

/**
 * **只有桌面窗口能用**的请求通道：它们在主进程这台电脑上弹原生界面 —— 开窗、系统文件管理器、原生对话框。
 * 网络客户端（浏览器）调它们，服务端一律回 `desktop_only` 失败、不执行（远处的人看不见那扇窗，坐在这台电脑前的人
 * 却会被它吓一跳）。web 客户端在本地给它们浏览器里的行为（phase D，`renderer/src/web/webApi.ts`）：新标签页、
 * 页面里的目录浏览器、显示路径并给一个复制按钮、导出后下载；没有本地行为的（内置浏览器窗口、悬浮窗）当场拒掉
 * 并给一条看得见的提示（不悄悄假装成功）。
 *
 * 值是理由（守卫测试核对每一条都是表里的 invoke 通道）。
 */
export const DESKTOP_ONLY_CHANNELS: Readonly<Record<string, string>> = {
  'app:open-settings': 'opens the settings window on this computer',
  'app:open-session-draft': 'brings up the main window on this computer',
  'app:open-external': "opens the system browser on this computer, not the caller's",
  'app:open-folder': 'opens the system file manager on this computer',
  'app:reveal-path': 'opens the system file manager on this computer',
  'dialog:openDirectory': 'native folder picker on this computer',
  'skill:pickExternalDir': 'native folder picker on this computer',
  'widget:pickExportTarget': 'native save dialog on this computer',
  'widget:revealExport': 'opens the system file manager on this computer',
  'subAgent:openFolder': 'opens the system file manager on this computer',
  'policy:openFolder': 'opens the system file manager on this computer',
  'hook:openFolder': 'opens the system file manager on this computer',
  'bot:openFolder': 'opens the system file manager on this computer',
  'knowledge:openFolder': 'opens the system file manager on this computer',
  'knowledge:revealFile': 'opens the system file manager on this computer',
  'files:open': 'opens a preview / markdown window on this computer',
  'widgetWindow:open': 'opens a widget window on this computer',
  'widgetWindow:status': "reports this computer's widget windows, which a browser does not have",
  'widgetWindow:setPreferWindow': "remembers this computer's window-or-panel choice for a widget",
  'pinChat:pin': 'opens a floating chat window on this computer',
  'pinChat:focus': 'focuses a floating chat window on this computer',
  'browser-view:open-window': 'opens the in-app browser window on this computer',
  'browser-view:open-settings': 'opens the in-app browser window on this computer'
}

/** 一个 override 成员底下用到的通道（`null` = 不走通道，如 `app.platform`） */
export interface ApiOverrideChannel {
  /** 线上是哪种调用（与表条目同义） */
  readonly kind: ApiMemberKind
  readonly channel: string
  /** 它在透传之外多做了什么 */
  readonly note: string
}

/**
 * 不在 `API_TABLE` 里、由宿主作为 override 交给 `buildApi` 的成员，以及它们底下的通道 —— 守卫据此核对主进程的
 * 定义（每条 invoke / send 通道恰有一个定义）与建出来的对象（override 恰好补齐这些成员）。
 */
export const API_OVERRIDE_CHANNELS = {
  app: {
    platform: null
  },
  events: {
    subscribe: {
      kind: 'event',
      channel: 'app:event',
      note: '整页只挂一个监听，本地扇出给各订阅者（每个回调各自 try/catch，派发前先复制一份）'
    }
  },
  liveDoc: {
    respond: {
      kind: 'invoke',
      channel: 'liveDoc:respond',
      note: '(requestId, result) 打包成一个 { requestId, result } 参数'
    }
  },
  knowledge: {
    baseOptions: {
      kind: 'invoke',
      channel: 'knowledge:baseOptions',
      note: '没给参数时传 {}'
    }
  },
  sync: {
    send: { kind: 'send', channel: 'sync:frame', note: '视图同步的帧（createSyncBridge）' },
    onFrame: {
      kind: 'event',
      channel: 'sync:frame',
      note: '只把（链路 id，帧）交给回调，链路 id 不是字符串的丢掉（createSyncBridge）'
    }
  }
} as const satisfies Readonly<Record<string, Readonly<Record<string, ApiOverrideChannel | null>>>>
