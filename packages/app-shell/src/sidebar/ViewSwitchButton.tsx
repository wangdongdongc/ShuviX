import { useTranslation } from 'react-i18next'
import { MoreHorizontal } from 'lucide-react'
import { useContextMenu } from '../contextmenu/ContextMenuProvider'

export type SidebarViewMode = 'projects' | 'calendar' | 'wiki'

const MODE_LABEL_KEYS: Record<SidebarViewMode, string> = {
  projects: 'sidebar.viewProjects',
  calendar: 'sidebar.viewCalendar',
  wiki: 'sidebar.viewWiki'
}

export interface ViewSwitchButtonProps {
  viewMode: SidebarViewMode
  onChange: (mode: SidebarViewMode) => void
  /** 菜单展示哪些视图入口;缺省与旧行为一致(扩展端不含 wiki) */
  modes?: SidebarViewMode[]
}

/**
 * 侧栏视图切换按钮（桌面/扩展共用）—— 标题行的「…」按钮，点开右键菜单选「项目 / 日历 / 维基」。
 * 菜单经共享 useContextMenu 弹出：桌面原生菜单、扩展 DOM 弹层，配置同一份。
 */
export function ViewSwitchButton({
  viewMode,
  onChange,
  modes = ['projects', 'calendar']
}: ViewSwitchButtonProps): React.JSX.Element {
  const { t } = useTranslation()
  const showContextMenu = useContextMenu()
  return (
    <button
      onClick={(e) =>
        void showContextMenu(
          e,
          modes.map((mode) => ({
            id: `view-${mode}`,
            label: `${viewMode === mode ? '✓' : '   '} ${t(MODE_LABEL_KEYS[mode])}`
          })),
          (id) => {
            const mode = modes.find((m) => `view-${m}` === id)
            if (mode) onChange(mode)
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
