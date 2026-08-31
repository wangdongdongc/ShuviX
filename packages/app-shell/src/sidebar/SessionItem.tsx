/**
 * SessionItem —— 共享会话列表单行（prop 驱动），从桌面 Sidebar.renderSessionItem 抽出。
 *
 * 通用部分（图标/标题/流式脉冲/待输入计数/选中态/删除）两宿主共用；桌面专属能力
 * （悬浮 pin / 会话配置 / 右键菜单）通过可选 prop 注入，缺省即隐藏。
 */
import { Bot, MessageSquare, FileText, PictureInPicture2, Settings2, Trash2 } from 'lucide-react'
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
      className={`group relative flex items-center gap-1.5 pl-2.5 pr-1.5 py-0.5 cursor-pointer transition-opacity duration-200 ${
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
        <span className="truncate">{session.title}</span>
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
