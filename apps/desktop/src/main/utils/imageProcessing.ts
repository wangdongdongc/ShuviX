import { nativeImage } from 'electron'

/**
 * 图片压缩工具（主进程） — 对标 renderer 的 imageProcessing.ts
 * 使用 Electron nativeImage 实现，无需额外依赖
 */

/** 压缩阈值配置（与 renderer 端保持一致） */
const MAX_EDGE = 2048
const JPEG_QUALITY = 85 // nativeImage.toJPEG 接受 0-100 整数
const SKIP_SIZE = 1 * 1024 * 1024 // 1MB

/** 压缩结果 */
export interface CompressedImage {
  data: string // base64
  mimeType: string
}

/**
 * 压缩图片 Buffer — 大图等比缩小到长边 2048px 并转为 JPEG
 * 小图（< 1MB 且尺寸达标）直接返回原始数据
 */
export function compressImageBuffer(buffer: Buffer, originalMimeType: string): CompressedImage {
  const img = nativeImage.createFromBuffer(buffer)
  if (img.isEmpty()) {
    // 无法解码，原样返回
    return { data: buffer.toString('base64'), mimeType: originalMimeType }
  }

  const { width: w, height: h } = img.getSize()
  const needResize = w > MAX_EDGE || h > MAX_EDGE
  const needCompress = needResize || buffer.length > SKIP_SIZE

  if (!needCompress) {
    return { data: buffer.toString('base64'), mimeType: originalMimeType }
  }

  // 等比缩小
  let target = img
  if (needResize) {
    const ratio = MAX_EDGE / Math.max(w, h)
    const dw = Math.round(w * ratio)
    const dh = Math.round(h * ratio)
    target = img.resize({ width: dw, height: dh })
  }

  const jpegBuffer = target.toJPEG(JPEG_QUALITY)
  return { data: jpegBuffer.toString('base64'), mimeType: 'image/jpeg' }
}
