import { useEffect, useRef } from 'react'
import { useDialogClose } from '../../hooks/useDialogClose'

/**
 * 通用确认弹窗（chat-ui 包内版本，无品牌图标）。
 *
 * 注：renderer 另有一份带 ShuviX 吉祥物图标的同名组件供 app 其它处使用；
 * 本包版本保持 brand-free 以便外部项目复用。
 */
export interface ConfirmDialogProps {
  /** 弹窗标题 */
  title: string
  /** 描述内容（支持 ReactNode，可传入富文本） */
  description?: React.ReactNode
  /** 确认按钮文案 */
  confirmText: string
  /** 取消按钮文案 */
  cancelText: string
  /** 确认按钮是否为危险操作样式（红色），默认 true */
  danger?: boolean
  /** 确认回调 */
  onConfirm: () => void
  /** 取消/关闭回调 */
  onCancel: () => void
}

export function ConfirmDialog({
  title,
  description,
  confirmText,
  cancelText,
  danger = true,
  onConfirm,
  onCancel
}: ConfirmDialogProps): React.JSX.Element {
  const overlayRef = useRef<HTMLDivElement>(null)
  const { closing, handleClose } = useDialogClose(onCancel)

  // ESC 关闭
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') handleClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [handleClose])

  // 点击遮罩关闭
  const handleOverlayClick = (e: React.MouseEvent): void => {
    if (e.target === overlayRef.current) handleClose()
  }

  return (
    <div
      ref={overlayRef}
      onClick={handleOverlayClick}
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/40 dialog-overlay${closing ? ' dialog-closing' : ''}`}
    >
      <div className="bg-bg-primary border border-border-primary rounded-xl shadow-xl w-[360px] max-w-[90vw] dialog-panel">
        <div className="flex items-start gap-3 px-5 py-4">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-text-primary mb-1">{title}</h3>
            {description && (
              <div className="text-xs text-text-secondary leading-relaxed">{description}</div>
            )}
          </div>
        </div>
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-border-secondary">
          <button
            onClick={handleClose}
            className="px-4 py-1.5 rounded-lg text-xs text-text-secondary hover:bg-bg-hover transition-colors"
          >
            {cancelText}
          </button>
          <button
            onClick={onConfirm}
            className={`px-4 py-1.5 rounded-lg text-xs text-white transition-colors ${
              danger ? 'bg-error hover:bg-error/90' : 'bg-accent hover:bg-accent-hover'
            }`}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}
