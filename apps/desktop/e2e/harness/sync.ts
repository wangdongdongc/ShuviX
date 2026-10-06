/**
 * 视图同步的 e2e 探针（P3-15a 的一半，随 P3-08 落地）—— spec 进程里读一条会话「现在长什么样」。
 *
 * 会话内容不再走 ChatEvent（P3-08）：消息、流式卡、工具进度、询问都在会话视图（`SessionView`）里，经
 * `window.api.sync` 同步。探针在 spec 进程（node）里跑一个**真的** chord 客户端（agent-runtime 的
 * `TestClient`，浏览器安全，node 里照样跑）：
 *  - 调用：`window.api.sync.invoke(target, call)` 经 CDP `eval` 在页面里发，回复原样带回；
 *  - 帧：页面侧装一个 `window.api.sync.onFrame` 监听，把**探针自己订阅**（id 前缀 `e2e#`）的帧攒进
 *    `window.__e2eSyncFrames`；探针每次读之前把新帧取回来交给 TestClient 解码。
 *
 * 和渲染端自己的订阅互不干扰：同一个 webContents（同一个客户端 id）下订阅 id 各不相同。
 *
 *   viewOf(sid)              订上（第一次）→ 取帧 → 当前值
 *   waitView(sid, pred, ms)  轮询直到值满足 pred
 *   waitRunEnded(sid, rec)   视图 `run.state !== 'busy'` **且** 录到一条该会话的 `agent_end`
 *   nextAsk(sid)             视图里下一条**没见过的**询问（流式游标，替代 `waitFor('input_request')`）
 *   waitAskGone(sid, id)     等这条询问从视图里消失（替代 `waitFor('input_request_resolved')`）
 *   toolResults(sid)         落盘的工具块（带结果的）：toolCallId / toolName / result / isError / details
 *                            （替代 `tool_end` 事件）
 *   agentViewOf(agentId)     一个派生 agent 的视图（`{kind:'agent'}` 目标，P3-14；根会话要先在主进程里打开过，
 *                            否则订阅以 service_not_found 拒绝 —— 抛出）
 *   waitAgentView(id, pred)  轮询直到 agent 视图满足 pred
 */
import { syncTargetKey, type SyncFrame, type SyncTarget } from '@shuvix/chat-protocol/sync'
import type { AgentView, SessionView } from '@shuvix/chat-protocol/types/sessionView'
import type { InputRequest } from '@shuvix/chat-protocol/types/inputRequest'
import type { AssistantToolBlock, ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'
import type { WireServiceProviderUpdate } from '@earendil-works/chord'
import {
  TestClient,
  type TestBinding
} from '../../../../packages/agent-runtime/src/sync/__tests__/support/client'
import type { CdpClient } from './cdp'
import { until } from './cdp'
import type { EventRecorder } from './seed'

const FRAMES = '__e2eSyncFrames'
/** 探针的客户端名 —— TestClient 的订阅 id 是 `<名>#<序号>` */
const CLIENT = 'e2e'

export interface SyncProbe {
  /** 装页面侧的帧缓冲（幂等；viewOf / waitView 会自动装） */
  install(): Promise<void>
  /** 一条会话此刻的视图（第一次读时订阅；订阅失败抛出） */
  viewOf(sessionId: string): Promise<SessionView | undefined>
  /** 等视图满足 `pred`；超时抛错（带最后一份视图的摘要） */
  waitView(
    sessionId: string,
    pred: (view: SessionView) => boolean,
    timeoutMs?: number,
    what?: string
  ): Promise<SessionView>
  /** 等这一轮结束：视图不在跑，且录到一条该会话的 `agent_end`（`since` 之后） */
  waitRunEnded(
    sessionId: string,
    opts?: { recorder?: EventRecorder; since?: number; timeoutMs?: number }
  ): Promise<SessionView>
  /** 视图里下一条还没被这个游标交出过的询问（每条只交一次） */
  nextAsk(sessionId: string, timeoutMs?: number): Promise<InputRequest>
  /** 等某条询问从视图里消失（答了 / 取消了） */
  waitAskGone(sessionId: string, requestId: string, timeoutMs?: number): Promise<void>
  /** 落盘的工具块里带结果的那些（按出现次序） */
  toolResults(sessionId: string): Promise<ToolResult[]>
  /** 等某个工具调用落盘出结果 */
  waitToolResult(sessionId: string, toolCallId?: string, timeoutMs?: number): Promise<ToolResult>
  /** 一个派生 agent 此刻的视图（第一次读时订阅；订阅失败抛出，错误带 `.code`） */
  agentViewOf(agentId: string): Promise<AgentView | undefined>
  /** 等 agent 视图满足 `pred`；超时抛错 */
  waitAgentView(
    agentId: string,
    pred: (view: AgentView) => boolean,
    timeoutMs?: number,
    what?: string
  ): Promise<AgentView>
  /** 放掉一条会话的订阅 */
  release(sessionId: string): Promise<void>
  /** 已订阅的会话 id */
  sessions(): string[]
}

/** 一个落盘的工具块（带结果） */
export interface ToolResult {
  toolCallId: string
  toolName: string
  args?: Record<string, unknown>
  result: string
  isError: boolean
  details?: AssistantToolBlock['details']
  /** 所属消息（条目）id */
  messageId: string
}

/** 一份消息列表里带结果的工具块 */
export function toolResultsIn(messages: readonly ChatMessage[]): ToolResult[] {
  const out: ToolResult[] = []
  for (const message of messages) {
    if (message.role !== 'assistant' || message.type !== 'message') continue
    for (const block of message.blocks) {
      if (block.type !== 'tool' || block.result === undefined) continue
      out.push({
        toolCallId: block.toolCallId,
        toolName: block.toolName,
        ...(block.args === undefined ? {} : { args: block.args }),
        result: block.result,
        isError: block.isError === true,
        ...(block.details === undefined ? {} : { details: block.details }),
        messageId: message.id
      })
    }
  }
  return out
}

const probes = new WeakMap<CdpClient, SyncProbe>()

/** 某个窗口的探针（每个 CdpClient 一个） */
export function syncProbe(main: CdpClient): SyncProbe {
  const existing = probes.get(main)
  if (existing) return existing

  let receiver: ((frame: SyncFrame<WireServiceProviderUpdate>) => void) | undefined
  const client = new TestClient(
    CLIENT,
    {
      invoke: (_clientId, target, call) =>
        main.eval(
          // preload 以纯对象 {code?, message} 拒绝（P3-15）：在页面里包回 Error，CDP 的异常描述才带着码与原文
          `window.api.sync.invoke(${JSON.stringify(target)}, ${JSON.stringify(call)}).then((v) => v === undefined ? null : v, (e) => { throw new Error((e && e.code ? e.code + ': ' : '') + (e && e.message !== undefined ? e.message : String(e))) })`
        ) as Promise<never>
    },
    {
      attach: (_clientId, deliver) => {
        receiver = deliver
      }
    }
  )
  const bindings = new Map<string, TestBinding>()
  /** nextAsk 的游标：会话 → 已交出过的询问 id */
  const seenAsks = new Map<string, Set<string>>()
  let installed = false

  async function install(): Promise<void> {
    if (installed) return
    await main.eval(
      `(() => {
        if (window.${FRAMES}) return true
        window.${FRAMES} = []
        window.api.sync.onFrame((frame) => {
          if (typeof frame?.subscriptionId === 'string' && frame.subscriptionId.startsWith('${CLIENT}#')) {
            window.${FRAMES}.push(frame)
          }
        })
        return true
      })()`
    )
    installed = true
  }

  /** 取回页面里攒下的帧，按序交给 TestClient */
  async function drain(): Promise<void> {
    const frames = await main.eval<SyncFrame<WireServiceProviderUpdate>[]>(
      `(window.${FRAMES} ?? []).splice(0)`
    )
    for (const frame of frames) receiver?.(frame)
  }

  /** agent 目标的绑定（按 `syncTargetKey` 记，与会话的分开） */
  const agentBindings = new Map<string, TestBinding>()

  async function bind(sessionId: string): Promise<TestBinding> {
    await install()
    let binding = bindings.get(sessionId)
    if (!binding) {
      const target: SyncTarget = { kind: 'session', sessionId }
      binding = client.bind(target)
      bindings.set(sessionId, binding)
      await binding.ready()
    }
    return binding
  }

  async function bindAgent(agentId: string): Promise<TestBinding> {
    await install()
    const target: SyncTarget = { kind: 'agent', agentId }
    const key = syncTargetKey(target)
    let binding = agentBindings.get(key)
    if (!binding) {
      binding = client.bind(target)
      try {
        await binding.ready()
      } catch (error) {
        // 订阅被拒：不留绑定，下一次重订
        await binding.dispose().catch(() => undefined)
        throw error
      }
      agentBindings.set(key, binding)
    }
    return binding
  }

  async function agentViewOf(agentId: string): Promise<AgentView | undefined> {
    const binding = await bindAgent(agentId)
    await drain()
    return binding.value() as AgentView | undefined
  }

  async function viewOf(sessionId: string): Promise<SessionView | undefined> {
    const binding = await bind(sessionId)
    await drain()
    return binding.value() as SessionView | undefined
  }

  const probe: SyncProbe = {
    install,
    viewOf,
    waitView: async (sessionId, pred, timeoutMs = 30_000, what) => {
      let last: SessionView | undefined
      try {
        return await until(
          async () => {
            last = await viewOf(sessionId)
            return last !== undefined && pred(last) ? last : null
          },
          what ?? `view of ${sessionId}`,
          timeoutMs
        )
      } catch (error) {
        const summary = last
          ? JSON.stringify({
              run: last.run,
              messages: last.messages.map((m) => `${m.role}:${m.content.slice(0, 40)}`),
              live: last.live?.message.content.slice(0, 40) ?? null,
              asks: last.asks.map((a) => a.id)
            })
          : 'no view'
        throw new Error(`${(error as Error).message}\nlast view: ${summary}`)
      }
    },
    waitRunEnded: async (sessionId, opts = {}) => {
      const timeoutMs = opts.timeoutMs ?? 30_000
      if (opts.recorder) {
        await opts.recorder.waitFor('agent_end', {
          sessionId,
          timeoutMs,
          ...(opts.since === undefined ? {} : { since: opts.since })
        })
      }
      return probe.waitView(
        sessionId,
        (v) => v.run.state !== 'busy',
        timeoutMs,
        `${sessionId} idle`
      )
    },
    nextAsk: async (sessionId, timeoutMs = 30_000) => {
      let seen = seenAsks.get(sessionId)
      if (!seen) {
        seen = new Set()
        seenAsks.set(sessionId, seen)
      }
      const known = seen
      const view = await probe.waitView(
        sessionId,
        (v) => v.asks.some((a) => !known.has(a.id)),
        timeoutMs,
        `a new ask in ${sessionId}`
      )
      const ask = view.asks.find((a) => !known.has(a.id))!
      known.add(ask.id)
      return ask
    },
    waitAskGone: async (sessionId, requestId, timeoutMs = 30_000) => {
      await probe.waitView(
        sessionId,
        (v) => !v.asks.some((a) => a.id === requestId),
        timeoutMs,
        `ask ${requestId} settled`
      )
    },
    toolResults: async (sessionId) => toolResultsIn((await viewOf(sessionId))?.messages ?? []),
    waitToolResult: async (sessionId, toolCallId, timeoutMs = 30_000) => {
      const view = await probe.waitView(
        sessionId,
        (v) =>
          toolResultsIn(v.messages).some(
            (r) => toolCallId === undefined || r.toolCallId === toolCallId
          ),
        timeoutMs,
        `tool result ${toolCallId ?? '(any)'} in ${sessionId}`
      )
      return toolResultsIn(view.messages).find(
        (r) => toolCallId === undefined || r.toolCallId === toolCallId
      )!
    },
    agentViewOf,
    waitAgentView: async (agentId, pred, timeoutMs = 30_000, what) => {
      let last: AgentView | undefined
      try {
        return await until(
          async () => {
            last = await agentViewOf(agentId)
            return last !== undefined && pred(last) ? last : null
          },
          what ?? `agent view of ${agentId}`,
          timeoutMs
        )
      } catch (error) {
        const summary = last
          ? JSON.stringify({
              run: last.run,
              messages: last.messages.map((m) => `${m.role}:${m.content.slice(0, 40)}`)
            })
          : 'no view'
        throw new Error(`${(error as Error).message}\nlast agent view: ${summary}`)
      }
    },
    release: async (sessionId) => {
      const binding = bindings.get(sessionId)
      if (!binding) return
      bindings.delete(sessionId)
      await binding.dispose().catch(() => undefined)
    },
    sessions: () => [...bindings.keys()]
  }
  probes.set(main, probe)
  return probe
}
