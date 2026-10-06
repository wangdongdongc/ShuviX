# @shuvix/chat-ui

可复用的"中间对话框"前端（React）。把 ShuviX 桌面端的聊天对话区抽出，供外部服务端智能体项目的 Web 前端复用——单一源码，桌面主窗口、Chrome 扩展的侧边栏与外部 Web 前端共用。

## 它包含什么

- `<Conversation>` —— 对话区核心：消息列表（虚拟滚动 + 归档回溯）、各类气泡、工具调用块（相邻的思考 / 工具调用合并成一行 `StepGroup`，文本前后各自成组）、系统通知行（压缩摘要 / 后台完成 / 指令注入，`SystemNoticeRow`）、待处理输入、输入区、模型选择。
- 对话域 stores / hooks（chatStore、useSessionView、useAgentView、useAgentEvents、useSessionInit、useChatActions…）。
- 视图同步客户端（`createSyncClient` / `syncClientFor`）：把后端推来的会话视图（`SessionView`）接进 store。
- 两个注入口：**ChatApi**（后端）与 **ChatHost**（宿主外观/模型选择/语音）。

**不包含**（宿主各自实现）：侧边栏、设置面板、浏览器/预览右面板、会话标题栏外壳、外观持久化。

## 两个注入口

### 1. ChatApi —— 后端契约

对话框只通过 `getChatApi()` / `getSessionChannelApi()` 访问后端。Electron 通过暴露 `window.api` 自动满足；外部项目在挂载前注入自己的 HTTP/WS 适配器。

后端往前端推东西走**两条路**：

- **`sync`（视图同步）—— 会话内容全走这里**：消息、正在流式的那张卡、工具进度、运行状态、排队的输入、
  挂着的询问、上下文占用。后端为每个目标（一条会话 / 一个派生 agent）挂一个 chord 远程服务
  `shuvix.chat.view`，交出一份复制状态 `view`（`SessionView` / `AgentView`，类型在
  `@shuvix/chat-protocol/types/sessionView`）；`sync.invoke(target, call)` 发 chord 的服务调用（订阅 / 退订），
  `sync.onFrame(cb)` 收后端推来的帧 `{target, subscriptionId, update}`（线协议见 `@shuvix/chat-protocol/sync`）。
- **`agent.onEvent`（`ChatEvent`）—— 只剩余项**：不属于内容的瞬时 / 全局信号，见下文「ChatEvent 余项」。

```ts
import { setChatApi, type ChatApi } from '@shuvix/chat-ui'
import { syncInvokeError, type SyncInvokeResult } from '@shuvix/chat-protocol/sync'

setChatApi({
  agent: {
    init: (p) =>
      fetch(`/api/sessions/${p.sessionId}/init`, { method: 'POST' }).then((r) => r.json()),
    prompt: (p) =>
      fetch(`/api/sessions/${p.sessionId}/prompt`, {
        method: 'POST',
        body: JSON.stringify(p)
      }).then((r) => r.json()),
    abort: (id) => fetch(`/api/sessions/${id}/abort`, { method: 'POST' }).then((r) => r.json()),
    onEvent: (cb) => {
      const ws = new WebSocket(`/api/events`)
      ws.onmessage = (e) => cb(JSON.parse(e.data)) // ChatEvent 余项
      return () => ws.close()
    }
    // …其余方法见 ChatApi 类型
  },
  sync: {
    // 后端总是回信封 SyncInvokeResult：失败分支还原成带 `.code` 的 Error（如 service_not_found）
    invoke: async (target, call) => {
      const r = await fetch('/api/sync/invoke', {
        method: 'POST',
        body: JSON.stringify({ target, call })
      })
      const envelope = (await r.json()) as SyncInvokeResult
      if (!envelope.ok) throw syncInvokeError(envelope.error)
      return envelope.value
    },
    onFrame: (cb) => {
      const ws = new WebSocket('/api/sync/frames')
      ws.onmessage = (e) => cb(JSON.parse(e.data)) // SyncFrame
      return () => ws.close()
    }
  }
  // session / message / provider / settings / tools / …
} as ChatApi)
```

后端那一半有现成的参考实现：agent-runtime 的 `createSyncHub`（`packages/agent-runtime/src/sync/`，宿主无关，
传输由宿主注入）；桌面端的接线在 `apps/desktop/src/main/frontend/sync/syncWiring.ts` 与
`apps/desktop/src/main/ipc/syncHandlers.ts`，preload 一侧是 `apps/desktop/src/preload/syncBridge.ts`。

只驱动**一条会话**、不需要宿主管理能力（模型切换、项目、会话配置、设置入口）时，注入更小的
`SessionChannelApi` 即可：`setSessionChannelApi(adapter)` 之后 `getHostApi()` 为空，那些界面自动隐藏。
`sync` 属于 `SessionChannelApi`，渠道端同样要实现。Chrome 扩展的侧边栏就是这样接的 —— 会话跑在桌面，
适配器把调用（连同 `sync.invoke` 与推来的帧）经原生消息转过去，见 `apps/extension/src/sidepanel/channelApi.ts`。

视图类型 `SessionView`、消息类型 `ChatMessage`、事件协议 `ChatEvent` 等都来自 `@shuvix/chat-protocol`，前后端（Node 后端）可共享同一份类型，零漂移。

### 会话内容：视图同步

- **`useSessionView(sessionId)`**：订阅一条会话的视图，每一份完整值经唯一写入口 `applySessionView` 镜像进
  chatStore（对话区组件读 store，不直接读视图）；返回绑定状态 `loading | live | unavailable | error`。
  同一条会话的多个使用方共用一个订阅，最后一个放手才退订。
- **`useAgentView(agentId)`**：派生 agent 的视图（`AgentView`，后台任务面板里的子 agent 详情），镜像进
  subSessionStore，同时交回给调用方。
- **`syncClientFor(channel)` / `createSyncClient({channel})`**：两个 hook 底下的客户端 —— 每个目标一个 chord
  绑定、按引用计数共享；先登记订阅再发调用、激活之前到的帧先缓存、帧断档时重订一次。连接重来过（后端
  换了进程）调 `resetAll()` 重订还有人持有的目标。

视图里的 `source`（`durable` / `legacy` / `none`）与 `capabilities`（`send` / `rollback` / `continue`）决定输入区
与回退入口的形态：旧格式会话（`legacy`）只读，输入区换成横幅。

### ChatEvent 余项

`agent.onEvent` 上只剩不属于内容的信号（类型见 `@shuvix/chat-protocol/events`），由 `useAgentEvents()` 分发：
运行生命周期 `agent_start` / `agent_end{reason}`（不带内容，终答与用量都在视图里）、运行时出生与关停
（`agent_created` / `agent_closing`）、MCP 惰性连接（`mcp_connecting`）、没有条目的错误（`error`）、自动审查
（`tool_review`）、资源与浏览器面板（`runtime_event` / `browser_event`）、派生 agent 的登记与收尾
（`sub_session_register` / `sub_session_end`）、后台任务（`bg_task`），以及只带数字的询问计数 `ask_count`
（询问内容只在视图里）。从前的内容类事件（`assistant_message`、`text_delta`、`tool_start` / `tool_end`、
`input_request` …）已经删除。

### 2. ChatHost —— 宿主状态注入

对话框不持有 settingsStore，外观/模型选择/语音由宿主注入。服务端从浏览器本地配置 + ChatApi 组装：

```tsx
import {
  ChatHostProvider,
  Conversation,
  useSessionView,
  useSessionInit,
  useAgentEvents
} from '@shuvix/chat-ui'

function ServerChat({ sessionId }: { sessionId: string }) {
  const host = {
    appearance: {
      theme: 'dark',
      darkTheme: 'github-dark',
      lightTheme: 'github-light',
      fontSize: 14,
      focusMode: false
    },
    models: {
      loaded,
      providers,
      availableModels,
      activeProvider,
      activeModel,
      setActiveProvider,
      setActiveModel
    },
    voice: undefined // 不提供则语音 UI 自动隐藏
  }
  return (
    <ChatHostProvider value={host}>
      <SessionRuntime sessionId={sessionId} />
      <div className="h-full flex flex-col">
        <Conversation sessionId={sessionId} />
      </div>
    </ChatHostProvider>
  )
}

// 会话级运行时 hook 必须在 Provider 之下
function SessionRuntime({ sessionId }: { sessionId: string }) {
  useSessionView(sessionId) // 会话内容（消息 / 流式卡 / 工具进度 / 询问 / 队列）
  useSessionInit(sessionId) // agent.init：模型与会话元信息
  useAgentEvents() // ChatEvent 余项
  return null
}
```

## 宿主还需提供

- **i18next**：对话框用 `react-i18next` 的 `useTranslation`。宿主初始化默认 i18next 实例，语言文件可用 `@shuvix/chat-protocol/i18n/locales/{zh,en,ja}.json`。
- **Tailwind + 主题 CSS 变量**：组件用 Tailwind utility class + `--theme-*` / `--cm-tok-*` 变量。宿主需自备 Tailwind，并在 `:root` 定义这些变量（参考本仓库 renderer 的 assets/main.css）。
- **React 19**（peerDependency）。

## 桌面端（本仓库）如何用

`src/renderer` 的 `App.tsx` 用 `useSettingsChatHost()` 把 settingsStore 适配成 ChatHost，`host/SessionRuntime.tsx`
挂 `useSessionView` / `useSessionInit` / `useAgentEvents`，`ChatView`（外壳）经 app-shell 的 `ChatBody` 渲染 `<Conversation>`；
`window.api`（Electron preload，`sync` 来自 `preload/syncBridge.ts`）天然满足 ChatApi —— 编译期断言见
`src/renderer/src/host/chatApiContract.ts`。
