/**
 * 手机布局的底部抽屉：桌面上浮在对话旁边的卡片（文件 / 任务）、新建会话的选择，在手机上都从底部升起。
 * 点遮罩关闭；高度随内容，最高到屏幕的 85%（内容自己滚动）；底部留出横条的安全区。
 */
import type { ReactNode } from 'react'

export function BottomSheet({
  open,
  onClose,
  title,
  children,
  tall = false
}: {
  open: boolean
  onClose: () => void
  title?: ReactNode
  children: ReactNode
  /** 撑到最高（文件树、任务列表这类可能很长的内容） */
  tall?: boolean
}): React.JSX.Element | null {
  if (!open) return null
  return (
    <div className="absolute inset-0 z-40" data-bottom-sheet="">
      <div
        className="absolute inset-0 bg-black/40"
        data-bottom-sheet-backdrop=""
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        role="dialog"
        className={`absolute inset-x-0 bottom-0 flex flex-col rounded-t-2xl bg-bg-secondary border-t border-border-secondary/60 pb-[env(safe-area-inset-bottom)] ${
          tall ? 'h-[85%]' : 'max-h-[85%]'
        }`}
        style={{ animation: 'mobile-sheet-in 220ms cubic-bezier(0.32, 0.72, 0, 1)' }}
      >
        <div className="flex justify-center pt-2 pb-1 flex-shrink-0">
          <span className="w-9 h-1 rounded-full bg-text-tertiary/40" />
        </div>
        {title && (
          <div className="px-4 pb-2 text-[13px] font-medium text-text-secondary flex-shrink-0">
            {title}
          </div>
        )}
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">{children}</div>
      </div>
    </div>
  )
}
