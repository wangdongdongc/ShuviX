import { useCallback, useEffect, useState } from 'react'
import {
  getChatApi,
  getHostApi,
  isSubSession,
  useAppEvent,
  useChatStore,
  type Session
} from '@shuvix/chat-ui'
import {
  CalendarView,
  ProjectSessionGroups,
  SessionConfigDialog,
  useProjects,
  useSessionDelete
} from '@shuvix/app-shell'
import { useBrowserStore } from '../../stores/browserStore'
import { usePinChatStore } from '../../stores/pinChatStore'

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function daysToDates(days: string[]): Date[] {
  const arr: Date[] = []
  for (const key of days) {
    const [y, m, d] = key.split('-').map(Number)
    arr.push(new Date(y, m - 1, d))
  }
  return arr
}

/**
 * 日历面板 —— Right panel 的 Calendar tab 内容。月历圆点与当日列表来自
 * session_day_prompts（IPC `calendar.*`），不再按 lastActiveAt 单日落点。
 */
export interface CalendarPanelProps {
  /** 用户从日历里打开了一个会话（同一个再点一次也算）—— 手机布局据此推入对话页；桌面不传 */
  onOpenSession?: (sessionId: string) => void
}

export function CalendarPanel({ onOpenSession }: CalendarPanelProps = {}): React.JSX.Element {
  const { projects } = useProjects()
  const width = useBrowserStore((s) => s.width)
  const pinnedSessionIds = usePinChatStore((s) => s.pinnedSessionIds)
  const setActiveSessionId = useChatStore((s) => s.setActiveSessionId)
  const requestScrollToMessage = useChatStore((s) => s.requestScrollToMessage)
  const { requestDelete: handleDelete, deleteDialog } = useSessionDelete()
  const [configuringSessionId, setConfiguringSessionId] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [selected, setSelected] = useState<Date>(() => new Date())
  const [month, setMonth] = useState<Date>(() => new Date())
  const [daysWithSessions, setDaysWithSessions] = useState<Date[]>([])
  const [daySessions, setDaySessions] = useState<Session[]>([])
  // 根会话一轮开跑（agent_start，PIN-06：当天那一行在受理 / 落位时就写了，早于生命周期信号）或列表
  // 成员变化后再拉；发消息时的乐观 touchSessionActive 太早。派生 agent 的开跑不算
  const [refreshTick, setRefreshTick] = useState(0)
  useAppEvent('session.listChanged', () => setRefreshTick((n) => n + 1))
  useEffect(() => {
    return getChatApi().agent.onEvent((event) => {
      if (event.type === 'agent_start' && !isSubSession(event.sessionId)) {
        setRefreshTick((n) => n + 1)
      }
    })
  }, [])

  useEffect(() => {
    const api = getHostApi()?.calendar
    if (!api) return
    let cancelled = false
    const year = month.getFullYear()
    const monthIndex = month.getMonth() + 1
    const day = dayKey(selected)
    void Promise.all([
      api.daysInMonth({ year, month: monthIndex }),
      api.sessionsOnDay({ day })
    ]).then(([days, list]) => {
      if (cancelled) return
      setDaysWithSessions(daysToDates(days))
      setDaySessions(list)
    })
    return () => {
      cancelled = true
    }
  }, [month, selected, refreshTick])

  const handleSelect = useCallback(
    (id: string): void => {
      setActiveSessionId(id)
      onOpenSession?.(id)
      if (pinnedSessionIds.has(id)) void window.api.pinChat.focus(id)
      const api = getHostApi()?.calendar
      if (!api) return
      const day = dayKey(selected)
      // 选中的这天就是这条会话最后活跃的一天（通常是今天，会话也许还在跑）：点它是要接着看、接着聊，照常落在
      // 最新内容上 —— 跳到这天的第一条消息就等于跳回一条今天才开的会话的开头。只有更早的一天（之后还有内容）
      // 才跳到那天的第一条消息
      const session = daySessions.find((s) => s.id === id)
      if (session && dayKey(new Date(session.lastActiveAt)) === day) return
      void api.firstEntryOnDay({ sessionId: id, day }).then((entryId) => {
        if (entryId) requestScrollToMessage(id, entryId)
      })
    },
    [
      daySessions,
      pinnedSessionIds,
      requestScrollToMessage,
      selected,
      setActiveSessionId,
      onOpenSession
    ]
  )

  const handleNewChat = async (projectId: string | null): Promise<void> => {
    const session = await getChatApi().session.create({ projectId: projectId ?? null })
    useChatStore.getState().setSessions(await getChatApi().session.list())
    setActiveSessionId(session.id)
  }

  return (
    <div className="flex flex-col h-full bg-bg-primary overflow-hidden">
      <div className="flex-1 overflow-y-auto pl-2 pr-2 py-1 no-scrollbar">
        <CalendarView
          width={width}
          daysWithSessions={daysWithSessions}
          daySessions={daySessions}
          selected={selected}
          onSelect={setSelected}
          month={month}
          onMonthChange={setMonth}
          renderGroupedSessionsForDay={(list: Session[]) => (
            <ProjectSessionGroups
              projects={projects}
              sessionsOverride={list}
              hideEmptyGroups
              collapsed={collapsed}
              onToggleGroup={(key) =>
                setCollapsed((prev) => {
                  const next = new Set(prev)
                  if (next.has(key)) next.delete(key)
                  else next.add(key)
                  return next
                })
              }
              onNewChat={(pid) => void handleNewChat(pid)}
              onSelect={handleSelect}
              onDelete={handleDelete}
              onConfigureSession={setConfiguringSessionId}
              caps={{ pin: true }}
              pinnedSessionIds={pinnedSessionIds}
            />
          )}
        />
      </div>
      {configuringSessionId && (
        <SessionConfigDialog
          sessionId={configuringSessionId}
          onClose={() => setConfiguringSessionId(null)}
        />
      )}
      {deleteDialog}
    </div>
  )
}
