import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * 触屏密度（ChatHost `density: 'touch'`）下的选择面板：从屏幕底部升起的抽屉，挂在 body 上（输入卡片是
 * 悬浮的、有自己的层叠上下文，锚在它上面的弹层会被裁、会出屏 —— 扩展面板就曾经 240px 宽、在 390 宽的手机上
 * 右边被切掉一截）。点遮罩关闭；最高到屏幕的 80%，内容自己滚动；底部留出横条的安全区。
 *
 * 与桌面应用 renderer 里手机外壳的 BottomSheet 同一个外观，但那个画在外壳里（文件 / 任务抽屉），chat-ui 用不到它。
 * `name` 落在 `data-touch-sheet` 上，是 e2e 认这块抽屉的锚点。
 */
export function TouchSheet({
  name,
  onClose,
  title,
  children,
  panelRef
}: {
  name: string
  onClose: () => void
  title?: ReactNode
  children: ReactNode
  /** 面板本体（不含遮罩）—— 调用方的「点在外面就关」要认它 */
  panelRef?: React.Ref<HTMLDivElement>
}): React.JSX.Element {
  return createPortal(
    <div className="fixed inset-0 z-50" data-touch-sheet={name}>
      <div
        className="absolute inset-0 bg-black/40"
        data-touch-sheet-backdrop=""
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="dialog"
        className="touch-sheet absolute inset-x-0 bottom-0 flex max-h-[80%] flex-col rounded-t-2xl border-t border-border-secondary/60 bg-bg-secondary pb-[env(safe-area-inset-bottom)]"
      >
        <div className="flex flex-shrink-0 justify-center pt-2 pb-1">
          <span className="h-1 w-9 rounded-full bg-text-tertiary/40" />
        </div>
        {title && (
          <div className="flex-shrink-0 px-4 pb-2 text-[13px] font-medium text-text-secondary">
            {title}
          </div>
        )}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
      </div>
    </div>,
    document.body
  )
}
