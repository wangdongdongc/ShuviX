/**
 * `web_search` 的 API 方式（Tavily / Exa）：读设置里选的搜索方式、读密钥、发请求。请求与回包的形状在
 * utils/toolUtils/webSearchApi.ts（纯函数）。
 *
 * 请求走 read 工具那个不落盘的网络会话（跟随系统代理，不带内置浏览器的 cookie、也不带应用自己的）。
 * 用户裁定（2026-11-16）：选哪个就用哪个，失败就报失败，这里从不退回别的方式。
 */
import {
  SEARCH_ENGINE_SETTING,
  SEARCH_ENGINES,
  searchEngineOf
} from '../../shared/browserSearchEngines'
import {
  isWebSearchApiProvider,
  keyLast4,
  WEB_SEARCH_API_PROVIDER_IDS,
  WEB_SEARCH_PROVIDER_SETTING,
  webSearchProviderOf,
  type WebSearchApiProviderId,
  type WebSearchConfig,
  type WebSearchKeyState,
  type WebSearchProviderId,
  type WebSearchTestResult
} from '../../shared/webSearchProviders'
import { settingsDao } from '../dao/settingsDao'
import { webSearchKeyDao } from '../dao/webSearchKeyDao'
import { createLogger } from '../logger'
import {
  buildApiSearchRequest,
  missingKeyError,
  networkError,
  parseApiSearchResponse,
  WebSearchApiError,
  withoutKey,
  type ApiSearchResult
} from '../utils/toolUtils/webSearchApi'
import { readUrlSession } from './readPageRenderer'

const log = createLogger('WebSearchApi')

/** 一次 API 搜索等多久 */
const API_TIMEOUT_MS = 20_000
/** 「测试」用的搜索词与条数（真的搜一次，花一次额度） */
const TEST_QUERY = 'ShuviX'
const TEST_RESULTS = 5

type Fetch = (url: string, init: RequestInit) => Promise<Response>

/** 设置里选的搜索方式（缺省内置浏览器） */
export function configuredWebSearchProvider(): WebSearchProviderId {
  return webSearchProviderOf(settingsDao.findByKey(WEB_SEARCH_PROVIDER_SETTING))
}

function keyStateOf(provider: WebSearchApiProviderId): WebSearchKeyState {
  const key = webSearchKeyDao.find(provider)
  return { saved: key !== '', last4: keyLast4(key) }
}

/** 设置页要的那一份：选的方式、浏览器此刻的搜索引擎、各家密钥存没存（明文从不交出去） */
export function webSearchConfig(): WebSearchConfig {
  const engine = searchEngineOf(settingsDao.findByKey(SEARCH_ENGINE_SETTING))
  return {
    provider: configuredWebSearchProvider(),
    browserEngine: SEARCH_ENGINES[engine].name,
    keys: Object.fromEntries(
      WEB_SEARCH_API_PROVIDER_IDS.map((id) => [id, keyStateOf(id)])
    ) as WebSearchConfig['keys']
  }
}

function assertProvider(provider: unknown): asserts provider is WebSearchApiProviderId {
  if (!isWebSearchApiProvider(provider)) throw new Error(`Unknown search API: ${String(provider)}`)
}

/** 存一把密钥（去掉首尾空白；空的不存） */
export function setWebSearchKey(provider: unknown, apiKey: unknown): WebSearchConfig {
  assertProvider(provider)
  const key = typeof apiKey === 'string' ? apiKey.trim() : ''
  if (key === '') throw new Error('The API key is empty')
  webSearchKeyDao.set(provider, key)
  return webSearchConfig()
}

export function deleteWebSearchKey(provider: unknown): WebSearchConfig {
  assertProvider(provider)
  webSearchKeyDao.delete(provider)
  return webSearchConfig()
}

/** 用一家 API 搜一次。没有密钥、被拒、限速、连不上都抛 WebSearchApiError（消息是写给模型的） */
export async function searchWithApi(
  provider: WebSearchApiProviderId,
  query: string,
  limit: number,
  opts: { signal?: AbortSignal; fetch?: Fetch } = {}
): Promise<ApiSearchResult[]> {
  const apiKey = webSearchKeyDao.find(provider)
  if (apiKey === '') throw missingKeyError(provider)
  const request = buildApiSearchRequest(provider, query, limit, apiKey)
  const doFetch: Fetch = opts.fetch ?? ((url, init) => readUrlSession().fetch(url, init))
  const timeout = AbortSignal.timeout(API_TIMEOUT_MS)
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout
  let status: number
  let body: unknown
  try {
    const response = await doFetch(request.url, { ...request.init, signal, credentials: 'omit' })
    status = response.status
    // 错误体不一定是 JSON（网关的 HTML 错页）：读不出来就当没有
    body = await response.json().catch(() => undefined)
  } catch (error) {
    // 调用方中止的原样抛（durable 的中止语义）；超时与连不上是这家 API 的失败
    if (opts.signal?.aborted) throw opts.signal.reason
    const failure = networkError(provider, error, apiKey)
    log.info(`${provider} request failed: ${failure.reason}`)
    throw failure
  }
  return parseApiSearchResponse(provider, status, body, limit, apiKey)
}

/** 设置页的「测试」：用存着的密钥真的搜一次 */
export async function testWebSearchProvider(provider: unknown): Promise<WebSearchTestResult> {
  assertProvider(provider)
  const started = Date.now()
  try {
    const results = await searchWithApi(provider, TEST_QUERY, TEST_RESULTS)
    return { ok: true, count: results.length, ms: Date.now() - started }
  } catch (error) {
    if (error instanceof WebSearchApiError) return { ok: false, error: error.reason }
    const text = error instanceof Error ? error.message : String(error)
    return { ok: false, error: withoutKey(text, webSearchKeyDao.find(provider)) }
  }
}
