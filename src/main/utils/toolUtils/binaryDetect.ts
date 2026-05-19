/**
 * 二进制 / 图像扩展名识别 + NULL 字节嗅探
 * 提取自 src/main/tools/read.ts，供 read 工具和 filePreviewService 共享
 */

import { open as fsOpen } from 'fs/promises'

/** 已知的不支持二进制格式（直接拒绝读取，避免乱码） */
export const KNOWN_BINARY_EXTENSIONS = new Set<string>([
  '.ppt', // Office 旧版二进制格式（.doc 已由 word-extractor 处理，.xls 已在 RICH 集合中）
  '.odt',
  '.ods',
  '.odp', // OpenDocument
  '.rtf',
  '.exe',
  '.dll',
  '.so',
  '.dylib', // 可执行 / 库
  '.bin',
  '.dat',
  '.db',
  '.sqlite',
  '.class',
  '.pyc',
  '.o',
  '.obj',
  '.wasm',
  '.tar',
  '.gz',
  '.bz2',
  '.7z',
  '.rar',
  '.mp3',
  '.mp4',
  '.avi',
  '.mov',
  '.wav',
  '.flac',
  '.ogg',
  '.webm',
  // 未支持的图像/字体格式（支持的图像见 IMAGE_MIME_BY_EXT）
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

/** 支持作为图像返回的扩展名 → MIME 映射 */
export const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp'
}

/** 检测文件是否为二进制（只读取前 8KB，检查 NULL 字节） */
export async function isBinaryFile(filepath: string, fileSize: number): Promise<boolean> {
  if (fileSize === 0) return false
  const fh = await fsOpen(filepath, 'r')
  try {
    const sampleSize = Math.min(8192, fileSize)
    const bytes = Buffer.alloc(sampleSize)
    const result = await fh.read(bytes, 0, sampleSize, 0)
    if (result.bytesRead === 0) return false
    for (let i = 0; i < result.bytesRead; i++) {
      if (bytes[i] === 0) return true
    }
    return false
  } finally {
    await fh.close()
  }
}
