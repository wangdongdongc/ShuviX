/**
 * AgentService — 基于文件系统的 Sub-Agent 管理
 *
 * 单文件约定（对齐 Claude Code / awesome-claude-agents 社区惯例）：
 * 内置 agents：<resources>/agents/<name>.md（随应用版本发布，只读）
 * 用户 agents：~/.shuvix/agents/<name>.md（用户可编辑）
 *
 * 文件名（去掉 .md）即默认 agent name；frontmatter 内 `name:` 字段可覆盖。
 *
 * 启用/禁用状态写入 ~/.shuvix/agents/.config.json：
 *   { disabled: string[] }   // 仅作用于用户 agent；内置始终启用
 *
 * 命名冲突：用户优先级 > 内置（同名时用户覆盖内置）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { shell } from 'electron'
import { getBuiltinAgentsDir, getDefaultAgentsDir } from '../utils/paths'
import type { AgentDefinition } from '../agents/types'
import { createLogger } from '../logger'

const log = createLogger('AgentService')

interface AgentConfig {
  /** 用户禁用的 agent 名称集合 */
  disabled: string[]
}

/** 解析 AGENT.md frontmatter（YAML 简化版，支持 string / number / 数组） */
function parseAgentMarkdown(text: string): {
  fields: Record<string, string | string[] | number>
  body: string
} | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('---')) return null

  const endIndex = trimmed.indexOf('\n---', 3)
  if (endIndex === -1) return null

  const frontmatter = trimmed.slice(3, endIndex).trim()
  const body = trimmed.slice(endIndex + 4).trim()

  const fields: Record<string, string | string[] | number> = {}
  for (const rawLine of frontmatter.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx).trim()
    const val = line.slice(colonIdx + 1).trim()
    if (!key) continue

    // 数组：[a, b, c]
    if (val.startsWith('[') && val.endsWith(']')) {
      const inner = val.slice(1, -1).trim()
      if (!inner) {
        fields[key] = []
        continue
      }
      fields[key] = inner.split(',').map((s) => s.trim().replace(/^["']|["']$/g, ''))
      continue
    }

    // 数字
    if (/^-?\d+$/.test(val)) {
      fields[key] = Number(val)
      continue
    }

    // 字符串（剥引号）
    fields[key] = val.replace(/^["']|["']$/g, '')
  }

  return { fields, body }
}

class AgentService {
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

  private readConfig(): AgentConfig {
    const configPath = join(this.userDir, '.config.json')
    try {
      if (existsSync(configPath)) {
        const raw = JSON.parse(readFileSync(configPath, 'utf-8'))
        return {
          disabled: Array.isArray(raw.disabled)
            ? raw.disabled.filter((x: unknown) => typeof x === 'string')
            : []
        }
      }
    } catch (e) {
      log.warn('读取 agents .config.json 失败:', e)
    }
    return { disabled: [] }
  }

  private writeConfig(config: AgentConfig): void {
    this.ensureUserDir()
    const configPath = join(this.userDir, '.config.json')
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
  }

  /** 从一个 .md 文件加载 agent 定义 */
  private loadAgentFromFile(
    filePath: string,
    defaultName: string,
    source: 'builtin' | 'user',
    config: AgentConfig
  ): AgentDefinition | null {
    let raw: string
    try {
      raw = readFileSync(filePath, 'utf-8')
    } catch (e) {
      log.warn(`加载 agent "${defaultName}" 失败:`, e)
      return null
    }

    const parsed = parseAgentMarkdown(raw)
    if (!parsed) {
      log.warn(`agent "${defaultName}": 无法解析 frontmatter`)
      return null
    }

    const { fields, body } = parsed
    // frontmatter `name` 覆盖文件名；否则用文件 basename
    const name = typeof fields.name === 'string' && fields.name ? fields.name : defaultName
    const displayName =
      typeof fields.displayName === 'string' && fields.displayName ? fields.displayName : name
    // 兼容 Claude Code 风格的 `description` 字段（其含义即 whenToUse）
    const whenToUse =
      typeof fields.whenToUse === 'string'
        ? fields.whenToUse
        : typeof fields.description === 'string'
          ? fields.description
          : ''
    const tools = Array.isArray(fields.tools) ? fields.tools : []
    const maxTurns = typeof fields.maxTurns === 'number' ? fields.maxTurns : 40
    const requiredMcp = Array.isArray(fields.requiredMcp) ? fields.requiredMcp : undefined

    // 内置不受 disabled 列表影响；用户 agent 按列表决定启用
    const isEnabled = source === 'builtin' ? true : !config.disabled.includes(name)

    return {
      name,
      displayName,
      whenToUse,
      systemPrompt: body,
      tools,
      maxTurns,
      source,
      requiredMcp,
      basePath: filePath,
      isEnabled
    }
  }

  /** 扫描指定目录下的所有 *.md 文件作为 agents */
  private scanDir(dir: string, source: 'builtin' | 'user', config: AgentConfig): AgentDefinition[] {
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

    const result: AgentDefinition[] = []
    for (const entry of entries) {
      if (!entry.isFile) continue
      if (entry.name.startsWith('.')) continue
      if (!entry.name.toLowerCase().endsWith('.md')) continue
      // 兼容用户用 README.md 之类作为说明文档放在同目录的场景
      const basename = entry.name.slice(0, -3)
      if (!basename) continue
      const def = this.loadAgentFromFile(join(dir, entry.name), basename, source, config)
      if (def) result.push(def)
    }
    return result
  }

  /** 列出所有 agent（含禁用状态；用户优先级 > 内置覆盖同名） */
  listAll(): AgentDefinition[] {
    const config = this.readConfig()
    const builtins = this.scanDir(getBuiltinAgentsDir(), 'builtin', config)
    const users = this.scanDir(this.userDir, 'user', config)

    // 用户覆盖内置同名
    const userNames = new Set(users.map((a) => a.name))
    const merged = [...builtins.filter((a) => !userNames.has(a.name)), ...users]
    return merged.sort((a, b) => a.name.localeCompare(b.name))
  }

  /** 列出所有已启用 agent */
  listEnabled(): AgentDefinition[] {
    return this.listAll().filter((a) => a.isEnabled)
  }

  /** 按 name 查询单个已启用的 agent（执行时使用） */
  getEnabled(name: string): AgentDefinition | undefined {
    return this.listEnabled().find((a) => a.name === name)
  }

  /** 切换启用状态；仅对用户 agent 生效 */
  setEnabled(name: string, enabled: boolean): { success: boolean; error?: string } {
    const target = this.listAll().find((a) => a.name === name)
    if (!target) return { success: false, error: `Agent "${name}" not found` }
    if (target.source === 'builtin') {
      return { success: false, error: 'Built-in agents cannot be disabled' }
    }
    const config = this.readConfig()
    if (enabled) {
      config.disabled = config.disabled.filter((n) => n !== name)
    } else if (!config.disabled.includes(name)) {
      config.disabled.push(name)
    }
    this.writeConfig(config)
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

  /** 获取内置目录路径（仅供 UI 显示） */
  getBuiltinDir(): string {
    return getBuiltinAgentsDir()
  }
}

export const agentService = new AgentService()
