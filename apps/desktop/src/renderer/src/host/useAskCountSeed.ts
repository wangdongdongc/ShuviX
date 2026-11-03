import { useCallback, useEffect } from 'react'
import { getChatApi, useAppEvent, useChatStore } from '@shuvix/chat-ui'

/**
 * 补侧栏的询问徽标。询问一直等人，不看有没有前端（2026-11-02），而 `ask_count` 是事件：窗口重建、web 客户端连上来
 * 之前发的都错过了，用户回来时看不出哪条会话在等他。所以挂载时取一份，`session.listChanged` 时再取一份 ——
 * web 客户端重连后补发的信号事件里有它，断线期间已经答掉的询问也随之消失。
 *
 * 应答与事件走同一条有序的连接（IPC / WebSocket），算出这份之后发出的 `ask_count` 排在应答后面，不会被它盖掉
 * （算好到发出之间隔一个微任务，那里头的事件会被盖掉，到下一个事件为止；窗口太小，不值得多一层判断）。
 * 取失败就保持现状，等下一个事件。
 */
export function useAskCountSeed(): void {
  const refetch = useCallback(() => {
    void getChatApi()
      .agent.askCounts()
      .then((counts) => useChatStore.getState().setAskCounts(counts))
      .catch(() => {
        /* 保持现状 */
      })
  }, [])
  useEffect(refetch, [refetch])
  useAppEvent('session.listChanged', refetch)
}
