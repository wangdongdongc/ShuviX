import { memo, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  categoryOfPlaceholder,
  splitPlaceholders,
  type RedactionMarkInfo
} from '@shuvix/chat-protocol/utils/redactionPlaceholders'
import { useRedactionMark } from '../../hooks/useRedaction'
import {
  releaseRedactionAnchor,
  scheduleHideRedaction,
  showRedaction,
  toggleRedaction,
  updateRedaction,
  type RedactionReveal
} from './redactionPopover'

/** 浮层的内容（随界面语言） */
export function revealOf(
  t: (key: string, opts?: Record<string, unknown>) => string,
  placeholder: string,
  info: RedactionMarkInfo | undefined
): RedactionReveal {
  const category = info?.category ?? categoryOfPlaceholder(placeholder)
  return {
    label: t(`redaction.category.${category}`, { defaultValue: category }),
    ...(info?.value === undefined ? {} : { value: info.value }),
    note:
      info === undefined
        ? t('redaction.looking')
        : info.value === undefined
          ? t('redaction.unavailableNote')
          : t('redaction.placeholderNote'),
    copyLabel: t('common.copy'),
    copiedLabel: t('common.copied')
  }
}

/**
 * 一处占位符（docs/auto-redaction-design.md §2.3），显示的是模型收到的样子：
 *  - 模型收到的是真值（策略照发这一类，或信任这个服务商）→ 原样显示真值，不加标记；
 *  - 模型收到的是占位符 → 显示占位符原文；指到、聚焦或点一下才浮出真值（工具执行、文件里用的那个）。
 */
export const RedactedMark = memo(function RedactedMark({
  placeholder
}: {
  placeholder: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const info = useRedactionMark(placeholder)
  const ref = useRef<HTMLSpanElement>(null)
  const category = info?.category ?? categoryOfPlaceholder(placeholder)
  const reveal = (): RedactionReveal => revealOf(t, placeholder, info)

  // 浮出期间真值查到了：就地换掉浮层内容；卸载时收起自己的浮层
  useEffect(() => {
    if (ref.current) updateRedaction(ref.current, reveal())
  })
  useEffect(() => {
    const el = ref.current
    return () => {
      if (el) releaseRedactionAnchor(el)
    }
  }, [])

  if (info?.disclosed === true && info.value !== undefined) {
    return (
      <span data-redaction={category} data-redaction-sent="">
        {info.value}
      </span>
    )
  }
  return (
    <span
      ref={ref}
      role="button"
      tabIndex={0}
      data-redaction={category}
      data-redaction-placeholder=""
      onMouseEnter={(e) => showRedaction(e.currentTarget, reveal())}
      onMouseLeave={(e) => scheduleHideRedaction(e.currentTarget)}
      onFocus={(e) => showRedaction(e.currentTarget, reveal())}
      onBlur={(e) => scheduleHideRedaction(e.currentTarget)}
      onClick={(e) => {
        e.stopPropagation()
        toggleRedaction(e.currentTarget, reveal())
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        e.preventDefault()
        e.stopPropagation()
        toggleRedaction(e.currentTarget, reveal())
      }}
      className="cursor-help rounded-[4px] bg-warning/15 px-1 font-mono text-[0.88em] text-text-primary outline-none focus-visible:ring-1 focus-visible:ring-warning"
    >
      {placeholder}
    </span>
  )
})

/** 一段纯文本：占位符按模型收到的样子显示，其余原样（没有占位符时就是那段字符串） */
export function RedactedText({ text }: { text: string }): React.ReactNode {
  const segments = useMemo(() => splitPlaceholders(text), [text])
  if (segments.length === 1 && typeof segments[0] === 'string') return segments[0]
  return segments.map((segment, index) =>
    typeof segment === 'string' ? (
      segment
    ) : (
      <RedactedMark key={index} placeholder={segment.placeholder} />
    )
  )
}
