import { useState, useRef, useEffect, useCallback } from 'react'

/**
 * 对话框面板高度自动过渡动画
 * 通过 ResizeObserver 监测面板尺寸变化，自动做平滑高度过渡
 * 返回 callback ref，绑定到面板元素即可
 */
export function usePanelTransition(): (node: HTMLDivElement | null) => void {
  const [panel, setPanel] = useState<HTMLDivElement | null>(null)
  const state = useRef({ prevH: 0, animating: false, rafId: 0, timer: 0 })

  useEffect(() => {
    if (!panel) return

    const s = state.current
    s.prevH = panel.offsetHeight

    const finish = (): void => {
      window.clearTimeout(s.timer)
      panel.style.height = ''
      panel.style.overflow = ''
      panel.style.transition = ''
      s.animating = false
      s.prevH = panel.offsetHeight
    }

    const ro = new ResizeObserver(() => {
      if (s.animating) return

      const curH = panel.offsetHeight
      if (Math.abs(curH - s.prevH) < 2) {
        s.prevH = curH
        return
      }

      const fromH = s.prevH
      s.prevH = curH
      s.animating = true

      // ResizeObserver 在 layout 之后、paint 之前触发
      // 立即回退到旧高度，用户看不到跳变
      panel.style.height = `${fromH}px`
      panel.style.overflow = 'hidden'
      panel.style.transition = ''

      cancelAnimationFrame(s.rafId)
      s.rafId = requestAnimationFrame(() => {
        panel.style.transition = 'height 200ms ease-out'
        panel.style.height = `${curH}px`
      })

      panel.addEventListener('transitionend', finish, { once: true })
      // 兜底：防止 transitionend 未触发
      s.timer = window.setTimeout(finish, 260)
    })

    ro.observe(panel)
    return () => {
      ro.disconnect()
      cancelAnimationFrame(s.rafId)
      window.clearTimeout(s.timer)
      finish()
    }
  }, [panel])

  const ref = useCallback((node: HTMLDivElement | null) => {
    setPanel(node)
  }, [])

  return ref
}
