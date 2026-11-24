/**
 * 商业搜索 API 的请求与回包（utils/toolUtils/webSearchApi.ts）—— 纯函数，不 mock。
 *
 *   WA-1..3   请求：端点、鉴权头（Tavily 是 Bearer，Exa 是 x-api-key）、请求体；密钥只在头里
 *   WA-4..16  结果：摘要取哪一段、只留 http(s) 地址、去重、条数、标题、空白压平、摘要不截、形状不对
 *   WA-17..24 失败的归类与那句给模型的话
 *   WA-25     密钥不进任何消息（服务方回显、网络层报错）
 *
 * 密钥是运行时拼出来的假值。
 */
import { describe, expect, it } from 'vitest'
import {
  WebSearchApiError,
  buildApiSearchRequest,
  missingKeyError,
  networkError,
  parseApiSearchResponse,
  withoutKey
} from '../webSearchApi'

type Provider = 'tavily' | 'exa'
const PROVIDERS: Provider[] = ['tavily', 'exa']
const NAME: Record<Provider, string> = { tavily: 'Tavily', exa: 'Exa' }
const KEY = ['tvly', 'SECRETSECRET', '1234'].join('-')

const parse = (body: unknown, limit = 10, provider: Provider = 'tavily'): unknown =>
  parseApiSearchResponse(provider, 200, body, limit)

/** 一次失败的调用抛出来的错 */
function failure(fn: () => unknown): WebSearchApiError {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(WebSearchApiError)
    return error as WebSearchApiError
  }
  throw new Error('expected a WebSearchApiError')
}

const item = (n: number, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  title: `T${n}`,
  url: `https://example.com/${n}`,
  content: `C${n}`,
  ...over
})

describe('请求', () => {
  it('WA-1 Tavily: POST, Bearer key, {query, max_results, search_depth}', () => {
    const { url, init } = buildApiSearchRequest('tavily', 'rust async', 5, KEY)
    expect(url).toBe('https://api.tavily.com/search')
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe(`Bearer ${KEY}`)
    expect(init.headers['Content-Type']).toBe('application/json')
    expect(init.headers).not.toHaveProperty('x-api-key')
    expect(JSON.parse(init.body)).toEqual({
      query: 'rust async',
      max_results: 5,
      search_depth: 'basic'
    })
  })

  it('WA-2 Exa: POST, x-api-key, {query, numResults, type, contents.highlights}', () => {
    const { url, init } = buildApiSearchRequest('exa', 'rust async', 5, KEY)
    expect(url).toBe('https://api.exa.ai/search')
    expect(init.method).toBe('POST')
    expect(init.headers['x-api-key']).toBe(KEY)
    expect(init.headers['Content-Type']).toBe('application/json')
    expect(init.headers).not.toHaveProperty('Authorization')
    expect(JSON.parse(init.body)).toEqual({
      query: 'rust async',
      numResults: 5,
      type: 'auto',
      contents: { highlights: true }
    })
  })

  it.each(PROVIDERS)('WA-3 %s: the query round-trips; the key is in headers only', (provider) => {
    const query = 'say "hi"\nto 東京 café'
    const { url, init } = buildApiSearchRequest(provider, query, 3, KEY)
    expect((JSON.parse(init.body) as { query: string }).query).toBe(query)
    expect(init.body).not.toContain(KEY)
    expect(url).not.toContain(KEY)
  })
})

describe('结果', () => {
  it('WA-4 Tavily results map to {title, url, snippet} in order, nothing else', () => {
    const body = { results: [1, 2, 3].map((n) => item(n, { score: 0.5 })) }
    expect(parse(body)).toEqual([
      { title: 'T1', url: 'https://example.com/1', snippet: 'C1' },
      { title: 'T2', url: 'https://example.com/2', snippet: 'C2' },
      { title: 'T3', url: 'https://example.com/3', snippet: 'C3' }
    ])
  })

  it('WA-5 Exa: the snippet is the highlights joined, not summary / text', () => {
    const [r] = parse(
      {
        results: [
          {
            title: 'T',
            url: 'https://a.example',
            highlights: ['alpha', 'beta'],
            summary: 'SUMMARY',
            text: 'TEXT'
          }
        ]
      },
      10,
      'exa'
    ) as Array<{ snippet: string }>
    expect(r.snippet.indexOf('alpha')).toBe(0)
    expect(r.snippet.indexOf('beta')).toBeGreaterThan(0)
    expect(r.snippet).not.toContain('SUMMARY')
    expect(r.snippet).not.toContain('TEXT')
  })

  it('WA-6 Exa fallbacks: summary, then text, non-string highlights skipped, none → empty', () => {
    const results = parse(
      {
        results: [
          { title: 'a', url: 'https://a.example', highlights: [], summary: 'SUM' },
          { title: 'b', url: 'https://b.example', text: 'TXT' },
          { title: 'c', url: 'https://c.example', highlights: [1, null, 'x'] },
          { title: 'd', url: 'https://d.example' }
        ]
      },
      10,
      'exa'
    ) as Array<{ snippet: string }>
    expect(results.map((r) => r.snippet)).toEqual(['SUM', 'TXT', 'x', ''])
  })

  it('WA-7 content wins over highlights, summary and text', () => {
    const [r] = parse({
      results: [item(1, { content: 'CONTENT', highlights: ['H'], summary: 'S', text: 'X' })]
    }) as Array<{ snippet: string }>
    expect(r.snippet).toBe('CONTENT')
  })

  it('WA-8 only http(s) addresses are kept (trimmed)', () => {
    const urls = [
      'https://a',
      'http://b',
      'HTTPS://C',
      'ftp://d',
      'javascript:alert(1)',
      '//e.com',
      '',
      undefined,
      42,
      ' https://f '
    ]
    const results = parse({
      results: urls.map((url, i) => ({ title: `t${i}`, url, content: 'c' }))
    }) as Array<{ url: string }>
    expect(results.map((r) => r.url)).toEqual(['https://a', 'http://b', 'HTTPS://C', 'https://f'])
  })

  it('WA-9 a repeated address keeps its first occurrence', () => {
    const results = parse({
      results: [item(1), item(1, { title: 'other' }), item(2)]
    }) as Array<{ title: string; url: string }>
    expect(results.map((r) => [r.title, r.url])).toEqual([
      ['T1', 'https://example.com/1'],
      ['T2', 'https://example.com/2']
    ])
  })

  it('WA-10 the limit counts kept results only', () => {
    const ten = { results: Array.from({ length: 10 }, (_, i) => item(i + 1)) }
    expect((parse(ten, 3) as unknown[]).length).toBe(3)
    expect((parse(ten, 3) as Array<{ title: string }>).map((r) => r.title)).toEqual([
      'T1',
      'T2',
      'T3'
    ])
    const mixed = {
      results: [item(1), item(1), item(3, { url: 'ftp://x' }), item(4), item(5)]
    }
    expect((parse(mixed, 3) as Array<{ title: string }>).map((r) => r.title)).toEqual([
      'T1',
      'T4',
      'T5'
    ])
  })

  it('WA-11 a missing / blank / non-string title becomes the address; a title is trimmed', () => {
    const results = parse({
      results: [
        { url: 'https://a.example', content: 'c' },
        { title: '', url: 'https://b.example' },
        { title: '   ', url: 'https://c.example' },
        { title: 7, url: 'https://d.example' },
        { title: '  Padded \n', url: 'https://e.example' }
      ]
    }) as Array<{ title: string }>
    expect(results.map((r) => r.title)).toEqual([
      'https://a.example',
      'https://b.example',
      'https://c.example',
      'https://d.example',
      'Padded'
    ])
  })

  it('WA-12 whitespace in a snippet collapses to single spaces', () => {
    const [r] = parse({ results: [item(1, { content: '  a\t\tb\n\n c    d \n' })] }) as Array<{
      snippet: string
    }>
    expect(r.snippet).toBe('a b c d')
  })

  it('WA-13 a snippet is not cut, whatever its length', () => {
    const snippetOf = (content: string): string =>
      (parse({ results: [item(1, { content })] }) as Array<{ snippet: string }>)[0].snippet
    for (const length of [300, 301, 5000]) {
      const long = Array.from({ length }, (_, i) => String(i % 10)).join('')
      const snippet = snippetOf(long)
      expect(snippet).toBe(long)
      expect(snippet.endsWith('…')).toBe(false)
    }
  })

  it('WA-14 entries that are not objects are skipped', () => {
    const results = parse({
      results: [null, 'text', 3, [item(9)], item(1), undefined, item(2)]
    }) as Array<{ title: string }>
    expect(results.map((r) => r.title)).toEqual(['T1', 'T2'])
  })

  it('WA-15 an empty list is an empty result, not an error', () => {
    expect(parse({ results: [] })).toEqual([])
  })

  it.each<[string, number, unknown]>([
    ['undefined', 200, undefined],
    ['null', 200, null],
    ['a string', 200, 'text'],
    ['{}', 200, {}],
    ['results null', 200, { results: null }],
    ['results object', 200, { results: {} }],
    ['results string', 200, { results: 'x' }],
    ['204 without a body', 204, undefined]
  ])('WA-16 2xx with %s → shape', (_label, status, body) => {
    for (const provider of PROVIDERS) {
      const error = failure(() => parseApiSearchResponse(provider, status, body, 5))
      expect(error.kind).toBe('shape')
      expect(error.provider).toBe(provider)
      expect(error.reason).toContain(NAME[provider])
    }
  })
})

describe('失败', () => {
  const STATUS_KINDS: Array<[number, string]> = [
    [401, 'bad-key'],
    [403, 'bad-key'],
    [402, 'quota'],
    [432, 'quota'],
    [433, 'quota'],
    [429, 'rate-limit'],
    [400, 'http'],
    [404, 'http'],
    [500, 'http'],
    [503, 'http'],
    [199, 'http'],
    [300, 'http'],
    [302, 'http']
  ]
  it.each(STATUS_KINDS)('WA-17 status %i → %s', (status, kind) => {
    for (const provider of PROVIDERS) {
      const error = failure(() => parseApiSearchResponse(provider, status, {}, 5))
      expect(error).toBeInstanceOf(Error)
      expect(error.name).toBe('WebSearchApiError')
      expect(error.kind).toBe(kind)
      expect(error.provider).toBe(provider)
      expect(error.reason).toContain(NAME[provider])
      expect(error.reason).toContain(String(status))
    }
  })

  it.each<[Provider, number, unknown, string]>([
    [
      'tavily',
      401,
      { detail: { error: 'Unauthorized: missing or invalid API key.' } },
      'Unauthorized: missing or invalid API key.'
    ],
    ['exa', 402, { error: 'credits exhausted', tag: 'X' }, 'credits exhausted'],
    ['tavily', 400, { detail: 'plain string' }, 'plain string'],
    ['exa', 500, { message: 'm-sentence' }, 'm-sentence'],
    // detail 是个没有 error 的对象：退到回包自己的 error / message
    ['tavily', 400, { detail: {}, error: 'outer error' }, 'outer error'],
    ['tavily', 400, { detail: { code: 1 }, message: 'outer message' }, 'outer message']
  ])('WA-18 %s %i: the vendor sentence is in the reason and the message', (p, s, body, text) => {
    const error = failure(() => parseApiSearchResponse(p, s, body, 5))
    expect(error.reason).toContain(text)
    expect(error.message).toContain(text)
  })

  it.each<[string, unknown]>([
    ['undefined', undefined],
    ['html', '<html><body>Bad gateway</body></html>'],
    ['{}', {}],
    ['detail {}', { detail: {} }],
    ['nested error', { error: { nested: 1 } }]
  ])('WA-19 an error body of %s leaves no garbage in the reason', (_label, body) => {
    const error = failure(() => parseApiSearchResponse('tavily', 500, body, 5))
    expect(error.kind).toBe('http')
    expect(error.reason).not.toContain('undefined')
    expect(error.reason).not.toContain('[object Object]')
    expect(error.reason).not.toContain('<html>')
    expect(error.reason.endsWith('.')).toBe(true)
  })

  it('WA-20 at most 200 characters of vendor text, whitespace collapsed', () => {
    const head = 'a'.repeat(100)
    const text = `${head}\n\n${'b'.repeat(99)}TAIL${'c'.repeat(4800)}`
    const error = failure(() => parseApiSearchResponse('exa', 500, { error: text }, 5))
    expect(error.reason).toContain(`${head} ${'b'.repeat(99)}`)
    expect(error.reason).not.toContain('\n')
    expect(error.reason).not.toContain('TAIL')
    expect(error.message).not.toContain('TAIL')
    expect(error.message).not.toContain('ccc')
  })

  it('WA-21 the message is the reason plus what the model should do', () => {
    const errors = [
      missingKeyError('tavily'),
      networkError('exa', new Error('x')),
      failure(() => parseApiSearchResponse('tavily', 401, {}, 5)),
      failure(() => parseApiSearchResponse('exa', 429, {}, 5)),
      failure(() => parseApiSearchResponse('exa', 200, {}, 5))
    ]
    for (const error of errors) {
      const name = NAME[error.provider]
      expect(error.message.startsWith(error.reason)).toBe(true)
      const rest = error.message.slice(error.reason.length)
      expect(rest).toContain(`The user chose ${name} for web search`)
      expect(rest).toContain('Settings → LLM tools → web_search')
      expect(rest).toContain('does not switch to another search method')
      expect(rest).toContain('Tell the user')
      expect(rest).toContain('do not call web_search again this turn')
      expect(error.reason).not.toContain('Tell the user')
      expect(error.reason).not.toContain('web_search')
    }
  })

  it('WA-22 a non-2xx status wins over a body that has results', () => {
    const error = failure(() => parseApiSearchResponse('tavily', 401, { results: [item(1)] }, 5))
    expect(error.kind).toBe('bad-key')
  })

  it.each(PROVIDERS)('WA-23 missingKeyError(%s)', (provider) => {
    const error = missingKeyError(provider)
    expect(error).toBeInstanceOf(WebSearchApiError)
    expect(error.kind).toBe('no-key')
    expect(error.provider).toBe(provider)
    expect(error.reason).toBe(`No API key is saved for ${NAME[provider]}, so nothing was searched.`)
    expect(error.message).toContain('Tell the user')
  })

  it('WA-24 networkError: kind, provider name, whitespace collapsed, long text clipped', () => {
    const a = networkError('exa', new Error('fetch failed\n  ECONNREFUSED'))
    expect(a.kind).toBe('network')
    expect(a.provider).toBe('exa')
    expect(a.reason).toContain('Exa')
    expect(a.reason).toContain('fetch failed ECONNREFUSED')

    expect(networkError('exa', 'boom').reason).toContain('boom')

    const long = networkError('tavily', new Error(`${'z'.repeat(160)}OVER${'y'.repeat(836)}`))
    expect(long.reason).toContain('z'.repeat(160))
    expect(long.reason).not.toContain('OVER')
    expect(long.message).not.toContain('OVER')
  })
})

describe('密钥不进消息', () => {
  it('WA-25 a key echoed by the vendor or by the transport is removed', () => {
    const rejected = failure(() =>
      parseApiSearchResponse(
        'tavily',
        401,
        { detail: { error: `Invalid API key: ${KEY}` } },
        5,
        KEY
      )
    )
    expect(rejected.kind).toBe('bad-key')
    expect(rejected.reason).toContain('Invalid API key:')
    expect(rejected.reason).not.toContain(KEY)
    expect(rejected.message).not.toContain(KEY)

    const exa = failure(() =>
      parseApiSearchResponse('exa', 500, { error: `key ${KEY} twice ${KEY}` }, 5, KEY)
    )
    expect(exa.message).not.toContain(KEY)

    const network = networkError('tavily', new Error(`bad header Bearer ${KEY}`), KEY)
    expect(network.reason).toContain('bad header Bearer')
    expect(network.reason).not.toContain(KEY)
    expect(network.message).not.toContain(KEY)
  })

  it('WA-25 withoutKey: every occurrence goes; no key, or a very short one, changes nothing', () => {
    expect(withoutKey(`a ${KEY} b ${KEY}`, KEY)).toBe('a [key] b [key]')
    expect(withoutKey('plain text', KEY)).toBe('plain text')
    expect(withoutKey('plain text', undefined)).toBe('plain text')
    expect(withoutKey('plain text', '')).toBe('plain text')
    expect(withoutKey('abc abc', 'abc')).toBe('abc abc')
  })
})
