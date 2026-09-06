import { v7 as uuidv7 } from 'uuid'
import { join, basename } from 'path'
import { rmSync, existsSync } from 'fs'
import { sessionDao } from '../dao/sessionDao'
import { messageService } from './messageService'
import {
  readSessionRunConfig,
  addSessionTreePin,
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

import { DEFAULT_THINKING_LEVEL } from '@shuvix/chat-protocol/types/thinking'
import {
  DEFAULT_CHAT_AGENT_KEY,
  DEFAULT_PROJECT_AGENT_KEY
} from '@shuvix/chat-protocol/agentProfile'
import {
  BASE_PROFILE_NAMES,
  SWITCHABLE_BASE_PROFILE_NAMES,
  CHAT_PROFILE_NAME,
  DEFAULT_PROFILE_NAME,
  NOTEBOOK_PROFILE_NAME,
  SessionManager
} from '@shuvix/agent-runtime'
import type { SubAgentModelConfig } from '@shuvix/agent-runtime'
import { isChatSessionSettings } from '@shuvix/chat-protocol/chatSession'
import { agentService } from './agentService'
// 仅在方法体内调用：两个模块的构造期都不互相触碰，ESM 活绑定下无初始化环
import { botService } from './botService'
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
      // 聊天会话恒无根 Agent。守在这一处，`tracked()` 便恒为 false，
      // `ensureAgentSession` 与 `getAgentInfo({ensure})` 两个消费方一行都不用改
      if (profileName === null) return undefined
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
   *
   * params.parentId 非空时创建**子会话**：形态仍是普通会话，只是多一个父指针。
   * projectId 恒随父会话（工作目录是会话的地基，跨项目的子会话没有可用语义）——
   * 调用方传的 projectId 在这种情况下被忽略。
   */
  create(params?: SessionCreateParams): Session {
    const id = uuidv7()
    const notebookPath = params?.notebookPath
    const now = Date.now()
    const parentId = params?.parentId ?? null
    const parent = parentId ? sessionDao.pick(parentId, ['projectId']) : undefined
    const pid = parent ? parent.projectId : (params?.projectId ?? null)

    // 聊天会话：绑定一个 bot，无根。空串 / 空白视同没给
    const bot = params?.bot?.trim() || undefined
    const isRootless = !!bot
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
        // 档案在**创建这一刻**定型（下同 §resolveAgentProfileName）：按会话形态取设置里
        // 对应的默认档案，落成一个显式的 agentProfile。之后改设置只影响更新的会话 ——
        // 档案是粘性的，一条已经在跑的会话不该因为改了个全局默认就换人格。
        // 笔记本会话（钉死 notebook）与无根的聊天会话不写：它们的档案不由这个值决定。
        ...(notebookPath || isRootless ? {} : { agentProfile: this.defaultAgentProfile(pid) })
      },
      createdAt: now,
      updatedAt: now
    }
    sessionDao.insert(session)
    broadcastSessionListChanged()
    // 注：指令文件不在创建时注入。改为在用户首次发送 prompt 时按当前配置懒注入
    // （由 AgentSession.prompt 判定 agent 上下文是否为空），使得用户可以在
    // 创建会话后、发送第一条消息前任意切换配置。
    return session
  }

  /**
   * 给聊天会话绑定 bot。
   *
   * 两条纪律：
   *  - **只对聊天会话生效**。「有没有 bot」决定的是会话形态（无根 / 有根）：给普通会话
   *    绑一个 bot 等于中途换一种会话，这里不做。反过来，群聊时代遗留的会话（只有 `bots`
   *    名单、没有 `bot`）正是这个口的主要客户 —— 它们没有做迁移，靠用户在这里重新选一个。
   *  - **不校验名字是否存在**（与 create 同口径）：bot md 是纯 md 驱动的，用户随时可能
   *    删掉一个；缺失在会话里可见地失败（`bot.botGone`），历史消息靠消息行自带的
   *    displayName 永不裂。
   */
  setBot(id: string, bot: string): { success: boolean; error?: string } {
    if (!this.isBotSession(id)) return { success: false, error: 'Not a chat session' }
    const name = bot.trim()
    if (!name) return { success: false, error: 'A chat session needs a bot' }
    sessionDao.updateSettings(id, { bot: name })
    broadcastSessionConfigChanged(id)
    log.info(`setBot session=${id} → ${name}`)
    return { success: true }
  }

  /**
   * 改聊天会话的运行配置（v2）—— 部分更新，未给的键保持原值。
   *
   * 只对聊天会话有意义（有根会话的配置在会话树上）。不广播列表变更：模型切换不改变
   * 会话在列表里的呈现，而 `updateSettings` 顺带 touch 的 updatedAt 会让它无端上浮 ——
   * 那是「有新消息」才该有的信号。
   */
  updateChatRunConfig(
    id: string,
    patch: { provider?: string; model?: string; thinkingLevel?: string }
  ): void {
    if (!this.isBotSession(id)) return
    const cur = sessionDao.pickSettings(id, ['chatRunConfig'])?.chatRunConfig
    sessionDao.updateSettings(id, {
      chatRunConfig: {
        provider: patch.provider ?? cur?.provider ?? '',
        model: patch.model ?? cur?.model ?? '',
        ...((patch.thinkingLevel ?? cur?.thinkingLevel)
          ? { thinkingLevel: patch.thinkingLevel ?? cur?.thinkingLevel }
          : {})
      }
    })
  }

  /**
   * bot 回复落树后的会话侧账（A4 未读）：未读 +1。`updateSettings` 顺带 touch
   * updatedAt —— 列表按它排序，**上浮与未读是同一笔账**；随后广播列表变更
   * （渲染端 seq-guarded 重拉）。只有聊天会话的落树路径会调它，有根会话恒缺省。
   */
  noteUnreadBotReply(id: string): void {
    const cur = sessionDao.pickSettings(id, ['unreadCount'])?.unreadCount ?? 0
    sessionDao.updateSettings(id, { unreadCount: cur + 1 })
    broadcastSessionListChanged()
  }

  /**
   * 清零未读（A4）。幂等：已为 0 不写库不广播 —— 正在看的会话每来一条回复都会
   * 「+1 → 清零」跑一轮，这个短路让第二次清零不再空转一圈广播。
   */
  markRead(id: string): { success: boolean } {
    const cur = sessionDao.pickSettings(id, ['unreadCount'])?.unreadCount ?? 0
    if (cur === 0) return { success: true }
    sessionDao.updateSettings(id, { unreadCount: 0 })
    broadcastSessionListChanged()
    return { success: true }
  }

  /**
   * 改名迁移专用的绑定改写。
   *
   * 与 `setBot` 刻意分开：那个是**用户操作**（校验形态、拒绝空名），而这里是一次跟着
   * bot 改名走的机械替换 —— 绑定没有变化，只是同一个 bot 换了个名字。
   */
  rewriteBot(id: string, bot: string): void {
    if (!bot) return
    sessionDao.updateSettings(id, { bot })
    broadcastSessionConfigChanged(id)
  }

  /**
   * 聊天会话判定 —— 绑定了 bot，或带着群聊时代的遗留成员名单（未绑定，等用户重新选）。
   * 口径在 chat-protocol 的 `isChatSessionSettings`：两个宿主与三层 UI 共用一份。
   */
  isBotSession(sessionId: string): boolean {
    return isChatSessionSettings(sessionDao.pickSettings(sessionId, ['bot', 'bots']))
  }

  /**
   * 新会话的默认档案名 —— 由**会话形态**选设置项：归属项目走「默认项目智能体」
   * （缺省 `default`：确认需求、把活儿交给 coding 子会话、验收结果），不归属项目走
   * 「默认聊天智能体」（缺省 `chat`：握全套内置工具、自己把活干完）。
   *
   * 设置指向的档案已不存在（用户删了那份 md），或它根本不能当会话档案（旧值指着
   * `notebook`、某份档案后来去掉了 `shuvix-session-awareness`）时回落对应基座 ——
   * 准入与 `/<agentName>` 切换同源（agentService.isSessionProfile）：**创建入口与切换
   * 入口必须同口径**，否则切换拒绝、创建照戳，同一条规则只实现一半。
   *
   * 回落到**对应基座**而不是一律 `default`，与 resolveAgentProfileName 的回落刻意不同：
   * 那里在读一条已经存在的会话（无戳 = 改动之前建的，那时的基座就是 default），这里在
   * 决定一条新会话该从哪条路线起步，形态是已知的。两处别合并。
   */
  private defaultAgentProfile(projectId: string | null): string {
    const inProject = !!projectId
    const key = inProject ? DEFAULT_PROJECT_AGENT_KEY : DEFAULT_CHAT_AGENT_KEY
    const base = inProject ? DEFAULT_PROFILE_NAME : CHAT_PROFILE_NAME
    const configured = settingsDao.findByKey(key)?.trim()
    if (!configured || configured === base) return base
    const profile = agentService.getProfile(configured)
    if (profile && agentService.isSessionProfile(profile)) return configured
    log.warn(`默认档案 "${configured}"（${key}）不可用作会话档案，回落 ${base}`)
    return base
  }

  /**
   * 解析会话根 Agent 的档案名。
   *
   * 聊天会话（见 isBotSession）返回 **null** —— 它没有根 Agent。
   * 笔记本会话（settings.notebookPath 非空）恒为 'notebook' 基座档案，忽略 agentProfile
   * （用户覆盖 `~/.shuvix/agents/notebook.md` 经 getProfile 按名合并自动生效）。
   * 其余会话读 settings.agentProfile —— 它在 `create` 时就按会话形态落成了显式值
   * （见 defaultAgentProfile），所以这里**不再判断有没有项目**：默认档案只在创建那一刻
   * 参与一次，之后是会话自己的事（`/<agentName>` 切换写的也是这个键）。
   * 缺省（本次改动之前建的老会话）与档案文件被删/改名时一律回落 'default'：档案是纯
   * md 驱动的，用户随时可能删掉某个 `~/.shuvix/agents/<name>.md`，会话设置不该因此把
   * 根 Agent 卡死在一个不存在的档案上。
   */
  resolveAgentProfileName(sessionId: string): string | null {
    const settings = sessionDao.pickSettings(sessionId, [
      'agentProfile',
      'notebookPath',
      'bot',
      'bots'
    ])
    // 聊天会话没有根 Agent：消息由绑定的 bot 的管线应答。返回类型因此是可空的 ——
    // 把「这个会话没有档案」变成编译期事实，胜过再造一个与它并行、迟早漂移的谓词
    if (isChatSessionSettings(settings)) return null
    if (settings?.notebookPath) return NOTEBOOK_PROFILE_NAME
    const name = settings?.agentProfile
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
    // 两类会话的档案都不接受切换（见 resolveAgentProfileName）。守在方法体第一句：
    // 拒绝必须先于 getProfile / 落库 / 种子写入 / invalidateAgent，零副作用
    const pinned = sessionDao.pickSettings(sessionId, ['notebookPath', 'bot', 'bots'])
    if (isChatSessionSettings(pinned)) {
      return { success: false, error: 'Chat sessions have no root agent to switch' }
    }
    if (pinned?.notebookPath) {
      return { success: false, error: 'Notebook sessions are pinned to the notebook profile' }
    }
    const profile = agentService.getProfile(name)
    if (!profile) return { success: false, error: `Unknown agent "${name}"` }
    // 'notebook' 是笔记本会话形态的基座，切到普通会话上只会得到一个指向不存在笔记的人格
    // （命令源同样不列它）；'default' / 'chat' 是普通会话的两条路线，互为退路，都可切。
    if (!SWITCHABLE_BASE_PROFILE_NAMES.has(name) && BASE_PROFILE_NAMES.has(name)) {
      return { success: false, error: `"${name}" is a base profile and cannot be switched to` }
    }
    // 未声明会话感知的档案（如 wiki-writer）只可被派发：政策的有效性依赖每次派发都是
    // 新鲜上下文，切成主会话后长对话会稀释系统提示词权重，而它们违规的代价静默且不可逆。
    // 可切换基座豁免（与 listSwitchable 同源）：会话本就由它们之一创建，一份漏写该键的
    // 用户 default.md / chat.md 不该把「切回基座」这条退路也堵死。
    if (!SWITCHABLE_BASE_PROFILE_NAMES.has(name) && !profile.sessionAwareness) {
      return { success: false, error: `"${name}" is not session-aware and cannot be switched to` }
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
   * 'auto' = 自动化写入（session 工具）。这是 `session.turn-completed` 埋点里
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
    broadcastSessionListChanged()
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
    // 聊天会话的写者不是 AgentSession 而是 botService 的树写锁，并列排空
    await botService.abortSession(id)
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

    // 运行配置的事实源**按会话形态**分流（v2）：
    //   有根会话 → 会话树的 model_change / thinking_level_change / active_tools_change entry
    //   聊天会话 → settings.chatRunConfig（它没有根 Agent，v2 之后也没有会话树）
    // 判据是形态（聊天会话）而不是「chatRunConfig 在不在」—— 刚建的聊天会话还没有那个键，
    // 按存在性分流会让它掉回去读一棵根本不存在的树。两种形态互斥，创建那一刻就定死。
    const cfg = sessionDao.pickSettings(sessionId, ['bot', 'bots', 'chatRunConfig'])
    const isChat = isChatSessionSettings(cfg)
    const chat = isChat ? cfg?.chatRunConfig : undefined
    const tree = isChat
      ? { provider: undefined, model: undefined, thinkingLevel: undefined, enabledTools: undefined }
      : await readSessionRunConfig(sessionId)
    const provider = chat?.provider ?? tree.provider ?? this.getDefaultProvider()
    const model = chat?.model ?? tree.model ?? this.getDefaultModel()
    const thinkingLevel = chat?.thinkingLevel ?? tree.thinkingLevel ?? DEFAULT_THINKING_LEVEL

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

  // ─── 用户输入 ──────────────────────────────────

  /**
   * 此刻活着的 AgentSession —— 供 broker 的参与方按 requestId 找归属。
   *
   * 响应入口本身已经上移到 `userInputBroker`：那里同时握着请求与答复两个方向，
   * 而聊天会话（无根）的询问归 botService 管，留在这里就永远轮不到它。
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
 * 无根的聊天会话在这里恒不认领，它由 botService 自己那份参与方接管。
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
