import { useEffect, useRef, useState } from 'react'
import { RedactedText } from './RedactedText'

/**
 * 折叠态的单行内容盒 —— 高度对齐工具行（ToolCallBlock 的 StepRow）的单行：那边是
 * `text-[11px]` 配继承来的 1.5 行高 = 16.5px，两者外层同为 `py-1`，于是这一块与工具行
 * 等高、在过程区里排成齐整的一列。
 *
 * 行高写死而不是跟着 `leading-relaxed`：思考用的是 13.5px 衬线，relaxed(1.625) 的行盒
 * 是 21.9px，比工具行高出 5px —— 一眼就能看出两种行不在一个节奏上。展开态仍走外层的
 * `leading-relaxed`（那里是大段正文，宽松行距才好读），只有折叠这一行收紧。
 */
const COLLAPSED_LINE = 'h-[16.5px] leading-[16.5px]'

/**
 * 思考块 —— 一段特殊的中间文本，不是「行」：无图标、无标签、无边框。
 * 折叠时收成**一行**，点击原地撑开同一段文字（不另起一块，避免开头重复出现两遍）。
 *
 * 折叠的已完成态是真正的单行（不换行、超出处省略号），而不是「整段换行再裁到一行高」：后者让
 * 盒子里藏着整段文字的高度，手机浏览器里外层按 `<button>` 排版时会按那个高度留位，折叠的思考块
 * 下面空出一大块（越长越大）。外层因此也不用 `<button>`，用 `role="button"` 的 div（Enter /
 * 空格同样展开），测试用 `data-thinking-block` 找它。
 */
export function ThinkingBlock({
  content,
  isGenerating
}: {
  content: string
  /** 是否正在流式生成中 */
  isGenerating?: boolean
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const viewRef = useRef<HTMLDivElement>(null)

  // 生成中始终贴着最新内容：折叠态是一行高的跑马灯窗口，展开态跟随滚到底
  useEffect(() => {
    if (!isGenerating) return
    const el = viewRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [isGenerating, expanded, content])

  // 折叠态压平换行按一段连续文字滚动；展开态保留原始换行按段落读
  const flat = content.replace(/\s*\n+\s*/g, ' ').trim()

  const caret = isGenerating ? (
    <span className="inline-block w-1.5 h-3 ml-1 align-[-1px] bg-accent/60 animate-pulse rounded-sm" />
  ) : null

  return (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      data-thinking-block=""
      // 展开后是大段可读文本，选中文字时不该顺手折叠掉
      onClick={() => {
        if (window.getSelection()?.toString()) return
        setExpanded(!expanded)
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        e.preventDefault()
        setExpanded(!expanded)
      }}
      className="block w-full my-0.5 px-1 py-1 rounded-md text-left font-serif text-[13.5px] leading-relaxed text-text-tertiary select-text cursor-pointer transition-colors hover:text-text-secondary hover:bg-bg-tertiary/40"
    >
      {expanded ? (
        // 首尾的空行去掉：不少模型的思考以几个换行收尾，pre-wrap 下就是展开后一截空白
        <div ref={viewRef} className="whitespace-pre-wrap break-words max-h-96 overflow-y-auto">
          <RedactedText text={content.trim()} />
          {caret}
        </div>
      ) : isGenerating ? (
        /* 一行高的定高窗口 + 程序化滚到底：clamp 只会卡在开头，看不出模型在想什么 */
        <div ref={viewRef} className={`${COLLAPSED_LINE} overflow-hidden break-words`}>
          <RedactedText text={flat} />
          {caret}
        </div>
      ) : (
        <div className={`${COLLAPSED_LINE} truncate`}>
          <RedactedText text={flat} />
        </div>
      )}
    </div>
  )
}
