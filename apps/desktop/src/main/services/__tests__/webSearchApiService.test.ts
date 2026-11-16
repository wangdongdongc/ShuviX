/**
 * `web_search` 的 API 方式（services/webSearchApiService.ts）：读设置里选的方式、密钥只进不出、发一次请求、
 * 失败就是失败（不重试、不换方式）、密钥不进任何消息与日志。
 *
 *   WS-1..4    选的方式；设置页要的那一份（形状、末四位、不含明文）
 *   WS-5..10   存 / 删密钥（去空白、空的不存、不认识的 API、不写 settings 表）
 *   WS-11..24  searchWithApi：没密钥不发请求、请求的形状、走 read 的网络会话、各种失败、超时、调用方中止、条数
 *   WS-25..29  「测试」：真的搜一次，只回原因那一段
 *
 * DAO 是内存里的 Map；日志的每次调用收进数组；网络是注入的假 fetch。密钥是运行时拼出来的假值。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  settings: new Map<string, string>(),
  settingsWrites: [] as unknown[][],
  keys: new Map<string, string>(),
  find: vi.fn(),
  set: vi.fn(),
  delete: vi.fn(),
  logs: [] as unknown[][],
  sessionFetch: vi.fn()
}))

vi.mock('../../dao/settingsDao', () => ({
  settingsDao: {
    findByKey: (key: string) => h.settings.get(key),
    findAll: () => Object.fromEntries(h.settings),
    set: (...args: unknown[]) => void h.settingsWrites.push(args),
    upsert: (...args: unknown[]) => void h.settingsWrites.push(args)
  }
}))
vi.mock('../../dao/webSearchKeyDao', () => ({
  webSearchKeyDao: { find: h.find, set: h.set, delete: h.delete }
}))
vi.mock('../../logger', () => ({
  createLogger: () => {
    const level =
      (name: string) =>
      (...args: unknown[]) =>
        void h.logs.push([name, ...args])
    return {
      info: level('info'),
      warn: level('warn'),
      error: level('error'),
      debug: level('debug')
    }
  }
}))
vi.mock('../readPageRenderer', () => ({
  readUrlSession: () => ({ fetch: h.sessionFetch })
}))

import { WebSearchApiError } from '../../utils/toolUtils/webSearchApi'
import {
  configuredWebSearchProvider,
  deleteWebSearchKey,
  searchWithApi,
  setWebSearchKey,
  testWebSearchProvider,
  webSearchConfig
} from '../webSearchApiService'

const KEY = ['tvly', 'SECRETSECRET', '1234'].join('-')
const EXA_KEY = ['exa', 'ANOTHERSECRET', '9876'].join('-')
const TAVILY_URL = 'https://api.tavily.com/search'
const EXA_URL = 'https://api.exa.ai/search'

type FetchInit = RequestInit & { headers: Record<string, string>; body: string }

const respond = (
  status: number,
  json: unknown
): { status: number; json: () => Promise<unknown> } => ({
  status,
  json: async () => json
})
const results = (n: number): { results: Array<Record<string, string>> } => ({
  results: Array.from({ length: n }, (_, i) => ({
    title: `T${i + 1}`,
    url: `https://example.com/${i + 1}`,
    content: `C${i + 1}`
  }))
})
/** 一个假 fetch：回给定的回包 */
const fetchOf = (status: number, json: unknown): ReturnType<typeof vi.fn> =>
  vi.fn(async () => respond(status, json))
/** 一个假 fetch：signal 中止时以它的 reason 失败，否则一直挂着 */
const hangingFetch = (): ReturnType<typeof vi.fn> =>
  vi.fn(
    (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        const signal = init.signal as AbortSignal
        if (signal.aborted) return reject(signal.reason)
        signal.addEventListener('abort', () => reject(signal.reason))
      })
  )
const asFetch = (fn: ReturnType<typeof vi.fn>): never => fn as never

async function rejection(work: Promise<unknown>): Promise<unknown> {
  try {
    await work
  } catch (error) {
    return error
  }
  throw new Error('expected a rejection')
}
async function apiFailure(work: Promise<unknown>): Promise<WebSearchApiError> {
  const error = await rejection(work)
  expect(error).toBeInstanceOf(WebSearchApiError)
  return error as WebSearchApiError
}

const logText = (): string => JSON.stringify(h.logs)
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  h.settings.clear()
  h.keys.clear()
  h.settingsWrites.length = 0
  h.logs.length = 0
  for (const fn of [h.find, h.set, h.delete, h.sessionFetch]) fn.mockReset()
  h.find.mockImplementation((provider: string) => h.keys.get(provider) ?? '')
  h.set.mockImplementation((provider: string, key: string) => void h.keys.set(provider, key))
  h.delete.mockImplementation((provider: string) => void h.keys.delete(provider))
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('选的方式与设置页那一份', () => {
  it.each<[string | undefined, string]>([
    [undefined, 'browser'],
    ['browser', 'browser'],
    ['tavily', 'tavily'],
    ['exa', 'exa'],
    ['bing', 'browser'],
    ['', 'browser']
  ])('WS-1 webSearch.provider = %j → %s', (value, expected) => {
    if (value !== undefined) h.settings.set('webSearch.provider', value)
    expect(configuredWebSearchProvider()).toBe(expected)
  })

  it('WS-2 nothing set: browser, Google, no keys — and no other field', () => {
    expect(webSearchConfig()).toEqual({
      provider: 'browser',
      browserEngine: 'Google',
      keys: { tavily: { saved: false, last4: '' }, exa: { saved: false, last4: '' } }
    })
  })

  it('WS-3 last four of a key of eight or more; a short key is saved with none shown', () => {
    h.keys.set('tavily', KEY)
    h.keys.set('exa', 'short12')
    h.settings.set('browser.searchEngine', 'duckduckgo')
    h.settings.set('webSearch.provider', 'exa')
    const config = webSearchConfig()
    expect(config.provider).toBe('exa')
    expect(config.browserEngine).toBe('DuckDuckGo')
    expect(config.keys).toEqual({
      tavily: { saved: true, last4: '1234' },
      exa: { saved: true, last4: '' }
    })
  })

  it('WS-4 the config never carries a key, nor more than its last four characters', () => {
    h.keys.set('tavily', KEY)
    h.keys.set('exa', EXA_KEY)
    const text = JSON.stringify(webSearchConfig())
    for (const key of [KEY, EXA_KEY]) {
      expect(text).not.toContain(key)
      expect(text).not.toContain(key.slice(-5))
      expect(text).toContain(key.slice(-4))
    }
  })
})

describe('存 / 删密钥', () => {
  it('WS-5 setWebSearchKey trims, stores once and answers the config without the key', () => {
    const config = setWebSearchKey('tavily', `  ${KEY}\n`)
    expect(h.set).toHaveBeenCalledTimes(1)
    expect(h.set).toHaveBeenCalledWith('tavily', KEY)
    expect(config.keys.tavily).toEqual({ saved: true, last4: '1234' })
    expect(JSON.stringify(config)).not.toContain(KEY)
  })

  it.each([[''], ['   '], [undefined], [null], [123], [{}]])(
    'WS-6 an API key of %j is refused and nothing is stored',
    (apiKey) => {
      expect(() => setWebSearchKey('tavily', apiKey)).toThrow('The API key is empty')
      expect(h.set).not.toHaveBeenCalled()
    }
  )

  it.each([['browser'], ['google'], [''], [undefined], ['toString'], ['Tavily']])(
    'WS-7 provider %j is not a search API; the error does not carry the key',
    (provider) => {
      const work = (): unknown => setWebSearchKey(provider, KEY)
      expect(work).toThrow(/^Unknown search API: /)
      try {
        work()
      } catch (error) {
        expect((error as Error).message).not.toContain(KEY)
      }
      expect(h.set).not.toHaveBeenCalled()
    }
  )

  it('WS-8 a second key replaces the first; the other provider is untouched', () => {
    h.keys.set('exa', EXA_KEY)
    setWebSearchKey('tavily', KEY)
    const config = setWebSearchKey('tavily', ['tvly', 'REPLACEMENT', 'abcd'].join('-'))
    expect(config.keys.tavily).toEqual({ saved: true, last4: 'abcd' })
    expect(config.keys.exa).toEqual({ saved: true, last4: '9876' })
    expect(h.keys.get('exa')).toBe(EXA_KEY)
  })

  it('WS-9 deleteWebSearchKey: with a key, with none, and an unknown provider', () => {
    h.keys.set('exa', EXA_KEY)
    expect(deleteWebSearchKey('exa').keys.exa).toEqual({ saved: false, last4: '' })
    expect(h.delete).toHaveBeenCalledWith('exa')
    expect(() => deleteWebSearchKey('exa')).not.toThrow()
    h.delete.mockClear()
    expect(() => deleteWebSearchKey('browser')).toThrow(/^Unknown search API: /)
    expect(h.delete).not.toHaveBeenCalled()
  })

  it('WS-10 a key never goes to the settings table', () => {
    setWebSearchKey('tavily', KEY)
    deleteWebSearchKey('tavily')
    expect(h.settingsWrites).toEqual([])
  })
})

describe('searchWithApi', () => {
  it('WS-11 no key: a no-key failure and no request at all', async () => {
    const fetch = fetchOf(200, results(1))
    const error = await apiFailure(searchWithApi('tavily', 'q', 5, { fetch: asFetch(fetch) }))
    expect(error.kind).toBe('no-key')
    expect(error.provider).toBe('tavily')
    expect(fetch).not.toHaveBeenCalled()
    expect(h.sessionFetch).not.toHaveBeenCalled()
  })

  it('WS-12 Tavily: one POST with the stored key, the limit, no cookies and a signal', async () => {
    h.keys.set('tavily', KEY)
    const fetch = fetchOf(200, results(3))
    const out = await searchWithApi('tavily', 'rust async', 7, { fetch: asFetch(fetch) })
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0] as [string, FetchInit]
    expect(url).toBe(TAVILY_URL)
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe(`Bearer ${KEY}`)
    expect(JSON.parse(init.body)).toEqual({
      query: 'rust async',
      max_results: 7,
      search_depth: 'basic'
    })
    expect(init.credentials).toBe('omit')
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(out).toEqual([
      { title: 'T1', url: 'https://example.com/1', snippet: 'C1' },
      { title: 'T2', url: 'https://example.com/2', snippet: 'C2' },
      { title: 'T3', url: 'https://example.com/3', snippet: 'C3' }
    ])
  })

  it('WS-13 Exa: its endpoint, x-api-key and numResults', async () => {
    h.keys.set('exa', EXA_KEY)
    const fetch = fetchOf(200, results(1))
    await searchWithApi('exa', 'q', 4, { fetch: asFetch(fetch) })
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0] as [string, FetchInit]
    expect(url).toBe(EXA_URL)
    expect(init.headers['x-api-key']).toBe(EXA_KEY)
    expect(init.headers).not.toHaveProperty('Authorization')
    expect((JSON.parse(init.body) as { numResults: number }).numResults).toBe(4)
  })

  it("WS-14 without an injected fetch the request goes through read's network session", async () => {
    h.keys.set('tavily', KEY)
    h.sessionFetch.mockResolvedValue(respond(200, results(2)))
    const globalFetch = vi.spyOn(globalThis, 'fetch')
    const out = await searchWithApi('tavily', 'q', 5)
    expect(out).toHaveLength(2)
    expect(h.sessionFetch).toHaveBeenCalledTimes(1)
    const [url, init] = h.sessionFetch.mock.calls[0] as [string, FetchInit]
    expect(url).toBe(TAVILY_URL)
    expect(init.method).toBe('POST')
    expect(init.credentials).toBe('omit')
    expect(globalFetch).not.toHaveBeenCalled()
  })

  it.each<[number, unknown, string]>([
    [401, { detail: { error: 'Unauthorized' } }, 'bad-key'],
    [402, { error: 'credits exhausted' }, 'quota'],
    [432, { detail: { error: 'plan limit' } }, 'quota'],
    [429, { detail: { error: 'slow down' } }, 'rate-limit'],
    [500, { error: 'oops' }, 'http']
  ])('WS-15 status %i → %s, with exactly one request (no retry)', async (status, body, kind) => {
    h.keys.set('tavily', KEY)
    const fetch = fetchOf(status, body)
    const error = await apiFailure(searchWithApi('tavily', 'q', 5, { fetch: asFetch(fetch) }))
    expect(error.kind).toBe(kind)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(h.sessionFetch).not.toHaveBeenCalled()
  })

  it('WS-16 a key echoed by the vendor or by the transport reaches neither the error nor the log', async () => {
    h.keys.set('tavily', KEY)
    const echoed = await apiFailure(
      searchWithApi('tavily', 'q', 5, {
        fetch: asFetch(fetchOf(401, { detail: { error: `Invalid API key: ${KEY}` } }))
      })
    )
    expect(echoed.kind).toBe('bad-key')
    expect(echoed.message).not.toContain(KEY)
    expect(echoed.reason).not.toContain(KEY)

    const thrown = await apiFailure(
      searchWithApi('tavily', 'q', 5, {
        fetch: asFetch(vi.fn(async () => Promise.reject(new Error(`bad header Bearer ${KEY}`))))
      })
    )
    expect(thrown.kind).toBe('network')
    expect(thrown.message).not.toContain(KEY)
    expect(thrown.reason).not.toContain(KEY)
    expect(h.logs.length).toBeGreaterThan(0)
    expect(logText()).not.toContain(KEY)
  })

  it('WS-17 a body that is not JSON: 200 → shape, 502 → http naming 502', async () => {
    h.keys.set('tavily', KEY)
    const html = (status: number): ReturnType<typeof vi.fn> =>
      vi.fn(async () => ({
        status,
        json: async () => Promise.reject(new SyntaxError('Unexpected token <'))
      }))
    const ok = await apiFailure(searchWithApi('tavily', 'q', 5, { fetch: asFetch(html(200)) }))
    expect(ok.kind).toBe('shape')
    const bad = await apiFailure(searchWithApi('tavily', 'q', 5, { fetch: asFetch(html(502)) }))
    expect(bad.kind).toBe('http')
    expect(bad.reason).toContain('502')
  })

  it('WS-18 a transport failure is a network failure of that provider, logged once without the key', async () => {
    h.keys.set('exa', EXA_KEY)
    const fetch = vi.fn(async () => Promise.reject(new TypeError('fetch failed')))
    const error = await apiFailure(searchWithApi('exa', 'q', 5, { fetch: asFetch(fetch) }))
    expect(error.kind).toBe('network')
    expect(error.reason).toContain('Exa')
    expect(error.reason).toContain('fetch failed')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(h.logs).toHaveLength(1)
    expect(logText()).toContain('exa')
    expect(logText()).not.toContain(EXA_KEY)
  })

  it('WS-19 the request is given 20 s; running out of it is a network failure', async () => {
    h.keys.set('tavily', KEY)
    const clock = new AbortController()
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(clock.signal)
    let settled = false
    const work = apiFailure(
      searchWithApi('tavily', 'q', 5, { fetch: asFetch(hangingFetch()) })
    ).finally(() => {
      settled = true
    })
    await settle()
    expect(timeout).toHaveBeenCalledTimes(1)
    expect(timeout).toHaveBeenCalledWith(20_000)
    expect(settled).toBe(false)
    clock.abort(new DOMException('The operation timed out.', 'TimeoutError'))
    const error = await work
    expect(error.kind).toBe('network')
    expect(error.provider).toBe('tavily')
  })

  it("WS-20 the caller's abort is rethrown as is, and is not logged as an API failure", async () => {
    h.keys.set('tavily', KEY)
    const abort = new AbortController()
    const work = rejection(
      searchWithApi('tavily', 'q', 5, { signal: abort.signal, fetch: asFetch(hangingFetch()) })
    )
    await settle()
    const reason = new Error('stopped by the user')
    abort.abort(reason)
    const error = await work
    expect(error).toBe(reason)
    expect(error).not.toBeInstanceOf(WebSearchApiError)
    expect(h.logs).toEqual([])
  })

  it('WS-21 a signal that is already aborted ends with its reason, not a network failure', async () => {
    h.keys.set('tavily', KEY)
    const abort = new AbortController()
    const reason = new Error('already stopped')
    abort.abort(reason)
    const error = await rejection(
      searchWithApi('tavily', 'q', 5, { signal: abort.signal, fetch: asFetch(hangingFetch()) })
    )
    expect(error).toBe(reason)
    expect(error).not.toBeInstanceOf(WebSearchApiError)
  })

  it("WS-22 with a caller signal the request's signal follows it", async () => {
    h.keys.set('tavily', KEY)
    const abort = new AbortController()
    const fetch = fetchOf(200, results(1))
    const out = await searchWithApi('tavily', 'q', 5, {
      signal: abort.signal,
      fetch: asFetch(fetch)
    })
    expect(out).toHaveLength(1)
    const signal = (fetch.mock.calls[0] as [string, RequestInit])[1].signal as AbortSignal
    expect(signal.aborted).toBe(false)
    abort.abort(new Error('later'))
    expect(signal.aborted).toBe(true)
  })

  it('WS-23 no more results than the limit', async () => {
    h.keys.set('tavily', KEY)
    const out = await searchWithApi('tavily', 'q', 4, { fetch: asFetch(fetchOf(200, results(10))) })
    expect(out.map((r) => r.title)).toEqual(['T1', 'T2', 'T3', 'T4'])
  })

  it('WS-24 on success and on every failure, no result, error or log line carries the key', async () => {
    h.keys.set('tavily', KEY)
    const fetches = [
      fetchOf(200, results(2)),
      fetchOf(401, {}),
      fetchOf(402, {}),
      fetchOf(429, {}),
      fetchOf(500, {}),
      fetchOf(200, {}),
      vi.fn(async () => Promise.reject(new TypeError('fetch failed')))
    ]
    for (const fetch of fetches) {
      const outcome = await searchWithApi('tavily', 'q', 5, { fetch: asFetch(fetch) }).catch(
        (error: Error & { reason?: string }) => `${error.message} ${error.reason ?? ''}`
      )
      expect(JSON.stringify(outcome)).not.toContain(KEY)
    }
    expect(logText()).not.toContain(KEY)
  })
})

describe('testWebSearchProvider', () => {
  it('WS-25 one real search with the stored key; ok, count and ms — nothing else', async () => {
    h.keys.set('tavily', KEY)
    h.sessionFetch.mockResolvedValue(respond(200, results(5)))
    const result = await testWebSearchProvider('tavily')
    expect(result).toEqual({ ok: true, count: 5, ms: expect.any(Number) })
    expect((result as { ms: number }).ms).toBeGreaterThanOrEqual(0)
    expect(h.sessionFetch).toHaveBeenCalledTimes(1)
    const [url, init] = h.sessionFetch.mock.calls[0] as [string, FetchInit]
    expect(url).toBe(TAVILY_URL)
    expect(init.headers.Authorization).toBe(`Bearer ${KEY}`)
  })

  it('WS-26 an empty list still counts as working', async () => {
    h.keys.set('exa', EXA_KEY)
    h.sessionFetch.mockResolvedValue(respond(200, { results: [] }))
    expect(await testWebSearchProvider('exa')).toMatchObject({ ok: true, count: 0 })
  })

  it.each<[string, () => void]>([
    ['no key', () => h.keys.delete('tavily')],
    ['401', () => h.sessionFetch.mockResolvedValue(respond(401, { detail: { error: 'no' } }))],
    ['429', () => h.sessionFetch.mockResolvedValue(respond(429, {}))],
    ['a network failure', () => h.sessionFetch.mockRejectedValue(new TypeError('fetch failed'))],
    [
      'a 401 that echoes the key',
      () => h.sessionFetch.mockResolvedValue(respond(401, { error: `Invalid key ${KEY}` }))
    ]
  ])('WS-27 %s → {ok: false, error}: the reason only, no key', async (_label, arrange) => {
    h.keys.set('tavily', KEY)
    arrange()
    const result = await testWebSearchProvider('tavily')
    expect(Object.keys(result).sort()).toEqual(['error', 'ok'])
    expect(result.ok).toBe(false)
    const { error } = result as { error: string }
    expect(error).toContain('Tavily')
    expect(error).not.toContain('Tell the user')
    expect(error).not.toContain('do not call web_search')
    expect(error).not.toContain(KEY)
  })

  it.each([['browser'], ['google'], [undefined]])(
    'WS-28 %j is not a search API: rejects, no request',
    async (provider) => {
      await expect(testWebSearchProvider(provider)).rejects.toThrow(/^Unknown search API: /)
      expect(h.sessionFetch).not.toHaveBeenCalled()
    }
  )

  it('WS-29 the provider asked for is tested, whichever method is selected', async () => {
    h.settings.set('webSearch.provider', 'browser')
    h.keys.set('exa', EXA_KEY)
    h.sessionFetch.mockResolvedValue(respond(200, results(1)))
    expect(await testWebSearchProvider('exa')).toMatchObject({ ok: true, count: 1 })
    expect(h.sessionFetch.mock.calls[0][0]).toBe(EXA_URL)
  })
})
