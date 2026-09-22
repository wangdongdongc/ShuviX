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
import type { FileSystemPort } from '@shuvix/agent-runtime'
import { resolveRealPath } from './realPath'

/** 路径末尾不改变指向的那部分：一串分隔符与 `.` 段（Windows 两种斜杠都认） */
const TRAILING_NOOP = process.platform === 'win32' ? /(?:[\\/]+\.?)+$/ : /(?:\/+\.?)+$/

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
