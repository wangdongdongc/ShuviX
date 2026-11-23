/**
 * 侧栏的视图切换（2026-11-16）—— 一枚只有图标的分段胶囊：会话（按项目分组的那棵树）/ 收件箱 / 日历 / 资料库。
 *
 * 收件箱与日历都是「把全部会话换一种排法看」，所以与默认的那棵树并排成同一处的几种视图，而不是右侧面板里的两个标签。
 * 资料库（智能体 / 安全策略 / Hooks / 技能 / 知识库）原先是会话那棵树最上面的一节，2026-11-22 起拿出来成了日历
 * 右边的第四段（用户裁定），会话视图从 Bots 开始。
 * 桌面画在侧栏顶上那一行（跟着侧栏一起收起），手机画在会话页大标题的右边 —— 手机的资料库本来就是底部的一个标签，
 * 所以手机只给前三段（`views`）。收件箱那一段在有会话等你回答时带一个琥珀点；数字不画（用户裁定：只用圆点），
 * 写在悬停提示里。
 */
import { CalendarDays, Inbox, Library, MessagesSquare, type LucideIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export type SidebarView = 'sessions' | 'inbox' | 'calendar' | 'library'

export const SIDEBAR_VIEWS: readonly SidebarView[] = ['sessions', 'inbox', 'calendar', 'library']

/** 认不得的值（旧版本存下的、手改的）一律当成默认的会话视图 */
export function toSidebarView(value: unknown): SidebarView {
  return SIDEBAR_VIEWS.includes(value as SidebarView) ? (value as SidebarView) : 'sessions'
}

const ICONS: Record<SidebarView, LucideIcon> = {
  sessions: MessagesSquare,
  inbox: Inbox,
  calendar: CalendarDays,
  library: Library
}

/** 各段的名字（悬停提示 / 读屏；手机上也是那一页的大标题） */
export const SIDEBAR_VIEW_LABEL_KEYS: Record<SidebarView, string> = {
  sessions: 'sidebar.viewSessions',
  inbox: 'inbox.title',
  calendar: 'panel.calendar',
  library: 'sidebar.library'
}

export interface SidebarViewSwitchProps {
  value: SidebarView
  onChange: (view: SidebarView) => void
  /** 有会话在等你回答：收件箱那一段上的琥珀点 */
  inboxAlert?: boolean
  /** 收件箱此刻的条数（等你回答 + 新回复）：只进悬停提示 */
  inboxCount?: number
  /** 画哪几段（按给的顺序）；缺省全部。手机不给资料库那一段 */
  views?: readonly SidebarView[]
  /** `touch`：手机上放大到手指的尺寸 */
  size?: 'regular' | 'touch'
  className?: string
}

export function SidebarViewSwitch({
  value,
  onChange,
  inboxAlert = false,
  inboxCount = 0,
  views = SIDEBAR_VIEWS,
  size = 'regular',
  className = ''
}: SidebarViewSwitchProps): React.JSX.Element {
  const { t } = useTranslation()
  const touch = size === 'touch'
  return (
    <div
      role="group"
      aria-label={t('sidebar.viewSwitch')}
      data-sidebar-view-switch={value}
      className={`inline-flex shrink-0 items-center gap-px rounded-lg bg-bg-tertiary/70 p-0.5 ${className}`}
    >
      {views.map((view) => {
        const Icon = ICONS[view]
        const active = view === value
        const name = t(SIDEBAR_VIEW_LABEL_KEYS[view])
        const label = view === 'inbox' && inboxCount > 0 ? `${name} · ${inboxCount}` : name
        return (
          <button
            key={view}
            type="button"
            data-sidebar-view={view}
            data-inbox-count={view === 'inbox' ? inboxCount : undefined}
            aria-pressed={active}
            aria-label={label}
            title={label}
            onClick={() => {
              if (!active) onChange(view)
            }}
            className={`relative flex items-center justify-center rounded-md transition-colors ${
              touch ? 'h-8 w-10' : 'h-[22px] w-7'
            } ${
              active
                ? 'bg-bg-primary text-text-primary shadow-[0_0_0_0.5px_var(--color-border-primary)]'
                : 'text-text-tertiary hover:text-text-secondary'
            }`}
          >
            <Icon size={touch ? 19 : 15} aria-hidden="true" />
            {view === 'inbox' && inboxAlert && (
              <span
                data-view-alert=""
                className={`absolute rounded-full bg-amber-400 ${
                  touch ? 'right-1.5 top-1 h-1.5 w-1.5' : 'right-1 top-0.5 h-1.5 w-1.5'
                }`}
              />
            )}
          </button>
        )
      })}
    </div>
  )
}
