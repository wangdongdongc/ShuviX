/**
 * 收件箱开着没有，以及它的数据来源（第一版：此刻在运行的会话，见 inboxItems.ts）。
 *
 * 打开收件箱 = 把活动会话清空、再标记打开：主区在「没有活动会话」时本来就画欢迎页那一格，桌面把那一格换成
 * 收件箱页（顶栏、侧栏开关都照旧）；侧栏里也就只有收件箱这一行是选中的。之后**任何**途径选中一条会话
 * （点侧栏、点收件箱里的条目、通知、会话链接、新建会话）都会把活动会话设成非空 —— 这里订阅着它，收件箱随之关上，
 * 不必每个入口各自记得关。
 */

import { useMemo } from 'react'
import { create } from 'zustand'
import {
  selectAllPendingCounts,
  selectBgRunKinds,
  selectStreamingSessions,
  taskRunKind,
  useBgTaskStore,
  useChatStore,
  useUnreadStore
} from '@shuvix/chat-ui'
import { inboxSectionsOf, type InboxSections } from './inboxItems'

interface InboxState {
  open: boolean
  /** 打开收件箱（活动会话随之清空） */
  openInbox: () => void
  closeInbox: () => void
}

/**
 * 选中了某条会话 → 收件箱关上（见文件头）。第一次打开收件箱时才订阅：模块加载时不碰 chat-ui 的 store
 * （app-shell 的 DOM 测试整个替换掉 `@shuvix/chat-ui`，替身上没有 subscribe）
 */
let watchingSelection = false
function watchSelection(): void {
  if (watchingSelection) return
  watchingSelection = true
  useChatStore.subscribe((state, prev) => {
    if (!state.activeSessionId || state.activeSessionId === prev.activeSessionId) return
    if (useInboxStore.getState().open) useInboxStore.getState().closeInbox()
  })
}

export const useInboxStore = create<InboxState>((set) => ({
  open: false,
  openInbox: () => {
    watchSelection()
    useChatStore.getState().setActiveSessionId(null)
    set({ open: true })
  },
  closeInbox: () => set({ open: false })
}))

/** 收件箱的两节（侧栏那一行的计数与收件箱页共用这一份） */
export function useInboxSections(): InboxSections {
  const sessions = useChatStore((s) => s.sessions)
  const streaming = useChatStore(selectStreamingSessions)
  const askCounts = useChatStore(selectAllPendingCounts)
  // 在跑的是哪一种：侧栏用的同一个选择器，两处的记号才不会对不上
  const backgroundRunKinds = useBgTaskStore(selectBgRunKinds)
  const tasks = useBgTaskStore((s) => s.tasks)
  const unread = useUnreadStore((s) => s.unread)
  const backgroundCommands = useMemo(() => {
    const commands: Record<string, string[]> = {}
    const open = Object.values(tasks)
      .filter((task) => taskRunKind(task) === 'resident')
      .sort((a, b) => a.startedAt - b.startedAt)
    for (const task of open) {
      if (task.subject.kind === 'bash') (commands[task.sessionId] ??= []).push(task.subject.command)
    }
    return commands
  }, [tasks])
  return useMemo(
    () =>
      inboxSectionsOf({
        sessions,
        streaming,
        askCounts,
        backgroundRunKinds,
        backgroundCommands,
        unread
      }),
    [sessions, streaming, askCounts, backgroundRunKinds, backgroundCommands, unread]
  )
}
