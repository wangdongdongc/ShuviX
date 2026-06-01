/**
 * Read 工具 — 读取文件内容 / 抓取网页
 * 从 pi-coding-agent 移植，支持分页读取、行号、截断
 * 支持通过 markitdown-ts 将 PDF/Office/HTML 等富文本格式转换为 Markdown
 * 支持通过 word-extractor 提取旧版 .doc 文件文字
 * 支持通过 markitdown-ts 抓取 URL 并转换为 Markdown
 */

import { stat as fsStat, readdir as fsReaddir, readFile } from 'fs/promises'
import { createReadStream } from 'fs'
import { createInterface } from 'readline'
import { extname } from 'path'
import { Type } from 'typebox'
import { nativeImage } from 'electron'
import { MarkItDown } from 'markitdown-ts'
import WordExtractor from 'word-extractor'
import {
  truncateLine,
  formatSize,
  DEFAULT_MAX_LINES,
  DEFAULT_MAX_BYTES
} from '../../shared/node/truncate'
import { resolveReadPath, suggestSimilarFiles } from '../utils/toolUtils/pathUtils'
import { recordRead } from '../utils/toolUtils/fileTime'
import {
  KNOWN_BINARY_EXTENSIONS,
  IMAGE_MIME_BY_EXT,
  isBinaryFile
} from '../utils/toolUtils/binaryDetect'
import { BaseTool } from '../services/baseTool'
import {
  resolveProjectConfig,
  assertSandboxRead,
  TOOL_ABORTED,
  type ToolContext
} from '../services/toolContext'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import type { ReadToolDetails } from '../../shared/types/chatMessage'
import { t } from '../i18n'
import { createLogger } from '../logger'
const log = createLogger('Tool:read')

/** 工具返回结果类型别名 */
type ReadResult = AgentToolResult<ReadToolDetails>

/** 检测是否为 HTTP/HTTPS URL */
function isUrl(path: string): boolean {
  return /^https?:\/\//i.test(path)
}

/** URL 抓取超时时间（毫秒） */
const FETCH_TIMEOUT_MS = 30_000

/** URL 响应体最大字节数（5MB） */
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024

/** URL 抓取 User-Agent */
const FETCH_USER_AGENT = 'Mozilla/5.0 (compatible; ShuviX/1.0)'

/** markitdown-ts 支持转换的文件扩展名 */
const RICH_FILE_EXTENSIONS = new Set([
  '.pdf',
  '.docx',
  '.xlsx',
  '.xls',
  '.pptx',
  '.html',
  '.htm',
  '.ipynb',
  '.zip'
])

/** 单张图片返回给模型的字节上限；超过则自动缩放 + JPEG 重编码 */
const MAX_IMAGE_BYTES = 1 * 1024 * 1024

/**
 * 图像压缩阶梯：从保守到激进依次尝试（最大宽度 × JPEG 质量），命中首个 ≤ 上限的即返回。
 * 分辨率足够下探到 800px，质量下探到 55；对截图/文档类图片仍能看清内容。
 */
const IMAGE_COMPRESS_STEPS: ReadonlyArray<{ maxWidth: number; quality: number }> = [
  { maxWidth: 2000, quality: 85 },
  { maxWidth: 1600, quality: 80 },
  { maxWidth: 1200, quality: 75 },
  { maxWidth: 1000, quality: 65 },
  { maxWidth: 800, quality: 55 }
]

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
    description: 'The file path, directory path, or URL (http/https) to read'
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

/** Read 工具类 */
export class ReadTool extends BaseTool<typeof ReadParamsSchema> {
  readonly name = 'read'
  readonly label = t('tool.readLabel')
  readonly description =
    'Read file, directory, or web page contents. For URLs (http/https), fetches the page and converts to Markdown. For text files, returns content with line numbers (supports pagination via offset/limit). For directories, returns a sorted list of entries. Supports PDF, Word, Excel, PowerPoint, HTML, and Jupyter Notebook formats (auto-converted to Markdown). Supports PNG, JPEG, GIF, WebP, BMP images (returned as inline image content for multimodal viewing; images larger than ~1MB are auto-downscaled and re-encoded as JPEG).'
  readonly parameters = ReadParamsSchema
  readonly outputStrategy = 'head' as const
  // 纯文本路径已经按 DEFAULT_MAX_BYTES 控制了原始字节，但行号前缀 + 头/尾元信息会额外
  // 再吃掉约 14KB。把 wrapToolOutput 的阈值抬到 80KB，避免 read 自家输出又被 wrapper 落盘
  // 导致 agent 反复读取持久化文件出现死循环。
  readonly outputMaxBytes = 80 * 1024

  constructor(private ctx: ToolContext) {
    super()
  }

  async preExecute(): Promise<void> {
    /* no-op */
  }

  protected async securityCheck(
    toolCallId: string,
    params: { path: string; offset?: number; limit?: number },
    signal?: AbortSignal
  ): Promise<void> {
    if (signal?.aborted) throw new Error(TOOL_ABORTED)

    // URL 不走文件系统沙箱检查
    if (isUrl(params.path)) return

    const config = resolveProjectConfig(this.ctx.sessionId)
    const absolutePath = resolveReadPath(params.path, config.workingDirectory)

    // 沙箱守卫:工作目录 + 参考目录 + allowList 内直接通过,否则挂起等待用户审批
    await assertSandboxRead(this.ctx, config, toolCallId, 'read', absolutePath, params.path)
  }

  protected async executeInternal(
    _toolCallId: string,
    params: { path: string; offset?: number; limit?: number },
    signal?: AbortSignal
  ): Promise<ReadResult> {
    if (signal?.aborted) throw new Error(TOOL_ABORTED)

    // URL：抓取网页并转换为 Markdown
    if (isUrl(params.path)) {
      try {
        return await readUrl(params.path, signal)
      } catch (err: unknown) {
        if (err instanceof Error && err.message === TOOL_ABORTED) throw err
        const errMsg = err instanceof Error ? err.message : String(err)
        throw new Error(`Failed to fetch URL: ${errMsg}`)
      }
    }

    const config = resolveProjectConfig(this.ctx.sessionId)
    const absolutePath = resolveReadPath(params.path, config.workingDirectory)
    log.info(absolutePath)

    try {
      // 获取文件/目录信息
      const s = await fsStat(absolutePath)

      // 目录：列出条目
      if (s.isDirectory()) {
        return await readDirectory(absolutePath, params)
      }

      const fileStat = { size: s.size, isFile: s.isFile() }
      if (!fileStat.isFile) {
        throw new Error(`Not a file: ${params.path}`)
      }

      if (signal?.aborted) throw new Error(TOOL_ABORTED)

      // 判断是否为富文本文件，使用 markitdown-ts 转换
      const ext = extname(absolutePath).toLowerCase()
      if (RICH_FILE_EXTENSIONS.has(ext)) {
        return await readRichFile(absolutePath, params.path, fileStat.size, signal)
      }

      // 图像文件：以 base64 + mimeType 返回给模型（多模态输入）
      if (ext in IMAGE_MIME_BY_EXT) {
        return await readImage(absolutePath, params.path, fileStat.size, ext)
      }

      // 旧版 Word .doc 文件：使用 word-extractor 提取文字
      if (ext === '.doc') {
        return await readLegacyDoc(absolutePath, params.path, fileStat.size, signal)
      }

      // 已知二进制格式：直接拒绝
      if (KNOWN_BINARY_EXTENSIONS.has(ext)) {
        throw new Error(
          `Unsupported format (${ext}): ${params.path}. Supported: text files, PDF, DOC, DOCX, XLSX, PPTX, HTML, IPYNB.`
        )
      }

      // 检测是否为二进制（只读取前 8KB，不加载整个文件）
      if (await isBinaryFile(absolutePath, fileStat.size)) {
        throw new Error(
          `Unsupported format (${ext || 'binary'}): ${params.path}. Supported: text files, PDF, DOC, DOCX, XLSX, PPTX, HTML, IPYNB.`
        )
      }

      // 纯文本文件：流式逐行读取（自带 offset/limit 分页，不经过 processToolOutput）
      // 注意：持久化的大结果文件（tool_results/*.txt）也走此路径，
      // 因此不会再次触发持久化，避免死循环。
      const result = await readTextFile(absolutePath, params, fileStat)
      // 记录读取时间（用于 edit/write 工具校验文件是否被外部修改）
      recordRead(this.ctx.sessionId, absolutePath)
      return result
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err)
      if (errMsg === TOOL_ABORTED) throw err
      if (
        err instanceof Error &&
        'code' in err &&
        (err as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        // 模糊匹配建议
        const suggestions = suggestSimilarFiles(absolutePath)
        if (suggestions.length > 0) {
          throw new Error(
            `File not found: ${params.path}` +
              '\n\nDid you mean one of these?\n' +
              suggestions.join('\n')
          )
        }
        throw new Error(`File not found: ${params.path}`)
      }
      throw new Error(`Failed: ${errMsg}`)
    }
  }
}

/**
 * 目录读取：列出条目（目录加 / 后缀），排序，支持 offset/limit 分页
 */
async function readDirectory(
  absolutePath: string,
  params: { path: string; offset?: number; limit?: number }
): Promise<ReadResult> {
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

  let text = `Directory: ${params.path} (${total} entries)\n`
  if (params.offset || params.limit) {
    text += `Showing: entries ${offset}-${offset + shown - 1}\n`
  }
  text += '\n' + sliced.join('\n')
  text +=
    '\n\n' +
    (truncated
      ? `(Showing ${shown} of ${total} entries. Use offset=${endIndex + 1} to continue.)`
      : `(${total} entries)`)

  return {
    content: [{ type: 'text' as const, text }],
    details: {
      type: 'read',
      totalEntries: total,
      truncated
    }
  }
}

/**
 * 富文本文件：通过 markitdown-ts 转换为 Markdown
 * 输出长度的截断/落盘由 wrapToolOutput 在构建工具时统一处理
 */
async function readRichFile(
  absolutePath: string,
  displayPath: string,
  fileSize: number,
  signal?: AbortSignal
): Promise<ReadResult> {
  if (signal?.aborted) throw new Error(TOOL_ABORTED)

  const md = getMarkItDown()
  const result = await md.convert(absolutePath)
  if (!result || !result.markdown) {
    throw new Error(`Failed to convert: ${displayPath}`)
  }

  const ext = extname(absolutePath).toLowerCase().slice(1).toUpperCase()
  const header = `File: ${displayPath} (${ext}, ${formatSize(fileSize)}) — converted to Markdown\n\n`

  return {
    content: [{ type: 'text' as const, text: header + result.markdown }],
    details: {
      type: 'read',
      fileSize,
      format: ext,
      converted: true,
      truncated: false
    }
  }
}

/**
 * 图像文件：以 base64 + mimeType 返回，供多模态模型直接查看
 * - ≤ MAX_IMAGE_BYTES：按原格式直出
 * - > MAX_IMAGE_BYTES：用 Electron nativeImage 按阶梯缩放 + 重编码为 JPEG，直到落在上限内
 * - 典型来源：browser 工具的 screenshot action 落盘产物
 */
async function readImage(
  absolutePath: string,
  displayPath: string,
  fileSize: number,
  ext: string
): Promise<ReadResult> {
  const buffer = await readFile(absolutePath)
  const format = ext.slice(1).toUpperCase()

  // 未超限：直出原图
  if (fileSize <= MAX_IMAGE_BYTES) {
    const mimeType = IMAGE_MIME_BY_EXT[ext] ?? 'image/png'
    return {
      content: [
        { type: 'image' as const, data: buffer.toString('base64'), mimeType },
        {
          type: 'text' as const,
          text: `Image: ${displayPath} (${format}, ${formatSize(fileSize)})`
        }
      ],
      details: { type: 'read', fileSize, format, truncated: false }
    }
  }

  // 超限：用 nativeImage 解码 → 阶梯式压缩
  const img = nativeImage.createFromBuffer(buffer)
  if (img.isEmpty()) {
    throw new Error(
      `Image too large (${formatSize(fileSize)}) and cannot be decoded for compression: ${displayPath}`
    )
  }
  const { width: origW, height: origH } = img.getSize()

  for (const step of IMAGE_COMPRESS_STEPS) {
    const targetWidth = Math.min(origW, step.maxWidth)
    const working = targetWidth < origW ? img.resize({ width: targetWidth, quality: 'good' }) : img
    const jpeg = working.toJPEG(step.quality)
    if (jpeg.length <= MAX_IMAGE_BYTES) {
      const { width: newW, height: newH } = working.getSize()
      const note =
        `Auto-compressed from ${format} ${origW}×${origH} ${formatSize(fileSize)} → ` +
        `JPEG ${newW}×${newH} ${formatSize(jpeg.length)} (quality ${step.quality})`
      log.info(`readImage: ${displayPath} — ${note}`)
      return {
        content: [
          { type: 'image' as const, data: jpeg.toString('base64'), mimeType: 'image/jpeg' },
          {
            type: 'text' as const,
            text: `Image: ${displayPath}\n${note}`
          }
        ],
        details: { type: 'read', fileSize: jpeg.length, format: 'JPEG', truncated: true }
      }
    }
  }

  // 阶梯走完仍 > 1MB —— 极端罕见（巨图 + 大量纯色块抗压）
  throw new Error(
    `Image too large to compress under ${formatSize(MAX_IMAGE_BYTES)}: ${displayPath} ` +
      `(${formatSize(fileSize)}, ${origW}×${origH}). Re-capture with a narrower viewport or target a single element (browser devtools_action="snapshot" + uid).`
  )
}

/**
 * 旧版 Word .doc 文件：通过 word-extractor 提取纯文本
 * 输出长度的截断/落盘由 wrapToolOutput 在构建工具时统一处理
 */
async function readLegacyDoc(
  absolutePath: string,
  displayPath: string,
  fileSize: number,
  signal?: AbortSignal
): Promise<ReadResult> {
  if (signal?.aborted) throw new Error(TOOL_ABORTED)

  const extractor = getWordExtractor()
  const doc = await extractor.extract(absolutePath)
  const body = doc.getBody()?.trim()
  if (!body) {
    throw new Error(`Failed to convert: ${displayPath}`)
  }

  const header = `File: ${displayPath} (DOC, ${formatSize(fileSize)}) — converted to Markdown\n\n`

  return {
    content: [{ type: 'text' as const, text: header + body }],
    details: {
      type: 'read',
      fileSize,
      format: 'DOC',
      converted: true,
      truncated: false
    }
  }
}

/**
 * URL 抓取：通过 markitdown-ts 抓取网页并转换为 Markdown
 * 自定义 fetch 实现超时、User-Agent、响应体大小限制
 */
async function readUrl(url: string, signal?: AbortSignal): Promise<ReadResult> {
  if (signal?.aborted) throw new Error(TOOL_ABORTED)

  log.info(`Fetching URL: ${url}`)

  const customFetch: typeof globalThis.fetch = async (input, init) => {
    const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS)
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal

    const response = await globalThis.fetch(input, {
      ...init,
      signal: combinedSignal,
      headers: {
        'User-Agent': FETCH_USER_AGENT,
        ...((init?.headers as Record<string, string>) || {})
      }
    })

    // 检查 Content-Length（如果存在）
    const contentLength = response.headers.get('content-length')
    if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_BYTES) {
      throw new Error(
        `Response too large (${formatSize(parseInt(contentLength, 10))}). ` +
          `Maximum allowed: ${formatSize(MAX_RESPONSE_BYTES)}.`
      )
    }

    return response
  }

  const md = getMarkItDown()
  const result = await md.convert(url, { fetch: customFetch })
  if (!result || !result.markdown) {
    throw new Error(`Failed to fetch or convert URL: ${url}`)
  }

  const title = result.title ? ` — ${result.title}` : ''
  const header = `URL: ${url}${title} — converted to Markdown\n\n`

  return {
    content: [{ type: 'text' as const, text: header + result.markdown }],
    details: {
      type: 'read',
      format: 'URL',
      converted: true,
      truncated: false,
      url
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
): Promise<ReadResult> {
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
  const header = `File: ${params.path} (${totalLines} lines, ${formatSize(fileStat.size)})`
  if (params.offset || params.limit) {
    text = `${header}\nShowing: lines ${offset}-${lastReadLine}\n\n${text}`
  } else {
    text = `${header}\n\n${text}`
  }

  return {
    content: [{ type: 'text' as const, text }],
    details: {
      type: 'read',
      totalLines,
      fileSize: fileStat.size,
      truncated
    }
  }
}

import { registerBuiltinTool } from '../services/toolRegistry'
registerBuiltinTool({
  name: 'read',
  group: 'general',
  defaultEnabled: true,
  getLabel: () => t('tool.readLabel'),
  getHint: () => t('tool.readHint'),
  factory: (ctx) => new ReadTool(ctx),
  presentation: {
    icon: 'FileText',
    summaryField: 'path'
  }
})
