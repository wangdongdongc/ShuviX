/**
 * diffOp 单元测试 —— TDD 先行：实现当前为桩（throw 'not implemented'），本文件此刻应全红。
 *
 * 三种模式（默认 worktree vs index / staged:true index vs HEAD / from(+to) 两 commit 树）
 * × 变更类型（修改/新增/删除/二进制），输出为 unified diff（context 3 行）。
 * 系统 git 造 fixture；加分项用 `git apply --check` 验证 patch 可回放。
 */
import { describe, it, expect, afterEach } from 'vitest'
import * as nodeFs from 'node:fs'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import type { GitCache, GitEnv, GitFsClient, GitOpOutput } from '../env'
import { diffOp } from '../diffOps'

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
  const d = nodeFs.mkdtempSync(join(tmpdir(), 'shuvix-gitdiff-'))
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

function expectBizError(out: GitOpOutput, contains?: string): void {
  expect(out.text ?? '').toMatch(/^Error: /)
  expect(out.details?.error).toBeTruthy()
  if (contains) expect(out.text).toContain(contains)
}

// ---------------------------------------------------------------------------
// 三种模式 × 变更类型
// ---------------------------------------------------------------------------

describe('diffOp - 默认模式（工作区 vs 索引）', () => {
  it('修改：diff --git 头 + ---/+++ + @@ hunk + 行内容', async () => {
    const d = makeRepo()
    write(d, 'a.txt', 'line1\nline2\nline3\n')
    git(d, 'add .')
    git(d, 'commit -m c1')
    write(d, 'a.txt', 'line1\nCHANGED\nline3\n')
    const out = await diffOp(envFor(d), newCache(), {})
    const text = out.text ?? ''
    expect(text).toContain('diff --git a/a.txt b/a.txt')
    expect(text).toContain('--- a/a.txt')
    expect(text).toContain('+++ b/a.txt')
    expect(text).toMatch(/^@@ /m)
    expect(text).toMatch(/^-line2$/m)
    expect(text).toMatch(/^\+CHANGED$/m)
    expect(out.details?.fileCount).toBe(1)
  })

  it('无变更时输出 no changes，fileCount 0', async () => {
    const d = makeRepo()
    write(d, 'a.txt', 'v1\n')
    git(d, 'add .')
    git(d, 'commit -m c1')
    const out = await diffOp(envFor(d), newCache(), {})
    expect(out.text).toContain('no changes')
    expect(out.details?.fileCount).toBe(0)
  })
})

describe('diffOp - staged:true（索引 vs HEAD）', () => {
  it('修改 + 新增（--- /dev/null）', async () => {
    const d = makeRepo()
    write(d, 'a.txt', 'one\ntwo\nthree\n')
    git(d, 'add .')
    git(d, 'commit -m c1')
    write(d, 'a.txt', 'one\nTWO\nthree\n')
    write(d, 'new.txt', 'hello\n')
    git(d, 'add .')
    const out = await diffOp(envFor(d), newCache(), { staged: true })
    const text = out.text ?? ''
    // 修改的文件
    expect(text).toContain('diff --git a/a.txt b/a.txt')
    expect(text).toMatch(/^-two$/m)
    expect(text).toMatch(/^\+TWO$/m)
    // 新增的文件：旧侧为 /dev/null
    expect(text).toContain('diff --git a/new.txt b/new.txt')
    expect(text).toContain('--- /dev/null')
    expect(text).toContain('+++ b/new.txt')
    expect(text).toMatch(/^\+hello$/m)
    expect(out.details?.fileCount).toBe(2)
  })
})

describe('diffOp - from/to（两 commit 之间）', () => {
  it('修改 + 删除（+++ /dev/null）', async () => {
    const d = makeRepo()
    write(d, 'a.txt', 'one\n')
    write(d, 'b.txt', 'bee\n')
    git(d, 'add .')
    git(d, 'commit -m c1')
    const oid1 = git(d, 'rev-parse HEAD').trim()
    write(d, 'a.txt', 'two\n')
    git(d, 'add a.txt')
    git(d, 'rm -q b.txt')
    git(d, 'commit -m c2')
    const oid2 = git(d, 'rev-parse HEAD').trim()
    const out = await diffOp(envFor(d), newCache(), { from: oid1, to: oid2 })
    const text = out.text ?? ''
    // 修改
    expect(text).toContain('diff --git a/a.txt b/a.txt')
    expect(text).toMatch(/^-one$/m)
    expect(text).toMatch(/^\+two$/m)
    // 删除：新侧为 /dev/null
    expect(text).toContain('diff --git a/b.txt b/b.txt')
    expect(text).toContain('--- a/b.txt')
    expect(text).toContain('+++ /dev/null')
    expect(text).toMatch(/^-bee$/m)
    expect(out.details?.fileCount).toBe(2)
  })

  it('from 不带 to：对比工作区当前内容', async () => {
    const d = makeRepo()
    write(d, 'a.txt', 'one\n')
    git(d, 'add .')
    git(d, 'commit -m c1')
    const oid1 = git(d, 'rev-parse HEAD').trim()
    write(d, 'a.txt', 'two\n')
    git(d, 'add .')
    git(d, 'commit -m c2')
    write(d, 'a.txt', 'three\n') // 工作区又改，未提交
    const out = await diffOp(envFor(d), newCache(), { from: oid1 })
    const text = out.text ?? ''
    expect(text).toMatch(/^-one$/m)
    expect(text).toMatch(/^\+three$/m)
    expect(text).not.toMatch(/^\+two$/m)
    expect(out.details?.fileCount).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 二进制 / path 过滤 / 参数与 ref 错误
// ---------------------------------------------------------------------------

describe('diffOp - 二进制与过滤', () => {
  it('二进制文件（含 \\0）→ Binary files a/<p> and b/<p> differ', async () => {
    const d = makeRepo()
    nodeFs.writeFileSync(join(d, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02, 0x03]))
    git(d, 'add .')
    git(d, 'commit -m c1')
    nodeFs.writeFileSync(join(d, 'bin.dat'), Buffer.from([0x00, 0x09, 0x09]))
    const out = await diffOp(envFor(d), newCache(), {})
    const text = out.text ?? ''
    expect(text).toContain('Binary files a/bin.dat and b/bin.dat differ')
    // 二进制文件不应产出文本 hunk
    expect(text).not.toMatch(/^@@ /m)
    expect(out.details?.fileCount).toBe(1)
  })

  it('path 过滤：只输出指定文件的 diff', async () => {
    const d = makeRepo()
    write(d, 'a.txt', 'aaa\n')
    write(d, 'b.txt', 'bbb\n')
    git(d, 'add .')
    git(d, 'commit -m c1')
    write(d, 'a.txt', 'AAA\n')
    write(d, 'b.txt', 'BBB\n')
    const out = await diffOp(envFor(d), newCache(), { path: 'a.txt' })
    const text = out.text ?? ''
    expect(text).toContain('diff --git a/a.txt b/a.txt')
    expect(text).not.toContain('b.txt')
    expect(out.details?.fileCount).toBe(1)
  })
})

describe('diffOp - 参数/ref 错误', () => {
  it('staged 与 from 同给 → 业务错误 not both', async () => {
    const d = makeRepo()
    write(d, 'a.txt', 'v1\n')
    git(d, 'add .')
    git(d, 'commit -m c1')
    const out = await diffOp(envFor(d), newCache(), { staged: true, from: 'HEAD' })
    expectBizError(out, 'not both')
  })

  it('不存在的 from ref → 业务错误', async () => {
    const d = makeRepo()
    write(d, 'a.txt', 'v1\n')
    git(d, 'add .')
    git(d, 'commit -m c1')
    const out = await diffOp(envFor(d), newCache(), { from: 'no-such-ref' })
    expectBizError(out)
  })
})

// ---------------------------------------------------------------------------
// 加分：patch 可回放性
// ---------------------------------------------------------------------------

describe('diffOp - patch 与系统 git 互操作', () => {
  it('默认模式输出可被 git apply --check / git apply 回放', async () => {
    const d = makeRepo()
    write(d, 'a.txt', 'one\ntwo\nthree\n')
    git(d, 'add .')
    git(d, 'commit -m c1')
    write(d, 'a.txt', 'one\nTWO\nthree\n')
    const out = await diffOp(envFor(d), newCache(), {})
    const patchPath = join(d, 'change.patch')
    nodeFs.writeFileSync(patchPath, out.text ?? '')
    // 还原到干净工作区后回放 patch
    git(d, 'checkout -- a.txt')
    expect(read(d, 'a.txt')).toBe('one\ntwo\nthree\n')
    git(d, 'apply --check change.patch') // 抛异常即失败
    git(d, 'apply change.patch')
    expect(read(d, 'a.txt')).toBe('one\nTWO\nthree\n')
  })
})
