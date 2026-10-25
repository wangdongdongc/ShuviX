---
shuvix: okf v0.2
type: Guide
title: '远程访问的通道 —— 按 scope 分节的每一条调用，与它的访问级别'
description: '远程浏览器能调的每一条通道，按 `object.scope`（管哪一块）分节，每条带它的 `object.access`（read / write / admin）；每节另列它含的分组、HTTP 路由与按 key 定的设置项 —— 写远程访问策略、核对某条调用落在哪一块哪一档时查。'
tags: [shuvix, policy, security, network, remote-access, reference]
status: stable
sources:
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/apps/desktop/src/shared/channelAccess.ts
    title: channelAccess.ts —— 每条通道的 scope 与访问级别
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/apps/desktop/src/shared/apiTable.ts
    title: apiTable.ts —— 通道表
---

# 远程访问的通道

远程使用 ShuviX 的浏览器做的每一件事都经过**通道** —— 它的 WebSocket 上一次有名字的调用。每次调用都按 `channel`
对象判（见 `network-policy` 条目）：`channel` 是名字，`scope` 是下面的小标题，`access` 是行首的级别，`group` 是
通道名所在的技术分组。

每节依次列出：

- `group` —— 这一块含的技术分组（`object.group`）；一个分组里的个别通道可能归在别的 scope（例如 `session` 分组里
  会话权限表的四条在 `security`）。
- `route` —— 落在这一块的 HTTP 路由（`request` 点位的 `object.route`）。
- `read` / `write` / `admin` —— 这一块里各档的通道。
- `settings:set` + 档位 —— 改这些设置项时，`settings:set` 按这一块、这一档判（`x.*` 是以 `x.` 开头的所有 key）。
  不在任何一节里的 key 按 `system` + `admin`。
- `agent:respondToInput` + `remember` —— 勾了「允许并记住」的回答按这一块、这一档判。

三档：`read` —— 看，不含机密；`write` —— 改用户的数据或让事情发生；`admin` —— 改 ShuviX 本身，或返回机密。每个
scope 管什么、界面上在哪，见 `network-policy` 条目的「scope 与 access」。

规则尽量写在 `scope` 与 `access` 上：以后版本新加的通道也会归进某一块、带上某一档，照样被管住，而一张名字清单会漏掉
它。只在要开例外时点名通道。清单按这个版本的通道表生成。

<!-- channels:begin -->

### `app`

- group: `app`, `contextMenu`, `mdMeta`, `notification`, `pinChat`, `project`, `settings`, `shuvixMd`, `tools`
- route: `page`, `asset`, `lib`, `socket`
- read: `app:version`, `app:window-ready`, `mdMeta:get`, `notification:consumePendingOpenSession`, `notification:reportActiveSession`, `pinChat:getAlwaysOnTop`, `pinChat:getState`, `project:getKnownFields`, `settings:get`, `settings:getAll`, `settings:getKnownKeys`, `settings:sandboxStatus`, `shuvixMd:validate`, `tools:presentations`
- write: `app:adjust-window-width`, `app:open-external`, `app:open-folder`, `app:open-session-draft`, `app:open-settings`, `app:reveal-path`, `app:set-browser-offset`, `app:take-session-draft`, `contextMenu:popup`, `dialog:openDirectory`, `pinChat:focus`, `pinChat:pin`, `pinChat:setAlwaysOnTop`, `pinChat:unpin`

### `sessions`

- group: `agent`, `bgTask`, `calendar`, `command`, `mentions`, `message`, `runtime`, `session`, `suggestion`, `sync`, `tracking`
- read: `agent:init`, `agentMonitor:detail`, `agentMonitor:list`, `bgTask:list`, `bgTask:readInvocation`, `bgTask:readLog`, `calendar:daysInMonth`, `calendar:firstEntryOnDay`, `calendar:reportDaysInMonth`, `calendar:reportOnDay`, `calendar:sessionsOnDay`, `command:list`, `message:list`, `runtime:statuses`, `session:getById`, `session:list`, `session:mentionEntries`, `sync:frame`, `tracking:list`
- write: `agent:abort`, `agent:continue`, `agent:destroy`, `agent:followUp`, `agent:getInfo`, `agent:prompt`, `agent:respondToInput`, `agent:setModel`, `agent:setThinkingLevel`, `agent:steer`, `agent:subAgentPrompt`, `agent:withdrawQueued`, `bgTask:clearDone`, `bgTask:dismiss`, `bgTask:stop`, `calendar:deleteReport`, `calendar:openReport`, `message:clear`, `message:rollback`, `runtime:destroy`, `session:create`, `session:delete`, `session:fork`, `session:updateEnabledTools`, `session:updateKnowledgeBases`, `session:updateProject`, `session:updateTitle`, `subSession:destroy`, `subSession:interrupt`, `suggestion:accept`, `tracking:deleteItem`, `tracking:openFolder`, `tracking:openNote`
- `settings:set` admin: `session.*`

### `projects`

- group: `project`
- write: `project:create`, `project:delete`, `project:update`
- admin: `project:getById`, `project:list`, `project:listArchived`

### `files`

- group: `artifact`, `download`, `files`, `fs`, `liveDoc`
- route: `media`, `preview`, `download`
- read: `artifact:list`, `artifact:read`, `files:read`, `files:scan`, `files:scanDir`, `files:unwatch`, `files:watch`, `fs:listDirectories`, `fs:locateFolder`
- write: `download:cancel`, `files:open`, `files:write`, `liveDoc:attach`, `liveDoc:detach`, `liveDoc:respond`

### `terminal`

- group: `terminal`
- write: `terminal:create`, `terminal:destroy`, `terminal:resize`, `terminal:write`

### `browser`

- group: `browserData`, `browserView`
- read: `browser-data:cert-exceptions`, `browser-data:list-sites`, `browser-data:site-info`, `browser-view:capture`, `browser-view:get-url`, `browser-view:is-window-open`, `browser-view:list-tabs`
- write: `browser-data:clear-all`, `browser-data:clear-origin`, `browser-data:clear-site`, `browser-data:clear-site-category`, `browser-data:clear-site-data`, `browser-data:remove-cookie`, `browser-view:activate-tab`, `browser-view:agent-devtools-clear`, `browser-view:close-tab`, `browser-view:create-tab`, `browser-view:devtools-close`, `browser-view:devtools-open`, `browser-view:go-back`, `browser-view:go-forward`, `browser-view:navigate`, `browser-view:open-internal`, `browser-view:open-session`, `browser-view:open-settings`, `browser-view:open-window`, `browser-view:reload`, `browser-view:reopen-closed-tab`, `browser-view:set-devtools-layout`, `browser-view:set-layout`, `browser-view:set-visible`, `browser-view:stop`, `browser-view:zoom`
- admin: `browser-data:site-details`, `browser-view:agent-devtools`, `browser-view:proceed-unsafe`
- `settings:set` write: `browser.*`
- `settings:set` admin: `tool.browser.*`

### `widgets`

- group: `widget`, `widgetWindow`
- route: `widget`
- read: `widget:getServerStatus`, `widget:list`, `widget:listArchived`, `widgetWindow:getAlwaysOnTop`, `widgetWindow:status`
- write: `widget:delete`, `widget:exportAsVite`, `widget:exportForDownload`, `widget:open`, `widget:pickExportTarget`, `widget:rename`, `widget:revealExport`, `widget:setArchived`, `widget:startWidget`, `widget:stopServer`, `widget:stopWidget`, `widgetWindow:close`, `widgetWindow:open`, `widgetWindow:setAlwaysOnTop`, `widgetWindow:setPreferWindow`

### `knowledge`

- group: `knowledge`, `mentions`
- read: `knowledge:baseOptions`, `knowledge:list`, `knowledge:mentionEntries`
- write: `knowledge:createBase`, `knowledge:createEntry`, `knowledge:createFolder`, `knowledge:openFolder`, `knowledge:openNote`, `knowledge:revealFile`

### `agents`

- group: `bot`, `mdMeta`, `subAgent`, `trigger`
- read: `bot:list`, `subAgent:getSource`, `subAgent:list`, `subAgent:listInvalid`, `trigger:logs`, `trigger:status`
- write: `bot:openFolder`, `subAgent:openBuiltinNote`, `subAgent:openFolder`, `trigger:clearLogs`
- admin: `bot:createNew`, `bot:delete`, `bot:deleteByFile`, `bot:openNote`, `mdMeta:setFill`, `mdMeta:unsetFill`, `subAgent:create`, `subAgent:createSource`, `subAgent:delete`, `subAgent:deleteByFile`, `subAgent:openNote`, `subAgent:save`
- `settings:set` admin: `bots.*`, `general.defaultChatAgent`, `general.defaultProjectAgent`, `triggers.*`

### `extensions`

- group: `chromeExtension`, `dbCredential`, `mcp`, `skill`, `tools`
- read: `chromeExtension:status`, `mcp:getTools`, `skill:getDefaultDir`, `skill:list`, `skill:listExternalDirs`, `skill:listGrouped`, `skill:parseMarkdown`, `tools:definitions`, `tools:list`
- write: `skill:pickExternalDir`
- admin: `chromeExtension:repair`, `dbCredential:add`, `dbCredential:delete`, `dbCredential:list`, `dbCredential:testConnection`, `dbCredential:update`, `mcp:add`, `mcp:connect`, `mcp:delete`, `mcp:disconnect`, `mcp:list`, `mcp:update`, `skill:addExternalDir`, `skill:deleteDefault`, `skill:openNote`, `skill:removeExternalDir`, `skill:setGroupEnabled`, `skill:update`

### `models`

- group: `provider`
- read: `provider:listAvailableModels`, `provider:listClassifierModels`, `provider:listModels`, `provider:oauthStatus`
- admin: `provider:add`, `provider:addModel`, `provider:delete`, `provider:deleteModel`, `provider:getById`, `provider:listAll`, `provider:listEnabled`, `provider:oauthAnswer`, `provider:oauthCancel`, `provider:oauthLogin`, `provider:oauthLogout`, `provider:syncModels`, `provider:toggleEnabled`, `provider:toggleModelEnabled`, `provider:updateConfig`, `provider:updateModelCapabilities`
- `settings:set` admin: `general.defaultModel`, `general.defaultProvider`, `general.defaultThinkingLevel`, `provider.*`

### `security`

- group: `hook`, `mdMeta`, `network`, `policy`, `session`
- read: `hook:getSource`, `hook:list`, `hook:listInvalid`, `network:status`, `policy:getSource`, `policy:list`, `policy:listInvalid`, `session:listAcl`
- write: `hook:openBuiltinNote`, `hook:openFolder`, `policy:openBuiltinNote`, `policy:openFolder`
- admin: `hook:create`, `hook:delete`, `hook:deleteByFile`, `hook:openNote`, `mdMeta:setEnabled`, `network:setEnabled`, `network:setPort`, `policy:create`, `policy:delete`, `policy:deleteByFile`, `policy:openNote`, `session:grantAcl`, `session:removeAclEntry`, `session:setAclAccess`
- `settings:set` admin: `general.classifierModel`, `general.classifierProvider`, `network.*`, `sandbox.*`
- `agent:respondToInput` + `remember`: admin

### `preferences`

- group: `tts`
- read: `tts:getQwen3Status`, `tts:getQwen3Voices`
- write: `tts:abort`, `tts:cancelSetupQwen3`, `tts:speakOnce`
- admin: `tts:setupQwen3`
- `settings:set` write: `appearance.*`, `general.darkTheme`, `general.fontSize`, `general.language`, `general.lightTheme`, `general.theme`, `general.uiZoom`, `notification.*`, `shuvix.figureExport.*`, `shuvix.mobile.*`, `voice.*`, `window.*`

### `telegram`

- group: `telegram`
- read: `telegram:listBots`
- admin: `telegram:addBot`, `telegram:deleteBot`, `telegram:updateBot`, `telegram:validateToken`

### `system`

- group: `classifierLog`, `config`, `httpLog`, `settings`, `update`
- read: `classifierLog:get`, `classifierLog:list`, `classifierLog:scenes`, `config:buildExportSnapshot`, `config:parseImportPayload`, `config:planImport`, `httpLog:get`, `httpLog:list`, `update:getLastEvent`
- write: `classifierLog:clear`, `httpLog:clear`, `update:check`
- admin: `config:applyImport`, `config:buildExportPayload`, `settings:set`, `update:download`, `update:install`
- `settings:set` admin: `httpLog.*`, `updates.*`

<!-- channels:end -->
