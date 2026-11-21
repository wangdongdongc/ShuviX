/**
 * 应用内看图（2026-11-20 用户裁定：点图不再开独立窗口 / 新标签页，在当前窗口里叠一层看）。
 *
 * 点图的地方交一组图和点中的那一张；每个窗口挂一个 ImageViewer（宿主在 SessionRuntime 里挂）读这里。
 * 一组 = 同一条消息的图、同一个 show_image、时间线上同一组的图 …… ← → 在组内翻。
 */
import { create } from 'zustand'

export interface ViewerImage {
  /** 直接可用的地址（`data:` / `https:`）；有它就不经 mediaUrl 解析 */
  src?: string
  /** 经 mediaUrl seam 解析的会话与路径（绝对路径、`shown:` / `library:` 引用） */
  sessionId?: string
  path?: string
  mimeType?: string
  /** 顶栏的名字、下载的文件名 */
  name: string
  /** 「在独立窗口打开」交给宿主的路径（原图）；没有就不给这个按钮 */
  openPath?: string
}

interface ImageViewerState {
  images: ViewerImage[]
  index: number
  /** 每打开一次 +1：同一组图关了再开也算新的一次（复位缩放） */
  nonce: number
  open: (images: ViewerImage[], index?: number) => void
  go: (index: number) => void
  close: () => void
}

export const useImageViewerStore = create<ImageViewerState>((set) => ({
  images: [],
  index: 0,
  nonce: 0,
  open: (images, index = 0) =>
    set((s) =>
      images.length === 0
        ? s
        : {
            images,
            index: Math.min(Math.max(0, index), images.length - 1),
            nonce: s.nonce + 1
          }
    ),
  go: (index) =>
    set((s) =>
      s.images.length === 0
        ? s
        : { index: ((index % s.images.length) + s.images.length) % s.images.length }
    ),
  close: () => set({ images: [], index: 0 })
}))

/** 打开看图（组里点中的是第 index 张） */
export function openImageViewer(images: ViewerImage[], index = 0): void {
  useImageViewerStore.getState().open(images, index)
}

const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.svg',
  '.avif'
])

/** 按扩展名是不是图（大小写不敏感；`shown:` 引用一律是图） */
export function isImagePath(path: string): boolean {
  if (path.startsWith('shown:')) return true
  const name = path.replace(/\\/g, '/').split('/').pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot > 0 && IMAGE_EXTENSIONS.has(name.slice(dot).toLowerCase())
}

/** 路径的最后一段（顶栏名字的兜底）；`shown:` 引用去掉前缀 */
export function imageNameOf(path: string): string {
  const parts = path
    .replace(/^shown:/, '')
    .replace(/\\/g, '/')
    .split('/')
  return parts[parts.length - 1] || path
}
