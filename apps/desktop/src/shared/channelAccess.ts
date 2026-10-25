/**
 * 请求通道的访问级别 —— 安全策略的事实 `object.access`：网络客户端经 WebSocket 发来的每条 RPC 请求都带上它，
 * 让用户的策略一条规则就能说「我以外的设备只能调读通道」。请求通道 = `API_TABLE` 里种类为 invoke / send 的成员，
 * 加上 `API_OVERRIDE_CHANNELS` 里种类为 invoke / send 的通道（与网络分发器 `tableRequestChannels` 同一口径）；
 * event 是主进程推过去的，不是请求，不在这里。纯数据 + 一个小函数，主进程 / preload / 渲染层都能引。
 *
 * 三档，按处理函数**实际做了什么**定（不按名字猜）：
 *  - `read`：读不含机密的数据、没有副作用 —— 列表 / 详情 / 状态 / 搜索 / 预览 / 候选项；
 *  - `write`：改用户的数据或让事情发生 —— 发消息驱动 agent、中止、回答 agent 的询问卡与输入请求，建 / 改名 / 删 /
 *    归档会话与项目，写文件与笔记、知识库写入、终端输入、操控内置浏览器、导出与下载、widget 动作，在这台电脑上
 *    开东西（对话框、外链、在文件管理器中显示）、通知、起后台任务；
 *  - `admin`：改 ShuviX 自己的配置或安全设置 —— 安全策略、hooks、智能体 / bot / 技能注册表、md 开关（mdMeta）、
 *    设置、提供商与模型、MCP 配置、网络访问、应用更新、数据库凭据、Telegram Bot、Chrome 扩展 —— **或者返回值里
 *    带机密**（API key、token、密码、OAuth 凭据、数据库凭据）：看处理函数回的是什么，带 apiKey 的提供商列表就是 admin。
 *
 * **拿不准就往严里归**：读 / 写之间拿不准 → `write`；写 / 管理之间拿不准 → `admin`。看着是读、却会触发昂贵或
 * 对外的动作（替用户向第三方发网络请求、起进程）→ `write`。
 *
 * 表必须恰好覆盖全部请求通道 —— `__tests__/channelAccess.test.ts` 核对：新加的请求通道没在这里归类、或这里留着
 * 已经不是请求通道的条目，测试都会失败。不在表里的通道 `channelAccessOf` 一律按 `admin`（最严）。
 *
 * 每条通道另有一个 **scope**（`object.scope`，2026-10-23，docs/network-scope/design.md）：它管的是 ShuviX 的哪一块，
 * 见文件后半的 CHANNEL_SCOPES。少数调用按这一次带的内容定 scope 与 access（channelCallFactsOf）。
 */
import { API_OVERRIDE_CHANNELS, API_TABLE } from './apiTable'

export type ChannelAccess = 'read' | 'write' | 'admin'

export const CHANNEL_ACCESS: Readonly<Record<string, ChannelAccess>> = {
  // ─── app：应用 / 窗口 ───
  'app:open-settings': 'write',
  'app:open-session-draft': 'write',
  'app:take-session-draft': 'write', // 取走即删
  'app:open-external': 'write',
  'app:open-folder': 'write',
  'app:reveal-path': 'write',
  'app:window-ready': 'read', // 页面画好了：桌面让窗口显示、套 UI 缩放；网络客户端调它什么也不改 —— 页面每次加载都发
  'app:adjust-window-width': 'write',
  'app:set-browser-offset': 'write',
  'app:version': 'read',
  'dialog:openDirectory': 'write',

  // ─── agent：驱动 agent、派生 agent、监控 ───
  'agent:init': 'read', // 名字像动作，实为取会话的模型 / 工具等元信息：不创建 agent、不打开运行
  'agent:prompt': 'write',
  'agent:subAgentPrompt': 'write',
  'subSession:destroy': 'write',
  'subSession:interrupt': 'write',
  'agent:steer': 'write',
  'agent:followUp': 'write',
  'agent:withdrawQueued': 'write',
  'agent:abort': 'write',
  'agent:continue': 'write',
  'agent:setModel': 'write',
  'agent:destroy': 'write',
  'agent:setThinkingLevel': 'write',
  'agent:getInfo': 'write', // 带 ensure 时会打开会话、创建 agent（锁配置、连 MCP）
  'agentMonitor:list': 'read',
  'agentMonitor:detail': 'read',
  'agent:respondToInput': 'write', // 回答询问卡 / 输入请求（勾了「允许并记住」按 admin，见 channelCallAccessOf）

  // ─── provider：提供商与模型（含订阅登录） ───
  'provider:listAll': 'admin', // 返回值带解密后的 apiKey 与自定义请求头
  'provider:listEnabled': 'admin', // 同上
  'provider:getById': 'admin', // 同上
  'provider:updateConfig': 'admin',
  'provider:toggleEnabled': 'admin',
  'provider:listModels': 'read',
  'provider:listAvailableModels': 'read',
  'provider:listClassifierModels': 'read',
  'provider:toggleModelEnabled': 'admin',
  'provider:syncModels': 'admin', // 拿 key 请求提供商、改写模型表
  'provider:add': 'admin',
  'provider:delete': 'admin',
  'provider:addModel': 'admin',
  'provider:deleteModel': 'admin',
  'provider:updateModelCapabilities': 'admin',
  'provider:oauthStatus': 'read', // 只有是否登录、到期时间，不带凭据
  'provider:oauthLogin': 'admin',
  'provider:oauthCancel': 'admin',
  'provider:oauthLogout': 'admin',
  'provider:oauthAnswer': 'admin',

  // ─── project：项目 ───
  'project:list': 'admin', // 返回值带项目环境变量的明文值（含标了敏感的）
  'project:listArchived': 'admin', // 同上
  'project:getById': 'admin', // 同上
  'project:create': 'write',
  'project:update': 'write',
  'project:delete': 'write',
  'project:getKnownFields': 'read',

  // ─── session：会话 ───
  'session:list': 'read',
  'session:create': 'write',
  'session:updateTitle': 'write',
  'session:updateProject': 'write',
  'session:updateEnabledTools': 'write',
  'session:updateKnowledgeBases': 'write',
  'session:listAcl': 'read',
  // 会话权限表的增、删、改同一级：都是安全状态（谁能免询问地读写哪里）
  'session:grantAcl': 'admin',
  'session:setAclAccess': 'admin',
  'session:removeAclEntry': 'admin',
  'session:fork': 'write',
  'session:delete': 'write',
  'session:getById': 'read',

  // ─── calendar：桌面日历（查开口日；日报是用户自己的数据：读是 read，建 / 插入是 write） ───
  'calendar:daysInMonth': 'read',
  'calendar:sessionsOnDay': 'read',
  'calendar:firstEntryOnDay': 'read',
  'calendar:reportDaysInMonth': 'read',
  'calendar:reportOnDay': 'read',
  'calendar:openReport': 'write', // 那天还没有就按模板建文件 + 笔记本会话
  'calendar:addSessionToReport': 'write',
  'calendar:deleteReport': 'write', // 删日报文件 + 它的笔记本会话

  // ─── tracking：跟踪项（实验；用户自己的数据：列出是 read，开笔记本 / 开目录是 write） ───
  'tracking:list': 'read',
  'tracking:openNote': 'write',
  'tracking:openFolder': 'write',

  // ─── message：消息 ───
  'message:list': 'read',
  'message:clear': 'write',
  'message:rollback': 'write',

  // ─── settings：设置 ───
  'settings:getAll': 'read', // 设置表里没有机密（凭据都在各自的表里）
  'settings:get': 'read',
  'settings:set': 'admin', // 按 key 定（SETTING_KEY_FACTS）；这一档是 key 缺了 / 不认识时的
  'settings:getKnownKeys': 'read',
  'settings:sandboxStatus': 'read',

  // ─── httpLog：LLM 请求日志 ───
  'httpLog:list': 'read',
  'httpLog:get': 'read', // 记的是请求体，不含请求头里的 key
  'httpLog:clear': 'write',

  // ─── classifierLog：分类器调用日志 ───
  'classifierLog:list': 'read',
  'classifierLog:get': 'read',
  'classifierLog:scenes': 'read',
  'classifierLog:clear': 'write',

  // ─── runtime：会话的运行时资源（数据库连接、ssh） ───
  'runtime:statuses': 'read',
  'runtime:destroy': 'write',

  // ─── dbCredential：数据库凭据 ───
  'dbCredential:list': 'admin', // 不含密码，但主机 / 用户名 / 驱动参数都属凭据
  'dbCredential:add': 'admin',
  'dbCredential:update': 'admin',
  'dbCredential:delete': 'admin',
  'dbCredential:testConnection': 'admin', // 拿传来的凭据连外部数据库，凭据管理的一部分

  // ─── subAgent：智能体档案（注册表） ───
  'subAgent:list': 'read',
  'subAgent:save': 'admin',
  'subAgent:create': 'admin',
  'subAgent:delete': 'admin',
  'subAgent:listInvalid': 'read',
  'subAgent:deleteByFile': 'admin',
  'subAgent:getSource': 'read',
  'subAgent:createSource': 'admin',
  'subAgent:openNote': 'admin', // 打开的笔记本就是档案文件的编辑器
  'subAgent:openBuiltinNote': 'write', // 只读笔记本，但会建 / 复用一条笔记本会话
  'subAgent:openFolder': 'write',

  // ─── policy：安全策略 ───
  'policy:list': 'read',
  'policy:getSource': 'read',
  'policy:create': 'admin',
  'policy:delete': 'admin',
  'policy:listInvalid': 'read',
  'policy:deleteByFile': 'admin',
  'policy:openNote': 'admin', // 策略文件的编辑器
  'policy:openBuiltinNote': 'write', // 只读笔记本，但会建 / 复用一条笔记本会话
  'policy:openFolder': 'write',

  // ─── hook：Hooks ───
  'hook:list': 'read',
  'hook:getSource': 'read',
  'hook:create': 'admin',
  'hook:delete': 'admin',
  'hook:listInvalid': 'read',
  'hook:deleteByFile': 'admin',
  'hook:openNote': 'admin', // hook 文件的编辑器
  'hook:openBuiltinNote': 'write', // 只读笔记本，但会建 / 复用一条笔记本会话
  'hook:openFolder': 'write',

  // ─── bot：Bots（注册表） ───
  'trigger:status': 'read',
  'trigger:logs': 'read',
  'trigger:clearLogs': 'write',
  'bot:list': 'read',
  'bot:openNote': 'admin', // bot 文件的编辑器
  'bot:createNew': 'admin',
  'bot:delete': 'admin',
  'bot:deleteByFile': 'admin',
  'bot:openFolder': 'write',

  // ─── shuvixMd：契约 md 校验（无状态） ───
  'shuvixMd:validate': 'read',

  // ─── mdMeta：md 扩展元数据（补缺值、内置项开关） ───
  'mdMeta:get': 'read',
  'mdMeta:setFill': 'admin',
  'mdMeta:unsetFill': 'admin',
  'mdMeta:setEnabled': 'admin',

  // ─── tools：工具 ───
  'tools:list': 'read',
  'tools:presentations': 'read',
  'tools:definitions': 'read',

  // ─── config：配置导出 / 导入 ───
  'config:buildExportSnapshot': 'read', // 只有提供商与 MCP 的名字
  'config:buildExportPayload': 'admin', // 可带 apiKey 与 MCP 的 env / headers
  'config:parseImportPayload': 'read', // 只解码调用方自己给的串
  'config:planImport': 'read',
  'config:applyImport': 'admin',

  // ─── mcp：MCP 客户端 ───
  'mcp:list': 'admin', // 返回值带 env 与 headers（常放 key / token）
  'mcp:add': 'admin',
  'mcp:update': 'admin',
  'mcp:delete': 'admin',
  'mcp:connect': 'admin', // 设置页的连接管理：起配置里的进程，所有会话共用
  'mcp:disconnect': 'admin', // 同上：断开所有会话共用的连接
  'mcp:getTools': 'read',

  // ─── telegram：Telegram Bot ───
  'telegram:listBots': 'read', // 不带 token
  'telegram:addBot': 'admin',
  'telegram:updateBot': 'admin',
  'telegram:deleteBot': 'admin',
  'telegram:validateToken': 'admin', // 拿 token 请求 Telegram，Bot 登记的一部分

  // ─── command：斜杠命令 ───
  'command:list': 'read',

  // ─── tts：文字转语音 ───
  'tts:speakOnce': 'write', // OpenAI 后端会替用户请求第三方
  'tts:abort': 'write',
  'tts:getQwen3Status': 'read',
  'tts:getQwen3Voices': 'read',
  'tts:setupQwen3': 'admin', // 下载 Python、pip 装依赖、下载模型 —— 往本机装可执行的东西
  'tts:cancelSetupQwen3': 'write',

  // ─── download：下载 ───
  'download:cancel': 'write',

  // ─── bgTask：后台任务 ───
  'bgTask:list': 'read',
  'bgTask:readLog': 'read',
  'bgTask:stop': 'write',
  'bgTask:dismiss': 'write',
  'bgTask:clearDone': 'write',
  'bgTask:readInvocation': 'read',

  // ─── terminal：终端（node-pty） ───
  'terminal:create': 'write',
  'terminal:write': 'write',
  'terminal:resize': 'write',
  'terminal:destroy': 'write',

  // ─── browserView：内置浏览器 ───
  'browser-view:open-window': 'write',
  'browser-view:is-window-open': 'read',
  'browser-view:create-tab': 'write',
  'browser-view:close-tab': 'write',
  'browser-view:reopen-closed-tab': 'write',
  'browser-view:activate-tab': 'write',
  'browser-view:list-tabs': 'read',
  'browser-view:navigate': 'write',
  'browser-view:go-back': 'write',
  'browser-view:go-forward': 'write',
  'browser-view:reload': 'write',
  'browser-view:stop': 'write',
  'browser-view:get-url': 'read',
  'browser-view:set-layout': 'write',
  'browser-view:capture': 'read', // 页面截图
  'browser-view:zoom': 'write',
  'browser-view:open-session': 'write',
  'browser-view:open-settings': 'write',
  'browser-view:open-internal': 'write',
  'browser-view:proceed-unsafe': 'admin', // 越过证书错误、记下证书例外（安全决定）
  'browser-view:set-visible': 'write',
  'browser-view:devtools-open': 'write',
  'browser-view:devtools-close': 'write',
  'browser-view:set-devtools-layout': 'write',
  // agent 在页面上的 devtool 调用与它的网络 / 控制台采集：结果里可能有 cookie 值（cdp Network.getCookies）等登录凭据
  'browser-view:agent-devtools': 'admin',
  'browser-view:agent-devtools-clear': 'write',

  // ─── chromeExtension：Chrome 扩展 ───
  'chromeExtension:status': 'read',
  'chromeExtension:repair': 'admin', // 重装原生消息宿主

  // ─── browserData：内置浏览器的分区数据 ───
  'browser-data:list-sites': 'read',
  'browser-data:clear-site': 'write',
  'browser-data:site-details': 'admin', // 返回值带 Cookie 的值（登录令牌）
  'browser-data:clear-site-category': 'write',
  'browser-data:clear-origin': 'write',
  'browser-data:remove-cookie': 'write',
  'browser-data:clear-all': 'write',
  'browser-data:site-info': 'read', // 只有 Cookie 条数与有没有证书例外
  'browser-data:clear-site-data': 'write',
  'browser-data:cert-exceptions': 'read',

  // ─── skill：技能（注册表） ───
  'skill:openNote': 'admin', // SKILL.md 的编辑器（内置那份只读，同一条通道）
  'skill:list': 'read',
  'skill:listGrouped': 'read',
  'skill:update': 'admin',
  'skill:deleteDefault': 'admin',
  'skill:parseMarkdown': 'read',
  'skill:getDefaultDir': 'read',
  'skill:listExternalDirs': 'read',
  'skill:pickExternalDir': 'write', // 只弹选择框、回路径，添加走 addExternalDir
  'skill:addExternalDir': 'admin',
  'skill:removeExternalDir': 'admin',
  'skill:setGroupEnabled': 'admin',

  // ─── update：自动更新 ───
  'update:check': 'write', // 向更新服务器发请求
  'update:download': 'admin',
  'update:install': 'admin',
  'update:getLastEvent': 'read',

  // ─── contextMenu：上下文菜单 ───
  'contextMenu:popup': 'write', // 在这台电脑上弹原生菜单

  // ─── widget：Widgets ───
  'widget:list': 'read',
  'widget:listArchived': 'read',
  'widget:open': 'write', // 构建并注册到 widget 服务器
  'widget:rename': 'write',
  'widget:setArchived': 'write',
  'widget:delete': 'write',
  'widget:getServerStatus': 'read',
  'widget:stopServer': 'write',
  'widget:startWidget': 'write',
  'widget:stopWidget': 'write',
  'widget:pickExportTarget': 'write',
  'widget:exportAsVite': 'write',
  'widget:revealExport': 'write',
  'widget:exportForDownload': 'write',

  // ─── widgetWindow：Widget 独立窗口 ───
  'widgetWindow:open': 'write',
  'widgetWindow:close': 'write',
  'widgetWindow:status': 'read',
  'widgetWindow:setPreferWindow': 'write',
  'widgetWindow:setAlwaysOnTop': 'write',
  'widgetWindow:getAlwaysOnTop': 'read',

  // ─── pinChat：悬浮聊天 ───
  'pinChat:pin': 'write',
  'pinChat:unpin': 'write',
  'pinChat:focus': 'write',
  'pinChat:getState': 'read',
  'pinChat:setAlwaysOnTop': 'write',
  'pinChat:getAlwaysOnTop': 'read',

  // ─── notification：通知 ───
  'notification:reportActiveSession': 'read', // 只撤掉该会话名下的通知（界面状态）—— 页面看会话时就发，只读设备也得能调
  'notification:consumePendingOpenSession': 'read', // 取走暂存的跳转目标（界面状态）—— 页面加载时就调

  // ─── liveDoc：协作编辑 ───
  'liveDoc:attach': 'write',
  'liveDoc:detach': 'write',
  'liveDoc:respond': 'write', // override：编辑器对改文档请求的答复

  // ─── artifact：会话 Artifacts ───
  'artifact:read': 'read',

  // ─── files：会话工作目录文件 ───
  'files:scan': 'read',
  'files:scanDir': 'read',
  'files:watch': 'read', // 只挂监听（内容变了推给界面），不动文件
  'files:unwatch': 'read',
  'files:read': 'read', // 宿主不限路径：网络客户端读的位置另过 path 点位（files / read）
  'files:open': 'write',
  'files:write': 'write', // 也能写到注册表目录里的 md：网络客户端写的位置另过 path 点位（files / write）

  // ─── knowledge / mentions：知识库 ───
  'knowledge:list': 'read',
  'knowledge:openNote': 'write',
  'knowledge:openFolder': 'write',
  'knowledge:revealFile': 'write',
  'knowledge:createBase': 'write',
  'knowledge:createFolder': 'write',
  'knowledge:createEntry': 'write',
  'knowledge:baseOptions': 'read', // override
  'knowledge:mentionEntries': 'read',
  'session:mentionEntries': 'read',

  // ─── network：网络访问 ───
  'network:status': 'read',
  'network:setEnabled': 'admin',
  'network:setPort': 'admin',

  // ─── fs：服务端文件系统（web 客户端的目录浏览器） ───
  'fs:listDirectories': 'read', // 宿主不限路径：网络客户端列的目录另过 path 点位（fs / listDirectories）
  'fs:locateFolder': 'read', // 目录不在会先建好（与 openFolder 同口径），别无副作用

  // ─── sync：视图同步（override） ───
  'sync:frame': 'read' // 订阅 / 释放会话视图的帧（只看）；网络客户端不经请求分发走这条
}

/** 不在表里的通道一律按 admin（最严） */
export function channelAccessOf(channel: string): ChannelAccess {
  return Object.hasOwn(CHANNEL_ACCESS, channel) ? CHANNEL_ACCESS[channel] : 'admin'
}

// ─────────────────────────── scope ───────────────────────────

/**
 * scope 的词表 —— 安全策略的事实 `object.scope`：这次请求管的是 ShuviX 的哪一块。按**它管的是什么**分，不按它出现在
 * 哪个 tab（「通用」里同时有外观、默认模型、命令分类器、网络访问）。词表是对用户的契约：知识库 `network-policy` 与
 * `network-channels` 逐个讲它管什么、界面上在哪，改名就是不兼容 —— 新通道归进已有的 scope，真要加一个是一次显式的
 * 决定（用户裁决 2026-10-23：15 个，一个人记得住）。
 *
 *  - `app`：页面每次加载都要的读取与应用外壳（窗口、右键菜单、通知、悬浮聊天）—— 拒掉它的 read，页面就打不开；
 *  - `sessions`：会话、和 agent 对话、消息、子会话、后台任务、运行时资源、斜杠命令、日历与日报；
 *  - `projects`：项目，含项目环境变量；
 *  - `files`：工作目录文件的列 / 读 / 写 / 预览 / 下载、笔记本协作编辑、Artifacts、服务端目录浏览；
 *  - `terminal`：终端；
 *  - `browser`：内置浏览器（标签页、浏览、DevTools、站点数据、证书例外）与它的设置项；
 *  - `widgets`：Widgets 与它们的独立窗口；
 *  - `knowledge`：知识库与条目；
 *  - `agents`：智能体档案、Bot、默认智能体；
 *  - `extensions`：工具、MCP 服务器、技能、数据库连接、Chrome 扩展；
 *  - `models`：提供商（含 API key 与订阅登录）、模型、默认模型与思考档位；
 *  - `security`：安全策略、hooks（自动审查是一个 hook）、会话权限表、命令沙箱、命令分类器、远程访问本身；
 *  - `preferences`：外观、语言、字号、缩放、通知开关、语音与 TTS；
 *  - `telegram`：Telegram Bot；
 *  - `system`：应用更新、配置导入导出、监视器日志（LLM 请求日志、分类器日志）。
 */
export const CHANNEL_SCOPES = [
  'app',
  'sessions',
  'projects',
  'files',
  'terminal',
  'browser',
  'widgets',
  'knowledge',
  'agents',
  'extensions',
  'models',
  'security',
  'preferences',
  'telegram',
  'system'
] as const

export type ChannelScope = (typeof CHANNEL_SCOPES)[number]

/**
 * 通道表的命名空间（`window.api.<group>`，即策略里的 `object.group`）→ scope。一个分组整体落在一个 scope 里，
 * 个别通道的例外写在 CHANNEL_SCOPE_OVERRIDES。测试核对：每条请求通道所在的分组都在这里。
 */
export const GROUP_SCOPE: Readonly<Record<string, ChannelScope>> = {
  app: 'app',
  contextMenu: 'app',
  notification: 'app',
  pinChat: 'app',
  shuvixMd: 'app',
  settings: 'app', // 读；settings:set 按 key 定（SETTING_KEY_FACTS）
  agent: 'sessions',
  session: 'sessions',
  message: 'sessions',
  calendar: 'sessions',
  tracking: 'sessions', // 跟踪项（实验）：与日报同属「用户这些天在做什么」
  runtime: 'sessions',
  bgTask: 'sessions',
  command: 'sessions',
  mentions: 'sessions',
  sync: 'sessions',
  project: 'projects',
  files: 'files',
  fs: 'files',
  liveDoc: 'files',
  download: 'files',
  artifact: 'files',
  terminal: 'terminal',
  browserView: 'browser',
  browserData: 'browser',
  widget: 'widgets',
  widgetWindow: 'widgets',
  knowledge: 'knowledge',
  subAgent: 'agents',
  bot: 'agents',
  trigger: 'agents', // 触发源（实验）：内置 timer 驱动 bot
  mdMeta: 'agents', // 补缺值只有 agent 的模型与思考档位（MD_FM_FILL_KEYS）
  tools: 'extensions',
  mcp: 'extensions',
  skill: 'extensions',
  dbCredential: 'extensions',
  chromeExtension: 'extensions',
  provider: 'models',
  policy: 'security',
  hook: 'security',
  network: 'security',
  tts: 'preferences',
  telegram: 'telegram',
  update: 'system',
  config: 'system',
  httpLog: 'system',
  classifierLog: 'system'
}

/** 不随分组走的通道 */
export const CHANNEL_SCOPE_OVERRIDES: Readonly<Record<string, ChannelScope>> = {
  // 会话权限表：谁能免询问地读写哪里 —— 安全状态
  'session:listAcl': 'security',
  'session:grantAcl': 'security',
  'session:setAclAccess': 'security',
  'session:removeAclEntry': 'security',
  'knowledge:mentionEntries': 'knowledge',
  // 页面每次加载都调（useAppInit）：拒掉它们整页起不来，所以归 app
  'project:getKnownFields': 'app',
  'tools:presentations': 'app',
  // 属性卡读一份注册表笔记的元数据（agent / bot / hook / policy 都有）
  'mdMeta:get': 'app',
  // 停用 / 启用内置的安全策略与 hook（MD_DISABLEABLE_KINDS）—— 关掉内置自动审查走的就是它
  'mdMeta:setEnabled': 'security',
  // 按 key 定；这一格是 key 缺了 / 不认识时的
  'settings:set': 'system'
}

/** 一条通道的 scope；不在任何分组里的 → system */
export function channelScopeOf(channel: string): ChannelScope {
  if (Object.hasOwn(CHANNEL_SCOPE_OVERRIDES, channel)) return CHANNEL_SCOPE_OVERRIDES[channel]
  const group = channelGroupOf(channel)
  return group !== '' && Object.hasOwn(GROUP_SCOPE, group) ? GROUP_SCOPE[group] : 'system'
}

/** 通道 → 它在通道表里的命名空间（`session:list` → `session`）；不在表里 → 空串 */
const GROUP_OF: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>()
  for (const [group, members] of Object.entries(API_TABLE)) {
    for (const member of Object.values(members)) {
      if (!map.has(member.channel)) map.set(member.channel, group)
    }
  }
  for (const [group, members] of Object.entries(API_OVERRIDE_CHANNELS)) {
    for (const member of Object.values(members)) {
      if (member !== null && !map.has(member.channel)) map.set(member.channel, group)
    }
  }
  return map
})()

export function channelGroupOf(channel: string): string {
  return GROUP_OF.get(channel) ?? ''
}

// ─────────────────────────── 设置项 ───────────────────────────

export interface CallFacts {
  readonly scope: ChannelScope
  readonly access: ChannelAccess
}

/**
 * `settings:set` 按 key 定 scope 与 access（用户裁决 2026-10-23）：**只影响外观与个人习惯的 → write；改变 agent
 * 能做什么、花谁的钱、连到哪、谁能进来的 → admin**。键以 `.` 结尾的是前缀。精确 key 优先，其次最长的前缀，都不中 →
 * `system` + `admin`（最严）。测试核对 KNOWN_SETTINGS 与代码里写的每个 key 都落在一条明确的条目上。
 */
export const SETTING_KEY_FACTS: Readonly<Record<string, CallFacts>> = {
  'general.theme': { scope: 'preferences', access: 'write' },
  'general.darkTheme': { scope: 'preferences', access: 'write' },
  'general.lightTheme': { scope: 'preferences', access: 'write' },
  'general.language': { scope: 'preferences', access: 'write' },
  'general.fontSize': { scope: 'preferences', access: 'write' },
  'general.uiZoom': { scope: 'preferences', access: 'write' },
  'appearance.': { scope: 'preferences', access: 'write' },
  'notification.': { scope: 'preferences', access: 'write' },
  'voice.': { scope: 'preferences', access: 'write' }, // TTS 的引擎、音色、语速；装 Qwen3 另走 tts:setupQwen3（admin）
  'window.': { scope: 'preferences', access: 'write' },
  'shuvix.mobile.': { scope: 'preferences', access: 'write' },
  'shuvix.figureExport.': { scope: 'preferences', access: 'write' },
  'browser.': { scope: 'browser', access: 'write' }, // 搜索引擎、视图模式、DevTools 高度
  'tool.browser.': { scope: 'browser', access: 'admin' }, // 忽略证书错误
  'general.defaultProvider': { scope: 'models', access: 'admin' },
  'general.defaultModel': { scope: 'models', access: 'admin' },
  'general.defaultThinkingLevel': { scope: 'models', access: 'admin' },
  'provider.': { scope: 'models', access: 'admin' },
  'general.defaultChatAgent': { scope: 'agents', access: 'admin' },
  'general.defaultProjectAgent': { scope: 'agents', access: 'admin' },
  'session.': { scope: 'sessions', access: 'admin' }, // 重启后续跑中断的会话
  'triggers.': { scope: 'agents', access: 'admin' }, // 触发源开关：关掉内置 timer 就没有 bot 会被定时叫起来
  'bots.': { scope: 'agents', access: 'admin' }, // 随应用提供的 bot 的内置 id 认定（daily-bot-access 据此放宽权限）
  'sandbox.': { scope: 'security', access: 'admin' },
  'general.classifierProvider': { scope: 'security', access: 'admin' }, // 命令风险分类器：read_only 的命令跳过审查
  'general.classifierModel': { scope: 'security', access: 'admin' },
  'network.': { scope: 'security', access: 'admin' },
  'httpLog.': { scope: 'system', access: 'admin' }, // 把每次 LLM 请求的内容记到磁盘
  'updates.': { scope: 'system', access: 'admin' }
}

const UNKNOWN_SETTING: CallFacts = { scope: 'system', access: 'admin' }

/** 一个设置项的 scope 与 access；`matched`：落在哪一条（没有 → 空串，按最严） */
export function settingKeyFactsOf(key: unknown): CallFacts & { matched: string } {
  if (typeof key !== 'string' || key === '') return { ...UNKNOWN_SETTING, matched: '' }
  if (!key.endsWith('.') && Object.hasOwn(SETTING_KEY_FACTS, key)) {
    return { ...SETTING_KEY_FACTS[key], matched: key }
  }
  let best = ''
  for (const entry of Object.keys(SETTING_KEY_FACTS)) {
    if (entry.endsWith('.') && key.startsWith(entry) && entry.length > best.length) best = entry
  }
  return best ? { ...SETTING_KEY_FACTS[best], matched: best } : { ...UNKNOWN_SETTING, matched: '' }
}

// ─────────────────────────── 一次调用 ───────────────────────────

/**
 * 一次请求的 scope 与访问级别：通常就是通道的那一格。例外两处：
 *  - `settings:set`：按要写的 key（SETTING_KEY_FACTS）；
 *  - 回答询问卡时勾了「允许并记住」（`agent:respondToInput` 的 `response.extra.rememberPath` / 会话询问的
 *    `extra.remember`）是往会话权限表里写一行，与 `session:grantAcl` 同一格（security + admin）—— 否则只许 write
 *    的设备绕过权限表的那一档，答一张卡就给会话加上永久授权。
 */
export function channelCallFactsOf(channel: string, args: readonly unknown[]): CallFacts {
  if (channel === 'settings:set') {
    const { scope, access } = settingKeyFactsOf((args[0] as { key?: unknown } | null)?.key)
    return { scope, access }
  }
  if (channel === 'agent:respondToInput' && remembersGrant(args[0])) {
    return { scope: 'security', access: 'admin' }
  }
  return { scope: channelScopeOf(channel), access: channelAccessOf(channel) }
}

export function channelCallAccessOf(channel: string, args: readonly unknown[]): ChannelAccess {
  return channelCallFactsOf(channel, args).access
}

function remembersGrant(params: unknown): boolean {
  const response = (params as { response?: unknown } | null)?.response
  const extra = (response as { extra?: unknown } | null | undefined)?.extra as
    | { rememberPath?: unknown; remember?: unknown }
    | null
    | undefined
  return !!extra?.rememberPath || !!extra?.remember
}
