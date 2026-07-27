/**
 * 图片像素尺寸解析（只读文件头，不解码）—— 供预览面板判断「解码后有多大」。
 *
 * 为什么需要：文件字节数和解码后的内存占用没有关系。一张纯色 30000×30000 的 PNG
 * 压缩后可能只有几十 KB，解码成位图却是 30000×30000×4 ≈ 3.6 GB —— 经典的解压炸弹。
 * 预览面板已有的「文件大小上限」完全拦不住这类文件，必须看真实像素数。
 *
 * 解析策略：只按各格式的头部结构取宽高，绝不解码。解析不出来返回 null（调用方按
 * 「未知，放行」处理）—— 这是体验保护而非安全控制，失败开放比误伤正常图片更合适。
 *
 * SVG 不在此列：矢量图没有固有像素尺寸，其风险来自病态路径/滤镜，靠宽高判断不了。
 */

export interface ImagePixelSize {
  width: number
  height: number
}

/** 大端读 uint32 */
function be32(b: Uint8Array, o: number): number {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0
}
/** 小端读 uint32 */
function le32(b: Uint8Array, o: number): number {
  return ((b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0) as number
}
/** 小端读 uint16 */
function le16(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8)
}
/** 大端读 uint16 */
function be16(b: Uint8Array, o: number): number {
  return (b[o] << 8) | b[o + 1]
}
/** 小端读 uint24 */
function le24(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)
}

function ascii(b: Uint8Array, start: number, end: number): string {
  let s = ''
  for (let i = start; i < end && i < b.length; i++) s += String.fromCharCode(b[i])
  return s
}

/** PNG：8 字节签名 + IHDR 块，宽高固定在偏移 16 / 20（大端 uint32） */
function parsePng(b: Uint8Array): ImagePixelSize | null {
  if (b.length < 24) return null
  if (ascii(b, 12, 16) !== 'IHDR') return null
  return { width: be32(b, 16), height: be32(b, 20) }
}

/** GIF：'GIF87a'/'GIF89a' + 逻辑屏幕描述符，宽高在偏移 6 / 8（小端 uint16） */
function parseGif(b: Uint8Array): ImagePixelSize | null {
  if (b.length < 10) return null
  return { width: le16(b, 6), height: le16(b, 8) }
}

/**
 * BMP：'BM' + 文件头(14) + DIB 头。
 * DIB 头长度 12 是老式 BITMAPCOREHEADER（uint16 宽高），其余按 BITMAPINFOHEADER（int32）。
 * 高度可为负（自上而下位图），取绝对值。
 */
function parseBmp(b: Uint8Array): ImagePixelSize | null {
  if (b.length < 26) return null
  const dibSize = le32(b, 14)
  if (dibSize === 12) return { width: le16(b, 18), height: le16(b, 20) }
  // int32：先按无符号读再转有符号
  const w = le32(b, 18) | 0
  const h = le32(b, 22) | 0
  return { width: Math.abs(w), height: Math.abs(h) }
}

/** SOF 标记（含宽高）；排除 C4=DHT、C8=JPG、CC=DAC —— 它们不是帧头 */
const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf
])

/**
 * JPEG：从 FFD8 开始逐段跳过，直到遇到 SOF 帧头（负载内 精度(1) 高(2) 宽(2)，均大端）。
 * EXIF 缩略图等大段落也只是按长度跳过，不解码。
 */
function parseJpeg(b: Uint8Array): ImagePixelSize | null {
  let o = 2
  while (o + 3 < b.length) {
    if (b[o] !== 0xff) {
      o++ // 段间填充字节，向前找下一个标记
      continue
    }
    const marker = b[o + 1]
    // 无负载标记：填充(FF)、SOI/EOI、RSTn
    if (marker === 0xff) {
      o++
      continue
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      o += 2
      continue
    }
    if (marker === 0xd9 || marker === 0xda) return null // EOI / 进入压缩数据，没找到 SOF
    const len = be16(b, o + 2)
    if (len < 2) return null
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (o + 9 > b.length) return null
      return { height: be16(b, o + 5), width: be16(b, o + 7) }
    }
    o += 2 + len
  }
  return null
}

/**
 * WebP：RIFF 容器，第一个块决定编码分支。
 *   VP8X（扩展）：画布宽高各 3 字节小端，存的是「实际值 - 1」
 *   VP8L（无损）：0x2F 签名后 14 位宽 + 14 位高，同样存「实际值 - 1」
 *   VP8 （有损）：帧标签(3) + 同步码 9D 01 2A 后，各 2 字节小端取低 14 位
 */
function parseWebp(b: Uint8Array): ImagePixelSize | null {
  if (b.length < 16 || ascii(b, 8, 12) !== 'WEBP') return null
  const chunk = ascii(b, 12, 16)
  if (chunk === 'VP8X') {
    if (b.length < 30) return null
    return { width: le24(b, 24) + 1, height: le24(b, 27) + 1 }
  }
  if (chunk === 'VP8L') {
    if (b.length < 25 || b[20] !== 0x2f) return null
    const bits = le32(b, 21)
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
  }
  if (chunk === 'VP8 ') {
    if (b.length < 30) return null
    // 同步码定位帧头：紧随其后的两个小端 uint16 低 14 位是宽高
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null
    return { width: le16(b, 26) & 0x3fff, height: le16(b, 28) & 0x3fff }
  }
  return null
}

/**
 * 从图片字节解析像素尺寸；无法识别或数据不全返回 null。
 * 只看头部结构，对任意大小的输入都是常数级开销。
 */
export function parseImagePixelSize(bytes: Uint8Array): ImagePixelSize | null {
  const b = bytes
  if (b.length < 10) return null
  let size: ImagePixelSize | null = null
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) size = parsePng(b)
  else if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) size = parseGif(b)
  else if (b[0] === 0xff && b[1] === 0xd8) size = parseJpeg(b)
  else if (b[0] === 0x42 && b[1] === 0x4d) size = parseBmp(b)
  else if (ascii(b, 0, 4) === 'RIFF') size = parseWebp(b)
  if (!size) return null
  // 0 或异常值视为解析失败 —— 宁可放行也不要基于垃圾数字拦截
  if (!Number.isFinite(size.width) || !Number.isFinite(size.height)) return null
  if (size.width <= 0 || size.height <= 0) return null
  return size
}
