/**
 * SkillService — 基于文件系统的 Skill 管理
 * 全局 skills：~/.shuvix/skills/<name>/SKILL.md（+ 可选伴随文件）
 * 外部目录：用户添加的额外 skill 源，每个目录有唯一 name，skill 标识为 dirName:skillName
 * 项目 skills：<projectPath>/.claude/skills/<name>/SKILL.md
 * 启用/禁用状态针对全局和外部 skills，存储在 ~/.shuvix/skills/.config.json
 * 项目级 skills 始终启用
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'fs'
import { dirname, join, resolve, sep } from 'path'
import i18next from 'i18next'
import type { Skill, SkillUpdateParams, SkillDir, SkillGroup } from '../types'
import type { SlashCommand } from '@shuvix/chat-protocol/types/slashCommand'
import log from 'electron-log/main'
import { getDefaultSkillsDir, getBuiltinSkillsDir } from '../utils/paths'
import { appEventBus } from '../utils/appEventBus'

/** 配置文件结构 */
interface SkillConfig {
  /** 禁用的 skill 名称集合（默认全部启用） */
  disabled: string[]
  /** 禁用的分组目录名集合（默认全部启用，分组关闭后整组失效） */
  disabledDirs: string[]
  /** 用户添加的外部 skill 目录 */
  dirs: SkillDir[]
}

type SkillSource = 'default' | 'project' | 'external' | 'builtin'

/** 内置 skill 的固定目录名（对应 dirName 字段，构建出 builtin:<name> 标识） */
const BUILTIN_DIR_NAME = 'builtin'

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
          dirs: raw.dirs ?? []
        }
      }
    } catch (e) {
      log.warn('读取 skills 配置失败:', e)
    }
    return { disabled: [], disabledDirs: [], dirs: [] }
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

    const entries = readdirSync(dir, { withFileTypes: true })
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

    // 3. 外部目录
    for (const dir of config.dirs) {
      allSkills.push(...this.scanSkillsDir(dir.path, 'external', config, dir.name))
    }

    if (!projectPath) return allSkills.sort((a, b) => a.name.localeCompare(b.name))

    // 4. 项目级 skills（同名覆盖）
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
    const isGroupEnabled = (dirName: string): boolean => !config.disabledDirs.includes(dirName)

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
        isEnabled: isGroupEnabled(BUILTIN_DIR_NAME),
        skills: builtinSkills
      })
    }

    // 默认目录
    groups.push({
      dirName: 'default',
      dirPath: this.skillsDir,
      isDefault: true,
      isEnabled: isGroupEnabled('default'),
      skills: this.scanSkillsDir(this.skillsDir, 'default', config).sort((a, b) =>
        a.name.localeCompare(b.name)
      )
    })

    // 外部目录
    for (const dir of config.dirs) {
      groups.push({
        dirName: dir.name,
        dirPath: dir.path,
        isDefault: false,
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
          isEnabled: isGroupEnabled('project'),
          skills: projectSkills.sort((a, b) => a.name.localeCompare(b.name))
        })
      }
    }

    return groups
  }

  /**
   * 获取所有已启用的 Skill
   * 项目级 skills 始终启用；分组总开关关闭时整组失效
   */
  findEnabled(projectPath?: string): Skill[] {
    const config = this.readConfig()
    const disabledDirSet = new Set(config.disabledDirs)
    return this.findAll(projectPath).filter((s) => {
      if (!s.isEnabled) return false
      // 默认目录用 'default'；项目级用 'project'；其它用 dirName
      const groupKey =
        s.source === 'default' ? 'default' : s.source === 'project' ? 'project' : (s.dirName ?? '')
      return !disabledDirSet.has(groupKey)
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
   * 这个绝对路径是不是落在**可写的**技能根下（默认目录或某个外部目录）——笔记本写完
   * `SKILL.md` 之后据此广播 `skill.changed`，侧栏那一组才跟得上改名。
   * 内置目录刻意不算：它只读，那儿本就不该有写入。
   */
  isInsideWritableRoot(absPath: string): boolean {
    const roots = [this.skillsDir, ...this.listExternalDirs().map((d) => d.path)]
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

  /**
   * 添加外部 skill 源目录。
   *
   * 目录名不是装饰：它是组内技能标识的前缀（`<dirName>:<skillName>`）、分组的键、以及笔记本
   * 承载项目 id 的一段（`__skills:<dirName>__`）。所以三条准入不能省：
   *   - **不能为空**：空名拼出的承载 id 不被 `isSkillProjectId` 认作技能项目，那个隐藏载体
   *     会就此出现在项目列表与日历上；
   *   - **不能含 `:`**：标识按第一个冒号切，含冒号的目录名会让「哪一半是目录」整个错位；
   *   - **不能占用保留组键**（`default` / `builtin` / `project`）：它们在分组、启用判定与侧栏
   *     渲染里都当作来源标记用 —— 取名 `builtin` 会让这个外部目录被当成内置，点开的是另一个
   *     根下的文件。
   */
  addExternalDir(dir: SkillDir): void {
    const name = dir.name.trim()
    if (!name) {
      throw new Error('Directory name is required')
    }
    if (name.includes(':')) {
      throw new Error('Directory name cannot contain ":"')
    }
    if (name === 'default' || name === BUILTIN_DIR_NAME || name === 'project') {
      throw new Error(`Directory name "${name}" is reserved`)
    }
    if (!existsSync(dir.path)) {
      throw new Error(`Directory does not exist: ${dir.path}`)
    }
    if (dir.path === this.skillsDir) {
      throw new Error('Cannot add the default skills directory')
    }

    const config = this.readConfig()
    // 落库的是 trim 过的那个名字 —— 重名判定与之后的一切（标识前缀、承载 id）都按它算
    if (config.dirs.some((d) => d.name === name)) {
      throw new Error(`Directory name "${name}" already exists`)
    }
    if (config.dirs.some((d) => d.path === dir.path)) {
      throw new Error(`Directory path "${dir.path}" already added`)
    }

    config.dirs.push({ name, path: dir.path })
    this.writeConfig(config)
  }

  /** 移除外部 skill 源目录 */
  removeExternalDir(rawName: string): void {
    // 落库的是 trim 过的名字（见 addExternalDir），移除按同一口径找，免得一对读写各认各的
    const name = rawName.trim()
    const config = this.readConfig()
    const prefix = `${name}:`
    config.dirs = config.dirs.filter((d) => d.name !== name)
    // 清理该目录下 skill 的 disabled 记录
    config.disabled = config.disabled.filter((n) => !n.startsWith(prefix))
    config.disabledDirs = config.disabledDirs.filter((n) => n !== name)
    this.writeConfig(config)
  }

  /** 切换分组总开关：关闭后该分组所有 skills 失效 */
  setGroupEnabled(dirName: string, isEnabled: boolean): void {
    const config = this.readConfig()
    if (isEnabled) {
      config.disabledDirs = config.disabledDirs.filter((n) => n !== dirName)
    } else if (!config.disabledDirs.includes(dirName)) {
      config.disabledDirs.push(dirName)
    }
    this.writeConfig(config)
  }
}

export const skillService = new SkillService()
