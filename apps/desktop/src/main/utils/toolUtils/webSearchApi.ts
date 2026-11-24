/**
 * 商业搜索 API 的请求与回包（`web_search` 的 API 方式）—— 纯函数，不碰 Electron、不读设置、不读密钥：
 * 发请求的在 services/webSearchApiService.ts。
 *
 * 2026-11-16 照官方文档核对：
 *  - Tavily：POST https://api.tavily.com/search，`Authorization: Bearer <key>`，`{query, max_results(≤20), search_depth}`
 *    → `results[{title, url, content, score}]`；401 密钥不对，429 限速，432 / 433 额度用完，错误体 `{detail:{error}}`
 *  - Exa：POST https://api.exa.ai/search，`x-api-key: <key>`，`{query, numResults(≤100), type, contents:{highlights}}`
 *    → `results[{title, url, highlights[], text?, summary?}]`（摘要要自己开 highlights）；401 密钥不对，402 额度用完，
 *    429 限速，错误体 `{error, tag}`
 *
 * 用户裁定：API 失败就报失败，不换方式。所以每一种失败都写成一句给模型的话：哪一家、为什么、别重试、告诉用户。
 */
import {
  WEB_SEARCH_API_PROVIDERS,
  type WebSearchApiProviderId
} from '../../../shared/webSearchProviders'

export interface ApiSearchResult {
  title: string
  url: string
  snippet: string
}

export interface ApiSearchRequest {
  url: string
  init: { method: 'POST'; headers: Record<string, string>; body: string }
}

/** 写给模型的失败（消息就是工具结果）；`kind` 给设置页的「测试」与单测用 */
export class WebSearchApiError extends Error {
  constructor(
    readonly provider: WebSearchApiProviderId,
    readonly kind: 'no-key' | 'bad-key' | 'quota' | 'rate-limit' | 'http' | 'network' | 'shape',
    /** 不带「告诉用户」那半句的原因（设置页显示这一段） */
    readonly reason: string
  ) {
    super(
      `${reason} The user chose ${WEB_SEARCH_API_PROVIDERS[provider].name} for web search in ShuviX's settings (Settings → LLM tools → web_search), and ShuviX does not switch to another search method on its own. ` +
        `Tell the user, do not call web_search again this turn, and get what you need another way if you can.`
    )
    this.name = 'WebSearchApiError'
  }
}

export function missingKeyError(provider: WebSearchApiProviderId): WebSearchApiError {
  const name = WEB_SEARCH_API_PROVIDERS[provider].name
  return new WebSearchApiError(
    provider,
    'no-key',
    `No API key is saved for ${name}, so nothing was searched.`
  )
}

export function buildApiSearchRequest(
  provider: WebSearchApiProviderId,
  query: string,
  limit: number,
  apiKey: string
): ApiSearchRequest {
  const url = WEB_SEARCH_API_PROVIDERS[provider].endpoint
  const json = { 'Content-Type': 'application/json', Accept: 'application/json' }
  if (provider === 'tavily') {
    return {
      url,
      init: {
        method: 'POST',
        headers: { ...json, Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ query, max_results: limit, search_depth: 'basic' })
      }
    }
  }
  return {
    url,
    init: {
      method: 'POST',
      headers: { ...json, 'x-api-key': apiKey },
      body: JSON.stringify({
        query,
        numResults: limit,
        type: 'auto',
        contents: { highlights: true }
      })
    }
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * 摘要不截（用户裁定，2026-11-23）：搜索 API 给的是按查询挑出来的段落，比结果页上那一两句有用，
 * 用户选了它就是要这些内容。只把空白压平成一行。
 */
function flatten(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * 把密钥从一段要给人 / 给模型看的文字里抹掉：服务方的错误体、网络层的报错都可能把提交的密钥原样带回来
 * （「Invalid API key: tvly-…」），而这段文字会进工具结果、进设置页、进日志。
 */
export function withoutKey(text: string, apiKey: string | undefined): string {
  return apiKey && apiKey.length >= 4 ? text.split(apiKey).join('[key]') : text
}

/** 错误体里那句话（两家形状不同；取不到回空串）。只取一小段，从不把整个回包带进消息 */
function errorDetail(body: unknown, apiKey: string | undefined): string {
  if (typeof body !== 'object' || body === null) return ''
  const o = body as Record<string, unknown>
  const detail = o.detail
  const nested =
    typeof detail === 'object' && detail !== null
      ? str((detail as Record<string, unknown>).error)
      : str(detail)
  const text = nested || str(o.error) || str(o.message)
  return withoutKey(text, apiKey).replace(/\s+/g, ' ').trim().slice(0, 200)
}

/** 回包 → 结果；不是 2xx、形状不对都抛 WebSearchApiError */
export function parseApiSearchResponse(
  provider: WebSearchApiProviderId,
  status: number,
  body: unknown,
  limit: number,
  /** 这次请求用的密钥：错误体里若带着它，抹掉再进消息 */
  apiKey?: string
): ApiSearchResult[] {
  const name = WEB_SEARCH_API_PROVIDERS[provider].name
  if (status < 200 || status >= 300) {
    const detail = errorDetail(body, apiKey)
    const tail = detail ? `: ${detail}` : '.'
    if (status === 401 || status === 403) {
      throw new WebSearchApiError(
        provider,
        'bad-key',
        `${name} rejected the API key (${status})${tail}`
      )
    }
    if (status === 402 || status === 432 || status === 433) {
      throw new WebSearchApiError(
        provider,
        'quota',
        `${name} refused the request because the plan's credits or limit are used up (${status})${tail}`
      )
    }
    if (status === 429) {
      throw new WebSearchApiError(
        provider,
        'rate-limit',
        `${name} is rate limiting requests (429)${tail}`
      )
    }
    throw new WebSearchApiError(provider, 'http', `${name} answered ${status}${tail}`)
  }
  const list =
    typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>).results
      : undefined
  if (!Array.isArray(list)) {
    throw new WebSearchApiError(provider, 'shape', `${name} answered without a list of results.`)
  }
  const seen = new Set<string>()
  const out: ApiSearchResult[] = []
  for (const item of list as unknown[]) {
    if (typeof item !== 'object' || item === null) continue
    const o = item as Record<string, unknown>
    const url = str(o.url).trim()
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue
    const highlights = Array.isArray(o.highlights)
      ? (o.highlights as unknown[]).filter((h): h is string => typeof h === 'string').join(' … ')
      : ''
    const snippet = flatten(str(o.content) || highlights || str(o.summary) || str(o.text))
    seen.add(url)
    out.push({ title: str(o.title).trim() || url, url, snippet })
    if (out.length >= limit) break
  }
  return out
}

/** 网络层的失败（连不上、超时）→ 给模型的话 */
export function networkError(
  provider: WebSearchApiProviderId,
  error: unknown,
  apiKey?: string
): WebSearchApiError {
  const name = WEB_SEARCH_API_PROVIDERS[provider].name
  const text = withoutKey(error instanceof Error ? error.message : String(error), apiKey)
  return new WebSearchApiError(
    provider,
    'network',
    `The request to ${name} did not get an answer (${text.replace(/\s+/g, ' ').slice(0, 160)}).`
  )
}
