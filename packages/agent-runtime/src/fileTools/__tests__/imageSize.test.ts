/**
 * parseImagePixelSize 单测 —— 各格式的文件头按规范逐字节构造，验证宽高偏移与字节序。
 * 重点覆盖解压炸弹场景：极小的字节数 + 极大的像素数（正是字节上限拦不住的那类）。
 */

import { describe, it, expect } from 'vitest'
import { parseImagePixelSize } from '../imageSize'

/** PNG：签名(8) + 块长(4) + 'IHDR'(4) + 宽(4 BE) + 高(4 BE) */
function png(w: number, h: number): Uint8Array {
  const b = new Uint8Array(24)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  b.set([0, 0, 0, 13], 8)
  b.set([0x49, 0x48, 0x44, 0x52], 12) // 'IHDR'
  new DataView(b.buffer).setUint32(16, w, false)
  new DataView(b.buffer).setUint32(20, h, false)
  return b
}

/** GIF：'GIF89a' + 宽(2 LE) + 高(2 LE) */
function gif(w: number, h: number): Uint8Array {
  const b = new Uint8Array(10)
  b.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0)
  new DataView(b.buffer).setUint16(6, w, true)
  new DataView(b.buffer).setUint16(8, h, true)
  return b
}

/** BMP：'BM' + 文件头(14) + BITMAPINFOHEADER(40)，宽高为 int32 LE（高可负=自上而下） */
function bmp(w: number, h: number): Uint8Array {
  const b = new Uint8Array(30)
  b.set([0x42, 0x4d], 0)
  const dv = new DataView(b.buffer)
  dv.setUint32(14, 40, true)
  dv.setInt32(18, w, true)
  dv.setInt32(22, h, true)
  return b
}

/** JPEG：FFD8 + 一个可跳过的 APP0 段 + SOF0（精度1/高2/宽2，均 BE） */
function jpeg(w: number, h: number, { withPadding = false } = {}): Uint8Array {
  const app0Len = 16
  const parts: number[] = [0xff, 0xd8]
  if (withPadding) parts.push(0xff, 0xff) // 段间填充字节，解析器须能跳过
  parts.push(0xff, 0xe0, 0x00, app0Len)
  for (let i = 0; i < app0Len - 2; i++) parts.push(0)
  parts.push(0xff, 0xc0, 0x00, 0x11, 0x08)
  parts.push((h >> 8) & 0xff, h & 0xff, (w >> 8) & 0xff, w & 0xff)
  for (let i = 0; i < 6; i++) parts.push(0)
  return Uint8Array.from(parts)
}

/** WebP VP8X：'RIFF'+size+'WEBP'+'VP8X'+flags(4)+ 宽-1(3 LE) + 高-1(3 LE) */
function webpVp8x(w: number, h: number): Uint8Array {
  const b = new Uint8Array(30)
  b.set([0x52, 0x49, 0x46, 0x46], 0) // RIFF
  b.set([0x57, 0x45, 0x42, 0x50], 8) // WEBP
  b.set([0x56, 0x50, 0x38, 0x58], 12) // VP8X
  const put24 = (o: number, v: number): void => {
    b[o] = v & 0xff
    b[o + 1] = (v >> 8) & 0xff
    b[o + 2] = (v >> 16) & 0xff
  }
  put24(24, w - 1)
  put24(27, h - 1)
  return b
}

/** WebP VP8L：'RIFF'+size+'WEBP'+'VP8L'+chunkSize(4)+0x2F+ 14 位宽-1 / 14 位高-1 */
function webpVp8l(w: number, h: number): Uint8Array {
  const b = new Uint8Array(25)
  b.set([0x52, 0x49, 0x46, 0x46], 0)
  b.set([0x57, 0x45, 0x42, 0x50], 8)
  b.set([0x56, 0x50, 0x38, 0x4c], 12) // VP8L
  b[20] = 0x2f
  const bits = ((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14)
  new DataView(b.buffer).setUint32(21, bits >>> 0, true)
  return b
}

describe('parseImagePixelSize', () => {
  it('parses PNG dimensions (big-endian at 16/20)', () => {
    expect(parseImagePixelSize(png(1920, 1080))).toEqual({ width: 1920, height: 1080 })
  })

  it('parses GIF dimensions (little-endian at 6/8)', () => {
    expect(parseImagePixelSize(gif(800, 600))).toEqual({ width: 800, height: 600 })
  })

  it('parses BMP dimensions, taking |height| for top-down bitmaps', () => {
    expect(parseImagePixelSize(bmp(640, 480))).toEqual({ width: 640, height: 480 })
    expect(parseImagePixelSize(bmp(640, -480))).toEqual({ width: 640, height: 480 })
  })

  it('parses JPEG by walking segments to SOF0', () => {
    expect(parseImagePixelSize(jpeg(4032, 3024))).toEqual({ width: 4032, height: 3024 })
  })

  it('tolerates JPEG inter-segment padding bytes', () => {
    expect(parseImagePixelSize(jpeg(100, 50, { withPadding: true }))).toEqual({
      width: 100,
      height: 50
    })
  })

  it('parses WebP VP8X and VP8L (both store value-minus-one)', () => {
    expect(parseImagePixelSize(webpVp8x(5000, 4000))).toEqual({ width: 5000, height: 4000 })
    expect(parseImagePixelSize(webpVp8l(300, 200))).toEqual({ width: 300, height: 200 })
  })

  it('detects a decompression bomb: tiny byte count, enormous pixel count', () => {
    // 30000×30000 PNG 头只有 24 字节，解码却是 ~3.6 GB —— 字节数上限完全拦不住
    const bomb = png(30000, 30000)
    expect(bomb.length).toBe(24)
    const size = parseImagePixelSize(bomb)
    expect(size).toEqual({ width: 30000, height: 30000 })
    expect(size!.width * size!.height).toBeGreaterThan(100_000_000)
  })

  it('returns null for unparseable / truncated / degenerate input (fails open)', () => {
    expect(parseImagePixelSize(new Uint8Array(0))).toBeNull()
    expect(parseImagePixelSize(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))).toBeNull()
    expect(parseImagePixelSize(png(0, 0))).toBeNull() // 0 尺寸视为解析失败
    expect(parseImagePixelSize(png(100, 100).subarray(0, 18))).toBeNull() // 截断
    expect(parseImagePixelSize(new TextEncoder().encode('<svg width="10"/>'))).toBeNull()
  })
})
