/**
 * 浏览器 ChatApi 适配器 —— chat-ui 的后端契约在 Side Panel 进程内的本地实现。
 *
 * agent / session / message / settings / provider 为真实实现（IndexedDB + chrome.storage +
 * 进程内 RuntimeSession）；其余命名空间为 noop（扩展形态无关）。结构对齐 window.api，但
 * 同进程直接 await，无 HTTP/WS。
 */
import type { ChatApi } from '@shuvix/chat-protocol/chatApi'
import { resolveTokensForAgent } from '@shuvix/chat-protocol/utils/inlineTokens'
import { messageStore } from '../storage/messageStore'
import { resolveModelRef } from '@shuvix/chat-protocol/agentModelRef'
import {
  CHAT_PROFILE_NAME,
  DEFAULT_CHAT_AGENT_KEY,
  DEFAULT_PROJECT_AGENT_KEY
} from '@shuvix/chat-protocol/agentProfile'
import { capsFor } from './resolveSessionModel'
import { sessionStore } from '../storage/sessionStore'
import { settingsStore } from '../storage/settingsStore'
import { mcpStore } from '../storage/mcpStore'
import { projectStore } from '../storage/projectStore'
import { configShareStore } from '../storage/configShareStore'
import { mcpManager } from './mcpRuntime'
import { eventBus } from './eventBus'
import { getToolPresentations } from './toolPresentations'
import { getBuiltinToolDefinitions } from './toolDefinitions'
import {
  ensureRuntimeSession,
  resolveSessionMeta,
  getRuntimeSession,
  removeRuntimeSession,
  setSessionModel
} from './agentRuntime'
import { subAgentManager, extensionSubAgentRegistry } from './subAgent'
import { withTabLease } from './tabLease'
import {
  BASE_PROFILE_NAMES,
  SWITCHABLE_BASE_PROFILE_NAMES,
  DEFAULT_PROFILE_NAME,
  type AgentProfile,
  validateShuvixMdText
} from '@shuvix/agent-runtime'
import { titlerFor, removeTitler } from './titleRuntime'
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

/**
 * 这份档案能否作为某条会话自己的档案 —— 选择器名单（listAgentProfiles）、`/<agentName>`
 * 切换（updateAgentProfile，另拆成两道门只为各自的错误文案）与新会话默认档案三处同源。
 * 口径同桌面 agentService.isSessionProfile。
 */
function isSessionProfile(profile: AgentProfile): boolean {
  return (
    SWITCHABLE_BASE_PROFILE_NAMES.has(profile.name) ||
    (!BASE_PROFILE_NAMES.has(profile.name) && profile.sessionAwareness)
  )
}

/**
 * 新会话的默认档案名 —— 由**会话形态**选设置项：归属项目（FSA 文件夹）走
 * 「默认项目智能体」（缺省 `default`），不归属项目（OPFS 隔离目录）走「默认聊天智能体」
 * （缺省 `chat`）。设置指向的档案已不存在时回落对应基座 —— 与桌面
 * sessionService.defaultAgentProfile 同一条纪律。
 */
async function defaultAgentProfile(projectId: string | null): Promise<string> {
  const inProject = !!projectId
  const key = inProject ? DEFAULT_PROJECT_AGENT_KEY : DEFAULT_CHAT_AGENT_KEY
  const base = inProject ? DEFAULT_PROFILE_NAME : CHAT_PROFILE_NAME
  const configured = (await settingsStore.get(key))?.trim()
  if (!configured || configured === base) return base
  const profile = extensionSubAgentRegistry.getProfile(configured)
  // 准入与切换入口同源（isSessionProfile）：创建与切换必须同口径
  return profile && isSessionProfile(profile) ? configured : base
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
    revealPath: async () => ok,
    adjustWindowWidth: async () => {},
    setBrowserOffset: async () => {},
    windowReady: () => {},
    onNewChat: () => () => {},
    onNewProject: () => () => {}
  },

  agent: {
    init: async ({ sessionId }) => {
      // 仅解析元信息，不创建运行时 —— Agent 延迟到首次发送消息时（prompt → ensureRuntimeSession）创建
      const { provider, model, caps, modelMetadata } = await resolveSessionMeta(sessionId)
      return {
        success: true,
        created: !!getRuntimeSession(sessionId),
        provider,
        model,
        capabilities: caps,
        modelMetadata,
        // 工作目录名(=项目根句柄名)，供 chatStore.projectPath / Files 面板新鲜度校验。无项目则空串。
        workingDirectory: await workingDirNameForSession(sessionId),
        enabledTools: ['ask']
      }
    },
    prompt: async ({ sessionId, text, images, inlineTokens }) => {
      const created = await ensureRuntimeSession(sessionId)
      if (!created) {
        eventBus.emit({ type: 'error', sessionId, error: 'Agent 未初始化' })
        return { success: false }
      }
      // 指令文件/项目提示词已在 createAgent 时 append 进系统提示词（统一创建管线）
      // 用户消息不再由适配器落库：harness 在 message_end 把它作为 entry 追加，
      // 并经 HarnessSession 的事件翻译广播 user_message —— 单一写入点。
      // 标签页租约：本轮结束（含中止）且无其他活跃运行时自动释放接管的标签页（见 tabLease.ts）
      // token 标记展开为真实文本（slash 模板 / @ 引用 / 粘贴原文）后再交给 Agent；
      // 标记态原文 + tokens 作显示侧车随行落树，投影层据此还原芯片气泡（与桌面同构）
      const hasTokens = !!inlineTokens && Object.keys(inlineTokens).length > 0
      const promptText = hasTokens ? resolveTokensForAgent(text, inlineTokens) : text
      const display = hasTokens ? { content: text, tokens: inlineTokens } : undefined
      await withTabLease(() => created.runtime.prompt(promptText, images, display))
      // 自动标题（与桌面 AgentSession.prompt 同一时序）：首轮快速标题已由 HarnessSession 的
      // onPromptAccepted 触发，这里在本轮回复落库后用更完整上下文精修一次（不 await）
      void titlerFor(sessionId).refine()
      return ok
    },
    // 继续与已存在子代理对话：复用该子会话 Agent 追加一轮（fire-and-forget，进展走事件流；整轮持有标签页租约）
    subAgentPrompt: async ({ subSessionId, text }) => {
      void withTabLease(() => subAgentManager.continueTask({ subSessionId, text })).catch(
        (e: unknown) => {
          eventBus.emit({
            type: 'error',
            sessionId: subSessionId,
            error: e instanceof Error ? e.message : String(e)
          })
        }
      )
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
      await getRuntimeSession(sessionId)?.runtime.steer(text)
      return ok
    },
    followUp: async ({ sessionId, text }) => {
      await getRuntimeSession(sessionId)?.runtime.followUp(text)
      return ok
    },
    nextTurn: async ({ sessionId, text }) => {
      await getRuntimeSession(sessionId)?.runtime.nextTurn(text)
      return ok
    },
    abort: async (sessionId) => {
      // harness 会把带 stopReason='aborted' 的部分消息正常落成 entry，无需回传消息
      await getRuntimeSession(sessionId)?.runtime.abort()
      return { success: true }
    },
    setModel: async ({ sessionId, provider, model }) => {
      await setSessionModel(sessionId, provider, model)
      return ok
    },
    setThinkingLevel: async ({ sessionId, level }) => {
      getRuntimeSession(sessionId)?.runtime.setThinkingLevel(level)
      return ok
    },
    // 运行时 Agent 实时信息（systemPrompt/工具/模型）；Agent 未创建返回 null，
    // ensure=true 则先按会话配置懒创建再取快照（构造运行时不请求 LLM）
    getInfo: async (sessionId, options) =>
      (options?.ensure
        ? await ensureRuntimeSession(sessionId)
        : getRuntimeSession(sessionId)
      )?.runtime.getRuntimeInfo() ?? null,
    respondToInput: async ({ sessionId, requestId, response }) => {
      getRuntimeSession(sessionId)?.runtime.respondToInput(requestId, response)
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
          await removeRuntimeSession(s.id)
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
      const projectId = params?.projectId ?? null
      const session = await sessionStore.create({
        ...sel,
        projectId,
        notebookPath: params?.notebookPath,
        title: params?.title,
        // 档案在创建这一刻定型（口径同桌面 sessionService.create）：按会话形态取设置里
        // 对应的默认档案。之后改设置只影响更新的会话——档案是粘性的。
        // 笔记本会话钉死 notebook 基座（buildRuntimeSession），不写这个键
        ...(params?.notebookPath ? {} : { agentProfile: await defaultAgentProfile(projectId) })
      })
      // 与桌面 sessionService.create 对齐：列表成员变化 → 信号事件，订阅端重拉
      appEventBus.publish({ type: 'session.listChanged' })
      return session
    },
    updateTitle: async ({ id, title }) => {
      await sessionStore.updateTitle(id, title)
      return ok
    },
    updateProject: async () => ok,
    // 注：updateModelConfig / updateThinkingLevel / updateEnabledTools 已移除 ——
    // 运行配置只写会话树，入口是 agent.setModel / setThinkingLevel / setEnabledTools。
    // autoAllow 仅落库（browser 询问门控已移除，扩展端暂无运行时消费者）
    updateAutoAllow: async ({ id, autoAllow }) => {
      await sessionStore.updateSettings(id, { autoAllow })
      return ok
    },
    removeAllowListEntry: async ({ id, entry }) => {
      const cur = sessionStore.getSettingsSync(id).allowList ?? []
      await sessionStore.updateSettings(id, { allowList: cur.filter((e) => e !== entry) })
      return ok
    },
    delete: async (id) => {
      await removeRuntimeSession(id)
      removeTitler(id)
      await sessionStore.delete(id)
      appEventBus.publish({ type: 'session.listChanged' })
      return ok
    },
    getById: async (id) => sessionStore.getById(id),
    // 可切换的会话档案（扩展只有内置档案，无用户目录）：只收声明了会话感知的档案
    // （不声明 = 只可被派发的执行型档案，政策要求新鲜上下文），排除 notebook 基座，
    // 保留 default / chat（普通会话的两条路线，互为退路）
    listAgentProfiles: async () =>
      extensionSubAgentRegistry
        .listAll()
        .filter((a) => isSessionProfile(a))
        .map((a) => ({
          name: a.name,
          displayName: a.displayName,
          description: a.description,
          source: a.source,
          model: a.model
        })),
    // 切换会话根 Agent 的档案：粘性写入会话设置 + 失效运行时，下一条消息按新档案重建
    // （buildRuntimeSession 读 settings.agentProfile）。档案声明的模型与 mcp:/skill: 工具
    // 作为种子写进会话树（口径同桌面：事实源是会话树，档案只在切换这一刻参与一次）。
    // 扩展端没有聊天会话（桌面端形态，设计 §12 明确把扩展端列为非目标）。
    // 契约成员必须在，但不假装支持 —— 静默成功会让调用方以为绑定改了
    setBot: async () => ({
      success: false,
      error: 'Chat sessions are not available in the extension'
    }),

    updateAgentProfile: async ({ id, name }) => {
      // 笔记本会话的档案钉死为 notebook 基座（buildRuntimeSession），不接受任何切换
      if ((await sessionStore.getById(id))?.settings?.notebookPath) {
        return { success: false, error: 'Notebook sessions are pinned to the notebook profile' }
      }
      const profile = extensionSubAgentRegistry.getProfile(name)
      if (!profile) return { success: false, error: `Unknown agent "${name}"` }
      // 基座档案不是切换目标（default / chat 除外 —— 普通会话两条路线的入口；口径同桌面）
      if (!SWITCHABLE_BASE_PROFILE_NAMES.has(name) && BASE_PROFILE_NAMES.has(name)) {
        return { success: false, error: `"${name}" is a base profile and cannot be switched to` }
      }
      // 未声明会话感知的档案只能被派发：切成主会话后长对话会稀释其政策的权重（见 definitionFile）。
      // 可切换基座豁免（与上面的列表同源）：会话本就由它们之一创建，不能把退路堵死
      if (!SWITCHABLE_BASE_PROFILE_NAMES.has(name) && !profile.sessionAwareness) {
        return { success: false, error: `"${name}" is not session-aware and cannot be switched to` }
      }
      await sessionStore.updateSettings(id, { agentProfile: name })
      // await：旧运行时彻底停下才算解绑，之后再写模型种子才不会和它抢叶子
      await removeRuntimeSession(id)

      const declared = profile.model
        ? resolveModelRef(profile.model, settingsStore.listAvailableModels())
        : undefined
      if (declared) await setSessionModel(id, declared.providerId, declared.modelId)

      return {
        success: true,
        applied: {
          model: declared
            ? {
                provider: declared.providerId,
                model: declared.modelId,
                capabilities: capsFor(declared.modelId)
              }
            : undefined,
          // 扩展没有会话级工具勾选（工具集固定为 ask + 已连接的 MCP，见 setEnabledTools），
          // 故没有可播的工具种子；档案的 mcp:/skill: 声明在扩展端不参与解析
          tools: []
        },
        modelUnavailable: profile.model && !declared ? profile.model : undefined
      }
    }
    // 配置变更订阅已并入 events.subscribe（扩展暂不发布 session.configChanged）
  },

  message: {
    list: async (sessionId) => messageStore.list(sessionId),
    clear: async (sessionId) => {
      // 先关停运行时再删：还在跑的 run 会往刚清空的会话树里接着写
      await removeRuntimeSession(sessionId)
      await messageStore.clear(sessionId)
      return ok
    },
    // 回退：先把旧运行时彻底关停并解绑，再把 entry 树的 leaf 移到目标消息的父节点。
    // 顺序反过来等于在一个还在写的 run 脚下抽走叶子 —— 两个 run 交叉写同一条分支，
    // tool_use/tool_result 配对当场作废（见 SessionManager 顶部注释）
    rollback: async ({ sessionId, messageId }) => {
      await removeRuntimeSession(sessionId)
      await messageStore.rollback(sessionId, messageId)
      return ok
    }
  },

  settings: {
    getAll: async () => settingsStore.getAll(),
    get: async (key) => settingsStore.get(key),
    set: async ({ key, value }) => {
      await settingsStore.set(key, value)
      return ok
    },
    getKnownKeys: async () => ({})
    // 系统提示词卡片（上下文管理）：复用桌面同源装配，KV 落 chrome.storage
  },

  // 配置分享：Provider + MCP 导出/导入（复用桌面同语义内核，见 configShareStore）
  config: configShareStore,

  runtime: {
    statuses: async () => ({}),
    destroy: async () => ok
  },

  // 后台任务是桌面 bash 工具的能力，扩展端没有 bash → 整组 no-op。
  // 面板 tab 按「有任务才显示」渲染，list 恒空即等于该功能在此宿主不存在。
  bgTask: {
    list: async () => [],
    readLog: async () => ({ exists: false, text: '', fromByte: 0, nextByte: 0, size: 0 }),
    stop: async () => ({ success: false }),
    dismiss: async () => ({ success: false }),
    clearDone: async () => ({ cleared: 0 }),
    setNotify: async () => ({ success: false })
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

  // 注：渠道绑定（telegram）属 ChannelBindingApi，非 ChatApi。
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
    write: ({ sessionId, path, content }) => filesRuntime.write(sessionId, path, content),
    // 单文件内容监听：浏览器沙箱（FSA/OPFS）无稳定的文件变更监听 API（FileSystemObserver 仍实验性）→ no-op。
    // notebook/预览对 agent/子智能体编辑的自动刷新已由 fileTools.onFileChange 发布的 files.changed 覆盖
    // （见 fileTools.ts）；此处仅缺「捕获外部程序改盘」，属平台能力缺失，非缺陷。
    watch: async () => {},
    unwatch: async () => {},
    // 另存为：浏览器里没有系统保存对话框，走原生下载（落点由浏览器的下载设置决定），
    // defaultPath 只取文件名部分。返回 ok 但 path 为空 —— 调用方只用它判成败。
    saveAs: async ({ defaultPath, dataBase64 }) => {
      const name = defaultPath.split(/[/\\]/).pop() || 'chart'
      const bytes = Uint8Array.from(atob(dataBase64), (c) => c.charCodeAt(0))
      const url = URL.createObjectURL(new Blob([bytes]))
      const a = document.createElement('a')
      a.href = url
      a.download = name
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
      return { ok: true, path: name }
    }
  },

  // shuvix 契约 md 校验：同进程直调 agent-runtime 解析器（与桌面 IPC 为同一实现）
  shuvixMd: {
    validate: async ({ type, text, name }) => validateShuvixMdText(type, text, name)
  },

  // 通用内部事件：进程内单例 bus，前端直接订阅（后端 publish 见 appEventBus）
  events: {
    subscribe: (cb) => appEventBus.subscribe(cb)
  },

  tts: {
    speakOnce: async () => {},
    abortTts: async () => {},
    onChunk: () => () => {}
  }
}
