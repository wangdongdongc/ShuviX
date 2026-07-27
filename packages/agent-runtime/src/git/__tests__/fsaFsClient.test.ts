/**
 * createFsaFsClient 单元测试 —— TDD 先行：实现当前为桩（throw 'not implemented'），本文件此刻应全红。
 *
 * 先在文件内实现一个内存 mock 句柄树（语义对齐真实 FSA：NotFoundError / removeEntry
 * recursive / entries() 异步迭代 / lastModified 用递增计数器），再验证适配器的 node-fs 语义
 * （契约见 fsaFsClient.ts 文件头注释）。
 * 加分项：mock 树 + 适配器直接跑 isomorphic-git 的 init/add/commit/status，纯内存验证兼容性。
 */
import { describe, it, expect } from 'vitest'

import {
  createFsaFsClient,
  type FsaDirHandleLike,
  type FsaFileHandleLike,
  type FsaFileLike,
  type FsaWritableLike
} from '../fsaFsClient'
import type { GitCache, GitEnv, GitFsClient } from '../env'
import { initOp, addOp, commitOp, statusOp } from '../gitOps'

// ---------------------------------------------------------------------------
// 内存 mock 句柄树（最小 FSA 语义）
// ---------------------------------------------------------------------------

interface FileNode {
  kind: 'file'
  data: Uint8Array
  mtime: number
}

interface DirNode {
  kind: 'directory'
  children: Map<string, FileNode | DirNode>
}

/** File.lastModified 用递增计数器，避免真实时钟同毫秒 */
let mtimeCounter = 0

function domError(name: string): Error {
  const e = new Error(name)
  e.name = name
  return e
}

function fileHandleFor(node: FileNode): FsaFileHandleLike {
  return {
    async getFile(): Promise<FsaFileLike> {
      const snapshot = node.data
      const mtime = node.mtime
      return {
        size: snapshot.byteLength,
        lastModified: mtime,
        arrayBuffer: async () => snapshot.slice().buffer as ArrayBuffer
      }
    },
    async createWritable(): Promise<FsaWritableLike> {
      const chunks: Uint8Array[] = []
      return {
        async write(data: Uint8Array | string): Promise<void> {
          chunks.push(typeof data === 'string' ? new TextEncoder().encode(data) : data)
        },
        async close(): Promise<void> {
          const total = chunks.reduce((n, c) => n + c.byteLength, 0)
          const merged = new Uint8Array(total)
          let offset = 0
          for (const c of chunks) {
            merged.set(c, offset)
            offset += c.byteLength
          }
          node.data = merged
          node.mtime = ++mtimeCounter
        }
      }
    }
  }
}

function dirHandleFor(node: DirNode): FsaDirHandleLike {
  return {
    async getDirectoryHandle(
      name: string,
      options?: { create?: boolean }
    ): Promise<FsaDirHandleLike> {
      const child = node.children.get(name)
      if (child) {
        if (child.kind !== 'directory') throw domError('TypeMismatchError')
        return dirHandleFor(child)
      }
      if (!options?.create) throw domError('NotFoundError')
      const created: DirNode = { kind: 'directory', children: new Map() }
      node.children.set(name, created)
      return dirHandleFor(created)
    },
    async getFileHandle(name: string, options?: { create?: boolean }): Promise<FsaFileHandleLike> {
      const child = node.children.get(name)
      if (child) {
        if (child.kind !== 'file') throw domError('TypeMismatchError')
        return fileHandleFor(child)
      }
      if (!options?.create) throw domError('NotFoundError')
      const created: FileNode = { kind: 'file', data: new Uint8Array(0), mtime: ++mtimeCounter }
      node.children.set(name, created)
      return fileHandleFor(created)
    },
    async removeEntry(name: string, options?: { recursive?: boolean }): Promise<void> {
      const child = node.children.get(name)
      if (!child) throw domError('NotFoundError')
      if (child.kind === 'directory' && child.children.size > 0 && !options?.recursive) {
        throw domError('InvalidModificationError')
      }
      node.children.delete(name)
    },
    async *entries(): AsyncGenerator<[string, { kind: 'file' | 'directory' }]> {
      for (const [name, child] of node.children) {
        yield [name, { kind: child.kind }]
      }
    }
  }
}

function makeMockRoot(): FsaDirHandleLike {
  return dirHandleFor({ kind: 'directory', children: new Map() })
}

function makeClient(): GitFsClient {
  return createFsaFsClient(makeMockRoot())
}

/** 取 promise 拒绝时错误上的 node 风格 code；未拒绝返回 undefined */
async function errCode(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p
  } catch (e) {
    return (e as { code?: string }).code
  }
  return undefined
}

// ---------------------------------------------------------------------------
// readFile / writeFile
// ---------------------------------------------------------------------------

describe('createFsaFsClient - readFile/writeFile', () => {
  it('Uint8Array 往返；encoding utf8 返回 string（对象与字符串两种 options 形态）', async () => {
    const fs = makeClient().promises
    await fs.writeFile('a.txt', new Uint8Array([104, 105])) // "hi"
    const buf = await fs.readFile('a.txt')
    expect(buf).toBeInstanceOf(Uint8Array)
    expect(Array.from(buf as Uint8Array)).toEqual([104, 105])
    expect(await fs.readFile('a.txt', { encoding: 'utf8' })).toBe('hi')
    await fs.writeFile('b.txt', 'héllo', 'utf8')
    expect(await fs.readFile('b.txt', 'utf8')).toBe('héllo')
  })

  it('writeFile 不自动创建父目录：父缺失 → ENOENT', async () => {
    const fs = makeClient().promises
    expect(await errCode(fs.writeFile('missing/b.txt', 'x', 'utf8'))).toBe('ENOENT')
  })

  it('readFile 不存在 → ENOENT', async () => {
    const fs = makeClient().promises
    expect(await errCode(fs.readFile('ghost.txt'))).toBe('ENOENT')
  })
})

// ---------------------------------------------------------------------------
// mkdir / unlink / rmdir / readdir
// ---------------------------------------------------------------------------

describe('createFsaFsClient - mkdir', () => {
  it('仅建一层：成功建目录；父缺失 → ENOENT；已存在 → EEXIST', async () => {
    const fs = makeClient().promises
    await fs.mkdir('d')
    expect((await fs.stat('d')).isDirectory()).toBe(true)
    expect(await errCode(fs.mkdir('x/y'))).toBe('ENOENT')
    expect(await errCode(fs.mkdir('d'))).toBe('EEXIST')
  })
})

describe('createFsaFsClient - unlink/rmdir', () => {
  it('rmdir 非空 → ENOTEMPTY；unlink 后 rmdir 成功；unlink 不存在 → ENOENT', async () => {
    const fs = makeClient().promises
    await fs.mkdir('d')
    await fs.writeFile('d/f.txt', 'x', 'utf8')
    expect(await errCode(fs.rmdir('d'))).toBe('ENOTEMPTY')
    await fs.unlink('d/f.txt')
    await fs.rmdir('d')
    expect(await errCode(fs.stat('d'))).toBe('ENOENT')
    expect(await errCode(fs.unlink('ghost.txt'))).toBe('ENOENT')
  })
})

describe('createFsaFsClient - readdir', () => {
  it('返回名字数组；对文件路径 → ENOTDIR', async () => {
    const fs = makeClient().promises
    await fs.mkdir('d')
    await fs.writeFile('d/a.txt', 'x', 'utf8')
    await fs.writeFile('d/b.txt', 'y', 'utf8')
    await fs.mkdir('d/sub')
    const names = await fs.readdir('d')
    expect([...names].sort()).toEqual(['a.txt', 'b.txt', 'sub'])
    expect(await errCode(fs.readdir('d/a.txt'))).toBe('ENOTDIR')
  })
})

// ---------------------------------------------------------------------------
// stat / lstat
// ---------------------------------------------------------------------------

describe('createFsaFsClient - stat/lstat', () => {
  it('文件：mode 0o100644、size、mtimeMs 取自 File，ino/uid/gid/dev 恒 0', async () => {
    const fs = makeClient().promises
    await fs.writeFile('f.txt', 'abc', 'utf8')
    const st = await fs.stat('f.txt')
    expect(st.isFile()).toBe(true)
    expect(st.isDirectory()).toBe(false)
    expect(st.isSymbolicLink()).toBe(false)
    expect(st.mode).toBe(0o100644)
    expect(st.size).toBe(3)
    expect(typeof st.mtimeMs).toBe('number')
    expect(st.mtimeMs).toBeGreaterThan(0)
    expect(st.ino).toBe(0)
    expect(st.uid).toBe(0)
    expect(st.gid).toBe(0)
    expect(st.dev).toBe(0)
  })

  it('目录：mode 0o40000', async () => {
    const fs = makeClient().promises
    await fs.mkdir('d')
    const st = await fs.stat('d')
    expect(st.isDirectory()).toBe(true)
    expect(st.isFile()).toBe(false)
    expect(st.mode).toBe(0o40000)
  })

  it('lstat 结果与 stat 一致（不支持 symlink）', async () => {
    const fs = makeClient().promises
    await fs.writeFile('f.txt', 'abc', 'utf8')
    const st = await fs.stat('f.txt')
    const lst = await fs.lstat('f.txt')
    expect(lst.mode).toBe(st.mode)
    expect(lst.size).toBe(st.size)
    expect(lst.mtimeMs).toBe(st.mtimeMs)
    expect(lst.isFile()).toBe(st.isFile())
    expect(lst.isSymbolicLink()).toBe(false)
  })

  it('不存在 → code ENOENT', async () => {
    const fs = makeClient().promises
    expect(await errCode(fs.stat('ghost'))).toBe('ENOENT')
    expect(await errCode(fs.lstat('ghost'))).toBe('ENOENT')
  })
})

// ---------------------------------------------------------------------------
// 路径语义
// ---------------------------------------------------------------------------

describe('createFsaFsClient - 路径语义', () => {
  it('前导斜杠：/a/b.txt 与 a/b.txt 指同一文件（isomorphic-git 以 dir:"/" 拼路径）', async () => {
    const fs = makeClient().promises
    await fs.mkdir('a')
    await fs.writeFile('a/b.txt', 'same', 'utf8')
    expect(await fs.readFile('/a/b.txt', 'utf8')).toBe('same')
    expect((await fs.stat('/a/b.txt')).size).toBe((await fs.stat('a/b.txt')).size)
    // 反向：带前导斜杠写、不带读
    await fs.writeFile('/a/c.txt', 'also', 'utf8')
    expect(await fs.readFile('a/c.txt', 'utf8')).toBe('also')
  })

  it('出现 ".." 段 → 抛错', async () => {
    const fs = makeClient().promises
    await fs.mkdir('a')
    await expect(fs.stat('a/../a')).rejects.toThrow()
    await expect(fs.readFile('../outside.txt')).rejects.toThrow()
  })

  it('目录句柄缓存失效：rmdir 后 stat → ENOENT，重建同名目录不得命中旧句柄', async () => {
    const fs = makeClient().promises
    await fs.mkdir('d')
    await fs.writeFile('d/f.txt', 'x', 'utf8')
    expect(await fs.readdir('d')).toEqual(['f.txt'])
    await fs.unlink('d/f.txt')
    await fs.rmdir('d')
    expect(await errCode(fs.stat('d'))).toBe('ENOENT')
    expect(await errCode(fs.readdir('d'))).toBe('ENOENT')
    // 重建同名目录：缓存若残留旧句柄，这里会读到幽灵内容
    await fs.mkdir('d')
    await fs.writeFile('d/g.txt', 'y', 'utf8')
    expect(await fs.readdir('d')).toEqual(['g.txt'])
    expect(await fs.readFile('d/g.txt', 'utf8')).toBe('y')
  })
})

// ---------------------------------------------------------------------------
// 加分：isomorphic-git × 适配器纯内存集成
// ---------------------------------------------------------------------------

describe('createFsaFsClient - isomorphic-git 集成（纯内存）', () => {
  it('init → writeFile → add → commit → status clean', async () => {
    const client = createFsaFsClient(makeMockRoot())
    const env: GitEnv = { fs: client, dir: '/' }
    const cache: GitCache = {}

    const initOut = await initOp(env, cache, {})
    expect(initOut.text).toContain('Initialized')

    await client.promises.writeFile('/hello.txt', 'hi\n', 'utf8')

    const addOut = await addOp(env, cache, { paths: ['hello.txt'] })
    expect(addOut.details?.fileCount).toBe(1)

    const commitOut = await commitOp(env, cache, {
      message: 'first',
      authorName: 'Alice',
      authorEmail: 'alice@example.com'
    })
    expect(commitOut.text).toMatch(/^\[main [0-9a-f]{7}\] first/)
    expect(String(commitOut.details?.oid)).toMatch(/^[0-9a-f]{40}$/)

    const statusOut = await statusOp(env, cache, {})
    expect(statusOut.text).toContain('working tree clean')
    expect(statusOut.details?.fileCount).toBe(0)
  })
})
