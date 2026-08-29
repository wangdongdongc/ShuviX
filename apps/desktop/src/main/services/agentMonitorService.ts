/**
 * 智能体监控服务（桌面宿主）—— 把 `agentRuntimeRegistry` 的快照补上会话身份后交给设置页。
 *
 * 本服务**不持有任何状态**：数值全部现取自 pi 原生运行时对象（注册中心已把 pi 的私有
 * 相位/队列/用量从事件流归约出来），这里只做一件 pi 不可能知道的事 —— 把 agent 挂到
 * 具体的会话上，并回答"那个会话还在吗"。
 *
 * 两个入口，冷热分明：
 *  - `listAgentRuntimes`（轮询路径）刻意保持"廉价"：注册中心的快照全是字段读与事件影子
 *    （上下文占用也是从 message_end 的 provider 用量归约来的），这里再补几次会话主键点查
 *    即可 —— 轮询路径上不存在任何遍历会话树的动作。
 *  - `getAgentRuntimeDetail`（用户展开某条时才调用一次）才去读运行时的"贵"的那一半：
 *    系统提示词全文、工具定义、上下文消息数。刻意不并进列表，否则每秒轮询都要重建一次上下文。
 */
import { agentRuntimeRegistry } from '@shuvix/agent-runtime'
import type { AgentMonitorEntry } from '@shuvix/chat-protocol/types/agentMonitor'
import type { AgentRuntimeInfo } from '@shuvix/chat-protocol/chatApi'
import { sessionDao } from '../dao/sessionDao'
import { providerDao } from '../dao/providerDao'
import { agentManager } from '../agents/AgentManager'
import { sessionService } from './sessionService'

/**
 * 全部活跃 agent 运行时，按血缘分组、组间按"最该被注意"排序。
 *
 * 注意力排序刻意不按启动时间 —— 诊断时想先看到的是"刚跑完还赖着"和"跑了很久没动静"，
 * 这两类都由 lastActivityAt 表达。但它只能排**组**，不能排条目：行首的缩进箭头
 * 声称"我是上面那位派出去的"，所以相邻关系必须由血缘决定（见 orderByLineage）。
 */
export function listAgentRuntimes(): AgentMonitorEntry[] {
  // 会话身份按主键点查并按 rootSessionId 缓存：活跃 agent 通常只归属少数几个会话，
  // 而本列表要被每秒轮询 —— 拉全表求存在性会让轮询代价随历史会话数线性增长。
  // 存在性直接由点查是否命中给出，不需要第二次查询。
  const lookup = new Map<string, { title?: string; exists: boolean }>()
  const resolve = (rootSessionId: string): { title?: string; exists: boolean } => {
    const cached = lookup.get(rootSessionId)
    if (cached) return cached
    const row = sessionDao.pick(rootSessionId, ['title'])
    const resolved = { title: row?.title, exists: !!row }
    lookup.set(rootSessionId, resolved)
    return resolved
  }

  // 提供商名：内置提供商的 model.provider 本就是 'anthropic' 这样的可读串，自定义提供商
  // 存的却是行 id（UUID）—— 直接显示等于没显示。同样按点查 + 缓存，提供商数量本就是个位数。
  const providerNames = new Map<string, string>()
  const providerName = (id: string): string => {
    const cached = providerNames.get(id)
    if (cached !== undefined) return cached
    const resolved = providerDao.pick(id, ['name'])?.name ?? id
    providerNames.set(id, resolved)
    return resolved
  }

  const entries = agentRuntimeRegistry.list().map<AgentMonitorEntry>((snap) => {
    const { title, exists } = resolve(snap.rootSessionId)
    return {
      ...snap,
      model: { ...snap.model, provider: providerName(snap.model.provider) },
      rootSessionTitle: title,
      rootSessionExists: exists
    }
  })

  return orderByLineage(entries)
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
 * 单个 agent 运行时的**完整**快照（展开某条时按需拉一次）：系统提示词与工具定义都取自
 * 内存中的运行时对象，与实际下发给 LLM 的内容零漂移 —— 这正是这页相对"读档案文件"的价值。
 *
 * 两类 agent 的运行时住在不同地方，故按 kind 分派：root 在会话服务里（agentId 即会话 id），
 * 派生的只活在派发协调器的 map 里（没有会话行，会话服务够不到）。
 * 已被销毁 / 不在登记簿里的 agentId 返回 null（轮询与点击之间存在时间差，属正常竞态）。
 */
export async function getAgentRuntimeDetail(agentId: string): Promise<AgentRuntimeInfo | null> {
  const snap = agentRuntimeRegistry.get(agentId)
  if (!snap) return null
  if (snap.kind === 'root') {
    // 只读已存在的运行时：监控页不该把 agent 建出来（列表本就只列活着的）
    const agent = sessionService.getAgentSession(agentId)
    return (await agent?.getRuntimeInfo()) ?? null
  }
  return await agentManager.getRuntimeInfo(agentId)
}
