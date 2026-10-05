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
  const [state, setState] = useState<ViewBindingState>(LOADING)

  useEffect(() => {
    if (!agentId) return
    const client = syncClientFor(getSessionChannelApi().sync)
    const sub = client.acquire<AgentView>({ kind: 'agent', agentId })
    let active = true
    setState(sub.state())
    const stop = sub.subscribe((event) => {
      if (!active) return
      if (event.kind === 'value') applyAgentView(agentId, event.value)
      else setState(event.state)
    })
    const current = sub.value()
    if (current !== undefined) applyAgentView(agentId, current)
    return () => {
      active = false
      stop()
      sub.release()
    }
  }, [agentId])

  return state
}
