import { useEffect, useLayoutEffect, useRef, useSyncExternalStore, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { BrowserPopoverFocus } from '../../../../shared/browserPopover'
import {
  openPopoverHost,
  POPOVER_FOCUS_SETTLE_MS,
  readyPopoverHost,
  subscribePopoverHost
} from './browserPopoverHost'

/**
 * 弹层（站点信息气泡、地址栏下拉）：原生页面画在外壳的 DOM 之上，弹层渲染进页面上方的一块透明 view
 * （主进程 services/browser/browserPopover.ts），页面本身一动不动。
 *
 * 那块 view 的文档是外壳 `window.open` 出来的（同进程同源），组件照常是外壳的 React 树，经 portal 进去。
 * 因此组件里的 `window` / `document` 还是外壳的：要碰弹层自己的文档用 `ownerDocument`。
 */

/** 透明 view 比弹层大出来的部分（CSS px）：放阴影（shadow-xl 向下约 40、向两边约 20） */
const SHADOW = { x: 20, top: 4, bottom: 40 }

/**
 * 弹层的外框：把内容渲染进透明 view，并把矩形报给主进程。挂着就是开着，卸载就关。
 * 放在 `anchor` 下方、左边对齐；`width` 不给就和 anchor 一样宽。
 */
export function BrowserPopover({
  anchor,
  width,
  gap,
  focus,
  onDismiss,
  onPressChange,
  children
}: {
  anchor: RefObject<HTMLElement | null>
  width?: number
  /** 与 anchor 下沿的距离（CSS px） */
  gap: number
  focus: BrowserPopoverFocus
  /** 该关了：Esc、点了外面（外壳、页面、透明 view 放阴影的那一圈）、窗口没焦点了。不给就不管这些 */
  onDismiss?: () => void
  /** 鼠标在弹层上按下 / 松开 */
  onPressChange?: (pressed: boolean) => void
  children: React.ReactNode
}): React.JSX.Element | null {
  const current = useSyncExternalStore(subscribePopoverHost, readyPopoverHost)
  const boxRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    openPopoverHost()
  }, [])

  // 尺寸、位置都是量出来的：内容变了（确认按钮、建议多一行）、地址栏变宽了（窗口缩放）都要重报
  useLayoutEffect(() => {
    const box = boxRef.current
    const anchorEl = anchor.current
    if (!current || !box || !anchorEl) return
    const report = (): void => {
      const a = anchorEl.getBoundingClientRect()
      box.style.width = `${width ?? a.width}px`
      window.api.browserView.setPopover({
        bounds: {
          x: Math.round(a.left - SHADOW.x),
          y: Math.round(a.bottom + gap - SHADOW.top),
          width: Math.ceil(box.offsetWidth + SHADOW.x * 2),
          height: Math.ceil(box.offsetHeight + SHADOW.top + SHADOW.bottom)
        },
        focus
      })
    }
    report()
    // 观察弹层里的元素得用它那边的 ResizeObserver：观察者按它所属的文档走生命周期
    const inPopover = new (current.win as Window & typeof globalThis).ResizeObserver(report)
    inPopover.observe(box)
    const inShell = new ResizeObserver(report)
    inShell.observe(anchorEl)
    return () => {
      inPopover.disconnect()
      inShell.disconnect()
      window.api.browserView.setPopover(null)
    }
  }, [current, anchor, width, gap, focus])

  useEffect(() => {
    if (!current) return
    const onDown = (e: MouseEvent): void => {
      if (boxRef.current?.contains(e.target as Node)) onPressChange?.(true)
      else onDismiss?.()
    }
    const onUp = (): void => onPressChange?.(false)
    current.win.addEventListener('mousedown', onDown)
    current.win.addEventListener('mouseup', onUp)
    return () => {
      current.win.removeEventListener('mousedown', onDown)
      current.win.removeEventListener('mouseup', onUp)
      // 按着的时候弹层没了（Esc）：松手再也到不了这里
      onPressChange?.(false)
    }
  }, [current, onDismiss, onPressChange])

  useEffect(() => {
    if (!current || !onDismiss) return
    const popoverDoc = current.win.document
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onDismiss()
    }
    // 点外壳：透明 view 收不到，外壳自己的文档收得到。捕获阶段听，标签的 ✕ 这些按钮会 stopPropagation；
    // 按在 anchor 上不算（锁按下去是切换开关，由它自己处理）
    const onShellDown = (e: MouseEvent): void => {
      if (!anchor.current?.contains(e.target as Node)) onDismiss()
    }
    // 点页面：谁也收不到鼠标，只知道焦点走了。外壳和弹层之间换手不算（打开时焦点从外壳到弹层，点锁时反过来）
    let settle: ReturnType<typeof setTimeout> | undefined
    const onBlur = (): void => {
      clearTimeout(settle)
      settle = setTimeout(() => {
        if (!document.hasFocus() && !popoverDoc.hasFocus()) onDismiss()
      }, POPOVER_FOCUS_SETTLE_MS)
    }
    document.addEventListener('keydown', onKey)
    popoverDoc.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onShellDown, true)
    window.addEventListener('blur', onBlur)
    current.win.addEventListener('blur', onBlur)
    return () => {
      clearTimeout(settle)
      document.removeEventListener('keydown', onKey)
      popoverDoc.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onShellDown, true)
      window.removeEventListener('blur', onBlur)
      current.win.removeEventListener('blur', onBlur)
    }
  }, [current, anchor, onDismiss])

  if (!current) return null
  return createPortal(
    <div ref={boxRef} className="absolute" style={{ left: SHADOW.x, top: SHADOW.top }}>
      {children}
    </div>,
    current.root
  )
}
