/** 极简 minimap —— 右侧悬浮 H1/H2… 级别标签，仅悬停某项时浮出该项完整标题。 */
import type { NotebookHeading } from './notebookHeadings'

/** 右侧悬浮的级别标签导航条 */
export function NotebookMinimap({
  headings,
  onJump
}: {
  headings: NotebookHeading[]
  onJump: (line: number) => void
}): React.JSX.Element {
  return (
    <div className="pointer-events-none absolute right-0 top-1/2 z-10 flex max-h-[82%] w-64 -translate-y-1/2 flex-col items-end gap-0.5 overflow-y-auto no-scrollbar py-2 pr-2">
      {headings.map((h, i) => (
        <button
          key={`${i}-${h.line}`}
          onClick={() => onJump(h.line)}
          title={h.text}
          className="group/tick pointer-events-auto relative flex items-center justify-end px-1 py-[1px]"
        >
          {/* 完整标题：仅悬停该项时浮出，置于级别标签左侧 */}
          <span className="pointer-events-none absolute right-full mr-2 max-w-[220px] truncate whitespace-nowrap rounded bg-bg-primary/90 px-1.5 py-0.5 text-[11px] text-text-primary opacity-0 shadow-sm transition-opacity duration-150 group-hover/tick:opacity-100">
            {h.text}
          </span>
          {/* 级别标签 H1/H2…：深层级更小更淡，hover 该项时变亮 */}
          <span
            className={`font-mono tabular-nums transition-colors duration-150 group-hover/tick:text-text-primary ${
              h.level <= 1 ? 'text-[11px] text-text-secondary' : 'text-[10px] text-text-tertiary/70'
            }`}
          >
            H{h.level}
          </span>
        </button>
      ))}
    </div>
  )
}
