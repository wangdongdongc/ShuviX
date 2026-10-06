import { useEffect, useState } from 'react'
import type { SessionView } from '@shuvix/chat-protocol/types/sessionView'
import { getSessionChannelApi } from '../api/chatApi'
import { applySessionView, releaseSessionView } from '../stores/chatStore'
import { syncClientFor, type ViewBindingState } from '../sync/syncClient'

const LOADING: ViewBindingState = { status: 'loading' }

/**
 * 订阅一条会话的视图（P3-08），把每一份完整值经唯一写入口 `applySessionView` 镜像进 chatStore。
 *
 *  - 同一条会话的多个使用方共用一个订阅（syncClient 引用计数）；卸载 / 换会话即放手，最后一个放手才退订；
 *  - 视图不可用（会话被删）→ `applySessionView(id, null)`：派生切片回到空视图（PIN-14）；
 *  - 订阅失败 → `{status:'error', code}`，不写这条会话的切片、不重试（P3-08-04）；
 *  - 放手时丢掉这条会话的视图切片（`releaseSessionView`），运行标记 / 询问计数改由余项接手。
 *
 * 返回绑定状态（loading / live / unavailable / error）。`sessionId` 为 null 时什么都不订。
 */
export function useSessionView(sessionId: string | null): ViewBindingState {
  // 状态按目标记：换了目标、新的订阅还没报过状态之前一律是 loading
  const [entry, setEntry] = useState<{ id: string | null; state: ViewBindingState }>({
    id: null,
    state: LOADING
  })

  useEffect(() => {
    if (!sessionId) return
    const client = syncClientFor(getSessionChannelApi().sync)
    const sub = client.acquire<SessionView>({ kind: 'session', sessionId })
    let active = true
    // 共用的订阅可能早就 live 了：把它此刻的状态补报一次（不在 effect 里同步 setState）
    queueMicrotask(() => {
      if (active) setEntry({ id: sessionId, state: sub.state() })
    })
    const stop = sub.subscribe((event) => {
      if (!active) return
      if (event.kind === 'value') applySessionView(sessionId, event.value)
      else {
        if (event.state.status === 'unavailable') applySessionView(sessionId, null)
        setEntry({ id: sessionId, state: event.state })
      }
    })
    // 共用的订阅可能早已有值（别处先订了）：先镜像一份
    const current = sub.value()
    if (current !== undefined) applySessionView(sessionId, current)
    return () => {
      active = false
      stop()
      // 最后一个使用方离开才丢掉这条会话的视图切片（同一窗口里别处还订着就留着）
      if (sub.release()) releaseSessionView(sessionId)
    }
  }, [sessionId])

  return entry.id === sessionId ? entry.state : LOADING
}
