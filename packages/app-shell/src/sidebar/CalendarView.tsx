import { useLayoutEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { DayPicker, useDayPicker } from 'react-day-picker'
import { zhCN, enUS } from 'react-day-picker/locale'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { Session } from '@shuvix/chat-ui'
import './calendar.css'

export interface CalendarViewProps {
  /** 渲染当日会话（按项目-会话树形分组，由宿主提供，复用 ProjectSessionGroups） */
  renderGroupedSessionsForDay: (sessions: Session[]) => React.ReactNode
  /** 侧栏当前宽度（决定是否显示周序号 + 日格尺寸/占位高度估算）；由宿主侧栏 store 注入 */
  width: number
  /** 是否正在拖动侧栏：拖动期间不渲染 DayPicker，避免重 layout 卡顿（缺省 false） */
  isResizing?: boolean
  /** 有过会话的日期（圆点）—— 来自 session_day_prompts */
  daysWithSessions: Date[]
  /** 选中日的会话列表 */
  daySessions: Session[]
  selected: Date
  onSelect: (date: Date) => void
  month: Date
  onMonthChange: (month: Date) => void
}

/**
 * 日历视图 —— 按天浏览会话。月历 + 选中日的会话分组列表。
 * 会话数据由宿主注入：桌面走索引表（同一会话可出现在多个开口日）。
 */
export function CalendarView({
  renderGroupedSessionsForDay,
  width,
  isResizing = false,
  daysWithSessions,
  daySessions,
  selected,
  onSelect,
  month,
  onMonthChange
}: CalendarViewProps): React.JSX.Element {
  const { i18n, t } = useTranslation()
  const showWeekNumber = width >= 240

  // 拖动占位高度：chrome（caption/nav/weekday header 恒定）+ 6 行 × day cell（跟随 sidebar 宽度）
  // 公式与 calendar.css 中 --rdp-day-height: clamp(26px, 12cqw, 40px) 一致
  // 容器宽度 = sidebar 宽度 - 周围 padding（pl-2 pr-1 = 12px）
  const dayCellSize = Math.max(26, Math.min(40, (width - 12) * 0.12))
  const calendarBoxRef = useRef<HTMLDivElement>(null)
  const chromeHeightRef = useRef<number>(46)
  useLayoutEffect(() => {
    if (!isResizing && calendarBoxRef.current) {
      const total = calendarBoxRef.current.offsetHeight
      chromeHeightRef.current = total - dayCellSize * 6
    }
  })
  const placeholderHeight = Math.round(dayCellSize * 6 + chromeHeightRef.current)

  const locale = i18n.language.startsWith('zh') ? zhCN : enUS

  // 自定义导航：‹ 今天 ›（横排）。闭包定义以访问外部 onSelect / onMonthChange
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
            onSelect(today)
            onMonthChange(today)
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
            onSelect={(d) => d && onSelect(d)}
            month={month}
            onMonthChange={onMonthChange}
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
