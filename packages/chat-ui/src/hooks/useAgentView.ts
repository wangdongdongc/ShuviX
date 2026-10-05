import { useEffect, useState } from 'react'
import type { AgentView } from '@shuvix/chat-protocol/types/sessionView'
import { getSessionChannelApi } from '../api/chatApi'
import { applyAgentView } from '../stores/subSessionStore'
import { syncClientFor, type ViewBindingState } from '../sync/syncClient'

const LOADING: ViewBindingState = { status: 'loading' }

/**
 * 订阅一个派生 agent 的视图（P3-08；面板接它在 P3-14），每一份完整值经 `applyAgentView` 镜像进
 * subSessionStore（只更新登记过的那条，PIN-07）。订阅失败（如重启后路由认不出它：`service_not_found`）
 * → `{status:'error', code}`，不写 store。卸载即放手，最后一个放手才退订。
 */
export function useAgentView(agentId: string | null): ViewBindingState {
  // 状态按目标记：换了目标、新的订阅还没报过状态之前一律是 loading
  const [entry, setEntry] = useState<{ id: string | null; state: ViewBindingState }>({
    id: null,
    state: LOADING
  })

  useEffect(() => {
    if (!agentId) return
    const client = syncClientFor(getSessionChannelApi().sync)
    const sub = client.acquire<AgentView>({ kind: 'agent', agentId })
    let active = true
    // 共用的订阅可能早就 live 了：把它此刻的状态补报一次（不在 effect 里同步 setState）
    queueMicrotask(() => {
      if (active) setEntry({ id: agentId, state: sub.state() })
    })
    const stop = sub.subscribe((event) => {
      if (!active) return
      if (event.kind === 'value') applyAgentView(agentId, event.value)
      else setEntry({ id: agentId, state: event.state })
    })
    const current = sub.value()
    if (current !== undefined) applyAgentView(agentId, current)
    return () => {
      active = false
      stop()
      sub.release()
    }
  }, [agentId])

  return entry.id === agentId ? entry.state : LOADING
}
