/**
 * BotService —— bot 注册表（宿主层）。
 *
 * 一个 bot 是 `~/.shuvix/bots/<name>.md`（`shuvix: bot`）：身份三项 + 一篇正文（人设与记忆）。
 * **纯 md 驱动**，与 agent / workflow / policy 同一条纪律 —— 文件存在且解析得过就是活的，没有
 * 启用开关、没有旁路配置、没有数据库表，也**不内置任何 bot**。
 *
 * 本服务**只管文件**：怎么把正文喂给会话是 agentSession 那一侧的事（`renderBotContext` →
 * `CreateAgentParams.systemContext`，只给根 Agent）。bot 会话是一条普通有根会话，所以这里没有
 * 派发、没有 mailbox、没有管线 —— 那些由会话与子会话机制原样承担。
 *
 * **编辑不经过本服务**：打开一份 bot 就是打开它的笔记本会话（registryNotes），自动保存经
 * writeSessionFile 落盘 —— 与知识库条目、任何项目里的 md 同一条路。本服务只在写入前后被告知
 * 一声（noteWriting / noteWritten），据此补上这份文件特有的两件事：改名迁移会话绑定、广播
 * `bot.changed`。
 *
 * 新建写盘走**原子写**（`writeFileAtomic`）：`scanDir` 随时可能在读，半份文件会让它从列表里
 * 消失一瞬。
 */
import { existsSync, readdirSync, readFileSync, mkdirSync, unlinkSync } from 'fs'
import { basename, join } from 'path'
import { shell } from 'electron'
import {
  parseBotDefinitionFile,
  registryFileBase,
  resolveShadowing,
  serializeBotDefinitionFile,
  type ParsedBotFile
} from '@shuvix/agent-runtime'
import { boundBotOf } from '@shuvix/chat-protocol/botSession'
import { getDefaultBotsDir } from '../utils/paths'
import { appEventBus } from '../utils/appEventBus'
import { writeFileAtomic } from '../utils/atomicWrite'
import { createLogger } from '../logger'
import { sessionDao } from '../dao/sessionDao'
import { broadcastSessionConfigChanged } from '../utils/sessionConfigBroadcast'

const log = createLogger('BotService')

/**
 * 笔记本写入后 `bot.changed` 的合并窗口：自动保存每 200ms 落一次盘，连续打字不该让侧栏分组
 * 与各 bot 会话的身份胶囊跟着一直重查。
 */
const CHANGED_DEBOUNCE_MS = 300

/** 目录里无法解析的文件（身份是文件名 —— 它解析不出 name） */
export interface InvalidBotFile {
  fileName: string
  /** 解析器的人读拒绝理由 */
  error: string
}

/** 注册表里的一条 */
export interface BotEntry {
  file: ParsedBotFile
  /** md 的绝对路径 */
  basePath: string
}

/** 同名的另一份压过了它、当前不生效的一份（侧栏照常列出，换一种样子） */
export interface ShadowedBotEntry extends BotEntry {
  /** 压过它的那份文件的文件名 */
  shadowedBy: string
}

class BotService {
  /**
   * 每份文件上一次解析出的名字（绝对路径 → frontmatter `name`）—— 改名迁移的依据，见
   * observeRenames。只在进程内。
   */
  private readonly namesByPath = new Map<string, string>()
  private changedTimer: ReturnType<typeof setTimeout> | null = null

  private get userDir(): string {
    return getDefaultBotsDir()
  }

  // ─── 注册表 ──────────────────────────────────

  /**
   * 目录扫描，分出生效 / 被同名遮蔽 / 不可解析三拨（同 policyService / workflowService.scanDir 口径）。
   * 同名的几份谁生效交给 agent-runtime 的 resolveShadowing：**按名取（get / forSession）与侧栏列出
   * 全部份数用的是这同一次裁决**。每次扫描顺带做改名观察（observeRenames）。
   */
  private scanDir(): {
    valid: BotEntry[]
    shadowed: ShadowedBotEntry[]
    invalid: InvalidBotFile[]
  } {
    if (!existsSync(this.userDir)) {
      this.namesByPath.clear()
      return { valid: [], shadowed: [], invalid: [] }
    }
    let names: string[]
    try {
      names = readdirSync(this.userDir, { withFileTypes: true })
        .filter(
          (e) => e.isFile() && !e.name.startsWith('.') && e.name.toLowerCase().endsWith('.md')
        )
        .map((e) => e.name)
        .sort()
    } catch (e) {
      log.warn(`扫描目录 ${this.userDir} 失败:`, e)
      return { valid: [], shadowed: [], invalid: [] }
    }

    const invalid: InvalidBotFile[] = []
    // 解析得过的每一份（含同名的几份）—— 改名观察要看得到一个名字的全部持有者，同名裁决也在这一拨上做
    const parsedFiles: Array<{ filePath: string; name: string; entry: BotEntry }> = []
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
      // warn 通道同时收「拒绝理由」与「软提示」（v1 残留的管线块）。只有拒绝值得进日志：
      // 软提示在每次 get / list 都会重发一遍，那条话归属性卡的琥珀横幅去讲
      const messages: string[] = []
      const parsed = parseBotDefinitionFile(raw, fileName.slice(0, -3), (msg) => messages.push(msg))
      if (!parsed) {
        for (const m of messages) log.warn(m)
        invalid.push({ fileName, error: messages.join('\n') || 'Invalid bot file' })
        continue
      }
      parsedFiles.push({ filePath, name: parsed.name, entry: { file: parsed, basePath: filePath } })
    }
    this.observeRenames(
      names.map((n) => join(this.userDir, n)),
      parsedFiles
    )
    const valid: BotEntry[] = []
    const shadowed: ShadowedBotEntry[] = []
    const resolved = resolveShadowing(
      parsedFiles.map((p) => ({
        name: p.name,
        source: 'user' as const,
        fileName: basename(p.filePath),
        value: p.entry
      }))
    )
    for (const entry of resolved) {
      if (entry.shadowedBy)
        shadowed.push({ ...entry.value, shadowedBy: entry.shadowedBy.fileName ?? '' })
      else valid.push(entry.value)
    }
    return { valid, shadowed, invalid }
  }

  /**
   * 改名观察：同一份文件这次解析出的名字与上次记下的不同，就把会话绑定从旧名迁到新名。
   *
   * 编辑是笔记本的自动保存，没有「点保存」那一刻可以拿新旧两份文本对照 —— 把 `name` 从
   * ranger 改成 hunter，磁盘上依次出现的是 h、hu、hun……中途还可能有一版解析不过。所以迁移
   * 挂在扫描上，一步一步跟过去：解析不过的文件不动记录（修好后从最后一个合法名字一次迁到位），
   * 文件没了才删记录。两种情况**不迁**：
   *  - 新名字此刻不止一份文件在用 —— 迁过去等于把会话交给一个说不清是谁的名字；记录停在旧名，
   *    等它改成独占的名字再迁；
   *  - 旧名字此刻还有别的文件在用（复制出一份再改名）—— 那些会话属于留下来的那份。
   *
   * 进程内第一次见到一份文件只记基线（写入前的基线由 noteWriting 保证）；应用关着时发生的
   * 改名（外部编辑器）不迁。
   */
  private observeRenames(
    present: string[],
    parsedFiles: Array<{ filePath: string; name: string }>
  ): void {
    const holders = new Map<string, number>()
    for (const { name } of parsedFiles) holders.set(name, (holders.get(name) ?? 0) + 1)
    for (const { filePath, name } of parsedFiles) {
      const prev = this.namesByPath.get(filePath)
      if (prev === name) continue
      if (prev !== undefined && (holders.get(name) ?? 0) > 1) continue
      this.namesByPath.set(filePath, name)
      if (prev !== undefined && !holders.has(prev)) this.migrateRename(prev, name)
    }
    const alive = new Set(present)
    for (const filePath of [...this.namesByPath.keys()]) {
      if (!alive.has(filePath)) this.namesByPath.delete(filePath)
    }
  }

  /** 全部合法 bot */
  listAll(): BotEntry[] {
    return this.scanDir().valid
  }

  /** 生效 + 被同名遮蔽 + 非法三拨（侧栏分组一次取齐） */
  listWithInvalid(): {
    valid: BotEntry[]
    shadowed: ShadowedBotEntry[]
    invalid: InvalidBotFile[]
  } {
    return this.scanDir()
  }

  /** 按名取一条；不存在返回 null（bot md 被删时会话据此降级，而不是卡死） */
  get(name: string): BotEntry | null {
    return this.listAll().find((p) => p.file.name === name) ?? null
  }

  /**
   * 一条会话绑定的 bot —— 注入侧的唯一入口（agentSession）。
   * 不是 bot 会话、或绑定的 md 已不存在，都返回 null：会话照常在基座 `bot` 上跑，
   * 只是没有人设可注入。**绑定不存在不该让会话打不开** —— 那是用户删了一个文件，
   * 不是数据损坏。
   */
  forSession(sessionId: string): BotEntry | null {
    const settings = sessionDao.pick(sessionId, ['settings'])?.settings
    const name = boundBotOf(settings)
    if (!name) return null
    const entry = this.get(name)
    if (!entry) log.warn(`会话 ${sessionId} 绑定的 bot "${name}" 已不存在`)
    return entry
  }

  // ─── 笔记本写入的回执 ──────────────────────────────────

  /**
   * 笔记本即将写一份 bot 文件（registryNotes.observeRegistryWrite）：进程内还没见过这份文件
   * 就先扫一遍，把它写入前的名字记成基线 —— 否则「重启后打开就改名」的第一笔写会被当成
   * 第一次见到，迁移随之漏掉。
   */
  noteWriting(filePath: string): void {
    if (!this.namesByPath.has(filePath)) this.scanDir()
  }

  /** 笔记本写完一份 bot 文件：重扫（名字变了就迁移），并合并窗口内广播一次 `bot.changed` */
  noteWritten(): void {
    this.scanDir()
    if (this.changedTimer) clearTimeout(this.changedTimer)
    this.changedTimer = setTimeout(() => {
      this.changedTimer = null
      appEventBus.publish({ type: 'bot.changed' })
    }, CHANGED_DEBOUNCE_MS)
  }

  /**
   * 改名之后把会话绑定迁过来。bot 的身份是 frontmatter 的 `name`，而会话的
   * `settings.bot` 引用它 —— 不迁的话改一次名等于把这个 bot 从它所有的会话里抽走，
   * 而用户看到的只是「我改了个显示名」。幂等。
   *
   * 历史消息里的署名**不迁**：署名取自消息落盘当时的会话绑定快照，历史不该因为今天的
   * 一次改名而改写（与旧 bot 那条纪律同源）。
   */
  private migrateRename(oldName: string, newName: string): void {
    // 走 dao 而不是 sessionService：本服务被 agentSession 在创建根 Agent 的路径上调用，
    // 而 sessionService 恰恰 import 了 agentSession —— 经 dao 读写是这一层既有的破环手法
    // （agentSession 自己也这么做）。
    let sessions: ReturnType<typeof sessionDao.findAll> = []
    try {
      sessions = sessionDao.findAll()
    } catch (e) {
      log.warn(`改名迁移：会话列表读取失败 ${oldName} → ${newName}:`, e)
      return
    }
    for (const session of sessions) {
      if (session.settings?.bot !== oldName) continue
      // **逐会话独立 try**：一个会话写失败不该让它后面的会话全部留在旧名上
      try {
        sessionDao.updateSettings(session.id, { bot: newName })
        broadcastSessionConfigChanged(session.id)
      } catch (e) {
        log.warn(`改名迁移：会话 ${session.id} 绑定改写失败:`, e)
      }
    }
  }

  // ─── 新建与删除 ──────────────────────────────────

  /** 解析一段将要落盘的文本；非法则回一句人读的理由 */
  private parseForWrite(
    text: string,
    fallbackName: string
  ): { file: ParsedBotFile } | { error: string } {
    const messages: string[] = []
    const parsed = parseBotDefinitionFile(text, fallbackName, (m) => messages.push(m))
    if (!parsed) return { error: messages.join('\n') || 'Invalid bot file' }
    return { file: parsed }
  }

  /** 新建；文件名由 name 净化派生。回名字与落盘的文件名（打开它的笔记本要用） */
  create(text: string): { success: boolean; name?: string; fileName?: string; error?: string } {
    const parsed = this.parseForWrite(text, 'bot')
    if ('error' in parsed) return { success: false, error: parsed.error }
    const name = parsed.file.name
    if (this.listAll().some((p) => p.file.name === name)) {
      return { success: false, error: `Bot "${name}" already exists` }
    }

    const safeBase = registryFileBase(name) || 'bot'
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
    appEventBus.publish({ type: 'bot.changed' })
    return { success: true, name, fileName: basename(filePath) }
  }

  /**
   * 侧栏「新建 Bot」：按模板落一份新文件，名字取 `my-bot`、`my-bot-2`……里第一个没被占用的。
   * 落盘之后怎么改就是打开它的笔记本会话去改，与任何 bot 一样。
   */
  createNew(): { success: boolean; name?: string; fileName?: string; error?: string } {
    const taken = new Set(this.listAll().map((p) => p.file.name))
    let name = 'my-bot'
    for (let i = 2; taken.has(name); i++) name = `my-bot-${i}`
    return this.create(this.newBotTemplate({ name }))
  }

  /**
   * 「新建 bot」的模板。
   *
   * 正文**预置几个小标题**而不是留空，有一个机制上的理由：bot 靠 `edit` 维护自己这份
   * 文件，而 `edit` 需要一段能锚定的既有文本 —— 空正文里它无处下手。骨架同时也是给用户
   * 看的说明：分成「我是谁」和「我记得什么」两段，人设归你写、记忆归它写。
   */
  newBotTemplate(params: { name: string; description?: string; body?: string }): string {
    const body =
      params.body?.trim() ||
      [
        '## 我是谁',
        '',
        `你是 ${params.name}。（写下它的口吻、职责与纪律 —— 这段是人设，由你维护。）`,
        '',
        '## 我记得什么',
        '',
        '（这一段归它自己。对话里出现的长期偏好、约定、结论，它会写进来。）'
      ].join('\n')
    return serializeBotDefinitionFile({
      name: params.name,
      displayName: params.name,
      description: params.description?.trim() || `${params.name} —— 一句话说明这个 bot 管什么`,
      body
    })
  }

  /** 删除 bot 文件。绑定它的会话**不动** —— 会话是用户资产，删一个 md 不该带走对话 */
  delete(name: string): { success: boolean; error?: string } {
    const target = this.get(name)
    if (!target) return { success: false, error: `Bot "${name}" not found` }
    try {
      unlinkSync(target.basePath)
    } catch (e) {
      log.warn(`删除 bot "${name}" 失败:`, e)
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
    this.namesByPath.delete(target.basePath)
    log.info(`已删除 bot "${name}" (${target.basePath})`)
    appEventBus.publish({ type: 'bot.changed' })
    return { success: true }
  }

  /**
   * 文件名白名单：仅接受 bots 目录下的单个 .md 文件名，杜绝路径穿越
   * （fileName 来自渲染进程，虽只由 listWithInvalid 的返回值填充，仍按不可信入参处理）。
   */
  private resolveUserFile(fileName: string): string | null {
    if (!/^[^/\\]+\.md$/i.test(fileName) || fileName.startsWith('.')) return null
    const filePath = join(this.userDir, fileName)
    return existsSync(filePath) ? filePath : null
  }

  /** 按文件名删除（清掉一个解析不过的文件 —— 它没有 name，走不了 delete） */
  deleteByFile(fileName: string): { success: boolean; error?: string } {
    const filePath = this.resolveUserFile(fileName)
    if (!filePath) return { success: false, error: `File "${fileName}" not found` }
    try {
      unlinkSync(filePath)
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
    this.namesByPath.delete(filePath)
    appEventBus.publish({ type: 'bot.changed' })
    return { success: true }
  }

  /** 在 OS 文件管理器里打开 bots 目录（不存在则先建 —— 用户点它就是想看见它） */
  async openFolder(): Promise<void> {
    const dir = this.userDir
    try {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      await shell.openPath(dir)
    } catch (e) {
      log.warn(`打开 bots 目录失败:`, e)
    }
  }

  /** 目录绝对路径 */
  get dir(): string {
    return this.userDir
  }
}

export const botService = new BotService()
