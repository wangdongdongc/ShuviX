import { memo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { User, Copy, Check, RotateCcw, AlertTriangle } from 'lucide-react'
import { copyToClipboard } from '../../utils/clipboard'
import type { UserTextMessage } from '../../stores/chatStore'
import { segmentContent, type ContentSegment } from '../../../../shared/utils/inlineTokens'

interface UserBubbleProps {
  msg: UserTextMessage
  onRollback?: () => void
}

/** Token badge — 交互式命令标签 + hover 展示 payload */
function TokenBadge({ segment }: { segment: Extract<ContentSegment, { type: 'token' }> }): React.JSX.Element {
  const [showPayload, setShowPayload] = useState(false)
  const { token } = segment

  return (
    <span className="relative inline-block">
      <span
        className="font-mono text-accent bg-accent/10 rounded px-1 cursor-help"
        onMouseEnter={() => setShowPayload(true)}
        onMouseLeave={() => setShowPayload(false)}
      >
        {token.displayText}
      </span>
      {/* 悬浮展示 payload */}
      {showPayload && (
        <div className="absolute left-0 top-full mt-1 z-50 w-[14rem] max-w-[75vw] rounded-lg border border-border-primary bg-bg-secondary shadow-xl p-3 text-xs text-text-secondary whitespace-pre-wrap break-words">
          {token.name && token.name !== token.id && (
            <div className="text-[10px] text-text-tertiary mb-1">{token.name}</div>
          )}
          <code className="text-[11px] leading-relaxed">{token.payload.length > 250 ? token.payload.slice(0, 250) + '…' : token.payload}</code>
        </div>
      )}
    </span>
  )
}

/** 无效 Token badge — uid 在 metadata 中找不到 */
function InvalidTokenBadge({ segment }: { segment: Extract<ContentSegment, { type: 'invalid_token' }> }): React.JSX.Element {
  return (
    <span
      className="inline-flex items-center gap-0.5 font-mono text-[12px] text-warning bg-warning/10 rounded px-1 line-through"
      title={`Invalid token: ${segment.uid}`}
    >
      <AlertTriangle size={10} />
      {segment.raw}
    </span>
  )
}

/**
 * 用户消息气泡 — 纯文本 + 内联 Token + 附图 + source badge
 */
export const UserBubble = memo(function UserBubble({
  msg,
  onRollback
}: UserBubbleProps): React.JSX.Element {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)

  const handleCopy = (): void => {
    copyToClipboard(msg.content)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  // 使用 segmentContent 将消息拆分为 text / token / invalid_token 段
  const segments = segmentContent(msg.content, msg.metadata?.inlineTokens)

  return (
    <div className="group flex gap-3 px-4 py-3">
      {/* 头像 */}
      <div className="flex-shrink-0 w-7 h-7 rounded-lg flex items-center justify-center mt-0.5 bg-accent/20 text-accent">
        <User size={14} />
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
        <div className="text-sm text-text-primary whitespace-pre-wrap break-all leading-relaxed">
          {segments.map((seg, idx) => {
            if (seg.type === 'text') return <span key={idx}>{seg.text}</span>
            if (seg.type === 'token') return <TokenBadge key={idx} segment={seg} />
            return <InvalidTokenBadge key={idx} segment={seg} />
          })}
        </div>
      </div>
    </div>
  )
})
