/**
 * 单行 hex 渲染 —— 16 字节 / 行
 * 拆出独立文件并用 React.memo 包裹，确保虚拟化窗口滚动时未变化的行不重渲染
 */

import { memo } from 'react'

/** 行高（px）——与 text-[11px] leading-[18px] 对齐，虚拟化窗口计算依赖 */
export const HEX_ROW_HEIGHT = 18

interface HexRowProps {
  /** 行号（从 0 起） */
  row: number
  /** 整个 hex chunk —— 父组件持有，所有行共享同一份 buffer，靠 base 偏移取字节 */
  data: Uint8Array
  /** 当前选中的全局字节偏移；null = 无选中 */
  selectedOffset: number | null
  onSelect: (offset: number) => void
}

export const HexRow = memo(function HexRow({
  row,
  data,
  selectedOffset,
  onSelect
}: HexRowProps): React.JSX.Element {
  const base = row * 16
  const len = Math.min(16, data.length - base)

  return (
    <div className="flex items-center h-[18px] text-[11px] leading-[18px] hover:bg-bg-hover/20">
      {/* 地址列 */}
      <span className="w-[72px] px-2 text-text-tertiary/70 tabular-nums select-none">
        {base.toString(16).padStart(8, '0')}
      </span>

      {/* hex 字节列 —— 8 + 8 分组 */}
      <div className="flex items-center gap-[1px]">
        {Array.from({ length: 16 }, (_, i) => {
          if (i >= len) {
            return <span key={i} className={`w-[18px] ${i === 7 ? 'mr-[6px]' : ''}`} />
          }
          const byte = data[base + i]
          const isSelected = selectedOffset === base + i
          const colorClass =
            byte === 0x00 || byte === 0xff
              ? 'text-text-tertiary/40'
              : byte >= 0x20 && byte <= 0x7e
                ? 'text-text-primary'
                : 'text-text-secondary'
          return (
            <button
              key={i}
              onClick={() => onSelect(base + i)}
              className={[
                'w-[18px] text-center tabular-nums cursor-default rounded-[2px]',
                colorClass,
                isSelected && 'bg-accent/25 ring-1 ring-accent/40 text-text-primary',
                i === 7 && 'mr-[6px]'
              ]
                .filter(Boolean)
                .join(' ')}
            >
              {byte.toString(16).padStart(2, '0')}
            </button>
          )
        })}
      </div>

      {/* ASCII 列 */}
      <span className="ml-3 pl-2 border-l border-border-secondary/30 text-text-secondary tabular-nums select-none">
        {Array.from({ length: len }, (_, i) => {
          const byte = data[base + i]
          const printable = byte >= 0x20 && byte <= 0x7e
          const isSelected = selectedOffset === base + i
          return (
            <span
              key={i}
              className={[
                printable ? 'text-text-primary' : 'text-text-tertiary/50',
                isSelected && 'bg-accent/25 text-text-primary'
              ]
                .filter(Boolean)
                .join(' ')}
            >
              {printable ? String.fromCharCode(byte) : '·'}
            </span>
          )
        })}
      </span>
    </div>
  )
})
