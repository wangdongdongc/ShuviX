/**
 * SessionGroup —— 共享会话分组，从桌面 Sidebar.renderGroupedSessions 抽出。
 *
 * 一个分组 = 标题行（可选图标 + 大写标签 + hover 操作按钮）+ 正文（通常为 SessionItem 列表）。
 * 三种形态：
 *   - `project`（项目，文件夹图标，可折叠，可带编辑按钮）
 *   - `wiki`（知识库置顶特殊分组，BookOpen 图标，可折叠，正文为条目列表）
 *   - `temp`（临时对话，**摊开的纯分节**：无图标、无折叠，标题行按侧栏顶部「项目」那种纯
 *     header 排版）—— 它是侧栏最常用的落点，收在一层折叠后面只是每次多一次点击，而临时
 *     会话本来就没有「这个组是什么」要交代，图标与折叠箭头都只是噪音。
 * 桌面与扩展共用——扩展只用单个 temp 分组，桌面对每个项目组 + 临时组 + 知识库组各渲染一个。
 */
import { BookOpen, Bot, FolderClosed, FolderOpen, MessageSquarePlus, Settings2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { AnimatedCollapse } from '../common/AnimatedCollapse'

export interface SessionGroupProps {
  label: string
  variant: 'temp' | 'project' | 'wiki'
  /** 折叠态 + 切换；`temp` 形态是摊开的纯分节，两者都不传 */
  collapsed?: boolean
  onToggle?: () => void
  /** 「新建对话」悬停按钮；缺省不渲染（wiki 组无新建入口） */
  onNewChat?: () => void
  /**
   * 「新建 Bot 会话」悬停按钮（UI 形态裁决①的落地形态：并排第二颗图标而非 “+” 下拉 ——
   * 悬停条小图标挂菜单既难点又难画，且桌面原生菜单忽略锚点位置）。宿主注入了 bots
   * 能力才渲染（扩展端 v1 无 bot）
   */
  onNewBotChat?: () => void
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
  /** 悬停操作区额外按钮（wiki 组的刷新），渲染在新建/编辑按钮之前 */
  headerActions?: React.ReactNode
  /** 分组内的会话项（SessionItem 列表） */
  children: React.ReactNode
}

export function SessionGroup({
  label,
  variant,
  collapsed = false,
  onToggle,
  onNewChat,
  onNewBotChat,
  active = false,
  dim = false,
  showDividerAbove = false,
  onEdit,
  onHeaderContextMenu,
  headerActions,
  children
}: SessionGroupProps): React.JSX.Element {
  const { t } = useTranslation()
  // temp 是摊开的纯分节：没有折叠，也就没有折叠图标（见文件头注释）
  const flat = variant === 'temp'
  const Icon = variant === 'wiki' ? BookOpen : collapsed ? FolderClosed : FolderOpen
  return (
    <div className={`transition-opacity duration-200 ${dim ? 'opacity-30 hover:opacity-100' : ''}`}>
      {showDividerAbove && <div className="mx-4 my-2 border-t border-border-secondary/30" />}
      <div className={`mb-0.5 rounded-md ${active ? 'bg-bg-primary/30' : ''}`}>
        <div
          data-group={variant}
          className="relative flex items-center w-full px-1.5 py-0.5 text-[12px] group/header"
          onContextMenu={onHeaderContextMenu}
        >
          {flat ? (
            /* 纯 header：不可点、无图标，排版对齐侧栏顶部的「项目」标题 */
            <div className="flex items-center flex-1 min-w-0 group-hover/header:pr-7">
              <span className="truncate text-[13px] font-medium uppercase tracking-wide text-text-tertiary">
                {label}
              </span>
            </div>
          ) : (
            <button
              onClick={onToggle}
              className={`flex items-center gap-1.5 flex-1 min-w-0 transition-colors group-hover/header:pr-7 ${
                active ? 'text-text-primary' : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              <Icon size={12} className="flex-shrink-0" />
              <span className="truncate font-medium uppercase tracking-wider">{label}</span>
            </button>
          )}
          <div className="absolute right-1.5 flex items-center gap-0.5 opacity-0 group-hover/header:opacity-100 transition-opacity duration-100">
            {headerActions}
            {onNewChat && (
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
            )}
            {onNewBotChat && (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  onNewBotChat()
                }}
                className="p-0.5 rounded hover:bg-bg-hover text-text-tertiary/50 hover:text-text-secondary"
                title={t('sidebar.newBotChat')}
              >
                <Bot size={11} />
              </button>
            )}
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
        {flat ? (
          /*
           * 摊开的分节不缩进：正文那 8px 是「组内」的语汇。再往左拉 4px 是把 SessionItem
           * 自带的 10px 基准内缩（pl-2.5）抵到组头的 6px（px-1.5）上 —— 于是图标列、分节
           * 标题列、项目行的文件夹图标列三者同在一条竖线上。
           */
          <div className="-ml-1">{children}</div>
        ) : (
          <AnimatedCollapse open={!collapsed}>
            <div className="ml-1.5 pl-0.5">{children}</div>
          </AnimatedCollapse>
        )}
      </div>
    </div>
  )
}
