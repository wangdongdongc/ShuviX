/**
 * WebUI window.api polyfill
 * 使用 HTTP + WebSocket 适配 Electron IPC 接口，
 * 使 renderer 组件无需修改即可在浏览器中运行
 */

const API_BASE = '/shuvix/api'

/** 从 URL 路径提取 sessionId: /shuvix/sessions/:id */
function getSessionIdFromUrl(): string {
  const match = window.location.pathname.match(/\/sessions\/([^/]+)/)
  return match?.[1] || ''
}

export const SESSION_ID = getSessionIdFromUrl()

/** 封装 fetch，自动处理 JSON */
async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
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

const noop = (): Promise<{ success: boolean }> => Promise.resolve({ success: false })
const noopVoid = (): void => {}

/**
 * 创建完整的 window.api polyfill
 */
export function createWebApi(): typeof window.api {
  return {
    app: {
      platform: 'web',
      openSettings: noop,
      openExternal: async (url: string) => {
        window.open(url, '_blank')
        return { success: true }
      },
      openImage: async (dataUrl: string) => {
        window.open(dataUrl, '_blank')
        return { success: true }
      },
      openFolder: noop,
      windowReady: noopVoid,
      onSettingsChanged: () => () => {}
    },

    agent: {
      init: (p) => api(`/sessions/${p.sessionId}/init`, { method: 'POST', body: '{}' }),
      prompt: (p) =>
        api(`/sessions/${p.sessionId}/prompt`, {
          method: 'POST',
          body: JSON.stringify({ text: p.text, images: p.images })
        }),
      abort: (sid) => api(`/sessions/${sid}/abort`, { method: 'POST', body: '{}' }),
      setModel: (p) =>
        api(`/sessions/${p.sessionId}/model`, {
          method: 'PUT',
          body: JSON.stringify(p)
        }),
      setThinkingLevel: (p) =>
        api(`/sessions/${p.sessionId}/thinking`, {
          method: 'PUT',
          body: JSON.stringify(p)
        }),
      approveToolCall: (p) =>
        api(`/sessions/${SESSION_ID}/approve`, {
          method: 'POST',
          body: JSON.stringify(p)
        }),
      respondToAsk: (p) =>
        api(`/sessions/${SESSION_ID}/respond-ask`, {
          method: 'POST',
          body: JSON.stringify(p)
        }),
      respondToSshCredentials: (p) =>
        api(`/sessions/${SESSION_ID}/respond-ssh`, {
          method: 'POST',
          body: JSON.stringify(p)
        }),
      setEnabledTools: (p) =>
        api(`/sessions/${p.sessionId}/tools`, {
          method: 'PUT',
          body: JSON.stringify(p)
        }),
      onEvent: (cb) => eventSource.addListener(cb)
    },

    provider: {
      listAll: () =>
        api<{ providers: ProviderInfo[] }>('/providers').then((d) => d.providers || []),
      listEnabled: () => Promise.resolve([]),
      getById: () => Promise.resolve(undefined),
      updateConfig: noop,
      toggleEnabled: noop,
      listModels: () => Promise.resolve([]),
      listAvailableModels: () =>
        api<{ models: AvailableModel[] }>('/providers').then((d) => d.models || []),
      toggleModelEnabled: noop,
      syncModels: () => Promise.resolve({ providerId: '', total: 0, added: 0 }),
      add: () => Promise.resolve({} as ProviderInfo),
      delete: noop,
      addModel: noop,
      deleteModel: noop,
      updateModelCapabilities: noop
    },

    project: {
      list: () => Promise.resolve([]),
      listArchived: () => Promise.resolve([]),
      getById: () => Promise.resolve(null),
      create: () => Promise.resolve({} as Project),
      update: noop,
      delete: noop,
      getKnownFields: () => Promise.resolve({})
    },

    session: {
      list: () => Promise.resolve([]),
      create: () => Promise.resolve({} as Session),
      updateTitle: (p) =>
        api(`/sessions/${p.id}/title`, {
          method: 'PUT',
          body: JSON.stringify(p)
        }),
      updateModelConfig: (p) =>
        api(`/sessions/${(p as { id: string }).id}/model`, {
          method: 'PUT',
          body: JSON.stringify(p)
        }),
      updateProject: noop,
      updateModelMetadata: (p) =>
        api(`/sessions/${(p as { id: string }).id}/model-metadata`, {
          method: 'PUT',
          body: JSON.stringify(p)
        }),
      updateSettings: (p) =>
        api(`/sessions/${(p as { id: string }).id}/settings`, {
          method: 'PUT',
          body: JSON.stringify(p)
        }),
      generateTitle: () => Promise.resolve({ title: null }),
      delete: noop,
      getById: (id) => api(`/sessions/${id}`)
    },

    message: {
      list: (sid) => api(`/sessions/${sid}/messages`),
      add: (p) =>
        api(`/sessions/${p.sessionId}/messages`, {
          method: 'POST',
          body: JSON.stringify(p)
        }),
      clear: noop,
      rollback: noop,
      deleteFrom: (p) =>
        api(`/sessions/${p.sessionId}/messages/delete-from`, {
          method: 'POST',
          body: JSON.stringify(p)
        })
    },

    settings: {
      getAll: () => api('/settings'),
      get: (key) => api(`/settings?key=${encodeURIComponent(key)}`),
      set: noop,
      getKnownKeys: () => Promise.resolve({})
    },

    httpLog: {
      list: () => Promise.resolve([]),
      get: () => Promise.resolve(undefined),
      clear: noop
    },

    docker: {
      validate: () => Promise.resolve({ ok: false }),
      sessionStatus: (sid) => api(`/sessions/${sid}/docker`),
      destroySession: (sid) =>
        api(`/sessions/${sid}/docker/destroy`, { method: 'POST', body: '{}' })
    },

    ssh: {
      sessionStatus: (sid) => api(`/sessions/${sid}/ssh`),
      disconnectSession: (sid) =>
        api(`/sessions/${sid}/ssh/disconnect`, { method: 'POST', body: '{}' })
    },

    sshCredential: {
      list: () => Promise.resolve([]),
      add: () => Promise.resolve({ id: '' }),
      update: noop,
      delete: noop,
      listNames: () => Promise.resolve([])
    },

    tools: {
      list: () => api('/tools')
    },

    mcp: {
      list: () => Promise.resolve([]),
      add: () => Promise.resolve({ success: false, id: '' }),
      update: noop,
      delete: noop,
      connect: noop,
      disconnect: noop,
      getTools: () => Promise.resolve([])
    },

    webui: {
      setShared: noop,
      isShared: () => Promise.resolve(false),
      listShared: () => Promise.resolve([]),
      serverStatus: () => Promise.resolve({ running: false })
    },

    skill: {
      list: () => Promise.resolve([]),
      add: (p) => api('/skills', { method: 'POST', body: JSON.stringify(p) }),
      update: noop,
      delete: noop,
      parseMarkdown: () => Promise.resolve(null),
      importFromDir: () => Promise.resolve({ success: false }),
      getDir: () => Promise.resolve('')
    }
  } as unknown as typeof window.api
}
