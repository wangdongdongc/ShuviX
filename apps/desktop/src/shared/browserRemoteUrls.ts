/**
 * 别的设备（远程访问的网络客户端）能让内置浏览器打开、看到的地址。
 *
 * 内置浏览器对坐在这台电脑前的人什么都能开（地址栏敲 `file:///…` 照 Chrome 打开本地文件），可网络客户端调同一批
 * 通道（`browser-view:create-tab` / `navigate` / 后退前进 / 重开 / `capture`）时，`file:` 页加上截图就是一次
 * 绕过 `files` scope 与 path 点位的本地文件读取 —— 网络策略只按通道判，看不到地址。所以对网络客户端只认三种：
 *
 *  - `http:` / `https:` 网页；
 *  - `about:blank`（空白页）；
 *  - `shuvix://` 内部页面（设置、历史 —— 它们画在浏览器窗口外壳里，tab 本身是一张 about:blank 占位）。
 *
 * 其余一律不认：`file:`、`view-source:`、`data:`、`blob:`、`filesystem:`、`chrome:`、`devtools:`，以及解析不了的串。
 * 纯函数，主进程与渲染端共用（src/shared 是叶子层）。
 */
import { internalPageOf } from './browserInternalPages'

/** 网络客户端能让内置浏览器打开（或截图）这个地址吗 */
export function remoteOpenableUrl(url: unknown): boolean {
  if (typeof url !== 'string') return false
  const text = url.trim()
  if (text === '') return false
  if (internalPageOf(text)) return true
  if (text.toLowerCase() === 'about:blank') return true
  let parsed: URL
  try {
    parsed = new URL(text)
  } catch {
    return false
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:'
}

/** 网络客户端要开的地址不在上面三种里时，处理函数抛的错误码（`ok:false` 的 `code`） */
export const REMOTE_URL_REFUSED_CODE = 'remote_url_refused'

/** 给网络客户端的拒绝（只说协议，不复述整个地址） */
export function remoteUrlRefusedError(url: unknown): Error & { code: string } {
  let scheme = ''
  if (typeof url === 'string') {
    const m = /^([a-z][a-z0-9+.-]*):/i.exec(url.trim())
    if (m) scheme = m[1].toLowerCase()
  }
  const what = scheme ? `${scheme}: addresses` : 'this address'
  const error = new Error(
    `From another device the app browser only opens web pages (http, https), about:blank and shuvix:// pages — not ${what}.`
  ) as Error & { code: string }
  error.code = REMOTE_URL_REFUSED_CODE
  return error
}
