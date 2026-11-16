/**
 * `web_search` 的搜索方式（shared/webSearchProviders.ts）—— 纯数据 + 纯函数。
 *
 *   WP-1  设置键与缺省
 *   WP-2  两家 API 的名字与端点；id 列表
 *   WP-3  isWebSearchApiProvider：只认 tavily / exa（原型上的名字不算）
 *   WP-4  webSearchProviderOf：不认识的值都回 browser
 *   WP-5  keyLast4：不足八位一位不露；先去首尾空白
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WEB_SEARCH_PROVIDER,
  WEB_SEARCH_API_PROVIDERS,
  WEB_SEARCH_API_PROVIDER_IDS,
  WEB_SEARCH_PROVIDER_SETTING,
  isWebSearchApiProvider,
  keyLast4,
  webSearchProviderOf
} from '../webSearchProviders'

describe('webSearchProviders', () => {
  it('WP-1 the setting key and the default method', () => {
    expect(WEB_SEARCH_PROVIDER_SETTING).toBe('webSearch.provider')
    expect(DEFAULT_WEB_SEARCH_PROVIDER).toBe('browser')
  })

  it('WP-2 exactly Tavily and Exa, with their endpoints', () => {
    expect(WEB_SEARCH_API_PROVIDERS).toEqual({
      tavily: { name: 'Tavily', endpoint: 'https://api.tavily.com/search' },
      exa: { name: 'Exa', endpoint: 'https://api.exa.ai/search' }
    })
    expect(WEB_SEARCH_API_PROVIDER_IDS).toEqual(['tavily', 'exa'])
  })

  it.each<[unknown, boolean]>([
    ['tavily', true],
    ['exa', true],
    ['browser', false],
    ['Tavily', false],
    ['', false],
    [undefined, false],
    [null, false],
    [1, false],
    ['toString', false],
    ['__proto__', false],
    ['constructor', false]
  ])('WP-3 isWebSearchApiProvider(%j) → %s', (value, expected) => {
    expect(isWebSearchApiProvider(value)).toBe(expected)
  })

  it.each<[string | undefined | null, string]>([
    [undefined, 'browser'],
    [null, 'browser'],
    ['', 'browser'],
    ['browser', 'browser'],
    ['google', 'browser'],
    ['TAVILY', 'browser'],
    [' tavily', 'browser'],
    ['toString', 'browser'],
    ['tavily', 'tavily'],
    ['exa', 'exa']
  ])('WP-4 webSearchProviderOf(%j) → %s', (value, expected) => {
    expect(webSearchProviderOf(value)).toBe(expected)
  })

  it('WP-5 keyLast4: nothing under eight characters, the last four otherwise, trimmed first', () => {
    expect(keyLast4('abcdefg')).toBe('')
    expect(keyLast4('abcdefgh')).toBe('efgh')
    expect(keyLast4(`${'k'.repeat(36)}wxyz`)).toBe('wxyz')
    expect(keyLast4('')).toBe('')
    expect(keyLast4('  abcdefg \n')).toBe('')
    expect(keyLast4('  abcdefgh \n')).toBe('efgh')
  })
})
