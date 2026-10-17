/**
 * 手机布局里「长按 = 右键」：侧栏行、主屏图标、知识库条目……的菜单都挂在 contextmenu 上（桌面是右键），手机
 * 没有右键。这里在触摸按住不动约半秒时，往按住的元素上派发一次 contextmenu（带按住的坐标）—— React 的
 * onContextMenu 照常收到，组件一行不改。
 *
 * - Android 的 Chrome 自己也会在长按时发一次 contextmenu：我们的先到就吞掉它的（免得弹两次），它的先到就取消
 *   我们的；
 * - 长按之后松手那一下 click 吞掉，不让它把行「点开」；
 * - 手指挪动超过 10px（在滚动 / 翻页）就不算长按。
 */
const HOLD_MS = 500
const SLOP_PX = 10
/** 长按松手后，多久之内的那一下 click 算是它带出来的 */
const CLICK_GRACE_MS = 600

export function installLongPressContextMenu(root: Document | HTMLElement = document): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let start: { x: number; y: number; target: EventTarget } | null = null
  /** 这一次触摸已经派发过（长按成立） */
  let fired = false

  const clear = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
  }

  const onTouchStart = (e: Event): void => {
    const touch = (e as TouchEvent).touches
    clear()
    fired = false
    if (touch.length !== 1 || !e.target) {
      start = null
      return
    }
    start = { x: touch[0].clientX, y: touch[0].clientY, target: e.target }
    timer = setTimeout(() => {
      timer = null
      if (!start) return
      fired = true
      start.target.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: start.x,
          clientY: start.y,
          view: window
        })
      )
    }, HOLD_MS)
  }

  const onTouchMove = (e: Event): void => {
    const touch = (e as TouchEvent).touches[0]
    if (!start || !touch) return
    if (Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > SLOP_PX) {
      clear()
      start = null
    }
  }

  const onTouchEnd = (): void => {
    clear()
    start = null
    // 长按之后手机通常不再发 click：别让这个标记留着，吞掉之后某个与之无关的 click（键盘、鼠标、el.click()）
    if (fired) setTimeout(() => (fired = false), CLICK_GRACE_MS)
  }

  const onNativeContextMenu = (e: Event): void => {
    if (!e.isTrusted) return // 我们自己派发的那一次
    if (fired) {
      e.preventDefault()
      e.stopPropagation()
      return
    }
    clear() // 浏览器自己的先到：交给它
  }

  const onClick = (e: Event): void => {
    if (!fired) return
    fired = false
    e.preventDefault()
    e.stopPropagation()
  }

  root.addEventListener('touchstart', onTouchStart, { passive: true })
  root.addEventListener('touchmove', onTouchMove, { passive: true })
  root.addEventListener('touchend', onTouchEnd)
  root.addEventListener('touchcancel', onTouchEnd)
  root.addEventListener('contextmenu', onNativeContextMenu, true)
  root.addEventListener('click', onClick, true)
  return () => {
    clear()
    root.removeEventListener('touchstart', onTouchStart)
    root.removeEventListener('touchmove', onTouchMove)
    root.removeEventListener('touchend', onTouchEnd)
    root.removeEventListener('touchcancel', onTouchEnd)
    root.removeEventListener('contextmenu', onNativeContextMenu, true)
    root.removeEventListener('click', onClick, true)
  }
}
