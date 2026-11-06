/**
 * read 工具的 URL 分支：抓取 + 解码 + 转 Markdown，不依赖 Electron（fetch、转换器、渲染都由调用方注入）。
 *
 * 先直接请求。网站拒绝、页面是空的或几乎没有文字时，再交给 `render`（隐藏页面里跑一遍 JS）取渲染后的 HTML。
 *
 * 转换器（markitdown）只按 UTF-8 读字节，JSON / 非 feed 的 XML 一律转换失败且错误信息带着整个响应体，还会把
 * 文本压空行，把任何字节当表格读。所以只把它真能转的东西交给它：HTML（先按声明的编码转成 UTF-8）、feed、notebook
 * 和文件头对得上的文档；其余文本原样返回，其余二进制只报一句简短的错误。
 */

import type { ToolResult } from '@shuvix/agent-runtime'
import type { ReadToolDetails } from '@shuvix/chat-protocol/types/chatMessage'
import { untilAborted } from '../untilAborted'

/** 抓取超时（毫秒），响应体读取也算在内 */
export const URL_FETCH_TIMEOUT_MS = 30_000

/** 响应体上限（解压后的字节数） */
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024

/** 响应体至少这么大、可见文字却不到 THIN_PAGE_TEXT_CHARS，才认为页面正文很可能没拿到 */
const THIN_PAGE_MIN_BYTES = 4 * 1024
const THIN_PAGE_TEXT_CHARS = 300

/** Chrome UA 被 403 时重试用的 UA：如实说明是 ShuviX */
export const SELF_DECLARED_USER_AGENT = 'Mozilla/5.0 (compatible; ShuviX/1.0)'

/** 这些状态码多半是网站拒绝自动化客户端，同样的请求重试没有意义 */
const REFUSED_STATUSES = new Set([401, 403, 429, 451, 503])

/** 这些拒绝可能是要求先过一遍浏览器验证，值得渲染；429（限流）和 451（法律原因）换个方式请求也一样 */
const RENDERABLE_STATUSES = new Set([401, 403, 503])

/** 没有写工具名：read 也给拿不到浏览器工具的 agent 用，提示不能指向它用不了的东西 */
const NEEDS_BROWSER_HINT =
  'Calling read again will not help. If you have browser tools or can turn them on, open the page there; otherwise tell the user it could not be read.'

const THIN_PAGE_NOTE = `Note: the page returned very little text. It may need a login or a security check, so its real content may be missing. ${NEEDS_BROWSER_HINT}\n\n`

export type UrlFetch = (url: string, init: RequestInit) => Promise<Response>

export type UrlConverter = (response: Response) => Promise<
  | {
      title?: string | null
      markdown?: string | null
    }
  | null
  | undefined
>

/** 在隐藏页面里渲染，返回渲染后的 HTML；拿不到就返回 null */
export type UrlRenderer = (url: string, signal?: AbortSignal) => Promise<{ html: string } | null>

export interface ReadUrlOptions {
  fetch: UrlFetch
  convert: UrlConverter
  render?: UrlRenderer
  userAgent: string
  acceptLanguage?: string
  signal?: AbortSignal
  /** signal 中止时抛出的错误文字（工具层靠它识别「用户中止」） */
  abortError: string
}

/** 与内置 Chromium 版本一致的 Chrome UA（版本号按 UA reduction 只留主版本），TLS 指纹和它是对得上的 */
export function chromeUserAgent(platform: NodeJS.Platform, chromeVersion: string): string {
  const major = chromeVersion.split('.')[0]
  const os =
    platform === 'darwin'
      ? 'Macintosh; Intel Mac OS X 10_15_7'
      : platform === 'win32'
        ? 'Windows NT 10.0; Win64; x64'
        : 'X11; Linux x86_64'
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
}

export type BodyKind = 'html' | 'text' | 'binary'

const GENERIC_BINARY_TYPES = new Set(['application/octet-stream', 'binary/octet-stream'])

function baseTypeOf(contentType: string): string {
  return contentType.split(';')[0].trim().toLowerCase()
}

/** 按 Content-Type 分类；类型缺失或是通用二进制类型时才看内容 */
export function classifyBody(contentType: string, bytes: Uint8Array): BodyKind {
  const base = baseTypeOf(contentType)
  if (base === 'text/html' || base === 'application/xhtml+xml') return 'html'
  if (
    base.startsWith('text/') ||
    base.endsWith('+json') ||
    base.endsWith('+xml') ||
    /^application\/(json|xml|javascript|ecmascript|yaml|x-yaml|toml|x-ndjson|ndjson|graphql)$/.test(
      base
    )
  ) {
    return 'text'
  }
  if (base && !GENERIC_BINARY_TYPES.has(base)) return 'binary'

  const sample = bytes.subarray(0, 8192)
  // 没有二进制内容的 PDF 也能解码成文字，不能当文本原样返回
  if (Buffer.from(sample.subarray(0, 4)).toString('latin1') === '%PDF') return 'binary'
  if (!bomCharset(bytes) && sample.includes(0)) return 'binary'
  let decoded: string
  try {
    // 样本截断时末尾可能是半个多字节字符，不算非法；没截断时就是非法
    decoded = decoderFor(charsetOf(sample, contentType), true).decode(sample, {
      stream: bytes.length > sample.length
    })
  } catch {
    return 'binary'
  }
  return /^\s*(?:<!--[\s\S]*?-->\s*)*(?:<!doctype\s+html|<html[\s>])/i.test(decoded)
    ? 'html'
    : 'text'
}

function bomCharset(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8'
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le'
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be'
  return null
}

/** 优先级同 WHATWG：BOM > 响应头 > 文档内声明（HTML 的 meta、XML 的声明）；都没有就是 UTF-8 */
export function charsetOf(bytes: Uint8Array, contentType: string): string {
  const bom = bomCharset(bytes)
  if (bom) return bom
  const header = /charset\s*=\s*["']?([^\s;"']+)/i.exec(contentType)?.[1]
  if (header) return header
  const base = baseTypeOf(contentType)
  // JSON、纯文本等没有文档内声明；正文里恰好出现的 charset= 字样不算数
  const mayDeclare =
    !base || GENERIC_BINARY_TYPES.has(base) || base.includes('html') || base.includes('xml')
  if (!mayDeclare) return 'utf-8'
  const head = Buffer.from(bytes.subarray(0, 4096)).toString('latin1')
  const declared =
    /<meta\b[^>]*?\bcharset\s*=\s*["']?\s*([\w.:-]+)/i.exec(head)?.[1] ??
    /^\s*<\?xml\b[^>]*?\bencoding\s*=\s*["']([\w.:-]+)/i.exec(head)?.[1]
  return declared ?? 'utf-8'
}

/** 声明的编码不认识就用 UTF-8 */
function decoderFor(label: string, fatal: boolean): TextDecoder {
  try {
    return new TextDecoder(label, { fatal })
  } catch {
    return new TextDecoder('utf-8', { fatal })
  }
}

export function decodeBody(bytes: Uint8Array, contentType: string): string {
  return decoderFor(charsetOf(bytes, contentType), false).decode(bytes)
}

/** Markdown 里的可见文字数（不算图片、链接地址和空白） */
export function visibleTextLength(markdown: string): number {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, '').length
}

/** 沿 cause 展开错误链：fetch 只说 "fetch failed"，真正的原因在 cause 里 */
export function describeFailure(err: unknown): string {
  const parts: string[] = []
  let current: unknown = err
  for (let depth = 0; current && depth < 5; depth++) {
    const e = current as { message?: unknown; code?: unknown; cause?: unknown }
    const message = typeof e.message === 'string' ? e.message : String(current)
    parts.push(typeof e.code === 'string' ? `${message} (${e.code})` : message)
    current = e.cause
  }
  return parts.join(' <- ')
}

function tooLarge(): Error {
  return new Error(`response is larger than the ${MAX_RESPONSE_BYTES / 1024 / 1024} MB limit`)
}

/** 边读边数：Content-Length 可能没有，有也只是压缩后的大小 */
async function readBodyCapped(response: Response): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {})
    throw tooLarge()
  }
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {})
      throw tooLarge()
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

/** 文件头对得上的文档才交给转换器：它的 xlsx 分支会把任何字节读成表格，音频分支只回一句占位 */
function convertibleDocumentType(bytes: Uint8Array, contentType: string): string | null {
  const head = Buffer.from(bytes.subarray(0, 4)).toString('latin1')
  if (head === '%PDF') return 'application/pdf'
  const isZip = head === 'PK\x03\x04'
  const isOle = head === '\xd0\xcf\x11\xe0'
  return isZip || isOle ? contentType || 'application/octet-stream' : null
}

const FEED_START = /^\s*(?:<\?[\s\S]*?\?>\s*|<!--[\s\S]*?-->\s*)*<(?:rss|feed)[\s>]/

function isNotebookUrl(url: string): boolean {
  try {
    return new URL(url).pathname.toLowerCase().endsWith('.ipynb')
  } catch {
    return false
  }
}

/** 这份响应交给转换器时用的 Content-Type；null = 不该交给它 */
function converterTypeOf(
  kind: BodyKind,
  bytes: Uint8Array,
  decoded: string | null,
  contentType: string,
  url: string
): string | null {
  if (kind === 'html') return 'text/html; charset=utf-8'
  if (kind === 'binary') return convertibleDocumentType(bytes, contentType)
  if (FEED_START.test((decoded ?? '').slice(0, 4096))) return 'application/xml; charset=utf-8'
  return isNotebookUrl(url) ? 'application/json; charset=utf-8' : null
}

/**
 * 给转换器的响应：文本已是 UTF-8。`url` 是请求的地址 —— session.fetch 跳转后 response.url 是空的，拿不到最终地址；
 * 转换器按它的扩展名和站点选转换规则。feed 不带地址，否则扩展名可能盖过类型。
 */
function responseForConverter(
  original: Response | null,
  url: string | null,
  contentType: string,
  body: Uint8Array
): Response {
  const headers = new Headers({ 'content-type': contentType })
  const disposition = original?.headers.get('content-disposition')
  if (disposition) headers.set('content-disposition', disposition)
  const response = new Response(body as BodyInit, { status: 200, headers })
  if (url) Object.defineProperty(response, 'url', { value: url })
  return response
}

function isErrorPlaceholder(markdown: string): boolean {
  return markdown.startsWith('[ERROR]')
}

/** 抓取 URL：HTML 与转换器认识的格式转成 Markdown，其余文本原样返回 */
export async function readUrlContent(
  url: string,
  options: ReadUrlOptions
): Promise<ToolResult<ReadToolDetails>> {
  const { signal, abortError } = options
  if (signal?.aborted) throw new Error(abortError)
  const timeout = AbortSignal.timeout(URL_FETCH_TIMEOUT_MS)

  type Converted = Awaited<ReturnType<UrlConverter>>
  /** 转换失败算没转成；等它时用户中止就不再等（JSDOM 之类的同步活儿例外，它不交出主线程谁也停不了） */
  const convert = async (response: Response): Promise<Converted> => {
    const pending = options.convert(response)
    try {
      return await (signal ? untilAborted(pending, signal) : pending)
    } catch {
      if (signal?.aborted) throw new Error(abortError)
      return null
    }
  }

  const markdownResult = (
    converted: Converted,
    markdown: string,
    note: string
  ): ToolResult<ReadToolDetails> => {
    const title = converted?.title ? ` — ${converted.title}` : ''
    return {
      content: [
        { type: 'text', text: `URL: ${url}${title} — converted to Markdown\n\n${note}${markdown}` }
      ],
      details: { type: 'read', format: 'URL', converted: true, truncated: false, url }
    }
  }

  /** 隐藏页面里渲染一遍；可见文字不到 minChars 就算没拿到 */
  const viaBrowser = async (minChars: number): Promise<ToolResult<ReadToolDetails> | null> => {
    if (!options.render) return null
    let page: { html: string } | null
    try {
      const pending = options.render(url, signal)
      page = await (signal ? untilAborted(pending, signal) : pending)
    } catch {
      if (signal?.aborted) throw new Error(abortError)
      return null
    }
    if (signal?.aborted) throw new Error(abortError)
    if (!page) return null
    const body = Buffer.from(page.html, 'utf-8')
    const converted = await convert(
      responseForConverter(null, url, 'text/html; charset=utf-8', body)
    )
    if (signal?.aborted) throw new Error(abortError)
    const markdown = converted?.markdown?.trim() ?? ''
    const chars = visibleTextLength(markdown)
    if (chars < Math.max(minChars, 1)) return null
    return markdownResult(converted, markdown, chars < THIN_PAGE_TEXT_CHARS ? THIN_PAGE_NOTE : '')
  }

  let response: Response
  let bytes: Buffer
  try {
    const request = (userAgent: string): Promise<Response> =>
      options.fetch(url, {
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        cache: 'no-store',
        // 有的站点先发 cookie 再跳转回同一地址，不带就一直转到超时；这个 session 只在内存里，也没有登录态
        credentials: 'include',
        headers: {
          'User-Agent': userAgent,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          ...(options.acceptLanguage ? { 'Accept-Language': options.acceptLanguage } : {})
        }
      })
    response = await request(options.userAgent)
    // 有的站点拒绝 Chrome UA，却接受自报身份的客户端，所以 403 时用自报的 UA 再试一次
    if (response.status === 403) {
      await response.body?.cancel().catch(() => {})
      response = await request(SELF_DECLARED_USER_AGENT)
    }
    if (!response.ok) await response.body?.cancel().catch(() => {})
    bytes = response.ok ? await readBodyCapped(response) : Buffer.alloc(0)
  } catch (err) {
    if (signal?.aborted) throw new Error(abortError)
    if (timeout.aborted) {
      throw new Error(`timed out after ${URL_FETCH_TIMEOUT_MS / 1000}s: ${url}`)
    }
    throw new Error(describeFailure(err), { cause: err })
  }

  if (!response.ok) {
    if (RENDERABLE_STATUSES.has(response.status)) {
      // 验证页也有几百字，这里要的是确实够一页正文的量
      const rendered = await viaBrowser(THIN_PAGE_TEXT_CHARS)
      if (rendered) return rendered
    }
    throw new Error(
      `HTTP ${response.status} from ${url}.` +
        (REFUSED_STATUSES.has(response.status)
          ? ` The site refused the request, often because it blocks automated clients. ${NEEDS_BROWSER_HINT}`
          : '')
    )
  }

  const contentType = response.headers.get('content-type') ?? ''
  const kind = classifyBody(contentType, bytes)
  const decoded = kind === 'binary' ? null : decodeBody(bytes, contentType)

  const converterType = converterTypeOf(kind, bytes, decoded, contentType, url)
  let converted: Converted = null
  if (converterType) {
    const body = decoded === null ? bytes : Buffer.from(decoded, 'utf-8')
    const isFeed = kind === 'text' && !isNotebookUrl(url)
    converted = await convert(
      responseForConverter(response, isFeed ? null : url, converterType, body)
    )
  }
  if (signal?.aborted) throw new Error(abortError)

  let markdown = converted?.markdown?.trim() ?? ''
  if (kind === 'binary' && isErrorPlaceholder(markdown)) markdown = ''

  if (kind === 'html') {
    if (!markdown) {
      const rendered = await viaBrowser(1)
      if (rendered) return rendered
      throw new Error(`the page at ${url} has no readable text. ${NEEDS_BROWSER_HINT}`)
    }
    const chars = visibleTextLength(markdown)
    const thin = bytes.length >= THIN_PAGE_MIN_BYTES && chars < THIN_PAGE_TEXT_CHARS
    if (!thin) return markdownResult(converted, markdown, '')
    return (await viaBrowser(chars + 1)) ?? markdownResult(converted, markdown, THIN_PAGE_NOTE)
  }

  if (markdown) return markdownResult(converted, markdown, '')

  if (decoded === null) {
    throw new Error(`could not convert ${baseTypeOf(contentType) || 'unknown type'} from ${url}`)
  }
  if (!decoded.trim()) throw new Error(`the response from ${url} is empty`)

  const type = baseTypeOf(contentType)
  return {
    content: [{ type: 'text', text: `URL: ${url}${type ? ` (${type})` : ''}\n\n${decoded}` }],
    details: { type: 'read', format: 'URL', converted: false, truncated: false, url }
  }
}
