/**
 * 黑盒验收探针 —— 独立于既有三个测试文件，覆盖其未触及的规格边界。
 *
 * 只 import 公开导出（gitOps/diffOps/author/fsaFsClient/tool/help），不读实现。
 * 探针方向：racy-git 保护、diff 不含 untracked、init 幂等、log 默认 depth、
 * 多行 message subject、unstage 新增文件、组合分支流、FSA mock × checkout、tool 层 usage/help。
 */
import { describe, it, expect, afterEach } from 'vitest'
import * as nodeFs from 'node:fs'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import type { GitCache, GitEnv, GitFsClient } from '../env'
import {
  statusOp,
  logOp,
  addOp,
  unstageOp,
  commitOp,
  branchOp,
  checkoutOp,
  initOp
} from '../gitOps'
import { diffOp } from '../diffOps'
import { createGitTool } from '../tool'
import { buildGitHelp, GIT_HELP_TOPICS } from '../help'
import {
  createFsaFsClient,
  type FsaDirHandleLike,
  type FsaFileHandleLike,
  type FsaFileLike,
  type FsaWritableLike
} from '../fsaFsClient'

// ---------------------------------------------------------------------------
// fixture 辅助（与既有测试同惯例）
// ---------------------------------------------------------------------------

const dirs: string[] = []

afterEach(() => {
  for (const d of dirs.splice(0)) {
    nodeFs.rmSync(d, { recursive: true, force: true })
  }
})

function makeDir(): string {
  const d = nodeFs.mkdtempSync(join(tmpdir(), 'shuvix-gitaccept-'))
  dirs.push(d)
  return d
}

function git(cwd: string, args: string): string {
  return execSync(
    `git -c user.name=Tester -c user.email=t@example.com -c commit.gpgsign=false ${args}`,
    { cwd, encoding: 'utf8' }
  )
}

function makeRepo(): string {
  const d = makeDir()
  execSync('git init -b main', { cwd: d, stdio: 'ignore' })
  return d
}

function write(dir: string, rel: string, content: string): void {
  nodeFs.writeFileSync(join(dir, rel), content)
}

function read(dir: string, rel: string): string {
  return nodeFs.readFileSync(join(dir, rel), 'utf8')
}

function envFor(dir: string): GitEnv {
  return { fs: nodeFs as unknown as GitFsClient, dir }
}

function newCache(): GitCache {
  return {}
}

const AUTHOR = { authorName: 'Alice', authorEmail: 'alice@example.com' }

/**
 * 解析 log 输出为 subject 列表（行格式 `<7位oid> <YYYY-MM-DD> <author> — <subject>`）。
 * 断言落在 subject 上，避免随机 oid 恰好含 subject 子串导致的假绿/假红。
 */
function logSubjects(text: string): string[] {
  return text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const m = /^[0-9a-f]{7} \d{4}-\d{2}-\d{2} .+? — (.*)$/.exec(line)
      if (!m) throw new Error(`unexpected log line: ${line}`)
      return m[1]
    })
}

/**
 * racy-git fixture：全程 isomorphic 路径（add/commit 都走被测 op，索引 stat 由实现写入），
 * commit 后**立即**（不 sleep）同尺寸改写 —— 命中 git stat 捷径的秒粒度盲区。
 */
async function makeRacyRepo(): Promise<{ d: string; env: GitEnv; cache: GitCache }> {
  const d = makeRepo()
  const env = envFor(d)
  const cache = newCache()
  write(d, 'a.txt', 'aaaa\n')
  await addOp(env, cache, { paths: ['a.txt'] })
  const c = await commitOp(env, cache, { message: 'base', ...AUTHOR })
  expect(c.text).toMatch(/^\[main [0-9a-f]{7}\] base/)
  write(d, 'a.txt', 'bbbb\n') // 同尺寸（5 字节）即时改写
  return { d, env, cache }
}

// ---------------------------------------------------------------------------
// racy-git 保护（实现方声称已修复 statusMatrix 的 stat 捷径误判）
// ---------------------------------------------------------------------------

describe('acceptance - racy-git 保护', () => {
  it('status：commit 后立即同尺寸改写 → 必须报 " M"（3 轮消除秒边界运气）', async () => {
    for (let i = 0; i < 3; i++) {
      const { env, cache } = await makeRacyRepo()
      const out = await statusOp(env, cache, {})
      expect(out.text ?? '').toMatch(/^ M a\.txt$/m)
      expect(out.details?.fileCount).toBe(1)
    }
  })

  it('add ["."]：commit 后立即同尺寸改写 → 必须暂存该变更（系统 git 验证）', async () => {
    for (let i = 0; i < 3; i++) {
      const { d, env, cache } = await makeRacyRepo()
      const out = await addOp(env, cache, { paths: ['.'] })
      expect(out.text).toContain('Staged 1 file(s):')
      expect(out.details?.fileCount).toBe(1)
      expect(git(d, 'status --porcelain')).toMatch(/^M {2}a\.txt$/m)
    }
  })

  it('diff：commit 后立即同尺寸改写 → 必须产出 -aaaa/+bbbb hunk', async () => {
    for (let i = 0; i < 3; i++) {
      const { env, cache } = await makeRacyRepo()
      const out = await diffOp(env, cache, {})
      const text = out.text ?? ''
      expect(text).toContain('diff --git a/a.txt b/a.txt')
      expect(text).toMatch(/^-aaaa$/m)
      expect(text).toMatch(/^\+bbbb$/m)
      expect(out.details?.fileCount).toBe(1)
    }
  })
})

// ---------------------------------------------------------------------------
// diff：默认模式与 from-无-to 模式均不含 untracked（规格明确，既有测试未覆盖）
// ---------------------------------------------------------------------------

describe('acceptance - diff 不含 untracked', () => {
  it('默认（工作区 vs 索引）与 from 缺省 to（commit vs 工作区）都不含未跟踪文件', async () => {
    const d = makeRepo()
    write(d, 'a.txt', 'one\n')
    git(d, 'add .')
    git(d, 'commit -m c1')
    const oid1 = git(d, 'rev-parse HEAD').trim()
    write(d, 'a.txt', 'two\n') // 已跟踪的修改
    write(d, 'untracked.txt', 'ghost\n') // 未跟踪，不得出现

    const def = await diffOp(envFor(d), newCache(), {})
    expect(def.text).toContain('diff --git a/a.txt b/a.txt')
    expect(def.text).not.toContain('untracked.txt')
    expect(def.details?.fileCount).toBe(1)

    const fromWt = await diffOp(envFor(d), newCache(), { from: oid1 })
    expect(fromWt.text).toMatch(/^\+two$/m)
    expect(fromWt.text).not.toContain('untracked.txt')
    expect(fromWt.details?.fileCount).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// init 幂等（规格明确，既有测试只测了空目录）
// ---------------------------------------------------------------------------

describe('acceptance - init 幂等', () => {
  it('对已有提交的仓库重复 init：不报错、HEAD/分支/历史无损', async () => {
    const d = makeRepo()
    write(d, 'a.txt', 'v1\n')
    git(d, 'add .')
    git(d, 'commit -m keep')
    const head = git(d, 'rev-parse HEAD').trim()
    const out = await initOp(envFor(d), newCache(), {})
    expect(out.text ?? '').not.toMatch(/^Error: /)
    expect(git(d, 'rev-parse HEAD').trim()).toBe(head)
    expect(git(d, 'branch --show-current').trim()).toBe('main')
    expect(git(d, 'log --format=%s').trim()).toBe('keep')
    expect(git(d, 'status --porcelain').trim()).toBe('')
  })
})

// ---------------------------------------------------------------------------
// log：depth 默认 20（规格明确，既有测试只测了显式 depth）
// ---------------------------------------------------------------------------

describe('acceptance - log 默认 depth 20', () => {
  it('22 个 commit 时默认只列最近 20 条，新→旧', async () => {
    const d = makeRepo()
    const env = envFor(d)
    const cache = newCache()
    for (let i = 1; i <= 22; i++) {
      write(d, 'f.txt', `v${i}\n`)
      await addOp(env, cache, { paths: ['f.txt'] })
      await commitOp(env, cache, { message: `c${i}`, ...AUTHOR })
    }
    const out = await logOp(env, cache, {})
    const subjects = logSubjects(out.text ?? '')
    expect(subjects).toHaveLength(20)
    expect(subjects[0]).toBe('c22')
    expect(subjects[19]).toBe('c3')
    expect(out.details?.fileCount).toBe(20)
  })
})

// ---------------------------------------------------------------------------
// commit：多行 message 只取 subject 进 [branch 7oid] 行
// ---------------------------------------------------------------------------

describe('acceptance - commit 多行 message', () => {
  it('输出首行为 [main <7oid>] <首行 subject>，不带正文', async () => {
    const d = makeRepo()
    write(d, 'f.txt', 'x\n')
    git(d, 'add .')
    const out = await commitOp(envFor(d), newCache(), {
      message: 'feat: subject line\n\nbody paragraph that must not leak',
      ...AUTHOR
    })
    const firstLine = (out.text ?? '').split('\n')[0]
    expect(firstLine).toMatch(/^\[main [0-9a-f]{7}\] feat: subject line$/)
    // 完整 message 落入 commit 对象（系统 git 验证）
    expect(git(d, 'log -1 --format=%B')).toContain('body paragraph that must not leak')
  })
})

// ---------------------------------------------------------------------------
// unstage：新增文件（A 态）回到 untracked，工作区不动
// ---------------------------------------------------------------------------

describe('acceptance - unstage 新增文件', () => {
  it('add 的新文件 unstage 后回到 ??，文件内容仍在', async () => {
    const d = makeRepo()
    write(d, 'base.txt', 'b\n')
    git(d, 'add .')
    git(d, 'commit -m base')
    write(d, 'n.txt', 'new\n')
    git(d, 'add n.txt')
    const out = await unstageOp(envFor(d), newCache(), { paths: ['n.txt'] })
    expect(out.text).toContain('Unstaged 1 file(s):')
    expect(git(d, 'status --porcelain')).toMatch(/^\?\? n\.txt$/m)
    expect(read(d, 'n.txt')).toBe('new\n')
  })
})

// ---------------------------------------------------------------------------
// 组合流：branch → 改文件 → commit → checkout 回 main → log 隔离
// ---------------------------------------------------------------------------

describe('acceptance - 组合分支流', () => {
  it('全程 isomorphic 路径：分支提交互不串史，工作区内容随切换还原', async () => {
    const d = makeRepo()
    const env = envFor(d)
    const cache = newCache()
    write(d, 'a.txt', 'v1\n')
    await addOp(env, cache, { paths: ['a.txt'] })
    await commitOp(env, cache, { message: 'c1', ...AUTHOR })

    const br = await branchOp(env, cache, { name: 'feature' })
    expect(br.text).toContain("Switched to a new branch 'feature'")
    write(d, 'a.txt', 'v2\n')
    await addOp(env, cache, { paths: ['a.txt'] })
    await commitOp(env, cache, { message: 'c2', ...AUTHOR })

    const featLog = await logOp(env, cache, {})
    expect(logSubjects(featLog.text ?? '')).toEqual(['c2', 'c1'])

    const back = await checkoutOp(env, cache, { ref: 'main' })
    expect(back.text).toContain("Switched to branch 'main'")
    expect(read(d, 'a.txt')).toBe('v1\n')
    expect(git(d, 'branch --show-current').trim()).toBe('main')

    const mainLog = await logOp(env, cache, {})
    expect(logSubjects(mainLog.text ?? '')).toEqual(['c1'])

    const featLog2 = await logOp(env, cache, { ref: 'feature' })
    expect(logSubjects(featLog2.text ?? '')).toEqual(['c2', 'c1'])
  })
})

// ---------------------------------------------------------------------------
// fsaFsClient × checkout：内存 mock 句柄树上切分支（写/删/缓存失效的真实 churn）
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

describe('acceptance - fsaFsClient × 分支切换（纯内存）', () => {
  it('init → 两分支各一提交 → checkout 来回切，内容正确、状态干净', async () => {
    const client = createFsaFsClient(dirHandleFor({ kind: 'directory', children: new Map() }))
    const env: GitEnv = { fs: client, dir: '/' }
    const cache: GitCache = {}

    await initOp(env, cache, {})
    await client.promises.writeFile('/a.txt', 'v1\n', 'utf8')
    await addOp(env, cache, { paths: ['a.txt'] })
    const c1 = await commitOp(env, cache, { message: 'c1', ...AUTHOR })
    expect(c1.text).toMatch(/^\[main [0-9a-f]{7}\] c1/)

    const br = await branchOp(env, cache, { name: 'feature' })
    expect(br.text).toContain("Switched to a new branch 'feature'")
    await client.promises.writeFile('/a.txt', 'v2\n', 'utf8')
    await addOp(env, cache, { paths: ['a.txt'] })
    const c2 = await commitOp(env, cache, { message: 'c2', ...AUTHOR })
    expect(c2.text).toMatch(/^\[feature [0-9a-f]{7}\] c2/)

    const back = await checkoutOp(env, cache, { ref: 'main' })
    expect(back.text ?? '').not.toMatch(/^Error: /)
    expect(await client.promises.readFile('/a.txt', 'utf8')).toBe('v1\n')

    const fwd = await checkoutOp(env, cache, { ref: 'feature' })
    expect(fwd.text ?? '').not.toMatch(/^Error: /)
    expect(await client.promises.readFile('/a.txt', 'utf8')).toBe('v2\n')

    const st = await statusOp(env, cache, {})
    expect(st.text).toContain('working tree clean')
    expect(st.details?.fileCount).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// tool 层：usage 回显 + help
// ---------------------------------------------------------------------------

function toolTextOf(result: { content: { type: string }[] }): string {
  return result.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n')
}

describe('acceptance - tool 层', () => {
  it('缺必选参数（show 无 ref）→ 不抛异常，回显该 action 的 usage', async () => {
    const d = makeRepo()
    write(d, 'a.txt', 'v1\n')
    git(d, 'add .')
    git(d, 'commit -m c1')
    const tool = createGitTool({ getEnv: () => envFor(d) })
    const result = await tool.execute('t1', { action: 'show' })
    const text = toolTextOf(result)
    expect(text).toContain('show(ref)')

    const result2 = await tool.execute('t2', { action: 'add' })
    expect(toolTextOf(result2)).toContain('add(paths: string[])')
  })

  it('未知 action → 不抛异常，回错误/用法提示', async () => {
    const d = makeRepo()
    const tool = createGitTool({ getEnv: () => envFor(d) })
    const result = await tool.execute('t3', { action: 'frobnicate' } as never)
    expect(toolTextOf(result)).toMatch(/error|unknown|usage|help/i)
  })

  it('help：全文含全部主题章节；topic 只回该章节', async () => {
    const d = makeRepo()
    const tool = createGitTool({ getEnv: () => envFor(d) })
    const full = toolTextOf(await tool.execute('t4', { action: 'help' }))
    for (const topic of GIT_HELP_TOPICS) {
      expect(full.toLowerCase()).toContain(topic)
    }
    expect(full).toBe(buildGitHelp())
    const single = toolTextOf(await tool.execute('t5', { action: 'help', topic: 'diff' }))
    expect(single).toBe(buildGitHelp('diff'))
    expect(single.length).toBeLessThan(full.length)
  })
})
