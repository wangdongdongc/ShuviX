/**
 * 桌面单测用的假会话运行时：FakeDurableSession（实现 DurableSession）与 FakeSessionHost（实现 SessionHost）。
 *
 *  - FakeDurableSession：可设的 `lock` / busy / interrupted / 挂起询问；submitUser / steer / followUp /
 *    continue / resumeInterrupted 的结果按脚本给（缺省 `{}`），requestState / lastAnswer / drivenRun /
 *    taskLiveness 也按脚本给；`destroyAgent` / `abort` 可挂闸门；`rollbackTo` 按 `rollbackResult` 给（P3-10a）；
 *    每次调用记进 `calls`。
 *    P2-10 的脚本：`submitUser` 带一个脚本里认得的 requestId（'pending' / 'settled'）= 重新挂上 —— 不调
 *    受理回调（P2-09 PIN-02）；`resumeInterrupted` 在被中断时把它变成在跑（interrupted=false, busy=true）；
 *    `abort` 把 busy / interrupted 都清掉（被中断的那一轮随之落定）。
 *    `lockOnFirstUse` 模拟 K3：第一次 submitUser / steer / followUp / continue / createAgent 时上锁。
 *  - FakeSessionHost：open / peek / get / close / closeAll / delete；`storages` 是「存储在」的会话集合
 *    （peek 只打开它们，open 会建）；`delete` 可挂闸门；调用记进 `calls`。
 *
 * 模块级的 `fakeHost` 给 `vi.mock('../sessionHost')` 用（`sessionHostModuleMock()`）；`resetFakeHost()`
 * 每个用例前换一个新的。
 */
import { vi } from 'vitest'
import type {
  AdmitResult,
  AgentIdentity,
  AgentProjector,
  CreateAgentOptions,
  DrivenRun,
  DurableSession,
  LastAnswer,
  LockRecord,
  NoticeInput,
  NoticeResult,
  NotifyOptions,
  PendingInputHooks,
  RequestState,
  RollbackOptions,
  RollbackResult,
  RunState,
  SessionHost,
  SessionProjector,
  SpawnCoordinator,
  SpawnOutcome,
  SubmitResult,
  TaskLiveness,
  UserSendOptions
} from '@shuvix/agent-runtime'
import type { UserInput } from '@earendil-works/pi-durable'
import type { InputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import type { ThinkingLevel } from '@shuvix/chat-protocol/types/thinking'

export type Gate = { promise: Promise<void>; release: () => void }

export function gate(): Gate {
  let release!: () => void
  const promise = new Promise<void>((resolve) => (release = resolve))
  return { promise, release }
}

/** 一条最小的锁记录 */
export function lockRecord(patch: Partial<LockRecord> = {}): LockRecord {
  return {
    conversationId: 1 as LockRecord['conversationId'],
    profileName: 'work',
    kind: 'root',
    model: { provider: 'faux', modelId: 'faux-1' },
    toolNames: [],
    extensions: [],
    sandboxed: false,
    mcp: {},
    skills: [],
    createdAt: 0,
    ...patch
  }
}

const REFUSALS = new Set(['busy', 'no_model', 'closed'])

export class FakeDurableSession implements DurableSession {
  readonly sessionId: string
  readonly harness = undefined as never
  readonly effectiveSettings = undefined as never
  closed = false
  lock: LockRecord | undefined
  runState: RunState = 'idle'
  busy = false
  interrupted = false
  pendingInputCount = 0
  pendingInputSummaries: string[] = []
  /** 第一次起跑类调用时上的锁（模拟 K3） */
  lockOnFirstUse: LockRecord | undefined
  readonly calls: unknown[][] = []
  submitResults: SubmitResult[] = []
  steerResult: AdmitResult = {}
  followUpResult: AdmitResult = {}
  continueResult: SubmitResult = {}
  resumeResult: SubmitResult = {}
  /** requestState 的脚本（没设的 requestId = 'none'） */
  readonly requestStates = new Map<string, RequestState>()
  answer: LastAnswer | undefined
  /** 此刻的 driven-run 标记（P2-10） */
  drivenRun: DrivenRun | undefined
  /** taskLiveness 的脚本（没设的任务 = undefined，即不存在） */
  readonly taskStates = new Map<number, TaskLiveness>()
  /** submitUser 受理之后、落定之前挂着的闸门 */
  submitGate: Gate | undefined
  destroyGate: Gate | undefined
  abortGate: Gate | undefined
  createAgentError: unknown
  destroyError: unknown
  /** false = 下一次 submitUser 不受理就返回脚本结果（模拟创建被取消：`{}` 而没有受理） */
  admit = true
  respondResult = false

  constructor(sessionId: string) {
    this.sessionId = sessionId
  }

  private use(): void {
    if (this.lock === undefined && this.lockOnFirstUse !== undefined)
      this.lock = this.lockOnFirstUse
  }

  async currentConversation(): Promise<never> {
    throw new Error('FakeDurableSession has no conversations')
  }

  isBusy(): boolean {
    return this.busy
  }

  isInterrupted(): boolean {
    return this.interrupted
  }

  /** 按对话可设的身份（派生 agent 等）；没设的对话 = 锁的根身份，没锁 = undefined（与真实现同口径） */
  readonly identities = new Map<number, AgentIdentity>()

  agentIdentity(conversationId: number): AgentIdentity | undefined {
    if (this.closed) return undefined
    const set = this.identities.get(conversationId)
    if (set !== undefined) return set
    if (this.lock === undefined) return undefined
    const { profileName, model } = this.lock
    return {
      profileName,
      kind: 'root',
      getModelConfig: () => ({ provider: model.provider, model: model.modelId, capabilities: {} })
    }
  }

  async continue(): Promise<SubmitResult> {
    this.calls.push(['continue'])
    if (this.closed) return { error: 'closed', code: 'closed' }
    this.use()
    return this.continueResult
  }

  async resumeInterrupted(): Promise<SubmitResult> {
    this.calls.push(['resumeInterrupted'])
    if (this.closed) return { error: 'closed', code: 'closed' }
    if (!this.interrupted) return {}
    this.use()
    if (this.resumeResult.error === undefined) {
      this.interrupted = false
      this.busy = true
    }
    return this.resumeResult
  }

  async taskLiveness(taskId: number): Promise<TaskLiveness | undefined> {
    this.calls.push(['taskLiveness', taskId])
    if (this.closed) throw new Error(`Session ${this.sessionId} is closed`)
    return this.taskStates.get(taskId)
  }

  async requestState(requestId: string): Promise<RequestState> {
    this.calls.push(['requestState', requestId])
    if (this.closed) throw new Error(`Session ${this.sessionId} is closed`)
    return this.requestStates.get(requestId) ?? 'none'
  }

  async lastAnswer(): Promise<LastAnswer | undefined> {
    this.calls.push(['lastAnswer'])
    if (this.closed) throw new Error(`Session ${this.sessionId} is closed`)
    return this.answer
  }

  async submitUser(content: UserInput, options: UserSendOptions = {}): Promise<SubmitResult> {
    this.calls.push(['submitUser', content, options])
    if (this.closed) return { error: `Session ${this.sessionId} is closed`, code: 'closed' }
    const result = this.submitResults.shift() ?? {}
    // 认得的 requestId = 重新挂上：不再受理，不调受理回调（P2-09 PIN-02）
    const known =
      options.requestId !== undefined &&
      (this.requestStates.get(options.requestId) ?? 'none') !== 'none'
    if (known) {
      if (options.driven !== undefined && options.requestId !== undefined) {
        this.drivenRun = {
          requestId: options.requestId,
          ...options.driven,
          conversationId: 1 as DrivenRun['conversationId']
        }
      }
      if (this.requestStates.get(options.requestId!) === 'settled') return result
      if (this.interrupted) {
        this.interrupted = false
        this.busy = true
      }
      if (this.submitGate) await this.submitGate.promise
      // 挂上的那一条落定了
      this.busy = false
      this.requestStates.set(options.requestId!, 'settled')
      return result
    }
    if (!this.admit) {
      this.admit = true
      return result
    }
    if (result.code === 'no_model') return result
    this.use()
    if (result.code !== undefined && REFUSALS.has(result.code)) return result
    if (options.driven !== undefined && options.requestId !== undefined) {
      this.drivenRun = {
        requestId: options.requestId,
        ...options.driven,
        conversationId: 1 as DrivenRun['conversationId']
      }
    }
    options.onAdmitted?.({})
    if (this.submitGate) await this.submitGate.promise
    return result
  }

  async steer(content: UserInput): Promise<AdmitResult> {
    this.calls.push(['steer', content])
    this.use()
    return this.steerResult
  }

  async followUp(content: UserInput): Promise<AdmitResult> {
    this.calls.push(['followUp', content])
    this.use()
    return this.followUpResult
  }

  async writeNotice(notice: NoticeInput): Promise<NoticeResult> {
    this.calls.push(['writeNotice', notice])
    return { status: 'submitted' }
  }

  async notify(text: string, options?: NotifyOptions): Promise<void> {
    this.calls.push(['notify', text, ...(options === undefined ? [] : [options])])
  }

  async abort(): Promise<void> {
    this.calls.push(['abort'])
    if (this.abortGate) await this.abortGate.promise
    this.busy = false
    this.interrupted = false
  }

  async setThinkingLevel(level: ThinkingLevel): Promise<void> {
    this.calls.push(['setThinkingLevel', level])
  }

  requestUserInput(request: InputRequest): Promise<InputResponse> {
    this.calls.push(['requestUserInput', request])
    return Promise.resolve({ kind: 'cancel', reason: 'fake' } as unknown as InputResponse)
  }

  respondToInput(requestId: string, response: InputResponse): boolean {
    this.calls.push(['respondToInput', requestId, response])
    return this.respondResult
  }

  /** 派生 agent 协调器的桩（P2-03）：每次调用记进 `calls`，派发 / 追问给脚本结果 */
  spawnOutcome: SpawnOutcome = { result: '' }
  readonly agents: SpawnCoordinator = {
    spawn: async (params) => {
      this.calls.push(['agents.spawn', params.profile.name, params.prompt])
      return this.spawnOutcome
    },
    interrupt: async (conversationId) => {
      this.calls.push(['agents.interrupt', conversationId])
    },
    destroy: async (conversationId) => {
      this.calls.push(['agents.destroy', conversationId])
    },
    continue: async (conversationId, text) => {
      this.calls.push(['agents.continue', conversationId, text])
      return this.spawnOutcome
    },
    ensureInstalled: async (conversationId) => {
      this.calls.push(['agents.ensureInstalled', conversationId])
    }
  }

  async createAgent(options?: CreateAgentOptions): Promise<LockRecord> {
    this.calls.push(['createAgent', ...(options === undefined ? [] : [options])])
    if (this.createAgentError !== undefined) throw this.createAgentError
    this.use()
    this.lock ??= lockRecord()
    return this.lock
  }

  async destroyAgent(): Promise<void> {
    this.calls.push(['destroyAgent'])
    if (this.destroyGate) await this.destroyGate.promise
    if (this.destroyError !== undefined) throw this.destroyError
    this.lock = undefined
  }

  /** 回退 fork（P3-10a）的结果脚本；缺省 = 一个新对话 2 */
  rollbackResult: RollbackResult = { ok: true, conversationId: 2 }

  async rollbackTo(targetEntryId: number, options?: RollbackOptions): Promise<RollbackResult> {
    this.calls.push(['rollbackTo', targetEntryId, ...(options === undefined ? [] : [options])])
    if (this.rollbackResult.ok) this.lock = undefined
    return this.rollbackResult
  }

  // 界面投影 / 运行状态 / 询问钩子（P3-03）：门面不用它们，桩子
  projector(): Promise<SessionProjector> {
    return Promise.reject(new Error('FakeDurableSession has no projector'))
  }

  async agentProjector(): Promise<AgentProjector | undefined> {
    return undefined
  }

  onRunStateChange(): () => void {
    return () => {}
  }

  subscribeInputs(_hooks: PendingInputHooks): () => void {
    return () => {}
  }

  pendingInputs(): InputRequest[] {
    return []
  }

  /** 某类调用（按顺序） */
  callsOf(name: string): unknown[][] {
    return this.calls.filter((call) => call[0] === name)
  }
}

export class FakeSessionHost implements SessionHost {
  readonly sessions = new Map<string, FakeDurableSession>()
  /** 存储存在的会话（peek 只打开这些） */
  readonly storages = new Set<string>()
  readonly calls: [string, string][] = []
  sealed = false
  deleteGate: Gate | undefined
  deleteError: unknown
  /** 新建的会话怎么配（打开时调用） */
  configure: ((session: FakeDurableSession) => void) | undefined
  /** 每个会话打开过的全部实例（重开 = 新实例） */
  readonly instances = new Map<string, FakeDurableSession[]>()

  private spawn(sessionId: string): FakeDurableSession {
    const session = new FakeDurableSession(sessionId)
    this.configure?.(session)
    this.sessions.set(sessionId, session)
    this.instances.set(sessionId, [...(this.instances.get(sessionId) ?? []), session])
    return session
  }

  /** 直接放一个打开着的会话进来（不记调用） */
  put(sessionId: string, patch: Partial<FakeDurableSession> = {}): FakeDurableSession {
    this.storages.add(sessionId)
    const session = this.spawn(sessionId)
    Object.assign(session, patch)
    return session
  }

  async open(sessionId: string): Promise<DurableSession> {
    this.calls.push(['open', sessionId])
    if (this.sealed) throw new Error(`Session host is closed; cannot open session ${sessionId}`)
    const existing = this.sessions.get(sessionId)
    if (existing) return existing
    this.storages.add(sessionId)
    return this.spawn(sessionId)
  }

  async peek(sessionId: string): Promise<DurableSession | undefined> {
    this.calls.push(['peek', sessionId])
    if (this.sealed) return undefined
    const existing = this.sessions.get(sessionId)
    if (existing) return existing
    if (!this.storages.has(sessionId)) return undefined
    return this.spawn(sessionId)
  }

  get(sessionId: string): FakeDurableSession | undefined {
    return this.sessions.get(sessionId)
  }

  async close(sessionId: string): Promise<void> {
    this.calls.push(['close', sessionId])
    const session = this.sessions.get(sessionId)
    if (session) session.closed = true
    this.sessions.delete(sessionId)
  }

  async closeAll(): Promise<void> {
    this.calls.push(['closeAll', ''])
    this.sealed = true
    for (const session of this.sessions.values()) session.closed = true
    this.sessions.clear()
  }

  async delete(sessionId: string): Promise<void> {
    this.calls.push(['delete', sessionId])
    if (this.deleteGate) await this.deleteGate.promise
    const session = this.sessions.get(sessionId)
    if (session) session.closed = true
    this.sessions.delete(sessionId)
    this.storages.delete(sessionId)
    if (this.deleteError !== undefined) throw this.deleteError
  }

  openSessionIds(): string[] {
    return [...this.sessions.keys()]
  }

  /** 某类调用的会话 id（按顺序） */
  callsOf(name: string): string[] {
    return this.calls.filter(([kind]) => kind === name).map(([, id]) => id)
  }
}

/** `vi.mock('../sessionHost')` 用的那个宿主（每个用例前 `resetFakeHost()`） */
export let fakeHost = new FakeSessionHost()

export function resetFakeHost(): FakeSessionHost {
  fakeHost = new FakeSessionHost()
  return fakeHost
}

/**
 * `vi.mock('../sessionHost', async () => (await import('./support/fakeSessionHost')).sessionHostModuleMock())`
 * —— 真模块的依赖图很重（模型注册表、事件适配器……），单测换成假的宿主。
 */
export function sessionHostModuleMock(): Record<string, unknown> {
  return {
    AUTO_RESUME_KEY: 'session.autoResume',
    INTERRUPTED_SEND_POLICY: 'abort-then-send',
    QUIT_CLOSE_CAP_MS: 5000,
    getSessionHost: () => fakeHost,
    peekSessionHost: () => fakeHost,
    resetSessionHostForTests: vi.fn(),
    installSessionHostQuitHook: vi.fn(() => ({ ready: true }))
  }
}

/** sessionService 单测用的假门面模块：`AgentSession.of` 包一层假会话，清理函数是 spy */
export const agentSessionSpies = {
  clearAgentScopedState: vi.fn<(sessionId: string) => void>(),
  /** 与真件同一形状：经宿主 delete（关掉并删存储） */
  destroySessionRuntime: vi.fn<(sessionId: string) => Promise<void>>(async (sessionId) => {
    await fakeHost.delete(sessionId)
  })
}

const facades = new WeakMap<DurableSession, Record<string, unknown>>()

/** 假门面：只转发 sessionService 会碰到的那几样 */
function facadeOf(durable: DurableSession): Record<string, unknown> {
  let facade = facades.get(durable)
  if (!facade) {
    facade = {
      sessionId: durable.sessionId,
      durable,
      notify: (text: string, options?: NotifyOptions) =>
        options === undefined ? durable.notify(text) : durable.notify(text, options),
      invalidate: async () => {
        await durable.destroyAgent()
        agentSessionSpies.clearAgentScopedState(durable.sessionId)
      },
      requestUserInput: (request: InputRequest) => durable.requestUserInput(request),
      respondToInput: (requestId: string, response: InputResponse) =>
        durable.respondToInput(requestId, response),
      setThinkingLevel: (level: ThinkingLevel) => durable.setThinkingLevel(level),
      abort: () => durable.abort(),
      get isStreaming() {
        return durable.isBusy()
      },
      get pendingInputCount() {
        return durable.pendingInputCount
      },
      get pendingInputSummaries() {
        return durable.pendingInputSummaries
      }
    }
    facades.set(durable, facade)
  }
  return facade
}

/** `vi.mock('../agentSession', async () => (await import('./support/fakeSessionHost')).agentSessionModuleMock())` */
export function agentSessionModuleMock(): Record<string, unknown> {
  return {
    AgentSession: { of: facadeOf },
    clearAgentScopedState: agentSessionSpies.clearAgentScopedState,
    destroySessionRuntime: agentSessionSpies.destroySessionRuntime
  }
}
