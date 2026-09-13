import { memo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, Check, RotateCcw, ChevronDown, ChevronUp } from 'lucide-react'
import { copyToClipboard } from '../../utils/clipboard'
import type { UserTextMessage } from '../../stores/chatStore'
import { segmentContent, resolveTokensForCopy } from '@shuvix/chat-protocol/utils/inlineTokens'
import { imageSrc } from '@shuvix/chat-protocol/utils/imageSrc'
import { TokenBadge, InvalidTokenBadge } from './InlineTokenBadge'

interface UserBubbleProps {
  msg: UserTextMessage
  onRollback?: () => void
}

/** 超过任一阈值即默认折叠（行数 / 字符数，字符兜底捕捉无换行长段落） */
const COLLAPSE_LINE_THRESHOLD = 15
const COLLAPSE_CHAR_THRESHOLD = 1200
/** 折叠态内容最大高度（px），需明显小于阈值行数渲染高度避免「差一点」的折叠 */
const COLLAPSED_MAX_HEIGHT = 300
/** 折叠态底部渐隐高度（px） */
const COLLAPSE_FADE_HEIGHT = 40

/**
 * 用户消息气泡 — 右对齐浅色气泡（与子智能体面板转写同形）：纯文本 + 内联 Token + 附图，
 * 操作（复制/回退）与来源标识收在气泡下方一行
 * 超长内容（长粘贴无法覆盖的手打长文/渠道来源/历史消息）默认折叠：截断 + 渐隐 + 展开按钮
 */
export const UserBubble = memo(function UserBubble({
  msg,
  onRollback
}: UserBubbleProps): React.JSX.Element {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const [expanded, setExpanded] = useState(false)

  const handleCopy = (): void => {
    // 复制还原用户原文：paste token 展开为完整粘贴内容，cmd/at 用人读 displayText
    copyToClipboard(resolveTokensForCopy(msg.content, msg.metadata?.inlineTokens))
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  // 使用 segmentContent 将消息拆分为 text / token / invalid_token 段
  const segments = segmentContent(msg.content, msg.metadata?.inlineTokens)

  const lineCount = msg.content.split('\n').length
  const isLong = lineCount > COLLAPSE_LINE_THRESHOLD || msg.content.length > COLLAPSE_CHAR_THRESHOLD
  const collapsed = isLong && !expanded
  // 折叠态把 3+ 连续换行压成 2（仅影响显示，展开/复制/发送均为原文）
  const displaySegments = collapsed
    ? segments.map((seg) =>
        seg.type === 'text' ? { ...seg, text: seg.text.replace(/\n{3,}/g, '\n\n') } : seg
      )
    : segments

  // 折叠渐隐用遮罩而非叠加渐变层：气泡有自己的底色，叠 bg-primary 渐变会露馅
  const fadeMask = `linear-gradient(to bottom, #000 calc(100% - ${COLLAPSE_FADE_HEIGHT}px), transparent)`

  const source = msg.metadata?.source

  return (
    <div className="group flex flex-col items-end gap-1 px-4 py-2">
      {/* 图片 */}
      {msg.metadata?.images && msg.metadata.images.length > 0 && (
        <div className="flex flex-wrap justify-end gap-2">
          {msg.metadata.images.map((img, idx) => (
            <img
              key={idx}
              src={imageSrc(img)}
              alt={t('message.attachment', { index: idx + 1 })}
              className="max-w-[240px] max-h-[180px] rounded-lg border border-border-primary object-contain"
            />
          ))}
        </div>
      )}

      {/* 气泡 */}
      <div className="flex w-full justify-end">
        <div className="max-w-[85%] rounded-lg bg-accent/10 text-text-primary px-3 py-1.5">
          <div
            className="whitespace-pre-wrap break-words leading-relaxed"
            style={{
              fontSize: 'var(--app-font-size, 14px)',
              ...(collapsed
                ? {
                    maxHeight: `${COLLAPSED_MAX_HEIGHT}px`,
                    overflow: 'hidden',
                    maskImage: fadeMask,
                    WebkitMaskImage: fadeMask
                  }
                : {})
            }}
          >
            {displaySegments.map((seg, idx) => {
              if (seg.type === 'text') return <span key={idx}>{seg.text}</span>
              if (seg.type === 'token') return <TokenBadge key={idx} segment={seg} />
              return <InvalidTokenBadge key={idx} segment={seg} />
            })}
          </div>
        </div>
      </div>

      {/* 气泡下方的操作行：展开/来源常驻，图标按钮悬浮才显形（常驻占位，避免布局跳动） */}
      <div className="flex items-center gap-1 text-text-tertiary">
        {isLong && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="mr-1 flex items-center gap-1 text-xs hover:text-text-secondary transition-colors"
          >
            {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            {expanded ? t('message.collapseLines') : t('message.expandLines', { lines: lineCount })}
          </button>
        )}
        {/* 非 Electron 来源标识 */}
        {source && (
          <span className="mr-1 text-[10px]">
            {source.type === 'webui'
              ? `WebUI${source.ip ? ` (${source.ip})` : ''}`
              : source.type === 'telegram'
                ? `Telegram${source.userId ? ` (${source.userId})` : ''}`
                : source.type}
          </span>
        )}
        {/* 复制 */}
        {msg.content && (
          <button
            onClick={handleCopy}
            className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:text-text-secondary transition-opacity"
            title={t('message.copy')}
          >
            {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
          </button>
        )}
        {/* 回退 */}
        {onRollback && (
          <button
            onClick={onRollback}
            className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:text-text-secondary transition-opacity"
            title={t('message.rollback')}
          >
            <RotateCcw size={12} />
          </button>
        )}
      </div>
    </div>
  )
})
