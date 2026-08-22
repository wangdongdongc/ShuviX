/**
 * PolicyService — 用户安全策略文件管理（对标 agentService 的纯 md 驱动模式）。
 *
 * 内置策略：硬编码进 @shuvix/agent-runtime（security/builtinPolicies，各端共享）。
 * 用户策略：~/.shuvix/policies/<name>.md（文件存在即生效，无启用开关/旁路配置；
 *   文件名去掉 .md 即默认 name，frontmatter `name:` 可覆盖）。
 * 命名冲突：用户同名覆盖内置（合并在 agent-runtime 的 assembleRules / mergePolicyFiles）。
 *
 * 安全语义与 agentService 的关键差异：**非法用户文件不遮蔽内置同名策略** ——
 * parsePolicyDefinitionFile 返回 null 的文件直接跳过（记警告），写坏一份 md
 * 不应意外关掉 workspace-boundary 这类内置保护。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { shell } from 'electron'
import {
  buildBuiltinPolicies,
  mergePolicyFiles,
  parsePolicyDefinitionFile,
  serializePolicyDefinitionFile,
  type ParsedPolicyFile
} from '@shuvix/agent-runtime'
import i18next from 'i18next'
import { getDefaultPoliciesDir } from '../utils/paths'
import { createLogger } from '../logger'

const log = createLogger('PolicyService')

export interface PolicyListItem extends ParsedPolicyFile {
  source: 'builtin' | 'user'
  /** 用户文件路径（内置为空串） */
  basePath: string
  /** 被同名用户策略遮蔽的内置（仅设置页展示用） */
  overridden?: boolean
}

/**
 * 无法解析的用户策略文件。刻意**不复用 PolicyListItem**：把它伪装成一份
 * 「零规则的合法策略」会与「同名空策略用于停用内置」这一真实语义混淆。
 * 身份是文件名（解析不出 name），故其读写走 *ByFile 一组接口。
 */
export interface InvalidPolicyFile {
  fileName: string
  /** 解析器给出的人读原因（多条以换行连接） */
  error: string
}

class PolicyService {
  /**
   * 现扫用户策略目录（每次调用重扫，无缓存 —— 决策新鲜度优先；目录小，readdir 微秒级）。
   * 非法文件跳过并警告，不进入合并（即不遮蔽内置）。
   */
  getUserPolicies(): ParsedPolicyFile[] {
    return this.scanUserFiles().map(({ policy }) => policy)
  }

  private scanUserFiles(): Array<{ policy: ParsedPolicyFile; basePath: string }> {
    return this.scanDir().valid
  }

  /**
   * 扫描用户策略目录，分出可解析与不可解析两拨。
   *
   * 非法文件**不进运行时**（跳过、不遮蔽内置，安全语义见文件头），但必须被设置页看见：
   * 用外部编辑器写坏一份策略后，它既不生效也不出现在任何界面里 —— 用户无从发现、
   * 更无从修复。invalid 一路带着解析器给出的人读原因回到 UI。
   */
  private scanDir(): {
    valid: Array<{ policy: ParsedPolicyFile; basePath: string }>
    invalid: InvalidPolicyFile[]
  } {
    const dir = getDefaultPoliciesDir()
    if (!existsSync(dir)) return { valid: [], invalid: [] }

    let names: string[]
    try {
      names = readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => e.name)
    } catch (e) {
      log.warn(`扫描策略目录 ${dir} 失败:`, e)
      return { valid: [], invalid: [] }
    }

    const valid: Array<{ policy: ParsedPolicyFile; basePath: string }> = []
    const invalid: InvalidPolicyFile[] = []
    const seen = new Set<string>()
    for (const fileName of names) {
      if (fileName.startsWith('.')) continue
      if (!fileName.toLowerCase().endsWith('.md')) continue
      const defaultName = fileName.slice(0, -3)
      if (!defaultName) continue
      const filePath = join(dir, fileName)
      let raw: string
      try {
        raw = readFileSync(filePath, 'utf-8')
      } catch (e) {
        log.warn(`读取策略 "${defaultName}" 失败:`, e)
        invalid.push({ fileName, error: e instanceof Error ? e.message : String(e) })
        continue
      }
      // warn 出口：拒绝原因（非法时）与软告警（合法但易误拦）都从这里出
      const reasons: string[] = []
      const policy = parsePolicyDefinitionFile(raw, defaultName, (msg) => {
        reasons.push(msg)
        log.warn(msg)
      })
      if (!policy) {
        log.warn(`策略 "${defaultName}": frontmatter 非法，已跳过（不遮蔽内置同名策略）`)
        invalid.push({ fileName, error: reasons.join('\n') || 'Invalid policy file' })
        continue
      }
      // 同名用户文件互相遮蔽语义不明：保留先扫到的一份，其余警告跳过
      if (seen.has(policy.name)) {
        log.warn(`策略 "${policy.name}": 同名用户文件重复（${fileName}），已跳过`)
        continue
      }
      seen.add(policy.name)
      valid.push({ policy, basePath: filePath })
    }
    return { valid, invalid }
  }

  /** 目录里无法解析的策略文件（设置页据此显示可点开修复的告警项） */
  listInvalid(): InvalidPolicyFile[] {
    return this.scanDir().invalid
  }

  /**
   * 设置页列表（未来策略检视 Tab 的数据源；本期无 UI，仅备好 API）：
   * 合并结果 + 被遮蔽的内置（overridden 标记，仅展示不进运行时）。
   */
  listForSettings(): PolicyListItem[] {
    const users = this.scanUserFiles()
    // 每次现算以反映当前界面语言（description/body 人读面；规则恒取 en）
    const builtins = buildBuiltinPolicies(i18next.language)
    const merged = mergePolicyFiles(
      builtins,
      users.map((u) => u.policy)
    ).map(({ policy, sourceKind }) => ({
      ...policy,
      source: sourceKind,
      basePath: users.find((u) => u.policy.name === policy.name)?.basePath ?? ''
    }))
    const userNames = new Set(users.map((u) => u.policy.name))
    const shadowed = builtins
      .filter((p) => userNames.has(p.name))
      .map((p) => ({ ...p, source: 'builtin' as const, basePath: '', overridden: true }))
    return [...merged, ...shadowed].sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * 取策略的 md 原文（设置页编辑器的数据源）。用户策略读文件原文（注释、键序原样）；
   * 内置策略无文件，用 serializePolicyDefinitionFile 回写出等价 md —— 这就是
   * 「创建覆盖副本」的初值（对齐 agent 设置页的 create override copy）。
   */
  getSource(name: string, source: 'builtin' | 'user'): { text: string } | { error: string } {
    if (source === 'user') {
      const target = this.scanUserFiles().find((u) => u.policy.name === name)
      if (!target) return { error: `Policy "${name}" not found` }
      try {
        return { text: readFileSync(target.basePath, 'utf-8') }
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) }
      }
    }
    const builtin = buildBuiltinPolicies(i18next.language).find((p) => p.name === name)
    if (!builtin) return { error: `Builtin policy "${name}" not found` }
    return { text: serializePolicyDefinitionFile(builtin) }
  }

  /**
   * 解析并校验一份待写入的策略原文。**非法一律拒绝写盘**：一份存在但非法的策略
   * 会被扫描静默跳过（不生效也不遮蔽内置），正是本次要消灭的失败模式 —— 与其
   * 让它躺在磁盘上假装生效，不如把解析器的拒绝原因原样交回 UI。
   */
  private parseForWrite(
    text: string,
    defaultName: string
  ): { policy: ParsedPolicyFile } | { error: string } {
    const messages: string[] = []
    const policy = parsePolicyDefinitionFile(text, defaultName, (msg) => messages.push(msg))
    if (!policy) return { error: messages.join('\n') || 'Invalid policy file' }
    return { policy }
  }

  /**
   * 覆写用户策略文件（设置页编辑器的保存路径）。`originalName` 定位现有文件
   * （文件路径不随改名变，frontmatter `name` 为准）；内置策略无文件，须先创建覆盖副本。
   */
  savePolicy(originalName: string, text: string): { success: boolean; error?: string } {
    const users = this.scanUserFiles()
    const target = users.find((u) => u.policy.name === originalName)
    if (!target) return { success: false, error: `Policy "${originalName}" not found` }

    const parsed = this.parseForWrite(text, originalName)
    if ('error' in parsed) return { success: false, error: parsed.error }
    const name = parsed.policy.name
    // 与其他用户策略重名 → 拒绝（同名用户文件互相遮蔽，语义不明）；覆盖内置为有意设计，放行
    if (name !== originalName && users.some((u) => u.policy.name === name)) {
      return { success: false, error: `Policy "${name}" already exists` }
    }

    try {
      writeFileSync(target.basePath, text, 'utf-8')
    } catch (e) {
      log.warn(`保存策略 "${originalName}" 失败:`, e)
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
    return { success: true }
  }

  /**
   * 新建用户策略文件（设置页「新建」与「创建覆盖副本」共用）。文件名由 frontmatter
   * `name` 净化派生（冲突追加数字后缀）；与既有用户策略重名拒绝，覆盖内置放行。
   */
  createPolicy(text: string): { success: boolean; name?: string; error?: string } {
    const parsed = this.parseForWrite(text, 'policy')
    if ('error' in parsed) return { success: false, error: parsed.error }
    const name = parsed.policy.name

    if (this.scanUserFiles().some((u) => u.policy.name === name)) {
      return { success: false, error: `Policy "${name}" already exists` }
    }

    // 文件名净化：路径分隔/非法字符替换为 '-'，前导点去除；frontmatter name 才是标识
    const safeBase = name.replace(/[\\/:*?"<>|]/g, '-').replace(/^\.+/, '') || 'policy'
    const dir = getDefaultPoliciesDir()
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    let filePath = join(dir, `${safeBase}.md`)
    for (let i = 1; existsSync(filePath); i++) {
      filePath = join(dir, `${safeBase}-${i}.md`)
    }

    try {
      writeFileSync(filePath, text, 'utf-8')
    } catch (e) {
      log.warn(`新建策略 "${name}" 失败:`, e)
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
    return { success: true, name }
  }

  /**
   * 文件名白名单：仅接受策略目录下的单个 .md 文件名，杜绝路径穿越
   * （fileName 来自渲染进程，虽只由 listInvalid 的返回值填充，仍按不可信入参处理）。
   */
  private resolveUserFile(fileName: string): string | null {
    if (!/^[^/\\]+\.md$/i.test(fileName) || fileName.startsWith('.')) return null
    const filePath = join(getDefaultPoliciesDir(), fileName)
    return existsSync(filePath) ? filePath : null
  }

  /** 按文件名取原文 —— 修复非法文件的读路径（它解析不出 name，走不了 getSource） */
  getSourceByFile(fileName: string): { text: string } | { error: string } {
    const filePath = this.resolveUserFile(fileName)
    if (!filePath) return { error: `Policy file "${fileName}" not found` }
    try {
      return { text: readFileSync(filePath, 'utf-8') }
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  }

  /**
   * 按文件名覆写 —— 修复非法文件的写路径。同样校验后才写（修坏了不许落盘），
   * 但**不做重名检查**：文件已在磁盘上，改好后它的 name 若与其他策略冲突，
   * 走的是既有的「同名用户文件重复保留先扫到者」语义，与外部编辑器写入等价。
   */
  saveByFile(fileName: string, text: string): { success: boolean; error?: string } {
    const filePath = this.resolveUserFile(fileName)
    if (!filePath) return { success: false, error: `Policy file "${fileName}" not found` }
    const parsed = this.parseForWrite(text, fileName.slice(0, -3))
    if ('error' in parsed) return { success: false, error: parsed.error }
    try {
      writeFileSync(filePath, text, 'utf-8')
    } catch (e) {
      log.warn(`保存策略文件 "${fileName}" 失败:`, e)
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
    return { success: true }
  }

  /** 按文件名删除 —— 非法文件修不好时的出路（它没有 name，走不了 deletePolicy） */
  deleteByFile(fileName: string): { success: boolean; error?: string } {
    const filePath = this.resolveUserFile(fileName)
    if (!filePath) return { success: false, error: `Policy file "${fileName}" not found` }
    try {
      unlinkSync(filePath)
    } catch (e) {
      log.warn(`删除策略文件 "${fileName}" 失败:`, e)
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
    log.info(`已删除策略文件 "${fileName}"`)
    return { success: true }
  }

  /** 删除用户策略文件；删除覆盖副本后同名内置自动恢复生效（合并语义） */
  deletePolicy(name: string): { success: boolean; error?: string } {
    const target = this.scanUserFiles().find((u) => u.policy.name === name)
    if (!target) return { success: false, error: `Policy "${name}" not found` }
    try {
      unlinkSync(target.basePath)
    } catch (e) {
      log.warn(`删除策略 "${name}" 失败:`, e)
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
    log.info(`已删除策略 "${name}" (${target.basePath})`)
    return { success: true }
  }

  getUserDir(): string {
    return getDefaultPoliciesDir()
  }

  /** 打开用户策略目录（OS 文件管理器；懒创建）—— 设置页「打开目录」按钮 */
  async openUserFolder(): Promise<void> {
    const dir = getDefaultPoliciesDir()
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    await shell.openPath(dir)
  }
}

export const policyService = new PolicyService()
