/**
 * SessionGroup —— 共享会话分组，从桌面 Sidebar.renderGroupedSessions 抽出。
 *
 * 一个分组 = 标题行（可选图标 + 大写标签 + 悬停浮现的 ⋮）+ 正文（通常为 SessionItem 列表）。
 * 三种形态：
 *   - `project`（项目，文件夹图标，可折叠）
 *   - `wiki`（知识库置顶特殊分组，BookOpen 图标，可折叠，正文为条目列表）
 *   - `temp`（临时对话，**摊开的纯分节**：无图标、无折叠，标题行按侧栏顶部「项目」那种纯
 *     header 排版）—— 它是侧栏最常用的落点，收在一层折叠后面只是每次多一次点击，而临时
 *     会话本来就没有「这个组是什么」要交代，图标与折叠箭头都只是噪音。
 * 桌面与扩展共用——扩展只用单个 temp 分组，桌面对每个项目组 + 临时组 + 知识库组各渲染一个。
 *
 * 组头**没有一排小图标**：新建对话 / 新建 Bot 会话 / 项目配置 / 知识库刷新全部收进 `onMenu`
 * 那一份菜单（右键组头与点 ⋮ 同一个入口，见 RowMenuButton）。菜单由容器组装 ——
 * 各形态能做什么本就是容器（ProjectSessionGroups / WikiGroup）才知道的事。
 */
import { BookOpen, FolderClosed, FolderOpen } from 'lucide-react'
import { AnimatedCollapse } from '../common/AnimatedCollapse'
import { RowMenuButton } from './RowMenuButton'

export interface SessionGroupProps {
  label: string
  variant: 'temp' | 'project' | 'wiki'
  /** 折叠态 + 切换；`temp` 形态是摊开的纯分节，两者都不传 */
  collapsed?: boolean
  onToggle?: () => void
  /** 活动组高亮（当前会话所属组） */
  active?: boolean
  /** 专注模式下整组淡化 */
  dim?: boolean
  /** 组上方分隔线（桌面临时组排在项目组之后时显示） */
  showDividerAbove?: boolean
  /** 组头菜单（右键标题行 / 点 ⋮ 走同一个回调）；缺省即两者都无 */
  onMenu?: (e: React.MouseEvent) => void
  /** 分组内的会话项（SessionItem 列表） */
  children: React.ReactNode
}

export function SessionGroup({
  label,
  variant,
  collapsed = false,
  onToggle,
  active = false,
  dim = false,
  showDividerAbove = false,
  onMenu,
  children
}: SessionGroupProps): React.JSX.Element {
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
          onContextMenu={onMenu}
        >
          {flat ? (
            /* 纯 header：不可点、无图标，排版对齐侧栏顶部的「项目」标题 */
            <div className="flex items-center flex-1 min-w-0 group-hover/header:pr-6">
              <span className="truncate text-[13px] font-medium uppercase tracking-wide text-text-tertiary">
                {label}
              </span>
            </div>
          ) : (
            <button
              onClick={onToggle}
              className={`flex items-center gap-1.5 flex-1 min-w-0 transition-colors group-hover/header:pr-6 ${
                active ? 'text-text-primary' : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              <Icon size={12} className="flex-shrink-0" />
              <span className="truncate font-medium uppercase tracking-wider">{label}</span>
            </button>
          )}
          {onMenu && (
            <RowMenuButton
              className="absolute right-1.5 opacity-0 group-hover/header:opacity-100"
              onOpen={onMenu}
            />
          )}
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
