---
shuvix: okf v0.2
type: Guide
title: 'Remote access channels — every call a browser can make, with its access tag'
description: 'The list of channels a remote browser calls over the WebSocket, grouped by `object.group`, each with its `object.access` tag (read / write / admin) — for writing channel rules in a remote access policy.'
tags: [shuvix, policy, security, network, remote-access, reference]
status: stable
sources:
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/apps/desktop/src/shared/channelAccess.ts
    title: channelAccess.ts — the access tag of every channel
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/apps/desktop/src/shared/apiTable.ts
    title: apiTable.ts — the channel table
---

# Remote access channels

A browser using ShuviX remotely does everything through **channels** — named calls over its
WebSocket. Each call is checked as a `channel` object (the `network-policy` entry): `channel` is
the name, `group` the heading below, `access` the tag on the line.

- `read` — reads data and returns no secrets.
- `write` — changes the user's data or makes something happen.
- `admin` — changes ShuviX itself (policies, hooks, agents, settings, providers, network
  access, updates) or returns secrets.

Prefer rules on `access` and `group`: a channel added in a later version gets a tag and is
covered, while a list of names misses it. Name channels only to make an exception. The list is
generated from the channel table of this version.

<!-- channels:begin -->

### `app`

- read: `app:version`, `app:window-ready`
- write: `app:adjust-window-width`, `app:open-external`, `app:open-folder`, `app:open-session-draft`, `app:open-settings`, `app:reveal-path`, `app:set-browser-offset`, `app:take-session-draft`, `dialog:openDirectory`

### `agent`

- read: `agent:init`, `agentMonitor:detail`, `agentMonitor:list`
- write: `agent:abort`, `agent:continue`, `agent:destroy`, `agent:followUp`, `agent:getInfo`, `agent:prompt`, `agent:respondToInput`, `agent:setModel`, `agent:setThinkingLevel`, `agent:steer`, `agent:subAgentPrompt`, `agent:withdrawQueued`, `subSession:destroy`, `subSession:interrupt`

### `provider`

- read: `provider:listAvailableModels`, `provider:listClassifierModels`, `provider:listModels`, `provider:oauthStatus`
- admin: `provider:add`, `provider:addModel`, `provider:delete`, `provider:deleteModel`, `provider:getById`, `provider:listAll`, `provider:listEnabled`, `provider:oauthAnswer`, `provider:oauthCancel`, `provider:oauthLogin`, `provider:oauthLogout`, `provider:syncModels`, `provider:toggleEnabled`, `provider:toggleModelEnabled`, `provider:updateConfig`, `provider:updateModelCapabilities`

### `project`

- read: `project:getKnownFields`
- write: `project:create`, `project:delete`, `project:update`
- admin: `project:getById`, `project:list`, `project:listArchived`

### `session`

- read: `session:getById`, `session:list`
- write: `session:create`, `session:delete`, `session:fork`, `session:updateEnabledTools`, `session:updateKnowledgeBases`, `session:updateProject`, `session:updateTitle`
- admin: `session:removeAllowListEntry`

### `calendar`

- read: `calendar:daysInMonth`, `calendar:firstEntryOnDay`, `calendar:sessionsOnDay`

### `message`

- read: `message:list`
- write: `message:clear`, `message:rollback`

### `settings`

- read: `settings:get`, `settings:getAll`, `settings:getKnownKeys`, `settings:sandboxStatus`
- admin: `settings:set`

### `httpLog`

- read: `httpLog:get`, `httpLog:list`
- write: `httpLog:clear`

### `classifierLog`

- read: `classifierLog:get`, `classifierLog:list`, `classifierLog:scenes`
- write: `classifierLog:clear`

### `runtime`

- read: `runtime:statuses`
- write: `runtime:destroy`

### `dbCredential`

- admin: `dbCredential:add`, `dbCredential:delete`, `dbCredential:list`, `dbCredential:testConnection`, `dbCredential:update`

### `subAgent`

- read: `subAgent:getSource`, `subAgent:list`, `subAgent:listInvalid`
- write: `subAgent:openBuiltinNote`, `subAgent:openFolder`
- admin: `subAgent:create`, `subAgent:createSource`, `subAgent:delete`, `subAgent:deleteByFile`, `subAgent:openNote`, `subAgent:save`

### `policy`

- read: `policy:getSource`, `policy:list`, `policy:listInvalid`
- write: `policy:openBuiltinNote`, `policy:openFolder`
- admin: `policy:create`, `policy:delete`, `policy:deleteByFile`, `policy:openNote`

### `hook`

- read: `hook:getSource`, `hook:list`, `hook:listInvalid`
- write: `hook:openBuiltinNote`, `hook:openFolder`
- admin: `hook:create`, `hook:delete`, `hook:deleteByFile`, `hook:openNote`

### `bot`

- read: `bot:list`
- write: `bot:openFolder`
- admin: `bot:createNew`, `bot:delete`, `bot:deleteByFile`, `bot:openNote`

### `shuvixMd`

- read: `shuvixMd:validate`

### `mdMeta`

- read: `mdMeta:get`
- admin: `mdMeta:setEnabled`, `mdMeta:setFill`, `mdMeta:unsetFill`

### `tools`

- read: `tools:definitions`, `tools:list`, `tools:presentations`

### `config`

- read: `config:buildExportSnapshot`, `config:parseImportPayload`, `config:planImport`
- admin: `config:applyImport`, `config:buildExportPayload`

### `mcp`

- read: `mcp:getTools`
- admin: `mcp:add`, `mcp:connect`, `mcp:delete`, `mcp:disconnect`, `mcp:list`, `mcp:update`

### `telegram`

- read: `telegram:listBots`
- admin: `telegram:addBot`, `telegram:deleteBot`, `telegram:updateBot`, `telegram:validateToken`

### `command`

- read: `command:list`

### `tts`

- read: `tts:getQwen3Status`, `tts:getQwen3Voices`
- write: `tts:abort`, `tts:cancelSetupQwen3`, `tts:speakOnce`
- admin: `tts:setupQwen3`

### `download`

- write: `download:cancel`

### `bgTask`

- read: `bgTask:list`, `bgTask:readInvocation`, `bgTask:readLog`
- write: `bgTask:clearDone`, `bgTask:dismiss`, `bgTask:stop`

### `terminal`

- write: `terminal:create`, `terminal:destroy`, `terminal:resize`, `terminal:write`

### `browserView`

- read: `browser-view:capture`, `browser-view:get-url`, `browser-view:is-window-open`, `browser-view:list-tabs`
- write: `browser-view:activate-tab`, `browser-view:close-tab`, `browser-view:create-tab`, `browser-view:go-back`, `browser-view:go-forward`, `browser-view:navigate`, `browser-view:open-internal`, `browser-view:open-session`, `browser-view:open-settings`, `browser-view:open-window`, `browser-view:reload`, `browser-view:reopen-closed-tab`, `browser-view:set-layout`, `browser-view:set-visible`, `browser-view:stop`, `browser-view:zoom`
- admin: `browser-view:proceed-unsafe`

### `chromeExtension`

- read: `chromeExtension:status`
- admin: `chromeExtension:repair`

### `browserData`

- read: `browser-data:cert-exceptions`, `browser-data:list-sites`, `browser-data:site-info`
- write: `browser-data:clear-all`, `browser-data:clear-origin`, `browser-data:clear-site`, `browser-data:clear-site-category`, `browser-data:clear-site-data`, `browser-data:remove-cookie`
- admin: `browser-data:site-details`

### `skill`

- read: `skill:getDefaultDir`, `skill:list`, `skill:listExternalDirs`, `skill:listGrouped`, `skill:parseMarkdown`
- write: `skill:pickExternalDir`
- admin: `skill:addExternalDir`, `skill:deleteDefault`, `skill:openNote`, `skill:removeExternalDir`, `skill:setGroupEnabled`, `skill:update`

### `update`

- read: `update:getLastEvent`
- write: `update:check`
- admin: `update:download`, `update:install`

### `contextMenu`

- write: `contextMenu:popup`

### `widget`

- read: `widget:getServerStatus`, `widget:list`, `widget:listArchived`
- write: `widget:delete`, `widget:exportAsVite`, `widget:exportForDownload`, `widget:open`, `widget:pickExportTarget`, `widget:rename`, `widget:revealExport`, `widget:setArchived`, `widget:startWidget`, `widget:stopServer`, `widget:stopWidget`

### `widgetWindow`

- read: `widgetWindow:getAlwaysOnTop`, `widgetWindow:status`
- write: `widgetWindow:close`, `widgetWindow:open`, `widgetWindow:setAlwaysOnTop`, `widgetWindow:setPreferWindow`

### `pinChat`

- read: `pinChat:getAlwaysOnTop`, `pinChat:getState`
- write: `pinChat:focus`, `pinChat:pin`, `pinChat:setAlwaysOnTop`, `pinChat:unpin`

### `notification`

- read: `notification:consumePendingOpenSession`, `notification:reportActiveSession`

### `liveDoc`

- write: `liveDoc:attach`, `liveDoc:detach`, `liveDoc:respond`

### `artifact`

- read: `artifact:read`

### `files`

- read: `files:read`, `files:scan`, `files:scanDir`, `files:unwatch`, `files:watch`
- write: `files:open`, `files:write`

### `knowledge`

- read: `knowledge:baseOptions`, `knowledge:list`
- write: `knowledge:createBase`, `knowledge:createEntry`, `knowledge:createFolder`, `knowledge:openFolder`, `knowledge:openNote`, `knowledge:revealFile`

### `mentions`

- read: `knowledge:mentionEntries`

### `network`

- read: `network:status`
- admin: `network:setEnabled`, `network:setPort`

### `fs`

- read: `fs:listDirectories`, `fs:locateFolder`

### `sync`

- read: `sync:frame`

<!-- channels:end -->
