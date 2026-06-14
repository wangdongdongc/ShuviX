import { useRef, useState, useCallback } from 'react'
import { ChevronDown } from 'lucide-react'
import { useClickOutside } from '@shuvix/chat-ui'

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

  const placeholderActive = !value

  return (
    <div ref={ref} className="relative w-full">
      <button
        onClick={() => setOpen(!open)}
        className={`w-full flex items-center justify-between gap-1 bg-bg-primary border border-border-secondary/50 rounded-md px-2.5 py-1 text-[11px] hover:border-border-secondary transition-colors cursor-pointer ${
          placeholderActive ? 'text-text-tertiary' : 'text-text-primary'
        } ${open ? 'border-accent/60' : ''}`}
      >
        <span className="truncate">{selectedLabel}</span>
        <ChevronDown size={11} className="text-text-tertiary flex-shrink-0" />
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-full mt-1 max-h-60 rounded-lg border border-border-primary bg-bg-secondary shadow-2xl overflow-y-auto z-50">
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
