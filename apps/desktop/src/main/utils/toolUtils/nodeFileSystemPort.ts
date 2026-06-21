/**
 * 桌面 FileSystemPort 实现 —— Node fs（操作绝对路径）。供共享文件内核（read/write）注入。
 */
import {
  stat as fsStat,
  readdir as fsReaddir,
  mkdir as fsMkdir,
  readFile as fsReadFile,
  writeFile as fsWriteFile
} from 'fs/promises'
import { createReadStream } from 'fs'
import { createInterface } from 'readline'
import { dirname } from 'path'
import type { FileSystemPort } from '@shuvix/agent-runtime'

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

  async writeFile(p, content) {
    await fsMkdir(dirname(p), { recursive: true })
    await fsWriteFile(p, content, 'utf-8')
  },

  async readdir(p) {
    const ds = await fsReaddir(p, { withFileTypes: true })
    return ds.map((d) => ({ name: d.name, isDirectory: d.isDirectory() }))
  }
}
