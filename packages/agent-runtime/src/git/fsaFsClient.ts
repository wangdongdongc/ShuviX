/**
 * FSA/OPFS → GitFsClient 适配器（扩展端注入用；桌面直接传 node:fs）。
 *
 * 基于最小结构类型 FsaDirHandleLike（不依赖 lib.dom），真实的 FileSystemDirectoryHandle
 * 与测试里的内存 mock 都满足。项目会话（FSA 真实文件夹）与临时会话（OPFS）同一适配器。
 *
 * 行为契约（node-fs 语义，isomorphic-git 依赖这些细节）：
 * - 路径以注入的 root 句柄为根；前导 '/' 必须吞掉（isomorphic-git 以 dir:'/' 拼出 '/x/y'）；
 *   ''/'.'/'/' 均指根；出现 '..' 段直接抛错（天然沙箱，与 fsaPort 同策略）。
 * - 找不到路径（FSA NotFoundError 等）→ 抛带 `code:'ENOENT'` 的 Error。
 * - mkdir 仅建一层：父目录不存在 → ENOENT；目标已存在 → EEXIST（isomorphic-git 会捕获两者）。
 * - writeFile 不自动创建父目录（node 语义）：父目录不存在 → ENOENT。
 * - unlink / rmdir 用 removeEntry；rmdir 对非空目录 → ENOTEMPTY。
 * - readdir 返回名字数组；对文件路径 → ENOTDIR。
 * - stat/lstat：文件 mode 0o100644、size/mtimeMs 取自 File（size/lastModified）；
 *   目录 mode 0o40000、size/mtimeMs 0；ino/uid/gid/dev 恒 0；isSymbolicLink() 恒 false；lstat === stat。
 * - 目录句柄缓存：按路径缓存已解析的目录句柄（.git/objects/xx 逐段导航是热点）；
 *   removeEntry（unlink/rmdir）后必须失效该路径子树的缓存。
 */
import type { GitFsClient, GitFsPromises, GitFsStat } from './env'

/** File 的最小结构（getFile() 返回值） */
export interface FsaFileLike {
  size: number
  lastModified: number
  arrayBuffer(): Promise<ArrayBuffer>
}

/** FileSystemWritableFileStream 的最小结构 */
export interface FsaWritableLike {
  write(data: Uint8Array | string): Promise<void>
  close(): Promise<void>
}

/** FileSystemFileHandle 的最小结构 */
export interface FsaFileHandleLike {
  getFile(): Promise<FsaFileLike>
  createWritable(): Promise<FsaWritableLike>
}

/** FileSystemDirectoryHandle 的最小结构（真实句柄与内存 mock 均满足） */
export interface FsaDirHandleLike {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FsaDirHandleLike>
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FsaFileHandleLike>
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>
  entries(): AsyncIterable<[string, { kind: 'file' | 'directory' }]>
}

// ---------------------------------------------------------------------------
// 错误映射
// ---------------------------------------------------------------------------

function errWithCode(code: string, message: string): Error {
  const e = new Error(message) as Error & { code: string }
  e.code = code
  return e
}

/** FSA DOMException → node 风格 code */
function mapFsaError(e: unknown, path: string, notFoundCode = 'ENOENT'): Error {
  const name = e instanceof Error ? e.name : ''
  if (name === 'NotFoundError') return errWithCode(notFoundCode, `${notFoundCode}: ${path}`)
  if (name === 'TypeMismatchError') return errWithCode('ENOTDIR', `ENOTDIR: ${path}`)
  if (name === 'InvalidModificationError') return errWithCode('ENOTEMPTY', `ENOTEMPTY: ${path}`)
  return e instanceof Error ? e : new Error(String(e))
}

function toSegments(path: string): string[] {
  const segments = path.split('/').filter((s) => s !== '' && s !== '.')
  if (segments.includes('..')) {
    throw errWithCode('EINVAL', `EINVAL: path escapes the sandbox root: ${path}`)
  }
  return segments
}

const encoder = new TextEncoder()
const utf8Decoder = new TextDecoder('utf-8')

function wantsUtf8(options?: { encoding?: 'utf8' } | 'utf8'): boolean {
  return options === 'utf8' || (typeof options === 'object' && options?.encoding === 'utf8')
}

function makeStat(kind: 'file' | 'directory', size: number, mtimeMs: number): GitFsStat {
  return {
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'directory',
    isSymbolicLink: () => false,
    mode: kind === 'file' ? 0o100644 : 0o40000,
    size,
    ino: 0,
    mtimeMs,
    ctimeMs: mtimeMs,
    uid: 0,
    gid: 0,
    dev: 0
  }
}

// ---------------------------------------------------------------------------
// 适配器
// ---------------------------------------------------------------------------

/** 以 root 句柄为根创建 GitFsClient（契约见文件头注释） */
export function createFsaFsClient(root: FsaDirHandleLike): GitFsClient {
  /** path key（'a/b'）→ 已解析目录句柄；'' = root */
  const dirCache = new Map<string, FsaDirHandleLike>()
  dirCache.set('', root)

  async function resolveDir(segments: string[], create: boolean): Promise<FsaDirHandleLike> {
    const key = segments.join('/')
    const hit = dirCache.get(key)
    if (hit) return hit
    const parent = await resolveDir(segments.slice(0, -1), create)
    const name = segments[segments.length - 1]
    let handle: FsaDirHandleLike
    try {
      handle = await parent.getDirectoryHandle(name, create ? { create: true } : undefined)
    } catch (e) {
      throw mapFsaError(e, key)
    }
    dirCache.set(key, handle)
    return handle
  }

  /** removeEntry 后失效该路径及其子树的目录句柄缓存 */
  function invalidate(key: string): void {
    for (const k of [...dirCache.keys()]) {
      if (k === key || k.startsWith(`${key}/`)) dirCache.delete(k)
    }
  }

  /** 拆出父目录句柄 + 末段名（path 不能为根） */
  async function parentOf(
    path: string,
    what: string
  ): Promise<{ parent: FsaDirHandleLike; name: string }> {
    const segments = toSegments(path)
    if (segments.length === 0) throw errWithCode('EISDIR', `EISDIR: ${what} on root: ${path}`)
    const parent = await resolveDir(segments.slice(0, -1), false)
    return { parent, name: segments[segments.length - 1] }
  }

  const promises: GitFsPromises = {
    async readFile(path, options) {
      const { parent, name } = await parentOf(path, 'readFile')
      let file: FsaFileLike
      try {
        file = await (await parent.getFileHandle(name)).getFile()
      } catch (e) {
        throw mapFsaError(e, path)
      }
      const bytes = new Uint8Array(await file.arrayBuffer())
      return wantsUtf8(options) ? utf8Decoder.decode(bytes) : bytes
    },

    async writeFile(path, data, _options) {
      void _options // mode 等选项无 FSA 对应物，忽略
      const { parent, name } = await parentOf(path, 'writeFile')
      let handle: FsaFileHandleLike
      try {
        handle = await parent.getFileHandle(name, { create: true })
      } catch (e) {
        throw mapFsaError(e, path)
      }
      const writable = await handle.createWritable()
      await writable.write(typeof data === 'string' ? encoder.encode(data) : data)
      await writable.close()
    },

    async unlink(path) {
      const { parent, name } = await parentOf(path, 'unlink')
      try {
        await parent.removeEntry(name)
      } catch (e) {
        throw mapFsaError(e, path)
      }
      invalidate(toSegments(path).join('/'))
    },

    async readdir(path) {
      const dir = await resolveDir(toSegments(path), false)
      const names: string[] = []
      for await (const [name] of dir.entries()) {
        names.push(name)
      }
      return names
    },

    async mkdir(path) {
      const segments = toSegments(path)
      if (segments.length === 0) throw errWithCode('EEXIST', `EEXIST: ${path}`)
      const parent = await resolveDir(segments.slice(0, -1), false)
      const name = segments[segments.length - 1]
      // 已存在（无论文件还是目录）→ EEXIST（node 语义）
      let exists = true
      try {
        await parent.getDirectoryHandle(name)
      } catch (e) {
        if (e instanceof Error && e.name === 'TypeMismatchError') {
          throw errWithCode('EEXIST', `EEXIST: ${path}`)
        }
        exists = false
      }
      if (exists) throw errWithCode('EEXIST', `EEXIST: ${path}`)
      try {
        const handle = await parent.getDirectoryHandle(name, { create: true })
        dirCache.set(segments.join('/'), handle)
      } catch (e) {
        throw mapFsaError(e, path)
      }
    },

    async rmdir(path) {
      const { parent, name } = await parentOf(path, 'rmdir')
      try {
        await parent.removeEntry(name)
      } catch (e) {
        throw mapFsaError(e, path)
      }
      invalidate(toSegments(path).join('/'))
    },

    async stat(path) {
      const segments = toSegments(path)
      if (segments.length === 0) return makeStat('directory', 0, 0)
      const parent = await resolveDir(segments.slice(0, -1), false)
      const name = segments[segments.length - 1]
      try {
        const file = await (await parent.getFileHandle(name)).getFile()
        return makeStat('file', file.size, file.lastModified)
      } catch (e) {
        if (e instanceof Error && e.name === 'TypeMismatchError') {
          return makeStat('directory', 0, 0)
        }
        throw mapFsaError(e, path)
      }
    },

    async lstat(path) {
      return promises.stat(path)
    },

    // isomorphic-git 的 FileSystem 无条件 bind readlink/symlink（commands 列表），必须存在；
    // 本适配器从不报告 symlink mode，故它们不会被真正调用 —— 占位抛 ENOSYS。
    async readlink(path) {
      throw errWithCode('ENOSYS', `ENOSYS: symlinks are not supported: ${path}`)
    },

    async symlink(_target, path) {
      throw errWithCode('ENOSYS', `ENOSYS: symlinks are not supported: ${path}`)
    }
  }

  return { promises }
}
