import { memo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { User, Copy, Check, RotateCcw } from 'lucide-react'
import { copyToClipboard } from '../../utils/clipboard'
import type { UserTextMessage } from '../../stores/chatStore'

interface UserBubbleProps {
  msg: UserTextMessage
  onRollback?: () => void
}

/**
 * 用户消息气泡 — 纯文本 + 附图 + source badge
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
          {msg.content}
        </div>
      </div>
    </div>
  )
})
