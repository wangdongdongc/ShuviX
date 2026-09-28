/**
 * Hook runner（宿主无关核心）—— 埋点匹配 + 派发一个 agent，没有别的。
 *
 * 职责边界（docs/hook-design.md）：
 *  - `fire(id, payload)` 是广播：按埋点 id 匹配每份 hook 的绑定、CEL `when` 命中即派发，
 *    **绝不抛出**，emit 侧对订阅情况零感知；
 *  - 一次 run = 一次 `manager.runTask`：hook 的正文 + 事件围栏是任务，agent 用自己的工具做事，
 *    **结果文本不读**（只看 `outcome.error` 判这次派发成没成）—— hook 是观察者，不拦截、不改 prompt、不等它；
 *  - 派发与 dispatch 工具走完全同一条创建与执行路径：同一个 runTask → createAgent → 宿主
 *    resolveTools → 同一个安全门。hook 不构成第二套安全机制，也不参与选模型
 *    （基准是归属会话的当前模型，被派发 agent 自己的 `shuvix-model` 优先，与任何派发一样）；
 *  - 会话域埋点：payload.sessionId 即 run 的归属会话（工具/询问/LLM 日志/面板都落到它）。
 *    v1 只在会话域埋点上运行 —— 没有归属会话的 run 授权为空、询问被拒，那是静默降级，宁可不跑。
 *
 * 宿主规则（不是文件里的键，用户改不了，所以也不是要维护的契约）：
 *  - 去重：同一 hook 在同一会话上的上一次还没跑完，本次跳过并记日志；
 *  - 超时：`timeoutMs`（缺省 5 分钟）到点中止本次派发；
 *  - 未知 agent / 无可用模型：跳过并记日志（配置错，重试永远不会好，不算一次失败的 run）。
 *
 * 刻意没有的：触发链防风暴。hook 派发的是进程内派生 agent，它不经 AgentSession、不发会话埋点；
 * 它能碰到别的会话埋点只有一条路 —— 用 `session` 工具开子会话，而子会话只许一层，子会话名下
 * 的 hook agent 再也开不出会话。链的深度由这条既有约束封死，不需要 runner 再记一份 chain。
 *
 * **判定型埋点**（`decide`，2026-09-28）：上面说的「结果不读」只对观察型成立。判定型埋点只出现在
 * 宿主已经决定「这里需要一个判断」的地方（今天只有 `permission.request`：策略判出 ask、弹卡片之前），
 * hook 回答「谁来判断」：
 *  - 派发时带上该埋点的结果契约（DECIDE_SPECS 的 schema → `next` 工具），结论取捕获值；
 *  - 命中的 hook 全部并行，**不做去重**（每次判断各是一次，同一会话里两条并行的命令各审各的）；
 *  - 超时缺省 60 秒（`decideTimeoutMs`），从进入这个 hook 算起、模型解析也在内 —— 调用方正挂在一次
 *    工具调用上等，哪一段挂住都不能让它跟着挂住；
 *  - 超时、中止、派发失败、没给出合格结论 = 这个 hook「没有意见」；全都没有意见返回 null，
 *    调用方照旧问人。多个结论取最严的那个（DecideSpec.severity）。
 * 它仍然不是第二套安全机制：deny / 强制询问 / 用户明示同意都在策略引擎里先结算完，轮不到 hook。
 */
import { v4 as uuid } from 'uuid'
import type { SubAgentManager } from '../subagent/manager'
import type { InProcessAgentType, SubAgentModelConfig } from '../subagent/types'
import type { RuntimeLogger } from '../types'
import {
  DECIDE_SPECS,
  TRIGGER_POINTS,
  type DecideSpec,
  type DecideTriggerId,
  type ObserveTriggerId,
  type TriggerPayloadMap,
  type TriggerResultMap
} from './triggerPoints'
import { evaluateWhen } from './when'
import { renderHookPrompt } from './hookPrompt'
import type { ParsedHookFile } from './hookFile'

/** 一次派发的墙钟上限缺省值 */
export const DEFAULT_HOOK_TIMEOUT_MS = 5 * 60 * 1000

/** 判定型派发的墙钟上限缺省值 —— 调用方正挂在一次工具调用上等结论 */
export const DEFAULT_DECIDE_TIMEOUT_MS = 60 * 1000

/** 注册表条目 —— 宿主 listHooks() 现算（builtin + 用户覆盖合并后的生效集） */
export interface HookRegistryEntry {
  file: ParsedHookFile
  source: 'builtin' | 'user'
}

/** 一次运行的只读信息（日志 / 监控 / 测试） */
export interface HookRunInfo {
  runId: string
  hook: string
  source: 'builtin' | 'user'
  trigger: string
  sessionId: string
  agent: string
  startedAt: number
}

export type HookSkipReason = 'busy' | 'unknown-agent' | 'no-model'

/** run 生命周期事件 —— 宿主据此记日志；测试据此观测 */
export type HookRunEvent =
  | { type: 'start'; run: HookRunInfo }
  | {
      type: 'end'
      run: HookRunInfo
      ok: boolean
      ms: number
      error?: string
      /** 仅判定型：这个 hook 给出的结论（观察型的结果从不读，这里恒缺） */
      result?: unknown
    }
  | {
      type: 'skip'
      hook: string
      trigger: string
      sessionId: string
      reason: HookSkipReason
      detail?: string
    }

export interface HookRunnerDeps {
  manager: Pick<SubAgentManager, 'runTask'>
  /** 每次 fire 现算的生效集（语言/用户文件变化自动跟随，同 agentService 口径） */
  listHooks: () => HookRegistryEntry[]
  /** 按名解析 agent 档案（运行投影）；未知返回 null */
  resolveAgentProfile: (name: string) => InProcessAgentType | null
  /** 归属会话的当前模型；没有可用模型返回 null（本次派发跳过） */
  resolveRunModel: (ctx: { sessionId: string }) => Promise<SubAgentModelConfig | null>
  /** CEL `when` 的 env 上下文 */
  env: { host: string; platform: string }
  /** 一次派发的墙钟上限；缺省 DEFAULT_HOOK_TIMEOUT_MS */
  timeoutMs?: number
  /** 一次判定型派发的墙钟上限；缺省 DEFAULT_DECIDE_TIMEOUT_MS */
  decideTimeoutMs?: number
  onRun?: (event: HookRunEvent) => void
  logger?: RuntimeLogger
}

/** 判定型埋点的合并结论 */
export interface HookDecision<R> {
  /** 最严的那个结论 */
  result: R
  /** 给出它的 hook 名 */
  hook: string
}

export interface HookRunner {
  /** 观察型埋点入口 —— payload 形状按 id 收窄（TriggerPayloadMap）。绝不抛出。 */
  fire<K extends ObserveTriggerId>(id: K, payload: TriggerPayloadMap[K]): void
  /**
   * 判定型埋点入口：等所有命中的 hook 给出结论，返回最严的那个；没有 hook 命中、或都没有意见
   * （超时 / 中止 / 失败 / 没给合格结论）返回 null。`signal` 落下即中止全部在跑的判定并返回 null。
   * 绝不抛出、绝不 reject。
   */
  decide<K extends DecideTriggerId>(
    id: K,
    payload: TriggerPayloadMap[K],
    opts?: { signal?: AbortSignal }
  ): Promise<HookDecision<TriggerResultMap[K]> | null>
  /** 中止某会话名下的全部 run，返回中止数 */
  abortSession(sessionId: string): number
  /** 在跑的 run（监控/测试用） */
  listRuns(): HookRunInfo[]
  runningCount(): number
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 超时文案：≥1s 给秒数（1500 → `1.5s`），不足一秒（测试里的小超时）给毫秒，绝不写成 `0s` */
function formatSeconds(ms: number): string {
  return ms >= 1000 ? `${ms / 1000}s` : `${ms}ms`
}

/** 去重键 —— 同一 hook × 同一会话至多一次在跑 */
function laneKey(hookName: string, sessionId: string): string {
  return `${hookName}\u0000${sessionId}`
}

export function createHookRunner(deps: HookRunnerDeps): HookRunner {
  const logger = deps.logger
  const timeoutMs = deps.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS
  const decideTimeoutMs = deps.decideTimeoutMs ?? DEFAULT_DECIDE_TIMEOUT_MS

  interface ActiveRun {
    info: HookRunInfo
    controller: AbortController
  }
  const active = new Map<string, ActiveRun>()

  const emit = (event: HookRunEvent): void => {
    try {
      deps.onRun?.(event)
    } catch {
      /* 观测回调失败不影响 run */
    }
  }

  function safeList(): HookRegistryEntry[] {
    try {
      return deps.listHooks()
    } catch (err) {
      logger?.warn(`hook registry listing failed: ${errText(err)}`)
      return []
    }
  }

  function whenHit(
    entry: HookRegistryEntry,
    when: string | undefined,
    event: Record<string, unknown>
  ): boolean {
    if (!when) return true
    try {
      return evaluateWhen(when, { event, env: deps.env })
    } catch (err) {
      // strict fail-safe：求值错误（含访问 payload 缺失属性）按不命中处理 —— 宁漏勿误发
      logger?.warn(`hook "${entry.file.name}": when evaluation failed — ${errText(err)}`)
      return false
    }
  }

  async function launch(
    entry: HookRegistryEntry,
    trigger: string,
    payload: Record<string, unknown>,
    sessionId: string
  ): Promise<void> {
    const { file } = entry
    const skip = (reason: HookSkipReason, detail?: string): void => {
      logger?.info(
        `hook "${file.name}" skipped for session ${sessionId}: ${reason}${detail ? ` (${detail})` : ''}`
      )
      emit({ type: 'skip', hook: file.name, trigger, sessionId, reason, detail })
    }

    const key = laneKey(file.name, sessionId)
    if (active.has(key)) {
      skip('busy', 'previous run still going')
      return
    }
    const profile = deps.resolveAgentProfile(file.agent)
    if (!profile) {
      skip('unknown-agent', `no agent definition named "${file.agent}"`)
      return
    }

    // 同步段先占坑：去重判定与本次启动之间无 await 窗口
    const controller = new AbortController()
    const info: HookRunInfo = {
      runId: `hkr-${uuid()}`,
      hook: file.name,
      source: entry.source,
      trigger,
      sessionId,
      agent: profile.name,
      startedAt: Date.now()
    }
    active.set(key, { info, controller })
    let timer: ReturnType<typeof setTimeout> | undefined
    let timedOut = false
    try {
      // 模型解析失败与「没有模型」同一处置：都是配置问题，重试永远不会好 —— 记成 skip，
      // 而不是一次没有 start 就 end 的失败 run
      let modelConfig: SubAgentModelConfig | null
      try {
        modelConfig = await deps.resolveRunModel({ sessionId })
      } catch (err) {
        skip('no-model', `model resolution failed: ${errText(err)}`)
        return
      }
      if (!modelConfig) {
        skip('no-model', 'no model available for this session')
        return
      }
      emit({ type: 'start', run: info })
      logger?.info(
        `hook "${file.name}" run=${info.runId} start trigger=${trigger} session=${sessionId} agent=${profile.name}`
      )
      timer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, timeoutMs)
      const outcome = await deps.manager.runTask({
        parentSessionId: sessionId,
        agentType: profile,
        prompt: renderHookPrompt(file.prompt, trigger, payload),
        description: file.displayName,
        modelConfig,
        parentAbortSignal: controller.signal
      })
      const ms = Date.now() - info.startedAt
      if (timedOut) {
        const error = `timed out after ${formatSeconds(timeoutMs)}`
        logger?.warn(`hook "${file.name}" run=${info.runId} ${error}`)
        emit({ type: 'end', run: info, ok: false, ms, error })
      } else if (controller.signal.aborted) {
        logger?.info(`hook "${file.name}" run=${info.runId} aborted`)
        emit({ type: 'end', run: info, ok: false, ms, error: 'aborted' })
      } else if (outcome.error) {
        // 派发出去的 agent 自己失败了（最常见：模型调用报错）—— runTask 照常 resolve，失败只在 outcome.error 上
        logger?.warn(`hook "${file.name}" run=${info.runId} failed: ${outcome.error}`)
        emit({ type: 'end', run: info, ok: false, ms, error: outcome.error })
      } else {
        logger?.info(`hook "${file.name}" run=${info.runId} ok (${ms}ms)`)
        emit({ type: 'end', run: info, ok: true, ms })
      }
    } catch (err) {
      const ms = Date.now() - info.startedAt
      logger?.warn(`hook "${file.name}" run=${info.runId} failed: ${errText(err)}`)
      emit({ type: 'end', run: info, ok: false, ms, error: errText(err) })
    } finally {
      clearTimeout(timer)
      active.delete(key)
    }
  }

  /**
   * 一次判定型派发：返回这个 hook 的结论，没有意见（跳过 / 超时 / 中止 / 失败 / 结论不合格）返回 null。
   * 与 launch 的差别只在宿主规则：不去重（坑位按 runId 占，只为 abortSession / listRuns 可见）、
   * 超时更短、派发带结果契约、结论要读。
   *
   * **超时与中止不等派发收尾**：调用方正挂在一次工具调用上，而派发链路未必立刻响应中止（模型请求可能
   * 还在路上），所以计时器 / 外部 signal / abortSession 一落下，这个 hook 当场按「没有意见」结算；
   * 派发在后台收尾，收尾前仍占着坑位（abortSession / listRuns 照样看得见），它的结果不再有人读。
   * 模型解析同理：计时从这里起，解析与中止赛跑 —— 解析挂住不会拖住调用方，也就不会有 start / end。
   */
  async function launchDecide<R>(
    entry: HookRegistryEntry,
    trigger: string,
    payload: Record<string, unknown>,
    sessionId: string,
    spec: DecideSpec<R>,
    outer: AbortSignal | undefined
  ): Promise<{ result: R; hook: string } | null> {
    const { file } = entry
    const skip = (reason: HookSkipReason, detail?: string): void => {
      logger?.info(
        `hook "${file.name}" skipped for session ${sessionId}: ${reason}${detail ? ` (${detail})` : ''}`
      )
      emit({ type: 'skip', hook: file.name, trigger, sessionId, reason, detail })
    }

    const profile = deps.resolveAgentProfile(file.agent)
    if (!profile) {
      skip('unknown-agent', `no agent definition named "${file.agent}"`)
      return null
    }

    const controller = new AbortController()
    const info: HookRunInfo = {
      runId: `hkr-${uuid()}`,
      hook: file.name,
      source: entry.source,
      trigger,
      sessionId,
      agent: profile.name,
      startedAt: Date.now()
    }
    active.set(info.runId, { info, controller })
    const onOuterAbort = (): void => controller.abort()
    if (outer?.aborted) controller.abort()
    else outer?.addEventListener('abort', onOuterAbort, { once: true })
    // 中止落下的那一刻（外部 signal / 超时 / abortSession）—— 与派发赛跑用
    const abortedNow = new Promise<null>((resolve) => {
      if (controller.signal.aborted) resolve(null)
      else controller.signal.addEventListener('abort', () => resolve(null), { once: true })
    })

    // 计时从进入这个 hook 算起：模型解析也在调用方的等待里
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, decideTimeoutMs)
    // 已经按「没有意见」结算、但派发还在后台收尾：坑位留到它落定
    let draining: Promise<unknown> | null = null
    try {
      let modelConfig: SubAgentModelConfig | null
      try {
        // 解析与中止赛跑：解析挂住（或慢过超时）不拖住调用方。输掉赛跑的那一边由 race 自己兜住
        const resolved = await Promise.race([
          Promise.resolve()
            .then(() => deps.resolveRunModel({ sessionId }))
            .then((config) => ({ config })),
          abortedNow
        ])
        modelConfig = resolved === null ? null : resolved.config
        if (resolved === null || controller.signal.aborted) {
          if (timedOut) {
            logger?.warn(
              `hook "${file.name}" timed out before start (session ${sessionId}, ${formatSeconds(decideTimeoutMs)})`
            )
          } else {
            logger?.info(`hook "${file.name}" aborted before start (session ${sessionId})`)
          }
          return null
        }
      } catch (err) {
        skip('no-model', `model resolution failed: ${errText(err)}`)
        return null
      }
      if (!modelConfig) {
        skip('no-model', 'no model available for this session')
        return null
      }
      emit({ type: 'start', run: info })
      logger?.info(
        `hook "${file.name}" run=${info.runId} start trigger=${trigger} session=${sessionId} agent=${profile.name}`
      )
      const run = deps.manager.runTask({
        parentSessionId: sessionId,
        agentType: profile,
        prompt: renderHookPrompt(file.prompt, trigger, payload),
        description: file.displayName,
        modelConfig,
        parentAbortSignal: controller.signal,
        resultContract: { schema: spec.schema, sourceLabel: file.name }
      })
      const raced = await Promise.race([run.then((outcome) => ({ outcome })), abortedNow])
      const ms = Date.now() - info.startedAt
      // error 与观察型同一口径：原话；日志里失败带 `failed:`，超时 / 中止不带
      const fail = (error: string, log: 'failed' | 'warn' | 'info'): null => {
        if (log === 'failed') logger?.warn(`hook "${file.name}" run=${info.runId} failed: ${error}`)
        else if (log === 'warn') logger?.warn(`hook "${file.name}" run=${info.runId} ${error}`)
        else logger?.info(`hook "${file.name}" run=${info.runId} ${error}`)
        emit({ type: 'end', run: info, ok: false, ms, error })
        return null
      }
      if (raced === null) {
        draining = run.catch(() => undefined)
        return timedOut
          ? fail(`timed out after ${formatSeconds(decideTimeoutMs)}`, 'warn')
          : fail('aborted', 'info')
      }
      const { outcome } = raced
      if (outcome.error) return fail(outcome.error, 'failed')
      const result = spec.parse(outcome.structured)
      if (result === null) return fail('no valid result', 'failed')
      logger?.info(`hook "${file.name}" run=${info.runId} ok (${ms}ms)`)
      emit({ type: 'end', run: info, ok: true, ms, result })
      return { result, hook: file.name }
    } catch (err) {
      const ms = Date.now() - info.startedAt
      logger?.warn(`hook "${file.name}" run=${info.runId} failed: ${errText(err)}`)
      emit({ type: 'end', run: info, ok: false, ms, error: errText(err) })
      return null
    } finally {
      clearTimeout(timer)
      outer?.removeEventListener('abort', onOuterAbort)
      if (draining) void draining.finally(() => active.delete(info.runId))
      else active.delete(info.runId)
    }
  }

  return {
    fire(id, payload): void {
      try {
        const def = TRIGGER_POINTS[id]
        if (!def) return
        if (def.kind === 'decide') {
          // 类型上已拦住；绕过类型的调用只记一笔，不派发 —— 判定型的结论没人等就是白花
          logger?.warn(
            `hook fire(${String(id)}): a decide trigger goes through decide(), not fire()`
          )
          return
        }
        const sessionId =
          def.scope === 'session' ? (payload as { sessionId?: unknown }).sessionId : undefined
        if (typeof sessionId !== 'string' || !sessionId) {
          logger?.warn(
            `hook fire(${String(id)}): no session context — hooks v1 run only under a session`
          )
          return
        }
        const event: Record<string, unknown> = { ...payload, trigger: id }
        for (const entry of safeList()) {
          // 同一埋点的多条绑定：命中一条即起一个 run（不重复起）
          const binding = entry.file.bindings.find(
            (b) => b.trigger === id && whenHit(entry, b.when, event)
          )
          if (!binding) continue
          // fire 是广播、不回传结果 —— 但启动失败仍要落到日志，不能变成无归属的 unhandled rejection
          void launch(entry, id, { ...payload }, sessionId).catch((err) =>
            logger?.warn(`hook "${entry.file.name}": run failed to start — ${errText(err)}`)
          )
        }
      } catch (err) {
        logger?.warn(`hook fire(${String(id)}) failed: ${errText(err)}`)
      }
    },

    async decide(id, payload, opts = {}) {
      try {
        const def = TRIGGER_POINTS[id]
        const spec = DECIDE_SPECS[id] as DecideSpec<TriggerResultMap[typeof id]> | undefined
        if (!def || def.kind !== 'decide' || !spec) {
          // 类型上已拦住；绕过类型的调用只记一笔（与 fire 收到判定型埋点对称）
          logger?.warn(`hook decide(${String(id)}): not a decide trigger`)
          return null
        }
        const sessionId = (payload as { sessionId?: unknown } | null | undefined)?.sessionId
        if (typeof sessionId !== 'string' || !sessionId) {
          logger?.warn(
            `hook decide(${String(id)}): no session context — hooks run only under a session`
          )
          return null
        }
        if (opts.signal?.aborted) return null
        // 在入口深拷贝一份：payload 有嵌套字段，而围栏在 await 模型解析之后才渲染 —— 调用方之后
        // 原地改了哪一层，CEL 看到的与 agent 读到的都还是调用那一刻的值（interface 没有隐式索引签名，
        // CEL 与围栏只把它当一份普通文档读）
        const fields = structuredClone(payload) as unknown as Record<string, unknown>
        const event: Record<string, unknown> = { ...fields, trigger: id }
        const matched = safeList().filter((entry) =>
          entry.file.bindings.some((b) => b.trigger === id && whenHit(entry, b.when, event))
        )
        if (matched.length === 0) return null
        const verdicts = await Promise.all(
          matched.map((entry) =>
            launchDecide(entry, id, { ...fields }, sessionId, spec, opts.signal).catch((err) => {
              logger?.warn(
                `hook "${entry.file.name}": decide run failed to start — ${errText(err)}`
              )
              return null
            })
          )
        )
        // 中止的那一刻起结论就不再有人要：即使某个 run 恰好在中止前交了卷，也按没有意见处理
        if (opts.signal?.aborted) return null
        let best: { result: TriggerResultMap[typeof id]; hook: string } | null = null
        for (const verdict of verdicts) {
          if (!verdict) continue
          if (!best || spec.severity(verdict.result) > spec.severity(best.result)) best = verdict
        }
        return best
      } catch (err) {
        logger?.warn(`hook decide(${String(id)}) failed: ${errText(err)}`)
        return null
      }
    },

    abortSession(sessionId): number {
      let n = 0
      for (const run of active.values()) {
        if (run.info.sessionId !== sessionId) continue
        run.controller.abort()
        n++
      }
      return n
    },

    listRuns(): HookRunInfo[] {
      return [...active.values()].map((run) => ({ ...run.info }))
    },

    runningCount(): number {
      return active.size
    }
  }
}
