/**
 * 共享 read 内核 —— 纯文本流式读取（行号/分页/单行截断/字节上限）+ 目录列表。
 * 从桌面 read.ts 的 readTextFile / readDirectory 逐字搬出，fs → 注入的 FileSystemPort。
 * （富文本转换 / 图片 / URL / 二进制探测等分支仍由各宿主在外层编排。）
 */
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import type { ReadToolDetails } from '@shuvix/chat-protocol/types/chatMessage'
import type { FileSystemPort } from './port'
import { truncateLine, formatSize, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES } from './truncate'

type ReadResult = AgentToolResult<ReadToolDetails>

const encoder = new TextEncoder()
const byteLen = (s: string): number => encoder.encode(s).length

export interface ReadTextParams {
  /** 展示用路径（行首信息/提示里用） */
  path: string
  offset?: number
  limit?: number
}

/**
 * 纯文本：按行流式读取（行号、分页、单行截断、字节上限）。
 * readPath 交给 port 解释；displayPath（params.path）用于输出文案。
 */
export async function readTextContent(
  port: FileSystemPort,
  readPath: string,
  params: ReadTextParams,
  fileSize: number
): Promise<ReadResult> {
  const limit = params.limit ?? DEFAULT_MAX_LINES
  const offset = params.offset ?? 1
  const start = offset - 1
  const raw: string[] = []
  let bytes = 0
  let lines = 0
  let truncatedByBytes = false
  let hasMoreLines = false

  for await (const text of port.readTextLines(readPath)) {
    lines += 1
    if (lines <= start) continue

    if (raw.length >= limit) {
      hasMoreLines = true
      continue
    }

    // 单行截断（minified JS/CSS 等场景）
    const line = truncateLine(text)
    const size = byteLen(line) + (raw.length > 0 ? 1 : 0)
    if (bytes + size > DEFAULT_MAX_BYTES) {
      truncatedByBytes = true
      hasMoreLines = true
      break
    }

    raw.push(line)
    bytes += size
  }

  const totalLines = lines
  const lastReadLine = offset + raw.length - 1
  const nextOffset = lastReadLine + 1
  const truncated = hasMoreLines || truncatedByBytes

  // 行号宽度对齐
  const padWidth = String(totalLines).length

  const numbered = raw.map((line, i) => {
    const lineNum = offset + i
    return `${String(lineNum).padStart(padWidth, ' ')}│${line}`
  })

  let text = numbered.join('\n')

  if (truncatedByBytes) {
    text += `\n\n(Output capped at ${formatSize(DEFAULT_MAX_BYTES)}. Showing lines ${offset}-${lastReadLine}. Use offset=${nextOffset} to continue.)`
  } else if (hasMoreLines) {
    text += `\n\n(Showing lines ${offset}-${lastReadLine} of ${totalLines}. Use offset=${nextOffset} to continue.)`
  } else {
    text += `\n\n(End of file - total ${totalLines} lines)`
  }

  const header = `File: ${params.path} (${totalLines} lines, ${formatSize(fileSize)})`
  if (params.offset || params.limit) {
    text = `${header}\nShowing: lines ${offset}-${lastReadLine}\n\n${text}`
  } else {
    text = `${header}\n\n${text}`
  }

  return {
    content: [{ type: 'text' as const, text }],
    details: { type: 'read', totalLines, fileSize, truncated }
  }
}

/** 目录读取：列出条目（目录加 / 后缀），排序，支持 offset/limit 分页 */
export async function readDirContent(
  port: FileSystemPort,
  readPath: string,
  params: ReadTextParams
): Promise<ReadResult> {
  const dirents = await port.readdir(readPath)
  const entries = dirents.map((d) => (d.isDirectory ? d.name + '/' : d.name))
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
    details: { type: 'read', totalEntries: total, truncated }
  }
}
