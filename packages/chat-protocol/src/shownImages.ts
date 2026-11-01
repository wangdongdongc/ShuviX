/**
 * 给用户看图（`show_image` 工具与带图提议，2026-11-01，设计稿 docs/show-image-design.md）—— agent 交一个本机文件路径，
 * 宿主把它快照进会话自己的目录，图出现在对话里调用的位置。模型收不到图：这是「给用户看」，不是「给模型看」。
 *
 * 这里是两端共用的那一半：限额、快照文件名的形状、`shown:` 引用的拼与拆、从调用块里取出要画的图。
 * 状态不另存：说明文字在调用参数里，快照在工具结果的 `details` 里（`ShownImage`），两者按下标对应。
 *
 * 没有权限点（用户裁决）：用户看自己的图不需要权限，模型看才需要。不让它成为模型读文件的旁路，靠的是快照放在会话
 * 权限表**之外**（宿主 `services/shownImages.ts`），模型 `read` 快照照样要问。
 */
import type { AssistantToolBlock, ShownImage, ToolResultDetails } from './types/chatMessage'

export const SHOW_IMAGE_TOOL_NAME = 'show_image'

/** 限额 —— 工具校验与描述共用 */
export const SHOW_IMAGE_LIMITS = {
  /** 一次 `show_image` 至多几张 */
  maxImages: 6,
  /** 一张图的说明至多多少字符 */
  caption: 200,
  /** 一张源图至多多少字节 */
  maxBytes: 20 * 1024 * 1024
} as const

/** 能摆的格式（按文件头认，不看扩展名）→ 快照的扩展名与 MIME */
export const SHOWN_IMAGE_FORMATS = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml'
} as const

export type ShownImageFormat = keyof typeof SHOWN_IMAGE_FORMATS

/** 给模型读的格式清单（描述与错误信息共用一句） */
export const SHOWN_IMAGE_FORMAT_NAMES = 'PNG, JPEG, GIF, WebP or SVG'

/** 快照文件名：内容的 sha256 + 扩展名。渲染端与宿主都只认这个形状，别的一律当作不存在 */
const SHOWN_IMAGE_FILE = /^[0-9a-f]{64}\.(png|jpg|gif|webp|svg)$/

/** `shown:` 引用的前缀 —— mediaUrl seam 与 `files.open` 收到它就到会话的快照目录里找，不按工作目录解析 */
export const SHOWN_IMAGE_REF_PREFIX = 'shown:'

/** 这个名字是不是一张快照的文件名 */
export function isShownImageFile(name: unknown): name is string {
  return typeof name === 'string' && SHOWN_IMAGE_FILE.test(name)
}

/** 快照文件名 → 交给 mediaUrl seam / `requestFilePreview` 的引用 */
export function shownImageRef(file: string): string {
  return `${SHOWN_IMAGE_REF_PREFIX}${file}`
}

/** 引用 → 快照文件名；不是 `shown:` 引用、或文件名形状不对 → undefined（调用方照普通路径处理） */
export function shownImageFileOfRef(path: string): string | undefined {
  if (!path.startsWith(SHOWN_IMAGE_REF_PREFIX)) return undefined
  const file = path.slice(SHOWN_IMAGE_REF_PREFIX.length)
  return isShownImageFile(file) ? file : undefined
}

/** 宽松地认一条 `ShownImage`（来自会话树，形状不可信）：文件名形状不对就不认 */
export function shownImageOf(value: unknown): ShownImage | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const o = value as Record<string, unknown>
  if (!isShownImageFile(o.file)) return undefined
  if (typeof o.mimeType !== 'string' || typeof o.source !== 'string') return undefined
  const size = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined
  return {
    file: o.file,
    ...(isShownImageFile(o.original) ? { original: o.original } : {}),
    source: o.source,
    mimeType: o.mimeType,
    ...(size(o.width) && size(o.height) ? { width: size(o.width), height: size(o.height) } : {}),
    bytes: size(o.bytes) ?? 0
  }
}

/** 一次成功落定的 `show_image` 调用（还在执行、出错的照普通工具块显示） */
export function isSettledShowImageBlock(block: { type: string }): block is AssistantToolBlock {
  if (block.type !== 'tool') return false
  const tool = block as AssistantToolBlock
  return tool.toolName === SHOW_IMAGE_TOOL_NAME && tool.result !== undefined && !tool.isError
}

/** 一张要画的图：快照 + 参数里同一下标的说明 */
export interface ShownImageItem {
  image: ShownImage
  caption?: string
}

/** 一次 `show_image` 调用里要画的图（坏项跳过；顺序同参数） */
export function shownImagesOfBlock(block: AssistantToolBlock): ShownImageItem[] {
  const details = block.details
  if (details?.type !== SHOW_IMAGE_TOOL_NAME || !Array.isArray(details.images)) return []
  const args = (block.args as { images?: unknown } | undefined)?.images
  const list = Array.isArray(args) ? args : []
  const out: ShownImageItem[] = []
  details.images.forEach((raw: unknown, i) => {
    const image = shownImageOf(raw)
    if (!image) return
    const arg: unknown = list[i]
    const caption =
      typeof arg === 'object' && arg !== null ? (arg as Record<string, unknown>).caption : undefined
    out.push(
      typeof caption === 'string' && caption.trim() !== ''
        ? { image, caption: caption.trim() }
        : { image }
    )
  })
  return out
}

/** `suggest` 调用详情里每条提议的图（下标同参数；没带图、或详情不是这个形状 → 那一格 undefined） */
export function suggestionImagesOf(
  details: ToolResultDetails | undefined
): Array<ShownImage | undefined> {
  if (details?.type !== 'suggest' || !Array.isArray(details.images)) return []
  return details.images.map((raw: unknown) => shownImageOf(raw))
}
