import { useTranslation } from 'react-i18next'
import { MoreHorizontal } from 'lucide-react'
import { useContextMenu } from '../contextmenu/ContextMenuProvider'

export type SidebarViewMode = 'projects' | 'calendar'

export interface ViewSwitchButtonProps {
  viewMode: SidebarViewMode
  onChange: (mode: SidebarViewMode) => void
}

/**
 * 侧栏视图切换按钮（桌面/扩展共用）—— 标题行的「…」按钮，点开右键菜单选「项目 / 日历」。
 * 菜单经共享 useContextMenu 弹出：桌面原生菜单、扩展 DOM 弹层，配置同一份。
 */
export function ViewSwitchButton({ viewMode, onChange }: ViewSwitchButtonProps): React.JSX.Element {
  const { t } = useTranslation()
  const showContextMenu = useContextMenu()
  return (
    <button
      onClick={(e) =>
        void showContextMenu(
          e,
          [
            {
              id: 'view-projects',
              label: `${viewMode === 'projects' ? '✓' : '   '} ${t('sidebar.viewProjects')}`
            },
            {
              id: 'view-calendar',
              label: `${viewMode === 'calendar' ? '✓' : '   '} ${t('sidebar.viewCalendar')}`
            }
          ],
          (id) => {
            if (id === 'view-projects') onChange('projects')
            if (id === 'view-calendar') onChange('calendar')
          }
        )
      }
      title={t('sidebar.switchView')}
      className="p-1 rounded text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors"
    >
      <MoreHorizontal size={14} />
    </button>
  )
}
