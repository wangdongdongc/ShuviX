/**
 * 按目录浅扫描（文件树懒加载的磁盘侧实现）。
 *
 * 浏览场景所见即磁盘所有：不做任何 .gitignore 过滤（gitignore 语义只留在搜索场景的
 * files.scan 全量接口）。唯一保留的过滤是 `.git`（既不列出也不进入）。
 * 用真实临时目录树验证，含符号链接语义（链接目录显示为目录但不递归，防环）。
 */
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { normalizeScanDir, scanDirShallow } from '../dirScan'

let root: string

/** 建一棵固定形状的目录树：
 *  top.ts, .env, .gitignore（内容存在但不生效 —— 浏览不过滤）
 *  a/f1.ts, a/b/f2.ts, a/b/c/f3.ts（深度链）
 *  empty/（空目录）
 *  node_modules/dep.js, node_modules/pkg/index.js（.gitignore 忽略，但浏览照列）
 *  .git/HEAD（永不出现）
 *  linkdir → a（符号链接目录：显示为目录但不递归）
 *  linkfile → top.ts（符号链接文件）
 *  broken → 不存在目标（悬空链接按文件处理）
 */
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'shuvix-dirscan-'))
  await mkdir(join(root, 'a/b/c'), { recursive: true })
  await mkdir(join(root, 'empty'))
  await mkdir(join(root, 'node_modules/pkg'), { recursive: true })
  await mkdir(join(root, '.git'))
  await writeFile(join(root, 'top.ts'), '')
  await writeFile(join(root, '.env'), '')
  await writeFile(join(root, 'a/f1.ts'), '')
  await writeFile(join(root, 'a/b/f2.ts'), '')
  await writeFile(join(root, 'a/b/c/f3.ts'), '')
  await writeFile(join(root, 'node_modules/dep.js'), '')
  await writeFile(join(root, 'node_modules/pkg/index.js'), '')
  await writeFile(join(root, '.git/HEAD'), '')
  await writeFile(join(root, '.gitignore'), 'node_modules/\n')
  // 符号链接：个别平台/权限下创建可能失败（Windows 需开发者模式），失败则相关用例降级跳过
  try {
    await symlink('a', join(root, 'linkdir'), 'dir')
    await symlink('top.ts', join(root, 'linkfile'), 'file')
    await symlink('no-such-target', join(root, 'broken'), 'file')
  } catch {
    /* 平台不支持 symlink —— 相关用例自行判空跳过 */
  }
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('normalizeScanDir', () => {
  it('归一合法相对路径', () => {
    expect(normalizeScanDir('')).toBe('')
    expect(normalizeScanDir('a')).toBe('a')
    expect(normalizeScanDir('./a')).toBe('a')
    expect(normalizeScanDir('a/')).toBe('a')
    expect(normalizeScanDir('a\\b')).toBe('a/b')
  })

  it('越界路径返回 null', () => {
    expect(normalizeScanDir('..')).toBeNull()
    expect(normalizeScanDir('a/../b')).toBeNull()
    expect(normalizeScanDir('/abs')).toBeNull()
    expect(normalizeScanDir('C:/x')).toBeNull()
  })
})

describe('scanDirShallow — files', () => {
  it('根扫描：只列直接子文件，排序，含隐藏文件', async () => {
    const { files } = await scanDirShallow(root, '')
    expect(files).toEqual([...files].sort())
    expect(files).toContain('top.ts')
    expect(files).toContain('.env')
    expect(files).toContain('.gitignore')
    // 只扫一层：子目录内的文件要展开对应目录才出现
    expect(files).not.toContain('a/f1.ts')
    expect(files).not.toContain('a/b/f2.ts')
    expect(files).not.toContain('a/b/c/f3.ts')
  })

  it('被 .gitignore 忽略的内容照常出现（浏览无 gitignore 过滤）', async () => {
    // 根层看不到 node_modules 内部；展开 node_modules 后其内容照常列出
    const rootScan = await scanDirShallow(root, '')
    expect(rootScan.files).not.toContain('node_modules/dep.js')
    expect(rootScan.dirs).toContain('node_modules/')
    const inner = await scanDirShallow(root, 'node_modules')
    expect(inner.files).toContain('node_modules/dep.js')
    expect(inner.dirs).toEqual(['node_modules/pkg/'])
    // 再进一层
    const pkg = await scanDirShallow(root, 'node_modules/pkg')
    expect(pkg.files).toEqual(['node_modules/pkg/index.js'])
  })

  it('.git 不列出', async () => {
    const { files, dirs } = await scanDirShallow(root, '')
    expect(files.some((f) => f.startsWith('.git/') || f === '.git')).toBe(false)
    expect(dirs).not.toContain('.git/')
  })

  it('子目录扫描：带前缀，只列一层', async () => {
    const { files, dirs } = await scanDirShallow(root, 'a')
    expect(files).toEqual(['a/f1.ts'])
    expect(dirs).toEqual(['a/b/'])
    // 再进一层
    const deeper = await scanDirShallow(root, 'a/b')
    expect(deeper.files).toEqual(['a/b/f2.ts'])
    expect(deeper.dirs).toEqual(['a/b/c/'])
  })
})

describe('scanDirShallow — dirs', () => {
  it('根扫描：直接子目录尾斜杠形式，含空目录，不含更深层', async () => {
    const { dirs } = await scanDirShallow(root, '')
    expect(dirs).toEqual([...dirs].sort())
    expect(dirs).toContain('a/')
    expect(dirs).toContain('empty/')
    expect(dirs).not.toContain('a/b/')
  })

  it('被 .gitignore 忽略的目录照常出现；.git 不出现', async () => {
    const { dirs } = await scanDirShallow(root, '')
    expect(dirs).toContain('node_modules/')
    expect(dirs).not.toContain('.git/')
  })

  it('子目录扫描：直接子目录带前缀', async () => {
    const { dirs } = await scanDirShallow(root, 'a')
    expect(dirs).toEqual(['a/b/'])
  })
})

describe('scanDirShallow — 符号链接', () => {
  it('链接目录显示为目录但不递归（防环）', async () => {
    const { files, dirs } = await scanDirShallow(root, '')
    if (!dirs.includes('linkdir/')) return // 平台不支持 symlink，降级跳过
    expect(dirs).toContain('linkdir/')
    // 不递归：linkdir/f1.ts 不应出现（目标 a/ 里的文件不从链接路径再列一遍）
    expect(files).not.toContain('linkdir/f1.ts')
    expect(files).not.toContain('linkdir/b/f2.ts')
  })

  it('链接文件按文件列出；悬空链接按文件处理', async () => {
    const { files, dirs } = await scanDirShallow(root, '')
    if (!dirs.includes('linkdir/')) return // 平台不支持 symlink
    expect(files).toContain('linkfile')
    expect(files).toContain('broken')
    expect(dirs).not.toContain('linkfile/')
    expect(dirs).not.toContain('broken/')
  })
})

describe('scanDirShallow — 容错', () => {
  it('目录不存在返回空列表而非抛错', async () => {
    const r = await scanDirShallow(root, 'no/such/dir')
    expect(r).toEqual({ files: [], dirs: [] })
  })

  it('dir 越界返回空列表', async () => {
    expect(await scanDirShallow(root, '../x')).toEqual({ files: [], dirs: [] })
    expect(await scanDirShallow(root, '/abs')).toEqual({ files: [], dirs: [] })
  })
})
