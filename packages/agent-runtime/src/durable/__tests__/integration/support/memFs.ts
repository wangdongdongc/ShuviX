/**
 * 「磁盘」：一张路径 → 文本的表，实现文件工具的 FileSystemPort 与 FileGuards。它是**世界级**的 ——
 * 重启（换进程）之后还是同一份，就像真磁盘熬过进程退出。落盘的工具输出也写在这里
 * （`/tool_results/<会话>/<调用>.txt`），真 read 工具读得回来。
 *
 * 计数（写 / 读）给「写了几次」「一次都没写」这类断言用。
 */
import type { DirEntry, FileGuards, FileStat, FileSystemPort } from '../../../../fileTools/port'

export interface MemFs {
  readonly files: Map<string, string>
  readonly port: FileSystemPort
  readonly guards: FileGuards
  /** writeFile 的调用（路径，按顺序） */
  readonly writes: string[]
  /** 对某个路径的 writeFile 次数 */
  writesTo(path: string): number
  /** readTextLines / readFile 的调用（路径，按顺序） */
  readonly reads: string[]
}

export function memFs(initial: Record<string, string> = {}): MemFs {
  const files = new Map(Object.entries(initial))
  const writes: string[] = []
  const reads: string[] = []
  const readTimes = new Set<string>()
  const locks = new Map<string, Promise<unknown>>()

  const isDir = (path: string): boolean => {
    const prefix = path.endsWith('/') ? path : `${path}/`
    for (const key of files.keys()) if (key.startsWith(prefix)) return true
    return false
  }

  const port: FileSystemPort = {
    stat: async (path): Promise<FileStat | null> => {
      const content = files.get(path)
      if (content !== undefined) {
        return { isFile: true, isDirectory: false, size: content.length, mtimeMs: 1000 }
      }
      return isDir(path) ? { isFile: false, isDirectory: true, size: 0, mtimeMs: 1000 } : null
    },
    async *readTextLines(path) {
      reads.push(path)
      const content = files.get(path)
      if (content === undefined) throw new Error(`ENOENT: ${path}`)
      for (const line of content.split('\n')) yield line
    },
    readFile: async (path) => {
      reads.push(path)
      const content = files.get(path)
      if (content === undefined) throw new Error(`ENOENT: ${path}`)
      return content
    },
    readBytes: async (path, offset, length) => {
      const content = files.get(path)
      if (content === undefined) throw new Error(`ENOENT: ${path}`)
      return new TextEncoder().encode(content).slice(offset, offset + length)
    },
    writeFile: async (path, content) => {
      writes.push(path)
      files.set(path, content)
    },
    readdir: async (path): Promise<DirEntry[]> => {
      const prefix = path.endsWith('/') ? path : `${path}/`
      const names = new Map<string, boolean>()
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue
        const rest = key.slice(prefix.length)
        const slash = rest.indexOf('/')
        names.set(slash < 0 ? rest : rest.slice(0, slash), slash >= 0)
      }
      return [...names].map(([name, isDirectory]) => ({ name, isDirectory }))
    },
    readLink: async () => null
  }

  const guards: FileGuards = {
    hasReadTime: (path) => readTimes.has(path),
    assertNotModifiedSinceRead: () => {},
    recordRead: (path) => void readTimes.add(path),
    withFileLock: async <T>(path: string, fn: () => Promise<T>): Promise<T> => {
      const previous = locks.get(path) ?? Promise.resolve()
      const run = previous.catch(() => undefined).then(fn)
      locks.set(
        path,
        run.catch(() => undefined)
      )
      return run
    }
  }

  return {
    files,
    port,
    guards,
    writes,
    writesTo: (path) => writes.filter((written) => written === path).length,
    reads
  }
}
