import { useEffect, useState } from 'react'
import type { AgentView } from '@shuvix/chat-protocol/types/sessionView'
import { getSessionChannelApi } from '../api/chatApi'
import { applyAgentView, detachAgentView } from '../stores/subSessionStore'
import { shareStructure } from '../stores/viewDerivation'
import { syncClientFor, type ViewBindingState } from '../sync/syncClient'

/** `useAgentView` 的结果：绑定状态，加上最近一份视图（还没到过 → 没有） */
export interface AgentViewBinding extends ViewBindingState {
  /**
   * 最近一份视图（与上一份逐项共享）。视图不可用 / 订阅失败之后仍留着最后那份 —— 面板据此保留已经画出来的
   * 消息（P3-14-20）；登记过的 agent 同时镜像在 subSessionStore 里
   */
  readonly view?: AgentView
}

const LOADING: AgentViewBinding = { status: 'loading' }

interface Entry {
  readonly id: string | null
  readonly binding: AgentViewBinding
}

/**
 * 订阅一个派生 agent 的视图（P3-08；后台任务面板的派生 agent 详情展开时挂它，P3-14），每一份完整值经
 * `applyAgentView` 镜像进 subSessionStore（只更新登记过的那条，PIN-07），同时交回给调用方（没有登记条目的
 * 面板 —— 重建过的渲染端 —— 直接从它渲染，PIN-13）。订阅失败（如根会话还没在主进程里打开：
 * `service_not_found`，PIN-12）→ `{status:'error', code}`，不写 store。视图不可用 / 订阅失败 / 最后一个使用方
 * 放手 → `detachAgentView` 收掉条目的实时态（已落盘的消息留着）。
 */
export function useAgentView(agentId: string | null): AgentViewBinding {
  // 状态按目标记：换了目标、新的订阅还没报过状态之前一律是 loading
  const [entry, setEntry] = useState<Entry>({ id: null, binding: LOADING })

  useEffect(() => {
    if (!agentId) return
    const client = syncClientFor(getSessionChannelApi().sync)
    const sub = client.acquire<AgentView>({ kind: 'agent', agentId })
    let active = true
    const update = (patch: (binding: AgentViewBinding) => AgentViewBinding): void =>
      setEntry((prev) => {
        const base = prev.id === agentId ? prev.binding : LOADING
        const next = patch(base)
        return next === base && prev.id === agentId ? prev : { id: agentId, binding: next }
      })
    const withView = (binding: AgentViewBinding, value: AgentView): AgentViewBinding => {
      const view = shareStructure(binding.view, value)
      return view === binding.view ? binding : { ...binding, view }
    }
    // 共用的订阅可能早就 live 了：把它此刻的状态补报一次（不在 effect 里同步 setState）
    queueMicrotask(() => {
      if (!active) return
      const state = sub.state()
      const current = sub.value()
      update((binding) => {
        const next: AgentViewBinding = {
          ...(binding.view === undefined ? {} : { view: binding.view }),
          ...state
        }
        return current === undefined ? next : withView(next, current)
      })
    })
    const stop = sub.subscribe((event) => {
      if (!active) return
      if (event.kind === 'value') {
        applyAgentView(agentId, event.value)
        update((binding) => withView(binding, event.value))
        return
      }
      const { state } = event
      if (state.status === 'unavailable' || state.status === 'error') detachAgentView(agentId)
      update((binding) => ({
        ...(binding.view === undefined ? {} : { view: binding.view }),
        ...state
      }))
    })
    const current = sub.value()
    if (current !== undefined) applyAgentView(agentId, current)
    return () => {
      active = false
      stop()
      if (sub.release()) detachAgentView(agentId)
    }
  }, [agentId])

  return entry.id === agentId ? entry.binding : LOADING
}
