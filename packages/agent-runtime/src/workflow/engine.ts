/**
 * Workflow 引擎（宿主无关核心）—— 埋点匹配 + run 生命周期 + 脚本 API 装配。
 *
 * 职责边界（docs/workflow-md-design.md §3.6/§4–§6）：
 *  - **两条调用路径**：`fire(id, payload)` 是广播（按埋点 id 匹配、CEL when 命中即起 run，
 *    **绝不抛出**，emit 侧对订阅情况零感知）；`invoke(req)` 是定向调用（按名起一份、
 *    回传结果）—— bot 管线、未来的手动运行 / CLI / mcp.call 共用后者；
 *  - **run 的身份是引擎生成的 runId**，不是工作流文件名。同一份 md 可经不同路径、
 *    不同参数同时执行，互不干扰 —— 声明是声明，执行态不焊在声明上；
 *  - **互斥拆成两个正交问题**：*什么算同一件事*（分道键 laneKey，**由调用方给**）与
 *    *同一件事撞车了怎么办*（策略，即文件的 `shuvix-workflow-concurrency`，作用域从
 *    「整份文件」收窄为「本分道」）。引擎不猜维度：会话域埋点的缺省键是 sessionId，
 *    bot 路径三种粒度（gate/task/notes）并存，都由调用方说了算；
 *  - run：脚本经宿主注入的 WorkflowScriptEngine 执行。基础 API 只有流程原语（条件、并行、
 *    聚合、日志），干活的是 `run()` 派发出去的 agent —— 它与 dispatch 工具派发的 agent
 *    走完全同一条创建与执行路径，照走 security 策略门。`invoke` 的调用方还可以随本次调用
 *    传几个自己造好的函数进来（`extraApi`，如 bot 路径的 say/claim/turn，目标已固化在
 *    闭包里）；`fire` 是广播、没有单一调用方，也就没有可传的东西。**这是脚本 API 面的
 *    装配差异，不是安全维度**：被派发 agent 能做什么只由策略引擎在执行期判定，与它经哪条
 *    路径起跑无关（工作流不构成第二套安全机制）；
 *  - 限额（maxAgents / maxDurationSec / maxConcurrentAgents）在此收口；run 级
 *    AbortController 作为 parentAbortSignal 下传，超时/中止级联到全部在飞 agent；
 *  - 会话域埋点（TriggerPointDef.scope==='session'）：payload.sessionId 即 run 的归属会话，
 *    派发以它为 parentSessionId —— 工具绑定/询问路由/LLM 日志/子代理面板都自然落位；
 *    无会话上下文的 run 以 runId 自成归属。
 *
 * 可观测性走 onRecord（宿主落 JSONL journal）：meta / step_start / step_end / log / end。
 * 刻意不做：ask/notify 脚本原语（需要作答/通知面）、触发链 provenance（chain 恒空数组占位）。
 */
import { v4 as uuid } from 'uuid'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { SubAgentManager } from '../subagent/manager'
import type { InProcessAgentType, SubAgentModelConfig } from '../subagent/types'
import type { RuntimeLogger } from '../types'
import { validateContractSchema } from '../subagent/nextTool'
import { TRIGGER_POINTS, type TriggerId, type TriggerPayloadMap } from './triggerPoints'
import { evaluateWhen, evaluateLaneKey } from './when'
import { renderPromptTemplate } from './promptTemplate'
import type { ParsedWorkflowFile, WorkflowConcurrency } from './workflowFile'

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

/**
 * 注册表条目 —— 宿主 listWorkflows() 现算（builtin + 用户覆盖合并）。
 *
 * **纯 md 驱动**：文件存在且校验通过即生效，没有启用开关也没有旁路配置（同 agent md）。
 * 不想让它跑就把文件删掉或改坏名字 —— 一个既在目录里、又"没启用"的工作流，
 * 是用户下次排查「为什么没触发」时最先被骗到的东西。
 */
export interface WorkflowRegistryEntry {
  file: ParsedWorkflowFile
  source: 'builtin' | 'user'
}

export interface WorkflowEngineDeps {
  manager: SubAgentManager
  script: WorkflowScriptEngine
  /** 每次 fire 现算的注册表（语言/用户文件/配置变化自动跟随，同 agentService 口径） */
  listWorkflows: () => WorkflowRegistryEntry[]
  /** 具名 agent 档案解析（运行投影）；未知返回 null */
  resolveAgentProfile: (ref: string) => InProcessAgentType | null
  /**
   * `run(..., { attach })` 里那些**不透明句柄**换成派生 agent 上下文里的真实消息。
   *
   * 为什么是句柄而不是内容本身：`run` 的入参来自脚本，而脚本的 input 会被原样写进 run
   * journal（`meta` 记录带着整个 envelope）—— 让 base64 图片进 input，等于每条带图消息
   * 都在磁盘上留下一份逐 bot 的副本。所以宿主放进 input 的是「第几张图、什么类型」这种
   * 轻量引用，真正的字节由本函数在派发那一刻取回来。
   *
   * 第二参是**本次 run 的归属会话**：句柄来自脚本，而脚本是用户写的 md —— 不把它交给
   * 宿主，任何工作流都能写一个指向别的会话的句柄，把那边的图片字节拉进本次派发的上下文。
   * 这不构成越权（会话都是同一个用户的），但「附件」这个词不该悄悄含有跨会话读取的意思。
   *
   * 未注入时 `attach` 被忽略（附件是宿主能力，不是每个宿主都有）。
   */
  resolveAttachments?: (
    refs: unknown[],
    sessionId: string | undefined
  ) => Promise<AgentMessage[]> | AgentMessage[]
  /**
   * 本次 run 的基准模型 = 归属会话的当前模型（无会话上下文时宿主自行兜底）；
   * 没有可用模型返回 null（run() 报错）。
   *
   * **工作流不参与选模型**：被派发 agent 的 `shuvix-model` 声明优先于这里给的值
   * （统一创建管线在 spawned 路径本就如此），没声明就跟随会话 —— 定模型是 agent 的
   * 属性，工作流再开一个覆盖入口只会让「这次到底用了谁」需要查优先级表。
   */
  resolveRunModel: (ctx: { sessionId?: string }) => Promise<SubAgentModelConfig | null>
  /** run 记录落盘（宿主 JSONL journal）；缺省丢弃 */
  onRecord?: (workflowName: string, runId: string, record: Record<string, unknown>) => void
  /** CEL `when` 的 env 上下文 */
  env: { host: string; platform: string }
  logger?: RuntimeLogger
}

/** 重入分道 —— 「什么和什么算同一件事」由调用方决定，引擎不猜 */
export interface WorkflowReentry {
  /** 分道键；同一工作流内相同 key 的 run 互斥。省略 → 不参与任何互斥 */
  key?: string
  /** 忙道策略；省略 → 文件的 `shuvix-workflow-concurrency` */
  mode?: WorkflowConcurrency
}

export interface WorkflowInvokeRequest {
  /** 注册表具名（用户覆盖内置同名，规则与 fire 一致） */
  workflow: string
  /** 脚本 `input`；文件声明了 `shuvix-workflow-input` 时按其 `required` 做浅校验 */
  input?: unknown
  /**
   * 调用方为本次 run 额外装配进脚本 API 的函数（bot 路径的 say/claim/turn）。
   * 与基础 API 同名、或名字不是合法标识符即拒绝装配，见 BASE_API_NAMES。
   */
  extraApi?: Record<string, unknown>
  reentry?: WorkflowReentry
  /** 归属会话（派发的 parentSessionId：工具/询问/LLM 日志/面板落位） */
  sessionId?: string
  /** 外部中止（会话 abort / per-bot 停止级联） */
  signal?: AbortSignal
  /** 调用来源标签（journal / listRuns 可读） */
  label?: string
  /**
   * 追加到本次 run 里**每一个** `run()` 所派发 agent 的系统提示词末尾的上下文块（已围栏）。
   * 与 `extraApi` 同一种席位：调用方随本次 invoke 装配、引擎不解释内容 —— bot 管线用它把
   * bot 的人设与记忆带给门控/复核/任务每一段。`fire` 没有调用方，所以那条路径恒为空。
   */
  systemContext?: readonly string[]
}

export interface WorkflowInvokeResult {
  /** 真的起跑了才有 */
  runId?: string
  started: boolean
  /**
   * `started: false` 的原因：
   *  - `not-found` 注册表里没有这个名字（用户改坏/删了引用的 workflow）
   *  - `invalid-input` 入参不满足 `shuvix-workflow-input`
   *  - `skipped` 本分道忙且策略为 skip
   *  - `superseded` 在 queue 槽里被更新的调用顶掉（槽容量恒为 1）
   *  - `error` 引擎内部失败（注册表抛错之类）—— 兜底不谎称「没这个工作流」，
   *    调用方据此提示用户会指错方向
   */
  reason?: 'not-found' | 'invalid-input' | 'skipped' | 'superseded' | 'error'
  /** started 时：脚本是否正常收尾 */
  ok?: boolean
  output?: unknown
  error?: string
  /**
   * 失败的机器可读归类（started 且 !ok 时可能有）：脚本里 `run()` 抛出的 `e.code`
   * （`unknown_agent` / `step_timeout` / `step_aborted` / `next_not_called`）、调用方经
   * `extraApi` 装配的函数抛出的 code（bot 路径的 `mailbox_*`）、或 run 级收尾的
   * `run_timeout` / `run_aborted`。脚本自己 `throw new Error()` / `fail()` 的没有 code。
   *
   * **宿主据此选文案与记账，脚本不必为了报告失败而 try/catch** —— 失败从脚本里原样抛
   * 出去就是可见的，而且比脚本转述更准（code 是引擎判的，不是脚本猜的）。
   */
  errorCode?: string
  /** 抛出那个错的派发步：本 run 里第几次 `run()`（从 0 数）与它派发的 agent 名 */
  errorStep?: WorkflowErrorStep
}

/** 一次派发步的身份 —— 挂在 `run()` 抛出的错误上（`e.step`），随失败结果交回调用方 */
export interface WorkflowErrorStep {
  index: number
  agent: string
}

/** 一次运行的只读快照（Monitor / 宿主中止面 / 测试） */
export interface WorkflowRunSnapshot {
  runId: string
  workflowName: string
  source: 'builtin' | 'user'
  invocation: { kind: 'trigger'; trigger: string } | { kind: 'call'; label?: string }
  laneKey?: string
  sessionId?: string
  startedAt: number
}

export interface WorkflowEngine {
  /** 业务埋点入口 —— payload 形状按 id 收窄（TriggerPayloadMap）。绝不抛出。 */
  fire<K extends TriggerId>(id: K, payload: TriggerPayloadMap[K]): void
  /** 定向调用入口 —— 按名起一份并回传结果。绝不抛出（失败经返回值表达）。 */
  invoke(req: WorkflowInvokeRequest): Promise<WorkflowInvokeResult>
  /** 在跑的 run 快照（唯一权威是 runId，不是文件名） */
  listRuns(): WorkflowRunSnapshot[]
  /** 中止一个 run；未知 runId 返回 false */
  abortRun(runId: string): boolean
  /** 中止一条分道上的全部 run（含排队中的那一个），返回中止数 */
  abortLane(laneKey: string): number
  /** 中止某会话名下的全部 run，返回中止数 */
  abortSession(sessionId: string): number
  /** 正在运行的 run 数（监控/测试用） */
  runningCount(): number
  /**
   * 当前有条目的分道数（监控/测试用）。存在的理由是「空道即删」这条不变量本身 ——
   * 它的动机是内存增长（bot 路径的键含 sessionId+botName），而一条只能靠
   * 「跑完还能不能再起」间接断言的不变量，等于没有验收面。
   */
  laneCount(): number
}

/**
 * 分道键的组合口径 —— 宿主要主动中止一条道（会话删除、per-bot 停止）时用这个拼，
 * 不要自己复制 `\u0000`：分隔符一旦被抄进宿主，下一次重构就会与引擎漂移。
 */
export function workflowLaneKey(workflowName: string, key: string): string {
  return `${workflowName}\u0000${key}`
}

/** 合法 JS 标识符 —— 装配进脚本 API 的名字要能在脚本里被写出来 */
const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/

/**
 * 脚本可见的基础 API 名 —— `extraApi` 与之同名即拒绝装配。
 * 遮蔽掉 `run`/`log` 这类基础面，会让同一份 md 在不同调用路径下语义不同。
 */
const BASE_API_NAMES = [
  'event',
  'input',
  'vars',
  'schemas',
  'prompt',
  'run',
  'map',
  'log',
  'sleep',
  'now',
  'fail'
] as const

/** run() 的脚本侧选项（脚本传入，逐字段防御性校验） */
interface RunOpts {
  schema?: unknown
  tools?: unknown
  description?: unknown
  nudges?: unknown
  /** 本次派发的墙钟上限（秒）；与 run 级 deadline 取先到者 */
  timeoutSec?: unknown
  /** 宿主给出的不透明附件句柄（见 `resolveAttachments`）——脚本只转交，不解释内容 */
  attach?: unknown
  /**
   * `'prose'`：带 `schema` 的一步跑完了却没调 `next` 时，**交回它的散文而不是抛
   * `next_not_called`**（散文为空仍抛）。给「有人在等答案、无形状的回答也胜过没有回答」
   * 的收尾步用；超时与被中止不在此列 —— 那是故障，照抛。
   */
  fallback?: unknown
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 错误上的机器可读归类；脚本自己 `throw` 的 / 非 Error 值没有 */
function errCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null | undefined)?.code
  return typeof code === 'string' && code ? code : undefined
}

/** 错误上挂着的派发步身份（`run()` 抛出的错才有） */
function errStep(err: unknown): WorkflowErrorStep | undefined {
  const step = (err as { step?: unknown } | null | undefined)?.step
  if (typeof step !== 'object' || step === null) return undefined
  const { index, agent } = step as { index?: unknown; agent?: unknown }
  return Number.isInteger(index) && typeof agent === 'string'
    ? { index: index as number, agent }
    : undefined
}

/**
 * 给 `run()` 里抛出的错挂上派发步身份。只挂在还没有的错上：错误对象一路原样上抛，
 * 脚本 catch 后 rethrow 的还是同一个对象，不会被更外层的 run 改写。
 */
function withStep(err: unknown, step: WorkflowErrorStep): unknown {
  if (typeof err === 'object' && err !== null && !('step' in err)) {
    ;(err as { step?: WorkflowErrorStep }).step = step
  }
  return err
}

/** run 级中止/超时的错误 —— 带 code，宿主据此区分「墙钟到了」与「有人按了停止」 */
function runStopError(reason: 'timeout' | 'aborted', maxDurationSec: number): Error {
  const err = new Error(
    reason === 'timeout'
      ? `workflow run timed out after ${maxDurationSec}s`
      : 'workflow run aborted'
  ) as Error & { code?: string }
  err.code = reason === 'timeout' ? 'run_timeout' : 'run_aborted'
  return err
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

  /** 一次运行的活状态 —— **唯一权威是 runId**，文件名只是它的一个属性 */
  interface WorkflowRun {
    runId: string
    workflowName: string
    source: 'builtin' | 'user'
    invocation: { kind: 'trigger'; trigger: string } | { kind: 'call'; label?: string }
    laneKey?: string
    sessionId?: string
    startedAt: number
    controller: AbortController
  }

  /** 一条分道：谁在跑 + 至多一个待跑槽 */
  interface Lane {
    active: Set<string>
    queued?: { plan: RunPlan; settle: (r: WorkflowInvokeResult) => void }
  }

  /** 起跑一次 run 所需的全部输入（fire 与 invoke 汇合成同一个形状） */
  interface RunPlan {
    entry: WorkflowRegistryEntry
    envelope: Record<string, unknown>
    invocation: { kind: 'trigger'; trigger: string } | { kind: 'call'; label?: string }
    laneKey?: string
    mode: WorkflowConcurrency
    sessionId?: string
    extraApi?: Record<string, unknown>
    externalSignal?: AbortSignal
    systemContext?: readonly string[]
  }

  const runs = new Map<string, WorkflowRun>()
  const lanes = new Map<string, Lane>()

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

  async function startRun(plan: RunPlan): Promise<WorkflowInvokeResult> {
    const { entry, envelope } = plan
    const file = entry.file
    const name = file.name
    const runId = `wfr-${uuid()}`
    const sessionId = plan.sessionId
    const limits = { ...DEFAULT_WORKFLOW_LIMITS, ...file.limits }
    const controller = new AbortController()
    const startedAt = Date.now()
    /**
     * 这一次 abort 是「限时到了」还是「有人喊停」—— 收尾文案据此分叉。
     * journal 与 invoke 的返回值不该对「用户点了停 / 会话删了 / 外部 signal 落下」
     * 撒谎说超时（默认限额 1800s 的文案配上几十毫秒的 run 尤其误导）。
     */
    let abortReason: 'aborted' | 'timeout' = 'aborted'

    // 同步段先占坑：忙道判定与本次启动之间无 await 窗口
    runs.set(runId, {
      runId,
      workflowName: name,
      source: entry.source,
      invocation: plan.invocation,
      laneKey: plan.laneKey,
      sessionId,
      startedAt,
      controller
    })
    if (plan.laneKey) {
      const lane = lanes.get(plan.laneKey) ?? { active: new Set<string>() }
      lane.active.add(runId)
      lanes.set(plan.laneKey, lane)
    }
    // 外部中止（会话 abort / per-bot 停止）级联进本 run
    const onExternalAbort = (): void => controller.abort()
    plan.externalSignal?.addEventListener('abort', onExternalAbort, { once: true })
    if (plan.externalSignal?.aborted) controller.abort()

    const record = (rec: Record<string, unknown>): void => {
      try {
        deps.onRecord?.(name, runId, rec)
      } catch {
        /* journal 失败不影响 run */
      }
    }

    // 占坑之后的**一切**都在同一个 try/finally 里：中间任何一步抛（例如不可 JSON 化的
    // payload 让 deepFreeze(jsonClone(envelope)) 炸）都不得让 run 与分道被永久占住 ——
    // fire 路径的 `void launch(...)` 还会把它变成一条无归属的 unhandled rejection
    let exec: Promise<unknown> | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let result: WorkflowInvokeResult
    try {
      record({
        type: 'meta',
        invocation: plan.invocation,
        source: entry.source,
        sessionId,
        lane: plan.laneKey,
        event: envelope
      })
      const how =
        plan.invocation.kind === 'trigger'
          ? `trigger=${plan.invocation.trigger}`
          : `call${plan.invocation.label ? `=${plan.invocation.label}` : ''}`
      logger?.info(`workflow "${name}" run=${runId} start ${how}`)

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
        if (controller.signal.aborted) throw runStopError('aborted', limits.maxDurationSec)
        if (typeof ref !== 'string' || !ref.trim()) {
          throw new Error('run(agent, prompt): agent ref must be a non-empty string')
        }
        if (typeof prompt !== 'string' || !prompt.trim()) {
          throw new Error('run(agent, prompt): prompt must be a non-empty string')
        }
        const schema = opts?.schema
        if (schema !== undefined) {
          const schemaError = validateContractSchema(schema)
          if (schemaError) throw new Error(`run(): ${schemaError}`)
        }
        const fallback = opts?.fallback
        if (fallback !== undefined && fallback !== 'prose') {
          throw new Error("run(): opts.fallback must be 'prose' when given")
        }
        if (opts?.tools !== undefined && !Array.isArray(opts.tools)) {
          throw new Error('run(): opts.tools must be a string array')
        }
        // 入参校验全部过了才占号：一次写错选项的调用是脚本的编程错误，不是一次派发，
        // 不该让后面的步号跳一格（步号是 errorStep.index，宿主拿它归因）
        if (++agentCount > limits.maxAgents) {
          throw new Error(`workflow agent limit reached (maxAgents=${limits.maxAgents})`)
        }
        // 本步的身份：第几次派发 + 派发的 agent。挂在这一步抛出的每个错上（`e.step`），
        // 随失败结果交回调用方 —— 宿主据此知道「坏在哪一段」，脚本不必为此 catch 后转述
        const step: WorkflowErrorStep = { index: agentCount - 1, agent: ref.trim() }
        await acquire()
        try {
          const profile = deps.resolveAgentProfile(ref.trim())
          if (!profile) {
            // 带 code：**配置错与「跑到一半挂了」是两回事** —— 前者重试永远不会好，而脚本
            // 此前只能落进通用 catch，对用户说「中途坏了」，把人指向错误的方向
            const unknownAgent = new Error(
              `unknown agent "${ref.trim()}" — the ref must name a configured agent definition`
            ) as Error & { code?: string }
            unknownAgent.code = 'unknown_agent'
            throw unknownAgent
          }
          step.agent = profile.name
          // opts.tools = 与档案白名单取交集（缺省 = 档案全量）：让一份通用 agent 在这一步
          // 只做窄任务，少给几个工具 = 少一点跑偏与噪声。**不是一道权限闸** —— 档案白名单
          // 不是权限集，agent 能做什么由策略引擎逐次判定，少给工具不改变其中任何一次判定。
          // 取交集而不是并集的理由是 md 的自洽：档案 body 是按它自己声明的工具清单写的，
          // 塞一个提示词里没提过的工具进去，等于让这份 md 描述的不是它自己（与 extraApi
          // 撞名拒装配同一条纪律）。
          // 两侧统一小写比较：mcp:/skill: 名的余部大小写保留在档案侧，收窄判定不因此漏配
          let tools = [...profile.tools]
          if (Array.isArray(opts?.tools)) {
            const allow = new Set(opts.tools.map((t) => String(t).toLowerCase()))
            tools = tools.filter((t) => allow.has(t.toLowerCase()))
          }
          const modelConfig = await deps.resolveRunModel({ sessionId })
          if (!modelConfig) {
            throw new Error(
              'no model available for this run — configure a session or default model'
            )
          }
          const description =
            typeof opts?.description === 'string' && opts.description.trim()
              ? opts.description.trim()
              : prompt.trim().split('\n')[0].slice(0, 40)
          const nudges = typeof opts?.nudges === 'number' ? opts.nudges : undefined

          // 本次派发的墙钟：与 run 级 deadline 取先到者。链在 run 的 controller 上，
          // 所以 run 超时/被中止时这一层也随之落下（无需各自监听）
          const stepController = new AbortController()
          // 这一步是怎么停的：超时 / run 级中止 / 都没有。**必须与「模型没调 next」分得开** ——
          // 三者在 manager 那里都表现为「没有 structured」，而脚本要据此做完全不同的事：
          // 超时与破损是故障（该出声或让位），被中止则是「有人赢了、或会话停了」（该安静退出）
          let stepStop: 'timeout' | 'aborted' | null = null
          const onRunAbort = (): void => {
            stepStop ??= 'aborted'
            stepController.abort()
          }
          controller.signal.addEventListener('abort', onRunAbort, { once: true })
          if (controller.signal.aborted) stepController.abort()
          // 附件**在计时开始之前**解析：读盘的耗时不该记到这一步的模型账上。解析失败也不
          // 让整个任务段挂掉 —— 少一张图的回答，好过没有回答
          let contextMessages: AgentMessage[] = []
          const attach = Array.isArray(opts?.attach) ? opts.attach : []
          if (attach.length && deps.resolveAttachments) {
            try {
              contextMessages = await deps.resolveAttachments(attach, sessionId)
            } catch (e) {
              record({ type: 'log', message: `attach failed: ${errText(e)}` })
            }
          } else if (attach.length) {
            record({ type: 'log', message: 'attach ignored: host has no attachment resolver' })
          }

          const stepTimeout =
            typeof opts?.timeoutSec === 'number' && opts.timeoutSec > 0
              ? setTimeout(() => {
                  stepStop ??= 'timeout'
                  stepController.abort()
                }, opts.timeoutSec * 1000)
              : undefined

          record({ type: 'step_start', agent: profile.name, description })
          const t0 = Date.now()
          try {
            const res = await deps.manager.runTask({
              // 会话域 run 挂到归属会话名下（工具/询问/日志/面板落位）；否则 runId 自成血缘根。
              // 后一支是**静默降级**，调用方漏传 sessionId 时会一路走到底：runId 不在登记簿里，
              // 于是会话授权（autoAllow / 已授予路径）恒空、工作区落到临时目录、ask 因会话不存在
              // 而 reject 成工具错误。方向全是更严，不构成绕过，但用户会看成「策略突然变严了」——
              // bot 路径（M3′）接上来时，漏传 sessionId 是最容易踩的那一脚
              parentSessionId: sessionId ?? runId,
              agentType: { ...profile, tools },
              prompt,
              description,
              modelConfig,
              parentAbortSignal: stepController.signal,
              ...(contextMessages.length ? { contextMessages } : {}),
              // 调用方随本次 invoke 固化的上下文块：这次 run 里每一段都带同一份
              ...(plan.systemContext?.length ? { systemContext: plan.systemContext } : {}),
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
            // **停在半路与有没有契约无关**：`timeoutSec` 是 `run()` 的独立选项，对一步无契约的
            // 派发同样成立。此前整段合成都关在 `schema !== undefined` 里，于是无契约的一步
            // 超时之后正常返回 —— 在脚本那里与「跑完了」长得一模一样，而笔记段正是这样一步：
            // 300s 墙钟到点会被当成归纳成功，检查点照常前进，那批材料就此埋掉。
            //
            // `structured === undefined` 是必要条件：模型赶在墙钟前一刻交了结果就是交了，
            // 不该因为随后定时器到点而把它作废
            if (stepStop && res.structured === undefined) {
              const stopped = new Error(
                `agent "${profile.name}" ${stepStop === 'timeout' ? 'timed out' : 'was aborted'} before finishing`
              ) as Error & { code?: string; finalText?: string }
              stopped.code = stepStop === 'timeout' ? 'step_timeout' : 'step_aborted'
              stopped.finalText = res.result
              throw stopped
            }
            if (schema !== undefined) {
              if (res.structured === undefined) {
                // 走到这里 `stepStop` 必为 null（超时与中止在上面已经抛掉），所以只剩一种：
                // 模型自己跑完了却没交结构化结果。
                //
                // `fallback: 'prose'`：这一步的散文就是结果 —— 给「有人在等答案」的收尾步，
                // 无形状的回答胜过没有回答；散文为空则没有可交的东西，照常按契约破损抛
                if (fallback === 'prose' && res.result.trim()) {
                  record({
                    type: 'log',
                    message: `agent "${profile.name}" finished without calling \`next\` — returning its prose instead (fallback: prose)`
                  })
                  return res.result
                }
                // 可编程失败（设计 §5.5）：脚本 catch 后可读 e.code / e.finalText 降级使用散文结果。
                // 用属性而非错误子类 —— 错误对象要跨脚本膜（vm realm），instanceof 不可靠。
                // 三种 code 对脚本的意味完全不同 —— 故障要出声或让位，被中止要安静退出，
                // 而这一种是契约破损
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
            clearTimeout(stepTimeout)
            controller.signal.removeEventListener('abort', onRunAbort)
          }
        } catch (err) {
          throw withStep(err, step)
        } finally {
          release()
        }
      }

      // ── 脚本 API（脚本可见的 global 面；出入参一律纯 JSON 值） ──
      const frozenEvent = deepFreeze(jsonClone(envelope))
      const frozenInput = deepFreeze(jsonClone((envelope as { input?: unknown }).input ?? {}))
      const frozenVars = deepFreeze(jsonClone(file.vars))
      const api: Record<string, unknown> = {
        event: frozenEvent,
        input: frozenInput,
        vars: frozenVars,
        schemas: deepFreeze(jsonClone(file.schemas)),
        /**
         * 取一份渲染好的提示词块（`md prompt=<name>`）。`extras` 并进渲染作用域 ——
         * 窗口切片这类一个表达式的事留在脚本里（`prompt('task', {window: …slice(-n)})`），
         * 比在模板里发明一套切片语法便宜得多。
         */
        prompt: (promptName: unknown, extras?: unknown): string => {
          const key = String(promptName ?? '')
          const template = file.prompts[key]
          if (template === undefined) {
            throw new Error(
              `prompt("${key}"): no such prompt block — add a \`\`\`md prompt=${key} block to this workflow`
            )
          }
          const scope: Record<string, unknown> = {
            ...(frozenInput as Record<string, unknown>),
            input: frozenInput,
            vars: frozenVars,
            event: frozenEvent,
            ...(extras && typeof extras === 'object' ? jsonClone(extras as object) : {})
          }
          // 块之间的 `{{>name}}` 引用在同一作用域里渲染（promptTemplate.ts）
          return renderPromptTemplate(template, scope, file.prompts)
        },
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
            // 已中止即刻拒绝：run 收尾后脚本还在脱手运行（node:vm 无法硬中断异步续体），
            // 少了这一条，`while (true) { await sleep(1000) }` 会在 run 记录为「已收尾」
            // 之后永远跑下去 —— run() 首行的同一条守卫，sleep 也要有
            if (controller.signal.aborted) {
              reject(runStopError('aborted', limits.maxDurationSec))
              return
            }
            const delay = Math.max(0, Number(ms) || 0)
            const timer = setTimeout(resolve, delay)
            controller.signal.addEventListener(
              'abort',
              () => {
                clearTimeout(timer)
                reject(runStopError('aborted', limits.maxDurationSec))
              },
              { once: true }
            )
          }),
        now: () => new Date().toISOString(),
        fail: (message: unknown): never => {
          throw new Error(String(message ?? 'workflow failed'))
        }
      }

      // ── 调用方随本次调用传进来的函数（fire 是广播、没有调用方，所以恒为空） ──
      // 它们由调用方在 invoke 之前造好，目标（bot 路径的那个会话、那个 bot）已经是闭包里
      // 的常量 —— 脚本调 say 时不传会话号，也没有那个参数位可传。这是 API 形状，不是
      // 作用域授权；被派发 agent 能做什么由策略引擎在执行期判定，与路径无关。
      for (const [fnName, fn] of Object.entries(plan.extraApi ?? {})) {
        // 名字不合法就当装配失败，而不是留一个脚本写不出来的 global —— 失败形态否则
        // 随宿主脚本引擎而异（AsyncFunction 抛语法错、node:vm 静默不可达）；
        // 与基础 API 同名则会让同一份 md 在不同调用路径下语义不同（脚本里的 run 被换掉）
        const nameError = !IDENTIFIER_RE.test(fnName)
          ? `extraApi "${fnName}" is not a valid identifier — a script cannot name it`
          : (BASE_API_NAMES as readonly string[]).includes(fnName)
            ? `extraApi "${fnName}" collides with the base script API`
            : null
        if (nameError) {
          record({ type: 'end', ok: false, ms: 0, error: nameError })
          logger?.error(`workflow "${name}" run=${runId}: ${nameError}`)
          // 销号交给 finally（早退路径与正常路径同一条收尾）
          return { runId, started: true, ok: false, error: nameError }
        }
        api[fnName] = fn
      }

      // ── 执行 + 墙钟限时（超时 abort 级联到脚本原语与全部在飞 agent） ──
      const deadlineMs = limits.maxDurationSec * 1000
      timer = setTimeout(() => {
        abortReason = 'timeout'
        controller.abort()
      }, deadlineMs)
      exec = deps.script.execute(file.script, api, {
        signal: controller.signal,
        timeoutMs: deadlineMs
      })
      // 无视脚本是否还挂着（node:vm 无法硬中断异步续体）：deadline 一到 run 即判超时收尾
      const output = await Promise.race([
        exec,
        new Promise<never>((_, reject) => {
          const rejectAborted = (): void => reject(runStopError(abortReason, limits.maxDurationSec))
          // **已 abort 的 signal 不会再派发 abort 事件** —— 少了这一条同步分支，
          // 「传入一个已 aborted 的 signal」会让这一路永不 reject、setTimeout 也因
          // 已 abort 而成空操作：整张墙钟安全网失效，run 与分道被永久占住
          if (controller.signal.aborted) rejectAborted()
          else controller.signal.addEventListener('abort', rejectAborted, { once: true })
        })
      ])
      record({ type: 'end', ok: true, ms: Date.now() - startedAt, output: jsonClone(output) })
      logger?.info(`workflow "${name}" run=${runId} ok (${Date.now() - startedAt}ms)`)
      result = { runId, started: true, ok: true, output: jsonClone(output) }
    } catch (err) {
      // 归类与出错的步随失败一起交回 —— 调用方（bot 宿主）据此选文案、记门控健康，
      // 脚本因此不必为了报告失败而 catch；journal 的 end 记录同样带上，排查时不用翻 log
      const code = errCode(err)
      const failedStep = errStep(err)
      const failure = {
        ...(code ? { errorCode: code } : {}),
        ...(failedStep ? { errorStep: failedStep } : {})
      }
      record({
        type: 'end',
        ok: false,
        ms: Date.now() - startedAt,
        error: errText(err),
        ...(code ? { code } : {}),
        ...(failedStep ? { step: failedStep } : {})
      })
      logger?.warn(`workflow "${name}" run=${runId} failed: ${errText(err)}`)
      result = { runId, started: true, ok: false, error: errText(err), ...failure }
    } finally {
      // race 输掉/超时后脚本稍后才 settle 时不留 unhandled rejection
      exec?.catch(() => {})
      clearTimeout(timer)
      controller.abort()
      plan.externalSignal?.removeEventListener('abort', onExternalAbort)
      finish()
    }
    return result

    /** 从 runs / lane 里销号，并拉起本分道待跑槽里的那一个 */
    function finish(): void {
      runs.delete(runId)
      if (!plan.laneKey) return
      const lane = lanes.get(plan.laneKey)
      if (!lane) return
      lane.active.delete(runId)
      if (lane.active.size > 0) return
      const next = lane.queued
      if (next) {
        lane.queued = undefined
        void startRun(next.plan).then(next.settle, (err) =>
          next.settle({ started: true, ok: false, error: errText(err) })
        )
        return
      }
      // 空道即删条目 —— bot 路径的键含 sessionId+botName，留 0 值条目会真的长起来
      lanes.delete(plan.laneKey)
    }
  }

  /** 忙道判定 → 起跑 / 丢弃 / 入槽。返回值即 invoke 的结果（fire 不看） */
  function launch(plan: RunPlan): Promise<WorkflowInvokeResult> {
    const name = plan.entry.file.name
    const lane = plan.laneKey ? lanes.get(plan.laneKey) : undefined
    const busy = (lane?.active.size ?? 0) > 0
    if (!busy) return startRun(plan)

    if (plan.mode === 'skip') {
      logger?.info(`workflow "${name}": lane busy — skipped`)
      return Promise.resolve({ started: false, reason: 'skipped' })
    }
    if (plan.mode === 'queue') {
      // 待跑槽容量恒为 1：新调用顶掉旧的（高频埋点上无界积压只会让迟到的 run
      // 拿着过期的信封挨个空跑，最后一个事件才是现状）
      const prev = lane!.queued
      if (prev) prev.settle({ started: false, reason: 'superseded' })
      logger?.info(`workflow "${name}": lane busy — queued (slot of 1)`)
      return new Promise<WorkflowInvokeResult>((resolve) => {
        lane!.queued = { plan, settle: resolve }
      })
    }
    // parallel：分道不阻断
    return startRun(plan)
  }

  return {
    fire(id, payload): void {
      try {
        const def = TRIGGER_POINTS[id]
        if (!def) return
        // 信封 = payload + 保留键：trigger（埋点 id）与 chain（触发链占位，恒空数组）
        const envelope: Record<string, unknown> = { ...payload, trigger: id, chain: [] }
        const sessionId =
          def.scope === 'session' ? (envelope as { sessionId?: string }).sessionId : undefined
        for (const entry of safeList()) {
          // 同一埋点的多条绑定：命中一条即起一个 run（不重复起）
          const binding = entry.file.bindings.find(
            (b) => b.trigger === id && whenHit(entry, b.when, envelope)
          )
          if (!binding) continue
          // fire 是广播、不回传结果 —— 但 launch 的失败仍要落到日志，
          // 不能变成一条无归属的 unhandled rejection（Electron 主进程里尤其难查）
          void launch({
            entry,
            envelope,
            invocation: { kind: 'trigger', trigger: id },
            laneKey: workflowLaneKey(
              entry.file.name,
              triggerLaneKey(entry, binding.key, envelope, def)
            ),
            mode: entry.file.concurrency,
            sessionId
          }).catch((err) =>
            logger?.warn(`workflow "${entry.file.name}": run failed to start — ${errText(err)}`)
          )
        }
      } catch (err) {
        logger?.warn(`workflow fire(${String(id)}) failed: ${errText(err)}`)
      }
    },

    async invoke(req): Promise<WorkflowInvokeResult> {
      try {
        // 刻意不走 safeList()：它为 fire 而设（注册表读不出来就当没人订阅，绝不抛）。
        // 定向调用有个等着答案的调用方，「扫描失败」与「没这个名字」必须分得开 ——
        // 否则用户会看到一句指错方向的「工作流不存在」
        const entry = deps.listWorkflows().find((e) => e.file.name === req.workflow)
        if (!entry) {
          logger?.warn(`workflow invoke("${req.workflow}"): no such workflow`)
          return { started: false, reason: 'not-found' }
        }
        // 「没传 input」归一为 `{}` **一次**，校验与信封读同一个值 —— 两边各归一各的，
        // 会让「声明了 input schema 但 required 为空」的工作流 invoke({workflow}) 被拒、
        // invoke({workflow, input:{}}) 通过（显式传 null 仍是入参错误，不是「没传」）
        const input = req.input === undefined ? {} : req.input
        const inputError = checkInput(entry.file, input)
        if (inputError) {
          logger?.warn(`workflow invoke("${req.workflow}"): ${inputError}`)
          return { started: false, reason: 'invalid-input', error: inputError }
        }
        // 信封形状与 fire 一致，只是 trigger 位写 'call' —— 脚本读 event 时不必分路径
        const envelope: Record<string, unknown> = { trigger: 'call', chain: [], input }
        return await launch({
          entry,
          envelope,
          invocation: { kind: 'call', label: req.label },
          laneKey: req.reentry?.key ? workflowLaneKey(entry.file.name, req.reentry.key) : undefined,
          mode: req.reentry?.mode ?? entry.file.concurrency,
          sessionId: req.sessionId,
          extraApi: req.extraApi,
          externalSignal: req.signal,
          systemContext: req.systemContext
        })
      } catch (err) {
        logger?.warn(`workflow invoke("${req.workflow}") failed: ${errText(err)}`)
        return { started: false, reason: 'error', error: errText(err) }
      }
    },

    listRuns(): WorkflowRunSnapshot[] {
      return [...runs.values()].map(({ controller: _controller, ...snapshot }) => snapshot)
    },

    abortRun(runId): boolean {
      const run = runs.get(runId)
      if (!run) return false
      run.controller.abort()
      return true
    },

    abortLane(laneKey): number {
      const lane = lanes.get(laneKey)
      if (!lane) return 0
      // 先清待跑槽：否则排空逻辑会在最后一个 active 落下时把它拉起来
      const queued = lane.queued
      if (queued) {
        lane.queued = undefined
        queued.settle({ started: false, reason: 'superseded' })
      }
      let n = queued ? 1 : 0
      for (const runId of [...lane.active]) {
        runs.get(runId)?.controller.abort()
        n++
      }
      return n
    },

    abortSession(sessionId): number {
      let n = 0
      // 先作废该会话的待跑槽：否则被中止的 run 收尾时排空逻辑会把它拉起来 ——
      // 「会话刚被中止/删除，引擎又给它起了一个新 run」（还带着已删会话的
      // parentSessionId 去派发 agent）。顺序与 abortLane 一致
      for (const lane of lanes.values()) {
        const queued = lane.queued
        if (!queued || queued.plan.sessionId !== sessionId) continue
        lane.queued = undefined
        queued.settle({ started: false, reason: 'superseded' })
        n++
      }
      for (const run of runs.values()) {
        if (run.sessionId !== sessionId) continue
        run.controller.abort()
        n++
      }
      return n
    },

    runningCount(): number {
      return runs.size
    },

    laneCount(): number {
      return lanes.size
    }
  }

  /**
   * 埋点路径的分道键：绑定写了 `key` 就按它的 CEL 求值，否则由埋点 scope 推导 ——
   * 会话域埋点天然按会话分道（两个会话同时轮结束不该互相 skip），其余全局一条道
   * （= 引入分道之前的行为）。
   *
   * 求值失败 fail-safe 到缺省键而不是「不互斥」：键算错时宁可更强的互斥，
   * 也不给一个来路不明的触发发一张并发许可。
   */
  function triggerLaneKey(
    entry: WorkflowRegistryEntry,
    key: string | undefined,
    envelope: Record<string, unknown>,
    def: { scope?: 'session' }
  ): string {
    const fallback =
      def.scope === 'session' ? String((envelope as { sessionId?: string }).sessionId ?? '*') : '*'
    if (!key) return fallback
    try {
      return evaluateLaneKey(key, { event: envelope, vars: entry.file.vars, env: deps.env })
    } catch (err) {
      logger?.warn(
        `workflow "${entry.file.name}": lane key evaluation failed — ${errText(err)}; using the default lane`
      )
      return fallback
    }
  }

  /**
   * invoke 入参的浅校验 —— 只看 `shuvix-workflow-input` 的 `type: object` 与 `required`，
   * 并沿 `properties` 里同样声明为 `type: object` 的子对象递归下去（bot 管线的
   * `agents` 槽位表就是这样一个子对象：哪些槽位必填由管线说了算，漏填在这里被拦下）。
   * 其余 JSON Schema 校验刻意不做：入参来自宿主自己的代码（不是模型输出），
   * 而 required 恰好挡住「换了个调用方、少传一个字段」这类真实错误。
   */
  function checkInput(file: ParsedWorkflowFile, input: unknown): string | null {
    const schema = file.inputSchema
    if (!schema) return null
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return 'input must be an object (this workflow declares shuvix-workflow-input)'
    }
    return checkRequired(schema, input as Record<string, unknown>, '')
  }

  function checkRequired(
    schema: Record<string, unknown>,
    value: Record<string, unknown>,
    path: string
  ): string | null {
    const required = Array.isArray(schema.required) ? schema.required : []
    const missing = required.filter((k) => !(String(k) in value))
    if (missing.length) {
      const names = missing.map((k) => `${path}${String(k)}`).join(', ')
      return `input is missing required field(s): ${names}`
    }
    const properties = schema.properties
    if (typeof properties !== 'object' || properties === null) return null
    for (const [key, sub] of Object.entries(properties as Record<string, unknown>)) {
      if (typeof sub !== 'object' || sub === null || (sub as { type?: unknown }).type !== 'object')
        continue
      const child = value[key]
      // 缺席且非必填：上面没拦，这里也不下钻（可选子对象整体省略是合法的）
      if (child === undefined) continue
      if (typeof child !== 'object' || child === null || Array.isArray(child)) {
        return `input.${path}${key} must be an object`
      }
      const err = checkRequired(
        sub as Record<string, unknown>,
        child as Record<string, unknown>,
        `${path}${key}.`
      )
      if (err) return err
    }
    return null
  }
}
