/**
 * SessionGroup —— 共享会话分组（可折叠），从桌面 Sidebar.renderGroupedSessions 抽出。
 *
 * 一个分组 = 标题行（图标 + 大写标签 + hover 操作按钮）+ 可折叠的会话列表（children 为 SessionItem 列表）。
 * 两种形态：`temp`（临时对话，MessageCircle 图标）/ `project`（项目，文件夹图标，可带编辑按钮）。
 * 桌面与扩展共用——扩展只用单个 temp 分组，桌面对每个项目组 + 临时组各渲染一个。
 */
import { MessageCircle, FolderClosed, FolderOpen, MessageSquarePlus, Settings2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { AnimatedCollapse } from '../common/AnimatedCollapse'

export interface SessionGroupProps {
  label: string
  variant: 'temp' | 'project'
  collapsed: boolean
  onToggle: () => void
  onNewChat: () => void
  /** 活动组高亮（当前会话所属组） */
  active?: boolean
  /** 专注模式下整组淡化 */
  dim?: boolean
  /** 组上方分隔线（桌面临时组排在项目组之后时显示） */
  showDividerAbove?: boolean
  /** 项目编辑回调（仅 project 形态显示编辑按钮） */
  onEdit?: () => void
  /** 标题行右键菜单 */
  onHeaderContextMenu?: (e: React.MouseEvent) => void
  /** 分组内的会话项（SessionItem 列表） */
  children: React.ReactNode
}

export function SessionGroup({
  label,
  variant,
  collapsed,
  onToggle,
  onNewChat,
  active = false,
  dim = false,
  showDividerAbove = false,
  onEdit,
  onHeaderContextMenu,
  children
}: SessionGroupProps): React.JSX.Element {
  const { t } = useTranslation()
  const Icon = variant === 'temp' ? MessageCircle : collapsed ? FolderClosed : FolderOpen
  return (
    <div className={`transition-opacity duration-200 ${dim ? 'opacity-30 hover:opacity-100' : ''}`}>
      {showDividerAbove && <div className="mx-4 my-2 border-t border-border-secondary/30" />}
      <div className={`mb-0.5 rounded-md ${active ? 'bg-bg-primary/30' : ''}`}>
        <div
          className="relative flex items-center w-full px-1.5 py-0.5 text-[12px] group/header"
          onContextMenu={onHeaderContextMenu}
        >
          <button
            onClick={onToggle}
            className={`flex items-center gap-1.5 flex-1 min-w-0 transition-colors group-hover/header:pr-7 ${
              active ? 'text-text-primary' : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            <Icon size={12} className="flex-shrink-0" />
            <span className="truncate font-medium uppercase tracking-wider">{label}</span>
          </button>
          <div className="absolute right-1.5 flex items-center gap-0.5 opacity-0 group-hover/header:opacity-100 transition-opacity duration-100">
            <button
              onClick={(e) => {
                e.stopPropagation()
                onNewChat()
              }}
              className="p-0.5 rounded hover:bg-bg-hover text-text-tertiary/50 hover:text-text-secondary"
              title={t('sidebar.newChat')}
            >
              <MessageSquarePlus size={11} />
            </button>
            {onEdit && (
              <button
                onClick={onEdit}
                className="p-0.5 rounded hover:bg-bg-hover text-text-tertiary/50 hover:text-text-secondary"
                title={t('sidebar.editProject')}
              >
                <Settings2 size={12} />
              </button>
            )}
          </div>
        </div>
        <AnimatedCollapse open={!collapsed}>
          <div className="ml-1.5 pl-0.5">{children}</div>
        </AnimatedCollapse>
      </div>
    </div>
  )
}
