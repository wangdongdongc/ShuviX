/**
 * 地址栏（omnibox）的纯函数：输入 → 要打开的地址，地址 → 未聚焦时的显示。
 * 单独成文件（不放组件文件里）是因为组件文件只能导出组件，否则 fast refresh 失效。
 */

/** 地址栏不是网址时用的搜索引擎（设置 → MCP → 内置浏览器那一行里可改） */
export type SearchEngineId = 'google' | 'bing' | 'baidu' | 'duckduckgo'

export const SEARCH_ENGINE_SETTING = 'browser.searchEngine'
/** 用户裁定（2026-10-16）：缺省 Google，与 Chrome 一致 */
export const DEFAULT_SEARCH_ENGINE: SearchEngineId = 'google'

/** 名字是品牌名，不翻译；%s = 编码后的搜索词 */
export const SEARCH_ENGINES: Record<SearchEngineId, { name: string; template: string }> = {
  google: { name: 'Google', template: 'https://www.google.com/search?q=%s' },
  bing: { name: 'Bing', template: 'https://www.bing.com/search?q=%s' },
  baidu: { name: '百度', template: 'https://www.baidu.com/s?wd=%s' },
  duckduckgo: { name: 'DuckDuckGo', template: 'https://duckduckgo.com/?q=%s' }
}

/** 设置里存的值 → 搜索引擎（没设过、或是不认识的值都回缺省） */
export function searchEngineOf(value: string | undefined | null): SearchEngineId {
  // 只认自有键：`'toString' in SEARCH_ENGINES` 也是 true
  return value && Object.hasOwn(SEARCH_ENGINES, value)
    ? (value as SearchEngineId)
    : DEFAULT_SEARCH_ENGINE
}

/** 一个搜索词在某个搜索引擎上的结果页地址 */
export function searchUrl(query: string, engine: SearchEngineId): string {
  return SEARCH_ENGINES[engine].template.replace('%s', encodeURIComponent(query))
}

/** 原样打开的协议（用户自己在地址栏里敲的） */
const PASS_THROUGH = /^(https?|file):\/\//i
const PASS_THROUGH_OPAQUE = /^(about|data|view-source):/i
/** 带端口的主机名部分：`host` 或 `host:port` */
const HOST_PORT = /^([^/?#]+?)(?::(\d{1,5}))?$/
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/
const IPV6 = /^\[[0-9a-f:.]+\]$/i
/** 像域名：至少一个点、最后一段是 2 个以上的字母（含非拉丁字母的国际化域名） */
const DOMAIN = /^[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)*\.\p{L}{2,63}$/u

/**
 * 地址栏输入 → 要打开的地址；空串回 null（不导航）。照 Chrome 的判断：
 * - 带 http(s) / file 协议、或 about: / data: / view-source: 的原样打开；
 * - 有空格的是搜索词；
 * - localhost、IP 地址（可带端口和路径）补 `http://`（本机开发服务器多半不是 https）；
 * - 像域名的（`example.com`、`example.com:8080/a`）补 `https://`；
 * - 其余（单个词、`javascript:` 之类）交给搜索引擎。
 */
export function resolveOmniboxInput(input: string, engine: SearchEngineId): string | null {
  const text = input.trim()
  if (!text) return null
  if (PASS_THROUGH.test(text) || PASS_THROUGH_OPAQUE.test(text)) return text
  if (/\s/.test(text)) return searchUrl(text, engine)

  const cut = text.search(/[/?#]/)
  const hostPort = cut === -1 ? text : text.slice(0, cut)
  const m = HOST_PORT.exec(hostPort)
  if (m) {
    const host = m[1].toLowerCase()
    const port = m[2] === undefined ? null : Number(m[2])
    if (port === null || (port > 0 && port <= 65535)) {
      if (host === 'localhost' || host.endsWith('.localhost') || IPV4.test(host)) {
        return `http://${text}`
      }
      if (IPV6.test(host)) return `http://${text}`
      if (DOMAIN.test(host)) return `https://${text}`
    }
  }
  return searchUrl(text, engine)
}

/** 地址栏未聚焦时的样子：协议换成一个图标，主机名突出、其余变淡（Chrome 的显示方式） */
export interface UrlDisplay {
  /** secure = https；insecure = http；local = file:；other = 其余（about: / data: …） */
  kind: 'secure' | 'insecure' | 'local' | 'other'
  host: string
  rest: string
}

export function urlDisplayOf(url: string): UrlDisplay {
  try {
    const u = new URL(url)
    const rest = `${u.pathname === '/' ? '' : u.pathname}${u.search}${u.hash}`
    if (u.protocol === 'https:') return { kind: 'secure', host: u.host, rest }
    if (u.protocol === 'http:') return { kind: 'insecure', host: u.host, rest }
    if (u.protocol === 'file:') return { kind: 'local', host: '', rest: decodeURI(u.pathname) }
  } catch {
    // 不是合法地址：原样显示
  }
  return { kind: 'other', host: '', rest: url }
}
