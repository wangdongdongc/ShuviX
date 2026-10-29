/**
 * 地址栏的搜索建议（searchSuggest.ts）—— 主进程向用户选的搜索引擎的 OpenSearch 建议接口要建议。
 *
 *   SS-1  设置 browser.searchSuggest 为 'false' → []、不发请求；没设过 → 照发
 *   SS-2  不该送的输入（localhost:3000、https://x、192.168.0.1、全空白）→ []、不发请求
 *   SS-3  地址 = searchSuggestUrl(trim 过的输入, 引擎)；不认识的引擎 → Google；init 带 credentials 'omit' 与
 *         signal，超时用 AbortSignal.timeout(2000)；不注入 fetch 时走浏览器分区的 session.fetch
 *   SS-4  回包经 parseSearchSuggestions：搜索词本身去掉、最多 8 条
 *   SS-5  字符集：Content-Type 里 charset=GBK 的字节按 GBK 解；带引号的 charset="utf-8" 认得；不认识的字符集、
 *         没有 Content-Type → UTF-8
 *   SS-6  失败一律 []：500、回包不是 JSON、fetch 抛；失败不进缓存（下一次照样再问）
 *   SS-7  缓存：`foo` 与 ` foo ` 只问一次；换引擎另问；再问过 50 个别的之后最早那个被挤掉（先进先出）
 *
 * electron（session.fromPartition）、settingsDao、logger 都是替身；browserViewService 只给 BROWSER_PARTITION
 * （真模块会拉起整个浏览器服务）。每条用例清缓存；fetch 一律注入（SS-3 的最后一条看缺省的那条路）。
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

const state = vi.hoisted(() => ({
  settings: {} as Record<string, string | undefined>,
  sessionFetch: vi.fn(),
  fromPartition: vi.fn()
}))

vi.mock('electron', () => ({
  session: { fromPartition: (partition: string) => state.fromPartition(partition) }
}))
// mock 路径按**测试文件**解析：被测模块在 services/browser/，测试在其 __tests__/ 下
vi.mock('../browserViewService', () => ({ BROWSER_PARTITION: 'persist:shuvix-browser' }))
vi.mock('../../../dao/settingsDao', () => ({
  settingsDao: { findByKey: (key: string) => state.settings[key] }
}))
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} })
}))

import { clearSearchSuggestCache, fetchSearchSuggestions } from '../searchSuggest'
import { searchSuggestUrl } from '../../../../shared/browserSearchEngines'

type FetchImpl = (url: string, init: RequestInit) => Promise<Response>

/** 一个回 JSON 的假 fetch（每次调用回一个新的 Response） */
function jsonFetch(
  body: unknown = ['q', []],
  init: { status?: number; headers?: Record<string, string> } = {}
): Mock<FetchImpl> {
  return vi.fn(
    async () =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status: init.status ?? 200,
        headers: init.headers ?? { 'content-type': 'application/json; charset=utf-8' }
      })
  )
}

/** 回一段原始字节的假 fetch */
function bytesFetch(
  bytes: Uint8Array<ArrayBuffer>,
  headers: Record<string, string>
): Mock<FetchImpl> {
  return vi.fn(async () => new Response(bytes, { status: 200, headers }))
}

beforeEach(() => {
  clearSearchSuggestCache()
  state.settings = {}
  state.sessionFetch.mockReset()
  state.fromPartition.mockReset()
  state.fromPartition.mockImplementation(() => ({ fetch: state.sessionFetch }))
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('开关（SS-1）', () => {
  it("SS-1 browser.searchSuggest = 'false' → []、不发请求", async () => {
    state.settings['browser.searchSuggest'] = 'false'
    const fetch = jsonFetch(['git', ['github']])
    expect(await fetchSearchSuggestions('git', 'google', fetch)).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([undefined, 'true', ''])('SS-1 browser.searchSuggest = %j → 照发', async (value) => {
    state.settings['browser.searchSuggest'] = value
    const fetch = jsonFetch(['git', ['github']])
    expect(await fetchSearchSuggestions('git', 'google', fetch)).toEqual(['github'])
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe('不该送的输入（SS-2）', () => {
  it.each(['localhost:3000', 'https://x', '192.168.0.1', '  ', ''])(
    'SS-2 %j → []、不发请求',
    async (input) => {
      const fetch = jsonFetch(['x', ['y']])
      expect(await fetchSearchSuggestions(input, 'google', fetch)).toEqual([])
      expect(fetch).not.toHaveBeenCalled()
    }
  )
})

describe('请求（SS-3）', () => {
  it.each([
    ['google', 'google'],
    ['bing', 'bing'],
    ['baidu', 'baidu'],
    ['duckduckgo', 'duckduckgo'],
    ['yahoo', 'google'],
    ['', 'google'],
    ['toString', 'google']
  ] as const)('SS-3 引擎 %j → %s 的地址（搜索词 trim 过）', async (engineValue, engine) => {
    const fetch = jsonFetch()
    await fetchSearchSuggestions('  北京 天气 ', engineValue, fetch)
    expect(fetch.mock.calls[0][0]).toBe(searchSuggestUrl('北京 天气', engine))
  })

  it("SS-3 init：credentials 'omit'、带 signal；超时 AbortSignal.timeout(2000)", async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    const fetch = jsonFetch()
    await fetchSearchSuggestions('git', 'google', fetch)
    const init = fetch.mock.calls[0][1]
    expect(init.credentials).toBe('omit')
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(timeout.mock.calls).toEqual([[2000]])
    expect(init.signal).toBe(timeout.mock.results[0].value)
  })

  it('SS-3 不注入 fetch：走浏览器分区（persist:shuvix-browser）的 session.fetch', async () => {
    state.sessionFetch.mockImplementation(
      async () => new Response(JSON.stringify(['git', ['github']]), { status: 200 })
    )
    expect(await fetchSearchSuggestions('git', 'bing')).toEqual(['github'])
    expect(state.fromPartition.mock.calls).toEqual([['persist:shuvix-browser']])
    expect(state.sessionFetch.mock.calls[0][0]).toBe(searchSuggestUrl('git', 'bing'))
    expect(state.sessionFetch.mock.calls[0][1]).toMatchObject({ credentials: 'omit' })
  })
})

describe('回包（SS-4 / SS-5）', () => {
  it('SS-4 经 parseSearchSuggestions：搜索词本身去掉、最多 8 条', async () => {
    const fetch = jsonFetch([
      'foo',
      ['foo', 'Foo', ...Array.from({ length: 10 }, (_, i) => `foo ${i}`)]
    ])
    expect(await fetchSearchSuggestions('foo', 'google', fetch)).toEqual(
      Array.from({ length: 8 }, (_, i) => `foo ${i}`)
    )
  })

  /** `["中",["中国"]]` 的 GBK 字节（中 = D6 D0，国 = B9 FA） */
  const GBK_BODY = Uint8Array.from([
    0x5b, 0x22, 0xd6, 0xd0, 0x22, 0x2c, 0x5b, 0x22, 0xd6, 0xd0, 0xb9, 0xfa, 0x22, 0x5d, 0x5d
  ])
  const UTF8_BODY = Uint8Array.from(new TextEncoder().encode(JSON.stringify(['中', ['中国']])))

  it('SS-5 charset=GBK：按 GBK 解', async () => {
    const fetch = bytesFetch(GBK_BODY, { 'content-type': 'text/javascript; charset=GBK' })
    expect(await fetchSearchSuggestions('中', 'baidu', fetch)).toEqual(['中国'])
  })

  it('SS-5 带引号的 charset="utf-8"', async () => {
    const fetch = bytesFetch(UTF8_BODY, { 'content-type': 'application/json; charset="utf-8"' })
    expect(await fetchSearchSuggestions('中', 'google', fetch)).toEqual(['中国'])
  })

  it('SS-5 不认识的字符集 → UTF-8', async () => {
    const fetch = bytesFetch(UTF8_BODY, { 'content-type': 'application/json; charset=x-nope' })
    expect(await fetchSearchSuggestions('中', 'google', fetch)).toEqual(['中国'])
  })

  it('SS-5 没有 Content-Type → UTF-8', async () => {
    const fetch = vi.fn<FetchImpl>(async () => {
      const res = new Response(UTF8_BODY, { status: 200 })
      res.headers.delete('content-type')
      return res
    })
    expect(await fetchSearchSuggestions('中', 'google', fetch)).toEqual(['中国'])
  })
})

describe('失败（SS-6）', () => {
  it.each([
    ['500', () => jsonFetch(['git', ['github']], { status: 500 })],
    ['不是 JSON', () => jsonFetch('<html>oops</html>')],
    [
      'fetch 抛',
      () =>
        vi.fn<FetchImpl>(async () => {
          throw new Error('net::ERR_INTERNET_DISCONNECTED')
        })
    ]
  ] as const)('SS-6 %s → []，不进缓存（下一次照样再问）', async (_l, make) => {
    const fetch = make()
    expect(await fetchSearchSuggestions('git', 'google', fetch)).toEqual([])
    expect(await fetchSearchSuggestions('git', 'google', fetch)).toEqual([])
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})

describe('缓存（SS-7）', () => {
  it('SS-7 `foo` 与 ` foo ` 只问一次；换引擎另问', async () => {
    const fetch = jsonFetch(['foo', ['foobar']])
    expect(await fetchSearchSuggestions('foo', 'google', fetch)).toEqual(['foobar'])
    expect(await fetchSearchSuggestions(' foo ', 'google', fetch)).toEqual(['foobar'])
    expect(fetch).toHaveBeenCalledTimes(1)
    await fetchSearchSuggestions('foo', 'bing', fetch)
    expect(fetch).toHaveBeenCalledTimes(2)
    await fetchSearchSuggestions('foo', 'google', fetch)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('SS-7 先进先出：再问过 49 个别的还在，第 50 个把最早那个挤掉', async () => {
    const fetch = jsonFetch(['q', ['suggestion']])
    await fetchSearchSuggestions('first', 'google', fetch)
    for (let i = 0; i < 49; i++) await fetchSearchSuggestions(`other ${i}`, 'google', fetch)
    expect(fetch).toHaveBeenCalledTimes(50)
    await fetchSearchSuggestions('first', 'google', fetch)
    expect(fetch).toHaveBeenCalledTimes(50)

    await fetchSearchSuggestions('other 49', 'google', fetch)
    expect(fetch).toHaveBeenCalledTimes(51)
    await fetchSearchSuggestions('first', 'google', fetch)
    expect(fetch).toHaveBeenCalledTimes(52)
  })
})
