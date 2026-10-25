/**
 * gitOps 单元测试 —— TDD 先行：实现当前为桩（throw 'not implemented'），本文件此刻应全红。
 *
 * 惯例（参考 apps/desktop ls.test.ts）：
 * - 真实文件系统：os.tmpdir() 下 mkdtempSync 建独立目录，afterEach 递归清理
 * - 系统 git 造 fixture / 验证结果（双向互操作：isomorphic-git 写 ↔ 系统 git 读，反之亦然）
 * - 易碎值（oid/日期）用正则断言格式
 *
 * 文件末尾两组给宿主自动提交（会话产物的版本，apps/desktop services/artifacts/history.ts）用的入口：
 * - addOp 的 `details.paths`：哪几个文件进了索引（排好序、含删除、`.` 展开、干净时为空）—— 提交标题照它写；
 * - readCommitChanges：结构化的 `git log --name-status`（新的在前、根提交全 A 带 blob oid、作者时间是整秒的
 *   毫秒、depth 截断、trailer 原样）；unborn HEAD → []，别的错误（坏 ref、缺对象）**照抛**，不吞成 []。
 *
 * 再往后是给回复里 ```artifact 引用钉版本用的三个 blob 入口（apps/desktop services/artifacts/pins.ts）：
 * - GB-1 writeBlobText：oid 与系统 `git hash-object --stdin` 一致、重复写幂等、不进提交、工作区状态不变；
 * - GB-2 readBlobText：unicode / CRLF / 空串原样往返；没有的 oid、tree / commit 的 oid → null；
 * - GB-3 hashBlobText：与 writeBlobText 交回的同一个值，且不写对象库。
 */
import { describe, it, expect, afterEach } from 'vitest'
import * as nodeFs from 'node:fs'
import { execFileSync, execSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import type { GitCache, GitEnv, GitFsClient, GitOpOutput } from '../env'
import {
  statusOp,
  logOp,
  showOp,
  addOp,
  unstageOp,
  commitOp,
  branchOp,
  checkoutOp,
  restoreOp,
  initOp,
  readCommitChanges,
  writeBlobText,
  readBlobText,
  hashBlobText
} from '../gitOps'
import { resolveAuthor, AUTHOR_MISSING_MESSAGE } from '../author'

// ---------------------------------------------------------------------------
// fixture 辅助
// ---------------------------------------------------------------------------

const dirs: string[] = []

afterEach(() => {
  for (const d of dirs.splice(0)) {
    nodeFs.rmSync(d, { recursive: true, force: true })
  }
})

function makeDir(): string {
  const d = nodeFs.mkdtempSync(join(tmpdir(), 'shuvix-gitops-'))
  dirs.push(d)
  return d
}

/** 系统 git（固定测试身份、禁 gpg 签名，避免宿主机全局配置干扰） */
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

/** 业务失败约定：不抛异常，text 以 "Error: " 开头且 details.error 置错误消息 */
function expectBizError(out: GitOpOutput, contains?: string): void {
  expect(out.text ?? '').toMatch(/^Error: /)
  expect(out.details?.error).toBeTruthy()
  if (contains) expect(out.text).toContain(contains)
}

/** 含全部 8 种码位的 status fixture 仓库 */
function makeStatusRepo(): string {
  const d = makeRepo()
  nodeFs.mkdirSync(join(d, 'sub'))
  write(d, 'a.txt', 'a1\n')
  write(d, 'b.txt', 'b1\n')
  write(d, 'c.txt', 'c1\n')
  write(d, 'd.txt', 'd1\n')
  write(d, 'sub/e.txt', 'e1\n')
  git(d, 'add .')
  git(d, 'commit -m base')
  write(d, 'u.txt', 'u\n') // ?? untracked
  write(d, 'a.txt', 'a2\n') // " M" 修改未暂存
  write(d, 'b.txt', 'b2\n')
  git(d, 'add b.txt') // "M " 修改已暂存
  write(d, 'c.txt', 'c2\n')
  git(d, 'add c.txt')
  write(d, 'c.txt', 'c3\n') // "MM" 已暂存后工作区又改
  write(d, 'n.txt', 'n\n')
  git(d, 'add n.txt') // "A " 新增已暂存
  git(d, 'rm -q d.txt') // "D " 删除已暂存
  nodeFs.rmSync(join(d, 'sub/e.txt')) // " D" 工作区删除未暂存
  return d
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

describe('statusOp', () => {
  it('干净仓库：On branch main + working tree clean，fileCount 0', async () => {
    const d = makeRepo()
    write(d, 'a.txt', 'v1\n')
    git(d, 'add .')
    git(d, 'commit -m c1')
    const out = await statusOp(envFor(d), newCache(), {})
    const text = out.text ?? ''
    expect(text.split('\n')[0]).toBe('On branch main')
    expect(text).toContain('nothing to commit, working tree clean')
    expect(out.details?.fileCount).toBe(0)
  })

  it('八种码位各归其位（??/ M/M / MM/A /D / D），首行 On branch main', async () => {
    const d = makeStatusRepo()
    const out = await statusOp(envFor(d), newCache(), {})
    const text = out.text ?? ''
    expect(text.split('\n')[0]).toBe('On branch main')
    expect(text).toMatch(/^\?\? u\.txt$/m)
    expect(text).toMatch(/^ M a\.txt$/m)
    expect(text).toMatch(/^M {2}b\.txt$/m)
    expect(text).toMatch(/^MM c\.txt$/m)
    expect(text).toMatch(/^A {2}n\.txt$/m)
    expect(text).toMatch(/^D {2}d\.txt$/m)
    expect(text).toMatch(/^ D sub\/e\.txt$/m)
    expect(out.details?.fileCount).toBe(7)
  })

  it('paths 过滤单个文件：只统计给定路径', async () => {
    const d = makeStatusRepo()
    const out = await statusOp(envFor(d), newCache(), { paths: ['a.txt'] })
    const text = out.text ?? ''
    expect(text).toMatch(/^ M a\.txt$/m)
    expect(text).not.toContain('u.txt')
    expect(text).not.toContain('b.txt')
    expect(out.details?.fileCount).toBe(1)
  })

  it('paths 过滤目录前缀：只统计目录下的变更', async () => {
    const d = makeStatusRepo()
    const out = await statusOp(envFor(d), newCache(), { paths: ['sub'] })
    const text = out.text ?? ''
    expect(text).toMatch(/^ D sub\/e\.txt$/m)
    expect(text).not.toContain('a.txt')
    expect(out.details?.fileCount).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------

describe('addOp', () => {
  it('暂存普通文件，系统 git 读到 "A " 索引态', async () => {
    const d = makeRepo()
    write(d, 'f.txt', 'hello\n')
    const out = await addOp(envFor(d), newCache(), { paths: ['f.txt'] })
    expect(out.text).toContain('Staged 1 file(s):')
    expect(out.text).toContain('f.txt')
    expect(out.details?.fileCount).toBe(1)
    expect(git(d, 'status --porcelain')).toMatch(/^A {2}f\.txt$/m)
  })

  it('paths:["."] 混合展开：新增+修改+删除全部进入索引，无遗留未暂存项', async () => {
    const d = makeRepo()
    write(d, 'a.txt', 'v1\n')
    write(d, 'b.txt', 'v1\n')
    git(d, 'add .')
    git(d, 'commit -m base')
    write(d, 'a.txt', 'v2\n') // 修改
    nodeFs.rmSync(join(d, 'b.txt')) // 工作区删除
    write(d, 'c.txt', 'new\n') // 新增
    const out = await addOp(envFor(d), newCache(), { paths: ['.'] })
    expect(out.details?.fileCount).toBe(3)
    const text = out.text ?? ''
    expect(text).toContain('Staged 3 file(s):')
    // 按字母序列出
    expect(text.indexOf('a.txt')).toBeGreaterThan(-1)
    expect(text.indexOf('a.txt')).toBeLessThan(text.indexOf('b.txt'))
    expect(text.indexOf('b.txt')).toBeLessThan(text.indexOf('c.txt'))
    // 系统 git 验证索引态：全部已暂存（含删除），无未暂存变更
    const porcelain = git(d, 'status --porcelain')
    expect(porcelain).toMatch(/^M {2}a\.txt$/m)
    expect(porcelain).toMatch(/^D {2}b\.txt$/m)
    expect(porcelain).toMatch(/^A {2}c\.txt$/m)
    for (const line of porcelain.split('\n').filter(Boolean)) {
      expect(line[1]).toBe(' ')
    }
  })

  it('路径既不在工作区也不在索引 → 业务错误', async () => {
    const d = makeRepo()
    write(d, 'a.txt', 'v1\n')
    git(d, 'add .')
    git(d, 'commit -m base')
    const out = await addOp(envFor(d), newCache(), { paths: ['ghost.txt'] })
    expectBizError(out)
  })
})

// ---------------------------------------------------------------------------
// unstage
// ---------------------------------------------------------------------------

describe('unstageOp', () => {
  it('add 后 unstage：索引回到 HEAD 版本，工作区不动', async () => {
    const d = makeRepo()
    write(d, 'a.txt', 'v1\n')
    git(d, 'add .')
    git(d, 'commit -m base')
    write(d, 'a.txt', 'v2\n')
    git(d, 'add a.txt') // 暂存为 "M "
    const out = await unstageOp(envFor(d), newCache(), { paths: ['a.txt'] })
    expect(out.text).toContain('Unstaged 1 file(s):')
    expect(out.text).toContain('a.txt')
    expect(out.details?.fileCount).toBe(1)
    // 系统 git 验证：回到未暂存的 " M"
    expect(git(d, 'status --porcelain')).toMatch(/^ M a\.txt$/m)
    // 工作区内容未被触碰
    expect(read(d, 'a.txt')).toBe('v2\n')
  })
})

// ---------------------------------------------------------------------------
// commit
// ---------------------------------------------------------------------------

describe('commitOp', () => {
  it('传参 author：系统 git 读到署名；输出 [main <7位oid>] subject；details.oid = rev-parse HEAD', async () => {
    const d = makeRepo()
    write(d, 'f.txt', 'hi\n')
    git(d, 'add f.txt')
    const out = await commitOp(envFor(d), newCache(), {
      message: 'feat: hello',
      authorName: 'Alice',
      authorEmail: 'alice@example.com'
    })
    expect(out.text).toMatch(/^\[main [0-9a-f]{7}\] feat: hello/)
    const head = git(d, 'rev-parse HEAD').trim()
    expect(out.details?.oid).toBe(head)
    expect(out.details?.ref).toBe('main')
    expect(git(d, 'log -1 --format=%an,%ae').trim()).toBe('Alice,alice@example.com')
  })

  it('.git/config 配置 user.name/user.email 后不传参可提交', async () => {
    const d = makeRepo()
    git(d, 'config user.name Confy')
    git(d, 'config user.email confy@example.com')
    write(d, 'f.txt', 'hi\n')
    git(d, 'add f.txt')
    const out = await commitOp(envFor(d), newCache(), { message: 'by config' })
    expect(out.text).toMatch(/^\[main [0-9a-f]{7}\] by config/)
    expect(git(d, 'log -1 --format=%an,%ae').trim()).toBe('Confy,confy@example.com')
  })

  it('索引与 HEAD 一致时 → 业务错误 nothing to commit', async () => {
    const d = makeRepo()
    write(d, 'f.txt', 'hi\n')
    git(d, 'add .')
    git(d, 'commit -m base')
    const out = await commitOp(envFor(d), newCache(), {
      message: 'empty',
      authorName: 'Alice',
      authorEmail: 'alice@example.com'
    })
    expectBizError(out, 'nothing to commit')
  })

  it('author 全缺（无参数/无 config/无 fallback）→ 业务错误 AUTHOR_MISSING_MESSAGE', async () => {
    const d = makeRepo()
    write(d, 'f.txt', 'hi\n')
    git(d, 'add f.txt')
    const out = await commitOp(envFor(d), newCache(), { message: 'x' })
    expectBizError(out)
    expect(out.text).toContain(AUTHOR_MISSING_MESSAGE)
    expect(String(out.details?.error)).toContain(AUTHOR_MISSING_MESSAGE)
  })
})

// ---------------------------------------------------------------------------
// resolveAuthor 四级解析链
// ---------------------------------------------------------------------------

describe('resolveAuthor', () => {
  it('① 参数优先：name+email 齐备时覆盖 config', async () => {
    const d = makeRepo()
    git(d, 'config user.name Confy')
    git(d, 'config user.email confy@example.com')
    const author = await resolveAuthor(envFor(d), newCache(), {
      authorName: 'Alice',
      authorEmail: 'alice@example.com'
    })
    expect(author).toEqual({ name: 'Alice', email: 'alice@example.com' })
  })

  it('② 参数只给 name 不算命中，降级到 config', async () => {
    const d = makeRepo()
    git(d, 'config user.name Confy')
    git(d, 'config user.email confy@example.com')
    const author = await resolveAuthor(envFor(d), newCache(), { authorName: 'OnlyName' })
    expect(author).toEqual({ name: 'Confy', email: 'confy@example.com' })
  })

  it('③ config 无、注入 resolveAuthorFallback 时用 fallback', async () => {
    const d = makeRepo()
    const env: GitEnv = {
      ...envFor(d),
      resolveAuthorFallback: async () => ({ name: 'Fallback', email: 'fb@example.com' })
    }
    const author = await resolveAuthor(env, newCache(), {})
    expect(author).toEqual({ name: 'Fallback', email: 'fb@example.com' })
  })

  it('④ 全缺返回 undefined（不抛错）', async () => {
    const d = makeRepo()
    const author = await resolveAuthor(envFor(d), newCache(), {})
    expect(author).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// log
// ---------------------------------------------------------------------------

/** 3 个 commit：c1(a.txt) → [branch dev] → c2(b.txt) → c3(a.txt) */
function makeLogRepo(): string {
  const d = makeRepo()
  write(d, 'a.txt', '1\n')
  git(d, 'add .')
  git(d, 'commit -m c1')
  git(d, 'branch dev')
  write(d, 'b.txt', '1\n')
  git(d, 'add .')
  git(d, 'commit -m c2')
  write(d, 'a.txt', '2\n')
  git(d, 'add .')
  git(d, 'commit -m c3')
  return d
}

/**
 * 解析 log 输出为 subject 列表（行格式 `<7位oid> <YYYY-MM-DD> <author> — <subject>`）。
 *
 * 断言必须落在 subject 上：缩写 oid 是随机 hex，对整段文本做子串断言会偶发误判
 * （如 oid `43e5c2e` 含 "c2"，令 `not.toContain('c2')` 假红；正向断言则可能假绿）。
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

describe('logOp', () => {
  it('默认 HEAD 全量，新→旧，行格式 <7位oid> <YYYY-MM-DD> <author> — <subject>', async () => {
    const d = makeLogRepo()
    const out = await logOp(envFor(d), newCache(), {})
    const lines = (out.text ?? '').trim().split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toMatch(/^[0-9a-f]{7} \d{4}-\d{2}-\d{2} Tester — c3$/)
    expect(lines[1]).toMatch(/^[0-9a-f]{7} \d{4}-\d{2}-\d{2} Tester — c2$/)
    expect(lines[2]).toMatch(/^[0-9a-f]{7} \d{4}-\d{2}-\d{2} Tester — c1$/)
    expect(out.details?.fileCount).toBe(3)
  })

  it('depth 截断为最近 N 条', async () => {
    const d = makeLogRepo()
    const out = await logOp(envFor(d), newCache(), { depth: 2 })
    expect(logSubjects(out.text ?? '')).toEqual(['c3', 'c2'])
    expect(out.details?.fileCount).toBe(2)
  })

  it('ref 指定分支：只列该分支可达的提交', async () => {
    const d = makeLogRepo()
    const out = await logOp(envFor(d), newCache(), { ref: 'dev' })
    expect(logSubjects(out.text ?? '')).toEqual(['c1'])
    expect(out.details?.ref).toBe('dev')
  })

  it('path 过滤：只列改动该文件的提交', async () => {
    const d = makeLogRepo()
    const out = await logOp(envFor(d), newCache(), { path: 'a.txt' })
    // 只断言 subject：整段文本含随机 oid，可能碰巧包含 "c2"
    expect(logSubjects(out.text ?? '')).toEqual(['c3', 'c1'])
    expect(out.details?.fileCount).toBe(2)
  })

  it('空仓库（无任何 commit）→ 业务错误', async () => {
    const d = makeRepo()
    const out = await logOp(envFor(d), newCache(), {})
    expectBizError(out)
  })

  it('不存在的 ref → 业务错误', async () => {
    const d = makeLogRepo()
    const out = await logOp(envFor(d), newCache(), { ref: 'no-such-ref' })
    expectBizError(out)
  })
})

// ---------------------------------------------------------------------------
// show
// ---------------------------------------------------------------------------

describe('showOp', () => {
  it('普通 commit：commit/Author/Date/message + name-status（M/A/D 各一）', async () => {
    const d = makeRepo()
    write(d, 'a.txt', 'v1\n')
    write(d, 'b.txt', 'b\n')
    git(d, 'add .')
    git(d, 'commit -m c1')
    write(d, 'a.txt', 'v2\n')
    write(d, 'c.txt', 'c\n')
    git(d, 'add a.txt c.txt')
    git(d, 'rm -q b.txt')
    git(d, 'commit -m c2')
    const head = git(d, 'rev-parse HEAD').trim()
    const out = await showOp(envFor(d), newCache(), { ref: 'HEAD' })
    const text = out.text ?? ''
    expect(text).toMatch(/^commit [0-9a-f]{40}$/m)
    expect(text).toContain(`commit ${head}`)
    expect(text).toMatch(/^Author: .*Tester.*t@example\.com/m)
    expect(text).toMatch(/^Date: \d{4}-\d{2}-\d{2}T/m)
    // 整行匹配 message：40 位 oid 也可能含 "c2"
    expect(text).toMatch(/^c2$/m)
    expect(text).toMatch(/^M a\.txt$/m)
    expect(text).toMatch(/^A c\.txt$/m)
    expect(text).toMatch(/^D b\.txt$/m)
    expect(out.details?.oid).toBe(head)
    expect(out.details?.ref).toBe('HEAD')
    expect(out.details?.fileCount).toBe(3)
  })

  it('根 commit：与空树对比，全部为 A', async () => {
    const d = makeRepo()
    write(d, 'a.txt', 'v1\n')
    write(d, 'b.txt', 'b\n')
    git(d, 'add .')
    git(d, 'commit -m root')
    const out = await showOp(envFor(d), newCache(), { ref: 'HEAD' })
    const text = out.text ?? ''
    expect(text).toMatch(/^A a\.txt$/m)
    expect(text).toMatch(/^A b\.txt$/m)
    expect(text).not.toMatch(/^[MD] /m)
    expect(out.details?.fileCount).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// branch
// ---------------------------------------------------------------------------

describe('branchOp', () => {
  it('无 name：列出分支，当前分支前缀 "* "、其余两空格', async () => {
    const d = makeRepo()
    write(d, 'a.txt', 'v1\n')
    git(d, 'add .')
    git(d, 'commit -m c1')
    git(d, 'branch dev')
    const out = await branchOp(envFor(d), newCache(), {})
    const text = out.text ?? ''
    expect(text).toMatch(/^\* main$/m)
    expect(text).toMatch(/^ {2}dev$/m)
    expect(out.details?.fileCount).toBe(2)
    expect(out.details?.ref).toBe('main')
  })

  it('有 name：创建并切换，系统 git 确认当前分支', async () => {
    const d = makeRepo()
    write(d, 'a.txt', 'v1\n')
    git(d, 'add .')
    git(d, 'commit -m c1')
    const out = await branchOp(envFor(d), newCache(), { name: 'feature' })
    expect(out.text).toContain("Switched to a new branch 'feature'")
    expect(out.details?.ref).toBe('feature')
    expect(git(d, 'branch --show-current').trim()).toBe('feature')
  })

  it('已存在同名分支 → 业务错误', async () => {
    const d = makeRepo()
    write(d, 'a.txt', 'v1\n')
    git(d, 'add .')
    git(d, 'commit -m c1')
    git(d, 'branch dev')
    const out = await branchOp(envFor(d), newCache(), { name: 'dev' })
    expectBizError(out)
  })

  it('delete:true 删除非当前分支', async () => {
    const d = makeRepo()
    write(d, 'a.txt', 'v1\n')
    git(d, 'add .')
    git(d, 'commit -m c1')
    git(d, 'branch dev')
    const out = await branchOp(envFor(d), newCache(), { name: 'dev', delete: true })
    expect(out.text).toContain('Deleted branch dev')
    expect(out.details?.ref).toBe('dev')
    expect(git(d, 'branch --list dev').trim()).toBe('')
  })

  it('删除当前分支 → 业务错误', async () => {
    const d = makeRepo()
    write(d, 'a.txt', 'v1\n')
    git(d, 'add .')
    git(d, 'commit -m c1')
    const out = await branchOp(envFor(d), newCache(), { name: 'main', delete: true })
    expectBizError(out)
  })
})

// ---------------------------------------------------------------------------
// checkout
// ---------------------------------------------------------------------------

/** main: a.txt='v1'；feature: a.txt='v2'；当前在 main */
function makeTwoBranchRepo(): string {
  const d = makeRepo()
  write(d, 'a.txt', 'v1\n')
  git(d, 'add .')
  git(d, 'commit -m c1')
  git(d, 'checkout -q -b feature')
  write(d, 'a.txt', 'v2\n')
  git(d, 'add .')
  git(d, 'commit -m c2')
  git(d, 'checkout -q main')
  return d
}

describe('checkoutOp', () => {
  it('干净切换：工作区文件内容随分支变化，可来回切', async () => {
    const d = makeTwoBranchRepo()
    const env = envFor(d)
    const cache = newCache()
    const out = await checkoutOp(env, cache, { ref: 'feature' })
    expect(out.text).toContain("Switched to branch 'feature'")
    expect(out.details?.ref).toBe('feature')
    expect(git(d, 'branch --show-current').trim()).toBe('feature')
    expect(read(d, 'a.txt')).toBe('v2\n')
    const back = await checkoutOp(env, cache, { ref: 'main' })
    expect(back.text).toContain("Switched to branch 'main'")
    expect(read(d, 'a.txt')).toBe('v1\n')
  })

  it('脏工作区冲突 → 业务错误：列出冲突文件、提示 force、工作区未被改动', async () => {
    const d = makeTwoBranchRepo()
    write(d, 'a.txt', 'local\n') // 未提交的本地修改，与 feature 冲突
    const out = await checkoutOp(envFor(d), newCache(), { ref: 'feature' })
    expectBizError(out)
    expect(out.text).toContain('a.txt')
    expect(out.text).toContain('force')
    // 工作区与 HEAD 均未被改动
    expect(read(d, 'a.txt')).toBe('local\n')
    expect(git(d, 'branch --show-current').trim()).toBe('main')
  })

  it('force:true 强制覆盖本地修改并切换', async () => {
    const d = makeTwoBranchRepo()
    write(d, 'a.txt', 'local\n')
    const out = await checkoutOp(envFor(d), newCache(), { ref: 'feature', force: true })
    expect(out.text).toContain("Switched to branch 'feature'")
    expect(git(d, 'branch --show-current').trim()).toBe('feature')
    expect(read(d, 'a.txt')).toBe('v2\n')
  })
})

// ---------------------------------------------------------------------------
// restore
// ---------------------------------------------------------------------------

describe('restoreOp', () => {
  it('默认 HEAD：修改后 restore 还原内容', async () => {
    const d = makeRepo()
    write(d, 'a.txt', 'v1\n')
    git(d, 'add .')
    git(d, 'commit -m c1')
    write(d, 'a.txt', 'dirty\n')
    const out = await restoreOp(envFor(d), newCache(), { paths: ['a.txt'] })
    expect(out.text).toContain('Restored 1 file(s) from HEAD:')
    expect(out.text).toContain('a.txt')
    expect(out.details?.fileCount).toBe(1)
    expect(read(d, 'a.txt')).toBe('v1\n')
  })

  it('restore 自其它 ref：内容取自该 ref，HEAD 不动', async () => {
    const d = makeRepo()
    write(d, 'a.txt', 'v1\n')
    git(d, 'add .')
    git(d, 'commit -m c1')
    const oid1 = git(d, 'rev-parse HEAD').trim()
    write(d, 'a.txt', 'v2\n')
    git(d, 'add .')
    git(d, 'commit -m c2')
    const oid2 = git(d, 'rev-parse HEAD').trim()
    const out = await restoreOp(envFor(d), newCache(), { paths: ['a.txt'], ref: oid1 })
    expect(out.text).toContain('Restored 1 file(s) from')
    expect(out.details?.fileCount).toBe(1)
    expect(read(d, 'a.txt')).toBe('v1\n')
    // HEAD 未移动
    expect(git(d, 'rev-parse HEAD').trim()).toBe(oid2)
  })

  it('路径在 ref 中不存在 → 业务错误', async () => {
    const d = makeRepo()
    write(d, 'a.txt', 'v1\n')
    git(d, 'add .')
    git(d, 'commit -m c1')
    const out = await restoreOp(envFor(d), newCache(), { paths: ['ghost.txt'] })
    expectBizError(out)
  })
})

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

describe('initOp', () => {
  it('空目录 init 后可继续 add/commit/status，系统 git 认可仓库', async () => {
    const d = makeDir()
    const env = envFor(d)
    const cache = newCache()
    const out = await initOp(env, cache, {})
    expect(out.text).toContain('Initialized')
    write(d, 'f.txt', 'hello\n')
    const addOut = await addOp(env, cache, { paths: ['f.txt'] })
    expect(addOut.details?.fileCount).toBe(1)
    const commitOut = await commitOp(env, cache, {
      message: 'first',
      authorName: 'Alice',
      authorEmail: 'alice@example.com'
    })
    expect(commitOut.text).toMatch(/^\[main [0-9a-f]{7}\] first/)
    const st = await statusOp(env, cache, {})
    expect(st.text).toContain('working tree clean')
    // 系统 git 验证仓库有效、默认分支 main
    expect(git(d, 'rev-parse --abbrev-ref HEAD').trim()).toBe('main')
    expect(git(d, 'log --format=%s').trim()).toBe('first')
    expect(git(d, 'status --porcelain').trim()).toBe('')
  })
})

// ---------------------------------------------------------------------------
// add —— details.paths（宿主自动提交写标题用）
// ---------------------------------------------------------------------------

describe('addOp details.paths', () => {
  it('"." 展开：排好序，含工作区删除的；与 fileCount 一致', async () => {
    const d = makeRepo()
    write(d, 'a.txt', 'a1\n')
    write(d, 'b.txt', 'b1\n')
    write(d, 'c.txt', 'c1\n')
    git(d, 'add .')
    git(d, 'commit -m base')
    nodeFs.rmSync(join(d, 'a.txt')) // 删除
    write(d, 'c.txt', 'c2 longer\n') // 修改
    write(d, 'z.txt', 'z\n') // 新增
    write(d, 'm.txt', 'm\n') // 新增
    const out = await addOp(envFor(d), newCache(), { paths: ['.'] })
    expect(out.details?.paths).toEqual(['a.txt', 'c.txt', 'm.txt', 'z.txt'])
    expect(out.details?.fileCount).toBe(4)
  })

  it('显式给的路径也排序（含已删除的 tracked 文件）', async () => {
    const d = makeRepo()
    write(d, 'a.txt', 'a\n')
    write(d, 'b.txt', 'b\n')
    git(d, 'add .')
    git(d, 'commit -m base')
    nodeFs.rmSync(join(d, 'b.txt'))
    write(d, 'a.txt', 'a2 longer\n')
    const out = await addOp(envFor(d), newCache(), { paths: ['b.txt', 'a.txt'] })
    expect(out.details?.paths).toEqual(['a.txt', 'b.txt'])
  })

  it('干净的工作区："." → paths 为 []', async () => {
    const d = makeRepo()
    write(d, 'a.txt', 'a\n')
    git(d, 'add .')
    git(d, 'commit -m base')
    const out = await addOp(envFor(d), newCache(), { paths: ['.'] })
    expect(out.details?.error).toBeUndefined()
    expect(out.details?.paths).toEqual([])
    expect(out.details?.fileCount).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// readCommitChanges —— 结构化的 log --name-status（宿主读自己提交过的历史）
// ---------------------------------------------------------------------------

/** 三个提交：root（A a/b）→ c2（M a）→ c3（D b）；返回各自的 oid */
function makeHistoryRepo(): { d: string; c1: string; c2: string; c3: string } {
  const d = makeRepo()
  write(d, 'a.txt', 'a1\n')
  write(d, 'b.txt', 'b1\n')
  git(d, 'add .')
  git(d, 'commit -m root')
  const c1 = git(d, 'rev-parse HEAD').trim()
  write(d, 'a.txt', 'a2 longer\n')
  git(d, 'add .')
  git(d, 'commit -m c2')
  const c2 = git(d, 'rev-parse HEAD').trim()
  git(d, 'rm -q b.txt')
  git(d, 'commit -m c3')
  const c3 = git(d, 'rev-parse HEAD').trim()
  return { d, c1, c2, c3 }
}

describe('readCommitChanges', () => {
  it('unborn HEAD（init 了、一个提交都没有）→ []', async () => {
    const d = makeRepo()
    write(d, 'a.txt', 'a\n')
    expect(await readCommitChanges(envFor(d), newCache())).toEqual([])
    // isomorphic-git 自己 init 的仓库同理
    const d2 = makeDir()
    await initOp(envFor(d2), newCache(), {})
    expect(await readCommitChanges(envFor(d2), newCache())).toEqual([])
  })

  it('根提交：与空树比，全部 A，带 blob oid', async () => {
    const d = makeRepo()
    write(d, 'b.txt', 'b\n')
    write(d, 'a.txt', 'a\n')
    git(d, 'add .')
    git(d, 'commit -m root')
    const out = await readCommitChanges(envFor(d), newCache())
    expect(out).toHaveLength(1)
    expect(out[0].oid).toBe(git(d, 'rev-parse HEAD').trim())
    expect(out[0].changes).toEqual([
      { path: 'a.txt', status: 'A', oid: git(d, 'rev-parse HEAD:a.txt').trim() },
      { path: 'b.txt', status: 'A', oid: git(d, 'rev-parse HEAD:b.txt').trim() }
    ])
  })

  it('新的在前：D（没有 oid）→ M（新 blob 的 oid）→ 根提交 A；作者时间是整秒的毫秒', async () => {
    const { d, c1, c2, c3 } = makeHistoryRepo()
    const out = await readCommitChanges(envFor(d), newCache())
    expect(out.map((c) => c.oid)).toEqual([c3, c2, c1])
    expect(out[0].changes).toEqual([{ path: 'b.txt', status: 'D' }])
    expect(out[1].changes).toEqual([
      { path: 'a.txt', status: 'M', oid: git(d, `rev-parse ${c2}:a.txt`).trim() }
    ])
    expect(out[2].changes.map((c) => `${c.status} ${c.path}`)).toEqual(['A a.txt', 'A b.txt'])
    const authorSecs = git(d, 'log --format=%at').trim().split('\n').map(Number)
    out.forEach((c, i) => {
      expect(c.timestamp % 1000).toBe(0)
      expect(c.timestamp).toBe(authorSecs[i] * 1000)
    })
  })

  it('depth 截断为最近 N 条', async () => {
    const { d, c2, c3 } = makeHistoryRepo()
    const out = await readCommitChanges(envFor(d), newCache(), { depth: 2 })
    expect(out.map((c) => c.oid)).toEqual([c3, c2])
  })

  it('提交信息原样（多行 + trailer）', async () => {
    const d = makeRepo()
    write(d, 'a.svg', '<svg/>\n')
    git(d, 'add .')
    const message = [
      'artifact: a.svg',
      '',
      'Tool-Call-Id: call_1',
      'Recorded-At: 2026-10-24T10:00:00.123Z'
    ].join('\n')
    const msgFile = join(makeDir(), 'msg.txt')
    nodeFs.writeFileSync(msgFile, message)
    git(d, `commit -q -F ${JSON.stringify(msgFile)}`)
    const [c] = await readCommitChanges(envFor(d), newCache())
    expect(c.message.trimEnd()).toBe(message)
    expect(c.message).toMatch(/^Recorded-At: 2026-10-24T10:00:00\.123Z$/m)
  })

  it('坏 ref / 缺对象 → 照抛（不吞成 []）', async () => {
    const { d, c3 } = makeHistoryRepo()
    // 给的 ref 不存在
    await expect(
      readCommitChanges(envFor(d), newCache(), { ref: 'no-such-branch' })
    ).rejects.toThrow()
    // HEAD 指着的提交对象没了（仓库坏了）
    const objectFile = join(d, '.git', 'objects', c3.slice(0, 2), c3.slice(2))
    nodeFs.chmodSync(objectFile, 0o644)
    nodeFs.rmSync(objectFile)
    await expect(readCommitChanges(envFor(d), newCache())).rejects.toThrow()
  })

  // 钉住现状：分支 ref 文件里是乱码时，isomorphic-git 的 resolveRef 抛的也是 NotFoundError —— 与 unborn
  // HEAD 分不开，于是当成「一个提交都没有」交回 []（产物面板因此退回「算一版、取 mtime」，不会报错）
  it('分支 ref 文件被写坏（乱码）→ 与 unborn 一样交回 []', async () => {
    const { d } = makeHistoryRepo()
    nodeFs.writeFileSync(join(d, '.git', 'refs', 'heads', 'main'), 'garbage\n')
    await expect(readCommitChanges(envFor(d), newCache())).resolves.toEqual([])
  })
})

// ---------------------------------------------------------------------------
// blob —— 按内容寻址存一份文本（宿主给 ```artifact 引用钉版本用）
// ---------------------------------------------------------------------------

/** 系统 git 算这段文本作为 blob 的哈希（`-w` 时顺带写进对象库） */
function hashObject(dir: string, text: string, writeIt = false): string {
  return execFileSync('git', ['hash-object', ...(writeIt ? ['-w'] : []), '--stdin'], {
    cwd: dir,
    input: text,
    encoding: 'utf8'
  }).trim()
}

/** 对象库里的松散对象（`ab/cdef…` → `abcdef…`），按名排序 */
function looseObjects(dir: string): string[] {
  const root = join(dir, '.git', 'objects')
  return nodeFs
    .readdirSync(root)
    .filter((d) => /^[0-9a-f]{2}$/.test(d))
    .flatMap((d) => nodeFs.readdirSync(join(root, d)).map((f) => d + f))
    .sort()
}

const SAMPLES = [
  '<svg aria-label="Bar chart"><rect/></svg>',
  '中文标题 · ünïcødé · 😀\n',
  'line one\r\nline two\r\n',
  ''
]

describe('writeBlobText / readBlobText / hashBlobText', () => {
  it('GB-1 writeBlobText：oid = git hash-object --stdin；幂等；不进提交、工作区状态不变', async () => {
    const d = makeRepo()
    write(d, 'a.txt', 'a\n')
    git(d, 'add .')
    git(d, 'commit -m base')
    write(d, 'a.txt', 'a changed\n') // 工作区里留一处改动：写 blob 不该碰它
    const head = git(d, 'rev-parse HEAD').trim()
    const status = git(d, 'status --porcelain')
    const index = nodeFs.readFileSync(join(d, '.git', 'index'))

    for (const text of SAMPLES) {
      const oid = await writeBlobText(envFor(d), text)
      expect(oid, JSON.stringify(text)).toBe(hashObject(d, text))
      // 系统 git 读得回同一份内容（对象真的进了库）
      expect(git(d, `cat-file -t ${oid}`).trim()).toBe('blob')
      expect(execFileSync('git', ['cat-file', 'blob', oid], { cwd: d, encoding: 'utf8' })).toBe(
        text
      )
    }
    // 同一份内容再写一次：同一个 oid、对象库里不多出东西
    const before = looseObjects(d)
    expect(await writeBlobText(envFor(d), SAMPLES[0])).toBe(hashObject(d, SAMPLES[0]))
    expect(looseObjects(d)).toEqual(before)

    expect(git(d, 'rev-parse HEAD').trim()).toBe(head)
    expect(git(d, 'rev-list --count HEAD').trim()).toBe('1')
    expect(git(d, 'status --porcelain')).toBe(status)
    expect(nodeFs.readFileSync(join(d, '.git', 'index')).equals(index)).toBe(true)
  })

  it('GB-2 readBlobText：原样往返；没有的 oid、tree / commit 的 oid → null', async () => {
    const d = makeRepo()
    for (const text of SAMPLES) {
      const oid = await writeBlobText(envFor(d), text)
      expect(await readBlobText(envFor(d), newCache(), oid), JSON.stringify(text)).toBe(text)
    }
    // 系统 git 写的 blob 也读得回（双向互操作）
    const byGit = hashObject(d, 'written by git\r\n', true)
    expect(await readBlobText(envFor(d), newCache(), byGit)).toBe('written by git\r\n')

    // 没有这个对象
    expect(await readBlobText(envFor(d), newCache(), 'f'.repeat(40))).toBeNull()
    expect(await readBlobText(envFor(d), newCache(), hashObject(d, 'never written'))).toBeNull()
    // 有，但不是 blob
    write(d, 'a.txt', 'a\n')
    git(d, 'add .')
    git(d, 'commit -m base')
    const commit = git(d, 'rev-parse HEAD').trim()
    const tree = git(d, 'rev-parse HEAD^{tree}').trim()
    expect(await readBlobText(envFor(d), newCache(), commit)).toBeNull()
    expect(await readBlobText(envFor(d), newCache(), tree)).toBeNull()
    // 根本不是仓库
    expect(await readBlobText(envFor(makeDir()), newCache(), byGit)).toBeNull()
  })

  it('GB-3 hashBlobText：与 writeBlobText 同一个 oid，且不写对象库', async () => {
    const d = makeRepo()
    for (const text of SAMPLES) {
      const before = looseObjects(d)
      const hashed = await hashBlobText(text)
      expect(looseObjects(d), JSON.stringify(text)).toEqual(before)
      expect(hashed).toBe(hashObject(d, text))
      expect(await readBlobText(envFor(d), newCache(), hashed)).toBeNull()
      expect(await writeBlobText(envFor(d), text)).toBe(hashed)
    }
    // 空串的 blob 哈希是 git 的那个常量
    expect(await hashBlobText('')).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391')
  })
})
