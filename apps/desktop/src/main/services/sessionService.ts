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
  BASE_PROFILE_NAMES,
  CHAT_PROFILE_NAME,
  NOTEBOOK_PROFILE_NAME,
  SessionManager,
  WORK_PROFILE_NAME
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
   * 调用方传的 projectId 在这种情况下被忽略；免询问开关（autoAllow）同样跟着抄一份，
   * 它是 settings 一列所以在这里，而模型 / 思考档位 / 工具勾选那三项是会话树上的
   * change entry，由 `subSessionRunner.seedRunConfig` 在建完之后种（见那里的说明）。
   */
  create(params?: SessionCreateParams): Session {
    const id = uuidv7()
    const notebookPath = params?.notebookPath
    const now = Date.now()
    const parentId = params?.parentId ?? null
    const parent = parentId ? sessionDao.pick(parentId, ['projectId', 'settings']) : undefined
    const pid = parent ? parent.projectId : (params?.projectId ?? null)

    // 聊天会话：绑定一个 bot，无根。空串 / 空白视同没给
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
        // 子会话继承父会话的免询问开关（其余运行配置的种子在 subSessionRunner.create）。
        // 与「按会话存的授权不可继承」那条原始设计相反，是一次显式裁决：子会话是父级
        // 派活的地方、同一个工作目录、开它本身还要过一次 ask-on-sub-session ——
        // 用户为这条对话关掉的询问，不该在它每开一条子会话时原样回来。
        // 路径授权（allowList）刻意**不**继承：那是一条会长大的记账，快照过去只会漂移。
        ...(parent?.settings?.autoAllow ? { autoAllow: true } : {})
        // 档案**不在这里写**：根 Agent 的档案由会话形态推导（项目会话 work / 无项目 chat /
        // 笔记本 notebook，见 resolveAgentProfileName），没有可选的东西。只有子会话在父级
        // 点名档案时由 subSessionRunner 经 pinAgentProfile 钉一个显式值。
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
   * 解析会话根 Agent 的档案名 —— **由会话形态推导**，不是用户选的：
   *
   *  - 聊天会话（见 isBotSession）返回 **null**：它没有根 Agent；
   *  - 笔记本会话（settings.notebookPath 非空）恒为 `notebook`
   *    （用户覆盖 `~/.shuvix/agents/notebook.md` 经 getProfile 按名合并自动生效）；
   *  - 子会话可以带一个父级点名、`pinAgentProfile` 钉下的 `settings.agentProfile`
   *    （如 `coding`）：档案还在就用它。档案是纯 md 驱动的，用户随时可能删掉某个
   *    `~/.shuvix/agents/<name>.md`，钉着一个已不存在的名字时回落形态基座而不是卡死；
   *  - 其余一律按形态：归属项目 → `work`，不归属任何项目 → `chat`。
   *
   * 根会话上的 `agentProfile` **不读**：那是会话内切换档案时代写下的戳（含旧基座名
   * `default`），改制刻意不做迁移 —— 项目会话就是 work、无项目会话就是 chat，没有设置项、
   * 没有切换命令、没有选择器，键留在 settings 里只是遗留数据。
   */
  resolveAgentProfileName(sessionId: string): string | null {
    const session = sessionDao.pick(sessionId, ['projectId', 'parentId', 'settings'])
    const settings = session?.settings
    // 聊天会话没有根 Agent：消息由绑定的 bot 的管线应答。返回类型因此是可空的 ——
    // 把「这个会话没有档案」变成编译期事实，胜过再造一个与它并行、迟早漂移的谓词
    if (isChatSessionSettings(settings)) return null
    if (settings?.notebookPath) return NOTEBOOK_PROFILE_NAME
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
   * （无项目的父级开一条 `work` 子会话？）；未声明 `shuvix-session-awareness` 的档案不接受
   * —— 那是只可派发的执行体（如 wiki-writer），政策的有效性依赖每次派发都是新鲜上下文，
   * 当一条长会话的人格会稀释系统提示词权重，而它们违规的代价静默且不可逆。
   *
   * 钉下的同时把档案声明的运行配置作为**种子**写进会话树（与用户手动改模型/工具同一条
   * 路径）：会话的事实源始终是会话树，档案只在这一刻参与一次，之后用户改什么就是什么
   * —— 若让 createAgent 每次重建都按档案覆盖，用户手选的会被默默还原。
   *  - 模型（`shuvix-model`）：解析成功才写；不可用则保持当前模型，把原始值经
   *    `modelUnavailable` 回传（后端日志之外调用方也该看得见）。
   *  - 工具（`shuvix-tools` 里的 mcp:/skill:）：**替换**会话勾选，没声明就是清空 ——
   *    档案对三类工具是完整声明；内置工具不进勾选（它们恒由档案白名单决定）。紧接着的
   *    subSessionRunner.seedRunConfig 会在档案没声明时把父会话那套补回去。
   * 种子结果随 `applied` 回传。
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
        error: BASE_PROFILE_NAMES.has(name)
          ? `"${name}" is a base profile; omit agent_profile to run the sub-session on this session's own base`
          : `"${name}" is not session-aware and cannot run a session of its own`
      }
    }
    log.info(`pinAgentProfile session=${sessionId} → ${name}`)
    sessionDao.updateSettings(sessionId, { agentProfile: name })
    // 刚建好的子会话还没有运行时；仍走一遍失效是为守住不变量 —— 钉档案与重建之间不能有
    // 一个还在写树的旧运行时（await：解绑必须发生在关停之后，之后往树上追加种子才不会和它抢叶子）
    await this.invalidateAgent(sessionId)

    // 种子：运行时已在上一行失效，故直接往树上追加（没有活跃 Agent 需要同步）
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
   * 会话**此刻实际在用**的整套运行配置 —— 与运行时创建同一口径
   * （resolveSessionAgentContext：树上没有 → 回落默认），会话不存在返回 null。
   *
   * 给的是**解析后**的值而不是「树上显式写过的那些」：子会话种子（subSessionRunner.create）
   * 要复制的是父会话跑起来是什么样，而父会话大多数键根本没显式改过 —— 只抄显式值，
   * 一条从没动过工具勾选的父会话就会把「继承」变成「什么也没继承」。
   */
  async resolveRunConfig(sessionId: string): Promise<{
    model: SubAgentModelConfig | null
    thinkingLevel: string
    enabledTools: string[]
  } | null> {
    const ctx = await this.resolveSessionAgentContext(sessionId)
    if (!ctx) return null
    return {
      model:
        ctx.provider && ctx.model
          ? { provider: ctx.provider, model: ctx.model, capabilities: ctx.capabilities }
          : null,
      thinkingLevel: ctx.modelMetadata.thinkingLevel ?? DEFAULT_THINKING_LEVEL,
      enabledTools: ctx.enabledTools
    }
  }

  /**
   * 会话当前模型配置（workflow 引擎会话域 run 的模型回落源）。
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
