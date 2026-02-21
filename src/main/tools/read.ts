/**
 * Read 工具 — 读取文件内容
 * 从 pi-coding-agent 移植，支持分页读取、行号、截断
 * 支持通过 markitdown-ts 将 PDF/Office/HTML 等富文本格式转换为 Markdown
 * 支持通过 word-extractor 提取旧版 .doc 文件文字
 */

import { readFile as fsReadFile, stat as fsStat } from 'fs/promises'
import { extname } from 'path'
import { Type } from '@sinclair/typebox'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import { MarkItDown } from 'markitdown-ts'
import WordExtractor from 'word-extractor'
import { truncateHead, formatSize, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES } from './utils/truncate'
import { resolveReadPath } from './utils/pathUtils'
import { resolveProjectConfig, isPathWithinWorkspace, type ToolContext } from './types'
import { t } from '../i18n'

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

/** 检测 Buffer 是否为二进制内容（前 8KB 中是否包含 NULL 字节） */
function isBinaryBuffer(buffer: Buffer): boolean {
  const checkLen = Math.min(buffer.length, 8192)
  for (let i = 0; i < checkLen; i++) {
    if (buffer[i] === 0) return true
  }
  return false
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
    description: t('tool.paramPath')
  }),
  offset: Type.Optional(
    Type.Number({
      description: t('tool.paramOffset')
    })
  ),
  limit: Type.Optional(
    Type.Number({
      description: t('tool.paramLimit')
    })
  )
})

/** 创建 read 工具实例 */
export function createReadTool(ctx: ToolContext): AgentTool<typeof ReadParamsSchema> {

  return {
    name: 'read',
    label: t('tool.readLabel'),
    description: t('tool.readDesc'),
    parameters: ReadParamsSchema,
    execute: async (
      _toolCallId: string,
      params: { path: string; offset?: number; limit?: number },
      signal?: AbortSignal
    ) => {
      if (signal?.aborted) throw new Error(t('tool.aborted'))

      const config = resolveProjectConfig(ctx)
      const absolutePath = resolveReadPath(params.path, config.workingDirectory)
      console.log(`[Tool: read] ${absolutePath}`)

      // 沙箱模式：路径越界检查
      if (config.sandboxEnabled && !isPathWithinWorkspace(absolutePath, config.workingDirectory)) {
        throw new Error(t('tool.sandboxBlocked', { path: params.path, workspace: config.workingDirectory }))
      }

      try {
        // 获取文件信息
        const s = await fsStat(absolutePath)
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

        // 读取文件并检测是否为二进制
        const buffer = await fsReadFile(absolutePath)
        if (isBinaryBuffer(buffer)) {
          throw new Error(t('tool.unsupportedFormat', { path: params.path, ext: ext || 'binary' }))
        }

        // 纯文本文件：原有逻辑
        return await readTextFile(absolutePath, params, fileStat, buffer)
      } catch (err: any) {
        if (err.message === t('tool.aborted')) throw err
        if (err.code === 'ENOENT') {
          throw new Error(t('tool.fileNotFound', { path: params.path }))
        }
        throw new Error(t('tool.cmdFailed', { message: err.message }))
      }
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
 * 纯文本文件：原有逻辑（行号、分页、截断）
 */
async function readTextFile(
  absolutePath: string,
  params: { path: string; offset?: number; limit?: number },
  fileStat: { size: number },
  preReadBuffer?: Buffer
) {
  const buffer = preReadBuffer ?? await fsReadFile(absolutePath)
  const content = buffer.toString('utf-8')
  const allLines = content.split('\n')
  const totalLines = allLines.length

  // 分页处理
  let lines = allLines
  let startLine = 1
  if (params.offset && params.offset > 0) {
    startLine = params.offset
    lines = allLines.slice(startLine - 1)
  }
  if (params.limit && params.limit > 0) {
    lines = lines.slice(0, params.limit)
  }

  // 添加行号
  const numbered = lines.map((line, i) => {
    const lineNum = startLine + i
    return `${String(lineNum).padStart(String(totalLines).length, ' ')}│${line}`
  })

  let text = numbered.join('\n')

  // 截断处理
  const truncated = truncateHead(text, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES)
  if (truncated.truncated) {
    text = `${t('tool.outputTruncated', { lines: totalLines, size: formatSize(fileStat.size) })}\n\n${truncated.text}`
  } else {
    text = truncated.text
  }

  // 添加文件信息头
  const header = t('tool.fileHeader', { path: params.path, lines: totalLines, size: formatSize(fileStat.size) })
  if (params.offset || params.limit) {
    const endLine = startLine + lines.length - 1
    text = `${header}\n${t('tool.showingLines', { start: startLine, end: endLine })}\n\n${text}`
  } else {
    text = `${header}\n\n${text}`
  }

  return {
    content: [{ type: 'text' as const, text }],
    details: {
      totalLines,
      fileSize: fileStat.size,
      truncated: truncated.truncated
    }
  }
}
