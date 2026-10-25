---
shuvix: okf v0.2
type: Guide
title: 'Remote access channels — every call by scope, with its access level'
description: 'Every channel a remote browser can call, in sections by `object.scope` (which part of ShuviX it is about), each with its `object.access` tag (read / write / admin); each section also lists its groups, HTTP routes and the settings decided by key — for writing a remote access policy and for looking up which scope and level a call falls in.'
tags: [shuvix, policy, security, network, remote-access, reference]
status: stable
sources:
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/apps/desktop/src/shared/channelAccess.ts
    title: channelAccess.ts — the scope and access level of every channel
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/apps/desktop/src/shared/apiTable.ts
    title: apiTable.ts — the channel table
---

# Remote access channels

A browser using ShuviX remotely does everything through **channels** — named calls over its
WebSocket. Each call is checked as a `channel` object (the `network-policy` entry): `channel` is
the name, `scope` the heading below, `access` the tag on the line, and `group` the technical group
the channel name belongs to.

Each section lists, in order:

- `group` — the technical groups (`object.group`) in this scope; a few channels of a group may
  belong to another scope (the four permission-table channels of the `session` group are in
  `security`, for example).
- `route` — the HTTP routes in this scope (`object.route` at the `request` check point).
- `read` / `write` / `admin` — the channels of this scope at each level.
- `settings:set` + a level — changing these settings through `settings:set` is judged with this
  scope and this level (`x.*` is every key that starts with `x.`). A key in no section is judged
  `system` + `admin`.
- `agent:respondToInput` + `remember` — an answer that ticks "allow and remember" is judged with
  this scope and this level.

The levels: `read` — looks, returns no secrets; `write` — changes the user's data or makes
something happen; `admin` — changes ShuviX itself, or returns secrets. What each scope covers and
where it is in the app: "Scope and access" in the `network-policy` entry.

Prefer rules on `scope` and `access`: a channel added in a later version lands in some scope with
some level and is covered, while a list of names misses it. Name channels only to make an
exception. The list is generated from the channel table of this version.

<!-- channels:begin -->

### `app`

- group: `app`, `contextMenu`, `mdMeta`, `notification`, `pinChat`, `project`, `settings`, `shuvixMd`, `tools`
- route: `page`, `asset`, `lib`, `socket`
- read: `app:version`, `app:window-ready`, `mdMeta:get`, `notification:consumePendingOpenSession`, `notification:reportActiveSession`, `pinChat:getAlwaysOnTop`, `pinChat:getState`, `project:getKnownFields`, `settings:get`, `settings:getAll`, `settings:getKnownKeys`, `settings:sandboxStatus`, `shuvixMd:validate`, `tools:presentations`
- write: `app:adjust-window-width`, `app:open-external`, `app:open-folder`, `app:open-session-draft`, `app:open-settings`, `app:reveal-path`, `app:set-browser-offset`, `app:take-session-draft`, `contextMenu:popup`, `dialog:openDirectory`, `pinChat:focus`, `pinChat:pin`, `pinChat:setAlwaysOnTop`, `pinChat:unpin`

### `sessions`

- group: `agent`, `bgTask`, `calendar`, `command`, `mentions`, `message`, `runtime`, `session`, `sync`, `tracking`
- read: `agent:init`, `agentMonitor:detail`, `agentMonitor:list`, `bgTask:list`, `bgTask:readInvocation`, `bgTask:readLog`, `calendar:daysInMonth`, `calendar:firstEntryOnDay`, `calendar:reportDaysInMonth`, `calendar:reportOnDay`, `calendar:sessionsOnDay`, `command:list`, `message:list`, `runtime:statuses`, `session:getById`, `session:list`, `session:mentionEntries`, `sync:frame`, `tracking:list`
- write: `agent:abort`, `agent:continue`, `agent:destroy`, `agent:followUp`, `agent:getInfo`, `agent:prompt`, `agent:respondToInput`, `agent:setModel`, `agent:setThinkingLevel`, `agent:steer`, `agent:subAgentPrompt`, `agent:withdrawQueued`, `bgTask:clearDone`, `bgTask:dismiss`, `bgTask:stop`, `calendar:deleteReport`, `calendar:openReport`, `message:clear`, `message:rollback`, `runtime:destroy`, `session:create`, `session:delete`, `session:fork`, `session:updateEnabledTools`, `session:updateKnowledgeBases`, `session:updateProject`, `session:updateTitle`, `subSession:destroy`, `subSession:interrupt`, `tracking:openFolder`, `tracking:openNote`
- `settings:set` admin: `session.*`

### `projects`

- group: `project`
- write: `project:create`, `project:delete`, `project:update`
- admin: `project:getById`, `project:list`, `project:listArchived`

### `files`

- group: `artifact`, `download`, `files`, `fs`, `liveDoc`
- route: `media`, `preview`, `download`
- read: `artifact:read`, `files:read`, `files:scan`, `files:scanDir`, `files:unwatch`, `files:watch`, `fs:listDirectories`, `fs:locateFolder`
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
