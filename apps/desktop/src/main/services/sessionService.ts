import { v7 as uuidv7 } from 'uuid'
import { join, basename } from 'path'
import { rmSync, existsSync } from 'fs'
import { sessionRecords } from './sessionRecords'
import { sessionDayPromptDao } from '../dao/sessionDayPromptDao'
import {
  readSessionRunConfig,
  recordSessionModel,
  recordSessionThinkingLevel,
  isDurableSession
} from './sessionStorage'
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
import type { Project, SessionSettings } from '../dao/types'

import {
  DEFAULT_THINKING_LEVEL,
  type SelectableThinkingLevel,
  type ThinkingLevel
} from '@shuvix/chat-protocol/types/thinking'
import {
  CHAT_PROFILE_NAME,
  NOTEBOOK_PROFILE_NAME,
  BOT_PROFILE_NAME,
  TAB_PROFILE_NAME,
  COEDIT_PROFILE_NAME,
  WORK_PROFILE_NAME,
  toInProcessAgentType,
  type AgentConfig,
  type DurableSession
} from '@shuvix/agent-runtime'
import { HOST_ONLY_PROFILE_NAMES, type SubAgentModelConfig } from '@shuvix/agent-runtime'
import { isBotSessionSettings } from '@shuvix/chat-protocol/botSession'
import { chromeTabOf, isChromeTabSessionSettings } from '@shuvix/chat-protocol/chromeTabSession'
import { CURRENT_SESSION_STORAGE_KIND } from '@shuvix/chat-protocol/sessionStorageKind'
import { agentService } from './agentService'
// 仅在方法体内调用：几个模块的构造期都不互相触碰，ESM 活绑定下无初始化环
import { AgentSession, clearAgentScopedState, destroySessionRuntime } from './agentSession'
import { getSessionHost, peekSessionHost } from './sessionHost'
import { peekSyncHub } from '../frontend/sync/syncWiring'
import { effectiveRunState, mirroredAgentLocked } from './sessionMirror'
import { killBySession, setBgTaskNotifier } from './bgTaskService'
import { resolveProfileModelSpec } from '../agents/agentHost'
import {
  broadcastSessionConfigChanged,
  broadcastSessionListChanged,
  broadcastSessionTitleChanged
} from '../utils/sessionConfigBroadcast'
import { registerUserInputParticipant } from './userInputBroker'
import { createLogger } from '../logger'
import { deleteSessionArtifacts } from './artifacts/store'
import { cleanupSession as cleanupSandboxSession } from './sandbox'

const log = createLogger('SessionService')

/** 思考档位的合法值（会话设置里写坏的值按缺省处理，PIN-03） */
const THINKING_LEVELS: readonly string[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
] satisfies readonly ThinkingLevel[]

/**
 * 会话设置里的思考档位 → 合法档位。没设过 / 写坏了 → 按模型能力给缺省：声明了 reasoning 的模型
 * DEFAULT_THINKING_LEVEL，否则 'off'（与 pi-durable 之前的 resolveInitialThinkingLevel、以及界面
 * useSessionInit 的口径一致；显式存下的值含 'off' 一律照用）。
 */
function sessionThinkingLevel(raw: unknown, reasoning: boolean | undefined): ThinkingLevel {
  if (typeof raw === 'string' && THINKING_LEVELS.includes(raw)) return raw as ThinkingLevel
  return reasoning ? DEFAULT_THINKING_LEVEL : 'off'
}

/**
 * 内置能力服务器 `chrome`（用户真实的 Chrome）在工具名单里的写法。它不是会话可勾选的扩展能力：
 * 只由 Chrome 标签页会话的基座档案 `tab` 声明（桌面自己的会话只用应用内的浏览器面板）。
 */
const CHROME_TOOL_NAME = 'mcp:chrome'

/**
 * 会话的工作目录：项目根 → 无项目会话自带的目录（settings.workingDirectory）→ 临时工作区。
 * 三处要这个答案（getById / resolveSessionAgentContext / toolContext 经 getById），口径只写在这里。
 */
function workingDirectoryOf(
  sessionId: string,
  projectPath: string | undefined,
  settings: SessionSettings | undefined
): string {
  return projectPath || settings?.workingDirectory || getTempWorkspace(sessionId)
}

/** 只留会话级工具名（mcp:/skill:）并去重保序 —— 扩展能力勾选里不该有别的东西 */
function sessionScopedTools(names: readonly string[]): string[] {
  return [...new Set(names.filter((n) => n.startsWith('mcp:') || n.startsWith('skill:')))]
}

/**
 * 会话服务 — 管理会话 CRUD，以及会话运行时（SessionHost 上的 DurableSession，经 AgentSession 门面）的
 * 取用 / 销毁。会话存储的打开 / 关闭 / LRU 归 SessionHost（services/sessionHost）；agent 的创建与
 * agent_created / agent_closing 事件归运行时的锁（第一次发送时创建，K3）。
 */
export class SessionService {
  constructor() {
    // 后台任务 / 子会话跑完 → 告知该会话（见 deliverNotice）
    setBgTaskNotifier((sessionId, text) => void this.deliverNotice(sessionId, text))
  }

  /** 主进程唯一的 SessionHost（懒建） */
  private get host(): ReturnType<typeof getSessionHost> {
    return getSessionHost()
  }

  /**
   * 后台通知送达（PIN-05）：开着的会话直接用，没开就 peek（存储在才打开，**从不创建**）。
   * 会话有 agent（锁着）→ 门面的 notify（运行时路由：steer / 自动续跑 / 写入 / 推迟）；
   * 没有 agent → 只写一条通知条目 —— 一条通知不该替一条没人在用的会话创建 agent。
   */
  private async deliverNotice(sessionId: string, text: string): Promise<void> {
    try {
      await this.deliverNoticeOrThrow(sessionId, text)
    } catch (err) {
      log.warn(`后台任务通知失败 session=${sessionId}: ${err}`)
    }
  }

  /**
   * 子会话完成通知送达父会话（P2-10，PIN-13）：与后台通知同一条路（开着的直接用、没开就 peek，
   * **从不创建**；锁着走门面的 notify，没锁只写一条通知条目），只是带上种类与 requestId
   * （`subsession-done:<子会话>:<submission>`，重复送达按它去重）。父会话的行已经没了 → 什么都不做。
   * 送达失败**抛出**：运行时据此留着子会话的 driven-run 标记，下次打开再报。
   */
  async deliverSubSessionNotice(parentId: string, text: string, requestId: string): Promise<void> {
    if (!sessionRecords.pick(parentId, ['id'])) return
    await this.deliverNoticeOrThrow(parentId, text, { kind: 'sub-session', requestId })
  }

  private async deliverNoticeOrThrow(
    sessionId: string,
    text: string,
    options?: { kind: string; requestId: string }
  ): Promise<void> {
    const session = await this.peekDurableSession(sessionId)
    if (!session) return
    if (session.lock) await AgentSession.of(session).notify(text, options)
    else await session.writeNotice({ text, kind: 'background', ...options })
  }

  /** 打开着的会话；没开就 peek（存储存在才打开，从不创建；旧格式 / 宿主已封存 → undefined） */
  private async peekDurableSession(sessionId: string): Promise<DurableSession | undefined> {
    const open = this.host.get(sessionId)
    if (open) return open
    if (!isDurableSession(sessionId)) return undefined
    return this.host.peek(sessionId)
  }

  // ─── DB CRUD ──────────────────────────────────

  /**
   * 获取所有会话（侧栏列表）。Chrome 标签页会话不在其中：它是那个标签页的临时对话，
   * 不是用户的一条会话记录（寿命跟着标签页，见 chromeTabSession.ts）。
   */
  list(): Session[] {
    return sessionRecords
      .findAll()
      .filter((s) => !isChromeTabSessionSettings(s.settings))
      .map((s) => this.withEffectiveRunState(s))
  }

  /**
   * 运行标记换成界面口径（`effectiveRunState`，P3-12）：镜像 `busy` 而会话没在本进程打开 → `interrupted`。
   * 只读：宿主还没建就不建（那时没有任何会话开着），不 open / peek，不写行。
   */
  private withEffectiveRunState<T extends Session>(session: T): T {
    const runState = session.settings?.runState
    if (runState !== 'busy') return session
    const isOpen = peekSessionHost()?.get(session.id) !== undefined
    const effective = effectiveRunState(runState, isOpen)
    if (effective === runState) return session
    return { ...session, settings: { ...session.settings, runState: effective } }
  }

  /**
   * 获取单个会话（含计算属性 workingDirectory）。
   *
   * 扩展能力勾选原样在 `settings.enabledTools` 里；要「创建 Agent 时会用的那份」（滤掉不再
   * 可用的项、旧会话补上继承值）走 `agent.init`（AgentInitResult.enabledTools）。
   */
  getById(id: string): SessionInfo | undefined {
    const session = sessionRecords.findById(id)
    if (!session) return undefined
    const project = session.projectId
      ? projectDao.pick(session.projectId, ['path', 'settings'])
      : undefined
    return {
      ...this.withEffectiveRunState(session),
      workingDirectory: workingDirectoryOf(id, project?.path, session.settings)
    }
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
    const parent = parentId ? sessionRecords.pick(parentId, ['projectId', 'settings']) : undefined
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
    const row = sessionRecords.pick(sessionId, ['projectId', 'parentId', 'settings'])
    if (!row) return []
    const stored = row.settings?.enabledTools
    if (Array.isArray(stored)) return stored
    const inherited = this.inheritedSelection(row.parentId, row.projectId)
    sessionRecords.updateSettings(sessionId, { enabledTools: inherited })
    log.info(`补齐旧会话的扩展能力勾选 session=${sessionId} tools=[${inherited.join(',')}]`)
    return inherited
  }

  /**
   * 创建新会话。
   *
   * **不预写模型类运行配置** —— provider / model / thinkingLevel 存会话设置（`settings.model` /
   * `settings.thinkingLevel`），新会话还没有设过。首次 resolveSessionAgentContext 时按「设置里没有 →
   * 回落默认」解析；用户第一次显式切换（或子会话继承父会话）才写下（sessionStorage 的
   * recordSessionModel / recordSessionThinkingLevel）。
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
   * 调用方传的 projectId 在这种情况下被忽略；扩展能力勾选同样跟着抄一份，它是 settings
   * 的键所以在这里，而模型 / 思考档位是会话树上的 change entry，
   * 由 `subSessionRunner.seedRunConfig` 在建完之后种（见那里的说明）。
   *
   * `options.ephemeral` 为真时建**内存会话**：行只在内存里（sessionRecords）、对话树也只在内存里
   * （sessionStorage），不进侧栏、不进日历、不记活跃、不记 LLM 请求日志，进程一退就没了 —— 寿命归
   * 开它的宿主管，用完由宿主 `delete`。它是主进程内部的选项，刻意不在 SessionCreateParams 里：
   * 渲染层经 IPC 建不出内存会话。内存会话的子会话**同为内存会话**（按父会话推定，不看 options）：
   * 父会话一删，子会话随级联删除一起消失，不会在库里留下一条挂在不存在的父会话下的子会话。
   * 同一个理由，父会话是一条已被删掉的内存会话时拒绝创建，而不是建出一条孤儿。
   *
   * `options.workingDirectory`（绝对路径）给**不属于任何项目**的会话指定工作目录，代替临时工作区；
   * 有项目时忽略。子会话不看 options，随父会话（父会话有就同一个目录）。同样只有主进程能给。
   *
   * `options.coEdit` 标记**协作编辑会话**（须同时给 notebookPath）：根档案由形态推出基座 `coedit`，
   * 文档经 doc_* 工具在编辑窗口的活缓冲上修改。只给根会话；子会话、Chrome 标签页会话忽略。
   *
   * `options.id` 由调用方定 id（P2-10 PIN-05，子会话 create 动作的重跑幂等）：同一父会话下已有这一行 →
   * 原样交回、什么都不写；这个 id 落在别的父会话（或根上）→ 抛错。同样只有主进程能给。
   */
  create(
    params?: SessionCreateParams,
    options?: { ephemeral?: boolean; workingDirectory?: string; coEdit?: boolean; id?: string }
  ): Session {
    // 调用方给定 id（子会话的 create 动作把它记在工具的 memo 里，崩溃后重跑拿到同一个，P2-10 PIN-05）：
    // 幂等 —— 同一父会话下已有这一行就原样交回（不再插入、不再广播、勾选不再抄一遍）；落在别处就拒绝
    if (options?.id !== undefined) {
      const existing = sessionRecords.findById(options.id)
      if (existing) {
        if (existing.parentId !== (params?.parentId ?? null)) {
          throw new Error(`Session ${options.id} already exists under a different parent`)
        }
        return existing
      }
    }
    const id = options?.id ?? uuidv7()
    // Chrome 标签页会话：无项目、无父会话、不是笔记本也不是 bot、不继承任何扩展能力勾选 ——
    // 它的工具全由基座档案 `tab` 声明（含 mcp:chrome），形态推导见 resolveAgentProfileName
    const chromeTab = chromeTabOf(params)
    const notebookPath = chromeTab ? undefined : params?.notebookPath
    const now = Date.now()
    const parentId = chromeTab ? null : (params?.parentId ?? null)
    const parent = parentId ? sessionRecords.pick(parentId, ['projectId', 'settings']) : undefined
    // 父会话行不在了，一般照旧建（一个坏指针不值得拒绝建会话）—— 唯独它曾是内存会话：那是宿主刚把它
    // 删掉，此刻建出来的子会话要么落库成侧栏里的孤儿，要么成为谁也不会去删的内存会话，两样都不对
    if (parentId && !parent && sessionRecords.wasEphemeral(parentId)) {
      throw new Error(`Parent session ${parentId} has been deleted`)
    }
    const ephemeral = parentId ? sessionRecords.isEphemeral(parentId) : !!options?.ephemeral
    const pid = chromeTab ? null : parent ? parent.projectId : (params?.projectId ?? null)
    const workingDirectory = parentId
      ? parent?.settings?.workingDirectory
      : chromeTab
        ? undefined
        : options?.workingDirectory
    // 子会话抄父会话的勾选，其余按项目继承（与旧会话补键同一条规则，见 inheritedSelection）
    const enabledTools = chromeTab ? [] : this.inheritedSelection(parentId, pid)

    // bot 会话：绑定一个 bot，**有根**（根档案 bot，形态推导见 resolveAgentProfileName）。空串 / 空白视同没给
    const bot = chromeTab ? undefined : params?.bot?.trim() || undefined
    const memorySlug = chromeTab ? undefined : params?.memorySlug
    const session: Session = {
      id,
      title: params?.title ?? (notebookPath ? basename(notebookPath) : t('agent.defaultTitle')),
      projectId: pid,
      parentId,
      // 新会话一律用当前版本的存储；建成后不再改（存储换代不迁移旧会话，见 sessionStorageKind.ts）
      storageKind: CURRENT_SESSION_STORAGE_KIND,
      // 指令文件不预写配置：留空即「未显式配置」，注入时按 AGENTS.md → CLAUDE.md 优先级自动选
      settings: {
        ...(notebookPath ? { notebookPath } : {}),
        // 协作编辑只对根上的笔记本会话有意义：它说的是「这份 md 开在一个协作窗口里」
        ...(notebookPath && !parentId && options?.coEdit ? { coEdit: true } : {}),
        // 自带工作目录只给无项目会话：有项目时工作目录恒为项目根。子会话随父会话（与 projectId
        // 同一条理由 —— 工作目录是会话的地基），调用方给的不算
        ...(!pid && workingDirectory ? { workingDirectory } : {}),
        ...(memorySlug ? { memorySlug } : {}),
        // 只在有值时写键：缺省即无键
        ...(bot ? { bot } : {}),
        // 子会话刻意**不**继承父会话的路径授权（allowList）：那是一条会长大的记账，快照过去只会漂移。
        ...(chromeTab ? { chromeTab } : {}),
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
    sessionRecords.insert(session, { ephemeral })
    // 内存会话不在任何列表里，没有列表变化可广播
    if (!ephemeral) broadcastSessionListChanged()
    // 注：指令文件不在创建时注入。改为在用户首次发送 prompt 时按当前配置懒注入
    // （由 AgentSession.prompt 判定 agent 上下文是否为空），使得用户可以在
    // 创建会话后、发送第一条消息前任意切换配置。
    return session
  }

  /** bot 会话判定 —— 绑定了一个 bot。口径在 chat-protocol 的 botSession（两个宿主与三层 UI 共用一份） */
  isBotSession(sessionId: string): boolean {
    return isBotSessionSettings(sessionRecords.pickSettings(sessionId, ['bot']))
  }

  /**
   * 解析会话根 Agent 的档案名 —— **由会话形态推导**，不是用户选的：
   *
   *  - 笔记本会话（settings.notebookPath 非空）恒为 `notebook`
   *    （用户覆盖 `~/.shuvix/agents/notebook.md` 经 getProfile 按名合并自动生效）；
   *  - bot 会话（settings.bot 非空）恒为 `bot`：人设与记忆是根 agent 系统提示词里活的 `bot_profile`
   *    段落（`shuvix.prompt.bot`，每次请求经 agentHost 的 resolveBotContext 现解析）；
   *  - Chrome 标签页会话（settings.chromeTab）恒为 `tab`；
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
    const session = sessionRecords.pick(sessionId, ['projectId', 'parentId', 'settings'])
    const settings = session?.settings
    // Chrome 标签页会话：根 Agent 恒为基座 `tab`（只有它声明 mcp:chrome —— 用户真实的 Chrome）。
    // 排在最前：create 不会让它同时是笔记本 / bot，万一行里真有那些键，也不能让它落到一个
    // 没有 mcp:chrome 的基座上
    if (isChromeTabSessionSettings(settings)) return TAB_PROFILE_NAME
    // 协作编辑窗口里的笔记本：基座 `coedit`（只经 doc_* 改那份活文档，不握 write / edit）
    if (settings?.notebookPath && settings.coEdit) return COEDIT_PROFILE_NAME
    if (settings?.notebookPath) return NOTEBOOK_PROFILE_NAME
    // bot 会话：根 Agent 恒为基座 `bot`，人设与记忆是活的 `bot_profile` 段落（agentHost 的 resolveBotContext）。
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
   * 钉下的同时把档案声明的模型作为**种子**写进会话树（与用户手动改模型同一个落点）：档案只在
   * 这一刻参与一次，之后用户改什么就是什么 —— 若让 createAgent 每次重建都按档案覆盖，用户手选的
   * 会被默默还原。解析成功才写；不可用则保持当前模型，把原始值经 `modelUnavailable` 回传（后端
   * 日志之外调用方也该看得见）。档案声明的思考档位（`shuvix-thinking`）同样作为种子写进树，
   * 经 `applied.thinkingLevel` 回传 —— 之后 seedRunConfig 只补档案没声明的那几项。
   *
   * 工具（`shuvix-tools` 里的 mcp:/skill:）**不写进勾选**：档案声明的每一项经 createAgent 的名单
   * 归一对这条会话恒生效（选择器里画成已勾、锁住），会话勾选只在其上叠加。于是 create 时从父会话
   * 抄来的勾选原样留着 —— 从前「声明了就替换勾选」是让声明生效的唯一办法，如今它只剩一个作用：
   * 把父会话的 MCP 与 skill 摘掉。内置 coding 声明了 `skill:builtin:drawing` 之后，那等于每条
   * coding 子会话都丢掉继承。
   * `applied.tools` 回传档案声明的那截（恒生效的部分，可能为空），不代表写了什么。
   */
  async pinAgentProfile(
    sessionId: string,
    name: string
  ): Promise<{
    success: boolean
    error?: string
    applied?: {
      model?: SubAgentModelConfig
      thinkingLevel?: SelectableThinkingLevel
      tools: string[]
    }
    modelUnavailable?: string
  }> {
    // 只有子会话可钉。守在方法体第一句：拒绝必须先于 getProfile / 落库 / 种子写入 /
    // invalidateAgent，零副作用
    const row = sessionRecords.pick(sessionId, ['parentId'])
    if (!row?.parentId) {
      return { success: false, error: 'Only a sub-session can be pinned to an agent profile' }
    }
    const profile = agentService.getProfile(name)
    // 只由宿主派发的档案（自动审查的 permission-reviewer）与派发工具同一口径：当作不存在，
    // 不给模型一个「换条路再试」的理由
    if (!profile || HOST_ONLY_PROFILE_NAMES.has(profile.name)) {
      return { success: false, error: `Unknown agent "${name}"` }
    }
    if (!agentService.isSessionProfile(profile)) {
      return {
        success: false,
        error: `"${name}" is a base profile; omit agent_profile to run the sub-session on this session's own base`
      }
    }
    log.info(`pinAgentProfile session=${sessionId} → ${name}`)
    sessionRecords.updateSettings(sessionId, { agentProfile: name })
    // 刚建好的子会话还没有运行时；仍走一遍失效是为守住不变量 —— 钉档案与重建之间不能有
    // 一个还在写树的旧运行时（await：解绑必须发生在关停之后，之后往树上追加种子才不会和它抢叶子）
    await this.invalidateAgent(sessionId)

    // 种子：运行时已在上一行失效，故直接写（没有活跃 Agent 需要同步）
    let model: SubAgentModelConfig | undefined
    let modelUnavailable: string | undefined
    if (profile.model) {
      const resolved = resolveProfileModelSpec(profile.model)
      if (resolved) {
        await recordSessionModel(sessionId, resolved.provider, resolved.model)
        model = resolved
        log.info(`pinAgentProfile 应用档案模型 ${resolved.provider}/${resolved.model}`)
      } else {
        modelUnavailable = profile.model
        log.warn(`档案 "${name}" 声明的模型 "${profile.model}" 当前不可用，保持会话现有模型`)
      }
    }
    // 思考档位同理作为种子写进树（之后用户可在子会话里改）；档位是枚举值，没有「不可用」一说
    const thinkingLevel = profile.thinkingLevel
    if (thinkingLevel) {
      await recordSessionThinkingLevel(sessionId, thinkingLevel)
      log.info(`pinAgentProfile 应用档案思考档位 ${thinkingLevel}`)
    }

    // 档案声明的 mcp:/skill: 由名单归一恒生效，不写进勾选：继承来的那份原样留着
    const tools = sessionScopedTools(profile.tools)

    broadcastSessionConfigChanged(sessionId)
    return { success: true, applied: { model, thinkingLevel, tools }, modelUnavailable }
  }

  /**
   * 更新会话标题。`origin` 记进 settings.titleOrigin：'user' = 用户改名（UI 重命名），
   * 'auto' = 自动化写入（session 工具）。这是 `session.turn-completed` 埋点里
   * `titleAutoGenerated` 的数据来源 —— 自动化据此避免覆盖用户手动改过的标题。
   * 自动写入才广播 titleChanged（用户改名时渲染端自行更新，维持旧行为）。
   */
  updateTitle(id: string, title: string, origin: 'user' | 'auto' = 'user'): void {
    sessionRecords.updateTitle(id, title)
    sessionRecords.updateSettings(id, { titleOrigin: origin })
    if (origin === 'auto') broadcastSessionTitleChanged(id, title)
  }

  /** 更新会话所属项目 */
  updateProjectId(id: string, projectId: string | null): void {
    sessionRecords.updateProjectId(id, projectId)
    if (!sessionRecords.isEphemeral(id)) broadcastSessionListChanged()
  }

  /**
   * 改扩展能力勾选（`settings.enabledTools`，整份替换）—— 输入框的工具选择器与会话设置里的
   * 扩展能力共用的唯一写入口。
   *
   * **只在这条会话没有 agent 的时候接受**：勾选只在创建 agent 那一刻读一次，锁住期间（含销毁在途）
   * 改了不会作用到那个 agent，所以一律拒绝、什么也不写，让前端回拉真实状态（判据 hasAgentRuntime：
   * 打开着的会话看运行时的锁，没开着看 DB 里的锁镜像）。创建在途的那一小段窗口里的写入照样接受
   * （PIN-12）—— 它不影响正在创建的 agent，下一次创建生效。
   */
  updateEnabledTools(id: string, enabledTools: readonly string[]): boolean {
    if (!sessionRecords.pick(id, ['id'])) return false
    if (this.hasAgentRuntime(id)) {
      log.info(`拒绝修改扩展能力：会话已有运行时 session=${id}`)
      return false
    }
    sessionRecords.updateSettings(id, { enabledTools: sessionScopedTools(enabledTools) })
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
    if (!sessionRecords.pick(id, ['id'])) return false
    const names = [...new Set(knowledgeBases.map((n) => n.trim()).filter(Boolean))]
    sessionRecords.updateSettings(id, { knowledgeBases: names })
    broadcastSessionConfigChanged(id)
    return true
  }

  /** 批量添加路径到统一允许列表（按 toolType 自动加 `Read(...)`/`Write(...)` 前缀）
   *
   *  仅路径类:命令类工具(bash/ssh)不再有允许列表,逐条询问。
   */
  addAllowListPaths(id: string, toolType: AllowToolType, paths: string[]): void {
    const sess = sessionRecords.pickSettings(id, ['allowList'])
    const list = sess?.allowList || []
    const prefixed = paths.map((p) => buildAllowEntry(toolType, p))
    const newEntries = prefixed.filter((p) => !list.includes(p))
    if (newEntries.length > 0) {
      sessionRecords.updateSettings(id, { allowList: [...list, ...newEntries] })
      log.info(`addAllowListPaths session=${id} ${toolType} +${newEntries.length}`)
      broadcastSessionConfigChanged(id)
    }
  }

  /** 从统一允许列表移除条目 */
  removeAllowListEntry(id: string, entry: string): void {
    const sess = sessionRecords.pickSettings(id, ['allowList'])
    const list = (sess?.allowList || []).filter((e) => e !== entry)
    sessionRecords.updateSettings(id, { allowList: list })
    broadcastSessionConfigChanged(id)
  }

  /** 删除会话（同时清理 AgentSession、后台任务、消息、HTTP 日志和临时工作目录） */
  async delete(id: string): Promise<void> {
    // 子会话先走一遍同样的清理（嵌套只有一层，所以不会递归下去第二层）。
    // 放在最前面：父会话的资源清理不该被子会话的运行时拖着。删除确认框已经告诉用户
    // 会一起删掉几条（见 useSessionDelete）——这是「递归删」唯一的补偿。
    for (const child of sessionRecords.findChildren(id)) {
      await this.delete(child.id)
    }
    // 后台任务是会话资源：必须在下面 rm tool_results 之前杀掉，否则进程还活着写一个已删目录。
    // 放在关停运行时**之前**：run 可能正等着某个后台任务，先杀掉才不会把关停一直吊着
    killBySession(id)
    // 父会话驱动着、此刻正在跑的那一轮：先照常中止（落定为用户停掉的 aborted），再删 —— 关停中的会话不报
    // driven 落定，直接删的话父会话永远等不到这一轮的结果（P2-12 PIN-06：删除 = 中止，通知照常走一条）。
    // 前台驱动的那次调用自己会收到落定，通知照旧被抑制
    const driven = this.getAgentSession(id)
    if (driven?.drivenRun && driven.isStreaming) {
      try {
        await driven.abort()
      } catch (err) {
        log.warn(`删除前中止被驱动的那一轮失败 session=${id}: ${err}`)
      }
    }
    // 再关停运行时并删掉会话存储（SessionHost 关它 —— 忙就中止、等它彻底停下 —— 再删文件；会话没开过
    // 也照样删文件），连同桌面侧的会话状态（hook 派发的 run、fileTime、决策日志、审查计数、沙箱钉子）。
    // 等它彻底停下才继续删数据 —— 否则一个还在跑的 run 会往刚被删掉的结果目录里继续写
    await destroySessionRuntime(id)
    // 视图同步：会话本身没了（不是清空）—— 撤下它的视图（前端收到 unavailable），之后再订阅它 →
    // service_not_found（P3-05 PIN-07：存储已删、行还在；hub 没建过就没有订阅，不建）
    peekSyncHub()?.deleteSession(id)
    // 内置能力服务器（inproc MCP）的寿命绑**会话**，不绑 agent —— 销毁 agent（芯片上的 X）时故意留着，
    // ssh 的 control socket / browser 的 tab 不该被一次重建白白掐断。所以释放写在这里。
    // 放在关停运行时之后：还在跑的 run 可能正调着它的工具。
    await mcpService.closeSession(id)
    // 再清理持久化数据（会话存储已随上面的关停删掉）
    httpLogDao.deleteBySessionId(id)
    // 未开 PRAGMA foreign_keys，session_day_prompts 的 ON DELETE CASCADE 不会触发
    sessionDayPromptDao.deleteBySessionId(id)
    const ephemeral = sessionRecords.isEphemeral(id)
    sessionRecords.deleteById(id)
    if (!ephemeral) broadcastSessionListChanged()
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
    // 沙箱的每会话临时目录（/private/tmp/shuvix-<uid>/<8hex>）
    cleanupSandboxSession(id)
  }

  // ─── 会话运行时（SessionHost + AgentSession 门面） ──────────────────

  /** 此刻打开着的会话的门面（不打开、不创建） */
  getAgentSession(sessionId: string): AgentSession | undefined {
    const session = this.host.get(sessionId)
    return session ? AgentSession.of(session) : undefined
  }

  /**
   * 打开着的会话的门面；没开就 peek（存储在才打开，从不创建）。给「会话没开着也要作用到它的 agent」
   * 的调用方用（锁着的会话改思考档位）。
   */
  async peekAgentSession(sessionId: string): Promise<AgentSession | undefined> {
    const session = await this.peekDurableSession(sessionId)
    return session ? AgentSession.of(session) : undefined
  }

  /**
   * 这条会话此刻有没有 agent（锁）。打开着的会话以运行时的锁为准；没开着就读 DB 里的锁镜像
   * （`settings.agentLocked`，每次打开都对账）。模型与扩展能力勾选都只在创建 agent 那一刻读一次，
   * 两处写入口（agent.setModel / updateEnabledTools）据这一位拒绝锁住期间的改动。
   * 创建在途的那一小段窗口里改动照样接受（PIN-12）：它们不影响正在创建的那个 agent。
   */
  hasAgentRuntime(sessionId: string): boolean {
    const session = this.host.get(sessionId)
    if (session) return session.lock !== undefined
    return mirroredAgentLocked(sessionId)
  }

  /**
   * 创建 agent 那一刻读的会话配置（SessionHost 的 resolveAgentConfig seam）：形态推导的基座档案
   * （resolveAgentProfileName）、扩展能力勾选（滤掉此刻不可用的；旧会话补键）、模型选择（没选过 →
   * 默认 provider / 模型，与界面同一口径；都没有 → 不给，运行时拒绝创建）、思考档位（没设过 / 写坏 →
   * 缺省，PIN-03）、工作目录。会话不存在 → 抛错。
   */
  async resolveAgentConfig(sessionId: string): Promise<AgentConfig> {
    const ctx = await this.resolveSessionAgentContext(sessionId)
    if (!ctx) throw new Error(`Session ${sessionId} does not exist`)
    const profileName = this.resolveAgentProfileName(sessionId)
    const profile = toInProcessAgentType(
      agentService.getProfile(profileName) ?? agentService.getProfile(WORK_PROFILE_NAME)!
    )
    return {
      profile,
      toolOverlay: ctx.enabledTools,
      ...(ctx.provider && ctx.model
        ? { model: { provider: ctx.provider, modelId: ctx.model } }
        : {}),
      thinkingLevel: sessionThinkingLevel(
        ctx.modelMetadata.thinkingLevel,
        ctx.capabilities.reasoning
      ),
      cwd: ctx.workingDirectory
    }
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
    const session = sessionRecords.pick(sessionId, ['projectId', 'settings'])
    if (!session) return null
    // 扩展能力勾选在会话设置里（创建会话时定下，创建 Agent 时读这一次）
    const selectedTools = this.sessionEnabledTools(sessionId)

    // 模型类运行配置的唯一事实源是会话设置：settings.model / settings.thinkingLevel
    const tree = await readSessionRunConfig(sessionId)
    const provider = tree.provider ?? this.getDefaultProvider()
    const model = tree.model ?? this.getDefaultModel()
    const modelRow = providerDao.findModelsByProvider(provider).find((m) => m.modelId === model)
    const capabilities: ModelCapabilities = modelRow?.capabilities
      ? JSON.parse(modelRow.capabilities)
      : {}
    const thinkingLevel = sessionThinkingLevel(tree.thinkingLevel, capabilities.reasoning)
    const project = session.projectId
      ? projectDao.pick(session.projectId, ['path', 'settings'])
      : undefined
    const workingDirectory = workingDirectoryOf(sessionId, project?.path, session.settings)
    // 滤掉已不可用的 MCP（配置里已停用 / 已删）与 skill（已删 / 已停用）；设置里的原值不动。
    // 可用性**不看连接状态** —— MCP 惰性启动，没连上的那台正要在下一步（装配工具）被连起来。
    // `mcp:chrome`（用户真实的 Chrome）不接受会话勾选：只由 Chrome 标签页会话的基座档案声明
    const enabledTools = filterAvailableTools(
      selectedTools.filter((name) => name !== CHROME_TOOL_NAME),
      project?.path
    )
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
      // created = 此刻有 agent（锁；init 本身不打开会话、不创建）—— 与扩展能力写入口
      // updateEnabledTools 的拒绝条件（hasAgentRuntime）同一口径，前端的只读态据此打底：
      // 窗口刷新时相关事件早已错过，只能靠这一位
      created: this.hasAgentRuntime(sessionId),
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
   * 打开（必要时创建存储）指定会话并返回门面。**只打开，不创建 agent** —— agent 在第一次发送时由
   * 运行时创建（K3）。会话不存在、旧格式（只读）、宿主已封存（退出中）→ undefined，什么都不建。
   * 关停中的同一会话会先等它关完（一条会话同一时刻只有一个 Harness）。
   */
  async ensureAgentSession(sessionId: string): Promise<AgentSession | undefined> {
    if (!isDurableSession(sessionId) || this.host.sealed) return undefined
    try {
      return AgentSession.of(await this.host.open(sessionId))
    } catch (err) {
      log.warn(`打开会话失败 session=${sessionId}: ${err instanceof Error ? err.message : err}`)
      return undefined
    }
  }

  /**
   * 会话**此刻实际在用**的模型类运行配置 —— 与运行时创建同一口径
   * （resolveSessionAgentContext：树上没有 → 回落默认），会话不存在返回 null。
   *
   * 给的是**解析后**的值而不是「树上显式写过的那些」：子会话种子（subSessionRunner.create）
   * 要复制的是父会话跑起来是什么样，而父会话大多数键根本没显式改过 —— 只抄显式值，
   * 一条从没切过模型的父会话就会把「继承」变成「什么也没继承」。
   * 扩展能力勾选不在这里：它是 settings 的键，子会话在 create 里直接抄父会话的。
   *
   * 也是 hook run 没锁时的模型选择（hookService 的 `hookRunModel`）：档位要带上 —— hook 派出的 agent 与任何
   * 派发一样继承会话的档位，想不思考就在它的 agent md 里声明 `shuvix-thinking`。
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
   * 销毁这条会话的 agent（agent 芯片上的 X、钉档案、清空之前；下一次发送按那时的配置重建）。
   * 会话没开着也作用到它（peek：存储在才打开，从不创建；旧格式不碰）。**返回的 Promise 落定时 agent
   * 已经停下并解锁**（忙 / 被中断的先中止）—— 调用方 await 之后再动会话。桌面侧随 agent 的状态
   * （fileTime、沙箱钉子）不论有没有 agent 都清。
   */
  async invalidateAgent(sessionId: string): Promise<void> {
    const session = await this.peekDurableSession(sessionId).catch((err: unknown) => {
      log.warn(`打开会话失败 session=${sessionId}: ${err}`)
      return undefined
    })
    if (session) await AgentSession.of(session).invalidate()
    else clearAgentScopedState(sessionId)
  }

  /**
   * 运行时**自己**销毁了 agent 之后（回退 fork：`rollbackTo` 校验过目标才停下、解锁，P3-10b PIN-03），
   * 补上桌面侧随 agent 的那一份清理（fileTime 的「已读」记录）—— 运行时的销毁不管它。不碰会话、不碰锁。
   */
  clearAgentScopedState(sessionId: string): void {
    clearAgentScopedState(sessionId)
  }

  // ─── 用户输入 ──────────────────────────────────

  /**
   * 此刻打开着的会话的门面 —— 供 broker 的参与方按 requestId 找归属（询问挂在打开着的会话上）。
   *
   * 响应入口本身在 `userInputBroker`：那里同时握着请求与答复两个方向。
   */
  liveAgentSessions(): AgentSession[] {
    const sessions: AgentSession[] = []
    for (const sessionId of this.host.openSessionIds()) {
      const session = this.getAgentSession(sessionId)
      if (session) sessions.push(session)
    }
    return sessions
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
 * `claims` 问的是「此刻这条会话开着没有」而不是「这条会话记录存不存在」—— 询问要送到的是
 * 打开着的那个 DurableSession 的挂起询问，会话没开就没有可送达的地方。
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
  respond: (requestId, response, meta) => {
    // 遍历而不是按 sessionId 索引：requestId 才是全局唯一的那个 —— 拿调用方以为的
    // sessionId 去选会话，等于把前端的判断当成真相
    for (const session of sessionService.liveAgentSessions()) {
      const claimed =
        meta === undefined
          ? session.respondToInput(requestId, response)
          : session.respondToInput(requestId, response, meta)
      if (claimed) {
        // 审计（PIN-20）：谁答了哪条、答的是哪一类 —— 从不记应答内容（文本 / 凭证）
        log.info(
          `ask answered session=${session.sessionId} requestId=${requestId} by=${meta?.clientId ?? 'unknown'} kind=${response.kind}`
        )
        return true
      }
    }
    return false
  }
})
