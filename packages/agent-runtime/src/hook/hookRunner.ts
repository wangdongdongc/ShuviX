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
 */
import { v4 as uuid } from 'uuid'
import type { SubAgentManager } from '../subagent/manager'
import type { InProcessAgentType, SubAgentModelConfig } from '../subagent/types'
import type { RuntimeLogger } from '../types'
import { TRIGGER_POINTS, type TriggerId, type TriggerPayloadMap } from './triggerPoints'
import { evaluateWhen } from './when'
import { renderHookPrompt } from './hookPrompt'
import type { ParsedHookFile } from './hookFile'

/** 一次派发的墙钟上限缺省值 */
export const DEFAULT_HOOK_TIMEOUT_MS = 5 * 60 * 1000

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
  | { type: 'end'; run: HookRunInfo; ok: boolean; ms: number; error?: string }
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
  onRun?: (event: HookRunEvent) => void
  logger?: RuntimeLogger
}

export interface HookRunner {
  /** 业务埋点入口 —— payload 形状按 id 收窄（TriggerPayloadMap）。绝不抛出。 */
  fire<K extends TriggerId>(id: K, payload: TriggerPayloadMap[K]): void
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

  return {
    fire(id, payload): void {
      try {
        const def = TRIGGER_POINTS[id]
        if (!def) return
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
