/**
 * 扩展端按目录浅扫描（FSA/OPFS 句柄遍历）—— 与桌面 dirScan 同契约：
 * 只列一层（直接子文件 + 直接子目录，尾斜杠）。浏览场景所见即磁盘所有，
 * 唯一过滤是 `.git` 目录不列出。
 */
import { describe, expect, it } from 'vitest'
import { scanDirHandleShallow, type ScanDirHandle } from './scanDirShallow'

/** 内存 mock 目录句柄：{ 文件名: null, 目录名: 子树 } */
interface Tree {
  [name: string]: Tree | null
}

function mockDir(tree: Tree): ScanDirHandle {
  return {
    async *entries() {
      for (const [name, node] of Object.entries(tree)) {
        yield [name, { kind: node === null ? ('file' as const) : ('directory' as const) }]
      }
    },
    async getDirectoryHandle(name: string) {
      const node = tree[name]
      if (!node) throw new Error(`NotFound: ${name}`)
      return mockDir(node)
    }
  }
}

const TREE: Tree = {
  'top.ts': null,
  a: {
    'f1.ts': null,
    b: { 'f2.ts': null, c: { 'f3.ts': null } }
  },
  empty: {},
  node_modules: { 'index.js': null },
  '.git': { HEAD: null }
}

describe('scanDirHandleShallow', () => {
  it('根扫描：只列一层 —— 直接子文件 + 直接子目录（尾斜杠），均排序', async () => {
    const r = await scanDirHandleShallow(mockDir(TREE), '')
    expect(r.files).toEqual(['top.ts'])
    // 浏览无忽略目录过滤：node_modules 照常列出
    expect(r.dirs).toEqual(['a/', 'empty/', 'node_modules/'])
  })

  it('.git 不列出', async () => {
    const r = await scanDirHandleShallow(mockDir(TREE), '')
    expect(r.dirs).not.toContain('.git/')
    expect(r.files).not.toContain('.git/HEAD')
  })

  it('子目录扫描：带前缀，只列一层', async () => {
    const r = await scanDirHandleShallow(mockDir(TREE), 'a')
    expect(r.files).toEqual(['a/f1.ts'])
    expect(r.dirs).toEqual(['a/b/'])
    // 再进一层
    const deeper = await scanDirHandleShallow(mockDir(TREE), 'a/b')
    expect(deeper.files).toEqual(['a/b/f2.ts'])
    expect(deeper.dirs).toEqual(['a/b/c/'])
  })

  it('目录不存在返回空列表而非抛错', async () => {
    const r = await scanDirHandleShallow(mockDir(TREE), 'no/such/dir')
    expect(r).toEqual({ files: [], dirs: [] })
  })

  it('dir 越界（.. 段）返回空列表', async () => {
    const r = await scanDirHandleShallow(mockDir(TREE), '../x')
    expect(r).toEqual({ files: [], dirs: [] })
  })
})
