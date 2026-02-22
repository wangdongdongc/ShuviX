import { useEffect, useRef } from 'react'
import appIcon from '../assets/ngnl_xiubi_color_mini.jpg'

/**
 * 通用确认弹窗 — 带自定义图标、标题、描述、确认/取消按钮
 * 可复用于所有需要用户确认的操作
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

  // ESC 关闭
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onCancel])

  // 点击遮罩关闭
  const handleOverlayClick = (e: React.MouseEvent): void => {
    if (e.target === overlayRef.current) onCancel()
  }

  return (
    <div
      ref={overlayRef}
      onClick={handleOverlayClick}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
    >
      <div className="bg-bg-primary border border-border-primary rounded-xl shadow-xl w-[360px] max-w-[90vw] animate-in fade-in zoom-in-95 duration-150">
        <div className="flex items-start gap-3 px-5 py-4">
          <img
            src={appIcon}
            alt="icon"
            className="w-10 h-10 rounded-lg flex-shrink-0 mt-0.5"
          />
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-text-primary mb-1">{title}</h3>
            {description && (
              <div className="text-xs text-text-secondary leading-relaxed">{description}</div>
            )}
          </div>
        </div>
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-border-secondary">
          <button
            onClick={onCancel}
            className="px-4 py-1.5 rounded-lg text-xs text-text-secondary hover:bg-bg-hover transition-colors"
          >
            {cancelText}
          </button>
          <button
            onClick={onConfirm}
            className={`px-4 py-1.5 rounded-lg text-xs text-white transition-colors ${
              danger
                ? 'bg-error hover:bg-error/90'
                : 'bg-accent hover:bg-accent-hover'
            }`}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}
