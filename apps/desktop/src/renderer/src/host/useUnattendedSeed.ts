import { useCallback, useEffect } from 'react'
import { getChatApi, useAppEvent, useChatStore } from '@shuvix/chat-ui'

/**
 * 补「这一轮无人值守」的状态（会话头部的图标读它）。`unattended` 是事件，窗口重建、web 客户端连上来之前发的都错过了，
 * 所以挂载时取一份、`session.listChanged` 时再取一份 —— 与 useAskCountSeed 同一个做法；换到另一条会话时也取一份
 * （没被这个窗口打开过的会话，它运行时的事件不一定送到这里）。取失败就保持现状。
 */
export function useUnattendedSeed(): void {
  const refetch = useCallback(() => {
    const query = getChatApi().agent.unattended
    if (!query) return
    void query()
      .then((ids) => useChatStore.getState().setUnattendedSessions(ids))
      .catch(() => {
        /* 保持现状 */
      })
  }, [])
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  useEffect(refetch, [refetch, activeSessionId])
  useAppEvent('session.listChanged', refetch)
}
