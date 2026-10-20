---
shuvix: okf v0.2
type: Guide
title: 'リモートアクセスのチャネル —— ブラウザーが呼べるすべての呼び出しとそのアクセス区分'
description: 'リモートのブラウザーが WebSocket 経由で呼ぶチャネルの一覧。`object.group` ごとにまとめ、それぞれに `object.access`（read / write / admin）を付けたもの —— リモートアクセスのポリシーでチャネルに対するルールを書くときに参照します。'
tags: [shuvix, policy, security, network, remote-access, reference]
status: stable
sources:
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/apps/desktop/src/shared/channelAccess.ts
    title: channelAccess.ts —— 各チャネルのアクセス区分
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/apps/desktop/src/shared/apiTable.ts
    title: apiTable.ts —— チャネル表
---

# リモートアクセスのチャネル

ShuviX をリモートで使うブラウザーは、すべてを**チャネル** —— WebSocket 上の名前付きの呼び出し —— で行います。
各呼び出しは `channel` オブジェクトとして判定されます（`network-policy` エントリー参照）：`channel` が名前、`group` が
下の小見出し、`access` が行頭の区分です。

- `read` —— データを読むだけで、秘密を返さない。
- `write` —— ユーザーのデータを変える、または何かを起こす。
- `admin` —— ShuviX 自身（セキュリティポリシー、hooks、エージェント、設定、モデルプロバイダー、ネットワークアクセス、
  アップデート）を変える、または秘密を返す。

チャネルではなく中身で区分が決まる呼び出しが一つあります：`agent:respondToInput` は `write` ですが、「許可して記憶」を
選んだ回答はセッションの権限表に行を加えるので、`admin` として判定されます —— `session:grantAcl` と同じ区分です。

ルールはできるだけ `access` と `group` に書いてください：後のバージョンで増えたチャネルにも区分が付いて対象になりますが、
名前の一覧ではそれを取りこぼします。チャネル名を挙げるのは例外を作るときだけにします。一覧はこのバージョンのチャネル表から
生成しています。

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
