/**
 * 会话信号的桌面接线（phase 3，P3-08；plan §B「Run lifecycle」、§D）—— 每条**打开着**的 durable 会话，从
 * 打开到关闭，主进程替它持有两样东西：
 *
 *  1. **一个投影句柄**（`session.projector()` → `acquire()`）与它的运行生命周期监听。运行生命周期只在投影被
 *     持有时才有（P3-03），所以句柄从 `onSessionOpened` 拿到、到 `onSessionClosed` 才还 —— 每一轮运行（根
 *     对话，或一个**登记过**的派生 agent，PIN-19）都恰好变成一对 `agent_start` / `agent_end{reason}`，经唯一
 *     的 `electronEventSink` 发出去（前端注册表、通知、Chrome 调试租约都从那里拿）。派生 agent 的那一对用
 *     agentId 当 sessionId；没登记过的派生对话（路由不认识）什么都不发，也就从不通知、从不碰租约。
 *  2. **询问的钩子**（`subscribeInputs`）：询问不再上前端线路（Q-P3-04），主进程的两个消费方挂在这里 ——
 *     通知（询问观察者 `setSessionAskObserver`：main 入口把 notificationService 的 `notifyAskRaised` /
 *     `notifyAskResolved` 接上，过滤与 ChatEvent 那一路同口径）与只带数字的 `ask_count`（PIN-01：侧栏
 *     徽标、后台任务面板的「卡在等人」读它）。本模块不 import 通知服务（它拖进 Electron）。
 *
 * **就绪**（PIN-09）：投影的挂载是异步的（显示侧车要先解析，P3-03 PIN-01），挂载本身从不发信号（P3-03
 * PIN-04）—— 一轮在挂载完成前就开跑，就既没有 `agent_start` 也没有 `agent_end`。所以打开时登记一个就绪
 * promise（登记进 `sessionSignalSeams` 那张小表），发送 / 继续在提交之前等它（AgentSession 里调）。
 *
 * **失败文本**（PIN-08）：模型侧的失败是一条错误条目（投影成 `error_event`），不再另发 `error` 事件；失败
 * 通知的正文由这里从投影里现读最后一条错误行（`sessionRunErrorText`；main 入口交给 notificationService）。
 *
 * 关闭：先摘生命周期监听、还句柄、摘询问钩子（关闭时取消询问的落定在 `onSessionClosed` 之前，所以计数
 * 落回 0 的那一条已经发过）。关闭之后不再有任何生命周期事件；忙着被关的那一轮不补 `agent_end`（投影在
 * 会话关停中什么都不发）。
 */
import type {
  DurableSession,
  ProjectorHandle,
  RunLifecycleSignal,
  SessionProjector
} from '@shuvix/agent-runtime'
import type { ChatEvent } from '@shuvix/chat-protocol/events'
import type { InputRequest } from '@shuvix/chat-protocol/types/inputRequest'
import type { SyncSessionClosedReason } from '@shuvix/agent-runtime'
import { sessionHostHooks, type SessionHookFanout } from '../frontend/sync/syncWiring'
import { createLogger } from '../logger'
import { electronEventSink } from './agentRuntimeAdapters'
import {
  clearSessionReadiness,
  isRegisteredAgent as routerKnowsAgent,
  setSessionReadiness
} from './sessionSignalSeams'

const log = createLogger('SessionSignals')

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 一条打开着的会话替它持有的东西 */
interface Held {
  closed: boolean
  projector?: SessionProjector
  handle?: ProjectorHandle<object>
  stopLifecycle?: () => void
  stopInputs?: () => void
  /** 投影句柄拿到（或拿不到）之后落定；从不拒绝 */
  ready: Promise<void>
  /** 上一次发出的询问数（不变不发） */
  askCount: number
}

export interface SessionSignalsDeps {
  /** 开 / 关钩子的扇出（缺省主进程那份） */
  readonly hooks?: Pick<SessionHookFanout<DurableSession>, 'onSessionOpened' | 'onSessionClosed'>
  /** 余项事件的出口（缺省 `electronEventSink.broadcast`） */
  readonly broadcast?: (event: ChatEvent) => void
  /** 询问挂起 / 落定的通知（缺省 = 登记过的询问观察者，`setSessionAskObserver`） */
  readonly askRaised?: (sessionId: string, request: InputRequest) => void
  readonly askResolved?: (sessionId: string, requestId: string) => void
  /**
   * 这个派生 agent 是不是登记过的（路由认识它，PIN-19）。缺省问路由自己登记的检查
   * （`sessionSignalSeams.setRegisteredAgentCheck`）；没登记过 → 当不认识
   */
  readonly isRegisteredAgent?: (agentId: string) => boolean
  /** 把就绪 promise 登记进进程的就绪表（`sessionSignalSeams`，发送前等它）；缺省 true */
  readonly publishReadiness?: boolean
}

export interface SessionSignals {
  /** 某会话的信号就绪（投影句柄拿到了或拿不到了）；不是打开着的会话 → 立刻落定 */
  ready(sessionId: string): Promise<void>
  /** 某打开着的会话最后一条错误行（PIN-08）；没有 → undefined */
  runErrorText(sessionId: string): string | undefined
  /** 此刻持有句柄的会话（测试用） */
  heldSessions(): string[]
  /** 摘掉钩子、还掉所有句柄（测试用；幂等） */
  dispose(): void
}

/** 一份视图消息列表里最后一条错误行的正文 */
function lastErrorText(projector: SessionProjector | undefined): string | undefined {
  const messages = projector?.value.messages
  if (!messages) return undefined
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.type === 'error_event') return message.content
  }
  return undefined
}

export function createSessionSignals(deps: SessionSignalsDeps = {}): SessionSignals {
  const hooks = deps.hooks ?? sessionHostHooks
  const broadcast = deps.broadcast ?? ((event: ChatEvent) => electronEventSink.broadcast(event))
  const askRaised =
    deps.askRaised ??
    ((sessionId: string, request: InputRequest) => askObserver?.askRaised(sessionId, request))
  const askResolved =
    deps.askResolved ??
    ((sessionId: string, requestId: string) => askObserver?.askResolved(sessionId, requestId))
  const isRegisteredAgent = deps.isRegisteredAgent ?? routerKnowsAgent

  const held = new Map<string, Held>()
  const publishReadiness = deps.publishReadiness ?? true

  function send(event: ChatEvent): void {
    try {
      broadcast(event)
    } catch (error) {
      log.warn(
        `会话信号广播失败 type=${event.type} session=${event.sessionId}: ${errorText(error)}`
      )
    }
  }

  function emitAskCount(sessionId: string, entry: Held, count: number): void {
    if (entry.askCount === count) return
    entry.askCount = count
    send({ type: 'ask_count', sessionId, count })
  }

  function onLifecycle(sessionId: string, entry: Held, signal: RunLifecycleSignal): void {
    if (entry.closed) return
    let target = sessionId
    if (signal.agentId !== undefined) {
      // 只有登记过的派生 agent 才有生命周期（PIN-19）：hook / 审查员起的派生对话也登记，所以它们照样有一对
      // —— 但它们的 sessionId 是 agentId：通知按血缘不弹、Chrome 租约只认标签页会话，都碰不到
      if (!isRegisteredAgent(signal.agentId)) return
      target = signal.agentId
    }
    if (signal.kind === 'started') send({ type: 'agent_start', sessionId: target })
    else send({ type: 'agent_end', sessionId: target, reason: signal.reason })
  }

  function release(entry: Held): void {
    entry.closed = true
    try {
      entry.stopLifecycle?.()
    } catch (error) {
      log.warn(`摘生命周期监听失败: ${errorText(error)}`)
    }
    entry.stopLifecycle = undefined
    try {
      entry.handle?.release()
    } catch (error) {
      log.warn(`归还投影句柄失败: ${errorText(error)}`)
    }
    entry.handle = undefined
    try {
      entry.stopInputs?.()
    } catch (error) {
      log.warn(`摘询问钩子失败: ${errorText(error)}`)
    }
    entry.stopInputs = undefined
  }

  function opened(session: DurableSession): void {
    const sessionId = session.sessionId
    const previous = held.get(sessionId)
    if (previous !== undefined) release(previous)
    const entry: Held = { closed: false, ready: Promise.resolve(), askCount: 0 }
    held.set(sessionId, entry)

    entry.stopInputs = session.subscribeInputs({
      onRequest: (request) => {
        if (entry.closed) return
        askRaised(sessionId, request)
        emitAskCount(sessionId, entry, session.pendingInputs().length)
      },
      onResolved: (requestId) => {
        if (entry.closed) return
        askResolved(sessionId, requestId)
        emitAskCount(sessionId, entry, session.pendingInputs().length)
      }
    })

    entry.ready = session
      .projector()
      .then((projector) => {
        if (entry.closed || projector.disposed) return
        entry.projector = projector
        entry.handle = projector.acquire() as ProjectorHandle<object>
        entry.stopLifecycle = projector.onRunLifecycle((signal) =>
          onLifecycle(sessionId, entry, signal)
        )
      })
      .catch((error: unknown) => {
        log.warn(`会话 ${sessionId} 的投影没能挂上（没有运行生命周期）: ${errorText(error)}`)
      })
    if (publishReadiness) setSessionReadiness(sessionId, entry.ready)
  }

  function closed(sessionId: string, _reason: SyncSessionClosedReason): void {
    const entry = held.get(sessionId)
    if (entry === undefined) return
    held.delete(sessionId)
    if (publishReadiness) clearSessionReadiness(sessionId)
    release(entry)
  }

  const stopOpened = hooks.onSessionOpened(opened)
  const stopClosed = hooks.onSessionClosed(closed)

  return {
    ready: (sessionId) => held.get(sessionId)?.ready ?? Promise.resolve(),
    runErrorText: (sessionId) => lastErrorText(held.get(sessionId)?.projector),
    heldSessions: () => [...held.keys()],
    dispose: () => {
      stopOpened()
      stopClosed()
      for (const entry of held.values()) release(entry)
      held.clear()
    }
  }
}

// ─── 主进程单例 ─────────────────────────────────────────

/** 询问的观察者（通知）：main 入口登记；没登记 → 询问只发 `ask_count` */
export interface SessionAskObserver {
  askRaised(sessionId: string, request: InputRequest): void
  askResolved(sessionId: string, requestId: string): void
}

let askObserver: SessionAskObserver | null = null

/** 登记询问的观察者（main 入口接 notificationService；null = 摘掉） */
export function setSessionAskObserver(observer: SessionAskObserver | null): void {
  askObserver = observer
}

let installed: SessionSignals | undefined

/** 装上主进程唯一的会话信号接线（幂等；宿主第一次建出来时调） */
export function installSessionSignals(): SessionSignals {
  installed ??= createSessionSignals()
  return installed
}

/** 某打开着的会话最后一条错误行（PIN-08；失败通知的正文） */
export function sessionRunErrorText(sessionId: string): string | undefined {
  return installed?.runErrorText(sessionId)
}

/**
 * 某会话的信号就绪（PIN-09）：发送 / 继续在提交之前等它，好让这一轮的 `agent_start` 一定有人发。没装过 /
 * 不是打开着的会话 → 立刻落定（读的是 `sessionSignalSeams` 那张表 —— AgentSession 直接引它）
 */
export { sessionSignalsReady, setRegisteredAgentCheck } from './sessionSignalSeams'
