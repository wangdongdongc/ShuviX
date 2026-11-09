import { useCallback, useEffect } from 'react'
import { getChatApi, useAppEvent, useChatStore, useUnreadStore } from '@shuvix/chat-ui'

/**
 * 收件箱的已读（docs/inbox-read-state-design.md）在这个前端的镜像：挂载时、`session.listChanged`（web 客户端
 * 重连后补发）时取一份全量，之后跟 `session.unreadChanged` 事件。取失败就保持现状，等下一个事件。
 *
 * 切到一条会话时先记下它的「新内容」锚点：打开的那一刻主进程就把它标成已读了（窗口上报当前会话 → 来到眼前），
 * 事件回来未读就没了；这里的 effect 与上报同一次提交、在 IPC 往返之前跑，读到的还是切换前的未读。
 */
export function useUnreadSeed(): void {
  const refetch = useCallback(() => {
    const request = getChatApi().session.unread?.()
    if (!request) return
    void request
      .then((unread) => useUnreadStore.getState().replaceAll(unread))
      .catch(() => {
        /* 保持现状 */
      })
  }, [])
  useEffect(refetch, [refetch])
  useAppEvent('session.listChanged', refetch)
  useAppEvent('session.unreadChanged', (event) => {
    useUnreadStore.getState().set(event.sessionId, event.unread)
  })

  const activeSessionId = useChatStore((s) => s.activeSessionId)
  useEffect(() => {
    useUnreadStore.getState().noteOpened(activeSessionId)
  }, [activeSessionId])
}
