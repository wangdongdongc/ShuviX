import { v7 as uuidv7 } from 'uuid'
import { join, basename } from 'path'
import { rmSync, existsSync } from 'fs'
import { sessionDao } from '../dao/sessionDao'
import { messageService } from './messageService'
import {
  readSessionRunConfig,
  setSessionTreePinned,
  appendModelChange,
  appendActiveToolsChange
} from './sessionStorage'
import { httpLogDao } from '../dao/httpLogDao'
import { providerDao } from '../dao/providerDao'
import { projectDao } from '../dao/projectDao'
import { settingsDao } from '../dao/settingsDao'
import { t } from '../i18n'
import { getTempWorkspace, getToolResultsBase } from '../utils/paths'
import { getDefaultEnabledTools, filterAvailableTools } from './toolAggregator'
import { buildAllowEntry } from '../utils/toolUtils/allowList'
import type { AllowToolType } from '../utils/toolUtils/allowList'
import type {
  Session,
  SessionInfo,
  SessionCreateParams,
  SessionModelMetadata,
  AgentInitResult,
  ModelCapabilities
} from '../types'
import type { Project } from '../dao/types'

import type { InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import { DEFAULT_THINKING_LEVEL } from '@shuvix/chat-protocol/types/thinking'
import {
  BASE_PROFILE_NAMES,
  DEFAULT_PROFILE_NAME,
  NOTEBOOK_PROFILE_NAME,
  SessionManager,
  resolveInitialThinkingLevel
} from '@shuvix/agent-runtime'
import type { SubAgentModelConfig } from '@shuvix/agent-runtime'
import { agentService } from './agentService'
import { AgentSession } from './agentSession'
import { killBySession, setBgTaskNotifier } from './bgTaskService'
import { renderNotebookSystemPrompt, resolveProfileModelSpec } from '../agents/agentHost'
import {
  broadcastSessionConfigChanged,
  broadcastSessionTitleChanged
} from '../utils/sessionConfigBroadcast'
import { chatFrontendRegistry } from '../frontend/core/ChatFrontendRegistry'
import { registerUserInputResolver } from './userInputBroker'
import { createLogger } from '../logger'

const log = createLogger('SessionService')

/** 广播「运行时正在关停 / 已关停」——前端据此显示「正在停止」并拦住发送 */
function broadcastAgentClosing(sessionId: string, closing: boolean): void {
  chatFrontendRegistry.broadcast({ type: 'agent_closing', sessionId, closing })
}

/**
 * 会话服务 — 管理会话 CRUD 与 AgentSession 运行时生命周期
 */
export class SessionService {
  /**
   * AgentSession 运行时生命周期（Map + 懒创建 + 失效/销毁）由共享 SessionManager 托管；
   * 构造（resolveSessionAgentContext + AgentSession.create）与清理（invalidate/destroy）经此注入。
   */
  private readonly agents = new SessionManager<AgentSession>({
    create: async (sessionId) => {
      const ctx = await this.resolveSessionAgentContext(sessionId)
      if (!ctx) {
        log.error(`创建 Agent 失败，未找到 session=${sessionId}`)
        return undefined
      }
      const profileName = this.resolveAgentProfileName(sessionId)
      log.info(`创建 Agent model=${ctx.model} profile=${profileName} session=${sessionId}`)
      return AgentSession.create({
        sessionId,
        provider: ctx.provider,
        model: ctx.model,
        capabilities: ctx.capabilities,
        workingDirectory: ctx.workingDirectory,
        enabledTools: ctx.enabledTools,
        modelMetadata: ctx.modelMetadata,
        profileName
      })
    },
    dispose: async (sessionId, agent, reason) => {
      // invalidate=回退重建（下次 ensure 重建），destroy/remove=删除会话。
      // **await**：解绑必须发生在关停之后 —— 见 SessionManager 顶部注释
      if (reason === 'invalidate') await agent.invalidate()
      else await agent.destroy()
      log.info(`移除 AgentSession session=${sessionId} reason=${reason}`)
    },
    // 关停可能很久（工具卡住不返回时会一直等），期间会话呈现「正在停止」并拦住发送
    onClosingChange: (sessionId, closing) => broadcastAgentClosing(sessionId, closing)
  })

  constructor() {
    // 会话树共享缓存的逐出保护：有 AgentSession（或创建中）的会话，
    // 树实例与运行时共享 —— LRU 不得回收，否则读取端会另开分叉实例
    setSessionTreePinned((sessionId) => this.agents.tracked(sessionId))

    // 后台任务结束 → 告知该会话的 Agent。刻意**不懒建 Agent**：没建过 Agent 的会话
    // 说明用户根本没在跟它对话，为一条后台通知把整个运行时拉起来不值当
    setBgTaskNotifier((sessionId, text) => {
      const agent = this.agents.get(sessionId)
      if (!agent) return
      void agent
        .notify(text)
        .catch((err) => log.warn(`后台任务通知失败 session=${sessionId}: ${err}`))
    })
  }

  // ─── DB CRUD ──────────────────────────────────

  /** 获取所有会话 */
  list(): Session[] {
    return sessionDao.findAll()
  }

  /**
   * 获取单个会话（含计算属性 workingDirectory）。
   *
   * 刻意**不返回 enabledTools** —— 它属于运行配置，事实源在会话树里，读取需要异步 IO，
   * 而本方法被工具执行链（toolContext / filesWatcher / filePreview）同步调用。
   * 需要工具集的地方走 `agent.init`（AgentInitResult.enabledTools）。
   */
  getById(id: string): SessionInfo | undefined {
    const session = sessionDao.findById(id)
    if (!session) return undefined
    const project = session.projectId
      ? projectDao.pick(session.projectId, ['path', 'settings'])
      : undefined
    return { ...session, workingDirectory: project?.path || getTempWorkspace(id) }
  }

  /** 会话没有显式工具配置时的默认启用集（项目声明优先，其次全局默认） */
  private defaultEnabledTools(project: Pick<Project, 'path' | 'settings'> | undefined): string[] {
    return project?.settings?.enabledTools
      ? filterAvailableTools(project.settings.enabledTools, project.path)
      : getDefaultEnabledTools(project?.path)
  }

  /**
   * 创建新会话。
   *
   * **不预写任何运行配置** —— provider / model / thinkingLevel / enabledTools 的唯一事实源是
   * 会话树，而新会话还没有树。首次 resolveSessionAgentContext 时按「树上没有 → 回落默认」
   * 解析；用户第一次显式切换才在树上留下 change entry。
   *
   * params.notebookPath 非空时创建「笔记本会话」：绑定项目内的一个 md 文件、标题默认取 basename
   * （去后缀的标题由共享的 useCreateNotebook 显式传入 params.title）。
   */
  create(params?: SessionCreateParams): Session {
    const id = uuidv7()
    const pid = params?.projectId ?? null
    const notebookPath = params?.notebookPath
    const now = Date.now()

    const session: Session = {
      id,
      title: params?.title ?? (notebookPath ? basename(notebookPath) : t('agent.defaultTitle')),
      projectId: pid,
      // 指令文件不预写配置：留空即「未显式配置」，注入时按 AGENTS.md → CLAUDE.md 优先级自动选
      settings: {
        ...(notebookPath ? { notebookPath } : {}),
        ...(params?.memorySlug ? { memorySlug: params.memorySlug } : {})
      },
      createdAt: now,
      updatedAt: now
    }
    sessionDao.insert(session)
    // 注：指令文件不在创建时注入。改为在用户首次发送 prompt 时按当前配置懒注入
    // （由 AgentSession.prompt 判定 agent 上下文是否为空），使得用户可以在
    // 创建会话后、发送第一条消息前任意切换配置。
    return session
  }

  /**
   * 解析会话根 Agent 的档案名。
   *
   * settings.agentProfile 缺省即 'default'；档案文件被删/改名时也回落 'default'
   * （档案是纯 md 驱动的，用户随时可能删掉某个 `~/.shuvix/agents/<name>.md`，
   * 会话设置不该因此把根 Agent 卡死在一个不存在的档案上）。
   */
  resolveAgentProfileName(sessionId: string): string {
    const name = sessionDao.pickSettings(sessionId, ['agentProfile'])?.agentProfile
    if (!name || name === DEFAULT_PROFILE_NAME) return DEFAULT_PROFILE_NAME
    if (agentService.getProfile(name)) return name
    log.warn(`会话档案 "${name}" 已不存在，回落 default（session=${sessionId}）`)
    return DEFAULT_PROFILE_NAME
  }

  /**
   * 切换会话根 Agent 的档案（`/<agentName>` 斜杠命令）。粘性：写入会话设置后一直生效。
   *
   * 档案决定系统提示词与内置工具白名单，两者都在 createAgent 时定型 —— 与指令文件同
   * 一套失效重建路径：会话树/历史一概不动，下一条消息用新档案重建运行时。
   *
   * 切换同时把档案声明的运行配置作为**种子**写进会话树（与用户手动改模型/工具同一条
   * 路径）：root 的事实源始终是会话树，档案只在切换这一刻参与一次，之后用户改什么就是
   * 什么 —— 若让 createAgent 每次重建都按档案覆盖，用户手选的会被默默还原。
   *  - 模型（`shuvix-model`）：解析成功才写；不可用则保持当前模型，把原始值经
   *    `modelUnavailable` 回传供前端提示（后端日志之外用户也该看得见）。
   *  - 工具（`shuvix-tools` 里的 mcp:/skill:）：**替换**会话勾选，没声明就是清空 ——
   *    档案对三类工具是完整声明，切过去就是它说的那套；内置工具不进勾选（选择器不展示，
   *    它们恒由档案白名单决定）。
   * 种子结果随 `applied` 回传，调用方据此就地更新选择器（免去一次重新 init）。
   */
  async updateAgentProfile(
    sessionId: string,
    name: string
  ): Promise<{
    success: boolean
    error?: string
    applied?: { model?: SubAgentModelConfig; tools: string[] }
    modelUnavailable?: string
  }> {
    const profile = agentService.getProfile(name)
    if (!profile) return { success: false, error: `Unknown agent "${name}"` }
    // 'notebook' 是笔记本会话形态的基座，切到聊天会话上只会得到一个指向不存在笔记的人格
    // （命令源同样不列它）；'default' 是唯一可切的基座档案 —— 切回主会话的入口。
    if (name !== DEFAULT_PROFILE_NAME && BASE_PROFILE_NAMES.has(name)) {
      return { success: false, error: `"${name}" is a base profile and cannot be switched to` }
    }
    // dispatch-only 档案（如 wiki-writer）：政策的有效性依赖每次派发都是新鲜上下文，
    // 切成主会话后长对话会稀释系统提示词权重，而它们违规的代价静默且不可逆。
    if (profile.dispatchOnly) {
      return { success: false, error: `"${name}" is dispatch-only and cannot be switched to` }
    }
    log.info(`updateAgentProfile session=${sessionId} → ${name}`)
    sessionDao.updateSettings(sessionId, { agentProfile: name })
    // await：旧运行时彻底停下才算解绑，之后往树上追加种子才不会和它抢叶子
    await this.invalidateAgent(sessionId)

    // 种子：运行时已在上一行失效，故直接往树上追加（没有活跃 Agent 需要同步）
    let model: SubAgentModelConfig | undefined
    let modelUnavailable: string | undefined
    if (profile.model) {
      const resolved = resolveProfileModelSpec(profile.model)
      if (resolved) {
        await appendModelChange(sessionId, resolved.provider, resolved.model)
        model = resolved
        log.info(`updateAgentProfile 应用档案模型 ${resolved.provider}/${resolved.model}`)
      } else {
        modelUnavailable = profile.model
        log.warn(`档案 "${name}" 声明的模型 "${profile.model}" 当前不可用，保持会话现有模型`)
      }
    }

    // 工具种子：档案声明的 mcp:/skill: 替换会话勾选（未声明 = 清空）
    const tools = profile.tools.filter((n) => n.startsWith('mcp:') || n.startsWith('skill:'))
    await appendActiveToolsChange(sessionId, tools)

    broadcastSessionConfigChanged(sessionId)
    return { success: true, applied: { model, tools }, modelUnavailable }
  }

  /**
   * 更新会话标题。`origin` 记进 settings.titleOrigin：'user' = 用户改名（UI 重命名），
   * 'auto' = 自动化写入（session-config 工具）。这是 `session.turn-completed` 埋点里
   * `titleAutoGenerated` 的数据来源 —— 自动化据此避免覆盖用户手动改过的标题。
   * 自动写入才广播 titleChanged（用户改名时渲染端自行更新，维持旧行为）。
   */
  updateTitle(id: string, title: string, origin: 'user' | 'auto' = 'user'): void {
    sessionDao.updateTitle(id, title)
    sessionDao.updateSettings(id, { titleOrigin: origin })
    if (origin === 'auto') broadcastSessionTitleChanged(id, title)
  }

  /** 更新会话所属项目 */
  updateProjectId(id: string, projectId: string | null): void {
    sessionDao.updateProjectId(id, projectId)
  }

  /** 更新命令免询问（bash + ssh 统一开关） */
  updateAutoAllow(id: string, autoAllow: boolean): void {
    sessionDao.updateSettings(id, { autoAllow })
  }

  /** 批量添加路径到统一允许列表（按 toolType 自动加 `Read(...)`/`Write(...)` 前缀）
   *
   *  仅路径类:命令类工具(bash/ssh)不再有允许列表,逐条询问。
   */
  addAllowListPaths(id: string, toolType: AllowToolType, paths: string[]): void {
    const sess = sessionDao.pickSettings(id, ['allowList'])
    const list = sess?.allowList || []
    const prefixed = paths.map((p) => buildAllowEntry(toolType, p))
    const newEntries = prefixed.filter((p) => !list.includes(p))
    if (newEntries.length > 0) {
      sessionDao.updateSettings(id, { allowList: [...list, ...newEntries] })
      log.info(`addAllowListPaths session=${id} ${toolType} +${newEntries.length}`)
      broadcastSessionConfigChanged(id)
    }
  }

  /** 从统一允许列表移除条目 */
  removeAllowListEntry(id: string, entry: string): void {
    const sess = sessionDao.pickSettings(id, ['allowList'])
    const list = (sess?.allowList || []).filter((e) => e !== entry)
    sessionDao.updateSettings(id, { allowList: list })
    broadcastSessionConfigChanged(id)
  }

  /** 删除会话（同时清理 AgentSession、后台任务、消息、HTTP 日志和临时工作目录） */
  async delete(id: string): Promise<void> {
    // 后台任务是会话资源：必须在下面 rm tool_results 之前杀掉，否则进程还活着写一个已删目录。
    // 放在关停运行时**之前**：run 可能正等着某个后台任务，先杀掉才不会把关停一直吊着
    killBySession(id)
    // 再清理运行时 AgentSession（dispose 触发 destroy）。等它彻底停下才继续删数据 ——
    // 否则一个还在跑的 run 会往刚被删掉的会话文件/结果目录里继续写
    await this.agents.remove(id, 'destroy')
    // 再清理持久化数据
    messageService.clear(id)
    httpLogDao.deleteBySessionId(id)
    sessionDao.deleteById(id)
    // 清理临时会话工作目录
    const tempDir = getTempWorkspace(id)
    if (existsSync(tempDir)) {
      try {
        rmSync(tempDir, { recursive: true, force: true })
      } catch {
        /* 忽略 */
      }
    }
    // 清理工具大结果持久化目录
    const toolResultsDir = join(getToolResultsBase(), id)
    if (existsSync(toolResultsDir)) {
      try {
        rmSync(toolResultsDir, { recursive: true, force: true })
      } catch {
        /* 忽略 */
      }
    }
  }

  // ─── AgentSession 运行时管理 ──────────────────

  /** 获取指定 session 的 AgentSession（不创建） */
  getAgentSession(sessionId: string): AgentSession | undefined {
    return this.agents.get(sessionId)
  }

  /** 解析会话的 Agent 上下文元信息（provider/model/能力/工作目录/启用工具/项目），不创建 AgentSession。
   *  供 initAgent（前端同步）与 ensureAgentSession（懒创建）共用。session 不存在返回 null。 */
  private async resolveSessionAgentContext(sessionId: string): Promise<{
    provider: string
    model: string
    capabilities: ModelCapabilities
    workingDirectory: string
    enabledTools: string[]
    project: Pick<Project, 'path' | 'settings'> | undefined
    modelMetadata: SessionModelMetadata
  } | null> {
    const session = sessionDao.pick(sessionId, ['projectId'])
    if (!session) return null

    // 运行配置的唯一事实源是会话树；树上没有（新会话/从未显式切换过）才回落默认
    const tree = await readSessionRunConfig(sessionId)
    const provider = tree.provider ?? this.getDefaultProvider()
    const model = tree.model ?? this.getDefaultModel()
    const thinkingLevel = tree.thinkingLevel ?? DEFAULT_THINKING_LEVEL

    const modelRow = providerDao.findModelsByProvider(provider).find((m) => m.modelId === model)
    const capabilities: ModelCapabilities = modelRow?.capabilities
      ? JSON.parse(modelRow.capabilities)
      : {}
    const project = session.projectId
      ? projectDao.pick(session.projectId, ['path', 'settings'])
      : undefined
    const workingDirectory = project?.path || getTempWorkspace(sessionId)
    const enabledTools = filterAvailableTools(
      tree.enabledTools ?? this.defaultEnabledTools(project),
      project?.path
    )
    return {
      provider,
      model,
      capabilities,
      workingDirectory,
      enabledTools,
      project,
      modelMetadata: { thinkingLevel, enabledTools }
    }
  }

  /**
   * 返回会话元信息供前端同步（projectPath / 启用工具 / 模型能力 等）。
   * **不创建 AgentSession** —— Agent 延迟到用户首次发送消息时（ensureAgentSession）才创建，
   * 故仅打开会话（含笔记本会话）不会启动 Agent。
   */
  async initAgent(sessionId: string): Promise<AgentInitResult> {
    const ctx = await this.resolveSessionAgentContext(sessionId)
    if (!ctx) {
      log.error(`初始化失败，未找到 session=${sessionId}`)
      return {
        success: false,
        created: false,
        provider: '',
        model: '',
        capabilities: {},
        modelMetadata: {},
        workingDirectory: '',
        enabledTools: []
      }
    }
    return {
      success: true,
      // created 现仅表示「Agent 此刻是否已存在」（已不在 init 时创建）
      created: this.agents.has(sessionId),
      provider: ctx.provider,
      model: ctx.model,
      capabilities: ctx.capabilities,
      modelMetadata: ctx.modelMetadata,
      workingDirectory: ctx.workingDirectory,
      enabledTools: ctx.enabledTools
    }
  }

  /**
   * 懒创建并返回指定 session 的 AgentSession（已存在直接返回）。
   * 首次发送消息 / 压缩 / 其它需要运行时 Agent 的操作调用；session 不存在返回 undefined。
   * 构造逻辑见 SessionManager 的 create 注入（resolveSessionAgentContext + AgentSession.create）。
   *
   * 上一个运行时尚未关停完时**会等**（一个会话只允许一个运行时），期间前端显示「正在停止」。
   */
  ensureAgentSession(sessionId: string): Promise<AgentSession | undefined> {
    return this.agents.ensure(sessionId)
  }

  /** 该会话的运行时是否正在关停（前端「正在停止」态的权威来源） */
  isAgentClosing(sessionId: string): boolean {
    return this.agents.isClosing(sessionId)
  }

  /**
   * 会话当前模型配置（workflow 引擎会话域 run 的模型回落源）。
   * 与运行时创建同一口径（resolveSessionAgentContext：树上没有 → 全局默认）；
   * 会话不存在或没有可用模型返回 null —— 调用方（run()）报「无可用模型」。
   */
  async resolveRunModelConfig(sessionId: string): Promise<SubAgentModelConfig | null> {
    const ctx = await this.resolveSessionAgentContext(sessionId)
    if (!ctx || !ctx.provider || !ctx.model) return null
    return { provider: ctx.provider, model: ctx.model, capabilities: ctx.capabilities }
  }

  /**
   * 关停并解绑指定 session 的 Agent（回退/切档案时使用，下次 ensure 会重建）。
   * **返回的 Promise 落定时旧运行时保证不会再写会话树** —— 调用方必须 await 之后
   * 再动会话树（moveTo / append），否则就会退回「两个 run 抢同一个叶子」的老问题。
   */
  invalidateAgent(sessionId: string): Promise<void> {
    return this.agents.remove(sessionId, 'invalidate')
  }

  /**
   * 解析笔记本会话「一次性子智能体」的运行数据（systemPrompt + 工具白名单 + 模型 + 注入开关），
   * 不创建任何运行时。仅负责数据存取；信封组装与派发由 runNotebookTask（共享内核）完成。
   *
   * 人格与工具白名单都取 **notebook 基座档案**（用户 ~/.shuvix/agents/notebook.md 可覆盖），
   * 笔记路径经 {{shuvix:notebookPath}} 在渲染时替换进 body。session 不存在返回 null。
   */
  async buildNotebookRunParams(sessionId: string): Promise<{
    systemPrompt: string
    /** 子代理工具白名单（buildSubAgentTools 按名解析） */
    tools: string[]
    modelConfig: SubAgentModelConfig
    /** notebook 档案声明的模型（`shuvix-model`）；声明了就优先于会话所选 */
    model?: string
    /** notebook 档案的两项上下文注入声明（内置默认都不注入，用户覆盖档案可打开） */
    instructionFiles: readonly string[]
    projectPrompt: boolean
  } | null> {
    const ctx = await this.resolveSessionAgentContext(sessionId)
    if (!ctx) return null
    const notebookPath = sessionDao.pickSettings(sessionId, ['notebookPath'])?.notebookPath ?? ''
    const profile = agentService.getProfile(NOTEBOOK_PROFILE_NAME)!
    // 档案白名单（内置已排除 ask —— 面板只读无法应答 —— 与 Agent）+ 会话启用的 mcp:/skill:
    const mcpSkill = ctx.enabledTools.filter((n) => n.startsWith('mcp:') || n.startsWith('skill:'))
    return {
      systemPrompt: await renderNotebookSystemPrompt(sessionId, ctx.workingDirectory, notebookPath),
      tools: [...profile.tools, ...mcpSkill],
      model: profile.model,
      instructionFiles: profile.instructionFiles,
      projectPrompt: profile.projectPrompt,
      modelConfig: {
        provider: ctx.provider,
        model: ctx.model,
        capabilities: ctx.capabilities,
        // 笔记本子代理继承会话所选思考深度（与主会话口径一致，经共享 helper 解析）
        thinkingLevel: resolveInitialThinkingLevel({
          persisted: ctx.modelMetadata.thinkingLevel,
          reasoning: ctx.capabilities.reasoning
        })
      }
    }
  }

  // ─── 用户输入响应路由(遍历所有 session 查找归属) ──

  /**
   * 统一响应入口:根据 requestId 找到归属 session 并把响应送达。
   * 所有类型的用户输入(询问 / 选择题 / SSH 凭证)都走这一个路径。
   */
  respondToInput(requestId: string, response: InputResponse): void {
    for (const session of this.agents.values()) {
      if (session.respondToInput(requestId, response)) return
    }
  }

  // ─── private ──────────────────────────────────

  /**
   * 获取默认提供商 ID。
   * 用户配置存在且依然处于启用状态时返回该值；否则返回空字符串（不做自动回退）。
   * 这样用户在设置中把默认显式选为「无」时，新会话也不会被静默配上某个模型。
   */
  private getDefaultProvider(): string {
    const configured = settingsDao.findByKey('general.defaultProvider')
    if (!configured) return ''
    const enabled = providerDao.findEnabled()
    return enabled.some((p) => p.id === configured) ? configured : ''
  }

  /**
   * 获取默认模型 ID。
   * 仅当 provider 已确定且配置模型仍处于启用列表中时返回该值；否则返回空字符串。
   */
  private getDefaultModel(): string {
    const providerId = this.getDefaultProvider()
    if (!providerId) return ''
    const configured = settingsDao.findByKey('general.defaultModel')
    if (!configured) return ''
    const models = providerDao.findEnabledModels(providerId)
    return models.some((m) => m.modelId === configured) ? configured : ''
  }
}

export const sessionService = new SessionService()

// 子代理询问通道：把子代理工具的 InputRequest 转发到父会话（表单出现在父会话对话流）。
// 经 userInputBroker 注册，避免 AgentManager 静态依赖 sessionService 形成循环。
registerUserInputResolver((sessionId, request) => {
  const agent = sessionService.getAgentSession(sessionId)
  if (!agent) {
    return Promise.reject(new Error(`Session ${sessionId} is not active`))
  }
  return agent.requestUserInput(request)
})
