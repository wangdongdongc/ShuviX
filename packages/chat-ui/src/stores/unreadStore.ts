/**
 * 收件箱的已读 / 未读在前端的镜像（docs/inbox-read-state-design.md）。真源在主进程（session_unread 表）：
 * 这里只跟着 `session.unreadChanged` 事件改、靠 `session.unread` 补种，自己从不判定谁读没读。
 *
 * 另记一样只属于这个前端的东西：**这一次打开的会话从哪里起是新内容**（`mark`）。打开一条未读会话的那一刻主进程
 * 就把它标成已读了，未读随即消失；分隔线要画的是「这次打开之前没看过的部分」，所以切进来时先记下锚点，
 * 离开这条会话就不再画。
 */

import { create } from 'zustand'
import type { SessionUnread } from '@shuvix/chat-protocol/sessionUnread'

interface UnreadState {
  /** 会话 id → 未读（只有未读的会话在表里） */
  unread: Record<string, SessionUnread>
  /** 此刻展示的会话从哪一刻起是新内容（切进来时它是未读、且有锚点才有） */
  mark: { sessionId: string; at: number } | null
  /** 整份换成主进程的（补种） */
  replaceAll: (unread: Record<string, SessionUnread>) => void
  /** 一条会话的状态变了（事件）：null = 读过了 */
  set: (sessionId: string, unread: SessionUnread | null) => void
  /** 切到一条会话时：它此刻未读且有锚点 → 记下；否则清掉 */
  noteOpened: (sessionId: string | null) => void
}

export const useUnreadStore = create<UnreadState>((set, get) => ({
  unread: {},
  mark: null,
  replaceAll: (unread) => set({ unread }),
  set: (sessionId, unread) =>
    set((state) => {
      if (unread === null) {
        if (!(sessionId in state.unread)) return state
        const next = { ...state.unread }
        delete next[sessionId]
        return { unread: next }
      }
      return { unread: { ...state.unread, [sessionId]: unread } }
    }),
  noteOpened: (sessionId) => {
    const anchorAt = sessionId ? get().unread[sessionId]?.anchorAt : undefined
    const mark = sessionId && anchorAt !== undefined ? { sessionId, at: anchorAt } : null
    const prev = get().mark
    if (prev?.sessionId === mark?.sessionId && prev?.at === mark?.at) return
    set({ mark })
  }
}))
