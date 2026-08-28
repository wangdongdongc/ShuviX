/**
 * Read 工具 — 读取文件内容 / 抓取网页
 * 从 pi-coding-agent 移植，支持分页读取、行号、截断
 * 支持通过 markitdown-ts 将 PDF/Office/HTML 等富文本格式转换为 Markdown
 * 支持通过 word-extractor 提取旧版 .doc 文件文字
 * 支持通过 markitdown-ts 抓取 URL 并转换为 Markdown
 */

import { readFile, writeFile, mkdir } from 'fs/promises'
import { extname, join } from 'path'
import { nativeImage } from 'electron'
import { MarkItDown } from 'markitdown-ts'
import WordExtractor from 'word-extractor'
import { createFileToolSuite, parseImagePixelSize, type ReadDecoders } from '@shuvix/agent-runtime'
import { BUILTIN_TOOL_PRESENTATIONS } from '@shuvix/chat-protocol/builtinToolPresentations'
import { formatSize } from '../../shared/node/truncate'
import { suggestSimilarFiles } from '../utils/toolUtils/pathUtils'
import { getToolResultsDir } from '../utils/paths'
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

/**
 * 模型侧宽度上限 —— 本文件真正的 token 旋钮。
 *
 * 图像 token ≈ 宽 × 高 / 750，**只由像素数决定**：JPEG 质量、PNG 压缩率、文件字节数
 * 一概不影响。所以「按字节决定要不要缩」是在优化错的变量：把 quality 从 85 压到 55
 * 能省下大半字节，省下的 token 是 0；而一张 1440×900 的截图通常不到 1MB，字节闸门
 * 根本不会触发，它就原样进了上下文。
 *
 * 为什么卡宽度而不是面积：**宽度决定字号**。一张 2428×3484 的整页截图，按面积预算
 * 会被压到 646 宽（原图的 26.6%，约 CSS 尺寸的一半），正文小字直接糊掉；而同样一张
 * 图按宽度卡到 1024，字还认得出。面积预算对横图和竖图的可读性完全不等价，纵向图
 * 越长被压得越狠 —— 恰恰是内容最多、最该看清的那一类。
 *
 * 1024 是可读性下限：常见 UI 截图多是 deviceScaleFactor 2 下 1200~1600 CSS px 的视口，
 * 缩到 1024 相当于 CSS 尺寸的 64%~85%，13px 的标签还剩 8~11px，勉强能认。再往下就是
 * 上面那张 646 的下场。
 */
const MAX_IMAGE_WIDTH = 1024

/**
 * 上游自己的 cap：长边 >1568px 或面积 >~1.15MP 的图，服务端会先缩到约 1600 tokens
 * 再计费。这意味着「不缩」的代价封顶在 ~1600 tokens/张，而不是按原始分辨率线性增长 ——
 * 算省了多少必须先过这道 cap，否则会把一张 8MP 图算成 11000 tokens 的虚高收益。
 */
const PROVIDER_MAX_LONG_EDGE = 1568
const PROVIDER_MAX_PIXELS = 1_150_000

/**
 * 省不到这个比例就不缩。
 *
 * 关键推论：既然上游封顶 ~1600 tokens，一张超大纵向图缩到 1024 宽之后**仍然**在 cap
 * 之上，token 一个没省，白白多做一次重采样把画质做差。这种情况直接原样透传 —— 同样
 * 的 token、更好的画质、还省掉一次解码。整页长截图真正的解法是别截整页（截视口或
 * 单个元素），不是把它压小。
 */
const MIN_TOKEN_SAVING_RATIO = 0.15

/**
 * 单张图片返回给模型的字节上限 —— 传输/服务端体积的兜底，**不是** token 闸门。
 * 只有像素已经达标、字节仍然超线的图（噪声大、抗压）才轮到质量阶梯出场。
 */
const MAX_IMAGE_BYTES = 1 * 1024 * 1024

/** 字节兜底用的 JPEG 质量阶梯（只影响字节数，不影响 token 数） */
const JPEG_QUALITY_STEPS: readonly number[] = [85, 75, 65, 55]

/** 质量降到底仍超字节上限时，再叠加的降采样系数 */
const EXTRA_DOWNSCALE_STEPS: readonly number[] = [0.75, 0.5]

/** 裸公式：图像 token ≈ 宽×高/750 */
function rawImageTokens(width: number, height: number): number {
  return Math.ceil((width * height) / 750)
}

/** 过一遍上游 cap 之后这张图实际值多少 token —— 比较收益只能用这个 */
function effectiveImageTokens(width: number, height: number): number {
  const scale = Math.min(
    1,
    PROVIDER_MAX_LONG_EDGE / Math.max(width, height),
    Math.sqrt(PROVIDER_MAX_PIXELS / (width * height))
  )
  if (scale >= 1) return rawImageTokens(width, height)
  return rawImageTokens(Math.round(width * scale), Math.round(height * scale))
}

/**
 * 定缩放方案：返回目标尺寸，或 null 表示「别缩」。
 *
 * null 有两种来源，含义不同但结论一样 —— 原图本来就没超宽；或者缩了也省不下 token
 * （见 MIN_TOKEN_SAVING_RATIO），那就别拿画质换空气。
 */
function planDownscale(width: number, height: number): { width: number; height: number } | null {
  if (width <= 0 || height <= 0) return null
  const targetWidth = Math.min(width, MAX_IMAGE_WIDTH)
  if (targetWidth >= width) return null
  // 高度按 resize 的实际行为（只给宽度、等比推高度）算，与后续 getSize() 对得上
  const targetHeight = Math.max(1, Math.round((height * targetWidth) / width))
  const before = effectiveImageTokens(width, height)
  const after = effectiveImageTokens(targetWidth, targetHeight)
  if (after > before * (1 - MIN_TOKEN_SAVING_RATIO)) return null
  return { width: targetWidth, height: targetHeight }
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

/** 派生图文件名去重计数器 —— 同一毫秒内的两次压缩读不该抢同一个文件名 */
let derivedImageSeq = 0

/**
 * 把「模型实际收到的那一份」派生图落盘，返回路径（失败返回 undefined）。
 *
 * 只有压缩分支需要：原图在磁盘上，缩放重编码后的这份只存在于内存里，不写出来
 * UI 就没法展示模型真正看到的画质。写进会话的 tool_results 目录，删会话时随目录
 * 一起清理（sessionService）。落盘失败不影响这次 read —— 模型该看的图已经在
 * content 里了，缺的只是 UI 内联展示。
 */
async function persistModelImage(sessionId: string, jpeg: Buffer): Promise<string | undefined> {
  if (!sessionId) return undefined
  try {
    const dir = getToolResultsDir(sessionId)
    await mkdir(dir, { recursive: true })
    const filePath = join(dir, `read-image-${Date.now()}-${derivedImageSeq++}.jpg`)
    await writeFile(filePath, jpeg)
    return filePath
  } catch (err) {
    log.warn(
      `readImage: persist derived image failed — ${err instanceof Error ? err.message : String(err)}`
    )
    return undefined
  }
}

/**
 * 图像文件：以 base64 + mimeType 返回，供多模态模型直接查看
 * - 宽度达标且字节 ≤ 上限：按原格式直出（与磁盘逐字节同源）
 * - 否则：用 Electron nativeImage 解码 → 等比缩到目标宽度 → 重编码为 JPEG；
 *   字节仍超限就依次降质量，再不行叠加降采样
 * - 典型来源：browser 工具的 screenshot action 落盘产物
 *
 * 给模型的文本只留「这是张什么图、被缩过没有」——原始字节数、JPEG 质量、省了多少
 * token 这些都是运维数字，模型拿它做不了任何决策，进上下文纯属噪声。完整账目落在
 * log 与 details 里（details 供 UI 展示）。
 *
 * 两条分支都在 details.image 里留下「模型收到的那一份」的磁盘路径，供 UI 内联展示：
 * 直出分支指原文件（逐字节同源），压缩分支指落盘的派生 JPEG —— 指回原文件的话，
 * 用户点开会看到比模型更清楚的图（见 ToolResultImage 契约）。
 */
async function readImage(
  absolutePath: string,
  displayPath: string,
  fileSize: number,
  ext: string,
  sessionId: string
): Promise<ReadResult> {
  const buffer = await readFile(absolutePath)
  const format = ext.slice(1).toUpperCase()
  const pixelSize = parseImagePixelSize(buffer)

  /** 直出原图：模型收到的就是这个文件的字节，UI 直接指它 */
  const directOutput = (hint = ''): ReadResult => {
    const mimeType = IMAGE_MIME_BY_EXT[ext] ?? 'image/png'
    const dims = pixelSize ? ` ${pixelSize.width}×${pixelSize.height}` : ''
    return {
      content: [
        { type: 'image' as const, data: buffer.toString('base64'), mimeType },
        { type: 'text' as const, text: `Image: ${displayPath} (${format}${dims})${hint}` }
      ],
      details: {
        type: 'read',
        fileSize,
        format,
        truncated: false,
        image: { path: absolutePath, bytes: fileSize, ...(pixelSize ?? {}) }
      }
    }
  }

  // 要重编码的两个理由互相独立：宽度超上限（费 token）、字节超上限（费带宽）。
  // 文件头解析不出宽高时只能靠字节判断 —— 真截图一定解析得出，这是边角情况。
  const plan = pixelSize ? planDownscale(pixelSize.width, pixelSize.height) : null
  if (!plan && fileSize <= MAX_IMAGE_BYTES) {
    // 想缩但缩了也省不下 token 的那一类（超长整页截图）：上游 cap 会把宽度压到
    // 可读下限以下，缩不缩都一样糊。这句提示是**可操作**的 —— 告诉模型别再截整页，
    // 换视口或单个元素。跟被砍掉的那些运维数字不同，它能改变下一步动作。
    const capped =
      pixelSize && pixelSize.width > MAX_IMAGE_WIDTH
        ? ' — full-page capture, downscaled by the model provider; text may be unreadable.' +
          ' Capture the viewport or a single element if you need to read it.'
        : ''
    return directOutput(capped)
  }

  // 超限：用 nativeImage 解码 → 缩放 + 重编码
  const img = nativeImage.createFromBuffer(buffer)
  if (img.isEmpty()) {
    // 头能解析、内容解不了码（IDAT 损坏之类）：字节没超线就照原样给模型，
    // 多花点 token 也好过整个 read 失败。
    if (fileSize <= MAX_IMAGE_BYTES) {
      log.warn(`readImage: ${displayPath} — decode failed, passing original bytes through`)
      return directOutput()
    }
    throw new Error(
      `Image too large (${formatSize(fileSize)}) and cannot be decoded for compression: ${displayPath}`
    )
  }
  const { width: origW, height: origH } = img.getSize()

  // 文件头没解析出宽高时 plan 是 null（这里只可能是字节超限进来的），退回用解码后的
  // 真实尺寸重算一次，别让一张 8000px 宽的图因为头坏了就躲过宽度闸门。
  const baseWidth = (plan ?? planDownscale(origW, origH))?.width ?? origW

  for (const factor of [1, ...EXTRA_DOWNSCALE_STEPS]) {
    const targetWidth = Math.max(1, Math.round(baseWidth * factor))
    const working = targetWidth < origW ? img.resize({ width: targetWidth, quality: 'good' }) : img
    for (const quality of JPEG_QUALITY_STEPS) {
      const jpeg = working.toJPEG(quality)
      if (jpeg.length > MAX_IMAGE_BYTES) continue

      const { width: newW, height: newH } = working.getSize()
      const resized = newW !== origW || newH !== origH
      // 完整账目只进 log —— 收益按上游 cap 之后算，否则会把 8MP 图算出虚高的省量
      log.info(
        `readImage: ${displayPath} — ${format} ${origW}×${origH} ${formatSize(fileSize)} → ` +
          `JPEG ${newW}×${newH} ${formatSize(jpeg.length)} (quality ${quality}), ` +
          `~${effectiveImageTokens(origW, origH)} → ~${effectiveImageTokens(newW, newH)} tokens`
      )
      // 这份重编码结果磁盘上没有第二份拷贝：不落盘，UI 就只能拿原图凑合
      const derivedPath = await persistModelImage(sessionId, jpeg)
      return {
        content: [
          { type: 'image' as const, data: jpeg.toString('base64'), mimeType: 'image/jpeg' },
          {
            type: 'text' as const,
            text:
              `Image: ${displayPath} (JPEG ${newW}×${newH}` +
              (resized ? `, downscaled from ${origW}×${origH})` : ')')
          }
        ],
        details: {
          type: 'read',
          fileSize: jpeg.length,
          format: 'JPEG',
          truncated: true,
          ...(derivedPath
            ? { image: { path: derivedPath, width: newW, height: newH, bytes: jpeg.length } }
            : {})
        }
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
 * 按 ctx 构造（不是模块级常量）：图片压缩分支要把派生图落到该会话的 tool_results 目录。
 * 富文档(markitdown) / 图片(nativeImage) / .doc(word-extractor) / URL(markitdown) / 二进制嗅探 /
 * 不存在时的相似路径建议,都是桌面平台叶子。
 */
const makeReadDecoders = (ctx: ToolContext): ReadDecoders => ({
  isUrl,
  readUrl,
  imageMimeByExt: IMAGE_MIME_BY_EXT,
  readImage: (portPath, displayPath, ext, fileSize) =>
    readImage(portPath, displayPath, fileSize, ext, ctx.sessionId),
  richExtensions: RICH_FILE_EXTENSIONS,
  readRich: readRichFile,
  readLegacyDoc,
  knownBinaryExtensions: KNOWN_BINARY_EXTENSIONS,
  isBinary: isBinaryFile,
  suggestSimilar: suggestSimilarFiles
})

/** 构建桌面 read 工具实例（共享套件 + 桌面 deps + 桌面解码器） */
export const makeReadTool = (ctx: ToolContext): ReturnType<typeof createFileToolSuite>['read'] =>
  createFileToolSuite(makeDesktopFileToolDeps(ctx, makeReadDecoders(ctx))).read

import { registerBuiltinTool } from '../services/toolRegistry'
import { ReadParamsSchema } from '@shuvix/agent-runtime'
import { READ_DESCRIPTION } from './fileToolDeps'
registerBuiltinTool({
  name: 'read',
  group: 'general',
  getLabel: () => t(BUILTIN_TOOL_PRESENTATIONS.read.labelKey),
  getHint: () => t('tool.readHint'),
  factory: (ctx) => makeReadTool(ctx),
  presentation: BUILTIN_TOOL_PRESENTATIONS.read.presentation,
  describe: () => ({ description: READ_DESCRIPTION, parameters: ReadParamsSchema })
})
