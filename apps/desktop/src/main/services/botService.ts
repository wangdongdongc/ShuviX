/**
 * BotService —— bot 注册表（桌面宿主层）。设计见 docs/bot-design.md §4。
 *
 * 落地分期（docs/bot-implementation-plan.md）：本文件是 **M1′ 的注册表半边** ——
 * 扫描 / md 原文读写 / 非法文件修复通道 / 新建模板。管线执行侧（cohort、仲裁、mailbox
 * lane、笔记写盘、决策记录）属于后续里程碑，此处刻意不留半成品桩。
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
import {
  DEFAULT_BOT_PIPELINE,
  parseBotDefinitionFile,
  serializeBotDefinitionFile,
  type ParsedBotFile
} from '@shuvix/agent-runtime'
import { getDefaultBotsDir } from '../utils/paths'
import { writeFileAtomic } from '../utils/atomicWrite'
import { createLogger } from '../logger'

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
