/**
 * 临时会话登记簿 — 纯内存，记录活跃 / 最近结束的子智能体会话元信息
 *
 * 用于：
 * - IPC 层（agent:init 等）判定某 sessionId 是否为临时子会话，并据此返回 registry 里的元信息而非 DB 行。
 * - 右侧 Sub-agent 面板定位子 Tab 的归属（parentSessionId + displayName）。
 *
 * 条目在 runTask 开始时 register，用户点 Sub-agent 子 Tab 的 × 时由 unregister 移除（通过 IPC 转发到 AgentManager.destroy）。
 */

export interface TransientSessionEntry {
  sessionId: string
  parentSessionId: string
  subAgentName: string
  displayName: string
  description: string
  startedAt: number
}

class TransientSessionRegistry {
  private entries = new Map<string, TransientSessionEntry>()

  register(meta: Omit<TransientSessionEntry, 'startedAt'>): void {
    this.entries.set(meta.sessionId, { ...meta, startedAt: Date.now() })
  }

  unregister(sessionId: string): void {
    this.entries.delete(sessionId)
  }

  get(sessionId: string): TransientSessionEntry | undefined {
    return this.entries.get(sessionId)
  }

  has(sessionId: string): boolean {
    return this.entries.has(sessionId)
  }

  listByParent(parentSessionId: string): TransientSessionEntry[] {
    const result: TransientSessionEntry[] = []
    for (const entry of this.entries.values()) {
      if (entry.parentSessionId === parentSessionId) result.push(entry)
    }
    return result
  }

  clear(): void {
    this.entries.clear()
  }
}

export const transientSessionRegistry = new TransientSessionRegistry()
