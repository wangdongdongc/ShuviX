/**
 * File preview 共享内核 —— 为文件预览窗口决定 FileReadResult，以及「这个文件能不能预览」。
 *
 * 宿主无关：只依赖注入的 FileSystemPort（stat + readBytes）。分类与读取共用同一份
 * 判定（classifyPreviewFile），「开不开窗」与「窗里显示什么」不会漂移。
 * 二进制文件不支持预览（曾经的 hex 视图已移除）。
 *
 * 内存安全（核心不变量）：任何「整读」分支前一定先过 size cap；嗅探只经
 * readBytes(offset,length) 读有限字节。故预览 GB 级文件也不会把整体载入内存。
 */
import type { FileReadResult } from '@shuvix/chat-protocol/types/filePreview'
import type { FileSystemPort } from './port'
import { parseImagePixelSize } from './imageSize'

/** 文本整读上限：超过给 too-large 占位，不读字节 */
export const PREVIEW_TEXT_MAX_BYTES = 2 * 1024 * 1024
/** 图片 base64 直出上限：超过给 too-large 占位 */
export const PREVIEW_IMAGE_MAX_BYTES = 10 * 1024 * 1024
/** Office 整读 base64 上限：渲染端（docx-preview / SheetJS）同步解析，cap 防 UI 长冻结 */
export const PREVIEW_OFFICE_MAX_BYTES = 15 * 1024 * 1024
/**
 * 电子书上限。比 Office 宽得多 —— 字节不经 IPC（渲染端自己按 URL 取），这里只挡住
 * 解压后必然撑爆内存的量级；常规图文书 50–100MB 仍在范围内，超阈值的由渲染端成本门控接手。
 */
export const PREVIEW_EBOOK_MAX_BYTES = 200 * 1024 * 1024

/** 支持作为图像返回的扩展名 → MIME 映射（含 .svg 单独处理） */
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp'
}

/** Chromium 原生可播放的视频容器 */
const VIDEO_MIME_BY_EXT: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.ogv': 'video/ogg'
}

/** Chromium 原生可播放的音频格式 */
const AUDIO_MIME_BY_EXT: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.opus': 'audio/opus'
}

/**
 * 电子书 → 渲染端解析器路由。
 * `.cbz` 走电子书而非归档占位 —— 它就是一包按序图片，逐页翻比「不支持预览」有用得多。
 * 刻意不含 .mobi/.azw3：它们的资源模型绕不开 blob: URL，而渲染器 CSP 不放行（见 ebookLoaders 注释）。
 */
const EBOOK_KIND_BY_EXT: Record<string, 'epub' | 'fb2' | 'cbz'> = {
  '.epub': 'epub',
  '.fb2': 'fb2',
  '.cbz': 'cbz'
}

/**
 * Office 文档 → 浏览器端渲染库路由（'office' kind 的 officeKind 判定）：
 * docx → docx-preview；sheet → SheetJS 自渲表格。两库均在渲染端懒加载。
 */
const OFFICE_KIND_BY_EXT: Record<string, 'docx' | 'sheet'> = {
  '.docx': 'docx',
  '.xlsx': 'sheet',
  '.xlsm': 'sheet',
  '.xls': 'sheet',
  '.ods': 'sheet'
}

/**
 * 已知二进制扩展名 —— 不读字节直接判为 binary（不支持预览）。
 * 无浏览器端渲染方案的富文档容器（.doc/.pptx …）、归档、编码后媒体、可执行文件 / 库 / 字体 /
 * 数据库等都在这里；NULL 嗅探识别不了的（富容器头部常是可打印字节）靠它兜住，避免当文本乱码渲染。
 * （.docx/.xlsx 等走 'office'，.pdf 走 'pdf'，.cbz 走电子书，均不在此集合。）
 */
const BINARY_EXTENSIONS = new Set<string>([
  '.doc',
  '.pptx',
  '.ppt',
  '.odt',
  '.odp',
  '.rtf',
  '.zip',
  '.tar',
  '.gz',
  '.bz2',
  '.7z',
  '.rar',
  '.avi',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin',
  '.dat',
  '.db',
  '.sqlite',
  '.class',
  '.pyc',
  '.o',
  '.obj',
  '.wasm',
  '.ico',
  '.tiff',
  '.heic',
  '.ttf',
  '.otf',
  '.woff',
  '.woff2',
  '.iso',
  '.dmg',
  '.pkg',
  '.protobuf',
  '.pb'
])

/** 取小写扩展名（含点）；无扩展名返回 '' */
export function extOfPath(path: string): string {
  const name = path.replace(/\\/g, '/').split('/').pop() ?? ''
  const i = name.lastIndexOf('.')
  return i <= 0 ? '' : name.slice(i).toLowerCase()
}

/** Uint8Array → base64（分块，避免 String.fromCharCode 爆栈；两端通用） */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

/** 前 8KB NULL 字节嗅探（经典二进制启发式） */
function sniffBinary(head: Uint8Array): boolean {
  const n = Math.min(head.length, 8192)
  for (let i = 0; i < n; i++) if (head[i] === 0) return true
  return false
}

/**
 * 预览分类 —— 只决定「这个文件按哪种方式预览」，不读正文字节（最多读前 8KB 做 NULL 嗅探）。
 *
 * 与 previewFile 同一份判定：previewFile = 分类 + 按分类读字节。宿主在**打开预览之前**
 * 先问这里（桌面据此决定开不开预览窗口），免得为一次「开不开」把整份文件读进内存。
 */
export type PreviewClass =
  | { kind: 'pdf'; size: number; ext: string }
  | {
      kind: 'media'
      mediaType: 'video' | 'audio'
      mimeType: string
      size: number
      ext: string
    }
  | { kind: 'image'; mimeType: string; size: number; ext: string }
  | { kind: 'ebook'; ebookKind: 'epub' | 'fb2' | 'cbz'; size: number; ext: string }
  | { kind: 'office'; officeKind: 'docx' | 'sheet'; size: number; ext: string }
  | { kind: 'text'; size: number; ext: string }
  | { kind: 'binary'; size: number; ext: string }
  | { kind: 'too-large'; size: number; cap: number }
  | { kind: 'error'; message: string }

/** 能打开预览的分类（其余 —— 二进制 / 超限 / 读不了 —— 不支持预览） */
export function isPreviewable(c: PreviewClass): boolean {
  return (
    c.kind === 'pdf' ||
    c.kind === 'media' ||
    c.kind === 'image' ||
    c.kind === 'ebook' ||
    c.kind === 'office' ||
    c.kind === 'text'
  )
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 给文件分类（宿主无关内核）。准入、工作目录解析由各宿主在调用前完成。
 *
 * @param port     注入的文件系统 port（stat + readBytes）
 * @param portPath 交给 port 的路径（桌面=绝对路径）
 */
export async function classifyPreviewFile(
  port: FileSystemPort,
  portPath: string
): Promise<PreviewClass> {
  const ext = extOfPath(portPath)

  let stat: Awaited<ReturnType<FileSystemPort['stat']>>
  try {
    stat = await port.stat(portPath)
  } catch (err) {
    return { kind: 'error', message: errorMessage(err) }
  }
  if (!stat) return { kind: 'error', message: 'File not found' }
  if (stat.isDirectory) return { kind: 'error', message: 'Path is a directory' }
  if (!stat.isFile) return { kind: 'error', message: 'Path is not a regular file' }
  const size = stat.size

  // PDF：交给 iframe + Chromium 内置 PDFium，不读字节
  if (ext === '.pdf') return { kind: 'pdf', size, ext }

  // 视频 / 音频：交给 Chromium 原生 <video>/<audio>，流式播放，不读字节
  if (ext in VIDEO_MIME_BY_EXT)
    return { kind: 'media', mediaType: 'video', mimeType: VIDEO_MIME_BY_EXT[ext], size, ext }
  if (ext in AUDIO_MIME_BY_EXT)
    return { kind: 'media', mediaType: 'audio', mimeType: AUDIO_MIME_BY_EXT[ext], size, ext }

  // 图像（含 SVG）
  if (ext === '.svg' || ext in IMAGE_MIME_BY_EXT) {
    if (size > PREVIEW_IMAGE_MAX_BYTES)
      return { kind: 'too-large', size, cap: PREVIEW_IMAGE_MAX_BYTES }
    return {
      kind: 'image',
      mimeType: ext === '.svg' ? 'image/svg+xml' : IMAGE_MIME_BY_EXT[ext],
      size,
      ext
    }
  }

  // 电子书：字节由渲染端经 useMediaUrl 自取（见 'ebook' kind 注释）
  const ebookKind = EBOOK_KIND_BY_EXT[ext]
  if (ebookKind) {
    if (size > PREVIEW_EBOOK_MAX_BYTES)
      return { kind: 'too-large', size, cap: PREVIEW_EBOOK_MAX_BYTES }
    return { kind: 'ebook', ebookKind, size, ext }
  }

  // Office 文档（docx/xlsx/xlsm/xls/ods）
  const officeKind = OFFICE_KIND_BY_EXT[ext]
  if (officeKind) {
    if (size > PREVIEW_OFFICE_MAX_BYTES)
      return { kind: 'too-large', size, cap: PREVIEW_OFFICE_MAX_BYTES }
    return { kind: 'office', officeKind, size, ext }
  }

  // 已知二进制：不读字节
  if (BINARY_EXTENSIONS.has(ext)) return { kind: 'binary', size, ext }

  // 启发式 NULL 字节嗅探 —— 仅读前 8KB，对 GB 文件也便宜，故放在文本 size cap 之前
  try {
    const head =
      size === 0 ? new Uint8Array(0) : await port.readBytes(portPath, 0, Math.min(size, 8192))
    if (sniffBinary(head)) return { kind: 'binary', size, ext }
  } catch (err) {
    return { kind: 'error', message: errorMessage(err) }
  }

  // 走到这里说明是文本
  if (size > PREVIEW_TEXT_MAX_BYTES) return { kind: 'too-large', size, cap: PREVIEW_TEXT_MAX_BYTES }
  return { kind: 'text', size, ext }
}

/**
 * 为预览决定 FileReadResult（宿主无关内核）= classifyPreviewFile + 按分类读字节。
 *
 * @param port        注入的文件系统 port（stat + readBytes）
 * @param portPath    交给 port 的路径（桌面=绝对路径）
 * @param displayPath 回填到结果里的路径（渲染端展示 / 拼媒体 URL 用；缺省同 portPath）
 */
export async function previewFile(
  port: FileSystemPort,
  portPath: string,
  displayPath: string = portPath
): Promise<FileReadResult> {
  const c = await classifyPreviewFile(port, portPath)
  const path = displayPath
  try {
    switch (c.kind) {
      case 'image': {
        // size cap 已在分类里过了；通过后 base64 直出
        const bytes = c.size === 0 ? new Uint8Array(0) : await port.readBytes(portPath, 0, c.size)
        // 像素尺寸从已读到的字节里顺带解析（只看文件头，零额外 I/O）；SVG 无固有像素尺寸，跳过
        const pixels = c.ext === '.svg' ? null : parseImagePixelSize(bytes)
        return {
          kind: 'image',
          path,
          mimeType: c.mimeType,
          dataBase64: bytesToBase64(bytes),
          size: c.size,
          ext: c.ext,
          pixelWidth: pixels?.width,
          pixelHeight: pixels?.height
        }
      }
      case 'office': {
        // 整读 base64，渲染端 OfficeView 懒加载 docx-preview / SheetJS 解析渲染
        const bytes = c.size === 0 ? new Uint8Array(0) : await port.readBytes(portPath, 0, c.size)
        return {
          kind: 'office',
          path,
          officeKind: c.officeKind,
          dataBase64: bytesToBase64(bytes),
          size: c.size,
          ext: c.ext
        }
      }
      case 'text': {
        const bytes = c.size === 0 ? new Uint8Array(0) : await port.readBytes(portPath, 0, c.size)
        const content = new TextDecoder().decode(bytes)
        const lines = content.length === 0 ? 0 : content.split('\n').length
        return { kind: 'text', path, content, size: c.size, lines, ext: c.ext }
      }
      default:
        // pdf / media / ebook / binary / too-large / error：分类即结果，不读字节
        return { ...c, path }
    }
  } catch (err) {
    return { kind: 'error', path, message: errorMessage(err) }
  }
}
