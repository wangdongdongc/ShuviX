import { useEffect } from 'react'
import { getChatApi, useChatStore } from '@shuvix/chat-ui'
import { takePendingSessionDraft } from './sessionDraftStash'

/**
 * 悬浮聊天窗口与从系统打开的 md 窗口：只上报"在看哪个会话"，不接受通知跳转（跳转恒落在主窗）——
 * 它们各自钉着一条会话，被一次通知点击换掉就不再是那个窗口了
 */
const isPinnedWindow =
  window.location.hash.startsWith('#pinned-chat') ||
  window.location.hash.startsWith('#markdown-window')

/**
 * 通知桥 —— 渲染层与主进程通知服务之间的两条细线。
 *
 * 上行：当前展示的会话。主进程不持有 activeSessionId（那是 chatStore 的状态），
 * 但「用户已经看着它了就别弹」的判定必须在主进程做 —— macOS 关窗后应用仍在跑、
 * agent 仍在干活，那时根本没有渲染进程，而那正是最该弹通知的时刻。
 * 窗口重新获得焦点时补报一次：主进程收到即把该会话名下未读通知撤回。
 *
 * 下行：通知点击要打开的会话。窗口活着走推送；窗口是被这次点击重建出来的，
 * 目标就暂存在主进程，挂载后取一次。设置页的「让 agent 帮我设置」（远程访问的安全策略）走同一条路：
 * 切过去之后再取走主进程替它记着的草稿（`app:take-session-draft`），填进输入框、不自动发送；会话是刚建的、
 * 本页的列表里还没有它 → 先重拉一次列表。web 的设置页在自己的标签页里，草稿经 sessionStorage 带回来
 * （sessionDraftStash.ts），挂载时取一次。
 */

/** 切到一条会话（列表里还没有就先重拉），再把草稿填进输入框（`draft` 缺省 → 问主进程要） */
async function openSession(sessionId: string, draft?: string): Promise<void> {
  if (!useChatStore.getState().sessions.some((s) => s.id === sessionId)) {
    try {
      useChatStore.getState().setSessions(await getChatApi().session.list())
    } catch {
      /* 列表拉不到：照样切过去 */
    }
  }
  useChatStore.getState().setActiveSessionId(sessionId)
  const text =
    draft ?? (await window.api.app.takeSessionDraft(sessionId).catch(() => null)) ?? undefined
  if (text) useChatStore.getState().requestDraftRestore(text)
}
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
      void openSession(sessionId)
    })
  }, [])

  useEffect(() => {
    if (isPinnedWindow) return
    const pending = takePendingSessionDraft()
    if (pending) {
      void openSession(pending.sessionId, pending.draft)
      return
    }
    void window.api.notification.consumePendingOpenSession().then((sessionId) => {
      if (sessionId) void openSession(sessionId)
    })
  }, [])
}
