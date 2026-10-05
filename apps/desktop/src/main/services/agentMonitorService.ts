/**
 * 智能体监控服务（桌面宿主）—— 设置页「监视器 → 智能体」与会话横幅 agent 胶囊的数据源（P3-13）。
 *
 * 列的是**打开着的会话**（`openSessionIds()` + `host.get`）：每条问一次 `DurableSession.monitorSnapshot()`
 * —— 根 agent（锁着时）与加载在它 Harness 里的派生 / hook agent（PIN-02）。**从不 open / peek**：那会打开
 * 关着的会话、并刷新 LRU 新近度（轮询每秒一次，会让修剪永远挑不出最久没用的那条）；宿主还没建过就答 `[]`，
 * 也不替它建。宿主只补 pi 不可能知道的两样：会话标题、根档案的显示名（`shuvix-displayName`，空则档案名），
 * 以及把自定义 provider 的行 id 换成行名。一条会话读失败只跳过它（记一条警告），不拖垮整张表。
 *
 * 血缘排序（orderByLineage）是纯函数 —— 数据源换了，分组与注意力排序的规则不变；interrupted 与 idle
 * 一样算「没在跑」（PIN-05）。
 */
import type { AgentMonitorRow, DurableSession, SessionHost } from '@shuvix/agent-runtime'
import { SessionClosedError } from '@shuvix/agent-runtime'
import type { AgentMonitorEntry } from '@shuvix/chat-protocol/types/agentMonitor'
import type { AgentRuntimeInfo } from '@shuvix/chat-protocol/chatApi'
import { agentManager } from '../agents/AgentManager'
import { providerDao } from '../dao/providerDao'
import { createLogger } from '../logger'
import { agentService } from './agentService'
import { peekSessionHost } from './sessionHost'
import { sessionRecords } from './sessionRecords'
import { sessionService } from './sessionService'

const log = createLogger('AgentMonitor')

/** 根档案显示名的缓存（档案表要扫用户目录；轮询每秒一次，显示名几乎不变） */
const DISPLAY_NAME_TTL_MS = 5_000
let displayNames: { readonly at: number; readonly names: Map<string, string> } | undefined

function profileDisplayName(profileName: string): string {
  const now = Date.now()
  if (displayNames === undefined || now - displayNames.at > DISPLAY_NAME_TTL_MS) {
    displayNames = { at: now, names: new Map() }
  }
  const cached = displayNames.names.get(profileName)
  if (cached !== undefined) return cached
  let name = profileName
  try {
    name = agentService.getProfile(profileName)?.displayName?.trim() || profileName
  } catch (err) {
    log.warn(`resolving the display name of profile ${profileName} failed: ${err}`)
  }
  displayNames.names.set(profileName, name)
  return name
}

/** 仅供单测：丢掉显示名缓存 */
export function resetAgentMonitorCachesForTests(): void {
  displayNames = undefined
}

/**
 * 打开着的会话里的全部 agent，按血缘分组、组间按「最该被注意」排序。
 *
 * 会话标题与 provider 名按主键点查并在本次调用内缓存（agent 通常只归属少数几个会话、provider 个位数）。
 */
export async function listAgentRuntimes(): Promise<AgentMonitorEntry[]> {
  const host = peekSessionHost()
  if (host === undefined) return []
  const titles = new Map<string, string | undefined>()
  const titleOf = (sessionId: string): string | undefined => {
    if (!titles.has(sessionId)) titles.set(sessionId, sessionRecords.pick(sessionId, ['title'])?.title)
    return titles.get(sessionId)
  }
  // 内置 provider 的 pi id 本就是可读的 slug；自定义 provider 的是行 id（UUID）—— 换成行名
  const providerNames = new Map<string, string>()
  const providerName = (id: string): string => {
    let name = providerNames.get(id)
    if (name === undefined) {
      name = (id ? providerDao.pick(id, ['name'])?.name : undefined) ?? id
      providerNames.set(id, name)
    }
    return name
  }

  const entries: AgentMonitorEntry[] = []
  for (const sessionId of host.openSessionIds()) {
    const rows = await snapshotOf(host, sessionId)
    for (const row of rows) {
      const { conversationId: _conversationId, displayName, ...rest } = row
      const title = titleOf(row.rootSessionId)
      entries.push({
        ...rest,
        displayName: row.kind === 'root' ? profileDisplayName(row.profileName) : (displayName ?? ''),
        model: { ...row.model, provider: providerName(row.model.provider) },
        ...(title === undefined ? {} : { rootSessionTitle: title })
      })
    }
  }
  return orderByLineage(entries)
}

/** 一条打开着的会话的行；关掉了（轮询与关停的竞态）→ 无声跳过；读失败 → 跳过并记警告 */
async function snapshotOf(host: SessionHost, sessionId: string): Promise<AgentMonitorRow[]> {
  const session: DurableSession | undefined = host.get(sessionId)
  if (session === undefined || session.closed) return []
  try {
    return await session.monitorSnapshot()
  } catch (err) {
    if (!(err instanceof SessionClosedError) && !session.closed) {
      log.warn(`reading the monitor snapshot of session ${sessionId} failed: ${err}`)
    }
    return []
  }
}

/** 「最该被注意」：先跑着的，再按最近活动倒序 */
function compareAttention(a: AgentMonitorEntry, b: AgentMonitorEntry): number {
  const running = (e: AgentMonitorEntry): number =>
    e.phase === 'turn' || e.phase === 'compaction' ? 0 : 1
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
 * 单个 agent 的**完整**快照（展开某条时按需拉一次；P3-06 / P3-13 PIN-06）：系统提示词与下一次请求逐字节相同。
 *
 * 按 agentId 分派：根 agent 的 agentId 即会话 id（打开着的会话，读它锁所在的对话）；派生 agent（含 hook
 * agent）先在**打开着的会话**的 agent 目录里找（`spawnedRecords()`，不依赖路由的索引 —— 重开过的会话里闲着
 * 的子 agent 路由还不认得），找不到再问路由。**只读已有的**：从不打开会话、从不创建 agent、从不装扩展 ——
 * 没开着、没锁、不认识 / 已销毁的 agentId 都答 null（轮询与点击之间的正常竞态）。
 */
export async function getAgentRuntimeDetail(agentId: string): Promise<AgentRuntimeInfo | null> {
  const session = sessionService.getAgentSession(agentId)
  if (session) return await session.getRuntimeInfo()
  const host = peekSessionHost()
  for (const sessionId of host?.openSessionIds() ?? []) {
    const durable = host?.get(sessionId)
    if (durable === undefined || durable.closed) continue
    const record = durable.spawnedRecords().find((candidate) => candidate.agentId === agentId)
    if (record === undefined) continue
    try {
      return (await durable.agentInfo(record.conversationId)) ?? null
    } catch (err) {
      if (err instanceof SessionClosedError || durable.closed) return null
      throw err
    }
  }
  if (agentManager.has(agentId)) return await agentManager.getRuntimeInfo(agentId)
  return null
}
