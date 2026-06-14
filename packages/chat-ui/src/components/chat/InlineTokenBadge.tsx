import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, X } from 'lucide-react'
import type { ContentSegment } from '@shuvix/chat-protocol/utils/inlineTokens'
import { useDialogClose } from '../../hooks/useDialogClose'

/** Token badge — 交互式命令标签。点击打开 Modal，展示 payload 原文 */
export function TokenBadge({
  segment
}: {
  segment: Extract<ContentSegment, { type: 'token' }>
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const { token } = segment

  return (
    <>
      <span
        role="button"
        tabIndex={0}
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setOpen(true)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            e.stopPropagation()
            setOpen(true)
          }
        }}
        className="font-mono text-accent bg-accent/10 hover:bg-accent/20 rounded px-1 cursor-pointer transition-colors"
      >
        {token.displayText}
      </span>
      {open && (
        <TokenPayloadDialog
          title={token.name && token.name !== token.id ? token.name : token.displayText}
          subtitle={token.name && token.name !== token.id ? token.displayText : undefined}
          payload={token.payload}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

/** Modal —— 直接展示 payload 原文 */
function TokenPayloadDialog({
  title,
  subtitle,
  payload,
  onClose
}: {
  title: string
  subtitle?: string
  payload: string
  onClose: () => void
}): React.JSX.Element {
  const overlayRef = useRef<HTMLDivElement>(null)
  const { closing, handleClose } = useDialogClose(onClose)

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') handleClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [handleClose])

  const handleOverlayClick = (e: React.MouseEvent): void => {
    if (e.target === overlayRef.current) handleClose()
  }

  return (
    <div
      ref={overlayRef}
      onClick={handleOverlayClick}
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/40 dialog-overlay${closing ? ' dialog-closing' : ''}`}
    >
      <div className="bg-bg-primary border border-border-primary rounded-xl shadow-xl w-[640px] max-w-[92vw] max-h-[82vh] flex flex-col dialog-panel">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-border-secondary">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-text-primary truncate">{title}</h3>
            {subtitle && (
              <div className="text-[11px] font-mono text-text-tertiary mt-0.5 truncate">
                {subtitle}
              </div>
            )}
          </div>
          <button
            onClick={handleClose}
            className="flex-shrink-0 p-1 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors"
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </div>

        {/* Body —— 原文 */}
        <div className="flex-1 overflow-y-auto px-4 py-3 min-w-0">
          <pre className="text-xs whitespace-pre-wrap break-words leading-relaxed font-mono text-text-secondary">
            {payload}
          </pre>
        </div>
      </div>
    </div>
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
