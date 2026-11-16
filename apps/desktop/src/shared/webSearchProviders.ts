/**
 * `web_search` 用哪种方式搜（设置 → LLM 工具 → web_search）：内置浏览器（缺省），或一家商业搜索 API。
 *
 * 用户裁定（2026-11-16）：选哪个就用哪个，API 失败就报失败，不自动换方式。
 * 纯数据 + 纯函数，主进程（工具、IPC）与渲染端（设置页）共用（src/shared 是叶子层）。
 * 密钥不在这里、也不在 settings 表里（那张表是明文，智能体与远程访问都读得到）：见 main/dao/webSearchKeyDao.ts。
 */

export type WebSearchApiProviderId = 'tavily' | 'exa'
export type WebSearchProviderId = 'browser' | WebSearchApiProviderId

export const WEB_SEARCH_PROVIDER_SETTING = 'webSearch.provider'
export const DEFAULT_WEB_SEARCH_PROVIDER: WebSearchProviderId = 'browser'

/** 名字是品牌名，不翻译 */
export const WEB_SEARCH_API_PROVIDERS: Record<
  WebSearchApiProviderId,
  { name: string; endpoint: string }
> = {
  tavily: { name: 'Tavily', endpoint: 'https://api.tavily.com/search' },
  exa: { name: 'Exa', endpoint: 'https://api.exa.ai/search' }
}

export const WEB_SEARCH_API_PROVIDER_IDS = Object.keys(
  WEB_SEARCH_API_PROVIDERS
) as WebSearchApiProviderId[]

export function isWebSearchApiProvider(value: unknown): value is WebSearchApiProviderId {
  return typeof value === 'string' && Object.hasOwn(WEB_SEARCH_API_PROVIDERS, value)
}

/** 设置里存的值 → 搜索方式（没设过、或是不认识的值都回缺省：内置浏览器） */
export function webSearchProviderOf(value: string | undefined | null): WebSearchProviderId {
  return isWebSearchApiProvider(value) ? value : DEFAULT_WEB_SEARCH_PROVIDER
}

/** 一家 API 的密钥状态：存没存、末四位（只为让人认出是哪一把；明文从不出主进程） */
export interface WebSearchKeyState {
  saved: boolean
  last4: string
}

/** 设置页要的那一份 */
export interface WebSearchConfig {
  provider: WebSearchProviderId
  /** 浏览器方式此刻用的搜索引擎的名字（地址栏那项设置） */
  browserEngine: string
  keys: Record<WebSearchApiProviderId, WebSearchKeyState>
}

/** 「测试」的结果：真的搜一次 */
export type WebSearchTestResult =
  | { ok: true; count: number; ms: number }
  | { ok: false; error: string }

/** 密钥的末四位（不足八位的一位都不露） */
export function keyLast4(key: string): string {
  const trimmed = key.trim()
  return trimmed.length >= 8 ? trimmed.slice(-4) : ''
}
