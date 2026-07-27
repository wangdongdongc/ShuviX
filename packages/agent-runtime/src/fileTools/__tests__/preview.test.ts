/**
 * previewFile 共享内核单测 —— 内存 FileSystemPort 上验证分类路由，
 * 重点覆盖 office kind（docx/sheet 路由、size 门控不读字节、base64 往返）
 * 及既有分支不回归（无渲染方案富容器占位 / 归档占位 / 文本回退）。
 */

import { describe, it, expect } from 'vitest'
import { previewFile, PREVIEW_OFFICE_MAX_BYTES, PREVIEW_EBOOK_MAX_BYTES } from '../preview'
import type { FileSystemPort } from '../port'

interface MemFile {
  /** 文件内容；size 未显式给出时取 bytes.length */
  bytes?: Uint8Array
  /** 显式声明 size（测 size 门控时不提供 bytes —— 一旦被读即抛错） */
  size?: number
}

/** 构造只实现 stat/readBytes 的内存 port（previewFile 只用这两个方法） */
function memPort(files: Record<string, MemFile>): FileSystemPort & { reads: string[] } {
  const reads: string[] = []
  return {
    reads,
    stat: (path) => {
      const f = files[path]
      return Promise.resolve(
        f
          ? {
              isFile: true,
              isDirectory: false,
              size: f.size ?? f.bytes?.length ?? 0,
              mtimeMs: 0
            }
          : null
      )
    },
    readBytes: (path, offset, length) => {
      const f = files[path]
      if (!f?.bytes) throw new Error(`unexpected readBytes(${path})`)
      reads.push(path)
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
    expect(Uint8Array.from(atob(r.dataBase64), (c) => c.charCodeAt(0))).toEqual(DOCX_BYTES)
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
