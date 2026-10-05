/**
 * 会话信号接线（`sessionSignals`，P3-08）的两条接缝 —— 一个没有依赖的小模块，好让 AgentSession 与派生 agent
 * 路由不必 import 接线本身（它经事件汇拖进通知服务与 Electron，经同步接线拖进存储层）：
 *
 *  - **就绪表**（PIN-09）：接线在会话打开时登记「这条会话的投影句柄什么时候挂上」，发送 / 继续
 *    （AgentSession）在提交之前等它；
 *  - **派生 agent 登记检查**（PIN-19）：路由（agents/AgentManager）加载时登记「认不认识这个 agentId」，接线
 *    只给认识的派生 agent 发生命周期。派生 agent 只经路由起，所以第一条派生信号到来之前它一定已经登记过。
 */

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
