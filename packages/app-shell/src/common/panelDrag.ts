/**
 * startPanelDrag —— 面板分隔条的拖拽手势（右侧面板、会话面板、左侧栏、底部终端共用）。
 *
 * 拖动期间在整个窗口上盖一层透明遮罩（`[data-panel-drag-overlay]`，最顶层，带拖拽光标），指针下面就只有它：
 * 从前各分隔条只在 document 上听 mousemove / mouseup，指针一进 iframe（右侧面板里的小组件、对话里的
 * ```interactive 块、预览）事件就归了 iframe —— 往那边拖一卡一卡的，在 iframe 上松开的 mouseup 也收不到，
 * 分隔条松手后还粘着指针走。逐个给 iframe 设 `pointer-events: none` 也行，但漏掉拖动中才出现的 iframe，
 * 还要记得逐个还原；一层遮罩没有这些问题。
 *
 * 结束恰好一次：mouseup、一次 mousemove 发现左键已经松开（mouseup 万一还是丢了）、窗口失焦。
 * 只有左键开始拖动。
 */

export interface PanelDragOptions {
  /** `x` = 左右拖（col-resize），`y` = 上下拖（row-resize） */
  axis: 'x' | 'y'
  /** 指针相对按下那一点移动了多少 px（x 向右为正，y 向下为正） */
  onMove: (delta: number) => void
  /** 拖动结束（恰好一次） */
  onEnd?: () => void
}

/** 鼠标按下事件里用到的那几项（React 的合成事件与原生 MouseEvent 都满足） */
interface PanelDragStart {
  clientX: number
  clientY: number
  button: number
  preventDefault(): void
}

/**
 * 在分隔条的 mousedown 里调用。交回一个结束函数（卸载时可调，已结束则什么也不做）；
 * 不是左键时不开始，交回的函数什么也不做，`onEnd` 也不会被调。
 */
export function startPanelDrag(e: PanelDragStart, options: PanelDragOptions): () => void {
  if (e.button !== 0) return () => {}
  e.preventDefault()
  const { axis, onMove, onEnd } = options
  const start = axis === 'x' ? e.clientX : e.clientY
  const cursor = axis === 'x' ? 'col-resize' : 'row-resize'

  const overlay = document.createElement('div')
  overlay.setAttribute('data-panel-drag-overlay', axis)
  overlay.style.cssText = `position:fixed;inset:0;z-index:2147483647;cursor:${cursor};background:transparent;`
  document.body.appendChild(overlay)

  const body = document.body.style
  const prevCursor = body.cursor
  const prevUserSelect = body.userSelect
  body.cursor = cursor
  body.userSelect = 'none'

  let ended = false
  const end = (): void => {
    if (ended) return
    ended = true
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', end)
    window.removeEventListener('blur', end)
    overlay.remove()
    body.cursor = prevCursor
    body.userSelect = prevUserSelect
    onEnd?.()
  }
  const move = (ev: MouseEvent): void => {
    // 左键已经不在按着：松开的那一下没送到这里，就当它刚刚松开
    if ((ev.buttons & 1) === 0) {
      end()
      return
    }
    onMove((axis === 'x' ? ev.clientX : ev.clientY) - start)
  }
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', end)
  window.addEventListener('blur', end)
  return end
}
