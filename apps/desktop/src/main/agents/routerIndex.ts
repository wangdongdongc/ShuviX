/**
 * 派生 agent 路由的索引接线（P3-14）—— 路由的 agentId 索引在会话打开时从这条会话的派生记录重建：
 *
 *  - **打开**：会话宿主每次真正打开（open / peek）经钩子扇出（`sessionHostHooks`，同步接线在模块初始化时挂上
 *    转发监听器）→ `sessionSignalSeams.indexOpenedSession` → 路由的 `indexSession(session)`。重启之后，面板
 *    追问、agent 视图（SyncHub 的 `resolveAgent`）、生命周期的登记检查因此在根会话打开之后就认得它的派生 agent；
 *  - **关闭**：`'destroy'`（删除 / 清空）丢掉这条会话的条目，其余原因（LRU、显式、全部关闭）留着；
 *  - **懒**（PIN-16）：路由没建过，转发什么都不做；路由建出来那一刻（本函数）登记自己，并把**此刻已经打开着**
 *    的会话各重建一次。
 *
 * 转发监听器抛错由扇出记一条日志、不拦别的监听器（P3-05 的扇出语义）；建出来时的那一轮自己兜。
 */
import type { DurableSession, RuntimeLogger } from '@shuvix/agent-runtime'
import type { AgentIndexer } from '../services/sessionSignalSeams'

export interface RouterIndexDeps {
  /** 登记 / 摘掉路由的索引重建面（`sessionSignalSeams.setAgentIndexer`） */
  readonly register: (indexer: AgentIndexer | null) => void
  /** 此刻打开着的会话（不建宿主、不碰 LRU 的新近度：`peekSessionHost()` + `get`） */
  readonly openSessions: () => Iterable<DurableSession>
  readonly logger?: Pick<RuntimeLogger, 'warn'>
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 接上；返回注销（重复注销无事） */
export function wireRouterIndex(router: AgentIndexer, deps: RouterIndexDeps): () => void {
  deps.register(router)
  for (const session of deps.openSessions()) {
    try {
      router.indexSession(session)
    } catch (error) {
      deps.logger?.warn(
        `rebuilding the agent index of session ${session.sessionId} failed: ${errorText(error)}`
      )
    }
  }
  let wired = true
  return () => {
    if (!wired) return
    wired = false
    deps.register(null)
  }
}

/** 宿主里此刻打开着的会话（宿主没建过 → 没有） */
export function openSessionsOf(
  host:
    | { openSessionIds(): string[]; get(sessionId: string): DurableSession | undefined }
    | undefined
): DurableSession[] {
  if (host === undefined) return []
  const sessions: DurableSession[] = []
  for (const sessionId of host.openSessionIds()) {
    const session = host.get(sessionId)
    if (session !== undefined) sessions.push(session)
  }
  return sessions
}
