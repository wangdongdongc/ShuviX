/**
 * previewFile / classifyPreviewFile 共享内核单测 —— 内存 FileSystemPort 上验证分类路由，
 * 重点覆盖 office kind（docx/sheet 路由、size 门控不读字节、base64 往返）、
 * 二进制（NULL 嗅探 → binary，hex 视图已移除）、各 size cap 的边界与「只嗅探一次」的内存不变量、
 * 错误分支（不存在 / 目录 / 非常规文件 / stat 或读取抛错），以及「分类与预览结果同一份判定」。
 */

import { describe, it, expect } from 'vitest'
import {
  classifyPreviewFile,
  isPreviewable,
  previewFile,
  PREVIEW_EBOOK_MAX_BYTES,
  PREVIEW_IMAGE_MAX_BYTES,
  PREVIEW_OFFICE_MAX_BYTES,
  PREVIEW_TEXT_MAX_BYTES,
  type PreviewClass
} from '../preview'
import type { FileSystemPort } from '../port'

interface MemFile {
  /** 文件内容；size 未显式给出时取 bytes.length */
  bytes?: Uint8Array
  /** 显式声明 size（测 size 门控时不提供 bytes —— 一旦被读即抛错） */
  size?: number
  /** stat 报成什么：缺省普通文件 */
  type?: 'file' | 'dir' | 'other'
  /** stat 直接抛这个错 */
  statThrows?: string
  /** readBytes 抛这个错 */
  readThrows?: string
}

interface ReadCall {
  path: string
  offset: number
  length: number
}

/** 构造只实现 stat/readBytes 的内存 port（previewFile 只用这两个方法），记录每次 readBytes 的范围 */
function memPort(files: Record<string, MemFile>): FileSystemPort & { reads: ReadCall[] } {
  const reads: ReadCall[] = []
  return {
    reads,
    stat: (path) => {
      const f = files[path]
      if (f?.statThrows) return Promise.reject(new Error(f.statThrows))
      return Promise.resolve(
        f
          ? {
              isFile: (f.type ?? 'file') === 'file',
              isDirectory: f.type === 'dir',
              size: f.size ?? f.bytes?.length ?? 0,
              mtimeMs: 0
            }
          : null
      )
    },
    readBytes: (path, offset, length) => {
      const f = files[path]
      reads.push({ path, offset, length })
      if (f?.readThrows) return Promise.reject(new Error(f.readThrows))
      if (!f?.bytes) throw new Error(`unexpected readBytes(${path})`)
      return Promise.resolve(f.bytes.subarray(offset, offset + length))
    },
    readTextLines: () => {
      throw new Error('not used by previewFile')
    },
    readFile: () => {
      throw new Error('not used by previewFile')
    },
    writeFile: () => {
      throw new Error('not used by previewFile')
    },
    readdir: () => {
      throw new Error('not used by previewFile')
    }
  }
}

/** 惰性大文件：size 很大，但只允许读前 n 字节（读多了就抛 —— 证明没有整读） */
function sparseFile(size: number, head: Uint8Array): MemFile {
  return { size, bytes: head }
}

/** 最小 PNG 头：8 字节签名 + IHDR 块（宽高大端 uint32），足够 parseImagePixelSize 识别 */
function pngHeader(width: number, height: number): Uint8Array {
  const b = new Uint8Array(33)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  const dv = new DataView(b.buffer)
  dv.setUint32(8, 13) // IHDR length
  b.set([0x49, 0x48, 0x44, 0x52], 12) // 'IHDR'
  dv.setUint32(16, width)
  dv.setUint32(20, height)
  b[24] = 8 // bit depth
  b[25] = 2 // color type
  return b
}

const decodeB64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

const DOCX_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])

describe('previewFile — office kind', () => {
  it.each([
    ['a.docx', 'docx'],
    ['a.xlsx', 'sheet'],
    ['a.xlsm', 'sheet'],
    ['a.xls', 'sheet'],
    ['a.ods', 'sheet'],
    ['UPPER.DOCX', 'docx'] // 扩展名大小写不敏感
  ] as const)('routes %s → office/%s with base64 payload', async (name, officeKind) => {
    const port = memPort({ [name]: { bytes: DOCX_BYTES } })
    const r = await previewFile(port, name)
    expect(r).toMatchObject({ kind: 'office', officeKind, size: DOCX_BYTES.length })
    if (r.kind !== 'office') return
    // base64 往返 —— 渲染端 atob 解出的字节必须与源一致
    expect(decodeB64(r.dataBase64)).toEqual(DOCX_BYTES)
  })

  it('gates oversized office files to too-large without reading bytes', async () => {
    const port = memPort({ 'big.xlsx': { size: PREVIEW_OFFICE_MAX_BYTES + 1 } })
    const r = await previewFile(port, 'big.xlsx')
    expect(r).toMatchObject({
      kind: 'too-large',
      size: PREVIEW_OFFICE_MAX_BYTES + 1,
      cap: PREVIEW_OFFICE_MAX_BYTES
    })
    expect(port.reads).toEqual([])
  })

  it.each([
    ['book.epub', 'epub'],
    ['story.fb2', 'fb2'],
    ['comic.cbz', 'cbz'],
    ['UPPER.EPUB', 'epub'] // 扩展名大小写不敏感
  ] as const)('routes %s → ebook/%s without reading any bytes', async (name, ebookKind) => {
    // 关键不变量：ebook 结果不带字节 —— 渲染端自己按 URL 取，几十 MB 不走 IPC
    const port = memPort({ [name]: { size: 40 * 1024 * 1024 } })
    const r = await previewFile(port, name)
    expect(r).toMatchObject({ kind: 'ebook', ebookKind, size: 40 * 1024 * 1024 })
    expect(port.reads).toEqual([])
    expect(r).not.toHaveProperty('dataBase64')
  })

  it('keeps .cbz out of the archive placeholder path (it is a readable page series)', async () => {
    const port = memPort({ 'c.cbz': { size: 10 }, 'plain.zip': { size: 10 } })
    expect(await previewFile(port, 'c.cbz')).toMatchObject({ kind: 'ebook' })
    expect(await previewFile(port, 'plain.zip')).toMatchObject({ kind: 'binary' })
  })

  it('gates absurdly large e-books to too-large', async () => {
    const port = memPort({ 'huge.epub': { size: PREVIEW_EBOOK_MAX_BYTES + 1 } })
    expect(await previewFile(port, 'huge.epub')).toMatchObject({
      kind: 'too-large',
      cap: PREVIEW_EBOOK_MAX_BYTES
    })
    expect(port.reads).toEqual([])
  })

  it('keeps non-renderable rich containers on the binary placeholder', async () => {
    const port = memPort({
      'legacy.doc': { size: 10 },
      'deck.pptx': { size: 10 },
      'bundle.zip': { size: 10 }
    })
    for (const name of ['legacy.doc', 'deck.pptx', 'bundle.zip']) {
      expect(await previewFile(port, name)).toMatchObject({ kind: 'binary' })
    }
    expect(port.reads).toEqual([])
  })

  it('still classifies plain text as text', async () => {
    const bytes = new TextEncoder().encode('hello\nworld\n')
    const port = memPort({ 'notes.txt': { bytes } })
    expect(await previewFile(port, 'notes.txt')).toMatchObject({
      kind: 'text',
      content: 'hello\nworld\n',
      lines: 3
    })
  })
})

describe('binary sniffing (no hex view any more)', () => {
  it('K-1 a NUL byte in an unknown file → binary with no payload, never hex', async () => {
    const bytes = new Uint8Array([0x41, 0x42, 0x00, 0x43])
    const port = memPort({ blob: { bytes }, 'x.unknownext': { bytes } })
    for (const name of ['blob', 'x.unknownext']) {
      const c = await classifyPreviewFile(port, name)
      expect(c.kind).toBe('binary')
      const r = await previewFile(port, name)
      expect(r.kind).toBe('binary')
      expect(r.kind).not.toBe('hex')
      expect(r).toMatchObject({ kind: 'binary', path: name, size: 4 })
      expect(r).not.toHaveProperty('dataBase64')
      expect(r).not.toHaveProperty('content')
      expect(r).not.toHaveProperty('bytes')
    }
  })

  it('K-2 sniffing a 5 MB unknown file reads at most 8192 bytes, exactly once', async () => {
    const head = new Uint8Array(8192).fill(0x61)
    head[100] = 0 // binary
    const port = memPort({ 'big.unknown': sparseFile(5 * 1024 * 1024, head) })
    const c = await classifyPreviewFile(port, 'big.unknown')
    expect(c).toMatchObject({ kind: 'binary', size: 5 * 1024 * 1024 })
    expect(port.reads).toEqual([{ path: 'big.unknown', offset: 0, length: 8192 }])

    port.reads.length = 0
    expect(await previewFile(port, 'big.unknown')).toMatchObject({ kind: 'binary' })
    expect(port.reads).toHaveLength(1)
    expect(port.reads[0].length).toBeLessThanOrEqual(8192)
  })

  it('K-2 a NUL past the first 8192 bytes is not seen (sniff is bounded)', async () => {
    const bytes = new Uint8Array(9000).fill(0x61)
    bytes[8500] = 0
    const port = memPort({ 'late.log': { bytes } })
    expect((await classifyPreviewFile(port, 'late.log')).kind).toBe('text')
    expect(port.reads).toEqual([{ path: 'late.log', offset: 0, length: 8192 }])
  })
})

describe('size caps', () => {
  it('K-3 text one byte over the cap → too-large, only the sniff read happened', async () => {
    const head = new Uint8Array(8192).fill(0x61)
    const port = memPort({ 'huge.txt': sparseFile(PREVIEW_TEXT_MAX_BYTES + 1, head) })
    const r = await previewFile(port, 'huge.txt')
    expect(r).toEqual({
      kind: 'too-large',
      path: 'huge.txt',
      size: PREVIEW_TEXT_MAX_BYTES + 1,
      cap: PREVIEW_TEXT_MAX_BYTES
    })
    expect(port.reads).toEqual([{ path: 'huge.txt', offset: 0, length: 8192 }])
  })

  it('K-3 text exactly at the cap → text', async () => {
    const bytes = new Uint8Array(PREVIEW_TEXT_MAX_BYTES).fill(0x61)
    const port = memPort({ 'edge.txt': { bytes } })
    expect(await classifyPreviewFile(port, 'edge.txt')).toMatchObject({
      kind: 'text',
      size: PREVIEW_TEXT_MAX_BYTES
    })
    const r = await previewFile(port, 'edge.txt')
    expect(r.kind).toBe('text')
    if (r.kind === 'text') expect(r.content.length).toBe(PREVIEW_TEXT_MAX_BYTES)
  })

  it('K-4 image over the cap → too-large without any read', async () => {
    const port = memPort({ 'big.png': { size: PREVIEW_IMAGE_MAX_BYTES + 1 } })
    expect(await previewFile(port, 'big.png')).toMatchObject({
      kind: 'too-large',
      size: PREVIEW_IMAGE_MAX_BYTES + 1,
      cap: PREVIEW_IMAGE_MAX_BYTES
    })
    expect(port.reads).toEqual([])
  })

  it('K-4 svg → image/svg+xml with no pixel size', async () => {
    const bytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="10"/>')
    const port = memPort({ 'fig.svg': { bytes } })
    const r = await previewFile(port, 'fig.svg')
    expect(r).toMatchObject({ kind: 'image', mimeType: 'image/svg+xml', ext: '.svg' })
    if (r.kind !== 'image') return
    expect(r.pixelWidth).toBeUndefined()
    expect(r.pixelHeight).toBeUndefined()
    expect(decodeB64(r.dataBase64)).toEqual(bytes)
  })

  it('K-4 small png with a 40×24 IHDR → pixel size and base64 round trip', async () => {
    const bytes = pngHeader(40, 24)
    const port = memPort({ 'pic.png': { bytes } })
    const r = await previewFile(port, 'pic.png')
    expect(r).toMatchObject({
      kind: 'image',
      mimeType: 'image/png',
      size: bytes.length,
      pixelWidth: 40,
      pixelHeight: 24
    })
    if (r.kind === 'image') expect(decodeB64(r.dataBase64)).toEqual(bytes)
  })
})

describe('streamed kinds never read bytes', () => {
  const FIVE_GB = 5 * 1024 * 1024 * 1024
  it.each([
    ['doc.pdf', { kind: 'pdf' }],
    ['clip.mp4', { kind: 'media', mediaType: 'video', mimeType: 'video/mp4' }],
    ['CLIP.MOV', { kind: 'media', mediaType: 'video', mimeType: 'video/quicktime' }],
    ['song.mp3', { kind: 'media', mediaType: 'audio', mimeType: 'audio/mpeg' }],
    ['voice.opus', { kind: 'media', mediaType: 'audio', mimeType: 'audio/opus' }]
  ] as const)('K-5 %s at 5 GB → %o, no reads', async (name, expected) => {
    const port = memPort({ [name]: { size: FIVE_GB } })
    const c = await classifyPreviewFile(port, name)
    expect(c).toMatchObject({ ...expected, size: FIVE_GB })
    const r = await previewFile(port, name)
    expect(r).toMatchObject({ ...expected, size: FIVE_GB, path: name })
    expect(port.reads).toEqual([])
  })
})

describe('isPreviewable', () => {
  const cases: Array<[PreviewClass, boolean]> = [
    [{ kind: 'pdf', size: 1, ext: '.pdf' }, true],
    [{ kind: 'media', mediaType: 'video', mimeType: 'video/mp4', size: 1, ext: '.mp4' }, true],
    [{ kind: 'media', mediaType: 'audio', mimeType: 'audio/mpeg', size: 1, ext: '.mp3' }, true],
    [{ kind: 'image', mimeType: 'image/png', size: 1, ext: '.png' }, true],
    [{ kind: 'ebook', ebookKind: 'epub', size: 1, ext: '.epub' }, true],
    [{ kind: 'office', officeKind: 'docx', size: 1, ext: '.docx' }, true],
    [{ kind: 'text', size: 0, ext: '.txt' }, true],
    [{ kind: 'binary', size: 1, ext: '.bin' }, false],
    [{ kind: 'too-large', size: 2, cap: 1 }, false],
    [{ kind: 'error', message: 'x' }, false]
  ]
  it.each(cases)('K-6 %o → %s', (c, expected) => {
    expect(isPreviewable(c)).toBe(expected)
  })
})

describe('error classes', () => {
  const port = memPort({
    dir: { type: 'dir' },
    fifo: { type: 'other' },
    boom: { statThrows: 'EACCES: permission denied' }
  })
  it.each([
    ['missing.txt', 'File not found'],
    ['dir', 'Path is a directory'],
    ['fifo', 'Path is not a regular file'],
    ['boom', 'EACCES: permission denied']
  ])('K-7 %s → error %s (classify and previewFile)', async (name, message) => {
    expect(await classifyPreviewFile(port, name)).toEqual({ kind: 'error', message })
    expect(await previewFile(port, name)).toEqual({ kind: 'error', path: name, message })
    expect(port.reads).toEqual([])
  })

  it('K-8 the sniff read throwing → error', async () => {
    const p = memPort({ 'locked.log': { size: 100, readThrows: 'EIO: i/o error' } })
    expect(await classifyPreviewFile(p, 'locked.log')).toEqual({
      kind: 'error',
      message: 'EIO: i/o error'
    })
    expect(await previewFile(p, 'locked.log')).toEqual({
      kind: 'error',
      path: 'locked.log',
      message: 'EIO: i/o error'
    })
  })
})

describe('empty files', () => {
  it('K-9 empty .log → text with empty content, 0 lines, no read', async () => {
    const port = memPort({ 'empty.log': { size: 0 } })
    expect(await previewFile(port, 'empty.log')).toEqual({
      kind: 'text',
      path: 'empty.log',
      content: '',
      size: 0,
      lines: 0,
      ext: '.log'
    })
    expect(port.reads).toEqual([])
  })

  it('K-9 empty .png → image with an empty payload, no read', async () => {
    const port = memPort({ 'empty.png': { size: 0 } })
    const r = await previewFile(port, 'empty.png')
    expect(r).toMatchObject({ kind: 'image', dataBase64: '', size: 0, mimeType: 'image/png' })
    expect(port.reads).toEqual([])
  })
})

describe('classify and preview agree', () => {
  it('K-10 previewFile returns the kind classifyPreviewFile decided, across a fixture set', async () => {
    const text = new TextEncoder().encode('a\nb')
    const nul = new Uint8Array([1, 0, 2])
    const files: Record<string, MemFile> = {
      'a.txt': { bytes: text },
      'a.ts': { bytes: text },
      noext: { bytes: nul },
      'a.bin': { size: 3 },
      'a.png': { bytes: pngHeader(2, 3) },
      'a.svg': { bytes: text },
      'big.png': { size: PREVIEW_IMAGE_MAX_BYTES + 1 },
      'a.pdf': { size: 10 },
      'a.mp4': { size: 10 },
      'a.wav': { size: 10 },
      'a.epub': { size: 10 },
      'a.docx': { bytes: DOCX_BYTES },
      'a.zip': { size: 10 },
      dir: { type: 'dir' }
    }
    const port = memPort(files)
    for (const name of [...Object.keys(files), 'missing.md']) {
      const c = await classifyPreviewFile(port, name)
      const r = await previewFile(port, name)
      expect(r.kind, name).toBe(c.kind)
    }
  })

  it('K-11 previewFile reports displayPath while reading portPath', async () => {
    const bytes = new TextEncoder().encode('hi')
    const port = memPort({ '/abs/real.txt': { bytes }, '/abs/doc.pdf': { size: 5 } })
    const r = await previewFile(port, '/abs/real.txt', 'shown/real.txt')
    expect(r).toMatchObject({ kind: 'text', path: 'shown/real.txt', content: 'hi' })
    expect(port.reads.every((c) => c.path === '/abs/real.txt')).toBe(true)
    expect(await previewFile(port, '/abs/doc.pdf', 'x.pdf')).toMatchObject({
      kind: 'pdf',
      path: 'x.pdf'
    })
    expect(await previewFile(port, '/abs/none.txt', 'y.txt')).toMatchObject({
      kind: 'error',
      path: 'y.txt'
    })
  })
})
