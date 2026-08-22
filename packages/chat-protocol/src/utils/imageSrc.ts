import type { ImageMeta } from '../types/chatMessage'

/**
 * 图片元数据 → `<img src>`。
 *
 * `ImageMeta.data` 存的是**裸 base64**：发送前 `fileToImageData` 就把 `data:` 前缀切掉了
 * （发给模型的是裸载荷），模型回传的图片同样如此。带前缀的完整 data URL 只在 `preview`
 * 上，而 preview 是**发送当次的内存态**——会话重开后从 entry 树投影回来的消息只剩 data，
 * 直接塞进 src 就是一张碎图。取 src 一律走这里补前缀，别在各处各拼一遍。
 */
export function imageSrc(img: ImageMeta): string {
  if (img.preview) return img.preview
  const data = img.data
  if (!data) return ''
  // 个别来源（transcript 转换等）给的已经是完整 data URL，别再套一层
  if (data.startsWith('data:')) return data
  return `data:${img.mimeType || 'image/png'};base64,${data}`
}
