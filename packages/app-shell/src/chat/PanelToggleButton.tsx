/**
 * PanelToggleButton —— 顶栏的侧栏/右面板开关按钮（桌面/扩展共用，保证样式一致）。
 *
 * 视觉沿用桌面：灰色图标按钮，用「图标内分栏的填充」表示展开态（不是整钮变 accent）。
 * side 决定分栏在左还是右：'left'=会话列表侧栏，'right'=右侧面板。
 * 行为/状态由各端注入（桌面 sidebarStore/browserStore，扩展 sidebarStore/panelStore）。
 */
export interface PanelToggleButtonProps {
  side: 'left' | 'right'
  /** 是否展开（决定分栏是否填充） */
  open: boolean
  onClick: () => void
  title?: string
  /** Electron 无边框窗口拖拽区内需要的 no-drag 类（扩展/web 省略） */
  noDrag?: boolean
}

export function PanelToggleButton({
  side,
  open,
  onClick,
  title,
  noDrag = false
}: PanelToggleButtonProps): React.JSX.Element {
  // 左：分隔线在 x=9，填充左栏(x=3,w=6)；右：分隔线在 x=15，填充右栏(x=15,w=6)
  const dividerX = side === 'left' ? 9 : 15
  const fillX = side === 'left' ? 3 : 15

  return (
    <button
      onClick={onClick}
      title={title}
      className={`${noDrag ? 'titlebar-no-drag ' : ''}p-1 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/50 transition-colors`}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect width="18" height="18" x="3" y="3" rx="2" />
        <path d={`M${dividerX} 3v18`} />
        {open && (
          <rect x={fillX} y="3" width="6" height="18" rx="2" fill="currentColor" stroke="none" />
        )}
      </svg>
    </button>
  )
}
