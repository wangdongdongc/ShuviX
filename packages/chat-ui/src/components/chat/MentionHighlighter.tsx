import { forwardRef } from 'react'
import { useTranslation } from 'react-i18next'
import { buildAtToken, buildPasteToken } from '@shuvix/chat-protocol/utils/inlineTokens'
import type { InlineToken } from '@shuvix/chat-protocol/types/chatMessage'
import { matchMentions, type AtMention } from '../../hooks/useAtMentions'
import { matchPasteChips, type PasteChip } from '../../hooks/usePasteChips'
import { matchSecretChips, type SecretChip } from '../../hooks/useSecretChips'
import type { RedactionHintSpan } from '../../hooks/useRedactionHints'
import { SECRET_TOKEN_TYPE } from '../../utils/tokenDisplay'
import { TokenChip } from './TokenChip'

interface MentionHighlighterProps {
  /** 与 textarea 同步的明文 */
  text: string
  /** 已登记的 @ 引用 */
  mentions: AtMention[]
  /** 已登记的粘贴芯片 */
  pasteChips?: PasteChip[]
  /** 要对模型藏起来的值的胶囊（§14） */
  secretChips?: SecretChip[]
  /** 提示：可能是敏感信息的几处（画虚线下划线） */
  hintSpans?: RedactionHintSpan[]
  /** 与 textarea 完全一致的字体/内边距/换行类（保证逐字对齐） */
  className: string
  /** 与 textarea 一致的 minHeight / textIndent 等内联样式 */
  style?: React.CSSProperties
}

/** 一处要画的命中区间：@ 引用 / 粘贴占位 / 要藏的值的胶囊（token）、提示的下划线（hint） */
interface ChipHit {
  start: number
  end: number
  token?: InlineToken
  kind?: 'hint'
}

/**
 * 输入框镜像层 —— 逐字复刻输入内容、覆于 textarea 之上（本层 pointer-events-none）。
 * 非胶囊文字透明（露出下方 textarea 的原生字形/光标/选区）；每处 @ 引用 / 粘贴占位 / 要藏的值渲染为
 * <TokenChip inline>—— 按类型分色的胶囊（类型色文字 + 类型色淡底，at 知识的前缀段弱化）。
 * 因镜像与 textarea 同字体同位置，胶囊字形恰压在下方原字形上；`inline` 变体布局中性故光标仍对齐。
 * 滚动由父组件把本层 scrollTop 同步为 textarea.scrollTop。
 */
export const MentionHighlighter = forwardRef<HTMLDivElement, MentionHighlighterProps>(
  function MentionHighlighter(
    { text, mentions, pasteChips, secretChips, hintSpans, className, style },
    ref
  ) {
    const { t } = useTranslation()
    const hits: ChipHit[] = [
      ...matchMentions(text, mentions).map((mt) => ({
        start: mt.start,
        end: mt.end,
        token: buildAtToken(mt.mention.ref, mt.mention.displayText)
      })),
      ...matchPasteChips(text, pasteChips ?? []).map((m) => ({
        start: m.start,
        end: m.end,
        token: buildPasteToken({
          payload: m.chip.payload,
          displayText: m.chip.text,
          seq: m.chip.seq,
          name: m.chip.name
        })
      })),
      // 与别的胶囊同一个组件、同一套画法。payload 是一句说明：真值不上屏（悬停卡、点开的弹窗里都没有）
      ...matchSecretChips(text, secretChips ?? []).map((m) => ({
        start: m.start,
        end: m.end,
        token: {
          type: SECRET_TOKEN_TYPE,
          id: m.chip.category,
          displayText: m.chip.text,
          payload: t('input.secretNote'),
          name: t(`redaction.category.${m.chip.category}`, { defaultValue: m.chip.category })
        }
      })),
      ...(hintSpans ?? []).map((h) => ({ start: h.start, end: h.end, kind: 'hint' as const }))
    ].sort((a, b) => a.start - b.start)

    const nodes: React.ReactNode[] = []
    let last = 0
    hits.forEach((h, i) => {
      // 几类命中一般不重叠（占位串不含 @）；重叠了先到的算（胶囊排在提示前面），后面的跳过
      if (h.start < last) return
      if (h.start > last) nodes.push(text.slice(last, h.start))
      // 胶囊显示文字必须逐字等于底层 textarea 文字，否则 accent 字形无法精确压住原字形 → 重影。
      // 故用命中的原始子串覆盖 displayText；dialog 标题/展开正文仍取 token 的 name/payload。
      const raw = text.slice(h.start, h.end)
      if (h.kind === 'hint') {
        // 字仍透明（露出下方 textarea），只画一条虚线
        nodes.push(
          <span
            key={i}
            data-redaction-hint-span=""
            className="underline decoration-dotted decoration-warning decoration-2 underline-offset-[3px]"
          >
            {raw}
          </span>
        )
      } else if (h.token) {
        nodes.push(<TokenChip key={i} token={{ ...h.token, displayText: raw }} inline />)
      }
      last = h.end
    })
    nodes.push(text.slice(last))

    return (
      <div ref={ref} aria-hidden className={className} style={style}>
        {nodes}
        {/* 尾随零宽字符：保证末行/空行也撑出高度，与 textarea 度量一致 */}
        {'​'}
      </div>
    )
  }
)
