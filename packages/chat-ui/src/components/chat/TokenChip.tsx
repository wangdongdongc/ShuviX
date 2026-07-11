import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import type { InlineToken } from '@shuvix/chat-protocol/types/chatMessage'
import { useDialogClose } from '../../hooks/useDialogClose'

/**
 * TokenChip —— 可复用的内联 Token 胶囊（对任意 InlineToken 类型通用：cmd / at / 以及将来新增类型）。
 *
 * 统一样式（accent 文字 + accent/10 底 + 圆角）与统一交互（点击弹出 payload 原文）。三处共用：
 * 用户气泡/子代理消息里的 token 段、输入框斜杠命令芯片、输入框 `@` 文件引用镜像层。
 *
 * `inline` 变体供覆于 textarea 之上的镜像层使用，须「零布局影响」：
 * - 去 `font-mono`、且不加任何内/外边距 → 字符步进与下方 textarea 完全一致，accent 字形逐字精确压在
 *   原字形之上（完全遮住）而非错位重影，光标也对齐；仅靠 accent 文字色 + accent/10 底 + 圆角成胶囊。
 * - `pointer-events-auto` 让胶囊在 pointer-events-none 的镜像根之上可点击。
 */
export function TokenChip({
  token,
  inline = false,
  className = ''
}: {
  token: InlineToken
  /** 内联镜像变体（布局中性、可点击穿透镜像根） */
  inline?: boolean
  className?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)

  const openDialog = (e: React.SyntheticEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    setOpen(true)
  }

  return (
    <>
      <span
        role="button"
        tabIndex={0}
        onClick={openDialog}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') openDialog(e)
        }}
        className={`text-accent bg-accent/10 hover:bg-accent/20 rounded cursor-pointer transition-colors box-decoration-clone ${
          inline ? 'pointer-events-auto' : 'font-mono px-1'
        } ${className}`}
      >
        {token.displayText}
      </span>
      {open &&
        createPortal(
          <TokenPayloadDialog
            title={token.name && token.name !== token.id ? token.name : token.displayText}
            subtitle={token.name && token.name !== token.id ? token.displayText : undefined}
            payload={token.payload}
            onClose={() => setOpen(false)}
          />,
          document.body
        )}
    </>
  )
}

/** Modal —— 直接展示 token 的 payload 原文 */
export function TokenPayloadDialog({
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
