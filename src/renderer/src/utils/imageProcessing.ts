/**
 * 图片处理工具函数 — 文件转 base64、自动压缩大图
 */

/** 压缩阈值配置 */
const MAX_EDGE = 2048
const JPEG_QUALITY = 0.85
const SKIP_SIZE = 1 * 1024 * 1024 // 1MB 以下且尺寸达标则跳过压缩

/** 图片数据（base64 + 预览） */
export interface ImageData {
  data: string
  mimeType: string
  preview: string
}

/** 将文件转为 base64 图片数据（大图自动压缩） */
export function fileToImageData(file: File): Promise<ImageData> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = reject
    reader.onload = () => {
      const dataUrl = reader.result as string
      const img = new Image()
      img.onload = () => {
        const { naturalWidth: w, naturalHeight: h } = img
        const needResize = w > MAX_EDGE || h > MAX_EDGE
        const needCompress = needResize || file.size > SKIP_SIZE

        if (!needCompress) {
          // 小图直接用原始数据，避免不必要的质量损失
          resolve({ data: dataUrl.split(',')[1], mimeType: file.type, preview: dataUrl })
          return
        }

        // 计算缩放尺寸（等比缩小到长边 MAX_EDGE）
        let dw = w,
          dh = h
        if (needResize) {
          const ratio = MAX_EDGE / Math.max(w, h)
          dw = Math.round(w * ratio)
          dh = Math.round(h * ratio)
        }

        // Canvas 压缩
        const canvas = document.createElement('canvas')
        canvas.width = dw
        canvas.height = dh
        const ctx = canvas.getContext('2d')!
        ctx.drawImage(img, 0, 0, dw, dh)

        const compressedUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY)
        const base64 = compressedUrl.split(',')[1]
        resolve({ data: base64, mimeType: 'image/jpeg', preview: compressedUrl })
      }
      img.onerror = () => reject(new Error('图片加载失败'))
      img.src = dataUrl
    }
    reader.readAsDataURL(file)
  })
}
