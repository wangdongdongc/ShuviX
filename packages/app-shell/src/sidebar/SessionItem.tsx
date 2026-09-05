/**
 * SessionItem —— 共享会话列表单行（prop 驱动），从桌面 Sidebar.renderSessionItem 抽出。
 *
 * 通用部分（图标/标题/流式脉冲/待输入计数/选中态）两宿主共用；桌面专属能力（悬浮 pin）
 * 通过可选 prop 注入，缺省即隐藏。
 *
 * 行内**没有任何动作按钮**：配置/导出/删除这些动作统一收在行尾那颗 ⋮ 里（`onMenu`，与右键
 * 同一份菜单，见 RowMenuButton）。菜单由容器组装 —— 一行能做什么取决于宿主注入了哪些回调，
 * 那份判断本来就在容器手里（ProjectSessionGroups / SessionList）。
 *
 * 子会话（`isSub` / `subCount`）借的是**知识库那套文件夹/文件语汇**：缩进用行内
 * paddingLeft（同 WikiGroup 的 `indent(depth)`，不是每行一条竖线），折叠钮就是行首那枚
 * 图标（同 WikiGroup 的 FolderClosed/FolderOpen 整行可点、ProjectMemoryFolder 的计数排版），
 * 数量是标题后一个暗淡的小数字而不是一枚药丸。有子会话的行图标换成 MessagesSquare
 * （两片叠起来的对话框 = 这里不止一场对话）。
 */
import { Bot, MessageSquare, MessagesSquare, FileText, PictureInPicture2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { RowMenuButton } from './RowMenuButton'

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
  /** 会话开着「免询问」（settings.autoAllow）—— 行首图标染琥珀 */
  autoAllow?: boolean
  /** 子会话行：缩进一级（行内 paddingLeft，同知识库的文件行）。其余与顶层行完全一致 */
  isSub?: boolean
  /** 拥有的子会话数（>0 时行首图标变成 MessagesSquare 且可点折叠，标题后跟一个计数） */
  subCount?: number
  /** 子会话折叠态（仅 subCount>0 时有意义） */
  subCollapsed?: boolean
  onToggleSubs?: (id: string) => void
  onSelect: (id: string) => void
  /** 行菜单（右键整行 / 点行尾的 ⋮ 走的是同一个回调）；缺省即无 ⋮ 也无右键 */
  onMenu?: (id: string, e: React.MouseEvent) => void
  // —— 桌面专属（可选） ——
  isPinned?: boolean
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
  autoAllow = false,
  isSub = false,
  subCount = 0,
  subCollapsed = false,
  onToggleSubs,
  onSelect,
  onMenu,
  isPinned = false
}: SessionItemProps): React.JSX.Element {
  const { t } = useTranslation()
  /**
   * 行首图标着色：免询问压过其余一切。工具调用不再逐次询问是会话的常驻状态，而顶栏那枚
   * 「免询问」胶囊已经撤了 —— 侧栏这枚图标是它在界面上仅剩的常驻痕迹，所以它得压过
   * accent（选中/流式）而不是被盖掉；流式的 animate-pulse 照旧，仍看得出这条在跑。
   */
  const tone = (base: string): string => (autoAllow ? 'text-amber-500' : base)
  return (
    <div
      onClick={() => onSelect(session.id)}
      onContextMenu={onMenu ? (e) => onMenu(session.id, e) : undefined}
      // 父子关系的稳定锚点（同 data-unread 的做法）：缩进与折叠态靠 class / 内联样式表达，
      // 它们会随样式调整变化 —— e2e 认这三个属性。折叠态另给一个是因为折叠只是把
      // AnimatedCollapse 的高度收成 0，子行仍在 DOM 里，光看有没有行判不出来
      data-sub={isSub ? '' : undefined}
      data-sub-count={subCount > 0 ? subCount : undefined}
      data-subs={subCount > 0 ? (subCollapsed ? 'collapsed' : 'expanded') : undefined}
      // 缩进口径与知识库一致：基准 10px（pl-2.5），每层再进 12px
      style={isSub ? { paddingLeft: 22 } : undefined}
      className={`group relative flex items-center gap-1.5 ${
        isSub ? 'pr-1.5' : 'pl-2.5 pr-1.5'
      } py-0.5 cursor-pointer transition-opacity duration-200 ${
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
          className={`flex-shrink-0 ${isStreaming ? 'animate-pulse ' : ''}${tone(
            isStreaming || active ? 'text-accent' : 'text-text-tertiary/40'
          )}`}
        />
      ) : isNotebook ? (
        <FileText
          size={11}
          className={`flex-shrink-0 ${tone(active ? 'text-accent' : 'text-text-tertiary/40')}`}
        />
      ) : isPinned ? (
        <PictureInPicture2
          size={11}
          className={`flex-shrink-0 ${isStreaming ? 'animate-pulse ' : ''}${tone('text-accent')}`}
        />
      ) : subCount > 0 ? (
        // 有子会话：两片叠起来的对话框 = 这里不止一场对话。图标本身就是折叠钮
        // （同知识库目录行点图标展开），点行的其余部分照常打开这条会话
        <button
          onClick={(e) => {
            e.stopPropagation()
            onToggleSubs?.(session.id)
          }}
          title={t('sidebar.subSessions', { count: subCount })}
          className="flex-shrink-0 -m-0.5 p-0.5 rounded hover:bg-bg-active"
        >
          <MessagesSquare
            size={11}
            className={`${isStreaming ? 'animate-pulse ' : ''}${tone(
              isStreaming || active ? 'text-accent' : 'text-text-tertiary/40'
            )}`}
          />
        </button>
      ) : (
        <MessageSquare
          size={11}
          fill={active || isStreaming ? 'currentColor' : 'none'}
          className={`flex-shrink-0 ${isStreaming ? 'animate-pulse ' : ''}${tone(
            isStreaming || active ? 'text-accent' : 'text-text-tertiary/40'
          )}`}
        />
      )}
      <div className="flex-1 min-w-0 flex items-center gap-1.5 text-[13px] group-hover:pr-6">
        <span className={`truncate${unreadCount > 0 ? ' font-semibold text-text-primary' : ''}`}>
          {session.title}
        </span>
        {subCount > 0 && (
          <span
            className={`shrink-0 text-[10px] tabular-nums ${
              subCollapsed ? 'text-text-tertiary/60' : 'text-text-tertiary/40'
            }`}
          >
            {subCount}
          </span>
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
      {onMenu && (
        <RowMenuButton
          className="absolute right-1.5 opacity-0 group-hover:opacity-100"
          onOpen={(e) => onMenu(session.id, e)}
        />
      )}
    </div>
  )
}
