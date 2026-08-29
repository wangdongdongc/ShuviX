/**
 * WorkflowService —— 工作流注册表 + 引擎装配 + 埋点门面（桌面宿主层）。
 *
 * 设计见 docs/workflow-md-design.md。分工：
 *  - 注册表：内置（@shuvix/agent-runtime buildBuiltinWorkflows，随语言现算）+ 用户
 *    `~/.shuvix/workflows/<name>.md`（目录扫描，同名覆盖内置 —— 与 agentService 同口径），
 *    用户文件额外过脚本引擎的 compile 语法检查（结构校验在共享解析器内）；
 *  - autorun 缺省规则：内置名（含覆盖内置的同名用户文件）默认启用 —— auto-title 出厂
 *    即工作；纯用户工作流默认关闭。`~/.shuvix/workflows/.config.json` 显式覆盖
 *    （{ disabled: string[], autorunEnabled: Record<name, boolean> }，同 skills 的旁路配置）；
 *  - run 记录：`~/.shuvix/workflows/.runs/<name>/<runId>.jsonl` 追加式 journal；
 *  - `workflowTriggers.fire(id, payload)`：业务埋点的唯一入口 —— **业务侧只声明
 *    「我在哪、上下文里有什么」**（payload 类型由 TriggerPayloadMap 收窄），订阅与
 *    否与它无关；引擎未初始化（启动早期）时静默丢弃。
 *
 * 引擎在 init() 里装配（main/index.ts 调用）而非模块顶层 —— 依赖 agentManager /
 * agentService / sessionService 的运行时状态，顶层装配会踩 ESM 初始化环。
 */
import { existsSync, readdirSync, readFileSync, mkdirSync, appendFileSync } from 'fs'
import { join } from 'path'
import i18next from 'i18next'
import {
  BUILTIN_WORKFLOW_NAMES,
  buildBuiltinWorkflows,
  createWorkflowEngine,
  parseWorkflowDefinitionFile,
  toInProcessAgentType,
  type ParsedWorkflowFile,
  type TriggerId,
  type TriggerPayloadMap,
  type WorkflowEngine,
  type WorkflowRegistryEntry
} from '@shuvix/agent-runtime'
import { getDefaultWorkflowsDir } from '../utils/paths'
import { agentManager } from '../agents/AgentManager'
import { resolveProfileModelSpec } from '../agents/agentHost'
import { agentService } from './agentService'
import { sessionService } from './sessionService'
import { nodeVmScriptEngine } from './workflowScriptEngine'
import { createLogger } from '../logger'

const log = createLogger('Workflow')

/** 旁路配置（`.config.json`）：显式开关，覆盖 autorun 缺省规则 */
interface WorkflowConfig {
  disabled?: string[]
  autorunEnabled?: Record<string, boolean>
}

class WorkflowService {
  private readonly userDir = getDefaultWorkflowsDir()
  private engine: WorkflowEngine | null = null

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
      resolveRunModel: async ({ sessionId, modelSpec }) => {
        // modelSpec（run opts.model ?? workflow md model）优先；不可用回落会话当前模型。
        // agent 档案自己的 shuvix-model 不经这里 —— 创建管线的 spawned 路径本就优先它。
        if (modelSpec) {
          const resolved = resolveProfileModelSpec(modelSpec)
          if (resolved) return resolved
          log.warn(`workflow model "${modelSpec}" 当前不可用，回落会话模型`)
        }
        return sessionId ? await sessionService.resolveRunModelConfig(sessionId) : null
      },
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

  // ─── 注册表 ──────────────────────────────────

  private readConfig(): WorkflowConfig {
    try {
      const raw = readFileSync(join(this.userDir, '.config.json'), 'utf-8')
      const parsed: unknown = JSON.parse(raw)
      return typeof parsed === 'object' && parsed !== null ? (parsed as WorkflowConfig) : {}
    } catch {
      return {}
    }
  }

  /** 用户目录扫描（同 agentService.scanDir 口径：非法文件警告跳过、同名保留先扫到的） */
  private scanUserDir(): ParsedWorkflowFile[] {
    if (!existsSync(this.userDir)) return []
    let names: string[]
    try {
      names = readdirSync(this.userDir, { withFileTypes: true })
        .filter(
          (e) => e.isFile() && !e.name.startsWith('.') && e.name.toLowerCase().endsWith('.md')
        )
        .map((e) => e.name)
    } catch (e) {
      log.warn(`扫描目录 ${this.userDir} 失败:`, e)
      return []
    }

    const result: ParsedWorkflowFile[] = []
    const seen = new Set<string>()
    for (const fileName of names) {
      let raw: string
      try {
        raw = readFileSync(join(this.userDir, fileName), 'utf-8')
      } catch (e) {
        log.warn(`加载 workflow "${fileName}" 失败:`, e)
        continue
      }
      const parsed = parseWorkflowDefinitionFile(raw, fileName.slice(0, -3), (msg) => log.warn(msg))
      if (!parsed) continue
      // 结构合法后再过脚本语法检查（共享解析器无脚本引擎依赖，语法归宿主）
      const compiled = nodeVmScriptEngine.compile(parsed.script)
      if (!compiled.ok) {
        log.warn(
          `workflow "${parsed.name}": script syntax error — ${compiled.error}; the whole file is rejected`
        )
        continue
      }
      if (seen.has(parsed.name)) {
        log.warn(`workflow "${parsed.name}": 同名文件重复（${fileName}），已跳过`)
        continue
      }
      seen.add(parsed.name)
      result.push(parsed)
    }
    return result
  }

  /** 合并列表（用户覆盖内置同名）+ 配置解析；引擎每次 fire 现算，文件/配置改动即时生效 */
  private listForEngine(): WorkflowRegistryEntry[] {
    const config = this.readConfig()
    const disabled = new Set(config.disabled ?? [])
    const users = this.scanUserDir()
    const userNames = new Set(users.map((w) => w.name))
    const builtins = buildBuiltinWorkflows({ language: i18next.language }).filter(
      (w) => !userNames.has(w.name)
    )

    const entries: WorkflowRegistryEntry[] = []
    for (const { file, source } of [
      ...builtins.map((file) => ({ file, source: 'builtin' as const })),
      ...users.map((file) => ({ file, source: 'user' as const }))
    ]) {
      if (disabled.has(file.name)) continue
      entries.push({
        file,
        source,
        // autorun 缺省：内置名（含覆盖内置的同名用户文件）默认 true —— 覆盖 auto-title
        // 不该让自动标题静默消失；纯用户工作流默认 false（放下 md 不该能静默烧 token）
        autorunEnabled: config.autorunEnabled?.[file.name] ?? BUILTIN_WORKFLOW_NAMES.has(file.name)
      })
    }
    return entries
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
    } catch (e) {
      log.warn(`workflow run journal 写入失败 (${name}/${runId}):`, e)
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
