import { memo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { User, Copy, Check, RotateCcw, ChevronDown, ChevronUp } from 'lucide-react'
import { copyToClipboard } from '../../utils/clipboard'
import type { UserTextMessage } from '../../stores/chatStore'
import { segmentContent, resolveTokensForCopy } from '@shuvix/chat-protocol/utils/inlineTokens'
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

/**
 * 用户消息气泡 — 纯文本 + 内联 Token + 附图 + source badge
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

  return (
    <div className="group relative flex gap-3 pl-10 pr-4 py-3">
      {/* 时间线 */}
      <div className="absolute left-[1.35rem] top-0 bottom-0 w-px bg-border-secondary/40" />
      {/* 头像节点 */}
      <div className="absolute left-2.5 top-3 flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center bg-accent/20 text-accent ring-2 ring-bg-primary z-10">
        <User size={10} />
      </div>

      {/* 内容 */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs font-medium text-text-secondary">{t('message.user')}</span>
          {/* 非 Electron 来源标识 */}
          {msg.metadata?.source && (
            <span className="text-[10px] text-text-tertiary">
              ·{' '}
              <span className="text-text-tertiary/80">
                {msg.metadata.source.type === 'webui'
                  ? `WebUI${msg.metadata.source.ip ? ` (${msg.metadata.source.ip})` : ''}`
                  : msg.metadata.source.type === 'telegram'
                    ? `Telegram${msg.metadata.source.userId ? ` (${msg.metadata.source.userId})` : ''}`
                    : msg.metadata.source.type}
              </span>
            </span>
          )}
          {/* 复制按钮 */}
          {msg.content && (
            <button
              onClick={handleCopy}
              className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-text-tertiary hover:text-text-secondary transition-opacity"
              title={t('message.copy')}
            >
              {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
            </button>
          )}
          {/* 回退 */}
          {onRollback && (
            <button
              onClick={onRollback}
              className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-text-tertiary hover:text-text-secondary transition-opacity"
              title={t('message.rollback')}
            >
              <RotateCcw size={12} />
            </button>
          )}
        </div>

        {/* 图片 */}
        {msg.metadata?.images && msg.metadata.images.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2">
            {msg.metadata.images.map((img, idx) => (
              <img
                key={idx}
                src={img.preview || img.data || ''}
                alt={t('message.attachment', { index: idx + 1 })}
                className="max-w-[240px] max-h-[180px] rounded-lg border border-border-primary object-contain"
              />
            ))}
          </div>
        )}
        <div
          className={collapsed ? 'relative overflow-hidden' : undefined}
          style={collapsed ? { maxHeight: `${COLLAPSED_MAX_HEIGHT}px` } : undefined}
        >
          <div
            className="text-text-primary whitespace-pre-wrap break-all leading-relaxed"
            style={{ fontSize: 'var(--app-font-size, 14px)' }}
          >
            {displaySegments.map((seg, idx) => {
              if (seg.type === 'text') return <span key={idx}>{seg.text}</span>
              if (seg.type === 'token') return <TokenBadge key={idx} segment={seg} />
              return <InvalidTokenBadge key={idx} segment={seg} />
            })}
          </div>
          {/* 折叠态底部渐隐（提示内容被截断） */}
          {collapsed && (
            <div className="absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-bg-primary to-transparent pointer-events-none" />
          )}
        </div>
        {isLong && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="mt-1 flex items-center gap-1 text-xs text-text-tertiary hover:text-text-secondary transition-colors"
          >
            {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            {expanded ? t('message.collapseLines') : t('message.expandLines', { lines: lineCount })}
          </button>
        )}
      </div>
    </div>
  )
})
