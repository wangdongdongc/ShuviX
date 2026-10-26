/**
 * 应用日志（主进程 electron-log 写的 main.log）—— 设置 → 监视器 → 应用日志 读它的尾部。
 * 纯数据 + 解析：主进程按字节读尾部（appLogService），渲染层把文本解析成条目。
 *
 * 行格式由 `main/logger.ts` 定：`[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}]{scope} {text}`。electron-log 把
 * `{level}]` 补齐到 6 个字符，`{scope}` 写成 ` (tag)` 再补齐到最长的 tag；一条消息里的换行（堆栈）原样写成后续行，
 * 没有行头 —— 它们归到上一条。
 */

/** 一次最多读文件的最后这么多字节（第一次打开、换了文件、落后太多时） */
export const APP_LOG_TAIL_BYTES = 512 * 1024

/** 读尾部的游标：上一次读到哪个文件（轮转后换了文件）的哪个字节 */
export interface AppLogCursor {
  fileId: string
  offset: number
}

/** 一次读尾部的结果 */
export interface AppLogTail {
  /** main.log 的绝对路径 */
  path: string
  /** 这份文件的身份（轮转成 main.old.log 后新文件换一个）；文件不在 → '' */
  fileId: string
  /** text 在文件里的起止字节（end 是下一次的 offset） */
  start: number
  end: number
  /** 从 start 起的完整行（不含末尾还没写完的半行） */
  text: string
  /** true = text 不接在游标后面（第一次读、换了文件、落后太多），调用方整个替换 */
  reset: boolean
  /** reset 时前面还有没读的内容（只读了最后一段） */
  truncated: boolean
}

export interface AppLogEntry {
  /** `YYYY-MM-DD HH:MM:SS.mmm`（本地时间） */
  time: string
  /** error / warn / info / verbose / debug / silly */
  level: string
  /** logger 的模块标签（createLogger 的 tag）；没有 → '' */
  scope: string
  text: string
  /** 消息里换行之后的行（堆栈之类） */
  more: string[]
}

export interface ParsedAppLog {
  /** 第一条行头之前的行：接着读时属于上一次的最后一条 */
  orphan: string[]
  entries: AppLogEntry[]
}

// 标签后面恒有空白（补齐 + 模板里的空格）；没有标签、正文又恰以 `(词) ` 开头的行会被读成带标签，接受
const HEADER =
  /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\] \[([a-z]+)\]\s*(?:\(([^()\s]+)\)\s+)?(.*)$/

export function parseAppLog(text: string): ParsedAppLog {
  const orphan: string[] = []
  const entries: AppLogEntry[] = []
  const lines = text.split('\n')
  // 以换行结尾的文本 split 出来最后是个空串
  if (lines[lines.length - 1] === '') lines.pop()
  for (const raw of lines) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    const m = HEADER.exec(line)
    if (m) {
      entries.push({ time: m[1], level: m[2], scope: m[3] ?? '', text: m[4], more: [] })
    } else if (entries.length > 0) {
      entries[entries.length - 1].more.push(line)
    } else {
      orphan.push(line)
    }
  }
  return { orphan, entries }
}

/** 一条的原文（复制用）：与文件里一样的行头 + 后续行 */
export function formatAppLogEntry(entry: AppLogEntry): string {
  const scope = entry.scope ? ` (${entry.scope})` : ''
  return [`[${entry.time}] [${entry.level}]${scope} ${entry.text}`, ...entry.more].join('\n')
}
