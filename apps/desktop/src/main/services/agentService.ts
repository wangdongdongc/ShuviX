/**
 * AgentService — Sub-Agent 管理
 *
 * 内置 agents：硬编码进 @shuvix/agent-runtime（builtinAgents，各端共享）。
 * 用户 agents：~/.shuvix/agents/<name>.md（用户可编辑；标准化单文件格式见
 *   agentDefinitionFile.ts —— 通用 key 对齐 Claude Code，ShuviX 自有字段带 `shuvix-` 前缀；
 *   文件名去掉 .md 即默认 agent name，frontmatter `name:` 可覆盖）。
 *
 * 纯 md 驱动：文件存在即可用，无启用开关/旁路配置。
 * 命名冲突：同名的几份谁生效由 agent-runtime 的 resolveShadowing 裁决（用户压过内置，可用于个性化
 * 内置政策；同为用户文件按文件名定先后）—— 注册表（listAll / getProfile）与设置页列表共用这一次裁决。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'fs'
import { basename, isAbsolute, join, resolve, sep } from 'path'
import { shell } from 'electron'
import i18next from 'i18next'
import { getDefaultAgentsDir, getWidgetsDir } from '../utils/paths'
import {
  buildBuiltinProfiles,
  parseAgentDefinitionFile,
  registryFileBase,
  resolveShadowing,
  serializeAgentDefinitionFile,
  BASE_PROFILE_NAMES,
  type AgentProfile,
  type AgentProfileRegistry,
  type ParsedAgentFile,
  type ShadowResolved
} from '@shuvix/agent-runtime'
import { createLogger } from '../logger'

const log = createLogger('AgentService')

/**
 * 无法解析的用户档案文件（设置页「无法解析」分组）。身份是文件名 —— 它解析不出 name，
 * 删除走 deleteByFile。
 */
export interface InvalidAgentFile {
  fileName: string
  /** 读取失败或解析器给出的人读原因（多条以换行连接） */
  error: string
}

/** 设置页列表项：被同名遮蔽的带 overridden（不生效）与 overriddenBy（压过它的文件名） */
type AgentListItem = AgentProfile & { overridden?: boolean; overriddenBy?: string }

/** 设置页排序：按名字；同名里生效的在前、再按文件路径 —— 被遮蔽的几份紧跟在胜出的那份后面 */
function compareRows(a: AgentListItem, b: AgentListItem): number {
  return (
    a.name.localeCompare(b.name) ||
    Number(!!a.overridden) - Number(!!b.overridden) ||
    a.basePath.localeCompare(b.basePath)
  )
}

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

  /**
   * 从一个 .md 文件加载 agent 定义。`onReject` 收读取失败 / 解析器的人读原因（解析器的 warn
   * 通道也会带软告警，调用方只在返回 null 时才把它们当作拒绝原因用）。
   */
  private loadAgentFromFile(
    filePath: string,
    defaultName: string,
    source: 'builtin' | 'user',
    onReject?: (reason: string) => void
  ): AgentProfile | null {
    let raw: string
    try {
      raw = readFileSync(filePath, 'utf-8')
    } catch (e) {
      log.warn(`加载 agent "${defaultName}" 失败:`, e)
      onReject?.(e instanceof Error ? e.message : String(e))
      return null
    }

    const parsed = parseAgentDefinitionFile(raw, defaultName, (msg) => {
      log.warn(msg)
      onReject?.(msg)
    })
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
    return this.scanDirWithInvalid(dir, source).valid
  }

  /**
   * 目录扫描，分出可解析与不可解析两拨（同 policyService.scanDir 口径）。非法文件不进注册表，
   * 但设置页要看得见 —— 笔记本自动保存时一份写到一半的档案就是这样一个文件，它不该从列表里消失。
   */
  private scanDirWithInvalid(
    dir: string,
    source: 'builtin' | 'user'
  ): { valid: AgentProfile[]; invalid: InvalidAgentFile[] } {
    if (!existsSync(dir)) return { valid: [], invalid: [] }

    let entries: { name: string; isFile: boolean }[]
    try {
      entries = readdirSync(dir, { withFileTypes: true }).map((e) => ({
        name: e.name,
        isFile: e.isFile()
      }))
    } catch (e) {
      log.warn(`扫描目录 ${dir} 失败:`, e)
      return { valid: [], invalid: [] }
    }

    const valid: AgentProfile[] = []
    const invalid: InvalidAgentFile[] = []
    for (const entry of entries) {
      if (!entry.isFile) continue
      if (entry.name.startsWith('.')) continue
      if (!entry.name.toLowerCase().endsWith('.md')) continue
      // 兼容用户用 README.md 之类作为说明文档放在同目录的场景
      const basename = entry.name.slice(0, -3)
      if (!basename) continue
      const reasons: string[] = []
      const def = this.loadAgentFromFile(join(dir, entry.name), basename, source, (reason) =>
        reasons.push(reason)
      )
      if (!def) {
        invalid.push({ fileName: entry.name, error: reasons.join('\n') || 'Invalid agent file' })
        continue
      }
      // 同名的几份都收下 —— 谁生效由 resolveProfiles 统一裁决（被遮蔽的照常列进设置页）
      valid.push(def)
    }
    return { valid, invalid }
  }

  /** 内置 agent 列表（统一 spec 构建器；每次现算以反映当前语言与 widget 根等宿主参数） */
  private builtinAgents(): AgentProfile[] {
    return buildBuiltinProfiles({
      language: i18next.language,
      widgetsRoot: getWidgetsDir()
    })
  }

  /**
   * 内置 + 全部可解析的用户文件过一遍同名裁决（agent-runtime resolveShadowing）。
   * **注册表（listAll / getProfile / 派发）与设置页列表都从这里取**：同一次裁决的两种投影，
   * 列表上标着生效的就是真正在用的那份。
   */
  private resolveProfiles(): ShadowResolved<AgentProfile>[] {
    return resolveShadowing<AgentProfile>([
      ...this.builtinAgents().map((profile) => ({
        name: profile.name,
        source: 'builtin' as const,
        value: profile
      })),
      ...this.scanDir(this.userDir, 'user').map((profile) => ({
        name: profile.name,
        source: 'user' as const,
        fileName: basename(profile.basePath),
        value: profile
      }))
    ])
  }

  /** 生效的用户档案（同名的几份里胜出的那些）—— 按名寻址的读 / 写 / 删用 */
  private activeUserProfiles(): AgentProfile[] {
    return this.resolveProfiles()
      .filter((entry) => entry.source === 'user' && !entry.shadowedBy)
      .map((entry) => entry.value)
  }

  /** 列出所有生效的 agent（同名裁决之后的结果） */
  listAll(): AgentProfile[] {
    return this.resolveProfiles()
      .filter((entry) => !entry.shadowedBy)
      .map((entry) => entry.value)
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * 设置页列表：同一次同名裁决的全部份数 —— 被遮蔽的（被用户档案压过的内置，或同名用户文件里
   * 没胜出的那几份）带 `overridden: true` 与 `overriddenBy`，只作展示，不进任何运行时路径。
   */
  listForSettings(): AgentListItem[] {
    return this.resolveProfiles()
      .map(
        (entry): AgentListItem =>
          entry.shadowedBy
            ? {
                ...entry.value,
                overridden: true,
                ...(entry.shadowedBy.fileName ? { overriddenBy: entry.shadowedBy.fileName } : {})
              }
            : entry.value
      )
      .sort(compareRows)
  }

  /**
   * 这份档案能否**作为某条会话自己的档案** —— 子会话钉档案的准入
   * （sessionService.pinAgentProfile：session 工具 `create-sub-session` 的 `agent_profile`）。
   *
   * 判据只有名字：基座档案（work / chat / notebook）不算，它们由会话形态推导、从不被点名
   * （见 BASE_PROFILE_NAMES）；其余任何档案都可以。曾经还有第二道门 `shuvix-session-awareness`
   * （只可派发的执行体不声明它），随会话内切换档案一并退役：能点名子会话档案的
   * 只剩 LLM 自己，而它被提示词导向 `coding`；为这一种误用留一个要用户在 GUI 里勾的开关不值。
   */
  isSessionProfile(profile: AgentProfile): boolean {
    return !BASE_PROFILE_NAMES.has(profile.name)
  }

  /**
   * 按名取档案。
   *
   * 这里**不需要**给内置档案再兜一层底：一份解析不了的用户 md 会被 scanDir 静默跳过，
   * 因而不进同名裁决的候选、也就遮蔽不了同名内置 —— `listAll()` 里那份内置原样还在。
   * 「一份写坏的 `chat.md` / `work.md` 不会让对应形态的会话建不出根 Agent」这条
   * 性质由那条跳过守住（回归钉在 agentService.test.ts 的 AS-20），不是由这里守住；
   * 之前那个 `if (found) return found` + 按名重取内置的分支恒不可达，已删。
   */
  getProfile(name: string): AgentProfile | undefined {
    return this.listAll().find((a) => a.name === name)
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
   * 取 agent 的 md 原文（原文编辑器的数据源）。用户档案读文件原文（注释、键序原样）；
   * 内置档案无文件，用 serializeAgentDefinitionFile 回写等价 md —— 即「创建覆盖副本」
   * 的初值（与 policyService.getSource 同形）。
   */
  getSource(name: string, source: 'builtin' | 'user'): { text: string } | { error: string } {
    if (source === 'user') {
      const target = this.activeUserProfiles().find((a) => a.name === name)
      if (!target?.basePath) return { error: `Agent "${name}" not found` }
      try {
        return { text: readFileSync(target.basePath, 'utf-8') }
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) }
      }
    }
    const builtin = this.builtinAgents().find((a) => a.name === name)
    if (!builtin) return { error: `Builtin agent "${name}" not found` }
    // AgentProfile 的 tools / instructionFiles 是 readonly，ParsedAgentFile 要可变数组 —— 拷一份即可
    return {
      text: serializeAgentDefinitionFile({
        ...builtin,
        tools: [...builtin.tools],
        instructionFiles: [...builtin.instructionFiles]
      })
    }
  }

  /**
   * 解析并校验一份待写入的 agent 原文。**非法一律拒绝写盘**并回传解析器的人读原因
   * （与 policyService.parseForWrite 同策：与其让一份不可解析的档案躺在磁盘上被扫描
   * 静默跳过，不如当场说清哪里错了）。
   */
  private parseSourceForWrite(
    text: string,
    defaultName: string
  ): { parsed: ParsedAgentFile } | { error: string } {
    const messages: string[] = []
    const parsed = parseAgentDefinitionFile(text, defaultName, (msg) => messages.push(msg))
    if (!parsed) return { error: messages.join('\n') || 'Invalid agent file' }
    return { parsed }
  }

  /**
   * 按原文新建用户 agent 文件（「新建」与「创建覆盖副本」共用）。文件名由 frontmatter
   * `name` 净化派生（冲突追加数字后缀）；与既有用户 agent 重名拒绝，覆盖内置放行。
   */
  createAgentSource(text: string): { success: boolean; name?: string; error?: string } {
    const result = this.parseSourceForWrite(text, 'agent')
    if ('error' in result) return { success: false, error: result.error }
    const name = result.parsed.name

    if (this.scanDir(this.userDir, 'user').some((a) => a.name === name)) {
      return { success: false, error: `Agent "${name}" already exists` }
    }

    const safeBase = registryFileBase(name) || 'agent'
    this.ensureUserDir()
    let filePath = join(this.userDir, `${safeBase}.md`)
    for (let i = 1; existsSync(filePath); i++) {
      filePath = join(this.userDir, `${safeBase}-${i}.md`)
    }

    try {
      writeFileSync(filePath, text, 'utf-8')
    } catch (e) {
      log.warn(`新建 agent 原文 "${name}" 失败:`, e)
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
    return { success: true, name }
  }

  /**
   * 保存（覆写）用户 agent 定义文件 —— 设置页编辑 GUI 的写路径。
   * `originalName` 定位现有文件（文件路径不随改名变，frontmatter `name` 为准）；
   * 内置 agent 无文件不可编辑。
   */
  saveAgent(originalName: string, input: ParsedAgentFile): { success: boolean; error?: string } {
    const users = this.scanDir(this.userDir, 'user')
    const target = this.activeUserProfiles().find((a) => a.name === originalName)
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

    // 文件名净化（与同名裁决认「文件名就是这个名字」同一套规则）；frontmatter name 才是标识
    const safeBase = registryFileBase(name) || 'agent'
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
   * 删除生效的那份用户 agent 定义文件（设置页删除按钮）。仅用户档案可删（内置无文件）；
   * 删除覆盖档案后同名内置自动恢复生效（合并语义）。同名里被遮蔽的那几份按文件名删（deleteByFile）。
   */
  deleteAgent(name: string): { success: boolean; error?: string } {
    const target = this.activeUserProfiles().find((a) => a.name === name)
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

  /** 目录里无法解析的档案文件（设置页「无法解析」分组 —— 写到一半的档案不该从列表里消失） */
  listInvalid(): InvalidAgentFile[] {
    return this.scanDirWithInvalid(this.userDir, 'user').invalid
  }

  /**
   * 按文件名删除 —— 解析不过的档案没有 name，走不了 deleteAgent；同名里被遮蔽的那几份按名删会删到
   * 生效的那份。文件名白名单：只接受 agents
   * 目录下的单个 .md（fileName 来自渲染进程，按不可信入参处理，杜绝路径穿越）。
   */
  deleteByFile(fileName: string): { success: boolean; error?: string } {
    const filePath = join(this.userDir, fileName)
    if (!/^[^/\\]+\.md$/i.test(fileName) || fileName.startsWith('.') || !existsSync(filePath)) {
      return { success: false, error: `Agent file "${fileName}" not found` }
    }
    try {
      unlinkSync(filePath)
    } catch (e) {
      log.warn(`删除 agent 文件 "${fileName}" 失败:`, e)
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
    log.info(`已删除 agent 文件 "${fileName}"`)
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
