/**
 * 视图同步的 e2e 探针（P3-15a 的一半，随 P3-08 落地；pi 1.2 换成 chord2 链路）—— spec 进程里读一条会话「现在长什么样」。
 *
 * 会话内容不走 ChatEvent：消息、流式卡、工具进度、询问都在会话视图（`SessionView`）里，经 `window.api.sync`
 * 的 chord 链路同步。探针在 spec 进程（node）里跑一个**真的** chord 客户端宿主，自己开一条链路（链路 id
 * `e2e-…`，与渲染端自己的链路并存 —— 主进程按（窗口，链路 id）分开）：
 *  - 发：`window.api.sync.send(link, frame)` 经 CDP `eval` 在页面里发（按序排队）；
 *  - 收：页面侧装一个 `window.api.sync.onFrame` 监听，把**探针这条链路**的帧攒进
 *    `window["__e2eSyncFrames:<链路 id>"]`（每个探针一份：同一个页面上可以有几个探针，各自一条 CDP 连接）；
 *    探针每次读之前把新帧取回来交给链路。链路的 ping 超时放得很长：帧只在读的时候才取回来。
 *
 *   viewOf(sid)              持有（第一次）→ 取帧 → 当前值
 *   waitView(sid, pred, ms)  轮询直到值满足 pred
 *   waitRunEnded(sid, rec)   视图 `run.state !== 'busy'` **且** 录到一条该会话的 `agent_end`
 *   nextAsk(sid)             视图里下一条**没见过的**询问（流式游标，替代 `waitFor('input_request')`）
 *   waitAskGone(sid, id)     等这条询问从视图里消失（替代 `waitFor('input_request_resolved')`）
 *   toolResults(sid)         落盘的工具块（带结果的）：toolCallId / toolName / result / isError / details
 *                            （替代 `tool_end` 事件）
 *   agentViewOf(agentId)     一个派生 agent 的视图（`{kind:'agent'}` 目标，P3-14；根会话要先在主进程里打开过，
 *                            否则以 `not_found` 失败 —— 抛出，错误带 `.code`）
 *   waitAgentView(id, pred)  轮询直到 agent 视图满足 pred
 */
import type { Frame, Handle, Host } from '@earendil-works/chord'
import { createHost } from '@earendil-works/chord'
import { SYNC_NOT_FOUND, type SyncTarget } from '@shuvix/chat-protocol/sync'
import type { AgentView, SessionView } from '@shuvix/chat-protocol/types/sessionView'
import type { InputRequest } from '@shuvix/chat-protocol/types/inputRequest'
import type { AssistantToolBlock, ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'
import {
  AgentViewContract,
  FrameLink,
  isNotFoundError,
  SessionViewContract,
  VIEW_SERVER_HOST
} from '../../../../packages/agent-runtime/src/sync/viewContracts'
import type { CdpClient } from './cdp'
import { sleep, until } from './cdp'
import type { EventRecorder } from './seed'

const FRAMES = '__e2eSyncFrames'

/** 持有一个目标、等它活过来最多等多久 */
const BIND_TIMEOUT_MS = 15_000

/** 探针链路的 ping 超时：帧只在读的时候取回来，空闲再久也不能让链路自己断 */
const PROBE_PING_TIMEOUT_MS = 24 * 60 * 60 * 1000

type ViewHandle = Handle<typeof SessionViewContract> | Handle<typeof AgentViewContract>

/** 句柄失败的错误 → 带 `.code` 的 Error（「找不到」映射成 `not_found`，与渲染端的 syncClient 同一个口径） */
export function syncErrorOf(error: unknown): Error & { code?: string } {
  const chord = error as { code?: unknown; message?: unknown } | null | undefined
  const code = isNotFoundError(error)
    ? SYNC_NOT_FOUND
    : typeof chord?.code === 'string'
      ? chord.code
      : undefined
  const message = error instanceof Error ? error.message : String(error)
  const wrapped = new Error(code === undefined ? message : `${code}: ${message}`) as Error & {
    code?: string
  }
  if (code !== undefined) wrapped.code = code
  return wrapped
}

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
  /**
   * 一条会话此刻的可用性（第一次读时订阅；订阅失败抛出，错误带 `.code`）。会话被删之后，已有的订阅上
   * 它变成 `unavailable`（新订阅则以 `not_found` 失败）
   */
  availabilityOf(sessionId: string): Promise<'available' | 'unavailable' | undefined>
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

/** 一个目标的持有：句柄 + 让远端状态一直订着（订着才会被同步过来） */
interface ProbeBinding {
  readonly handle: ViewHandle
  readonly stops: (() => void)[]
}

/** 某个窗口的探针（每个 CdpClient 一个） */
export function syncProbe(main: CdpClient): SyncProbe {
  const existing = probes.get(main)
  if (existing) return existing

  const linkId = `e2e-${Math.random().toString(36).slice(2, 10)}`
  /** 页面里这个探针自己的帧缓冲（按链路 id 分开：同一个页面上可以有好几个探针 —— 各自一条 CDP 连接） */
  const buffer = JSON.stringify(`${FRAMES}:${linkId}`)
  /** 发往页面的帧按序排队（CDP eval 是异步的） */
  let outbox: Promise<unknown> = Promise.resolve()
  const link = new FrameLink((frame: Frame) => {
    const expression = `window.api.sync.send(${JSON.stringify(linkId)}, ${JSON.stringify(frame)})`
    outbox = outbox.then(() => main.eval(expression)).catch(() => undefined)
  })
  let host: Host | undefined
  const bindings = new Map<string, ProbeBinding>()
  /** nextAsk 的游标：会话 → 已交出过的询问 id */
  const seenAsks = new Map<string, Set<string>>()
  let installed = false

  async function install(): Promise<void> {
    if (installed) return
    await main.eval(
      `(() => {
        if (window[${buffer}]) return true
        window[${buffer}] = []
        window.api.sync.onFrame((link, frame) => {
          if (link === ${JSON.stringify(linkId)}) window[${buffer}].push(frame)
        })
        return true
      })()`
    )
    installed = true
  }

  function client(): Host {
    if (host === undefined) {
      host = createHost({ name: `e2e-probe:${linkId}`, kind: 'client', onError: () => {} })
      host.connect(link, { pingTimeout: PROBE_PING_TIMEOUT_MS })
    }
    return host
  }

  /** 发出去的先送到，再取回页面里攒下的帧、按序交给链路 */
  async function drain(): Promise<void> {
    await outbox
    const frames = await main.eval<unknown[]>(`(window[${buffer}] ?? []).splice(0)`)
    for (const frame of frames) link.deliver(frame)
  }

  function release(key: string): void {
    const binding = bindings.get(key)
    if (!binding) return
    bindings.delete(key)
    for (const stop of binding.stops.splice(0)) stop()
    binding.handle.release()
  }

  /** 持有一个目标，等它活过来、快照到了；失败 → 放掉、抛带 `.code` 的错（下一次重新持有） */
  async function bind(target: SyncTarget): Promise<ProbeBinding> {
    await install()
    const key =
      target.kind === 'session' ? `session:${target.sessionId}` : `agent:${target.agentId}`
    const existing = bindings.get(key)
    if (existing) return existing
    const host = client()
    const handle: ViewHandle =
      target.kind === 'session'
        ? host.get(SessionViewContract, { sessionId: target.sessionId }, { at: VIEW_SERVER_HOST })
        : host.get(AgentViewContract, { agentId: target.agentId }, { at: VIEW_SERVER_HOST })
    handle.ready.catch(() => undefined)
    const binding: ProbeBinding = {
      handle,
      stops: [handle.view.subscribe(() => {}), handle.availability.subscribe(() => {})]
    }
    bindings.set(key, binding)
    // 自己轮询（`until` 会吞掉错误）：gone = 订阅失败，带着码抛出去
    const deadline = Date.now() + BIND_TIMEOUT_MS
    try {
      for (;;) {
        await drain()
        if (handle.status === 'gone') throw syncErrorOf(handle.error)
        if (handle.status === 'live' && handle.view.value !== undefined) return binding
        if (Date.now() > deadline) {
          throw new Error(`timeout waiting: view of ${key} hydrated (status ${handle.status})`)
        }
        await sleep(50)
      }
    } catch (error) {
      release(key)
      throw error
    }
  }

  async function agentViewOf(agentId: string): Promise<AgentView | undefined> {
    const binding = await bind({ kind: 'agent', agentId })
    await drain()
    return binding.handle.view.value as AgentView | undefined
  }

  async function viewOf(sessionId: string): Promise<SessionView | undefined> {
    const binding = await bind({ kind: 'session', sessionId })
    await drain()
    return binding.handle.view.value as SessionView | undefined
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
    availabilityOf: async (sessionId) => {
      const binding = await bind({ kind: 'session', sessionId })
      await drain()
      return binding.handle.availability.value as 'available' | 'unavailable' | undefined
    },
    release: async (sessionId) => {
      release(`session:${sessionId}`)
      await outbox
    },
    sessions: () =>
      [...bindings.keys()]
        .filter((key) => key.startsWith('session:'))
        .map((key) => key.slice('session:'.length))
  }
  probes.set(main, probe)
  return probe
}
