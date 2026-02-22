import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  AgentInitParams,
  AgentPromptParams,
  AgentSetModelParams,
  AgentSetThinkingLevelParams,
  HttpLogListParams,
  MessageAddParams,
  ProjectCreateParams,
  ProjectUpdateParams,
  ProjectDeleteParams,
  ProviderAddModelParams,
  ProviderAddParams,
  ProviderDeleteParams,
  ProviderSyncModelsParams,
  ProviderToggleEnabledParams,
  ProviderToggleModelEnabledParams,
  ProviderUpdateConfigParams,
  ProviderUpdateModelCapabilitiesParams,
  SessionUpdateModelConfigParams,
  SessionUpdateModelMetadataParams,
  SessionUpdateProjectParams,
  SessionUpdateTitleParams,
  SettingsSetParams
} from '../main/types'

/** 暴露给 Renderer 的 API */
const api = {
  // ============ 应用事件 ============
  app: {
    /** 打开独立设置窗口 */
    openSettings: () => ipcRenderer.invoke('app:open-settings'),
    /** 用系统默认应用打开 base64 图片 */
    openImage: (dataUrl: string) => ipcRenderer.invoke('app:open-image', dataUrl),
    /** 用系统文件管理器打开指定文件夹 */
    openFolder: (folderPath: string) => ipcRenderer.invoke('app:open-folder', folderPath),
    /** 监听设置变更（设置窗口关闭后主窗口收到通知） */ 
    onSettingsChanged: (callback: () => void) => {
      const handler = (): void => callback()
      ipcRenderer.on('app:settings-changed', handler)
      return () => ipcRenderer.removeListener('app:settings-changed', handler)
    }
  },

  // ============ Agent 操作 ============
  agent: {
    /** 初始化 Agent */
    init: (params: AgentInitParams) => ipcRenderer.invoke('agent:init', params),

    /** 向指定 session 发送消息 */
    prompt: (params: AgentPromptParams) => ipcRenderer.invoke('agent:prompt', params),

    /** 中止指定 session 的生成 */
    abort: (sessionId: string) => ipcRenderer.invoke('agent:abort', sessionId),

    /** 切换模型 */
    setModel: (params: AgentSetModelParams) =>
      ipcRenderer.invoke('agent:setModel', params),

    /** 设置思考深度 */
    setThinkingLevel: (params: AgentSetThinkingLevelParams) =>
      ipcRenderer.invoke('agent:setThinkingLevel', params),

    /** 响应工具审批请求（沙箱模式下 bash 命令需用户确认） */
    approveToolCall: (params: { toolCallId: string; approved: boolean }) =>
      ipcRenderer.invoke('agent:approveToolCall', params),

    /** 响应 ask 工具的用户选择 */
    respondToAsk: (params: { toolCallId: string; selections: string[] }) =>
      ipcRenderer.invoke('agent:respondToAsk', params),

    /** 监听 Agent 事件流 */
    onEvent: (callback: (event: any) => void) => {
      const handler = (_: any, event: any): void => callback(event)
      ipcRenderer.on('agent:event', handler)
      return () => ipcRenderer.removeListener('agent:event', handler)
    }
  },

  // ============ 提供商管理 ============
  provider: {
    listAll: () => ipcRenderer.invoke('provider:listAll'),
    listEnabled: () => ipcRenderer.invoke('provider:listEnabled'),
    getById: (id: string) => ipcRenderer.invoke('provider:getById', id),
    updateConfig: (params: ProviderUpdateConfigParams) =>
      ipcRenderer.invoke('provider:updateConfig', params),
    toggleEnabled: (params: ProviderToggleEnabledParams) =>
      ipcRenderer.invoke('provider:toggleEnabled', params),
    listModels: (providerId: string) => ipcRenderer.invoke('provider:listModels', providerId),
    listAvailableModels: () => ipcRenderer.invoke('provider:listAvailableModels'),
    toggleModelEnabled: (params: ProviderToggleModelEnabledParams) =>
      ipcRenderer.invoke('provider:toggleModelEnabled', params),
    syncModels: (params: ProviderSyncModelsParams) =>
      ipcRenderer.invoke('provider:syncModels', params),
    add: (params: ProviderAddParams) =>
      ipcRenderer.invoke('provider:add', params),
    delete: (params: ProviderDeleteParams) =>
      ipcRenderer.invoke('provider:delete', params),
    addModel: (params: ProviderAddModelParams) =>
      ipcRenderer.invoke('provider:addModel', params),
    deleteModel: (id: string) =>
      ipcRenderer.invoke('provider:deleteModel', id),
    updateModelCapabilities: (params: ProviderUpdateModelCapabilitiesParams) =>
      ipcRenderer.invoke('provider:updateModelCapabilities', params)
  },

  // ============ 项目管理 ============
  project: {
    list: () => ipcRenderer.invoke('project:list'),
    getById: (id: string) => ipcRenderer.invoke('project:getById', id),
    create: (params: ProjectCreateParams) => ipcRenderer.invoke('project:create', params),
    update: (params: ProjectUpdateParams) => ipcRenderer.invoke('project:update', params),
    delete: (params: ProjectDeleteParams) => ipcRenderer.invoke('project:delete', params)
  },

  // ============ 会话管理 ============
  session: {
    list: () => ipcRenderer.invoke('session:list'),
    create: (params?: any) => ipcRenderer.invoke('session:create', params),
    updateTitle: (params: SessionUpdateTitleParams) =>
      ipcRenderer.invoke('session:updateTitle', params),
    updateModelConfig: (params: SessionUpdateModelConfigParams) =>
      ipcRenderer.invoke('session:updateModelConfig', params),
    updateProject: (params: SessionUpdateProjectParams) =>
      ipcRenderer.invoke('session:updateProject', params),
    updateModelMetadata: (params: SessionUpdateModelMetadataParams) =>
      ipcRenderer.invoke('session:updateModelMetadata', params),
    generateTitle: (params: { sessionId: string; userMessage: string; assistantMessage: string }) =>
      ipcRenderer.invoke('session:generateTitle', params),
    delete: (id: string) =>
      ipcRenderer.invoke('session:delete', id),
    /** 获取单个会话（含 workingDirectory） */
    getById: (id: string) =>
      ipcRenderer.invoke('session:getById', id)
  },

  // ============ 消息管理 ============
  message: {
    list: (sessionId: string) => ipcRenderer.invoke('message:list', sessionId),
    add: (params: MessageAddParams) =>
      ipcRenderer.invoke('message:add', params),
    clear: (sessionId: string) => ipcRenderer.invoke('message:clear', sessionId),
    rollback: (params: { sessionId: string; messageId: string }) =>
      ipcRenderer.invoke('message:rollback', params),
    deleteFrom: (params: { sessionId: string; messageId: string }) =>
      ipcRenderer.invoke('message:deleteFrom', params)
  },

  // ============ 设置管理 ============
  settings: {
    getAll: () => ipcRenderer.invoke('settings:getAll'),
    get: (key: string) => ipcRenderer.invoke('settings:get', key),
    set: (params: SettingsSetParams) => ipcRenderer.invoke('settings:set', params)
  },

  // ============ HTTP 日志 ============
  httpLog: {
    list: (params?: HttpLogListParams) => ipcRenderer.invoke('httpLog:list', params),
    get: (id: string) => ipcRenderer.invoke('httpLog:get', id),
    clear: () => ipcRenderer.invoke('httpLog:clear')
  },

  // ============ Docker ============
  docker: {
    validate: (params?: { image?: string }) => ipcRenderer.invoke('docker:validate', params)
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
