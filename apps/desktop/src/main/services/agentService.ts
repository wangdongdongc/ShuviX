/**
 * AgentService — Sub-Agent 管理
 *
 * 内置 agents：硬编码进 @shuvix/agent-runtime（builtinAgents，各端共享；wiki 经工厂注入桌面 wiki 根）。
 * 用户 agents：~/.shuvix/agents/<name>.md（用户可编辑；标准化单文件格式见
 *   agentDefinitionFile.ts —— 通用 key 对齐 Claude Code，ShuviX 自有字段带 `shuvix-` 前缀；
 *   文件名去掉 .md 即默认 agent name，frontmatter `name:` 可覆盖）。
 *
 * 纯 md 驱动：文件存在即可用，无启用开关/旁路配置。
 * 命名冲突：用户优先级 > 内置（同名时用户覆盖内置，可用于个性化内置政策）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'fs'
import { basename, isAbsolute, join, resolve, sep } from 'path'
import { shell } from 'electron'
import i18next from 'i18next'
import { getDefaultAgentsDir, getDefaultWikisDir, getWidgetsDir } from '../utils/paths'
import {
  buildBuiltinProfiles,
  parseAgentDefinitionFile,
  serializeAgentDefinitionFile,
  BASE_PROFILE_NAMES,
  DEFAULT_PROFILE_NAME,
  type AgentProfile,
  type AgentProfileRegistry,
  type ParsedAgentFile
} from '@shuvix/agent-runtime'
import type { AgentProfileSummary } from '@shuvix/chat-protocol/chatApi'
import { createLogger } from '../logger'

const log = createLogger('AgentService')

class AgentService implements AgentProfileRegistry {
  private readonly userDir: string

  constructor() {
    this.userDir = getDefaultAgentsDir()
  }

  /** 懒创建用户目录 */
  private ensureUserDir(): void {
    if (!existsSync(this.userDir)) {
      mkdirSync(this.userDir, { recursive: true })
    }
  }

  /** 从一个 .md 文件加载 agent 定义 */
  private loadAgentFromFile(
    filePath: string,
    defaultName: string,
    source: 'builtin' | 'user'
  ): AgentProfile | null {
    let raw: string
    try {
      raw = readFileSync(filePath, 'utf-8')
    } catch (e) {
      log.warn(`加载 agent "${defaultName}" 失败:`, e)
      return null
    }

    const parsed = parseAgentDefinitionFile(raw, defaultName)
    if (!parsed) {
      log.warn(`agent "${defaultName}": 无法解析 frontmatter`)
      return null
    }

    return {
      ...parsed,
      source,
      basePath: filePath
    }
  }

  /** 扫描指定目录下的所有 *.md 文件作为 agents */
  private scanDir(dir: string, source: 'builtin' | 'user'): AgentProfile[] {
    if (!existsSync(dir)) return []

    let entries: { name: string; isFile: boolean }[]
    try {
      entries = readdirSync(dir, { withFileTypes: true }).map((e) => ({
        name: e.name,
        isFile: e.isFile()
      }))
    } catch (e) {
      log.warn(`扫描目录 ${dir} 失败:`, e)
      return []
    }

    const result: AgentProfile[] = []
    for (const entry of entries) {
      if (!entry.isFile) continue
      if (entry.name.startsWith('.')) continue
      if (!entry.name.toLowerCase().endsWith('.md')) continue
      // 兼容用户用 README.md 之类作为说明文档放在同目录的场景
      const basename = entry.name.slice(0, -3)
      if (!basename) continue
      const def = this.loadAgentFromFile(join(dir, entry.name), basename, source)
      if (def) result.push(def)
    }
    return result
  }

  /** 内置 agent 列表（统一 spec 构建器；每次现算以反映当前语言与 wiki / widget 根等宿主参数） */
  private builtinAgents(): AgentProfile[] {
    return buildBuiltinProfiles({
      language: i18next.language,
      widgetsRoot: getWidgetsDir(),
      wikiRoot: getDefaultWikisDir()
    })
  }

  /** 列出所有 agent（用户优先级 > 内置覆盖同名） */
  listAll(): AgentProfile[] {
    const builtins = this.builtinAgents()
    const users = this.scanDir(this.userDir, 'user')

    // 用户覆盖内置同名
    const userNames = new Set(users.map((a) => a.name))
    const merged = [...builtins.filter((a) => !userNames.has(a.name)), ...users]
    return merged.sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * 设置页列表：合并结果 + 被同名用户档案遮蔽的内置（`overridden: true` 标记）。
   * 遮蔽的内置仅作展示（提示"已被覆盖，不生效"），不进任何运行时路径 ——
   * listAll/getProfile 仍以合并语义为准。
   */
  listForSettings(): (AgentProfile & { overridden?: boolean })[] {
    const builtins = this.builtinAgents()
    const users = this.scanDir(this.userDir, 'user')
    const userNames = new Set(users.map((a) => a.name))
    const merged = [...builtins.filter((a) => !userNames.has(a.name)), ...users]
    const shadowed = builtins
      .filter((a) => userNames.has(a.name))
      .map((a) => ({ ...a, overridden: true }))
    return [...merged, ...shadowed].sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * 会话档案选择器的列表：可切换的档案 + 选择器要显示的字段。
   *
   * 与 updateAgentProfile 的准入同源：排除 notebook（笔记本会话形态的基座，切到聊天会话上
   * 只会得到一个指向不存在笔记的人格）与 `shuvix-dispatch-only` 档案（政策必须跑在新鲜
   * 上下文里的执行型 agent，如 wiki-writer），保留 default（切回主会话基座的唯一入口）。
   * 不带 systemPrompt —— 选择器不需要，见 AgentProfileSummary。
   */
  listSwitchable(): AgentProfileSummary[] {
    return this.listAll()
      .filter(
        (a) =>
          a.name === DEFAULT_PROFILE_NAME || (!BASE_PROFILE_NAMES.has(a.name) && !a.dispatchOnly)
      )
      .map((a) => ({
        name: a.name,
        displayName: a.displayName,
        description: a.description,
        source: a.source,
        model: a.model
      }))
  }

  /** 按名取档案（含 'default' 内置兜底 —— 用户 default 文件损坏时主会话仍可创建） */
  getProfile(name: string): AgentProfile | undefined {
    const found = this.listAll().find((a) => a.name === name)
    if (found) return found
    if (name !== DEFAULT_PROFILE_NAME) return undefined
    return this.builtinAgents().find((a) => a.name === DEFAULT_PROFILE_NAME)
  }

  /**
   * 按路径 ref 即时加载 agent 定义（派发工具的路径形态；不经注册表/启用开关——
   * 直接寻址即显式意图，且支持运行时动态生成的定义文件）。
   *
   * 寻址卫生：相对路径以 baseDir（根会话工作目录）为基准；最终路径必须位于
   * baseDir 或 ~/.shuvix/agents 内（read 工具本可读任意文件，此约束只为寻址
   * 规范而非安全边界）。失败 throw 带原因的 Error（派发工具转为 LLM 可读错误文本）。
   */
  loadAgentFromRef(refPath: string, baseDir?: string): AgentProfile {
    if (!isAbsolute(refPath) && !baseDir) {
      throw new Error('Relative agent paths require a project working directory')
    }
    const abs = isAbsolute(refPath) ? resolve(refPath) : resolve(baseDir!, refPath)
    const within = (dir: string): boolean => {
      const base = resolve(dir)
      return abs === base || abs.startsWith(base + sep)
    }
    if (!(baseDir && within(baseDir)) && !within(this.userDir)) {
      throw new Error(
        'Agent definition file must live inside the working directory or the global agents directory (~/.shuvix/agents)'
      )
    }
    const defaultName = basename(abs).replace(/\.md$/i, '') || 'agent'
    const def = this.loadAgentFromFile(abs, defaultName, 'user')
    if (!def) {
      throw new Error(
        'file missing or invalid — expected markdown with YAML frontmatter (name / description / shuvix-tools) and the system prompt as body'
      )
    }
    return def
  }

  /**
   * 保存（覆写）用户 agent 定义文件 —— 设置页编辑 GUI 的写路径。
   * `originalName` 定位现有文件（文件路径不随改名变，frontmatter `name` 为准）；
   * 内置 agent 无文件不可编辑。
   */
  saveAgent(originalName: string, input: ParsedAgentFile): { success: boolean; error?: string } {
    const users = this.scanDir(this.userDir, 'user')
    const target = users.find((a) => a.name === originalName)
    if (!target) return { success: false, error: `Agent "${originalName}" not found` }

    const name = input.name.trim()
    if (!name) return { success: false, error: 'Agent name is required' }
    // 与其他用户 agent 重名 → 拒绝（同名用户文件互相遮蔽，语义不明）；覆盖内置为有意设计，放行
    if (name !== originalName && users.some((a) => a.name === name)) {
      return { success: false, error: `Agent "${name}" already exists` }
    }

    const content = serializeAgentDefinitionFile({ ...input, name })
    // 序列化→解析往返自检，防御 serializer/parser 漂移导致写出不可读文件
    if (!parseAgentDefinitionFile(content, name)) {
      return { success: false, error: 'Internal error: serialized agent file failed to parse' }
    }

    try {
      writeFileSync(target.basePath, content, 'utf-8')
    } catch (e) {
      log.warn(`保存 agent "${originalName}" 失败:`, e)
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
    return { success: true }
  }

  /**
   * 新建用户 agent 定义文件 —— 设置页「添加自定义智能体」的写路径。
   * name / description / systemPrompt 必填；文件名由 name 净化派生（frontmatter name 为准，
   * 文件名冲突时追加数字后缀）。与既有用户 agent 重名拒绝；覆盖内置同名为有意设计，放行。
   */
  createAgent(input: ParsedAgentFile): { success: boolean; name?: string; error?: string } {
    const name = input.name.trim()
    if (!name) return { success: false, error: 'Agent name is required' }
    if (!input.description.trim()) return { success: false, error: 'When-to-use is required' }
    if (!input.systemPrompt.trim()) return { success: false, error: 'System prompt is required' }

    const users = this.scanDir(this.userDir, 'user')
    if (users.some((a) => a.name === name)) {
      return { success: false, error: `Agent "${name}" already exists` }
    }

    const content = serializeAgentDefinitionFile({ ...input, name })
    if (!parseAgentDefinitionFile(content, name)) {
      return { success: false, error: 'Internal error: serialized agent file failed to parse' }
    }

    // 文件名净化：路径分隔/非法字符替换为 '-'，前导点去除；frontmatter name 才是标识
    const safeBase = name.replace(/[\\/:*?"<>|]/g, '-').replace(/^\.+/, '') || 'agent'
    this.ensureUserDir()
    let filePath = join(this.userDir, `${safeBase}.md`)
    for (let i = 1; existsSync(filePath); i++) {
      filePath = join(this.userDir, `${safeBase}-${i}.md`)
    }

    try {
      writeFileSync(filePath, content, 'utf-8')
    } catch (e) {
      log.warn(`新建 agent "${name}" 失败:`, e)
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
    return { success: true, name }
  }

  /**
   * 删除用户 agent 定义文件（设置页删除按钮）。仅用户档案可删（内置无文件）；
   * 删除覆盖档案后同名内置自动恢复生效（合并语义）。
   */
  deleteAgent(name: string): { success: boolean; error?: string } {
    const users = this.scanDir(this.userDir, 'user')
    const target = users.find((a) => a.name === name)
    if (!target) return { success: false, error: `Agent "${name}" not found` }

    try {
      unlinkSync(target.basePath)
    } catch (e) {
      log.warn(`删除 agent "${name}" 失败:`, e)
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
    log.info(`已删除 agent "${name}" (${target.basePath})`)
    return { success: true }
  }

  /** 打开用户 agents 目录（OS 文件管理器） */
  async openUserFolder(): Promise<void> {
    this.ensureUserDir()
    await shell.openPath(this.userDir)
  }

  /** 获取用户目录路径 */
  getUserDir(): string {
    return this.userDir
  }
}

export const agentService = new AgentService()
