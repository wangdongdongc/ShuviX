/**
 * read 工具的 URL 分支（urlFetch.ts）。fetch / render 是注入的桩；转换器默认是真的 markitdown ——
 * 「什么东西交给它、它的报错不外泄」靠它真实的行为才算数（它的错误信息里带着响应体，xlsx 分支把任何字节当表格读）。
 * 要看「交给转换器的那份响应长什么样」时才换成 spy。
 *
 * AbortSignal.timeout 不受假时钟驱动：超时用例 spy 它，换成手里一个 controller 的 signal。
 * 桩的响应流要在 init.signal 中止时报错，和真的 fetch 一样，否则读响应体的那一步永远等不到。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MarkItDown } from 'markitdown-ts'
import {
  charsetOf,
  chromeUserAgent,
  classifyBody,
  decodeBody,
  describeFailure,
  MAX_RESPONSE_BYTES,
  readUrlContent,
  SELF_DECLARED_USER_AGENT,
  URL_FETCH_TIMEOUT_MS,
  visibleTextLength,
  type ReadUrlOptions,
  type UrlConverter,
  type UrlFetch,
  type UrlRenderer
} from '../urlFetch'

const URL_ = 'https://example.test/page'
const CHROME_UA = 'Mozilla/5.0 (test) Chrome/142.0.0.0 Safari/537.36'
const ABORTED = 'Aborted'
const HTML = 'text/html; charset=utf-8'
const SECRET = 'SECRET-BODY-MARKER'
const HINT = 'Calling read again will not help'
const NOTE_START = 'Note: the page returned very little text.'

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

/** GBK 的「中文」；Node 的 TextEncoder 只会 UTF-8，手写字节 */
const GBK_ZHONGWEN = [0xd6, 0xd0, 0xce, 0xc4]
/** Shift_JIS 的「テスト」 */
const SJIS_TESUTO = [0x83, 0x65, 0x83, 0x58, 0x83, 0x67]

/** 响应体一律给字节：给字符串时 Response 会自己添一个 text/plain 类型 */
function respond(
  body: string | Uint8Array | null,
  contentType?: string,
  init: { status?: number; headers?: Record<string, string> } = {}
): Response {
  const headers = new Headers(init.headers)
  if (contentType) headers.set('content-type', contentType)
  const bytes = typeof body === 'string' ? utf8(body) : body
  return new Response(bytes as BodyInit | null, { status: init.status ?? 200, headers })
}

/** 可见文字恰好 n 个字符的页面 */
const page = (n: number, ch = 'a'): string =>
  `<!doctype html><html><head><title>T</title></head><body><p>${ch.repeat(n)}</p></body></html>`

/** 可见文字恰好 chars 个字符、总字节数恰好 bytes 的页面（多的全在 script 里，转换器不要它） */
function paddedPage(chars: number, bytes: number): string {
  const open = '<!doctype html><html><head><title>T</title><script>'
  const close = `</script></head><body><p>${'a'.repeat(chars)}</p></body></html>`
  return open + 'x'.repeat(bytes - open.length - close.length) + close
}

/** 没有可见文字的页面（一个 SPA 的空壳） */
const EMPTY_PAGE =
  '<!doctype html><html><head><title>T</title></head><body><div id="root"></div></body></html>'

const realConvert: UrlConverter = (response) => new MarkItDown().convert(response)

function fetchSeq(...responses: Array<Response | Error>): ReturnType<typeof vi.fn<UrlFetch>> {
  let i = 0
  return vi.fn<UrlFetch>(async () => {
    const next = responses[Math.min(i++, responses.length - 1)]
    if (next instanceof Error) throw next
    return next
  })
}

function options(fetch: UrlFetch, overrides: Partial<ReadUrlOptions> = {}): ReadUrlOptions {
  return { fetch, convert: realConvert, userAgent: CHROME_UA, abortError: ABORTED, ...overrides }
}

const textOf = (result: { content: Array<{ type: string; text?: string }> }): string =>
  (result.content[0] as { text: string }).text

/** 一个什么都能看的转换器 spy：记下交给它的响应（类型、地址、正文） */
function spyConvert(
  markdown: string | null = '# ok',
  title: string | null = null
): {
  convert: ReturnType<typeof vi.fn<UrlConverter>>
  seen: Array<{ type: string | null; url: string; bytes: Buffer; disposition: string | null }>
} {
  const seen: Array<{
    type: string | null
    url: string
    bytes: Buffer
    disposition: string | null
  }> = []
  const convert = vi.fn<UrlConverter>(async (response) => {
    seen.push({
      type: response.headers.get('content-type'),
      url: response.url,
      disposition: response.headers.get('content-disposition'),
      bytes: Buffer.from(await response.clone().arrayBuffer())
    })
    return { title, markdown }
  })
  return { convert, seen }
}

/** 永不结束的响应流：init.signal 中止时报错；cancel 被记下 */
function stallingFetch(contentType = 'text/plain'): {
  fetch: UrlFetch
  started: Promise<void>
} {
  let markStarted: () => void = () => {}
  const started = new Promise<void>((r) => (markStarted = r))
  const fetch: UrlFetch = async (_url, init) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(utf8('partial'))
          markStarted()
          init.signal?.addEventListener('abort', () => controller.error(init.signal?.reason))
        }
      }),
      { headers: { 'content-type': contentType } }
    )
  return { fetch, started }
}

/** 永不回应的请求：init.signal 中止时拒绝 */
function hangingFetch(): { fetch: UrlFetch; started: Promise<void> } {
  let markStarted: () => void = () => {}
  const started = new Promise<void>((r) => (markStarted = r))
  const fetch: UrlFetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      markStarted()
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
    })
  return { fetch, started }
}

/** 换掉 AbortSignal.timeout；手里的 controller 中止 = 超时到了 */
function controlledTimeout(): AbortController {
  const controller = new AbortController()
  vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)
  return controller
}

beforeEach(() => {
  // markitdown 转换失败时自己往控制台写
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('chromeUserAgent', () => {
  it.each([
    ['darwin', 'Macintosh; Intel Mac OS X 10_15_7'],
    ['win32', 'Windows NT 10.0; Win64; x64'],
    ['linux', 'X11; Linux x86_64']
  ] as const)('%s：只留主版本号，没有 Electron / ShuviX', (platform, os) => {
    const ua = chromeUserAgent(platform, '142.0.7444.59')
    expect(ua).toBe(
      `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36`
    )
    expect(ua).not.toMatch(/Electron|ShuviX/)
  })
})

describe('请求', () => {
  it('UF-R1 请求头、缓存、凭据、signal', async () => {
    const fetch = fetchSeq(respond('{}', 'application/json'))
    const signal = new AbortController().signal
    await readUrlContent(URL_, options(fetch, { acceptLanguage: 'zh-CN,en;q=0.8', signal }))

    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe(URL_)
    expect(init.cache).toBe('no-store')
    expect(init.credentials).toBe('include')
    expect(init.signal).toBeInstanceOf(AbortSignal)
    const headers = init.headers as Record<string, string>
    expect(headers['User-Agent']).toBe(CHROME_UA)
    expect(headers['Accept']).toBe(
      'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    )
    expect(headers['Accept-Language']).toBe('zh-CN,en;q=0.8')
  })

  it('UF-R2 没给语言就不带 Accept-Language', async () => {
    const fetch = fetchSeq(respond('{}', 'application/json'))
    await readUrlContent(URL_, options(fetch))
    expect(fetch.mock.calls[0][1].headers).not.toHaveProperty('Accept-Language')
  })

  it('UF-R3 403 时用自报身份的 UA 重试一次，成功就用它', async () => {
    const render = vi.fn<UrlRenderer>(async () => null)
    const fetch = fetchSeq(respond('no', HTML, { status: 403 }), respond(page(500), HTML))
    const result = await readUrlContent(URL_, options(fetch, { render }))

    expect(fetch).toHaveBeenCalledTimes(2)
    const uaOf = (i: number): string =>
      (fetch.mock.calls[i][1].headers as Record<string, string>)['User-Agent']
    expect(uaOf(0)).toBe(CHROME_UA)
    expect(uaOf(1)).toBe(SELF_DECLARED_USER_AGENT)
    expect(textOf(result)).toContain('a'.repeat(500))
    expect(render).not.toHaveBeenCalled()
  })

  it('UF-R4 重试过的 403 不再重试第三次；第一次响应的流被取消', async () => {
    const cancel = vi.fn()
    const first = new Response(
      new ReadableStream<Uint8Array>({
        pull: (c) => c.enqueue(utf8('x')),
        cancel
      }),
      { status: 403 }
    )
    const fetch = fetchSeq(first, respond('no', HTML, { status: 403 }))
    await expect(readUrlContent(URL_, options(fetch))).rejects.toThrow('HTTP 403')
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it.each([401, 404, 429, 451, 500, 503])('UF-R5 %d 不重试', async (status) => {
    const fetch = fetchSeq(respond('no', HTML, { status }))
    await expect(readUrlContent(URL_, options(fetch))).rejects.toThrow(`HTTP ${status}`)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('UF-R6 重试之后是别的状态：按那个状态报，不说成 403', async () => {
    const fetch = fetchSeq(
      respond('no', HTML, { status: 403 }),
      respond('no', HTML, { status: 404 })
    )
    const render = vi.fn<UrlRenderer>(async () => null)
    await expect(readUrlContent(URL_, options(fetch, { render }))).rejects.toThrow(
      new Error(`HTTP 404 from ${URL_}.`)
    )
    expect(render).not.toHaveBeenCalled()
  })
})

describe('编码', () => {
  it.each([
    ['UTF-8 BOM 胜过响应头', [0xef, 0xbb, 0xbf, 0x41], 'text/html; charset=gbk', 'utf-8'],
    ['UTF-16LE BOM', [0xff, 0xfe, 0x41, 0], 'text/plain; charset=gbk', 'utf-16le'],
    ['UTF-16BE BOM', [0xfe, 0xff, 0, 0x41], '', 'utf-16be']
  ])('UF-C1 %s', (_name, bytes, contentType, expected) => {
    expect(charsetOf(Uint8Array.from(bytes), contentType)).toBe(expected)
  })

  it('UF-C2 响应头胜过 meta，带引号也认', () => {
    const body = utf8('<meta charset="big5">')
    expect(charsetOf(body, 'text/html; charset=gbk')).toBe('gbk')
    expect(charsetOf(body, 'text/html; charset="gbk"')).toBe('gbk')
  })

  it.each([
    ['<meta charset>', '<html><meta charset="gbk">', 'text/html', 'gbk'],
    ['不带引号', '<meta charset=gbk>', 'text/html', 'gbk'],
    [
      'http-equiv 写法',
      '<meta http-equiv="Content-Type" content="text/html; charset=gbk">',
      'text/html',
      'gbk'
    ],
    ['XML 声明', `<?xml version="1.0" encoding="gbk"?><a/>`, 'application/xml', 'gbk'],
    ['+xml 的 XML 声明', `<?xml version='1.0' encoding='gbk'?><a/>`, 'application/rss+xml', 'gbk'],
    ['没有类型时也看文档', '<meta charset="gbk">', '', 'gbk'],
    ['octet-stream 也看文档', '<meta charset="gbk">', 'application/octet-stream', 'gbk']
  ])('UF-C3 文档内声明：%s', (_name, body, contentType, expected) => {
    expect(charsetOf(utf8(body), contentType)).toBe(expected)
  })

  it.each([
    ['JSON 正文里的 charset= 字样', '{"html":"<meta charset=gbk>"}', 'application/json'],
    ['纯文本里的', '<meta charset=gbk>', 'text/plain'],
    ['都没有', '<p>x</p>', 'text/html'],
    ['都没有也没类型', 'x', '']
  ])('UF-C4 回到 UTF-8：%s', (_name, body, contentType) => {
    expect(charsetOf(utf8(body), contentType)).toBe('utf-8')
  })

  it('UF-C5 4096 字节之后的 meta 不算', () => {
    const body = utf8(`<html><!-- ${'x'.repeat(5000)} --><meta charset="gbk">`)
    expect(charsetOf(body, 'text/html')).toBe('utf-8')
  })

  it('UF-C6 不认识的编码名按 UTF-8 解', () => {
    expect(decodeBody(utf8('中文'), 'text/plain; charset=x-no-such-charset')).toBe('中文')
  })

  it('UF-C7 GBK 页面（响应头声明）经真转换器不乱码', async () => {
    const body = Buffer.concat([
      Buffer.from('<html><body><p>'),
      Buffer.from(GBK_ZHONGWEN),
      Buffer.from('</p></body></html>')
    ])
    const result = await readUrlContent(
      URL_,
      options(fetchSeq(respond(body, 'text/html; charset=gbk')))
    )
    expect(textOf(result)).toContain('中文')
    expect(textOf(result)).not.toContain('�')
  })

  it('UF-C8 Shift_JIS 页面（只有 meta 声明）不乱码，交给转换器的已是 UTF-8', async () => {
    const body = Buffer.concat([
      Buffer.from('<html><head><meta charset="shift_jis"></head><body><p>'),
      Buffer.from(SJIS_TESUTO),
      Buffer.from('</p></body></html>')
    ])
    const { convert, seen } = spyConvert()
    await readUrlContent(URL_, options(fetchSeq(respond(body, 'text/html')), { convert }))
    expect(seen[0].type).toBe('text/html; charset=utf-8')
    expect(seen[0].bytes.toString('utf-8')).toContain('テスト')

    const real = await readUrlContent(URL_, options(fetchSeq(respond(body, 'text/html'))))
    expect(textOf(real)).toContain('テスト')
  })

  it('UF-C9 原样返回的文本也按声明的编码解', async () => {
    const result = await readUrlContent(
      URL_,
      options(fetchSeq(respond(Uint8Array.from(GBK_ZHONGWEN), 'text/plain; charset=gbk')))
    )
    expect(textOf(result)).toBe(`URL: ${URL_} (text/plain)\n\n中文`)
  })

  it('UF-C10 UTF-16 的 JSON（BOM）解对，BOM 不留在结果里', async () => {
    const body = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('{"a":1}', 'utf16le')])
    const result = await readUrlContent(URL_, options(fetchSeq(respond(body, 'application/json'))))
    expect(textOf(result)).toBe(`URL: ${URL_} (application/json)\n\n{"a":1}`)
  })
})

describe('classifyBody', () => {
  it.each([
    ['text/html', 'html'],
    ['TEXT/HTML; charset=utf-8', 'html'],
    ['application/xhtml+xml', 'html'],
    ['text/plain', 'text'],
    ['text/css', 'text'],
    ['text/csv', 'text'],
    ['application/json', 'text'],
    ['application/problem+json', 'text'],
    ['application/rss+xml', 'text'],
    ['image/svg+xml', 'text'],
    ['application/xml', 'text'],
    ['application/javascript', 'text'],
    ['application/yaml', 'text'],
    ['application/x-ndjson', 'text'],
    ['application/pdf', 'binary'],
    ['image/png', 'binary'],
    ['application/zip', 'binary']
  ])('UF-K1 %s → %s（只看类型，不看内容）', (contentType, kind) => {
    expect(classifyBody(contentType, utf8('whatever'))).toBe(kind)
  })

  describe.each([[''], ['application/octet-stream'], ['binary/octet-stream']])(
    '类型 %j 时看内容',
    (contentType) => {
      it('UF-K2 HTML 嗅探：doctype / <html> / 前面有注释和空白，大小写不论', () => {
        for (const body of [
          '<!doctype html><p>',
          '<!DOCTYPE HTML>',
          '  \n<html lang="en">',
          '<HTML>',
          '<!-- a --><!-- b -->\n<html>',
          '<!-- a\nb -->  <!doctype html>'
        ]) {
          expect(classifyBody(contentType, utf8(body)), body).toBe('html')
        }
      })

      it('UF-K3 片段和看着像的不算 HTML', () => {
        for (const body of ['<div>x</div>', '<htmlish>', 'text <html>', '{"a":1}', '']) {
          expect(classifyBody(contentType, utf8(body)), body).toBe('text')
        }
      })

      it('UF-K4 NUL 且没有 BOM → 二进制', () => {
        expect(classifyBody(contentType, Uint8Array.from([0x41, 0, 0x42]))).toBe('binary')
      })

      it('UF-K5 带 BOM 时 NUL 不算（UTF-16 文本）', () => {
        const body = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hello', 'utf16le')])
        expect(classifyBody(contentType, body)).toBe('text')
      })

      it('UF-K6 不合法的 UTF-8 → 二进制', () => {
        expect(classifyBody(contentType, Uint8Array.from([0x41, 0xff, 0xfe, 0x42]))).toBe('binary')
      })

      it('UF-K7 合法的多字节文本 → 文本', () => {
        expect(classifyBody(contentType, utf8('中文 テスト'))).toBe('text')
      })

      it('UF-K8 文档内声明的编码也算数：GBK 字节不是二进制', () => {
        const body = Buffer.concat([
          Buffer.from('<html><meta charset="gbk">'),
          Buffer.from(GBK_ZHONGWEN)
        ])
        expect(classifyBody(contentType, body)).toBe('html')
      })

      it('UF-K9 样本截断在一个多字节字符中间：不算非法', () => {
        const body = Buffer.concat([Buffer.alloc(8191, 0x61), Buffer.from('中'), Buffer.from('b')])
        expect(classifyBody(contentType, body)).toBe('text')
      })

      it('UF-K10 没有截断：结尾半个字符就是非法', () => {
        const body = Buffer.concat([Buffer.alloc(8191, 0x61), Buffer.from('中').subarray(0, 1)])
        expect(body.length).toBe(8192)
        expect(classifyBody(contentType, body)).toBe('binary')
      })

      it('UF-K11 样本之内的非法字节，后面再多也是二进制', () => {
        const body = Buffer.concat([Buffer.from([0xff]), Buffer.alloc(20_000, 0x61)])
        expect(classifyBody(contentType, body)).toBe('binary')
      })

      it('UF-K12 样本之外的 NUL 不看', () => {
        const body = Buffer.concat([Buffer.alloc(8192, 0x61), Buffer.from([0])])
        expect(classifyBody(contentType, body)).toBe('text')
      })
    }
  )

  it('UF-K13 响应头声明的编码也算数（octet-stream; charset=gbk）', () => {
    expect(
      classifyBody('application/octet-stream; charset=gbk', Uint8Array.from(GBK_ZHONGWEN))
    ).toBe('text')
  })

  it('UF-K14 声明的编码不认识：按 UTF-8 严格判', () => {
    expect(classifyBody('application/octet-stream; charset=nope', utf8('中文'))).toBe('text')
    expect(classifyBody('application/octet-stream; charset=nope', Uint8Array.from([0xff]))).toBe(
      'binary'
    )
  })
})

describe('HTML 与转换器', () => {
  it('UF-H1 结果头、标题、details', async () => {
    const result = await readUrlContent(
      URL_,
      options(
        fetchSeq(
          respond('<html><head><title>Hello</title></head><body><h1>Hi</h1></body></html>', HTML)
        )
      )
    )
    expect(textOf(result)).toBe(`URL: ${URL_} — Hello — converted to Markdown\n\n# Hi`)
    expect(result.details).toEqual({
      type: 'read',
      format: 'URL',
      converted: true,
      truncated: false,
      url: URL_
    })
  })

  it('UF-H2 没有标题就不写标题那一段', async () => {
    const result = await readUrlContent(
      URL_,
      options(fetchSeq(respond('<html><body><h1>Hi</h1></body></html>', HTML)))
    )
    expect(textOf(result)).toBe(`URL: ${URL_} — converted to Markdown\n\n# Hi`)
  })

  it('UF-H3 交给转换器：类型是 UTF-8 的 HTML，地址是请求的地址，content-disposition 带上', async () => {
    const { convert, seen } = spyConvert()
    const url = 'https://example.test/data.json'
    await readUrlContent(
      url,
      options(
        fetchSeq(
          respond('<html><p>x</p></html>', 'text/html', {
            headers: { 'content-disposition': 'inline; filename="a.html"' }
          })
        ),
        { convert }
      )
    )
    expect(convert).toHaveBeenCalledTimes(1)
    expect(seen[0].type).toBe('text/html; charset=utf-8')
    expect(seen[0].url).toBe(url)
    expect(seen[0].disposition).toBe('inline; filename="a.html"')
    expect(seen[0].bytes.toString('utf-8')).toBe('<html><p>x</p></html>')
  })

  it('UF-H4 没有类型但嗅探出 HTML：也走转换器', async () => {
    const result = await readUrlContent(
      URL_,
      options(fetchSeq(respond('<!-- c -->\n<html><body><h1>Hi</h1></body></html>')))
    )
    expect(textOf(result)).toContain('converted to Markdown')
    expect(textOf(result)).toContain('# Hi')
  })

  it('UF-H5 普通 HTML 不渲染', async () => {
    const render = vi.fn<UrlRenderer>(async () => ({ html: page(1000) }))
    await readUrlContent(URL_, options(fetchSeq(respond(page(500), HTML)), { render }))
    expect(render).not.toHaveBeenCalled()
  })
})

describe('其余文本原样返回', () => {
  const BODY = '  first\n\n\n<b>keep</b>   \t\n# not a heading\n\n'

  it.each([
    'application/json',
    'application/problem+json',
    'application/xml',
    'text/xml',
    'text/plain',
    'text/css',
    'text/csv',
    'text/yaml',
    'application/yaml',
    'application/javascript',
    'image/svg+xml'
  ])('UF-T1 %s：一个字节不改，converted=false，转换器碰都不碰', async (type) => {
    const { convert } = spyConvert()
    const render = vi.fn<UrlRenderer>(async () => ({ html: page(1000) }))
    const result = await readUrlContent(
      URL_,
      options(fetchSeq(respond(BODY, `${type}; charset=utf-8`)), { convert, render })
    )
    expect(textOf(result)).toBe(`URL: ${URL_} (${type})\n\n${BODY}`)
    expect(result.details).toEqual({
      type: 'read',
      format: 'URL',
      converted: false,
      truncated: false,
      url: URL_
    })
    expect(convert).not.toHaveBeenCalled()
    expect(render).not.toHaveBeenCalled()
  })

  it.each(['a.html', 'a.pdf', 'a.docx', 'a.xlsx', 'a.csv', 'feed.xml', 'a.zip'])(
    'UF-T2 地址的扩展名不算数（%s）',
    async (name) => {
      const { convert } = spyConvert()
      const url = `https://example.test/${name}`
      const result = await readUrlContent(
        url,
        options(fetchSeq(respond('{"a":1}', 'application/json')), { convert })
      )
      expect(textOf(result)).toBe(`URL: ${url} (application/json)\n\n{"a":1}`)
      expect(convert).not.toHaveBeenCalled()
    }
  )

  it('UF-T3 真转换器下 JSON 也不会被它吃掉', async () => {
    const result = await readUrlContent(
      URL_,
      options(fetchSeq(respond(`{"secret":"${SECRET}"}`, 'application/json')))
    )
    expect(textOf(result)).toBe(`URL: ${URL_} (application/json)\n\n{"secret":"${SECRET}"}`)
  })

  it('UF-T4 没有类型：头里不写类型', async () => {
    const result = await readUrlContent(URL_, options(fetchSeq(respond('<div>frag</div>'))))
    expect(textOf(result)).toBe(`URL: ${URL_}\n\n<div>frag</div>`)
    expect(result.details).toMatchObject({ converted: false })
  })

  it('UF-T5 octet-stream 的文本：头里写 octet-stream', async () => {
    const result = await readUrlContent(
      URL_,
      options(fetchSeq(respond('plain', 'application/octet-stream')))
    )
    expect(textOf(result)).toBe(`URL: ${URL_} (application/octet-stream)\n\nplain`)
  })

  it.each([
    ['空', ''],
    ['全是空白', ' \n\t ']
  ])('UF-T6 响应是%s的文本 → 一句话的错误，不渲染', async (_name, body) => {
    const render = vi.fn<UrlRenderer>(async () => ({ html: page(1000) }))
    await expect(
      readUrlContent(URL_, options(fetchSeq(respond(body, 'text/plain')), { render }))
    ).rejects.toThrow(new Error(`the response from ${URL_} is empty`))
    expect(render).not.toHaveBeenCalled()
  })

  it('UF-T7 204 没有响应体：同样是 empty', async () => {
    await expect(
      readUrlContent(URL_, options(fetchSeq(respond(null, undefined, { status: 204 }))))
    ).rejects.toThrow(new Error(`the response from ${URL_} is empty`))
  })
})

describe('feed 与 notebook', () => {
  const RSS =
    '<?xml version="1.0"?><rss version="2.0"><channel><title>Feed</title><item><title>A</title><description>D</description></item></channel></rss>'
  const ATOM =
    '<feed xmlns="http://www.w3.org/2005/Atom"><title>F</title><entry><title>E1</title><summary>S</summary></entry></feed>'
  const NOTEBOOK = JSON.stringify({
    cells: [
      { cell_type: 'markdown', source: ['# Note'] },
      { cell_type: 'code', source: ['print(1)'], outputs: [] }
    ],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5
  })

  it.each([
    ['RSS', RSS, 'application/rss+xml', '# Feed'],
    ['RSS（text/xml）', RSS, 'text/xml', '# Feed'],
    ['Atom', ATOM, 'application/atom+xml', '# F'],
    ['前面有注释和声明', `<?xml version="1.0"?>\n<!-- c -->\n${ATOM}`, 'application/xml', '# F']
  ])('UF-F1 %s 经真转换器成 Markdown', async (_name, body, type, heading) => {
    const result = await readUrlContent(URL_, options(fetchSeq(respond(body, type))))
    expect(textOf(result)).toContain('converted to Markdown')
    expect(textOf(result)).toContain(heading)
    expect(result.details).toMatchObject({ converted: true })
  })

  it('UF-F2 feed 交给转换器：application/xml，不带地址（扩展名不能盖过类型）', async () => {
    const { convert, seen } = spyConvert()
    await readUrlContent(
      'https://example.test/feed.html',
      options(fetchSeq(respond(RSS, 'application/rss+xml')), { convert })
    )
    expect(seen[0].type).toBe('application/xml; charset=utf-8')
    expect(seen[0].url).toBe('')
  })

  it('UF-F3 GBK 的 feed：声明的编码解开，交给转换器的是 UTF-8', async () => {
    const body = Buffer.concat([
      Buffer.from('<?xml version="1.0" encoding="gbk"?><rss version="2.0"><channel><title>'),
      Buffer.from(GBK_ZHONGWEN),
      Buffer.from('</title></channel></rss>')
    ])
    const { convert, seen } = spyConvert()
    await readUrlContent(URL_, options(fetchSeq(respond(body, 'application/xml')), { convert }))
    expect(seen[0].bytes.toString('utf-8')).toContain('中文')
  })

  it.each([
    ['别的 XML', '<?xml version="1.0"?><catalog><rss/></catalog>'],
    ['名字只是开头相同', '<rssfoo/>'],
    ['feedback', '<feedback/>'],
    ['正文里才有', 'see <rss> here']
  ])('UF-F4 %s 不是 feed：原样', async (_name, body) => {
    const { convert } = spyConvert()
    const result = await readUrlContent(
      URL_,
      options(fetchSeq(respond(body, 'application/xml')), { convert })
    )
    expect(textOf(result)).toBe(`URL: ${URL_} (application/xml)\n\n${body}`)
    expect(convert).not.toHaveBeenCalled()
  })

  it('UF-F5 feed 转不出来：退回原样返回', async () => {
    const convert = vi.fn<UrlConverter>(async () => {
      throw new Error('boom')
    })
    const result = await readUrlContent(
      URL_,
      options(fetchSeq(respond(RSS, 'application/rss+xml')), { convert })
    )
    expect(textOf(result)).toBe(`URL: ${URL_} (application/rss+xml)\n\n${RSS}`)
    expect(result.details).toMatchObject({ converted: false })
  })

  it.each(['https://example.test/a.ipynb', 'https://example.test/A.IPYNB?raw=1'])(
    'UF-N1 %s 经真转换器成 Markdown',
    async (url) => {
      const result = await readUrlContent(url, options(fetchSeq(respond(NOTEBOOK, 'text/plain'))))
      expect(textOf(result)).toContain('# Note')
      expect(textOf(result)).toContain('print(1)')
      expect(result.details).toMatchObject({ converted: true })
    }
  )

  it('UF-N2 notebook 交给转换器：application/json，带地址', async () => {
    const { convert, seen } = spyConvert()
    const url = 'https://example.test/a.ipynb'
    await readUrlContent(url, options(fetchSeq(respond(NOTEBOOK, 'text/plain')), { convert }))
    expect(seen[0].type).toBe('application/json; charset=utf-8')
    expect(seen[0].url).toBe(url)
  })

  it('UF-N3 .ipynb 只在查询串里：不是 notebook', async () => {
    const { convert } = spyConvert()
    const url = 'https://example.test/get?file=a.ipynb'
    const result = await readUrlContent(
      url,
      options(fetchSeq(respond('{"a":1}', 'application/json')), { convert })
    )
    expect(textOf(result)).toBe(`URL: ${url} (application/json)\n\n{"a":1}`)
    expect(convert).not.toHaveBeenCalled()
  })

  it('UF-N4 .ipynb 里其实不是 notebook：真转换器失败，退回原样', async () => {
    const url = 'https://example.test/a.ipynb'
    const body = `not json ${SECRET}`
    const result = await readUrlContent(url, options(fetchSeq(respond(body, 'text/plain'))))
    expect(textOf(result)).toBe(`URL: ${url} (text/plain)\n\n${body}`)
  })
})

describe('二进制', () => {
  const failed = (type: string, url = URL_): Error =>
    new Error(`could not convert ${type} from ${url}`)
  const pdf = utf8(`%PDF-1.4 ${SECRET}`)
  const zip = utf8(`PK\x03\x04 ${SECRET}`)
  const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), Buffer.from(SECRET)])

  it('UF-B1 %PDF 一律按 application/pdf 交给转换器，字节不动', async () => {
    const { convert, seen } = spyConvert('# Pdf text')
    const body = Buffer.concat([Buffer.from('%PDF-1.7\0'), Buffer.from([0xff, 0xfe])])
    const result = await readUrlContent(
      URL_,
      options(fetchSeq(respond(body, 'application/octet-stream')), { convert })
    )
    expect(seen[0].type).toBe('application/pdf')
    expect(seen[0].url).toBe(URL_)
    expect(seen[0].bytes.equals(body)).toBe(true)
    expect(textOf(result)).toContain('# Pdf text')
    expect(result.details).toMatchObject({ converted: true })
  })

  it.each([
    ['PK', zip, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['OLE', ole, 'application/msword']
  ])('UF-B2 %s 文件头：按声明的类型交给转换器', async (_name, body, type) => {
    const { convert, seen } = spyConvert()
    await readUrlContent(URL_, options(fetchSeq(respond(body, type)), { convert }))
    expect(seen[0].type).toBe(type)
  })

  it('UF-B3 PK 文件头、类型缺失：没有类型也交得出去（嗅探成二进制时）', async () => {
    const { convert, seen } = spyConvert()
    const body = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.from([0, 0, 0])])
    await readUrlContent(URL_, options(fetchSeq(respond(body)), { convert }))
    expect(seen[0].type).toBe('application/octet-stream')
  })

  it.each([
    ['PNG', Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]), 'image/png'],
    ['MP3', Buffer.from('ID3 audio'), 'audio/mpeg'],
    ['声明成 PDF 却没有文件头', Buffer.from(`not a pdf ${SECRET}`), 'application/pdf'],
    ['只有 3 个字节', Buffer.from('%PD'), 'application/pdf']
  ])('UF-B4 %s：转换器碰都不碰，一句话的错误', async (_name, body, type) => {
    const { convert } = spyConvert()
    await expect(
      readUrlContent(URL_, options(fetchSeq(respond(body, type)), { convert }))
    ).rejects.toThrow(failed(type))
    expect(convert).not.toHaveBeenCalled()
  })

  it('UF-B5 类型带参数：错误里只写类型本身', async () => {
    await expect(
      readUrlContent(URL_, options(fetchSeq(respond(Buffer.from([1, 2]), 'image/png; q=1'))))
    ).rejects.toThrow(failed('image/png'))
  })

  it('UF-B6 没有类型：unknown type', async () => {
    await expect(
      readUrlContent(URL_, options(fetchSeq(respond(Buffer.from([0x41, 0, 0x42])))))
    ).rejects.toThrow(failed('unknown type'))
  })

  it('UF-B7 octet-stream 的二进制：写 octet-stream', async () => {
    await expect(
      readUrlContent(
        URL_,
        options(fetchSeq(respond(Buffer.from([0, 1]), 'application/octet-stream')))
      )
    ).rejects.toThrow(failed('application/octet-stream'))
  })

  it.each([
    ['[ERROR] 占位', async () => ({ markdown: `[ERROR] Failed ${SECRET}` })],
    ['抛错', async () => Promise.reject(new Error(`Could not convert ${SECRET}`))],
    ['空的 markdown', async () => ({ markdown: '' })],
    ['只有空白', async () => ({ markdown: '  \n ' })],
    ['null', async () => null],
    ['undefined', async () => undefined]
  ])('UF-B8 转换器%s → 同一句错误', async (_name, impl) => {
    const convert = vi.fn(impl) as unknown as UrlConverter
    await expect(
      readUrlContent(URL_, options(fetchSeq(respond(pdf, 'application/pdf')), { convert }))
    ).rejects.toThrow(failed('application/pdf'))
  })

  it.each([
    ['假 PDF（真转换器抛错，错误里带着响应体）', pdf, 'application/pdf'],
    ['假 zip（真转换器回 [ERROR]，里面带着响应体）', zip, 'application/zip'],
    ['假 OLE', ole, 'application/msword']
  ])('UF-B9 %s：响应体绝不出现在错误里', async (_name, body, type) => {
    const error = await readUrlContent(URL_, options(fetchSeq(respond(body, type)))).catch(
      (e: Error) => e
    )
    expect((error as Error).message).toBe(`could not convert ${type} from ${URL_}`)
    expect((error as Error).message).not.toContain(SECRET)
    // cause 也不带
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(SECRET)
  })

  it('UF-B10 二进制不渲染', async () => {
    const render = vi.fn<UrlRenderer>(async () => ({ html: page(1000) }))
    await expect(
      readUrlContent(URL_, options(fetchSeq(respond(pdf, 'application/pdf')), { render }))
    ).rejects.toThrow(failed('application/pdf'))
    expect(render).not.toHaveBeenCalled()
  })

  it('UF-B11 文档转换成功时不留结果头以外的东西', async () => {
    const { convert } = spyConvert('Body', 'Doc')
    const result = await readUrlContent(
      URL_,
      options(fetchSeq(respond(pdf, 'application/pdf')), { convert })
    )
    expect(textOf(result)).toBe(`URL: ${URL_} — Doc — converted to Markdown\n\nBody`)
  })
})

describe('大小限制', () => {
  const TOO_LARGE = new Error('response is larger than the 5 MB limit')

  function chunked(
    chunks: number,
    size: number,
    headers: Record<string, string> = {}
  ): { response: Response; pulled: () => number; cancel: ReturnType<typeof vi.fn> } {
    let pulled = 0
    const cancel = vi.fn()
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (pulled >= chunks) return controller.close()
          pulled++
          controller.enqueue(new Uint8Array(size).fill(0x61))
        },
        cancel
      }),
      { headers: { 'content-type': 'text/plain', ...headers } }
    )
    return { response, pulled: () => pulled, cancel }
  }

  it('UF-S1 Content-Length 超过上限：不读响应体就失败', async () => {
    const { response, pulled, cancel } = chunked(10, 1024, {
      'content-length': String(MAX_RESPONSE_BYTES + 1)
    })
    await expect(readUrlContent(URL_, options(fetchSeq(response)))).rejects.toThrow(TOO_LARGE)
    expect(cancel).toHaveBeenCalledTimes(1)
    // ReadableStream 的默认高水位可能先拉一块；反正远不到 10 块
    expect(pulled()).toBeLessThanOrEqual(1)
  })

  it('UF-S2 Content-Length 恰好等于上限：不算超', async () => {
    const body = new Uint8Array(MAX_RESPONSE_BYTES).fill(0x61)
    const result = await readUrlContent(
      URL_,
      options(
        fetchSeq(
          respond(body, 'text/plain', { headers: { 'content-length': String(body.length) } })
        )
      )
    )
    expect(textOf(result).length).toBe(`URL: ${URL_} (text/plain)\n\n`.length + body.length)
  })

  it('UF-S3 没有 Content-Length：边读边数，超了就停', async () => {
    const mb = 1024 * 1024
    const { response, pulled, cancel } = chunked(50, mb)
    await expect(readUrlContent(URL_, options(fetchSeq(response)))).rejects.toThrow(TOO_LARGE)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(pulled()).toBeLessThan(10)
  })

  it('UF-S4 Content-Length 说得小（压缩后的大小）：仍按读到的字节数算', async () => {
    const { response } = chunked(7, 1024 * 1024, { 'content-length': '1000' })
    await expect(readUrlContent(URL_, options(fetchSeq(response)))).rejects.toThrow(TOO_LARGE)
  })

  it('UF-S5 恰好读到上限：不算超；多一个字节就超', async () => {
    const exact = new Uint8Array(MAX_RESPONSE_BYTES).fill(0x61)
    await expect(
      readUrlContent(URL_, options(fetchSeq(respond(exact, 'text/plain'))))
    ).resolves.toBeDefined()

    const over = new Uint8Array(MAX_RESPONSE_BYTES + 1).fill(0x61)
    await expect(
      readUrlContent(URL_, options(fetchSeq(respond(over, 'text/plain'))))
    ).rejects.toThrow(TOO_LARGE)
  })

  it('UF-S6 超限的响应体不进错误，也不会交给转换器、不渲染', async () => {
    const { convert } = spyConvert()
    const render = vi.fn<UrlRenderer>(async () => ({ html: page(1000) }))
    const { response } = chunked(7, 1024 * 1024)
    const error = await readUrlContent(
      URL_,
      options(fetchSeq(response), { convert, render })
    ).catch((e: Error) => e)
    expect((error as Error).message).toBe(TOO_LARGE.message)
    expect(convert).not.toHaveBeenCalled()
    expect(render).not.toHaveBeenCalled()
  })
})

describe('状态码', () => {
  const refusedMessage = (status: number): string =>
    `HTTP ${status} from ${URL_}. The site refused the request, often because it blocks automated clients. ${HINT}. If you have browser tools or can turn them on, open the page there; otherwise tell the user it could not be read.`

  it.each([401, 403, 503])('UF-V1 %d：渲染出够一页的正文就用它', async (status) => {
    const render = vi.fn<UrlRenderer>(async () => ({ html: page(300) }))
    const signal = new AbortController().signal
    const result = await readUrlContent(
      URL_,
      options(fetchSeq(respond('blocked', HTML, { status })), { render, signal })
    )
    expect(render).toHaveBeenCalledTimes(1)
    expect(render.mock.calls[0]).toEqual([URL_, signal])
    expect(textOf(result)).toBe(`URL: ${URL_} — T — converted to Markdown\n\n${'a'.repeat(300)}`)
    expect(result.details).toMatchObject({ converted: true })
  })

  it.each([401, 403, 503])(
    'UF-V2 %d：渲染出来不到 300 个字（验证页）→ 拒绝的错误',
    async (status) => {
      const render = vi.fn<UrlRenderer>(async () => ({ html: page(299) }))
      await expect(
        readUrlContent(URL_, options(fetchSeq(respond('blocked', HTML, { status })), { render }))
      ).rejects.toThrow(new Error(refusedMessage(status)))
    }
  )

  it.each([
    ['返回 null', async () => null],
    ['抛错', async () => Promise.reject(new Error(`render broke ${SECRET}`))],
    ['没有文字', async () => ({ html: EMPTY_PAGE })]
  ])('UF-V3 渲染%s → 拒绝的错误，不提渲染的原因', async (_name, impl) => {
    const render = vi.fn(impl) as unknown as UrlRenderer
    const error = await readUrlContent(
      URL_,
      options(fetchSeq(respond(SECRET, HTML, { status: 401 })), { render })
    ).catch((e: Error) => e)
    expect((error as Error).message).toBe(refusedMessage(401))
  })

  it('UF-V4 没有注入 render：拒绝的错误', async () => {
    await expect(
      readUrlContent(URL_, options(fetchSeq(respond('no', HTML, { status: 503 }))))
    ).rejects.toThrow(new Error(refusedMessage(503)))
  })

  it.each([429, 451])('UF-V5 %d：不渲染，拒绝的错误', async (status) => {
    const render = vi.fn<UrlRenderer>(async () => ({ html: page(1000) }))
    await expect(
      readUrlContent(URL_, options(fetchSeq(respond('no', HTML, { status })), { render }))
    ).rejects.toThrow(new Error(refusedMessage(status)))
    expect(render).not.toHaveBeenCalled()
  })

  it('UF-V6 拒绝的错误：有状态码、refused、不要再调、browser tools，没写具体工具名，没有响应体', async () => {
    const error = await readUrlContent(
      URL_,
      options(fetchSeq(respond(SECRET, HTML, { status: 429 })))
    ).catch((e: Error) => e)
    const message = (error as Error).message
    expect(message).toContain('429')
    expect(message).toContain('refused')
    expect(message).toContain(HINT)
    expect(message).toContain('browser tools')
    expect(message).not.toMatch(/mcp__|open_tab|navigate|snapshot|read_page|evaluate/)
    expect(message).not.toContain(SECRET)
  })

  it.each([400, 402, 404, 405, 410, 418, 500, 502, 504])(
    'UF-V7 %d：恰好一句 HTTP，不渲染',
    async (status) => {
      const render = vi.fn<UrlRenderer>(async () => ({ html: page(1000) }))
      const fetch = fetchSeq(respond(SECRET, HTML, { status }))
      const error = await readUrlContent(URL_, options(fetch, { render })).catch((e: Error) => e)
      expect((error as Error).message).toBe(`HTTP ${status} from ${URL_}.`)
      expect(render).not.toHaveBeenCalled()
    }
  )

  it('UF-V8 拒绝的响应体不读：流被取消', async () => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({ pull: (c) => c.enqueue(utf8('x')), cancel })
    await expect(
      readUrlContent(URL_, options(fetchSeq(new Response(body, { status: 404 }))))
    ).rejects.toThrow('HTTP 404')
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('UF-V9 403 两次都拒绝再渲染：两次请求 + 一次渲染，顺序对', async () => {
    const order: string[] = []
    const fetch = vi.fn<UrlFetch>(async () => {
      order.push('fetch')
      return respond('no', HTML, { status: 403 })
    })
    const render = vi.fn<UrlRenderer>(async () => {
      order.push('render')
      return { html: page(400) }
    })
    await readUrlContent(URL_, options(fetch, { render }))
    expect(order).toEqual(['fetch', 'fetch', 'render'])
  })

  it('UF-V10 渲染的 HTML 按 UTF-8 交给转换器，带请求的地址', async () => {
    const { convert, seen } = spyConvert('b'.repeat(400))
    const render = vi.fn<UrlRenderer>(async () => ({ html: '<html><p>中文</p></html>' }))
    await readUrlContent(
      URL_,
      options(fetchSeq(respond('no', HTML, { status: 503 })), { render, convert })
    )
    expect(seen[0].type).toBe('text/html; charset=utf-8')
    expect(seen[0].url).toBe(URL_)
    expect(seen[0].bytes.toString('utf-8')).toBe('<html><p>中文</p></html>')
  })

  it('UF-V11 只有链接地址和图片撑起来的长度不算正文', async () => {
    const links = Array.from(
      { length: 40 },
      (_, i) =>
        `<a href="https://example.test/${'x'.repeat(20)}${i}">l</a><img src="/i${i}.png" alt="">`
    ).join(' ')
    const render = vi.fn<UrlRenderer>(async () => ({
      html: `<html><body>${links}</body></html>`
    }))
    await expect(
      readUrlContent(URL_, options(fetchSeq(respond('no', HTML, { status: 403 })), { render }))
    ).rejects.toThrow(new Error(refusedMessage(403)))
  })
})

describe('空页面与几乎没字的页面', () => {
  const NO_TEXT = `the page at ${URL_} has no readable text. ${HINT}`

  describe('Markdown 是空的', () => {
    it('UF-E1 渲染出文字就用它；不到 300 字带 note', async () => {
      const render = vi.fn<UrlRenderer>(async () => ({ html: page(5) }))
      const result = await readUrlContent(
        URL_,
        options(fetchSeq(respond(EMPTY_PAGE, HTML)), { render })
      )
      expect(render).toHaveBeenCalledTimes(1)
      const text = textOf(result)
      expect(text.startsWith(`URL: ${URL_} — T — converted to Markdown\n\n${NOTE_START}`)).toBe(
        true
      )
      expect(text.endsWith('\n\naaaaa')).toBe(true)
    })

    it('UF-E2 渲染出够多的字：不带 note', async () => {
      const render = vi.fn<UrlRenderer>(async () => ({ html: page(300) }))
      const result = await readUrlContent(
        URL_,
        options(fetchSeq(respond(EMPTY_PAGE, HTML)), { render })
      )
      expect(textOf(result)).toBe(`URL: ${URL_} — T — converted to Markdown\n\n${'a'.repeat(300)}`)
    })

    it.each([
      ['渲染也是空的', async () => ({ html: EMPTY_PAGE })],
      ['返回 null', async () => null],
      ['抛错', async () => Promise.reject(new Error('window died'))]
    ])('UF-E3 %s → no readable text', async (_name, impl) => {
      const render = vi.fn(impl) as unknown as UrlRenderer
      const error = await readUrlContent(
        URL_,
        options(fetchSeq(respond(EMPTY_PAGE, HTML)), { render })
      ).catch((e: Error) => e)
      expect((error as Error).message.startsWith(NO_TEXT)).toBe(true)
      expect((error as Error).message).toContain('browser tools')
      expect((error as Error).message).not.toContain('window died')
    })

    it('UF-E4 没有注入 render：no readable text', async () => {
      await expect(
        readUrlContent(URL_, options(fetchSeq(respond(EMPTY_PAGE, HTML))))
      ).rejects.toThrow(NO_TEXT)
    })

    it('UF-E5 转换器抛错的 HTML 也算没拿到正文：错误里没有它的话', async () => {
      const convert = vi.fn<UrlConverter>(async () => {
        throw new Error(`could not ${SECRET}`)
      })
      const error = await readUrlContent(
        URL_,
        options(fetchSeq(respond(page(500), HTML)), { convert })
      ).catch((e: Error) => e)
      expect((error as Error).message.startsWith(NO_TEXT)).toBe(true)
      expect((error as Error).message).not.toContain(SECRET)
    })

    it('UF-E6 空的 HTML 响应（0 字节，类型是 HTML）也走这条', async () => {
      const render = vi.fn<UrlRenderer>(async () => null)
      await expect(
        readUrlContent(URL_, options(fetchSeq(respond(new Uint8Array(0), HTML)), { render }))
      ).rejects.toThrow(NO_TEXT)
      expect(render).toHaveBeenCalledTimes(1)
    })
  })

  describe('至少 4096 字节、不到 300 个字', () => {
    const THIN = paddedPage(20, 8000)
    it('UF-M1 渲染出更多的字（够 300）：用渲染的，不带 note', async () => {
      const render = vi.fn<UrlRenderer>(async () => ({ html: page(300, 'b') }))
      const result = await readUrlContent(URL_, options(fetchSeq(respond(THIN, HTML)), { render }))
      expect(textOf(result)).toBe(`URL: ${URL_} — T — converted to Markdown\n\n${'b'.repeat(300)}`)
    })

    it('UF-M2 渲染出更多的字（仍不够 300）：用渲染的，带 note', async () => {
      const render = vi.fn<UrlRenderer>(async () => ({ html: page(21, 'b') }))
      const result = await readUrlContent(URL_, options(fetchSeq(respond(THIN, HTML)), { render }))
      const text = textOf(result)
      expect(text).toContain(NOTE_START)
      expect(text.endsWith(`\n\n${'b'.repeat(21)}`)).toBe(true)
    })

    it.each([
      ['一样多', async () => ({ html: page(20, 'b') })],
      ['更少', async () => ({ html: page(3, 'b') })],
      ['没有文字', async () => ({ html: EMPTY_PAGE })],
      ['返回 null', async () => null],
      ['抛错', async () => Promise.reject(new Error('boom'))]
    ])('UF-M3 渲染%s：回抓到的页面，note 夹在头和正文之间', async (_name, impl) => {
      const render = vi.fn(impl) as unknown as UrlRenderer
      const result = await readUrlContent(URL_, options(fetchSeq(respond(THIN, HTML)), { render }))
      const text = textOf(result)
      expect(text.startsWith(`URL: ${URL_} — T — converted to Markdown\n\n${NOTE_START}`)).toBe(
        true
      )
      expect(text).toContain(HINT)
      expect(text.endsWith(`\n\n${'a'.repeat(20)}`)).toBe(true)
      expect(render).toHaveBeenCalledTimes(1)
    })

    it('UF-M4 没有注入 render：回抓到的页面，带 note', async () => {
      const result = await readUrlContent(URL_, options(fetchSeq(respond(THIN, HTML))))
      expect(textOf(result)).toContain(NOTE_START)
    })

    it('UF-M5 阈值：恰好 4096 字节、299 个字算；4095 字节不算', async () => {
      const render = vi.fn<UrlRenderer>(async () => null)
      const at = paddedPage(299, 4096)
      expect(Buffer.byteLength(at)).toBe(4096)
      const atResult = await readUrlContent(URL_, options(fetchSeq(respond(at, HTML)), { render }))
      expect(render).toHaveBeenCalledTimes(1)
      expect(textOf(atResult)).toContain(NOTE_START)

      render.mockClear()
      const below = paddedPage(299, 4095)
      const belowResult = await readUrlContent(
        URL_,
        options(fetchSeq(respond(below, HTML)), { render })
      )
      expect(render).not.toHaveBeenCalled()
      expect(textOf(belowResult)).not.toContain(NOTE_START)
    })

    it('UF-M6 阈值：够 300 个字就不算，再大也不渲染', async () => {
      const render = vi.fn<UrlRenderer>(async () => ({ html: page(1000, 'b') }))
      const result = await readUrlContent(
        URL_,
        options(fetchSeq(respond(paddedPage(300, 100_000), HTML)), { render })
      )
      expect(render).not.toHaveBeenCalled()
      expect(textOf(result)).not.toContain(NOTE_START)
      expect(textOf(result)).toContain('a'.repeat(300))
    })

    it('UF-M7 非 HTML 的短文本：不算几乎没字，不渲染', async () => {
      const render = vi.fn<UrlRenderer>(async () => ({ html: page(1000) }))
      const body = `${' '.repeat(10_000)}x`
      const result = await readUrlContent(
        URL_,
        options(fetchSeq(respond(body, 'text/plain')), { render })
      )
      expect(render).not.toHaveBeenCalled()
      expect(textOf(result)).not.toContain(NOTE_START)
    })

    it('UF-M8 feed 和文档转出来很短：也不算，不带 note', async () => {
      const render = vi.fn<UrlRenderer>(async () => ({ html: page(1000) }))
      const { convert } = spyConvert('short')
      const body = Buffer.concat([Buffer.from('%PDF-1.4\0'), Buffer.alloc(10_000, 0x20)])
      const result = await readUrlContent(
        URL_,
        options(fetchSeq(respond(body, 'application/pdf')), { render, convert })
      )
      expect(render).not.toHaveBeenCalled()
      expect(textOf(result)).not.toContain(NOTE_START)
    })
  })
})

describe('visibleTextLength', () => {
  it.each([
    ['纯文字', 'abc', 3],
    ['空白不算', ' a \n b\t', 2],
    ['图片不算', 'a![alt text](https://x.test/i.png)b', 2],
    ['链接只算文字', '[label](https://x.test/long/path)', 5],
    ['带 title 的链接', '[l](https://a.test/x "https://a.test/x")', 1],
    ['中文按字符算', '中文', 2],
    ['空', '', 0]
  ])('%s', (_name, markdown, length) => {
    expect(visibleTextLength(markdown)).toBe(length)
  })
})

describe('网络失败', () => {
  it('UF-W1 错误链展开：fetch failed <- 真正的原因（带 code）', async () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), {
      code: 'ECONNREFUSED'
    })
    const fetch = fetchSeq(new TypeError('fetch failed', { cause }))
    const error = (await readUrlContent(URL_, options(fetch)).catch((e: Error) => e)) as Error
    expect(error.message).toBe('fetch failed <- connect ECONNREFUSED 127.0.0.1:1 (ECONNREFUSED)')
    expect(error.cause).toBeInstanceOf(TypeError)
  })

  it('UF-W2 net::ERR_* 这种一层的错误原样', async () => {
    const fetch = fetchSeq(new Error('net::ERR_NAME_NOT_RESOLVED'))
    await expect(readUrlContent(URL_, options(fetch))).rejects.toThrow(
      new Error('net::ERR_NAME_NOT_RESOLVED')
    )
  })

  it('UF-W3 重试那一次失败也一样', async () => {
    const fetch = fetchSeq(respond('no', HTML, { status: 403 }), new Error('net::ERR_FAILED'))
    await expect(readUrlContent(URL_, options(fetch))).rejects.toThrow(new Error('net::ERR_FAILED'))
  })

  it('UF-W4 读响应体时断开：同样展开', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start: (c) => c.error(new Error('net::ERR_CONNECTION_RESET'))
    })
    await expect(readUrlContent(URL_, options(fetchSeq(new Response(stream))))).rejects.toThrow(
      new Error('net::ERR_CONNECTION_RESET')
    )
  })

  it('UF-W5 describeFailure：字符串 / 环形 cause / 深度封顶', () => {
    expect(describeFailure('boom')).toBe('boom')
    const a: Error & { cause?: unknown } = new Error('a')
    a.cause = a
    expect(describeFailure(a)).toBe('a <- a <- a <- a <- a')
    expect(describeFailure(new Error('x', { cause: new Error('y') }))).toBe('x <- y')
    expect(describeFailure(Object.assign(new Error('x'), { code: 7 }))).toBe('x')
  })
})

describe('超时', () => {
  const TIMED_OUT = new Error(`timed out after 30s: ${URL_}`)

  it('UF-O1 等响应头时超时', async () => {
    const timeout = controlledTimeout()
    const { fetch, started } = hangingFetch()
    const pending = readUrlContent(URL_, options(fetch))
    await started
    timeout.abort(new DOMException('timed out', 'TimeoutError'))
    await expect(pending).rejects.toThrow(TIMED_OUT)
    expect(AbortSignal.timeout).toHaveBeenCalledWith(URL_FETCH_TIMEOUT_MS)
    expect(URL_FETCH_TIMEOUT_MS).toBe(30_000)
  })

  it('UF-O2 读响应体时超时', async () => {
    const timeout = controlledTimeout()
    const { fetch, started } = stallingFetch()
    const pending = readUrlContent(URL_, options(fetch))
    await started
    timeout.abort(new DOMException('timed out', 'TimeoutError'))
    await expect(pending).rejects.toThrow(TIMED_OUT)
  })

  it('UF-O3 带着用户 signal 时超时也生效（两个 signal 合在一起）', async () => {
    const timeout = controlledTimeout()
    const { fetch, started } = hangingFetch()
    const pending = readUrlContent(URL_, options(fetch, { signal: new AbortController().signal }))
    await started
    timeout.abort(new DOMException('timed out', 'TimeoutError'))
    await expect(pending).rejects.toThrow(TIMED_OUT)
  })

  it('UF-O4 两个都到了：算用户中止', async () => {
    const timeout = controlledTimeout()
    const user = new AbortController()
    const { fetch, started } = hangingFetch()
    const pending = readUrlContent(URL_, options(fetch, { signal: user.signal }))
    await started
    user.abort()
    timeout.abort()
    await expect(pending).rejects.toThrow(new Error(ABORTED))
  })
})

describe('用户中止', () => {
  const abortedExactly = async (work: Promise<unknown>, message = ABORTED): Promise<void> => {
    const error = (await work.then(
      () => new Error('expected a rejection'),
      (e: Error) => e
    )) as Error
    expect(error.message).toBe(message)
  }

  it('UF-A1 已经中止：不发请求', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetch = fetchSeq(respond('x', 'text/plain'))
    await abortedExactly(readUrlContent(URL_, options(fetch, { signal: controller.signal })))
    expect(fetch).not.toHaveBeenCalled()
  })

  it('UF-A2 abortError 用调用方给的文字', async () => {
    const controller = new AbortController()
    controller.abort()
    await abortedExactly(
      readUrlContent(
        URL_,
        options(fetchSeq(respond('x')), { signal: controller.signal, abortError: 'Stopped' })
      ),
      'Stopped'
    )
  })

  it('UF-A3 等响应头时中止', async () => {
    const controller = new AbortController()
    const { fetch, started } = hangingFetch()
    const pending = readUrlContent(URL_, options(fetch, { signal: controller.signal }))
    await started
    controller.abort()
    await abortedExactly(pending)
  })

  it('UF-A4 读响应体时中止', async () => {
    const controller = new AbortController()
    const { fetch, started } = stallingFetch()
    const pending = readUrlContent(URL_, options(fetch, { signal: controller.signal }))
    await started
    controller.abort()
    await abortedExactly(pending)
  })

  /** render 收到 signal 之后按它的结局走；render 是在拒绝路径（403）上被调的 */
  const renderAborted = (
    outcome: () => Promise<{ html: string } | null>
  ): {
    controller: AbortController
    started: Promise<void>
    render: ReturnType<typeof vi.fn<UrlRenderer>>
  } => {
    const controller = new AbortController()
    let entered: () => void = () => {}
    const started = new Promise<void>((r) => (entered = r))
    const render = vi.fn<UrlRenderer>(async (_url, signal) => {
      entered()
      await new Promise<void>((resolve) =>
        signal?.addEventListener('abort', () => resolve(), { once: true })
      )
      return outcome()
    })
    return { controller, started, render }
  }

  it.each([
    ['回 null（真 renderPage 的样子）', async () => null],
    ['抛错', async () => Promise.reject(new Error('Object has been destroyed'))],
    ['还是把页面带回来了', async () => ({ html: page(1000) })]
  ])('UF-A5 拒绝路径上渲染时中止：渲染%s → 恰好是中止错误，不是 HTTP 403', async (_n, outcome) => {
    const { controller, started, render } = renderAborted(outcome)
    const { convert } = spyConvert()
    const pending = readUrlContent(
      URL_,
      options(fetchSeq(respond('no', HTML, { status: 403 })), {
        render,
        convert,
        signal: controller.signal
      })
    )
    await started
    controller.abort()
    await abortedExactly(pending)
    expect(convert).not.toHaveBeenCalled()
  })

  it('UF-A6 空页面渲染时中止：不是 no readable text', async () => {
    const { controller, started, render } = renderAborted(async () => null)
    const pending = readUrlContent(
      URL_,
      options(fetchSeq(respond(EMPTY_PAGE, HTML)), { render, signal: controller.signal })
    )
    await started
    controller.abort()
    await abortedExactly(pending)
  })

  it('UF-A7 几乎没字的页面渲染时中止：不回抓到的页面', async () => {
    const { controller, started, render } = renderAborted(async () => null)
    const pending = readUrlContent(
      URL_,
      options(fetchSeq(respond(paddedPage(20, 8000), HTML)), { render, signal: controller.signal })
    )
    await started
    controller.abort()
    await abortedExactly(pending)
  })

  const neverConvert = (): {
    convert: UrlConverter
    started: Promise<void>
  } => {
    let entered: () => void = () => {}
    const started = new Promise<void>((r) => (entered = r))
    return {
      started,
      convert: () => {
        entered()
        return new Promise(() => {})
      }
    }
  }

  it.each([
    ['HTML', page(500), HTML],
    ['二进制文档', Buffer.from('%PDF-1.4\0'), 'application/pdf'],
    ['feed', '<rss><channel/></rss>', 'application/rss+xml']
  ])('UF-A8 转换器永远不回（%s）时中止', async (_name, body, type) => {
    const controller = new AbortController()
    const { convert, started } = neverConvert()
    const pending = readUrlContent(
      URL_,
      options(fetchSeq(respond(body, type)), { convert, signal: controller.signal })
    )
    await started
    controller.abort()
    await abortedExactly(pending)
  })

  it('UF-A9 转换渲染结果时永远不回，中止', async () => {
    const controller = new AbortController()
    const { convert, started } = neverConvert()
    const pending = readUrlContent(
      URL_,
      options(fetchSeq(respond('no', HTML, { status: 503 })), {
        convert,
        render: async () => ({ html: page(400) }),
        signal: controller.signal
      })
    )
    await started
    controller.abort()
    await abortedExactly(pending)
  })

  it('UF-A10 转换器抛错的同时已中止：恰好是中止错误', async () => {
    const controller = new AbortController()
    const convert = vi.fn<UrlConverter>(async () => {
      controller.abort()
      throw new Error('conversion failed')
    })
    await abortedExactly(
      readUrlContent(
        URL_,
        options(fetchSeq(respond(page(500), HTML)), { convert, signal: controller.signal })
      )
    )
  })

  it('UF-A11 转换完才发现已中止：不返回结果', async () => {
    const controller = new AbortController()
    const convert = vi.fn<UrlConverter>(async () => {
      controller.abort()
      return { markdown: '# done' }
    })
    await abortedExactly(
      readUrlContent(
        URL_,
        options(fetchSeq(respond(page(500), HTML)), { convert, signal: controller.signal })
      )
    )
  })

  it('UF-A12 中止的错误里没有地址、没有 cause', async () => {
    const controller = new AbortController()
    const { fetch, started } = hangingFetch()
    const pending = readUrlContent(URL_, options(fetch, { signal: controller.signal }))
    await started
    controller.abort()
    const error = (await pending.catch((e: Error) => e)) as Error
    expect(error.message).toBe(ABORTED)
    expect(error.cause).toBeUndefined()
  })
})

describe('classifyBody：没有类型时的 PDF', () => {
  it.each(['', 'application/octet-stream'])('类型 %j、全是文本字节的 %%PDF 算二进制', (type) => {
    expect(classifyBody(type, Buffer.from('%PDF-1.4\nplain ascii body\n'))).toBe('binary')
  })
})
