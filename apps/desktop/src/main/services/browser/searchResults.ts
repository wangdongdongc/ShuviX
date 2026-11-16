/**
 * `web_search` 工具的纯数据一半：在搜索结果页里跑的取数脚本、验证页的判断、结果的整理与成文。
 *
 * 不碰 Electron —— 开 tab、等页面、关 tab 在 webSearch.ts。
 *
 * 取数按搜索引擎各写一段选择器（2026-11-16 实测四家的结果页）。结果页的结构会变（Bing 同一个会话里就见过两种），
 * 所以选择器取不到时不算失败：`pageText` 把页面正文带回来，由工具原样交给模型。
 */
import type { SearchEngineId } from '../../../shared/browserSearchEngines'

export interface SearchResult {
  title: string
  url: string
  snippet: string
}

/** 取数脚本在页面里看到的东西 */
export interface SearchPageState {
  url: string
  title: string
  /** 页面可见文字的长度（判断「页面还在变」用） */
  textLength: number
  /** 页面开头的一段文字（认验证页用） */
  head: string
  results: SearchResult[]
}

const SNIPPET_CHARS = 300
const HEAD_CHARS = 400

/**
 * 在结果页里取结果。返回 SearchPageState；不改页面、不点任何东西。
 * 写成一段字符串是因为它经 `executeJavaScript` 进页面；里面用不到外面的任何变量。
 */
export const SEARCH_PAGE_SCRIPT = `(() => {
  const txt = (el) => (el ? (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim() : '')
  const host = location.hostname
  const out = []
  const push = (title, url, snippet) => {
    if (title && url) out.push({ title, url, snippet: (snippet || '').slice(0, ${SNIPPET_CHARS}) })
  }
  try {
    if (/(^|\\.)google\\./.test(host)) {
      const SNIPPET = '.VwiC3b, [data-sncf], div[style*="line-clamp"]'
      document.querySelectorAll('a h3').forEach((h3) => {
        const a = h3.closest('a')
        if (!a) return
        let scope = a.closest('div[data-hveid], div.g') || a.parentElement
        for (let i = 0; i < 4 && scope && !scope.querySelector(SNIPPET); i++) scope = scope.parentElement
        push(txt(h3), a.href, txt(scope && scope.querySelector(SNIPPET)))
      })
    } else if (/(^|\\.)bing\\.com$/.test(host)) {
      document.querySelectorAll('li.b_algo').forEach((li) => {
        const a = li.querySelector('h2 a')
        push(txt(a), a && a.href, txt(li.querySelector('.b_caption p, p')))
      })
    } else if (/(^|\\.)duckduckgo\\.com$/.test(host)) {
      document.querySelectorAll('article[data-testid="result"]').forEach((r) => {
        const a = r.querySelector('a[data-testid="result-title-a"]')
        push(txt(a), a && a.href, txt(r.querySelector('[data-result="snippet"]')))
      })
    } else if (/(^|\\.)baidu\\.com$/.test(host)) {
      document.querySelectorAll('div.result, div.c-container').forEach((r) => {
        const a = r.querySelector('h3 a')
        push(
          txt(a),
          a && a.href,
          txt(r.querySelector('.c-abstract, [class*="content-right"], [class*="summary-text"], span[class*="content"]'))
        )
      })
    }
  } catch (_) {}
  const body = document.body ? document.body.innerText || '' : ''
  return {
    url: location.href,
    title: document.title,
    textLength: body.length,
    head: body.slice(0, ${HEAD_CHARS}).replace(/\\s+/g, ' '),
    results: out
  }
})()`

/** 结果页的正文（选择器取不到结果时的退路） */
export const SEARCH_PAGE_TEXT_SCRIPT = `(document.body ? document.body.innerText || '' : '')`

const VERIFICATION_TEXT =
  /unusual traffic|not a robot|are you a (human|robot)|verify you are human|bots use duckduckgo|complete the following challenge|安全验证|异常流量|请完成下方验证|人机验证/i

/** 验证页都很短（实测 52 ~ 360 字）；比这长的页面不按文字认 —— 结果页的正文里出现这些字样很平常 */
const VERIFICATION_PAGE_MAX_CHARS = 1500

/**
 * 这一页是不是搜索引擎的人机验证页（要一个真人去点）。
 * 已经取到结果的页面不算。按文字认的时候只看正文开头、且页面要够短，不看标题：四家都把搜索词放进标题，
 * 搜「not a robot」不该被当成验证页。
 */
export function isVerificationPage(state: SearchPageState): boolean {
  if (state.results.length > 0) return false
  let parsed: URL
  try {
    parsed = new URL(state.url)
  } catch {
    return false
  }
  const host = parsed.hostname
  const path = parsed.pathname
  // Google：/sorry/index；Bing：/turing/captcha；百度：wappass.baidu.com 的验证页
  if (isGoogleHost(host) && path.startsWith('/sorry/')) return true
  if (/(^|\.)bing\.com$/.test(host) && /captcha|challenge/i.test(path)) return true
  if (host === 'wappass.baidu.com') return true
  if (state.textLength > VERIFICATION_PAGE_MAX_CHARS) return false
  return VERIFICATION_TEXT.test(state.head)
}

/** google.com 与各国域名（google.co.jp、google.com.hk）；`google.evil.com` 不算 */
function isGoogleHost(host: string): boolean {
  return /(^|\.)google\.(com|[a-z]{2,3}|com?\.[a-z]{2})$/.test(host)
}

/**
 * Google 的不透明跳转链接（`/goto?url=<令牌>`）：通过人机验证之后的会话里，结果的地址是这种（2026-11-16 实测），
 * 真实地址只有跟着跳一次才知道（见 webSearch.ts resolveOpaqueLinks）。
 */
export function isOpaqueRedirect(url: string): boolean {
  try {
    const parsed = new URL(url)
    return isGoogleHost(parsed.hostname) && parsed.pathname === '/goto'
  } catch {
    return false
  }
}

function decodeBase64Url(text: string): string | undefined {
  try {
    const padded = text.replace(/-/g, '+').replace(/_/g, '/')
    return Buffer.from(padded, 'base64').toString('utf-8')
  } catch {
    return undefined
  }
}

function isWebUrl(value: string | undefined | null): value is string {
  return !!value && /^https?:\/\//i.test(value)
}

/**
 * 结果里的跳转地址 → 真实地址（认不出就原样）：
 *  - Google `/url?q=<地址>`
 *  - Bing `/ck/a?…&u=a1<base64url 的地址>`
 *  - DuckDuckGo `/l/?uddg=<地址>`
 * 百度的 `/link?url=…` 是不透明的，解不出来，留着（`read` 打开它会跟着跳转）。
 */
export function unwrapResultUrl(raw: string): string {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return raw
  }
  const host = parsed.hostname
  if (isGoogleHost(host) && parsed.pathname === '/url') {
    const target = parsed.searchParams.get('q') ?? parsed.searchParams.get('url')
    return isWebUrl(target) ? target : raw
  }
  if (/(^|\.)bing\.com$/.test(host) && parsed.pathname.startsWith('/ck/')) {
    const u = parsed.searchParams.get('u')
    const target = u && u.startsWith('a1') ? decodeBase64Url(u.slice(2)) : undefined
    return isWebUrl(target) ? target : raw
  }
  if (/(^|\.)duckduckgo\.com$/.test(host) && parsed.pathname.startsWith('/l/')) {
    const target = parsed.searchParams.get('uddg')
    return isWebUrl(target) ? target : raw
  }
  return raw
}

/** 页面里取到的结果 → 交给模型的结果：只留 http(s)、解开跳转地址、按地址去重、至多 limit 条 */
export function cleanResults(raw: unknown, limit: number): SearchResult[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: SearchResult[] = []
  for (const item of raw as unknown[]) {
    if (typeof item !== 'object' || item === null) continue
    const o = item as Record<string, unknown>
    const title = typeof o.title === 'string' ? o.title.trim() : ''
    const href = typeof o.url === 'string' ? o.url.trim() : ''
    if (!title || !isWebUrl(href)) continue
    const url = unwrapResultUrl(href)
    if (seen.has(url)) continue
    seen.add(url)
    out.push({ title, url, snippet: typeof o.snippet === 'string' ? o.snippet.trim() : '' })
    if (out.length >= limit) break
  }
  return out
}

/** 一页结果写成给模型看的文字 */
export function formatResults(query: string, engineName: string, results: SearchResult[]): string {
  const lines = results.map((r, i) => {
    const snippet = r.snippet ? `\n   ${r.snippet}` : ''
    return `${i + 1}. ${r.title}\n   ${r.url}${snippet}`
  })
  const note = results.some((r) => isOpaqueRedirect(r.url))
    ? `\n\nAddresses that start with https://www.google.com/goto are Google's own links to the result; opening one leads to the page.`
    : ''
  return `${engineName} results for ${JSON.stringify(query)}:\n\n${lines.join('\n\n')}${note}`
}

/** 页面正文的退路最多带回多少字 */
export const PAGE_TEXT_FALLBACK_CHARS = 6000

/** 选择器没取到结果时：把页面正文交给模型，说明这不是整理过的结果 */
export function formatPageTextFallback(
  query: string,
  engineName: string,
  pageUrl: string,
  text: string
): string {
  const body = text.replace(/\n{3,}/g, '\n\n').trim()
  const clipped =
    body.length > PAGE_TEXT_FALLBACK_CHARS
      ? `${body.slice(0, PAGE_TEXT_FALLBACK_CHARS)}\n[…cut]`
      : body
  return (
    `The ${engineName} results page for ${JSON.stringify(query)} could not be split into results, so this is the page's text as shown (${pageUrl}). ` +
    `It has no result links; open the page with read if you need them.\n\n${clipped}`
  )
}

export type { SearchEngineId }
