import { useEffect, useRef } from 'react'
import { FileText } from 'lucide-react'
import type { AtSuggestion } from '../../hooks/useAtMentions'

interface AtMentionPopoverProps {
  /** 补全候选（工作区文件，已排序） */
  suggestions: AtSuggestion[]
  /** 选中回调 */
  onSelect: (suggestion: AtSuggestion) => void
  /** 当前键盘选中索引 */
  selectedIndex: number
}

/**
 * `@` 自动补全浮层 —— 复用斜杠命令 / 内置技能选择框的视觉样式。
 * 候选是工作区文件（文件名主 + 所在目录次）。
 * 锚定在 textarea 上方（与斜杠命令一致，不做光标坐标测量，键位与整体观感统一）。
 */
export function AtMentionPopover({
  suggestions,
  onSelect,
  selectedIndex
}: AtMentionPopoverProps): React.JSX.Element | null {
  const listRef = useRef<HTMLDivElement>(null)

  // 确保选中项可见
  useEffect(() => {
    const container = listRef.current
    if (!container) return
    const item = container.children[selectedIndex] as HTMLElement | undefined
    item?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  if (suggestions.length === 0) return null

  return (
    <div
      ref={listRef}
      className="absolute bottom-full left-0 right-0 mb-1 mx-2 max-h-48 overflow-y-auto rounded-lg border border-border-primary bg-bg-secondary shadow-xl z-30"
    >
      {suggestions.map((s, idx) => (
        <button
          // 文件 token 可能重复（同名裸名回退），叠加 idx 保唯一
          key={`${s.token}-${idx}`}
          onMouseDown={(e) => {
            // mousedown 抢在 textarea blur 之前，避免点击丢失焦点/触发态
            e.preventDefault()
            onSelect(s)
          }}
          className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-xs transition-colors ${
            idx === selectedIndex
              ? 'bg-accent/15 text-text-primary'
              : 'text-text-secondary hover:bg-bg-tertiary'
          }`}
          data-at-suggestion={s.rel}
        >
          <FileText size={12} className="flex-shrink-0 text-sky-500" />
          <span className="font-mono text-accent truncate">{s.label}</span>
          {s.detail && (
            <span className="text-text-tertiary text-[11px] truncate ml-auto pl-2">{s.detail}</span>
          )}
        </button>
      ))}
    </div>
  )
}
