/**
 * SessionItem —— 共享会话列表单行（prop 驱动），从桌面 Sidebar.renderSessionItem 抽出。
 *
 * 通用部分（图标/标题/流式脉冲/待输入计数/选中态/删除）两宿主共用；桌面专属能力
 * （悬浮 pin / 会话配置 / 右键菜单）通过可选 prop 注入，缺省即隐藏。
 */
import {
  Bot,
  ChevronDown,
  ChevronRight,
  MessageSquare,
  FileText,
  PictureInPicture2,
  Settings2,
  Trash2
} from 'lucide-react'
import { useTranslation } from 'react-i18next'

export interface SessionItemProps {
  session: { id: string; title: string }
  active: boolean
  isStreaming?: boolean
  pendingCount?: number
  /** 专注模式下淡化（由宿主计算后传入） */
  dim?: boolean
  /** 笔记本会话（绑定 md 文件）—— 显示笔记本图标，选中后中间区为 live-preview */
  isNotebook?: boolean
  /** 聊天会话（settings.bots 非空）—— 显示 bot 图标；与 isNotebook 互斥（创建时定死） */
  isBot?: boolean
  /** 聊天会话的未读 bot 回复数（A4）：>0 时标题加粗 + accent 计数徽标 */
  unreadCount?: number
  /** 子会话行：缩进一级 + 左侧竖线。除此之外与顶层会话行完全一致 */
  isSub?: boolean
  /** 拥有的子会话数（>0 时标题后出现折叠钮 + 计数） */
  subCount?: number
  /** 子会话折叠态（仅 subCount>0 时有意义） */
  subCollapsed?: boolean
  onToggleSubs?: (id: string) => void
  onSelect: (id: string) => void
  onDelete?: (id: string) => void
  // —— 桌面专属（可选） ——
  isPinned?: boolean
  onConfigure?: (id: string) => void
  onContextMenu?: (id: string, e: React.MouseEvent) => void
}

export function SessionItem({
  session,
  active,
  isStreaming = false,
  pendingCount = 0,
  dim = false,
  isNotebook = false,
  isBot = false,
  unreadCount = 0,
  isSub = false,
  subCount = 0,
  subCollapsed = false,
  onToggleSubs,
  onSelect,
  onDelete,
  isPinned = false,
  onConfigure,
  onContextMenu
}: SessionItemProps): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div
      onClick={() => onSelect(session.id)}
      onContextMenu={onContextMenu ? (e) => onContextMenu(session.id, e) : undefined}
      // 父子关系的稳定锚点（同 data-unread 的做法）：缩进靠 class 表达，
      // 而 class 会随样式调整变化 —— e2e 认这两个属性
      data-sub={isSub ? '' : undefined}
      data-sub-count={subCount > 0 ? subCount : undefined}
      className={`group relative flex items-center gap-1.5 ${
        isSub ? 'pl-6 border-l border-border-subtle/60 ml-3' : 'pl-2.5'
      } pr-1.5 py-0.5 cursor-pointer transition-opacity duration-200 ${
        active
          ? 'bg-bg-active/80 text-text-primary'
          : `text-text-secondary hover:bg-bg-hover/50 hover:text-text-primary ${
              dim ? 'opacity-30 hover:opacity-100' : ''
            }`
      }`}
    >
      {isBot ? (
        <Bot
          size={11}
          className={`flex-shrink-0 ${
            isStreaming
              ? 'text-accent animate-pulse'
              : active
                ? 'text-accent'
                : 'text-text-tertiary/40'
          }`}
        />
      ) : isNotebook ? (
        <FileText
          size={11}
          className={`flex-shrink-0 ${active ? 'text-accent' : 'text-text-tertiary/40'}`}
        />
      ) : isPinned ? (
        <PictureInPicture2
          size={11}
          className={`flex-shrink-0 ${isStreaming ? 'text-accent animate-pulse' : 'text-accent'}`}
        />
      ) : (
        <MessageSquare
          size={11}
          fill={active || isStreaming ? 'currentColor' : 'none'}
          className={`flex-shrink-0 ${
            isStreaming
              ? 'text-accent animate-pulse'
              : active
                ? 'text-accent'
                : 'text-text-tertiary/40'
          }`}
        />
      )}
      <div className="flex-1 min-w-0 flex items-center gap-1.5 text-[13px] group-hover:pr-6">
        <span className={`truncate${unreadCount > 0 ? ' font-semibold text-text-primary' : ''}`}>
          {session.title}
        </span>
        {subCount > 0 && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              onToggleSubs?.(session.id)
            }}
            className="shrink-0 flex items-center gap-0.5 px-1 rounded text-[10px] tabular-nums text-text-tertiary hover:bg-bg-active hover:text-text-secondary"
            title={t('sidebar.subSessions', { count: subCount })}
          >
            {subCollapsed ? <ChevronRight size={9} /> : <ChevronDown size={9} />}
            {subCount}
          </button>
        )}
        {unreadCount > 0 && (
          <span
            className="ml-auto shrink-0 min-w-[17px] h-[17px] px-1 rounded-full bg-accent text-white text-[10px] font-semibold tabular-nums flex items-center justify-center"
            data-unread={unreadCount}
          >
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
        {pendingCount > 0 && (
          <span className="flex items-center gap-1 ml-auto shrink-0">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75 animate-ping" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-amber-400" />
            </span>
            <span className="text-[9px] text-amber-400 font-semibold tabular-nums">
              {pendingCount}
            </span>
          </span>
        )}
      </div>
      <div className="absolute right-1.5 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity duration-100">
        {onConfigure && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              onConfigure(session.id)
            }}
            className="p-0.5 rounded hover:bg-bg-active text-text-tertiary hover:text-text-secondary"
            title={t('sessionConfig.title')}
          >
            <Settings2 size={11} />
          </button>
        )}
        {onDelete && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              onDelete(session.id)
            }}
            className="p-0.5 rounded hover:bg-bg-active text-text-tertiary hover:text-error"
          >
            <Trash2 size={11} />
          </button>
        )}
      </div>
    </div>
  )
}
