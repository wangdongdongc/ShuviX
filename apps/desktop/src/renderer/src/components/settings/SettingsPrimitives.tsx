import { ChevronDown } from 'lucide-react'
import type { ReactNode } from 'react'

/**
 * 设置页通用基元：分节标题 + 圆角卡片 + 行式条目（左标题/描述，右控件）。
 *
 * 设计与 SessionConfigPanel 保持一致，可被 GeneralSettings / 其他设置 Tab 共用。
 */

export function SettingsSection({
  title,
  description,
  headerAction,
  preamble,
  footer,
  children
}: {
  title: ReactNode
  description?: ReactNode
  headerAction?: ReactNode
  /** 渲染在分组标题与卡片之间的内容（例如警告 callout） */
  preamble?: ReactNode
  footer?: ReactNode
  children: ReactNode
}): React.JSX.Element {
  return (
    <section>
      <div className="flex items-start justify-between mb-2 px-1 gap-3">
        <div className="min-w-0">
          <h3 className="text-[13px] font-semibold text-text-primary">{title}</h3>
          {description && (
            <p className="text-[11px] text-text-tertiary mt-0.5 leading-relaxed">{description}</p>
          )}
        </div>
        {headerAction && <div className="shrink-0">{headerAction}</div>}
      </div>
      {preamble && <div className="mb-2">{preamble}</div>}
      <div className="rounded-xl border border-border-secondary/60 bg-bg-secondary/30 overflow-hidden divide-y divide-border-secondary/40">
        {children}
      </div>
      {footer && (
        <div className="text-[10px] text-text-tertiary mt-2 px-1 leading-relaxed">{footer}</div>
      )}
    </section>
  )
}

export function SettingsRow({
  title,
  description,
  icon,
  control
}: {
  title: ReactNode
  description?: ReactNode
  icon?: ReactNode
  control?: ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-[13px] text-text-primary">
          {icon}
          {title}
        </div>
        {description && (
          <div className="text-[11px] text-text-tertiary mt-0.5 leading-relaxed">{description}</div>
        )}
      </div>
      {control && <div className="shrink-0">{control}</div>}
    </div>
  )
}

/**
 * 整行宽度的内容块（用于多行输入、说明文字等，不强制左右布局）。
 * 放在 SettingsSection 中作为独立的行。
 */
export function SettingsBlock({
  label,
  description,
  children
}: {
  label?: ReactNode
  description?: ReactNode
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className="px-4 py-3 space-y-2">
      {(label || description) && (
        <div className="min-w-0">
          {label && <div className="text-[13px] text-text-primary">{label}</div>}
          {description && (
            <div className="text-[11px] text-text-tertiary mt-0.5 leading-relaxed">
              {description}
            </div>
          )}
        </div>
      )}
      {children}
    </div>
  )
}

export function Toggle({
  on,
  onClick,
  color = 'accent',
  disabled = false
}: {
  on: boolean
  onClick: () => void
  color?: 'accent' | 'amber'
  disabled?: boolean
}): React.JSX.Element {
  const onColor = color === 'amber' ? 'bg-amber-500' : 'bg-accent'
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center w-8 h-[18px] rounded-full px-[2px] transition-colors ${
        on ? onColor : 'bg-bg-hover'
      } ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
    >
      <span
        className={`block w-[14px] h-[14px] rounded-full bg-white shadow-sm transition-transform duration-150 ${
          on ? 'translate-x-[14px]' : 'translate-x-0'
        }`}
      />
    </button>
  )
}

export function InlineSelect({
  value,
  onChange,
  children,
  width = 200
}: {
  value: string
  onChange: (v: string) => void
  children: ReactNode
  /** 固定宽度（默认 200px），便于同一页面的多个 select 视觉对齐 */
  width?: number
}): React.JSX.Element {
  return (
    <div className="relative inline-block" style={{ width }}>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full appearance-none bg-bg-primary rounded-md pl-2.5 pr-7 py-1 text-[11px] text-text-primary border border-border-secondary/50 transition-colors hover:border-border-secondary cursor-pointer truncate focus:outline-none focus:border-accent/60"
      >
        {children}
      </select>
      <ChevronDown
        size={11}
        className="absolute right-1.5 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none"
      />
    </div>
  )
}

/**
 * 行内输入框 — 视觉风格与 InlineSelect 一致，作为 SettingsRow 的 control 使用。
 */
export function InlineInput({
  value,
  onChange,
  onBlur,
  placeholder,
  type = 'text',
  width = 200,
  autoFocus,
  monospace,
  disabled,
  min,
  max
}: {
  value: string | number
  onChange: (v: string) => void
  onBlur?: () => void
  placeholder?: string
  type?: 'text' | 'password' | 'number'
  /** 固定宽度（默认 200px） */
  width?: number
  autoFocus?: boolean
  monospace?: boolean
  disabled?: boolean
  min?: number
  max?: number
}): React.JSX.Element {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      placeholder={placeholder}
      autoFocus={autoFocus}
      disabled={disabled}
      min={min}
      max={max}
      style={{ width }}
      className={`appearance-none bg-bg-primary rounded-md px-2.5 py-1 text-[11px] text-text-primary border border-border-secondary/50 transition-colors hover:border-border-secondary focus:outline-none focus:border-accent/60 placeholder:text-text-tertiary disabled:opacity-60 disabled:cursor-not-allowed${monospace ? ' font-mono' : ''}`}
    />
  )
}

/**
 * 分段控件（小型按钮组）。少量、互斥选项的紧凑切换器。
 */
export function SegmentedControl<T extends string>({
  value,
  onChange,
  options
}: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: ReactNode }[]
}): React.JSX.Element {
  return (
    <div className="inline-flex items-center rounded-md bg-bg-tertiary/60 border border-border-secondary/50 p-0.5 gap-0.5">
      {options.map((opt) => {
        const selected = opt.value === value
        return (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            className={`px-2.5 py-1 rounded text-[11px] font-medium transition-colors ${
              selected
                ? 'bg-bg-primary text-text-primary shadow-sm'
                : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}

/**
 * 嵌入到 SettingsRow 控件位置的滑块。带末尾数值显示。
 */
export function InlineSlider({
  value,
  min,
  max,
  step = 1,
  onChange,
  suffix,
  width = 160
}: {
  value: number
  min: number
  max: number
  step?: number
  onChange: (v: number) => void
  suffix?: string
  width?: number
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ width }}
        className="h-1.5 bg-bg-tertiary rounded-full appearance-none cursor-pointer accent-accent"
      />
      <span className="text-[11px] text-text-tertiary tabular-nums min-w-[36px] text-right">
        {value}
        {suffix}
      </span>
    </div>
  )
}
