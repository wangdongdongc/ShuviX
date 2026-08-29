/**
 * AgentRegistry —— 活跃派生 agent 的唯一登记簿（跨端共享）。
 *
 * 会话根 agent（有持久化会话身份）**不登记**：任何不在登记簿里的 id 视为根会话，
 * depth=0。派生 agent（ephemeral，无会话记录）在 spawn 时登记、destroy 时注销，
 * 父子关系与层级都从这里查 —— 取代旧的 manager.byParent / 桌面 transientSessionRegistry
 * 双份内存簿记。
 */

export interface AgentRegistryEntry {
  agentId: string
  /** 派生来源 agent 的 id（可能本身也是派生 agent） */
  parentAgentId: string
  /** 派生层级（根会话 = 0，直接派生 = 1，依此类推） */
  depth: number
  /** agent profile 名（AgentProfile.name） */
  profileName: string
  displayName: string
  description: string
  startedAt: number
}

export type AgentRegistryEntryInput = Omit<AgentRegistryEntry, 'startedAt'>

export class AgentRegistry {
  private entries = new Map<string, AgentRegistryEntry>()

  register(entry: AgentRegistryEntryInput): void {
    this.entries.set(entry.agentId, { ...entry, startedAt: Date.now() })
  }

  unregister(agentId: string): void {
    this.entries.delete(agentId)
  }

  get(agentId: string): AgentRegistryEntry | undefined {
    return this.entries.get(agentId)
  }

  has(agentId: string): boolean {
    return this.entries.has(agentId)
  }

  /** 派生层级：不在登记簿里的 id 即会话根 agent，depth=0 */
  depthOf(agentId: string): number {
    return this.entries.get(agentId)?.depth ?? 0
  }

  /** 直接子代（按登记先后） */
  childrenOf(agentId: string): AgentRegistryEntry[] {
    const result: AgentRegistryEntry[] = []
    for (const entry of this.entries.values()) {
      if (entry.parentAgentId === agentId) result.push(entry)
    }
    return result
  }

  /** 全部后代（深度优先，父在前） */
  descendantsOf(agentId: string): AgentRegistryEntry[] {
    const result: AgentRegistryEntry[] = []
    for (const child of this.childrenOf(agentId)) {
      result.push(child, ...this.descendantsOf(child.agentId))
    }
    return result
  }

  /** 沿父链上溯到第一个不在登记簿里的 id —— 即所属根会话 id（传入根会话 id 时原样返回） */
  rootSessionOf(agentId: string): string {
    let current = agentId
    const seen = new Set<string>()
    for (let entry = this.entries.get(current); entry; entry = this.entries.get(current)) {
      if (seen.has(current)) break // 环保护（正常登记不会出现）
      seen.add(current)
      current = entry.parentAgentId
    }
    return current
  }

  list(): AgentRegistryEntry[] {
    return [...this.entries.values()]
  }

  clear(): void {
    this.entries.clear()
  }
}

/** 生成一个派生 agent 的事件频道 id（保留 `sub-` 前缀以兼容既有前端约定） */
export function agentIdOf(uuid: string): string {
  return `sub-${uuid}`
}
