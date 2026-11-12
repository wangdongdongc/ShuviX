/**
 * 收件箱的数据来源（此刻在运行 / 在等你 / 有新回复的会话，见 inboxItems.ts），以及「正开着、作为新回复打开的那条」。
 *
 * 收件箱在右侧面板的第一个标签里（2026-11-12 用户选定 E1），与会话并排常驻：点一行 = 中间打开那条会话，收件箱不动。
 * 打开即读过，作为新回复打开的那一行要是立刻消失，列表会在眼前跳一下 —— 它留在原处（`useHeldUnread`），切走才离开。
 */

import { useEffect, useMemo } from 'react'
import { create } from 'zustand'
import type { SessionUnread } from '@shuvix/chat-protocol/sessionUnread'
import {
  selectAllPendingCounts,
  selectBgRunKinds,
  selectStreamingSessions,
  taskRunKind,
  useBgTaskStore,
  useChatStore,
  useUnreadStore
} from '@shuvix/chat-ui'
import { inboxSectionsOf, type InboxInput, type InboxSections } from './inboxItems'

type Held = NonNullable<InboxInput['held']>

interface InboxHoldState {
  held: Held | null
  /** 留住这一条（打开它的那一刻它是新回复） */
  hold: (sessionId: string, unread: SessionUnread) => void
  release: () => void
}

/**
 * 选中换到别的会话 → 放掉留着的那一条。挂在 store 上而不是面板的 effect 里：右侧面板只在开着时挂载，
 * 面板收着时换了会话、再换回来，留着的那条不该复活。第一次 `hold` 时才订阅：模块加载时不碰 chat-ui 的 store
 * （app-shell 的 DOM 测试整个替换掉 `@shuvix/chat-ui`，替身上的 subscribe 可能是空的）
 */
let watchingSelection = false
function watchSelection(): void {
  if (watchingSelection || typeof useChatStore.subscribe !== 'function') return
  watchingSelection = true
  useChatStore.subscribe((state, prev) => {
    if (state.activeSessionId === prev.activeSessionId) return
    const held = useInboxHoldStore.getState().held
    if (held && held.sessionId !== state.activeSessionId) useInboxHoldStore.getState().release()
  })
}

/** 留住的那一条：模块级，面板收起再展开、换窗口布局都还在 */
export const useInboxHoldStore = create<InboxHoldState>((set) => ({
  held: null,
  hold: (sessionId, unread) => {
    watchSelection()
    set({ held: { sessionId, unread } })
  },
  release: () => set({ held: null })
}))

/**
 * 正开着、作为新回复打开的那条会话（给 `inboxSectionsOf` 的 `held`）。选中换到一条有未读的会话就留住它；
 * 换到别的、或者没有选中 → 放掉。打开它之后未读被主进程清掉不影响 —— 留住的是打开那一刻的未读。
 * 收件箱的行在点开时自己也会先 `hold`（未读清得比这里的 effect 还快时，靠那一步）
 */
export function useHeldUnread(): Held | undefined {
  const activeId = useChatStore((s) => s.activeSessionId)
  const live = useUnreadStore((s) => (activeId ? s.unread[activeId] : undefined))
  const held = useInboxHoldStore((s) => s.held)
  useEffect(() => {
    const store = useInboxHoldStore.getState()
    if (activeId && live) store.hold(activeId, live)
    else if (store.held && store.held.sessionId !== activeId) store.release()
  }, [activeId, live])
  // 面板没挂着的时候换了会话、effect 还没来得及放：只认此刻开着的那一条
  return held && held.sessionId === activeId ? held : undefined
}

/**
 * 收件箱的三节（侧栏那一行的计数与收件箱面板共用这一份）。`held` 只有面板给：侧栏的数字只数真的没看的
 */
export function useInboxSections(held?: Held): InboxSections {
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
        unread,
        held
      }),
    [sessions, streaming, askCounts, backgroundRunKinds, backgroundCommands, unread, held]
  )
}
