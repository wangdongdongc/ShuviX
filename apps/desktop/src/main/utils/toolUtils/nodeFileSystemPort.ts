/**
 * 桌面 FileSystemPort 实现 —— Node fs（操作绝对路径）。供共享文件内核（read/write）注入。
 */
import {
  stat as fsStat,
  lstat as fsLstat,
  readlink as fsReadlink,
  readdir as fsReaddir,
  mkdir as fsMkdir,
  readFile as fsReadFile,
  writeFile as fsWriteFile,
  open as fsOpen
} from 'fs/promises'
import { createReadStream } from 'fs'
import { createInterface } from 'readline'
import { dirname } from 'path'
import iconv from 'iconv-lite'
import type { FileSystemPort } from '@shuvix/agent-runtime'
import { resolveRealPath } from './realPath'

/** 路径末尾不改变指向的那部分：一串分隔符与 `.` 段（Windows 两种斜杠都认） */
const TRAILING_NOOP = process.platform === 'win32' ? /(?:[\\/]+\.?)+$/ : /(?:\/+\.?)+$/

/** 保留换行、回车、制表与 ANSI ESC；其余 C0/C1 控制字符不直接送进模型输出 */
export const isDisallowedControlCodePoint = (cp: number): boolean =>
  cp === 0 ||
  (cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d && cp !== 0x1b) ||
  (cp >= 0x7f && cp <= 0x9f)

/** 局部逐字处理，避免控制字符正则；ANSI ESC 与其他可打印文本一样原样保留 */
export function escapeDisallowedControlChars(text: string): string {
  let result = ''
  let copiedFrom = 0
  for (let i = 0; i < text.length; i++) {
    const cp = text.charCodeAt(i)
    if (!isDisallowedControlCodePoint(cp)) continue
    result += text.slice(copiedFrom, i)
    result += cp === 0 ? '\\0' : `\\x${cp.toString(16).padStart(2, '0')}`
    copiedFrom = i + 1
  }
  return copiedFrom === 0 ? text : result + text.slice(copiedFrom)
}

/** TextDecoder 保留跨 chunk 的未完成多字节序列 */
const LEGACY_DECODER_BATCH_BYTES = 64 * 1024
// iconv-lite 0.7 的 GB18030 低层 decoder 对逐字节四字节序列有边界缺陷；写入前最多保留
// 三字节，使最长的 DBCS 字符不必跨 write。缓冲有 64KB 上限，仍是流式而非整读拼接。
const LEGACY_DECODER_CARRY_BYTES = 3

async function* decodeTextChunks(path: string, encoding: string): AsyncGenerator<string> {
  const stream = createReadStream(path)
  const nativeDecoder = /^(?:utf-?8|utf-?16(?:le|be))$/i.test(encoding)
    ? new TextDecoder(encoding)
    : null
  const legacyDecoder = nativeDecoder ? null : iconv.getDecoder(encoding)
  let legacyPending: Buffer = Buffer.alloc(0)
  try {
    for await (const chunk of stream) {
      let text: string
      if (nativeDecoder) {
        text = nativeDecoder.decode(chunk as Uint8Array, { stream: true })
      } else {
        const bytes = chunk as Buffer
        legacyPending = legacyPending.length === 0 ? bytes : Buffer.concat([legacyPending, bytes])
        if (legacyPending.length < LEGACY_DECODER_BATCH_BYTES) continue
        const flushLength = legacyPending.length - LEGACY_DECODER_CARRY_BYTES
        text = legacyDecoder!.write(legacyPending.subarray(0, flushLength))
        legacyPending = legacyPending.subarray(flushLength)
      }
      if (text) yield text
    }
    const tail = nativeDecoder
      ? nativeDecoder.decode()
      : legacyDecoder!.write(legacyPending) + (legacyDecoder!.end() ?? '')
    if (tail) yield tail
  } finally {
    stream.destroy()
  }
}

/** 与 readline 的 CRLF/CR/LF 及末尾空行语义对齐，但输入来自已解码 chunk */
async function* splitDecodedLines(chunks: AsyncIterable<string>): AsyncGenerator<string> {
  let pending = ''
  for await (const chunk of chunks) {
    pending += chunk
    let start = 0
    for (let i = 0; i < pending.length; i++) {
      const char = pending[i]
      if (char !== '\n' && char !== '\r') continue
      // chunk 末尾的 CR 等下一块，避免把 CRLF 错分成两个换行
      if (char === '\r' && i + 1 === pending.length) break
      yield pending.slice(start, i)
      if (char === '\r' && pending[i + 1] === '\n') i++
      start = i + 1
    }
    pending = pending.slice(start)
  }
  if (!pending) return
  yield pending.endsWith('\r') ? pending.slice(0, -1) : pending
}

/** 桌面 read 的可选解码行流；正文始终流式读取，不整读文件 */
export async function* readDecodedTextLines(
  path: string,
  encoding: string,
  escapeControls = false
): AsyncGenerator<string> {
  const decoded = decodeTextChunks(path, encoding)
  const chunks = escapeControls
    ? (async function* () {
        for await (const chunk of decoded) yield escapeDisallowedControlChars(chunk)
      })()
    : decoded
  yield* splitDecodedLines(chunks)
}

export const nodeFileSystemPort: FileSystemPort = {
  async stat(p) {
    try {
      const s = await fsStat(p)
      return { isFile: s.isFile(), isDirectory: s.isDirectory(), size: s.size, mtimeMs: s.mtimeMs }
    } catch {
      return null
    }
  },

  async *readTextLines(p) {
    const stream = createReadStream(p, { encoding: 'utf8' })
    const rl = createInterface({ input: stream, crlfDelay: Infinity })
    try {
      for await (const line of rl) yield line
    } finally {
      rl.close()
      stream.destroy()
    }
  },

  async readFile(p) {
    const buffer = await fsReadFile(p)
    return buffer.toString('utf-8')
  },

  async readBytes(p, offset, length) {
    if (length <= 0) return new Uint8Array(0)
    const fh = await fsOpen(p, 'r')
    try {
      const buf = Buffer.alloc(length)
      const { bytesRead } = await fh.read(buf, 0, length, offset)
      // Buffer 是 Uint8Array 子类；真实读到 bytesRead 字节，返回精确视图
      return bytesRead === length ? buf : buf.subarray(0, bytesRead)
    } finally {
      await fh.close()
    }
  },

  async writeFile(p, content) {
    await fsMkdir(dirname(p), { recursive: true })
    await fsWriteFile(p, content, 'utf-8')
  },

  async readdir(p) {
    const ds = await fsReaddir(p, { withFileTypes: true })
    return ds.map((d) => ({ name: d.name, isDirectory: d.isDirectory() }))
  },

  async readLink(p) {
    // 末尾的分隔符与 `.` 段不改变最后一段是谁：`dirlink/`、`dirlink/.` 说的仍是 dirlink 这条链接，
    // 可 lstat 碰上结尾斜杠会跟过去 —— 相对写法经 path.resolve 已去掉结尾，绝对写法原样到这里。
    // `..` 不在此列：它取的是链接那头的物理父目录，是另一条路径
    const named = p.replace(TRAILING_NOOP, '') || p
    try {
      if (!(await fsLstat(named)).isSymbolicLink()) return null
      // resolved 与路径门用的是同一个解析（链条跟到底、`..` 取物理父目录、终点可以还不存在）
      return { target: await fsReadlink(named), resolved: resolveRealPath(named) }
    } catch {
      return null
    }
  }
}
