/**
 * 笔记本右侧目录（Notion 式）—— 平时只是一列短横线：长短表示相对级别，当前章节那条加深；
 * 悬停横线列或键盘聚焦进来时，整列换成一张目录卡片，点标题跳转。
 */
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { relativeLevels, type NotebookHeading } from './notebookHeadings'

/** 横线宽度（px），按相对级别取；比最后一档更深的级别沿用最后一档 */
const DASH_WIDTHS = [16, 11, 7, 5]

/** 把 child 滚到可滚动容器 box 的中间（只动 box 自己，不像 scrollIntoView 那样连带滚动祖先） */
function centerIn(box: HTMLElement, child: HTMLElement): void {
  box.scrollTop = child.offsetTop - (box.clientHeight - child.offsetHeight) / 2
}

export function NotebookMinimap({
  headings,
  activeIndex,
  onJump
}: {
  headings: NotebookHeading[]
  /** 当前章节在 headings 里的下标；-1 = 还没读到第一个标题 */
  activeIndex: number
  onJump: (line: number) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const railRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const levels = relativeLevels(headings)

  // 标题多到横线列被 max-h 截住时，让当前章节的横线留在可见范围里
  useEffect(() => {
    const rail = railRef.current
    if (!rail || activeIndex < 0 || rail.scrollHeight <= rail.clientHeight) return
    const dash = rail.children[activeIndex]
    if (dash instanceof HTMLElement) centerIn(rail, dash)
  }, [activeIndex, headings])

  // 卡片展开时把当前项滚到卡片中间（卡片平时只是透明，仍在排版里，此刻就能量到位置）
  const revealActive = (): void => {
    const list = listRef.current
    const item = activeIndex >= 0 ? list?.children[activeIndex] : undefined
    if (list && item instanceof HTMLElement) centerIn(list, item)
  }

  // 横线列离右缘留 mr-1：编辑器 4px 宽的滚动条就在最右侧，悬停区不能盖住它。横线列 relative —— centerIn 用的
  // offsetTop 以最近的定位祖先为准，不定位就会量到 nav 上去
  // 展开条件用 :focus-visible 而不是 focus-within：鼠标点完一项后按钮仍握着焦点，
  // focus-within 会让卡片在鼠标移开后一直开着（只读预览跳转不会把焦点交还编辑器）
  const open = 'group-hover:opacity-100 group-has-[:focus-visible]:opacity-100'
  const hiddenWhenOpen = 'group-hover:opacity-0 group-has-[:focus-visible]:opacity-0'

  return (
    <nav
      aria-label={t('notebook.outline')}
      onFocus={revealActive}
      className="group pointer-events-none absolute inset-y-0 right-0 z-10 flex items-center"
    >
      <div
        ref={railRef}
        aria-hidden
        onMouseEnter={revealActive}
        className={`pointer-events-auto relative mr-1 flex max-h-[80%] flex-col items-end gap-[7px] overflow-hidden px-2 py-3 transition-opacity duration-150 ${hiddenWhenOpen}`}
      >
        {headings.map((h, i) => (
          <span
            key={`${i}-${h.line}`}
            style={{ width: DASH_WIDTHS[Math.min(levels[i], DASH_WIDTHS.length - 1)] }}
            className={`block h-[2px] shrink-0 rounded-full transition-colors duration-150 ${
              i === activeIndex ? 'bg-text-primary' : 'bg-text-tertiary/50'
            }`}
          />
        ))}
      </div>
      <div
        ref={listRef}
        className={`thin-scrollbar pointer-events-none absolute right-1 top-1/2 max-h-[80%] w-60 -translate-y-1/2 overflow-y-auto rounded-xl border border-border-secondary bg-bg-primary p-1.5 opacity-0 shadow-xl transition-opacity duration-150 group-hover:pointer-events-auto group-has-[:focus-visible]:pointer-events-auto ${open}`}
      >
        {headings.map((h, i) => (
          <button
            key={`${i}-${h.line}`}
            type="button"
            onClick={(e) => {
              // 鼠标点完就还掉焦点（detail > 0 = 指针点击，键盘触发为 0）：只读预览不会把焦点交还编辑器，
              // 按钮留着焦点的话，下一次按键就让它 :focus-visible、把卡片又顶开
              if (e.detail > 0) e.currentTarget.blur()
              onJump(h.line)
            }}
            title={h.text}
            aria-current={i === activeIndex ? 'location' : undefined}
            style={{ paddingLeft: 8 + levels[i] * 12 }}
            className={`block w-full truncate rounded-md py-1 pr-2 text-left text-[12px] leading-[1.4] transition-colors hover:bg-bg-hover ${
              i === activeIndex
                ? 'font-medium text-text-primary'
                : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            {h.text}
          </button>
        ))}
      </div>
    </nav>
  )
}
