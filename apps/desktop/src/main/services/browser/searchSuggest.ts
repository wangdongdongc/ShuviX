/**
 * 地址栏的搜索建议（Chrome 边打字边给的「Google 搜索」那几行）：向用户选的搜索引擎的 OpenSearch 建议接口要。
 *
 * 用户裁定（2026-10-29）：缺省开着、设置页可关（browser.searchSuggest）。为什么在主进程取：渲染端的 CSP 不放行
 * 外站请求；走浏览器分区的 session，代理设置与内置浏览器一致。不带 Cookie（credentials: 'omit'）—— 建议不必
 * 按用户的登录态个性化，送出去的只有这几个字。带协议、localhost、IP、本地路径这类输入不送
 * （shared/browserSearchEngines.ts 的 searchSuggestAllowed）。
 *
 * 失败（断网、超时、回包认不出）一律回空数组：地址栏照样只给历史与「搜索 …」那一行。
 */

import { session } from 'electron'
import { createLogger } from '../../logger'
import { settingsDao } from '../../dao/settingsDao'
import { BROWSER_PARTITION } from './browserViewService'
import {
  SEARCH_SUGGEST_SETTING,
  parseSearchSuggestions,
  searchEngineOf,
  searchSuggestAllowed,
  searchSuggestEnabled,
  searchSuggestUrl
} from '../../../shared/browserSearchEngines'

const log = createLogger('SearchSuggest')

const TIMEOUT_MS = 2000
const CACHE_SIZE = 50

/** 最近要过的（引擎 + 搜索词 → 建议）：退格再敲回来不必再问一次 */
const cache = new Map<string, string[]>()

type Fetch = (url: string, init: RequestInit) => Promise<Response>

function defaultFetch(url: string, init: RequestInit): Promise<Response> {
  return session.fromPartition(BROWSER_PARTITION).fetch(url, init)
}

/** 回包的字符集（Content-Type 里的 charset；没写当 UTF-8） */
function charsetOf(res: Response): string {
  const m = /charset=([^;]+)/i.exec(res.headers.get('content-type') ?? '')
  return m ? m[1].trim().replace(/^"|"$/g, '') : 'utf-8'
}

function decode(buf: ArrayBuffer, charset: string): string {
  try {
    return new TextDecoder(charset).decode(buf)
  } catch {
    return new TextDecoder('utf-8').decode(buf)
  }
}

/** 一段输入在某个搜索引擎上的搜索建议（最多 8 条）；关着、不该送、失败都回空数组 */
export async function fetchSearchSuggestions(
  input: string,
  engineValue: string,
  fetchImpl: Fetch = defaultFetch
): Promise<string[]> {
  if (!searchSuggestEnabled(settingsDao.findByKey(SEARCH_SUGGEST_SETTING))) return []
  const query = input.trim()
  if (!searchSuggestAllowed(query)) return []
  const engine = searchEngineOf(engineValue)
  const key = `${engine}\u0000${query}`
  const hit = cache.get(key)
  if (hit) return hit
  try {
    const res = await fetchImpl(searchSuggestUrl(query, engine), {
      credentials: 'omit',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Accept: 'application/json, text/javascript, */*' }
    })
    if (!res.ok) return []
    const text = decode(await res.arrayBuffer(), charsetOf(res))
    const suggestions = parseSearchSuggestions(JSON.parse(text), query)
    cache.set(key, suggestions)
    if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value as string)
    return suggestions
  } catch (err) {
    log.info(`search suggestions from ${engine} failed: ${(err as Error).message}`)
    return []
  }
}

/** 测试用：清掉缓存 */
export function clearSearchSuggestCache(): void {
  cache.clear()
}
