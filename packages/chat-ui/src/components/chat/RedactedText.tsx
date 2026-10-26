import { memo, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Lock } from 'lucide-react'
import {
  categoryOfPlaceholder,
  splitPlaceholders
} from '@shuvix/chat-protocol/utils/redactionPlaceholders'
import { useRedactionMark } from '../../hooks/useRedaction'

/**
 * 一处占位符（docs/auto-redaction-design.md §2.3）：对话记录里存的是 `{{API_KEY_k3v7x2mq}}`，界面显示会话对照表里的
 * 真值，加一个标记说明「这里在记录里是占位符」，不加说明文字（悬停显示类别）。真值还没查到、或这台电脑解不开时
 * 显示一枚带锁的类别小签。
 */
export const RedactedMark = memo(function RedactedMark({
  placeholder
}: {
  placeholder: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const info = useRedactionMark(placeholder)
  const category = info?.category ?? categoryOfPlaceholder(placeholder)
  const label = t(`redaction.category.${category}`, { defaultValue: category })
  if (info?.value !== undefined) {
    return (
      <span
        data-redaction={category}
        title={label}
        className="rounded-[3px] bg-warning/10 underline decoration-warning/60 decoration-dotted underline-offset-2"
      >
        {info.value}
      </span>
    )
  }
  return (
    <span
      data-redaction={category}
      data-redaction-missing=""
      title={info ? t('redaction.unavailable', { label }) : label}
      className="inline-flex items-center gap-0.5 rounded-[3px] bg-warning/15 px-1 align-baseline text-[0.85em] text-warning"
    >
      <Lock size={10} className="flex-shrink-0" />
      {label}
    </span>
  )
})

/** 一段纯文本：占位符换成标记，其余原样（没有占位符时就是那段字符串） */
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
