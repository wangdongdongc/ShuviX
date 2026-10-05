/**
 * 假的同步会话与宿主（P3-05 单元用例）：`projector()` 交一个真的 chord `replicatedState(SessionView)`，
 * 用例自己 `change` 它；最后一个租约释放时停用，下一次 `projector()` 给一个新的（初值 = 上一个的最后值）。
 */
import type { SyncHubHost, SyncSession, SyncSessionClosedReason } from '@shuvix/agent-runtime'
import type { AgentView, SessionView } from '@shuvix/chat-protocol/types/sessionView'
import {
  BG,
  FakeProjector,
  agentView,
  durableView
} from '../../../../../../../../packages/agent-runtime/src/sync/__tests__/support/rig'

export { BG, FakeProjector, durableView, agentView as agentViewOf }

export class FakeSyncSession implements SyncSession {
  #root: FakeProjector<SessionView> | undefined
  #last: SessionView
  readonly agents = new Map<string, FakeProjector<AgentView>>()
  /** 认识的派生 agent（agentId → 对话） */
  readonly knownAgents = new Map<string, number>()

  constructor(readonly sessionId: string) {
    this.#last = durableView(sessionId)
  }

  /** 当前（未停用）的根投影器；没有就新建一个 */
  root(): FakeProjector<SessionView> {
    if (this.#root === undefined || this.#root.disposed) {
      this.#root = new FakeProjector<SessionView>(this.#last, (last) => {
        this.#last = last
      })
    }
    return this.#root
  }

  async projector(): Promise<FakeProjector<SessionView>> {
    return this.root()
  }

  async agentProjector(agent: {
    agentId: string
    conversationId: number
  }): Promise<FakeProjector<AgentView> | undefined> {
    if (!this.knownAgents.has(agent.agentId)) return undefined
    let projector = this.agents.get(agent.agentId)
    if (projector === undefined || projector.disposed) {
      projector = new FakeProjector<AgentView>(
        agentView(agent.agentId, this.sessionId, agent.conversationId),
        () => {}
      )
      this.agents.set(agent.agentId, projector)
    }
    return projector
  }

  /** 改根视图（像投影器那样逐字段写） */
  change(mutate: (draft: SessionView) => void): void {
    this.root().state.change(BG, (draft) => mutate(draft as SessionView))
  }
}

/** 一个最小的 hub 宿主：会话表 + 开 / 关监听器（用例手动报） */
export class FakeSyncHost implements SyncHubHost {
  sealed = false
  readonly sessions = new Map<string, FakeSyncSession>()
  readonly peeks: string[] = []
  readonly opened = new Set<(session: SyncSession) => void>()
  readonly closed = new Set<(sessionId: string, reason: SyncSessionClosedReason) => void>()

  async peek(sessionId: string): Promise<SyncSession | undefined> {
    this.peeks.push(sessionId)
    return this.sealed ? undefined : this.sessions.get(sessionId)
  }

  onSessionOpened(listener: (session: SyncSession) => void): () => void {
    this.opened.add(listener)
    return () => this.opened.delete(listener)
  }

  onSessionClosed(
    listener: (sessionId: string, reason: SyncSessionClosedReason) => void
  ): () => void {
    this.closed.add(listener)
    return () => this.closed.delete(listener)
  }

  add(sessionId: string): FakeSyncSession {
    const session = new FakeSyncSession(sessionId)
    this.sessions.set(sessionId, session)
    return session
  }
}
