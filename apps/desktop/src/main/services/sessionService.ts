import { v7 as uuidv7 } from 'uuid'
import { join, basename } from 'path'
import { rmSync, existsSync } from 'fs'
import { sessionDao } from '../dao/sessionDao'
import { messageService } from './messageService'
import { readSessionRunConfig, addSessionTreePin, appendModelChange } from './sessionStorage'
import { httpLogDao } from '../dao/httpLogDao'
import { providerDao } from '../dao/providerDao'
import { projectDao } from '../dao/projectDao'
import { settingsDao } from '../dao/settingsDao'
import { t } from '../i18n'
import { getTempWorkspace, getToolResultsBase } from '../utils/paths'
import { filterAvailableTools } from './toolAggregator'
import { mcpService } from './mcpService'
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

import { DEFAULT_THINKING_LEVEL } from '@shuvix/chat-protocol/types/thinking'
import {
  CHAT_PROFILE_NAME,
  NOTEBOOK_PROFILE_NAME,
  BOT_PROFILE_NAME,
  SessionManager,
  WORK_PROFILE_NAME
} from '@shuvix/agent-runtime'
import type { SubAgentModelConfig } from '@shuvix/agent-runtime'
import { isBotSessionSettings } from '@shuvix/chat-protocol/botSession'
import { agentService } from './agentService'
// 仅在方法体内调用：两个模块的构造期都不互相触碰，ESM 活绑定下无初始化环
import { AgentSession } from './agentSession'
import { killBySession, setBgTaskNotifier } from './bgTaskService'
import { resolveProfileModelSpec } from '../agents/agentHost'
import {
  broadcastSessionConfigChanged,
  broadcastSessionListChanged,
  broadcastSessionTitleChanged
} from '../utils/sessionConfigBroadcast'
import { chatFrontendRegistry } from '../frontend/core/ChatFrontendRegistry'
import { registerUserInputParticipant } from './userInputBroker'
import { createLogger } from '../logger'
import { deleteSessionArtifacts } from './artifacts/store'

const log = createLogger('SessionService')

/** 广播「运行时正在关停 / 已关停」——前端据此显示「正在停止」并拦住发送 */
function broadcastAgentClosing(sessionId: string, closing: boolean): void {
  chatFrontendRegistry.broadcast({ type: 'agent_closing', sessionId, closing })
}

/** 广播「运行时已创建」——前端据此把扩展能力勾选切成只读（到 agent_closing{false} 为止） */
function broadcastAgentCreated(sessionId: string): void {
  chatFrontendRegistry.broadcast({ type: 'agent_created', sessionId })
}

/** 只留会话级工具名（mcp:/skill:）并去重保序 —— 扩展能力勾选里不该有别的东西 */
function sessionScopedTools(names: readonly string[]): string[] {
  return [...new Set(names.filter((n) => n.startsWith('mcp:') || n.startsWith('skill:')))]
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
    onClosingChange: (sessionId, closing) => broadcastAgentClosing(sessionId, closing),
    onCreated: (sessionId) => broadcastAgentCreated(sessionId)
  })

  constructor() {
    // 会话树共享缓存的逐出保护：有 AgentSession（或创建中）的会话，
    // 树实例与运行时共享 —— LRU 不得回收，否则读取端会另开分叉实例
    addSessionTreePin((sessionId) => this.agents.tracked(sessionId))

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
   * 扩展能力勾选原样在 `settings.enabledTools` 里；要「创建 Agent 时会用的那份」（滤掉不再
   * 可用的项、旧会话补上继承值）走 `agent.init`（AgentInitResult.enabledTools）。
   */
  getById(id: string): SessionInfo | undefined {
    const session = sessionDao.findById(id)
    if (!session) return undefined
    const project = session.projectId
      ? projectDao.pick(session.projectId, ['path', 'settings'])
      : undefined
    return { ...session, workingDirectory: project?.path || getTempWorkspace(id) }
  }

  /**
   * 新会话从项目继承的扩展能力勾选（mcp:/skill:）：
   *  - 项目在编辑页保存过扩展能力 → 那一份（只做 mcp:/skill: 净化与去重）；
   *  - 项目从没保存过、不属于任何项目（或项目已删）→ 空。
   * 没有「默认全开」：不管在不在项目里，没人勾过就一个都不勾，要用什么由用户自己勾。
   *
   * **继承时不按「此刻可用」过滤**：MCP 的可用 = 此刻已连接，刚启动还没连上的服务器会被当成
   * 不存在，而这里的结果要落库 —— 过滤一次就永久丢掉。可用性只在创建 Agent 那一刻过滤
   * （resolveSessionAgentContext），设置里的原值不动。
   */
  private inheritedEnabledTools(projectId: string | null): string[] {
    const saved = projectId
      ? projectDao.pick(projectId, ['settings'])?.settings?.enabledTools
      : undefined
    return Array.isArray(saved) ? sessionScopedTools(saved) : []
  }

  /**
   * 一条会话「照规矩」该有的勾选：子会话抄父会话（父会话也是没有这个键的旧会话时，按父会话
   * 自己的项目算 —— 与父会话下次解析出来的是同一份，且不替父会话落库）；其余按项目继承。
   * 新建会话（create）与旧会话补键（sessionEnabledTools）共用这一条。
   */
  private inheritedSelection(parentId: string | null, projectId: string | null): string[] {
    const parent = parentId ? sessionDao.pick(parentId, ['projectId', 'settings']) : undefined
    if (!parent) return this.inheritedEnabledTools(projectId)
    const parentTools = parent.settings?.enabledTools
    return Array.isArray(parentTools)
      ? sessionScopedTools(parentTools)
      : this.inheritedEnabledTools(parent.projectId)
  }

  /**
   * 会话的扩展能力勾选（`settings.enabledTools`）原值。
   *
   * 缺这个键的只有改制前建的旧会话：按新建会话同一条规则（inheritedSelection —— 子会话抄父会话，
   * 其余按项目继承）算一次**并落库** —— 之后它和新会话一样是一份快照，不跟着项目配置的后续修改
   * 漂移。会话不存在返回 []。
   */
  private sessionEnabledTools(sessionId: string): string[] {
    const row = sessionDao.pick(sessionId, ['projectId', 'parentId', 'settings'])
    if (!row) return []
    const stored = row.settings?.enabledTools
    if (Array.isArray(stored)) return stored
    const inherited = this.inheritedSelection(row.parentId, row.projectId)
    sessionDao.updateSettings(sessionId, { enabledTools: inherited })
    log.info(`补齐旧会话的扩展能力勾选 session=${sessionId} tools=[${inherited.join(',')}]`)
    return inherited
  }

  /**
   * 创建新会话。
   *
   * **不预写模型类运行配置** —— provider / model / thinkingLevel 的唯一事实源是会话树，
   * 而新会话还没有树。首次 resolveSessionAgentContext 时按「树上没有 → 回落默认」
   * 解析；用户第一次显式切换才在树上留下 change entry。
   *
   * 扩展能力勾选（`settings.enabledTools`）则在这里定下来，**恒写键**（空数组也写 —— 缺键
   * 专指改制前的旧会话）：项目会话继承项目保存过的扩展能力（项目没保存过就是空，见
   * inheritedEnabledTools），无项目的会话为空，子会话抄父会话的勾选。之后只在 Agent 还没
   * 创建时可改（updateEnabledTools）。
   *
   * params.notebookPath 非空时创建「笔记本会话」：绑定项目内的一个 md 文件、标题默认取 basename
   * （去后缀的标题由共享的 useCreateNotebook 显式传入 params.title）。
   *
   * params.parentId 非空时创建**子会话**：形态仍是普通会话，只是多一个父指针。
   * projectId 恒随父会话（工作目录是会话的地基，跨项目的子会话没有可用语义）——
   * 调用方传的 projectId 在这种情况下被忽略；免询问开关（autoAllow）与扩展能力勾选同样跟着
   * 抄一份，它们是 settings 的键所以在这里，而模型 / 思考档位是会话树上的 change entry，
   * 由 `subSessionRunner.seedRunConfig` 在建完之后种（见那里的说明）。
   */
  create(params?: SessionCreateParams): Session {
    const id = uuidv7()
    const notebookPath = params?.notebookPath
    const now = Date.now()
    const parentId = params?.parentId ?? null
    const parent = parentId ? sessionDao.pick(parentId, ['projectId', 'settings']) : undefined
    const pid = parent ? parent.projectId : (params?.projectId ?? null)
    // 子会话抄父会话的勾选，其余按项目继承（与旧会话补键同一条规则，见 inheritedSelection）
    const enabledTools = this.inheritedSelection(parentId, pid)

    // bot 会话：绑定一个 bot，**有根**（根档案 bot，形态推导见 resolveAgentProfileName）。空串 / 空白视同没给
    const bot = params?.bot?.trim() || undefined
    const session: Session = {
      id,
      title: params?.title ?? (notebookPath ? basename(notebookPath) : t('agent.defaultTitle')),
      projectId: pid,
      parentId,
      // 指令文件不预写配置：留空即「未显式配置」，注入时按 AGENTS.md → CLAUDE.md 优先级自动选
      settings: {
        ...(notebookPath ? { notebookPath } : {}),
        ...(params?.memorySlug ? { memorySlug: params.memorySlug } : {}),
        // 只在有值时写键：缺省即无键
        ...(bot ? { bot } : {}),
        // 子会话继承父会话的免询问开关（模型 / 思考档位的种子在 subSessionRunner.create）。
        // 与「按会话存的授权不可继承」那条原始设计相反，是一次显式裁决：子会话是父级
        // 派活的地方、同一个工作目录、开它本身还要过一次 ask-on-sub-session ——
        // 用户为这条对话关掉的询问，不该在它每开一条子会话时原样回来。
        // 路径授权（allowList）刻意**不**继承：那是一条会长大的记账，快照过去只会漂移。
        ...(parent?.settings?.autoAllow ? { autoAllow: true } : {}),
        // 扩展能力勾选恒写键（见方法注释）
        enabledTools
        // 档案**不在这里写**：根 Agent 的档案由会话形态推导（项目会话 work / 无项目 chat /
        // 笔记本 notebook / bot 会话 bot，见 resolveAgentProfileName），没有可选的东西。只有子会话在父级
        // 点名档案时由 subSessionRunner 经 pinAgentProfile 钉一个显式值。
      },
      createdAt: now,
      updatedAt: now,
      lastActiveAt: now
    }
    sessionDao.insert(session)
    broadcastSessionListChanged()
    // 注：指令文件不在创建时注入。改为在用户首次发送 prompt 时按当前配置懒注入
    // （由 AgentSession.prompt 判定 agent 上下文是否为空），使得用户可以在
    // 创建会话后、发送第一条消息前任意切换配置。
    return session
  }

  /** bot 会话判定 —— 绑定了一个 bot。口径在 chat-protocol 的 botSession（两个宿主与三层 UI 共用一份） */
  isBotSession(sessionId: string): boolean {
    return isBotSessionSettings(sessionDao.pickSettings(sessionId, ['bot']))
  }

  /**
   * 解析会话根 Agent 的档案名 —— **由会话形态推导**，不是用户选的：
   *
   *  - 笔记本会话（settings.notebookPath 非空）恒为 `notebook`
   *    （用户覆盖 `~/.shuvix/agents/notebook.md` 经 getProfile 按名合并自动生效）；
   *  - bot 会话（settings.bot 非空）恒为 `bot`：人设与记忆经 systemContext 注入（见 agentSession）；
   *  - 子会话可以带一个父级点名、`pinAgentProfile` 钉下的 `settings.agentProfile`
   *    （如 `coding`）：档案还在就用它。档案是纯 md 驱动的，用户随时可能删掉某个
   *    `~/.shuvix/agents/<name>.md`，钉着一个已不存在的名字时回落形态基座而不是卡死；
   *  - 其余一律按形态：归属项目 → `work`，不归属任何项目 → `chat`。
   *
   * 根会话上的 `agentProfile` **不读**：那是会话内切换档案时代写下的戳（含旧基座名
   * `default`），改制刻意不做迁移 —— 项目会话就是 work、无项目会话就是 chat，没有设置项、
   * 没有切换命令、没有选择器，键留在 settings 里只是遗留数据。
   */
  resolveAgentProfileName(sessionId: string): string {
    const session = sessionDao.pick(sessionId, ['projectId', 'parentId', 'settings'])
    const settings = session?.settings
    if (settings?.notebookPath) return NOTEBOOK_PROFILE_NAME
    // bot 会话：根 Agent 恒为基座 `bot`，人设与记忆经 systemContext 注入（见 agentSession.create）。
    // 与笔记本一样按形态推导，没有设置项
    if (isBotSessionSettings(settings)) return BOT_PROFILE_NAME
    const pinned = session?.parentId ? settings?.agentProfile : undefined
    if (pinned) {
      if (agentService.getProfile(pinned)) return pinned
      log.warn(`子会话档案 "${pinned}" 已不存在，回落形态基座（session=${sessionId}）`)
    }
    return session?.projectId ? WORK_PROFILE_NAME : CHAT_PROFILE_NAME
  }

  /**
   * 给一条**刚建好的子会话**钉上父级点名的档案（session 工具 `create-sub-session` 的
   * `agent_profile`；唯一调用方是 subSessionRunner.create）。这是 `settings.agentProfile`
   * 如今唯一的写入口 —— 根会话的档案由形态推导（见 resolveAgentProfileName），没有可写
   * 的东西，也就没有会话内切换：用户想改一种形态的人格，去覆盖对应的基座 md。
   *
   * 准入与派发面互补（agentService.isSessionProfile）：基座档案（work / chat / notebook）
   * 不接受 —— 子会话不点名就自然落到自己形态的基座上，点名一个基座只会得到说不清的组合
   * （无项目的父级开一条 `work` 子会话？）；其余任何档案都可以。
   *
   * 钉下的同时把档案声明的运行配置作为**种子**写进会话（与用户手动改模型 / 勾选同一个落点）：
   * 档案只在这一刻参与一次，之后用户改什么就是什么 —— 若让 createAgent 每次重建都按档案
   * 覆盖，用户手选的会被默默还原。
   *  - 模型（`shuvix-model`）：解析成功才往会话树写；不可用则保持当前模型，把原始值经
   *    `modelUnavailable` 回传（后端日志之外调用方也该看得见）。
   *  - 工具（`shuvix-tools` 里的 mcp:/skill:）：声明了就**替换**扩展能力勾选
   *    （`settings.enabledTools`）；**没声明不算意见**，保留 create 时从父会话抄来的那份 ——
   *    内置 coding / explore 之流只列内置工具，按「完整声明」读就会把项目的 MCP 与 skill 从每条
   *    子会话上摘掉。内置工具不进勾选（它们恒由档案白名单决定）。
   * 种子结果随 `applied` 回传（`tools` 是档案声明的那截，可能为空）。
   */
  async pinAgentProfile(
    sessionId: string,
    name: string
  ): Promise<{
    success: boolean
    error?: string
    applied?: { model?: SubAgentModelConfig; tools: string[] }
    modelUnavailable?: string
  }> {
    // 只有子会话可钉。守在方法体第一句：拒绝必须先于 getProfile / 落库 / 种子写入 /
    // invalidateAgent，零副作用
    const row = sessionDao.pick(sessionId, ['parentId'])
    if (!row?.parentId) {
      return { success: false, error: 'Only a sub-session can be pinned to an agent profile' }
    }
    const profile = agentService.getProfile(name)
    if (!profile) return { success: false, error: `Unknown agent "${name}"` }
    if (!agentService.isSessionProfile(profile)) {
      return {
        success: false,
        error: `"${name}" is a base profile; omit agent_profile to run the sub-session on this session's own base`
      }
    }
    log.info(`pinAgentProfile session=${sessionId} → ${name}`)
    sessionDao.updateSettings(sessionId, { agentProfile: name })
    // 刚建好的子会话还没有运行时；仍走一遍失效是为守住不变量 —— 钉档案与重建之间不能有
    // 一个还在写树的旧运行时（await：解绑必须发生在关停之后，之后往树上追加种子才不会和它抢叶子）
    await this.invalidateAgent(sessionId)

    // 种子：运行时已在上一行失效，故直接写（没有活跃 Agent 需要同步）
    let model: SubAgentModelConfig | undefined
    let modelUnavailable: string | undefined
    if (profile.model) {
      const resolved = resolveProfileModelSpec(profile.model)
      if (resolved) {
        await appendModelChange(sessionId, resolved.provider, resolved.model)
        model = resolved
        log.info(`pinAgentProfile 应用档案模型 ${resolved.provider}/${resolved.model}`)
      } else {
        modelUnavailable = profile.model
        log.warn(`档案 "${name}" 声明的模型 "${profile.model}" 当前不可用，保持会话现有模型`)
      }
    }

    // 工具种子：档案声明的 mcp:/skill: 替换扩展能力勾选；没声明就留着继承来的那份
    const tools = sessionScopedTools(profile.tools)
    if (tools.length) sessionDao.updateSettings(sessionId, { enabledTools: tools })

    broadcastSessionConfigChanged(sessionId)
    return { success: true, applied: { model, tools }, modelUnavailable }
  }

  /**
   * 更新会话标题。`origin` 记进 settings.titleOrigin：'user' = 用户改名（UI 重命名），
   * 'auto' = 自动化写入（session 工具）。这是 `session.turn-completed` 埋点里
   * `titleAutoGenerated` 的数据来源 —— 自动化据此避免覆盖用户手动改过的标题。
   * 自动写入才广播 titleChanged（用户改名时渲染端自行更新，维持旧行为）。
   */
  updateTitle(id: string, title: string, origin: 'user' | 'auto' = 'user'): void {
    sessionDao.updateTitle(id, title)
    sessionDao.updateSettings(id, { titleOrigin: origin })
    if (origin === 'user') sessionDao.touchActive(id)
    if (origin === 'auto') broadcastSessionTitleChanged(id, title)
  }

  /** 更新会话所属项目 */
  updateProjectId(id: string, projectId: string | null): void {
    sessionDao.updateProjectId(id, projectId)
    sessionDao.touchActive(id)
    broadcastSessionListChanged()
  }

  /** 更新命令免询问（bash + ssh 统一开关） */
  updateAutoAllow(id: string, autoAllow: boolean): void {
    sessionDao.updateSettings(id, { autoAllow })
    sessionDao.touchActive(id)
  }

  /**
   * 改扩展能力勾选（`settings.enabledTools`，整份替换）—— 输入框的工具选择器与会话设置里的
   * 扩展能力共用的唯一写入口。
   *
   * **只在这条会话没有运行时的时候接受**：勾选只在创建 Agent 那一刻读一次，运行时已存在、
   * 正在创建或正在关停时改了都不会作用到那个运行时，所以一律拒绝、什么也不写，让前端回拉
   * 真实状态。判据用 `tracked` 而不是 `has`：`ensure` 同步登记创建在途，之后到来的写入都落在
   * 这个窗口里被拒 —— 不会出现「勾选落库了、运行时却是按旧勾选建的」。
   */
  updateEnabledTools(id: string, enabledTools: readonly string[]): boolean {
    if (!sessionDao.pick(id, ['id'])) return false
    if (this.agents.tracked(id)) {
      log.info(`拒绝修改扩展能力：会话已有运行时 session=${id}`)
      return false
    }
    sessionDao.updateSettings(id, { enabledTools: sessionScopedTools(enabledTools) })
    sessionDao.touchActive(id)
    broadcastSessionConfigChanged(id)
    return true
  }

  /**
   * 改这条会话启用的知识库（`settings.knowledgeBases`，整份替换）。
   *
   * **不像扩展能力那样上锁**：知识库不进 Agent 的工具表，是 `knowledge` 工具每次调用时由宿主
   * 现查的，所以运行时存在期间照样可改、改完下一次调用就生效。会话不存在返回 false。
   */
  updateKnowledgeBases(id: string, knowledgeBases: readonly string[]): boolean {
    if (!sessionDao.pick(id, ['id'])) return false
    const names = [...new Set(knowledgeBases.map((n) => n.trim()).filter(Boolean))]
    sessionDao.updateSettings(id, { knowledgeBases: names })
    sessionDao.touchActive(id)
    broadcastSessionConfigChanged(id)
    return true
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
      sessionDao.touchActive(id)
      log.info(`addAllowListPaths session=${id} ${toolType} +${newEntries.length}`)
      broadcastSessionConfigChanged(id)
    }
  }

  /** 从统一允许列表移除条目 */
  removeAllowListEntry(id: string, entry: string): void {
    const sess = sessionDao.pickSettings(id, ['allowList'])
    const list = (sess?.allowList || []).filter((e) => e !== entry)
    sessionDao.updateSettings(id, { allowList: list })
    sessionDao.touchActive(id)
    broadcastSessionConfigChanged(id)
  }

  /** 删除会话（同时清理 AgentSession、后台任务、消息、HTTP 日志和临时工作目录） */
  async delete(id: string): Promise<void> {
    // 子会话先走一遍同样的清理（嵌套只有一层，所以不会递归下去第二层）。
    // 放在最前面：父会话的资源清理不该被子会话的运行时拖着。删除确认框已经告诉用户
    // 会一起删掉几条（见 useSessionDelete）——这是「递归删」唯一的补偿。
    for (const child of sessionDao.findChildren(id)) {
      await this.delete(child.id)
    }
    // 后台任务是会话资源：必须在下面 rm tool_results 之前杀掉，否则进程还活着写一个已删目录。
    // 放在关停运行时**之前**：run 可能正等着某个后台任务，先杀掉才不会把关停一直吊着
    killBySession(id)
    // 再清理运行时 AgentSession（dispose 触发 destroy）。等它彻底停下才继续删数据 ——
    // 否则一个还在跑的 run 会往刚被删掉的会话文件/结果目录里继续写
    await this.agents.remove(id, 'destroy')
    // 内置能力服务器（inproc MCP）的寿命绑**会话**，不绑运行时实例 —— 回退重建（invalidate）
    // 时故意留着，ssh 的 control socket / browser 的 tab 不该被一次重建白白掐断。所以释放写在
    // 这里而不是 agent 的 dispose 钩子上：那个钩子在「运行时已先被 invalidate 掉」时根本不跑
    // （SessionManager.remove 没有实例就提前返回），连接会变成谁也关不掉的孤儿。
    // 放在 agents.remove 之后：还在跑的 run 可能正调着它的工具。
    await mcpService.closeSession(id)
    // 再清理持久化数据
    messageService.clear(id)
    httpLogDao.deleteBySessionId(id)
    sessionDao.deleteById(id)
    broadcastSessionListChanged()
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
    // 会话 Artifacts：产物归这场对话，会话没了它们也没有意义（目录不存在时是 no-op —— 多数
    // 会话一件都没有，图缺省走 ```svg 围栏、根本不落盘）
    deleteSessionArtifacts(id)
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
    /** 会话设置里的扩展能力勾选原值（旧会话在这里补键）—— 前端展示与整份替换写入的基准 */
    selectedTools: string[]
    /** 创建 Agent 用的勾选：原值滤掉此刻不可用的 MCP / skill */
    enabledTools: string[]
    project: Pick<Project, 'path' | 'settings'> | undefined
    modelMetadata: SessionModelMetadata
  } | null> {
    const session = sessionDao.pick(sessionId, ['projectId'])
    if (!session) return null
    // 扩展能力勾选在会话设置里（创建会话时定下，创建 Agent 时读这一次）
    const selectedTools = this.sessionEnabledTools(sessionId)

    // 模型类运行配置的唯一事实源是会话树：model_change / thinking_level_change entry
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
    // 滤掉已不可用的 MCP（配置里已停用 / 已删）与 skill（已删 / 已停用）；设置里的原值不动。
    // 可用性**不看连接状态** —— MCP 惰性启动，没连上的那台正要在下一步（装配工具）被连起来
    const enabledTools = filterAvailableTools(selectedTools, project?.path)
    return {
      provider,
      model,
      capabilities,
      workingDirectory,
      selectedTools,
      enabledTools,
      project,
      modelMetadata: { thinkingLevel }
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
      // created = 此刻有运行时（含正在创建 / 正在关停；init 本身不创建）—— 与扩展能力写入口
      // updateEnabledTools 的拒绝条件（tracked）同一口径，前端的只读态据此打底：窗口刷新时
      // 一个卡在关停里的运行时，相关事件早已错过，只能靠这一位
      created: this.agents.tracked(sessionId),
      provider: ctx.provider,
      model: ctx.model,
      capabilities: ctx.capabilities,
      modelMetadata: ctx.modelMetadata,
      workingDirectory: ctx.workingDirectory,
      // 前端要的是勾选原值（离线的 MCP 也显示为已勾，整份替换写入时不会被抹掉）；
      // 过滤后的那份只给创建 Agent 用
      enabledTools: ctx.selectedTools
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
   * 会话**此刻实际在用**的模型类运行配置 —— 与运行时创建同一口径
   * （resolveSessionAgentContext：树上没有 → 回落默认），会话不存在返回 null。
   *
   * 给的是**解析后**的值而不是「树上显式写过的那些」：子会话种子（subSessionRunner.create）
   * 要复制的是父会话跑起来是什么样，而父会话大多数键根本没显式改过 —— 只抄显式值，
   * 一条从没切过模型的父会话就会把「继承」变成「什么也没继承」。
   * 扩展能力勾选不在这里：它是 settings 的键，子会话在 create 里直接抄父会话的。
   */
  async resolveRunConfig(sessionId: string): Promise<{
    model: SubAgentModelConfig | null
    thinkingLevel: string
  } | null> {
    const ctx = await this.resolveSessionAgentContext(sessionId)
    if (!ctx) return null
    return {
      model:
        ctx.provider && ctx.model
          ? { provider: ctx.provider, model: ctx.model, capabilities: ctx.capabilities }
          : null,
      thinkingLevel: ctx.modelMetadata.thinkingLevel ?? DEFAULT_THINKING_LEVEL
    }
  }

  /**
   * 会话当前模型配置（hook 派发的模型回落源）。
   * 会话不存在或没有可用模型返回 null —— 调用方（run()）报「无可用模型」。
   */
  async resolveRunModelConfig(sessionId: string): Promise<SubAgentModelConfig | null> {
    return (await this.resolveRunConfig(sessionId))?.model ?? null
  }

  /**
   * 关停并解绑指定 session 的 Agent（回退/切档案时使用，下次 ensure 会重建）。
   * **返回的 Promise 落定时旧运行时保证不会再写会话树** —— 调用方必须 await 之后
   * 再动会话树（moveTo / append），否则就会退回「两个 run 抢同一个叶子」的老问题。
   */
  invalidateAgent(sessionId: string): Promise<void> {
    return this.agents.remove(sessionId, 'invalidate')
  }

  // ─── 用户输入 ──────────────────────────────────

  /**
   * 此刻活着的 AgentSession —— 供 broker 的参与方按 requestId 找归属。
   *
   * 响应入口本身在 `userInputBroker`：那里同时握着请求与答复两个方向。
   */
  liveAgentSessions(): Iterable<AgentSession> {
    return this.agents.values()
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
/**
 * 有根 agent 的会话由这里认领。
 *
 * `claims` 问的是「此刻有没有活着的运行时」而不是「这条会话记录存不存在」—— 询问要送到
 * 的是内存里那个 AgentSession 的 pendingInputs，运行时不在就没有可送达的地方。
 */
registerUserInputParticipant({
  name: 'session',
  claims: (sessionId) => !!sessionService.getAgentSession(sessionId),
  request: (sessionId, request) => {
    const agent = sessionService.getAgentSession(sessionId)
    // claims 与 request 之间会话可能刚被失效（切档案 / 回退 / 清空）
    if (!agent) return Promise.reject(new Error(`Session ${sessionId} is not active`))
    return agent.requestUserInput(request)
  },
  respond: (requestId, response) => {
    // 遍历而不是按 sessionId 索引：requestId 才是全局唯一的那个 —— 拿调用方以为的
    // sessionId 去选会话，等于把前端的判断当成真相
    for (const session of sessionService.liveAgentSessions()) {
      if (session.respondToInput(requestId, response)) return true
    }
    return false
  }
})
