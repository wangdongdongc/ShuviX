---
shuvix: okf v0.2
type: Guide
title: '远程访问的通道 —— 浏览器能调的每一条，与它的访问级别'
description: '远程浏览器经 WebSocket 调用的通道清单，按 `object.group` 分组，每条带它的 `object.access`（read / write / admin）—— 写远程访问策略里针对通道的规则时查。'
tags: [shuvix, policy, security, network, remote-access, reference]
status: stable
sources:
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/apps/desktop/src/shared/channelAccess.ts
    title: channelAccess.ts —— 每条通道的访问级别
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/apps/desktop/src/shared/apiTable.ts
    title: apiTable.ts —— 通道表
---

# 远程访问的通道

远程使用 ShuviX 的浏览器做的每一件事都经过**通道** —— 它的 WebSocket 上一次有名字的调用。每次调用都按
`channel` 对象判（见 `network-policy` 条目）：`channel` 是名字，`group` 是下面的小标题，`access` 是行首的级别。

- `read` —— 读数据，不返回机密。
- `write` —— 改用户的数据，或让事情发生。
- `admin` —— 改 ShuviX 本身（安全策略、hooks、agent、设置、模型服务、网络访问、更新），或返回机密。

有一种调用按带的内容而不是按通道定级别：`agent:respondToInput` 是 `write`，但勾了「允许并记住」的回答会往会话
权限表里加一行，所以按 `admin` 判 —— 与 `session:grantAcl` 同一级。

规则尽量写在 `access` 与 `group` 上：以后版本新加的通道也会带上级别、照样被管住，而一张名字清单会漏掉它。
只在要开例外时点名通道。清单按这个版本的通道表生成。

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

- read: `session:getById`, `session:list`, `session:listAcl`
- write: `session:create`, `session:delete`, `session:fork`, `session:updateEnabledTools`, `session:updateKnowledgeBases`, `session:updateProject`, `session:updateTitle`
- admin: `session:grantAcl`, `session:removeAclEntry`, `session:setAclAccess`

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
- write: `browser-view:activate-tab`, `browser-view:agent-devtools-clear`, `browser-view:close-tab`, `browser-view:create-tab`, `browser-view:devtools-close`, `browser-view:devtools-open`, `browser-view:go-back`, `browser-view:go-forward`, `browser-view:navigate`, `browser-view:open-internal`, `browser-view:open-session`, `browser-view:open-settings`, `browser-view:open-window`, `browser-view:reload`, `browser-view:reopen-closed-tab`, `browser-view:set-devtools-layout`, `browser-view:set-layout`, `browser-view:set-visible`, `browser-view:stop`, `browser-view:zoom`
- admin: `browser-view:agent-devtools`, `browser-view:proceed-unsafe`

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

- read: `knowledge:mentionEntries`, `session:mentionEntries`

### `network`

- read: `network:status`
- admin: `network:setEnabled`, `network:setPort`

### `fs`

- read: `fs:listDirectories`, `fs:locateFolder`

### `sync`

- read: `sync:frame`

<!-- channels:end -->
