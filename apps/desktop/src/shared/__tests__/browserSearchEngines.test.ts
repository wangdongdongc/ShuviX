/**
 * 内置浏览器的搜索引擎表里与搜索建议有关的几个纯函数（shared/browserSearchEngines.ts）。
 *
 *   SE-1  searchSuggestEnabled：只有字面量 'false' 算关（没设过 / null / 空串 / 'true' / 'FALSE' / '0' 都是开）
 *   SE-2  searchSuggestUrl：四家各自的 OpenSearch 地址，搜索词 encodeURIComponent（`a&b c`、`北京`、`$&` ——
 *         最后一个在 String.replace 里本是「整个匹配」的替换模式，不能被当成它）
 *   SE-3  searchSuggestAllowed 为真：普通词、带空白的「词:」、主机:端口、像 localhost 但不是的、不完整的 IP、
 *         前后空白、恰好 200 字
 *   SE-4  为假：空 / 全空白 / 201 字；带协议的（大小写都算）与没有空白的「词:」；本地路径；localhost（含端口、
 *         子域名）；IPv4 / IPv6（含端口、路径）
 *   SE-5  parseSearchSuggestions：去掉搜索词本身（不分大小写、去空白后比）、去重、非字符串 / 空串跳过、
 *         缺省最多 8 条、显式 limit 照截
 *   SE-6  认不出的回包 → []
 */
import { describe, expect, it } from 'vitest'
import {
  parseSearchSuggestions,
  searchSuggestAllowed,
  searchSuggestEnabled,
  searchSuggestUrl,
  type SearchEngineId
} from '../browserSearchEngines'

describe('searchSuggestEnabled（SE-1）', () => {
  it.each([undefined, null, '', 'true', 'FALSE', '0', ' false'])('SE-1 %j → 开', (value) => {
    expect(searchSuggestEnabled(value)).toBe(true)
  })

  it("SE-1 'false' → 关", () => {
    expect(searchSuggestEnabled('false')).toBe(false)
  })
})

describe('searchSuggestUrl（SE-2）', () => {
  it.each<[SearchEngineId, string]>([
    ['google', 'https://www.google.com/complete/search?client=firefox&q=%s'],
    ['bing', 'https://www.bing.com/osjson.aspx?query=%s'],
    ['baidu', 'https://www.baidu.com/su?wd=%s&action=opensearch&ie=utf-8'],
    ['duckduckgo', 'https://duckduckgo.com/ac/?q=%s&type=list']
  ])('SE-2 %s', (engine, template) => {
    for (const [query, encoded] of [
      ['a&b c', 'a%26b%20c'],
      ['北京', '%E5%8C%97%E4%BA%AC'],
      ['$&', '%24%26']
    ]) {
      expect(searchSuggestUrl(query, engine), `${engine} ${query}`).toBe(
        template.replace('%s', () => encoded)
      )
    }
  })
})

describe('searchSuggestAllowed（SE-3 / SE-4）', () => {
  it.each([
    'hello world',
    'git',
    'note: buy milk',
    'example.com:8080',
    'localhostfoo',
    '10.0.0',
    ' git ',
    'a'.repeat(200)
  ])('SE-3 %j → 送', (input) => {
    expect(searchSuggestAllowed(input)).toBe(true)
  })

  it.each([
    '',
    '   ',
    'a'.repeat(201),
    'https://x',
    'HTTP://x',
    'file:///etc',
    'about:blank',
    'data:x',
    'view-source:x',
    'javascript:alert(1)',
    'mailto:a@b',
    'shuvix://settings',
    'chrome://x',
    'foo:bar',
    '/etc/hosts',
    '~/notes',
    'C:\\Users',
    'localhost',
    'LOCALHOST:3000',
    'app.localhost/x',
    '192.168.1.1',
    '192.168.1.1:8080/x',
    '[::1]',
    '[::1]:3000'
  ])('SE-4 %j → 不送', (input) => {
    expect(searchSuggestAllowed(input)).toBe(false)
  })
})

describe('parseSearchSuggestions（SE-5 / SE-6）', () => {
  const body = ['git', ['git', 'GitHub', 'github', ' gitlab ', '', 3, null, 'git ']]

  it('SE-5 去掉搜索词本身、去重（不分大小写）、去空白、跳过非字符串与空串', () => {
    expect(parseSearchSuggestions(body, 'git')).toEqual(['GitHub', 'gitlab'])
    // 搜索词本身前后的空白也不算数
    expect(parseSearchSuggestions(body, '  GIT ')).toEqual(['GitHub', 'gitlab'])
  })

  it('SE-5 缺省最多 8 条；显式 limit 照截', () => {
    const many = ['q', Array.from({ length: 12 }, (_, i) => `q${i}`)]
    expect(parseSearchSuggestions(many, 'q')).toEqual(Array.from({ length: 8 }, (_, i) => `q${i}`))
    expect(parseSearchSuggestions(body, 'git', 2)).toEqual(['GitHub', 'gitlab'])
    expect(parseSearchSuggestions(many, 'q', 2)).toEqual(['q0', 'q1'])
  })

  it.each([null, undefined, {}, 'x', ['q'], ['q', 'notarray'], [['q'], 'x'], 42])(
    'SE-6 %j → []',
    (malformed) => {
      expect(parseSearchSuggestions(malformed, 'q')).toEqual([])
    }
  )
})
