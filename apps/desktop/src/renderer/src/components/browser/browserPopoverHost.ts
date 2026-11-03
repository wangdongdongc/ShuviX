import { BROWSER_POPOVER_FRAME } from '../../../../shared/browserPopover'

/**
 * 弹层住的那份文档：外壳 `window.open` 出来、主进程挂成页面上方一块透明 view（services/browser/browserPopover.ts）。
 * 同进程同源，外壳同步摸得到它的 document；样式表和 <html> 上的主题从外壳抄过去。整个外壳就这一份。
 */

/** 焦点在外壳和弹层之间换手时，一边的 blur 和另一边的 focus 不是同时到的：等这么久再看焦点落在哪 */
export const POPOVER_FOCUS_SETTLE_MS = 60

export interface PopoverHost {
  win: Window
  root: HTMLElement
}

let host: PopoverHost | null = null
let hostReady = false
const listeners = new Set<() => void>()

function notify(): void {
  for (const l of listeners) l()
}

/** 外壳的样式表抄一份过去（link 要绝对地址，about:blank 自己没有基准）；回等它们加载完的 Promise */
function mirrorStyles(doc: Document, mirrored: Set<Node>): Promise<unknown> {
  const loads: Array<Promise<unknown>> = []
  for (const node of document.head.querySelectorAll('link[rel="stylesheet"], style')) {
    if (mirrored.has(node)) continue
    mirrored.add(node)
    const copy = doc.importNode(node, true) as HTMLElement
    if (node instanceof HTMLLinkElement) {
      const link = copy as HTMLLinkElement
      link.href = node.href
      loads.push(
        new Promise((resolve) => {
          link.onload = resolve
          link.onerror = resolve
        })
      )
    }
    doc.head.appendChild(copy)
  }
  return Promise.all(loads)
}

/** 主题、字号都挂在外壳的 <html> 上（data-theme、--app-font-size），弹层的 <html> 跟着 */
function mirrorRoot(doc: Document): void {
  const from = document.documentElement
  const to = doc.documentElement
  for (const name of from.getAttributeNames()) {
    to.setAttribute(name, from.getAttribute(name) ?? '')
  }
}

export function openPopoverHost(): PopoverHost | null {
  if (host && !host.win.closed) return host
  hostReady = false
  let win: Window | null = null
  try {
    win = window.open('', BROWSER_POPOVER_FRAME)
  } catch {
    win = null
  }
  if (!win) {
    console.warn('browser popover: window.open returned nothing')
    host = null
    return null
  }
  const doc = win.document
  // 外壳刷新过（开发环境）：同名的窗口还是原来那个，里面是上一次的东西
  doc.head.replaceChildren()
  doc.body.replaceChildren()
  const base = doc.createElement('style')
  base.textContent = 'html,body{background:transparent!important;margin:0;overflow:hidden}'
  const mirrored = new Set<Node>()
  const ready = mirrorStyles(doc, mirrored)
  // main.css 之后才放，压得过它给 body 的背景
  doc.head.appendChild(base)
  mirrorRoot(doc)
  const opened: PopoverHost = { win, root: doc.body }
  host = opened
  // 懒加载的 chunk 带来的样式表（开发环境里 Vite 改写已有的 <style> 跟不上，刷新窗口才有）
  new MutationObserver(() => {
    void mirrorStyles(doc, mirrored)
    doc.head.appendChild(base)
  }).observe(document.head, { childList: true })
  new MutationObserver(() => mirrorRoot(doc)).observe(document.documentElement, {
    attributes: true
  })
  void ready.then(() => {
    if (host !== opened) return
    hostReady = true
    notify()
  })
  return opened
}

/** 提前把透明 view 备好（外壳起来后调一次）：第一次点锁、第一次敲字就不用现等 */
export function warmBrowserPopover(): void {
  openPopoverHost()
}

export function subscribePopoverHost(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function readyPopoverHost(): PopoverHost | null {
  return hostReady ? host : null
}
