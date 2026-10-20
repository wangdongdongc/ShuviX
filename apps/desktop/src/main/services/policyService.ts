/**
 * PolicyService — 用户安全策略文件管理（对标 agentService 的纯 md 驱动模式）。
 *
 * 内置策略：随包发布到 `Resources/builtin-policies/`（开发期指仓库源码目录，见
 *   getBuiltinPoliciesDir），运行时按当前语言**现读**（readBuiltinPolicyMd）—— 与内置
 *   agent 档案同一套机制；侧栏点开一份内置策略的只读笔记本，读的就是运行时读的那一份。
 * 用户策略：~/.shuvix/policies/<name>.md（文件存在即生效，无启用开关/旁路配置；
 *   文件名去掉 .md 即默认 name，frontmatter `name:` 可覆盖）。
 * 命名冲突：同名的几份谁生效由 agent-runtime 的 resolvePolicyFiles 裁决（用户压过内置，同为用户
 *   文件按文件名定先后）。**评估侧装配（assembleRules → mergePolicyFiles）与设置页列表调的是同一个
 *   函数、喂的是同一份候选**（当前界面语言的内置 + getUserPolicies 交出的全部用户文件）—— 列表上
 *   标着生效的，就是真正在评估的那份。
 *
 * 安全语义与 agentService 的关键差异：**非法用户文件不遮蔽内置同名策略** ——
 * parsePolicyDefinitionFile 返回 null 的文件不进候选（记警告），写坏一份 md
 * 不应意外关掉 workspace-boundary 这类内置保护。
 *
 * **统一缓存**（2026-10-19，docs/network-policy/design.md §2）：用户策略目录的扫描结果（可解析的 + 不可解析的）
 * 缓存在这里，agent 会话的每次判定、远程访问的每个网络请求、侧栏列表都读这一份。缓存按**目录签名**认新旧
 * （每个 .md 的 名字 + size + mtime + ctime + inode；带 ctime 是因为 Finder 拷贝会保留原文件的修改时间），
 * 三处刷新：
 *   - 应用内写入（新建、删除、笔记本保存 —— registryNotes）**同步**标脏，下一次读必然重扫；
 *   - 判定路径（getUserPolicies）距上次核对超过 POLICY_CHECK_INTERVAL_MS 就核一次签名 —— 覆盖 agent 的
 *     write / edit、bash、Finder、git 这些不经过本服务的写入，闲着时零开销；列表路径（listForSettings /
 *     listInvalid / getSource / 删除 / 新建）是用户手动触发的低频操作，每次都核；
 *   - 远程访问开着时网络服务定时调 refresh()：连着但不发请求的客户端照样在收推送，新加的 deny 要能把它断开。
 * 签名核对发现的变化（即外部写入）重扫后发一次 `policy.changed`；标脏引起的重扫不发（应用内写入各自发过了）。
 * 会话授权与 vars 不在这里，照旧每次现取（「允许并记住」落库即生效）。
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { join } from 'path'
import { shell } from 'electron'
import {
  buildBuiltinPolicies,
  builtinMdFileNames,
  parsePolicyDefinitionFile,
  registryFileBase,
  resolvePolicyFiles,
  type ParsedPolicyFile,
  type UserPolicyFile
} from '@shuvix/agent-runtime'
import i18next from 'i18next'
import { getBuiltinPoliciesDir, getDefaultPoliciesDir } from '../utils/paths'
import { appEventBus } from '../utils/appEventBus'
import { ensureObjectId } from '../utils/mdObjectId'
import { isKnownDisableableBuiltin } from '../utils/builtinDisable'
import { createLogger } from '../logger'

const log = createLogger('PolicyService')

/** 判定路径上两次目录签名核对之间至少隔多久（毫秒）—— agent 改写策略后至多这么久生效 */
export const POLICY_CHECK_INTERVAL_MS = 1000

/** 一次扫描的结果 */
interface PolicyScan {
  valid: Array<{ policy: ParsedPolicyFile; fileName: string }>
  invalid: InvalidPolicyFile[]
}

/** 缓存：哪个目录、什么签名、扫出了什么（userPolicies 是交给装配的那份，带文件名） */
interface PolicyScanCache {
  dir: string
  signature: string
  scan: PolicyScan
  userPolicies: UserPolicyFile[]
}

/**
 * 目录签名：每个参与扫描的文件（非点开头的 .md）一段 `名字 size mtime ctime inode`。目录不在 → 空串；
 * 某个文件 stat 失败（刚被删）→ 那一段记成 `名字 ?`，下次核对自然对不上
 */
function directorySignature(dir: string): string {
  if (!existsSync(dir)) return ''
  let names: string[]
  try {
    names = readdirSync(dir)
      .filter((name) => !name.startsWith('.') && name.toLowerCase().endsWith('.md'))
      .sort()
  } catch {
    return '?'
  }
  return names
    .map((name) => {
      try {
        const st = statSync(join(dir, name))
        if (!st.isFile()) return `${name} -`
        return `${name} ${st.size} ${st.mtimeMs} ${st.ctimeMs} ${st.ino}`
      } catch {
        return `${name} ?`
      }
    })
    .join('\n')
}

export interface PolicyListItem extends ParsedPolicyFile {
  source: 'builtin' | 'user'
  /** 文件路径：用户策略在 ~/.shuvix/policies；内置策略是它当前语言那一版的随包文件 */
  basePath: string
  /**
   * 被同名遮蔽、当前不生效：被用户策略压过的内置，或同名用户文件里没胜出的那几份
   * （仅设置页展示，不进任何运行时路径）
   */
  overridden?: boolean
  /** 压过它的那份用户文件的文件名 */
  overriddenBy?: string
  /** 这一行有禁用开关（持有一个确有其物的内置安全策略 id：内置本身，或沿用了它的覆盖副本） */
  disableable?: boolean
  /** 被用户停用（内置安全策略的停用开关；沿用内置 id 的覆盖副本一并算）—— 不参与装配 */
  disabled?: boolean
}

/**
 * 无法解析的用户策略文件。刻意**不复用 PolicyListItem**：把它伪装成一份
 * 「零规则的合法策略」会与「同名空策略用于停用内置」这一真实语义混淆。
 * 身份是文件名（解析不出 name），删除走 deleteByFile。
 */
export interface InvalidPolicyFile {
  fileName: string
  /** 解析器给出的人读原因（多条以换行连接） */
  error: string
}

/** 设置页排序：按名字；同名里生效的在前、再按文件路径 —— 被遮蔽的几份紧跟在胜出的那份后面 */
function compareRows(a: PolicyListItem, b: PolicyListItem): number {
  return (
    a.name.localeCompare(b.name) ||
    Number(!!a.overridden) - Number(!!b.overridden) ||
    a.basePath.localeCompare(b.basePath)
  )
}

class PolicyService {
  /**
   * 停用开关的读口（ShuviX 扩展元数据，按对象 id 认）。由主进程入口注入（setDisabledReader，读 services/mdMeta
   * 的内存快照）—— 本服务不直接依赖数据库：单测里没有库，没注入 = 都不停用。
   */
  private disabledReader: ((objectId: string) => boolean) | null = null

  private cache: PolicyScanCache | null = null
  /** 应用内写入之后：下一次读必然重扫 */
  private dirty = true
  /** 上一次核对签名的时刻 */
  private lastCheckAt = 0
  private checkIntervalMs = POLICY_CHECK_INTERVAL_MS
  private now: () => number = Date.now

  /** 单测用：判定路径的核对间隔与时钟（缺省 POLICY_CHECK_INTERVAL_MS / Date.now） */
  configureCache(opts: { checkIntervalMs?: number; now?: () => number }): void {
    if (opts.checkIntervalMs !== undefined) this.checkIntervalMs = opts.checkIntervalMs
    if (opts.now) this.now = opts.now
  }

  /** 标脏：应用内写了策略目录（新建、删除、笔记本保存），下一次读必然重扫 */
  invalidate(): void {
    this.dirty = true
  }

  /**
   * 核一次目录签名（不节流）：变了就重扫并发 `policy.changed`。回：这一次是否发现了变化。
   * 远程访问开着时网络服务定时调它
   */
  refresh(): boolean {
    const before = this.cache
    const after = this.scanned('fresh')
    return before !== null && after !== before
  }

  /**
   * 拿扫描结果：标脏 / 没有缓存 / 目录换了 → 重扫；否则按 mode 核签名（`fresh` 每次核，`throttled` 距上次
   * 超过间隔才核），签名变了 → 重扫并发 `policy.changed`
   */
  private scanned(mode: 'fresh' | 'throttled'): PolicyScanCache {
    const dir = getDefaultPoliciesDir()
    const now = this.now()
    const cached = this.cache
    if (cached === null || this.dirty || cached.dir !== dir) {
      this.dirty = false
      this.lastCheckAt = now
      return this.rescan(dir, directorySignature(dir))
    }
    if (mode === 'throttled' && now - this.lastCheckAt < this.checkIntervalMs) return cached
    this.lastCheckAt = now
    const signature = directorySignature(dir)
    if (signature === cached.signature) return cached
    const next = this.rescan(dir, signature)
    appEventBus.publish({ type: 'policy.changed' })
    return next
  }

  private rescan(dir: string, signature: string): PolicyScanCache {
    const scan = this.scanDir()
    this.cache = {
      dir,
      signature,
      scan,
      userPolicies: scan.valid.map(({ policy, fileName }) => ({ ...policy, fileName }))
    }
    return this.cache
  }

  /** 注入停用开关的读口（主进程启动时调一次；null = 撤掉） */
  setDisabledReader(reader: ((objectId: string) => boolean) | null): void {
    this.disabledReader = reader
  }

  /** 这份策略被停用了吗（装配时 SecurityHostProvider.isPolicyDisabled 与列表的停用徽标共用） */
  isDisabled(policy: ParsedPolicyFile): boolean {
    return !!policy.objectId && !!this.disabledReader?.(policy.objectId)
  }

  /**
   * 评估侧的用户策略来源（SecurityHostProvider.getUserPolicies）：**全部**可解析的用户文件，带文件名、
   * 含同名的几份 —— 谁生效由装配时的 resolvePolicyFiles 裁决，与设置页列表同一个函数。
   * 读统一缓存（判定路径：至多每 POLICY_CHECK_INTERVAL_MS 核一次目录签名，见文件头）；交回的数组与里面的
   * 对象是缓存本身，调用方不得改动。非法文件不在其中（不遮蔽内置）。
   */
  getUserPolicies(): UserPolicyFile[] {
    return this.scanned('throttled').userPolicies
  }

  /**
   * 扫描用户策略目录，分出可解析与不可解析两拨。同名的几份都收下（谁生效交给同名裁决）；
   * 文件名排序，让每次扫描的顺序一致。
   *
   * 非法文件**不进运行时**（跳过、不遮蔽内置，安全语义见文件头），但必须被设置页看见：
   * 用外部编辑器写坏一份策略后，它既不生效也不出现在任何界面里 —— 用户无从发现、
   * 更无从修复。invalid 一路带着解析器给出的人读原因回到 UI。
   */
  private scanDir(): PolicyScan {
    const dir = getDefaultPoliciesDir()
    if (!existsSync(dir)) return { valid: [], invalid: [] }

    let names: string[]
    try {
      names = readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => e.name)
        .sort()
    } catch (e) {
      log.warn(`扫描策略目录 ${dir} 失败:`, e)
      return { valid: [], invalid: [] }
    }

    const valid: Array<{ policy: ParsedPolicyFile; fileName: string }> = []
    const invalid: InvalidPolicyFile[] = []
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
      valid.push({ policy, fileName })
    }
    return { valid, invalid }
  }

  /**
   * 同名裁决的全部份数：当前界面语言的内置 + 全部用户文件，过 resolvePolicyFiles ——
   * 与 assembleRules 装配时是同一个函数、同一份候选（provider 的 getLanguage 即 i18next.language）。
   * 内置条目的 basePath 是它**当前语言那一版**的文件（与装配时那次语言回退同一条候选序）——
   * 侧栏点内置行开的只读笔记本按它认。
   */
  private resolve(): Array<ReturnType<typeof resolvePolicyFiles>[number] & { basePath: string }> {
    const dir = getDefaultPoliciesDir()
    return resolvePolicyFiles(
      buildBuiltinPolicies({ language: i18next.language, readMd: this.readBuiltinPolicyMd }),
      this.scanned('fresh').userPolicies
    ).map((entry) => {
      const builtinFile =
        entry.sourceKind === 'builtin' ? this.builtinSourceFile(entry.policy.name) : null
      return {
        ...entry,
        basePath:
          entry.sourceKind === 'user' && entry.fileName
            ? join(dir, entry.fileName)
            : builtinFile
              ? join(getBuiltinPoliciesDir(), builtinFile)
              : ''
      }
    })
  }

  /**
   * 内置策略 md 的读取口 —— 随包发布的目录现读（桌面 SecurityHostProvider 的
   * `readBuiltinPolicyMd` 也是它）。读不到回 null，构建器按语言回退。
   */
  readBuiltinPolicyMd(fileName: string): string | null {
    try {
      return readFileSync(join(getBuiltinPoliciesDir(), fileName), 'utf-8')
    } catch {
      return null // 该语言没有这一版（或目录不在）—— 构建器按 en 回退
    }
  }

  /**
   * 某份内置策略当前语言那一版的文件名（`ask-on-command.zh.md`）—— 侧栏点内置行开只读笔记本
   * 要按它认。与装配时那次语言回退同一条候选序（精确语言 → 基础语言 → en），UI 不另挑。
   */
  builtinSourceFile(name: string): string | null {
    const dir = getBuiltinPoliciesDir()
    for (const fileName of builtinMdFileNames(name, i18next.language)) {
      if (existsSync(join(dir, fileName))) return fileName
    }
    return null
  }

  /** 生效的用户策略里叫这个名字的那份（按名寻址的读 / 删用；被遮蔽的几份只能按文件名删） */
  private activeUserFile(name: string): { basePath: string } | undefined {
    return this.resolve().find(
      (entry) => entry.sourceKind === 'user' && !entry.shadowedBy && entry.policy.name === name
    )
  }

  /** 目录里无法解析的策略文件（设置页据此显示可点开修复的告警项） */
  listInvalid(): InvalidPolicyFile[] {
    return this.scanned('fresh').scan.invalid
  }

  /**
   * 设置页列表：同一次同名裁决的全部份数 —— 被遮蔽的（被用户策略压过的内置，或同名用户文件里
   * 没胜出的那几份）带 `overridden` 与 `overriddenBy`，只作展示、不进运行时。
   */
  listForSettings(): PolicyListItem[] {
    return this.resolve()
      .map(({ policy, sourceKind, basePath, shadowedBy }): PolicyListItem => {
        // 用户策略对象上挂着 getUserPolicies 附带的 fileName（给同名裁决用）—— 列表项的文件身份是
        // basePath，这个契约外的字段不带过 IPC
        const { fileName: _fileName, ...fields } = policy as UserPolicyFile
        return {
          ...fields,
          source: sourceKind,
          basePath,
          ...(policy.objectId && isKnownDisableableBuiltin(policy.objectId, 'policy')
            ? { disableable: true }
            : {}),
          ...(this.isDisabled(policy) ? { disabled: true } : {}),
          ...(shadowedBy
            ? {
                overridden: true,
                ...(shadowedBy.fileName ? { overriddenBy: shadowedBy.fileName } : {})
              }
            : {})
        }
      })
      .sort(compareRows)
  }

  /**
   * 取策略的 md 原文。两侧都是**盘上文件逐字原文**（注释、键序原样）：用户策略读生效那份
   * 用户文件；内置策略读随包发布目录里当前语言那一版（与 builtinSourceFile / 装配的语言回退
   * 同一条候选序：精确语言 → 基础语言 → en）。这就是「创建覆盖副本」的初值 —— 副本与
   * 运行时读的那一份逐字节相同（对齐 agent 的 create override copy）。
   */
  getSource(name: string, source: 'builtin' | 'user'): { text: string } | { error: string } {
    if (source === 'user') {
      const target = this.activeUserFile(name)
      if (!target) return { error: `Policy "${name}" not found` }
      try {
        return { text: readFileSync(target.basePath, 'utf-8') }
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) }
      }
    }
    // 候选序最终落在 <name>.md（en）上；它读不到意味着规则的唯一事实源缺席 —— 名字不存在
    // 与文件缺失都走同一个错误出口，装配侧（buildBuiltinPolicies）对后者另有 throw
    const fileName = this.builtinSourceFile(name)
    if (!fileName) return { error: `Builtin policy "${name}" not found` }
    try {
      return { text: readFileSync(join(getBuiltinPoliciesDir(), fileName), 'utf-8') }
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  }

  /**
   * 解析并校验一份待写入的策略原文（新建用）。**非法一律拒绝写盘**：新建出一份存在但非法的
   * 策略没有意义 —— 与其让它躺在磁盘上假装生效，不如把解析器的拒绝原因原样交回 UI。
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
   * 新建用户策略文件（设置页「新建」与「创建覆盖副本」共用）。文件名由 frontmatter
   * `name` 净化派生（冲突追加数字后缀）；与既有用户策略重名拒绝，覆盖内置放行。
   * 新文件一出生就带 `shuvix-id`：覆盖副本逐字复制内置原文，内置 id 跟着来；「新建」的模板补一个新的。
   */
  createPolicy(text: string): { success: boolean; name?: string; error?: string } {
    const parsed = this.parseForWrite(text, 'policy')
    if ('error' in parsed) return { success: false, error: parsed.error }
    const name = parsed.policy.name
    const content = ensureObjectId(text, (t) => parsePolicyDefinitionFile(t, 'policy'))

    if (this.scanned('fresh').scan.valid.some((u) => u.policy.name === name)) {
      return { success: false, error: `Policy "${name}" already exists` }
    }

    // 文件名净化（与同名裁决认「文件名就是这个名字」同一套规则）；frontmatter name 才是标识
    const safeBase = registryFileBase(name) || 'policy'
    const dir = getDefaultPoliciesDir()
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    let filePath = join(dir, `${safeBase}.md`)
    for (let i = 1; existsSync(filePath); i++) {
      filePath = join(dir, `${safeBase}-${i}.md`)
    }

    try {
      writeFileSync(filePath, content, 'utf-8')
    } catch (e) {
      log.warn(`新建策略 "${name}" 失败:`, e)
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
    this.invalidate()
    appEventBus.publish({ type: 'policy.changed' })
    return { success: true, name }
  }

  /**
   * 文件名白名单：仅接受策略目录下的单个 .md 文件名，杜绝路径穿越
   * （fileName 来自渲染进程，按不可信入参处理）。
   */
  private resolveUserFile(fileName: string): string | null {
    if (!/^[^/\\]+\.md$/i.test(fileName) || fileName.startsWith('.')) return null
    const filePath = join(getDefaultPoliciesDir(), fileName)
    return existsSync(filePath) ? filePath : null
  }

  /** 按文件名删除 —— 非法文件、或同名里被遮蔽的那几份（按名删会删到生效的那份） */
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
    this.invalidate()
    appEventBus.publish({ type: 'policy.changed' })
    return { success: true }
  }

  /** 删除生效的那份用户策略文件；删除覆盖副本后同名内置自动恢复生效（合并语义） */
  deletePolicy(name: string): { success: boolean; error?: string } {
    const target = this.activeUserFile(name)
    if (!target) return { success: false, error: `Policy "${name}" not found` }
    try {
      unlinkSync(target.basePath)
    } catch (e) {
      log.warn(`删除策略 "${name}" 失败:`, e)
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
    log.info(`已删除策略 "${name}" (${target.basePath})`)
    this.invalidate()
    appEventBus.publish({ type: 'policy.changed' })
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
