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
 * 全部活跃 agent 运行时，按"最该被注意"排序：先跑着的，再按最近活动倒序。
 *
 * 排序刻意不按启动时间 —— 诊断时想先看到的是"刚跑完还赖着"和"跑了很久没动静"，
 * 这两类都由 lastActivityAt 表达。
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

  return entries.sort((a, b) => {
    const running = (e: AgentMonitorEntry): number => (e.phase === 'idle' ? 1 : 0)
    return running(a) - running(b) || b.lastActivityAt - a.lastActivityAt
  })
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
