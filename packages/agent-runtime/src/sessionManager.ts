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
 */

/** dispose 原因：invalidate=回退重建、destroy=删除会话、remove=普通移除 */
export type SessionDisposeReason = 'invalidate' | 'destroy' | 'remove'

export interface SessionManagerDeps<T> {
  /**
   * 创建某会话的运行时实例（已存在时不会调用）。返回 undefined 表示会话不存在/无法创建。
   * 同步或异步均可；并发 ensure 同一 sessionId 会复用同一在途 Promise，不会重复创建。
   */
  create: (sessionId: string) => T | undefined | Promise<T | undefined>
  /** 移除实例前的清理钩子（reason 区分 invalidate/destroy/remove）；可选 */
  dispose?: (sessionId: string, instance: T, reason: SessionDisposeReason) => void
}

export class SessionManager<T> {
  private readonly sessions = new Map<string, T>()
  /** 在途创建去重：并发 ensure 同一会话共享同一 Promise，避免重复构造 */
  private readonly pending = new Map<string, Promise<T | undefined>>()

  constructor(private readonly deps: SessionManagerDeps<T>) {}

  /** 取已存在的运行时实例（不创建） */
  get(sessionId: string): T | undefined {
    return this.sessions.get(sessionId)
  }

  /** 运行时实例此刻是否已存在 */
  has(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  /**
   * 实例已存在**或正在创建中**。
   * 供宿主的资源钉住判定（如会话树缓存的逐出保护）—— 创建中的实例已经持有了
   * 底层资源引用，只看 `has()` 会在创建窗口内误判为可回收。
   */
  tracked(sessionId: string): boolean {
    return this.sessions.has(sessionId) || this.pending.has(sessionId)
  }

  /** 取（或懒创建）运行时实例。会话不存在/创建失败返回 undefined。 */
  async ensure(sessionId: string): Promise<T | undefined> {
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
    return inflight
  }

  /** 移除并清理某会话的运行时实例（不存在则无操作） */
  remove(sessionId: string, reason: SessionDisposeReason = 'remove'): void {
    const inst = this.sessions.get(sessionId)
    if (!inst) return
    this.deps.dispose?.(sessionId, inst, reason)
    this.sessions.delete(sessionId)
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
