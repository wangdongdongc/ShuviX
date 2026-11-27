/**
 * 基于 Electron `nativeImage` 的 `pi-durable` ImageProcessor（供 `createFitImagesExtension` 使用）。
 *
 * 在工具结果写入 transcript 之前兜底适配所有图片块（包括 MCP 工具、browser 截图、read 等）：
 *  - 已在模型尺寸与字节上限内且格式受支持（PNG/JPEG/GIF/WebP）：解码校验通过后原样透传，不重编码；
 *  - 超出尺寸或字节上限、或格式非内联类型（如 BMP）：等比缩放到模型上限内，非 JPEG 优先尝试无损 PNG，
 *    仍超字节上限时按 JPEG 质量与缩放梯度压缩；
 *  - 损坏 / 无法解码 / 压缩后仍无法满足上限：返回 `undefined`，由 `fit-images` 省略该图并附带诊断说明，
 *    避免一张坏图永久污染整条会话的后续请求。
 */
import * as electron from 'electron'
import type { ImageLimits, ImageProcessor, PreparedImage } from '@earendil-works/pi-durable/tools'

const INLINE_IMAGE_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp'
])

const base64Length = (byteLength: number): number => Math.ceil(byteLength / 3) * 4

const toBase64 = (bytes: Uint8Array): string =>
  (Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  ).toString('base64')

export interface NativeImageLike {
  isEmpty(): boolean
  getSize(): { width: number; height: number }
  resize(options: {
    width?: number
    height?: number
    quality?: 'good' | 'better' | 'best'
  }): NativeImageLike
  toPNG(): Buffer
  toJPEG(quality: number): Buffer
}

export interface NativeImageModuleLike {
  createFromBuffer(buffer: Buffer): NativeImageLike
}

const JPEG_QUALITIES = [85, 75, 65, 50, 35] as const
const EXTRA_SCALE_STEPS = [1, 0.75, 0.5, 0.35, 0.25] as const

function fitDimensions(
  width: number,
  height: number,
  maxWidth: number,
  maxHeight: number
): { width: number; height: number } {
  if (width <= maxWidth && height <= maxHeight) return { width, height }
  const ratio = Math.min(maxWidth / width, maxHeight / height)
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio))
  }
}

function resolveDefaultNativeImage(): NativeImageModuleLike | undefined {
  try {
    return (electron as { nativeImage?: NativeImageModuleLike }).nativeImage
  } catch {
    return undefined
  }
}

export function createElectronImageProcessor(api?: NativeImageModuleLike): ImageProcessor {
  return {
    async prepare(
      bytes: Uint8Array,
      mimeType: string,
      limits: ImageLimits
    ): Promise<PreparedImage | undefined> {
      const mod = api ?? resolveDefaultNativeImage()
      if (!mod?.createFromBuffer) return undefined
      if (
        !Number.isFinite(limits.maxWidth) ||
        limits.maxWidth <= 0 ||
        !Number.isFinite(limits.maxHeight) ||
        limits.maxHeight <= 0 ||
        !Number.isFinite(limits.maxBytes) ||
        limits.maxBytes <= 0
      ) {
        return undefined
      }
      try {
        const buffer = Buffer.isBuffer(bytes)
          ? bytes
          : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        const img = mod.createFromBuffer(buffer)
        if (img.isEmpty()) return undefined

        const { width: origW, height: origH } = img.getSize()
        if (origW <= 0 || origH <= 0) return undefined

        // 已符合格式、尺寸与字节上限：原样返回，让 fitImages 走 unchanged 快路径（零重编码）
        if (
          INLINE_IMAGE_TYPES.has(mimeType) &&
          origW <= limits.maxWidth &&
          origH <= limits.maxHeight &&
          base64Length(bytes.byteLength) <= limits.maxBytes
        ) {
          return { data: toBase64(bytes), mimeType }
        }

        const fitted = fitDimensions(origW, origH, limits.maxWidth, limits.maxHeight)
        const baseImg =
          fitted.width !== origW || fitted.height !== origH
            ? img.resize({ width: fitted.width, height: fitted.height, quality: 'good' })
            : img

        // 非 JPEG 原图（如 PNG/WebP/BMP 截图）优先尝试 PNG，保留文字清晰度
        if (mimeType !== 'image/jpeg') {
          const png = baseImg.toPNG()
          if (png.byteLength > 0 && base64Length(png.byteLength) <= limits.maxBytes) {
            const { width: newW, height: newH } = baseImg.getSize()
            const resized = newW !== origW || newH !== origH
            return {
              data: toBase64(png),
              mimeType: 'image/png',
              ...(resized
                ? {
                    resized: {
                      from: { width: origW, height: origH },
                      to: { width: newW, height: newH }
                    }
                  }
                : {}),
              ...(mimeType !== 'image/png' ? { convertedFrom: mimeType } : {})
            }
          }
        }

        // 回退到 JPEG：依次降质量，仍超限则叠加降采样
        for (const scale of EXTRA_SCALE_STEPS) {
          const working =
            scale === 1
              ? baseImg
              : img.resize({
                  width: Math.max(1, Math.round(fitted.width * scale)),
                  height: Math.max(1, Math.round(fitted.height * scale)),
                  quality: 'good'
                })
          const { width: newW, height: newH } = working.getSize()
          for (const quality of JPEG_QUALITIES) {
            const jpeg = working.toJPEG(quality)
            if (jpeg.byteLength === 0 || base64Length(jpeg.byteLength) > limits.maxBytes) continue
            const resized = newW !== origW || newH !== origH
            return {
              data: toBase64(jpeg),
              mimeType: 'image/jpeg',
              ...(resized
                ? {
                    resized: {
                      from: { width: origW, height: origH },
                      to: { width: newW, height: newH }
                    }
                  }
                : {}),
              ...(mimeType !== 'image/jpeg' ? { convertedFrom: mimeType } : {})
            }
          }
        }

        return undefined
      } catch {
        return undefined
      }
    }
  }
}
