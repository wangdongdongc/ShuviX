import { forwardRef } from 'react'
import {
  buildAtToken,
  buildBotToken,
  buildPasteToken
} from '@shuvix/chat-protocol/utils/inlineTokens'
import type { InlineToken } from '@shuvix/chat-protocol/types/chatMessage'
import { matchMentions, type AtMention } from '../../hooks/useAtMentions'
import { matchPasteChips, type PasteChip } from '../../hooks/usePasteChips'
import { TokenChip } from './TokenChip'

interface MentionHighlighterProps {
  /** 与 textarea 同步的明文 */
  text: string
  /** 已登记的 @ 引用 */
  mentions: AtMention[]
  /** 已登记的粘贴芯片 */
  pasteChips?: PasteChip[]
  /** 与 textarea 完全一致的字体/内边距/换行类（保证逐字对齐） */
  className: string
  /** 与 textarea 一致的 minHeight / textIndent 等内联样式 */
  style?: React.CSSProperties
}

/** 一处需画胶囊的命中区间（@ 引用 / 粘贴占位统一形态） */
interface ChipHit {
  start: number
  end: number
  token: InlineToken
}

/**
 * 输入框镜像层 —— 逐字复刻输入内容、覆于 textarea 之上（本层 pointer-events-none）。
 * 非胶囊文字透明（露出下方 textarea 的原生字形/光标/选区）；每处 @ 引用 / 粘贴占位渲染为
 * <TokenChip inline>—— 与斜杠命令芯片同款胶囊（accent 文字 + accent/10 底 + 圆角 + 点击弹 payload）。
 * 因镜像与 textarea 同字体同位置，胶囊 accent 字形恰压在下方原字形上；`inline` 变体布局中性故光标仍对齐。
 * 滚动由父组件把本层 scrollTop 同步为 textarea.scrollTop。
 */
export const MentionHighlighter = forwardRef<HTMLDivElement, MentionHighlighterProps>(
  function MentionHighlighter({ text, mentions, pasteChips, className, style }, ref) {
    const hits: ChipHit[] = [
      ...matchMentions(text, mentions).map((mt) => ({
        start: mt.start,
        end: mt.end,
        // bot 提及走 bot token：点开胶囊显示的是 `@显示名` 而不是文件话术
        token:
          mt.mention.kind === 'bot'
            ? buildBotToken({
                name: mt.mention.botName ?? mt.mention.base,
                displayName: mt.mention.base
              })
            : buildAtToken(mt.mention)
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
      }))
    ].sort((a, b) => a.start - b.start)

    const nodes: React.ReactNode[] = []
    let last = 0
    hits.forEach((h, i) => {
      // 两类命中理论上不重叠（占位串不含 @、引用明文不含括号占位），防御性跳过越界项
      if (h.start < last) return
      if (h.start > last) nodes.push(text.slice(last, h.start))
      // 胶囊显示文字必须逐字等于底层 textarea 文字，否则 accent 字形无法精确压住原字形 → 重影。
      // 故用命中的原始子串覆盖 displayText；dialog 标题/展开正文仍取 token 的 name/payload。
      const raw = text.slice(h.start, h.end)
      nodes.push(<TokenChip key={i} token={{ ...h.token, displayText: raw }} inline />)
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
