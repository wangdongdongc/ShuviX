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
 */
import type {
  CancelReason,
  InputRequest,
  InputResponse
} from '@shuvix/chat-protocol/types/inputRequest'
import type { RuntimeEventSink } from '../types'

interface PendingInput {
  request: InputRequest
  resolve: (response: InputResponse) => void
}

export interface PendingInputHooks {
  /** 一条询问开始挂起（广播 input_request 之后） */
  onRequest?: (request: InputRequest) => void
  /** 一条挂起的询问落定（应答 / 取消 / 被顶替；广播 input_request_resolved 之后） */
  onResolved?: (requestId: string, response: InputResponse) => void
}

function cancelled(reason: CancelReason): InputResponse {
  return { kind: 'cancel', reason }
}

export class PendingInputRequests {
  private readonly pending = new Map<string, PendingInput>()
  /** 受理窗口关闭时的取消原因；undefined = 窗口开着 */
  private closedReason: CancelReason | undefined

  constructor(
    private readonly sessionId: string,
    private readonly sink: RuntimeEventSink,
    private readonly hooks: PendingInputHooks = {}
  ) {}

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
      this.sink.broadcast({ type: 'input_request', sessionId: this.sessionId, request })
      this.safely(() => this.hooks.onRequest?.(request))
    })
  }

  /** 应答一条挂起的询问；不存在（已应答 / 已取消）时返回 false —— 先到者胜 */
  respond(requestId: string, response: InputResponse): boolean {
    return this.settle(requestId, response)
  }

  /** 取消一条挂起的询问；不存在时返回 false */
  cancel(requestId: string, reason: CancelReason = 'aborted'): boolean {
    return this.settle(requestId, cancelled(reason))
  }

  /** 取消全部挂起（逐条广播落定）；不改变受理窗口 */
  cancelAll(reason: CancelReason = 'aborted'): void {
    for (const requestId of [...this.pending.keys()]) this.settle(requestId, cancelled(reason))
  }

  /** 关闭受理窗口：之后的新询问当场以 `reason` 取消（不挂起、不计数、不广播） */
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

  private settle(requestId: string, response: InputResponse): boolean {
    const pending = this.pending.get(requestId)
    if (!pending) return false
    this.pending.delete(requestId)
    pending.resolve(response)
    this.sink.broadcast({ type: 'input_request_resolved', sessionId: this.sessionId, requestId })
    this.safely(() => this.hooks.onResolved?.(requestId, response))
    return true
  }

  /** 钩子抛错只当通知失败：询问本身的落定不受影响 */
  private safely(call: () => void): void {
    try {
      call()
    } catch {
      /* 宿主钩子自己记日志 */
    }
  }
}
