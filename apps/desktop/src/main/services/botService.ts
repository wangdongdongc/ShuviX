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
 * 写盘一律**原子写**（`writeFileAtomic`）：bot 会在答话途中用 `edit` 改自己的文件，而 `scanDir`
 * 随时可能在读；半份文件会让它从列表里消失一瞬。
 */
import { existsSync, readdirSync, readFileSync, mkdirSync, unlinkSync } from 'fs'
import { createHash } from 'crypto'
import { basename, join } from 'path'
import { shell } from 'electron'
import {
  parseBotDefinitionFile,
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

/** 内容指纹 —— 「我打开之后它被改过吗」的判据（bot 自己会改这份文件） */
function revisionOf(text: string): string {
  return createHash('sha1').update(text).digest('hex')
}

class BotService {
  private get userDir(): string {
    return getDefaultBotsDir()
  }

  // ─── 注册表 ──────────────────────────────────

  /** 目录扫描，分出可解析与不可解析两拨（同 botService / workflowService.scanDir 口径） */
  private scanDir(): { valid: BotEntry[]; invalid: InvalidBotFile[] } {
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

    const valid: BotEntry[] = []
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
      // warn 通道同时收「拒绝理由」与「软提示」（v1 残留的管线块）。只有拒绝值得进日志：
      // 软提示在每次 get / list 都会重发一遍，那条话归属性卡的琥珀横幅去讲
      const messages: string[] = []
      const parsed = parseBotDefinitionFile(raw, fileName.slice(0, -3), (msg) => messages.push(msg))
      if (!parsed) {
        for (const m of messages) log.warn(m)
        invalid.push({ fileName, error: messages.join('\n') || 'Invalid bot file' })
        continue
      }
      if (seen.has(parsed.name)) {
        log.warn(`bot "${parsed.name}": 同名文件重复（${fileName}），已跳过`)
        continue
      }
      seen.add(parsed.name)
      valid.push({ file: parsed, basePath: filePath })
    }
    return { valid, invalid }
  }

  /** 全部合法 bot */
  listAll(): BotEntry[] {
    return this.scanDir().valid
  }

  /** 合法 + 非法两拨（侧栏分组一次取齐） */
  listWithInvalid(): { valid: BotEntry[]; invalid: InvalidBotFile[] } {
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

  // ─── 读写 ──────────────────────────────────

  /** 取 md 原文 + 指纹（档案页打开时用；指纹在保存时回传做冲突检测） */
  getSource(name: string): { text: string; revision: string; path: string } | null {
    const entry = this.get(name)
    if (!entry) return null
    try {
      const text = readFileSync(entry.basePath, 'utf-8')
      return { text, revision: revisionOf(text), path: entry.basePath }
    } catch (e) {
      log.warn(`读取 bot "${name}" 失败:`, e)
      return null
    }
  }

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

  /**
   * 保存（档案页的显式保存）。
   *
   * **带指纹的冲突检测**：这份文件有两个写者 —— 用户在档案页改，bot 在答话途中用 `edit`
   * 改自己。用户打开编辑器时拿到的 revision 与此刻磁盘上的不一致，就说明中间有人写过，
   * 直接覆盖等于把 bot 刚记下的东西抹掉。
   */
  save(
    originalName: string,
    text: string,
    revision?: string
  ): {
    success: boolean
    error?: string
    revision?: string
    conflict?: { current: string }
  } {
    const target = this.get(originalName)
    if (!target) return { success: false, error: `Bot "${originalName}" not found` }

    // `!== undefined` 而不是真值判断：**空串同样算「给了一个对不上的指纹」**，不是「没给」。
    // 真值判断会让 `revision: ''` 静默跳过整道丢更新守卫，把 bot 刚记下的东西覆盖掉 ——
    // 而「没给指纹」是修非法文件那条通道的语义（它没有可对账的基准），两者必须分得开。
    if (revision !== undefined) {
      let onDisk: string
      try {
        onDisk = readFileSync(target.basePath, 'utf-8')
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
      if (revisionOf(onDisk) !== revision) {
        return {
          success: false,
          error:
            'This bot changed on disk since you opened it — most likely the bot itself, updating its own memory.',
          conflict: { current: onDisk }
        }
      }
    }

    const parsed = this.parseForWrite(text, originalName)
    if ('error' in parsed) return { success: false, error: parsed.error }
    const name = parsed.file.name
    if (name !== originalName && this.listAll().some((p) => p.file.name === name)) {
      return { success: false, error: `Bot "${name}" already exists` }
    }
    try {
      writeFileAtomic(target.basePath, text)
    } catch (e) {
      log.warn(`保存 bot "${originalName}" 失败:`, e)
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
    if (name !== originalName) this.migrateRename(originalName, name)
    // 半途崩溃的补做（同 botService）：文件名不随改名变，所以「文件叫 scout.md、里面写着
    // ranger」正是一次没走完的迁移。幂等，正常保存时这一步什么都不做
    const stale = basename(target.basePath).replace(/\.md$/i, '')
    if (stale !== name && !this.listAll().some((p) => p.file.name === stale)) {
      this.migrateRename(stale, name)
    }
    appEventBus.publish({ type: 'bot.changed' })
    // 成功回新指纹：UI 不必为了「再保存一次」而重新 getSource，否则第二次必然误报冲突
    return { success: true, revision: revisionOf(text) }
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

  /** 新建；文件名由 name 净化派生 */
  create(text: string): { success: boolean; name?: string; error?: string } {
    const parsed = this.parseForWrite(text, 'bot')
    if ('error' in parsed) return { success: false, error: parsed.error }
    const name = parsed.file.name
    if (this.listAll().some((p) => p.file.name === name)) {
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
    appEventBus.publish({ type: 'bot.changed' })
    return { success: true, name }
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
    log.info(`已删除 bot "${name}" (${target.basePath})`)
    appEventBus.publish({ type: 'bot.changed' })
    return { success: true }
  }

  // ─── 非法文件（按文件名寻址） ──────────────────────────────────

  /**
   * 文件名白名单：仅接受 bots 目录下的单个 .md 文件名，杜绝路径穿越
   * （fileName 来自渲染进程，虽只由 listWithInvalid 的返回值填充，仍按不可信入参处理）。
   */
  private resolveUserFile(fileName: string): string | null {
    if (!/^[^/\\]+\.md$/i.test(fileName) || fileName.startsWith('.')) return null
    const filePath = join(this.userDir, fileName)
    return existsSync(filePath) ? filePath : null
  }

  /** 取非法文件的原文（档案页的「修一下」入口） */
  getSourceByFile(fileName: string): { text: string; revision: string; path: string } | null {
    const filePath = this.resolveUserFile(fileName)
    if (!filePath) return null
    try {
      const text = readFileSync(filePath, 'utf-8')
      return { text, revision: revisionOf(text), path: filePath }
    } catch (e) {
      log.warn(`读取文件 "${fileName}" 失败:`, e)
      return null
    }
  }

  /** 按文件名保存（修非法文件；修好之后它就有 name 了，后续走 save） */
  saveByFile(
    fileName: string,
    text: string
  ): { success: boolean; error?: string; name?: string; revision?: string } {
    const filePath = this.resolveUserFile(fileName)
    if (!filePath) return { success: false, error: `File "${fileName}" not found` }
    const parsed = this.parseForWrite(text, fileName.slice(0, -3))
    if ('error' in parsed) return { success: false, error: parsed.error }
    try {
      writeFileAtomic(filePath, text)
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
    appEventBus.publish({ type: 'bot.changed' })
    return { success: true, name: parsed.file.name, revision: revisionOf(text) }
  }

  /** 按文件名删除（清掉一个修不好的文件） */
  deleteByFile(fileName: string): { success: boolean; error?: string } {
    const filePath = this.resolveUserFile(fileName)
    if (!filePath) return { success: false, error: `File "${fileName}" not found` }
    try {
      unlinkSync(filePath)
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
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

  /** 目录绝对路径（档案页头部显示） */
  get dir(): string {
    return this.userDir
  }
}

export const botService = new BotService()
