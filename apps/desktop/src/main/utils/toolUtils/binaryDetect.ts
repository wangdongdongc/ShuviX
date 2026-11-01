/**
 * 二进制 / 图像扩展名识别 + 有限采样的文本编码与混合内容嗅探
 * 提取自 src/main/tools/read.ts，扩展名映射也供 filePreviewService 共享
 */

import { open as fsOpen } from 'fs/promises'
import { analyse } from 'chardet'
import iconv from 'iconv-lite'
import type { ReadTextDetection } from '@shuvix/agent-runtime'
import {
  isDisallowedControlCodePoint,
  nodeFileSystemPort,
  readDecodedTextLines
} from './nodeFileSystemPort'

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

// 文本检测只看有限前缀；正文随后从文件头流式解码，不为嗅探整读大文件。
const TEXT_SAMPLE_MAX_BYTES = 64 * 1024
// 解码后不允许的控制字符 ≤5% 视为混合文本并转义；更高比例仍按二进制拒绝。
const MAX_MIXED_CONTROL_RATIO = 0.05
// 严格 UTF-8 失败后，仅少量 U+FFFD（≤2%）可按混合 UTF-8 读取，否则交给 chardet。
const MAX_MIXED_REPLACEMENT_RATIO = 0.02
// chardet 的置信度为 0–100；低置信度不乱猜编码。
const MIN_CHARDET_CONFIDENCE = 20
// 无 BOM UTF-16：一侧字节应有显著 NUL 分布，另一侧应很少，避免只凭零星 NUL 猜测。
const UTF16_MIN_SKEWED_NUL_RATIO = 0.2
const UTF16_MAX_OPPOSITE_NUL_RATIO = 0.05
const UTF16_MIN_NUL_SKEW_FACTOR = 4

interface DecodedTextQuality {
  controlCount: number
  replacementCount: number
  controlRatio: number
  replacementRatio: number
}

function inspectDecodedText(text: string): DecodedTextQuality {
  let controlCount = 0
  let replacementCount = 0
  for (const char of text) {
    const cp = char.codePointAt(0)!
    if (isDisallowedControlCodePoint(cp)) controlCount++
    if (cp === 0xfffd) replacementCount++
  }
  const length = Math.max(1, text.length)
  return {
    controlCount,
    replacementCount,
    controlRatio: controlCount / length,
    replacementRatio: replacementCount / length
  }
}

function decodeNativeSample(
  sample: Buffer,
  encoding: string,
  isPrefix: boolean,
  fatal: boolean
): string {
  // stream=true 保留采样末尾未完整的多字节序列，不把 chunk 边界误判为非法字节
  return new TextDecoder(encoding, { fatal }).decode(sample, { stream: isPrefix })
}

function decodeLegacySample(sample: Buffer, encoding: string, isPrefix: boolean): string {
  const decoder = iconv.getDecoder(encoding)
  const text = decoder.write(sample)
  return text + (isPrefix ? '' : (decoder.end() ?? ''))
}

function textPlan(
  filepath: string,
  encoding: string,
  quality: DecodedTextQuality,
  options: {
    alwaysShowEncoding?: boolean
    checkReplacements?: boolean
    useOriginalUtf8Stream?: boolean
  } = {}
): ReadTextDetection {
  if (quality.controlRatio > MAX_MIXED_CONTROL_RATIO) return { kind: 'binary' }
  if (options.checkReplacements && quality.replacementRatio > MAX_MIXED_REPLACEMENT_RATIO) {
    return { kind: 'binary' }
  }

  const escapedControlChars = quality.controlCount > 0
  const replacedInvalid = options.checkReplacements && quality.replacementCount > 0
  const notes: string[] = []
  if (options.alwaysShowEncoding || escapedControlChars || replacedInvalid) notes.push(encoding)
  if (escapedControlChars || replacedInvalid) {
    const repairs: string[] = []
    if (replacedInvalid) repairs.push('invalid sequences replaced with U+FFFD')
    if (escapedControlChars) repairs.push('control characters escaped')
    notes.push(`mixed text (${repairs.join('; ')})`)
  }

  return {
    kind: 'text',
    encoding,
    ...(notes.length > 0 ? { headerNote: notes.join('; ') } : {}),
    ...(escapedControlChars ? { escapedControlChars: true } : {}),
    readLines: () =>
      options.useOriginalUtf8Stream && !escapedControlChars
        ? nodeFileSystemPort.readTextLines(filepath)
        : readDecodedTextLines(filepath, encoding, escapedControlChars)
  }
}

/** BOM 优先；UTF-16 必须先于普通控制字符统计特判，其原始字节天然含大量 NUL */
function bomEncoding(sample: Buffer): string | null {
  if (sample.length >= 3 && sample[0] === 0xef && sample[1] === 0xbb && sample[2] === 0xbf) {
    return 'UTF-8'
  }
  if (sample.length >= 2 && sample[0] === 0xff && sample[1] === 0xfe) return 'UTF-16LE'
  if (sample.length >= 2 && sample[0] === 0xfe && sample[1] === 0xff) return 'UTF-16BE'
  return null
}

function utf16EncodingFromNulDistribution(sample: Buffer): 'UTF-16LE' | 'UTF-16BE' | null {
  const pairs = Math.floor(sample.length / 2)
  if (pairs === 0) return null
  let evenNuls = 0
  let oddNuls = 0
  for (let i = 0; i < pairs * 2; i++) {
    if (sample[i] !== 0) continue
    if (i % 2 === 0) evenNuls++
    else oddNuls++
  }
  const evenRatio = evenNuls / pairs
  const oddRatio = oddNuls / pairs
  if (
    oddRatio >= UTF16_MIN_SKEWED_NUL_RATIO &&
    evenRatio <= UTF16_MAX_OPPOSITE_NUL_RATIO &&
    oddRatio >= evenRatio * UTF16_MIN_NUL_SKEW_FACTOR
  ) {
    return 'UTF-16LE'
  }
  if (
    evenRatio >= UTF16_MIN_SKEWED_NUL_RATIO &&
    oddRatio <= UTF16_MAX_OPPOSITE_NUL_RATIO &&
    evenRatio >= oddRatio * UTF16_MIN_NUL_SKEW_FACTOR
  ) {
    return 'UTF-16BE'
  }
  return null
}

const TEXTUAL_UNICODE_CHAR = /[\p{L}\p{N}\p{M}\p{P}\p{S}]/u
const UNLIKELY_UNICODE_CHAR = /[\p{Cn}\p{Co}\p{Cs}]/u

/**
 * 无 BOM 且 NUL 分布不典型时，比较两个端序的严格解码结果。
 * 常见文字/空白/换行提高可信度，未分配与私用码位降低可信度；同分不乱猜。
 */
function utf16TextScore(text: string): number {
  let score = 0
  let length = 0
  for (const char of text) {
    length++
    const cp = char.codePointAt(0)!
    if (cp === 0x0a || cp === 0x0d) score += 8
    else if (cp === 0x09 || cp === 0x20) score += 2
    else if (
      (cp >= 0x3400 && cp <= 0x9fff) ||
      (cp >= 0xac00 && cp <= 0xd7af) ||
      (cp >= 0x3040 && cp <= 0x30ff)
    ) {
      score += 2
    } else if (TEXTUAL_UNICODE_CHAR.test(char)) score += 1
    else if (UNLIKELY_UNICODE_CHAR.test(char)) score -= 4
  }
  return length > 0 ? score / length : Number.NEGATIVE_INFINITY
}

function fallbackUtf16TextPlan(
  filepath: string,
  sample: Buffer,
  isPrefix: boolean
): ReadTextDetection | null {
  const candidates: Array<{ score: number; plan: ReadTextDetection }> = []
  for (const encoding of ['UTF-16LE', 'UTF-16BE'] as const) {
    try {
      const text = decodeNativeSample(sample, encoding, isPrefix, true)
      const plan = textPlan(filepath, encoding, inspectDecodedText(text), {
        alwaysShowEncoding: true
      })
      if (plan.kind !== 'text') continue
      // 大量 GBK 等字节在错误端序下会变成私用区/未分配码位；这不是可信文本证据
      if (UNLIKELY_UNICODE_CHAR.test(text)) continue
      const score = utf16TextScore(text)
      if (score > 0) candidates.push({ score, plan })
    } catch {
      // 非法 surrogate 等严格解码失败的端序不是候选
    }
  }
  candidates.sort((a, b) => b.score - a.score)
  if (candidates.length === 0) return null
  if (candidates.length > 1 && candidates[0].score === candidates[1].score) return null
  return candidates[0].plan
}

async function readSample(filepath: string, fileSize: number): Promise<Buffer> {
  const fh = await fsOpen(filepath, 'r')
  try {
    const sample = Buffer.alloc(Math.min(TEXT_SAMPLE_MAX_BYTES, fileSize))
    const { bytesRead } = await fh.read(sample, 0, sample.length, 0)
    return sample.subarray(0, bytesRead)
  } finally {
    await fh.close()
  }
}

/** 有限采样判定文本/二进制，并给共享 read 一个流式解码计划 */
export async function detectTextFile(
  filepath: string,
  fileSize: number
): Promise<ReadTextDetection> {
  if (fileSize === 0) {
    return textPlan(filepath, 'UTF-8', inspectDecodedText(''), { useOriginalUtf8Stream: true })
  }
  const sample = await readSample(filepath, fileSize)
  const isPrefix = sample.length < fileSize

  const bom = bomEncoding(sample)
  if (bom) {
    const quality = inspectDecodedText(decodeNativeSample(sample, bom, isPrefix, false))
    return textPlan(filepath, bom, quality, {
      alwaysShowEncoding: bom !== 'UTF-8',
      checkReplacements: true
    })
  }

  const utf16 = utf16EncodingFromNulDistribution(sample)
  if (utf16) {
    try {
      const quality = inspectDecodedText(decodeNativeSample(sample, utf16, isPrefix, true))
      return textPlan(filepath, utf16, quality, { alwaysShowEncoding: true })
    } catch {
      // 强 NUL 分布只是候选；非法 surrogate 等解码失败时继续后续判定
    }
  }

  try {
    const quality = inspectDecodedText(decodeNativeSample(sample, 'UTF-8', isPrefix, true))
    return textPlan(filepath, 'UTF-8', quality, { useOriginalUtf8Stream: true })
  } catch {
    // CJK/emoji 为主的 UTF-16 可能没有典型 NUL 偏斜；严格 UTF-8 失败后比较两个端序
  }

  const fallbackUtf16 = fallbackUtf16TextPlan(filepath, sample, isPrefix)
  if (fallbackUtf16) return fallbackUtf16

  const utf8Quality = inspectDecodedText(decodeNativeSample(sample, 'UTF-8', isPrefix, false))
  if (utf8Quality.replacementRatio <= MAX_MIXED_REPLACEMENT_RATIO) {
    return textPlan(filepath, 'UTF-8', utf8Quality, { checkReplacements: true })
  }

  for (const candidate of analyse(sample)) {
    if (candidate.confidence < MIN_CHARDET_CONFIDENCE) break
    if (!iconv.encodingExists(candidate.name)) continue
    try {
      const quality = inspectDecodedText(decodeLegacySample(sample, candidate.name, isPrefix))
      const plan = textPlan(filepath, candidate.name, quality, {
        alwaysShowEncoding: true,
        checkReplacements: true
      })
      if (plan.kind === 'text') return plan
    } catch {
      // 候选解码失败则尝试下一个高置信度候选；都不合适就拒绝
    }
  }
  return { kind: 'binary' }
}
