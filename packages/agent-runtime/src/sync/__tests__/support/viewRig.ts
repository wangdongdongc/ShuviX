/**
 * 视图服务端（`viewServer`）用例的夹具（pi 1.2 / chord2）：
 *
 *  - **假会话宿主** `fakeViewHost()`：一个 `SyncHubHost` + 一组控制口。会话（`FakeSession`）的根投影器与派生 agent
 *    投影器都是 {@link FakeProjector}（真的 chord `replicatedState` 上的引用计数 `acquire()`）。`peek` 记调用、记
 *    peek 那一刻服务端有没有钉住它（`pinnedAtPeek`）；可以挂住（`deferPeek`）、让它失败（`failPeek`）、在 peek
 *    里同步报打开（`peekFiresOpened`，与 SessionHost 一样）。开 / 关钩子由用例手动触发（`opened` / `closed`）。
 *  - **假投影器** `FakeProjector`：`acquire` / `release` 记进共享的 `log`（`acquire:<id>` / `release:<id>`），最后一个
 *    租约还掉时停用（保留最后的值）；`change` / `stream.*` 模拟流式写入。
 *  - **带窃听的链路对** `tappedLinkPair()`：两条 `FrameLink`，帧 JSON 往返、在微任务里送达，两个方向都记下来，
 *    可以暂停 / 恢复送达。
 *  - **裸的 chord 客户端** `rawClient(server, principal)`：一条窃听链路上的 chord 客户端宿主，`get(target)` 交回一个
 *    记下全部值 / 事件 / 可用性 / 状态的 {@link TestView}。
 */
import {
  createHost,
  type Frame,
  type Handle,
  type HandleStatus,
  type Host,
  type LinkOptions,
  type MutableReplicatedState,
  replicatedState
} from '@earendil-works/chord'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Draft } from '@earendil-works/chord'
import type { SyncTarget } from '@shuvix/chat-protocol/sync'
import type { AssistantMessage } from '@shuvix/chat-protocol/types/chatMessage'
import {
  emptySessionView,
  type AgentView,
  type SessionView
} from '@shuvix/chat-protocol/types/sessionView'
import type { LegacyTranscript } from '../../services'
import {
  createViewServer,
  type SyncAgentRef,
  type SyncHubHost,
  type SyncSession,
  type SyncSessionClosedReason,
  type ViewLease,
  type ViewPrincipal,
  type ViewProjector,
  type ViewServer,
  type ViewServerDeps
} from '../../viewServer'
import {
  AgentViewContract,
  FrameLink,
  SessionViewContract,
  VIEW_SERVER_HOST,
  type ViewAvailability
} from '../../viewContracts'

export const BG = BACKGROUND_CONTEXT

export function json<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T)
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 等微任务 / 宏任务都跑完几轮（链路在微任务里送达，chord 的任务也是） */
export async function settle(rounds = 8): Promise<void> {
  for (let index = 0; index < rounds; index++) await sleep(0)
}

/** 轮询直到 `check` 给出非 undefined / false 的值；超时抛错 */
export async function until<T>(
  check: () => T | undefined | false | null,
  what: string,
  timeoutMs = 3000
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = check()
    if (value !== undefined && value !== false && value !== null) return value
    if (Date.now() > deadline) throw new Error(`timeout: ${what}`)
    await sleep(2)
  }
}

// ─── 视图 ──────────────────────────────────────────────

/** durable 会话的初值 */
export function durableView(sessionId: string): SessionView {
  return {
    ...emptySessionView(sessionId),
    source: 'durable',
    capabilities: { send: true, rollback: true, continue: true },
    conversationId: 1
  }
}

export function agentView(agentId: string, sessionId: string, conversationId: number): AgentView {
  return {
    v: 1,
    agentId,
    sessionId,
    conversationId,
    messages: [],
    live: null,
    toolRuns: {},
    run: { state: 'idle' },
    context: { usedTokens: null }
  }
}

type ViewWithLive = SessionView | AgentView

function assistant(sessionId: string, id: string, text: string): AssistantMessage {
  return {
    id,
    sessionId,
    role: 'assistant',
    type: 'message',
    content: text,
    model: 'faux-1',
    createdAt: 1,
    blocks: [{ type: 'text', text }],
    metadata: null
  }
}

/** 模拟流式（像真投影器那样逐字段写：增长的字符串 → append op） */
export const stream = {
  start<V extends ViewWithLive>(state: MutableReplicatedState<V>, taskId = 't1'): void {
    state.change(BG, (draft) => {
      const view = draft as unknown as ViewWithLive
      view.run = { state: 'busy' }
      view.live = { id: `live:${taskId}`, message: assistant(view.sessionId, `live:${taskId}`, '') }
    })
  },
  append<V extends ViewWithLive>(state: MutableReplicatedState<V>, text: string): void {
    state.change(BG, (draft) => {
      const live = (draft as unknown as ViewWithLive).live!
      live.message.content += text
      const block = live.message.blocks[0] as { type: 'text'; text: string }
      block.text += text
    })
  },
  commit<V extends ViewWithLive>(state: MutableReplicatedState<V>, entryId: number): void {
    state.change(BG, (draft) => {
      const view = draft as unknown as ViewWithLive
      const text = view.live?.message.content ?? ''
      view.messages.push(assistant(view.sessionId, String(entryId), text))
      view.live = null
      view.run = { state: 'idle' }
    })
  },
  /** 一轮完整的回答：开卡、逐段追加、落盘 */
  answer<V extends ViewWithLive>(
    state: MutableReplicatedState<V>,
    parts: readonly string[],
    entryId: number
  ): void {
    stream.start(state, `t${entryId}`)
    for (const part of parts) stream.append(state, part)
    stream.commit(state, entryId)
  }
}

// ─── 假投影器 ──────────────────────────────────────────

let projectorSeq = 0

/** 引用计数的投影器：最后一个租约还掉时停用（保留最后的值）；acquire / release 记进共享的 `log` */
export class FakeProjector<V extends object> implements ViewProjector<V> {
  readonly id: string
  readonly state: MutableReplicatedState<V>
  refs = 0
  acquires = 0
  disposed = false
  /** 下一次 acquire 抛这个错 */
  failAcquire: Error | undefined

  constructor(
    label: string,
    initial: V,
    private readonly log: string[],
    private readonly onDispose?: (last: V) => void
  ) {
    this.id = `${label}#${++projectorSeq}`
    this.state = replicatedState(json(initial))
  }

  get value(): V {
    return this.state.value
  }

  acquire(): ViewLease<V> {
    if (this.failAcquire !== undefined) {
      const error = this.failAcquire
      this.failAcquire = undefined
      throw error
    }
    if (this.disposed) throw new Error(`acquire on a disposed projector ${this.id}`)
    this.refs++
    this.acquires++
    this.log.push(`acquire:${this.id}`)
    let released = false
    return {
      state: this.state,
      release: () => {
        if (released) return
        released = true
        this.refs--
        this.log.push(`release:${this.id}`)
        if (this.refs === 0) this.dispose()
      }
    }
  }

  /** 一次修订 */
  change(mutate: (draft: Draft<V>) => void): void {
    this.state.change(BG, mutate)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.onDispose?.(this.state.value)
  }
}

// ─── 假会话 ────────────────────────────────────────────

interface Pending<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function pending<T>(): Pending<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** 一条（打开着的）会话实例：根投影器 + 认识的派生 agent */
export class FakeSession implements SyncSession {
  #root: FakeProjector<SessionView> | undefined
  #last: SessionView
  readonly #agents = new Map<string, FakeProjector<AgentView>>()
  /** 认识的派生 agent → 它的初值（停用之后的新投影器从最后的值起） */
  readonly #agentLast = new Map<string, AgentView>()
  projectorCalls = 0
  readonly agentProjectorCalls: string[] = []
  #deferProjector: Pending<void> | undefined
  #failProjector: unknown
  #failAgentProjector: unknown

  constructor(
    readonly sessionId: string,
    initial: SessionView,
    readonly log: string[]
  ) {
    this.#last = json(initial)
  }

  /** 当前（未停用）的根投影器；没有就新建一个（初值 = 上一个的最后值） */
  get root(): FakeProjector<SessionView> {
    if (this.#root === undefined || this.#root.disposed) {
      this.#root = new FakeProjector<SessionView>(
        `root:${this.sessionId}`,
        this.#last,
        this.log,
        (last) => {
          this.#last = last
        }
      )
    }
    return this.#root
  }

  /** 此刻的根投影器（不新建） */
  currentRoot(): FakeProjector<SessionView> | undefined {
    return this.#root === undefined || this.#root.disposed ? undefined : this.#root
  }

  /** 这条会话认识一个派生 agent */
  addAgent(agentId: string, view?: AgentView): void {
    this.#agentLast.set(agentId, json(view ?? agentView(agentId, this.sessionId, 2)))
  }

  knowsAgent(agentId: string): boolean {
    return this.#agentLast.has(agentId)
  }

  /** 某个派生 agent 当前（未停用）的投影器；没有就新建 */
  agent(agentId: string): FakeProjector<AgentView> {
    const current = this.#agents.get(agentId)
    if (current !== undefined && !current.disposed) return current
    const initial = this.#agentLast.get(agentId) ?? agentView(agentId, this.sessionId, 2)
    const projector = new FakeProjector<AgentView>(
      `agent:${agentId}`,
      initial,
      this.log,
      (last) => {
        this.#agentLast.set(agentId, last)
      }
    )
    this.#agents.set(agentId, projector)
    return projector
  }

  /** 认识的派生 agent（初值，供 reopen 复制） */
  agentSnapshots(): Map<string, AgentView> {
    for (const [agentId, projector] of this.#agents) {
      if (!projector.disposed) this.#agentLast.set(agentId, projector.value)
    }
    return new Map(this.#agentLast)
  }

  /** 最后的根视图（停用的也算） */
  lastRoot(): SessionView {
    return this.#root !== undefined && !this.#root.disposed ? this.#root.value : this.#last
  }

  /** 下一次 projector() 挂住，直到 resolve / reject */
  deferProjector(): { resolve(): void; reject(error: unknown): void } {
    const gate = pending<void>()
    this.#deferProjector = gate
    return { resolve: () => gate.resolve(), reject: (error) => gate.reject(error) }
  }

  /** 下一次 projector() 拒绝 */
  failProjector(error: unknown = new Error('projector failed')): void {
    this.#failProjector = error
  }

  /** 下一次 agentProjector() 拒绝 */
  failAgentProjector(error: unknown = new Error('agent projector failed')): void {
    this.#failAgentProjector = error
  }

  async projector(): Promise<ViewProjector<SessionView>> {
    this.projectorCalls++
    const gate = this.#deferProjector
    this.#deferProjector = undefined
    if (gate !== undefined) await gate.promise
    else await Promise.resolve()
    if (this.#failProjector !== undefined) {
      const error = this.#failProjector
      this.#failProjector = undefined
      throw error
    }
    return this.root
  }

  async agentProjector(agent: SyncAgentRef): Promise<ViewProjector<AgentView> | undefined> {
    this.agentProjectorCalls.push(agent.agentId)
    await Promise.resolve()
    if (this.#failAgentProjector !== undefined) {
      const error = this.#failAgentProjector
      this.#failAgentProjector = undefined
      throw error
    }
    if (!this.#agentLast.has(agent.agentId)) return undefined
    return this.agent(agent.agentId)
  }

  /** 会话关闭：停用它的全部投影器（与真会话一样，P3-03-47） */
  disposeAll(): void {
    this.#root?.dispose()
    for (const projector of this.#agents.values()) projector.dispose()
  }
}

// ─── 假会话宿主 ────────────────────────────────────────

export interface FakeViewHostOptions {
  /** peek 里同步报打开（SessionHost 就是这样：peek 打开一条会话 → 钩子报打开） */
  readonly peekFiresOpened?: boolean
}

export interface FakeViewHost extends SyncHubHost {
  sealed: boolean
  /** acquire / release 的记录（所有投影器共用） */
  readonly log: string[]
  /** peek 的调用（按次序） */
  readonly peeks: string[]
  /** peek 那一刻服务端有没有钉住这条会话（最后一次） */
  readonly pinnedAtPeek: Record<string, boolean>
  /** legacyView 的调用 */
  readonly legacyCalls: string[]
  /** resolveAgent 的调用 */
  readonly resolveCalls: string[]
  /** 服务端（建好之后挂上，`pinnedAtPeek` 读它） */
  server: ViewServer | undefined
  /** 有存储的会话（新建一个实例；同 id 的旧实例被换掉） */
  add(sessionId: string, view?: SessionView): FakeSession
  /** 同一条会话重新打开：新实例，初值 = 旧实例的最后值，认识的 agent 照搬 */
  reopen(sessionId: string): FakeSession
  /** 此刻的会话实例 */
  session(sessionId: string): FakeSession | undefined
  /** 派生 agent：resolveAgent 认得它（→ 根会话），根会话认得它 */
  addAgent(agentId: string, rootId: string, view?: AgentView, conversationId?: number): void
  /** 旧格式会话 */
  legacy(sessionId: string, transcript: LegacyTranscript): void
  /** 下一次 peek(id) 挂住，直到 resolve（会话或 undefined）/ reject */
  deferPeek(sessionId: string): {
    resolve(session?: FakeSession | undefined): void
    reject(error: unknown): void
  }
  /** 下一次 peek(id) 拒绝 */
  failPeek(sessionId: string, error?: unknown): void
  /** 报打开（id → 此刻的实例） */
  opened(session: string | SyncSession): void
  /** 报关闭（destroy = 存储没了：实例从表里拿掉）；会话的投影器一并停用 */
  closed(sessionId: string, reason: SyncSessionClosedReason): void
  /** 开 / 关钩子上此刻登记的监听器数 */
  listenerCount(): number
  /** 服务端要的接缝 */
  readonly resolveAgent: NonNullable<ViewServerDeps['resolveAgent']>
  readonly legacyView: NonNullable<ViewServerDeps['legacyView']>
}

export function fakeViewHost(options: FakeViewHostOptions = {}): FakeViewHost {
  const log: string[] = []
  const peeks: string[] = []
  const pinnedAtPeek: Record<string, boolean> = {}
  const legacyCalls: string[] = []
  const resolveCalls: string[] = []
  const sessions = new Map<string, FakeSession>()
  const agents = new Map<string, { sessionId: string; conversationId: number }>()
  const legacies = new Map<string, LegacyTranscript>()
  const deferred = new Map<string, Pending<FakeSession | undefined>>()
  const failures = new Map<string, unknown>()
  const openedListeners = new Set<(session: SyncSession) => void>()
  const closedListeners = new Set<(sessionId: string, reason: SyncSessionClosedReason) => void>()

  const fireOpened = (session: SyncSession): void => {
    for (const listener of [...openedListeners]) listener(session)
  }

  const host: FakeViewHost = {
    sealed: false,
    log,
    peeks,
    pinnedAtPeek,
    legacyCalls,
    resolveCalls,
    server: undefined,
    async peek(sessionId) {
      peeks.push(sessionId)
      pinnedAtPeek[sessionId] = host.server?.hasSubscribers(sessionId) ?? false
      let result: FakeSession | undefined
      const gate = deferred.get(sessionId)
      if (gate !== undefined) {
        deferred.delete(sessionId)
        result = await gate.promise
      } else {
        await Promise.resolve()
        if (failures.has(sessionId)) {
          const error = failures.get(sessionId)
          failures.delete(sessionId)
          throw error
        }
        if (host.sealed) return undefined
        result = sessions.get(sessionId)
      }
      if (result !== undefined && options.peekFiresOpened === true) fireOpened(result)
      return result
    },
    onSessionOpened(listener) {
      openedListeners.add(listener)
      return () => openedListeners.delete(listener)
    },
    onSessionClosed(listener) {
      closedListeners.add(listener)
      return () => closedListeners.delete(listener)
    },
    add(sessionId, view) {
      const session = new FakeSession(sessionId, view ?? durableView(sessionId), log)
      sessions.set(sessionId, session)
      return session
    },
    reopen(sessionId) {
      const previous = sessions.get(sessionId)
      const session = new FakeSession(
        sessionId,
        previous?.lastRoot() ?? durableView(sessionId),
        log
      )
      for (const [agentId, view] of previous?.agentSnapshots() ?? [])
        session.addAgent(agentId, view)
      sessions.set(sessionId, session)
      return session
    },
    session: (sessionId) => sessions.get(sessionId),
    addAgent(agentId, rootId, view, conversationId = 2) {
      agents.set(agentId, { sessionId: rootId, conversationId })
      sessions.get(rootId)?.addAgent(agentId, view ?? agentView(agentId, rootId, conversationId))
    },
    legacy(sessionId, transcript) {
      legacies.set(sessionId, transcript)
    },
    deferPeek(sessionId) {
      const gate = pending<FakeSession | undefined>()
      deferred.set(sessionId, gate)
      return { resolve: (session) => gate.resolve(session), reject: (error) => gate.reject(error) }
    },
    failPeek(sessionId, error = new Error(`peek ${sessionId} failed`)) {
      failures.set(sessionId, error)
    },
    opened(session) {
      const instance = typeof session === 'string' ? sessions.get(session) : session
      if (instance === undefined) throw new Error(`fakeViewHost: no session ${String(session)}`)
      fireOpened(instance)
    },
    closed(sessionId, reason) {
      const session = sessions.get(sessionId)
      session?.disposeAll()
      if (reason === 'destroy') sessions.delete(sessionId)
      for (const listener of [...closedListeners]) listener(sessionId, reason)
    },
    listenerCount: () => openedListeners.size + closedListeners.size,
    resolveAgent: (agentId) => {
      resolveCalls.push(agentId)
      return agents.get(agentId)
    },
    legacyView: (sessionId) => {
      legacyCalls.push(sessionId)
      return legacies.get(sessionId)
    }
  }
  return host
}

/** 日志记录器：`warn: …` / `error: …` */
export function recordingLogger(): {
  readonly logs: string[]
  readonly logger: NonNullable<ViewServerDeps['logger']>
} {
  const logs: string[] = []
  return {
    logs,
    logger: {
      info: () => {},
      warn: (message) => logs.push(`warn: ${message}`),
      error: (message) => logs.push(`error: ${message}`)
    }
  }
}

/** 建服务端（缺省接上假宿主的 legacyView / resolveAgent），挂回 `host.server` */
export function serverFor(
  host: FakeViewHost,
  extra: Partial<Omit<ViewServerDeps, 'host'>> = {}
): ViewServer {
  const server = createViewServer({
    host,
    legacyView: host.legacyView,
    resolveAgent: host.resolveAgent,
    ...extra
  })
  host.server = server
  return server
}

// ─── 带窃听的链路对 ────────────────────────────────────

export type TapDirection = 'up' | 'down'

export interface TapRecord {
  /** up = 客户端 → 服务端，down = 服务端 → 客户端 */
  readonly dir: TapDirection
  readonly frame: Frame
}

export interface TappedPair {
  /** 服务端这头（交给 `accept`） */
  readonly server: FrameLink
  /** 客户端这头（交给 `connect`） */
  readonly client: FrameLink
  /** 两个方向发出的每一帧（发出那一刻记，JSON 拷贝） */
  readonly frames: TapRecord[]
  /** 暂停送达（帧攒着）；缺省两个方向 */
  pause(dir?: TapDirection | 'both'): void
  /** 恢复送达（攒着的按序送出） */
  resume(): void
  /** 之后服务端 → 客户端的发送一律抛错（传输坏了：服务端那条 FrameLink 随之以 `transport error` 结束） */
  breakDown(): void
}

export function tappedLinkPair(tap?: (dir: TapDirection, frame: Frame) => void): TappedPair {
  const frames: TapRecord[] = []
  const paused = { up: false, down: false }
  const held: TapRecord[] = []
  let brokenDown = false
  // 两条链路互相引用：`target` / `send` 只在构造之后才被调用
  // eslint-disable-next-line prefer-const -- 先声明、两条都建好再赋值
  let server: FrameLink | undefined
  // eslint-disable-next-line prefer-const -- 同上
  let client: FrameLink | undefined
  const target = (dir: TapDirection): FrameLink => (dir === 'up' ? server! : client!)
  const send = (dir: TapDirection, frame: Frame): void => {
    if (dir === 'down' && brokenDown) throw new Error('transport broken')
    const copy = json(frame)
    frames.push({ dir, frame: copy })
    tap?.(dir, copy)
    queueMicrotask(() => {
      if (paused[dir] || held.some((entry) => entry.dir === dir)) {
        held.push({ dir, frame: copy })
        return
      }
      target(dir).deliver(json(copy))
    })
  }
  server = new FrameLink((frame) => send('down', frame))
  client = new FrameLink((frame) => send('up', frame))
  return {
    server: server!,
    client: client!,
    frames,
    pause(dir = 'both') {
      if (dir === 'both' || dir === 'up') paused.up = true
      if (dir === 'both' || dir === 'down') paused.down = true
    },
    resume() {
      paused.up = false
      paused.down = false
      for (const entry of held.splice(0)) target(entry.dir).deliver(json(entry.frame))
    },
    breakDown() {
      brokenDown = true
    }
  }
}

// ─── 裸的 chord 客户端 ─────────────────────────────────

type ViewHandle = Handle<typeof SessionViewContract> | Handle<typeof AgentViewContract>

/** 一个目标的句柄 + 它的全部记录 */
export interface TestView<V = SessionView | AgentView> {
  readonly target: SyncTarget
  readonly handle: ViewHandle
  /** view.subscribe 交来的每个值（含开头的 undefined） */
  readonly views: (V | undefined)[]
  /** view.events 的事件种类（snap / reset / ops） */
  readonly events: string[]
  /** availability.subscribe 交来的每个值 */
  readonly availability: (ViewAvailability | undefined)[]
  /** onStatus 报的每个状态 */
  readonly statuses: HandleStatus[]
  status(): HandleStatus
  error(): unknown
  /** 句柄此刻的视图值 */
  value(): V | undefined
  /** 句柄此刻的可用性 */
  avail(): ViewAvailability | undefined
  /** 交来过的非 undefined 值 */
  values(): V[]
  /** ready 落定：失败 → 错误，成功 → undefined */
  settled(): Promise<unknown>
  release(): void
}

export interface RawClient {
  readonly host: Host
  readonly pair: TappedPair
  readonly principal: ViewPrincipal
  get<V = SessionView>(target: SyncTarget): TestView<V>
  /** 服务端发来的帧（down） */
  down(): Frame[]
  /** 客户端发出的帧（up） */
  up(): Frame[]
  close(): Promise<void>
}

let rawSeq = 0

/** 一条窃听链路上的 chord 客户端宿主（服务端 `accept` 它，主体由这里给） */
export function rawClient(
  server: ViewServer,
  principal: ViewPrincipal,
  options: { upstreamOptions?: LinkOptions } = {}
): RawClient {
  const pair = tappedLinkPair()
  server.accept(pair.server, principal)
  const host = createHost({ name: `raw-client-${++rawSeq}`, kind: 'client', onError: () => {} })
  host.connect(pair.client, options.upstreamOptions)
  return {
    host,
    pair,
    principal,
    get<V = SessionView>(target: SyncTarget): TestView<V> {
      const handle: ViewHandle =
        target.kind === 'session'
          ? host.get(SessionViewContract, { sessionId: target.sessionId }, { at: VIEW_SERVER_HOST })
          : host.get(AgentViewContract, { agentId: target.agentId }, { at: VIEW_SERVER_HOST })
      const settled = handle.ready.then(
        () => undefined,
        (error: unknown) => error
      )
      const views: (V | undefined)[] = []
      const events: string[] = []
      const availability: (ViewAvailability | undefined)[] = []
      const statuses: HandleStatus[] = []
      const stops = [
        handle.view.subscribe((value) => views.push(value as V | undefined)),
        handle.view.events((event) => events.push(event.type)),
        handle.availability.subscribe((value) => availability.push(value)),
        handle.onStatus((status) => statuses.push(status))
      ]
      let released = false
      return {
        target,
        handle,
        views,
        events,
        availability,
        statuses,
        status: () => handle.status,
        error: () => handle.error,
        value: () => handle.view.value as V | undefined,
        avail: () => handle.availability.value,
        values: () => views.filter((value): value is V => value !== undefined),
        settled: () => settled,
        release: () => {
          if (released) return
          released = true
          for (const stop of stops) stop()
          handle.release()
        }
      }
    },
    down: () => pair.frames.filter((r) => r.dir === 'down').map((r) => r.frame),
    up: () => pair.frames.filter((r) => r.dir === 'up').map((r) => r.frame),
    close: () => host.close()
  }
}

/** 帧里带视图值的 state 帧（快照 / 重置 / 增量） */
export function isViewStateFrame(frame: Frame): boolean {
  return (
    frame.t === 'state' &&
    ((frame as { snap?: unknown }).snap !== undefined ||
      (frame as { reset?: unknown }).reset !== undefined ||
      (frame as { ops?: unknown }).ops !== undefined)
  )
}

export type { ViewHandle }
