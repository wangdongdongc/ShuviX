/**
 * 摆给用户看的图的快照（services/shownImages.ts，2026-11-01，docs/show-image-design.md §4）—— `show_image` 与带图
 * 提议共用：按文件头认格式、快照进 `<userData>/shown/<会话 id>/`（内容寻址）、大位图另存展示副本、分支拷贝、删会话清理。
 *
 * 真 utils/paths（userData 指到临时目录），electron 的 nativeImage 按用例换桩，展示副本用注入的 resizer spy。
 *
 *   SN-1  sniffShownImageFormat：位图签名；SVG = BOM / 空白 / XML 声明 / 处理指令 / 注释 / doctype（含内部子集）之后
 *         第一个元素是 <svg；HTML、别的根元素、没写完的注释 / doctype / 子集 / PI、超过嗅探窗口的长注释 → undefined
 *   SN-2  正常路径：相对工作目录的 40×24 PNG → file = sha256 + .png、source = realpath、MIME、宽高、bytes，没有
 *         original；快照落在 shown/<sid>/<file>，字节一致
 *   SN-3  按内容认格式：叫 pic.jpg 的 PNG → .png；叫 x.png 的文本、空文件 → 「is not a PNG, JPEG, GIF, WebP or SVG image」
 *   SN-4  不存在 / 断掉的符号链接 → no such file（解析后的绝对路径）；目录 → not a file
 *   SN-5  大小上限：20971521 字节 → 原样的错误句（带两个字节数），不建快照目录、不读文件；恰 20971520 字节过了大小关、
 *         败在格式关
 *   SN-6  [合法, 不存在] → 错误点名 images[1].path
 *   SN-7  不安全的会话 id → This session cannot show images.，shown 下什么都不建
 *   SN-8  去重：一次调用里同一内容两条路径 → 同一个 file、盘上一份；再调一次不重写；别的会话各存一份
 *   SN-9  符号链接 → source 是目标的 realpath
 *   SN-10 展示副本（resizer spy）：长边超 2048 / 字节超 4 MiB 才做；GIF、SVG 不做；resizer 交回 null / 抛错 → 只用原图
 *         （抛错记一条 warn）；PNG 头读不出尺寸的大文件照样交给 resizer（size === null）
 *   SN-11 shownImageFilePath：合法 → <userData>/shown/<sid>/<file>；不安全的 id、坏名字 → undefined
 *   SN-12 shownImagePathOfRef：shown:<合法> → 路径；shown:../x.png、普通路径、合法引用 + 不安全 id → undefined
 *   SN-13 removeShownImages：只删 shown/<sid>；目录不在 no-op；''、'..'、'a/b' 什么都不删；rmSync 抛错也不抛
 *   SN-14 copyShownImages：同名逐字节拷过去、源不动；源目录不在 → 不建目标；不安全 id no-op；已有目标目录 → 合并
 *   SN-15 nativeDisplayResizer（nativeImage 桩）：size null 用解码尺寸；给的尺寸优先；png → toPNG、jpg / webp →
 *         toJPEG(90)；已在 2048 内不缩照样重编码；isEmpty / 尺寸为 0 / 编码出空 → null
 */
import { createHash } from 'crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  userData: '',
  warn: vi.fn(),
  /** nativeImage.createFromBuffer 的桩（SN-15 按用例换） */
  createFromBuffer: vi.fn(),
  /** fs.rmSync 的替身（缺省走真的；SN-13 让它抛） */
  rmSync: null as null | ((...args: unknown[]) => void),
  /** fs/promises.readFile 的调用记录（SN-5：超限的文件不读） */
  readPaths: [] as string[]
}))

vi.mock('electron', () => ({
  app: { getPath: () => h.userData, isPackaged: false, getAppPath: () => '/' },
  nativeImage: { createFromBuffer: (bytes: Buffer) => h.createFromBuffer(bytes) }
}))

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: h.warn, error: vi.fn(), debug: vi.fn() })
}))

vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>()
  const rm = ((...args: Parameters<typeof real.rmSync>) =>
    h.rmSync ? h.rmSync(...args) : real.rmSync(...args)) as typeof real.rmSync
  return { ...real, default: { ...real, rmSync: rm }, rmSync: rm }
})

vi.mock('fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs/promises')>()
  const readFile = ((path: unknown, ...rest: unknown[]) => {
    h.readPaths.push(String(path))
    return (real.readFile as (...a: unknown[]) => Promise<Buffer>)(path, ...rest)
  }) as typeof real.readFile
  return { ...real, default: { ...real, readFile }, readFile }
})

import {
  DISPLAY_MAX_BYTES,
  DISPLAY_MAX_EDGE,
  copyShownImages,
  nativeDisplayResizer,
  presentImages,
  removeShownImages,
  shownImageFilePath,
  shownImagePathOfRef,
  sniffShownImageFormat,
  type DisplayResizer
} from '../shownImages'

// ─── 夹具 ───────────────────────────────────────────────

const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'shuvix-shown-')))
h.userData = join(root, 'userData')
const WD = join(root, 'wd')
const SHOWN = join(h.userData, 'shown')
const shownDir = (sid: string): string => join(SHOWN, sid)

let seq = 0
/** 每个用例自己的会话 id（互不干扰） */
const freshSid = (): string => `sess-${++seq}`

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  mkdirSync(WD, { recursive: true })
  h.warn.mockClear()
  h.createFromBuffer.mockReset()
  h.rmSync = null
  h.readPaths.length = 0
})

const sha = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')

/** PNG：签名 + IHDR（宽高大端 uint32 在 16 / 20） */
function pngHeader(width: number, height: number): Buffer {
  const b = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'ascii')
  b.writeUInt32BE(width, 16)
  b.writeUInt32BE(height, 20)
  return b
}

/** GIF：'GIF89a' + 宽高小端 uint16 */
function gifHeader(width: number, height: number, magic = 'GIF89a'): Buffer {
  const b = Buffer.alloc(10)
  b.write(magic, 0, 'ascii')
  b.writeUInt16LE(width, 6)
  b.writeUInt16LE(height, 8)
  return b
}

/** JPEG：FFD8 + APP0 + SOF0 */
function jpegHeader(width: number, height: number): Buffer {
  const parts: number[] = [0xff, 0xd8, 0xff, 0xe0, 0x00, 16]
  for (let i = 0; i < 14; i++) parts.push(0)
  parts.push(0xff, 0xc0, 0x00, 0x11, 0x08)
  parts.push((height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff)
  for (let i = 0; i < 6; i++) parts.push(0)
  return Buffer.from(parts)
}

/** WebP VP8X：宽高 -1 存 24 位小端 */
function webpHeader(width: number, height: number): Buffer {
  const b = Buffer.alloc(30)
  b.write('RIFF', 0, 'ascii')
  b.write('WEBP', 8, 'ascii')
  b.write('VP8X', 12, 'ascii')
  b.writeUIntLE(width - 1, 24, 3)
  b.writeUIntLE(height - 1, 27, 3)
  return b
}

/** 头 + 补零到 total 字节（真实字节，头要能解析） */
const padded = (head: Buffer, total: number): Buffer =>
  Buffer.concat([head, Buffer.alloc(total - head.length)])

/** 在工作目录里写一个文件，交回绝对路径 */
function put(name: string, bytes: Buffer | string): string {
  const path = join(WD, name)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, bytes)
  return path
}

const one = (path: string, label = 'images[0].path'): Array<{ path: string; label: string }> => [
  { path, label }
]

const noResize: DisplayResizer = () => {
  throw new Error('resizer should not be called')
}

// ─── SN-1 ───────────────────────────────────────────────

describe('SN-1 · sniffShownImageFormat', () => {
  const t = (s: string): Buffer => Buffer.from(s, 'utf8')

  it.each<[string, Buffer, string]>([
    ['PNG 签名', pngHeader(1, 1), 'png'],
    ['PNG 签名恰 8 字节', pngHeader(1, 1).subarray(0, 8), 'png'],
    ['FF D8 FF', Buffer.from([0xff, 0xd8, 0xff]), 'jpg'],
    ['JPEG 头', jpegHeader(4, 4), 'jpg'],
    ['GIF87a', gifHeader(1, 1, 'GIF87a'), 'gif'],
    ['GIF89a', gifHeader(1, 1, 'GIF89a'), 'gif'],
    ['RIFF....WEBP', webpHeader(2, 2), 'webp']
  ])('SN-1 位图：%s → %s', (_label, bytes, format) => {
    expect(sniffShownImageFormat(bytes)).toBe(format)
  })

  it.each<[string, string]>([
    ['<svg', '<svg xmlns="http://www.w3.org/2000/svg"/>'],
    ['大写 <SVG', '<SVG xmlns="http://www.w3.org/2000/svg"/>'],
    ['BOM + 空白 + <svg', '﻿  \n\t<svg/>'],
    ['XML 声明 + 换行', '<?xml version="1.0"?>\n<svg/>'],
    ['声明 + 注释', '<?xml?><!-- c --><svg/>'],
    ['声明 + 样式表 PI', '<?xml?><?xml-stylesheet href="a.css"?><svg/>'],
    [
      'SVG 1.1 doctype',
      '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n<svg/>'
    ],
    ['带内部子集的 doctype', '<!DOCTYPE svg [ <!ENTITY a "b"> ]><svg/>']
  ])("SN-1 SVG：%s → 'svg'", (_label, text) => {
    expect(sniffShownImageFormat(t(text))).toBe('svg')
  })

  it.each<[string, Buffer]>([
    ['空', Buffer.alloc(0)],
    ['纯文本', t('hello world')],
    ['%PDF', t('%PDF-1.4\n')],
    ['RIFF....WAVE', Buffer.concat([t('RIFF'), Buffer.alloc(4), t('WAVEfmt ')])],
    ['GIF88a', gifHeader(1, 1, 'GIF88a')],
    ['BM', t('BM\0\0\0\0\0\0\0\0')],
    ['短于 8 字节的 PNG 签名', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a])],
    ['<!doctype html><svg>', t('<!doctype html><svg></svg>')],
    ['<!doctype html><html><body><svg>', t('<!doctype html><html><body><svg></svg>')],
    ['<?xml?><html><svg>', t('<?xml?><html><svg></svg></html>')],
    ['<html><svg>', t('<html><svg></svg></html>')],
    ['<?xml?><feed>', t('<?xml?><feed></feed>')],
    ['没写完的注释', t('<!-- x <svg/>')],
    ['没写完的 doctype', t('<!DOCTYPE svg <svg/')],
    ['没写完的内部子集', t('<!DOCTYPE svg [ <!ENTITY a "b"> <svg/>')],
    ['没写完的 PI', t('<?xml <svg/>')],
    ['超过嗅探窗口的长注释', t(`<!-- ${'x'.repeat(4096)} --><svg/>`)]
  ])('SN-1 %s → undefined', (_label, bytes) => {
    expect(sniffShownImageFormat(bytes)).toBeUndefined()
  })
})

// ─── SN-2 / SN-3 ────────────────────────────────────────

describe('SN-2 · 正常路径', () => {
  it('SN-2 相对工作目录的 40×24 PNG：内容寻址的文件名、realpath、MIME、宽高、bytes；快照字节一致', async () => {
    const sid = freshSid()
    const bytes = pngHeader(40, 24)
    const abs = put('sn2/chart.png', bytes)
    const [image] = await presentImages(
      { sessionId: sid, workingDirectory: WD, images: one('sn2/chart.png') },
      noResize
    )
    expect(image).toStrictEqual({
      file: `${sha(bytes)}.png`,
      source: realpathSync(abs),
      mimeType: 'image/png',
      width: 40,
      height: 24,
      bytes: bytes.length
    })
    expect(image).not.toHaveProperty('original')
    const snapshot = join(shownDir(sid), image.file)
    expect(readFileSync(snapshot).equals(bytes)).toBe(true)
  })
})

describe('SN-3 · 按内容认格式', () => {
  it('SN-3 叫 pic.jpg 的 PNG → .png / image/png', async () => {
    const sid = freshSid()
    put('sn3/pic.jpg', pngHeader(8, 8))
    const [image] = await presentImages(
      { sessionId: sid, workingDirectory: WD, images: one('sn3/pic.jpg') },
      noResize
    )
    expect(image.file.endsWith('.png')).toBe(true)
    expect(image.mimeType).toBe('image/png')
  })

  it.each<[string, string, Buffer | string]>([
    ['叫 x.png 的文本', 'sn3/x.png', 'just some text'],
    ['空文件', 'sn3/empty.png', '']
  ])('SN-3 %s → 不是能摆的图', async (_label, name, content) => {
    const abs = put(name, content)
    await expect(
      presentImages({ sessionId: freshSid(), workingDirectory: WD, images: one(name) }, noResize)
    ).rejects.toThrow(`images[0].path: ${abs} is not a PNG, JPEG, GIF, WebP or SVG image`)
  })
})

// ─── SN-4 / SN-5 / SN-6 / SN-7 ──────────────────────────

describe('SN-4 · 不存在 / 不是文件', () => {
  it('SN-4 不存在 → no such file: <解析后的绝对路径>', async () => {
    await expect(
      presentImages(
        { sessionId: freshSid(), workingDirectory: WD, images: one('sn4/missing.png', 'L') },
        noResize
      )
    ).rejects.toThrow(`L: no such file: ${join(WD, 'sn4/missing.png')}`)
  })

  it('SN-4 断掉的符号链接 → 同一句', async () => {
    mkdirSync(join(WD, 'sn4'), { recursive: true })
    const link = join(WD, 'sn4', 'broken.png')
    symlinkSync(join(WD, 'sn4', 'nowhere.png'), link)
    await expect(
      presentImages(
        { sessionId: freshSid(), workingDirectory: WD, images: one(link, 'L') },
        noResize
      )
    ).rejects.toThrow(`L: no such file: ${link}`)
  })

  it('SN-4 目录 → not a file', async () => {
    const dir = join(WD, 'sn4', 'adir')
    mkdirSync(dir, { recursive: true })
    await expect(
      presentImages(
        { sessionId: freshSid(), workingDirectory: WD, images: one(dir, 'L') },
        noResize
      )
    ).rejects.toThrow(`L: not a file: ${dir}`)
  })
})

describe('SN-5 · 大小上限', () => {
  it('SN-5 20971521 字节 → 原样的错误句；不建快照目录、不读文件', async () => {
    const sid = freshSid()
    const abs = put('sn5/huge.png', '')
    truncateSync(abs, 20971521)
    await expect(
      presentImages({ sessionId: sid, workingDirectory: WD, images: one(abs) }, noResize)
    ).rejects.toThrow(
      new Error(
        `images[0].path: ${abs} is 20.0MB (20971521 bytes); the limit is 20.0MB (20971520 bytes)`
      )
    )
    expect(existsSync(shownDir(sid))).toBe(false)
    expect(h.readPaths).not.toContain(abs)
  })

  it('SN-5 恰 20971520 字节（全零）→ 过了大小关，败在格式关', async () => {
    const abs = put('sn5/at.png', '')
    truncateSync(abs, 20971520)
    await expect(
      presentImages({ sessionId: freshSid(), workingDirectory: WD, images: one(abs) }, noResize)
    ).rejects.toThrow(`${abs} is not a PNG, JPEG, GIF, WebP or SVG image`)
  })
})

describe('SN-6 · 一张有问题整次失败', () => {
  it('SN-6 [合法, 不存在] → 错误点名 images[1].path', async () => {
    put('sn6/ok.png', pngHeader(4, 4))
    await expect(
      presentImages(
        {
          sessionId: freshSid(),
          workingDirectory: WD,
          images: [
            { path: 'sn6/ok.png', label: 'images[0].path' },
            { path: 'sn6/missing.png', label: 'images[1].path' }
          ]
        },
        noResize
      )
    ).rejects.toThrow(/^images\[1\]\.path: no such file: /)
  })
})

describe('SN-7 · 不安全的会话 id', () => {
  it.each(['', '..', 'a/b', 'a..b'])('SN-7 %o → This session cannot show images.', async (sid) => {
    put('sn7/ok.png', pngHeader(4, 4))
    const before = existsSync(SHOWN) ? readdirSync(SHOWN).sort() : []
    await expect(
      presentImages({ sessionId: sid, workingDirectory: WD, images: one('sn7/ok.png') }, noResize)
    ).rejects.toThrow('This session cannot show images.')
    const after = existsSync(SHOWN) ? readdirSync(SHOWN).sort() : []
    expect(after).toStrictEqual(before)
    expect(existsSync(join(h.userData, 'a'))).toBe(false)
  })
})

// ─── SN-8 / SN-9 ────────────────────────────────────────

describe('SN-8 · 去重', () => {
  it('SN-8 一次调用里同一内容两条路径 → 同一个 file、盘上一份；再调一次不重写；别的会话各存一份', async () => {
    const sid = freshSid()
    const bytes = pngHeader(12, 12)
    put('sn8/a.png', bytes)
    put('sn8/b.png', bytes)
    const images = await presentImages(
      {
        sessionId: sid,
        workingDirectory: WD,
        images: [
          { path: 'sn8/a.png', label: 'images[0].path' },
          { path: 'sn8/b.png', label: 'images[1].path' }
        ]
      },
      noResize
    )
    expect(images).toHaveLength(2)
    expect(images[0].file).toBe(images[1].file)
    expect(images[0].source).not.toBe(images[1].source)
    expect(readdirSync(shownDir(sid))).toStrictEqual([images[0].file])

    // 把快照的 mtime 往回拨：再快照同一内容不该重写它
    const snapshot = join(shownDir(sid), images[0].file)
    const past = new Date('2020-01-01T00:00:00Z')
    utimesSync(snapshot, past, past)
    await presentImages(
      { sessionId: sid, workingDirectory: WD, images: one('sn8/a.png') },
      noResize
    )
    expect(statSync(snapshot).mtimeMs).toBe(past.getTime())

    const other = freshSid()
    const [copy] = await presentImages(
      { sessionId: other, workingDirectory: WD, images: one('sn8/a.png') },
      noResize
    )
    expect(copy.file).toBe(images[0].file)
    expect(existsSync(join(shownDir(other), copy.file))).toBe(true)
  })
})

describe('SN-9 · 符号链接', () => {
  it('SN-9 source 是目标的 realpath', async () => {
    const target = put('sn9/real.png', pngHeader(6, 6))
    const link = join(WD, 'sn9', 'link.png')
    symlinkSync(target, link)
    const [image] = await presentImages(
      { sessionId: freshSid(), workingDirectory: WD, images: one('sn9/link.png') },
      noResize
    )
    expect(image.source).toBe(realpathSync(target))
  })
})

// ─── SN-10 ──────────────────────────────────────────────

describe('SN-10 · 展示副本', () => {
  const run = async (
    name: string,
    bytes: Buffer | string,
    resize: DisplayResizer
  ): Promise<{ sid: string; image: Awaited<ReturnType<typeof presentImages>>[number] }> => {
    const sid = freshSid()
    put(name, bytes)
    const [image] = await presentImages(
      { sessionId: sid, workingDirectory: WD, images: one(name) },
      resize
    )
    return { sid, image }
  }

  it('SN-10a PNG 2049×1 → resizer 调一次；结果取副本的名字 / 尺寸 / 字节 / MIME，original 是原图；两份都在盘上', async () => {
    const orig = pngHeader(2049, 1)
    const display = Buffer.from('display')
    const resize = vi.fn<DisplayResizer>(() => ({
      bytes: display,
      format: 'png',
      width: 2048,
      height: 1
    }))
    const { sid, image } = await run('sn10/wide.png', orig, resize)
    expect(resize).toHaveBeenCalledTimes(1)
    const [bytesArg, formatArg, sizeArg] = resize.mock.calls[0]
    expect(Buffer.isBuffer(bytesArg) && bytesArg.equals(orig)).toBe(true)
    expect(formatArg).toBe('png')
    expect(sizeArg).toStrictEqual({ width: 2049, height: 1 })
    expect(image).toMatchObject({
      file: `${sha(display)}.png`,
      original: `${sha(orig)}.png`,
      mimeType: 'image/png',
      width: 2048,
      height: 1,
      bytes: display.length
    })
    expect(readFileSync(join(shownDir(sid), image.file)).equals(display)).toBe(true)
    expect(readFileSync(join(shownDir(sid), image.original!)).equals(orig)).toBe(true)
  })

  it('SN-10b WebP 3000×10，resizer 交回 jpg → file 是 .jpg / image/jpeg，original 是 .webp', async () => {
    const resize = vi.fn<DisplayResizer>(() => ({
      bytes: Buffer.from('jpeg-display'),
      format: 'jpg',
      width: 2048,
      height: 7
    }))
    const { image } = await run('sn10/wide.webp', webpHeader(3000, 10), resize)
    expect(resize.mock.calls[0][1]).toBe('webp')
    expect(image.file.endsWith('.jpg')).toBe(true)
    expect(image.mimeType).toBe('image/jpeg')
    expect(image.original?.endsWith('.webp')).toBe(true)
  })

  it('SN-10c 长边恰 2048 且不超 4 MiB → 不调 resizer', async () => {
    expect(DISPLAY_MAX_EDGE).toBe(2048)
    const resize = vi.fn<DisplayResizer>(() => null)
    const { image } = await run('sn10/edge.png', pngHeader(2048, 100), resize)
    expect(resize).not.toHaveBeenCalled()
    expect(image).not.toHaveProperty('original')
  })

  it('SN-10d 10×10 PNG 补到 4194305 字节 → 调（带读出的尺寸）；恰 4194304 字节 → 不调', async () => {
    expect(DISPLAY_MAX_BYTES).toBe(4194304)
    const over = vi.fn<DisplayResizer>(() => null)
    await run('sn10/over.png', padded(pngHeader(10, 10), 4194305), over)
    expect(over).toHaveBeenCalledTimes(1)
    expect(over.mock.calls[0][2]).toStrictEqual({ width: 10, height: 10 })

    const at = vi.fn<DisplayResizer>(() => null)
    await run('sn10/at.png', padded(pngHeader(10, 10), 4194304), at)
    expect(at).not.toHaveBeenCalled()
  })

  it('SN-10e GIF（4000×4000、超 4 MiB）不调；SVG（哪怕超 4 MiB）不调，结果没有宽高', async () => {
    const resize = vi.fn<DisplayResizer>(() => null)
    const { image: gif } = await run('sn10/big.gif', gifHeader(4000, 4000), resize)
    expect(gif).toMatchObject({ width: 4000, height: 4000, mimeType: 'image/gif' })
    await run('sn10/heavy.gif', padded(gifHeader(10, 10), DISPLAY_MAX_BYTES + 1), resize)
    const svgText = `<svg xmlns="http://www.w3.org/2000/svg"><!-- ${'x'.repeat(DISPLAY_MAX_BYTES)} --></svg>`
    const { image: svg } = await run('sn10/heavy.svg', svgText, resize)
    expect(resize).not.toHaveBeenCalled()
    expect(svg.mimeType).toBe('image/svg+xml')
    expect(svg).not.toHaveProperty('width')
    expect(svg).not.toHaveProperty('height')
  })

  it('SN-10f resizer 交回 null → 只有原图，没有 original', async () => {
    const orig = pngHeader(3000, 3000)
    const { sid, image } = await run('sn10/null.png', orig, () => null)
    expect(image).toStrictEqual({
      file: `${sha(orig)}.png`,
      source: realpathSync(join(WD, 'sn10/null.png')),
      mimeType: 'image/png',
      width: 3000,
      height: 3000,
      bytes: orig.length
    })
    expect(readdirSync(shownDir(sid))).toStrictEqual([image.file])
  })

  it('SN-10g resizer 抛错 → 只有原图，记一条 warn，调用照样成功', async () => {
    const orig = pngHeader(3000, 10)
    const { image } = await run('sn10/throw.png', orig, () => {
      throw new Error('decoder exploded')
    })
    expect(image.file).toBe(`${sha(orig)}.png`)
    expect(image).not.toHaveProperty('original')
    expect(h.warn).toHaveBeenCalledTimes(1)
    expect(String(h.warn.mock.calls[0][0])).toContain('decoder exploded')
  })

  it('SN-10h PNG 签名 + 读不出尺寸的头、超 4 MiB → resizer 收到 size === null；交回 null 时没有宽高，交回副本时用副本的', async () => {
    // 签名对、IHDR 不在 —— parseImagePixelSize 读不出尺寸
    const head = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
    const big = padded(head, DISPLAY_MAX_BYTES + 1)

    const none = vi.fn<DisplayResizer>(() => null)
    const { image: plain } = await run('sn10/nohdr-a.png', big, none)
    expect(none).toHaveBeenCalledTimes(1)
    expect(none.mock.calls[0][2]).toBeNull()
    expect(plain).not.toHaveProperty('width')
    expect(plain).not.toHaveProperty('height')

    const copy = vi.fn<DisplayResizer>(() => ({
      bytes: Buffer.from('decoded'),
      format: 'png',
      width: 640,
      height: 480
    }))
    const { image: shown } = await run('sn10/nohdr-b.png', big, copy)
    expect(copy.mock.calls[0][2]).toBeNull()
    expect(shown).toMatchObject({ width: 640, height: 480, original: `${sha(big)}.png` })
  })
})

// ─── SN-11 / SN-12 ──────────────────────────────────────

const VALID = `${'ab'.repeat(32)}.png`

describe('SN-11 · shownImageFilePath', () => {
  it('SN-11 合法 → <userData>/shown/<sid>/<file>', () => {
    expect(shownImageFilePath('s1', VALID)).toBe(join(h.userData, 'shown', 's1', VALID))
  })

  it.each<[string, string, string]>([
    ['空 id', '', VALID],
    ['.. id', '..', VALID],
    ['带 / 的 id', 'a/b', VALID],
    ['坏名字', 's1', 'chart.png'],
    ['带路径的名字', 's1', `../${VALID}`],
    ['大写十六进制', 's1', VALID.toUpperCase().replace('.PNG', '.png')]
  ])('SN-11 %s → undefined', (_label, sid, file) => {
    expect(shownImageFilePath(sid, file)).toBeUndefined()
  })
})

describe('SN-12 · shownImagePathOfRef', () => {
  it('SN-12 shown:<合法> → 快照路径', () => {
    expect(shownImagePathOfRef('s1', `shown:${VALID}`)).toBe(join(SHOWN, 's1', VALID))
  })

  it.each<[string, string, string]>([
    ['shown:../x.png', 's1', 'shown:../x.png'],
    ['普通路径', 's1', 'a.png'],
    ['普通绝对路径', 's1', join(SHOWN, 's1', VALID)],
    ['合法引用 + 不安全 id', '..', `shown:${VALID}`],
    ['合法引用 + 空 id', '', `shown:${VALID}`]
  ])('SN-12 %s → undefined', (_label, sid, path) => {
    expect(shownImagePathOfRef(sid, path)).toBeUndefined()
  })
})

// ─── SN-13 / SN-14 ──────────────────────────────────────

describe('SN-13 · removeShownImages', () => {
  it('SN-13 只删 shown/<sid>：别的会话与 shown 本身还在', () => {
    mkdirSync(shownDir('rmS'), { recursive: true })
    writeFileSync(join(shownDir('rmS'), VALID), 'x')
    mkdirSync(shownDir('rmT'), { recursive: true })
    writeFileSync(join(shownDir('rmT'), VALID), 'y')
    removeShownImages('rmS')
    expect(existsSync(shownDir('rmS'))).toBe(false)
    expect(readFileSync(join(shownDir('rmT'), VALID), 'utf8')).toBe('y')
    expect(existsSync(SHOWN)).toBe(true)
  })

  it('SN-13 目录不在 → no-op', () => {
    expect(() => removeShownImages('never-had-images')).not.toThrow()
  })

  it.each(['', '..', 'a/b'])('SN-13 %o → 什么都不删（shown 与 userData 下的哨兵都在）', (sid) => {
    mkdirSync(join(SHOWN, 'a', 'b'), { recursive: true })
    writeFileSync(join(SHOWN, 'sentinel'), 's')
    writeFileSync(join(SHOWN, 'a', 'b', 'sentinel'), 's')
    writeFileSync(join(h.userData, 'sentinel'), 'u')
    removeShownImages(sid)
    expect(existsSync(join(SHOWN, 'sentinel'))).toBe(true)
    expect(existsSync(join(SHOWN, 'a', 'b', 'sentinel'))).toBe(true)
    expect(existsSync(join(h.userData, 'sentinel'))).toBe(true)
  })

  it('SN-13 rmSync 抛错也不抛', () => {
    mkdirSync(shownDir('rmBoom'), { recursive: true })
    h.rmSync = () => {
      throw new Error('EBUSY')
    }
    expect(() => removeShownImages('rmBoom')).not.toThrow()
    expect(existsSync(shownDir('rmBoom'))).toBe(true)
  })
})

describe('SN-14 · copyShownImages', () => {
  const OTHER = `${'cd'.repeat(32)}.jpg`

  it('SN-14 同名逐字节拷过去，源不动', () => {
    mkdirSync(shownDir('cpS'), { recursive: true })
    writeFileSync(join(shownDir('cpS'), VALID), Buffer.from([1, 2, 3]))
    writeFileSync(join(shownDir('cpS'), OTHER), Buffer.from([4, 5]))
    copyShownImages('cpS', 'cpF')
    expect(readdirSync(shownDir('cpF')).sort()).toStrictEqual([VALID, OTHER].sort())
    expect(readFileSync(join(shownDir('cpF'), VALID)).equals(Buffer.from([1, 2, 3]))).toBe(true)
    expect(readFileSync(join(shownDir('cpF'), OTHER)).equals(Buffer.from([4, 5]))).toBe(true)
    expect(readdirSync(shownDir('cpS')).sort()).toStrictEqual([VALID, OTHER].sort())
  })

  it('SN-14 源目录不在 → 不建目标', () => {
    copyShownImages('cpNone', 'cpNoneF')
    expect(existsSync(shownDir('cpNoneF'))).toBe(false)
  })

  it.each<[string, string]>([
    ['..', 'cpX'],
    ['cpS2', '..'],
    ['cpS2', ''],
    ['', 'cpX']
  ])('SN-14 不安全的 id（%o → %o）→ no-op', (from, to) => {
    mkdirSync(shownDir('cpS2'), { recursive: true })
    writeFileSync(join(shownDir('cpS2'), VALID), 'x')
    const before = readdirSync(SHOWN).sort()
    copyShownImages(from, to)
    expect(readdirSync(SHOWN).sort()).toStrictEqual(before)
    expect(existsSync(join(SHOWN, VALID))).toBe(false)
  })

  it('SN-14 已有目标目录 → 合并', () => {
    mkdirSync(shownDir('cpM'), { recursive: true })
    writeFileSync(join(shownDir('cpM'), VALID), 'src')
    mkdirSync(shownDir('cpMF'), { recursive: true })
    writeFileSync(join(shownDir('cpMF'), OTHER), 'existing')
    copyShownImages('cpM', 'cpMF')
    expect(readdirSync(shownDir('cpMF')).sort()).toStrictEqual([VALID, OTHER].sort())
    expect(readFileSync(join(shownDir('cpMF'), OTHER), 'utf8')).toBe('existing')
    expect(readFileSync(join(shownDir('cpMF'), VALID), 'utf8')).toBe('src')
  })
})

// ─── SN-15 ──────────────────────────────────────────────

describe('SN-15 · nativeDisplayResizer', () => {
  interface FakeImage {
    isEmpty: ReturnType<typeof vi.fn>
    getSize: ReturnType<typeof vi.fn>
    resize: ReturnType<typeof vi.fn>
    toPNG: ReturnType<typeof vi.fn>
    toJPEG: ReturnType<typeof vi.fn>
  }

  /** 一张假图：getSize 交回给定尺寸，resize 交回另一张按目标尺寸的假图 */
  function fakeImage(
    size: { width: number; height: number },
    opts: { empty?: boolean; encoded?: Buffer } = {}
  ): FakeImage {
    const encoded = opts.encoded ?? Buffer.from('encoded')
    const img: FakeImage = {
      isEmpty: vi.fn(() => opts.empty ?? false),
      getSize: vi.fn(() => size),
      resize: vi.fn((o: { width: number; height: number }) =>
        fakeImage({ width: o.width, height: o.height }, { encoded })
      ),
      toPNG: vi.fn(() => encoded),
      toJPEG: vi.fn(() => encoded)
    }
    return img
  }

  it('SN-15 size 为 null → 用解码尺寸；4000×1000 → resize({2048, 512, good})', () => {
    const img = fakeImage({ width: 4000, height: 1000 })
    h.createFromBuffer.mockReturnValue(img)
    const out = nativeDisplayResizer(Buffer.from('x'), 'png', null)
    expect(img.getSize).toHaveBeenCalled()
    expect(img.resize).toHaveBeenCalledWith({ width: 2048, height: 512, quality: 'good' })
    expect(out).toMatchObject({ format: 'png', width: 2048, height: 512 })
  })

  it('SN-15 给的尺寸优先于解码尺寸', () => {
    const img = fakeImage({ width: 100, height: 100 })
    h.createFromBuffer.mockReturnValue(img)
    nativeDisplayResizer(Buffer.from('x'), 'png', { width: 4096, height: 2048 })
    expect(img.resize).toHaveBeenCalledWith({ width: 2048, height: 1024, quality: 'good' })
  })

  it("SN-15 png → toPNG、format 'png'；jpg / webp → toJPEG(90)、format 'jpg'；宽高读缩好的那张", () => {
    const png = fakeImage({ width: 3000, height: 3000 })
    h.createFromBuffer.mockReturnValue(png)
    const pngOut = nativeDisplayResizer(Buffer.from('x'), 'png', null)
    const pngResized = png.resize.mock.results[0].value as FakeImage
    expect(pngResized.toPNG).toHaveBeenCalledTimes(1)
    expect(pngResized.toJPEG).not.toHaveBeenCalled()
    expect(pngOut).toStrictEqual({
      bytes: Buffer.from('encoded'),
      format: 'png',
      width: 2048,
      height: 2048
    })

    for (const format of ['jpg', 'webp'] as const) {
      const img = fakeImage({ width: 2049, height: 10 })
      h.createFromBuffer.mockReturnValue(img)
      const out = nativeDisplayResizer(Buffer.from('x'), format, null)
      const resized = img.resize.mock.results[0].value as FakeImage
      expect(resized.toJPEG, format).toHaveBeenCalledWith(90)
      expect(resized.toPNG, format).not.toHaveBeenCalled()
      expect(out?.format, format).toBe('jpg')
      expect(out?.width, format).toBe(2048)
      expect(out?.height, format).toBe(10)
    }
  })

  it('SN-15 已在 2048 内 → 不 resize，照样重编码', () => {
    const img = fakeImage({ width: 2048, height: 1500 })
    h.createFromBuffer.mockReturnValue(img)
    const out = nativeDisplayResizer(Buffer.from('x'), 'jpg', null)
    expect(img.resize).not.toHaveBeenCalled()
    expect(img.toJPEG).toHaveBeenCalledWith(90)
    expect(out).toMatchObject({ format: 'jpg', width: 2048, height: 1500 })
  })

  it('SN-15 isEmpty → null', () => {
    h.createFromBuffer.mockReturnValue(fakeImage({ width: 10, height: 10 }, { empty: true }))
    expect(nativeDisplayResizer(Buffer.from('x'), 'png', { width: 4000, height: 10 })).toBeNull()
  })

  it('SN-15 解码尺寸为 0（size 为 null）→ null', () => {
    h.createFromBuffer.mockReturnValue(fakeImage({ width: 0, height: 0 }))
    expect(nativeDisplayResizer(Buffer.from('x'), 'png', null)).toBeNull()
  })

  it('SN-15 编码出空 buffer → null', () => {
    h.createFromBuffer.mockReturnValue(
      fakeImage({ width: 3000, height: 10 }, { encoded: Buffer.alloc(0) })
    )
    expect(nativeDisplayResizer(Buffer.from('x'), 'webp', null)).toBeNull()
  })
})
