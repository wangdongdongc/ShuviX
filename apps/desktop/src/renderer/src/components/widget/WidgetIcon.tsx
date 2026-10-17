import { useEffect } from 'react'
import { useWidgetStore } from '../../stores/widgetStore'
import { iconSlot, monogram } from './homeLayout'

/**
 * 小组件的应用图标：圆角方块。
 *
 * - widget 目录里有 `icon.svg` → 清洗后内联（清洗在 widgetStore 取图标时做，`sanitizeAuthoredSvg`）。内联而不是 `<img>`，是为了让图标里的 `var(--viz-*)` / `var(--theme-*)`
 *   跟着主题走；图标铺满整块，圆角由这里裁。
 * - 没有、读不到或清洗后为空 → 名字的第一个字放在按 id 选定的主题色浅底上（`--viz-N-tint` / `--viz-N-ink`）。
 *
 * 图标原文按 `iconMtime` 缓存在 widgetStore 里：文件改了（mtime 变了）才重新取。
 */
export function WidgetIcon({
  widget,
  size,
  className = ''
}: {
  widget: Pick<WidgetSummary, 'id' | 'name' | 'iconMtime'>
  size: number
  className?: string
}): React.JSX.Element {
  const cached = useWidgetStore((s) => s.icons[widget.id])
  const ensureIcon = useWidgetStore((s) => s.ensureIcon)
  const mtime = widget.iconMtime ?? 0

  useEffect(() => {
    if (mtime > 0) ensureIcon(widget.id, mtime)
  }, [widget.id, mtime, ensureIcon])

  const svg = mtime > 0 && cached?.mtime === mtime ? cached.svg : null
  const radius = Math.round(size * 0.23)
  const slot = iconSlot(widget.id)

  return (
    <div
      data-widget-icon={widget.id}
      className={`relative overflow-hidden flex items-center justify-center select-none ${className}`}
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        background: svg ? 'var(--theme-bg-secondary)' : `var(--viz-${slot}-tint)`,
        color: `var(--viz-${slot}-ink)`,
        boxShadow: 'inset 0 0 0 0.5px var(--theme-border-primary)'
      }}
    >
      {svg ? (
        <span
          aria-hidden="true"
          className="absolute inset-0 [&>svg]:w-full [&>svg]:h-full"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <span aria-hidden="true" style={{ fontSize: Math.round(size * 0.42), fontWeight: 500 }}>
          {monogram(widget.name, widget.id)}
        </span>
      )}
    </div>
  )
}
