/**
 * Read 工具 — 读取文件内容 / 抓取网页
 * 从 pi-coding-agent 移植，支持分页读取、行号、截断
 * 支持通过 markitdown-ts 将 PDF/Office/HTML 等富文本格式转换为 Markdown
 * 支持通过 word-extractor 提取旧版 .doc 文件文字
 * 支持通过 markitdown-ts 抓取 URL 并转换为 Markdown
 */

import { readFile } from 'fs/promises'
import { extname } from 'path'
import { nativeImage } from 'electron'
import { MarkItDown } from 'markitdown-ts'
import WordExtractor from 'word-extractor'
import { createFileToolSuite, type ReadDecoders } from '@shuvix/agent-runtime'
import { BUILTIN_TOOL_PRESENTATIONS } from '@shuvix/chat-protocol/builtinToolPresentations'
import { formatSize } from '../../shared/node/truncate'
import { suggestSimilarFiles } from '../utils/toolUtils/pathUtils'
import {
  KNOWN_BINARY_EXTENSIONS,
  IMAGE_MIME_BY_EXT,
  isBinaryFile
} from '../utils/toolUtils/binaryDetect'
import { TOOL_ABORTED, type ToolContext } from '../services/toolContext'
import { makeDesktopFileToolDeps } from './fileToolDeps'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import type { ReadToolDetails } from '@shuvix/chat-protocol/types/chatMessage'
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
 * 桌面 read 内容解码器 —— 把上面这些 Node/Electron 实现注入共享 createFileToolSuite 的 read 分派。
 * 富文档(markitdown) / 图片(nativeImage) / .doc(word-extractor) / URL(markitdown) / 二进制嗅探 /
 * 不存在时的相似路径建议,都是桌面平台叶子。
 */
const readDecoders: ReadDecoders = {
  isUrl,
  readUrl,
  imageMimeByExt: IMAGE_MIME_BY_EXT,
  readImage: (portPath, displayPath, ext, fileSize) =>
    readImage(portPath, displayPath, fileSize, ext),
  richExtensions: RICH_FILE_EXTENSIONS,
  readRich: readRichFile,
  readLegacyDoc,
  knownBinaryExtensions: KNOWN_BINARY_EXTENSIONS,
  isBinary: isBinaryFile,
  suggestSimilar: suggestSimilarFiles
}

/** 构建桌面 read 工具实例（共享套件 + 桌面 deps + 桌面解码器） */
export const makeReadTool = (ctx: ToolContext): ReturnType<typeof createFileToolSuite>['read'] =>
  createFileToolSuite(makeDesktopFileToolDeps(ctx, readDecoders)).read

import { registerBuiltinTool } from '../services/toolRegistry'
registerBuiltinTool({
  name: 'read',
  group: 'general',
  defaultEnabled: true,
  getLabel: () => t(BUILTIN_TOOL_PRESENTATIONS.read.labelKey),
  getHint: () => t('tool.readHint'),
  factory: (ctx) => makeReadTool(ctx),
  presentation: BUILTIN_TOOL_PRESENTATIONS.read.presentation
})
