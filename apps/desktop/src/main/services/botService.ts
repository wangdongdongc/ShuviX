/**
 * BotService —— bot 注册表（桌面宿主层）。设计见 docs/bot-design.md §4。
 *
 * 落地分期（docs/bot-implementation-plan.md）：本文件现有两半 ——
 *  - **注册表半边（M1′）**：扫描 / md 原文读写 / 非法文件修复通道 / 新建模板；
 *  - **消息半边（M3′）**：无根会话的用户消息落盘、bot 消息的双 append、greeting 播种、
 *    在飞计数（树钉住用）与 abortSession 会师点；
 *  - **管线半边（M4′）**：L0 门 → cohort → 每成员一次 invoke，以及装配进脚本的
 *    `claim` / `turn` / `say` 三个回调。仲裁与 mailbox 的算法在 `bot/` 下各自成件。
 *
 * 笔记写盘（M9′）、真意图段与窗口构建（M5′）、任务段与 BotReply 投影（M8′）尚未接上 ——
 * 内置管线此刻跑的是骨架脚本（确定性占位判定），链路是真的，判断还不是。
 *
 * **不内置任何 bot**（设计 §4.2）：内置的只有管线 workflow（`bot-chat`）与阶段 agent
 * （`bot-intent` / `bot-notes`）。因此这里没有 agent/workflow/policy 三件套那种
 * 「内置 + 用户同名覆盖」的两源合并 —— 目录里有什么就是什么，少一整个概念。
 * 「新建 bot」由 `newBotTemplate()` 用内置件填一份模板，用户取个名字即可（§4.6）。
 *
 * 写盘一律**原子写**（`writeFileAtomic`）：笔记写入之后这些文件会被后台高频改写，而
 * `scanDir` 随时可能读进来 —— `writeFileSync` 的「先截断再写」会让 bot 在注册表里瞬时
 * 消失并落进 invalid 双轨。
 */
import { existsSync, readdirSync, readFileSync, mkdirSync, renameSync, unlinkSync } from 'fs'
import { createHash } from 'crypto'
import { basename, join } from 'path'
import { v4 as uuidv4 } from 'uuid'
import { shell } from 'electron'
import type { AgentMessage, SessionTreeEntry } from '@earendil-works/pi-agent-core'
import {
  BOT_SENDER_CUSTOM_TYPE,
  DEFAULT_BOT_PIPELINE,
  INLINE_TOKENS_CUSTOM_TYPE,
  entriesToChatMessages,
  parseBotDefinitionFile,
  serializeBotDefinitionFile,
  type BotSenderSidecar,
  type ParsedBotFile
} from '@shuvix/agent-runtime'
import type { AgentPromptParams } from '@shuvix/chat-protocol/chatApi'
import type { InputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import type {
  ChatMessage,
  InlineToken,
  SuppressedCandidate
} from '@shuvix/chat-protocol/types/chatMessage'
import { resolveTokensForAgent } from '@shuvix/chat-protocol/utils/inlineTokens'
import { botReplyToMarkdown, coerceBotReply } from '@shuvix/chat-protocol/botReply'
import { getDefaultBotsDir } from '../utils/paths'
import { writeFileAtomic } from '../utils/atomicWrite'
import { createLogger } from '../logger'
import { t } from '../i18n'
import {
  addSessionTreePin,
  drainSessionTreeLock,
  getSessionTree,
  readSessionRunConfig,
  withSessionTreeLock
} from './sessionStorage'
import { workflowService, workflowTriggers } from './workflowService'
import { buildTurnCompletedFacts, isDefaultTitle } from './sessionTriggerFacts'
import { appendBotDecision, botRunsDir, pruneBotRuns, type BotDecisionKind } from './bot/botJournal'
import { runL0Gate, type L0Record, type LastBotSender } from './bot/botGate'
import { CohortBarrier, type ClaimIntent, type ClaimVerdict } from './bot/botArbiter'
import { BotMailbox, mailboxKey, type QueueItem, type TurnSlot } from './bot/botMailbox'
import { BotNotesScheduler } from './bot/botNotesScheduler'
import { electronEventSink } from './agentRuntimeAdapters'
import { registerUserInputParticipant } from './userInputBroker'
import { chatFrontendRegistry } from '../frontend/core/ChatFrontendRegistry'
import { messageService } from './messageService'
import { sessionService } from './sessionService'

const log = createLogger('Bot')

/**
 * 设置页列表项 —— 刻意**不外传** systemPrompt / 笔记区 / suggestions：列表只需要
 * 「是谁、干什么、怎么应答、用哪条管线」，编辑走 getSource 拿整份 md 原文
 * （与 agent/workflow/policy 设置页同形：详情即原文编辑器）。
 */
export interface BotListItem {
  name: string
  displayName: string
  description: string
  /** 管线框架（workflow 名） */
  pipeline: string
  /** 门控模式 auto | mention-only */
  respond: string
  /** 笔记开关 */
  notesEnabled: boolean
  /** 笔记字符数（0 = 尚无笔记） */
  notesChars: number
  /** 任务段工具白名单 */
  tools: string[]
  /** 任务段模型（`shuvix-model`）；省略 = 跟随会话 */
  model?: string
  /** 文件路径 */
  basePath: string
  /** 笔记区的结构异常（软失败，不影响可用性；设置页显示为提示） */
  warnings: string[]
}

/**
 * 无法解析的 bot 文件。身份是文件名 —— 它解析不出 name，读写走 *ByFile 一组接口
 * （同 workflowService.InvalidWorkflowFile / policyService.InvalidPolicyFile）。
 */
export interface InvalidBotFile {
  fileName: string
  /** 人读原因：解析器的拒绝理由 */
  error: string
}

/** 连续多少次门控故障就回落内置（设计 §6.1） */
const GATE_FAILURE_STREAK = 2

/** 角色回落表 —— bot md 的 `shuvix-bot-agents` 逐键覆盖它 */
const DEFAULT_STAGE_AGENTS = {
  intent: 'bot-intent',
  recheck: 'bot-intent',
  notes: 'bot-notes'
} as const

/**
 * 任务段指向 bot 自己。**必须是全局可寻址的 `bot:<name>` 而不是 `bot:self`** ——
 * 引擎的 `resolveAgentProfile(ref)` 是一个无 run 上下文的全局 dep，相对 ref 在那里
 * 永远解析不出来。解析（`bot:<name>` → InProcessAgentType）归 M8′，此刻只定名。
 */
export function botSelfRef(botName: string): string {
  return `bot:${botName}`
}

export interface ResolvedPipeline {
  workflow: string
  /** 注册表里有没有这份管线 —— 派发之前就能判，不必靠事后的 not-found */
  exists: boolean
  agents: Record<string, string>
}

export function resolvePipeline(
  bot: ParsedBotFile,
  overrides?: Record<string, string>
): ResolvedPipeline {
  const workflow = bot.pipeline || DEFAULT_BOT_PIPELINE
  return {
    workflow,
    exists: workflowService.hasWorkflow(workflow),
    agents: {
      ...DEFAULT_STAGE_AGENTS,
      task: botSelfRef(bot.name),
      ...bot.agents,
      // 回落覆盖用户的 shuvix-bot-agents —— 它正是「那份不可靠的门控 agent」的来源
      ...overrides
    }
  }
}

/**
 * 一次「某个 bot 应答某条消息」的全部身份与状态。
 *
 * **它先于 invoke 存在，所以 `claim`/`turn`/`say` 的闭包固化的是它，不是 runId** ——
 * runId 由引擎在内部生成，闭包拿不到，也不需要：三个回调要回答的是「我是谁、我在哪个
 * 会话、我在应答哪条消息」，这些在派发之前就全有了。runId 只是事后回填的一个别名，
 * 用来把决策记录与 run journal 交叉引用起来。
 */
interface BotTicket {
  ticketId: string
  sessionId: string
  botName: string
  displayName: string
  messageSeq: number
  messageId: string
  barrier: CohortBarrier
  claimState: 'none' | 'won' | 'lost'
  /**
   * 仲裁给出的具体理由。`claimState` 把 ignored / lost / timeout 压成一个 'lost' ——
   * 强制点只关心「能不能说」，而全体沉默的定性要分清「全员判定不接」（正常）与
   * 「全都没跑到判定」（坏了），两者对用户的意味完全相反
   */
  claimReason?: ClaimVerdict['reason']
  /** run 已收尾（超时 / 被中止 / settle）—— `say` 的硬闸，见下 */
  terminal: boolean
  /** 本 ticket 已经往会话里说过话 —— 可见结局兜底据此决定要不要再补一条失败气泡 */
  said: boolean
  /**
   * `say` 被仲裁挡下过。挡下之后脚本通常就抛到顶、run 记一个笼统的 `failed` ——
   * 而「你的管线忘了调 claim」与「网络抖了一下」在提示里长得一模一样，写管线的人
   * 第一次踩这个坑时线索太薄。带上它，沉默提示就能直接说出是哪一种
   */
  blockedBy?: 'arbitration_lost' | 'arbitration_bypassed'
  abort: AbortController
  /** meta 到达时回填 */
  runId?: string
}

/**
 * `claim(intent)` 的入参校验。值跨 vm realm 到达，`instanceof` 不可靠 —— 逐字段 typeof。
 * 形状不合法即抛：这是脚本 bug，不是沉默的理由。
 */
export function asClaimIntent(raw: unknown): ClaimIntent {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('claim(intent): intent must be an object')
  }
  const d = raw as Record<string, unknown>
  const decision = d.decision
  if (
    decision !== 'reply' &&
    decision !== 'task' &&
    decision !== 'clarify' &&
    decision !== 'ignore'
  ) {
    throw new Error(`claim(intent): unknown decision "${String(decision)}"`)
  }
  const relevance = typeof d.relevance === 'number' ? d.relevance : NaN
  if (!Number.isInteger(relevance) || relevance < 0 || relevance > 9) {
    throw new Error('claim(intent): relevance must be an integer in 0..9')
  }
  return {
    decision,
    relevance,
    reason: typeof d.reason === 'string' ? d.reason : undefined
  }
}

/**
 * `say(reply)` 的正文投影 —— 落树的 content 就是它的返回值。
 *
 * 对象形态走 `BotReply` 的**全键** markdown 投影：content 是模型可见的唯一权威
 * （重开、压缩、标题、复制、TTS 读的都是它），漏投一个字段就等于那条信息对模型不存在，
 * 而 UI 上它明明还在。裸字符串照旧原样通过 —— 门控段的轻回应本来就是一句话。
 */
export function asSayContent(raw: unknown): string {
  // 空串一路走到 appendBotMessage 只会 return null + 一条 warn：脚本拿到 messageId:null、
  // journal 里没有失败记录、会话里什么都没有 —— 正是「可见结局」不变式要杜绝的形态
  if (typeof raw === 'string') {
    if (!raw.trim()) throw new Error('say(reply): reply must be a non-empty string')
    return raw
  }
  // 补救版而不是严格版：缺一句结论就把整条回答作废,用户拿到的是一句内部错误串 ——
  // 而那串还会成为模型可见的历史。见 coerceBotReply
  const reply = coerceBotReply(raw)
  if (reply) {
    const md = botReplyToMarkdown(reply)
    if (md.trim()) return md
  }
  throw new Error('say(reply): reply must be a non-empty string or carry a headline')
}

/** 一个 cohort 成员这一轮的结局 —— 全体沉默的判据由它们汇总而来 */
interface MemberOutcome {
  botName: string
  displayName: string
  /** 这个成员往会话里放了东西没有（一条回复、或一条可见失败） */
  said: boolean
  /**
   * 这个成员这一轮的结局。取值域是三者的并：仲裁理由（`claim_*`，与决策记录的 kind 同源）、
   * 脚本自报的 outcome（`gate-broken` / `task-pending` …）、run 本身怎么收的（`ok` /
   * `failed` / 引擎的 reason）。**刻意不归一成一张封闭表** —— 自定义管线的 outcome 本就
   * 是开放的，硬归一只会把它们全冲成 `other`
   */
  outcome: string
}

/**
 * 一个成员这一轮的结局用哪句话说清楚。三级优先：
 *
 * 1. **仲裁理由**（宿主亲眼所见）—— 它是全体沉默定性的唯一依据，因为只有它证明这个成员
 *    真的进过仲裁。自定义管线可以一句 `outcome:'ignored'` 随口一说，那不算「判定不接」；
 * 2. 脚本自报的 outcome —— `gate-broken` / `task-pending` 这类，比「run 跑完了」有信息量；
 * 3. run 本身怎么收的。
 */
function memberOutcome(
  ticket: BotTicket,
  scriptOutcome: string | undefined,
  ended: string
): string {
  const r = ticket.claimReason
  if (r && r !== 'won' && r !== 'solo') return `claim_${r}`
  // 没有仲裁理由却被强制点挡下 = 压根没 claim（`arbitration_bypassed`）。这是管线的
  // 写法问题，笼统的 'failed' 会让人往网络/模型上找原因
  if (ticket.blockedBy) return ticket.blockedBy
  return scriptOutcome || ended
}

/**
 * cohort 整体沉默了没有，以及该怎么定性（设计 §9 的可见结局不变式）。
 *
 * 只看「会话里多出东西了吗」：任何一个成员开了口，这一轮就有结局，不必提示。
 * 定性只分两类 —— 自判不接（沉默白名单里唯一的正常项）与其余（有东西坏了）。
 */
export function cohortSilence(
  outcomes: MemberOutcome[]
): { reason: 'all_ignored' | 'all_failed' | 'mixed' } | null {
  if (!outcomes.length || outcomes.some((o) => o.said)) return null
  const ignored = outcomes.filter((o) => o.outcome === 'claim_ignored').length
  if (ignored === outcomes.length) return { reason: 'all_ignored' }
  return { reason: ignored ? 'mixed' : 'all_failed' }
}

/**
 * 附件句柄 —— 交给脚本原样转交给 `run(..., { attach })` 的不透明值。
 *
 * **自包含且不含字节**：引擎那一层没有会话上下文，而脚本的 input 会被原样写进 run
 * journal —— 让 base64 进 input 等于每条带图消息都在磁盘上留下一份逐 bot 的副本。
 * `mimeType` 留着是为了让提示词能说出「用户附了一张 png」，它不参与回读。
 */
export interface BotAttachmentRef {
  sessionId: string
  entryId: string
  index: number
  mimeType: string
}

/**
 * 归纳材料的行数上限。`bot-chat.md` 的 `notesWindow` 是脚本侧的同一把尺，这里是宿主侧的
 * 那一把 —— 两处都要，因为这份 input 既进提示词也进 run journal。
 */
const NOTES_MAX_LINES = 200

/**
 * 这一轮值得记进笔记吗。
 *
 * `task` 前缀不能一刀切：`task-failed` / `task-timeout` / `task-no-agent` 都是**没干成**，
 * 而 `task-no-agent` 更是配置错（脚本自己的注释就写着重试永远不会好）。让它们把计数顶到
 * 门槛，换来的是一次没有材料价值的归纳 —— 代价是一整份笔记进上下文外加一张询问卡。
 */
export function isNoteWorthy(
  output: { outcome?: string; memorable?: boolean } | undefined
): boolean {
  if (output?.memorable === true) return true
  return output?.outcome === 'task' || output?.outcome === 'task-unshaped'
}

/**
 * 一份 md 原文的版本指纹。
 *
 * 用内容哈希而不是 mtime：笔记段的写入与用户的保存可以落在同一秒里，而 mtime 的分辨率
 * 恰好会把这种情况判成「没变」——那正是要拦的那一种。
 */
function revisionOf(raw: string): string {
  return createHash('sha256').update(raw).digest('hex').slice(0, 16)
}

/** 被压制候选的暂存键：一轮仲裁 = 一条用户消息 = (会话, seq) */
function suppressedKey(sessionId: string, messageSeq: number): string {
  return `${sessionId}\u0000${messageSeq}`
}

class BotService {
  private readonly userDir = getDefaultBotsDir()

  // ─── 注册表 ──────────────────────────────────

  /** 目录扫描，分出可解析与不可解析两拨（同 workflowService.scanDir 口径） */
  private scanDir(): {
    valid: Array<{ file: ParsedBotFile; basePath: string; warnings: string[] }>
    invalid: InvalidBotFile[]
  } {
    if (!existsSync(this.userDir)) return { valid: [], invalid: [] }
    let names: string[]
    try {
      names = readdirSync(this.userDir, { withFileTypes: true })
        .filter(
          (e) => e.isFile() && !e.name.startsWith('.') && e.name.toLowerCase().endsWith('.md')
        )
        .map((e) => e.name)
    } catch (e) {
      log.warn(`扫描目录 ${this.userDir} 失败:`, e)
      return { valid: [], invalid: [] }
    }

    const valid: Array<{ file: ParsedBotFile; basePath: string; warnings: string[] }> = []
    const invalid: InvalidBotFile[] = []
    const seen = new Set<string>()
    for (const fileName of names) {
      const filePath = join(this.userDir, fileName)
      let raw: string
      try {
        raw = readFileSync(filePath, 'utf-8')
      } catch (e) {
        log.warn(`加载 bot "${fileName}" 失败:`, e)
        invalid.push({ fileName, error: e instanceof Error ? e.message : String(e) })
        continue
      }
      // warn 通道同时收「拒绝理由」与「接受但有话说」（笔记区异常、task 覆盖提示）；
      // 只有 parsed 为 null 时这些话才是拒绝原因，否则它们是 warnings
      const messages: string[] = []
      const parsed = parseBotDefinitionFile(raw, fileName.slice(0, -3), (msg) => {
        messages.push(msg)
        log.warn(msg)
      })
      if (!parsed) {
        invalid.push({ fileName, error: messages.join('\n') || 'Invalid bot file' })
        continue
      }
      if (seen.has(parsed.name)) {
        log.warn(`bot "${parsed.name}": 同名文件重复（${fileName}），已跳过`)
        continue
      }
      seen.add(parsed.name)
      valid.push({ file: parsed, basePath: filePath, warnings: messages })
    }
    return { valid, invalid }
  }

  /**
   * 全部可用 bot —— 会话创建与管线解析的事实源。
   * 每次现扫，文件改动即时生效（同 agentService.listAll）。
   */
  listAll(): Array<{ file: ParsedBotFile; basePath: string }> {
    return this.scanDir().valid
  }

  /** 按名取一个 bot；未知名返回 null */
  getBot(name: string): ParsedBotFile | null {
    return this.listAll().find((b) => b.file.name === name)?.file ?? null
  }

  /** 按名取原始文件内容与路径（笔记写入的读侧入口；未知名返回 null） */
  readBotFile(name: string): { path: string; raw: string } | null {
    const target = this.listAll().find((b) => b.file.name === name)
    if (!target) return null
    try {
      return { path: target.basePath, raw: readFileSync(target.basePath, 'utf-8') }
    } catch (e) {
      log.warn(`读取 bot "${name}" 原文失败:`, e)
      return null
    }
  }

  // ─── 设置页 API ─────────────────────────────

  listForSettings(): BotListItem[] {
    return this.scanDir()
      .valid.map(({ file, basePath, warnings }) => ({
        name: file.name,
        displayName: file.displayName,
        description: file.description,
        pipeline: file.pipeline,
        respond: file.respond,
        notesEnabled: file.notesEnabled,
        notesChars: file.notes?.length ?? 0,
        tools: file.tools,
        model: file.model,
        basePath,
        warnings
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  /** 目录里无法解析的 bot 文件（设置页显示为可点开修复的告警项） */
  listInvalid(): InvalidBotFile[] {
    return this.scanDir().invalid
  }

  /**
   * 取 md 原文（编辑器数据源），连同一枚**版本指纹**。
   *
   * 指纹是给 `save` 用的:笔记段会在后台改这份文件,而用户可能在那之前就打开了编辑器。
   * 没有它,「T0 打开 → T1 笔记段改 → T2 用户保存」会把 T1 的归纳整份吃掉,而且是静默的
   * (设计 §8.2 把这条记为已知未解,留给 M9′)。`edit` 工具自带的「读后被改」检测保护的是
   * agent 那一侧,反方向从来没有人守。
   */
  getSource(name: string): { text: string; revision: string } | { error: string } {
    const target = this.readBotFile(name)
    if (!target) return { error: `Bot "${name}" not found` }
    return { text: target.raw, revision: revisionOf(target.raw) }
  }

  /**
   * 写盘前解析校验。**非法一律拒绝**：一份存在但非法的 bot 会被扫描跳过，与其让它躺在
   * 磁盘上假装可用，不如把原因交回 UI。笔记区异常不算非法（软失败）。
   */
  private parseForWrite(
    text: string,
    defaultName: string
  ): { file: ParsedBotFile } | { error: string } {
    const messages: string[] = []
    const file = parseBotDefinitionFile(text, defaultName, (msg) => messages.push(msg))
    if (!file) return { error: messages.join('\n') || 'Invalid bot file' }
    return { file }
  }

  /**
   * 覆写 bot 文件（`originalName` 定位文件；frontmatter name 为准，可改名）。
   *
   * `revision` 是 `getSource` 那一刻的指纹。对不上说明这份文件在你编辑期间被改过 ——
   * 几乎总是笔记段干的 —— 此时**拒绝并让 UI 去解决冲突**，而不是让后写的一方赢。
   * 不传 revision 的调用方按旧语义直接覆盖（`saveByFile` 的修复通道就该这样：
   * 那条路走的是解析不出来的坏文件，没有可对照的版本）。
   */
  save(
    originalName: string,
    text: string,
    revision?: string
  ): { success: boolean; error?: string; revision?: string; conflict?: { current: string } } {
    const bots = this.listAll()
    const target = bots.find((b) => b.file.name === originalName)
    if (!target) return { success: false, error: `Bot "${originalName}" not found` }

    if (revision !== undefined) {
      // **按路径读而不是按名字查**：笔记段拿的是普通 `edit`，改得动 frontmatter 的
      // `name:` 那一行 —— 按旧名字查就查不到，于是最需要三方合并的那一次反而拿不到
      // 盘上的内容。空串同理算「给了一个对不上的指纹」，不是「没给」
      let onDisk = ''
      try {
        onDisk = readFileSync(target.basePath, 'utf-8')
      } catch {
        /* 文件在这一刻消失了：当作对不上，交给 UI */
      }
      if (revisionOf(onDisk) !== revision) {
        return {
          success: false,
          error: 'This bot changed on disk since you opened it — most likely its own notes pass.',
          conflict: { current: onDisk }
        }
      }
    }

    const parsed = this.parseForWrite(text, originalName)
    if ('error' in parsed) return { success: false, error: parsed.error }
    const name = parsed.file.name
    if (name !== originalName && bots.some((b) => b.file.name === name)) {
      return { success: false, error: `Bot "${name}" already exists` }
    }
    try {
      writeFileAtomic(target.basePath, text)
    } catch (e) {
      log.warn(`保存 bot "${originalName}" 失败:`, e)
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
    if (name !== originalName) this.migrateRename(originalName, name)
    // 半途崩溃的补做：文件名不随改名变，所以「文件叫 scout.md、里面写着 ranger」正是
    // 一次没走完的迁移。此时若还有会话引用着 scout，而 scout 已经不是任何一个活着的
    // bot —— 那就是它，补迁一次。幂等，正常保存时这一步什么都不做
    const stale = basename(target.basePath).replace(/\.md$/i, '')
    if (stale !== name && !this.listAll().some((b) => b.file.name === stale)) {
      this.migrateRename(stale, name)
    }
    // 成功回新指纹：UI 不必为了「再保存一次」而重新 getSource，否则第二次必然误报冲突
    return { success: true, revision: revisionOf(text) }
  }

  /**
   * 改名之后把散在别处的旧名字迁过来。
   *
   * bot 的身份是 frontmatter 里的 `name`，而这个名字被三处引用：会话的 `settings.bots`
   * 成员名单、决策记录与 run journal 的目录、以及笔记检查点。**不迁的话改一次名等于把
   * 这个 bot 从所有会话里删掉** —— L0 门会把它当成「成员 md 不存在」，而用户看到的是
   * 「我只是改了个名字」。
   *
   * **幂等**：每一步都先看目标状态再动手，重复跑一遍不会出错 —— 迁移做了一半崩掉时，
   * 下一次保存（或用户手动改回来再改过去）能把剩下的补上。
   *
   * 历史消息里的署名**不迁**，那是刻意的：侧车自带落树当时的 displayName，历史不该因为
   * 今天的一次改名而改写（这条纪律从 M3′ 起就写在署名侧车的注释里）。
   */
  private migrateRename(oldName: string, newName: string): void {
    // ① 会话成员名单
    // **逐会话独立 try**：一个会话写失败不该让它后面的会话全部留在旧名上 ——
    // 那会让「迁移了一半」这个本就难查的状态再多出一种形态
    let sessions: ReturnType<typeof sessionService.list> = []
    try {
      sessions = sessionService.list()
    } catch (e) {
      log.warn(`改名迁移：会话列表读取失败 ${oldName} → ${newName}:`, e)
    }
    for (const session of sessions) {
      const bots = session.settings?.bots
      if (!bots?.includes(oldName)) continue
      try {
        // 已经有新名字就只是去掉旧的（用户可能先手动加过新名字）
        const next = bots.map((b) => (b === oldName ? newName : b))
        sessionService.rewriteBots(session.id, [...new Set(next)])
      } catch (e) {
        log.warn(`改名迁移：会话 ${session.id} 名单改写失败:`, e)
      }
    }
    // ② 决策记录与 run journal 的目录
    try {
      const from = botRunsDir(oldName)
      const to = botRunsDir(newName)
      if (existsSync(from) && !existsSync(to)) renameSync(from, to)
    } catch (e) {
      log.warn(`改名迁移：journal 目录改名失败 ${oldName} → ${newName}:`, e)
    }
    // ③ 笔记检查点
    this.notes.rename(oldName, newName)
  }

  /** 新建 bot；文件名由 name 净化派生 */
  create(text: string): { success: boolean; name?: string; error?: string } {
    const parsed = this.parseForWrite(text, 'bot')
    if ('error' in parsed) return { success: false, error: parsed.error }
    const name = parsed.file.name
    if (this.listAll().some((b) => b.file.name === name)) {
      return { success: false, error: `Bot "${name}" already exists` }
    }

    const safeBase = name.replace(/[\\/:*?"<>|]/g, '-').replace(/^\.+/, '') || 'bot'
    if (!existsSync(this.userDir)) mkdirSync(this.userDir, { recursive: true })
    let filePath = join(this.userDir, `${safeBase}.md`)
    for (let i = 1; existsSync(filePath); i++) {
      filePath = join(this.userDir, `${safeBase}-${i}.md`)
    }
    try {
      writeFileAtomic(filePath, text)
    } catch (e) {
      log.warn(`新建 bot "${name}" 失败:`, e)
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
    return { success: true, name }
  }

  /**
   * 「新建 bot」的模板 —— 用内置管线与内置阶段 agent 填一份可直接落盘的 md。
   *
   * 这是「不内置 bot」的另一半（设计 §4.2）：用户不必从空文件起步，取个名字 + 写句人设
   * 就有一个能用的 bot；而内置件的更新照常跟随版本，不会被一份 fork 出来的副本冻住。
   */
  newBotTemplate(params: { name: string; description?: string; persona?: string }): string {
    const persona = params.persona?.trim() || `你是 ${params.name}。（在这里写它的人设与纪律。）`
    return serializeBotDefinitionFile({
      name: params.name,
      displayName: params.name,
      description: params.description?.trim() || `${params.name} —— 描述这个 bot 负责什么`,
      systemPrompt: persona,
      tools: [],
      instructionFiles: [],
      projectAwareness: false,
      pipeline: DEFAULT_BOT_PIPELINE,
      pipelineInput: {},
      respond: 'auto',
      notesEnabled: true,
      agents: {},
      greeting: '',
      suggestions: [],
      notes: null
    })
  }

  /** 删除 bot 文件 */
  delete(name: string): { success: boolean; error?: string } {
    const target = this.listAll().find((b) => b.file.name === name)
    if (!target) return { success: false, error: `Bot "${name}" not found` }
    try {
      unlinkSync(target.basePath)
    } catch (e) {
      log.warn(`删除 bot "${name}" 失败:`, e)
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
    log.info(`已删除 bot "${name}" (${target.basePath})`)
    return { success: true }
  }

  /**
   * 文件名白名单：仅接受 bot 目录下的单个 .md 文件名，杜绝路径穿越
   * （fileName 来自渲染进程，虽只由 listInvalid 的返回值填充，仍按不可信入参处理）。
   */
  private resolveUserFile(fileName: string): string | null {
    if (!/^[^/\\]+\.md$/i.test(fileName) || fileName.startsWith('.')) return null
    const filePath = join(this.userDir, fileName)
    return existsSync(filePath) ? filePath : null
  }

  /** 非法文件的读/写/删（身份是文件名 —— 它解析不出 name） */
  getSourceByFile(fileName: string): { text: string } | { error: string } {
    const filePath = this.resolveUserFile(fileName)
    if (!filePath) return { error: `Bot file "${fileName}" not found` }
    try {
      return { text: readFileSync(filePath, 'utf-8') }
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  }

  saveByFile(fileName: string, text: string): { success: boolean; error?: string } {
    const filePath = this.resolveUserFile(fileName)
    if (!filePath) return { success: false, error: `Bot file "${fileName}" not found` }
    const parsed = this.parseForWrite(text, fileName.slice(0, -3))
    if ('error' in parsed) return { success: false, error: parsed.error }
    try {
      writeFileAtomic(filePath, text)
    } catch (e) {
      log.warn(`保存 bot 文件 "${fileName}" 失败:`, e)
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
    return { success: true }
  }

  deleteByFile(fileName: string): { success: boolean; error?: string } {
    const filePath = this.resolveUserFile(fileName)
    if (!filePath) return { success: false, error: `Bot file "${fileName}" not found` }
    try {
      unlinkSync(filePath)
    } catch (e) {
      log.warn(`删除 bot 文件 "${fileName}" 失败:`, e)
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
    log.info(`已删除 bot 文件 "${fileName}"`)
    return { success: true }
  }

  // ─── 消息半边（M3′：无根会话的落盘与广播；不派发任何管线） ───────────────

  /**
   * 在飞会话计数 —— 树钉住谓词的数据源。
   *
   * 聊天会话恒无 AgentSession，所以 `agents.tracked()` 对它永远是 false；不另外钉住的话，
   * 树槽会被 LRU 逐出（默认只留 8 个未钉住的），而**逐出并不销毁 Session 实例** ——
   * 在飞的那个实例还会继续往同一个 jsonl 追加，与新开的实例各写各的，消息静默分叉。
   *
   * 口径对齐 `SessionManager.tracked`：覆盖「排队中 / 执行中 / 收尾中」，不是「有 run 在跑」。
   */
  private readonly inflight = new Map<string, number>()

  /** 会话内单调的消息序 —— entry id 是 uuidv7 的随机尾，刻意不可排序，seq 只能宿主自铸。
   *  进程内单调即可：mailbox 队列本来就是进程内的，重启不必续 */
  private readonly seqBySession = new Map<string, number>()
  /** 在飞 ticket（per-bot 停止、会话级中止、journal 关联都查它） */
  private readonly tickets = new Map<string, BotTicket>()
  /** 已经硬路由过的 clarify entry —— 一条 clarify 只回连一次 */
  private readonly clarifyConsumed = new Map<string, Set<string>>()
  /** 禁写位：`abortSession` 期间 `say` 一律硬失败（drain 只排空队列，挡不住新写者） */
  private readonly blockWrites = new Map<string, number>()
  /**
   * 定局那一刻被压制的候选，键是 `<sessionId>\u0000<messageSeq>` —— 等胜者真的开口时
   * 挂到它的署名侧车上（救济 chip 的数据源）。
   *
   * **不在定局时直接广播**：那时胜者可能还有一整个任务段要跑，chip 得跟着胜者那条消息走，
   * 而不是提前孤零零地飘在会话里。取走即删（一轮只挂一次，任务段后续的 say 不再重复挂），
   * cohort 收尾时无论取没取都清 —— 胜者半路失败的话就没人来取了。
   */
  private readonly suppressedBy = new Map<string, SuppressedCandidate[]>()
  /**
   * 会话里在飞的 barrier。**中止会话必须连它一起拆**：ticket / mailbox / workflow run
   * 都在 `abortSession` 里拆掉了，唯独 barrier 会带着它的宽限窗定时器活到 3 秒之后 ——
   * 那时会话早已收尾，它却仍会回调宿主、往 `suppressedBy` 里塞一份再也没人来取的名单。
   * `ClaimVerdict.reason:'aborted'` 这一支也是因为没人调 `abort()` 才一直是死代码。
   */
  private readonly barriers = new Map<string, Set<CohortBarrier>>()
  /**
   * 在飞的用户询问，键是 requestId。
   *
   * 有根会话里这份状态住在 `HarnessSession.pendingInputs`；聊天会话没有根运行时，
   * 于是这一份得自己养。**任务段 agent 是派生的、自身没有输入面板**，它的询问带着
   * 聊天会话 id 走 broker 到这里 —— 此前 broker 的单槽 resolver 只认有根会话，
   * 于是 bot 管线里的每一次询问都以「Session … is not active」收场：工具拿到一条错误，
   * 用户那边什么都没发生。
   */
  private readonly pendingInputs = new Map<
    string,
    { sessionId: string; resolve: (r: InputResponse) => void }
  >()
  /**
   * 被中止过、且还没有新消息进来的会话 —— 此间一律不受理新询问。
   *
   * **不能拿 `blockWrites` 顶替**：那个的语义是「`abortSession` 正在执行期间」，出了
   * finally 就没了。而工具是在自己的收尾里才发出询问的，它完全可能晚于整个 abortSession
   * 落定 —— 那条询问于是登记进 pendingInputs 再没人取消，run 一路烧到墙钟上限，用户还会
   * 在**按下停止之后**看见一张新冒出来的待答卡片。两者差的正是一个 finally。
   * 对照 `HarnessSession.inputsClosed`（那边置位在 abort、复位在下一次 prompt）。
   */
  private readonly inputsClosed = new Set<string>()
  /** 等「这个会话一个 run 都不剩」的人（`abortSession` 的会师点） */
  private readonly idleWaiters = new Map<string, Array<() => void>>()
  /**
   * 门控段的健康度：连续故障计数与「已回落」标记。
   *
   * 设计 §6.1：同一个 bot **连续 2 次**破损就回落内置门控 agent。超时与破损共用同一条
   * streak —— 回落这个救济对两者是同一个动作（换掉那个不可靠的门控 agent / 模型），
   * 分成两条只会让「一次超时 + 一次破损」永远够不到阈值。决策记录里两者仍分 kind。
   *
   * **回落是 sticky 的**：回落之后跑出的成功是**内置**跑出来的，不是那份覆盖跑出来的，
   * 拿它清零会造成「回落 → 成功 → 切回 → 再坏两次」的振荡。sticky 到进程重启为止。
   */
  private readonly gateHealth = new Map<string, { streak: number; degraded?: string }>()
  /**
   * 笔记归纳的节流调度（设计 §8）。真正的归纳由 `runNotes` 派发 —— 调度器只管
   * 「什么时候值得跑、给它看哪些新材料、跑完记到哪儿」
   */
  private readonly notes = new BotNotesScheduler({
    runNotes: (botName, dirty) => this.runNotesPass(botName, dirty)
  })
  private readonly mailbox = new BotMailbox({
    onChange: (key, snapshot) => {
      const [sessionId, botName] = key.split('\u0000')
      electronEventSink.broadcast({ type: 'bot_mailbox', sessionId, botName, ...snapshot })
    },
    onEvent: (key, kind, item, detail) => {
      const [sessionId, botName] = key.split('\u0000')
      appendBotDecision({
        kind,
        sessionId,
        botName,
        ticketId: item.ticketId,
        messageSeq: item.messageSeq,
        messageId: item.messageId,
        detail
      })
    }
  })

  /** 主进程启动时装配（同 workflowService.init 的时机，避免 ESM 初始化环） */
  init(): void {
    addSessionTreePin((sessionId) => this.isActive(sessionId))
    // bot 路径的 run journal 落到该 bot 自己的目录；meta 是唯一带调用方身份的记录，
    // label 就是 ticketId
    workflowService.registerRunJournalSink((record) => {
      const label = (record.invocation as { label?: string } | undefined)?.label
      const ticket = label ? this.tickets.get(label) : undefined
      if (!ticket) return null
      return botRunsDir(ticket.botName)
    })
  }

  /** 同步、O(1)、纯内存 —— 钉住谓词会对每个缓存槽各调一次，不能读盘或 parse JSON */
  isActive(sessionId: string): boolean {
    return (this.inflight.get(sessionId) ?? 0) > 0
  }

  private enter(sessionId: string): void {
    this.inflight.set(sessionId, (this.inflight.get(sessionId) ?? 0) + 1)
  }

  private leave(sessionId: string): void {
    const n = (this.inflight.get(sessionId) ?? 1) - 1
    if (n > 0) {
      this.inflight.set(sessionId, n)
      return
    }
    this.inflight.delete(sessionId)
    for (const wake of this.idleWaiters.get(sessionId) ?? []) wake()
    this.idleWaiters.delete(sessionId)
    // 这个会话一个 run 都不剩了，还挂着的询问按定义**没有人能消费它的答复** ——
    // 询问是被工具 await 着的，run 正常跑着就不可能结束；能走到这里只有一种情况：
    // 那个 run 被单独中止或超时掉了（定局时中止未表态成员、引擎墙钟），而中止路径
    // 拿不到「哪条询问属于哪张票」——询问经 broker 到达时只带着会话 id。
    // 按「会话归零」收口，就不必伪造那个归属
    this.cancelPendingInputs(sessionId)
  }

  /**
   * 聊天会话的用户消息落盘 —— gateway.prompt 对无根会话分流到这里。
   *
   * 有根会话里这件事发生在 pi 内部（harness 把 user 消息作为 entry 追加，随后广播）；
   * 聊天会话没有那个运行时，所以宿主自己走一遍**同样的顺序**：先 append 拿到 entry id，
   * 再用这个 id 广播。**禁止合成 id**，也禁止 append 之后回读叶子取 id —— 多写者下
   * 回读会拿到别人刚写的那条。
   *
   * **「bot 的回复不得触发 bot」是硬规则**（防循环），而它由**结构**保证：这个方法的唯一
   * 调用链是 `agent:prompt` IPC → gateway 分流，bot 自己的回复走 `appendBotMessage`，
   * 完全旁路这里。所以不写运行期的作者判定 —— `AgentPromptParams` 里加一个恒为 'user'
   * 的字段等于给自己开一张假证明。将来真出现「bot 消息回灌 prompt 入口」的路径，
   * 该改的是那条路径。
   */
  async handleUserMessage(params: AgentPromptParams): Promise<void> {
    const { sessionId, text, images, inlineTokens } = params
    // 新消息 = 重新开门（对照 HarnessSession.prompt 里的 inputsClosed 复位）。
    // 中止只该管住那一轮，不是把这条会话的询问永久拒收
    this.inputsClosed.delete(sessionId)
    this.enter(sessionId)
    try {
      // LLM 看到的是展开后的全文；标记态原文进显示侧车（与网关有根路径同一形状）
      const hasTokens = !!inlineTokens && Object.keys(inlineTokens).length > 0
      const promptText = hasTokens ? resolveTokensForAgent(text, inlineTokens) : text
      const display = hasTokens ? { content: text, tokens: inlineTokens } : undefined

      const message: AgentMessage = {
        role: 'user',
        content: [
          { type: 'text', text: promptText },
          ...(images ?? []).map((img) => ({
            type: 'image' as const,
            data: img.data,
            mimeType: img.mimeType
          }))
        ]
      } as AgentMessage

      const ids = await withSessionTreeLock(
        sessionId,
        async (tree) => {
          const sidecarId = display
            ? await tree.appendCustomEntry(INLINE_TOKENS_CUSTOM_TYPE, display)
            : null
          const entryId = await tree.appendMessage(message)
          // seq 在临界区内递增：它要与 entry 的先后严格一致
          const seq = (this.seqBySession.get(sessionId) ?? 0) + 1
          this.seqBySession.set(sessionId, seq)
          return { sidecarId, entryId, seq }
        },
        sessionService.getById(sessionId)?.workingDirectory ?? ''
      )

      const projected = await this.projectSlice(sessionId, [ids.sidecarId, ids.entryId])
      if (projected) {
        electronEventSink.broadcast({
          type: 'user_message',
          sessionId,
          message: JSON.stringify(projected)
        })
      }

      // 会话域埋点：**聊天会话也 fire**，用户工作流因此能旁观这里发生的事（auto-title
      // 也就顺带对聊天会话生效了）。payload 只是会话此刻的事实，与订阅方无关
      this.firePromptAccepted(
        sessionId,
        promptText,
        sessionService.getById(sessionId)?.settings?.bots ?? []
      )

      await this.dispatchCohort({
        sessionId,
        text,
        inlineTokens,
        promptText,
        messageId: ids.entryId,
        messageSeq: ids.seq,
        // **只带描述符，不带字节**：脚本的 input 会被原样写进 run journal（meta 记录带着
        // 整个 envelope），让 base64 进 input 等于每条带图消息都在磁盘上留下一份逐 bot 的
        // 副本。真正的字节由 resolveAttachments 在派发那一刻按引用取回
        attachments: (images ?? []).map((img, i) => ({
          sessionId,
          entryId: ids.entryId,
          index: i,
          mimeType: img.mimeType
        }))
      })
    } finally {
      this.leave(sessionId)
    }
  }

  /**
   * L0 门 → cohort → 每成员一次 invoke。
   *
   * 在飞计数覆盖**整条管线**（不是只包住一次 append）：钉住谓词是会话树不被 LRU 逐出的
   * 唯一依据，而被逐出的 Session 实例并不销毁、还会继续往同一个 jsonl 写 —— 症状是低频
   * 消息静默分叉，e2e 里几乎不可能稳定复现。
   */
  /**
   * 等这个会话的在飞管线全部收尾。
   *
   * **带上限**:中止已经把 ticket / barrier / mailbox / run 全拆了,正常情况下这里几乎
   * 立刻返回。上限是为了不让一个卡死的脚本把「删除会话」这类用户操作永久挂住 —— 宁可
   * 让极端情况下多出一次并发写(树是 append-only 的,最坏是多一条孤儿 entry),
   * 也不能让界面卡在那里。
   */
  private whenIdle(sessionId: string, timeoutMs = 5000): Promise<void> {
    if (!this.inflight.get(sessionId)) return Promise.resolve()
    return new Promise<void>((resolve) => {
      let done = false
      const finish = (): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        log.warn(`会话 ${sessionId} 的管线在中止后仍未收尾(${timeoutMs}ms),不再等`)
        finish()
      }, timeoutMs)
      const list = this.idleWaiters.get(sessionId) ?? []
      list.push(finish)
      this.idleWaiters.set(sessionId, list)
    })
  }

  /** prompt 受理埋点（fire 绝不抛出）。members 现取：名单随时可能被 updateBots 改 */
  private firePromptAccepted(sessionId: string, promptText: string, bots: string[]): void {
    const title = sessionService.getById(sessionId)?.title ?? ''
    workflowTriggers.fire('session.prompt-accepted', {
      sessionId,
      // 无根会话没有档案名。空串而不是编一个 —— 订阅方要区分会话种类,看 bots
      profileName: '',
      title,
      isDefaultTitle: isDefaultTitle(title),
      bots,
      promptText
    })
  }

  /** 轮结束埋点：事实由与有根会话**同一个**构造器现算 */
  private async fireTurnCompleted(sessionId: string, bots: string[]): Promise<void> {
    const facts = await buildTurnCompletedFacts(sessionId)
    if (!facts) return
    workflowTriggers.fire('session.turn-completed', {
      sessionId,
      profileName: '',
      bots,
      ...facts
    })
  }

  private async dispatchCohort(ctx: {
    sessionId: string
    text: string
    inlineTokens?: Record<string, InlineToken>
    promptText: string
    messageId: string
    messageSeq: number
    attachments?: BotAttachmentRef[]
  }): Promise<void> {
    const { sessionId, messageId, messageSeq, promptText } = ctx
    const members = sessionService.getById(sessionId)?.settings?.bots ?? []
    if (!members.length) return

    // listAll 每次现扫全目录 —— cohort 组建只扫一次，别在成员循环里反复扫
    const known = new Map(this.listAll().map((b) => [b.file.name, b.file]))
    const paths = new Map(this.listAll().map((b) => [b.file.name, b.basePath]))

    const gate = runL0Gate({
      members,
      known,
      text: ctx.text,
      inlineTokens: ctx.inlineTokens,
      lastBotSender: await this.lastBotSender(sessionId),
      clarifyConsumed: this.clarifyConsumed.get(sessionId) ?? new Set()
    })
    this.recordL0(sessionId, messageId, messageSeq, gate.records)
    if (gate.consumedClarifyEntryId) {
      const seen = this.clarifyConsumed.get(sessionId) ?? new Set<string>()
      seen.add(gate.consumedClarifyEntryId)
      this.clarifyConsumed.set(sessionId, seen)
    }
    if (!gate.cohort.length) {
      // L0 把所有成员都筛掉了（全是 mention-only 而这条没提及谁）——**这一轮仍然算结束**。
      // 有根会话那侧的契约是「无论成败恒触发」，两边在「什么时候算一轮」上错开，订阅方
      // 看到的就是「某类会话的工作流莫名其妙不触发」
      await this.fireTurnCompleted(sessionId, members)
      return
    }

    // 窗口只建一次，切好之后发给每个成员 —— 它要读一遍会话树 + 跑一次投影
    const window = await this.buildWindow(sessionId, messageId)

    const barrier = new CohortBarrier(gate.cohort, {
      onSettled: ({ unresponsive, suppressed }) => {
        // 定局时连意图都还没交的成员：继续跑纯属烧钱。已 claim 的败者**不**中止 ——
        // 让脚本按 verdict.won === false 自己优雅收尾，`say` 的强制点是兜底
        for (const name of unresponsive) this.ticketOf(sessionId, name, messageSeq)?.abort.abort()
        if (suppressed.length) {
          this.suppressedBy.set(
            suppressedKey(sessionId, messageSeq),
            suppressed.map((s) => ({
              name: s.botName,
              // 显示名取 cohort 组建那一刻的快照，与署名侧车同理：bot 改名或被删之后，
              // 历史消息上的 chip 仍该显示当初那个名字
              displayName: known.get(s.botName)?.displayName ?? s.botName,
              decision: s.decision,
              relevance: s.relevance,
              ...(s.reason ? { reason: s.reason } : {})
            }))
          )
        }
      }
    })

    const live = this.barriers.get(sessionId) ?? new Set<CohortBarrier>()
    live.add(barrier)
    this.barriers.set(sessionId, live)

    this.enter(sessionId)
    try {
      const outcomes = await Promise.all(
        gate.cohort.map((botName) =>
          this.runPipeline({
            bot: known.get(botName)!,
            basePath: paths.get(botName) ?? '',
            sessionId,
            messageId,
            messageSeq,
            promptText,
            barrier,
            // 「还有别人可能接这条消息吗」—— 降级出声的判据
            arbitrated: gate.cohort.length > 1,
            // 「这条消息点名了我吗」—— 契约选择的判据（定向与单 bot 一样用 intentSolo）
            directed: gate.directed,
            members: gate.cohort,
            known,
            window,
            attachments: ctx.attachments
          }).catch((e) => {
            // 一个成员炸了不该拖垮整个 cohort：Promise.all 一 reject，后面的沉默判定
            // 就永远跑不到，用户看到的是一条消息发出去之后彻底没有下文
            log.warn(`bot 管线异常退出 (${botName}):`, e)
            return {
              botName,
              displayName: known.get(botName)?.displayName ?? botName,
              said: false,
              outcome: 'pipeline_error'
            }
          })
        )
      )

      // 多 bot 的沉默是 cohort 整体的结局，逐成员补气泡会让每条消息多出 N 条噪音
      // （M4′ 的 `!ctx.arbitrated` 正是为此留的口子，这里把它补完）。单 bot 会话不发 ——
      // 那里的沉默只可能是失败，一条留痕的失败消息比一次转瞬即逝的提示更该有。
      //
      // **被中止的一轮也不发**：用户自己按的停止不属于「无从解释的沉默」，跟单 bot 那条
      // 降级气泡的 `!signal.aborted` 是同一条纪律 —— 少了它，点一次停止就弹一条
      // 「全体沉默：有东西坏了」
      const silence = gate.cohort.length > 1 && !barrier.wasAborted ? cohortSilence(outcomes) : null
      if (silence) {
        // 逐成员各记一条，而不是找个 `_cohort` 假目录记一条：决策记录按 bot 分目录，
        // 回答的是「这个 bot 为什么没说话」—— 「这一轮谁都没说」正是它自己那份记录里
        // 最该有、又只能由 cohort 视角给出的一句（否则要跨 N 个文件对账才看得出来）
        for (const o of outcomes) {
          appendBotDecision({
            kind: 'cohort_silent',
            sessionId,
            botName: o.botName,
            ticketId: '-',
            messageSeq,
            messageId,
            detail: { reason: silence.reason, self: o.outcome }
          })
        }
        // 胜者半路失败的场合，暂存里还躺着一份没人来取的候选名单 —— 而这恰恰是最需要
        // 救济的一次：有人想接、赢家却哑了。没有胜者消息可挂，就挂到这条提示上
        const orphaned = this.suppressedBy.get(suppressedKey(sessionId, messageSeq))
        electronEventSink.broadcast({
          type: 'bot_cohort_silent',
          sessionId,
          messageId,
          reason: silence.reason,
          members: outcomes.map((o) => ({
            name: o.botName,
            displayName: o.displayName,
            outcome: o.outcome
          })),
          ...(orphaned?.length ? { suppressed: orphaned } : {})
        })
      }
      // 全员收尾之后才算「一轮结束」——聊天会话的一轮是 cohort 整体，不是某个成员。
      // **在 finally 之前**：放到在飞计数之外的话，`abortSession` 的会师点可以在这次
      // fire 还在飞时就落定，于是 auto-title 能在一个正在被删除/清空的会话上新起一个 run
      await this.fireTurnCompleted(sessionId, members)
    } finally {
      this.leave(sessionId)
      this.suppressedBy.delete(suppressedKey(sessionId, messageSeq))
      live.delete(barrier)
      if (!live.size) this.barriers.delete(sessionId)
    }
  }

  /**
   * 会话窗口 —— 喂给提示词的**已成型字符串行**，不是对象数组。
   *
   * 提示词模板对数组是「逐项 String 后按行拼」，而对象会走 JSON.stringify：给对象数组，
   * `{{window}}` 渲染出来就是一行一个 JSON，白烧 token 还难读。字符预算也只有在拼成行
   * 之后才有确切含义。脚本仍能按条数切（`input.window.slice(-vars.gateWindow)`）。
   *
   * 发言人标签用固定的 `User` / bot 的 displayName，**刻意不本地化** —— 它是数据标注
   * 不是文案，模型跨语言都读得懂。bot 的名字取投影产物里的 `metadata.sender`，
   * 那是落树当时的快照，所以历史行不会因为改名而改写。
   *
   * @param untilEntryId 截到这条 entry **之前**（新用户消息在派发前已经落树，
   *        不截的话它会和提示词里的 `{{message.text}}` 重复一遍）
   */
  private async buildWindow(
    sessionId: string,
    untilEntryId?: string
  ): Promise<{ lines: string[]; after: (entryId: string) => string[] }> {
    const msgs = await messageService.listBySession(sessionId)
    const cut = untilEntryId ? msgs.findIndex((m) => m.id === untilEntryId) : -1
    const upTo = cut >= 0 ? msgs.slice(0, cut) : msgs
    const lineOf = (m: (typeof msgs)[number]): string => {
      const who =
        m.role === 'user'
          ? 'User'
          : ((m.metadata as { sender?: { displayName?: string } } | null)?.sender?.displayName ??
            'Assistant')
      // user 消息的 content 是标记态原文（内联 Token 还没展开）—— 还原成人读文本
      const text =
        m.role === 'user' ? resolveTokensForAgent(m.content, m.metadata?.inlineTokens) : m.content
      return `${who}: ${String(text ?? '').trim()}`
    }
    return {
      lines: upTo.filter((m) => m.role === 'user' || m.role === 'assistant').map(lineOf),
      after: (entryId: string) => {
        const at = msgs.findIndex((m) => m.id === entryId)
        if (at < 0) return []
        return msgs
          .slice(at + 1)
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .map(lineOf)
      }
    }
  }

  /**
   * 门控段的健康度记账。信道是脚本返回值的 `gate` 字段 —— 宿主看不见脚本内 `run()` 的错，
   * 而管线自己知道它这一轮是怎么收的。
   *
   * `gate` 缺省（自定义管线、`started:false`、脚本自身抛出）→ **既不递增也不清零**：
   * 这个计数器问的是「内置门控契约还灵不灵」，网络抖动不该把用户的自定义管线打成回落态。
   */
  private noteGateHealth(botName: string, gate: string | undefined, ticket: BotTicket): void {
    if (gate !== 'ok' && gate !== 'broken' && gate !== 'timeout') return
    const health = this.gateHealth.get(botName) ?? { streak: 0 }
    if (gate === 'ok') {
      // 已回落的不清零（见 gateHealth 的注释）
      if (!health.degraded) health.streak = 0
      this.gateHealth.set(botName, health)
      return
    }
    health.streak += 1
    appendBotDecision({
      kind: gate === 'timeout' ? 'gate_timeout' : 'gate_broken',
      sessionId: ticket.sessionId,
      botName,
      ticketId: ticket.ticketId,
      messageSeq: ticket.messageSeq,
      messageId: ticket.messageId,
      detail: { streak: health.streak }
    })
    if (health.streak >= GATE_FAILURE_STREAK && !health.degraded) {
      health.degraded = gate
      appendBotDecision({
        kind: 'gate_fallback',
        sessionId: ticket.sessionId,
        botName,
        ticketId: ticket.ticketId,
        detail: { after: health.streak, reason: gate }
      })
      log.warn(`bot "${botName}" 的门控段连续 ${health.streak} 次故障，已回落内置 bot-intent`)
      // 回落是**会话里看得见的行为改变**（设计 §6.1）：这个 bot 从此不再用用户指定的门控
      // agent 了。只落 journal + 设置页徽标的话,用户看到的是「它忽然变得不一样了」而
      // 线索埋在文件系统里。回落是 sticky 的,所以这条一个进程只出一次
      this.appendBotMessage(
        ticket.sessionId,
        { botName, displayName: ticket.displayName },
        { content: t('bot.gateFallback', { name: ticket.displayName, count: health.streak }) }
      ).catch((e) => log.warn(`回落提示落树失败 (${botName}):`, e))
    }
    this.gateHealth.set(botName, health)
  }

  /** 某个 bot 的门控段是不是已经回落（设置页徽标的数据位） */
  gateDegradedOf(botName: string): string | undefined {
    return this.gateHealth.get(botName)?.degraded
  }

  /** 一个成员的一次应答：建 ticket → 装配三个回调 → invoke */
  private async runPipeline(ctx: {
    bot: ParsedBotFile
    basePath: string
    sessionId: string
    messageId: string
    messageSeq: number
    promptText: string
    barrier: CohortBarrier
    arbitrated: boolean
    directed: boolean
    members: string[]
    known: Map<string, ParsedBotFile>
    window: { lines: string[]; after: (entryId: string) => string[] }
    attachments?: BotAttachmentRef[]
  }): Promise<MemberOutcome> {
    const { bot, sessionId, messageId, messageSeq } = ctx
    // 连续故障之后回落内置门控：用户覆盖的 `shuvix-bot-agents.intent` 让位
    const degraded = this.gateHealth.get(bot.name)?.degraded
    const pipeline = resolvePipeline(bot, degraded ? { intent: 'bot-intent' } : undefined)
    const ticket: BotTicket = {
      ticketId: `bt-${uuidv4()}`,
      sessionId,
      botName: bot.name,
      displayName: bot.displayName,
      messageSeq,
      messageId,
      barrier: ctx.barrier,
      claimState: ctx.barrier.isSolo ? 'won' : 'none',
      terminal: false,
      said: false,
      abort: new AbortController()
    }

    const decide = (kind: BotDecisionKind, detail?: Record<string, unknown>): void =>
      appendBotDecision({
        kind,
        sessionId,
        botName: bot.name,
        ticketId: ticket.ticketId,
        runId: ticket.runId,
        messageSeq,
        messageId,
        detail
      })

    if (!pipeline.exists) {
      // 管线名写坏 / 被删：不派发，但**会话里要看得见** —— journal 深处的记录不是呈现
      decide('pipeline_not_found', { workflow: pipeline.workflow })
      this.activity(ticket, 'ended', 'pipeline_not_found')
      await this.appendBotMessage(
        sessionId,
        { botName: bot.name, displayName: bot.displayName },
        { content: t('bot.pipelineMissing', { pipeline: pipeline.workflow }) }
      )
      // said=true：这个成员确实往会话里放了东西（一条可见失败）。全体沉默的判据是
      // 「会话里什么都没多出来」，不是「脚本调过 say」—— 否则一条已经显形的失败
      // 还会再触发一次沉默提示
      return {
        botName: bot.name,
        displayName: bot.displayName,
        said: true,
        outcome: 'pipeline_not_found'
      }
    }

    this.tickets.set(ticket.ticketId, ticket)
    this.activity(ticket, 'started')
    const startedAt = Date.now()
    try {
      const result = await workflowService.invoke({
        workflow: pipeline.workflow,
        // 漏传 sessionId 是静默降级：会话授权恒空、工作区落临时目录、ask 变成工具错误
        sessionId,
        label: ticket.ticketId,
        signal: ticket.abort.signal,
        input: {
          ...bot.pipelineInput,
          // 宿主键铺在用户的 shuvix-bot-input 之后 —— 一份 bot md 不得改写 session.id 这类事实
          occasion: 'message',
          bot: {
            name: bot.name,
            displayName: bot.displayName,
            description: bot.description,
            file: ctx.basePath
          },
          agents: pipeline.agents,
          session: {
            id: sessionId,
            arbitrated: ctx.arbitrated,
            directed: ctx.directed,
            members: ctx.members,
            // 其它成员的身份 —— 门控段据此判断「这条明显是冲着别人去的」
            others: ctx.members
              .filter((n) => n !== bot.name)
              .map((n) => ctx.known.get(n))
              .filter((b): b is ParsedBotFile => !!b)
              .map((b) => ({ displayName: b.displayName, description: b.description }))
          },
          window: ctx.window.lines,
          message: {
            id: messageId,
            seq: messageSeq,
            text: ctx.promptText,
            ...(ctx.attachments?.length ? { attachments: ctx.attachments } : {})
          },
          notes: bot.notes ?? ''
        },
        extraApi: this.makeBotApi(ticket)
        // reentry 一个字都不传：独占 100% 由 mailbox 提供，引擎重入彻底让位。
        // 只给 mode 不给 key 静默无效，而显式传 mode 等于替用户的管线 md 做主
      })

      const output = result.output as
        | { outcome?: string; gate?: string; memorable?: boolean }
        | undefined
      if (!result.started) {
        decide(result.reason === 'invalid-input' ? 'pipeline_invalid_input' : 'pipeline_error', {
          reason: result.reason,
          error: result.error
        })
      } else {
        this.noteGateHealth(bot.name, output?.gate, ticket)
        // 值得归纳的事：干过一次活，或者意图段觉得这条带着可长期沿用的东西。
        // 关掉笔记的 bot 连账都不记 —— 攒一堆永远不会被读的计数没有意义
        const worthNoting = bot.notesEnabled && isNoteWorthy(output)
        if (worthNoting) {
          this.notes.note(bot.name, sessionId)
          // 不 await：归纳是离线的，把它挂在这一轮的收尾上等于让用户等笔记
          void this.notes.maybeRun(bot.name)
        }
        decide('run_end', {
          ok: result.ok,
          outcome: output?.outcome,
          gate: output?.gate,
          error: result.error,
          ms: Date.now() - startedAt
        })
      }

      // 可见结局兜底（设计 §9）：脚本自己抛了、没有可用模型、mailbox 超时 —— 这些今天
      // 在会话里什么都不会出现。
      //
      // 谁该出这条气泡：**没有仲裁的场合，或者仲裁的胜者**。多 bot 会话里的败者与未表态者
      // 一刀切会让每条消息多出 N−1 条错误气泡（那是设计要的沉默），但**胜者不在此列** ——
      // 它正是那个欠着一条回复的人，它的失败恰恰最该看得见。顺带这也让被它压制的候选有处
      // 可挂：气泡是一条正经的 bot 消息，救济 chip 跟着它走
      const owesReply = !ctx.arbitrated || ticket.claimState === 'won'
      if (!result.ok && !ticket.said && owesReply && !ticket.abort.signal.aborted) {
        await this.appendBotMessage(
          sessionId,
          {
            botName: bot.name,
            displayName: bot.displayName,
            ...(this.takeSuppressed(ticket) ?? {})
          },
          { content: t('bot.runFailed', { name: bot.displayName }) }
        )
        ticket.said = true
      }
      const ended = result.started ? (result.ok ? 'ok' : 'failed') : (result.reason ?? 'error')
      this.activity(ticket, 'ended', ended)
      return {
        botName: bot.name,
        displayName: bot.displayName,
        said: ticket.said,
        outcome: memberOutcome(ticket, output?.outcome, ended)
      }
    } finally {
      ticket.terminal = true
      this.mailbox.releaseByTicket(ticket.ticketId)
      this.tickets.delete(ticket.ticketId)
      // 重定向出去的目录由它的所有者自己剪（workflowService 的通配会连 decisions.jsonl 一起剪）
      pruneBotRuns(bot.name)
    }
  }

  /**
   * 装配进脚本 API 的三个回调。
   *
   * 值跨 vm realm 到达 —— `instanceof` 不可靠，一律逐字段 typeof 校验 + JSON 克隆。
   */
  private makeBotApi(ticket: BotTicket): Record<string, unknown> {
    const key = mailboxKey(ticket.sessionId, ticket.botName)
    const decide = (kind: BotDecisionKind, detail?: Record<string, unknown>): void =>
      appendBotDecision({
        kind,
        sessionId: ticket.sessionId,
        botName: ticket.botName,
        ticketId: ticket.ticketId,
        runId: ticket.runId,
        messageSeq: ticket.messageSeq,
        messageId: ticket.messageId,
        detail
      })

    return {
      claim: async (raw: unknown): Promise<ClaimVerdict> => {
        const intent = asClaimIntent(raw)
        const verdict = await ticket.barrier.claim(ticket.botName, intent)
        ticket.claimState = verdict.won ? 'won' : 'lost'
        ticket.claimReason = verdict.reason
        decide(
          verdict.reason === 'solo'
            ? 'claim_solo'
            : verdict.won
              ? 'claim_won'
              : verdict.reason === 'ignored'
                ? 'claim_ignored'
                : verdict.reason === 'timeout'
                  ? 'claim_timeout'
                  : // 中止不是「输了」。并进 claim_lost 会让排查的人去找那个并不存在的胜者，
                    // 也会与沉默事件里的 claim_aborted 对不上号
                    verdict.reason === 'aborted'
                    ? 'claim_aborted'
                    : 'claim_lost',
          { decision: intent.decision, relevance: intent.relevance, winner: verdict.winner }
        )
        this.activity(ticket, verdict.won ? 'claimed' : 'silent', verdict.reason)
        return { ...verdict }
      },

      turn: async (fn?: unknown): Promise<unknown> => {
        const item: QueueItem = {
          ticketId: ticket.ticketId,
          messageSeq: ticket.messageSeq,
          messageId: ticket.messageId
        }
        this.activity(ticket, 'queued')
        const slot = await this.mailbox.acquireBare(key, item)
        this.activity(ticket, 'working')
        // 排队期间发生的事 —— 在这里补而不是在 mailbox 的 slot() 里：那是同步纯函数，
        // 塞一次读树进去会污染它的假时钟单测。mailbox 只需要知道 messageId，
        // 「那条消息之后有什么」是宿主的窗口构建器的事
        const since = (await this.buildWindow(ticket.sessionId)).after(ticket.messageId)
        const granted: TurnSlot = { ...slot, since }
        if (typeof fn !== 'function') {
          // 裸形式：由 run 收尾时释放（runPipeline 的 finally）
          return granted
        }
        try {
          return await (fn as (s: TurnSlot) => Promise<unknown>)(granted)
        } finally {
          this.mailbox.releaseByTicket(ticket.ticketId)
        }
      },

      say: async (raw: unknown, opts?: unknown): Promise<{ messageId: string | null }> => {
        // ① run 已收尾：引擎只是 race 输掉，node:vm 无法硬中断异步续体，脚本还在脱手跑。
        //    少了这条闸，会出现「journal 记为超时失败、会话里却多出一条消息」的分叉
        if (ticket.terminal) throw new Error('this run has already ended')
        if (this.blockWrites.has(ticket.sessionId)) throw new Error('session is being torn down')
        // ② 仲裁的**唯一强制点**：claim 返回 false 只是建议，落树才是有外部后果的动作
        if (ticket.claimState === 'lost') {
          ticket.blockedBy = 'arbitration_lost'
          decide('arbitration_lost')
          throw new Error('another bot won this message')
        }
        if (ticket.claimState === 'none' && !ticket.barrier.isSolo) {
          // 隐式入场 = 给「不调 claim」发一张永远赢的票
          ticket.blockedBy = 'arbitration_bypassed'
          decide('arbitration_bypassed')
          throw new Error('call claim() before say() in a multi-bot session')
        }
        const content = asSayContent(raw)
        const botReply = coerceBotReply(raw)
        const o = (typeof opts === 'object' && opts !== null ? opts : {}) as {
          decision?: unknown
          error?: unknown
        }
        // 降级出声（`{error:true}`）**绝不带 decision** —— 否则一条 clarify 会把用户的
        // 下一条无关消息硬路由回这个刚出过故障的 bot
        const decision = o.error !== true && typeof o.decision === 'string' ? o.decision : undefined
        const messageId = await this.appendBotMessage(
          ticket.sessionId,
          {
            botName: ticket.botName,
            displayName: ticket.displayName,
            ...(decision ? { decision } : {}),
            ...(this.takeSuppressed(ticket) ?? {}),
            // 侧车存**校验过**的结构，与 content 里那份 markdown 同源（content 由
            // botReplyToMarkdown 得来）—— 读写两侧同一个形状，UI 不必再自己防一遍
            ...(botReply ? { reply: botReply } : {})
          },
          { content }
        )
        if (messageId) {
          ticket.said = true
          this.mailbox.noteReplied(key, ticket.messageSeq)
        }
        return { messageId }
      }
    }
  }

  /**
   * 附件句柄 → 派生 agent 上下文里的真实图片消息（引擎的 `resolveAttachments` 接缝）。
   *
   * 句柄是**自包含**的（会话 + entry + 第几张）：引擎那一层没有会话上下文，它只是把脚本
   * 转交的值原样递过来。字节**从会话树回读而不是在内存里另存一份** —— 消息可能在 mailbox
   * 里排很久才轮到任务段，而树是这些字节唯一的权威副本；内存缓存要么跟着排队时长一起
   * 泄漏，要么在超时那一刻恰好被清掉。
   *
   * 取不到就跳过那一张（少一张图的回答好过没有回答），不抛。
   */
  async resolveAttachments(refs: unknown[], ownerSessionId?: string): Promise<AgentMessage[]> {
    const wanted = new Map<string, { sessionId: string; entryId: string; indexes: number[] }>()
    for (const raw of refs) {
      if (typeof raw !== 'object' || raw === null) continue
      const d = raw as { sessionId?: unknown; entryId?: unknown; index?: unknown }
      if (typeof d.sessionId !== 'string' || !d.sessionId) continue
      // **只读本次 run 归属的那条会话**：句柄来自脚本，而脚本是用户写的 md —— 不设这道
      // 闸，任何工作流都能写一个指向别的会话的句柄，把那边的图片拉进本次上下文。不是越权
      // （会话都是同一个用户的），但「附件」这个词不该悄悄含有跨会话读取的意思
      if (ownerSessionId && d.sessionId !== ownerSessionId) {
        log.warn(`附件句柄指向别的会话，已忽略：${d.sessionId}`)
        continue
      }
      if (typeof d.entryId !== 'string' || !d.entryId) continue
      if (!Number.isInteger(d.index) || (d.index as number) < 0) continue
      const key = `${d.sessionId}\u0000${d.entryId}`
      const slot = wanted.get(key) ?? {
        sessionId: d.sessionId,
        entryId: d.entryId,
        indexes: [] as number[]
      }
      slot.indexes.push(d.index as number)
      wanted.set(key, slot)
    }
    if (!wanted.size) return []

    const out: Array<{ type: 'image'; data: string; mimeType: string }> = []
    for (const { sessionId, entryId, indexes } of wanted.values()) {
      try {
        const tree = await getSessionTree(sessionId)
        const entry = tree ? await tree.getEntry(entryId) : null
        if (!entry || entry.type !== 'message') continue
        const content = (entry.message as { content?: unknown }).content
        if (!Array.isArray(content)) continue
        const images = content.filter(
          (c): c is { type: 'image'; data: string; mimeType: string } =>
            typeof c === 'object' && c !== null && (c as { type?: unknown }).type === 'image'
        )
        for (const i of indexes) if (images[i]) out.push(images[i])
      } catch (e) {
        log.warn(`附件回读失败 session=${sessionId} entry=${entryId}:`, e)
      }
    }
    if (!out.length) return []
    // 一条 user 消息装全部图片：模型看到的是「用户随这条消息附了这些图」，拆成多条会让
    // 上下文里凭空多出几轮对话
    return [{ role: 'user', content: out } as AgentMessage]
  }

  /**
   * 跑一次笔记归纳。
   *
   * **归属会话取最近一个有增量的那条**：笔记本身是跨会话的（per-bot），但派发出去的
   * agent 要写 `~/.shuvix/bots/<bot>.md` —— 那是工作区之外的路径，会撞 ask-on-write 的
   * 询问卡（设计 §8.2 明确接受这个代价）。而询问卡必须落在一条用户看得见的会话上：
   * 不给 sessionId 的话，M7′ 那条路由找不到参与方，每次笔记写入都会被直接拒绝。
   *
   * **分道键是 `bot:<name>:notes`**：同一个 bot 的笔记同一时刻只能有一处在改，而这与
   * 会话无关 —— 它改的是那一份文件。`queue` 而不是 `skip`：排队时被更新的调用顶掉是对的
   * （检查点只在成功后前进，所以后来者看到的材料是前者的超集），丢掉则是真的丢。
   */
  private async runNotesPass(
    botName: string,
    dirty: Array<{ sessionId: string; sinceEntryId: string }>
  ): Promise<boolean> {
    const bot = this.getBot(botName)
    if (!bot || !bot.notesEnabled) return false
    const basePath = this.listAll().find((b) => b.file.name === botName)?.basePath ?? ''
    if (!basePath) return false

    // 便宜的检查排在读树之前：管线名写坏的 bot 否则每条消息都要白读一遍所有会话树
    const pipeline = resolvePipeline(bot)
    if (!pipeline.exists) return false

    // 各会话的增量窗 + 归纳到哪一条的新检查点。一并算出来，免得成功之后再读一遍树
    const blocks: Array<{ sessionId: string; at: number; lines: string[]; last: string }> = []
    for (const { sessionId, sinceEntryId } of dirty) {
      const msgs = await messageService.listBySession(sessionId)
      let from = 0
      if (sinceEntryId) {
        const at = msgs.findIndex((m) => m.id === sinceEntryId)
        // **找不到就跳过这个会话**，而不是从头再来一遍。检查点可能因为一次回退而不在
        // 当前分支的投影里了 —— 那时把整段历史当成新材料重灌，代价是成倍的
        if (at < 0) continue
        from = at + 1
      }
      const fresh = msgs.slice(from).filter((m) => m.role === 'user' || m.role === 'assistant')
      if (!fresh.length) continue
      const lines: string[] = []
      const title = sessionService.getById(sessionId)?.title ?? sessionId
      lines.push(`--- ${title} ---`)
      for (const m of fresh) {
        const who =
          m.role === 'user'
            ? 'User'
            : ((m.metadata as { sender?: { displayName?: string } } | null)?.sender?.displayName ??
              'Assistant')
        const text =
          m.role === 'user' ? resolveTokensForAgent(m.content, m.metadata?.inlineTokens) : m.content
        lines.push(`${who}: ${String(text ?? '').trim()}`)
      }
      blocks.push({
        sessionId,
        at: fresh[fresh.length - 1]?.createdAt ?? 0,
        lines,
        last: msgs[msgs.length - 1]?.id ?? ''
      })
    }
    if (!blocks.length) return false

    // 归属会话 = **最近有增量的那条**（询问卡落在用户刚才还在看的地方）。dirty 的顺序是
    // 「这个会话第一次被记账」的插入序，拿它当「最近」会让卡片挂到一条早就冷掉的会话上
    const owner = [...blocks].sort((a, b) => b.at - a.at)[0].sessionId
    const checkpoints: Record<string, string> = {}
    for (const b of blocks) checkpoints[b.sessionId] = b.last
    // **有上限**：`notesWindow` 声明了就得用上。不设限的话，一个 bot 在三个繁忙会话里
    // 攒半小时就能把上千行灌进笔记段的提示词 —— 而这份 input 还会被原样写进 run journal
    const since = blocks.flatMap((b) => b.lines).slice(-NOTES_MAX_LINES)
    if (!since.length) return false
    const result = await workflowService.invoke({
      workflow: pipeline.workflow,
      sessionId: owner,
      label: `notes:${botName}`,
      reentry: { mode: 'queue', key: `bot:${botName}:notes` },
      input: {
        ...bot.pipelineInput,
        occasion: 'notes',
        bot: {
          name: bot.name,
          displayName: bot.displayName,
          description: bot.description,
          file: basePath
        },
        agents: pipeline.agents,
        session: { id: owner, arbitrated: false, directed: false, members: [] },
        since,
        notes: bot.notes ?? ''
      }
    })
    // **run 跑完 ≠ 归纳成功**：脚本 catch 掉任何错误之后是正常返回的，于是引擎记 ok:true。
    // 只认它自报的 outcome —— 少了这一刀，一次失败（甚至用户按停止）都会推进检查点，
    // 把这批材料永远埋掉，而那恰恰是「检查点只在成功后前进」要防的唯一一件事
    const output = result.output as { outcome?: string } | undefined
    const ok = result.started && result.ok === true && output?.outcome === 'notes'
    if (ok) this.notes.advance(botName, checkpoints)
    else log.warn(`笔记归纳未完成 (${botName}): ${result.reason ?? result.error ?? 'unknown'}`)
    return ok
  }

  /** 会话被删：连它的笔记检查点一起忘掉 */
  forgetNotesSession(sessionId: string): void {
    this.notes.forgetSession(sessionId)
  }

  // ─── 用户询问（聊天会话没有根运行时，这份生命周期得自己养） ───

  /**
   * 一次询问。返回的 Promise 落定于：用户答复、会话被中止、或前端根本不在。
   *
   * 与 `HarnessSession.requestUserInput` 同一套判据 —— 没有输入面板就**立刻取消**而不是
   * 挂起：一个永远等不到答复的 Promise 会把任务段的墙钟耗光，而用户那边压根没看见问题。
   */
  requestUserInput(sessionId: string, request: InputRequest): Promise<InputResponse> {
    if (
      this.blockWrites.has(sessionId) ||
      this.inputsClosed.has(sessionId) ||
      !chatFrontendRegistry.hasCapability(sessionId, 'userInput')
    ) {
      return Promise.resolve({ kind: 'cancel', reason: 'aborted' })
    }
    return new Promise<InputResponse>((resolve) => {
      this.pendingInputs.set(request.id, { sessionId, resolve })
      electronEventSink.broadcast({ type: 'input_request', sessionId, request })
    })
  }

  /** 答复送达；`false` = 这条不是我发出的（broker 会继续问下一个参与方） */
  respondToInput(requestId: string, response: InputResponse): boolean {
    const pending = this.pendingInputs.get(requestId)
    if (!pending) return false
    this.pendingInputs.delete(requestId)
    pending.resolve(response)
    electronEventSink.broadcast({
      type: 'input_request_resolved',
      sessionId: pending.sessionId,
      requestId
    })
    return true
  }

  /**
   * 会话被中止：在飞的询问一律取消。
   *
   * **必须广播 `input_request_resolved`**：前端的 pending 卡片只认这一个事件（不看
   * agent_end，而聊天会话本来也永不发 agent_end）—— 少了它，会话停了、卡片还挂在那里，
   * 点下去石沉大海。
   */
  private cancelPendingInputs(sessionId: string): void {
    for (const [id, pending] of [...this.pendingInputs]) {
      if (pending.sessionId !== sessionId) continue
      this.pendingInputs.delete(id)
      pending.resolve({ kind: 'cancel', reason: 'aborted' })
      electronEventSink.broadcast({ type: 'input_request_resolved', sessionId, requestId: id })
    }
  }

  /**
   * 取走这一轮被压制的候选，交给即将落树的那条 bot 消息。
   *
   * **取走即删**：一轮只挂一次 —— 任务段会 say 好几次，每条都挂等于把「还有谁想回答」
   * 重复 N 遍。两个调用点（正常回复、胜者的失败气泡）共用它，因为它们是同一件事的
   * 两种结局：这条消息就是胜者对这一轮的交代。
   */
  private takeSuppressed(ticket: BotTicket): { suppressed: SuppressedCandidate[] } | null {
    const key = suppressedKey(ticket.sessionId, ticket.messageSeq)
    const list = this.suppressedBy.get(key)
    if (!list?.length) return null
    this.suppressedBy.delete(key)
    return { suppressed: list }
  }

  private ticketOf(sessionId: string, botName: string, messageSeq: number): BotTicket | undefined {
    for (const t of this.tickets.values()) {
      if (t.sessionId === sessionId && t.botName === botName && t.messageSeq === messageSeq)
        return t
    }
    return undefined
  }

  private activity(
    ticket: BotTicket,
    phase: 'started' | 'claimed' | 'queued' | 'working' | 'silent' | 'ended',
    outcome?: string
  ): void {
    electronEventSink.broadcast({
      type: 'bot_activity',
      sessionId: ticket.sessionId,
      botName: ticket.botName,
      displayName: ticket.displayName,
      phase,
      outcome,
      messageId: ticket.messageId
    })
  }

  private recordL0(
    sessionId: string,
    messageId: string,
    messageSeq: number,
    records: L0Record[]
  ): void {
    for (const r of records) {
      appendBotDecision({ ...r, sessionId, ticketId: '-', messageSeq, messageId })
    }
  }

  /**
   * 分支尾部最后一条 bot 署名侧车 —— clarify 回连的判定材料。
   *
   * **读树上的原始 entry，不走 messageService**：投影把侧车压成 `{kind,name,displayName}`，
   * `decision` 被丢掉，走投影会拿到一个恒为 undefined 的字段**且不报错**（表现为
   * 「回连从来不触发」）。也不用 findEntries —— 它不区分分支，回退后的旧分支会命中。
   */
  private async lastBotSender(sessionId: string): Promise<LastBotSender | null> {
    const tree = await getSessionTree(sessionId)
    if (!tree) return null
    const branch = await tree.getBranch()
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i]
      if (entry.type !== 'custom' || entry.customType !== BOT_SENDER_CUSTOM_TYPE) continue
      const data = entry.data as Partial<LastBotSender> | undefined
      if (!data?.botName) return null
      return { ...(data as LastBotSender), entryId: entry.id }
    }
    return null
  }

  /**
   * bot 消息落树 —— 一次持锁内**连续 append 两条 entry**：署名侧车在前、assistant 在后。
   *
   * 两者之间不得有任何 await 逃逸点（广播、日志、投影一律移到锁外）：投影层靠「紧邻」
   * 配对它们，中间插进别人的消息就会让署名挂错人 —— 而错挂署名比丢署名更糟。
   *
   * 返回 assistant entry 的 id。
   */
  async appendBotMessage(
    sessionId: string,
    sender: BotSenderSidecar,
    message: { content: string; model?: string; provider?: string }
  ): Promise<string | null> {
    // 投影对 assistant 消息有两处「整条吃掉」的早退（stopReason==='error' / blocks 为空），
    // 落一条投不出来的 entry 只会留下一个无主侧车去污染下一条消息。宁可不落。
    if (!message.content.trim()) {
      log.warn(`bot "${sender.botName}" 的消息内容为空，未落树（session=${sessionId}）`)
      return null
    }
    if (this.blockWrites.has(sessionId)) {
      log.warn(`会话正在关停，拒绝落 bot "${sender.botName}" 的消息（session=${sessionId}）`)
      return null
    }
    this.enter(sessionId)
    try {
      const assistant = {
        role: 'assistant',
        content: [{ type: 'text', text: message.content }],
        // 切片投影里没有 model_change，assistant 消息只能靠自身兜底
        model: message.model ?? '',
        provider: message.provider ?? '',
        stopReason: 'stop'
      } as unknown as AgentMessage

      const ids = await withSessionTreeLock(
        sessionId,
        async (tree) => {
          const sidecarId = await tree.appendCustomEntry(BOT_SENDER_CUSTOM_TYPE, { ...sender })
          const entryId = await tree.appendMessage(assistant)
          return { sidecarId, entryId }
        },
        sessionService.getById(sessionId)?.workingDirectory ?? ''
      )

      const projected = await this.projectSlice(sessionId, [ids.sidecarId, ids.entryId])
      if (projected) {
        electronEventSink.broadcast({
          type: 'assistant_message',
          sessionId,
          messageId: ids.entryId,
          message: JSON.stringify(projected)
        })
      }
      return ids.entryId
    } finally {
      this.leave(sessionId)
    }
  }

  /**
   * 成员的开场白落树（会话创建后由 `session:create` handler await；
   * 中途加成员时由 `updateBots` 只对**新增**的那几个调）。
   *
   * 按成员顺序逐条落；没写 greeting 的成员跳过。`listAll()` 每次现扫全目录，
   * 所以这里只扫一次再按名取，别在循环里反复扫。
   *
   * @param only 只播这几个成员（缺省 = 会话当前的全部成员）
   */
  async seedGreetings(sessionId: string, only?: string[]): Promise<void> {
    const members = sessionService.getById(sessionId)?.settings?.bots ?? []
    // 传了 only 就按 only 的顺序播（它是「新增顺序」，与名单顺序一致）
    const names = only ?? members
    if (!names.length) return
    const byName = new Map(this.listAll().map((b) => [b.file.name, b.file]))
    for (const name of names) {
      const bot = byName.get(name)
      if (!bot?.greeting.trim()) continue
      await this.appendBotMessage(
        sessionId,
        { botName: bot.name, displayName: bot.displayName },
        { content: bot.greeting }
      )
    }
  }

  /**
   * 会师点：Promise 落定时保证**不会再有人写这棵树**（契约对齐 `invalidateAgent`）。
   * `clearMessages` / `rollbackMessage` / `session.delete` 在动树之前一律先 await 它。
   *
   * M3′ 语义 = 排空写锁。管线 run 的级联中止留到 M8′。
   */
  async abortSession(sessionId: string): Promise<void> {
    // 禁写位：drain 只排空**此刻队列里**的写入，挡不住随后拿锁的新写者。管线跑起来之后
    // 那是可达的（脚本还在脱手运行），而三个调用点都拿这个方法当「动树之前的安全前提」
    // **引用计数而不是 Set**：四个入口（回退 / 清空 / 删除会话 / 网关 abort）可以重叠，
    // 而 `whenIdle` 把每次中止的驻留窗口从毫秒级 drain 拉到秒级 —— 先完成的那个若直接
    // 撤掉禁写位，另一个还在等的中止就失去了它赖以成立的前提
    this.blockWrites.set(sessionId, (this.blockWrites.get(sessionId) ?? 0) + 1)
    try {
      for (const t of [...this.tickets.values()]) {
        if (t.sessionId === sessionId) t.abort.abort()
      }
      // barrier 也要拆：不拆的话它的宽限窗定时器会在会话收尾之后才 fire
      for (const b of this.barriers.get(sessionId) ?? []) b.abort()
      // 在飞的询问也要收，并且**关上门**：blockWrites 出了 finally 就没了，而工具可能
      // 在整个 abortSession 落定之后才发出询问
      this.inputsClosed.add(sessionId)
      this.cancelPendingInputs(sessionId)
      this.mailbox.abortSession(sessionId)
      workflowService.abortSessionRuns(sessionId)
      // **先等管线真的停下来,再排空写锁**。drain 只保证「此刻队列里的写入」落完,而一条
      // 还在收尾的管线随时可能再拿一次锁 —— 三个调用点(回退/清空/删除会话)都拿这个方法
      // 当「动树之前的安全前提」,顺序反了等于那个前提只在没有并发时成立
      await this.whenIdle(sessionId)
      await drainSessionTreeLock(sessionId)
    } finally {
      const left = (this.blockWrites.get(sessionId) ?? 1) - 1
      if (left > 0) this.blockWrites.set(sessionId, left)
      else this.blockWrites.delete(sessionId)
    }
  }

  /**
   * 对新 append 的 entry 切片跑投影 —— 广播的内容与 id 都取自它，
   * 「流式所见」因此与「重开所见」逐字段同源。
   *
   * fallback 走 `readSessionRunConfig`（沿分支扫 model_change，与全量投影同一数据源）：
   * 切片里没有 model_change，而 user 消息没有自身归属可兜底。
   */
  private async projectSlice(
    sessionId: string,
    ids: Array<string | null>
  ): Promise<ChatMessage | null> {
    const tree = await getSessionTree(sessionId)
    if (!tree) return null
    // 按调用方给的顺序逐条取，而不是过滤 getEntries()：顺序在这里是语义的一部分
    // （署名侧车必须在前，投影才配得上对），而且 O(1) 取代对整棵树的一次扫描
    const slice: SessionTreeEntry[] = []
    for (const id of ids) {
      if (!id) continue
      const entry = await tree.getEntry(id)
      if (entry) slice.push(entry)
    }
    if (!slice.length) return null
    const cfg = await readSessionRunConfig(sessionId)
    const [projected] = entriesToChatMessages(slice, sessionId, cfg.model ?? '', cfg.provider ?? '')
    return projected ?? null
  }

  getUserDir(): string {
    return this.userDir
  }

  /** 打开 bot 目录（OS 文件管理器；懒创建） */
  async openUserFolder(): Promise<void> {
    if (!existsSync(this.userDir)) mkdirSync(this.userDir, { recursive: true })
    await shell.openPath(this.userDir)
  }
}

export const botService = new BotService()

/**
 * 聊天会话（无根）的询问由这里认领。
 *
 * `claims` 只问「这条会话是不是聊天会话」，**不问此刻有没有在飞的 run** —— 与有根会话那份
 * 参与方（问的是「运行时还活着吗」）刻意不同：那边没有运行时就真的没有可送达的地方，
 * 而这边的送达面是会话本身的输入面板，问的人是派生 agent，它在不在飞由它自己的中止负责。
 * 两个 claims 因此天然互斥：一条会话要么有根 agent、要么 settings.bots 非空。
 */
registerUserInputParticipant({
  name: 'bot',
  claims: (sessionId) => sessionService.isBotSession(sessionId),
  request: (sessionId, request) => botService.requestUserInput(sessionId, request),
  respond: (requestId, response) => botService.respondToInput(requestId, response)
})
