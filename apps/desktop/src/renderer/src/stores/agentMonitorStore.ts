/**
 * agent 运行时监控的 renderer 共享 store —— monitor 列表、会话筛选与全局唯一轮询器。
 *
 * 为什么收进 store：会话横幅上的 profile 标记（AgentProfileChip）与右栏 agents tab
 * （AgentMonitorPanel）消费同一份 `monitorList()` 快照，各自起 1s 轮询就是双份 IPC。
 * 这里用引用计数保证全局同一时刻最多一个轮询器：第一个订阅者启动并立即拉一次，最后
 * 一个退订时停表。订阅方：ChatView（每个会话视图常驻，驱动横幅标记 —— 订阅放在
 * ChatView 而非 chip 内，是因为 chip 只在 root entry 出现后才有内容可渲染，若由它自持
 * 订阅，新会话永远等不到第一次拉取）与 AgentMonitorPanel（仅 active 时）。
 *
 * sessionFilter 是 agents tab 的会话筛选（按 rootSessionId 匹配，root 与派生 entry 都算），
 * 面板级状态，不持久化。
 */
import { create } from 'zustand'
import type { AgentMonitorEntry } from '@shuvix/chat-protocol/types/agentMonitor'

/** 轮询间隔：相位/活动时间要看着是活的，又不值得铺跨窗口事件推送 */
const POLL_MS = 1000

interface AgentMonitorState {
  entries: AgentMonitorEntry[]
  /** 首次拉取完成前为 true（面板用它显示加载态） */
  loading: boolean
  /** agents tab 的会话筛选：非 null 时只显示 rootSessionId 匹配的条目 */
  sessionFilter: string | null
  setSessionFilter: (sessionId: string | null) => void
}

export const useAgentMonitorStore = create<AgentMonitorState>((set) => ({
  entries: [],
  loading: true,
  sessionFilter: null,
  setSessionFilter: (sessionFilter) => set({ sessionFilter })
}))

let subscribers = 0
let timer: ReturnType<typeof setInterval> | null = null
/** 在途请求去重：上一轮 IPC 未回时跳过本轮（慢主进程下也不会叠请求） */
let inFlight = false

async function fetchOnce(): Promise<void> {
  if (inFlight) return
  inFlight = true
  try {
    const rows = await window.api.agent.monitorList()
    useAgentMonitorStore.setState({ entries: rows, loading: false })
  } catch {
    // 拉取失败保留旧快照，下一轮再试；loading 必须落地，否则面板永远转圈
    useAgentMonitorStore.setState({ loading: false })
  } finally {
    inFlight = false
  }
}

/**
 * 订阅监控轮询（引用计数），返回退订函数。第一个订阅者启动全局 1s 轮询并立即拉一次；
 * 最后一个退订时停表。
 */
export function subscribeAgentMonitor(): () => void {
  subscribers += 1
  if (subscribers === 1) {
    void fetchOnce()
    timer = setInterval(() => void fetchOnce(), POLL_MS)
  }
  return () => {
    subscribers = Math.max(0, subscribers - 1)
    if (subscribers === 0 && timer) {
      clearInterval(timer)
      timer = null
    }
  }
}

/** 立即拉一次（面板手动刷新按钮），与轮询同源、无订阅者时也可用 */
export async function refreshAgentMonitor(): Promise<void> {
  await fetchOnce()
}
