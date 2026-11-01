/**
 * 摆给用户看的图（`show_image` 工具与带图提议共用，设计稿 docs/show-image-design.md §4）—— agent 交本机文件路径，
 * 这里把它快照进 `<userData>/shown/<会话 id>/`，交回写进工具结果 `details` 的 `ShownImage`。
 *
 * 三条要点，改动前先读：
 *
 * 1. **没有权限点**（2026-11-01 用户裁决）：用户看自己的图不需要权限，模型看才需要。这里不报客体、不判断、不询问，
 *    所以带图提议照样立刻返回，没人在场的运行里也能用。模型从结果里只得到：文件在不在、是不是图、宽高。
 * 2. **快照在会话权限表之外**：这是「不成为模型读文件的旁路」的全部保证。快照目录若是权限表里的一行（像
 *    `tool_results/<id>`），「摆一张权限表外的图、再 read 快照」就绕过了外部路径询问。
 * 3. **历史记会话内的文件名**（`<sha256>.<ext>`），不记绝对路径：分支把整个目录拷过去（`copyShownImages`），历史照常
 *    显示；同一会话里同一份内容只存一份。
 *
 * 大位图另存一份展示副本（长边 2048）：卡片默认就显示，解码一张 4000×3000 的原图约 48 MB，副本把一段对话的内存
 * 上限压住；点开看原图。GIF 不缩（缩了丢动画），SVG 不缩。
 */
import { createHash } from 'crypto'
import { cpSync, existsSync, rmSync } from 'fs'
import { mkdir, readFile, realpath, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import { nativeImage } from 'electron'
import { parseImagePixelSize } from '@shuvix/agent-runtime'
import {
  isShownImageFile,
  SHOW_IMAGE_LIMITS,
  SHOWN_IMAGE_FORMAT_NAMES,
  SHOWN_IMAGE_FORMATS,
  shownImageFileOfRef,
  type ShownImageFormat
} from '@shuvix/chat-protocol/shownImages'
import type { ShownImage } from '@shuvix/chat-protocol/types/chatMessage'
import { getShownImagesDir, isSafeSessionId } from '../utils/paths'
import { resolveReadPath } from '../utils/toolUtils/pathUtils'
import { formatSize } from '../../shared/node/truncate'
import { createLogger } from '../logger'

const log = createLogger('ShownImages')

/** 展示副本的长边上限（像素） */
export const DISPLAY_MAX_EDGE = 2048
/** 超过这个字节数也另存展示副本 */
export const DISPLAY_MAX_BYTES = 4 * 1024 * 1024

/** 认 SVG 时看开头多少字节 */
const SVG_SNIFF_BYTES = 4096

/** 按文件头认格式（不看扩展名）；不是能摆的图 → undefined */
export function sniffShownImageFormat(bytes: Uint8Array): ShownImageFormat | undefined {
  const b = bytes
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return 'png'
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg'
  if (b.length >= 6) {
    const head = String.fromCharCode(...b.subarray(0, 6))
    if (head === 'GIF87a' || head === 'GIF89a') return 'gif'
  }
  if (
    b.length >= 12 &&
    String.fromCharCode(...b.subarray(0, 4)) === 'RIFF' &&
    String.fromCharCode(...b.subarray(8, 12)) === 'WEBP'
  ) {
    return 'webp'
  }
  // SVG 是文本：去掉 BOM、前导空白，以及前面的 XML 声明 / 处理指令 / 注释 / SVG 自己的 doctype，第一个元素得是
  // <svg ——「开头几 KB 里出现过 <svg」不算（一页 HTML 里内嵌一张 SVG 不是 SVG 文件，`<!doctype html>` 不跳）
  let text = Buffer.from(b.subarray(0, SVG_SNIFF_BYTES))
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .toLowerCase()
  for (;;) {
    text = text.trimStart()
    const end = text.startsWith('<?')
      ? text.indexOf('?>') + 2
      : text.startsWith('<!--')
        ? text.indexOf('-->') + 3
        : text.startsWith('<!doctype svg')
          ? doctypeEnd(text)
          : -1
    if (end <= 1) break
    text = text.slice(end)
  }
  return text.startsWith('<svg') ? 'svg' : undefined
}

/** `<!doctype svg …>` 的结尾（带内部子集 `[ … ]` 的也认）；没写完 → -1 */
function doctypeEnd(text: string): number {
  const bracket = text.indexOf('[')
  const close = text.indexOf('>')
  if (bracket !== -1 && bracket < close) {
    const subsetEnd = text.indexOf(']', bracket)
    if (subsetEnd === -1) return -1
    const after = text.indexOf('>', subsetEnd)
    return after === -1 ? -1 : after + 1
  }
  return close === -1 ? -1 : close + 1
}

/** 要摆的一张图：路径 + 出错时给模型看的位置（`images[1].path` / `suggestions[0].image`） */
export interface PresentImageRequest {
  path: string
  label: string
}

/**
 * 展示副本：缩好的字节 + 尺寸；做不出来（解码失败）→ null，卡片就用原图。`size` 是从文件头读出的尺寸，读不出来是
 * null（超过 DISPLAY_MAX_BYTES 的位图照样交过来，由解码器自己量）
 */
export type DisplayResizer = (
  bytes: Buffer,
  format: ShownImageFormat,
  size: { width: number; height: number } | null
) => { bytes: Buffer; format: ShownImageFormat; width: number; height: number } | null

/** 缺省的展示副本：Electron nativeImage 缩到长边 DISPLAY_MAX_EDGE；PNG 仍存 PNG（留透明），其余存 JPEG 90 */
export const nativeDisplayResizer: DisplayResizer = (bytes, format, size) => {
  const img = nativeImage.createFromBuffer(bytes)
  if (img.isEmpty()) return null
  const { width: w, height: h } = size ?? img.getSize()
  if (w <= 0 || h <= 0) return null
  const scale = Math.min(1, DISPLAY_MAX_EDGE / Math.max(w, h))
  const resized =
    scale < 1
      ? img.resize({
          width: Math.max(1, Math.round(w * scale)),
          height: Math.max(1, Math.round(h * scale)),
          quality: 'good'
        })
      : img
  const out = format === 'png' ? resized.toPNG() : resized.toJPEG(90)
  if (out.length === 0) return null
  const { width, height } = resized.getSize()
  return { bytes: out, format: format === 'png' ? 'png' : 'jpg', width, height }
}

/** 字节 → 快照文件名（内容寻址） */
function snapshotName(bytes: Buffer, format: ShownImageFormat): string {
  return `${createHash('sha256').update(bytes).digest('hex')}.${format}`
}

/** 写一份快照（同名已在 = 同一份内容，不再写） */
async function writeSnapshot(dir: string, name: string, bytes: Buffer): Promise<void> {
  const target = join(dir, name)
  if (existsSync(target)) return
  await mkdir(dir, { recursive: true })
  await writeFile(target, bytes)
}

/**
 * 快照这几张图，交回与请求同序的 `ShownImage`。任何一张有问题（不存在、不是文件、太大、不是能摆的图）就抛，消息是
 * 给模型读的、可以照着改 —— 调用方据此整次失败，不留半截卡片。
 */
export async function presentImages(
  params: { sessionId: string; workingDirectory: string; images: readonly PresentImageRequest[] },
  resize: DisplayResizer = nativeDisplayResizer
): Promise<ShownImage[]> {
  const { sessionId, workingDirectory, images } = params
  if (!isSafeSessionId(sessionId)) throw new Error('This session cannot show images.')
  const dir = getShownImagesDir(sessionId)
  const out: ShownImage[] = []
  for (const { path, label } of images) {
    const resolved = resolveReadPath(path, workingDirectory)
    let source: string
    try {
      source = await realpath(resolved)
    } catch {
      throw new Error(`${label}: no such file: ${resolved}`)
    }
    const info = await stat(source)
    if (!info.isFile()) throw new Error(`${label}: not a file: ${source}`)
    if (info.size > SHOW_IMAGE_LIMITS.maxBytes) {
      // 带上字节数：刚过上限的文件按 formatSize 四舍五入会和上限写成同一个数
      throw new Error(
        `${label}: ${source} is ${formatSize(info.size)} (${info.size} bytes); the limit is ${formatSize(SHOW_IMAGE_LIMITS.maxBytes)} (${SHOW_IMAGE_LIMITS.maxBytes} bytes)`
      )
    }
    const bytes = await readFile(source)
    const format = sniffShownImageFormat(bytes)
    if (!format) {
      throw new Error(`${label}: ${source} is not a ${SHOWN_IMAGE_FORMAT_NAMES} image`)
    }
    const size = format === 'svg' ? null : parseImagePixelSize(bytes)
    const originalName = snapshotName(bytes, format)
    await writeSnapshot(dir, originalName, bytes)

    let shown: ShownImage = {
      file: originalName,
      source,
      mimeType: SHOWN_IMAGE_FORMATS[format],
      ...(size ? { width: size.width, height: size.height } : {}),
      bytes: bytes.length
    }
    // GIF 不缩（丢动画）、SVG 不缩；尺寸读不出来的大位图也交给解码器试一次
    const needsDisplayCopy =
      format !== 'gif' &&
      format !== 'svg' &&
      (bytes.length > DISPLAY_MAX_BYTES ||
        (size !== null && Math.max(size.width, size.height) > DISPLAY_MAX_EDGE))
    if (needsDisplayCopy) {
      let display: ReturnType<DisplayResizer> = null
      try {
        display = resize(bytes, format, size)
      } catch (err) {
        log.warn(
          `展示副本做不出来，卡片用原图：${err instanceof Error ? err.message : String(err)}`
        )
      }
      if (display) {
        const displayName = snapshotName(display.bytes, display.format)
        await writeSnapshot(dir, displayName, display.bytes)
        shown = {
          file: displayName,
          original: originalName,
          source,
          mimeType: SHOWN_IMAGE_FORMATS[display.format],
          width: display.width,
          height: display.height,
          bytes: display.bytes.length
        }
      }
    }
    out.push(shown)
  }
  return out
}

/** 一条会话里一张快照的绝对路径；会话 id 或文件名形状不对 → undefined（当作不存在） */
export function shownImageFilePath(sessionId: string, file: string): string | undefined {
  if (!isSafeSessionId(sessionId) || !isShownImageFile(file)) return undefined
  return join(getShownImagesDir(sessionId), file)
}

/** `shown:<file>` 引用 → 绝对路径；不是这种引用 → undefined（调用方照普通路径解析） */
export function shownImagePathOfRef(sessionId: string, path: string): string | undefined {
  const file = shownImageFileOfRef(path)
  return file === undefined ? undefined : shownImageFilePath(sessionId, file)
}

/** 删一条会话的全部快照（删会话时）。从不抛：清理失败不该让删除半途而废，与 tool_results 的清理同一个口径 */
export function removeShownImages(sessionId: string): void {
  try {
    if (!isSafeSessionId(sessionId)) return
    const dir = getShownImagesDir(sessionId)
    if (!existsSync(dir)) return
    rmSync(dir, { recursive: true, force: true })
  } catch (err) {
    log.warn(`删会话 ${sessionId} 的快照失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

/** 分支：把源会话的快照整个拷给新会话（文件名不变，历史照常显示）。没有就什么都不做 */
export function copyShownImages(fromSessionId: string, toSessionId: string): void {
  if (!isSafeSessionId(fromSessionId) || !isSafeSessionId(toSessionId)) return
  const from = getShownImagesDir(fromSessionId)
  if (!existsSync(from)) return
  cpSync(from, getShownImagesDir(toSessionId), { recursive: true })
}
