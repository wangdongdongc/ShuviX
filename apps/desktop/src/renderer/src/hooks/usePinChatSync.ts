import { useEffect } from 'react'
import { usePinChatStore } from '../stores/pinChatStore'

/**
 * 同步主进程的悬浮聊天状态到本窗口的 pinChatStore。
 *
 * - 挂载时通过 getState() 拉取一次初值（兜底窗口刚加载完丢失的事件）
 * - 持续订阅 'window:pin-state-changed' 事件
 *
 * 在 App.tsx 顶层调用一次即可（主窗口 & 悬浮窗口都需要）。
 */
export function usePinChatSync(): void {
  const setPinnedSessionIds = usePinChatStore((s) => s.setPinnedSessionIds)

  useEffect(() => {
    let cancelled = false
    void window.api.pinChat.getState().then((state) => {
      if (!cancelled) setPinnedSessionIds(state.pinnedSessionIds)
    })
    // AppEvent 'pinChat.changed'（替代旧 pinChat.onStateChanged）
    const off = window.api.events.subscribe((event) => {
      if (event.type === 'pinChat.changed') setPinnedSessionIds(event.pinnedSessionIds)
    })
    return () => {
      cancelled = true
      off()
    }
  }, [setPinnedSessionIds])
}
