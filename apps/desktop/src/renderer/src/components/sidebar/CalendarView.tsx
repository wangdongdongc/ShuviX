import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DayPicker, useDayPicker } from 'react-day-picker'
import { zhCN, enUS } from 'react-day-picker/locale'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useChatStore, groupSessionsByDay, type Session } from '@shuvix/chat-ui'
import { useSidebarStore } from '../../stores/sidebarStore'
import './calendar.css'

interface Props {
  /** 渲染当日会话（按项目-会话树形分组，由 Sidebar 提供） */
  renderGroupedSessionsForDay: (sessions: Session[]) => React.ReactNode
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function CalendarView({ renderGroupedSessionsForDay }: Props): React.JSX.Element {
  const { i18n, t } = useTranslation()
  const sessions = useChatStore((s) => s.sessions)
  const isResizing = useSidebarStore((s) => s.isResizing)
  const sidebarWidth = useSidebarStore((s) => s.width)
  const showWeekNumber = sidebarWidth >= 240
  const [selected, setSelected] = useState<Date>(() => new Date())
  const [month, setMonth] = useState<Date>(() => new Date())

  // 拖动占位高度：chrome（caption/nav/weekday header 恒定）+ 6 行 × day cell（跟随 sidebar 宽度）
  // 公式与 calendar.css 中 --rdp-day-height: clamp(26px, 12cqw, 40px) 一致
  // 容器宽度 = sidebar 宽度 - 周围 padding（pl-2 pr-1 = 12px）
  const dayCellSize = Math.max(26, Math.min(40, (sidebarWidth - 12) * 0.12))
  const calendarBoxRef = useRef<HTMLDivElement>(null)
  const chromeHeightRef = useRef<number>(46)
  useLayoutEffect(() => {
    if (!isResizing && calendarBoxRef.current) {
      const total = calendarBoxRef.current.offsetHeight
      chromeHeightRef.current = total - dayCellSize * 6
    }
  })
  const placeholderHeight = Math.round(dayCellSize * 6 + chromeHeightRef.current)

  // 派生：YYYY-MM-DD -> Session[]；只在 sessions 引用变化时重算
  const sessionsByDay = useMemo(() => groupSessionsByDay(sessions), [sessions])

  const daysWithSessions = useMemo(() => {
    const arr: Date[] = []
    for (const key of sessionsByDay.keys()) {
      const [y, m, d] = key.split('-').map(Number)
      arr.push(new Date(y, m - 1, d))
    }
    return arr
  }, [sessionsByDay])

  const daySessions = sessionsByDay.get(dayKey(selected)) ?? []
  const locale = i18n.language.startsWith('zh') ? zhCN : enUS

  // 自定义导航：‹ 今天 ›（横排）。闭包定义以访问外部 setSelected
  const CustomNav = (): React.JSX.Element => {
    const { goToMonth, nextMonth, previousMonth } = useDayPicker()
    return (
      <nav className="rdp-nav flex items-center gap-1">
        <button
          type="button"
          aria-label="Previous month"
          disabled={!previousMonth}
          onClick={() => previousMonth && goToMonth(previousMonth)}
          className="rdp-button_previous"
        >
          <ChevronLeft size={12} />
        </button>
        <button
          type="button"
          onClick={() => {
            const today = new Date()
            setSelected(today)
            goToMonth(today)
          }}
          className="px-1 text-[11px] text-text-tertiary hover:text-text-secondary transition-colors"
        >
          {t('sidebar.today')}
        </button>
        <button
          type="button"
          aria-label="Next month"
          disabled={!nextMonth}
          onClick={() => nextMonth && goToMonth(nextMonth)}
          className="rdp-button_next"
        >
          <ChevronRight size={12} />
        </button>
      </nav>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <div ref={calendarBoxRef} className="calendar-container pt-1">
        {isResizing ? (
          // 拖动期间不渲染 DayPicker，避免重 layout 卡顿；占位高度跟随当前宽度实时估算
          <div style={{ height: placeholderHeight }} aria-hidden />
        ) : (
          <DayPicker
            mode="single"
            selected={selected}
            onSelect={(d) => d && setSelected(d)}
            month={month}
            onMonthChange={setMonth}
            showWeekNumber={showWeekNumber}
            weekStartsOn={1}
            locale={locale}
            modifiers={{ hasSessions: daysWithSessions }}
            modifiersClassNames={{ hasSessions: 'rdp-has-sessions' }}
            components={{ Nav: CustomNav }}
          />
        )}
      </div>
      <div className="flex-1 overflow-y-auto mt-2 pt-2 border-t border-border-secondary/30 no-scrollbar">
        {daySessions.length === 0 ? (
          <div className="px-3 py-6 text-center text-text-tertiary text-xs">
            {t('sidebar.noSessionsOnDay')}
          </div>
        ) : (
          renderGroupedSessionsForDay(daySessions)
        )}
      </div>
    </div>
  )
}
