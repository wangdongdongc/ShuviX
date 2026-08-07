/**
 * WebUI 后端适配器 —— 局域网分享是「单会话渠道」，只实现 SessionChannelApi（看 + 发）。
 *
 * 经 setSessionChannelApi() 注入；getHostApi() 因此返回 null，宿主管理类 UI
 * （模型/项目/设置/工具编辑/绑定…）自动隐藏。用 HTTP + WebSocket 适配 Electron IPC，
 * 使 chat-ui / app-shell 的会话组件无需修改即可在浏览器中运行。
 */
import type { SessionChannelApi } from '@shuvix/chat-ui'

const API_BASE = '/shuvix/api'

/** 从 URL 路径提取 sessionId: /shuvix/sessions/:id */
function getSessionIdFromUrl(): string {
  const match = window.location.pathname.match(/\/sessions\/([^/]+)/)
  return match?.[1] || ''
}

export const SESSION_ID = getSessionIdFromUrl()

/** 封装 fetch，自动处理 JSON。导出供 App 引导（设置/分享模式）直接取数。 */
export async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    ...init
  })
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(`API ${res.status}: ${text}`)
  }
  return res.json()
}

/** 创建 WebSocket 连接（含自动重连） */
function createEventSource(): {
  addListener: (cb: (event: ChatEvent) => void) => () => void
} {
  const listeners: Array<(event: ChatEvent) => void> = []
  let ws: WebSocket | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null

  function connect(): void {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    ws = new WebSocket(`${protocol}//${location.host}/shuvix/ws?sessionId=${SESSION_ID}`)

    ws.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data)
        listeners.forEach((fn) => fn(event))
      } catch {
        /* ignore parse errors */
      }
    }

    ws.onclose = () => {
      ws = null
      reconnectTimer = setTimeout(connect, 3000)
    }

    ws.onerror = () => {
      ws?.close()
    }
  }

  // 仅当有 sessionId 时连接
  if (SESSION_ID) connect()

  return {
    addListener(cb) {
      listeners.push(cb)
      return () => {
        const idx = listeners.indexOf(cb)
        if (idx >= 0) listeners.splice(idx, 1)
        // 没有监听者时断开
        if (listeners.length === 0 && ws) {
          if (reconnectTimer) clearTimeout(reconnectTimer)
          ws.close()
          ws = null
        }
      }
    }
  }
}

const eventSource = createEventSource()

const voidAsync = (): Promise<void> => Promise.resolve()
const unsub = (): (() => void) => () => {}

/**
 * 创建 WebUI 的 SessionChannelApi 实现。
 * 发送类（主会话 prompt / 笔记本 / 子代理 / steer）与会话/消息/文件/运行时均接服务端 HTTP/WS 路由；
 * 渠道暂不支持的（语音/归档分页/斜杠命令/工具展示/内部事件总线）给类型正确的空实现。
 */
export function createWebSessionChannelApi(): SessionChannelApi {
  return {
    app: {
      platform: 'web',
      openExternal: async (url) => {
        window.open(url, '_blank')
        return { success: true }
      }
    },

    agent: {
      init: (p) => api(`/sessions/${p.sessionId}/init`, { method: 'POST', body: '{}' }),
      prompt: (p) =>
        api(`/sessions/${p.sessionId}/prompt`, {
          method: 'POST',
          body: JSON.stringify({ text: p.text, images: p.images })
        }),
      // 笔记本会话发送：接服务端 /notebook-prompt 路由（每次开独立子代理，进展走 WS 事件流）
      notebookPrompt: (p) =>
        api(`/sessions/${p.sessionId}/notebook-prompt`, {
          method: 'POST',
          body: JSON.stringify({ text: p.text, images: p.images, inlineTokens: p.inlineTokens })
        }),
      // 用户直发派发：渠道端无斜杠命令源（command.list 为空）→ 入口不可达，给类型正确的占位实现
      dispatchPrompt: () => Promise.resolve({ success: false }),
      // 子代理：继续对话 / 销毁 / 中断 —— 接服务端 /subagent/* 路由（子会话进展走 WS 事件流）
      subAgentPrompt: (p) =>
        api(`/sessions/${SESSION_ID}/subagent/prompt`, {
          method: 'POST',
          body: JSON.stringify({
            subSessionId: p.subSessionId,
            text: p.text,
            inlineTokens: p.inlineTokens
          })
        }),
      subSessionDestroy: (subSessionId) =>
        api(`/sessions/${SESSION_ID}/subagent/destroy`, {
          method: 'POST',
          body: JSON.stringify({ subSessionId })
        }),
      subSessionInterrupt: (subSessionId) =>
        api(`/sessions/${SESSION_ID}/subagent/interrupt`, {
          method: 'POST',
          body: JSON.stringify({ subSessionId })
        }),
      steer: (p) =>
        api(`/sessions/${p.sessionId}/steer`, {
          method: 'POST',
          body: JSON.stringify({ text: p.text })
        }),
      abort: (sid) => api(`/sessions/${sid}/abort`, { method: 'POST', body: '{}' }),
      // WebUI 是分享出去的受限客户端：压缩会改写会话历史，不开放
      compact: async () => ({ success: false, error: 'not supported in WebUI' }),
      respondToInput: (p) =>
        api(`/sessions/${p.sessionId}/respond-input`, {
          method: 'POST',
          body: JSON.stringify({ requestId: p.requestId, response: p.response })
        }),
      onEvent: (cb) => eventSource.addListener(cb)
    },

    session: {
      getById: (id) => api(`/sessions/${id}`)
    },

    message: {
      list: (sid) => api(`/sessions/${sid}/messages`),
      // 服务端暂无归档分页路由：渠道展示活动消息即可
      countArchived: () => Promise.resolve(0),
      listArchived: () => Promise.resolve([])
    },

    runtime: {
      statuses: (sid) => api(`/sessions/${sid}/runtimes`)
    },

    tools: {
      list: () => api('/tools'),
      presentations: () => Promise.resolve({}),
      definitions: () => api('/tools/definitions')
    },

    // 斜杠命令源未经服务端暴露：渠道返回空列表
    command: {
      list: () => Promise.resolve([])
    },

    // 工作目录文件（只读）：接服务端 /files 路由，供笔记本 / 文件预览
    files: {
      scan: (p) => api(`/sessions/${p.sessionId}/files`),
      read: (p) => api(`/sessions/${p.sessionId}/files/read?path=${encodeURIComponent(p.path)}`),
      // 只读分享端不做实时文件监听（AppEvent 未经 WS 转发）→ no-op
      watch: () => Promise.resolve(),
      unwatch: () => Promise.resolve()
    },

    // 通用内部事件（AppEvent）暂未经 WS 转发 → no-op；后续可接 eventSource
    events: {
      subscribe: unsub
    },

    // 语音渠道暂不支持
    stt: {
      transcribe: () => Promise.resolve({ text: '' })
    },
    tts: {
      speakOnce: voidAsync,
      abortTts: voidAsync,
      onChunk: unsub
    }
  } satisfies SessionChannelApi
}
