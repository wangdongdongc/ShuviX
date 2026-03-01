# ChatFrontend 抽象层：独立事件模型 + 会话级绑定 + 能力感知降级

## 背景

`AgentService` 原先通过 `BrowserWindow.webContents.send()` 直接向 Electron 渲染进程推送事件，形成与 Electron IPC 的硬耦合。事件类型 `AgentStreamEvent` 是扁平接口（~15 可选字段），缺乏类型安全。

**设计目标**：

1. 定义独立的 `ChatEvent` 判别联合类型作为通信协议（零外部依赖）
2. 以会话为维度绑定前端：所有会话默认绑定 App 前端，指定会话可额外绑定其它前端（如 TG bot）
3. 能力声明 + 自动降级：不支持的交互立即降级，不会挂起

## 目录结构

```
src/main/frontend/
├── core/                           # 抽象层（零外部依赖）
│   ├── types.ts                    # ChatEvent 判别联合 + ChatTokenUsage
│   ├── ChatFrontend.ts             # ChatFrontend 接口 + ChatFrontendCapabilities
│   ├── ChatFrontendRegistry.ts     # 注册中心（会话级绑定 + 能力感知广播）
│   └── index.ts                    # re-exports
├── electron/                       # Electron IPC 实现
│   └── ElectronFrontend.ts
└── index.ts                        # 便利入口
```

未来扩展只需新增 `src/main/frontend/telegram/`、`src/main/frontend/websocket/` 等目录。

## 一、ChatEvent 协议 — `core/types.ts`

零 import，纯类型定义。保持事件类型名不变（`agent_start` / `text_delta` / `tool_start` …），核心改进：从扁平可选字段 → 判别联合。

### 字段重命名（消除万能 `data` 歧义）

| 旧字段 (`AgentStreamEvent`) | 新字段 (`ChatEvent`) | 出现于 |
|--------|--------|--------|
| `data` | `delta` | `text_delta`, `thinking_delta` |
| `data` | `message` | `agent_end` |
| `data` | `messageId` | `tool_start`, `tool_end`, `docker_event`, `ssh_event` |
| `data` | `image` | `image_data` |
| `toolResult` | `result` | `tool_end` |
| `toolIsError` | `isError` | `tool_end` |
| `userInputPayload` | `payload` | `user_input_request` |

### 类型定义

```typescript
// core/types.ts — 零依赖

interface ChatEventBase { sessionId: string }

// 流式生成
export interface ChatAgentStartEvent extends ChatEventBase { type: 'agent_start' }
export interface ChatTextDeltaEvent extends ChatEventBase { type: 'text_delta'; delta: string }
export interface ChatThinkingDeltaEvent extends ChatEventBase { type: 'thinking_delta'; delta: string }
export interface ChatTextEndEvent extends ChatEventBase { type: 'text_end' }
export interface ChatAgentEndEvent extends ChatEventBase {
  type: 'agent_end'
  message?: string       // 持久化的 assistant 消息 (JSON string)
  usage?: ChatTokenUsage
}

// 工具执行
export interface ChatToolStartEvent extends ChatEventBase {
  type: 'tool_start'
  toolCallId: string; toolName: string; toolArgs?: Record<string, unknown>
  messageId?: string; turnIndex?: number
  approvalRequired?: boolean; userInputRequired?: boolean; sshCredentialRequired?: boolean
}
export interface ChatToolEndEvent extends ChatEventBase {
  type: 'tool_end'
  toolCallId: string; toolName: string
  result?: string; isError?: boolean; messageId?: string
}

// 交互请求
export interface ChatApprovalRequestEvent extends ChatEventBase {
  type: 'tool_approval_request'
  toolCallId: string; toolName: string; toolArgs?: Record<string, unknown>
}
export interface ChatInputRequestEvent extends ChatEventBase {
  type: 'user_input_request'
  toolCallId: string; toolName: string
  payload: { question: string; options: Array<{ label: string; description: string }>; allowMultiple: boolean }
}
export interface ChatCredentialRequestEvent extends ChatEventBase {
  type: 'ssh_credential_request'
  toolCallId: string; toolName: string
}

// 媒体 / 资源 / 错误
export interface ChatImageDataEvent extends ChatEventBase { type: 'image_data'; image: string }
export interface ChatDockerEvent extends ChatEventBase { type: 'docker_event'; messageId: string }
export interface ChatSshEvent extends ChatEventBase { type: 'ssh_event'; messageId: string }
export interface ChatErrorEvent extends ChatEventBase { type: 'error'; error: string }

// 联合类型
export type ChatEvent = ChatAgentStartEvent | ChatTextDeltaEvent | ChatThinkingDeltaEvent
  | ChatTextEndEvent | ChatAgentEndEvent | ChatToolStartEvent | ChatToolEndEvent
  | ChatApprovalRequestEvent | ChatInputRequestEvent | ChatCredentialRequestEvent
  | ChatImageDataEvent | ChatDockerEvent | ChatSshEvent | ChatErrorEvent

// Token 用量
export interface ChatTokenUsage {
  input: number; output: number; cacheRead: number; total: number
  details: Array<{ input: number; output: number; cacheRead: number; total: number; stopReason: string }>
}
```

## 二、ChatFrontend 接口 — `core/ChatFrontend.ts`

```typescript
export interface ChatFrontendCapabilities {
  streaming?: boolean       // text_delta / thinking_delta / image_data
  toolApproval?: boolean    // tool_approval_request
  userInput?: boolean       // user_input_request
  sshCredentials?: boolean  // ssh_credential_request
}

export interface ChatFrontend {
  readonly id: string
  readonly capabilities: ChatFrontendCapabilities
  sendEvent(event: ChatEvent): void
  isAlive(): boolean
}
```

## 三、ChatFrontendRegistry — `core/ChatFrontendRegistry.ts`

### 会话级绑定模型

```typescript
export class ChatFrontendRegistry {
  /** 默认前端：自动绑定到所有会话（如 Electron 主窗口） */
  private defaultFrontends = new Map<string, ChatFrontend>()
  /** 会话级额外绑定：sessionId → (frontendId → ChatFrontend) */
  private sessionBindings = new Map<string, Map<string, ChatFrontend>>()

  registerDefault(frontend: ChatFrontend): void    // 注册默认前端
  bind(sessionId: string, frontend: ChatFrontend): void  // 绑定额外前端
  unbind(sessionId: string, frontendId: string): void     // 解除绑定
  unregister(frontendId: string): void             // 注销前端
  getFrontends(sessionId: string): ChatFrontend[]  // 获取生效前端
  hasCapability(sessionId: string, cap: keyof ChatFrontendCapabilities): boolean
  broadcast(event: ChatEvent): void                // 能力感知广播
}

export const chatFrontendRegistry = new ChatFrontendRegistry()
export const INTERACTION_TIMEOUT_MS = 5 * 60 * 1000  // 交互请求超时 5 分钟
```

### 广播路由规则

| 事件类型 | 发送给 |
|----------|--------|
| `text_delta`, `thinking_delta`, `image_data` | 仅 `streaming: true` 的前端 |
| `tool_approval_request` | 仅 `toolApproval: true` 的前端 |
| `user_input_request` | 仅 `userInput: true` 的前端 |
| `ssh_credential_request` | 仅 `sshCredentials: true` 的前端 |
| 其他所有事件 | 所有绑定前端 |

`broadcast()` 同时检查 `isAlive()`，自动清理已断开的前端。

### 典型使用场景

```typescript
// 1. 启动时注册 Electron 为默认前端
chatFrontendRegistry.registerDefault(new ElectronFrontend(mainWindow))

// 2. 未来：给会话A额外绑定 TG bot
chatFrontendRegistry.bind(sessionA.id, new TelegramFrontend(chatId, bot))

// 3. 广播时：会话A 的事件同时推送给 Electron + TG bot
//           会话B 的事件只推送给 Electron
```

## 四、ElectronFrontend — `electron/ElectronFrontend.ts`

```typescript
export class ElectronFrontend implements ChatFrontend {
  readonly id = 'electron-main'
  readonly capabilities: ChatFrontendCapabilities = {
    streaming: true, toolApproval: true, userInput: true, sshCredentials: true
  }
  constructor(private window: BrowserWindow) {}
  sendEvent(event: ChatEvent): void {
    if (!this.window.isDestroyed()) {
      this.window.webContents.send('agent:event', event)
    }
  }
  isAlive(): boolean { return !!this.window && !this.window.isDestroyed() }
}
```

## 五、交互请求自动降级（agent.ts）

3 处交互 Promise（`requestApproval` / `requestUserInput` / `requestSshCredentials`）的降级逻辑：

```
1. hasCapability() 检查 → 无能力前端 → 立即自动拒绝（不挂起）
2. 有能力前端 → 创建 Promise + INTERACTION_TIMEOUT_MS 超时
3. 超时 → 自动拒绝
```

示例（`requestApproval`）：

```typescript
requestApproval: (toolCallId: string, command: string) => {
  // 无前端支持审批 → 立即拒绝
  if (!chatFrontendRegistry.hasCapability(sessionId, 'toolApproval')) {
    return Promise.resolve({ approved: false, reason: 'no frontend supports approval' })
  }
  return new Promise<{ approved: boolean; reason?: string }>((resolve) => {
    this.pendingApprovals.set(toolCallId, { resolve })
    const timer = setTimeout(() => {
      if (this.pendingApprovals.delete(toolCallId)) {
        resolve({ approved: false, reason: 'approval timeout' })
      }
    }, INTERACTION_TIMEOUT_MS)
    const origResolve = resolve
    this.pendingApprovals.set(toolCallId, {
      resolve: (result) => { clearTimeout(timer); origResolve(result) }
    })
    chatFrontendRegistry.broadcast({
      type: 'tool_approval_request', sessionId, toolCallId,
      toolName: 'bash', toolArgs: { command }
    })
  })
}
```

## 六、前端类型声明（preload/index.d.ts）

渲染进程通过 `preload/index.d.ts` 中的全局类型声明使用 ChatEvent：

```typescript
declare global {
  interface ChatEventBase { sessionId: string }
  interface ChatAgentStartEvent extends ChatEventBase { type: 'agent_start' }
  // ... 与 core/types.ts 同构的 14 个事件接口 ...
  type ChatEvent = ChatAgentStartEvent | ... | ChatErrorEvent
}
```

渲染进程 `useAgentEvents` hook 中，switch-case 自动获得类型收窄，无需 `|| ''` 兜底。

## 变更清单

| 文件 | 改动 |
|------|------|
| `src/main/frontend/core/types.ts` | **新建** — ChatEvent 判别联合 |
| `src/main/frontend/core/ChatFrontend.ts` | **新建** — 接口 + 能力声明 |
| `src/main/frontend/core/ChatFrontendRegistry.ts` | **新建** — 会话级绑定注册中心 |
| `src/main/frontend/core/index.ts` | **新建** — re-exports |
| `src/main/frontend/electron/ElectronFrontend.ts` | **新建** — Electron 实现 |
| `src/main/frontend/index.ts` | **新建** — 便利入口 |
| `src/main/services/agentEventHandler.ts` | 删除 `AgentStreamEvent`；用 `ChatEvent` + `broadcastEvent` |
| `src/main/services/agent.ts` | 删除 `BrowserWindow` 耦合；交互降级 + 超时 |
| `src/main/index.ts` | `setWindow()` → `registerDefault()` |
| `src/main/ipc/sessionHandlers.ts` | 2 处直接发送 → `chatFrontendRegistry.broadcast()` |
| `src/preload/index.ts` | `AgentStreamEvent` → `ChatEvent` |
| `src/preload/index.d.ts` | `AgentStreamEvent` → `ChatEvent` 全局声明 |
| `src/renderer/src/hooks/useAgentEvents.ts` | 事件字段访问更新 |

## 扩展指南

实现新前端只需：

1. 新建目录（如 `src/main/frontend/telegram/`）
2. 实现 `ChatFrontend` 接口，声明支持的 `capabilities`
3. 在合适时机调用 `chatFrontendRegistry.registerDefault()` 或 `chatFrontendRegistry.bind(sessionId, frontend)`
4. 不支持的能力会自动降级，无需额外处理
