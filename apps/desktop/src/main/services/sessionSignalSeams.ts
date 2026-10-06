/**
 * 会话信号接线（`sessionSignals`，P3-08）的两条接缝 —— 一个没有依赖的小模块，好让 AgentSession 与派生 agent
 * 路由不必 import 接线本身（它经事件汇拖进通知服务与 Electron，经同步接线拖进存储层）：
 *
 *  - **就绪表**（PIN-09）：接线在会话打开时登记「这条会话的投影句柄什么时候挂上」，发送 / 继续
 *    （AgentSession）在提交之前等它；
 *  - **派生 agent 登记检查**（PIN-19）：路由（agents/AgentManager）加载时登记「认不认识这个 agentId」，接线
 *    只给认识的派生 agent 发生命周期。派生 agent 只经路由起，所以第一条派生信号到来之前它一定已经登记过。
 *  - **索引重建**（P3-14）：路由加载时登记自己（`setAgentIndexer`）；同步接线的钩子扇出在每次真正打开 /
 *    关闭时转给它（`indexOpenedSession` / `forgetClosedSession`）—— 路由没建过就什么都不做（PIN-16）。经这张
 *    小表而不是路由直接登记扇出监听器：路由模块可能在同步接线 / 会话宿主模块**求值途中**被求值（sessionHost →
 *    sessionService → agentSession → hookService → AgentManager 的环），那时扇出还在暂时性死区里。
 */
import type { DurableSession } from '@shuvix/agent-runtime'

const readiness = new Map<string, Promise<void>>()

/** 登记某会话的就绪 promise（打开时）；promise 从不拒绝 */
export function setSessionReadiness(sessionId: string, ready: Promise<void>): void {
  readiness.set(sessionId, ready)
}

/** 摘掉某会话的就绪 promise（关闭时） */
export function clearSessionReadiness(sessionId: string): void {
  readiness.delete(sessionId)
}

/** 等某会话的信号就绪；没登记过（不是打开着的会话 / 没装接线）→ 立刻落定 */
export function sessionSignalsReady(sessionId: string): Promise<void> {
  return readiness.get(sessionId) ?? Promise.resolve()
}

let registeredAgentCheck: ((agentId: string) => boolean) | null = null

/** 路由登记「认不认识这个派生 agent」（null = 摘掉） */
export function setRegisteredAgentCheck(check: ((agentId: string) => boolean) | null): void {
  registeredAgentCheck = check
}

/** 这个派生 agent 是不是路由认识的；路由没登记过检查 → 当不认识 */
export function isRegisteredAgent(agentId: string): boolean {
  return registeredAgentCheck?.(agentId) ?? false
}

/** 路由的索引重建面（`SubAgentManager` 满足它） */
export interface AgentIndexer {
  indexSession(session: DurableSession): void
  onSessionClosed(sessionId: string, reason: 'remove' | 'destroy'): void
}

let agentIndexer: AgentIndexer | null = null

/** 路由登记自己的索引重建面（null = 摘掉） */
export function setAgentIndexer(indexer: AgentIndexer | null): void {
  agentIndexer = indexer
}

/** 会话真正打开了（扇出监听器）：交给路由重建索引；路由没登记 → 什么都不做 */
export function indexOpenedSession(session: DurableSession): void {
  agentIndexer?.indexSession(session)
}

/** 会话关掉了（扇出监听器）：`destroy` 原样交给路由，其余原因都算 `remove`；路由没登记 → 什么都不做 */
export function forgetClosedSession(sessionId: string, reason: string): void {
  agentIndexer?.onSessionClosed(sessionId, reason === 'destroy' ? 'destroy' : 'remove')
}
