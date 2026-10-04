/**
 * 智能体监控服务（桌面宿主）—— 设置页「监视器 → 智能体」的数据源。
 *
 * 旧实现读 agent-runtime 的 `agentRuntimeRegistry`（pi 0.80 AgentHarness 的事件影子），那个登记簿
 * 随 pi-durable 切换（P1-01）一起删除了。在 durable 会话的监控数据接上之前两个入口都答「没有」：
 * 列表为空、详情为 null。TODO(pi-durable p3): 从 SessionHost / durable 的 LiveDoc / UsageDoc 取数。
 *
 * 血缘排序（orderByLineage）是纯函数，原样保留 —— 数据源换了，分组与注意力排序的规则不变。
 */
import type { AgentMonitorEntry } from '@shuvix/chat-protocol/types/agentMonitor'
import type { AgentRuntimeInfo } from '@shuvix/chat-protocol/chatApi'

/**
 * 全部活跃 agent 运行时，按血缘分组、组间按"最该被注意"排序。
 * TODO(pi-durable p3): 接 durable 的运行时数据；现在没有可列的登记簿，恒为空。
 */
export function listAgentRuntimes(): AgentMonitorEntry[] {
  return orderByLineage([])
}

/** 「最该被注意」：先跑着的，再按最近活动倒序 */
function compareAttention(a: AgentMonitorEntry, b: AgentMonitorEntry): number {
  const running = (e: AgentMonitorEntry): number => (e.phase === 'idle' ? 1 : 0)
  return running(a) - running(b) || b.lastActivityAt - a.lastActivityAt
}

/**
 * 血缘分组排序：根 agent 打头，派生 agent 紧跟在自己的父级之后。
 *
 * 原先是全表平铺按注意力排，于是一条派生 agent 经常落在毫无关系的另一个根 agent 下面 ——
 * 它行首的缩进箭头此刻就是在骗人（看上去像是上面那个会话派出去的，真正派出它的会话
 * 反而排在更后面）。缩进要成立，谁挨着谁就只能由血缘决定，不能由活动时间决定。
 *
 * 注意力排序没有被丢掉，只是**从条目提升到了组**：组的排序键取组内最强的一条，所以
 * 一个自己早已 idle、但派出去的 agent 正在跑的会话仍然排在最前 —— 这正是原排序的本意。
 *
 * 分组按 rootSessionId 而不是顺着父指针爬：父运行时可能先一步被销毁（子还赖着），
 * 按父指针分组会让这些孤儿散落全表，按根会话分组则仍聚在它们真正的归属旁边。
 */
export function orderByLineage(entries: readonly AgentMonitorEntry[]): AgentMonitorEntry[] {
  const groups = new Map<string, AgentMonitorEntry[]>()
  for (const entry of entries) {
    const group = groups.get(entry.rootSessionId)
    if (group) group.push(entry)
    else groups.set(entry.rootSessionId, [entry])
  }

  return [...groups.values()]
    .sort((a, b) => compareAttention(strongest(a), strongest(b)))
    .flatMap(orderGroup)
}

/** 整组的排序键 = 组内最强的一条（组是一个整体，不该被自己最闲的成员代表） */
function strongest(members: readonly AgentMonitorEntry[]): AgentMonitorEntry {
  return members.reduce((best, entry) => (compareAttention(entry, best) < 0 ? entry : best))
}

/**
 * 组内血缘序：父在前、子紧随，同一父下的兄弟之间照旧按注意力排。
 *
 * 父级不在本组的（父运行时已销毁，或父就是根会话本身而根 agent 已注销）当作组的顶层，
 * 否则 DFS 够不到它们 —— 这个列表的第一职责是"把赖着的都指出来"，少一行比顺序难看糟得多，
 * 故末尾还有一道兜底扫描（血缘成环时唯一的出口，正常登记不会出现）。
 */
function orderGroup(members: AgentMonitorEntry[]): AgentMonitorEntry[] {
  const present = new Set(members.map((entry) => entry.agentId))
  const children = new Map<string, AgentMonitorEntry[]>()
  const tops: AgentMonitorEntry[] = []
  for (const entry of members) {
    const parentId = entry.parentAgentId
    if (parentId && parentId !== entry.agentId && present.has(parentId)) {
      const siblings = children.get(parentId)
      if (siblings) siblings.push(entry)
      else children.set(parentId, [entry])
    } else tops.push(entry)
  }

  const ordered: AgentMonitorEntry[] = []
  const seen = new Set<string>()
  const visit = (entry: AgentMonitorEntry): void => {
    if (seen.has(entry.agentId)) return
    seen.add(entry.agentId)
    ordered.push(entry)
    for (const child of (children.get(entry.agentId) ?? []).sort(compareAttention)) visit(child)
  }
  for (const top of tops.sort(compareAttention)) visit(top)
  for (const entry of [...members].sort(compareAttention)) visit(entry)
  return ordered
}

/**
 * 单个 agent 运行时的**完整**快照（展开某条时按需拉一次）。
 * TODO(pi-durable p3): 接 durable 的运行时数据；现在列表恒空，没有可展开的条目。
 */
export async function getAgentRuntimeDetail(_agentId: string): Promise<AgentRuntimeInfo | null> {
  return null
}
