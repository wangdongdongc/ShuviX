# @shuvix/chat-ui

可复用的"中间对话框"前端（React）。把 ShuviX 桌面端的聊天对话区抽出，供外部服务端智能体项目的 Web 前端复用——单一源码，桌面/扩展/服务端共用。

## 它包含什么

- `<Conversation>` —— 对话区核心：消息列表（虚拟滚动 + 归档回溯）、各类气泡、工具调用块（相邻的思考 / 工具调用合并成一行 `StepGroup`，文本前后各自成组）、系统通知行（压缩摘要 / 后台完成 / 指令注入，`SystemNoticeRow`）、待处理输入、输入区、模型选择。
- 对话域 stores / hooks（chatStore、useAgentEvents、useSessionInit、useChatActions…）。
- 两个注入口：**ChatApi**（后端）与 **ChatHost**（宿主外观/模型选择/语音）。

**不包含**（宿主各自实现）：侧边栏、设置面板、浏览器/预览右面板、会话标题栏外壳、外观持久化。

## 两个注入口

### 1. ChatApi —— 后端契约

对话框只通过 `getChatApi()` 访问后端。Electron 通过暴露 `window.api` 自动满足；外部项目在挂载前注入自己的 HTTP/WS 适配器：

```ts
import { setChatApi } from '@shuvix/chat-ui'

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
      const ws = new WebSocket(`/api/ws?sessionId=${SESSION_ID}`)
      ws.onmessage = (e) => cb(JSON.parse(e.data)) // 收到的是 ChatEvent JSON
      return () => ws.close()
    }
    // …其余 namespace 见 ChatApi 类型；可参考 apps/extension/src/runtime/chatApiAdapter.ts 的完整实现
  }
  // session / message / provider / settings / tools / …
} as ChatApi)
```

事件协议 `ChatEvent`、消息类型 `ChatMessage` 等都来自 `@shuvix/chat-protocol`，前后端（Node 后端）可共享同一份类型，零漂移。

### 2. ChatHost —— 宿主状态注入

对话框不持有 settingsStore，外观/模型选择/语音由宿主注入。服务端从浏览器本地配置 + ChatApi 组装：

```tsx
import { ChatHostProvider, Conversation, useSessionInit, useAgentEvents } from '@shuvix/chat-ui'

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
  useSessionInit(sessionId)
  useAgentEvents()
  return null
}
```

## 宿主还需提供

- **i18next**：对话框用 `react-i18next` 的 `useTranslation`。宿主初始化默认 i18next 实例，语言文件可用 `@shuvix/chat-protocol/i18n/locales/{zh,en,ja}.json`。
- **Tailwind + 主题 CSS 变量**：组件用 Tailwind utility class + `--theme-*` / `--cm-tok-*` 变量。宿主需自备 Tailwind，并在 `:root` 定义这些变量（参考本仓库 renderer 的 assets/main.css）。
- **React 19**（peerDependency）。

## 桌面端（本仓库）如何用

`src/renderer` 的 `ChatView`（外壳）用 `useSettingsChatHost()` 把 settingsStore 适配成 ChatHost，内部渲染 `<Conversation>`；`window.api`（Electron preload）天然满足 ChatApi。
