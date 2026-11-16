/**
 * `web_search` 的纯数据一半（services/browser/searchResults.ts）：跳转地址解包、结果整理、成文、验证页判断、
 * 不透明跳转链接、页面里跑的取数脚本（Bing / DuckDuckGo 两段用手搭的假 DOM 跑；Google / 百度留给真页面）。
 *
 *   SR-1..6   unwrapResultUrl
 *   SR-7..11  cleanResults
 *   SR-12..14 formatResults / formatPageTextFallback
 *   SR-15..19 isVerificationPage
 *   SR-24     isOpaqueRedirect
 *   SR-20..23 SEARCH_PAGE_SCRIPT / SEARCH_PAGE_TEXT_SCRIPT
 */
import { describe, expect, it } from 'vitest'
import {
  cleanResults,
  formatPageTextFallback,
  formatResults,
  isOpaqueRedirect,
  isVerificationPage,
  PAGE_TEXT_FALLBACK_CHARS,
  SEARCH_PAGE_SCRIPT,
  SEARCH_PAGE_TEXT_SCRIPT,
  unwrapResultUrl,
  type SearchPageState
} from '../searchResults'

describe('unwrapResultUrl', () => {
  it('SR-1 Google /url?q= 与 url=，各国域名一样', () => {
    const target = 'https://example.com/a?b=1'
    const enc = encodeURIComponent(target)
    expect(unwrapResultUrl(`https://www.google.com/url?q=${enc}&sa=U`)).toBe(target)
    expect(unwrapResultUrl(`https://www.google.com/url?url=${enc}&sa=U`)).toBe(target)
    expect(unwrapResultUrl(`https://www.google.co.jp/url?q=${enc}`)).toBe(target)
    expect(unwrapResultUrl(`https://www.google.com.hk/url?q=${enc}`)).toBe(target)
  })

  it('SR-2 Google /url 里不是 http(s) 的目标、没有 q、不是 /url → 原样', () => {
    for (const raw of [
      'https://www.google.com/url?q=javascript:alert(1)',
      'https://www.google.com/url?q=/relative',
      'https://www.google.com/url',
      'https://www.google.com/search?q=https://x.com'
    ]) {
      expect(unwrapResultUrl(raw), raw).toBe(raw)
    }
  })

  it('SR-2b 不是 Google 的主机 → 原样', () => {
    for (const raw of [
      'https://google.evil.com/url?q=https://a.com',
      'https://notgoogle.com/url?q=https://a.com'
    ]) {
      expect(unwrapResultUrl(raw), raw).toBe(raw)
    }
  })

  it('SR-3 Bing /ck/a 的 u=a1<base64url>（含非 ASCII），cn.bing.com 一样', () => {
    // 这两个地址的 base64url 分别带 `_` 与 `-`（标准 base64 里是 `/` 与 `+`）
    const withUnderscore = 'https://example.com/搜索?q=é'
    const withDash = 'https://example.com/a?b=>>>'
    const a = Buffer.from(withUnderscore).toString('base64url')
    const b = Buffer.from(withDash).toString('base64url')
    expect(a).toContain('_')
    expect(b).toContain('-')
    expect(unwrapResultUrl(`https://www.bing.com/ck/a?!&&p=x&u=a1${a}&ntb=1`)).toBe(withUnderscore)
    expect(unwrapResultUrl(`https://www.bing.com/ck/a?u=a1${b}`)).toBe(withDash)
    expect(unwrapResultUrl(`https://cn.bing.com/ck/a?u=a1${a}`)).toBe(withUnderscore)
  })

  it('SR-4 Bing /ck/a 解不出 http(s) 地址 → 原样', () => {
    const plain = Buffer.from('https://example.com/').toString('base64url')
    const ftp = Buffer.from('ftp://x').toString('base64url')
    for (const raw of [
      `https://www.bing.com/ck/a?u=${plain}`,
      'https://www.bing.com/ck/a?u=a1%%%garbage',
      'https://www.bing.com/ck/a?u=a1!!!!',
      `https://www.bing.com/ck/a?u=a1${ftp}`,
      'https://www.bing.com/ck/a?p=1'
    ]) {
      expect(unwrapResultUrl(raw), raw).toBe(raw)
    }
  })

  it('SR-5 DuckDuckGo /l/?uddg=', () => {
    expect(
      unwrapResultUrl('https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2F&rut=x')
    ).toBe('https://example.com/')
    const bad = 'https://duckduckgo.com/l/?uddg=javascript%3Aalert(1)'
    expect(unwrapResultUrl(bad)).toBe(bad)
  })

  it('SR-6 百度 /link、普通地址、不是地址、Google /goto → 原样', () => {
    for (const raw of [
      'https://www.baidu.com/link?url=abc123',
      'https://example.com/page?x=1',
      'not a url',
      'https://www.google.com/goto?url=tok'
    ]) {
      expect(unwrapResultUrl(raw), raw).toBe(raw)
    }
  })
})

describe('cleanResults', () => {
  const item = (n: number): { title: string; url: string; snippet: string } => ({
    title: `T${n}`,
    url: `https://site${n}.example/`,
    snippet: `s${n}`
  })

  it('SR-7 不是数组 → []', () => {
    for (const raw of [undefined, null, 'x', 5, { length: 1 }]) {
      expect(cleanResults(raw, 8)).toEqual([])
    }
  })

  it('SR-8 丢掉不成形的项与不是 http(s) 的地址，保留大写协议', () => {
    const out = cleanResults(
      [
        null,
        'text',
        7,
        { title: '', url: 'https://a.com/' },
        { title: '   ', url: 'https://a.com/' },
        { url: 'https://a.com/' },
        { title: 'T', url: 5 },
        { title: 'T', url: 'javascript:alert(1)' },
        { title: 'T', url: 'file:///etc/passwd' },
        { title: 'T', url: 'about:blank' },
        { title: 'T', url: '//host/x' },
        { title: 'Kept', url: 'HTTP://EXAMPLE.com', snippet: 's' }
      ],
      8
    )
    expect(out).toEqual([{ title: 'Kept', url: 'HTTP://EXAMPLE.com', snippet: 's' }])
  })

  it('SR-9 trim 三个字段；snippet 不是字符串 → 空串', () => {
    expect(
      cleanResults(
        [
          { title: '  T  ', url: '  https://a.com/  ', snippet: '  s  ' },
          { title: 'U', url: 'https://b.com/', snippet: 42 },
          { title: 'V', url: 'https://c.com/' }
        ],
        8
      )
    ).toEqual([
      { title: 'T', url: 'https://a.com/', snippet: 's' },
      { title: 'U', url: 'https://b.com/', snippet: '' },
      { title: 'V', url: 'https://c.com/', snippet: '' }
    ])
  })

  it('SR-10 按解包后的地址去重（留第一条）；带 # 的算另一个地址', () => {
    const out = cleanResults(
      [
        { title: 'First', url: 'https://www.google.com/url?q=https%3A%2F%2Fa.com%2F' },
        { title: 'Second', url: 'https://a.com/' },
        { title: 'Third', url: 'https://a.com/#x' }
      ],
      8
    )
    expect(out.map((r) => [r.title, r.url])).toEqual([
      ['First', 'https://a.com/'],
      ['Third', 'https://a.com/#x']
    ])
  })

  it('SR-11 上限：按顺序取前 limit 条；重复与无效的不占名额', () => {
    const twelve = Array.from({ length: 12 }, (_, i) => item(i + 1))
    expect(cleanResults(twelve, 8).map((r) => r.title)).toEqual(
      ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8'].slice()
    )
    expect(cleanResults(twelve, 1)).toEqual([item(1)])
    const noisy = [item(1), item(1), null, { title: 'x', url: 'about:blank' }, item(2), item(3)]
    expect(cleanResults(noisy, 3).map((r) => r.title)).toEqual(['T1', 'T2', 'T3'])
  })
})

describe('formatResults / formatPageTextFallback', () => {
  it('SR-12 两条结果（一条没有摘要）的逐字文本', () => {
    expect(
      formatResults('q "x"', 'Google', [
        { title: 'T', url: 'https://a.com/', snippet: 'snippet' },
        { title: 'U', url: 'https://b.com/', snippet: '' }
      ])
    ).toBe(
      'Google results for "q \\"x\\"":\n\n1. T\n   https://a.com/\n   snippet\n\n2. U\n   https://b.com/'
    )
  })

  it('SR-12b 有 Google /goto 地址时结尾多一句说明；没有就不提 goto', () => {
    const withGoto = formatResults('q', 'Google', [
      { title: 'T', url: 'https://www.google.com/goto?url=tok', snippet: '' },
      { title: 'U', url: 'https://b.com/', snippet: '' }
    ])
    expect(
      withGoto.endsWith(
        "\n\nAddresses that start with https://www.google.com/goto are Google's own links to the result; opening one leads to the page."
      )
    ).toBe(true)
    const without = formatResults('q', 'Google', [
      { title: 'U', url: 'https://b.com/', snippet: '' }
    ])
    expect(without).not.toContain('goto')
  })

  it('SR-13 页面正文的退路：开头、页面地址、提示用 read；多余空行收成一行；首尾 trim', () => {
    const text = formatPageTextFallback(
      'q',
      '百度',
      'https://www.baidu.com/s?wd=q',
      '\n\n  line one\n\n\n\nline two\n\n\n'
    )
    expect(text.startsWith('The 百度 results page for "q" could not be split into results')).toBe(
      true
    )
    expect(text).toContain('(https://www.baidu.com/s?wd=q)')
    expect(text).toContain('open the page with read')
    expect(text.endsWith('\n\nline one\n\nline two')).toBe(true)
  })

  it('SR-14 退路的长度上限：6001 字截到 6000 + 标记；正好 6000 不截', () => {
    expect(PAGE_TEXT_FALLBACK_CHARS).toBe(6000)
    const over = formatPageTextFallback('q', 'Bing', 'https://b/', 'a'.repeat(6001))
    expect(over.endsWith(`\n\n${'a'.repeat(6000)}\n[…cut]`)).toBe(true)
    const exact = formatPageTextFallback('q', 'Bing', 'https://b/', 'a'.repeat(6000))
    expect(exact.endsWith(`\n\n${'a'.repeat(6000)}`)).toBe(true)
    expect(exact).not.toContain('[…cut]')
  })
})

describe('isVerificationPage', () => {
  const page = (over: Partial<SearchPageState>): SearchPageState => ({
    url: 'https://www.google.com/search?q=x',
    title: '',
    textLength: 100,
    head: '',
    results: [],
    ...over
  })
  const BY_ADDRESS = [
    'https://www.google.com/sorry/index?continue=https://www.google.com/search%3Fq%3Dx',
    'https://www.google.co.jp/sorry/index?continue=x',
    'https://www.bing.com/turing/captcha/challenge',
    'https://wappass.baidu.com/static/captcha/tuxing.html'
  ]
  const BY_TEXT = [
    'Our systems have detected unusual traffic from your computer network.',
    "I'm not a robot",
    '百度安全验证',
    'Unfortunately, bots use DuckDuckGo too.',
    '请完成人机验证后继续'
  ]

  it.each(BY_ADDRESS)('SR-15 按地址认：%s（正文再长也算）', (url) => {
    expect(isVerificationPage(page({ url }))).toBe(true)
    expect(isVerificationPage(page({ url, textLength: 5000 }))).toBe(true)
  })

  it.each(BY_TEXT)('SR-16 按正文开头认（短页面，不分大小写）：%s', (head) => {
    expect(isVerificationPage(page({ head }))).toBe(true)
    expect(isVerificationPage(page({ head: head.toUpperCase() }))).toBe(true)
  })

  it.each([
    ['https://www.google.com/search?q=not+a+robot', 'not a robot - Google Search'],
    ['https://www.bing.com/search?q=not+a+robot', 'not a robot - Search'],
    ['https://www.baidu.com/s?wd=not+a+robot', 'not a robot_百度搜索'],
    ['https://duckduckgo.com/?q=not+a+robot', 'not a robot at DuckDuckGo']
  ])('SR-17 字样只在标题里不算：%s', (url, title) => {
    expect(isVerificationPage(page({ url, title, head: 'All Images Videos News' }))).toBe(false)
  })

  it('SR-17b 长度界限：1500 字算，1501 字不算', () => {
    const head = "I'm not a robot"
    expect(isVerificationPage(page({ head, textLength: 1500 }))).toBe(true)
    expect(isVerificationPage(page({ head, textLength: 1501 }))).toBe(false)
  })

  it('SR-18 取到了结果的页面一律不算', () => {
    const results = [{ title: 'T', url: 'https://a.com/', snippet: '' }]
    for (const url of BY_ADDRESS)
      expect(isVerificationPage(page({ url, results })), url).toBe(false)
    for (const head of BY_TEXT)
      expect(isVerificationPage(page({ head, results })), head).toBe(false)
  })

  it('SR-19 反例', () => {
    expect(isVerificationPage(page({ head: 'About 1,000 results' }))).toBe(false)
    for (const url of [
      'about:blank',
      '',
      'https://www.google.com/search?q=sorry',
      'https://example.com/sorry/',
      'https://www.google.com/sorry',
      'https://www.google.com/sorryx',
      'https://google.evil.com/sorry/index'
    ]) {
      expect(isVerificationPage(page({ url })), url).toBe(false)
    }
  })
})

describe('isOpaqueRedirect', () => {
  it('SR-24 只认 Google 主机上的 /goto', () => {
    expect(isOpaqueRedirect('https://www.google.com/goto?url=tok')).toBe(true)
    expect(isOpaqueRedirect('https://www.google.co.uk/goto?url=tok')).toBe(true)
    for (const url of [
      'https://www.google.com/goto/x',
      'https://www.google.com/url?q=https://a.com',
      'https://google.evil.com/goto?url=tok',
      'https://example.com/goto?url=tok',
      'not a url'
    ]) {
      expect(isOpaqueRedirect(url), url).toBe(false)
    }
  })
})

// ─── 页面脚本：用手搭的假 document / location 跑 ─────────────────────

interface FakeEl {
  innerText?: string
  textContent?: string
  href?: string
  querySelector: (selector: string) => FakeEl | null
}
const el = (text: string, extra: Partial<FakeEl> = {}): FakeEl => ({
  innerText: text,
  querySelector: () => null,
  ...extra
})
/** 一个只认给定选择器的容器 */
const box = (children: Record<string, FakeEl | null>): FakeEl => ({
  innerText: '',
  querySelector: (selector) => children[selector] ?? null
})

interface FakeDocument {
  title: string
  body: { innerText: string } | null
  querySelectorAll: (selector: string) => FakeEl[]
}

function runScript(script: string, document: FakeDocument, href: string): unknown {
  const location = { href, hostname: new URL(href).hostname }
  return new Function('document', 'location', `return ${script}`)(document, location)
}

describe('SEARCH_PAGE_SCRIPT', () => {
  it('SR-20 Bing：两条 li.b_algo → 两条结果，空白收成一个空格；页面字段照填', () => {
    const body = `Results   for\n\n cats ${'x'.repeat(600)}`
    const document: FakeDocument = {
      title: 'cats - Search',
      body: { innerText: body },
      querySelectorAll: (selector) =>
        selector === 'li.b_algo'
          ? [
              box({
                'h2 a': el('  Cats \n  are   great ', { href: 'https://cats.example/' }),
                '.b_caption p, p': el('All\n\tabout   cats')
              }),
              box({
                'h2 a': el('Dogs', { href: 'https://dogs.example/' }),
                '.b_caption p, p': null
              })
            ]
          : []
    }
    const state = runScript(
      SEARCH_PAGE_SCRIPT,
      document,
      'https://www.bing.com/search?q=cats'
    ) as SearchPageState
    expect(state.results).toEqual([
      { title: 'Cats are great', url: 'https://cats.example/', snippet: 'All about cats' },
      { title: 'Dogs', url: 'https://dogs.example/', snippet: '' }
    ])
    expect(state.url).toBe('https://www.bing.com/search?q=cats')
    expect(state.title).toBe('cats - Search')
    expect(state.textLength).toBe(body.length)
    expect(state.head.length).toBeLessThanOrEqual(400)
    expect(state.head.startsWith('Results for cats x')).toBe(true)
  })

  it('SR-21 DuckDuckGo：自己的选择器；没有标题链接的跳过；摘要截到 300 字', () => {
    const TITLE = 'a[data-testid="result-title-a"]'
    const SNIPPET = '[data-result="snippet"]'
    const document: FakeDocument = {
      title: 'cats at DuckDuckGo',
      body: { innerText: 'short body' },
      querySelectorAll: (selector) =>
        selector === 'article[data-testid="result"]'
          ? [
              box({
                [TITLE]: el('Cats', { href: 'https://cats.example/' }),
                [SNIPPET]: el('y'.repeat(500))
              }),
              box({ [TITLE]: null, [SNIPPET]: el('orphan snippet') }),
              // textContent 的退路（innerText 没有）
              box({
                [TITLE]: {
                  textContent: ' Dogs ',
                  href: 'https://dogs.example/',
                  querySelector: () => null
                },
                [SNIPPET]: el('about dogs')
              })
            ]
          : []
    }
    const state = runScript(
      SEARCH_PAGE_SCRIPT,
      document,
      'https://duckduckgo.com/?q=cats'
    ) as SearchPageState
    expect(state.results).toEqual([
      { title: 'Cats', url: 'https://cats.example/', snippet: 'y'.repeat(300) },
      { title: 'Dogs', url: 'https://dogs.example/', snippet: 'about dogs' }
    ])
    expect(state.textLength).toBe('short body'.length)
    expect(state.head).toBe('short body')
  })

  it('SR-22 不认识的主机 → 没有结果；body 为 null、querySelectorAll 抛错也照样交回一个状态', () => {
    const unknown = runScript(
      SEARCH_PAGE_SCRIPT,
      { title: 'Example', body: { innerText: 'hello' }, querySelectorAll: () => [el('x')] },
      'https://example.com/search?q=x'
    ) as SearchPageState
    expect(unknown).toEqual({
      url: 'https://example.com/search?q=x',
      title: 'Example',
      textLength: 5,
      head: 'hello',
      results: []
    })

    const noBody = runScript(
      SEARCH_PAGE_SCRIPT,
      { title: '', body: null, querySelectorAll: () => [] },
      'https://www.bing.com/search?q=x'
    ) as SearchPageState
    expect(noBody.textLength).toBe(0)
    expect(noBody.head).toBe('')
    expect(noBody.results).toEqual([])

    const throwing = runScript(
      SEARCH_PAGE_SCRIPT,
      {
        title: 'T',
        body: { innerText: 'body text' },
        querySelectorAll: () => {
          throw new Error('boom')
        }
      },
      'https://www.bing.com/search?q=x'
    ) as SearchPageState
    expect(throwing.results).toEqual([])
    expect(throwing.textLength).toBe(9)
    expect(throwing.title).toBe('T')
  })

  it('SR-23 SEARCH_PAGE_TEXT_SCRIPT：body.innerText；没有 body → 空串', () => {
    const base = { title: '', querySelectorAll: () => [] }
    expect(
      runScript(
        SEARCH_PAGE_TEXT_SCRIPT,
        { ...base, body: { innerText: 'page text' } },
        'https://a.com/'
      )
    ).toBe('page text')
    expect(runScript(SEARCH_PAGE_TEXT_SCRIPT, { ...base, body: null }, 'https://a.com/')).toBe('')
  })
})
