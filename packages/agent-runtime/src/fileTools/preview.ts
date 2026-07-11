/**
 * File preview 共享内核 —— 为 FilesPanel 的预览覆盖层决定 FileReadResult。
 *
 * 宿主无关：只依赖注入的 FileSystemPort（stat + readBytes），桌面用 Node fs、
 * 扩展用 File System Access。两端共用同一份分类/大小门控/magic 逻辑，杜绝行为漂移。
 *
 * 内存安全（核心不变量）：任何「整读」分支前一定先过 size cap；hex/嗅探只经
 * readBytes(offset,length) 读有限字节。故预览 GB 级文件也不会把整体载入内存。
 */
import type { FileReadResult } from '@shuvix/chat-protocol/types/filePreview'
import type { FileSystemPort } from './port'

/** 文本整读上限：超过给 too-large 占位，不读字节 */
export const PREVIEW_TEXT_MAX_BYTES = 2 * 1024 * 1024
/** 图片 base64 直出上限：超过给 too-large 占位 */
export const PREVIEW_IMAGE_MAX_BYTES = 10 * 1024 * 1024
/** Hex 视图只读取前 1 MiB —— 更大用户应换专门工具，预览面板只做“瞄一眼” */
export const PREVIEW_HEX_MAX_BYTES = 1024 * 1024

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
 * hex 视图无价值的扩展名 —— 即使是二进制也只给 binary 占位卡片，不读字节。
 * 归档（zip/tar/...）和编码后媒体（.avi）头部之后是压缩/编码后随机字节，hex 没可读性。
 */
const HEX_VIEW_DENYLIST = new Set<string>(['.zip', '.tar', '.gz', '.bz2', '.7z', '.rar', '.avi'])

/**
 * Office / PDF 等富文本容器 —— 内容是二进制且 NULL 嗅探不一定识别（PDF 前 8KB 常无 NULL），
 * 显式列出走 binary 占位避免渲染成乱码。（.pdf 单独走 'pdf' kind 喂给 iframe，不在此集合。）
 */
const RICH_BINARY_PREVIEW_EXTENSIONS = new Set<string>(['.doc', '.docx', '.xls', '.xlsx', '.pptx'])

/** 已知二进制扩展名 → hex view（文本渲染会乱码，但 hex 有可读价值：可执行/库/字体/数据库…） */
const KNOWN_BINARY_EXTENSIONS = new Set<string>([
  '.ppt',
  '.odt',
  '.ods',
  '.odp',
  '.rtf',
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

interface MagicSignature {
  /** 起始偏移 —— 缺省 0 */
  offset?: number
  /** 必须命中的字节序列；mask 中为 0 的位置为通配 */
  pattern: number[]
  /** 与 pattern 同长度，0=通配，0xFF=必匹配。缺省全 0xFF */
  mask?: number[]
  label: string
  /** 命中后进一步判断（例 RIFF 容器读 8-11 字节决定 WAVE/AVI/WEBP） */
  sub?: (buf: Uint8Array) => string
}

/** 读 ASCII 子串（用于 magic 子类型判定），越界安全 */
function asciiAt(buf: Uint8Array, start: number, end: number): string {
  let s = ''
  for (let i = start; i < end && i < buf.length; i++) s += String.fromCharCode(buf[i])
  return s
}

/** 顺序敏感：长签名在前，避免短前缀提前命中 */
const MAGIC_SIGNATURES: ReadonlyArray<MagicSignature> = [
  { pattern: [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00], label: 'RAR v5 archive' },
  { pattern: [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00], label: 'RAR v1.5+ archive' },
  {
    pattern: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1],
    label: 'OLE Compound (legacy .doc/.xls)'
  },
  { pattern: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], label: 'PNG image' },
  {
    pattern: [
      0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33
    ],
    label: 'SQLite 3 database'
  },
  { pattern: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], label: '7-Zip archive' },
  { pattern: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61], label: 'GIF89a image' },
  { pattern: [0x47, 0x49, 0x46, 0x38, 0x37, 0x61], label: 'GIF87a image' },
  {
    pattern: [0xca, 0xfe, 0xba, 0xbe],
    // 后面 4 字节如果是 `00 00 00 ??` 说明 Java class；否则 Mach-O fat
    sub: (buf) => {
      if (buf.length >= 8 && buf[4] === 0 && buf[5] === 0 && buf[6] === 0) return 'Java class file'
      return 'Mach-O fat binary'
    },
    label: 'Mach-O fat binary'
  },
  { pattern: [0xfe, 0xed, 0xfa, 0xcf], label: 'Mach-O 64-bit (BE)' },
  { pattern: [0xfe, 0xed, 0xfa, 0xce], label: 'Mach-O 32-bit (BE)' },
  { pattern: [0xcf, 0xfa, 0xed, 0xfe], label: 'Mach-O 64-bit' },
  { pattern: [0xce, 0xfa, 0xed, 0xfe], label: 'Mach-O 32-bit' },
  { pattern: [0x7f, 0x45, 0x4c, 0x46], label: 'ELF executable' },
  { pattern: [0x25, 0x50, 0x44, 0x46], label: 'PDF document' },
  { pattern: [0x50, 0x4b, 0x03, 0x04], label: 'ZIP / .docx / .jar' },
  { pattern: [0x50, 0x4b, 0x05, 0x06], label: 'ZIP archive (empty)' },
  { pattern: [0x50, 0x4b, 0x07, 0x08], label: 'ZIP archive (spanned)' },
  { pattern: [0x00, 0x61, 0x73, 0x6d], label: 'WebAssembly module' },
  { pattern: [0x4f, 0x67, 0x67, 0x53], label: 'OGG container' },
  { pattern: [0x66, 0x4c, 0x61, 0x43], label: 'FLAC audio' },
  {
    pattern: [0x52, 0x49, 0x46, 0x46],
    // 字节 8-11 决定子类型
    sub: (buf) => {
      if (buf.length < 12) return 'RIFF container'
      const tag = asciiAt(buf, 8, 12)
      if (tag === 'WAVE') return 'WAVE audio'
      if (tag === 'AVI ') return 'AVI video'
      if (tag === 'WEBP') return 'WebP image'
      return 'RIFF container'
    },
    label: 'RIFF container'
  },
  { pattern: [0x4f, 0x54, 0x54, 0x4f], label: 'OpenType font (CFF)' },
  { pattern: [0x77, 0x4f, 0x46, 0x32], label: 'WOFF2 font' },
  { pattern: [0x77, 0x4f, 0x46, 0x46], label: 'WOFF font' },
  { pattern: [0x25, 0x21, 0x50, 0x53], label: 'PostScript document' },
  { pattern: [0x00, 0x01, 0x00, 0x00, 0x00], label: 'TrueType font' },
  // 偏移 4: `66 74 79 70` —— MP4 box header
  { offset: 4, pattern: [0x66, 0x74, 0x79, 0x70], label: 'MP4 / QuickTime container' },
  { pattern: [0xff, 0xd8, 0xff], label: 'JPEG image' },
  { pattern: [0x42, 0x5a, 0x68], label: 'bzip2 archive' },
  { pattern: [0x49, 0x44, 0x33], label: 'MP3 audio (ID3v2)' },
  { pattern: [0xef, 0xbb, 0xbf], label: 'UTF-8 BOM' },
  { pattern: [0x1f, 0x8b], label: 'gzip archive' },
  { pattern: [0x42, 0x4d], label: 'BMP image' },
  { pattern: [0x4d, 0x5a], label: 'PE (Windows EXE/DLL)' }
]

function detectMagic(buf: Uint8Array): string | undefined {
  for (const sig of MAGIC_SIGNATURES) {
    const off = sig.offset ?? 0
    if (buf.length < off + sig.pattern.length) continue
    let hit = true
    for (let i = 0; i < sig.pattern.length; i++) {
      const m = sig.mask?.[i] ?? 0xff
      if (m === 0) continue
      if ((buf[off + i] & m) !== (sig.pattern[i] & m)) {
        hit = false
        break
      }
    }
    if (!hit) continue
    return sig.sub ? sig.sub(buf) : sig.label
  }
  return undefined
}

/** 经 port 只读前 min(size, 1 MiB) 字节，构造 hex 结果 */
async function readHexResult(
  port: FileSystemPort,
  portPath: string,
  displayPath: string,
  ext: string,
  size: number
): Promise<FileReadResult> {
  const length = Math.min(size, PREVIEW_HEX_MAX_BYTES)
  const data = length === 0 ? new Uint8Array(0) : await port.readBytes(portPath, 0, length)
  return {
    kind: 'hex',
    path: displayPath,
    size,
    ext,
    data,
    bytesShown: data.length,
    truncated: size > data.length,
    magic: detectMagic(data)
  }
}

/**
 * 为预览面板决定 FileReadResult（宿主无关内核）。
 *
 * @param port        注入的文件系统 port（stat + readBytes）
 * @param portPath    交给 port 的路径（桌面=绝对路径；扩展=相对句柄根）
 * @param displayPath 回填到结果里的路径（渲染端展示 / 拼媒体 URL 用；缺省同 portPath）
 *
 * 沙箱准入、工作目录解析由各宿主在调用前完成 —— 内核只做「已准入文件」的分类。
 */
export async function previewFile(
  port: FileSystemPort,
  portPath: string,
  displayPath: string = portPath
): Promise<FileReadResult> {
  const ext = extOfPath(portPath)

  let stat: Awaited<ReturnType<FileSystemPort['stat']>>
  try {
    stat = await port.stat(portPath)
  } catch (err) {
    return {
      kind: 'error',
      path: displayPath,
      message: err instanceof Error ? err.message : String(err)
    }
  }
  if (!stat) return { kind: 'error', path: displayPath, message: 'File not found' }
  if (stat.isDirectory) return { kind: 'error', path: displayPath, message: 'Path is a directory' }
  if (!stat.isFile)
    return { kind: 'error', path: displayPath, message: 'Path is not a regular file' }
  const size = stat.size

  // PDF：交给 iframe + Chromium 内置 PDFium，不读字节
  if (ext === '.pdf') return { kind: 'pdf', path: displayPath, size, ext }

  // 视频 / 音频：交给 Chromium 原生 <video>/<audio>，流式播放，不读字节
  if (ext in VIDEO_MIME_BY_EXT)
    return {
      kind: 'media',
      mediaType: 'video',
      path: displayPath,
      mimeType: VIDEO_MIME_BY_EXT[ext],
      size,
      ext
    }
  if (ext in AUDIO_MIME_BY_EXT)
    return {
      kind: 'media',
      mediaType: 'audio',
      path: displayPath,
      mimeType: AUDIO_MIME_BY_EXT[ext],
      size,
      ext
    }

  // 图像（含 SVG）：size cap 命中前不读字节；通过后 base64 直出
  if (ext === '.svg' || ext in IMAGE_MIME_BY_EXT) {
    if (size > PREVIEW_IMAGE_MAX_BYTES)
      return { kind: 'too-large', path: displayPath, size, cap: PREVIEW_IMAGE_MAX_BYTES }
    const mimeType = ext === '.svg' ? 'image/svg+xml' : IMAGE_MIME_BY_EXT[ext]
    try {
      const bytes = size === 0 ? new Uint8Array(0) : await port.readBytes(portPath, 0, size)
      return {
        kind: 'image',
        path: displayPath,
        mimeType,
        dataBase64: bytesToBase64(bytes),
        size,
        ext
      }
    } catch (err) {
      return {
        kind: 'error',
        path: displayPath,
        message: err instanceof Error ? err.message : String(err)
      }
    }
  }

  // Office / 归档 / 编码后媒体 —— hex 无价值，给 binary 占位
  if (RICH_BINARY_PREVIEW_EXTENSIONS.has(ext) || HEX_VIEW_DENYLIST.has(ext))
    return { kind: 'binary', path: displayPath, size, ext }

  // 其余已知二进制扩展名 → hex view（只读前 1 MiB）
  if (KNOWN_BINARY_EXTENSIONS.has(ext)) {
    try {
      return await readHexResult(port, portPath, displayPath, ext, size)
    } catch {
      return { kind: 'binary', path: displayPath, size, ext }
    }
  }

  // 启发式 NULL 字节嗅探 —— 仅读前 8KB，对 GB 文件也便宜，故放在 size cap 之前。
  // 命中后不论文件大小一律给 hex view（readHexResult 自带 1 MiB 上限）。
  let nullSniffed = false
  try {
    const head =
      size === 0 ? new Uint8Array(0) : await port.readBytes(portPath, 0, Math.min(size, 8192))
    nullSniffed = sniffBinary(head)
  } catch (err) {
    return {
      kind: 'error',
      path: displayPath,
      message: err instanceof Error ? err.message : String(err)
    }
  }
  if (nullSniffed) {
    try {
      return await readHexResult(port, portPath, displayPath, ext, size)
    } catch {
      return { kind: 'binary', path: displayPath, size, ext }
    }
  }

  // 走到这里说明是文本：先做文本大小检查，再整读（gate 在读之前，杜绝大文件全载）
  if (size > PREVIEW_TEXT_MAX_BYTES)
    return { kind: 'too-large', path: displayPath, size, cap: PREVIEW_TEXT_MAX_BYTES }
  try {
    const bytes = size === 0 ? new Uint8Array(0) : await port.readBytes(portPath, 0, size)
    const content = new TextDecoder().decode(bytes)
    const lines = content.length === 0 ? 0 : content.split('\n').length
    return { kind: 'text', path: displayPath, content, size, lines, ext }
  } catch (err) {
    return {
      kind: 'error',
      path: displayPath,
      message: err instanceof Error ? err.message : String(err)
    }
  }
}
