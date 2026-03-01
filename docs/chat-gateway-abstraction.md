# ChatGateway 抽象层：上行操作统一入口（前端 → 后端）

## 背景

下行（后端 → 前端事件推送）已通过 `ChatFrontend` + `ChatFrontendRegistry` 抽象完成（见 [chat-frontend-abstraction.md](./chat-frontend-abstraction.md)）。但上行（前端操作 → 后端服务）仍与 Electron IPC 硬耦合：

```
Renderer → preload (ipcRenderer.invoke) → ipcMain.handle → IPC handler → Service
```

问题：

1. IPC handler 中混杂了协调逻辑（持久化 + 多 Service 联动），增加 WebSocket/Telegram 等传输层时需要重复这些逻辑
2. 前端操作没有统一入口，散落在多个 handler 文件中

**设计目标**：提取 `ChatGateway` 接口作为会话级操作的统一入口，IPC handler 退化为纯传输适配器。

## 设计决策

### 抽象范围：仅会话内操作

非 Electron 前端通过 `chatFrontendRegistry.bind(sessionId, frontend)` 以**会话维度**绑定，因此：

- 它不需要管理会话的能力（创建/列表/删除由管理端控制）
- 所有操作都在已绑定的会话内进行

ChatGateway 只包含**会话内操作**：

| 包含（会话内操作）                                          | 排除（管理操作，留在 IPC）                              |
| ----------------------------------------------------------- | ------------------------------------------------------- |
| Agent 对话（prompt, abort）                                 | Session CRUD（create, list, delete）                    |
| 交互响应（approve, respondToAsk, respondToSshCredentials）  | Session 配置（updateTitle, updateProject, updateModelConfig...） |
| 运行时调整（setModel, setThinkingLevel, setEnabledTools）   | Provider / Settings / Project 管理                      |
| 消息操作（list, add, clear, rollback, deleteFrom）          | MCP / Skill / SSH 凭据管理                              |
| 资源操作（Docker/SSH status, destroy, disconnect）          | HTTP 日志 / App 级操作                                  |
| 工具发现（listTools）                                       |                                                         |

### 协调逻辑提取

IPC handler 中有意义的协调逻辑（非纯委托）迁移到 `DefaultChatGateway`：

| 操作                  | 协调逻辑                                                                 |
| --------------------- | ------------------------------------------------------------------------ |
| `rollbackMessage`     | `messageService.rollbackToMessage()` + `agentService.invalidateAgent()`  |
| `deleteFromMessage`   | `messageService.deleteFromMessage()` + `agentService.invalidateAgent()`  |
| `destroyDocker`       | `dockerManager.destroyContainer()` + 持久化事件 + `chatFrontendRegistry.broadcast()` |
| `disconnectSsh`       | `sshManager.disconnect()` + 持久化事件 + `chatFrontendRegistry.broadcast()`          |
| `listTools`           | 聚合 builtins + MCP + skills                                            |

其余方法是纯委托（一行调用），但仍统一收入 ChatGateway 保持 API 完整性。

## 目录结构

```
src/main/frontend/
├── core/
│   ├── types.ts                    # ChatEvent 判别联合（已有）
│   ├── ChatFrontend.ts             # 下行接口（已有）
│   ├── ChatFrontendRegistry.ts     # 下行注册中心（已有）
│   ├── ChatGateway.ts              # 上行接口 [新增]
│   ├── DefaultChatGateway.ts       # 上行默认实现 [新增]
│   └── index.ts                    # re-exports
├── electron/
│   └── ElectronFrontend.ts
└── index.ts
```

## 一、ChatGateway 接口 — `core/ChatGateway.ts`

零 Electron 依赖，import 仅来自 `../../types` 和 `../../tools/types`。

```typescript
import type { AgentInitResult, MessageAddParams, Message, ThinkingLevel } from '../../types'
import type { SshCredentialPayload } from '../../tools/types'

export interface ChatGateway {
  // ─── Agent 对话 ──────────────────────────────
  initAgent(sessionId: string): AgentInitResult
  prompt(sessionId: string, text: string, images?: Array<{ type: 'image'; data: string; mimeType: string }>): Promise<void>
  abort(sessionId: string): { success: boolean; savedMessage?: Message }

  // ─── 交互响应 ─────────────────────────────────
  approveToolCall(toolCallId: string, approved: boolean, reason?: string): void
  respondToAsk(toolCallId: string, selections: string[]): void
  respondToSshCredentials(toolCallId: string, credentials: SshCredentialPayload | null): void

  // ─── 运行时调整 ────────────────────────────────
  setModel(sessionId: string, provider: string, model: string, baseUrl?: string, apiProtocol?: string): void
  setThinkingLevel(sessionId: string, level: ThinkingLevel): void
  setEnabledTools(sessionId: string, tools: string[]): void

  // ─── 消息操作 ─────────────────────────────────
  listMessages(sessionId: string): Message[]
  addMessage(params: MessageAddParams): Message
  clearMessages(sessionId: string): void
  rollbackMessage(sessionId: string, messageId: string): void
  deleteFromMessage(sessionId: string, messageId: string): void

  // ─── 资源操作 ──────────────────────────────────
  getDockerStatus(sessionId: string): { containerId: string; image: string } | null
  destroyDocker(sessionId: string): Promise<{ success: boolean }>
  getSshStatus(sessionId: string): { host: string; port: number; username: string } | null
  disconnectSsh(sessionId: string): Promise<{ success: boolean }>

  // ─── 工具发现 ──────────────────────────────────
  listTools(): Array<{ name: string; label: string; hint?: string; group?: string; serverStatus?: string }>
}
```

**设计说明**：

- 方法签名直接接收解构后的参数（非 IPC 的 params 包装对象）
- 同步方法直接返回值，异步方法返回 Promise
- 与 `ChatFrontend`（下行接口）对称：`ChatFrontend` 定义推送能力，`ChatGateway` 定义操作入口

## 二、DefaultChatGateway 实现 — `core/DefaultChatGateway.ts`

聚合现有 Service 的默认实现。导出全局单例 `chatGateway`。

```typescript
import { agentService, ALL_TOOL_NAMES } from '../../services/agent'
import { messageService } from '../../services/messageService'
import { dockerManager } from '../../services/dockerManager'
import { sshManager } from '../../services/sshManager'
import { mcpService } from '../../services/mcpService'
import { skillService } from '../../services/skillService'
import { chatFrontendRegistry } from './ChatFrontendRegistry'
import { t } from '../../i18n'

export class DefaultChatGateway implements ChatGateway {
  // ─── 纯委托（一行调用） ─────────────────────
  initAgent(sessionId) { return agentService.createAgent(sessionId) }
  async prompt(sessionId, text, images?) { await agentService.prompt(sessionId, text, images) }
  abort(sessionId) { return { success: true, savedMessage: agentService.abort(sessionId) || undefined } }
  approveToolCall(id, approved, reason?) { agentService.approveToolCall(id, approved, reason) }
  respondToAsk(id, selections) { agentService.respondToAsk(id, selections) }
  respondToSshCredentials(id, creds) { agentService.respondToSshCredentials(id, creds) }
  setModel(sid, provider, model, baseUrl?, apiProtocol?) { agentService.setModel(sid, provider, model, baseUrl, apiProtocol) }
  setThinkingLevel(sid, level) { agentService.setThinkingLevel(sid, level) }
  setEnabledTools(sid, tools) { agentService.setEnabledTools(sid, tools) }
  listMessages(sid) { return messageService.listBySession(sid) }
  addMessage(params) { return messageService.add(params) }
  clearMessages(sid) { messageService.clear(sid) }
  getDockerStatus(sid) { return dockerManager.getContainerInfo(sid) }
  getSshStatus(sid) { return sshManager.getConnectionInfo(sid) }

  // ─── 协调逻辑（多 Service 联动） ─────────────
  rollbackMessage(sessionId, messageId) {
    messageService.rollbackToMessage(sessionId, messageId)
    agentService.invalidateAgent(sessionId)
  }

  deleteFromMessage(sessionId, messageId) {
    messageService.deleteFromMessage(sessionId, messageId)
    agentService.invalidateAgent(sessionId)
  }

  async destroyDocker(sessionId) {
    const containerId = await dockerManager.destroyContainer(sessionId)
    if (containerId) {
      const msg = messageService.add({
        sessionId, role: 'system_notify', type: 'docker_event',
        content: 'container_destroyed',
        metadata: JSON.stringify({ containerId: containerId.slice(0, 12), reason: 'manual' })
      })
      chatFrontendRegistry.broadcast({ type: 'docker_event', sessionId, messageId: msg.id })
    }
    return { success: !!containerId }
  }

  async disconnectSsh(sessionId) {
    const info = sshManager.getConnectionInfo(sessionId)
    if (!info) return { success: false }
    await sshManager.disconnect(sessionId)
    const msg = messageService.add({
      sessionId, role: 'system_notify', type: 'ssh_event',
      content: 'ssh_disconnected',
      metadata: JSON.stringify({ host: info.host, port: String(info.port), username: info.username, reason: 'manual' })
    })
    chatFrontendRegistry.broadcast({ type: 'ssh_event', sessionId, messageId: msg.id })
    return { success: true }
  }

  listTools() {
    const builtinTools = ALL_TOOL_NAMES.map(name => ({
      name, label: t(`tool.${name}Label`) || name, hint: t(`tool.${name}Hint`), group: undefined
    }))
    const mcpTools = mcpService.getAllToolInfos().map(info => ({
      name: info.name, label: info.label, group: info.group, serverStatus: info.serverStatus
    }))
    const skillItems = skillService.findEnabled().map(s => ({
      name: `skill:${s.name}`,
      label: s.description.length > 60 ? s.description.slice(0, 57) + '...' : s.description,
      group: '__skills__'
    }))
    return [...builtinTools, ...mcpTools, ...skillItems]
  }
}

export const chatGateway = new DefaultChatGateway()
```

## 三、IPC handler 改造

聊天相关 handler 退化为纯传输适配器（参数拆包 → 调用 gateway → 包装返回值）：

### agentHandlers.ts

```typescript
import { chatGateway } from '../frontend'

export function registerAgentHandlers(): void {
  ipcMain.handle('agent:init', (_e, params) => chatGateway.initAgent(params.sessionId))
  ipcMain.handle('agent:prompt', async (_e, params) => {
    await chatGateway.prompt(params.sessionId, params.text, params.images)
    return { success: true }
  })
  ipcMain.handle('agent:abort', (_e, sid) => chatGateway.abort(sid))
  ipcMain.handle('agent:approveToolCall', (_e, p) => {
    chatGateway.approveToolCall(p.toolCallId, p.approved, p.reason)
    return { success: true }
  })
  ipcMain.handle('agent:setModel', (_e, p) => {
    chatGateway.setModel(p.sessionId, p.provider, p.model, p.baseUrl, p.apiProtocol)
    return { success: true }
  })
  // ... 每个 handler 一行委托
  ipcMain.handle('tools:list', () => chatGateway.listTools())
}
```

### messageHandlers.ts

```typescript
import { chatGateway } from '../frontend'

export function registerMessageHandlers(): void {
  ipcMain.handle('message:list', (_e, sid) => chatGateway.listMessages(sid))
  ipcMain.handle('message:add', (_e, params) => chatGateway.addMessage(params))
  ipcMain.handle('message:clear', (_e, sid) => { chatGateway.clearMessages(sid); return { success: true } })
  ipcMain.handle('message:rollback', (_e, p) => { chatGateway.rollbackMessage(p.sessionId, p.messageId); return { success: true } })
  ipcMain.handle('message:deleteFrom', (_e, p) => { chatGateway.deleteFromMessage(p.sessionId, p.messageId); return { success: true } })
}
```

### sessionHandlers.ts（部分改造）

仅 Docker/SSH 资源操作委托到 `chatGateway`，其余管理操作保持不变：

```typescript
// 改造部分 — 资源操作
ipcMain.handle('docker:sessionStatus', (_e, sid) => chatGateway.getDockerStatus(sid))
ipcMain.handle('ssh:sessionStatus', (_e, sid) => chatGateway.getSshStatus(sid))
ipcMain.handle('docker:destroySession', async (_e, sid) => chatGateway.destroyDocker(sid))
ipcMain.handle('ssh:disconnectSession', async (_e, sid) => chatGateway.disconnectSsh(sid))

// 不改造部分 — 管理操作直连 Service
ipcMain.handle('session:create', (_e, params) => sessionService.create(params))
ipcMain.handle('session:list', () => sessionService.list())
ipcMain.handle('session:delete', (_e, id) => { agentService.removeAgent(id); sessionService.delete(id); return { success: true } })
// ... 其余 session CRUD / generateTitle / dialog handler 保持不变
```

### 不改造的 handler

| 文件                          | 原因                     |
| ----------------------------- | ------------------------ |
| `providerHandlers.ts`         | 管理操作，不经过 gateway |
| `settingsHandlers.ts`         | 管理操作                 |
| `projectHandlers.ts`          | 管理操作                 |
| `mcpHandlers.ts`              | 管理操作                 |
| `skillHandlers.ts`            | 管理操作                 |
| `sshCredentialHandlers.ts`    | 管理操作                 |
| `httpLogHandlers.ts`          | 管理操作                 |

## 四、对称架构总览

```
                 ┌────────────────────────────────────┐
                 │         Core 抽象层                  │
                 │  ChatEvent (types.ts)   — 下行协议   │
                 │  ChatFrontend          — 下行接口    │
                 │  ChatFrontendRegistry  — 下行路由    │
                 │  ChatGateway           — 上行接口    │
                 │  DefaultChatGateway    — 上行实现    │
                 └───────────┬──────────────────────────┘
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
     ┌─────────────┐  ┌──────────┐  ┌─────────────┐
     │  Electron    │  │ Services │  │  Future     │
     │  IPC handler │  │          │  │  WS / TG   │
     └──────┬───┬───┘  └──────────┘  └──────┬───┬──┘
            │   │                           │   │
   上行(gateway)│下行(frontend)    上行(gateway)│下行(frontend)
            │   │                           │   │
       ┌────▼───▼────┐                ┌─────▼───▼────┐
       │  Electron   │                │  WS/TG       │
       │  Renderer   │                │  Client      │
       └─────────────┘                └──────────────┘

Electron 特有：管理操作 (session CRUD / provider / settings / ...)
             直接走 IPC handler → Service，不经过 ChatGateway
```

## 五、典型使用场景

### Electron IPC（现有传输层）

```typescript
// 会话内操作经过 gateway
ipcMain.handle('agent:prompt', async (_e, params) => {
  await chatGateway.prompt(params.sessionId, params.text, params.images)
  return { success: true }
})

// 管理操作直连 Service（不经过 gateway）
ipcMain.handle('session:create', (_e, params) => sessionService.create(params))
```

### 未来：Telegram bot

```typescript
// 实现 ChatFrontend（下行）
class TelegramFrontend implements ChatFrontend {
  readonly capabilities = { streaming: false, toolApproval: false, userInput: false, sshCredentials: false }
  sendEvent(event: ChatEvent) {
    if (event.type === 'agent_end' && event.message) {
      bot.sendMessage(this.chatId, JSON.parse(event.message).content)
    }
  }
}

// 使用 chatGateway（上行）
bot.on('message', async (msg) => {
  // 会话由管理端创建并映射
  const sessionId = sessionMap.get(msg.chat.id)
  chatFrontendRegistry.bind(sessionId, new TelegramFrontend(bot, msg.chat.id))
  chatGateway.initAgent(sessionId)
  await chatGateway.prompt(sessionId, msg.text)
})
```

### 未来：WebSocket 传输层

```typescript
ws.on('message', async (raw) => {
  const { action, sessionId, ...params } = JSON.parse(raw)
  switch (action) {
    case 'prompt': await chatGateway.prompt(sessionId, params.text); break
    case 'abort': chatGateway.abort(sessionId); break
    case 'rollback': chatGateway.rollbackMessage(sessionId, params.messageId); break
  }
})
```

## 变更清单

| 文件                                        | 改动                                            |
| ------------------------------------------- | ----------------------------------------------- |
| `src/main/frontend/core/ChatGateway.ts`     | **新建** — 上行接口定义                         |
| `src/main/frontend/core/DefaultChatGateway.ts` | **新建** — 默认实现 + 全局单例                |
| `src/main/frontend/core/index.ts`           | 新增 re-export                                  |
| `src/main/ipc/agentHandlers.ts`             | 全部委托 `chatGateway`，删除直接 Service import |
| `src/main/ipc/messageHandlers.ts`           | 全部委托 `chatGateway`，删除直接 Service import |
| `src/main/ipc/sessionHandlers.ts`           | Docker/SSH 资源操作委托 `chatGateway`           |

## 扩展指南

集成新的前端传输层只需：

1. 实现 `ChatFrontend` 接口（下行 — 接收事件推送）
2. 调用 `chatFrontendRegistry.bind(sessionId, frontend)` 绑定到目标会话
3. 调用 `chatGateway.*` 方法（上行 — 执行会话内操作）
4. 会话管理（创建/删除等）由管理端完成，不经过 `ChatGateway`
