/**
 * Workflow 引擎（宿主无关核心）—— 埋点匹配 + run 生命周期 + 脚本 API 装配。
 *
 * 职责边界（docs/workflow-md-design.md §4–§6）：
 *  - `fire(id, payload)`：对着注册表匹配「绑定了该埋点、autorun 已启用、CEL when 命中」
 *    的工作流并起 run。**绝不抛出**，emit 侧对订阅情况零感知；
 *  - run：脚本经宿主注入的 WorkflowScriptEngine 执行；脚本唯一的副作用通道是 `run()`
 *    派发 agent（经共享 SubAgentManager，结果契约见 subagent/nextTool.ts）—— 脚本本身
 *    零环境权限；
 *  - 限额（maxAgents / maxDurationSec / maxConcurrentAgents）与重入（skip/queue/parallel）
 *    在此收口；run 级 AbortController 作为 parentAbortSignal 下传，超时/中止级联到
 *    全部在飞 agent；
 *  - 会话域埋点（TriggerPointDef.scope==='session'）：payload.sessionId 即 run 的归属会话，
 *    派发以它为 parentSessionId —— 工具绑定/询问路由/LLM 日志/子代理面板都自然落位；
 *    无会话上下文的 run 以 runId 自成归属。
 *
 * 可观测性走 onRecord（宿主落 JSONL journal）：meta / step_start / step_end / log / end。
 * v1 刻意不做：ask/notify 脚本原语（需要作答/通知面）、手动运行入口、触发链 provenance
 * （现有埋点不会由 run 的副作用再触发，chain 恒空数组占位）。
 */
import { v4 as uuid } from 'uuid'
import type { SubAgentManager } from '../subagent/manager'
import type { InProcessAgentType, SubAgentModelConfig } from '../subagent/types'
import type { RuntimeLogger } from '../types'
import { validateContractSchema } from '../subagent/nextTool'
import { TRIGGER_POINTS, type TriggerId, type TriggerPayloadMap } from './triggerPoints'
import { evaluateWhen } from './when'
import type { ParsedWorkflowFile } from './workflowFile'

/** 限额缺省（`shuvix-workflow-limits` 可覆盖）；askTimeoutSec 预留给未来的 ask 原语 */
export const DEFAULT_WORKFLOW_LIMITS = {
  maxAgents: 20,
  maxDurationSec: 1800,
  maxConcurrentAgents: 4
} as const

/**
 * 脚本引擎 seam —— 宿主注入（桌面 node:vm 过渡实现；目标是两端统一的 QuickJS wasm）。
 * `api` 以 global 形式暴露给脚本；执行语义：标准 JS、顶层 await、返回值即 run 输出。
 */
export interface WorkflowScriptEngine {
  /** 保存/扫描期语法检查。ok=false 时 error 为人读原因（整份文件判非法） */
  compile(source: string): { ok: true } | { ok: false; error: string }
  /** 执行脚本。signal 中止后应尽快失败；timeoutMs 为引擎自身的兜底（同步段守卫等） */
  execute(
    source: string,
    api: Record<string, unknown>,
    opts: { signal: AbortSignal; timeoutMs: number }
  ): Promise<unknown>
}

/** 注册表条目 —— 宿主 listWorkflows() 现算（builtin + 用户覆盖合并、disabled 已滤除） */
export interface WorkflowRegistryEntry {
  file: ParsedWorkflowFile
  source: 'builtin' | 'user'
  /** 自动触发是否启用（手动运行不看它）。缺省规则在宿主：内置名默认 true，纯用户默认 false */
  autorunEnabled: boolean
}

export interface WorkflowEngineDeps {
  manager: SubAgentManager
  script: WorkflowScriptEngine
  /** 每次 fire 现算的注册表（语言/用户文件/配置变化自动跟随，同 agentService 口径） */
  listWorkflows: () => WorkflowRegistryEntry[]
  /** 具名 agent 档案解析（运行投影）；未知返回 null */
  resolveAgentProfile: (ref: string) => InProcessAgentType | null
  /**
   * 解析一次派发的模型：modelSpec（run opts.model ?? workflow md model，原样字符串）优先，
   * 不可用/未声明回落 sessionId 的会话当前模型；都没有返回 null（run() 报错）。
   * agent 档案自己的 `shuvix-model` 不经这里 —— 统一创建管线在 spawned 路径本就优先它。
   */
  resolveRunModel: (ctx: {
    sessionId?: string
    modelSpec?: string
  }) => Promise<SubAgentModelConfig | null>
  /** run 记录落盘（宿主 JSONL journal）；缺省丢弃 */
  onRecord?: (workflowName: string, runId: string, record: Record<string, unknown>) => void
  /** CEL `when` 的 env 上下文 */
  env: { host: string; platform: string }
  logger?: RuntimeLogger
}

export interface WorkflowEngine {
  /** 业务埋点入口 —— payload 形状按 id 收窄（TriggerPayloadMap）。绝不抛出。 */
  fire<K extends TriggerId>(id: K, payload: TriggerPayloadMap[K]): void
  /** 正在运行的 run 数（监控/测试用） */
  runningCount(): number
}

/** run() 的脚本侧选项（脚本传入，逐字段防御性校验） */
interface RunOpts {
  schema?: unknown
  model?: unknown
  tools?: unknown
  description?: unknown
  nudges?: unknown
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 深冻结（脚本侧的 event/vars/schemas 只读；跨 vm realm 的防御性质，不是安全边界） */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const v of Object.values(value)) deepFreeze(v)
    Object.freeze(value)
  }
  return value
}

/** JSON 克隆 —— 跨脚本膜只走纯 JSON 值（丢函数/原型，undefined 字段消失） */
function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? null)) as T
}

export function createWorkflowEngine(deps: WorkflowEngineDeps): WorkflowEngine {
  const logger = deps.logger
  /** 每工作流的在跑计数（skip/queue 重入判定） */
  const running = new Map<string, number>()
  /**
   * queue 模式的待跑槽 —— **容量恒为 1**，新触发覆盖旧的（设计 §3.3「队列长度 1」）：
   * 高频埋点上无界积压只会让迟到的 run 拿着过期的信封挨个空跑，最后一个事件才是现状。
   */
  const queuedNext = new Map<
    string,
    { entry: WorkflowRegistryEntry; envelope: Record<string, unknown> }
  >()

  function safeList(): WorkflowRegistryEntry[] {
    try {
      return deps.listWorkflows()
    } catch (err) {
      logger?.warn(`workflow registry listing failed: ${errText(err)}`)
      return []
    }
  }

  function whenHit(
    entry: WorkflowRegistryEntry,
    when: string | undefined,
    envelope: Record<string, unknown>
  ): boolean {
    if (!when) return true
    try {
      return evaluateWhen(when, { event: envelope, vars: entry.file.vars, env: deps.env })
    } catch (err) {
      // strict fail-safe：求值错误（含访问 payload 缺失属性）按不命中处理 —— 宁漏勿误发
      logger?.warn(`workflow "${entry.file.name}": when evaluation failed — ${errText(err)}`)
      return false
    }
  }

  async function executeRun(
    entry: WorkflowRegistryEntry,
    envelope: Record<string, unknown>
  ): Promise<void> {
    const file = entry.file
    const name = file.name
    // 同步段先占坑：skip 判定与本次启动之间无 await 窗口
    running.set(name, (running.get(name) ?? 0) + 1)

    const runId = `wfr-${uuid()}`
    const triggerId = envelope.trigger as string
    const def = TRIGGER_POINTS[triggerId as TriggerId]
    const sessionId =
      def?.scope === 'session' ? (envelope as { sessionId?: string }).sessionId : undefined
    const limits = { ...DEFAULT_WORKFLOW_LIMITS, ...file.limits }
    const controller = new AbortController()
    const startedAt = Date.now()

    const record = (rec: Record<string, unknown>): void => {
      try {
        deps.onRecord?.(name, runId, rec)
      } catch {
        /* journal 失败不影响 run */
      }
    }
    record({ type: 'meta', trigger: triggerId, source: entry.source, sessionId, event: envelope })
    logger?.info(`workflow "${name}" run=${runId} start trigger=${triggerId}`)

    // ── run() 原语：agent 派发（配额 + 并发信号量 + 结果契约） ──
    let agentCount = 0
    let activeAgents = 0
    const waiters: Array<() => void> = []
    const acquire = async (): Promise<void> => {
      while (activeAgents >= limits.maxConcurrentAgents) {
        await new Promise<void>((resolve) => waiters.push(resolve))
      }
      activeAgents++
    }
    const release = (): void => {
      activeAgents--
      waiters.shift()?.()
    }

    const runAgent = async (ref: unknown, prompt: unknown, opts?: RunOpts): Promise<unknown> => {
      if (controller.signal.aborted) throw new Error('workflow run aborted')
      if (typeof ref !== 'string' || !ref.trim()) {
        throw new Error('run(agent, prompt): agent ref must be a non-empty string')
      }
      if (typeof prompt !== 'string' || !prompt.trim()) {
        throw new Error('run(agent, prompt): prompt must be a non-empty string')
      }
      if (++agentCount > limits.maxAgents) {
        throw new Error(`workflow agent limit reached (maxAgents=${limits.maxAgents})`)
      }
      const schema = opts?.schema
      if (schema !== undefined) {
        const schemaError = validateContractSchema(schema)
        if (schemaError) throw new Error(`run(): ${schemaError}`)
      }
      await acquire()
      try {
        const profile = deps.resolveAgentProfile(ref.trim())
        if (!profile) {
          throw new Error(
            `unknown agent "${ref.trim()}" — the ref must name a configured agent definition`
          )
        }
        // opts.tools = 档案白名单的交集收窄（只能减不能加 —— 提权须改 agent md）；
        // 两侧统一小写比较：mcp:/skill: 名的余部大小写保留在档案侧，收窄判定不因此漏配
        let tools = [...profile.tools]
        if (opts?.tools !== undefined) {
          if (!Array.isArray(opts.tools))
            throw new Error('run(): opts.tools must be a string array')
          const allow = new Set(opts.tools.map((t) => String(t).toLowerCase()))
          tools = tools.filter((t) => allow.has(t.toLowerCase()))
        }
        const modelSpec = typeof opts?.model === 'string' && opts.model ? opts.model : file.model
        const modelConfig = await deps.resolveRunModel({ sessionId, modelSpec })
        if (!modelConfig) {
          throw new Error('no model available for this run — configure a session or default model')
        }
        const description =
          typeof opts?.description === 'string' && opts.description.trim()
            ? opts.description.trim()
            : prompt.trim().split('\n')[0].slice(0, 40)
        const nudges = typeof opts?.nudges === 'number' ? opts.nudges : undefined

        record({ type: 'step_start', agent: profile.name, description })
        const t0 = Date.now()
        const res = await deps.manager.runTask({
          // 会话域 run 挂到归属会话名下（工具/询问/日志/面板落位）；否则 runId 自成血缘根
          parentSessionId: sessionId ?? runId,
          agentType: { ...profile, tools },
          prompt,
          description,
          modelConfig,
          parentAbortSignal: controller.signal,
          resultContract: schema
            ? { schema: schema as Record<string, unknown>, sourceLabel: name, nudges }
            : undefined
        })
        record({
          type: 'step_end',
          agent: profile.name,
          ms: Date.now() - t0,
          captured: schema ? res.structured !== undefined : undefined
        })
        if (schema !== undefined) {
          if (res.structured === undefined) {
            // 可编程失败（设计 §5.5）：脚本 catch 后可读 e.code / e.finalText 降级使用散文结果。
            // 用属性而非错误子类 —— 错误对象要跨脚本膜（vm realm），instanceof 不可靠
            const err = new Error(
              `agent "${profile.name}" finished without calling \`next\` — transcript tail: ${res.result.slice(0, 300)}`
            ) as Error & { code?: string; finalText?: string }
            err.code = 'next_not_called'
            err.finalText = res.result
            throw err
          }
          return jsonClone(res.structured)
        }
        return res.result
      } finally {
        release()
      }
    }

    // ── 脚本 API（唯一可见的 global 面；出入参一律纯 JSON 值） ──
    const api: Record<string, unknown> = {
      event: deepFreeze(jsonClone(envelope)),
      input: deepFreeze(jsonClone((envelope as { input?: unknown }).input ?? {})),
      vars: deepFreeze(jsonClone(file.vars)),
      schemas: deepFreeze(jsonClone(file.schemas)),
      run: runAgent,
      /** 并发辅助：单项失败落为 null（不整体 reject）；并发上限由 run() 内的信号量统一约束 */
      map: async (items: unknown, fn: (item: unknown, index: number) => unknown) => {
        if (!Array.isArray(items)) throw new Error('map(items, fn): items must be an array')
        if (typeof fn !== 'function') throw new Error('map(items, fn): fn must be a function')
        return Promise.all(
          items.map((item, index) =>
            Promise.resolve()
              .then(() => fn(item, index))
              .catch((err) => {
                record({ type: 'log', message: `map[${index}] failed: ${errText(err)}` })
                return null
              })
          )
        )
      },
      log: (message: unknown) => record({ type: 'log', message: String(message) }),
      sleep: (ms: unknown) =>
        new Promise<void>((resolve, reject) => {
          const delay = Math.max(0, Number(ms) || 0)
          const timer = setTimeout(resolve, delay)
          controller.signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer)
              reject(new Error('workflow run aborted'))
            },
            { once: true }
          )
        }),
      now: () => new Date().toISOString(),
      fail: (message: unknown): never => {
        throw new Error(String(message ?? 'workflow failed'))
      }
    }

    // ── 执行 + 墙钟限时（超时 abort 级联到脚本原语与全部在飞 agent） ──
    const deadlineMs = limits.maxDurationSec * 1000
    const timer = setTimeout(() => controller.abort(), deadlineMs)
    let exec: Promise<unknown> | undefined
    try {
      exec = deps.script.execute(file.script, api, {
        signal: controller.signal,
        timeoutMs: deadlineMs
      })
      // 无视脚本是否还挂着（node:vm 无法硬中断异步续体）：deadline 一到 run 即判超时收尾
      const output = await Promise.race([
        exec,
        new Promise<never>((_, reject) =>
          controller.signal.addEventListener(
            'abort',
            () => reject(new Error(`workflow run timed out after ${limits.maxDurationSec}s`)),
            { once: true }
          )
        )
      ])
      record({ type: 'end', ok: true, ms: Date.now() - startedAt, output: jsonClone(output) })
      logger?.info(`workflow "${name}" run=${runId} ok (${Date.now() - startedAt}ms)`)
    } catch (err) {
      record({ type: 'end', ok: false, ms: Date.now() - startedAt, error: errText(err) })
      logger?.warn(`workflow "${name}" run=${runId} failed: ${errText(err)}`)
    } finally {
      // race 输掉/超时后脚本稍后才 settle 时不留 unhandled rejection
      exec?.catch(() => {})
      clearTimeout(timer)
      controller.abort()
      running.set(name, (running.get(name) ?? 1) - 1)
      // queue 模式的排空：空闲后拉起待跑槽里最后一个触发（skip/parallel 从不写这个槽）
      const next = queuedNext.get(name)
      if (next && (running.get(name) ?? 0) === 0) {
        queuedNext.delete(name)
        void executeRun(next.entry, next.envelope)
      }
    }
  }

  function launch(entry: WorkflowRegistryEntry, envelope: Record<string, unknown>): void {
    const name = entry.file.name
    const mode = entry.file.concurrency
    if (mode === 'skip' && (running.get(name) ?? 0) > 0) {
      logger?.info(`workflow "${name}": previous run still active — trigger skipped`)
      return
    }
    if (mode === 'queue' && (running.get(name) ?? 0) > 0) {
      // 队列长度 1：覆盖待跑槽（迟到多次只保最后一个事件）
      queuedNext.set(name, { entry, envelope })
      logger?.info(`workflow "${name}": previous run still active — trigger queued (slot of 1)`)
      return
    }
    void executeRun(entry, envelope)
  }

  return {
    fire(id, payload): void {
      try {
        if (!TRIGGER_POINTS[id]) return
        // 信封 = payload + 保留键：trigger（埋点 id）与 chain（触发链占位，恒空数组）
        const envelope: Record<string, unknown> = { ...payload, trigger: id, chain: [] }
        for (const entry of safeList()) {
          if (!entry.autorunEnabled) continue
          // 同一埋点的多条绑定：命中一条即起一个 run（不重复起）
          const binding = entry.file.bindings.find(
            (b) => b.trigger === id && whenHit(entry, b.when, envelope)
          )
          if (!binding) continue
          launch(entry, envelope)
        }
      } catch (err) {
        logger?.warn(`workflow fire(${String(id)}) failed: ${errText(err)}`)
      }
    },

    runningCount(): number {
      let total = 0
      for (const count of running.values()) total += count
      return total
    }
  }
}
