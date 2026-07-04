/**
 * 浏览器 ChatApi 适配器 —— chat-ui 的后端契约在 Side Panel 进程内的本地实现。
 *
 * agent / session / message / settings / provider 为真实实现（IndexedDB + chrome.storage +
 * 进程内 RuntimeSession）；其余命名空间为 noop（扩展形态无关）。仿 webui/api.ts 结构，但
 * 同进程直接 await，无 HTTP/WS。
 */
import type { ChatApi } from '@shuvix/chat-protocol/chatApi'
import { messageStore } from '../storage/messageStore'
import { sessionStore } from '../storage/sessionStore'
import { scanInstructionFiles } from './instructionFilesRuntime'
import { settingsStore } from '../storage/settingsStore'
import { mcpStore } from '../storage/mcpStore'
import { projectStore } from '../storage/projectStore'
import { configShareStore } from '../storage/configShareStore'
import { systemPromptStore } from '../storage/systemPromptStore'
import { mcpManager } from './mcpRuntime'
import { eventBus } from './eventBus'
import { getToolPresentations } from './toolPresentations'
import { getBuiltinToolDefinitions } from './toolDefinitions'
import {
  ensureRuntimeSession,
  resolveSessionMeta,
  getRuntimeSession,
  removeRuntimeSession,
  setSessionModel,
  buildSessionTools
} from './agentRuntime'
import { subAgentManager, registerSessionTools } from './subAgent'
import { runNotebookTask, resolveInitialThinkingLevel } from '@shuvix/agent-runtime'
import { compactSession } from './compactionRuntime'
import { generateTitleForSession } from './titleRuntime'
import { filesRuntime, workingDirNameForSession } from './filesRuntime'
import { appEventBus } from './appEventBus'

const ok = { success: true as const }

/**
 * 新建会话的默认 provider/model —— 读「设置中的默认模型」(general.default*)，
 * 与每会话 ModelPicker 选择解耦（对齐桌面）；校验一致性，不一致回退首个可用模型。
 */
async function activeSelection(): Promise<{ provider: string; model: string }> {
  return settingsStore.getNewSessionSelection()
}

export const chatApiAdapter: ChatApi = {
  app: {
    platform: 'web',
    openSettings: async () => ok,
    openExternal: async (url) => {
      window.open(url, '_blank', 'noopener')
      return ok
    },
    openFolder: async () => ok,
    adjustWindowWidth: async () => {},
    setBrowserOffset: async () => {},
    windowReady: () => {},
    onNewChat: () => () => {},
    onNewProject: () => () => {}
  },

  agent: {
    init: async ({ sessionId }) => {
      // 仅解析元信息，不创建运行时 —— Agent 延迟到首次发送消息时（prompt → ensureRuntimeSession）创建
      const { provider, model, caps } = await resolveSessionMeta(sessionId)
      return {
        success: true,
        created: !!getRuntimeSession(sessionId),
        provider,
        model,
        capabilities: caps,
        modelMetadata: {},
        // 工作目录名(=项目根句柄名)，供 chatStore.projectPath / Files 面板新鲜度校验。无项目则空串。
        workingDirectory: await workingDirNameForSession(sessionId),
        enabledTools: ['ask']
      }
    },
    prompt: async ({ sessionId, text, images }) => {
      await ensureRuntimeSession(sessionId)
      const rt = getRuntimeSession(sessionId)
      if (!rt) {
        eventBus.emit({ type: 'error', sessionId, error: 'Agent 未初始化' })
        return { success: false }
      }
      // 后端统一持久化用户消息并广播（chat-ui 通过 user_message 事件落到 store）
      const userMsg = messageStore.add({ sessionId, role: 'user', type: 'text', content: text })
      eventBus.emit({ type: 'user_message', sessionId, message: JSON.stringify(userMsg) })
      await rt.prompt(text, images)
      return ok
    },
    // 笔记本会话发送：不走主会话，每次开启独立子智能体（fire-and-forget）。仅注入笔记本路径 + read 提示，
    // 正文由子代理自行读取；子代理不含 ask（面板只读无法应答）。信封组装与派发由共享 runNotebookTask 完成。
    notebookPrompt: async ({ sessionId, text }) => {
      // 绑定 md 的项目内相对路径（文件工具相对工作目录寻址）
      const session = await sessionStore.getById(sessionId)
      const notebookPath = session?.settings?.notebookPath ?? ''
      const parts = await buildSessionTools(sessionId, {
        // 面板只读、无法应答交互式提问 → ask 已剔除；file tools 的 requestUserInput 为预留项
        requestUserInput: () => Promise.reject(new Error('NO_INTERACTIVE_INPUT')),
        includeAsk: false
      })
      // resolveTools 读 sessionTools map（笔记本无 runtime，故在此登记）；扩展按注册表解析 → tools 传 []
      registerSessionTools(sessionId, parts.tools)
      runNotebookTask(
        subAgentManager,
        {
          sessionId,
          text,
          systemPrompt: parts.systemPrompt,
          modelConfig: {
            provider: parts.provider,
            model: parts.model,
            capabilities: parts.caps,
            // 笔记本子代理继承会话所选思考深度（与桌面/主会话同一 helper）
            thinkingLevel: resolveInitialThinkingLevel({
              persisted: session?.modelMetadata?.thinkingLevel,
              reasoning: parts.caps.reasoning
            })
          },
          tools: [],
          notebookPath
        },
        (error) => eventBus.emit({ type: 'error', sessionId, error })
      )
      return ok
    },
    // 继续与已存在子代理对话：复用该子会话 Agent 追加一轮（fire-and-forget，进展走事件流）
    subAgentPrompt: async ({ subSessionId, text }) => {
      void subAgentManager.continueTask({ subSessionId, text }).catch((e: unknown) => {
        eventBus.emit({
          type: 'error',
          sessionId: subSessionId,
          error: e instanceof Error ? e.message : String(e)
        })
      })
      return ok
    },
    // 子会话基础能力：销毁（中止 + 移出注册表）/ 中断（软停止）——与桌面同走共享 subAgentManager
    subSessionDestroy: async (subSessionId) => {
      subAgentManager.destroy(subSessionId)
      return ok
    },
    subSessionInterrupt: async (subSessionId) => {
      subAgentManager.interrupt(subSessionId)
      return ok
    },
    steer: async ({ sessionId, text }) => {
      getRuntimeSession(sessionId)?.steer(text)
      return ok
    },
    abort: async (sessionId) => {
      const saved = getRuntimeSession(sessionId)?.abort() ?? null
      return { success: true, savedMessage: saved ?? undefined }
    },
    setModel: async ({ sessionId, provider, model }) => {
      await setSessionModel(sessionId, provider, model)
      return ok
    },
    setThinkingLevel: async ({ sessionId, level }) => {
      getRuntimeSession(sessionId)?.setThinkingLevel(level)
      return ok
    },
    respondToInput: async ({ sessionId, requestId, response }) => {
      getRuntimeSession(sessionId)?.respondToInput(requestId, response)
      return ok
    },
    setEnabledTools: async () => ok, // 扩展工具集固定（ask + 已连接 MCP 工具）
    onEvent: (callback) => eventBus.subscribe(callback)
  },

  provider: {
    listAll: async () => settingsStore.listProviders(),
    listEnabled: async () => settingsStore.listProviders().filter((p) => p.isEnabled),
    getById: async (id) => settingsStore.listProviders().find((p) => p.id === id),
    updateConfig: async ({ id, name, apiKey, baseUrl, apiProtocol, metadata }) => {
      await settingsStore.updateConfig(id, { name, apiKey, baseUrl, apiProtocol, metadata })
      return ok
    },
    toggleEnabled: async ({ id, isEnabled }) => {
      await settingsStore.toggleEnabled(id, isEnabled)
      return ok
    },
    listModels: async (providerId) => settingsStore.listModelsFor(providerId),
    listAvailableModels: async () => settingsStore.listAvailableModels(),
    toggleModelEnabled: async ({ id, isEnabled }) => {
      await settingsStore.toggleModelEnabled(id, isEnabled)
      return ok
    },
    syncModels: async ({ providerId }) => settingsStore.syncModels(providerId),
    add: async (params) => {
      const id = await settingsStore.addCustomProvider(params)
      return settingsStore.getProviderWithKey(id)!
    },
    delete: async ({ id }) => {
      await settingsStore.deleteProvider(id)
      return ok
    },
    addModel: async ({ providerId, modelId }) => {
      await settingsStore.addModel(providerId, modelId)
      return ok
    },
    deleteModel: async (id) => {
      await settingsStore.deleteModel(id)
      return ok
    },
    updateModelCapabilities: async ({ id, capabilities }) => {
      await settingsStore.updateModelCapabilities(id, capabilities as Record<string, unknown>)
      return ok
    }
  },

  // 文件夹项目（与桌面同一概念，存 chrome IndexedDB 目录句柄）。创建经侧栏「打开文件夹」
  // 直接走 projectStore.createFromHandle（需句柄，无法走标准 {path} 入参）。
  project: {
    list: async () => projectStore.list(),
    listArchived: async () => projectStore.listArchived(),
    getById: async (id) => projectStore.getById(id),
    create: async () => {
      throw new Error('扩展项目须经「打开文件夹」创建')
    },
    update: async ({ id, name, archived }) => {
      if (name !== undefined) await projectStore.rename(id, name)
      if (archived !== undefined) await projectStore.setArchived(id, archived)
      return ok
    },
    delete: async ({ id }) => {
      // 级联删除该项目下的会话
      for (const s of await sessionStore.list()) {
        if (s.projectId === id) {
          removeRuntimeSession(s.id)
          await sessionStore.delete(s.id)
        }
      }
      await projectStore.delete(id)
      return ok
    },
    getKnownFields: async () => ({})
    // 变更订阅已并入 events.subscribe（AppEvent 'project.changed'）
  },

  session: {
    list: async () => sessionStore.list(),
    create: async (params) => {
      const sel = await activeSelection()
      return sessionStore.create({
        ...sel,
        projectId: params?.projectId ?? null,
        notebookPath: params?.notebookPath,
        title: params?.title
      })
    },
    updateTitle: async ({ id, title }) => {
      await sessionStore.updateTitle(id, title)
      return ok
    },
    updateModelConfig: async ({ id, provider, model }) => {
      await sessionStore.updateModelConfig(id, provider, model)
      return ok
    },
    updateProject: async () => ok,
    updateThinkingLevel: async () => ok,
    updateEnabledTools: async () => ok,
    // autoApprove 门控「操作用户真实浏览器」的 CDP 工具（见 browserTools 审批）；关时逐次确认
    updateAutoApprove: async ({ id, autoApprove }) => {
      await sessionStore.updateSettings(id, { autoApprove })
      return ok
    },
    previewAllowPatterns: async () => [],
    addAllowListPatterns: async () => ok,
    removeAllowListEntry: async ({ id, entry }) => {
      const cur = sessionStore.getSettingsSync(id).allowList ?? []
      await sessionStore.updateSettings(id, { allowList: cur.filter((e) => e !== entry) })
      return ok
    },
    // LLM 标题生成（与桌面同源，见 titleRuntime）：优先专用标题模型，回退会话模型，
    // 失败再退启发式；并落库 IndexedDB
    generateTitle: async ({ sessionId, conversationText }) => {
      const title = await generateTitleForSession(sessionId, conversationText)
      return { title }
    },
    delete: async (id) => {
      removeRuntimeSession(id)
      await sessionStore.delete(id)
      return ok
    },
    getById: async (id) => sessionStore.getById(id),
    // 顶层扫描 AGENTS.md/CLAUDE.md（FSA/OPFS 工作目录）；启用项注入系统提示（见 buildSessionTools）
    scanInstructionFiles: async (sessionId) => scanInstructionFiles(sessionId),
    updateInstructionFiles: async ({ id, filenames }) => {
      await sessionStore.updateSettings(id, { enabledInstructionFiles: filenames })
      return ok
    }
    // 配置变更订阅已并入 events.subscribe（扩展暂不发布 session.configChanged）
  },

  message: {
    list: async (sessionId) => messageStore.list(sessionId),
    add: async (p) =>
      messageStore.add({
        sessionId: p.sessionId,
        role: p.role,
        type: p.type,
        content: p.content,
        metadata: p.metadata,
        model: p.model
      }),
    // 仅持久化并返回；不可再 emit 'error' —— 否则与 useAgentEvents 的 'error' 处理形成反馈死循环
    addErrorEvent: async ({ sessionId, content }) =>
      messageStore.addErrorEvent({ sessionId, content }),
    deleteErrorEvent: async ({ sessionId, messageId }) => {
      await messageStore.deleteOne(sessionId, messageId)
      return ok
    },
    clear: async (sessionId) => {
      await messageStore.clear(sessionId)
      return ok
    },
    // 回退：保留该消息、删除其后，并失效运行时（下次交互从截断后的历史重建上下文）
    rollback: async ({ sessionId, messageId }) => {
      await messageStore.deleteAfter(sessionId, messageId)
      removeRuntimeSession(sessionId)
      return ok
    },
    deleteFrom: async ({ sessionId, messageId }) => {
      await messageStore.deleteFrom(sessionId, messageId)
      removeRuntimeSession(sessionId) // 删除消息后须失效运行时，否则上下文与持久化不一致
      return ok
    },
    countArchived: async (sessionId) => messageStore.countArchived(sessionId),
    listArchived: async ({ sessionId, limit, offset }) => {
      // 对齐桌面：归档消息按时间倒序分页
      const all = (await messageStore.listArchived(sessionId)).sort(
        (a, b) => b.createdAt - a.createdAt
      )
      return all.slice(offset, offset + limit)
    }
  },

  settings: {
    getAll: async () => settingsStore.getAll(),
    get: async (key) => settingsStore.get(key),
    set: async ({ key, value }) => {
      await settingsStore.set(key, value)
      return ok
    },
    getKnownKeys: async () => ({}),
    // 系统提示词卡片（上下文管理）：复用桌面同源装配，KV 落 chrome.storage
    listBuiltinSections: async () => systemPromptStore.listBuiltinSections(),
    setBuiltinDisabled: async (ids) => {
      await systemPromptStore.setBuiltinDisabled(ids)
      return ok
    },
    getCustomSections: async () => systemPromptStore.getCustomSections(),
    setCustomSections: async (sections) => {
      await systemPromptStore.setCustomSections(sections)
      return ok
    },
    previewBuiltinSection: async ({ id }) => systemPromptStore.previewBuiltinSection(id)
  },

  // 配置分享：Provider + MCP 导出/导入（复用桌面同语义内核，见 configShareStore）
  config: configShareStore,

  runtime: {
    statuses: async () => ({}),
    destroy: async () => ok
  },

  tools: {
    list: async () => [
      { name: 'ask', label: 'Ask', group: 'general', defaultEnabled: true, isEnabled: true }
    ],
    // read/write/edit/ask 复用桌面同一渲染定义 + 浏览器工具（见 toolPresentations）
    presentations: async () => getToolPresentations(),
    definitions: async () => getBuiltinToolDefinitions()
  },

  command: {
    list: async () => []
  },

  // MCP 客户端（浏览器 http-only）：chrome.storage 存储 + 共享 McpManager 连接
  mcp: {
    list: async () =>
      mcpStore.findAll().map((s) => {
        let toolCount = 0
        try {
          toolCount = JSON.parse(s.cachedTools || '[]').length
        } catch {
          /* ignore */
        }
        return {
          ...s,
          status: mcpManager.getStatus(s.id),
          error: mcpManager.getError(s.id),
          toolCount
        }
      }),
    add: async (params) => {
      const s = mcpStore.add(params)
      if (s.isEnabled) await mcpManager.connect(s.id)
      return ok
    },
    update: async (params) => {
      const s = mcpStore.update(params)
      if (s) {
        // 配置/启停变化 → 启用则（重）连，否则断开
        if (s.isEnabled) await mcpManager.connect(s.id)
        else await mcpManager.disconnect(s.id)
      }
      return ok
    },
    delete: async (id) => {
      await mcpManager.disconnect(id)
      mcpStore.delete(id)
      return ok
    },
    connect: async (id) => {
      await mcpManager.connect(id)
      return ok
    },
    disconnect: async (id) => {
      await mcpManager.disconnect(id)
      return ok
    },
    getTools: async (id) => mcpManager.getServerToolInfos(id)
  },

  compact: {
    start: async (sessionId) => compactSession(sessionId)
  },

  // 注：渠道绑定（webui 局域网分享 / telegram）属 ChannelBindingApi，非 ChatApi。
  // 扩展两者皆不支持（MV3 无法监听端口、无出站 Bot 托管），故不注入 setChannelBindingApi → 相关 UI 自动隐藏。

  pinChat: {
    pin: async () => ok,
    unpin: async () => ok,
    focus: async () => ok,
    getState: async () => ({ pinnedSessionIds: [] }),
    setAlwaysOnTop: async () => ({ alwaysOnTop: false }),
    getAlwaysOnTop: async () => ({ alwaysOnTop: false })
    // 悬浮状态变更订阅已并入 events.subscribe（扩展无悬浮窗）
  },

  update: {
    check: async () => ok,
    download: async () => ok,
    install: async () => ok,
    getLastEvent: async () => null,
    onEvent: () => () => {}
  },

  // 工作目录文件浏览（Files 面板）：File System Access 实现
  files: {
    scan: ({ sessionId }) => filesRuntime.scan(sessionId),
    read: ({ sessionId, path }) => filesRuntime.read(sessionId, path),
    write: ({ sessionId, path, content }) => filesRuntime.write(sessionId, path, content)
  },

  // 通用内部事件：进程内单例 bus，前端直接订阅（后端 publish 见 appEventBus）
  events: {
    subscribe: (cb) => appEventBus.subscribe(cb)
  },

  stt: {
    transcribe: async () => ({ text: '' })
  },

  tts: {
    speakOnce: async () => {},
    abortTts: async () => {},
    onChunk: () => () => {}
  }
}
