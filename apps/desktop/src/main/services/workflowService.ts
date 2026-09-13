/**
 * WorkflowService —— 工作流注册表 + 引擎装配 + 埋点门面（桌面宿主层）。
 *
 * 设计见 docs/workflow-md-design.md。分工：
 *  - 注册表：内置（@shuvix/agent-runtime buildBuiltinWorkflows，随语言现算）+ 用户
 *    `~/.shuvix/workflows/<name>.md`（目录扫描，同名覆盖内置 —— 与 agentService 同口径），
 *    用户文件额外过脚本引擎的 compile 语法检查（结构校验在共享解析器内）；
 *  - **纯 md 驱动**：文件存在且校验通过即生效，无启用开关、无旁路配置（同 agentService）；
 *  - run 记录：`~/.shuvix/workflows/.runs/<name>/<runId>.jsonl` 追加式 journal；
 *  - `workflowTriggers.fire(id, payload)`：业务埋点的唯一入口 —— **业务侧只声明
 *    「我在哪、上下文里有什么」**（payload 类型由 TriggerPayloadMap 收窄），订阅与
 *    否与它无关；引擎未初始化（启动早期）时静默丢弃。
 *
 * 引擎在 init() 里装配（main/index.ts 调用）而非模块顶层 —— 依赖 agentManager /
 * agentService / sessionService 的运行时状态，顶层装配会踩 ESM 初始化环。
 */
import {
  existsSync,
  readdirSync,
  readFileSync,
  mkdirSync,
  appendFileSync,
  statSync,
  writeFileSync,
  unlinkSync
} from 'fs'
import { basename, join } from 'path'
import { shell } from 'electron'
import i18next from 'i18next'
import {
  buildBuiltinWorkflows,
  createWorkflowEngine,
  getBuiltinWorkflowSource,
  parseWorkflowDefinitionFile,
  registryFileBase,
  resolveShadowing,
  toInProcessAgentType,
  type ParsedWorkflowFile,
  type ShadowResolved,
  type TriggerId,
  type TriggerPayloadMap,
  type WorkflowEngine,
  type WorkflowInvokeRequest,
  type WorkflowInvokeResult,
  type WorkflowRegistryEntry
} from '@shuvix/agent-runtime'
import { getDefaultWorkflowsDir } from '../utils/paths'
import { agentManager } from '../agents/AgentManager'
import { agentService } from './agentService'
import { sessionService } from './sessionService'
import { nodeVmScriptEngine } from './workflowScriptEngine'
import { createLogger } from '../logger'

const log = createLogger('Workflow')

/** 每个工作流保留的 run journal 文件数（见 pruneRunJournal） */
const RUN_JOURNAL_KEEP = 200

/**
 * 设置页列表项 —— 刻意**不外传** script / schemas / inputSchema / vars / limits：
 * 列表只需要「是什么、什么时候跑、开没开」，编辑走 getSource 拿整份 md 原文
 * （与 agent/policy 设置页同形：详情即原文编辑器）。
 */
export interface WorkflowListItem {
  name: string
  displayName: string
  description: string
  /** 绑定的埋点 id 列表（列表行的副标题；空 = 只能手动运行，当前无手动入口） */
  triggers: string[]
  concurrency: string
  source: 'builtin' | 'user'
  /** 用户文件路径（内置为空串） */
  basePath: string
  /**
   * 被同名遮蔽、当前不生效：被用户文件压过的内置，或同名用户文件里没胜出的那几份（仅展示）
   */
  overridden?: boolean
  /** 压过它的那份用户文件的文件名 */
  overriddenBy?: string
}

/**
 * 无法解析的用户工作流文件（结构非法或脚本语法错）。身份是文件名 —— 它解析不出 name，
 * 读写走 *ByFile 一组接口（同 policyService.InvalidPolicyFile）。
 */
export interface InvalidWorkflowFile {
  fileName: string
  /** 人读原因：解析器拒绝原因，或脚本引擎的语法错 */
  error: string
}

interface ScanResult {
  valid: Array<{ file: ParsedWorkflowFile; basePath: string }>
  invalid: InvalidWorkflowFile[]
}

class WorkflowService {
  private readonly userDir = getDefaultWorkflowsDir()
  private engine: WorkflowEngine | null = null

  /**
   * 目录扫描缓存 —— 键是「每份文件的 mtime+size」的指纹。
   *
   * 引擎每次 fire/invoke 都现算注册表（这是「文件改动即时生效」的实现方式），而现算
   * 意味着 readdir + 逐份 readFile + YAML parse + vm compile，而触发点落在每个会话的每一轮上。
   *
   * 缓存按指纹失效，所以承诺不变：外部编辑器改文件 mtime 就变，下一次调用照常重扫。
   */
  private scanCache: { fingerprint: string; result: ScanResult } | null = null

  /**
   * 本进程自己的写路径显式失效。指纹已经能兜住外部编辑器，但**同一秒内、同样大小**的
   * 覆写在秒级精度的文件系统上骗得过它 —— 而「点保存后立刻生效」正是本进程最常见的动作。
   */
  private invalidateScan(): void {
    this.scanCache = null
  }

  /** main 启动时装配引擎（此前的 fire 静默丢弃 —— 启动早期没有值得触发的业务事件） */
  init(): void {
    if (this.engine) return
    this.engine = createWorkflowEngine({
      manager: agentManager,
      script: nodeVmScriptEngine,
      listWorkflows: () => this.listForEngine(),
      resolveAgentProfile: (ref) => {
        const profile = agentService.getProfile(ref)
        return profile ? toInProcessAgentType(profile) : null
      },
      // 基准模型 = 归属会话的当前模型；被派发 agent 的 shuvix-model 声明优先于它
      // （统一创建管线的 spawned 路径本就如此）—— 工作流自己不参与选模型
      resolveRunModel: async ({ sessionId }) =>
        sessionId ? await sessionService.resolveRunModelConfig(sessionId) : null,
      onRecord: (name, runId, record) => this.appendRunRecord(name, runId, record),
      env: { host: 'desktop', platform: process.platform },
      logger: { info: (m) => log.info(m), warn: (m) => log.warn(m), error: (m) => log.error(m) }
    })
    log.info('workflow engine ready')
  }

  /** 业务埋点入口（绝不抛出）。引擎未就绪时静默丢弃。 */
  fire<K extends TriggerId>(id: K, payload: TriggerPayloadMap[K]): void {
    this.engine?.fire(id, payload)
  }

  /**
   * 定向调用（绝不抛出）。
   *
   * 引擎未就绪只可能出现在启动竞态里（`init()` 在任何 prompt 之前装配），属于内部故障 ——
   * 回 `'error'` + 人读串，**不给 reason 枚举加「未就绪」这一项**：那会让调用方为一个
   * 不可达的分支写降级。
   */
  async invoke(req: WorkflowInvokeRequest): Promise<WorkflowInvokeResult> {
    if (!this.engine) return { started: false, reason: 'error', error: 'workflow engine not ready' }
    return await this.engine.invoke(req)
  }

  /** 中止某会话名下的全部 run；引擎未就绪返回 0 */
  abortSessionRuns(sessionId: string): number {
    return this.engine?.abortSession(sessionId) ?? 0
  }

  /** 注册表里有没有这个名字 —— 派发**之前**就能判「这份管线存在」，不必靠事后的 not-found */
  hasWorkflow(name: string): boolean {
    return this.listForEngine().some((e) => e.file.name === name)
  }

  // ─── 注册表 ──────────────────────────────────

  /**
   * 用户目录扫描，分出可解析与不可解析两拨（同 policyService.scanDir 口径）。
   *
   * 非法文件**不进运行时**（不触发、不遮蔽内置），但必须被设置页看见：用外部编辑器
   * 写坏一份工作流后，它既不生效也不出现在任何界面里 —— 用户无从发现更无从修复。
   * invalid 一路带着人读原因（解析器的拒绝原因，或脚本引擎的语法错）回到 UI。
   */
  private scanDir(): ScanResult {
    if (!existsSync(this.userDir)) return { valid: [], invalid: [] }
    let names: string[]
    try {
      names = readdirSync(this.userDir, { withFileTypes: true })
        .filter(
          (e) => e.isFile() && !e.name.startsWith('.') && e.name.toLowerCase().endsWith('.md')
        )
        .map((e) => e.name)
        .sort()
    } catch (e) {
      log.warn(`扫描目录 ${this.userDir} 失败:`, e)
      return { valid: [], invalid: [] }
    }

    // 指纹命中即复用上次的解析结果（见 scanCache 的注释）
    const fingerprint = this.fingerprint(names)
    if (this.scanCache?.fingerprint === fingerprint) return this.scanCache.result

    const valid: Array<{ file: ParsedWorkflowFile; basePath: string }> = []
    const invalid: InvalidWorkflowFile[] = []
    for (const fileName of names) {
      const filePath = join(this.userDir, fileName)
      let raw: string
      try {
        raw = readFileSync(filePath, 'utf-8')
      } catch (e) {
        log.warn(`加载 workflow "${fileName}" 失败:`, e)
        invalid.push({ fileName, error: e instanceof Error ? e.message : String(e) })
        continue
      }
      const reasons: string[] = []
      const parsed = parseWorkflowDefinitionFile(raw, fileName.slice(0, -3), (msg) => {
        reasons.push(msg)
        log.warn(msg)
      })
      if (!parsed) {
        invalid.push({ fileName, error: reasons.join('\n') || 'Invalid workflow file' })
        continue
      }
      // 结构合法后再过脚本语法检查（共享解析器无脚本引擎依赖，语法归宿主）
      const compiled = nodeVmScriptEngine.compile(parsed.script)
      if (!compiled.ok) {
        const error = `script syntax error — ${compiled.error}`
        log.warn(`workflow "${parsed.name}": ${error}; the whole file is rejected`)
        invalid.push({ fileName, error })
        continue
      }
      // 同名的几份都收下 —— 谁生效由 resolveWorkflows 统一裁决（被遮蔽的照常列进设置页）
      valid.push({ file: parsed, basePath: filePath })
    }
    const result: ScanResult = { valid, invalid }
    this.scanCache = { fingerprint, result }
    return result
  }

  /**
   * 目录指纹：文件名 + inode + mtimeMs + size。stat 失败的条目记为 `?`，天然不命中缓存。
   *
   * inode 那一段是给笔记本的：编辑工作流就是它的笔记本会话在自动保存，走的是「临时文件 +
   * rename」的原子写 —— 每一笔都换一个 inode，所以秒级精度的文件系统上同一秒内的等长改写
   * 也骗不过指纹（原地覆写的外部编辑器保留 inode，那个缺口照旧，见单测里钉的现状）。
   */
  private fingerprint(names: string[]): string {
    return names
      .map((name) => {
        try {
          const st = statSync(join(this.userDir, name))
          return `${name}:${st.ino}:${st.mtimeMs}:${st.size}`
        } catch {
          return `${name}:?`
        }
      })
      .join('|')
  }

  /**
   * 内置（当前界面语言）+ 全部合法用户文件过一遍同名裁决（agent-runtime resolveShadowing）。
   * **引擎的注册表（listForEngine）与设置页列表都从这里取** —— 同一次裁决的两种投影，列表上标着
   * 生效的就是 fire / invoke 时真正会跑的那份。
   */
  private resolveWorkflows(): ShadowResolved<{ file: ParsedWorkflowFile; basePath: string }>[] {
    return resolveShadowing([
      ...buildBuiltinWorkflows({ language: i18next.language }).map((file) => ({
        name: file.name,
        source: 'builtin' as const,
        value: { file, basePath: '' }
      })),
      ...this.scanDir().valid.map((user) => ({
        name: user.file.name,
        source: 'user' as const,
        fileName: basename(user.basePath),
        value: user
      }))
    ])
  }

  /** 生效的用户工作流里叫这个名字的那份（按名寻址的读 / 删用；被遮蔽的几份只能按文件名删） */
  private activeUserFile(name: string): { file: ParsedWorkflowFile; basePath: string } | undefined {
    return this.resolveWorkflows().find(
      (entry) => entry.source === 'user' && !entry.shadowedBy && entry.name === name
    )?.value
  }

  /** 生效集（同名裁决之后，内置在前、用户在后）；引擎每次 fire 现算，文件改动即时生效 */
  private listForEngine(): WorkflowRegistryEntry[] {
    return this.resolveWorkflows()
      .filter((entry) => !entry.shadowedBy)
      .map((entry) => ({ file: entry.value.file, source: entry.source }))
  }

  // ─── 设置页 API（对标 policyService：全量列表 / md 原文 / 非法文件） ───

  /**
   * 设置页列表：同一次同名裁决的全部份数 —— 被遮蔽的（被用户文件压过的内置，或同名用户文件里没胜出
   * 的那几份）带 `overridden` 与 `overriddenBy`，只作展示。按名字排，同名里生效的在前。
   */
  listForSettings(): WorkflowListItem[] {
    return this.resolveWorkflows()
      .map(
        (entry): WorkflowListItem => ({
          ...this.toListItem(entry.value.file, entry.source, entry.value.basePath),
          ...(entry.shadowedBy
            ? {
                overridden: true,
                ...(entry.shadowedBy.fileName ? { overriddenBy: entry.shadowedBy.fileName } : {})
              }
            : {})
        })
      )
      .sort(
        (a, b) =>
          a.name.localeCompare(b.name) ||
          Number(!!a.overridden) - Number(!!b.overridden) ||
          a.basePath.localeCompare(b.basePath)
      )
  }

  /** ParsedWorkflowFile → 前端列表项（脚本/schema 原文不外传：列表不需要，编辑走 getSource） */
  private toListItem(
    file: ParsedWorkflowFile,
    source: 'builtin' | 'user',
    basePath: string
  ): WorkflowListItem {
    return {
      name: file.name,
      displayName: file.displayName,
      description: file.description,
      triggers: file.bindings.map((b) => b.trigger),
      concurrency: file.concurrency,
      source,
      basePath
    }
  }

  /** 目录里无法解析的工作流文件（设置页显示为可点开修复的告警项） */
  listInvalid(): InvalidWorkflowFile[] {
    return this.scanDir().invalid
  }

  /**
   * 取 md 原文（编辑器数据源）。用户文件读原文；内置直接回 bundle 里的 md 原文 ——
   * 工作流正文是「散文 + 脚本块」的混合体，无法从解析产物序列化还原（见
   * getBuiltinWorkflowSource）。内置原文同时是「创建覆盖副本」的初值。
   */
  getSource(name: string, source: 'builtin' | 'user'): { text: string } | { error: string } {
    if (source === 'user') {
      const target = this.activeUserFile(name)
      if (!target) return { error: `Workflow "${name}" not found` }
      try {
        return { text: readFileSync(target.basePath, 'utf-8') }
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) }
      }
    }
    const text = getBuiltinWorkflowSource(name, { language: i18next.language })
    return text === null ? { error: `Builtin workflow "${name}" not found` } : { text }
  }

  /**
   * 解析 + 脚本语法双重校验（写盘前）。**非法一律拒绝**：一份存在但非法的工作流会被
   * 扫描跳过（不触发也不遮蔽内置），与其让它躺在磁盘上假装生效，不如把原因交回 UI。
   */
  private parseForWrite(
    text: string,
    defaultName: string
  ): { file: ParsedWorkflowFile } | { error: string } {
    const messages: string[] = []
    const file = parseWorkflowDefinitionFile(text, defaultName, (msg) => messages.push(msg))
    if (!file) return { error: messages.join('\n') || 'Invalid workflow file' }
    const compiled = nodeVmScriptEngine.compile(file.script)
    if (!compiled.ok) return { error: `script syntax error — ${compiled.error}` }
    return { file }
  }

  /** 新建用户工作流（「新建」与「创建覆盖副本」共用）；文件名由 name 净化派生 */
  create(text: string): { success: boolean; name?: string; error?: string } {
    const parsed = this.parseForWrite(text, 'workflow')
    if ('error' in parsed) return { success: false, error: parsed.error }
    const name = parsed.file.name
    if (this.scanDir().valid.some((u) => u.file.name === name)) {
      return { success: false, error: `Workflow "${name}" already exists` }
    }

    // 文件名净化（与同名裁决认「文件名就是这个名字」同一套规则）；frontmatter name 才是标识
    const safeBase = registryFileBase(name) || 'workflow'
    if (!existsSync(this.userDir)) mkdirSync(this.userDir, { recursive: true })
    let filePath = join(this.userDir, `${safeBase}.md`)
    for (let i = 1; existsSync(filePath); i++) {
      filePath = join(this.userDir, `${safeBase}-${i}.md`)
    }
    try {
      writeFileSync(filePath, text, 'utf-8')
      this.invalidateScan()
    } catch (e) {
      log.warn(`新建 workflow "${name}" 失败:`, e)
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
    return { success: true, name }
  }

  /** 删除生效的那份用户工作流（删掉覆盖副本后同名内置自动恢复；被遮蔽的几份按文件名删） */
  delete(name: string): { success: boolean; error?: string } {
    const target = this.activeUserFile(name)
    if (!target) return { success: false, error: `Workflow "${name}" not found` }
    try {
      unlinkSync(target.basePath)
      this.invalidateScan()
    } catch (e) {
      log.warn(`删除 workflow "${name}" 失败:`, e)
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
    log.info(`已删除 workflow "${name}" (${target.basePath})`)
    return { success: true }
  }

  /**
   * 文件名白名单：仅接受工作流目录下的单个 .md 文件名，杜绝路径穿越
   * （fileName 来自渲染进程，虽只由 listInvalid 的返回值填充，仍按不可信入参处理）。
   */
  private resolveUserFile(fileName: string): string | null {
    if (!/^[^/\\]+\.md$/i.test(fileName) || fileName.startsWith('.')) return null
    const filePath = join(this.userDir, fileName)
    return existsSync(filePath) ? filePath : null
  }

  /** 按文件名删除 —— 非法文件（它解析不出 name）、或同名里被遮蔽的那几份（按名删会删到生效的那份） */
  deleteByFile(fileName: string): { success: boolean; error?: string } {
    const filePath = this.resolveUserFile(fileName)
    if (!filePath) return { success: false, error: `Workflow file "${fileName}" not found` }
    try {
      unlinkSync(filePath)
      this.invalidateScan()
    } catch (e) {
      log.warn(`删除 workflow 文件 "${fileName}" 失败:`, e)
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
    log.info(`已删除 workflow 文件 "${fileName}"`)
    return { success: true }
  }

  getUserDir(): string {
    return this.userDir
  }

  /** 打开用户工作流目录（OS 文件管理器；懒创建） */
  async openUserFolder(): Promise<void> {
    if (!existsSync(this.userDir)) mkdirSync(this.userDir, { recursive: true })
    await shell.openPath(this.userDir)
  }

  // ─── run 记录（JSONL journal） ────────────────

  private appendRunRecord(name: string, runId: string, record: Record<string, unknown>): void {
    try {
      // 与 agentService 的文件名净化同一习语；前导点一并剥掉（`..` 这类名不得逃出 .runs）
      const safeName = name.replace(/[\\/:*?"<>|]/g, '-').replace(/^\.+/, '') || 'workflow'
      const dir = join(this.userDir, '.runs', safeName)
      mkdirSync(dir, { recursive: true })
      appendFileSync(
        join(dir, `${runId}.jsonl`),
        `${JSON.stringify({ ts: Date.now(), ...record })}\n`
      )
      // meta 是每个 run 的第一条记录 —— 一个 run 一次剪枝，代价是一次 readdir
      if (record.type === 'meta') this.pruneRunJournal(dir)
    } catch (e) {
      log.warn(`workflow run journal 写入失败 (${name}/${runId}):`, e)
    }
  }

  /**
   * 保留每个工作流最近 `RUN_JOURNAL_KEEP` 个 run 文件。
   *
   * 无保留策略不可上线：auto-title 是「每会话每轮一个」—— 一个长期使用的用户目录会攒出
   * 十万级小文件。按 mtime 而不是文件名
   * 排序：runId 是 uuid，名字里没有时间。
   */
  private pruneRunJournal(dir: string): void {
    try {
      const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
      if (files.length <= RUN_JOURNAL_KEEP) return
      const stamped = files.map((f) => {
        const path = join(dir, f)
        try {
          return { path, mtime: statSync(path).mtimeMs }
        } catch {
          return { path, mtime: 0 }
        }
      })
      stamped.sort((a, b) => b.mtime - a.mtime)
      for (const { path } of stamped.slice(RUN_JOURNAL_KEEP)) {
        try {
          unlinkSync(path)
        } catch {
          /* 并发/权限问题跳过这一个，下次再剪 */
        }
      }
    } catch (e) {
      log.warn(`workflow run journal 剪枝失败 (${dir}):`, e)
    }
  }
}

export const workflowService = new WorkflowService()

/**
 * 业务埋点门面 —— emit 侧唯一入口。用法：
 *   workflowTriggers.fire('session.turn-completed', { sessionId, … })
 * payload 形状由 TriggerPayloadMap 按 id 收窄（埋点目录见 agent-runtime workflow/triggerPoints.ts）。
 */
export const workflowTriggers = {
  fire: <K extends TriggerId>(id: K, payload: TriggerPayloadMap[K]): void =>
    workflowService.fire(id, payload)
}
