import { useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import type { ContentSegment } from '../../../../shared/utils/inlineTokens'

/** Token badge — 交互式命令标签 + hover 展示 payload */
export function TokenBadge({
  segment,
  popoverDirection = 'down'
}: {
  segment: Extract<ContentSegment, { type: 'token' }>
  /** 悬浮框方向：down（默认，向下）/ up（向上） */
  popoverDirection?: 'up' | 'down'
}): React.JSX.Element {
  const [showPayload, setShowPayload] = useState(false)
  const { token } = segment
  const popoverPos = popoverDirection === 'up' ? 'bottom-full mb-1' : 'top-full mt-1'

  return (
    <span className="relative inline-block">
      <span
        className="font-mono text-accent bg-accent/10 rounded px-1 cursor-help"
        onMouseEnter={() => setShowPayload(true)}
        onMouseLeave={() => setShowPayload(false)}
      >
        {token.displayText}
      </span>
      {showPayload && (
        <div
          className={`absolute left-0 ${popoverPos} z-50 w-[14rem] max-w-[75vw] rounded-lg border border-border-primary bg-bg-secondary shadow-xl p-3 text-xs text-text-secondary whitespace-pre-wrap break-words`}
        >
          {token.name && token.name !== token.id && (
            <div className="text-[10px] text-text-tertiary mb-1">{token.name}</div>
          )}
          <code className="text-[11px] leading-relaxed">
            {token.payload.length > 250 ? token.payload.slice(0, 250) + '…' : token.payload}
          </code>
        </div>
      )}
    </span>
  )
}

/** 无效 Token badge — uid 在 metadata 中找不到 */
export function InvalidTokenBadge({
  segment
}: {
  segment: Extract<ContentSegment, { type: 'invalid_token' }>
}): React.JSX.Element {
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
