import { useState, useCallback } from 'react'

const ANIMATION_DURATION = 120

/**
 * 弹窗关闭动效 hook — 触发关闭时先播放退出动画，动画结束后再执行真正的卸载回调
 * 返回 closing 状态（用于切换 CSS class）和 handleClose 替代直接 onClose
 */
export function useDialogClose(onClose: () => void): {
  closing: boolean
  handleClose: () => void
} {
  const [closing, setClosing] = useState(false)

  const handleClose = useCallback(() => {
    if (closing) return
    setClosing(true)
    setTimeout(onClose, ANIMATION_DURATION)
  }, [onClose, closing])

  return { closing, handleClose }
}
