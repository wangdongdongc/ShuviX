/**
 * 询问卡片上可能很长的那段话（选项题的问题、审批卡的标题）：平时最多两行，超出时第二行末尾是「…展开全文」。
 *
 * 卡片在对话流末尾，问题一长就占掉半屏、把选项挤到屏幕外；选项才是要点的东西，所以问题先收起来。开关不单独占一行：
 * 收起时盖在第二行行尾（左边一小段渐变把被截的字淡出，底色是卡片的 bg-primary —— 对话里的卡片与笔记本输入卡片
 * 都是它），展开后「收起」紧跟在最后一个字后面。
 *
 * 只有真的被截断才出现开关：量 scrollHeight 与 clientHeight，宽度变了（窗口缩放、侧栏开合）再量一次。
 */
import { useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

/** 盖在行尾的开关左边那段渐变：被截的字从这里淡出 */
const FADE_STYLE = {
  background: 'linear-gradient(to right, transparent, var(--color-bg-primary))'
} as const

export function ClampedText({
  text,
  className,
  data
}: {
  text: string
  className: string
  /** 挂在正文段落上的 data-* 属性（测试与页面对象的锚点） */
  data?: Record<string, string>
}): React.JSX.Element {
  const { t } = useTranslation()
  const ref = useRef<HTMLParagraphElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [overflowing, setOverflowing] = useState(false)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el || expanded) return
    const measure = (): void => setOverflowing(el.scrollHeight > el.clientHeight + 1)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [text, expanded])

  // 字号、行高随段落（className 给的），开关只换颜色与字重
  const toggleClass = 'font-normal text-accent hover:underline'
  const collapsed = overflowing && !expanded

  // 收起时的开关在段落外（段落的 textContent 只有原文，页面对象按它读），盖在它的右下角
  return (
    <div className={collapsed ? 'relative min-w-0' : 'min-w-0'}>
      <p
        ref={ref}
        className={`${className} ${expanded ? '' : 'line-clamp-2'}`}
        data-clamped={collapsed ? '' : undefined}
        {...data}
      >
        {text}
        {expanded && (
          <>
            {' '}
            <button
              type="button"
              onClick={() => setExpanded(false)}
              aria-expanded={true}
              data-clamp-toggle=""
              className={toggleClass}
            >
              {t('pendingInputs.hideFullText')}
            </button>
          </>
        )}
      </p>
      {collapsed && (
        <span className={`${className} absolute right-0 bottom-0 flex`}>
          <span aria-hidden="true" className="w-8" style={FADE_STYLE} />
          <button
            type="button"
            onClick={() => setExpanded(true)}
            aria-expanded={false}
            data-clamp-toggle=""
            className={`bg-bg-primary ${toggleClass}`}
          >
            <span aria-hidden="true" className="text-text-tertiary">
              …{' '}
            </span>
            {t('pendingInputs.showFullText')}
          </button>
        </span>
      )}
    </div>
  )
}
