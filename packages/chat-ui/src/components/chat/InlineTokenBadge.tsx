import { AlertTriangle } from 'lucide-react'
import type { ContentSegment } from '@shuvix/chat-protocol/utils/inlineTokens'
import { TokenChip } from './TokenChip'

/** Token badge —— 消息/子代理里的 token 段，复用 TokenChip（点击展示 payload 原文） */
export function TokenBadge({
  segment
}: {
  segment: Extract<ContentSegment, { type: 'token' }>
}): React.JSX.Element {
  return <TokenChip token={segment.token} />
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
