/**
 * SkillService — 基于文件系统的 Skill 管理
 * 全局 skills：~/.shuvix/skills/<name>/SKILL.md（+ 可选伴随文件）
 * 外部目录：用户添加的额外 skill 源，每个目录有唯一 name，skill 标识为 dirName:skillName
 * 共用目录：与别的智能体共用的 ~/.claude/skills 与 ~/.agents/skills —— 宿主固定列出（标识
 *   claude:skillName / agents:skillName），整组缺省关着
 * 项目 skills：<projectPath>/.claude/skills/<name>/SKILL.md
 * 启用/禁用状态针对全局、外部与共用 skills，存储在 ~/.shuvix/skills/.config.json
 * 项目级 skills 始终启用
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  realpathSync,
  rmSync
} from 'fs'
import type { Dirent } from 'fs'
import { dirname, join, resolve, sep } from 'path'
import i18next from 'i18next'
import { parse as parseYaml } from 'yaml'
import type { Skill, SkillUpdateParams, SkillDir, SkillGroup } from '../types'
import type { SlashCommand } from '@shuvix/chat-protocol/types/slashCommand'
import log from 'electron-log/main'
import { getDefaultSkillsDir, getBuiltinSkillsDir, getSharedSkillsDirs } from '../utils/paths'
import { appEventBus } from '../utils/appEventBus'

/** 配置文件结构 */
interface SkillConfig {
  /** 禁用的 skill 名称集合（默认全部启用） */
  disabled: string[]
  /** 禁用的分组目录名集合（默认全部启用，分组关闭后整组失效） */
  disabledDirs: string[]
  /**
   * **打开了的**缺省关着的分组 —— 只对共用目录（`claude` / `agents`）有意义，别的分组看 disabledDirs。
   * 两个集合各管一边，而不是给共用目录预先塞一条 disabledDirs：那样「没写过配置」与「关着」
   * 就分不开了，删掉 `.config.json` 会让共用目录整组打开。
   */
  enabledDirs: string[]
  /** 用户添加的外部 skill 目录 */
  dirs: SkillDir[]
}

type SkillSource = 'default' | 'project' | 'external' | 'builtin' | 'shared'

/** 内置 skill 的固定目录名（对应 dirName 字段，构建出 builtin:<name> 标识） */
const BUILTIN_DIR_NAME = 'builtin'

/**
 * 共用目录的组键（同时是技能标识的前缀）与行上的写法。顺序即侧栏顺序。
 *
 * 为什么缺省关着：那两个目录是别的工具的，里面装的东西用户未必想让 ShuviX 的 agent 看见 ——
 * 列出来是让它们「找得到」，打不打开由用户决定。
 */
const SHARED_DIRS = [
  { name: 'claude', label: '~/.claude/skills' },
  { name: 'agents', label: '~/.agents/skills' }
] as const

/** 外部目录不能取的名字：它们在分组、启用判定与标识前缀里另有所指 */
const RESERVED_DIR_NAMES = new Set<string>([
  'default',
  BUILTIN_DIR_NAME,
  'project',
  ...SHARED_DIRS.map((d) => d.name)
])

/** 一个在列的共用目录 */
interface SharedDir {
  name: string
  path: string
  label: string
}

/**
 * 两个路径是不是同一个目录：能解析到真实位置就比真实位置（经过一条符号链接、或在不分大小写的
 * 磁盘上换了大小写写的同一个目录，都算同一个），解析不了（还不存在）就比 resolve 之后的字面。
 */
function samePath(a: string, b: string): boolean {
  return resolve(a) === resolve(b) || realOf(a) === realOf(b)
}

/** 路径真正通到的位置；解析不了（还不存在）就是 resolve 之后的字面 */
function realOf(p: string): string {
  try {
    return realpathSync.native(p)
  } catch {
    return resolve(p)
  }
}

/** YAML 块标量的头（`>` / `|`，可带缩进数字与 `+` / `-`）—— 按行读到的 description 只有这么一截 */
const BLOCK_SCALAR_HEADER = /^[>|](?:[1-9][+-]?|[+-][1-9]?)?$/

/**
 * frontmatter 按 YAML 读成对象；读不了、或读出来不是映射就 null（调用方留按行读的值）。
 * `logLevel: 'error'` 而不是 'silent'：后者会吞掉语法错误、交回半截结果，那正是要退回按行读的情形。
 */
function parseFrontmatterYaml(frontmatter: string): Record<string, unknown> | null {
  try {
    const doc: unknown = parseYaml(frontmatter, { logLevel: 'error' })
    return doc !== null && typeof doc === 'object' && !Array.isArray(doc)
      ? (doc as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** 笔记本写入后广播 `skill.changed` 的合并窗口（自动保存每 200ms 落一次盘） */
const CHANGED_DEBOUNCE_MS = 300

class SkillService {
  /** skills 根目录 */
  private readonly skillsDir: string
  /** 笔记本写入 → `skill.changed` 的合并窗口计时器（见 noteFileWritten） */
  private changedTimer: ReturnType<typeof setTimeout> | null = null

  constructor() {
    this.skillsDir = getDefaultSkillsDir()
    this.ensureDir(this.skillsDir)
  }

  /** 确保目录存在 */
  private ensureDir(dir: string): void {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
  }

  /** 读取配置文件 */
  private readConfig(): SkillConfig {
    const configPath = join(this.skillsDir, '.config.json')
    try {
      if (existsSync(configPath)) {
        const raw = JSON.parse(readFileSync(configPath, 'utf-8'))
        return {
          disabled: raw.disabled ?? [],
          disabledDirs: raw.disabledDirs ?? [],
          enabledDirs: raw.enabledDirs ?? [],
          dirs: raw.dirs ?? []
        }
      }
    } catch (e) {
      log.warn('读取 skills 配置失败:', e)
    }
    return { disabled: [], disabledDirs: [], enabledDirs: [], dirs: [] }
  }

  /**
   * 在列的共用目录。用户早先自己把同一个目录（或同名的目录）加成了外部目录的，那一条照旧
   * 归它 —— 它开着、它的技能标识（`<它取的名>:<skill>`）已经写进了会话的扩展选择，换成共用
   * 目录那一组就等于把它们悄悄关掉、再列出一份重复的。
   */
  private sharedDirs(config: SkillConfig): SharedDir[] {
    const paths = getSharedSkillsDirs()
    return SHARED_DIRS.map((d) => ({ ...d, path: paths[d.name] })).filter(
      (d) => !config.dirs.some((x) => x.name === d.name || samePath(x.path, d.path))
    )
  }

  /** 这个组键是不是一个在列的共用目录（它们的开关缺省关着，见 SkillConfig.enabledDirs） */
  private isSharedKey(config: SkillConfig, dirName: string): boolean {
    return this.sharedDirs(config).some((d) => d.name === dirName)
  }

  /**
   * 分组总开关的判定：共用目录要显式打开，其余分组要显式关掉。返回一个判定函数而不是直接判 ——
   * 在列的共用目录要比对真实路径，逐个技能判的地方（findEnabled）只该算这一次。
   */
  private groupSwitch(config: SkillConfig): (dirName: string) => boolean {
    const shared = new Set(this.sharedDirs(config).map((d) => d.name))
    return (dirName) =>
      shared.has(dirName)
        ? config.enabledDirs.includes(dirName)
        : !config.disabledDirs.includes(dirName)
  }

  /** 写入配置文件 */
  private writeConfig(config: SkillConfig): void {
    const configPath = join(this.skillsDir, '.config.json')
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
    // 配置是启用开关 / 分组开关 / 外部目录的唯一落点：从这里广播，侧栏那一组就不必各处补通知
    appEventBus.publish({ type: 'skill.changed' })
  }

  /**
   * 解析 SKILL.md — 提取 YAML frontmatter 中的 name 和 description
   * 返回 null 表示解析失败
   */
  parseSkillMarkdown(text: string): { name: string; description: string; content: string } | null {
    const trimmed = text.trim()
    if (!trimmed.startsWith('---')) return null

    const endIndex = trimmed.indexOf('---', 3)
    if (endIndex === -1) return null

    const frontmatter = trimmed.slice(3, endIndex).trim()
    const content = trimmed.slice(endIndex + 3).trim()

    let name = ''
    let description = ''

    for (const line of frontmatter.split('\n')) {
      const colonIdx = line.indexOf(':')
      if (colonIdx === -1) continue
      const key = line.slice(0, colonIdx).trim()
      // 移除引号包裹
      const val = line
        .slice(colonIdx + 1)
        .trim()
        .replace(/^["']|["']$/g, '')
      if (key === 'name') name = val
      if (key === 'description') description = val
    }

    // YAML 只补按行读不出来的那一种：description 写成多行。别处装来的技能常写 `description: >`
    // （按行切只拿得到一个 `>`），或者把一句话折到下一行（按行切只拿得到第一行）。别的一律留按行读的
    // 值 —— 合法 YAML 也会把它读成另一个样子（` #42` 起头的部分是注释、`''` 是转义），而今天读得出来
    // 的每一份都不该因此变样；`name` 更是一个字不动：它是技能标识，`.config.json` 的开关与会话勾选
    // 都按它记。手写的 `description: Use when: …` 不是合法 YAML，读不了，同样留按行读的值。
    const yamlDescription = parseFrontmatterYaml(frontmatter)?.description
    if (typeof yamlDescription === 'string') {
      const folded = yamlDescription.trim()
      if (
        BLOCK_SCALAR_HEADER.test(description) ||
        (folded.length > description.length && folded.startsWith(description))
      ) {
        description = folded
      }
    }

    if (!name) return null
    return { name, description, content }
  }

  /** 从指定目录加载单个 skill */
  private loadSkillFromDir(
    dir: string,
    dirEntryName: string,
    source: SkillSource,
    config: SkillConfig,
    dirName?: string
  ): Skill | null {
    const mdPath = join(dir, 'SKILL.md')
    if (!existsSync(mdPath)) return null

    try {
      const raw = readFileSync(mdPath, 'utf-8')
      const parsed = this.parseSkillMarkdown(raw)

      // 构建全局唯一名称
      const rawName = parsed ? parsed.name : dirEntryName
      const globalName = dirName ? `${dirName}:${rawName}` : rawName
      const isEnabled = source === 'project' ? true : !config.disabled.includes(globalName)

      if (parsed) {
        return {
          name: globalName,
          description: parsed.description,
          content: parsed.content,
          basePath: dir,
          isEnabled,
          source,
          dirName
        }
      }

      // frontmatter 解析失败时，用目录名作为 name，全文作为 content
      return {
        name: globalName,
        description: '',
        content: raw.trim(),
        basePath: dir,
        isEnabled,
        source,
        dirName
      }
    } catch (e) {
      log.warn(`加载 skill "${dirEntryName}" 失败:`, e)
      return null
    }
  }

  /** 扫描指定目录下的所有 skills */
  private scanSkillsDir(
    dir: string,
    source: SkillSource,
    config: SkillConfig,
    dirName?: string
  ): Skill[] {
    if (!existsSync(dir)) return []

    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (e) {
      // 共用目录是别的工具的、不是用户挑的：它是个文件、读不了，都只该让这一组空着，不能让整份清单抛
      log.warn(`扫描 skills 目录失败: ${dir}`, e)
      return []
    }
    const skills: Skill[] = []

    for (const entry of entries) {
      // 跳过配置文件和隐藏文件
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const skill = this.loadSkillFromDir(
        join(dir, entry.name),
        entry.name,
        source,
        config,
        dirName
      )
      if (skill) skills.push(skill)
    }

    return skills
  }

  /**
   * 获取所有已安装的 Skill
   * 传入 projectPath 时，合并项目级 .claude/skills/ 中的 skills（项目级同名覆盖全局）
   */
  findAll(projectPath?: string): Skill[] {
    const config = this.readConfig()
    const allSkills: Skill[] = []

    // 1. 内置目录（随应用发布，只读）
    allSkills.push(
      ...this.scanSkillsDir(getBuiltinSkillsDir(), 'builtin', config, BUILTIN_DIR_NAME)
    )

    // 2. 默认目录
    allSkills.push(...this.scanSkillsDir(this.skillsDir, 'default', config))

    // 3. 共用目录（~/.claude/skills、~/.agents/skills）
    for (const dir of this.sharedDirs(config)) {
      allSkills.push(...this.scanSkillsDir(dir.path, 'shared', config, dir.name))
    }

    // 4. 外部目录
    for (const dir of config.dirs) {
      allSkills.push(...this.scanSkillsDir(dir.path, 'external', config, dir.name))
    }

    if (!projectPath) return allSkills.sort((a, b) => a.name.localeCompare(b.name))

    // 5. 项目级 skills（同名覆盖）
    const projectSkillsDir = join(projectPath, '.claude', 'skills')
    const projectSkills = this.scanSkillsDir(projectSkillsDir, 'project', config)
    if (projectSkills.length === 0) return allSkills.sort((a, b) => a.name.localeCompare(b.name))

    const projectNames = new Set(projectSkills.map((s) => s.name))
    return [...allSkills.filter((s) => !projectNames.has(s.name)), ...projectSkills].sort((a, b) =>
      a.name.localeCompare(b.name)
    )
  }

  /**
   * 获取按目录分组的 Skill 列表
   */
  findAllGrouped(projectPath?: string): SkillGroup[] {
    const config = this.readConfig()
    const groups: SkillGroup[] = []
    const isGroupEnabled = this.groupSwitch(config)

    // 内置目录（仅在存在任一内置 skill 时才展示分组）
    const builtinDir = getBuiltinSkillsDir()
    const builtinSkills = this.scanSkillsDir(builtinDir, 'builtin', config, BUILTIN_DIR_NAME).sort(
      (a, b) => a.name.localeCompare(b.name)
    )
    if (builtinSkills.length > 0) {
      groups.push({
        dirName: BUILTIN_DIR_NAME,
        dirPath: builtinDir,
        isDefault: false,
        isShared: false,
        isEnabled: isGroupEnabled(BUILTIN_DIR_NAME),
        skills: builtinSkills
      })
    }

    // 默认目录
    groups.push({
      dirName: 'default',
      dirPath: this.skillsDir,
      isDefault: true,
      isShared: false,
      isEnabled: isGroupEnabled('default'),
      skills: this.scanSkillsDir(this.skillsDir, 'default', config).sort((a, b) =>
        a.name.localeCompare(b.name)
      )
    })

    // 共用目录：与内置同策，一个技能都没有就不给这一组 —— 它们移不掉，没用过那些工具的人
    // 不该天天看着两行空文件夹
    for (const dir of this.sharedDirs(config)) {
      const skills = this.scanSkillsDir(dir.path, 'shared', config, dir.name)
      if (skills.length === 0) continue
      groups.push({
        dirName: dir.name,
        dirPath: dir.path,
        isDefault: false,
        isShared: true,
        label: dir.label,
        isEnabled: isGroupEnabled(dir.name),
        skills: skills.sort((a, b) => a.name.localeCompare(b.name))
      })
    }

    // 外部目录
    for (const dir of config.dirs) {
      groups.push({
        dirName: dir.name,
        dirPath: dir.path,
        isDefault: false,
        isShared: false,
        isEnabled: isGroupEnabled(dir.name),
        skills: this.scanSkillsDir(dir.path, 'external', config, dir.name).sort((a, b) =>
          a.name.localeCompare(b.name)
        )
      })
    }

    // 项目级
    if (projectPath) {
      const projectSkillsDir = join(projectPath, '.claude', 'skills')
      const projectSkills = this.scanSkillsDir(projectSkillsDir, 'project', config)
      if (projectSkills.length > 0) {
        groups.push({
          dirName: 'project',
          dirPath: projectSkillsDir,
          isDefault: false,
          isShared: false,
          isEnabled: isGroupEnabled('project'),
          skills: projectSkills.sort((a, b) => a.name.localeCompare(b.name))
        })
      }
    }

    return groups
  }

  /**
   * 获取所有已启用的 Skill
   * 项目级 skills 始终启用；分组总开关关闭时整组失效（共用目录的总开关缺省关着）
   */
  findEnabled(projectPath?: string): Skill[] {
    const isGroupEnabled = this.groupSwitch(this.readConfig())
    return this.findAll(projectPath).filter((s) => {
      if (!s.isEnabled) return false
      // 默认目录用 'default'；项目级用 'project'；其它用 dirName
      const groupKey =
        s.source === 'default' ? 'default' : s.source === 'project' ? 'project' : (s.dirName ?? '')
      return isGroupEnabled(groupKey)
    })
  }

  /**
   * 把已启用的 Skill 适配成 SlashCommand 形态，供 commandService 合入命令池。
   * 模板 = 原 SKILL.md 正文（已剥过 frontmatter）+ "Base directory" 头 + 静态替换 ${CLAUDE_SKILL_DIR}。
   * ${CLAUDE_SESSION_ID} 留到前端 expand 时替换（renderer 知道 activeSessionId）。
   *
   * commandId 直接用 skill.name（已经处理过命名空间，比如外部目录的 dirName:name）。
   *
   * 内置 skill 的 description 会被 i18n key `command.skills.<rawName>` 覆盖（若已配置），
   * 因为 SKILL.md frontmatter 的 description 通常含大量触发关键词，不适合作 popover 文案。
   */
  findEnabledAsCommands(projectPath?: string): SlashCommand[] {
    return this.findEnabled(projectPath).map((s) => {
      const baseDir = s.basePath
      const normalizedDir = process.platform === 'win32' ? baseDir.replace(/\\/g, '/') : baseDir
      const body = s.content.trim()
      const template = `Base directory for this skill: ${normalizedDir}\n\n${body}`.replaceAll(
        '${CLAUDE_SKILL_DIR}',
        normalizedDir
      )
      // 内置 skill 用单独维护的多语言短描述覆盖（仅显示用，不影响注入正文）
      let description = s.description
      if (s.source === 'builtin') {
        const rawName = s.dirName ? s.name.slice(s.dirName.length + 1) : s.name
        const key = `command.skills.${rawName}`
        if (i18next.exists(key)) {
          description = i18next.t(key)
        }
      }
      return {
        commandId: s.name,
        name: s.name,
        description,
        template,
        filePath: join(baseDir, 'SKILL.md'),
        kind: 'skill'
      }
    })
  }

  /**
   * 根据名称获取单个 Skill
   * 传入 projectPath 时，优先查找项目级 skill
   * 注意：目录名可能与 SKILL.md 中的 name 字段不同，需遍历匹配
   */
  findByName(name: string, projectPath?: string): Skill | null {
    return this.findAll(projectPath).find((s) => s.name === name) ?? null
  }

  /** 更新 Skill */
  update(params: SkillUpdateParams): void {
    // 处理启用/禁用（对默认和外部 skill 都生效）
    if (params.isEnabled !== undefined) {
      const config = this.readConfig()
      if (params.isEnabled) {
        config.disabled = config.disabled.filter((n) => n !== params.name)
      } else {
        if (!config.disabled.includes(params.name)) {
          config.disabled.push(params.name)
        }
      }
      this.writeConfig(config)
    }

    // 更新 SKILL.md 内容（仅默认目录的 skill）
    if (params.description !== undefined || params.content !== undefined) {
      // 从 name 中判断是否为外部 skill（含 : 前缀）
      const skill = this.findByName(params.name)
      if (!skill) throw new Error(`Skill "${params.name}" not found`)
      if (skill.source !== 'default') {
        throw new Error(
          skill.source === 'builtin'
            ? 'Cannot edit built-in skills (bundled with the app)'
            : 'Cannot edit skills from external directories'
        )
      }

      const dir = skill.basePath
      const desc = params.description ?? skill.description
      const content = params.content ?? skill.content
      const md = `---\nname: ${params.name}\ndescription: "${desc}"\n---\n\n${content}`
      writeFileSync(join(dir, 'SKILL.md'), md, 'utf-8')
      appEventBus.publish({ type: 'skill.changed' })
    }
  }

  /**
   * 删除默认目录中的 Skill（移除整个子目录）。
   *
   * 两处刻意不省：
   *   - **按注册表定位、删 `basePath`**，不拿 `name` 去拼路径 —— 技能的 name 来自 SKILL.md
   *     的 frontmatter，与磁盘目录名并不总是相等（见 loadSkillFromDir），拼出来的路径可能
   *     根本不存在：那会变成「配置清了、事件发了、目录纹丝不动」的静默失败；
   *   - **删之前再确认这个目录就在默认根的下一层**。`name` 来自渲染进程，按不可信入参处理
   *     （同 registryNotes 对文件名的白名单）：`rmSync(recursive)` 是不可逆操作，一个
   *     `../` 就能出界。
   */
  deleteDefaultSkill(name: string): void {
    const skill = this.findByName(name)
    if (!skill || skill.source !== 'default') {
      throw new Error(`Skill "${name}" not found in the default skills directory`)
    }
    const dir = resolve(skill.basePath)
    const parent = resolve(this.skillsDir)
    if (dirname(dir) !== parent || dir === parent) {
      throw new Error(`Refusing to delete outside the default skills directory: ${dir}`)
    }
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true })
    }

    // 从配置中清理
    const config = this.readConfig()
    config.disabled = config.disabled.filter((n) => n !== name)
    this.writeConfig(config)
  }

  /**
   * 这个绝对路径是不是落在**可写的**技能根下（默认目录、某个外部目录或共用目录）——笔记本写完
   * `SKILL.md` 之后据此广播 `skill.changed`，侧栏那一组才跟得上改名。
   * 内置目录刻意不算：它只读，那儿本就不该有写入。
   */
  isInsideWritableRoot(absPath: string): boolean {
    const config = this.readConfig()
    const roots = [
      this.skillsDir,
      ...config.dirs.map((d) => d.path),
      ...this.sharedDirs(config).map((d) => d.path)
    ]
    return roots.some((root) => absPath.startsWith(root.endsWith(sep) ? root : root + sep))
  }

  /**
   * 笔记本刚往某个路径落了一笔盘：落在可写的技能根下就（合并窗口内）广播一次 `skill.changed`,
   * 让侧栏那一组重扫 —— 技能的行标签取自 SKILL.md 的 frontmatter，改名就发生在笔记本里，
   * 没有「切窗口」这一下可以兜底。合并窗口的理由同 bot / agent：自动保存每 200ms 落一次盘。
   */
  noteFileWritten(absPath: string): void {
    if (!this.isInsideWritableRoot(absPath)) return
    if (this.changedTimer) clearTimeout(this.changedTimer)
    this.changedTimer = setTimeout(() => {
      this.changedTimer = null
      appEventBus.publish({ type: 'skill.changed' })
    }, CHANGED_DEBOUNCE_MS)
  }

  /** 获取 skills 根目录路径 */
  getDefaultSkillsDir(): string {
    return this.skillsDir
  }

  // ============ 目录管理 ============

  /** 获取所有外部 skill 源目录 */
  listExternalDirs(): SkillDir[] {
    return this.readConfig().dirs
  }

  /** 在列的共用目录（`claude` → ~/.claude/skills，`agents` → ~/.agents/skills；被用户早先加过的不在列） */
  listSharedDirs(): SkillDir[] {
    return this.sharedDirs(this.readConfig()).map(({ name, path }) => ({ name, path }))
  }

  /**
   * 用户这边启用着的技能根目录：默认目录 + 没被整组关掉的外部目录 + 打开了的共用目录（内置目录
   * 不在这里，见 paths）。会话目录的只读那一份用它 —— 技能里会让 agent 去读 `references/*.md`，
   * 每读一次都问不值。共用目录关着就不给：`~/.claude` 底下还有别的工具的东西，用户没打开的那一组
   * 不该因为「列出来了」就变成谁都能不问就读的地方。
   */
  enabledSkillRoots(): string[] {
    const config = this.readConfig()
    return [
      this.skillsDir,
      ...config.dirs.filter((d) => !config.disabledDirs.includes(d.name)).map((d) => d.path),
      ...this.sharedDirs(config)
        .filter((d) => config.enabledDirs.includes(d.name))
        .map((d) => d.path)
    ]
  }

  /**
   * 添加外部 skill 源目录。
   *
   * 目录名不是装饰：它是组内技能标识的前缀（`<dirName>:<skillName>`）、分组的键、以及笔记本
   * 承载项目 id 的一段（`__skills:<dirName>__`）。所以三条准入不能省：
   *   - **不能为空**：空名拼出的承载 id 不被 `isSkillProjectId` 认作技能项目，那个隐藏载体
   *     会就此出现在项目列表与日历上；
   *   - **不能含 `:`**：标识按第一个冒号切，含冒号的目录名会让「哪一半是目录」整个错位；
   *   - **不能占用保留组键**（`default` / `builtin` / `project` / `claude` / `agents`）：它们在
   *     分组、启用判定与侧栏渲染里都当作来源标记用 —— 取名 `builtin` 会让这个外部目录被当成内置，
   *     点开的是另一个根下的文件。
   * 共用目录本身也不能再加一遍：它已经在列，加成外部目录只会把那一组换个名字、换成缺省开着。
   */
  addExternalDir(dir: SkillDir): void {
    const name = dir.name.trim()
    if (!name) {
      throw new Error('Directory name is required')
    }
    if (name.includes(':')) {
      throw new Error('Directory name cannot contain ":"')
    }
    if (RESERVED_DIR_NAMES.has(name)) {
      throw new Error(`Directory name "${name}" is reserved`)
    }
    if (!existsSync(dir.path)) {
      throw new Error(`Directory does not exist: ${dir.path}`)
    }
    // 落库的是 resolve 过的写法，下面每道闸都按它判。resolve 把 `..` 当文字折掉，系统却是先跟链接、
    // 再往上走 —— `<链接>/..` 两边说的不是同一个目录。那样的路径不收：否则闸查的是一个目录，
    // 记下来的是另一个，同一批技能（甚至默认目录）就能换个名字再列一遍
    const stored = resolve(dir.path)
    if (realOf(stored) !== realOf(dir.path)) {
      throw new Error(
        `Directory path "${dir.path}" has ".." after a symbolic link, so it does not name one folder; choose the folder itself`
      )
    }
    if (samePath(stored, this.skillsDir)) {
      throw new Error('Cannot add the default skills directory')
    }

    const config = this.readConfig()
    const shared = this.sharedDirs(config).find((d) => samePath(d.path, stored))
    if (shared) {
      throw new Error(`${shared.label} is a shared skills directory that ShuviX lists by itself`)
    }
    // 落库的是 trim 过的那个名字 —— 重名判定与之后的一切（标识前缀、承载 id）都按它算
    if (config.dirs.some((d) => d.name === name)) {
      throw new Error(`Directory name "${name}" already exists`)
    }
    // 同一个目录换个写法（末尾多个 `/`、带 `..`、经一条符号链接）也是同一个：否则它会以两个名字
    // 各列一遍，同一批技能顶着两个标识
    if (config.dirs.some((d) => samePath(d.path, stored))) {
      throw new Error(`Directory path "${dir.path}" already added`)
    }

    // 落库 resolve 过的写法（去掉末尾的 `/` 与 `..`，不跟符号链接 —— 用户挑的是哪条路就记哪条）
    config.dirs.push({ name, path: stored })
    this.writeConfig(config)
  }

  /**
   * 移除外部 skill 源目录；返回是否真的移除了一条（调用方据此决定要不要连带删承载项目）。
   * 不在 `dirs` 里的名字一律不动 —— 尤其是共用目录的组键：它们移不掉，侧栏不给这个动作，
   * 这里也不能因为名字对得上就把 `claude:*` / `agents:*` 的开关记录清掉、把那一组的笔记会话删掉。
   */
  removeExternalDir(rawName: string): boolean {
    // 落库的是 trim 过的名字（见 addExternalDir），移除按同一口径找，免得一对读写各认各的
    const name = rawName.trim()
    const config = this.readConfig()
    if (!config.dirs.some((d) => d.name === name)) return false
    const prefix = `${name}:`
    config.dirs = config.dirs.filter((d) => d.name !== name)
    // 清理该目录下 skill 的 disabled 记录
    config.disabled = config.disabled.filter((n) => !n.startsWith(prefix))
    config.disabledDirs = config.disabledDirs.filter((n) => n !== name)
    this.writeConfig(config)
    return true
  }

  /** 切换分组总开关：关闭后该分组所有 skills 失效 */
  setGroupEnabled(dirName: string, isEnabled: boolean): void {
    const config = this.readConfig()
    if (this.isSharedKey(config, dirName)) {
      // 共用目录缺省关着：记的是「打开了」
      config.enabledDirs = config.enabledDirs.filter((n) => n !== dirName)
      if (isEnabled) config.enabledDirs.push(dirName)
    } else if (isEnabled) {
      config.disabledDirs = config.disabledDirs.filter((n) => n !== dirName)
    } else if (!config.disabledDirs.includes(dirName)) {
      config.disabledDirs.push(dirName)
    }
    this.writeConfig(config)
  }
}

export const skillService = new SkillService()
