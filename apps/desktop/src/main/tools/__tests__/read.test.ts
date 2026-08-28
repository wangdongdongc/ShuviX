/**
 * read 工具集成测试
 * 使用临时文件/目录，mock resolveProjectConfig 和 i18n
 */

import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from 'vitest'
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  existsSync,
  rmSync
} from 'node:fs'
import { deflateSync } from 'node:zlib'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'

const TEST_DIR = join(tmpdir(), 'shuvix-read-test-' + Date.now())
/** 假 userData —— 派生图落盘走真实的 utils/paths.ts（getToolResultsDir），必须给它一个真目录 */
const USER_DATA_DIR = join(tmpdir(), 'shuvix-read-test-userdata-' + Date.now())
const SESSION_ID = 'test-session'

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
    enforcePath: async () => {},
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

// mock electron — read.ts 需要 nativeImage（图片压缩）与 app.getPath（派生图落盘目录）
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
    app: { getPath: () => USER_DATA_DIR, isPackaged: false },
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
vi.mock('markitdown-ts', () => ({
  MarkItDown: class {
    async convert(source: string): Promise<{ title: string | null; markdown: string } | null> {
      // URL mock：模拟网页抓取
      if (typeof source === 'string' && /^https?:\/\//i.test(source)) {
        if (source.includes('empty-page')) {
          return { title: null, markdown: '' }
        }
        if (source.includes('fail-convert')) {
          throw new Error('Network error')
        }
        return { title: 'Mock Page', markdown: '# Mock Page\n\nMock content from URL.' }
      }
      return { title: null, markdown: '' }
    }
  }
}))
vi.mock('word-extractor', () => ({
  default: class {
    extract(): { getBody: () => string } {
      return { getBody: () => '' }
    }
  }
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

/** execute 的返回类型是 AgentToolResult<unknown>，details 按 read 详情读 */
const detailsOf = (result: { details?: unknown }): ReadToolDetails =>
  result.details as ReadToolDetails

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

afterEach(() => {
  Object.assign(nativeImageStub, defaultImageStub())
  persistFailure.on = false
})

describe('read 工具 - 纯文本文件', () => {
  it('读取纯文本文件返回带行号的内容', async () => {
    const tool = makeReadTool(ctx)
    const result = await tool.execute('tc1', { path: join(TEST_DIR, 'hello.txt') })
    const text = getText(result)
    // 应包含行号
    expect(text).toContain('1│line1')
    expect(text).toContain('5│line5')
  })

  it('分页读取 offset/limit', async () => {
    const tool = makeReadTool(ctx)
    const result = await tool.execute('tc2', {
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
    const result = await tool.execute('tc3', { path: join(TEST_DIR, 'empty.txt') })
    expect(getText(result)).toBeDefined()
    expect((result.details as { totalLines: number }).totalLines).toBeLessThanOrEqual(1)
  })
})

describe('read 工具 - 单行截断', () => {
  it('超长单行被截断到 2000 字符', async () => {
    const tool = makeReadTool(ctx)
    const result = await tool.execute('tc4', { path: join(TEST_DIR, 'minified.js') })
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
    const result = await tool.execute('tc5', { path: join(TEST_DIR, 'subdir') })
    const text = getText(result)
    // 目录条目加 / 后缀
    expect(text).toContain('nested/')
    // 文件条目不加 /
    expect(text).toContain('a.ts')
  })

  it('目录分页 offset/limit', async () => {
    const tool = makeReadTool(ctx)
    const result = await tool.execute('tc6', {
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
    try {
      await tool.execute('tc7', { path: join(TEST_DIR, 'readme') })
      expect.fail('应该抛错')
    } catch (err: unknown) {
      expect(err instanceof Error ? err.message : '').toContain('Did you mean')
    }
  })

  it('无近似文件时返回普通 fileNotFound', async () => {
    const tool = makeReadTool(ctx)
    try {
      await tool.execute('tc8', { path: join(TEST_DIR, 'zzzznonexistent') })
      expect.fail('应该抛错')
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : ''
      expect(msg).toContain('File not found')
      expect(msg).not.toContain('Did you mean')
    }
  })
})

describe('read 工具 - 二进制文件拒绝', () => {
  it('已知扩展名直接拒绝', async () => {
    const tool = makeReadTool(ctx)
    try {
      await tool.execute('tc9', { path: join(TEST_DIR, 'archive.exe') })
      expect.fail('应该抛错')
    } catch (err: unknown) {
      expect(err instanceof Error ? err.message : '').toContain('Unsupported format')
    }
  })

  it('NULL 字节检测拒绝', async () => {
    const tool = makeReadTool(ctx)
    try {
      await tool.execute('tc10', { path: join(TEST_DIR, 'binary.log') })
      expect.fail('应该抛错')
    } catch (err: unknown) {
      expect(err instanceof Error ? err.message : '').toContain('Unsupported format')
    }
  })
})

describe('read 工具 - 大文件字节上限', () => {
  it('超 50KB 时截断并提示 offset', async () => {
    const tool = makeReadTool(ctx)
    const result = await tool.execute('tc11', {
      path: join(TEST_DIR, 'largedir', 'large.txt')
    })
    const text = getText(result)
    expect((result.details as { truncated: boolean }).truncated).toBe(true)
    // 应包含截断提示
    expect(text).toContain('offset=')
  })
})

describe('read 工具 - URL 抓取', () => {
  it('URL 正确路由到 readUrl 并返回 Markdown', async () => {
    const tool = makeReadTool(ctx)
    const result = await tool.execute('tc-url1', {
      path: 'https://example.com/page'
    })
    const text = getText(result)
    const details = result.details as { format: string; converted: boolean; url: string }
    expect(text).toContain('URL: https://example.com/page')
    expect(text).toContain('Mock Page')
    expect(text).toContain('Mock content from URL.')
    expect(details.format).toBe('URL')
    expect(details.converted).toBe(true)
    expect(details.url).toBe('https://example.com/page')
  })

  it('URL 返回包含页面标题', async () => {
    const tool = makeReadTool(ctx)
    const result = await tool.execute('tc-url2', {
      path: 'https://example.com/page'
    })
    const text = getText(result)
    expect(text).toContain('— Mock Page —')
  })

  it('URL 抓取失败返回合适的错误', async () => {
    const tool = makeReadTool(ctx)
    try {
      await tool.execute('tc-url3', { path: 'https://fail-convert.example.com' })
      expect.fail('应该抛错')
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : ''
      expect(msg).toContain('Failed to fetch URL')
      expect(msg).toContain('Network error')
    }
  })

  it('URL 返回空内容时报错', async () => {
    const tool = makeReadTool(ctx)
    try {
      await tool.execute('tc-url4', { path: 'https://empty-page.example.com' })
      expect.fail('应该抛错')
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : ''
      expect(msg).toContain('Failed to fetch URL')
    }
  })

  it('http URL 也能正确识别', async () => {
    const tool = makeReadTool(ctx)
    const result = await tool.execute('tc-url5', {
      path: 'http://example.com/page'
    })
    const text = getText(result)
    expect(text).toContain('URL: http://example.com/page')
    expect(text).toContain('Mock content from URL.')
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
    const result = await tool.execute('tc-img1', { path: png })
    const details = detailsOf(result)
    expect(details.image?.path).toBe(png)
    expect(details.image?.bytes).toBe(statSync(png).size)
    expect(details.format).toBe('PNG')
    expect(details.truncated).toBe(false)

    // 同一份 PNG 字节换个扩展名：format / mimeType 跟 ext 走，不嗅探内容
    const jpeg = join(TEST_DIR, 'photo.jpeg')
    const asJpeg = await tool.execute('tc-img2', { path: jpeg })
    expect(detailsOf(asJpeg).format).toBe('JPEG')
    expect(detailsOf(asJpeg).image?.path).toBe(jpeg)
    expect(imageContent(asJpeg)?.mimeType).toBe('image/jpeg')
  })

  it('交给模型的字节与 image.path 所指文件同源，宽高取自文件头', async () => {
    const tool = makeReadTool(ctx)
    const result = await tool.execute('tc-img3', { path: join(TEST_DIR, 'small.png') })
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
    const result = await tool.execute('tc-img4', { path: broken })
    const details = detailsOf(result)
    expect(details.image?.path).toBe(broken)
    expect(details.image?.bytes).toBe(statSync(broken).size)
    expect(details.image?.width).toBeUndefined()
    expect(details.image?.height).toBeUndefined()
    expect(imageContent(result)).toBeDefined()
  })

  it('相对路径入参也回绝对路径', async () => {
    const tool = makeReadTool(ctx)
    const result = await tool.execute('tc-img5', { path: 'small.png' })
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

    const result = await makeReadTool(ctx).execute('tc-px1', { path: shot })
    const details = detailsOf(result)
    expect(details.truncated).toBe(true)
    expect(details.format).toBe('JPEG')
    expect(modelSize(result)).toEqual({ w: 1024, h: 640 })
  })

  it('整页长截图原样透传：缩到 1024 宽后仍在上游 cap 之上，省不下 token', async () => {
    // 实测回归：2428×3484 曾被面积预算压成 646×927，正文糊掉，而 token 一个没省 ——
    // 透传与缩放都落在 895×1284 ≈ 1533 tokens，透传还少一次重采样。
    const tall = join(TEST_DIR, 'tallpage.png')
    const result = await makeReadTool(ctx).execute('tc-px2', { path: tall })
    const details = detailsOf(result)
    expect(details.truncated).toBe(false)
    expect(details.format).toBe('PNG')
    expect(details.image?.path).toBe(tall)
    expect(nativeImageStub.decodes).toBe(0) // 连解码都没做
    expect(imageContent(result)?.data).toBe(readFileSync(tall).toString('base64'))
  })

  it('透传的整页截图带一句可操作提示：换视口或单个元素', async () => {
    const result = await makeReadTool(ctx).execute('tc-px3', {
      path: join(TEST_DIR, 'tallpage.png')
    })
    expect(textContent(result)).toContain('Capture the viewport or a single element')
  })

  it('宽度上限生效：超宽图按宽度缩，不按面积', async () => {
    nativeImageStub.size = { width: 2000, height: 200 }
    const result = await makeReadTool(ctx).execute('tc-px4', { path: join(TEST_DIR, 'wide.png') })
    expect(modelSize(result).w).toBe(1024)
  })

  it('已在宽度上限内：透传，不解码也不提示', async () => {
    const square = join(TEST_DIR, 'square.png') // 1000×900，1000 < 1024
    const result = await makeReadTool(ctx).execute('tc-px5', { path: square })
    expect(detailsOf(result).truncated).toBe(false)
    expect(nativeImageStub.decodes).toBe(0)
    expect(textContent(result)).not.toContain('Capture the viewport')
  })

  it('宽度达标、只是字节超限：降质量，不动分辨率', async () => {
    const heavy = join(TEST_DIR, 'heavy.png')
    expect(statSync(heavy).size).toBeGreaterThan(1024 * 1024)
    nativeImageStub.size = { width: 800, height: 600 } // 800 < 1024，宽度没问题
    nativeImageStub.jpegBytes = (quality) => (quality >= 85 ? 2 * 1024 * 1024 : 300 * 1024)

    const result = await makeReadTool(ctx).execute('tc-px6', { path: heavy })
    expect(modelSize(result)).toEqual({ w: 800, h: 600 }) // 分辨率原封不动
    expect(detailsOf(result).image?.bytes).toBe(300 * 1024)
  })

  it('超预算但解不了码：退回直出原图，不让整个 read 失败', async () => {
    nativeImageStub.isEmpty = true
    const shot = join(TEST_DIR, 'screenshot.png')
    const result = await makeReadTool(ctx).execute('tc-px7', { path: shot })
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
    const result = await makeReadTool(ctx).execute('tc-txt1', {
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
    const result = await makeReadTool(ctx).execute('tc-txt2', { path: join(TEST_DIR, 'small.png') })
    expect(textContent(result)).toBe(`Image: ${join(TEST_DIR, 'small.png')} (PNG 40×24)`)
  })
})

describe('read 工具 - 图片（超限压缩落盘）', () => {
  const big = join(TEST_DIR, 'big.png')

  it('details.image 指落进 tool_results 的派生 JPEG，与交给模型的字节同源', async () => {
    const tool = makeReadTool(ctx)
    const result = await tool.execute('tc-img6', { path: big })
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
    const result = await tool.execute('tc-img7', { path: big })
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
    const result = await tool.execute('tc-img8', { path: big })
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
      const first = await tool.execute('tc-img9a', { path: big })
      const second = await tool.execute('tc-img9b', { path: big })
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
    const result = await makeReadTool({ sessionId: '' }).execute('tc-img10', { path: big })
    expect(detailsOf(result).image).toBeUndefined()
    expect(imageContent(result)).toBeDefined()
    expect(existsSync(base) ? readdirSync(base) : []).toEqual(before)
  })

  it('nativeImage 解不开：抛错（与「落盘失败降级」是两回事）', async () => {
    nativeImageStub.isEmpty = true
    const tool = makeReadTool(ctx)
    try {
      await tool.execute('tc-img11', { path: big })
      expect.fail('应该抛错')
    } catch (err: unknown) {
      expect(err instanceof Error ? err.message : '').toContain('cannot be decoded')
    }
  })
})

describe('read 工具 - 非图片结果不带 image', () => {
  it('纯文本 / 目录 / URL 三条都没有 details.image', async () => {
    const tool = makeReadTool(ctx)
    const text = await tool.execute('tc-img12', { path: join(TEST_DIR, 'hello.txt') })
    const dir = await tool.execute('tc-img13', { path: join(TEST_DIR, 'subdir') })
    const url = await tool.execute('tc-img14', { path: 'https://example.com/page' })
    expect(detailsOf(text).image).toBeUndefined()
    expect(detailsOf(dir).image).toBeUndefined()
    expect(detailsOf(url).image).toBeUndefined()
  })
})
