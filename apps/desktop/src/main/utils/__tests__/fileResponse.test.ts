/**
 * `utils/fileResponse.ts` —— 把本机文件回给页面时的两样纯计算（桌面的 `shuvix-preview://` 与网络服务的 `/files/*`
 * 共用，server mode phase D）：
 *
 *   FR-1 previewMimeOf：表里每一项都映射得上（共 22 项）；几组字面量钉死；扩展名不分大小写；不认识的（含没有
 *        扩展名、`a.tar.gz`、点文件 `/x/.png`）→ application/octet-stream
 *   FR-2 parseByteRange（size 10）：没有头 → 整个；单段的几种写法 → 那一段；缺省（legacy）的后缀读法照旧
 *        （`bytes=-4` → 0..4、`bytes=-` → 0..9）；落在文件外 → 不可满足；空文件；认不出的写法 → 整个。
 *        `suffix: 'rfc'`（网络服务的 `/files/*`）：`bytes=-N` 是最后 N 个字节，`bytes=-0` 不可满足，`bytes=-`
 *        认不出（整个），空文件上的后缀范围不可满足；非后缀的写法两种读法一样
 */
import { describe, expect, it } from 'vitest'
import { PREVIEW_MIME_BY_EXT, parseByteRange, previewMimeOf, type ByteRange } from '../fileResponse'

const full: ByteRange = { kind: 'full' }
const none: ByteRange = { kind: 'unsatisfiable' }
const part = (start: number, end: number): ByteRange => ({ kind: 'partial', start, end })

describe('FR-1 previewMimeOf', () => {
  it('FR-1 表里每一项都映射得上；共 22 项', () => {
    const entries = Object.entries(PREVIEW_MIME_BY_EXT)
    expect(entries).toHaveLength(22)
    for (const [ext, mime] of entries) {
      expect(previewMimeOf(`/x/a${ext}`), ext).toBe(mime)
      expect(previewMimeOf(`a${ext}`), ext).toBe(mime)
    }
  })

  it('FR-1 几组字面量', () => {
    expect(previewMimeOf('/a/b.png')).toBe('image/png')
    expect(previewMimeOf('/a/b.svg')).toBe('image/svg+xml')
    expect(previewMimeOf('/a/b.pdf')).toBe('application/pdf')
    expect(previewMimeOf('/a/b.m4a')).toBe('audio/mp4')
    expect(previewMimeOf('/a/b.opus')).toBe('audio/opus')
  })

  it('FR-1 扩展名不分大小写', () => {
    expect(previewMimeOf('/a/B.PNG')).toBe('image/png')
    expect(previewMimeOf('/a/clip.Mp4')).toBe('video/mp4')
  })

  it('FR-1 不认识的 → application/octet-stream（含没有扩展名、多段扩展名、点文件）', () => {
    for (const path of [
      '/a/notes.txt',
      '/a/page.html',
      '/a/archive.zip',
      '/a/app.js',
      '/a/README',
      '/a/a.tar.gz',
      '/x/.png'
    ]) {
      expect(previewMimeOf(path), path).toBe('application/octet-stream')
    }
  })
})

describe('FR-2 parseByteRange（size 10）', () => {
  it('FR-2 没有头 → 整个', () => {
    expect(parseByteRange(undefined, 10)).toStrictEqual(full)
    expect(parseByteRange(null, 10)).toStrictEqual(full)
    expect(parseByteRange('', 10)).toStrictEqual(full)
  })

  it('FR-2 单段 → 那一段（含两端）', () => {
    expect(parseByteRange('bytes=0-0', 10)).toStrictEqual(part(0, 0))
    expect(parseByteRange('bytes=2-5', 10)).toStrictEqual(part(2, 5))
    expect(parseByteRange('bytes=3-', 10)).toStrictEqual(part(3, 9))
    expect(parseByteRange('bytes=0-9', 10)).toStrictEqual(part(0, 9))
    expect(parseByteRange('bytes=9-9', 10)).toStrictEqual(part(9, 9))
  })

  it('FR-2 缺省（legacy）的后缀读法照旧：bytes=-4 → 0..4，bytes=- → 0..9；显式 legacy 同缺省', () => {
    expect(parseByteRange('bytes=-4', 10)).toStrictEqual(part(0, 4))
    expect(parseByteRange('bytes=-', 10)).toStrictEqual(part(0, 9))
    expect(parseByteRange('bytes=-4', 10, { suffix: 'legacy' })).toStrictEqual(part(0, 4))
    expect(parseByteRange('bytes=-', 10, { suffix: 'legacy' })).toStrictEqual(part(0, 9))
    expect(parseByteRange('bytes=-4', 10, {})).toStrictEqual(part(0, 4))
  })

  it('FR-2 落在文件外 → 不可满足', () => {
    for (const header of ['bytes=10-', 'bytes=0-10', 'bytes=5-3', 'bytes=99999999999999999999-']) {
      expect(parseByteRange(header, 10), header).toStrictEqual(none)
    }
  })

  it('FR-2 空文件：bytes=0- 不可满足；没有头 → 整个', () => {
    expect(parseByteRange('bytes=0-', 0)).toStrictEqual(none)
    expect(parseByteRange(undefined, 0)).toStrictEqual(full)
  })

  it('FR-2 认不出的写法 → 整个（多段、别的单位、大小写、空格、非数字、前导空格）', () => {
    for (const header of [
      'bytes=0-1,3-4',
      'items=0-1',
      'Bytes=0-1',
      'bytes = 0-1',
      'bytes=a-b',
      ' bytes=0-1'
    ]) {
      expect(parseByteRange(header, 10), header).toStrictEqual(full)
      expect(parseByteRange(header, 10, { suffix: 'rfc' }), `rfc ${header}`).toStrictEqual(full)
    }
  })

  it("FR-2 suffix:'rfc'：bytes=-N 是最后 N 个字节；超过文件 → 整个文件那一段；-0 不可满足；- → 整个", () => {
    const rfc = { suffix: 'rfc' } as const
    expect(parseByteRange('bytes=-4', 10, rfc)).toStrictEqual(part(6, 9))
    expect(parseByteRange('bytes=-20', 10, rfc)).toStrictEqual(part(0, 9))
    expect(parseByteRange('bytes=-10', 10, rfc)).toStrictEqual(part(0, 9))
    expect(parseByteRange('bytes=-1', 10, rfc)).toStrictEqual(part(9, 9))
    expect(parseByteRange('bytes=-0', 10, rfc)).toStrictEqual(none)
    expect(parseByteRange('bytes=-', 10, rfc)).toStrictEqual(full)
  })

  it("FR-2 suffix:'rfc'：空文件上的后缀范围不可满足", () => {
    expect(parseByteRange('bytes=-1', 0, { suffix: 'rfc' })).toStrictEqual(none)
  })

  it("FR-2 suffix:'rfc'：非后缀的写法与缺省读法一样", () => {
    for (const header of [
      undefined,
      'bytes=0-0',
      'bytes=2-5',
      'bytes=3-',
      'bytes=9-9',
      'bytes=10-',
      'bytes=0-10',
      'bytes=5-3'
    ]) {
      expect(parseByteRange(header, 10, { suffix: 'rfc' }), String(header)).toStrictEqual(
        parseByteRange(header, 10)
      )
    }
  })
})
