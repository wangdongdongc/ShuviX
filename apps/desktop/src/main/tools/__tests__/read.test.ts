/**
 * read 工具集成测试
 * 使用临时文件/目录，mock resolveProjectConfig 和 i18n
 */

import { describe, it, expect, afterEach, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  existsSync,
  rmSync,
  symlinkSync
} from 'node:fs'
import { deflateSync } from 'node:zlib'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import {
  executeTool,
  failureText,
  resultText,
  type InvokedToolResult
} from '@shuvix/agent-runtime/tools/testing/invokeTool'

const TEST_DIR = join(tmpdir(), 'shuvix-read-test-' + Date.now())
/** 假 userData —— 派生图落盘走真实的 utils/paths.ts（getToolResultsDir），必须给它一个真目录 */
const USER_DATA_DIR = join(tmpdir(), 'shuvix-read-test-userdata-' + Date.now())
const SESSION_ID = 'test-session'
const HTML_SOURCE = '<!doctype html>\n<html lang="en">\n<p>A &amp; B</p>\n</html>'
const RICH_FILE_EXTENSIONS = ['pdf', 'docx', 'xlsx', 'xls', 'pptx', 'ipynb', 'zip'] as const

/** 门面 enforcePath 的 spy（恒放行）—— RD-L 看门问没问、问的是哪一条写法 */
const enforcePath = vi.hoisted(() =>
  vi.fn(async (_mode: string, _path: string, _opts: unknown): Promise<void> => {})
)
/** 门面 enforceUrl 的 spy（恒放行）—— read 读 URL 走的是它，不是 enforcePath */
const enforceUrl = vi.hoisted(() =>
  vi.fn(async (_url: unknown, _opts: unknown): Promise<void> => {})
)

/**
 * read 的网络面：专用 session 的 fetch 回一个 HTML 页面（转换器是下面的 mock，不看正文），其余两条路（defaultSession /
 * 全局 fetch）一调就算错。渲染是 readPageRenderer 的 renderPage，窗口那一面在它自己的单测里，这里换成 spy。
 */
const net = vi.hoisted(() => {
  const respondHtml = async (): Promise<Response> =>
    new Response(new TextEncoder().encode('<html><body>x</body></html>'), {
      headers: { 'content-type': 'text/html; charset=utf-8' }
    })
  const readSession = {
    fetch: vi.fn(async (_url: string, _init: RequestInit): Promise<Response> => respondHtml()),
    setUserAgent: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    on: vi.fn()
  }
  return {
    respondHtml,
    readSession,
    fromPartition: vi.fn((_partition: string) => readSession),
    defaultSessionFetch: vi.fn(),
    renderPage: vi.fn(
      async (_url: string, _signal?: AbortSignal): Promise<{ html: string } | null> => null
    )
  }
})

// mock toolContext（避免加载 projectDao/sessionService → electron app.getPath）
vi.mock('../../services/toolContext', () => ({
  resolveProjectConfig: () => ({
    workingDirectory: TEST_DIR,
    referenceDirs: []
  }),
  isPathWithinWorkspace: (absolutePath: string, workingDirectory: string) => {
    const resolved = resolve(absolutePath)
    const base = resolve(workingDirectory)
    return resolved === base || resolved.startsWith(base + sep)
  },
  isPathWithinReferenceDirs: () => false,
  assertReadAllowed: () => {},
  assertWriteAllowed: () => {},
  // 共享 createFileToolSuite 经此 security 门面走统一评估；测试里恒放行（询问 no-op）
  getDesktopSecurityContext: () => ({
    evaluate: () => ({ effect: 'allow', matched: [], winning: 'test' }),
    evaluateReadOnly: () => true,
    enforcePath,
    enforceUrl,
    enforceCommand: async () => ({ status: 'allowed' }),
    enforceGitOp: async () => {}
  }),
  TOOL_ABORTED: 'Aborted'
}))

// mock toolRegistry — 文件底部的 registerBuiltinTool 在测试里是 no-op
vi.mock('../../services/toolRegistry', () => ({
  registerBuiltinTool: () => {}
}))

/**
 * nativeImage 桩的行为旋钮 —— 压缩分支的三条轴都从这里拨：能否解码、原图尺寸、
 * 各质量档的产出字节数（决定阶梯停在第几级）。工厂里的闭包在**调用时**才读它，
 * 故声明在 vi.mock 之下也没问题（与本文件既有的 TEST_DIR 闭包同理）。
 * 每个 it 之后由 afterEach 复位。
 */
function defaultImageStub(): {
  isEmpty: boolean
  size: { width: number; height: number }
  /** quality → 产出字节数；默认第一级就压进上限内 */
  jpegBytes: (quality: number) => number
  /** toJPEG 调用序号 —— 每次产出的字节内容不同，便于分辨「哪一次的字节落进了哪个文件」 */
  calls: number
  /** createFromBuffer 调用次数 —— 断言「像素预算内的图根本不解码」 */
  decodes: number
} {
  return {
    isEmpty: false,
    size: { width: 2400, height: 1200 },
    jpegBytes: () => 64 * 1024,
    calls: 0,
    decodes: 0
  }
}
const nativeImageStub = defaultImageStub()

// mock electron — read.ts 需要 nativeImage（图片压缩）、app.getPath（派生图落盘目录）与读 URL 的 session
vi.mock('electron', () => {
  /** 按尺寸造一个 nativeImage 桩；resize 返回等比缩放后的新桩（getSize 随之变） */
  const makeImage = (width: number, height: number): Record<string, unknown> => ({
    isEmpty: () => nativeImageStub.isEmpty,
    getSize: () => ({ width, height }),
    resize: ({ width: w }: { width: number }) => makeImage(w, Math.round((height * w) / width)),
    toJPEG: (quality: number) =>
      Buffer.alloc(nativeImageStub.jpegBytes(quality), ++nativeImageStub.calls & 0xff),
    toPNG: () => Buffer.alloc(0),
    toDataURL: () => 'data:image/png;base64,'
  })
  return {
    app: { getPath: () => USER_DATA_DIR, isPackaged: false, getLocale: () => 'zh-CN' },
    session: {
      fromPartition: net.fromPartition,
      defaultSession: { fetch: net.defaultSessionFetch }
    },
    nativeImage: {
      createFromBuffer: () => {
        nativeImageStub.decodes++
        return makeImage(nativeImageStub.size.width, nativeImageStub.size.height)
      }
    }
  }
})

/**
 * 落盘失败注入（U-6）—— 置位时 writeFile 抛错，其余调用原样透传。
 * read 自己读原图也走 fs/promises，故必须是**部分** mock。
 */
const persistFailure = { on: false }
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return {
    ...actual,
    default: actual,
    writeFile: (...args: Parameters<typeof actual.writeFile>) =>
      persistFailure.on
        ? Promise.reject(new Error('EACCES: injected persist failure'))
        : actual.writeFile(...args)
  }
})

// mock i18n — 返回 key 本身（带参数展开）
vi.mock('../../i18n', () => ({
  t: (key: string, params?: Record<string, unknown>) => {
    if (!params) return key
    let result = key
    for (const [k, v] of Object.entries(params)) {
      result += ` ${k}=${v}`
    }
    return result
  }
}))

// mock logger
vi.mock('../../logger', () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {}
  })
}))

// mock markitdown-ts 和 word-extractor（避免不必要的加载）
const markItDownConvert = vi.hoisted(() =>
  vi.fn(
    async (
      source: string | Response
    ): Promise<{ title: string | null; markdown: string } | null> => {
      // URL：urlFetch 交来的是一份响应，地址在 response.url
      if (source instanceof Response) {
        if (source.url.includes('empty-page')) {
          return { title: null, markdown: '' }
        }
        if (source.url.includes('fail-convert')) {
          throw new Error('Network error')
        }
        return { title: 'Mock Page', markdown: '# Mock Page\n\nMock content from URL.' }
      }
      return { title: null, markdown: '# Converted local rich' }
    }
  )
)
vi.mock('markitdown-ts', () => ({
  MarkItDown: class {
    convert = markItDownConvert
  }
}))
vi.mock('word-extractor', () => ({
  default: class {
    extract(): { getBody: () => string } {
      return { getBody: () => '' }
    }
  }
}))

// 只换 renderPage；readUrlSession / UA / 语言是真的（RD-URL 要看它们接没接对）
vi.mock('../../services/readPageRenderer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/readPageRenderer')>()),
  renderPage: net.renderPage
}))

import { makeReadTool } from '../read'
import type { ToolContext } from '../../services/toolContext'
import type { ReadToolDetails } from '@shuvix/chat-protocol/types/chatMessage'

const ctx: ToolContext = { sessionId: SESSION_ID }

/** 从 execute 结果中提取文本内容（类型断言） */
function getText(result: { content: Array<{ type: string; text?: string }> }): string {
  const item = result.content[0]
  return (item as { type: 'text'; text: string }).text
}

/** 调用结果的 details 是 unknown，按 read 详情读 */
const detailsOf = (result: { details?: unknown }): ReadToolDetails =>
  result.details as ReadToolDetails

/** 去掉 File/Showing 头部与 End/Showing 尾部，只留带行号的正文 */
function numberedBody(text: string): string {
  return text.slice(text.indexOf('\n\n') + 2, text.lastIndexOf('\n\n('))
}

function expectedNumberedBody(lines: string[], offset = 1, totalLines = lines.length): string {
  const padWidth = String(totalLines).length
  return lines
    .map((line, index) => `${String(offset + index).padStart(padWidth, ' ')}│${line}`)
    .join('\n')
}

function expectNoMixedTextNotice(text: string): void {
  expect(text).not.toContain('mixed text')
  expect(text).not.toContain('control characters escaped')
  expect(text).not.toContain('invalid sequences replaced')
}

/** 交给模型的那个图片块（base64 + mimeType）；没有则 undefined */
function textContent(result: { content: Array<{ type: string }> }): string {
  const item = result.content.find((c) => c.type === 'text') as { text: string } | undefined
  return item?.text ?? ''
}

function imageContent(result: {
  content: Array<{ type: string }>
}): { data: string; mimeType: string } | undefined {
  return result.content.find((c) => c.type === 'image') as
    | { data: string; mimeType: string }
    | undefined
}

// ── 最小 PNG 编码器 ──
// 图片用例要的是**真**文件头：parseImagePixelSize 只读头不解码，写死一段假字节就测不出
// 「宽高来自文件本身」。e2e 那边另有一份（seed.writePng，还要能造 >1MB 的噪声图），
// 这里只需要一张能对字节的小图，故不共用。
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()
function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  let c = 0xffffffff
  for (const b of body) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE((c ^ 0xffffffff) >>> 0, 0)
  return Buffer.concat([len, body, crc])
}
/** 纯色 RGB PNG（w×h） */
function makePng(w: number, h: number): Buffer {
  const stride = w * 3 + 1
  const raw = Buffer.alloc(stride * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = y * stride + 1 + x * 3
      raw[o] = 200
      raw[o + 1] = 40
      raw[o + 2] = 40
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

/**
 * 只带合法文件头的 PNG（IHDR 写真实宽高，IDAT 给个空壳）。
 * 大尺寸 fixture 专用：parseImagePixelSize 只读 IHDR，nativeImage 又是桩，
 * 为一张 2428×3484 真去 deflate 25MB 像素纯属浪费测试时间。
 */
function makePngHeader(w: number, h: number): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(Buffer.alloc(0))),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

/** 派生图的落点：<userData>/tool_results/<sessionId>/ */
const toolResultsDir = (sid: string): string => join(USER_DATA_DIR, 'tool_results', sid)

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true })

  // 纯文本文件
  writeFileSync(join(TEST_DIR, 'hello.txt'), 'line1\nline2\nline3\nline4\nline5\n')

  // 本地 HTML 按原文读取；大小写扩展名都覆盖
  for (const extension of ['html', 'htm', 'HTML']) {
    writeFileSync(join(TEST_DIR, `page.${extension}`), HTML_SOURCE)
  }

  // MarkItDown 本地转换分支只关心路由，内容由 convert spy 提供
  for (const extension of RICH_FILE_EXTENSIONS) {
    writeFileSync(join(TEST_DIR, `document.${extension}`), `rich fixture: ${extension}`)
  }

  // 空文件
  writeFileSync(join(TEST_DIR, 'empty.txt'), '')

  // 超长单行文件（minified）
  writeFileSync(join(TEST_DIR, 'minified.js'), 'x'.repeat(5000) + '\nshort line\n')

  // 二进制文件（含 NULL 字节，文件扩展名为文本类，触发 isBinaryFile 路径）
  const binBuf = Buffer.alloc(100)
  binBuf[50] = 0 // NULL 字节
  binBuf.write('hello', 0)
  writeFileSync(join(TEST_DIR, 'binary.log'), binBuf)

  // 已知二进制扩展名（.exe 在 KNOWN_BINARY_EXTENSIONS）
  writeFileSync(join(TEST_DIR, 'archive.exe'), 'not really an exe')

  // 子目录
  mkdirSync(join(TEST_DIR, 'subdir'), { recursive: true })
  writeFileSync(join(TEST_DIR, 'subdir', 'a.ts'), 'export const a = 1')
  mkdirSync(join(TEST_DIR, 'subdir', 'nested'), { recursive: true })

  // 目录中有多个文件（用于测试目录分页）
  mkdirSync(join(TEST_DIR, 'bigdir'), { recursive: true })
  for (let i = 0; i < 10; i++) {
    writeFileSync(join(TEST_DIR, 'bigdir', `file${String(i).padStart(2, '0')}.txt`), `content ${i}`)
  }

  // 大文件（超过 50KB）
  mkdirSync(join(TEST_DIR, 'largedir'), { recursive: true })
  const largeLines = Array.from({ length: 5000 }, (_, i) => `line ${i + 1}: ${'x'.repeat(20)}`)
  writeFileSync(join(TEST_DIR, 'largedir', 'large.txt'), largeLines.join('\n'))

  // 模糊匹配测试文件
  writeFileSync(join(TEST_DIR, 'README.md'), '# README')

  // 图片：未超限直出（40×24 真 PNG，文件头可解析出真实像素）
  writeFileSync(join(TEST_DIR, 'small.png'), makePng(40, 24))
  // 同一份字节换个扩展名 —— format/mime 该由 ext 推出，而不是嗅探内容
  writeFileSync(join(TEST_DIR, 'photo.jpeg'), makePng(40, 24))
  // 图片扩展名但文件头解析不出（图片分支不做二进制嗅探，仍会走 readImage）
  writeFileSync(join(TEST_DIR, 'garbage.png'), Buffer.from('definitely not a png header'))
  // 超限图片（>1MB）：内容不重要 —— 该分支交给 nativeImage 桩解码
  writeFileSync(join(TEST_DIR, 'big.png'), Buffer.alloc(1536 * 1024, 7))

  // ── 宽度上限用的 fixture：全部 <1MB（纯色图 deflate 后只有几 KB），
  //    所以旧的「按字节判断」会把它们原样放行 —— 正是本组用例要盯住的回归。
  // 典型浏览器视口截图：超宽度上限，缩了确实省 token
  writeFileSync(join(TEST_DIR, 'screenshot.png'), makePng(1440, 900))
  // 超宽度上限
  writeFileSync(join(TEST_DIR, 'wide.png'), makePngHeader(2000, 200))
  // 已在宽度上限内（1000 < 1024）
  writeFileSync(join(TEST_DIR, 'square.png'), makePng(1000, 900))
  // 整页长截图：缩到 1024 宽之后仍在上游 cap 之上，省不下 token —— 该原样透传。
  // 用户实测把它压成 646×927 糊掉了正文，这张是那个回归的钉子。
  writeFileSync(join(TEST_DIR, 'tallpage.png'), makePngHeader(2428, 3484))
  // 像素在预算内、字节超上限：IEND 之后补零撑大文件，文件头仍报 800×600
  writeFileSync(
    join(TEST_DIR, 'heavy.png'),
    Buffer.concat([makePng(800, 600), Buffer.alloc(1200 * 1024)])
  )

  mkdirSync(USER_DATA_DIR, { recursive: true })
})

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
  rmSync(USER_DATA_DIR, { recursive: true, force: true })
})

beforeEach(() => {
  markItDownConvert.mockClear()
})

afterEach(() => {
  Object.assign(nativeImageStub, defaultImageStub())
  persistFailure.on = false
})

describe('read 工具 - 纯文本文件', () => {
  it('读取纯文本文件返回带行号的内容', async () => {
    const tool = makeReadTool(ctx)
    const result = await executeTool(tool, 'tc1', { path: join(TEST_DIR, 'hello.txt') })
    const text = getText(result)
    // 应包含行号
    expect(text).toContain('1│line1')
    expect(text).toContain('5│line5')
  })

  it('分页读取 offset/limit', async () => {
    const tool = makeReadTool(ctx)
    const result = await executeTool(tool, 'tc2', {
      path: join(TEST_DIR, 'hello.txt'),
      offset: 2,
      limit: 2
    })
    const text = getText(result)
    expect(text).toContain('2│line2')
    expect(text).toContain('3│line3')
    // 不应包含 line1
    expect(text).not.toContain('1│line1')
  })

  it('空文件正常返回', async () => {
    const tool = makeReadTool(ctx)
    const result = await executeTool(tool, 'tc3', { path: join(TEST_DIR, 'empty.txt') })
    expect(getText(result)).toBeDefined()
    expect((result.details as { totalLines: number }).totalLines).toBeLessThanOrEqual(1)
  })
})

describe('read 工具 - 文本编码与混合内容', () => {
  const plainLines = ['ASCII plain text', '中文与 emoji：你好 😀']
  const legacyCases = [
    {
      name: 'gbk.out',
      encoding: 'GBK',
      // "GBK中文：你好，世界！\n第二行：文件读取测试。"；独立编码后写死，不用被测 iconv 造夹具
      hex: '47424bd6d0cec4a3bac4e3bac3a3accac0bde7a3a10ab5dab6fed0d0a3bacec4bcfeb6c1c8a1b2e2cad4a1a3',
      lines: ['GBK中文：你好，世界！', '第二行：文件读取测试。']
    },
    {
      name: 'gb18030.out',
      encoding: 'GB18030',
      // 含 U+2000B 的四字节序列 95 32 83 37
      hex: '47423138303330babad7d6a3ba95328337a3accbc4d7d6bddad7d6b7fba1a30ab5dab6fed0d0a3bad7bcc8b7bbb9d4ada1a3',
      lines: ['GB18030汉字：𠀋，四字节字符。', '第二行：准确还原。']
    },
    {
      name: 'shift-jis.out',
      encoding: 'Shift_JIS',
      hex: '93fa967b8cea82cc8365834c83588367814682b182f182c982bf82cd90a28a4581490a93f18d7396da814690b38a6d82c993c782dd82dc82b78142',
      lines: ['日本語のテキスト：こんにちは世界！', '二行目：正確に読みます。']
    }
  ] as const
  const pagedLines = ['第一行中文', '第二行你好', '第三行世界', '第四行完成']
  const largeLines = Array.from(
    { length: 2500 },
    (_, index) => `第${index + 1}行：多字节中文内容🙂`
  )
  let readId = 0

  const writeFixture = (name: string, content: string | Buffer): void => {
    writeFileSync(join(TEST_DIR, name), content)
  }
  const readFixture = async (
    name: string,
    params: { offset?: number; limit?: number } = {}
  ): Promise<InvokedToolResult> =>
    executeTool(makeReadTool(ctx), `tc-text-${readId++}`, {
      path: join(TEST_DIR, name),
      ...params
    })
  const utf16Bytes = (text: string, endian: 'LE' | 'BE', bom: boolean): Buffer => {
    const body = Buffer.from(text, 'utf16le')
    if (endian === 'BE') body.swap16()
    const marker = endian === 'LE' ? [0xff, 0xfe] : [0xfe, 0xff]
    return bom ? Buffer.concat([Buffer.from(marker), body]) : body
  }

  beforeAll(() => {
    writeFixture('plain.out', plainLines.join('\n'))
    for (const endian of ['LE', 'BE'] as const) {
      for (const bom of [true, false]) {
        writeFixture(
          `utf16${endian.toLowerCase()}-${bom ? 'bom' : 'no-bom'}.out`,
          utf16Bytes('第一行 ASCII\n第二行中文 😀\n第三行结束', endian, bom)
        )
      }
      writeFixture(
        `paged-utf16${endian.toLowerCase()}.out`,
        utf16Bytes(pagedLines.join('\n'), endian, false)
      )
    }
    for (const fixture of legacyCases) writeFixture(fixture.name, Buffer.from(fixture.hex, 'hex'))
    writeFixture(
      'paged-gbk.out',
      Buffer.from(
        'b5dad2bbd0d0d6d0cec40ab5dab6fed0d0c4e3bac30ab5dac8fdd0d0cac0bde70ab5dacbc4d0d0cdeab3c9',
        'hex'
      )
    )
    writeFixture('large-utf16.out', utf16Bytes(largeLines.join('\n'), 'LE', true))
    writeFixture('long-non-ascii.out', `${'界'.repeat(2100)}\nshort`)
    writeFixture('mixed-paging.out', `zero\0\none\x01\nclean-${'x'.repeat(80)}\nlast`)
    writeFixture('tabs-newlines.out', 'A\tB\r\nC\rD\n')
    writeFixture(
      'invalid-utf8.out',
      Buffer.concat([
        Buffer.from(`VALID-BEFORE-${'x'.repeat(80)}\n`),
        Buffer.from([0xff]),
        Buffer.from('\nVALID-AFTER')
      ])
    )
    writeFixture(
      'dense.out',
      Buffer.from(Array.from({ length: 256 }, (_, i) => (i % 3 === 0 ? 0 : i & 0xff)))
    )
    writeFixture('zeros.out', Buffer.alloc(256))
    writeFixture('controls.out', Buffer.from(Array.from({ length: 256 }, (_, i) => (i % 4) + 1)))
  })

  it('RD-ENC-01 plain.out 的 ASCII、中文与 emoji 精确可读且无异常提示', async () => {
    const result = await readFixture('plain.out')
    const text = getText(result)

    expect(numberedBody(text)).toBe(expectedNumberedBody(plainLines))
    expect(detailsOf(result).totalLines).toBe(2)
    expect(detailsOf(result).encoding).toBe('UTF-8')
    expect(detailsOf(result).escapedControlChars).toBeUndefined()
    expectNoMixedTextNotice(text)
    expect(text).not.toContain('\uFFFD')
  })

  it.each([
    ['UTF-16LE', true],
    ['UTF-16LE', false],
    ['UTF-16BE', true],
    ['UTF-16BE', false]
  ] as const)(
    'RD-ENC-02 %s（BOM=%s）精确解码，无 NUL 转义、替换字符或 BOM 泄漏',
    async (encoding, bom) => {
      const name = `utf16${encoding.slice(-2).toLowerCase()}-${bom ? 'bom' : 'no-bom'}.out`
      const result = await readFixture(name)
      const text = getText(result)
      const lines = ['第一行 ASCII', '第二行中文 😀', '第三行结束']

      expect(numberedBody(text)).toBe(expectedNumberedBody(lines))
      expect(detailsOf(result).encoding).toBe(encoding)
      expect(detailsOf(result).totalLines).toBe(3)
      expect(detailsOf(result).escapedControlChars).toBeUndefined()
      expect(text).not.toContain('\0')
      expect(text).not.toContain('\\0')
      expect(text).not.toContain('\\x00')
      expect(text).not.toContain('\uFFFD')
      expect(text).not.toContain('\uFEFF')
      expectNoMixedTextNotice(text)
    }
  )

  it.each(legacyCases)(
    'RD-ENC-03 $encoding 固定字节 fixture 精确还原且无混合文本提示',
    async (fixture) => {
      const result = await readFixture(fixture.name)
      const text = getText(result)

      expect(numberedBody(text)).toBe(expectedNumberedBody([...fixture.lines]))
      expect(detailsOf(result).totalLines).toBe(2)
      expect(detailsOf(result).encoding).toBeDefined()
      expect(detailsOf(result).escapedControlChars).toBeUndefined()
      expect(text).not.toContain('\uFFFD')
      expectNoMixedTextNotice(text)
    }
  )

  it.each([
    ['ascii-short.out', 'x'],
    ['chinese-short.out', '好'],
    ['emoji-short.out', '😀'],
    ['combined-short.out', 'A好😀']
  ])('RD-ENC-04 短 UTF-8 %s 不误判为其他编码', async (name, content) => {
    writeFixture(name, content)
    const result = await readFixture(name)
    const text = getText(result)

    expect(numberedBody(text)).toBe(expectedNumberedBody([content]))
    expect(detailsOf(result).encoding).toBe('UTF-8')
    expectNoMixedTextNotice(text)
    expect(text).not.toContain('\uFFFD')
  })

  const sparseControlCases = [0x00, 0x01].flatMap((control) => {
    const escaped = control === 0 ? '\\0' : '\\x01'
    return [
      {
        position: '文件开头',
        name: `sparse-${control}-start.out`,
        bytes: Buffer.concat([
          Buffer.from([control]),
          Buffer.from(`AFTER-START-${'x'.repeat(80)}\nTAIL`)
        ]),
        lines: [`${escaped}AFTER-START-${'x'.repeat(80)}`, 'TAIL']
      },
      {
        position: '8KiB 边界附近',
        name: `sparse-${control}-8k.out`,
        bytes: Buffer.concat([
          Buffer.from(`${'A'.repeat(8180)}\nLEFT-8K-`),
          Buffer.from([control]),
          Buffer.from('-RIGHT-8K\nTAIL')
        ]),
        lines: null
      },
      {
        position: 'EOF',
        name: `sparse-${control}-eof.out`,
        bytes: Buffer.concat([
          Buffer.from(`HEAD\nBEFORE-EOF-${'x'.repeat(80)}`),
          Buffer.from([control])
        ]),
        lines: ['HEAD', `BEFORE-EOF-${'x'.repeat(80)}${escaped}`]
      }
    ]
  })

  it.each(sparseControlCases)(
    'RD-ENC-05 $position 的单个控制字节可转义读取且只提示一次（$name）',
    async (fixture) => {
      writeFixture(fixture.name, fixture.bytes)
      const result = await readFixture(fixture.name)
      const text = getText(result)
      const control = fixture.name.includes('-0-') ? 0 : 1
      const escaped = control === 0 ? '\\0' : '\\x01'

      if (fixture.lines) {
        expect(numberedBody(text)).toBe(expectedNumberedBody(fixture.lines))
      } else {
        expect(text).toContain(`2│LEFT-8K-${escaped}-RIGHT-8K`)
        expect(text).toContain('3│TAIL')
        expect(detailsOf(result).totalLines).toBe(3)
      }
      expect(text).not.toContain(String.fromCharCode(control))
      expect(text.match(/mixed text/g)).toHaveLength(1)
      expect(text.match(/control characters escaped/g)).toHaveLength(1)
      expect(detailsOf(result).escapedControlChars).toBe(true)
    }
  )

  it('RD-ENC-06 少量非法 UTF-8 仍保留合法上下文并给出一次提示', async () => {
    const result = await readFixture('invalid-utf8.out')
    const text = getText(result)

    expect(result.isError).not.toBe(true)
    expect(text).toContain('1│VALID-BEFORE')
    expect(text).toContain('3│VALID-AFTER')
    expect(detailsOf(result).totalLines).toBe(3)
    expect(text.match(/mixed text/g)).toHaveLength(1)
    expect(text).toContain('invalid sequences replaced with U+FFFD')
  })

  it.each(['dense.out', 'zeros.out', 'controls.out'])(
    'RD-ENC-07 高密度二进制 %s 仍拒绝读取',
    async (name) => {
      const failure = await failureText(readFixture(name))
      expect(failure).toContain('Unsupported format')
    }
  )

  it('RD-ENC-08a tab、CRLF 与 CR 保持原有分行及原文字义', async () => {
    const result = await readFixture('tabs-newlines.out')
    const text = getText(result)

    expect(numberedBody(text)).toBe(expectedNumberedBody(['A\tB', 'C', 'D']))
    expect(detailsOf(result).totalLines).toBe(3)
    expectNoMixedTextNotice(text)
  })

  it('RD-ENC-08b ANSI ESC 序列保留原文，不转义也不单独触发混合文本提示', async () => {
    const ansiLine = `before \u001B[31mred\u001B[0m after ${'padding '.repeat(20)}`
    writeFixture('ansi.out', ansiLine)
    const result = await readFixture('ansi.out')
    const text = getText(result)

    expect(numberedBody(text)).toBe(expectedNumberedBody([ansiLine]))
    expect(text).toContain('\u001B[31m')
    expect(text).toContain('\u001B[0m')
    expect(text).not.toContain('\\x1b')
    expectNoMixedTextNotice(text)
    expect(detailsOf(result).escapedControlChars).toBeUndefined()
  })

  it.each(['paged-utf16le.out', 'paged-utf16be.out', 'paged-gbk.out'])(
    'RD-ENC-09a %s 的 offset/limit 与 totalLines 正确',
    async (name) => {
      const result = await readFixture(name, { offset: 2, limit: 2 })
      const text = getText(result)

      expect(numberedBody(text)).toBe(expectedNumberedBody(pagedLines.slice(1, 3), 2, 4))
      expect(detailsOf(result).totalLines).toBe(4)
      expect(detailsOf(result).truncated).toBe(true)
      expect(text).toContain('Showing: lines 2-3')
      expect(text).toContain('Use offset=4 to continue')
      expect(text).not.toContain('\uFFFD')
    }
  )

  it('RD-ENC-09b 多字节大文件按输出字节截断后可从准确行号续读', async () => {
    const first = await readFixture('large-utf16.out')
    const firstText = getText(first)
    const nextOffset = Number(firstText.match(/Use offset=(\d+) to continue/)?.[1])

    expect(detailsOf(first).truncated).toBe(true)
    expect(firstText).toContain('Output capped at 50.0KB')
    expect(Number.isInteger(nextOffset)).toBe(true)
    expect(nextOffset).toBeGreaterThan(1)
    expect(nextOffset).toBeLessThan(largeLines.length)
    expect(firstText).not.toContain('\uFFFD')

    const second = await readFixture('large-utf16.out', { offset: nextOffset, limit: 3 })
    expect(numberedBody(getText(second))).toBe(
      expectedNumberedBody(
        largeLines.slice(nextOffset - 1, nextOffset + 2),
        nextOffset,
        largeLines.length
      )
    )
    expect(detailsOf(second).totalLines).toBe(largeLines.length)
    expect(getText(second)).not.toContain('\uFFFD')
  })

  it('RD-ENC-10a 非 ASCII 超长单行仍按 2000 字符截断', async () => {
    const result = await readFixture('long-non-ascii.out')
    const text = getText(result)

    expect(numberedBody(text)).toBe(
      expectedNumberedBody([`${'界'.repeat(2000)}... (line truncated to 2000 chars)`, 'short'])
    )
    expect(text).not.toContain('界界超出')
    expect(text).not.toContain('\uFFFD')
  })

  it('RD-ENC-10b 混合异常转义不破坏 offset/limit 与 totalLines', async () => {
    const result = await readFixture('mixed-paging.out', { offset: 2, limit: 2 })
    const text = getText(result)

    expect(numberedBody(text)).toBe(
      expectedNumberedBody(['one\\x01', `clean-${'x'.repeat(80)}`], 2, 4)
    )
    expect(detailsOf(result).totalLines).toBe(4)
    expect(detailsOf(result).truncated).toBe(true)
    expect(text.match(/mixed text/g)).toHaveLength(1)
  })

  it('RD-ENC-11 不同编码并发读取不串解码或转义状态', async () => {
    const names = ['plain.out', 'utf16le-bom.out', 'gbk.out', 'gb18030.out', 'shift-jis.out']
    const results = await Promise.all(names.map((name) => readFixture(name)))
    const expected = [
      plainLines,
      ['第一行 ASCII', '第二行中文 😀', '第三行结束'],
      ...legacyCases.map((fixture) => [...fixture.lines])
    ]

    for (const [index, result] of results.entries()) {
      const text = getText(result)
      expect(numberedBody(text)).toBe(expectedNumberedBody(expected[index]))
      expect(text).not.toContain('\uFFFD')
      expectNoMixedTextNotice(text)
    }
  })
})

describe('read 工具 - 单行截断', () => {
  it('超长单行被截断到 2000 字符', async () => {
    const tool = makeReadTool(ctx)
    const result = await executeTool(tool, 'tc4', { path: join(TEST_DIR, 'minified.js') })
    const text = getText(result)
    // 第一行应被截断
    expect(text).toContain('line truncated to')
    // 第二行应正常
    expect(text).toContain('short line')
  })
})

describe('read 工具 - 目录读取', () => {
  it('读取目录返回排序的条目列表', async () => {
    const tool = makeReadTool(ctx)
    const result = await executeTool(tool, 'tc5', { path: join(TEST_DIR, 'subdir') })
    const text = getText(result)
    // 目录条目加 / 后缀
    expect(text).toContain('nested/')
    // 文件条目不加 /
    expect(text).toContain('a.ts')
  })

  it('目录分页 offset/limit', async () => {
    const tool = makeReadTool(ctx)
    const result = await executeTool(tool, 'tc6', {
      path: join(TEST_DIR, 'bigdir'),
      offset: 1,
      limit: 3
    })
    const text = getText(result)
    const details = result.details as { totalEntries: number; truncated: boolean }
    expect(details.totalEntries).toBe(10)
    expect(details.truncated).toBe(true)
    // 应包含分页提示
    expect(text).toContain('offset=4')
  })
})

describe('read 工具 - 文件不存在', () => {
  it('有近似文件时返回 Did you mean', async () => {
    const tool = makeReadTool(ctx)
    const failure = await failureText(executeTool(tool, 'tc7', { path: join(TEST_DIR, 'readme') }))
    expect(failure).toContain('Did you mean')
  })

  it('无近似文件时返回普通 fileNotFound', async () => {
    const tool = makeReadTool(ctx)
    const msg = await failureText(
      executeTool(tool, 'tc8', { path: join(TEST_DIR, 'zzzznonexistent') })
    )
    expect(msg).toContain('File not found')
    expect(msg).not.toContain('Did you mean')
  })
})

describe('read 工具 - 二进制文件拒绝', () => {
  it('已知扩展名直接拒绝', async () => {
    const tool = makeReadTool(ctx)
    const failure = await failureText(
      executeTool(tool, 'tc9', { path: join(TEST_DIR, 'archive.exe') })
    )
    expect(failure).toContain('Unsupported format')
  })

  it('NULL 字节检测拒绝', async () => {
    const tool = makeReadTool(ctx)
    const failure = await failureText(
      executeTool(tool, 'tc10', { path: join(TEST_DIR, 'binary.log') })
    )
    expect(failure).toContain('Unsupported format')
  })
})

describe('read 工具 - 大文件字节上限', () => {
  it('超 50KB 时截断并提示 offset', async () => {
    const tool = makeReadTool(ctx)
    const result = await executeTool(tool, 'tc11', {
      path: join(TEST_DIR, 'largedir', 'large.txt')
    })
    const text = getText(result)
    expect((result.details as { truncated: boolean }).truncated).toBe(true)
    // 应包含截断提示
    expect(text).toContain('offset=')
  })
})

describe('read 工具 - 本地 HTML 原文', () => {
  it.each(['page.html', 'page.htm', 'page.HTML'])(
    'RD-HTML-01 %s 保留标签、实体与行号，不经过 MarkItDown',
    async (filename) => {
      const tool = makeReadTool(ctx)
      const result = await executeTool(tool, `tc-html-${filename}`, {
        path: join(TEST_DIR, filename)
      })
      const text = getText(result)
      const details = detailsOf(result)

      expect(text).toContain('1│<!doctype html>')
      expect(text).toContain('2│<html lang="en">')
      expect(text).toContain('3│<p>A &amp; B</p>')
      expect(text).not.toContain('converted to Markdown')
      expect(details.totalLines).toBe(4)
      expect(details.converted).not.toBe(true)
      expect(markItDownConvert).not.toHaveBeenCalled()
    }
  )

  it('RD-HTML-02 offset/limit 只返回所选原文并保留续读信息', async () => {
    const tool = makeReadTool(ctx)
    const result = await executeTool(tool, 'tc-html-pagination', {
      path: join(TEST_DIR, 'page.html'),
      offset: 2,
      limit: 2
    })
    const text = getText(result)
    const details = detailsOf(result)

    expect(text).toContain('2│<html lang="en">')
    expect(text).toContain('3│<p>A &amp; B</p>')
    expect(text).not.toContain('1│<!doctype html>')
    expect(text).not.toContain('4│</html>')
    expect(text).toContain('Showing: lines 2-3')
    expect(text).toContain('offset=4')
    expect(details.totalLines).toBe(4)
    expect(details.truncated).toBe(true)
    expect(markItDownConvert).not.toHaveBeenCalled()
  })

  it.each(RICH_FILE_EXTENSIONS)(
    'RD-HTML-04 .%s 本地文件仍由 MarkItDown 转换',
    async (extension) => {
      const absolutePath = join(TEST_DIR, `document.${extension}`)
      const tool = makeReadTool(ctx)
      const result = await executeTool(tool, `tc-rich-${extension}`, { path: absolutePath })
      const text = getText(result)
      const details = detailsOf(result)

      expect(markItDownConvert).toHaveBeenCalledTimes(1)
      expect(markItDownConvert).toHaveBeenCalledWith(absolutePath)
      expect(text).toContain('converted to Markdown')
      expect(text).toContain('# Converted local rich')
      expect(details.converted).toBe(true)
      expect(details.format).toBe(extension.toUpperCase())
    }
  )

  it('RD-HTML-05 description 区分 URL、本地 HTML 与富文档转换', () => {
    const description = makeReadTool(ctx).description

    expect(description).toMatch(/URLs \(http\/https\).*converts it to Markdown/i)
    expect(description).toMatch(/text files[^;]*line numbers[^;]*offset\/limit/i)

    const localHtmlClause = description.match(/local HTML[\s\S]*?(?=For directories|$)/i)?.[0]
    expect(localHtmlClause).toBeDefined()
    expect(localHtmlClause).toMatch(/\.html\/\.htm/i)
    expect(localHtmlClause).toMatch(/text source/i)
    expect(localHtmlClause).toMatch(/not auto-converted/i)

    const richFileDescription = description.match(/Supports PDF[^.]+\./i)?.[0]
    expect(richFileDescription).toBeDefined()
    for (const format of ['PDF', 'Word', 'Excel', 'PowerPoint', 'Jupyter Notebook']) {
      expect(richFileDescription).toContain(format)
    }
    expect(richFileDescription).toMatch(/auto-converted to Markdown/i)

    const withoutQualifiedHtmlRule = description.replace(localHtmlClause!, '')
    expect(withoutQualifiedHtmlRule).not.toMatch(/HTML[^.;]*auto-converted/i)
  })
})

/** Node 下没有 process.versions.chrome（Electron 才有）；readUrlSession / readUserAgent 要读它。下面图片那组也读 URL */
const originalChrome = Object.getOwnPropertyDescriptor(process.versions, 'chrome')
beforeAll(() => {
  Object.defineProperty(process.versions, 'chrome', {
    value: '142.0.7444.59',
    configurable: true
  })
})
afterAll(() => {
  if (originalChrome) Object.defineProperty(process.versions, 'chrome', originalChrome)
  else Reflect.deleteProperty(process.versions, 'chrome')
})

describe('read 工具 - URL 抓取', () => {
  const globalFetch = vi.fn()

  beforeAll(() => {
    vi.stubGlobal('fetch', globalFetch)
  })

  afterAll(() => {
    vi.unstubAllGlobals()
  })

  beforeEach(() => {
    net.readSession.fetch.mockReset()
    net.readSession.fetch.mockImplementation(net.respondHtml)
    net.renderPage.mockReset()
    net.renderPage.mockResolvedValue(null)
    net.defaultSessionFetch.mockReset()
    globalFetch.mockReset()
    enforceUrl.mockReset()
    enforceUrl.mockResolvedValue(undefined)
    enforcePath.mockClear()
    markItDownConvert.mockClear()
  })

  const sessionUserAgent = (): string =>
    (net.readSession.fetch.mock.calls[0][1].headers as Record<string, string>)['User-Agent']

  it('RD-HTML-03 .html HTTPS URL 仍完整交给 convert 并返回 Markdown', async () => {
    const url = 'https://example.com/page.html'
    const tool = makeReadTool(ctx)
    const result = await executeTool(tool, 'tc-url1', { path: url })
    const text = getText(result)
    const details = result.details as { format: string; converted: boolean; url: string }

    expect(markItDownConvert).toHaveBeenCalledTimes(1)
    const source = markItDownConvert.mock.calls[0][0]
    expect(source).toBeInstanceOf(Response)
    expect((source as Response).url).toBe(url)
    expect(text).toContain(`URL: ${url}`)
    expect(text).toContain('— Mock Page —')
    expect(text).toContain('# Mock Page')
    expect(text).toContain('Mock content from URL.')
    expect(text).not.toMatch(/^\d+│/m)
    expect(details.format).toBe('URL')
    expect(details.converted).toBe(true)
    expect(details.url).toBe(url)
  })

  it('URL 返回包含页面标题', async () => {
    const tool = makeReadTool(ctx)
    const result = await executeTool(tool, 'tc-url2', {
      path: 'https://example.com/page'
    })
    const text = getText(result)
    expect(text).toContain('— Mock Page —')
  })

  it('转换器抛错的 HTML 算没有正文：说页面读不出来，不带转换器的话', async () => {
    const url = 'https://fail-convert.example.com'
    const tool = makeReadTool(ctx)
    const msg = await failureText(executeTool(tool, 'tc-url3', { path: url }))
    expect(msg.startsWith(`Failed to fetch URL: the page at ${url} has no readable text.`)).toBe(
      true
    )
    expect(msg).not.toContain('Network error')
    expect(net.renderPage).toHaveBeenCalledTimes(1)
  })

  it('URL 返回空内容时先渲染，还是没有就报错', async () => {
    const url = 'https://empty-page.example.com'
    const tool = makeReadTool(ctx)
    const msg = await failureText(executeTool(tool, 'tc-url4', { path: url }))
    expect(msg.startsWith(`Failed to fetch URL: the page at ${url} has no readable text.`)).toBe(
      true
    )
    expect(net.renderPage).toHaveBeenCalledTimes(1)
  })

  it('http URL 也能正确识别', async () => {
    const tool = makeReadTool(ctx)
    const result = await executeTool(tool, 'tc-url5', {
      path: 'http://example.com/page'
    })
    const text = getText(result)
    expect(text).toContain('URL: http://example.com/page')
    expect(text).toContain('Mock content from URL.')
  })

  it('RD-URL-01 走 shuvix-read-url 分区的 fetch，不走 defaultSession 也不走全局 fetch', async () => {
    const url = 'https://example.com/page'
    await executeTool(makeReadTool(ctx), 'tc-url6', { path: url })
    expect(net.fromPartition).toHaveBeenCalledWith('shuvix-read-url')
    expect(net.readSession.fetch).toHaveBeenCalledTimes(1)
    expect(net.readSession.fetch.mock.calls[0][0]).toBe(url)
    expect(net.defaultSessionFetch).not.toHaveBeenCalled()
    expect(globalFetch).not.toHaveBeenCalled()
  })

  it('RD-URL-02 UA 是内置 Chromium 主版本的 Chrome，没有 Electron / ShuviX；语言来自 app.getLocale', async () => {
    await executeTool(makeReadTool(ctx), 'tc-url7', { path: 'https://example.com/page' })
    const ua = sessionUserAgent()
    expect(ua).toContain('Chrome/142.0.0.0')
    expect(ua).not.toMatch(/Electron|ShuviX/)
    const headers = net.readSession.fetch.mock.calls[0][1].headers as Record<string, string>
    expect(headers['Accept-Language']).toBe('zh-CN,en;q=0.8')
  })

  it('RD-URL-03 session 只配置一次：UA、语言，权限一律拒，下载一律拦', async () => {
    const tool = makeReadTool(ctx)
    await executeTool(tool, 'tc-url8', { path: 'https://example.com/a' })
    await executeTool(tool, 'tc-url9', { path: 'https://example.com/b' })
    // 模块级只配一次；本文件之前的用例可能已经配过，所以按「总共一次」看
    expect(net.readSession.setUserAgent).toHaveBeenCalledTimes(1)
    const [ua, languages] = net.readSession.setUserAgent.mock.calls[0]
    expect(ua).toContain('Chrome/142.0.0.0')
    expect(languages).toBe('zh-CN,en;q=0.8')
    expect(net.readSession.setPermissionRequestHandler).toHaveBeenCalledTimes(1)
    const decide = vi.fn()
    const handler = net.readSession.setPermissionRequestHandler.mock.calls[0][0] as (
      wc: unknown,
      permission: string,
      callback: (allowed: boolean) => void
    ) => void
    handler(null, 'geolocation', decide)
    expect(decide).toHaveBeenCalledWith(false)
    const check = net.readSession.setPermissionCheckHandler.mock.calls[0][0] as () => boolean
    expect(check()).toBe(false)
    const [eventName, onDownload] = net.readSession.on.mock.calls[0] as [
      string,
      (event: { preventDefault: () => void }) => void
    ]
    expect(eventName).toBe('will-download')
    const preventDefault = vi.fn()
    onDownload({ preventDefault })
    expect(preventDefault).toHaveBeenCalledTimes(1)
  })

  it('RD-URL-04 非中止的错误只带一次 Failed to fetch URL: 前缀', async () => {
    const url = 'https://example.com/missing'
    net.readSession.fetch.mockResolvedValue(new Response(null, { status: 404 }))
    const msg = await failureText(executeTool(makeReadTool(ctx), 'tc-url10', { path: url }))
    expect(msg).toBe(`Failed to fetch URL: HTTP 404 from ${url}.`)
  })

  it('RD-URL-05 网络错误也只带一次前缀，错误链展开', async () => {
    net.readSession.fetch.mockRejectedValue(
      new TypeError('fetch failed', { cause: new Error('net::ERR_CONNECTION_REFUSED') })
    )
    const msg = await failureText(
      executeTool(makeReadTool(ctx), 'tc-url11', { path: 'https://example.com/a' })
    )
    expect(msg).toBe('Failed to fetch URL: fetch failed <- net::ERR_CONNECTION_REFUSED')
  })

  it('RD-URL-06 中止：拒绝的错误恰好是 Aborted，没有前缀（工具层靠这句认出中止）', async () => {
    const controller = new AbortController()
    net.readSession.fetch.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
          controller.abort()
        })
    )
    const error = await executeTool(
      makeReadTool(ctx),
      'tc-url12',
      { path: 'https://example.com/a' },
      controller.signal
    ).then(
      () => null,
      (e: Error) => e
    )
    expect(error?.message).toBe('Aborted')
  })

  it('RD-URL-07 渲染时中止：恰好是 Aborted，渲染拿到的是这次调用的 signal', async () => {
    const controller = new AbortController()
    net.readSession.fetch.mockResolvedValue(new Response(null, { status: 403 }))
    net.renderPage.mockImplementation(async () => {
      controller.abort()
      return null
    })
    const error = await executeTool(
      makeReadTool(ctx),
      'tc-url13',
      { path: 'https://example.com/a' },
      controller.signal
    ).then(
      () => null,
      (e: Error) => e
    )
    expect(error?.message).toBe('Aborted')
    expect(net.renderPage).toHaveBeenCalledTimes(1)
    expect(net.renderPage.mock.calls[0][0]).toBe('https://example.com/a')
    expect(net.renderPage.mock.calls[0][1]).toBeInstanceOf(AbortSignal)
  })

  it('RD-URL-08 被拒绝时接上真的 renderPage 这条路：够一页的渲染结果进结果', async () => {
    // mock 的转换器回一页很短的 Markdown（不够 300 字），所以这里换一个够长的
    markItDownConvert.mockImplementationOnce(async () => ({
      title: 'Rendered',
      markdown: 'r'.repeat(400)
    }))
    net.readSession.fetch.mockResolvedValue(new Response(null, { status: 503 }))
    net.renderPage.mockResolvedValue({ html: '<html><body>rendered</body></html>' })
    const result = await executeTool(makeReadTool(ctx), 'tc-url14', {
      path: 'https://example.com/a'
    })
    expect(getText(result)).toBe(
      `URL: https://example.com/a — Rendered — converted to Markdown\n\n${'r'.repeat(400)}`
    )
  })

  it('RD-URL-09 先过 enforceUrl（规整后的客体），不走 enforcePath', async () => {
    const url = 'https://user:pw@Example.COM./page?q=1'
    await executeTool(makeReadTool(ctx), 'tc-url15', { path: url })
    expect(enforceUrl).toHaveBeenCalledTimes(1)
    const [object, opts] = enforceUrl.mock.calls[0] as [
      Record<string, unknown>,
      Record<string, unknown>
    ]
    expect(object).toMatchObject({ scheme: 'https', host: 'example.com', browser: 'app' })
    expect(String(object.url)).not.toContain('pw')
    expect(opts).toMatchObject({ toolCallId: 'tc-url15', toolName: 'read', abortError: 'Aborted' })
    expect(enforcePath).not.toHaveBeenCalled()
    expect(enforceUrl.mock.invocationCallOrder[0]).toBeLessThan(
      net.readSession.fetch.mock.invocationCallOrder[0]
    )
  })

  it('RD-URL-10 enforceUrl 拒绝：不发任何请求、不渲染，错误是门的那一句', async () => {
    enforceUrl.mockRejectedValue(new Error('Blocked by policy'))
    const msg = await failureText(
      executeTool(makeReadTool(ctx), 'tc-url16', { path: 'https://example.com/a' })
    )
    expect(msg).toContain('Blocked by policy')
    expect(msg).not.toContain('Failed to fetch URL')
    expect(net.readSession.fetch).not.toHaveBeenCalled()
    expect(net.renderPage).not.toHaveBeenCalled()
    expect(markItDownConvert).not.toHaveBeenCalled()
  })

  it('RD-URL-11 本地文件不问 enforceUrl', async () => {
    await executeTool(makeReadTool(ctx), 'tc-url17', { path: join(TEST_DIR, 'hello.txt') })
    expect(enforceUrl).not.toHaveBeenCalled()
    expect(enforcePath).toHaveBeenCalled()
  })

  it('RD-URL-12 JSON 不进转换器：原样返回，converted=false', async () => {
    const url = 'https://example.com/data.json'
    net.readSession.fetch.mockResolvedValue(
      new Response(new TextEncoder().encode('{"a":\n\n1}'), {
        headers: { 'content-type': 'application/json' }
      })
    )
    const result = await executeTool(makeReadTool(ctx), 'tc-url18', { path: url })
    expect(getText(result)).toBe(`URL: ${url} (application/json)\n\n{"a":\n\n1}`)
    expect(detailsOf(result).converted).toBe(false)
    expect(markItDownConvert).not.toHaveBeenCalled()
  })

  it('RD-URL-13 description 说明文本原样返回、隐藏页面没有登录', () => {
    const description = makeReadTool(ctx).description
    expect(description).toMatch(/JSON, XML and other text come back as they are/)
    expect(description).toMatch(/hidden browser page, without any login/)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 图片：details.image 记的是「模型实际收到的那一份」在磁盘上的落点
//   - ≤1MB 直出 → 指原文件（逐字节同源）
//   - >1MB 压缩 → 指落进 tool_results 的派生 JPEG（指回原图的话用户会看到比模型更清楚的画面）
//   - 落盘失败 → 整个字段缺席，read 本身不受影响

describe('read 工具 - 图片（未超限直出）', () => {
  it('details.image 指原文件，bytes 为文件字节数，format 由扩展名推出', async () => {
    const tool = makeReadTool(ctx)
    const png = join(TEST_DIR, 'small.png')
    const result = await executeTool(tool, 'tc-img1', { path: png })
    const details = detailsOf(result)
    expect(details.image?.path).toBe(png)
    expect(details.image?.bytes).toBe(statSync(png).size)
    expect(details.format).toBe('PNG')
    expect(details.truncated).toBe(false)

    // 同一份 PNG 字节换个扩展名：format / mimeType 跟 ext 走，不嗅探内容
    const jpeg = join(TEST_DIR, 'photo.jpeg')
    const asJpeg = await executeTool(tool, 'tc-img2', { path: jpeg })
    expect(detailsOf(asJpeg).format).toBe('JPEG')
    expect(detailsOf(asJpeg).image?.path).toBe(jpeg)
    expect(imageContent(asJpeg)?.mimeType).toBe('image/jpeg')
  })

  it('交给模型的字节与 image.path 所指文件同源，宽高取自文件头', async () => {
    const tool = makeReadTool(ctx)
    const result = await executeTool(tool, 'tc-img3', { path: join(TEST_DIR, 'small.png') })
    const details = detailsOf(result)
    const img = imageContent(result)
    expect(img?.mimeType).toBe('image/png')
    expect(img?.data).toBe(readFileSync(details.image!.path).toString('base64'))
    expect(details.image?.width).toBe(40)
    expect(details.image?.height).toBe(24)
  })

  it('文件头解析不出时仍给 path / bytes，只是没有宽高', async () => {
    const tool = makeReadTool(ctx)
    const broken = join(TEST_DIR, 'garbage.png')
    const result = await executeTool(tool, 'tc-img4', { path: broken })
    const details = detailsOf(result)
    expect(details.image?.path).toBe(broken)
    expect(details.image?.bytes).toBe(statSync(broken).size)
    expect(details.image?.width).toBeUndefined()
    expect(details.image?.height).toBeUndefined()
    expect(imageContent(result)).toBeDefined()
  })

  it('相对路径入参也回绝对路径', async () => {
    const tool = makeReadTool(ctx)
    const result = await executeTool(tool, 'tc-img5', { path: 'small.png' })
    expect(detailsOf(result).image?.path).toBe(join(TEST_DIR, 'small.png'))
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 宽度上限：图像 token ≈ 宽×高/750，只由像素数决定，闸门必须架在像素上 ——
// 一张 1440×900 的截图通常不到 1MB，「按字节判断」会原样放行。
// 卡宽度而不是面积：宽度决定字号，实测 1024 宽下 11px 表格数字仍可准确读出，
// 768 宽就会把 203417882 读成 283417882（自信地读错，比读不出更糟）。

describe('read 工具 - 图片（宽度上限）', () => {
  /** 模型实际拿到的那张图的尺寸 */
  const modelSize = (result: { details?: unknown }): { w: number; h: number } => {
    const img = detailsOf(result).image!
    return { w: img.width!, h: img.height! }
  }

  it('<1MB 但超宽度上限的截图会被缩 —— 旧的按字节判断会原样放行', async () => {
    const shot = join(TEST_DIR, 'screenshot.png')
    expect(statSync(shot).size).toBeLessThan(1024 * 1024) // 字节闸门拦不住它
    nativeImageStub.size = { width: 1440, height: 900 }

    const result = await executeTool(makeReadTool(ctx), 'tc-px1', { path: shot })
    const details = detailsOf(result)
    expect(details.truncated).toBe(true)
    expect(details.format).toBe('JPEG')
    expect(modelSize(result)).toEqual({ w: 1024, h: 640 })
  })

  it('整页长截图原样透传：缩到 1024 宽后仍在上游 cap 之上，省不下 token', async () => {
    // 实测回归：2428×3484 曾被面积预算压成 646×927，正文糊掉，而 token 一个没省 ——
    // 透传与缩放都落在 895×1284 ≈ 1533 tokens，透传还少一次重采样。
    const tall = join(TEST_DIR, 'tallpage.png')
    const result = await executeTool(makeReadTool(ctx), 'tc-px2', { path: tall })
    const details = detailsOf(result)
    expect(details.truncated).toBe(false)
    expect(details.format).toBe('PNG')
    expect(details.image?.path).toBe(tall)
    expect(nativeImageStub.decodes).toBe(0) // 连解码都没做
    expect(imageContent(result)?.data).toBe(readFileSync(tall).toString('base64'))
  })

  it('透传的整页截图带一句可操作提示：换视口或单个元素', async () => {
    const result = await executeTool(makeReadTool(ctx), 'tc-px3', {
      path: join(TEST_DIR, 'tallpage.png')
    })
    expect(textContent(result)).toContain('Capture the viewport or a single element')
  })

  it('宽度上限生效：超宽图按宽度缩，不按面积', async () => {
    nativeImageStub.size = { width: 2000, height: 200 }
    const result = await executeTool(makeReadTool(ctx), 'tc-px4', {
      path: join(TEST_DIR, 'wide.png')
    })
    expect(modelSize(result).w).toBe(1024)
  })

  it('已在宽度上限内：透传，不解码也不提示', async () => {
    const square = join(TEST_DIR, 'square.png') // 1000×900，1000 < 1024
    const result = await executeTool(makeReadTool(ctx), 'tc-px5', { path: square })
    expect(detailsOf(result).truncated).toBe(false)
    expect(nativeImageStub.decodes).toBe(0)
    expect(textContent(result)).not.toContain('Capture the viewport')
  })

  it('宽度达标、只是字节超限：降质量，不动分辨率', async () => {
    const heavy = join(TEST_DIR, 'heavy.png')
    expect(statSync(heavy).size).toBeGreaterThan(1024 * 1024)
    nativeImageStub.size = { width: 800, height: 600 } // 800 < 1024，宽度没问题
    nativeImageStub.jpegBytes = (quality) => (quality >= 85 ? 2 * 1024 * 1024 : 300 * 1024)

    const result = await executeTool(makeReadTool(ctx), 'tc-px6', { path: heavy })
    expect(modelSize(result)).toEqual({ w: 800, h: 600 }) // 分辨率原封不动
    expect(detailsOf(result).image?.bytes).toBe(300 * 1024)
  })

  it('超预算但解不了码：退回直出原图，不让整个 read 失败', async () => {
    nativeImageStub.isEmpty = true
    const shot = join(TEST_DIR, 'screenshot.png')
    const result = await executeTool(makeReadTool(ctx), 'tc-px7', { path: shot })
    const details = detailsOf(result)
    expect(nativeImageStub.decodes).toBe(1) // 试过解码
    expect(details.truncated).toBe(false)
    expect(details.format).toBe('PNG')
    expect(details.image?.path).toBe(shot)
  })
})

// 给模型的文本只留「这是张什么图、缩过没有」—— 原始字节、JPEG 质量、省了多少 token
// 都是运维数字，模型拿它做不了决策，进上下文纯属噪声（完整账目在 log 与 details 里）。
describe('read 工具 - 图片（给模型的文本）', () => {
  it('压缩分支：只说尺寸与缩自多大，不带质量/字节/省量', async () => {
    nativeImageStub.size = { width: 1440, height: 900 }
    const result = await executeTool(makeReadTool(ctx), 'tc-txt1', {
      path: join(TEST_DIR, 'screenshot.png')
    })
    const text = textContent(result)
    expect(text).toBe(
      `Image: ${join(TEST_DIR, 'screenshot.png')} (JPEG 1024×640, downscaled from 1440×900)`
    )
    for (const noise of ['quality', 'saved', 'KB', 'tokens', 'Auto-compressed']) {
      expect(text).not.toContain(noise)
    }
  })

  it('直出分支：格式 + 尺寸，仅此而已', async () => {
    const result = await executeTool(makeReadTool(ctx), 'tc-txt2', {
      path: join(TEST_DIR, 'small.png')
    })
    expect(textContent(result)).toBe(`Image: ${join(TEST_DIR, 'small.png')} (PNG 40×24)`)
  })
})

describe('read 工具 - 图片（超限压缩落盘）', () => {
  const big = join(TEST_DIR, 'big.png')

  it('details.image 指落进 tool_results 的派生 JPEG，与交给模型的字节同源', async () => {
    const tool = makeReadTool(ctx)
    const result = await executeTool(tool, 'tc-img6', { path: big })
    const details = detailsOf(result)
    const derived = details.image!.path
    expect(derived.startsWith(toolResultsDir(SESSION_ID) + sep)).toBe(true)
    expect(derived.endsWith('.jpg')).toBe(true)
    expect(derived).not.toBe(big)
    expect(existsSync(derived)).toBe(true)
    expect(imageContent(result)?.mimeType).toBe('image/jpeg')
    expect(imageContent(result)?.data).toBe(readFileSync(derived).toString('base64'))
  })

  it('宽高是压缩后的尺寸（阶梯停在哪级就是哪级），bytes 是落盘文件大小', async () => {
    // 2400×1200 先被像素预算缩到 1024×512（长边 1024 比面积上限更严），
    // 再在该尺寸下降质量兜字节：q85 仍 >1MB，q75 才落进上限。
    nativeImageStub.size = { width: 2400, height: 1200 }
    nativeImageStub.jpegBytes = (quality) => (quality >= 85 ? 2 * 1024 * 1024 : 300 * 1024)

    const tool = makeReadTool(ctx)
    const result = await executeTool(tool, 'tc-img7', { path: big })
    const details = detailsOf(result)
    expect(details.image?.width).toBe(1024)
    expect(details.image?.height).toBe(512)
    expect(details.image?.bytes).toBe(300 * 1024)
    expect(statSync(details.image!.path).size).toBe(details.image?.bytes)
    expect(details.format).toBe('JPEG')
    expect(details.truncated).toBe(true)
    expect(details.fileSize).toBe(300 * 1024)
  })

  it('落盘失败：read 照常返回，只是 image 字段缺席', async () => {
    persistFailure.on = true
    const tool = makeReadTool(ctx)
    const result = await executeTool(tool, 'tc-img8', { path: big })
    const details = detailsOf(result)
    expect(details.image).toBeUndefined()
    // 该给模型的一样不少，压缩本身的结论也不变
    expect(result.content.map((c) => c.type)).toEqual(['image', 'text'])
    expect(Buffer.from(imageContent(result)!.data, 'base64').length).toBe(64 * 1024)
    expect((result.content.find((c) => c.type === 'text') as { text: string }).text).toContain(
      'downscaled from 2400×1200'
    )
    expect(details.format).toBe('JPEG')
    expect(details.truncated).toBe(true)
    expect(details.fileSize).toBe(64 * 1024)
  })

  it('同毫秒两次读：两份派生图各自落盘，互不覆盖', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    try {
      const tool = makeReadTool(ctx)
      const first = await executeTool(tool, 'tc-img9a', { path: big })
      const second = await executeTool(tool, 'tc-img9b', { path: big })
      const pathA = detailsOf(first).image!.path
      const pathB = detailsOf(second).image!.path
      expect(pathA).not.toBe(pathB)
      expect(existsSync(pathA)).toBe(true)
      expect(existsSync(pathB)).toBe(true)
      // 各自的文件里装的是各自交给模型的那份字节
      expect(readFileSync(pathA).toString('base64')).toBe(imageContent(first)?.data)
      expect(readFileSync(pathB).toString('base64')).toBe(imageContent(second)?.data)
      expect(imageContent(first)?.data).not.toBe(imageContent(second)?.data)
    } finally {
      now.mockRestore()
    }
  })

  it('sessionId 为空：不落盘、无 image 字段，read 仍成功', async () => {
    const base = join(USER_DATA_DIR, 'tool_results')
    const before = existsSync(base) ? readdirSync(base) : []
    const result = await executeTool(makeReadTool({ sessionId: '' }), 'tc-img10', { path: big })
    expect(detailsOf(result).image).toBeUndefined()
    expect(imageContent(result)).toBeDefined()
    expect(existsSync(base) ? readdirSync(base) : []).toEqual(before)
  })

  it('nativeImage 解不开：报错（isError 结果；与「落盘失败降级」是两回事）', async () => {
    nativeImageStub.isEmpty = true
    const tool = makeReadTool(ctx)
    const failure = await failureText(executeTool(tool, 'tc-img11', { path: big }))
    expect(failure).toContain('cannot be decoded')
  })
})

describe('read 工具 - 非图片结果不带 image', () => {
  it('纯文本 / 目录 / URL 三条都没有 details.image', async () => {
    const tool = makeReadTool(ctx)
    const text = await executeTool(tool, 'tc-img12', { path: join(TEST_DIR, 'hello.txt') })
    const dir = await executeTool(tool, 'tc-img13', { path: join(TEST_DIR, 'subdir') })
    const url = await executeTool(tool, 'tc-img14', { path: 'https://example.com/page' })
    expect(detailsOf(text).image).toBeUndefined()
    expect(detailsOf(dir).image).toBeUndefined()
    expect(detailsOf(url).image).toBeUndefined()
  })
})

// 路径本身是符号链接 → 不跟（真的桌面 port.readLink）；中间段是链接的照常读。
// 门在这里是恒放行的 spy：看的是「问没问、问的是哪一条写法」，判定本身在 writeAskWiring.test
describe.skipIf(process.platform === 'win32')('read 工具 - 符号链接不跟（RD-L）', () => {
  /** fixture 都放在 links/ 下（随 TEST_DIR 一起清掉） */
  const L = join(TEST_DIR, 'links')

  /** 抓住一次拒绝的原话（没拒就判红） */
  /**
   * P1-04 起拒绝收成 isError 结果（裁定 Q12，文字即原话）；调用本身被取消时才照旧抛出 —— 两种都认
   */
  const messageOf = async (work: Promise<InvokedToolResult>): Promise<string> => {
    let res: InvokedToolResult
    try {
      res = await work
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
    if (res.isError) return resultText(res)
    throw new Error('expected the read to be refused')
  }

  /**
   * links/ 下：realdir/f.txt、dirlink → links/realdir；dangling → links/nowhere.txt（悬空），
   * 旁边一个 dangling-sibling.txt —— 换成不是链接的名字，「Did you mean」就有东西可建议；
   * pic.png → TEST_DIR/screenshot.png（超宽度上限：真跟过去就会解码、落一张派生图）
   */
  beforeAll(() => {
    mkdirSync(join(L, 'realdir'), { recursive: true })
    writeFileSync(join(L, 'realdir', 'f.txt'), 'through the link\n')
    symlinkSync(join(L, 'realdir'), join(L, 'dirlink'))
    symlinkSync(join(L, 'nowhere.txt'), join(L, 'dangling'))
    writeFileSync(join(L, 'dangling-sibling.txt'), 'x')
    symlinkSync(join(TEST_DIR, 'screenshot.png'), join(L, 'pic.png'))
  })

  beforeEach(() => enforcePath.mockClear())

  it('RD-L1 指向目录的链接本身：拒（门都不问）；经它读里面的文件：照常读到，门恰问一次、问的是写法那一条', async () => {
    const link = join(L, 'dirlink')
    const real = realpathSync.native(join(L, 'realdir'))

    expect(await messageOf(executeTool(makeReadTool(ctx), 'rdl1a', { path: link }))).toContain(
      `${link} is a symbolic link to ${real}. Symbolic links are not followed`
    )
    expect(enforcePath).not.toHaveBeenCalled()

    const through = join(link, 'f.txt')
    const result = await executeTool(makeReadTool(ctx), 'rdl1b', { path: through })
    expect(getText(result)).toContain('through the link')
    expect(enforcePath).toHaveBeenCalledTimes(1)
    expect(enforcePath.mock.calls[0].slice(0, 2)).toEqual(['read', through])
  })

  it('RD-L2 悬空链接：拒的是链接这一条 —— 不是 File not found，也不给 Did you mean（对照：同目录里真不存在的名字才给）', async () => {
    const link = join(L, 'dangling')

    const msg = await messageOf(executeTool(makeReadTool(ctx), 'rdl2a', { path: link }))
    expect(msg).toContain(
      `${link} is a symbolic link to ${join(realpathSync.native(L), 'nowhere.txt')}.`
    )
    expect(msg).not.toContain('File not found')
    expect(msg).not.toContain('Did you mean')
    expect(enforcePath).not.toHaveBeenCalled()

    // 对照：同一个目录里一个真不存在（不是链接）的名字 —— 相似路径建议照常出现
    const missing = await messageOf(
      executeTool(makeReadTool(ctx), 'rdl2b', { path: join(L, 'danglin') })
    )
    expect(missing).toContain('File not found')
    expect(missing).toContain('Did you mean')
  })

  it('RD-L3 带图片扩展名的链接：在解码之前就拒 —— nativeImage 一次都没碰，tool_results 里什么都没多', async () => {
    const link = join(L, 'pic.png')
    const derivedDir = toolResultsDir(SESSION_ID)
    const derivedBefore = existsSync(derivedDir) ? readdirSync(derivedDir).length : 0

    expect(await messageOf(executeTool(makeReadTool(ctx), 'rdl3', { path: link }))).toContain(
      `${link} is a symbolic link to ${realpathSync.native(join(TEST_DIR, 'screenshot.png'))}.`
    )
    expect(nativeImageStub.decodes).toBe(0)
    expect(nativeImageStub.calls).toBe(0)
    expect(existsSync(derivedDir) ? readdirSync(derivedDir).length : 0).toBe(derivedBefore)
    expect(enforcePath).not.toHaveBeenCalled()
  })
})
