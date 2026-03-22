/**
 * SkillService — 基于文件系统的 Skill 管理
 * 全局 skills：~/.shuvix/skills/<name>/SKILL.md（+ 可选伴随文件）
 * 项目 skills：<projectPath>/.claude/skills/<name>/SKILL.md
 * 启用/禁用状态仅针对全局 skills，存储在 ~/.shuvix/skills/.config.json
 * 项目级 skills 始终启用
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, cpSync } from 'fs'
import { join } from 'path'
import type { Skill, SkillAddParams, SkillUpdateParams } from '../types'
import log from 'electron-log/main'
import { getUserConfigDir } from '../utils/paths'

/** 配置文件结构 */
interface SkillConfig {
  /** 禁用的 skill 名称集合（默认全部启用） */
  disabled: string[]
}

class SkillService {
  /** skills 根目录 */
  private readonly skillsDir: string

  constructor() {
    this.skillsDir = join(getUserConfigDir(), 'skills')
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
        return JSON.parse(readFileSync(configPath, 'utf-8'))
      }
    } catch (e) {
      log.warn('读取 skills 配置失败:', e)
    }
    return { disabled: [] }
  }

  /** 写入配置文件 */
  private writeConfig(config: SkillConfig): void {
    const configPath = join(this.skillsDir, '.config.json')
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
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

  /** 从指定目录加载单个 skill（通用，支持全局和项目目录） */
  private loadSkillFromDir(dir: string, name: string, isProject: boolean): Skill | null {
    const mdPath = join(dir, 'SKILL.md')
    if (!existsSync(mdPath)) return null

    try {
      const raw = readFileSync(mdPath, 'utf-8')
      const parsed = this.parseSkillMarkdown(raw)
      const config = isProject ? null : this.readConfig()

      if (parsed) {
        return {
          name: parsed.name,
          description: parsed.description,
          content: parsed.content,
          basePath: dir,
          isEnabled: isProject ? true : !config!.disabled.includes(name)
        }
      }

      // frontmatter 解析失败时，用目录名作为 name，全文作为 content
      return {
        name,
        description: '',
        content: raw.trim(),
        basePath: dir,
        isEnabled: isProject ? true : !config!.disabled.includes(name)
      }
    } catch (e) {
      log.warn(`加载 skill "${name}" 失败:`, e)
      return null
    }
  }

  /** 从目录加载单个 skill（全局 skills 目录） */
  private loadSkill(name: string): Skill | null {
    return this.loadSkillFromDir(join(this.skillsDir, name), name, false)
  }

  /** 扫描指定目录下的所有 skills */
  private scanSkillsDir(dir: string, isProject: boolean): Skill[] {
    if (!existsSync(dir)) return []

    const entries = readdirSync(dir, { withFileTypes: true })
    const skills: Skill[] = []

    for (const entry of entries) {
      // 跳过配置文件和隐藏文件
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const skill = this.loadSkillFromDir(join(dir, entry.name), entry.name, isProject)
      if (skill) skills.push(skill)
    }

    return skills
  }

  /**
   * 获取所有已安装的 Skill
   * 传入 projectPath 时，合并项目级 .claude/skills/ 中的 skills（项目级同名覆盖全局）
   */
  findAll(projectPath?: string): Skill[] {
    const globalSkills = this.scanSkillsDir(this.skillsDir, false)
    if (!projectPath) return globalSkills.sort((a, b) => a.name.localeCompare(b.name))

    const projectSkillsDir = join(projectPath, '.claude', 'skills')
    const projectSkills = this.scanSkillsDir(projectSkillsDir, true)
    if (projectSkills.length === 0) return globalSkills.sort((a, b) => a.name.localeCompare(b.name))

    // 合并：项目级同名 skill 覆盖全局
    const projectNames = new Set(projectSkills.map((s) => s.name))
    return [...globalSkills.filter((s) => !projectNames.has(s.name)), ...projectSkills].sort(
      (a, b) => a.name.localeCompare(b.name)
    )
  }

  /**
   * 获取所有已启用的 Skill
   * 项目级 skills 始终启用
   */
  findEnabled(projectPath?: string): Skill[] {
    return this.findAll(projectPath).filter((s) => s.isEnabled)
  }

  /**
   * 根据名称获取单个 Skill
   * 传入 projectPath 时，优先查找项目级 skill
   */
  findByName(name: string, projectPath?: string): Skill | null {
    // 优先查项目级
    if (projectPath) {
      const projectDir = join(projectPath, '.claude', 'skills', name)
      const skill = this.loadSkillFromDir(projectDir, name, true)
      if (skill) return skill
    }
    return this.loadSkill(name)
  }

  /** 手动创建 Skill（在 skills 目录下创建子目录 + SKILL.md） */
  create(params: SkillAddParams): Skill {
    const dir = join(this.skillsDir, params.name)
    if (existsSync(dir)) {
      throw new Error(`Skill "${params.name}" already exists`)
    }

    this.ensureDir(dir)

    // 写入 SKILL.md（含 frontmatter）
    const md = `---\nname: ${params.name}\ndescription: "${params.description}"\n---\n\n${params.content}`
    writeFileSync(join(dir, 'SKILL.md'), md, 'utf-8')

    return {
      name: params.name,
      description: params.description,
      content: params.content,
      basePath: dir,
      isEnabled: true
    }
  }

  /** 从本地目录导入 Skill（复制整个目录到 skills 根目录） */
  importFromDirectory(sourcePath: string): Skill {
    const mdPath = join(sourcePath, 'SKILL.md')
    if (!existsSync(mdPath)) {
      throw new Error(`目录中未找到 SKILL.md: ${sourcePath}`)
    }

    const raw = readFileSync(mdPath, 'utf-8')
    const parsed = this.parseSkillMarkdown(raw)
    if (!parsed) {
      throw new Error('SKILL.md 解析失败：缺少有效的 YAML frontmatter')
    }

    // 用解析到的 name（而非目录名）作为 skill 名称
    const targetDir = join(this.skillsDir, parsed.name)
    if (existsSync(targetDir)) {
      throw new Error(`Skill "${parsed.name}" already exists`)
    }

    // 复制整个目录
    cpSync(sourcePath, targetDir, { recursive: true })

    return {
      name: parsed.name,
      description: parsed.description,
      content: parsed.content,
      basePath: targetDir,
      isEnabled: true
    }
  }

  /** 更新 Skill */
  update(params: SkillUpdateParams): void {
    const dir = join(this.skillsDir, params.name)
    if (!existsSync(dir)) {
      throw new Error(`Skill "${params.name}" not found`)
    }

    // 处理启用/禁用
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

    // 更新 SKILL.md 内容
    if (params.description !== undefined || params.content !== undefined) {
      const current = this.loadSkill(params.name)
      if (!current) return

      const desc = params.description ?? current.description
      const content = params.content ?? current.content
      const md = `---\nname: ${params.name}\ndescription: "${desc}"\n---\n\n${content}`
      writeFileSync(join(dir, 'SKILL.md'), md, 'utf-8')
    }
  }

  /** 删除 Skill（移除整个目录） */
  deleteByName(name: string): void {
    const dir = join(this.skillsDir, name)
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true })
    }

    // 从配置中清理
    const config = this.readConfig()
    config.disabled = config.disabled.filter((n) => n !== name)
    this.writeConfig(config)
  }

  /** 获取 skills 根目录路径 */
  getSkillsDir(): string {
    return this.skillsDir
  }
}

export const skillService = new SkillService()
