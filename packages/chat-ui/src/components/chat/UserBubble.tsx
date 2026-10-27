import { memo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, Check, RotateCcw, ChevronDown, ChevronUp } from 'lucide-react'
import { copyToClipboard } from '../../utils/clipboard'
import type { UserTextMessage } from '../../stores/chatStore'
import { segmentContent, resolveTokensForCopy } from '@shuvix/chat-protocol/utils/inlineTokens'
import { imageSrc } from '@shuvix/chat-protocol/utils/imageSrc'
import { TokenBadge, InvalidTokenBadge } from './InlineTokenBadge'
import { OriginBadge, originTone } from './OriginBadge'
import { SuggestionOriginTag } from './SuggestionCards'
import { RedactedText } from './RedactedText'
import { useRestoreForCopy } from '../../hooks/useRedaction'
import { useChatDensity } from '../../host/chatHostContext'

interface UserBubbleProps {
  msg: UserTextMessage
  onRollback?: () => void
  /** 乐观占位：正在发送、后端还没落库 —— 压淡一档，落库后换成真实那条时恢复 */
  pending?: boolean
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
 * 不是本机窗口打的（远程、Chrome、别的会话……）气泡换成来源的配色，来源标识与「采纳的提议」标签在气泡右上方
 * （右缘与气泡对齐 —— 放在下方那行时，后面不可见的操作图标还占着位，短消息的标签就歪到了气泡左边）；
 * 操作（复制/回退）在气泡下方一行，桌面悬浮才显形，触屏密度（手机）没有悬浮：点一下气泡出现、再点收起。
 * 超长内容（长粘贴无法覆盖的手打长文/渠道来源/历史消息）默认折叠：截断 + 渐隐 + 展开按钮
 */
export const UserBubble = memo(function UserBubble({
  msg,
  onRollback,
  pending = false
}: UserBubbleProps): React.JSX.Element {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const touch = useChatDensity() === 'touch'
  // 触屏：操作图标点气泡才出（每条消息下面都常驻一排图标太吵）
  const [showActions, setShowActions] = useState(false)
  const restore = useRestoreForCopy()

  const handleCopy = (): void => {
    // 复制还原用户原文：paste token 展开为完整粘贴内容，cmd/at 用人读 displayText；脱敏的占位符换回真值
    copyToClipboard(restore(resolveTokensForCopy(msg.content, msg.metadata?.inlineTokens)))
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

  const origin = msg.metadata?.origin
  const tone = originTone(origin)
  // 右上方那行有没有东西：来源只标非本机的（originTone 认得的种类，同 OriginBadge），提议只标采纳来的
  const fromSuggestion = !!origin && 'suggestion' in origin && !!origin.suggestion
  const hasMeta = !!tone || fromSuggestion
  // 操作图标：桌面常驻占位、悬浮显形（不跳版）；触屏点过气泡才渲染
  const iconCls = touch
    ? 'h-8 w-8 flex items-center justify-center rounded active:bg-bg-hover'
    : 'opacity-0 group-hover:opacity-100 p-0.5 rounded hover:text-text-secondary transition-opacity'
  const iconSize = touch ? 15 : 12
  const actionsShown = !touch || showActions

  return (
    <div
      data-msg-pending={pending || undefined}
      className={`group flex flex-col items-end gap-1 px-4 py-2 transition-opacity ${
        pending ? 'opacity-60' : ''
      }`}
    >
      {/* 这条消息的右上方（附图也在它下面）：来源（本机窗口打的不标）与「采纳的提议」（文字由 agent 写） */}
      {hasMeta && (
        <div data-user-meta="" className="flex max-w-[85%] items-center justify-end gap-1">
          <SuggestionOriginTag origin={origin} />
          {origin && <OriginBadge origin={origin} />}
        </div>
      )}

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
        <div
          data-user-bubble=""
          onClick={touch ? () => setShowActions((v) => !v) : undefined}
          className={`max-w-[85%] rounded-lg text-text-primary px-3 py-1.5 ${tone ? '' : 'bg-accent/10'}`}
          style={tone ? { backgroundColor: tone.tint } : undefined}
          data-origin-tone={origin && tone ? origin.kind : undefined}
        >
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
              if (seg.type === 'text') {
                return (
                  <span key={idx}>
                    <RedactedText text={seg.text} />
                  </span>
                )
              }
              if (seg.type === 'token') return <TokenBadge key={idx} segment={seg} />
              return <InvalidTokenBadge key={idx} segment={seg} />
            })}
          </div>
        </div>
      </div>

      {/* 气泡下方的操作行：展开常驻；图标按钮桌面悬浮才显形（常驻占位，避免布局跳动），触屏点过气泡才有 */}
      <div data-user-actions="" className="flex items-center gap-1 text-text-tertiary">
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
        {/* 复制 */}
        {actionsShown && msg.content && (
          <button
            onClick={handleCopy}
            className={iconCls}
            title={t('message.copy')}
            aria-label={t('message.copy')}
          >
            {copied ? <Check size={iconSize} className="text-success" /> : <Copy size={iconSize} />}
          </button>
        )}
        {/* 回退 */}
        {actionsShown && onRollback && (
          <button
            onClick={onRollback}
            className={iconCls}
            title={t('message.rollback')}
            aria-label={t('message.rollback')}
          >
            <RotateCcw size={iconSize} />
          </button>
        )}
      </div>
    </div>
  )
})
