/**
 * SessionProjector（phase 3，P3-03）—— 一条打开着的 durable 会话的「界面现在长什么样」，作为一份 chord
 * 复制状态（`MutableReplicatedState<SessionView>`）维护，供 SyncHub（P3-04）推给每个前端。
 *
 * **内容来源是 `conversation.watch(ctx)`**（P3-03 设计稿的修订）：durable 的视图挂载按提交发布前进，
 * 每一帧（精确、有序、异步，在微任务里）给出 `{entries, docs}`（含 `pi.live` / `pi.inbox`）。帧处理器
 * 把它喂给纯投影（`project.ts`）再逐字段对齐进状态（`reconcile.ts`）—— 流式文字是 `a` 操作，新消息是一条
 * `p`。帧处理器不在 Session 的提交监听里，下游（SyncHub 的发送）抛错也只记日志，碰不到会话（PIN-03）。
 *
 * 帧里没有、但投影要的东西由一条**同步的旁路**（`subscribeCommits`）先记下：
 *  - `submission` 变化：requestId → 落下的条目（显示侧车按它落到 user 条目上）、submission id → requestId
 *    （排队的内联 Token 输入按它找显示侧车，PIN-17 / PIN-22）；
 *  - `DisplayDoc` 变化（每个对话一份）；
 *  - `SessionStateDoc.currentConversation` 变化 → 换挂载（回退 fork 之后，PIN-07：`state.replace`，一条
 *    `["r"]`）；
 *  - 任务的中止标记与每个任务最后一条 assistant 的 stopReason（运行结束的原因，PIN-05）；
 *  - 派生 agent 对话的 `pi.live.run` 出现 / 消失（它们的运行生命周期，PIN-20 / PIN-06）。
 * 旁路先于帧（同一次发布里，帧要等微任务），所以帧处理器读到的旁路状态总是已经包含这一帧的那次发布。
 *
 * 其余两路输入：询问（`PendingInputRequests` 的多钩子，PIN-02，询问变化是一次没有提交的修订）与运行状态
 * （`DurableSession.onRunStateChange`，PIN-23：`markResumed` 那种没有发布的转变也有一次只改
 * `run.state` 的修订）。运行状态在处理时现读。
 *
 * 挂载（PIN-01、P3-03-51）：先挂旁路，再取 watch（它的初值之后的每次发布都会成为一帧），再读 DisplayDoc
 * 与 submission（一个只读提交）—— 三步之间的发布一条都不会丢。全部就绪之后才建状态、`projector()` 才落定，
 * 所以第一份可见的值就是完整的（不会先给一版没有显示侧车的）。挂载只读：不开启调度器、不产生发布。
 *
 * 运行生命周期（PIN-04/05/06）：根对话按相邻两帧之间 `pi.live.run` 的出现 / 消失；派生 agent 的对话按
 * 旁路里 `pi.live` 的变化。都在帧（发布）之后的微任务里送出，监听器各自隔离。挂载从不发信号；只有发过
 * `started` 的运行才会有 `ended`；关停中的会话什么都不发。
 *
 * 共享与回收：`DurableSession.projector()` 惰性建一个、同一时刻只有一个；`acquire()` / `release()` 计数，
 * 最后一个 release 之后拆掉（状态保留最后的值）；会话关停时一并拆掉。不依赖 Node / Electron。
 */
import { replicatedState, type MutableReplicatedState } from '@earendil-works/chord'
import {
  AssistantEntry,
  LiveDoc,
  UserEntry,
  type CommitPublication,
  type ConversationId,
  type ConversationView,
  type EntryId,
  type EntryRecord,
  type Harness,
  type InboxState,
  type JsonObject,
  type LiveState,
  type SubmissionId,
  type TaskId,
  type WatchHandle
} from '@earendil-works/pi-durable'
import type { InputRequest } from '@shuvix/chat-protocol/types/inputRequest'
import type { RunViewState, SessionView } from '@shuvix/chat-protocol/types/sessionView'
import type { RuntimeLogger } from '../../types'
import { backgroundContext as BG, errorText } from '../context'
import { DisplayDoc, SessionStateDoc, type SessionState } from '../docs'
import type { PendingInputHooks } from '../inputRequests'
import { displayItemOf, type DisplayItem } from './display'
import { projectSessionView } from './project'
import { reconcile } from './reconcile'

// ─────────────────────────── 公共类型 ───────────────────────────

/** 运行结束的原因（PIN-05） */
export type RunEndReason = 'ok' | 'aborted' | 'error'

/**
 * 运行生命周期信号（PIN-06）：根对话的一轮运行、或一个派生 agent 对话的一轮运行开始 / 结束。
 * `agentId` 只在派生 agent 的对话上有。主进程内部用（P3-08 据此发 `agent_start` / `agent_end`、通知、
 * Chrome 调试租约）。
 */
export type RunLifecycleSignal =
  | {
      readonly kind: 'started'
      readonly sessionId: string
      readonly conversationId: number
      readonly taskId: number
      readonly agentId?: string
    }
  | {
      readonly kind: 'ended'
      readonly sessionId: string
      readonly conversationId: number
      readonly taskId: number
      readonly agentId?: string
      readonly reason: RunEndReason
    }

export type RunLifecycleListener = (signal: RunLifecycleSignal) => void

/** 一次 `acquire()` 的句柄：同一个投影的所有句柄共享同一份状态 */
export interface ProjectorHandle<V extends object> {
  /**
   * 复制状态（只有投影写它；消费方只读 —— 类型是可变的，只为让 SyncHub 能把它交给 chord 的服务提供方，
   * 以及测试能制造竞态）。投影拆掉之后它保留最后的值。
   */
  readonly state: MutableReplicatedState<V>
  /** 归还（幂等）；最后一个归还时投影拆掉 */
  release(): void
}

/** 一条会话的界面投影（`DurableSession.projector()`） */
export interface SessionProjector {
  readonly sessionId: string
  /** 此刻的视图（= 任何一个句柄的 `state.value`） */
  readonly value: SessionView
  /** 已拆掉（最后一个句柄归还，或会话关停）；拆掉的投影不能再 acquire —— 重新 `projector()` */
  readonly disposed: boolean
  /** 借一个句柄（计数 +1）；已拆掉 → 抛错 */
  acquire(): ProjectorHandle<SessionView>
  /** 订阅运行生命周期（根对话与派生 agent 的对话）；返回退订函数。监听器抛错只记日志 */
  onRunLifecycle(listener: RunLifecycleListener): () => void
}

/**
 * 投影向会话要的东西（DurableSession 内部实现；不是公共接口）。
 * `harness` 是**原始**的 Harness（不经开启调度器的观测代理 —— 投影只读）。
 */
export interface ProjectorHost {
  readonly sessionId: string
  readonly harness: Harness
  readonly logger: RuntimeLogger
  readonly closed: boolean
  /** 会话（根）的运行状态（同步真值） */
  readonly runState: RunViewState
  /** 当前对话（R11：指针指向不存在的对话 → 根，并记警告） */
  currentConversationId(): Promise<ConversationId>
  /** 一个对话自己的运行状态：有生成任务 → 调度器开着 busy / 停着 interrupted；否则 idle */
  conversationRunState(conversationId: ConversationId): RunViewState
  /** 根运行状态的变化（微任务里调用；含没有发布的 `markResumed`）；返回退订函数 */
  onRunStateChange(listener: () => void): () => void
  /** 询问的钩子（PIN-02）；返回退订函数 */
  subscribeInputs(hooks: PendingInputHooks): () => void
  /** 此刻挂着的询问 */
  pendingInputs(): InputRequest[]
  /** 派生 agent 对话的 agentId（不是派生 agent 的对话 → undefined） */
  agentIdOf(conversationId: ConversationId): string | undefined
}

// ─────────────────────────── 共用的投影核心 ───────────────────────────

const ROOT_REVISION_FAILED = 'projector revision failed'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `pi.live.run` 的 taskId；没有 run → undefined */
export function liveRunTask(live: unknown): TaskId | undefined {
  if (!isRecord(live) || !isRecord(live.run)) return undefined
  const taskId = live.run.taskId
  return typeof taskId === 'number' ? (taskId as TaskId) : undefined
}

/** 一次挂载：一个对话的 watch 与它挂上时解析出来的祖先侧车落点 */
export interface ProjectorMount {
  readonly conversationId: ConversationId
  readonly watch: WatchHandle<ConversationView>
  /** 最近处理过的一帧（挂载时 = watch 的初值） */
  value: ConversationView
  /** fork 祖先里的 requestId → 条目（挂载时一次解析；它们之后不会再变） */
  readonly ancestorEntries: ReadonlyMap<string, EntryId>
  /** 换挂载之后旧挂载作废（它之后的帧一律丢掉） */
  stale: boolean
}

/** 正在跟踪的一轮运行（生命周期） */
interface TrackedRun {
  taskId: TaskId
  /** 发过 started（只有它才会有 ended） */
  emitted: boolean
  /** 被中断时挂上的：之后第一帧在跑且没被中止 → 补发 started（继续，PIN-04） */
  resumable: boolean
  /** 派生 agent 的 id（根对话没有） */
  readonly agentId?: string
}

export interface ProjectorCoreOptions {
  /** 拆掉时（最后一个句柄归还 / 会话关停）通知 DurableSession 丢掉缓存 */
  onDispose?: () => void
}

/**
 * 投影核心：旁路、watch 挂载、显示侧车、帧 → 投影 → 对齐、句柄计数、生命周期送达。SessionProjector 与
 * AgentProjector 各自给出「投影什么」与「运行状态从哪来」。
 */
export abstract class ProjectorCore<V extends object> {
  protected readonly host: ProjectorHost
  private readonly options: ProjectorCoreOptions
  protected mount: ProjectorMount | undefined
  private stateRef: MutableReplicatedState<V> | undefined
  private refs = 0
  private disposedFlag = false
  private unsubscribers: (() => void)[] = []
  private refreshScheduled = false
  /** 对话 → requestId → 显示侧车（DisplayDoc 的值；旁路与挂载时的快照合起来） */
  private readonly displayDocs = new Map<ConversationId, Map<string, DisplayItem>>()
  /** 对话 → requestId → 落下的条目（旁路的 submission 变化与挂载时的查询） */
  private readonly requestEntries = new Map<ConversationId, Map<string, EntryId>>()
  /** 还排着队的 submission → requestId（排队输入的显示侧车；落下 / 落定之后删掉） */
  private readonly queuedRequests = new Map<SubmissionId, string>()
  /** 带着中止标记的生成任务（运行结束的原因） */
  private readonly abortedTasks = new Set<TaskId>()
  /** 任务 → 它最后一条 assistant 条目的 stopReason */
  private readonly stopReasons = new Map<TaskId, string>()
  private readonly lifecycleListeners = new Set<RunLifecycleListener>()
  /** 挂着的对话上正在跟踪的运行 */
  private rootRun: TrackedRun | undefined
  /** 别的对话上正在跟踪的运行（派生 agent；换挂载之后还没结束的旧根运行） */
  private readonly otherRuns = new Map<ConversationId, TrackedRun>()

  protected constructor(host: ProjectorHost, options: ProjectorCoreOptions) {
    this.host = host
    this.options = options
  }

  // ─── 子类给出的 ─────────────────────────────

  /** 一帧（或刷新）的视图 */
  protected abstract project(mount: ProjectorMount, runState: RunViewState): V
  /** 此刻挂着的对话的运行状态 */
  protected abstract runStateOf(conversationId: ConversationId): RunViewState
  /** 旁路的额外处理（指针变化 → 换挂载等）；在通用记账之后调用 */
  protected onPublication(_publication: CommitPublication): void {
    // 缺省：没有额外处理
  }
  /** 是否跟踪别的对话（派生 agent）的运行生命周期 */
  protected get tracksOtherRuns(): boolean {
    return false
  }

  // ─── 公共 ─────────────────────────────────

  get disposed(): boolean {
    return this.disposedFlag
  }

  get value(): V {
    return this.requireState().value
  }

  acquire(): ProjectorHandle<V> {
    if (this.disposedFlag) throw new Error('This projector is disposed; acquire a new one')
    const state = this.requireState()
    this.refs++
    let released = false
    return {
      state,
      release: () => {
        if (released) return
        released = true
        this.refs--
        if (this.refs === 0) this.dispose()
      }
    }
  }

  onRunLifecycle(listener: RunLifecycleListener): () => void {
    const entry: RunLifecycleListener = (signal) => listener(signal)
    this.lifecycleListeners.add(entry)
    return () => {
      this.lifecycleListeners.delete(entry)
    }
  }

  /** 拆掉（幂等）：停 watch、摘旁路与各路订阅；状态保留最后的值 */
  dispose(): void {
    if (this.disposedFlag) return
    this.disposedFlag = true
    for (const unsubscribe of this.unsubscribers.splice(0)) {
      try {
        unsubscribe()
      } catch {
        /* 退订失败无所谓 */
      }
    }
    const mount = this.mount
    if (mount !== undefined) {
      mount.stale = true
      void mount.watch.stop().catch(() => undefined)
    }
    this.lifecycleListeners.clear()
    try {
      this.options.onDispose?.()
    } catch {
      /* 缓存清理不会失败 */
    }
  }

  // ─── 挂载 ─────────────────────────────────

  /** 先挂旁路（子类在调 `mountConversation` 之前调它），返回之后的发布都会被记下 */
  protected attachSideChannel(): void {
    this.unsubscribers.push(
      this.host.harness.subscribeCommits((publication) => this.sideChannel(publication))
    )
  }

  /** 登记一个退订函数（拆掉时调用） */
  protected own(unsubscribe: () => void): void {
    if (this.disposedFlag) {
      unsubscribe()
      return
    }
    this.unsubscribers.push(unsubscribe)
  }

  /**
   * 挂上一个对话：取 watch，再读它的 DisplayDoc 与 submission 落点（一个只读提交），返回挂载（还没开始
   * 收帧）。旁路必须已经挂好。
   */
  protected async attachConversation(conversationId: ConversationId): Promise<ProjectorMount> {
    const harness = this.host.harness
    const conversation = await harness.conversation(conversationId, BG)
    if (conversation === undefined) throw new Error(`Conversation ${conversationId} does not exist`)
    const watch = await conversation.watch(BG)
    try {
      const value = watch.value
      const snapshot = await harness.snapshot(DisplayDoc, conversationId, BG)
      const display = this.displayOf(conversationId)
      for (const [requestId, item] of Object.entries(snapshot?.items ?? {})) {
        const parsed = displayItemOf(item)
        // 旁路记下的更新（挂载途中的写入）优先
        if (parsed !== undefined && !display.has(requestId)) display.set(requestId, parsed)
      }
      const ancestorEntries = await this.lookupRequests(conversationId, value.entries, display)
      return { conversationId, watch, value, ancestorEntries, stale: false }
    } catch (error) {
      void watch.stop().catch(() => undefined)
      throw error
    }
  }

  /**
   * 显示侧车的落点（PIN-22）：每份侧车在当前对话、以及活上下文里出现过 `pi.user` 的每个祖先对话里各按
   * requestId 找一次 submission —— 与 `resolveDisplayItems` 同一判据（祖先里的条目必须在活上下文里）。
   * 当前对话的结果进旁路的表（之后的 submission 变化接着更新），还排着队的记下 submission id。
   */
  private async lookupRequests(
    conversationId: ConversationId,
    entries: readonly EntryRecord[],
    display: ReadonlyMap<string, DisplayItem>
  ): Promise<Map<string, EntryId>> {
    const ancestors = new Map<ConversationId, Set<EntryId>>()
    for (const entry of entries) {
      if (entry.kind !== UserEntry.kind || entry.conversationId === conversationId) continue
      let ids = ancestors.get(entry.conversationId)
      if (ids === undefined) {
        ids = new Set()
        ancestors.set(entry.conversationId, ids)
      }
      ids.add(entry.id)
    }
    const ancestorEntries = new Map<string, EntryId>()
    const requestIds = [...display.keys()]
    if (requestIds.length === 0) return ancestorEntries
    const own = this.requestEntriesOf(conversationId)
    await this.host.harness.commit(async (tx) => {
      for (const requestId of requestIds) {
        const record = await tx.submissionByRequest(conversationId, requestId)
        if (record !== undefined) {
          if (record.entry !== undefined) own.set(requestId, record.entry)
          else if (record.type === 'input' && record.status === 'queued') {
            this.queuedRequests.set(record.id, requestId)
          }
          continue
        }
        for (const [owner, ids] of ancestors) {
          const found = await tx.submissionByRequest(owner, requestId)
          if (found?.entry !== undefined && ids.has(found.entry)) {
            ancestorEntries.set(requestId, found.entry)
            break
          }
        }
      }
    }, BG)
    return ancestorEntries
  }

  /** 挂载就绪：建状态（第一份值）并开始收帧 */
  protected startMount(mount: ProjectorMount): void {
    this.mount = mount
    this.rootRun = this.initialRun(mount)
    this.stateRef = replicatedState(this.project(mount, this.runStateOf(mount.conversationId)))
    this.listen(mount)
  }

  /**
   * 换挂载（PIN-07）：新挂载的整份值以 `state.replace` 交出（一条 `["r"]`），条目 id 不变所以前缀的消息
   * 看起来没动。旧对话上发过 started、还没结束的运行转去旁路接着跟（成对，PIN-04）。
   */
  protected switchMount(mount: ProjectorMount): void {
    const previous = this.mount
    if (previous !== undefined) {
      previous.stale = true
      void previous.watch.stop().catch(() => undefined)
      const run = this.rootRun
      if (run?.emitted === true && previous.conversationId !== mount.conversationId) {
        this.otherRuns.set(previous.conversationId, run)
      }
    }
    this.mount = mount
    this.rootRun = this.initialRun(mount)
    const state = this.requireState()
    const next = this.project(mount, this.runStateOf(mount.conversationId))
    this.guard(() => state.replace(BG, next))
    this.listen(mount)
  }

  private listen(mount: ProjectorMount): void {
    mount.watch.start(async (value) => {
      this.onFrame(mount, value)
    })
  }

  /** 挂载时的运行：在跑的不补发；被中断的等继续之后补发 started（PIN-04） */
  private initialRun(mount: ProjectorMount): TrackedRun | undefined {
    const taskId = liveRunTask(mount.value.docs[LiveDoc.definition.kind])
    if (taskId === undefined) return undefined
    const state = this.runStateOf(mount.conversationId)
    return { taskId, emitted: false, resumable: state === 'interrupted' }
  }

  // ─── 帧与刷新 ───────────────────────────────

  private onFrame(mount: ProjectorMount, value: ConversationView): void {
    if (mount.stale || this.disposedFlag || mount !== this.mount) return
    try {
      const previous = mount.value
      mount.value = value
      const runState = this.runStateOf(mount.conversationId)
      this.revise(mount, runState)
      this.trackRootRun(mount, previous, value, runState)
    } catch (error) {
      this.host.logger.warn(
        `session ${this.host.sessionId}: ${ROOT_REVISION_FAILED}: ${errorText(error)}`
      )
    }
  }

  /** 重算一次（询问 / 运行状态变了，没有新的帧）：同步 */
  protected reviseNow(): void {
    const mount = this.mount
    if (mount === undefined || this.disposedFlag || this.stateRef === undefined) return
    try {
      this.revise(mount, this.runStateOf(mount.conversationId))
    } catch (error) {
      this.host.logger.warn(
        `session ${this.host.sessionId}: ${ROOT_REVISION_FAILED}: ${errorText(error)}`
      )
    }
  }

  /** 微任务里重算一次（同一时刻的多次请求合成一次） */
  protected scheduleRefresh(): void {
    if (this.refreshScheduled || this.disposedFlag) return
    this.refreshScheduled = true
    queueMicrotask(() => {
      this.refreshScheduled = false
      this.reviseNow()
    })
  }

  private revise(mount: ProjectorMount, runState: RunViewState): void {
    const state = this.requireState()
    const next = this.project(mount, runState)
    this.guard(() => state.change(BG, (draft) => reconcile(draft, next)))
  }

  /** 状态写入：下游监听器抛错（chord 收集后重抛）只记日志，状态本身已经更新（PIN-03 / PIN-12） */
  private guard(write: () => void): void {
    try {
      write()
    } catch (error) {
      this.host.logger.warn(
        `session ${this.host.sessionId}: projector listener failed: ${errorText(error)}`
      )
    }
  }

  private requireState(): MutableReplicatedState<V> {
    if (this.stateRef === undefined) throw new Error('The projector is not mounted yet')
    return this.stateRef
  }

  // ─── 显示侧车（投影输入） ───────────────────────

  private displayOf(conversationId: ConversationId): Map<string, DisplayItem> {
    let display = this.displayDocs.get(conversationId)
    if (display === undefined) {
      display = new Map()
      this.displayDocs.set(conversationId, display)
    }
    return display
  }

  private requestEntriesOf(conversationId: ConversationId): Map<string, EntryId> {
    let entries = this.requestEntries.get(conversationId)
    if (entries === undefined) {
      entries = new Map()
      this.requestEntries.set(conversationId, entries)
    }
    return entries
  }

  /** 条目 id → 显示侧车（投影只看活上下文里的 `pi.user`，多出来的键无害） */
  protected displayByEntry(mount: ProjectorMount): Map<number, DisplayItem> {
    const resolved = new Map<number, DisplayItem>()
    const display = this.displayDocs.get(mount.conversationId)
    if (display === undefined) return resolved
    const own = this.requestEntries.get(mount.conversationId)
    for (const [requestId, item] of display) {
      const entry = own?.get(requestId) ?? mount.ancestorEntries.get(requestId)
      if (entry !== undefined) resolved.set(entry, item)
    }
    return resolved
  }

  /** 排队输入 → 显示侧车（PIN-17 / PIN-22） */
  protected queueDisplay(
    mount: ProjectorMount,
    inbox: InboxState | undefined
  ): Map<number, DisplayItem> {
    const queued = new Map<number, DisplayItem>()
    const display = this.displayDocs.get(mount.conversationId)
    if (display === undefined || !Array.isArray(inbox?.items)) return queued
    for (const item of inbox.items) {
      const requestId = this.queuedRequests.get(item.id)
      const found = requestId === undefined ? undefined : display.get(requestId)
      if (found !== undefined) queued.set(item.id, found)
    }
    return queued
  }

  // ─── 旁路 ─────────────────────────────────

  /** 同步，在 Session 串行线上：只记账，不调任何会话操作，不写状态（PIN-03） */
  private sideChannel(publication: CommitPublication): void {
    if (this.disposedFlag) return
    try {
      for (const change of publication.changes) {
        if (change.type === 'submission') {
          const record = change.value
          if (record.requestId !== undefined) {
            if (record.entry !== undefined) {
              this.requestEntriesOf(record.conversationId).set(record.requestId, record.entry)
            }
            if (record.type === 'input' && record.status === 'queued') {
              this.queuedRequests.set(record.id, record.requestId)
            } else {
              this.queuedRequests.delete(record.id)
            }
          }
        } else if (change.type === 'task') {
          const record = change.value
          if (record.abortRequested) this.abortedTasks.add(record.id)
        } else if (change.type === 'entry') {
          const entry = change.value
          if (entry.kind === AssistantEntry.kind && entry.byTaskId !== undefined) {
            const message = entry.model?.[0]
            if (message?.role === 'assistant')
              this.stopReasons.set(entry.byTaskId, message.stopReason)
          }
        } else if (change.type === 'document' && change.conversationId !== undefined) {
          if (change.record.key !== undefined) continue
          const kind = change.record.kind
          if (kind === DisplayDoc.definition.kind) {
            const display = this.displayOf(change.conversationId)
            const items = isRecord(change.value) ? change.value.items : undefined
            if (isRecord(items)) {
              for (const [requestId, item] of Object.entries(items)) {
                const parsed = displayItemOf(item)
                if (parsed !== undefined) display.set(requestId, parsed)
              }
            }
          } else if (kind === LiveDoc.definition.kind) {
            this.observeOtherLive(change.conversationId, change.value, change.ops)
          }
        }
      }
      this.onPublication(publication)
    } catch (error) {
      this.host.logger.warn(
        `session ${this.host.sessionId}: projector side channel failed: ${errorText(error)}`
      )
    }
  }

  // ─── 运行生命周期 ─────────────────────────────

  /** 根对话（挂着的那个）：相邻两帧之间 `pi.live.run` 的出现 / 消失 */
  private trackRootRun(
    mount: ProjectorMount,
    previous: ConversationView,
    next: ConversationView,
    runState: RunViewState
  ): void {
    const before = liveRunTask(previous.docs[LiveDoc.definition.kind])
    const after = liveRunTask(next.docs[LiveDoc.definition.kind])
    const conversationId = mount.conversationId
    const run = this.rootRun
    if (after === undefined) {
      if (run === undefined) return
      this.rootRun = undefined
      if (run.emitted) this.emitEnded(conversationId, run)
      return
    }
    if (run === undefined) {
      // 出现：会话在跑 → started；否则（理论上不会）只跟着、不发
      const emitted = before === undefined && runState === 'busy'
      this.rootRun = { taskId: after, emitted, resumable: false }
      if (emitted) this.emitStarted(conversationId, after, undefined)
      return
    }
    // 交接：run 一直在，换了任务 → 什么都不发，跟着新任务
    run.taskId = after
    // 继续：被中断时挂上的那一轮，调度器开了且没被中止 → 补发 started（PIN-04）
    if (!run.emitted && run.resumable && runState === 'busy' && !this.abortedTasks.has(after)) {
      run.emitted = true
      run.resumable = false
      this.emitStarted(conversationId, after, undefined)
    }
  }

  /**
   * 别的对话的 `pi.live` 变化（旁路，同步）：派生 agent 的运行出现 / 消失；换挂载之后旧根上还没结束的那轮
   * 照样跟到结束。出现 = 这次变化把 `run` 设上（或文档整份出现时带着 run）—— 中途的更新不算，所以挂载
   * 之前就在跑的运行不会凭空发 started。
   */
  private observeOtherLive(
    conversationId: ConversationId,
    value: JsonObject | null,
    ops: readonly unknown[]
  ): void {
    if (this.mount?.conversationId === conversationId) return
    const taskId = liveRunTask(value)
    const tracked = this.otherRuns.get(conversationId)
    if (tracked !== undefined) {
      if (taskId === undefined) {
        this.otherRuns.delete(conversationId)
        if (tracked.emitted) this.emitEnded(conversationId, tracked)
      } else {
        tracked.taskId = taskId
      }
      return
    }
    if (!this.tracksOtherRuns || taskId === undefined) return
    const agentId = this.host.agentIdOf(conversationId)
    if (agentId === undefined) return
    const appeared =
      ops.length === 0 ||
      ops.some(
        (op) =>
          Array.isArray(op) &&
          (op[0] === 'r' ||
            (op[0] === 's' && Array.isArray(op[1]) && op[1].length === 1 && op[1][0] === 'run'))
      )
    if (!appeared) return
    const emitted = this.host.conversationRunState(conversationId) === 'busy'
    this.otherRuns.set(conversationId, { taskId, emitted, resumable: false, agentId })
    if (emitted) this.emitStarted(conversationId, taskId, agentId)
  }

  /** 结束原因（PIN-05）：任务带中止标记 → aborted；否则看它最后一条 assistant 的 stopReason */
  private endReason(taskId: TaskId): RunEndReason {
    if (this.abortedTasks.has(taskId)) return 'aborted'
    const stopReason = this.stopReasons.get(taskId)
    if (stopReason === 'error') return 'error'
    if (stopReason === 'aborted') return 'aborted'
    return 'ok'
  }

  private emitStarted(
    conversationId: ConversationId,
    taskId: TaskId,
    agentId: string | undefined
  ): void {
    this.deliver({
      kind: 'started',
      sessionId: this.host.sessionId,
      conversationId,
      taskId,
      ...(agentId === undefined ? {} : { agentId })
    })
  }

  private emitEnded(conversationId: ConversationId, run: TrackedRun): void {
    const reason = this.endReason(run.taskId)
    this.abortedTasks.delete(run.taskId)
    this.stopReasons.delete(run.taskId)
    this.deliver({
      kind: 'ended',
      sessionId: this.host.sessionId,
      conversationId,
      taskId: run.taskId,
      ...(run.agentId === undefined ? {} : { agentId: run.agentId }),
      reason
    })
  }

  /** 帧 / 发布之后的微任务里送出；监听器各自隔离（PIN-04） */
  private deliver(signal: RunLifecycleSignal): void {
    queueMicrotask(() => {
      if (this.host.closed) return
      for (const listener of [...this.lifecycleListeners]) {
        try {
          listener(signal)
        } catch (error) {
          this.host.logger.warn(
            `session ${this.host.sessionId}: run lifecycle listener failed: ${errorText(error)}`
          )
        }
      }
    })
  }
}

// ─────────────────────────── SessionProjector ───────────────────────────

export class SessionProjectorImpl extends ProjectorCore<SessionView> implements SessionProjector {
  readonly sessionId: string
  /** 换挂载在途（指针又变了就再来一次） */
  private remounting: Promise<void> | undefined
  private remountAgain = false
  /** 旁路最近看到的指针值（没看到过 = undefined） */
  private lastPointer: number | undefined

  constructor(host: ProjectorHost, options: ProjectorCoreOptions = {}) {
    super(host, options)
    this.sessionId = host.sessionId
  }

  protected override get tracksOtherRuns(): boolean {
    return true
  }

  /** 挂载（PIN-01）：旁路 → 询问 / 运行状态 → 当前对话 → watch → 侧车；全部就绪才落定 */
  async start(): Promise<void> {
    this.attachSideChannel()
    this.own(
      this.host.subscribeInputs({
        onRequest: () => this.reviseNow(),
        onResolved: () => this.reviseNow()
      })
    )
    this.own(this.host.onRunStateChange(() => this.scheduleRefresh()))
    const conversationId = await this.host.currentConversationId()
    const mount = await this.attachConversation(conversationId)
    if (this.disposed) {
      void mount.watch.stop().catch(() => undefined)
      throw new Error(`Session ${this.sessionId} closed while its projector was mounting`)
    }
    this.startMount(mount)
  }

  protected project(mount: ProjectorMount, runState: RunViewState): SessionView {
    const { entries, docs } = mount.value
    const inbox = docs['pi.inbox'] as InboxState | undefined
    return projectSessionView(
      { sessionId: this.sessionId, conversationId: mount.conversationId },
      entries,
      docs[LiveDoc.definition.kind] as LiveState | undefined,
      inbox,
      this.displayByEntry(mount),
      this.host.pendingInputs(),
      runState,
      this.queueDisplay(mount, inbox)
    )
  }

  protected runStateOf(): RunViewState {
    return this.host.runState
  }

  /** 指针变了（回退 fork 之后）→ 微任务里换挂载 */
  protected override onPublication(publication: CommitPublication): void {
    for (const change of publication.changes) {
      if (
        change.type !== 'document' ||
        change.record.kind !== SessionStateDoc.definition.kind ||
        change.value === null
      ) {
        continue
      }
      // 只在指针本身变了时才去换（锁、日期、driven 标记的写入也带着整份文档发布）
      const pointer = (change.value as SessionState).currentConversation ?? 1
      if (pointer === this.lastPointer) continue
      this.lastPointer = pointer
      if (pointer !== this.mount?.conversationId) this.requestRemount()
    }
  }

  private requestRemount(): void {
    if (this.disposed) return
    if (this.remounting !== undefined) {
      this.remountAgain = true
      return
    }
    this.remounting = (async () => {
      try {
        do {
          this.remountAgain = false
          await this.remountOnce()
        } while (this.remountAgain && !this.disposed)
      } catch (error) {
        if (!this.disposed && !this.host.closed) {
          this.host.logger.warn(
            `session ${this.sessionId}: projector remount failed: ${errorText(error)}`
          )
        }
      } finally {
        this.remounting = undefined
      }
    })()
  }

  private async remountOnce(): Promise<void> {
    if (this.disposed || this.host.closed) return
    // R11：指向不存在的对话 → 根（DurableSession 记警告）；与此刻挂着的相同就不换
    const conversationId = await this.host.currentConversationId()
    if (this.disposed || conversationId === this.mount?.conversationId) return
    const mount = await this.attachConversation(conversationId)
    if (this.disposed) {
      void mount.watch.stop().catch(() => undefined)
      return
    }
    this.switchMount(mount)
  }
}
