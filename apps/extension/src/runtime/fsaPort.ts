/**
 * 浏览器 FileSystemPort —— File System Access API 实现（注入给 @shuvix/agent-runtime 共享文件内核）。
 *
 * 路径语义：相对项目根句柄，按 '/' 逐段导航；'.' 跳过，'..' 直接拒绝（天然沙箱：不能越过根）。
 * 与桌面 Node fs port 一一对应：stat / readTextLines / readFile / writeFile / readdir。
 */
import type { FileSystemPort, DirEntry, FileGuards } from '@shuvix/agent-runtime'

/** 相对路径 → 规范段；'\' 视作 '/'，'.' 跳过，'..' 拒绝 */
function toSegments(path: string): string[] {
  const out: string[] = []
  for (const p of path.replace(/\\/g, '/').split('/')) {
    if (p === '' || p === '.') continue
    if (p === '..') throw new Error(`Path escapes project root: ${path}`)
    out.push(p)
  }
  return out
}

export function createFsaPort(root: FileSystemDirectoryHandle): FileSystemPort {
  /** 导航到前 count 段对应的目录句柄（不存在时按 create 决定建/抛） */
  async function dirAt(
    segs: string[],
    count: number,
    create: boolean
  ): Promise<FileSystemDirectoryHandle> {
    let dir = root
    for (let i = 0; i < count; i++) {
      dir = await dir.getDirectoryHandle(segs[i], { create })
    }
    return dir
  }

  async function readFileText(path: string): Promise<string> {
    const segs = toSegments(path)
    if (segs.length === 0) throw new Error(`Not a file: ${path}`)
    const parent = await dirAt(segs, segs.length - 1, false)
    const fh = await parent.getFileHandle(segs[segs.length - 1])
    const file = await fh.getFile()
    return file.text()
  }

  return {
    async stat(path) {
      const segs = toSegments(path)
      // 根目录
      if (segs.length === 0) return { isFile: false, isDirectory: true, size: 0, mtimeMs: 0 }
      let parent: FileSystemDirectoryHandle
      try {
        parent = await dirAt(segs, segs.length - 1, false)
      } catch {
        return null
      }
      const name = segs[segs.length - 1]
      try {
        const fh = await parent.getFileHandle(name)
        const file = await fh.getFile()
        return { isFile: true, isDirectory: false, size: file.size, mtimeMs: file.lastModified }
      } catch {
        /* 不是文件，下面试目录 */
      }
      try {
        await parent.getDirectoryHandle(name)
        return { isFile: false, isDirectory: true, size: 0, mtimeMs: 0 }
      } catch {
        return null
      }
    },

    readFile: readFileText,

    async readBytes(path, offset, length) {
      if (length <= 0) return new Uint8Array(0)
      const segs = toSegments(path)
      if (segs.length === 0) throw new Error(`Not a file: ${path}`)
      const parent = await dirAt(segs, segs.length - 1, false)
      const fh = await parent.getFileHandle(segs[segs.length - 1])
      const file = await fh.getFile()
      // File.slice 只切片不读盘；arrayBuffer 只解出 [offset, offset+length) 这段字节
      const blob = file.slice(offset, offset + length)
      return new Uint8Array(await blob.arrayBuffer())
    },

    async *readTextLines(path) {
      const text = await readFileText(path)
      if (text === '') return
      const lines = text.split(/\r\n|\r|\n/)
      // 文件末尾的换行会切出一个空段；与 Node readline（crlfDelay:Infinity）行为对齐，去掉它
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
      for (const line of lines) yield line
    },

    async writeFile(path, content) {
      const segs = toSegments(path)
      if (segs.length === 0) throw new Error(`Not a file: ${path}`)
      const parent = await dirAt(segs, segs.length - 1, true) // 自动建父目录
      const fh = await parent.getFileHandle(segs[segs.length - 1], { create: true })
      const writable = await fh.createWritable()
      await writable.write(content)
      await writable.close()
    },

    async readdir(path) {
      const segs = toSegments(path)
      const dir = await dirAt(segs, segs.length, false)
      const out: DirEntry[] = []
      for await (const [name, handle] of dir.entries()) {
        out.push({ name, isDirectory: handle.kind === 'directory' })
      }
      return out
    }
  }
}

/**
 * 浏览器 FileGuards —— 读后被改守卫 + 写锁（per-session 内存态）。
 * 与桌面 fileTime 同语义：recordRead 存「读取墙钟时刻」，assert 比对文件 mtime（50ms 容差）。
 * 桌面 statSync 同步取 mtime；浏览器 FSA 只能异步，故 assert 走 port.stat（接口本就允许返回 Promise）。
 */
export function createFsaGuards(port: FileSystemPort): FileGuards {
  const readTimes = new Map<string, number>()
  const locks = new Map<string, Promise<void>>()

  return {
    hasReadTime: (p) => readTimes.has(p),

    recordRead: (p) => {
      readTimes.set(p, Date.now())
    },

    async assertNotModifiedSinceRead(p) {
      const t = readTimes.get(p)
      if (t === undefined) {
        throw new Error(`You must read file ${p} before overwriting it. Use the read tool first.`)
      }
      const st = await port.stat(p)
      if (!st) return // 文件不存在（可能已删），允许写入
      if (st.mtimeMs > t + 50) {
        throw new Error(
          `File ${p} has been modified since it was last read.\n` +
            `Please read the file again before modifying it.`
        )
      }
    },

    async withFileLock(p, fn) {
      const current = locks.get(p) ?? Promise.resolve()
      let release: () => void = () => {}
      const next = new Promise<void>((resolve) => {
        release = resolve
      })
      const chained = current.then(() => next)
      locks.set(p, chained)
      await current
      try {
        return await fn()
      } finally {
        release()
        if (locks.get(p) === chained) locks.delete(p)
      }
    }
  }
}

/**
 * 取某相对路径对应的 File（原始字节）——图片读取走这里，绕过文本 port（不经 UTF-8 解码）。
 */
export async function getFile(root: FileSystemDirectoryHandle, path: string): Promise<File> {
  const segs = toSegments(path)
  if (segs.length === 0) throw new Error(`Not a file: ${path}`)
  let dir = root
  for (let i = 0; i < segs.length - 1; i++) dir = await dir.getDirectoryHandle(segs[i])
  const fh = await dir.getFileHandle(segs[segs.length - 1])
  return fh.getFile()
}

/**
 * 确认对持久化目录句柄仍有读写权限。FSA 句柄存进 IndexedDB 后，跨会话权限可能失效，
 * 需重新授权（requestPermission 须用户手势，非手势上下文会拒绝 → 返回 false 由上层提示重开文件夹）。
 */
export async function ensureRwPermission(handle: FileSystemHandle): Promise<boolean> {
  const opts: FileSystemHandlePermissionDescriptor = { mode: 'readwrite' }
  if ((await handle.queryPermission(opts)) === 'granted') return true
  try {
    return (await handle.requestPermission(opts)) === 'granted'
  } catch {
    return false
  }
}
