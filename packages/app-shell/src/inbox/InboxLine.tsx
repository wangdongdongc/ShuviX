/**
 * 收件箱的一行（M1，2026-11-10 用户选定：元素精简，用图形和动效代替文字）。
 *
 * 一行就是一行：行首一个状态图形、标题、灰色的一句预览、行尾的时间。状态不再用文字写，靠行首的形状：
 * 琥珀问号 / 盾牌 = 在等你回答（实心盾牌 = 申请完全访问），蓝点 = 新回复（红点 = 出错），在运行的是侧栏那枚会话图标
 * （蓝色呼吸 = agent 在干活，绿色不动 = 只剩后台命令开着，见 SessionIcon），空心圆 = 跟踪中（虚线琥珀圆 = 在等别人）。
 * 图形都带 `title` 与读屏文字，平时看不见字，悬停或读屏时还在。
 *
 * 行首那一格可以是按钮（跟踪项的圆圈 = 归档），所以整行是一个 div，点开的是中间那个按钮；行尾可以再挂一个
 * 只在悬停时出现的动作（标为已读、恢复）。
 */

import type { InboxFamily } from './inboxItems'

export interface InboxLineProps {
  /** 行首的状态图形（已经套好 18px 的格子，见 GlyphCell） */
  leading: React.ReactNode
  title: React.ReactNode
  /** 标题的字重 / 颜色（新回复加粗，已归档变灰） */
  titleClassName?: string
  preview?: React.ReactNode
  /** 行尾的时间之类（灰色小字） */
  meta?: React.ReactNode
  /** 只在悬停时出现的行尾内容（盖在 meta 上） */
  hoverMeta?: React.ReactNode
  /** 行尾的其它控件（子会话圆点之类），在点开的按钮之外 */
  trailing?: React.ReactNode
  /** 挂在父会话下面：往里缩一格 */
  indent?: boolean
  onOpen: () => void
  /** 点开按钮的悬停提示（跟踪项给文件名） */
  openTitle?: string
  /** 写到行最外层的 data-* / aria-* 属性 */
  attrs?: Record<string, string | undefined>
  openAttrs?: Record<string, string | undefined>
  onContextMenu?: (e: React.MouseEvent) => void
}

export function InboxLine({
  leading,
  title,
  titleClassName = 'text-text-primary',
  preview,
  meta,
  hoverMeta,
  trailing,
  indent = false,
  onOpen,
  openTitle,
  attrs,
  openAttrs,
  onContextMenu
}: InboxLineProps): React.JSX.Element {
  return (
    <div
      {...attrs}
      onContextMenu={onContextMenu}
      className={`group relative flex items-center gap-2.5 rounded-[7px] pr-2 transition-colors hover:bg-bg-hover/60 ${
        indent ? 'pl-[34px]' : 'pl-2'
      }`}
    >
      {leading}
      <button
        type="button"
        {...openAttrs}
        onClick={onOpen}
        title={openTitle}
        className="flex min-w-0 flex-1 items-center gap-2.5 py-[7px] text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <span className={`min-w-0 max-w-[58%] shrink-0 truncate text-[14px] ${titleClassName}`}>
          {title}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-text-secondary">{preview}</span>
        {meta !== undefined && meta !== null && (
          <span
            className={`shrink-0 text-[12px] tabular-nums text-text-tertiary ${
              hoverMeta ? 'group-hover:invisible group-focus-within:invisible' : ''
            }`}
          >
            {meta}
          </span>
        )}
      </button>
      {hoverMeta && (
        <span className="absolute right-2 flex items-center opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
          {hoverMeta}
        </span>
      )}
      {trailing}
    </div>
  )
}

/** 行首 18px 的一格（图形居中；`label` 同时是悬停提示与读屏文字） */
export function GlyphCell({
  children,
  label
}: {
  children: React.ReactNode
  label?: string
}): React.JSX.Element {
  return (
    <span
      role={label ? 'img' : undefined}
      aria-label={label}
      title={label}
      className="flex h-[18px] w-[18px] shrink-0 items-center justify-center"
    >
      {children}
    </span>
  )
}

/** 新回复：蓝点；这一轮出错时是红点 */
export function UnreadGlyph({
  failed,
  label
}: {
  failed: boolean
  label: string
}): React.JSX.Element {
  return (
    <GlyphCell label={label}>
      <span className={`h-2 w-2 rounded-full ${failed ? 'bg-error' : 'bg-accent'}`} />
    </GlyphCell>
  )
}

/** 申请完全访问的批准：实心盾牌（平时的批准是空心的） */
export function FullAccessShield({ size = 17 }: { size?: number }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="shrink-0 text-warning"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path
        fill="currentColor"
        stroke="currentColor"
        d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"
      />
      <path stroke="white" fill="none" d="M12 8v4" />
      <path stroke="white" fill="none" d="M12 16h.01" />
    </svg>
  )
}

/** 一行最多画几个子会话圆点，再多的写成 +N */
const MAX_PIPS = 6

/**
 * 父会话行尾的子会话圆点：一条子会话一个 —— 琥珀实心 = 在等你，蓝色实心 = 有新回复，蓝色空心（呼吸）= agent 在干活，
 * 绿色空心（不动）= 只剩后台命令开着（颜色与动效同会话图标）。有在运行的子会话时它是一个按钮，点一下展开 / 收起那几条
 */
export function FamilyPips({
  family,
  open,
  label,
  onToggle
}: {
  family: InboxFamily
  open: boolean
  label: string
  onToggle?: () => void
}): React.JSX.Element {
  const states = [
    ...family.waiting.map(() => 'waiting' as const),
    ...family.unread.map(() => 'unread' as const),
    ...family.running.map((item) =>
      item.run === 'resident' ? ('resident' as const) : ('running' as const)
    )
  ]
  const shown = states.slice(0, MAX_PIPS)
  const more = states.length - shown.length
  const pips = (
    <>
      {shown.map((state, i) => (
        <span
          key={i}
          data-pip={state}
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
            state === 'waiting'
              ? 'bg-amber-400'
              : state === 'unread'
                ? 'bg-accent'
                : state === 'resident'
                  ? 'border-[1.5px] border-success'
                  : 'border-[1.5px] border-accent animate-pulse motion-reduce:animate-none'
          }`}
        />
      ))}
      {more > 0 && <span className="text-[11px] text-text-tertiary">+{more}</span>}
    </>
  )
  return onToggle ? (
    <button
      type="button"
      data-inbox-family-toggle=""
      aria-expanded={open}
      aria-label={label}
      title={label}
      onClick={onToggle}
      className="flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 transition-colors hover:bg-bg-active"
    >
      {pips}
    </button>
  ) : (
    <span
      role="img"
      aria-label={label}
      title={label}
      className="flex h-6 shrink-0 items-center gap-1 px-1.5"
    >
      {pips}
    </span>
  )
}
