/**
 * SessionManager —— 宿主无关的会话运行时生命周期簿记。
 *
 * 把「`Map<sessionId, 运行时实例>` + 懒创建 + 查找 + 失效/销毁」这套两端一致的策略收敛到一处，
 * 让「延迟到首次发消息才创建」「失效后下次重建」等生命周期改动只写一遍。
 *
 * 实例的**构造**（拼 system prompt / build tools / resolve model / 恢复历史）与**清理**因端而异，
 * 经 `create` / `dispose` 注入：
 *   - 桌面：实例为 `AgentSession`（含 ssh 清理），create 同步，dispose → invalidate/destroy。
 *   - 扩展：实例为 `RuntimeSession`，create 异步（FSA/OPFS），dispose → 子代理/工具注册表清理。
 *
 * T 是每会话的运行时对象类型（桌面 AgentSession / 扩展 RuntimeSession），对本类不透明。
 *
 * ─── 强一致性：一个会话同一时刻只有一个运行时 ───────────────────────────
 *
 * 会话树（pi 的 `Session`）只有一个 leaf 指针，谁 append 都挂在当前叶子上。所以
 * **两个运行时同时活着 = 两个 run 的消息交叉写进同一条分支**，`tool_use` 与
 * `tool_result` 的配对当场作废，之后每一发请求都会被 provider 打回
 * （`tool call id bash:35 is not found`），会话永久卡死。
 *
 * 旧实现的洞在 `remove()`：同步删表项、`dispose` 不等待。而真正的关停要等当前 run
 * 跑完（pi 的 `abort()` 内部是 `waitForIdle()`），于是「解绑」发生在「关停」之前 ——
 * 下一次 `ensure()` 看到空位就造了第二个，旧的那个还握着同一棵树在写。
 *
 * 现在的契约：
 *   - `remove()` 异步，`dispose` 返回的 Promise **会被等待**；
 *   - 关停期间该会话记在 `closing` 里，`ensure()` 必须先等它结束才谈新建 ——
 *     **关不掉就一直等**（会话表现为「正在停止」），绝不放行第二个运行时；
 *   - 创建在途时 `remove()` 先等它出生再关，堵住「删了个空、新实例随后落进 map」的竞态。
 */

/** dispose 原因：invalidate=回退重建、destroy=删除会话、remove=普通移除 */
export type SessionDisposeReason = 'invalidate' | 'destroy' | 'remove'

export interface SessionManagerDeps<T> {
  /**
   * 创建某会话的运行时实例（已存在时不会调用）。返回 undefined 表示会话不存在/无法创建。
   * 同步或异步均可；并发 ensure 同一 sessionId 会复用同一在途 Promise，不会重复创建。
   */
  create: (sessionId: string) => T | undefined | Promise<T | undefined>
  /**
   * 移除实例前的清理钩子（reason 区分 invalidate/destroy/remove）；可选。
   *
   * **返回 Promise 会被等待**：在它落定之前该会话不会解绑，`ensure()` 不会造新实例。
   * 实现方要保证 resolve 时旧运行时已经不会再写会话树（桌面端 = `await runtime.abort()`）。
   */
  dispose?: (sessionId: string, instance: T, reason: SessionDisposeReason) => void | Promise<void>
  /** 关停开始 / 结束回调（宿主用来广播「正在停止」）；可选 */
  onClosingChange?: (sessionId: string, closing: boolean) => void
}

export class SessionManager<T> {
  private readonly sessions = new Map<string, T>()
  /** 在途创建去重：并发 ensure 同一会话共享同一 Promise，避免重复构造 */
  private readonly pending = new Map<string, Promise<T | undefined>>()
  /**
   * 正在关停的会话：占位到 dispose 落定为止。
   * 这是「一个会话只有一个运行时」的闸门 —— 有占位就不许新建。
   */
  private readonly closing = new Map<string, Promise<void>>()

  constructor(private readonly deps: SessionManagerDeps<T>) {}

  /** 取已存在的运行时实例（不创建；关停中视为不存在） */
  get(sessionId: string): T | undefined {
    return this.sessions.get(sessionId)
  }

  /** 运行时实例此刻是否已存在（关停中视为不存在） */
  has(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  /** 该会话是否正在关停（宿主据此显示「正在停止」并拦住发送） */
  isClosing(sessionId: string): boolean {
    return this.closing.has(sessionId)
  }

  /**
   * 实例已存在、**正在创建中**或**正在关停中**。
   * 供宿主的资源钉住判定（如会话树缓存的逐出保护）—— 创建中的实例已经持有了
   * 底层资源引用，关停中的实例则可能还在往树上写最后几条，
   * 只看 `has()` 会在这两个窗口内误判为可回收。
   */
  tracked(sessionId: string): boolean {
    return (
      this.sessions.has(sessionId) || this.pending.has(sessionId) || this.closing.has(sessionId)
    )
  }

  /**
   * 取（或懒创建）运行时实例。会话不存在/创建失败返回 undefined。
   *
   * 上一个运行时还在关停时**先等它彻底停下**，绝不并存两个 —— 这一等可能很久
   * （工具卡住不返回），宿主应当把这段时间呈现为「正在停止」。
   */
  async ensure(sessionId: string): Promise<T | undefined> {
    // 每轮：先等关停结束，再取或建；若建出来的实例在这期间就被关停了，重来一轮。
    // 返回值必须是**此刻仍绑在会话上**的那个实例 —— 否则调用方会拿着一个已被弃用的
    // 运行时去 prompt，等于又制造出一个「已解绑却还在写树」的孤儿。
    for (;;) {
      // while 而非 if：等待期间可能又发起了一次关停
      let closing = this.closing.get(sessionId)
      while (closing) {
        await closing
        closing = this.closing.get(sessionId)
      }
      const existing = this.sessions.get(sessionId)
      if (existing) return existing
      let inflight = this.pending.get(sessionId)
      if (!inflight) {
        inflight = (async () => {
          try {
            const created = await this.deps.create(sessionId)
            if (created !== undefined) this.sessions.set(sessionId, created)
            return created
          } finally {
            this.pending.delete(sessionId)
          }
        })()
        this.pending.set(sessionId, inflight)
      }
      const created = await inflight
      // 创建失败/会话不存在 —— 没什么可等的，直接回报
      if (created === undefined) return undefined
      // 关停已排上队（`remove()` 同步登记 closing，哪怕 dispose 还没跑）或实例已被换掉 ——
      // 这一个都不能交出去。注意别只比身份：关停的续跑可能还排在本续跑之后，
      // 那一刻 map 里躺着的仍是它自己。
      if (!this.closing.has(sessionId) && this.sessions.get(sessionId) === created) return created
    }
  }

  /**
   * 关停并解绑某会话的运行时实例（不存在则无操作）。
   *
   * **等 dispose 落定才返回**：返回时旧运行时保证不会再写会话树，调用方可以安全地
   * 移动 leaf / 重建运行时。并发调用共享同一次关停。dispose 抛错只当清理失败，
   * 不让它把会话永久钉死在关停态（宿主自己记日志）。
   */
  remove(sessionId: string, reason: SessionDisposeReason = 'remove'): Promise<void> {
    const inflight = this.closing.get(sessionId)
    if (inflight) return inflight

    // 创建在途：先等它出生再关。否则这里删了个空，新实例随后落进 map —— 就成了
    // 「已解绑但还活着」的孤儿运行时（本类要根除的正是这种状态）。
    const creating = this.pending.get(sessionId)
    if (!creating && !this.sessions.has(sessionId)) return Promise.resolve()

    const task = (async () => {
      if (creating) await creating.catch(() => undefined)
      const inst = this.sessions.get(sessionId)
      if (!inst) return
      // 先摘牌再关停：关停期间 get()/ensure() 都拿不到它，closing 占位挡住新建
      this.sessions.delete(sessionId)
      await this.deps.dispose?.(sessionId, inst, reason)
    })()

    const guarded = task
      .catch(() => undefined)
      .finally(() => {
        this.closing.delete(sessionId)
        this.deps.onClosingChange?.(sessionId, false)
      })
    this.closing.set(sessionId, guarded)
    this.deps.onClosingChange?.(sessionId, true)
    return guarded
  }

  /** 遍历所有活跃实例（如用户输入响应路由） */
  values(): IterableIterator<T> {
    return this.sessions.values()
  }

  /** 遍历所有活跃实例及其 sessionId（如批量重建工具集） */
  entries(): IterableIterator<[string, T]> {
    return this.sessions.entries()
  }

  /** 当前活跃实例数 */
  get size(): number {
    return this.sessions.size
  }
}
