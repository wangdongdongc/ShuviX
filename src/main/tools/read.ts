/**
 * Read 工具 — 读取文件内容
 * 从 pi-coding-agent 移植，支持分页读取、行号、截断
 * 支持通过 markitdown-ts 将 PDF/Office/HTML 等富文本格式转换为 Markdown
 * 支持通过 word-extractor 提取旧版 .doc 文件文字
 */

import { stat as fsStat, readdir as fsReaddir, open as fsOpen } from 'fs/promises'
import { createReadStream } from 'fs'
import { createInterface } from 'readline'
import { extname } from 'path'
import { Type } from '@sinclair/typebox'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import { MarkItDown } from 'markitdown-ts'
import WordExtractor from 'word-extractor'
import { truncateLine, truncateHead, formatSize, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES } from './utils/truncate'
import { resolveReadPath, suggestSimilarFiles } from './utils/pathUtils'
import { recordRead } from './utils/fileTime'
import { resolveProjectConfig, isPathWithinWorkspace, isPathWithinReferenceDirs, type ToolContext } from './types'
import { t } from '../i18n'
import { createLogger } from '../logger'
const log = createLogger('Tool:read')

/** markitdown-ts 支持转换的文件扩展名 */
const RICH_FILE_EXTENSIONS = new Set([
  '.pdf', '.docx', '.xlsx', '.xls', '.pptx',
  '.html', '.htm',
  '.ipynb', '.zip'
])

/** 已知的不支持二进制格式（直接拒绝读取，避免乱码） */
const KNOWN_BINARY_EXTENSIONS = new Set([
  '.ppt',                   // Office 旧版二进制格式（.doc 已由 word-extractor 处理，.xls 已在 RICH 集合中）
  '.odt', '.ods', '.odp', // OpenDocument
  '.rtf',
  '.exe', '.dll', '.so', '.dylib', // 可执行 / 库
  '.bin', '.dat', '.db', '.sqlite',
  '.class', '.pyc', '.o', '.obj',
  '.wasm',
  '.tar', '.gz', '.bz2', '.7z', '.rar',
  '.mp3', '.mp4', '.avi', '.mov', '.wav', '.flac', '.ogg', '.webm',
  '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.ico', '.tiff', '.heic',
  '.ttf', '.otf', '.woff', '.woff2',
  '.iso', '.dmg', '.pkg',
  '.protobuf', '.pb'
])

/** 检测文件是否为二进制（只读取前 8KB，检查 NULL 字节） */
async function isBinaryFile(filepath: string, fileSize: number): Promise<boolean> {
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

/** 单例 MarkItDown 实例 */
let markitdownInstance: MarkItDown | null = null
function getMarkItDown(): MarkItDown {
  if (!markitdownInstance) markitdownInstance = new MarkItDown()
  return markitdownInstance
}

/** 单例 WordExtractor 实例 */
let wordExtractorInstance: WordExtractor | null = null
function getWordExtractor(): WordExtractor {
  if (!wordExtractorInstance) wordExtractorInstance = new WordExtractor()
  return wordExtractorInstance
}

const ReadParamsSchema = Type.Object({
  path: Type.String({
    description: 'The file or directory path to read (relative or absolute)'
  }),
  offset: Type.Optional(
    Type.Number({
      description: 'Starting line number (1-based) for paginated reading of large files'
    })
  ),
  limit: Type.Optional(
    Type.Number({
      description: 'Maximum number of lines to read, used together with offset'
    })
  )
})

/** 创建 read 工具实例 */
export function createReadTool(ctx: ToolContext): AgentTool<typeof ReadParamsSchema> {

  return {
    name: 'read',
    label: t('tool.readLabel'),
    description:
      'Read file or directory contents. For text files, returns content with line numbers (supports pagination via offset/limit). For directories, returns a sorted list of entries. Also supports PDF, Word, Excel, PowerPoint, HTML, and Jupyter Notebook formats (auto-converted to Markdown).',
    parameters: ReadParamsSchema,
    execute: async (
      _toolCallId: string,
      params: { path: string; offset?: number; limit?: number },
      signal?: AbortSignal
    ) => {
      if (signal?.aborted) throw new Error(t('tool.aborted'))

      const config = resolveProjectConfig(ctx)
      const absolutePath = resolveReadPath(params.path, config.workingDirectory)
      log.info(absolutePath)

      // 沙箱模式：路径越界检查（工作目录 + 参考目录均允许读取）
      if (config.sandboxEnabled
        && !isPathWithinWorkspace(absolutePath, config.workingDirectory)
        && !isPathWithinReferenceDirs(absolutePath, config.referenceDirs)) {
        throw new Error(t('tool.sandboxBlocked', { path: params.path, workspace: config.workingDirectory }))
      }

      try {
        // 获取文件/目录信息
        const s = await fsStat(absolutePath)

        // 目录：列出条目
        if (s.isDirectory()) {
          return await readDirectory(absolutePath, params)
        }

        const fileStat = { size: s.size, isFile: s.isFile() }
        if (!fileStat.isFile) {
          throw new Error(t('tool.notAFile', { path: params.path }))
        }

        if (signal?.aborted) throw new Error(t('tool.aborted'))

        // 判断是否为富文本文件，使用 markitdown-ts 转换
        const ext = extname(absolutePath).toLowerCase()
        if (RICH_FILE_EXTENSIONS.has(ext)) {
          return await readRichFile(absolutePath, params.path, fileStat.size, signal)
        }

        // 旧版 Word .doc 文件：使用 word-extractor 提取文字
        if (ext === '.doc') {
          return await readLegacyDoc(absolutePath, params.path, fileStat.size, signal)
        }

        // 已知二进制格式：直接拒绝
        if (KNOWN_BINARY_EXTENSIONS.has(ext)) {
          throw new Error(t('tool.unsupportedFormat', { path: params.path, ext }))
        }

        // 检测是否为二进制（只读取前 8KB，不加载整个文件）
        if (await isBinaryFile(absolutePath, fileStat.size)) {
          throw new Error(t('tool.unsupportedFormat', { path: params.path, ext: ext || 'binary' }))
        }

        // 纯文本文件：流式逐行读取
        const result = await readTextFile(absolutePath, params, fileStat)
        // 记录读取时间（用于 edit/write 工具校验文件是否被外部修改）
        recordRead(ctx.sessionId, absolutePath)
        return result
      } catch (err: any) {
        if (err.message === t('tool.aborted')) throw err
        if (err.code === 'ENOENT') {
          // 模糊匹配建议
          const suggestions = suggestSimilarFiles(absolutePath)
          if (suggestions.length > 0) {
            throw new Error(
              t('tool.fileNotFound', { path: params.path }) +
              '\n\nDid you mean one of these?\n' +
              suggestions.join('\n')
            )
          }
          throw new Error(t('tool.fileNotFound', { path: params.path }))
        }
        throw new Error(t('tool.cmdFailed', { message: err.message }))
      }
    }
  }
}

/**
 * 目录读取：列出条目（目录加 / 后缀），排序，支持 offset/limit 分页
 */
async function readDirectory(
  absolutePath: string,
  params: { path: string; offset?: number; limit?: number }
) {
  const dirents = await fsReaddir(absolutePath, { withFileTypes: true })
  const entries = dirents.map((d) => (d.isDirectory() ? d.name + '/' : d.name))
  entries.sort((a, b) => a.localeCompare(b))

  const limit = params.limit ?? DEFAULT_MAX_LINES
  const offset = params.offset ?? 1
  const start = offset - 1
  const sliced = entries.slice(start, start + limit)
  const total = entries.length
  const shown = sliced.length
  const endIndex = start + shown
  const truncated = endIndex < total

  let text = t('tool.dirHeader', { path: params.path, count: total }) + '\n'
  if (params.offset || params.limit) {
    text += t('tool.dirShowingEntries', { start: offset, end: offset + shown - 1 }) + '\n'
  }
  text += '\n' + sliced.join('\n')
  text += '\n\n' + (truncated
    ? t('tool.dirPagination', { shown, total, next: endIndex + 1 })
    : t('tool.dirAllEntries', { count: total }))

  return {
    content: [{ type: 'text' as const, text }],
    details: {
      totalEntries: total,
      truncated
    }
  }
}

/**
 * 富文本文件：通过 markitdown-ts 转换为 Markdown
 */
async function readRichFile(
  absolutePath: string,
  displayPath: string,
  fileSize: number,
  signal?: AbortSignal
) {
  if (signal?.aborted) throw new Error(t('tool.aborted'))

  const md = getMarkItDown()
  const result = await md.convert(absolutePath)
  if (!result || !result.markdown) {
    throw new Error(t('tool.convertFailed', { path: displayPath }))
  }

  let text = result.markdown

  // 截断处理
  const truncated = truncateHead(text, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES)
  if (truncated.truncated) {
    text = `${t('tool.outputTruncated', { lines: text.split('\n').length, size: formatSize(fileSize) })}\n\n${truncated.text}`
  } else {
    text = truncated.text
  }

  // 文件信息头
  const ext = extname(absolutePath).toLowerCase().slice(1).toUpperCase()
  const header = t('tool.convertedHeader', { path: displayPath, format: ext, size: formatSize(fileSize) })
  text = `${header}\n\n${text}`

  return {
    content: [{ type: 'text' as const, text }],
    details: {
      fileSize,
      format: ext,
      converted: true,
      truncated: truncated.truncated
    }
  }
}

/**
 * 旧版 Word .doc 文件：通过 word-extractor 提取纯文本
 */
async function readLegacyDoc(
  absolutePath: string,
  displayPath: string,
  fileSize: number,
  signal?: AbortSignal
) {
  if (signal?.aborted) throw new Error(t('tool.aborted'))

  const extractor = getWordExtractor()
  const doc = await extractor.extract(absolutePath)
  let text = doc.getBody()?.trim()
  if (!text) {
    throw new Error(t('tool.convertFailed', { path: displayPath }))
  }

  // 截断处理
  const truncated = truncateHead(text, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES)
  if (truncated.truncated) {
    text = `${t('tool.outputTruncated', { lines: text.split('\n').length, size: formatSize(fileSize) })}\n\n${truncated.text}`
  } else {
    text = truncated.text
  }

  // 文件信息头
  const header = t('tool.convertedHeader', { path: displayPath, format: 'DOC', size: formatSize(fileSize) })
  text = `${header}\n\n${text}`

  return {
    content: [{ type: 'text' as const, text }],
    details: {
      fileSize,
      format: 'DOC',
      converted: true,
      truncated: truncated.truncated
    }
  }
}

/**
 * 纯文本文件：流式逐行读取（行号、分页、单行截断、字节上限）
 * 使用 readline 流式读取，遇到行数/字节截断点即 break，不需要将整个文件读入内存
 */
async function readTextFile(
  absolutePath: string,
  params: { path: string; offset?: number; limit?: number },
  fileStat: { size: number }
) {
  const stream = createReadStream(absolutePath, { encoding: 'utf8' })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })

  const limit = params.limit ?? DEFAULT_MAX_LINES
  const offset = params.offset ?? 1
  const start = offset - 1
  const raw: string[] = []
  let bytes = 0
  let lines = 0
  let truncatedByBytes = false
  let hasMoreLines = false

  try {
    for await (const text of rl) {
      lines += 1
      if (lines <= start) continue

      if (raw.length >= limit) {
        hasMoreLines = true
        continue
      }

      // 单行截断（minified JS/CSS 等场景）
      const line = truncateLine(text)
      const size = Buffer.byteLength(line, 'utf-8') + (raw.length > 0 ? 1 : 0)
      if (bytes + size > DEFAULT_MAX_BYTES) {
        truncatedByBytes = true
        hasMoreLines = true
        break
      }

      raw.push(line)
      bytes += size
    }
  } finally {
    rl.close()
    stream.destroy()
  }

  const totalLines = lines
  const lastReadLine = offset + raw.length - 1
  const nextOffset = lastReadLine + 1
  const truncated = hasMoreLines || truncatedByBytes

  // 行号宽度对齐
  const padWidth = String(totalLines).length

  // 添加行号
  const numbered = raw.map((line, i) => {
    const lineNum = offset + i
    return `${String(lineNum).padStart(padWidth, ' ')}│${line}`
  })

  let text = numbered.join('\n')

  // 截断提示
  if (truncatedByBytes) {
    text += `\n\n(Output capped at ${formatSize(DEFAULT_MAX_BYTES)}. Showing lines ${offset}-${lastReadLine}. Use offset=${nextOffset} to continue.)`
  } else if (hasMoreLines) {
    text += `\n\n(Showing lines ${offset}-${lastReadLine} of ${totalLines}. Use offset=${nextOffset} to continue.)`
  } else {
    text += `\n\n(End of file - total ${totalLines} lines)`
  }

  // 文件信息头
  const header = t('tool.fileHeader', { path: params.path, lines: totalLines, size: formatSize(fileStat.size) })
  if (params.offset || params.limit) {
    text = `${header}\n${t('tool.showingLines', { start: offset, end: lastReadLine })}\n\n${text}`
  } else {
    text = `${header}\n\n${text}`
  }

  return {
    content: [{ type: 'text' as const, text }],
    details: {
      totalLines,
      fileSize: fileStat.size,
      truncated
    }
  }
}
