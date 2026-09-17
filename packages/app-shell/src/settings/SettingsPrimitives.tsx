import { ChevronDown, CircleHelp } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

/**
 * 设置页通用基元：分节标题 + 圆角卡片 + 行式条目（左标题/说明，右控件）。
 *
 * 设计与 SessionConfigPanel 保持一致，可被 GeneralSettings / 其他设置 Tab 共用。
 *
 * **说明文字一律收进问号气泡**（2026-09-17）：`description` / `footer` 不再铺成正文，而是标题旁一个
 * 小问号，悬浮或聚焦才展开。设置页的说明多是「这个开关是干嘛的」，一屏铺满灰字之后，真正要找的那一行
 * 开关反而被埋住；收起来之后一屏只剩标题与控件，要看解释的人一眼知道去点哪。
 *
 * 少数 `description` 并不是解释，而是这一行自己的内容（SSH 凭据的 `user@host`、更新检查的当前状态）——
 * 那些走 `subtitle`，照旧铺成一行文字。判据很简单：**收起来之后这一行还说得清自己是谁**，就该收起来。
 */

/** 气泡与触发点之间留的空隙（px） */
const HINT_GAP = 6
/** 气泡到视口边缘的最小距离（px） */
const HINT_MARGIN = 8

/** 一个矩形的左上角与尺寸（`DOMRect` 的子集 —— 这里只用得到这几个数） */
export interface HintBox {
  top: number
  bottom: number
  left: number
  width: number
}

/**
 * 气泡该放在哪（视口坐标，配 `position: fixed`）。`null` = 锚点整个滚出视野，该藏起来。
 *
 * 单独拎出来是因为**五个分支里有四个在真实设置页永远走不到** —— 那里的问号清一色贴着左上角，
 * 翻转、贴边、出视口都碰不到，e2e 再多也覆盖不了，只能靠单测把它们钉住。
 * 纯算术、无副作用：读 rect 与写 style 都留在 `place()` 里。
 */
export function hintPosition(
  anchor: HintBox,
  tip: { width: number; height: number },
  viewport: { width: number; height: number }
): { top: number; left: number } | null {
  // 锚点整个滚出视野：留在原地会变成一段飘在无关内容上的说明，藏起来更诚实
  if (anchor.bottom < 0 || anchor.top > viewport.height) return null
  const left = Math.min(
    Math.max(HINT_MARGIN, anchor.left + anchor.width / 2 - tip.width / 2),
    Math.max(HINT_MARGIN, viewport.width - tip.width - HINT_MARGIN)
  )
  const below = anchor.bottom + HINT_GAP
  if (below + tip.height <= viewport.height - HINT_MARGIN) return { top: below, left }
  // 下方放不下就翻到上方；**上方也放不下时钉在上边距** —— 那会盖住锚点，是刻意选的：
  // 气泡是 pointer-events-none 的 fixed 层，既不在任何滚动容器里、也没有 max-height，
  // 掉到视口下沿之外就彻底够不着。说明比整个视口还高才会走到这一支，今天最长的也就几行。
  return { top: Math.max(HINT_MARGIN, anchor.top - HINT_GAP - tip.height), left }
}

/**
 * 说明气泡：一个小问号，悬浮（或键盘聚焦）才展开说明。
 *
 * **为什么是 portal + fixed**：设置卡片本身是 `overflow-hidden` 的圆角容器，行内绝对定位的气泡会被
 * 裁掉半截；挂到 body 上、按触发点现算坐标，就不受任何祖先的裁剪与层叠影响。
 *
 * 滚动与改窗口大小时**重新定位，不收起**：`focus()` 本身会把按钮滚进视野，若滚动即收起，键盘 Tab
 * 过来的人刚展开就被自己那一下滚动关掉（e2e 的 UIF-E-1 正是撞在这上面）。锚点整个滚出视野时才藏起来。
 *
 * 可及性：问号是真的 `<button>`（能 Tab 到），聚焦即展开，Esc 收起；气泡以 `aria-describedby`
 * 挂在按钮上，读屏把它当这个按钮的说明来念，而不是页面上多出来的一段散文。
 */
export function InfoHint({ hint }: { hint: ReactNode }): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const id = useId()

  const close = useCallback(() => setOpen(false), [])

  /**
   * 坐标直接写在 DOM 上，不进 state：气泡是自适应宽度的，只有挂上去量过才知道往哪放，而「量完再
   * setState 重渲染一次」既是级联渲染（lint 拦的正是这个），又会先在 (0,0) 画一帧。
   * 配合 `useLayoutEffect`（浏览器绘制**之前**同步跑），用户看到的第一帧就已经在位。
   * React 不管这三个属性（元素上没有 `style`），也就不会在下一次渲染时把它们抹掉。
   */
  const place = useCallback((): void => {
    const trigger = triggerRef.current
    const tip = tipRef.current
    if (!trigger || !tip) return
    const anchor = trigger.getBoundingClientRect()
    const box = tip.getBoundingClientRect()
    const at = hintPosition(anchor, box, {
      width: window.innerWidth,
      height: window.innerHeight
    })
    if (!at) {
      tip.style.visibility = 'hidden'
      return
    }
    tip.style.top = `${at.top}px`
    tip.style.left = `${at.left}px`
    tip.style.visibility = 'visible'
  }, [])

  useLayoutEffect(() => {
    if (open) place()
  }, [open, hint, place])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    // capture：说明多半在某个内部滚动容器里，滚动事件不冒泡到 window
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    document.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, close, place])

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-info-hint
        aria-label={t('common.info')}
        // 标准 tooltip 接法：气泡是这个按钮的**说明**。刻意不写 aria-expanded —— 那是展开/收起
        // 一块内容的控件才有的语义，会让读屏把它念成一个可操作的开关
        aria-describedby={open ? id : undefined}
        onMouseEnter={() => setOpen(true)}
        // 键盘打开的那一个，不该被路过的鼠标关掉：Tab 过来展开之后鼠标碰巧扫过再移开，
        // 焦点明明没动，说明却没了，而键盘上除了「失焦再聚焦」没有重开的路
        onMouseLeave={() => {
          if (document.activeElement !== triggerRef.current) close()
        }}
        onFocus={() => setOpen(true)}
        onBlur={close}
        // 说明不是操作：点问号不该惊动这一行。要挡住的是**冒泡**（问号可能坐在可点的行里），
        // 而 type="button" 本来就没有默认行为可取消 —— preventDefault 在这儿是个空操作
        onClick={(e) => e.stopPropagation()}
        className="inline-flex shrink-0 items-center rounded text-text-tertiary/70 hover:text-text-secondary transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60"
      >
        <CircleHelp size={12} />
      </button>
      {open &&
        createPortal(
          <div
            ref={tipRef}
            id={id}
            data-info-tip
            role="tooltip"
            className="fixed top-0 left-0 z-[70] w-max max-w-[280px] px-2.5 py-1.5 rounded-lg border border-border-secondary bg-bg-primary shadow-lg text-[11px] leading-relaxed text-text-secondary pointer-events-none"
          >
            {hint}
          </div>,
          document.body
        )}
    </>
  )
}

export function SettingsSection({
  title,
  description,
  headerAction,
  preamble,
  footer,
  children
}: {
  title: ReactNode
  /** 这一节是干嘛的 —— 收进标题旁的问号气泡 */
  description?: ReactNode
  headerAction?: ReactNode
  /** 渲染在分组标题与卡片之间的内容（例如警告 callout）—— 不是说明，照旧铺在卡片上方 */
  preamble?: ReactNode
  /** 卡片的补充说明 —— 与 description 同进一个气泡（两者都给时按先后叠成两段） */
  footer?: ReactNode
  children: ReactNode
}): React.JSX.Element {
  // 两个都是「这一节的说明」，只是历史上落在标题下方与卡片下方；收进气泡之后没有理由再分两处
  const hint =
    description || footer ? (
      <div className="space-y-1.5">
        {description && <div>{description}</div>}
        {footer && <div>{footer}</div>}
      </div>
    ) : null

  return (
    <section>
      <div className="flex items-start justify-between mb-2 px-1 gap-3">
        <div className="min-w-0 flex items-center gap-1.5">
          <h3 className="text-[13px] font-semibold text-text-primary">{title}</h3>
          {hint && <InfoHint hint={hint} />}
        </div>
        {headerAction && <div className="shrink-0">{headerAction}</div>}
      </div>
      {preamble && <div className="mb-2">{preamble}</div>}
      <div className="rounded-xl border border-border-secondary/60 bg-bg-secondary/30 overflow-hidden divide-y divide-border-secondary/40">
        {children}
      </div>
    </section>
  )
}

export function SettingsRow({
  title,
  description,
  subtitle,
  icon,
  control
}: {
  title: ReactNode
  /** 这一行是干嘛的 —— 收进标题旁的问号气泡 */
  description?: ReactNode
  /** 这一行**自己的内容**（凭据的 user@host、当前更新状态）—— 照旧铺成标题下的一行字 */
  subtitle?: ReactNode
  icon?: ReactNode
  control?: ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-[13px] text-text-primary">
          {icon}
          {title}
          {description && <InfoHint hint={description} />}
        </div>
        {subtitle && (
          <div className="text-[11px] text-text-tertiary mt-0.5 leading-relaxed">{subtitle}</div>
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
  subtitle,
  children
}: {
  label?: ReactNode
  /**
   * 这一块是干嘛的 —— 收进标签旁的问号气泡。
   * 不给 `label` 只给它，渲染出来是一个**没有解释对象的孤零零问号**；今天没有调用点这么用，
   * 也不该这么用（要么给标签，要么这段话本就该是 `subtitle`）。
   */
  description?: ReactNode
  /** 这一块**自己的内容** —— 照旧铺成标签下的一行字 */
  subtitle?: ReactNode
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className="px-4 py-3 space-y-2">
      {(label || description || subtitle) && (
        <div className="min-w-0">
          {(label || description) && (
            <div className="flex items-center gap-1.5 text-[13px] text-text-primary">
              {label}
              {description && <InfoHint hint={description} />}
            </div>
          )}
          {subtitle && (
            <div className="text-[11px] text-text-tertiary mt-0.5 leading-relaxed">{subtitle}</div>
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
