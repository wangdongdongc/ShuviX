/**
 * BotService —— bot 注册表（桌面宿主层）。设计见 docs/bot-design.md §4。
 *
 * 本文件有三半 ——
 *  - **注册表半边**：扫描 / md 原文读写 / 非法文件修复通道 / 新建模板；
 *  - **消息半边**：无根会话的用户消息落盘、bot 消息的 append、在飞计数与 abortSession 会师点；
 *  - **管线半边**：L0 门 → cohort → 每成员一次 invoke，以及装配进脚本的 `turn` / `say`
 *    两个回调。L0 门与 mailbox 的算法在 `bot/` 下各自成件。
 *
 * **一个 bot 是一份绑定**：身份 + 管线 workflow + 槽位表（槽位 → agent md）+ 正文。
 * 正文是它的人设与记忆，由 `renderBotContext` 围栏后随 invoke 的 `systemContext` 带给
 * 这次 run 派发的每一个 agent（门控、复核、任务段都拿同一份），并由 bot 自己维护 ——
 * 任务段 agent 拿自己的文件工具就地改这份 md。没有笔记段、没有开场白、没有逐 bot 的
 * 门控模式：每个成员都进 cohort，「这条与我无关」由它自己的意图段说。
 *
 * **不内置任何 bot**（设计 §4.2）：内置的只有管线 workflow（`bot-chat`）与门控段 agent
 * （`bot-intent`）。因此这里没有 agent/workflow/policy 三件套那种「内置 + 用户同名覆盖」
 * 的两源合并 —— 目录里有什么就是什么，少一整个概念。「新建 bot」由 `newBotTemplate()`
 * 用内置件填一份模板，用户取个名字即可（§4.6）。
 *
 * 写盘一律**原子写**（`writeFileAtomic`）：bot 在答话途中会改自己的文件，而 `scanDir`
 * 随时可能读进来 —— `writeFileSync` 的「先截断再写」会让 bot 在注册表里瞬时消失并落进
 * invalid 双轨。
 */
import { existsSync, readdirSync, readFileSync, mkdirSync, renameSync, unlinkSync } from 'fs'
import { createHash } from 'crypto'
import { basename, join } from 'path'
import { v4 as uuidv4 } from 'uuid'
import { shell } from 'electron'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import {
  DEFAULT_BOT_PIPELINE,
  parseBotDefinitionFile,
  renderBotContext,
  serializeBotDefinitionFile,
  type ParsedBotFile,
  type PipelineAgentSlot
} from '@shuvix/agent-runtime'
import type { AgentPromptParams } from '@shuvix/chat-protocol/chatApi'
import type { InputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import type { InlineToken } from '@shuvix/chat-protocol/types/chatMessage'
import { resolveTokensForAgent } from '@shuvix/chat-protocol/utils/inlineTokens'
import { botReplyToMarkdown, coerceBotReply } from '@shuvix/chat-protocol/botReply'
import { getDefaultBotsDir } from '../utils/paths'
import { writeFileAtomic } from '../utils/atomicWrite'
import { recordRead } from '../utils/toolUtils/fileTime'
import { createLogger } from '../logger'
import { t } from '../i18n'
import { chatMessageDao } from '../dao/chatMessageDao'
import { rowToChatMessage } from './chatMessageProjection'
import { setChatSessionPredicate } from './messageService'
import { readChatAttachment, saveChatAttachments } from './chatAttachments'
import { workflowService, workflowTriggers } from './workflowService'
import { agentService } from './agentService'
import { buildTurnCompletedFacts, isDefaultTitle } from './sessionTriggerFacts'
import { appendBotDecision, botRunsDir, pruneBotRuns, type BotDecisionKind } from './bot/botJournal'
import { runL0Gate, type L0Record, type LastBotSender } from './bot/botGate'
import { BotMailbox, mailboxKey, type QueueItem, type TurnSlot } from './bot/botMailbox'
import { electronEventSink } from './agentRuntimeAdapters'
import { registerUserInputParticipant } from './userInputBroker'
import { chatFrontendRegistry } from '../frontend/core/ChatFrontendRegistry'
import { sessionService } from './sessionService'

const log = createLogger('Bot')

/**
 * 设置页列表项 —— 刻意**不外传**正文：列表只需要「是谁、干什么、用哪条管线、槽位填了谁」，
 * 编辑走 getSource 拿整份 md 原文（与 agent/workflow/policy 设置页同形：详情即原文编辑器）。
 */
export interface BotListItem {
  name: string
  displayName: string
  description: string
  /** 管线框架（workflow 名） */
  pipeline: string
  /** 槽位 → agent 名（bot md 的 shuvix-bot-agents 原样） */
  agents: Record<string, string>
  /** 正文（人设与记忆）字符数 —— 它进每个参与 agent 的系统提示词，设置页据此提醒体量 */
  bodyChars: number
  /** 文件路径 */
  basePath: string
  /** 解析器接受但有话说的提示（不影响可用性；设置页显示为提示） */
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

/**
 * 内置门控段 —— 门控连续故障时的回落人选，也是新建模板给 `intent` 槽位预填的名字。
 * **不是缺省表**：槽位由 bot md 逐一填写，漏填必填槽位由管线的输入校验拦下并在会话里说出来。
 */
export const BUILTIN_GATE_AGENT = 'bot-intent'
/** 新建模板给 `task` 槽位预填的名字 —— 主会话基座档案，工具最全的那份通用 agent */
export const DEFAULT_TASK_AGENT = 'default'

export interface ResolvedPipeline {
  workflow: string
  /** 注册表里有没有这份管线 —— 派发之前就能判，不必靠事后的 not-found */
  exists: boolean
  /** 管线声明的槽位（顺序即声明序）；管线不存在或没声明 = [] */
  slots: PipelineAgentSlot[]
  /** 槽位 → agent 名：bot md 的 `shuvix-bot-agents` 原样，加上回落覆盖 */
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
    slots: workflowService.agentSlots(workflow),
    agents: {
      ...bot.agents,
      // 回落覆盖用户的 shuvix-bot-agents —— 它正是「那份不可靠的门控 agent」的来源
      ...overrides
    }
  }
}

/**
 * 一次「某个 bot 应答某条消息」的全部身份与状态。
 *
 * **它先于 invoke 存在，所以 `turn`/`say` 的闭包固化的是它，不是 runId** ——
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
  /** run 已收尾（超时 / 被中止）—— `say` 的硬闸，见下 */
  terminal: boolean
  /** 本 ticket 已经往会话里说过话 —— 可见结局兜底据此决定要不要再补一条失败气泡 */
  said: boolean
  abort: AbortController
  /** meta 到达时回填 */
  runId?: string
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

/**
 * 一个成员这一轮的结局 —— v2 起只进 run journal（没有仲裁，也就没有需要汇总定性的
 * 「全体沉默」）。`outcome` 取脚本自报的值，脚本没报就用 run 本身怎么收的；
 * **刻意不归一成一张封闭表** —— 自定义管线的 outcome 本就是开放的。
 */
interface MemberOutcome {
  botName: string
  displayName: string
  /** 这个成员往会话里放了东西没有（一条回复、或一条可见失败） */
  said: boolean
  outcome: string
}

/** 一条 bot 消息的署名与附带结构（写进 chat_messages 的那几列） */
interface BotSender {
  botName: string
  displayName: string
  /** 意图段判定（clarify 回连的判定材料） */
  decision?: string
  /** BotReply 结构化原文，仅供 UI */
  reply?: unknown
  /** 失败 / 降级通告 */
  error?: true
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
  /** 承载附件的那条消息（chat_messages 的行 id） */
  messageId: string
  /** 该消息附件数组里的下标 */
  index: number
  mimeType: string
}

/** 行里的 inlineTokens 是 JSON 字符串；坏 JSON 当作没有，不让一条消息读不出来 */
function parseInlineTokens(raw?: string): Record<string, InlineToken> | undefined {
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as Record<string, InlineToken>
  } catch {
    return undefined
  }
}

/**
 * 一份 md 原文的版本指纹。
 *
 * 用内容哈希而不是 mtime：bot 的自我编辑与用户的保存可以落在同一秒里，而 mtime 的分辨率
 * 恰好会把这种情况判成「没变」——那正是要拦的那一种。
 */
function revisionOf(raw: string): string {
  return createHash('sha256').update(raw).digest('hex').slice(0, 16)
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
      // warn 通道同时收「拒绝理由」与「接受但有话说」；
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

  /** 按名取原始文件内容与路径（未知名返回 null） */
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
        agents: { ...file.agents },
        bodyChars: file.body.length,
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
   * 设置页详情的**运行时读数**（`bot:inspect`）：管线与各槽位的解析结果、门控 sticky 降级、
   * 正文用量。frontmatter 本身归属性卡（bot 描述符），这里只回答「按现在的注册表状态，
   * 这个 bot 跑起来会解析成什么」—— 引用缺失之类的事实埋在 journal 里不算呈现（§8.5）。
   */
  inspect(name: string):
    | {
        pipeline: { name: string; exists: boolean; concurrency?: string }
        /**
         * 管线声明的每个槽位 + bot 填的 agent 名；bot 额外填了管线没声明的槽位也列出
         * （required=false）。ref 缺省 = 没填；missing = 填了但那个 agent 不存在。
         */
        slots: Array<{
          role: string
          required: boolean
          description?: string
          ref?: string
          missing: boolean
        }>
        /** 门控段已 sticky 回落内置的原因（broken / timeout）；未降级则缺省 */
        gateDegraded?: string
        /** 正文（人设与记忆）的用量 —— 它进每个参与 agent 的系统提示词 */
        body: { chars: number }
      }
    | { error: string } {
    const bot = this.getBot(name)
    if (!bot) return { error: `Bot "${name}" not found` }
    const pipeline = resolvePipeline(bot)
    // 生效的那一份 workflow（用户同名遮蔽内置）：取未被遮蔽的条目读并发模式
    const wf = workflowService
      .listForSettings()
      .find((w) => w.name === pipeline.workflow && !w.overridden)
    const declared = new Set(pipeline.slots.map((s) => s.role))
    const extra = Object.keys(bot.agents)
      .filter((role) => !declared.has(role))
      .map((role): PipelineAgentSlot => ({ role, required: false }))
    const slots = [...pipeline.slots, ...extra].map((slot) => {
      const ref = bot.agents[slot.role]
      return {
        ...slot,
        ...(ref ? { ref } : {}),
        missing: !!ref && !agentService.getProfile(ref)
      }
    })
    const degraded = this.gateDegradedOf(name)
    return {
      pipeline: { name: pipeline.workflow, exists: pipeline.exists, concurrency: wf?.concurrency },
      slots,
      ...(degraded ? { gateDegraded: degraded } : {}),
      body: { chars: bot.body.length }
    }
  }

  /**
   * 取 md 原文（编辑器数据源），连同一枚**版本指纹**。
   *
   * 指纹是给 `save` 用的:bot 会在答话途中改这份文件,而用户可能在那之前就打开了编辑器。
   * 没有它,「T0 打开 → T1 bot 改 → T2 用户保存」会把 T1 的改动整份吃掉,而且是静默的。
   * `edit` 工具自带的「读后被改」检测保护的是 agent 那一侧,反方向从来没有人守。
   */
  getSource(name: string): { text: string; revision: string } | { error: string } {
    const target = this.readBotFile(name)
    if (!target) return { error: `Bot "${name}" not found` }
    return { text: target.raw, revision: revisionOf(target.raw) }
  }

  /**
   * 写盘前解析校验。**非法一律拒绝**：一份存在但非法的 bot 会被扫描跳过，与其让它躺在
   * 磁盘上假装可用，不如把原因交回 UI。
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
   * 几乎总是 bot 自己干的 —— 此时**拒绝并让 UI 去解决冲突**，而不是让后写的一方赢。
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
      // **按路径读而不是按名字查**：bot 拿的是普通 `edit`，改得动 frontmatter 的
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
          error:
            'This bot changed on disk since you opened it — most likely the bot itself, updating its own profile.',
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
   * bot 的身份是 frontmatter 里的 `name`，而这个名字被两处引用：会话的 `settings.bots`
   * 成员名单、决策记录与 run journal 的目录。**不迁的话改一次名等于把这个 bot 从所有
   * 会话里删掉** —— L0 门会把它当成「成员 md 不存在」，而用户看到的是「我只是改了个名字」。
   *
   * **幂等**：每一步都先看目标状态再动手，重复跑一遍不会出错 —— 迁移做了一半崩掉时，
   * 下一次保存（或用户手动改回来再改过去）能把剩下的补上。
   *
   * 历史消息里的署名**不迁**，那是刻意的：消息行存着落库当时的 displayName，历史不该因为
   * 今天的一次改名而改写（这条纪律从 M3′ 的署名侧车起就在，v2 换成表之后原样保留）。
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
   * 「新建 bot」的模板 —— 用内置管线填一份可直接落盘的 md，两个必填槽位预填
   * 内置门控（`bot-intent`）与主会话基座档案（`default`）。
   *
   * 这是「不内置 bot」的另一半（设计 §4.2）：用户不必从空文件起步，取个名字 + 写句人设
   * 就有一个能用的 bot；而内置件的更新照常跟随版本，不会被一份 fork 出来的副本冻住。
   */
  newBotTemplate(params: { name: string; description?: string; persona?: string }): string {
    const persona =
      params.persona?.trim() ||
      `你是 ${params.name}。（在这里写它的人设与纪律。这份正文会追加到替它做事的每个 agent 的系统提示词里，bot 自己也会把学到的东西写进来。）`
    return serializeBotDefinitionFile({
      name: params.name,
      displayName: params.name,
      description: params.description?.trim() || `${params.name} —— 描述这个 bot 负责什么`,
      body: persona,
      pipeline: DEFAULT_BOT_PIPELINE,
      pipelineInput: {},
      agents: { intent: BUILTIN_GATE_AGENT, task: DEFAULT_TASK_AGENT }
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

  /** 在飞 ticket（per-bot 停止、会话级中止、journal 关联都查它） */
  private readonly tickets = new Map<string, BotTicket>()
  /** 已经硬路由过的 clarify entry —— 一条 clarify 只回连一次 */
  private readonly clarifyConsumed = new Map<string, Set<string>>()
  /** 禁写位：`abortSession` 期间 `say` 一律硬失败（drain 只排空队列，挡不住新写者） */
  private readonly blockWrites = new Map<string, number>()
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
    // 「这是不是聊天会话」的判据注入 messageService（v2）：它据此在会话树与
    // chat_messages 表之间分流，自己不依赖 dao 层。装配放在 init 而不是构造期 ——
    // 构造期调用会让「mock 了 messageService 却没提供这个导出」的单测整片挂掉，
    // 与 workflowService.init 的时机选择同一条理由（避免 ESM 初始化环与构造期耦合）
    setChatSessionPredicate((sessionId) => sessionService.isBotSession(sessionId))

    // v2 起聊天会话不再有会话树 —— 那条「在飞时钉住树、别被 LRU 逐出」的注册随之取消。
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
   * 的字段等于给自己开一张假证明。
   */
  async handleUserMessage(params: AgentPromptParams): Promise<void> {
    const { sessionId, text, images, inlineTokens } = params
    // 新消息 = 重新开门（对照 HarnessSession.prompt 里的 inputsClosed 复位）。
    // 中止只该管住那一轮，不是把这条会话的询问永久拒收
    this.inputsClosed.delete(sessionId)
    this.enter(sessionId)
    try {
      // LLM 看到的是展开后的全文（管线 input 用它）；行里存标记态原文 + tokens 字典，
      // 展开在读侧现做 —— 与 v1 投影的口径一致，只是不再需要一条独立的显示侧车
      const hasTokens = !!inlineTokens && Object.keys(inlineTokens).length > 0
      const promptText = hasTokens ? resolveTokensForAgent(text, inlineTokens) : text
      const display = hasTokens

      // 附件先落盘（文件名要用消息 id，所以 id 提前生成），行里只留描述符
      const messageId = uuidv4()
      const attachments = saveChatAttachments(sessionId, messageId, images ?? [])

      // **content 存标记态原文**（内联 token 未展开）+ tokens 字典：UI 据此渲染胶囊，
      // 喂给模型的展开由读侧的 resolveTokensForAgent 现做（同 v1 投影的口径）。
      // seq 由 DAO 在事务内分配 —— v1 为这件事维护的那套异步互斥不再需要
      const row = chatMessageDao.append({
        id: messageId,
        sessionId,
        authorKind: 'user',
        content: text,
        ...(display ? { inlineTokens: JSON.stringify(inlineTokens) } : {}),
        ...(attachments.length ? { attachments } : {})
      })

      electronEventSink.broadcast({
        type: 'user_message',
        sessionId,
        message: JSON.stringify(rowToChatMessage(row))
      })

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
        messageId: row.id,
        messageSeq: row.seq,
        // **只带描述符，不带字节**：脚本的 input 会被原样写进 run journal（meta 记录带着
        // 整个 envelope），让 base64 进 input 等于每条带图消息都在磁盘上留下一份逐 bot 的
        // 副本。真正的字节由 resolveAttachments 在派发那一刻按索引回读文件
        attachments: attachments.map((_, i) => ({
          sessionId,
          messageId: row.id,
          index: i,
          mimeType: attachments[i].mimeType
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
   * **带上限**:中止已经把 ticket / mailbox / run 全拆了,正常情况下这里几乎
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
    const scanned = this.listAll()
    const known = new Map(scanned.map((b) => [b.file.name, b.file]))
    const paths = new Map(scanned.map((b) => [b.file.name, b.basePath]))

    const gate = runL0Gate({
      members,
      known,
      text: ctx.text,
      inlineTokens: ctx.inlineTokens,
      lastBotSender: this.lastBotSender(sessionId),
      clarifyConsumed: this.clarifyConsumed.get(sessionId) ?? new Set()
    })
    this.recordL0(sessionId, messageId, messageSeq, gate.records)
    if (gate.consumedClarifyEntryId) {
      const seen = this.clarifyConsumed.get(sessionId) ?? new Set<string>()
      seen.add(gate.consumedClarifyEntryId)
      this.clarifyConsumed.set(sessionId, seen)
    }
    if (!gate.cohort.length) {
      // L0 把所有成员都筛掉了（名单里的 md 全没了）——**这一轮仍然算结束**。
      // 有根会话那侧的契约是「无论成败恒触发」，两边在「什么时候算一轮」上错开，订阅方
      // 看到的就是「某类会话的工作流莫名其妙不触发」
      await this.fireTurnCompleted(sessionId, members)
      return
    }

    // 窗口只建一次，切好之后发给每个成员 —— 它要读一遍会话树 + 跑一次投影
    const window = await this.buildWindow(sessionId, messageId)

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
            // 「这条消息点名了我吗」—— 契约选择的判据（定向的消息不给 ignore）
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

      // 全员收尾之后才算「一轮结束」——聊天会话的一轮是 cohort 整体，不是某个成员。
      // **在 finally 之前**：放到在飞计数之外的话，`abortSession` 的会师点可以在这次
      // fire 还在飞时就落定，于是 auto-title 能在一个正在被删除/清空的会话上新起一个 run
      await this.fireTurnCompleted(sessionId, members)
    } finally {
      this.leave(sessionId)
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
  private buildWindow(
    sessionId: string,
    untilMessageId?: string
  ): { lines: string[]; after: (messageId: string) => string[] } {
    const rows = chatMessageDao.findBySession(sessionId)
    const cut = untilMessageId ? rows.findIndex((r) => r.id === untilMessageId) : -1
    const upTo = cut >= 0 ? rows.slice(0, cut) : rows
    const lineOf = (r: (typeof rows)[number]): string => {
      // 谁说的直接是列 —— v1 要先投影成 ChatMessage 再从 metadata.sender 里挖
      const who = r.authorKind === 'user' ? 'User' : (r.displayName ?? r.botName ?? 'Assistant')
      // user 行的 content 是标记态原文（内联 Token 未展开）—— 还原成人读文本
      const text =
        r.authorKind === 'user'
          ? resolveTokensForAgent(r.content, parseInlineTokens(r.inlineTokens))
          : r.content
      return `${who}: ${String(text ?? '').trim()}`
    }
    const speaking = (r: (typeof rows)[number]): boolean => r.authorKind !== 'system'
    return {
      lines: upTo.filter(speaking).map(lineOf),
      after: (messageId: string) => {
        const at = rows.findIndex((r) => r.id === messageId)
        if (at < 0) return []
        return rows
          .slice(at + 1)
          .filter(speaking)
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
      log.warn(
        `bot "${botName}" 的门控段连续 ${health.streak} 次故障，已回落内置 ${BUILTIN_GATE_AGENT}`
      )
      // 回落是**会话里看得见的行为改变**（设计 §6.1）：这个 bot 从此不再用用户指定的门控
      // agent 了。只落 journal + 设置页徽标的话,用户看到的是「它忽然变得不一样了」而
      // 线索埋在文件系统里。回落是 sticky 的,所以这条一个进程只出一次
      this.appendBotMessage(
        ticket.sessionId,
        { botName, displayName: ticket.displayName, error: true },
        { content: t('bot.gateFallback', { name: ticket.displayName, count: health.streak }) },
        { replyToId: ticket.messageId }
      ).catch((e) => log.warn(`回落提示落库失败 (${botName}):`, e))
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
    directed: boolean
    members: string[]
    known: Map<string, ParsedBotFile>
    window: { lines: string[]; after: (messageId: string) => string[] }
    attachments?: BotAttachmentRef[]
  }): Promise<MemberOutcome> {
    const { bot, sessionId, messageId, messageSeq } = ctx
    // 连续故障之后回落内置门控：用户覆盖的 `shuvix-bot-agents.intent` 让位
    const degraded = this.gateHealth.get(bot.name)?.degraded
    const pipeline = resolvePipeline(bot, degraded ? { intent: BUILTIN_GATE_AGENT } : undefined)
    const ticket: BotTicket = {
      ticketId: `bt-${uuidv4()}`,
      sessionId,
      botName: bot.name,
      displayName: bot.displayName,
      messageSeq,
      messageId,
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
        { botName: bot.name, displayName: bot.displayName, error: true },
        { content: t('bot.pipelineMissing', { pipeline: pipeline.workflow }) },
        { replyToId: messageId }
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
      // 正文已经在每个参与 agent 的系统提示词里了 —— 对文件工具而言这就是「读过」：
      // 派发前替这条会话记一笔读取时间，任务段直接 `edit` 自己的 md 不必先 `read`
      // （派生 agent 的 fileTime 归根会话，即这条聊天会话）。文件在注入之后被别人改过，
      // edit 照样拒绝 —— 保障不变，只是省掉一次毫无信息量的读。
      if (ctx.basePath) recordRead(sessionId, ctx.basePath)
      const result = await workflowService.invoke({
        workflow: pipeline.workflow,
        // 漏传 sessionId 是静默降级：会话授权恒空、工作区落临时目录、ask 变成工具错误
        sessionId,
        label: ticket.ticketId,
        signal: ticket.abort.signal,
        input: {
          ...bot.pipelineInput,
          // 宿主键铺在用户的 shuvix-bot-input 之后 —— 一份 bot md 不得改写 session.id 这类事实
          bot: {
            name: bot.name,
            displayName: bot.displayName,
            description: bot.description,
            file: ctx.basePath
          },
          agents: pipeline.agents,
          session: {
            id: sessionId,
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
          }
        },
        extraApi: this.makeBotApi(ticket),
        // bot 的人设与记忆：这次 run 派发的每一个 agent 都在系统提示词末尾拿到同一份
        systemContext: [
          renderBotContext({
            name: bot.name,
            displayName: bot.displayName,
            file: ctx.basePath,
            body: bot.body
          })
        ]
        // reentry 一个字都不传：独占 100% 由 mailbox 提供，引擎重入彻底让位。
        // 只给 mode 不给 key 静默无效，而显式传 mode 等于替用户的管线 md 做主
      })

      const output = result.output as { outcome?: string; gate?: string } | undefined
      if (!result.started) {
        decide(result.reason === 'invalid-input' ? 'pipeline_invalid_input' : 'pipeline_error', {
          reason: result.reason,
          error: result.error
        })
        if (result.reason === 'invalid-input') {
          // 入参被管线拒绝 —— 几乎总是槽位没填全（`agents.task` 之类）。这是配置错，不是
          // 「跑到一半坏了」：把管线的原话说出来，用户才知道该去改哪一行，而不是通用的
          // 「没能处理完」
          await this.appendBotMessage(
            sessionId,
            { botName: bot.name, displayName: bot.displayName, error: true },
            {
              content: t('bot.pipelineInvalidInput', {
                name: bot.displayName,
                error: result.error ?? 'invalid input'
              })
            },
            { replyToId: messageId }
          )
          ticket.said = true
        }
      } else {
        this.noteGateHealth(bot.name, output?.gate, ticket)
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
      // v2 起**每个 bot 各自为自己的结局负责**：没有胜者，也就没有「只让胜者出声」
      // 那条规则。它自己坏了就自己说 —— N 个同时坏就是 N 条错误气泡，在群聊形态下
      // 这是正确的（每个成员各说各的），且失败本就罕见。
      // 用户按的停止不在此列：那不是「无从解释的沉默」（设计 §9.1）
      if (!result.ok && !ticket.said && !ticket.abort.signal.aborted) {
        await this.appendBotMessage(
          sessionId,
          {
            botName: bot.name,
            displayName: bot.displayName,
            error: true
          },
          { content: t('bot.runFailed', { name: bot.displayName }) },
          { replyToId: ticket.messageId }
        )
        ticket.said = true
      }
      const ended = result.started ? (result.ok ? 'ok' : 'failed') : (result.reason ?? 'error')
      this.activity(ticket, 'ended', ended)
      return {
        botName: bot.name,
        displayName: bot.displayName,
        said: ticket.said,
        // 脚本自报优先，没报就用 run 本身怎么收的
        outcome: output?.outcome || ended
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
   * 装配进脚本 API 的两个回调（v2 去掉 `claim` —— 没有仲裁了）。
   *
   * 值跨 vm realm 到达 —— `instanceof` 不可靠，一律逐字段 typeof 校验 + JSON 克隆。
   */
  private makeBotApi(ticket: BotTicket): Record<string, unknown> {
    const key = mailboxKey(ticket.sessionId, ticket.botName)

    return {
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
        // v2 起 say 就是纯粹的落库动作：没有仲裁，也就没有「赢了才能说」这道强制
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
            // 行里存**校验过**的结构，与 content 里那份 markdown 同源（content 由
            // botReplyToMarkdown 得来）—— 读写两侧同一个形状，UI 不必再自己防一遍
            ...(botReply ? { reply: botReply } : {}),
            // 脚本降级出声（门控破损/超时、任务失败等）—— 失败卡样式的数据源
            ...(o.error === true ? { error: true as const } : {})
          },
          { content },
          { replyToId: ticket.messageId }
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
   * 句柄是**自包含**的（会话 + 消息 + 第几张）：引擎那一层没有会话上下文，它只是把脚本
   * 转交的值原样递过来。字节**按需从盘上回读而不是在内存里另存一份** —— 消息可能在
   * mailbox 里排很久才轮到任务段，而盘上那份是这些字节唯一的权威副本；内存缓存要么跟着
   * 排队时长一起泄漏，要么在超时那一刻恰好被清掉。
   *
   * 取不到就跳过那一张（少一张图的回答好过没有回答），不抛。
   */
  async resolveAttachments(refs: unknown[], ownerSessionId?: string): Promise<AgentMessage[]> {
    const wanted = new Map<string, { sessionId: string; messageId: string; indexes: number[] }>()
    for (const raw of refs) {
      if (typeof raw !== 'object' || raw === null) continue
      const d = raw as { sessionId?: unknown; messageId?: unknown; index?: unknown }
      if (typeof d.sessionId !== 'string' || !d.sessionId) continue
      // **只读本次 run 归属的那条会话**：句柄来自脚本，而脚本是用户写的 md —— 不设这道
      // 闸，任何工作流都能写一个指向别的会话的句柄，把那边的图片拉进本次上下文。不是越权
      // （会话都是同一个用户的），但「附件」这个词不该悄悄含有跨会话读取的意思
      if (ownerSessionId && d.sessionId !== ownerSessionId) {
        log.warn(`附件句柄指向别的会话，已忽略：${d.sessionId}`)
        continue
      }
      if (typeof d.messageId !== 'string' || !d.messageId) continue
      if (!Number.isInteger(d.index) || (d.index as number) < 0) continue
      const key = `${d.sessionId}\u0000${d.messageId}`
      const slot = wanted.get(key) ?? {
        sessionId: d.sessionId,
        messageId: d.messageId,
        indexes: [] as number[]
      }
      slot.indexes.push(d.index as number)
      wanted.set(key, slot)
    }
    if (!wanted.size) return []

    const out: Array<{ type: 'image'; data: string; mimeType: string }> = []
    for (const { sessionId, messageId, indexes } of wanted.values()) {
      try {
        const row = chatMessageDao.findById(messageId)
        if (!row || row.sessionId !== sessionId) continue
        const attachments = row.attachments ?? []
        for (const i of indexes) {
          const ref = attachments[i]
          if (!ref) continue
          // 字节在盘上：行里只有描述符（不把 base64 塞进表，见 chatAttachments 的说明）
          const bytes = readChatAttachment(sessionId, ref)
          if (bytes) out.push({ type: 'image', ...bytes })
        }
      } catch (e) {
        log.warn(`附件回读失败 session=${sessionId} message=${messageId}:`, e)
      }
    }
    if (!out.length) return []
    // 一条 user 消息装全部图片：模型看到的是「用户随这条消息附了这些图」，拆成多条会让
    // 上下文里凭空多出几轮对话
    return [{ role: 'user', content: out } as AgentMessage]
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

  private activity(
    ticket: BotTicket,
    phase: 'started' | 'queued' | 'working' | 'silent' | 'ended',
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
  private lastBotSender(sessionId: string): LastBotSender | null {
    const row = chatMessageDao.findLastBot(sessionId)
    if (!row?.botName) return null
    return {
      botName: row.botName,
      displayName: row.displayName ?? row.botName,
      ...(row.decision ? { decision: row.decision } : {}),
      entryId: row.id
    }
  }

  /**
   * bot 消息落库 —— 一行，一次同步事务（seq 在事务里分配）。
   *
   * v1 这里要在一次持锁内连着写两条 entry（署名侧车在前、assistant 在后，投影靠「紧邻」
   * 把它们配对），中间不许有任何 await 逃逸点，否则署名会挂到别人头上。v2 把「谁说的」
   * 变成行上的两列，那套纪律连同它要防的故障一起消失了。
   *
   * `origin` 是「这条在回应什么」（replyToId 列）。**bot 的回复不触发 bot**：这里只落库
   * 广播，不回灌任何门 —— 与 `handleUserMessage` 两条路根本不交汇，由结构保证。
   *
   * 返回消息 id；空正文或会话正在关停时返回 null。
   */
  async appendBotMessage(
    sessionId: string,
    sender: BotSender,
    message: { content: string },
    origin?: { replyToId?: string }
  ): Promise<string | null> {
    // 空正文投不成一条可读消息，落进去只会在会话里留一个空气泡。宁可不落。
    if (!message.content.trim()) {
      log.warn(`bot "${sender.botName}" 的消息内容为空，未落库（session=${sessionId}）`)
      return null
    }
    if (this.blockWrites.has(sessionId)) {
      log.warn(`会话正在关停，拒绝落 bot "${sender.botName}" 的消息（session=${sessionId}）`)
      return null
    }
    this.enter(sessionId)
    try {
      const row = chatMessageDao.append({
        sessionId,
        authorKind: 'bot',
        botName: sender.botName,
        displayName: sender.displayName,
        content: message.content,
        ...(sender.decision ? { decision: sender.decision } : {}),
        ...(sender.reply ? { reply: JSON.stringify(sender.reply) } : {}),
        ...(sender.error === true ? { isError: true } : {}),
        ...(origin?.replyToId ? { replyToId: origin.replyToId } : {})
      })

      electronEventSink.broadcast({
        type: 'assistant_message',
        sessionId,
        messageId: row.id,
        message: JSON.stringify(rowToChatMessage(row))
      })
      // 会话侧账（A4）：未读 +1、updatedAt 上浮、列表广播。正在看的一侧随后 markRead 清零
      sessionService.noteUnreadBotReply(sessionId)
      return row.id
    } finally {
      this.leave(sessionId)
    }
  }

  /**
   * per-bot 停止（A2，设计 §5.4「中止粒度到 bot」）：中止某个成员**对某条消息**的应答。
   *
   * 粒度到 (bot, 消息) 而不是整个 bot：占位卡是 per-(bot,消息) 的面，「停止」停的是
   * 卡上那件事。**不清 mailbox、不丢消息** —— 该 bot 为其它消息排着的队原样保留
   * （UI 也只在 claimed/working 卡上给停止钮，排队卡是纯信息）；防御性地仍调
   * `mailbox.abortTicket`：万一目标票正排着队，引擎的 run 级 abort 唤不醒 await 在
   * 宿主 Promise 上的脚本，不拒绝它就只能等排队超时。
   *
   * 不动 barrier：停止钮只出现在 claim 已定的相位上；claim 未定的票撑死再等 3s 宽限窗。
   * 失败气泡被 `!ticket.abort.signal.aborted` 守卫压掉 —— 用户按的停止不是「无从解释的
   * 沉默」（§9.1），结局进决策记录。
   */
  abortBot(sessionId: string, botName: string, messageId: string): boolean {
    let hit = false
    for (const t of [...this.tickets.values()]) {
      if (t.sessionId !== sessionId || t.botName !== botName || t.messageId !== messageId) continue
      hit = true
      t.abort.abort()
      this.mailbox.abortTicket(t.ticketId)
    }
    if (!hit) {
      log.info(`abortBot 未命中在飞票（session=${sessionId} bot=${botName}）—— 多半已收尾`)
    }
    return hit
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
      // 在飞的询问也要收，并且**关上门**：blockWrites 出了 finally 就没了，而工具可能
      // 在整个 abortSession 落定之后才发出询问
      this.inputsClosed.add(sessionId)
      this.cancelPendingInputs(sessionId)
      this.mailbox.abortSession(sessionId)
      workflowService.abortSessionRuns(sessionId)
      // 等管线真的停下来。v1 这里还要排空会话树的写锁 —— 那条保证在管线成为长命写者
      // 之后本来就已经悄悄失效（drain 只排空「此刻队列里的」写入）。v2 的写者是一次
      // 同步事务，没有「持锁跨越 await」这回事，`whenIdle` + 禁写位就是完整的前提
      await this.whenIdle(sessionId)
    } finally {
      const left = (this.blockWrites.get(sessionId) ?? 1) - 1
      if (left > 0) this.blockWrites.set(sessionId, left)
      else this.blockWrites.delete(sessionId)
    }
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
