/**
 * 浏览器窗口的弹层（站点信息气泡、地址栏下拉）住的透明 view。
 *
 * 原生页面画在外壳的 DOM 之上，DOM 弹层会被它盖住。早先的做法是弹层开着时把页面区换成截图、把原生 view 挪去停放窗口：
 * 换的那一瞬间整个页面区是空的（录屏逐帧看，点一下锁开和关各黑 10~30ms），页面还被改成停放尺寸重排两次，
 * 开着的时候视频也不动了。现在页面一动不动，弹层画在它上面的一块透明 view 里，和 Chrome 的气泡一样。
 *
 * view 用外壳自己 `window.open` 出来的 webContents（about:blank、同进程同源、外壳同步摸得到它的 document）：
 * 弹层的 React 组件还是外壳的，经 portal 渲染进去 —— 状态、i18n、`window.api` 都不用再搭一份，发 IPC 的也还是外壳。
 * 那份文档里除了外壳放进去的东西什么都没有，也不许它导航、开窗。
 *
 * 不用的时候尺寸为 0（不 setVisible(false)：这个目录里 view 一律不隐藏，见 noDisturbGuard.test.ts；隐藏再显示还会先露出上次的旧帧）。
 *
 * 只由用户在浏览器窗口里的动作打开，agent 碰不到它；键盘焦点只在窗口已经在前台时才挪（browserWindowInFront）。
 */
import { WebContentsView, type BrowserWindow, type WebContents } from 'electron'
import { browserWindowInFront, installShortcuts } from './browserViewService'
import { scaledRect } from './layoutAnchors'
import {
  BROWSER_POPOVER_FRAME,
  type BrowserPopoverFocus,
  type BrowserPopoverPlacement
} from '../../../shared/browserPopover'

const HIDDEN = { x: 0, y: 0, width: 0, height: 0 }

let popover: { view: WebContentsView; host: BrowserWindow } | null = null
/** 弹层现在的焦点约定；null = 没开着 */
let shownFocus: BrowserPopoverFocus | null = null

function liveWebContents(view: WebContentsView): WebContents | null {
  // webContents 没了之后这个属性是 undefined（类型上说它一直在）
  const wc = view.webContents as WebContents | undefined
  return wc && !wc.isDestroyed() ? wc : null
}

/**
 * 外壳 `window.open` 的处理：名字对得上才建，其余回 null（走窗口原有的守卫）。
 * 传给 guardAppWindow 的 `allowOpen`。
 */
export function popoverWindowOpen(
  host: BrowserWindow
): (details: Electron.HandlerDetails) => Electron.WindowOpenHandlerResponse | null {
  return ({ url, frameName }) => {
    if (url !== 'about:blank' || frameName !== BROWSER_POPOVER_FRAME) return null
    return {
      action: 'allow',
      createWindow: (options) => {
        destroyBrowserPopover()
        // options 实际带着 Electron 为这次 window.open 建好的 webContents（类型里没写）
        const { webContents } = options as { webContents: WebContents }
        const view = new WebContentsView({ webContents })
        view.setBackgroundColor('#00000000')
        view.setBounds(HIDDEN)
        const wc = view.webContents
        wc.setWindowOpenHandler(() => ({ action: 'deny' }))
        wc.on('will-navigate', (event) => event.preventDefault())
        // 气泡拿着焦点时 ⌘W、⌘L 这些照样是浏览器的
        installShortcuts(wc)
        // 按在地址栏下拉上，系统会把焦点给这块 view：还给外壳，字接着打
        wc.on('focus', () => {
          if (shownFocus === 'keep-shell') focusPopoverInFront(host.webContents)
        })
        host.contentView.addChildView(view)
        popover = { view, host }
        return wc
      }
    }
  }
}

function focusPopoverInFront(target: WebContents): void {
  if (!browserWindowInFront()) return
  target.focus()
}

/** 外壳开 / 关 / 挪弹层（矩形是 CSS px；null = 关） */
export function setBrowserPopover(placement: BrowserPopoverPlacement | null): void {
  const wc = popover && liveWebContents(popover.view)
  if (!popover || !wc) return
  const { view, host } = popover
  if (!placement) {
    const hadFocus = wc.isFocused()
    shownFocus = null
    view.setBounds(HIDDEN)
    // 弹层自己关的（Esc、✕）焦点还在这块 0 尺寸的 view 上：还给外壳。点页面关的那种焦点已经在页面上了，不动
    if (hadFocus) focusPopoverInFront(host.webContents)
    return
  }
  const zoom = host.webContents.getZoomFactor()
  if (Math.abs(wc.getZoomFactor() - zoom) > 0.001) wc.setZoomFactor(zoom)
  const opening = shownFocus === null
  shownFocus = placement.focus
  if (opening) host.contentView.addChildView(view)
  view.setBounds(scaledRect(placement.bounds, zoom))
  if (opening && placement.focus === 'take') focusPopoverInFront(wc)
}

/** 有 view 刚挂到窗口上（会盖在最上面）：弹层开着就把它再提上来 */
export function raiseBrowserPopover(): void {
  if (popover && shownFocus && liveWebContents(popover.view)) {
    popover.host.contentView.addChildView(popover.view)
  }
}

/** 浏览器窗口没了：弹层跟着收掉 */
export function destroyBrowserPopover(): void {
  const current = popover
  popover = null
  shownFocus = null
  if (!current) return
  const wc = liveWebContents(current.view)
  if (!current.host.isDestroyed()) current.host.contentView.removeChildView(current.view)
  if (wc) wc.close()
}
