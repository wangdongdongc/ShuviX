import { useEffect } from 'react'
import { useChatStore } from '@shuvix/chat-ui'

/** 悬浮聊天窗口：只上报"在看哪个会话"，不接受通知跳转（跳转恒落在主窗） */
const isPinnedWindow = window.location.hash.startsWith('#pinned-chat')

/**
 * 通知桥 —— 渲染层与主进程通知服务之间的两条细线。
 *
 * 上行：当前展示的会话。主进程不持有 activeSessionId（那是 chatStore 的状态），
 * 但「用户已经看着它了就别弹」的判定必须在主进程做 —— macOS 关窗后应用仍在跑、
 * agent 仍在干活，那时根本没有渲染进程，而那正是最该弹通知的时刻。
 * 窗口重新获得焦点时补报一次：主进程收到即把该会话名下未读通知撤回。
 *
 * 下行：通知点击要打开的会话。窗口活着走推送；窗口是被这次点击重建出来的，
 * 目标就暂存在主进程，挂载后取一次。
 */
export function useNotificationBridge(): void {
  const activeSessionId = useChatStore((s) => s.activeSessionId)

  useEffect(() => {
    const report = (): void => {
      void window.api.notification.reportActiveSession(activeSessionId ?? null)
    }
    report()
    window.addEventListener('focus', report)
    return () => window.removeEventListener('focus', report)
  }, [activeSessionId])

  useEffect(() => {
    if (isPinnedWindow) return
    return window.api.notification.onOpenSession((sessionId) => {
      useChatStore.getState().setActiveSessionId(sessionId)
    })
  }, [])

  useEffect(() => {
    if (isPinnedWindow) return
    void window.api.notification.consumePendingOpenSession().then((sessionId) => {
      if (sessionId) useChatStore.getState().setActiveSessionId(sessionId)
    })
  }, [])
}
