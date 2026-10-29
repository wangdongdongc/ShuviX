/**
 * 地址栏下拉建议（Chrome 的 omnibox popup）的纯函数：输入 + 历史 + 搜索建议 + 开着的 tab → 一列建议，
 * 外加内联补全。单独成文件（不放组件文件里）是因为组件文件只能导出组件，否则 fast refresh 失效。
 *
 * 排法（最多 8 行）：
 *   1. 默认的那一行（回车就是它）：能内联补全就是补出来的那个网址；输入像网址就打开它；否则用搜索引擎搜；
 *   2. 开着的 tab 里对得上的（「切换到此标签页」，最多 2 行；选中的那页与内部页面不算）；
 *   3. 网址从开头对得上的历史（最多 2 行）；
 *   4. 搜索那几行：默认那行不是搜索时补一行「搜索 …」，再加搜索引擎给的建议（合计最多 4 行）；
 *   5. 其余对得上的历史。
 * 历史只来自用户自己的访问（主进程只给 visitCount > 0 的）；agent 打开的页面不会出现在这里。
 * 一个历史网址正开在别的 tab 里时，那一行变成「切换到此标签页」。
 */

import {
  displayUrlOf,
  historyMatchScore,
  historyQueryWords,
  inlineCompletionFor,
  type HistorySuggestion
} from '../../../../shared/browserHistory'
import { internalPageOf } from '../../../../shared/browserInternalPages'
import { resolveOmniboxInput, searchUrl, type SearchEngineId } from './omnibox'

interface MatchBase {
  /** 列表里的唯一键 */
  key: string
  /** 用方向键选到这一行时地址栏里显示的字 */
  fill: string
}

/** 照输入打开的网址（Chrome 的 what-you-typed） */
export interface UrlMatch extends MatchBase {
  kind: 'url'
  url: string
  /** 历史里有它时的标题（内联补全出来的那一行） */
  title?: string
  favicon?: string
}

/** 用搜索引擎搜（输入本身，或搜索引擎给的建议） */
export interface SearchMatch extends MatchBase {
  kind: 'search'
  query: string
  url: string
  suggested: boolean
}

/** 历史里的一个网址 */
export interface HistoryMatch extends MatchBase {
  kind: 'history'
  url: string
  title: string
  favicon: string
}

/** 开着的一个 tab：选它 = 切过去，不重新打开 */
export interface TabMatch extends MatchBase {
  kind: 'tab'
  tabId: string
  url: string
  title: string
  favicon: string
}

export type OmniboxMatch = UrlMatch | SearchMatch | HistoryMatch | TabMatch

export interface OmniboxTabLike {
  id: string
  url: string
  title: string
  favicon?: string
}

export interface OmniboxSuggestInput {
  /** 用户敲的字（不含内联补上的那段） */
  text: string
  engine: SearchEngineId
  /** 主进程给的历史候选（可能是上一段输入的结果：这里按这段输入重新过滤、排序） */
  history: HistorySuggestion[]
  /** 搜索引擎给的建议（可能是上一段输入的：只留还以这段输入开头的） */
  searchSuggestions: string[]
  tabs: OmniboxTabLike[]
  selectedTabId: string | null
  /** 这一次能不能内联补全（刚删过字、输入法正在组字、光标不在末尾时不能） */
  allowInline: boolean
  now: number
}

export interface OmniboxSuggestResult {
  matches: OmniboxMatch[]
  /** 内联补全后地址栏里的整段文字（用户敲的 + 补上的）；没有补全为 null */
  inline: string | null
}

const MAX_MATCHES = 8
const MAX_TABS = 2
const MAX_TOP_HISTORY = 2
const MAX_SEARCH = 4

/** 比较用的网址写法（`https://a.com` 与历史里的 `https://a.com/` 是同一个） */
function sameUrlKey(url: string): string {
  try {
    return new URL(url).href
  } catch {
    return url
  }
}

/** 网址某种写法从开头对上了输入（不分大小写） */
function urlPrefixMatches(text: string, url: string): boolean {
  const lower = text.trim().toLowerCase()
  if (!lower) return false
  return [displayUrlOf(url), url.replace(/^https?:\/\//i, ''), url].some((f) =>
    f.toLowerCase().startsWith(lower)
  )
}

/** 一个开着的 tab 是否对得上：每个词都出现在标题或网址里 */
function tabMatches(words: string[], tab: OmniboxTabLike): boolean {
  const title = tab.title.toLowerCase()
  const url = displayUrlOf(tab.url).toLowerCase()
  return words.every((w) => title.includes(w) || url.includes(w))
}

/** 能切过去的 tab：不是选中的那页、不是空白页或内部页面 */
function switchable(tab: OmniboxTabLike, selectedTabId: string | null): boolean {
  return (
    tab.id !== selectedTabId && !!tab.url && tab.url !== 'about:blank' && !internalPageOf(tab.url)
  )
}

function tabMatchOf(tab: OmniboxTabLike): TabMatch {
  return {
    kind: 'tab',
    key: `tab:${tab.id}`,
    fill: displayUrlOf(tab.url),
    tabId: tab.id,
    url: tab.url,
    title: tab.title,
    favicon: tab.favicon ?? ''
  }
}

export function buildOmniboxMatches(input: OmniboxSuggestInput): OmniboxSuggestResult {
  const { text, engine, tabs, selectedTabId, now } = input
  const query = text.trim()
  if (!query) return { matches: [], inline: null }
  const words = historyQueryWords(query)

  // 历史：按这段输入重打分（主进程给的可能是上一段输入的结果）
  const history = input.history
    .map((row) => ({ ...row, score: historyMatchScore(query, row, now) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || b.lastVisitAt - a.lastVisitAt)

  const inline = input.allowInline ? inlineCompletionFor(text, history) : null
  const openTabs = tabs.filter((tab) => switchable(tab, selectedTabId))
  const tabByUrl = new Map(openTabs.map((tab) => [sameUrlKey(tab.url), tab]))

  // 1. 默认的那一行
  let first: OmniboxMatch
  if (inline) {
    const row = history.find((r) => r.url === inline.url)
    first = {
      kind: 'url',
      key: `url:${inline.url}`,
      fill: inline.fill,
      url: inline.url,
      ...(row ? { title: row.title, favicon: row.favicon } : {})
    }
  } else {
    const target = resolveOmniboxInput(text, engine) ?? searchUrl(query, engine)
    first =
      target === searchUrl(query, engine)
        ? {
            kind: 'search',
            key: `search:${query}`,
            fill: text,
            query,
            url: target,
            suggested: false
          }
        : { kind: 'url', key: `url:${target}`, fill: text, url: target }
  }

  const used = new Set<string>([first.key])
  /** 已经占了一行的网址（比较用的写法） */
  const takenUrls = new Set<string>(first.kind === 'url' ? [sameUrlKey(first.url)] : [])
  const takenTabs = new Set<string>()

  // 2. 开着的 tab
  const tabRows: TabMatch[] = []
  for (const tab of openTabs) {
    if (tabRows.length >= MAX_TABS) break
    const key = sameUrlKey(tab.url)
    if (takenUrls.has(key) || !tabMatches(words, tab)) continue
    tabRows.push(tabMatchOf(tab))
    takenTabs.add(tab.id)
    takenUrls.add(key)
  }

  // 3 / 5. 历史（正开在别的 tab 里的，变成切换那一行）
  const historyRows: Array<HistoryMatch | TabMatch> = []
  for (const row of history) {
    const key = sameUrlKey(row.url)
    if (takenUrls.has(key)) continue
    takenUrls.add(key)
    const open = tabByUrl.get(key)
    if (open && !takenTabs.has(open.id)) {
      takenTabs.add(open.id)
      historyRows.push(tabMatchOf(open))
      continue
    }
    historyRows.push({
      kind: 'history',
      key: `history:${row.url}`,
      fill: displayUrlOf(row.url),
      url: row.url,
      title: row.title,
      favicon: row.favicon
    })
  }
  const topHistory: Array<HistoryMatch | TabMatch> = []
  const restHistory: Array<HistoryMatch | TabMatch> = []
  for (const row of historyRows) {
    if (topHistory.length < MAX_TOP_HISTORY && urlPrefixMatches(query, row.url))
      topHistory.push(row)
    else restHistory.push(row)
  }

  // 4. 搜索
  const searchRows: SearchMatch[] = []
  const lowerQuery = query.toLowerCase()
  const addSearch = (q: string, suggested: boolean): void => {
    const key = `search:${q}`
    if (used.has(key) || searchRows.length >= MAX_SEARCH) return
    used.add(key)
    searchRows.push({
      kind: 'search',
      key,
      fill: q,
      query: q,
      url: searchUrl(q, engine),
      suggested
    })
  }
  if (first.kind !== 'search') addSearch(query, false)
  for (const s of input.searchSuggestions) {
    if (s.toLowerCase().startsWith(lowerQuery) && s.toLowerCase() !== lowerQuery) addSearch(s, true)
  }

  const matches = [first, ...tabRows, ...topHistory, ...searchRows, ...restHistory].slice(
    0,
    MAX_MATCHES
  )
  return { matches, inline: inline?.fill ?? null }
}
