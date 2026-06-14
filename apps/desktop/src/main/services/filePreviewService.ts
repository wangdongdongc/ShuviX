/**
 * File preview 服务 —— 为 FilesPanel 的预览覆盖层提供文件内容读取
 *
 * 与 ReadTool 的关键差异：
 *  - 沙箱判定走 isPathInSandboxRead（不弹审批）—— 被动 UI 不应在每次点击时打扰用户
 *  - 返回 FileReadResult discriminated union，二进制/超大/越权状态走专门分支而非抛异常
 *  - 不做 LLM 化处理：无行号 header、无 byte-cap 截断、无 tool_results 持久化、不压缩图片
 *  - 只复用底层原语（binaryDetect、resolveReadPath、resolveProjectConfig）
 */

import { stat as fsStat, readFile, writeFile, open as fsOpen } from 'fs/promises'
import type { Stats } from 'fs'
import { extname } from 'path'
import { sessionService } from './sessionService'
import { isPathInSandboxRead, isPathInSandboxWrite, resolveProjectConfig } from './toolContext'
import { resolveReadPath } from '../utils/toolUtils/pathUtils'
import {
  IMAGE_MIME_BY_EXT,
  KNOWN_BINARY_EXTENSIONS,
  isBinaryFile
} from '../utils/toolUtils/binaryDetect'
import type { FileReadResult } from '@shuvix/chat-protocol/types/filePreview'

const PREVIEW_TEXT_MAX_BYTES = 2 * 1024 * 1024
const PREVIEW_IMAGE_MAX_BYTES = 10 * 1024 * 1024
/** Hex 视图只读取前 1 MiB —— 大于这个量级用户应该用专门工具，预览面板只做"瞄一眼" */
const PREVIEW_HEX_MAX_BYTES = 1024 * 1024

/**
 * hex 视图无价值的扩展名 —— 即使是二进制也只给占位卡片，不读字节。
 * 归档（zip/tar/...）和编码后媒体（mp4/mp3/...）头部之后全是压缩或编码后的随机字节，
 * hex view 没有可读性。RICH_BINARY_PREVIEW_EXTENSIONS（PDF/Office）已经在上方拦截。
 */
const HEX_VIEW_DENYLIST = new Set<string>([
  '.zip',
  '.tar',
  '.gz',
  '.bz2',
  '.7z',
  '.rar',
  // .avi 通常封装 XVID/DivX，Chromium 默认不解码；保留占位
  '.avi'
])

/** Chromium 原生可播放的视频容器（编码器随 Electron 私有版本附带 H.264/H.265/AAC） */
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
 * Office / PDF / 压缩包等富文本/容器格式 —— 内容是二进制，
 * isBinaryFile 的 NULL-字节嗅探不一定能识别（PDF 前 8KB 经常没有 NULL），
 * 这里显式列出避免渲染成乱码。read 工具有 markitdown 转 Markdown 路径，
 * 但预览面板是被动 UI，不引入异步转换链路，直接占位即可。
 */
const RICH_BINARY_PREVIEW_EXTENSIONS = new Set<string>([
  // .pdf 走专门的 'pdf' kind 喂给 iframe + Chromium 内置 PDFium，不在此处兜底
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.pptx'
])

/**
 * 用 fh.read 仅读取前 N 字节，避免对几百 MB 的文件调 readFile 把全部加载进内存。
 * truncated 由调用方根据 totalSize 与读取上限对比决定。
 */
async function readHexHead(
  absolutePath: string,
  totalSize: number
): Promise<{ data: Buffer; truncated: boolean }> {
  const length = Math.min(totalSize, PREVIEW_HEX_MAX_BYTES)
  if (length === 0) return { data: Buffer.alloc(0), truncated: false }
  const fh = await fsOpen(absolutePath, 'r')
  try {
    const buf = Buffer.alloc(length)
    const { bytesRead } = await fh.read(buf, 0, length, 0)
    return {
      data: bytesRead === length ? buf : buf.subarray(0, bytesRead),
      truncated: totalSize > length
    }
  } finally {
    await fh.close()
  }
}

interface MagicSignature {
  /** 起始偏移 —— 缺省 0 */
  offset?: number
  /** 必须命中的字节序列；mask 中为 0 的位置为通配 */
  pattern: number[]
  /** 与 pattern 同长度，0=通配，0xFF=必匹配。缺省全 0xFF */
  mask?: number[]
  label: string
  /** 命中后进一步判断（例 RIFF 容器读 4-7 字节决定 WAVE/AVI/WEBP） */
  sub?: (buf: Buffer) => string
}

/** 顺序敏感：长签名在前，避免短前缀提前命中（例如 `4D 5A` 不应抢在 `4D 5A` 之前需要的检查之前） */
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
      const tag = buf.toString('ascii', 8, 12)
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
  {
    offset: 4,
    pattern: [0x66, 0x74, 0x79, 0x70],
    label: 'MP4 / QuickTime container'
  },
  { pattern: [0xff, 0xd8, 0xff], label: 'JPEG image' },
  { pattern: [0x42, 0x5a, 0x68], label: 'bzip2 archive' },
  { pattern: [0x49, 0x44, 0x33], label: 'MP3 audio (ID3v2)' },
  { pattern: [0xef, 0xbb, 0xbf], label: 'UTF-8 BOM' },
  { pattern: [0x1f, 0x8b], label: 'gzip archive' },
  { pattern: [0x42, 0x4d], label: 'BMP image' },
  { pattern: [0x4d, 0x5a], label: 'PE (Windows EXE/DLL)' }
]

function detectMagic(buf: Buffer): string | undefined {
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

export async function previewSessionFile(sessionId: string, path: string): Promise<FileReadResult> {
  const session = sessionService.getById(sessionId)
  const workingDirectory = session?.workingDirectory
  if (!workingDirectory) {
    return { kind: 'not-allowed', path, reason: 'No active workspace for this session' }
  }

  const absolutePath = resolveReadPath(path, workingDirectory)
  const config = resolveProjectConfig(sessionId)

  if (!isPathInSandboxRead(config, absolutePath)) {
    return {
      kind: 'not-allowed',
      path,
      reason: 'Path is outside the workspace and reference directories'
    }
  }

  let s: Stats
  try {
    s = await fsStat(absolutePath)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { kind: 'error', path, message: 'File not found' }
    return { kind: 'error', path, message: err instanceof Error ? err.message : String(err) }
  }

  if (s.isDirectory()) {
    return { kind: 'error', path, message: 'Path is a directory' }
  }
  if (!s.isFile()) {
    return { kind: 'error', path, message: 'Path is not a regular file' }
  }

  const ext = extname(absolutePath).toLowerCase()

  // PDF：交给 iframe + Chromium 内置 PDFium，主进程只做沙箱准入和大小汇报，不读字节
  if (ext === '.pdf') {
    return { kind: 'pdf', path: absolutePath, size: s.size, ext }
  }

  // 视频 / 音频：交给 Chromium 原生 <video>/<audio>，主进程只汇报准入信息，不读字节
  if (ext in VIDEO_MIME_BY_EXT) {
    return {
      kind: 'media',
      mediaType: 'video',
      path: absolutePath,
      mimeType: VIDEO_MIME_BY_EXT[ext],
      size: s.size,
      ext
    }
  }
  if (ext in AUDIO_MIME_BY_EXT) {
    return {
      kind: 'media',
      mediaType: 'audio',
      path: absolutePath,
      mimeType: AUDIO_MIME_BY_EXT[ext],
      size: s.size,
      ext
    }
  }

  // SVG：本质是 XML 文本，但 Chromium 原生渲染矢量更合适。
  // 走 image 分支：base64 包装成 data:image/svg+xml；<img> 标签不会执行内嵌 <script>，安全。
  if (ext === '.svg') {
    if (s.size > PREVIEW_IMAGE_MAX_BYTES) {
      return { kind: 'too-large', path, size: s.size, cap: PREVIEW_IMAGE_MAX_BYTES }
    }
    try {
      const buffer = await readFile(absolutePath)
      return {
        kind: 'image',
        path,
        mimeType: 'image/svg+xml',
        dataBase64: buffer.toString('base64'),
        size: s.size,
        ext
      }
    } catch (err) {
      return { kind: 'error', path, message: err instanceof Error ? err.message : String(err) }
    }
  }

  // 图像：扩展名映射命中即按 base64 直出，不压缩（本地查看无 token 成本）
  if (ext in IMAGE_MIME_BY_EXT) {
    if (s.size > PREVIEW_IMAGE_MAX_BYTES) {
      return { kind: 'too-large', path, size: s.size, cap: PREVIEW_IMAGE_MAX_BYTES }
    }
    try {
      const buffer = await readFile(absolutePath)
      return {
        kind: 'image',
        path,
        mimeType: IMAGE_MIME_BY_EXT[ext],
        dataBase64: buffer.toString('base64'),
        size: s.size,
        ext
      }
    } catch (err) {
      return { kind: 'error', path, message: err instanceof Error ? err.message : String(err) }
    }
  }

  // Office / PDF / 归档 / 编码后媒体 —— hex 没价值，给 binary 占位
  if (RICH_BINARY_PREVIEW_EXTENSIONS.has(ext) || HEX_VIEW_DENYLIST.has(ext)) {
    return { kind: 'binary', path, size: s.size, ext }
  }

  // 其余已知二进制扩展名 → hex view（读前 1 MiB）
  if (KNOWN_BINARY_EXTENSIONS.has(ext)) {
    try {
      const { data, truncated } = await readHexHead(absolutePath, s.size)
      return {
        kind: 'hex',
        path,
        size: s.size,
        ext,
        data,
        bytesShown: data.length,
        truncated,
        magic: detectMagic(data)
      }
    } catch {
      // 读 hex 失败也至少能分类成 binary，不抛 error 让 UI 占位
      return { kind: 'binary', path, size: s.size, ext }
    }
  }

  // 启发式 NULL 字节嗅探 —— 仅读 8KB，对 GB 文件也便宜，故放在 size cap 之前。
  // 命中后不论文件大小一律给 hex view（readHexHead 自带 1 MiB 上限）。
  let nullSniffed = false
  try {
    nullSniffed = await isBinaryFile(absolutePath, s.size)
  } catch (err) {
    return { kind: 'error', path, message: err instanceof Error ? err.message : String(err) }
  }
  if (nullSniffed) {
    try {
      const { data, truncated } = await readHexHead(absolutePath, s.size)
      return {
        kind: 'hex',
        path,
        size: s.size,
        ext,
        data,
        bytesShown: data.length,
        truncated,
        magic: detectMagic(data)
      }
    } catch {
      return { kind: 'binary', path, size: s.size, ext }
    }
  }

  // 走到这里说明是文本：先做文本大小检查
  if (s.size > PREVIEW_TEXT_MAX_BYTES) {
    return { kind: 'too-large', path, size: s.size, cap: PREVIEW_TEXT_MAX_BYTES }
  }

  try {
    const content = await readFile(absolutePath, 'utf8')
    const lines = content.length === 0 ? 0 : content.split('\n').length
    return { kind: 'text', path, content, size: s.size, lines, ext }
  } catch (err) {
    return { kind: 'error', path, message: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * 回写文件内容 —— 给中间区的 Markdown live-preview 编辑器自动保存用。
 *
 * 与 WriteTool 的差异同 previewSessionFile：走 isPathInSandboxWrite 的同步准入判定，
 * 不弹审批（被动 UI 不应每次自动保存都打断用户）。落在 workspace / 可读写参考目录之外
 * 一律拒绝（文件树只扫描 workspace，正常路径都在准入范围内）。
 */
export async function writeSessionFile(
  sessionId: string,
  path: string,
  content: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = sessionService.getById(sessionId)
  const workingDirectory = session?.workingDirectory
  if (!workingDirectory) return { ok: false, error: 'No active workspace for this session' }

  const absolutePath = resolveReadPath(path, workingDirectory)
  const config = resolveProjectConfig(sessionId)
  if (!isPathInSandboxWrite(config, absolutePath)) {
    return { ok: false, error: 'Path is not writable (outside workspace)' }
  }

  try {
    await writeFile(absolutePath, content, 'utf8')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
