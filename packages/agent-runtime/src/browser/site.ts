/**
 * 「站点」的写法 —— 按站点过门时的记账键，server 与宿主（Chrome 的授权记录）共用这一份。
 *
 * 站点 = 网页（http / https）的 host：小写、去掉结尾的点，与 url 客体（`urlObjectOf`）同一种写法；
 * 协议与端口不算（`http://a.com:8080` 与 `https://a.com` 是同一个站点 —— 登录态按 host 走）。
 *
 * 几种「看上去不是网页、其实是某个站点」的地址按它里面那个站点算，否则一个站点门就能被绕开：
 *  - `blob:https://x/…`：同源文档，带着 x 的登录态 —— 属于创建它的那个源（`URL.origin`）；
 *  - `view-source:https://x/…`：带着 x 的登录态读出来的源码；
 *  - `filesystem:https://x/…`：x 的沙箱文件系统。
 *
 * 其余地址（about:blank、data:、chrome://、扩展页、file:）没有站点，回 undefined —— 站点门不管它们
 * （本地文件另有路径门）。
 */
const WRAPPER_PREFIXES = ['view-source:', 'filesystem:'] as const

export function browserSiteOf(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  let text = raw.trim()
  for (;;) {
    const lower = text.slice(0, 16).toLowerCase()
    const prefix = WRAPPER_PREFIXES.find((p) => lower.startsWith(p))
    if (!prefix) break
    text = text.slice(prefix.length)
  }
  let parsed: URL
  try {
    parsed = new URL(text)
  } catch {
    return undefined
  }
  if (parsed.protocol === 'blob:') {
    if (parsed.origin === 'null') return undefined
    try {
      parsed = new URL(parsed.origin)
    } catch {
      return undefined
    }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
  const host = parsed.hostname.toLowerCase().replace(/\.+$/, '')
  return host || undefined
}
