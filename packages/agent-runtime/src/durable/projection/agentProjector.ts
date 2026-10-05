/**
 * AgentProjector（phase 3，P3-03）—— 一个派生 agent 的对话（子 agent 面板）的界面投影：与 SessionProjector
 * 同一套机制（旁路 → watch 帧 → 纯投影 → 逐字段对齐），投影成 `AgentView`（没有队列与询问，它们属于根
 * 会话；PIN-24）。
 *
 * 运行状态按**这个对话**算（`conversationRunState`：有生成任务 → 调度器开着 busy / 停着 interrupted），
 * 与根会话的状态无关；任务变化（旁路）与根运行状态的变化（调度器开启）都会让它重算一次 run.state。
 * 运行生命周期不在这里发 —— 派生 agent 的 started / ended 由 SessionProjector 统一发（带 agentId）。
 *
 * 由 `DurableSession.agentProjector(agentId)` 惰性建立、按 agentId 共享、计数回收；不认识的 agentId →
 * undefined（不挂载）。宿主派发的 hook agent（起标题、审查）也能看（只读，PIN-20）。不依赖 Node / Electron。
 */
import {
  LiveDoc,
  type CommitPublication,
  type ConversationId,
  type LiveState
} from '@earendil-works/pi-durable'
import type { AgentView, RunViewState } from '@shuvix/chat-protocol/types/sessionView'
import { projectAgentView } from './project'
import {
  ProjectorCore,
  type ProjectorCoreOptions,
  type ProjectorHandle,
  type MountFrame,
  type ProjectorHost
} from './sessionProjector'

/** 一个派生 agent 对话的界面投影（`DurableSession.agentProjector(agentId)`） */
export interface AgentProjector {
  readonly agentId: string
  readonly sessionId: string
  readonly conversationId: number
  /** 此刻的视图 */
  readonly value: AgentView
  /** 已拆掉（最后一个句柄归还，或会话关停） */
  readonly disposed: boolean
  /** 借一个句柄（计数 +1）；已拆掉 → 抛错 */
  acquire(): ProjectorHandle<AgentView>
}

export class AgentProjectorImpl extends ProjectorCore<AgentView> implements AgentProjector {
  readonly agentId: string
  readonly sessionId: string
  readonly conversationId: ConversationId

  constructor(
    host: ProjectorHost,
    agentId: string,
    conversationId: ConversationId,
    options: ProjectorCoreOptions = {}
  ) {
    super(host, options)
    this.agentId = agentId
    this.sessionId = host.sessionId
    this.conversationId = conversationId
  }

  /** 挂载（与 SessionProjector 同序：旁路 → 运行状态 → watch → 侧车；就绪才落定） */
  async start(): Promise<void> {
    this.attachSideChannel()
    this.own(this.host.onRunStateChange(() => this.scheduleRefresh()))
    const mount = await this.attachConversation(this.conversationId)
    if (this.disposed) {
      void mount.watch.stop().catch(() => undefined)
      throw new Error(`Session ${this.sessionId} closed while an agent projector was mounting`)
    }
    this.startMount(mount)
  }

  protected project(mount: MountFrame, runState: RunViewState): AgentView {
    const { entries, docs } = mount.value
    return projectAgentView(
      { agentId: this.agentId, sessionId: this.sessionId, conversationId: mount.conversationId },
      entries,
      docs[LiveDoc.definition.kind] as LiveState | undefined,
      this.displayByEntry(mount),
      runState
    )
  }

  protected runStateOf(conversationId: ConversationId): RunViewState {
    return this.host.conversationRunState(conversationId)
  }

  /** 这个对话的任务变了（生成任务出现 / 终结）→ run.state 可能变了，而这次发布未必有帧 */
  protected override onPublication(publication: CommitPublication): void {
    for (const change of publication.changes) {
      if (change.type === 'task' && change.value.conversationId === this.conversationId) {
        this.scheduleRefresh()
        return
      }
    }
  }
}
