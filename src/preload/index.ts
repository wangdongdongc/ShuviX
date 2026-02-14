import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

/** 暴露给 Renderer 的 API */
const api = {
  // ============ Agent 操作 ============
  agent: {
    /** 初始化 Agent */
    init: (params: {
      provider: string
      model: string
      systemPrompt: string
      apiKey?: string
      messages?: Array<{ role: string; content: string }>
    }) => ipcRenderer.invoke('agent:init', params),

    /** 发送消息 */
    prompt: (text: string) => ipcRenderer.invoke('agent:prompt', text),

    /** 中止生成 */
    abort: () => ipcRenderer.invoke('agent:abort'),

    /** 切换模型 */
    setModel: (params: { provider: string; model: string }) =>
      ipcRenderer.invoke('agent:setModel', params),

    /** 监听 Agent 事件流 */
    onEvent: (callback: (event: any) => void) => {
      const handler = (_: any, event: any): void => callback(event)
      ipcRenderer.on('agent:event', handler)
      return () => ipcRenderer.removeListener('agent:event', handler)
    }
  },

  // ============ 会话管理 ============
  session: {
    list: () => ipcRenderer.invoke('session:list'),
    create: (params?: any) => ipcRenderer.invoke('session:create', params),
    updateTitle: (params: { id: string; title: string }) =>
      ipcRenderer.invoke('session:updateTitle', params),
    delete: (id: string) => ipcRenderer.invoke('session:delete', id)
  },

  // ============ 消息管理 ============
  message: {
    list: (sessionId: string) => ipcRenderer.invoke('message:list', sessionId),
    add: (params: { sessionId: string; role: 'user' | 'assistant'; content: string }) =>
      ipcRenderer.invoke('message:add', params),
    clear: (sessionId: string) => ipcRenderer.invoke('message:clear', sessionId)
  },

  // ============ 设置管理 ============
  settings: {
    getAll: () => ipcRenderer.invoke('settings:getAll'),
    get: (key: string) => ipcRenderer.invoke('settings:get', key),
    set: (params: { key: string; value: string }) => ipcRenderer.invoke('settings:set', params)
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
