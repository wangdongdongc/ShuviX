/**
 * SessionItem —— 共享会话列表单行（prop 驱动），从桌面 Sidebar.renderSessionItem 抽出。
 *
 * 通用部分（图标/标题/流式脉冲/待输入计数/选中态）两宿主共用；桌面专属能力（悬浮 pin）
 * 通过可选 prop 注入，缺省即隐藏。
 *
 * 行内**没有任何动作按钮**：配置/导出/删除这些动作统一收在行尾那颗 ⋮ 里（`onMenu`，与右键
 * 同一份菜单，见 RowMenuButton）。菜单由容器组装 —— 一行能做什么取决于宿主注入了哪些回调，
 * 那份判断本来就在容器手里（ProjectSessionGroups）。
 *
 * 子会话（`isSub` / `subCount`）借的是**知识库那套文件夹/文件语汇**：缩进是 .sb-row 的一级
 * （`sb-depth-1`，同知识库子目录；不是每行一条竖线），折叠钮就是行首那枚
 * 图标（同 KnowledgeGroup 的 FolderClosed/FolderOpen 整行可点），数量是标题后一个暗淡的
 * 小数字而不是一枚药丸。有子会话的行，行首图标外面包一层折叠钮：
 * 普通会话的图标换成 MessagesSquare（两片叠起来的对话框 = 这里不止一场对话），bot / 悬浮
 * 会话保留自己的身份图标 —— 身份图标若顶掉折叠钮，它们的子会话在侧栏里就够不着了（bot 恰恰
 * 把活全交给子会话）。
 */
import { Bot, MessageSquare, MessagesSquare, FileText, PictureInPicture2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { RowMenuButton } from './RowMenuButton'
import { RedactedText, RedactionSessionProvider } from '@shuvix/chat-ui'

export interface SessionItemProps {
  session: { id: string; title: string }
  active: boolean
  isStreaming?: boolean
  /**
   * 上个进程退出时这条会话正在跑（P3-12，Q-P3-10 的侧栏圆点）：标题后一枚小圆点 + 悬浮提示。
   * 在跑的会话不显示（转圈已经说明了一切）
   */
  interrupted?: boolean
  pendingCount?: number
  /** 专注模式下淡化（由宿主计算后传入） */
  dim?: boolean
  /** 笔记本会话（绑定 md 文件）—— 显示笔记本图标，选中后中间区为 live-preview */
  isNotebook?: boolean
  /** bot 会话（绑定了 bot）—— 显示 bot 图标；与 isNotebook 互斥（创建时定死） */
  isBot?: boolean
  /** 子会话行：缩进一级（`sb-depth-1`，同知识库的子目录行）。其余与顶层行完全一致 */
  isSub?: boolean
  /** 拥有的子会话数（>0 时行首图标可点折叠 —— 普通会话换成 MessagesSquare；标题后跟一个计数） */
  subCount?: number
  /** 子会话折叠态（仅 subCount>0 时有意义） */
  subCollapsed?: boolean
  onToggleSubs?: (id: string) => void
  onSelect: (id: string) => void
  /** 行菜单（右键整行 / 点行尾的 ⋮ 走的是同一个回调）；缺省即无 ⋮ 也无右键 */
  onMenu?: (id: string, e: React.MouseEvent) => void
  /**
   * 行尾一小段灰字：这条会话在哪干活（bot 会话 —— 同一个 bot 的会话散在不同项目里，行上不标就分不清：项目名或「临时」）。
   * 缺省不画
   */
  location?: string
  // —— 桌面专属（可选） ——
  isPinned?: boolean
}

export function SessionItem({
  session,
  active,
  isStreaming = false,
  interrupted = false,
  pendingCount = 0,
  dim = false,
  isNotebook = false,
  isBot = false,
  isSub = false,
  subCount = 0,
  subCollapsed = false,
  onToggleSubs,
  onSelect,
  onMenu,
  location,
  isPinned = false
}: SessionItemProps): React.JSX.Element {
  const { t } = useTranslation()
  const pulse = isStreaming ? 'animate-pulse ' : ''
  const lit = isStreaming || active ? 'text-accent' : 'text-text-tertiary'
  // 行首图标说的是「这是哪种会话」；有子会话时它外面再包一层折叠钮（见下）
  const icon = isBot ? (
    <Bot className={`sb-icon ${pulse}${lit}`} />
  ) : isNotebook ? (
    <FileText className={`sb-icon ${active ? 'text-accent' : 'text-text-tertiary'}`} />
  ) : isPinned ? (
    <PictureInPicture2 className={`sb-icon ${pulse}text-accent`} />
  ) : subCount > 0 ? (
    <MessagesSquare className={`sb-icon ${pulse}${lit}`} />
  ) : (
    <MessageSquare
      fill={active || isStreaming ? 'currentColor' : 'none'}
      className={`sb-icon ${pulse}${lit}`}
    />
  )
  return (
    <div
      onClick={() => onSelect(session.id)}
      onContextMenu={onMenu ? (e) => onMenu(session.id, e) : undefined}
      // 父子关系的稳定锚点：缩进与折叠态靠 class / 内联样式表达，
      // 它们会随样式调整变化 —— e2e 认这三个属性。折叠态另给一个是因为折叠只是把
      // AnimatedCollapse 的高度收成 0，子行仍在 DOM 里，光看有没有行判不出来
      data-session-row=""
      data-sub={isSub ? '' : undefined}
      data-sub-count={subCount > 0 ? subCount : undefined}
      data-subs={subCount > 0 ? (subCollapsed ? 'collapsed' : 'expanded') : undefined}
      // 缩进口径与知识库一致（base.css 的 .sb-row）：子会话再进一级，图标对齐父行的标签
      className={`group relative sb-row cursor-pointer transition-opacity duration-200 ${isSub ? 'sb-depth-1' : ''} ${
        active
          ? 'bg-bg-active/80 text-text-primary'
          : `text-text-primary hover:bg-bg-hover/60 ${dim ? 'opacity-30 hover:opacity-100' : ''}`
      }`}
    >
      {subCount > 0 ? (
        // 有子会话：图标本身就是折叠钮（同知识库目录行点图标展开），点行的其余部分照常
        // 打开这条会话。`data-subs-toggle` 是 e2e 认它的锚点 —— 钮里的图标随会话身份变
        <button
          data-subs-toggle=""
          onClick={(e) => {
            e.stopPropagation()
            onToggleSubs?.(session.id)
          }}
          title={t('sidebar.subSessions', { count: subCount })}
          className="flex-shrink-0 -m-1 p-1 rounded hover:bg-bg-active"
        >
          {icon}
        </button>
      ) : (
        icon
      )}
      <div className="flex-1 min-w-0 flex items-center gap-1.5 group-hover:pr-6">
        <span className="truncate">
          {/* 标题可能带自动脱敏的占位符（起标题的 agent 看到的是占位符）：按这一行的会话显示成标记 */}
          <RedactionSessionProvider sessionId={session.id}>
            <RedactedText text={session.title} />
          </RedactionSessionProvider>
        </span>
        {subCount > 0 && (
          <span
            className={`shrink-0 text-[0.8em] tabular-nums ${
              subCollapsed ? 'text-text-tertiary' : 'text-text-tertiary/60'
            }`}
          >
            {subCount}
          </span>
        )}
        {location && (
          <span
            data-session-location=""
            title={location}
            className="ml-auto min-w-0 max-w-[45%] shrink truncate text-[0.85em] text-text-tertiary group-hover:invisible"
          >
            {location}
          </span>
        )}
        {interrupted && !isStreaming && (
          <span
            data-interrupted=""
            title={t('sidebar.interrupted')}
            aria-label={t('sidebar.interrupted')}
            className="shrink-0 ml-auto h-1.5 w-1.5 rounded-full bg-warning"
          />
        )}
        {pendingCount > 0 && (
          <span
            className={`flex items-center gap-1 shrink-0 ${interrupted && !isStreaming ? '' : 'ml-auto'}`}
          >
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
