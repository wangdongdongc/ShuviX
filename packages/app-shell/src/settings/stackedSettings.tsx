/**
 * 叠放设置（web 客户端的手机布局，SettingsContainer 的 `stacked`）里的第二层 —— 「提供商」「LLM 工具」这类分区
 * 自己又是「左边一列 + 右边详情」，手机上两栏并排挤在一屏里放不下。叠放时它们改成跟第一层一样的往下钻：
 *
 * - 先是一整屏的列表（`StackedListRow`：整行可点、行尾一个 ›）；
 * - 点一项 → 这一项的详情占满一屏，分区自己的顶栏换成「‹ <分区名>」+ 这一项的名字（`useStackedSubPage`），
 *   返回键回到列表。
 *
 * 分区组件只问 `useStackedSettings()` 自己是不是在叠放布局里，不需要宿主多传参数；不在（桌面、扩展）时一切照旧。
 */
import { createContext, useContext, useEffect, useLayoutEffect, useRef } from 'react'
import { ChevronRight } from 'lucide-react'

export interface StackedSubPage {
  /** 顶栏中间的名字（这一项的名字） */
  title: string
  /** 顶栏返回键：回到分区的列表 */
  onBack: () => void
}

interface StackedSettingsValue {
  setSubPage: (page: StackedSubPage | null) => void
}

const StackedSettingsContext = createContext<StackedSettingsValue | null>(null)

export const StackedSettingsProvider = StackedSettingsContext.Provider

/** 是不是在叠放设置里（手机布局） */
export function useStackedSettings(): boolean {
  return useContext(StackedSettingsContext) !== null
}

/**
 * 叠放时声明「此刻开着一项的详情」（null = 在列表上）：容器的顶栏据此换成第二层。离开（卸载、回到列表）时撤掉。
 * 只看 title 变没变 —— onBack 每次渲染都是新函数，存在 ref 里，按下时取最新的那个。
 * 用 layout effect 报上去：顶栏与内容在同一帧换（普通 effect 会先画出新内容配旧顶栏的一帧）
 */
export function useStackedSubPage(page: StackedSubPage | null): void {
  const ctx = useContext(StackedSettingsContext)
  const onBackRef = useRef<(() => void) | undefined>(page?.onBack)
  useEffect(() => {
    onBackRef.current = page?.onBack
  })
  const title = page?.title
  useLayoutEffect(() => {
    if (!ctx) return
    ctx.setSubPage(title === undefined ? null : { title, onBack: () => onBackRef.current?.() })
    return () => ctx.setSubPage(null)
  }, [ctx, title])
}

/** 真正在滚的那一层：自己或最近的祖先里 overflow-y 是 auto / scroll、而且内容确实超出的那个 */
function scrollerOf(el: HTMLElement | null): HTMLElement | null {
  for (let node = el; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node)
    if (
      (overflowY === 'auto' || overflowY === 'scroll') &&
      node.scrollHeight > node.clientHeight + 1
    )
      return node
  }
  return null
}

/**
 * 列表 ⇄ 详情的滚动位置：列表与详情共用同一个滚动容器（有的分区外面还包着宿主的滚动层），不管的话从列表靠下的
 * 一行点进去，详情一打开就停在半截，返回时列表又停在详情的位置。这里约定：打开一项 → 滚到顶；回到列表 → 回到
 * 离开时的位置（点那一行之前先 `remember()`）。`ref` 挂在列表 / 详情那一层上，往上找真正在滚的那一个
 */
export function useDrillDownScroll(itemOpen: boolean): {
  ref: React.RefObject<HTMLDivElement | null>
  remember: () => void
} {
  const ref = useRef<HTMLDivElement | null>(null)
  const listOffset = useRef(0)
  const first = useRef(true)
  useLayoutEffect(() => {
    // 第一次挂上不动：那是宿主自己的初始位置
    if (first.current) {
      first.current = false
      return
    }
    const scroller = scrollerOf(ref.current)
    if (scroller) scroller.scrollTop = itemOpen ? 0 : listOffset.current
  }, [itemOpen])
  return {
    ref,
    remember: () => {
      listOffset.current = scrollerOf(ref.current)?.scrollTop ?? 0
    }
  }
}

/**
 * 叠放列表里的一行（与第一层分区列表同一副排版：整宽、15px、行间一条细线、行尾 ›）。
 * `trailing` 放在 › 前面（提供商的启用开关）；点它不该进详情的，自己 stopPropagation
 */
export function StackedListRow({
  icon,
  label,
  tag,
  trailing,
  dimmed = false,
  onClick,
  rowProps
}: {
  icon?: React.ReactNode
  label: string
  /** 标签后的附注（平台标签、分类器标签）—— 不随标签截断 */
  tag?: React.ReactNode
  trailing?: React.ReactNode
  dimmed?: boolean
  onClick: () => void
  /** 行上的 data-* 锚点（e2e 认它们） */
  rowProps?: Record<string, string>
}): React.JSX.Element {
  return (
    <div
      role="button"
      tabIndex={0}
      {...rowProps}
      data-stacked-row=""
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClick()
        }
      }}
      className={`w-full flex items-center gap-3 px-4 min-h-[48px] text-left text-[15px] text-text-primary border-b border-border-secondary/40 active:bg-bg-hover cursor-pointer ${
        dimmed ? 'opacity-60' : ''
      }`}
    >
      {icon && (
        <span className="flex-shrink-0 inline-flex items-center text-text-tertiary">{icon}</span>
      )}
      <span className="flex-1 min-w-0 flex items-center gap-1.5">
        <span className="min-w-0 truncate">{label}</span>
        {tag}
      </span>
      {trailing}
      <ChevronRight size={16} className="flex-shrink-0 text-text-tertiary" />
    </div>
  )
}
