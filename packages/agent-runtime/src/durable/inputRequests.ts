/**
 * 挂起的用户询问（`ask` 工具、路径 / 命令确认卡片……）—— 会话运行时的「等人回答」那一半。
 *
 * 从已删除的 `harness/harnessSession.ts` 搬来（P1-01），P1-07 由 DurableSession 持有并接上
 * 中止 / 关停 / 下一轮复位。询问与 pi 的运行时无关：durable 只管工具任务，人什么时候回答是宿主的事。
 *
 * 三条纪律：
 *  1. **关闭受理窗口**（`closeInputs`）。`cancelAll()` 只能解掉它看到的那一批挂起；若某个工具恰好
 *     在这之后才发起询问，那条挂起就没人会应答了（宿主按「当前绑定的运行时」路由应答，而正在关停的
 *     运行时已不在绑定表里），中止又要等工具收尾 —— 双方互等，会话永远停在「正在停止」。
 *     所以中止 / 关停先关窗口：之后的新询问当场判为已取消，不计数、不广播。下一个起跑路径
 *     （发送 / steer / followUp / 继续 / 自动续跑）经 `reopenInputs()` 重新受理。
 *  2. **同 id 只认最新一条**（裁决 R12）：重复 id 的询问到来时，先前那条以 `superseded` 取消，
 *     绝不让它变成永远没人应答的孤儿。
 *  3. **每个 id 的 onRequest / onResolved 恰好各一次**；被闸门拒收（窗口关闭 / 没有前端能展示）的
 *     询问两者都没有。
 *
 * **不再广播**（P3-08，plan §D / Q-P3-04）：询问经视图（`SessionView.asks`，投影挂的钩子）到达每个前端，
 * 主进程的消费方（通知、侧栏计数）也挂钩子 —— 前端线路上没有 `input_request` / `_resolved` 了。sink 只剩
 * `hasUserInputCapability` 这道闸门。应答带上答题方（`{clientId}`，P3-08 PIN-20），原样交给 onResolved
 * 供审计；不记应答内容。
 *
 * 钩子可以有多份（P3-03 PIN-02）：构造时的那一份（旧接口）之外，`subscribe()` 再挂任意多份（界面投影、
 * 通知中心……），逐个隔离 —— 一份抛错只记日志，不影响其余几份，也不影响询问本身。`list()` 给出此刻
 * 挂着的询问（按出现次序；同 id 重发的那条排到最后）。
 */
import type {
  CancelReason,
  InputRequest,
  InputResponse
} from '@shuvix/chat-protocol/types/inputRequest'
import type { RuntimeEventSink, RuntimeLogger } from '../types'

interface PendingInput {
  request: InputRequest
  resolve: (response: InputResponse) => void
}

export interface PendingInputHooks {
  /** 一条询问开始挂起 */
  onRequest?: (request: InputRequest) => void
  /**
   * 一条挂起的询问落定（应答 / 取消 / 被顶替）。`clientId` = 答题方（`ipc:<id>` / `chrome:<id>`，PIN-20）：
   * 只有经 `respond(…, {clientId})` 应答的才有；取消、顶替、不带身份的应答都没有。
   */
  onResolved?: (requestId: string, response: InputResponse, clientId?: string) => void
}

/** 应答的附带信息（P3-08 PIN-20）：谁答的，只供审计 */
export interface InputResponseMeta {
  readonly clientId?: string
}

function cancelled(reason: CancelReason): InputResponse {
  return { kind: 'cancel', reason }
}

export class PendingInputRequests {
  private readonly pending = new Map<string, PendingInput>()
  /** 受理窗口关闭时的取消原因；undefined = 窗口开着 */
  private closedReason: CancelReason | undefined
  /** `subscribe()` 挂上的钩子（构造时的那一份之后逐个调用） */
  private readonly subscribers = new Set<PendingInputHooks>()

  constructor(
    private readonly sessionId: string,
    private readonly sink: RuntimeEventSink,
    private readonly hooks: PendingInputHooks = {},
    private readonly logger?: RuntimeLogger
  ) {}

  /**
   * 再挂一份钩子（PIN-02）：之后每条询问的 onRequest / onResolved 都会调到它（构造时那一份之后、按挂上
   * 的次序）。返回的函数摘掉它（幂等）。已经挂着的询问不补发 —— 需要时先读 `list()`。
   */
  subscribe(hooks: PendingInputHooks): () => void {
    const entry: PendingInputHooks = { ...hooks }
    this.subscribers.add(entry)
    return () => {
      this.subscribers.delete(entry)
    }
  }

  /** 此刻挂着的询问（按出现次序；同 id 重发的那条排到最后）。返回新数组，询问对象本身不拷贝 */
  list(): InputRequest[] {
    return [...this.pending.values()].map(({ request }) => request)
  }

  /** 发起一条询问并挂起，直到被应答、取消或被同 id 的新询问顶替 */
  request(request: InputRequest): Promise<InputResponse> {
    if (this.closedReason !== undefined) return Promise.resolve(cancelled(this.closedReason))
    if (!this.sink.hasUserInputCapability(this.sessionId)) {
      return Promise.resolve(cancelled('aborted'))
    }
    // 同 id 又来一条：先前那条作废（只有最新一条能被应答）
    this.settle(request.id, cancelled('superseded'))
    return new Promise<InputResponse>((resolve) => {
      this.pending.set(request.id, { request, resolve })
      this.safely(() => this.hooks.onRequest?.(request))
      for (const hooks of [...this.subscribers]) this.safely(() => hooks.onRequest?.(request))
    })
  }

  /** 应答一条挂起的询问；不存在（已应答 / 已取消）时返回 false —— 先到者胜 */
  respond(requestId: string, response: InputResponse, meta: InputResponseMeta = {}): boolean {
    return this.settle(requestId, response, meta.clientId)
  }

  /** 取消一条挂起的询问；不存在时返回 false */
  cancel(requestId: string, reason: CancelReason = 'aborted'): boolean {
    return this.settle(requestId, cancelled(reason))
  }

  /** 取消全部挂起（逐条落定）；不改变受理窗口 */
  cancelAll(reason: CancelReason = 'aborted'): void {
    for (const requestId of [...this.pending.keys()]) this.settle(requestId, cancelled(reason))
  }

  /** 关闭受理窗口：之后的新询问当场以 `reason` 取消（不挂起、不计数、不调钩子） */
  closeInputs(reason: CancelReason = 'aborted'): void {
    this.closedReason = reason
  }

  /** 重新受理询问（下一个起跑路径调用）。`closed` 关掉的窗口不会被重开 */
  reopenInputs(): void {
    if (this.closedReason === 'closed') return
    this.closedReason = undefined
  }

  /** 受理窗口此刻是否关闭 */
  get inputsClosed(): boolean {
    return this.closedReason !== undefined
  }

  /** 挂起中的询问数 */
  get count(): number {
    return this.pending.size
  }

  /**
   * 待答询问的人读摘要。给**别的会话**看的 —— 父会话只知道子会话「卡在等人回答」
   * 却不知道问的是什么，就只能干等或反复重试。有了这个它至少能把问题转告用户。
   */
  get summaries(): string[] {
    return [...this.pending.values()].map(({ request }) => {
      const r = request as { kind: string; toolName: string; command?: string; question?: string }
      return [r.toolName, r.command ?? r.question ?? r.kind].filter(Boolean).join(': ')
    })
  }

  private settle(requestId: string, response: InputResponse, clientId?: string): boolean {
    const pending = this.pending.get(requestId)
    if (!pending) return false
    this.pending.delete(requestId)
    pending.resolve(response)
    // 带身份时才多传一个参数：既有的两参钩子（与它们的断言）看到的调用形状不变
    const resolved = (hooks: PendingInputHooks): void => {
      if (clientId === undefined) hooks.onResolved?.(requestId, response)
      else hooks.onResolved?.(requestId, response, clientId)
    }
    this.safely(() => resolved(this.hooks))
    for (const hooks of [...this.subscribers]) this.safely(() => resolved(hooks))
    return true
  }

  /** 钩子抛错只当通知失败：询问本身的落定、其余钩子都不受影响（有日志就记一笔） */
  private safely(call: () => void): void {
    try {
      call()
    } catch (error) {
      this.logger?.warn(
        `input request hook failed session=${this.sessionId}: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
}
