import { useLayoutEffect, useRef, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import { useFocusDim } from '../sidebar/useFocusDim'

/**
 * 右侧面板标签栏（桌面/扩展共用）—— 统一标签样式：图标 + 文字 + 底部下划线选中态 +
 * 可选数字徽标 + 容器变窄时自动切「仅图标」模式 + 专注模式淡化未选中。
 *
 * 标签集合与激活态由宿主拥有（桌面 browserStore：files/browser/terminal/widget/subagent；
 * 扩展 panelStore：files/subagent），经 props 注入；本组件只负责一致的外观与交互。
 */
export interface PanelTabItem {
  key: string
  label: string
  Icon: LucideIcon
  /** 可选数字徽标（如子代理数 / 小组件数），>0 才显示 */
  badge?: number
}

export interface PanelTabBarProps {
  tabs: PanelTabItem[]
  activeKey: string
  onSelect: (key: string) => void
  /** Electron 无边框窗口拖拽区（titlebar-drag/no-drag）；扩展/web 省略 */
  windowDrag?: boolean
  /** 容器附加类（宿主背景差异：桌面 bg-bg-primary；扩展继承面板 bg-bg-secondary） */
  className?: string
}

export function PanelTabBar({
  tabs,
  activeKey,
  onSelect,
  windowDrag,
  className = ''
}: PanelTabBarProps): React.JSX.Element {
  const { dim } = useFocusDim()
  const drag = windowDrag ? 'titlebar-drag' : ''
  const noDrag = windowDrag ? 'titlebar-no-drag' : ''

  // 测量「图标 + 完整文字」自然宽度，超出容器则切到仅图标模式（off-screen measurer 取 scrollWidth）
  const tabBarRef = useRef<HTMLDivElement | null>(null)
  const fullWidthRef = useRef<HTMLDivElement | null>(null)
  const [compact, setCompact] = useState(false)

  useLayoutEffect(() => {
    const container = tabBarRef.current
    const measurer = fullWidthRef.current
    if (!container || !measurer) return
    const update = (): void => setCompact(measurer.scrollWidth > container.clientWidth)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(container)
    ro.observe(measurer)
    return () => ro.disconnect()
  }, [tabs.length])

  return (
    <>
      <div
        ref={tabBarRef}
        className={`${drag} flex-shrink-0 flex items-center h-8 border-b border-border-secondary/30 overflow-hidden ${className}`}
      >
        {tabs.map(({ key, label, Icon, badge }) => (
          <button
            key={key}
            onClick={() => onSelect(key)}
            title={compact ? label : undefined}
            className={`${noDrag} flex items-center gap-1 px-3 h-8 text-[11px] font-medium transition-all duration-200 relative whitespace-nowrap flex-shrink-0 ${
              activeKey === key
                ? 'text-text-primary'
                : `text-text-tertiary hover:text-text-secondary ${dim ? 'opacity-30 hover:opacity-100' : ''}`
            }`}
          >
            <Icon size={12} />
            {!compact && <span>{label}</span>}
            {badge !== undefined && badge > 0 && (
              <span className="ml-0.5 text-[10px] text-text-tertiary/60 tabular-nums">{badge}</span>
            )}
            {activeKey === key && (
              <span className="absolute bottom-0 left-2 right-2 h-[2px] bg-accent rounded-t" />
            )}
          </button>
        ))}
      </div>

      {/* 隐形测量节点：永远以「图标 + 文字」渲染，用以判断容器是否容得下完整标签 */}
      <div
        ref={fullWidthRef}
        aria-hidden
        className="absolute -top-[9999px] left-0 flex items-center pointer-events-none"
      >
        {tabs.map(({ key, label, Icon, badge }) => (
          <span
            key={key}
            className="flex items-center gap-1 px-3 h-8 text-[11px] font-medium whitespace-nowrap"
          >
            <Icon size={12} />
            <span>{label}</span>
            {badge !== undefined && badge > 0 && (
              <span className="ml-0.5 text-[10px] tabular-nums">{badge}</span>
            )}
          </span>
        ))}
      </div>
    </>
  )
}
