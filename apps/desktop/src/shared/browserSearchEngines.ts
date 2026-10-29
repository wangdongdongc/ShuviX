/**
 * 内置浏览器的搜索引擎表：地址栏里不是网址时去哪儿搜，以及边打字边给的搜索建议从哪儿取。
 *
 * 纯数据 + 几个纯函数，主进程（取搜索建议）与渲染端（地址栏、设置页）共用（src/shared 是叶子层）。
 */

export type SearchEngineId = 'google' | 'bing' | 'baidu' | 'duckduckgo'

export const SEARCH_ENGINE_SETTING = 'browser.searchEngine'
/** 用户裁定（2026-10-16）：缺省 Google，与 Chrome 一致 */
export const DEFAULT_SEARCH_ENGINE: SearchEngineId = 'google'

/**
 * 地址栏边打字边向搜索引擎要搜索建议（Chrome 的「自动补全搜索和网址」）。用户裁定（2026-10-29）：缺省开着，
 * 与 Chrome 一致；设置页里可关。只有字面量 `'false'` 算关。
 */
export const SEARCH_SUGGEST_SETTING = 'browser.searchSuggest'

export function searchSuggestEnabled(value: string | undefined | null): boolean {
  return value !== 'false'
}

/**
 * 名字是品牌名，不翻译；%s = 编码后的搜索词。
 * `suggest` 是 OpenSearch 搜索建议接口（回 `[搜索词, [建议…]]`，Firefox 用的同一批地址；2026-10-29 实测四家都是
 * UTF-8，Bing 会 302 到 cn.bing.com）。
 */
export const SEARCH_ENGINES: Record<
  SearchEngineId,
  { name: string; template: string; suggest: string }
> = {
  google: {
    name: 'Google',
    template: 'https://www.google.com/search?q=%s',
    suggest: 'https://www.google.com/complete/search?client=firefox&q=%s'
  },
  bing: {
    name: 'Bing',
    template: 'https://www.bing.com/search?q=%s',
    suggest: 'https://www.bing.com/osjson.aspx?query=%s'
  },
  baidu: {
    name: '百度',
    template: 'https://www.baidu.com/s?wd=%s',
    suggest: 'https://www.baidu.com/su?wd=%s&action=opensearch&ie=utf-8'
  },
  duckduckgo: {
    name: 'DuckDuckGo',
    template: 'https://duckduckgo.com/?q=%s',
    suggest: 'https://duckduckgo.com/ac/?q=%s&type=list'
  }
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

/** 一个搜索词的搜索建议接口地址 */
export function searchSuggestUrl(query: string, engine: SearchEngineId): string {
  return SEARCH_ENGINES[engine].suggest.replace('%s', encodeURIComponent(query))
}

/** 搜索建议最长送多少字（再长多半是粘进来的一大段，不送） */
const MAX_SUGGEST_QUERY = 200

/**
 * 这段输入能不能送去要搜索建议。照 Chrome 的口径，带协议的（`https://…`、`file:`、`about:`、`shuvix:`…）不送；
 * 再多挡几样只在这台电脑 / 内网里有意义的：localhost、IP 地址、本地路径（`/…`、`~/…`、`C:\…`）——
 * 它们不是搜索词，送出去只是把内网地址告诉搜索引擎。
 */
export function searchSuggestAllowed(input: string): boolean {
  const text = input.trim()
  if (!text || text.length > MAX_SUGGEST_QUERY) return false
  // 认得的协议一律不送；别的「词:」只在整段没有空白时当协议（`note: 买牛奶` 是搜索词，`example.com:8080` 是端口）
  if (
    /^(https?|file|ftp|about|data|blob|view-source|javascript|mailto|chrome|shuvix):/i.test(text)
  ) {
    return false
  }
  if (!/\s/.test(text) && /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(text)) return false
  if (/^(\/|~\/|[a-z]:\\)/i.test(text)) return false
  const host = text.split(/[/?#\s]/)[0].toLowerCase()
  if (host === 'localhost' || host.startsWith('localhost:') || host.endsWith('.localhost'))
    return false
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(host) || /^\[[0-9a-f:.]+\](:\d+)?$/.test(host)) {
    return false
  }
  return true
}

/**
 * OpenSearch 搜索建议的回包 → 建议列表（与搜索词本身相同的去掉、去重、最多 limit 条）。认不出的形状回空数组。
 */
export function parseSearchSuggestions(body: unknown, query: string, limit = 8): string[] {
  if (!Array.isArray(body) || !Array.isArray(body[1])) return []
  const seen = new Set([query.trim().toLowerCase()])
  const out: string[] = []
  for (const item of body[1] as unknown[]) {
    if (typeof item !== 'string') continue
    const text = item.trim()
    const key = text.toLowerCase()
    if (!text || seen.has(key)) continue
    seen.add(key)
    out.push(text)
    if (out.length >= limit) break
  }
  return out
}
