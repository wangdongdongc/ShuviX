import { FilePlus2, NotebookText } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export interface DayReportHeaderProps {
  /** 选中的那一天 */
  day: Date
  /** 那天的日报：undefined = 还没查到（先不出动作）；null = 没有；有则带摘录（只有模板时为空串） */
  report: { excerpt: string } | null | undefined
  /** 那天能不能写：未来的日子不能（日报记的是已经发生的事），过去的可以补 */
  writable: boolean
  /** 主区开着的正是这份日报 —— 行按选中态画 */
  active?: boolean
  /** 打开那天的日报（还没有就按模板建） */
  onOpen: () => void
}

/**
 * 日历当天列表的头：日期 + 那天的日报。
 *
 * 没有日报时只在日期行尾放一颗「新建」图标（不放文字按钮 —— 日期就是它的说明）；写了就在日期下面多
 * 一行，图标 + 摘录，点开就是那份日报的笔记本。行与侧栏同一套 .sb-row，桌面 / 手机两档密度共用。
 */
export function DayReportHeader({
  day,
  report,
  writable,
  active = false,
  onOpen
}: DayReportHeaderProps): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const label = day.toLocaleDateString(i18n.language, {
    month: 'long',
    day: 'numeric',
    weekday: 'short'
  })
  return (
    <div data-day-report-header="" className="pb-1">
      <div className="sb-section" style={{ marginTop: 0 }}>
        <span className="flex-1 min-w-0 truncate">{label}</span>
        {report === null && writable && (
          <button
            type="button"
            data-daily-write=""
            onClick={onOpen}
            title={t('daily.write')}
            aria-label={t('daily.write')}
            className="flex-shrink-0 -mr-1 p-1 rounded text-text-tertiary hover:text-text-secondary hover:bg-bg-active"
          >
            <FilePlus2 className="sb-icon" />
          </button>
        )}
      </div>
      {report && (
        <div
          role="button"
          tabIndex={0}
          data-daily-report=""
          onClick={onOpen}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              onOpen()
            }
          }}
          title={t('daily.open')}
          className={`sb-row cursor-pointer ${active ? 'bg-bg-active/80' : 'hover:bg-bg-hover/60'}`}
        >
          <NotebookText className="sb-icon self-start mt-[0.15em] text-success" />
          <span
            className={`flex-1 min-w-0 line-clamp-2 py-0.5 ${
              report.excerpt ? 'text-text-secondary' : 'text-text-tertiary'
            }`}
          >
            {report.excerpt || t('daily.empty')}
          </span>
        </div>
      )}
    </div>
  )
}
