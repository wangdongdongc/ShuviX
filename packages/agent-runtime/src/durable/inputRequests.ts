/**
 * 挂起的用户询问（`ask` 工具、路径 / 命令确认卡片……）—— 会话运行时的「等人回答」那一半。
 *
 * 从已删除的 `harness/harnessSession.ts` 原样搬来（P1-01）：询问的挂起、应答、中止后拒收、
 * 给别的会话看的摘要，都与 pi 的运行时无关，换到 pi-durable 之后照样需要。
 * TODO(pi-durable p1): P1-07 的 DurableSession 持有一份实例并接上 abort / 下一轮复位。
 */
import type { InputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import type { RuntimeEventSink } from '../types'

interface PendingInput {
  request: InputRequest
  resolve: (response: InputResponse) => void
}

export class PendingInputRequests {
  private readonly pending = new Map<string, PendingInput>()
  /**
   * 中止后是否拒收新的用户输入请求（下一次 prompt 经 `reopen()` 复位）。
   *
   * `cancelAll()` 只能解掉**它看到的那一批**挂起。若某个工具恰好在这之后才发起询问，
   * 那条挂起就没人会应答了 —— 宿主的输入路由是按「当前绑定的运行时」找的，而
   * 正在关停的运行时已经不在绑定表里（见 SessionManager）。中止又要等 run 跑完，
   * 于是双方互等，会话永远停在「正在停止」。中止后直接把新请求当作已取消，堵住这个窗口。
   */
  private closed = false

  constructor(
    private readonly sessionId: string,
    private readonly sink: RuntimeEventSink
  ) {}

  /** 发起一条询问并挂起，直到被应答或取消 */
  request(request: InputRequest): Promise<InputResponse> {
    // 中止之后到下一次 prompt 之前：不再受理新的询问（见 closed）
    if (this.closed || !this.sink.hasUserInputCapability(this.sessionId)) {
      return Promise.resolve({ kind: 'cancel', reason: 'aborted' })
    }
    return new Promise<InputResponse>((resolve) => {
      this.pending.set(request.id, { request, resolve })
      this.sink.broadcast({ type: 'input_request', sessionId: this.sessionId, request })
    })
  }

  /** 应答一条挂起的询问；不存在（已应答 / 已取消）时返回 false */
  respond(requestId: string, response: InputResponse): boolean {
    const pending = this.pending.get(requestId)
    if (!pending) return false
    this.pending.delete(requestId)
    pending.resolve(response)
    this.sink.broadcast({ type: 'input_request_resolved', sessionId: this.sessionId, requestId })
    return true
  }

  /** 中止：拒收之后的新询问，并把现有挂起全部按「已中止」解掉 */
  cancelAll(): void {
    this.closed = true
    for (const [requestId, pending] of this.pending) {
      pending.resolve({ kind: 'cancel', reason: 'aborted' })
      this.sink.broadcast({ type: 'input_request_resolved', sessionId: this.sessionId, requestId })
    }
    this.pending.clear()
  }

  /** 新一轮开始：恢复受理用户输入（上一次 cancelAll 关掉的） */
  reopen(): void {
    this.closed = false
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
}
