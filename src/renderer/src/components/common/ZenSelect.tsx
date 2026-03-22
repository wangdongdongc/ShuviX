import { useRef, useState, useCallback } from 'react'
import { ChevronDown } from 'lucide-react'
import { useClickOutside } from '../../hooks/useClickOutside'

export interface ZenSelectOption {
  value: string
  label: string
}

interface ZenSelectProps {
  value: string
  onChange: (value: string) => void
  options: ZenSelectOption[]
  /** 未选中（value 为空）时显示的文本 */
  placeholder?: string
}

/**
 * Zen 风格自定义选择器 — 底线触发 + 弹出面板
 * 替代 native select，用于筛选栏等行内场景
 */
export function ZenSelect({
  value,
  onChange,
  options,
  placeholder
}: ZenSelectProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)

  const close = useCallback(() => setOpen(false), [])
  useClickOutside(ref, close, open)

  const selectedLabel = options.find((o) => o.value === value)?.label || placeholder || ''

  const select = (v: string): void => {
    onChange(v)
    close()
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-1 bg-transparent border-0 border-b border-border-secondary rounded-none py-1.5 text-[11px] text-text-primary whitespace-nowrap hover:border-accent/50 transition-colors cursor-pointer"
      >
        <span>{selectedLabel}</span>
        <ChevronDown size={10} className="text-text-tertiary flex-shrink-0" />
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1 min-w-[120px] max-h-60 rounded-lg border border-border-primary bg-bg-secondary shadow-2xl overflow-y-auto z-50">
          {/* 空值选项（placeholder） */}
          {placeholder && (
            <button
              onClick={() => select('')}
              className={`w-full text-left px-3 py-1.5 text-[11px] transition-colors ${
                !value
                  ? 'bg-accent/10 text-accent font-medium'
                  : 'text-text-primary hover:bg-bg-hover'
              }`}
            >
              {placeholder}
            </button>
          )}
          {options.map((opt) => (
            <button
              key={opt.value}
              onClick={() => select(opt.value)}
              className={`w-full text-left px-3 py-1.5 text-[11px] transition-colors ${
                value === opt.value
                  ? 'bg-accent/10 text-accent font-medium'
                  : 'text-text-primary hover:bg-bg-hover'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
