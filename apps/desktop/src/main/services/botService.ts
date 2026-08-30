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
import { existsSync, readdirSync, readFileSync, mkdirSync, unlinkSync } from 'fs'
import { join } from 'path'
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
import type { ChatMessage, InlineToken } from '@shuvix/chat-protocol/types/chatMessage'
import { resolveTokensForAgent } from '@shuvix/chat-protocol/utils/inlineTokens'
import { getDefaultBotsDir } from '../utils/paths'
import { writeFileAtomic } from '../utils/atomicWrite'
import { createLogger } from '../logger'
import {
  addSessionTreePin,
  drainSessionTreeLock,
  getSessionTree,
  readSessionRunConfig,
  withSessionTreeLock
} from './sessionStorage'
import { workflowService } from './workflowService'
import { appendBotDecision, botRunsDir, pruneBotRuns, type BotDecisionKind } from './bot/botJournal'
import { runL0Gate, type L0Record, type LastBotSender } from './bot/botGate'
import { CohortBarrier, type ClaimIntent, type ClaimVerdict } from './bot/botArbiter'
import { BotMailbox, mailboxKey, type QueueItem, type TurnSlot } from './bot/botMailbox'
import { electronEventSink } from './agentRuntimeAdapters'
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

/** 角色回落表 —— bot md 的 `shuvix-bot-agents` 逐键覆盖它 */
const DEFAULT_STAGE_AGENTS = { intent: 'bot-intent', notes: 'bot-notes' } as const

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

export function resolvePipeline(bot: ParsedBotFile): ResolvedPipeline {
  const workflow = bot.pipeline || DEFAULT_BOT_PIPELINE
  return {
    workflow,
    exists: workflowService.hasWorkflow(workflow),
    agents: {
      ...DEFAULT_STAGE_AGENTS,
      task: botSelfRef(bot.name),
      ...bot.agents
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
  /** run 已收尾（超时 / 被中止 / settle）—— `say` 的硬闸，见下 */
  terminal: boolean
  abort: AbortController
  /** meta 到达时回填 */
  runId?: string
}

/**
 * `claim(intent)` 的入参校验。值跨 vm realm 到达，`instanceof` 不可靠 —— 逐字段 typeof。
 * 形状不合法即抛：这是脚本 bug，不是沉默的理由。
 */
function asClaimIntent(raw: unknown): ClaimIntent {
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
 * `say(reply)` 的正文投影。M4′ 只取 headline —— BotReply 的**全键** markdown 投影
 * （含 points / table / followups，需要全键覆盖断言）归 M8′。
 */
function asSayContent(raw: unknown): string {
  if (typeof raw === 'string') return raw
  if (typeof raw === 'object' && raw !== null) {
    const d = raw as Record<string, unknown>
    const head = typeof d.headline === 'string' ? d.headline : ''
    const body = typeof d.body === 'string' ? d.body : ''
    const text = [head, body].filter(Boolean).join('\n\n')
    if (text.trim()) return text
  }
  throw new Error('say(reply): reply must be a non-empty string or carry a headline')
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

  /** 取 md 原文（编辑器数据源） */
  getSource(name: string): { text: string } | { error: string } {
    const target = this.readBotFile(name)
    return target ? { text: target.raw } : { error: `Bot "${name}" not found` }
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

  /** 覆写 bot 文件（`originalName` 定位文件；frontmatter name 为准，可改名） */
  save(originalName: string, text: string): { success: boolean; error?: string } {
    const bots = this.listAll()
    const target = bots.find((b) => b.file.name === originalName)
    if (!target) return { success: false, error: `Bot "${originalName}" not found` }

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
    return { success: true }
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
  private readonly blockWrites = new Set<string>()
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
    if (n > 0) this.inflight.set(sessionId, n)
    else this.inflight.delete(sessionId)
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

      await this.dispatchCohort({
        sessionId,
        text,
        inlineTokens,
        promptText,
        messageId: ids.entryId,
        messageSeq: ids.seq
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
  private async dispatchCohort(ctx: {
    sessionId: string
    text: string
    inlineTokens?: Record<string, InlineToken>
    promptText: string
    messageId: string
    messageSeq: number
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
    if (!gate.cohort.length) return

    const barrier = new CohortBarrier(gate.cohort, {
      onSettled: ({ unresponsive }) => {
        // 定局时连意图都还没交的成员：继续跑纯属烧钱。已 claim 的败者**不**中止 ——
        // 让脚本按 verdict.won === false 自己优雅收尾，`say` 的强制点是兜底
        for (const name of unresponsive) this.ticketOf(sessionId, name, messageSeq)?.abort.abort()
      }
    })

    this.enter(sessionId)
    try {
      await Promise.all(
        gate.cohort.map((botName) =>
          this.runPipeline({
            bot: known.get(botName)!,
            basePath: paths.get(botName) ?? '',
            sessionId,
            messageId,
            messageSeq,
            promptText,
            barrier,
            arbitrated: gate.cohort.length > 1,
            members: gate.cohort
          })
        )
      )
    } finally {
      this.leave(sessionId)
    }
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
    members: string[]
  }): Promise<void> {
    const { bot, sessionId, messageId, messageSeq } = ctx
    const pipeline = resolvePipeline(bot)
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
        { content: `⚠️ 管线 "${pipeline.workflow}" 不存在或无法解析，这条消息没有被处理。` }
      )
      return
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
          session: { id: sessionId, arbitrated: ctx.arbitrated, members: ctx.members },
          message: { id: messageId, seq: messageSeq, text: ctx.promptText },
          notes: bot.notes ?? ''
        },
        extraApi: this.makeBotApi(ticket)
        // reentry 一个字都不传：独占 100% 由 mailbox 提供，引擎重入彻底让位。
        // 只给 mode 不给 key 静默无效，而显式传 mode 等于替用户的管线 md 做主
      })

      if (!result.started) {
        decide(result.reason === 'invalid-input' ? 'pipeline_invalid_input' : 'pipeline_error', {
          reason: result.reason,
          error: result.error
        })
      } else {
        decide('run_end', {
          ok: result.ok,
          outcome: (result.output as { outcome?: string } | undefined)?.outcome,
          error: result.error,
          ms: Date.now() - startedAt
        })
      }
      this.activity(ticket, 'ended', result.started ? (result.ok ? 'ok' : 'failed') : result.reason)
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
        decide(
          verdict.reason === 'solo'
            ? 'claim_solo'
            : verdict.won
              ? 'claim_won'
              : verdict.reason === 'ignored'
                ? 'claim_ignored'
                : verdict.reason === 'timeout'
                  ? 'claim_timeout'
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
        if (typeof fn !== 'function') {
          // 裸形式：由 run 收尾时释放（runPipeline 的 finally）
          return { ...slot }
        }
        try {
          return await (fn as (s: TurnSlot) => Promise<unknown>)({ ...slot })
        } finally {
          this.mailbox.releaseByTicket(ticket.ticketId)
        }
      },

      say: async (raw: unknown): Promise<{ messageId: string | null }> => {
        // ① run 已收尾：引擎只是 race 输掉，node:vm 无法硬中断异步续体，脚本还在脱手跑。
        //    少了这条闸，会出现「journal 记为超时失败、会话里却多出一条消息」的分叉
        if (ticket.terminal) throw new Error('this run has already ended')
        if (this.blockWrites.has(ticket.sessionId)) throw new Error('session is being torn down')
        // ② 仲裁的**唯一强制点**：claim 返回 false 只是建议，落树才是有外部后果的动作
        if (ticket.claimState === 'lost') {
          decide('arbitration_lost')
          throw new Error('another bot won this message')
        }
        if (ticket.claimState === 'none' && !ticket.barrier.isSolo) {
          // 隐式入场 = 给「不调 claim」发一张永远赢的票
          decide('arbitration_bypassed')
          throw new Error('call claim() before say() in a multi-bot session')
        }
        const content = asSayContent(raw)
        const messageId = await this.appendBotMessage(
          ticket.sessionId,
          { botName: ticket.botName, displayName: ticket.displayName },
          { content }
        )
        if (messageId) this.mailbox.noteReplied(key, ticket.messageSeq)
        return { messageId }
      }
    }
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
    this.blockWrites.add(sessionId)
    try {
      for (const t of [...this.tickets.values()]) {
        if (t.sessionId === sessionId) t.abort.abort()
      }
      this.mailbox.abortSession(sessionId)
      workflowService.abortSessionRuns(sessionId)
      await drainSessionTreeLock(sessionId)
    } finally {
      this.blockWrites.delete(sessionId)
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
