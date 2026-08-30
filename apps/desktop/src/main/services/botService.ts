/**
 * BotService —— bot 注册表（桌面宿主层）。设计见 docs/bot-design.md §4。
 *
 * 落地分期（docs/bot-implementation-plan.md）：本文件现有两半 ——
 *  - **注册表半边（M1′）**：扫描 / md 原文读写 / 非法文件修复通道 / 新建模板；
 *  - **消息半边（M3′）**：无根会话的用户消息落盘、bot 消息的双 append、greeting 播种、
 *    在飞计数（树钉住用）与 abortSession 会师点。
 *
 * 管线执行侧（L0 门、cohort、仲裁、mailbox lane、笔记写盘、决策记录）属于后续里程碑，
 * 此处刻意不留半成品桩：`handleUserMessage` 现在**只落用户消息，不派发任何东西**。
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
import type { ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'
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

  /** 主进程启动时装配（同 workflowService.init 的时机，避免 ESM 初始化环） */
  init(): void {
    addSessionTreePin((sessionId) => this.isActive(sessionId))
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
   * **M3′ 到此为止：不 invoke 管线、不做 L0 门、不组 cohort。**
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
          return { sidecarId, entryId }
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
    } finally {
      this.leave(sessionId)
    }
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
   * 成员的开场白落树（会话创建后由 `session:create` handler await）。
   *
   * 按成员顺序逐条落；没写 greeting 的成员跳过。`listAll()` 每次现扫全目录，
   * 所以这里只扫一次再按名取，别在循环里反复扫。
   */
  async seedGreetings(sessionId: string): Promise<void> {
    const names = sessionService.getById(sessionId)?.settings?.bots ?? []
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
    await drainSessionTreeLock(sessionId)
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
