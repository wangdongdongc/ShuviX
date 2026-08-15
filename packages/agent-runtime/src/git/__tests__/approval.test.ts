/**
 * git 逐操作审批 —— tool 层行为探针（真实临时仓库，沿用 dirParam.test.ts 的惯例）。
 *
 * 覆盖：GIT_OPS.approval 的表驱动判定、需审批四种调用的 reason/action、免审批集合零弹窗且真执行、
 * approveOp 拒绝时操作不落地、resolveDir 与 approveOp 的先后、审批卡片的命令行形态、
 * 未注入 approveOp 时不审批、参数校验先于审批。
 */
import { describe, it, expect, afterEach, vi, type Mock } from 'vitest'
import * as nodeFs from 'node:fs'
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import type { GitEnv, GitFsClient } from '../env'
import { createGitTool } from '../tool'
import { GIT_OPS, type GitAction, type GitApprovalReason, type GitOpParams } from '../ops'

const dirs: string[] = []

afterEach(() => {
  for (const d of dirs.splice(0)) {
    nodeFs.rmSync(d, { recursive: true, force: true })
  }
})

function makeDir(): string {
  const d = nodeFs.mkdtempSync(join(tmpdir(), 'shuvix-gitapproval-'))
  dirs.push(d)
  return d
}

function git(cwd: string, args: string): string {
  return execSync(
    `git -c user.name=Tester -c user.email=t@example.com -c commit.gpgsign=false ${args}`,
    { cwd, encoding: 'utf8' }
  )
}

/** 建一个有一次提交的仓库（log/show/diff/checkout 需要 HEAD） */
function makeRepoWithCommit(): string {
  const d = makeDir()
  execSync('git init -b main', { cwd: d, stdio: 'ignore' })
  nodeFs.writeFileSync(join(d, 'a.txt'), 'first\n')
  git(d, 'add a.txt')
  git(d, 'commit -m "init"')
  return d
}

function envFor(dir: string): GitEnv {
  return { fs: nodeFs as unknown as GitFsClient, dir }
}

function textOf(result: { content: { type: string }[] }): string {
  return result.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n')
}

interface ApproveCall {
  action: GitAction
  reason: GitApprovalReason
  command: string
  toolCallId: string
}

interface ApproveSpy {
  fn: Mock<(info: ApproveCall) => Promise<void>>
  calls: ApproveCall[]
}

/** approveOp spy（默认放行；throwWith 非空时捕获后抛错，用于「拒绝」与「只看命令行」两种场景） */
function approveSpy(throwWith?: string): ApproveSpy {
  const calls: ApproveCall[] = []
  const fn = vi.fn(async (info: ApproveCall) => {
    calls.push(info)
    if (throwWith) throw new Error(throwWith)
  })
  return { fn, calls }
}

// ─── GIT-1：审批判定表 ───────────────────────────────────────────────────────

describe('GIT_OPS.approval 判定表', () => {
  /** action → 「需审批的参数组合」列表；其余参数组合必须恒 null */
  const NEEDS_APPROVAL: Partial<Record<GitAction, { params: GitOpParams; reason: string }[]>> = {
    init: [{ params: {}, reason: 'createRepo' }],
    restore: [
      { params: { paths: ['a.txt'] }, reason: 'discardChanges' },
      { params: { paths: ['a.txt'], ref: 'HEAD~1' }, reason: 'discardChanges' }
    ],
    checkout: [{ params: { ref: 'main', force: true }, reason: 'discardChanges' }],
    branch: [{ params: { name: 'feat', delete: true }, reason: 'deleteBranch' }]
  }

  /** 覆盖每个 action 的代表性参数组合（含破坏性开关的正反两面） */
  const PARAM_MATRIX: Record<GitAction, GitOpParams[]> = {
    help: [{}, { topic: 'workflow' }],
    status: [{}, { paths: ['a.txt'] }],
    log: [{}, { ref: 'HEAD', depth: 5 }],
    show: [{ ref: 'HEAD' }],
    diff: [{}, { staged: true }, { from: 'HEAD~1', to: 'HEAD' }],
    add: [{ paths: ['.'] }],
    unstage: [{ paths: ['a.txt'] }],
    commit: [{ message: 'm' }],
    branch: [{}, { name: 'feat' }, { name: 'feat', delete: true }],
    checkout: [{ ref: 'main' }, { ref: 'main', force: true }],
    restore: [{ paths: ['a.txt'] }, { paths: ['a.txt'], ref: 'HEAD~1' }],
    init: [{}]
  }

  it.each(GIT_OPS.map((op) => [op.name, op] as const))(
    'GIT-1: %s 的 approval 判定与白名单一致',
    (name, spec) => {
      for (const params of PARAM_MATRIX[name]) {
        const reason = spec.approval?.(params) ?? null
        const expected =
          NEEDS_APPROVAL[name]?.find((e) => JSON.stringify(e.params) === JSON.stringify(params))
            ?.reason ?? null
        expect({ params, reason }).toEqual({ params, reason: expected })
      }
    }
  )

  it('GIT-1: 只有 init / restore / checkout(force) / branch(delete) 声明了 approval', () => {
    expect(
      GIT_OPS.filter((op) => op.approval)
        .map((op) => op.name)
        .sort()
    ).toEqual(['branch', 'checkout', 'init', 'restore'])
  })
})

// ─── GIT-2 / GIT-6：需审批的四种调用 ─────────────────────────────────────────

describe('git 工具 — 需审批的操作', () => {
  it.each([
    ['init', { action: 'init' }, 'createRepo', 'git init'],
    ['restore', { action: 'restore', paths: ['a.txt'] }, 'discardChanges', 'git restore a.txt'],
    [
      'restore（带 ref 与多路径）',
      { action: 'restore', ref: 'HEAD~1', paths: ['a.txt', 'b.txt'] },
      'discardChanges',
      'git restore --source HEAD~1 a.txt b.txt'
    ],
    [
      'checkout --force',
      { action: 'checkout', ref: 'main', force: true },
      'discardChanges',
      'git checkout --force main'
    ],
    [
      'branch -d',
      { action: 'branch', name: 'feat', delete: true },
      'deleteBranch',
      'git branch -d feat'
    ]
  ] as const)(
    'GIT-2/GIT-6: %s 恰好审批一次，reason 与命令行形态正确',
    async (_label, params, reason, command) => {
      const repo = makeRepoWithCommit()
      // 抛错阻断执行 —— 本用例只关心审批入参（restore 的 HEAD~1 等引用未必存在）
      const approve = approveSpy('stop here')
      const tool = createGitTool({ getEnv: () => envFor(repo), approveOp: approve.fn })

      await expect(tool.execute('tc-1', params)).rejects.toThrow('stop here')

      expect(approve.calls).toHaveLength(1)
      expect(approve.calls[0]).toEqual({
        action: params.action,
        reason,
        command,
        toolCallId: 'tc-1'
      })
    }
  )
})

// ─── GIT-3：免审批集合 ───────────────────────────────────────────────────────

describe('git 工具 — 免审批的操作', () => {
  it('GIT-3: 只读与温和写操作零弹窗，且都真实执行', async () => {
    const repo = makeRepoWithCommit()
    const approve = approveSpy()
    const tool = createGitTool({ getEnv: () => envFor(repo), approveOp: approve.fn })

    nodeFs.writeFileSync(join(repo, 'b.txt'), 'second\n')

    expect(textOf(await tool.execute('g1', { action: 'help' }))).toContain('git')
    expect(textOf(await tool.execute('g2', { action: 'status' }))).toContain('b.txt')
    expect(textOf(await tool.execute('g3', { action: 'log' }))).toContain('init')
    expect(textOf(await tool.execute('g4', { action: 'show', ref: 'HEAD' }))).toContain('a.txt')
    expect(textOf(await tool.execute('g5', { action: 'diff' }))).not.toContain('Error')

    // add → 索引里出现 b.txt
    await tool.execute('g6', { action: 'add', paths: ['b.txt'] })
    expect(git(repo, 'diff --cached --name-only')).toContain('b.txt')
    // unstage → 又从索引里消失
    await tool.execute('g7', { action: 'unstage', paths: ['b.txt'] })
    expect(git(repo, 'diff --cached --name-only')).not.toContain('b.txt')
    // 重新 add 后 commit → 历史多一条
    await tool.execute('g8', { action: 'add', paths: ['b.txt'] })
    await tool.execute('g9', {
      action: 'commit',
      message: 'second commit',
      authorName: 'Alice',
      authorEmail: 'alice@example.com'
    })
    expect(git(repo, 'log --oneline')).toContain('second commit')

    // branch(name) 建并切换 → branch() 列表里 feat 带 *
    await tool.execute('g10', { action: 'branch', name: 'feat' })
    expect(textOf(await tool.execute('g11', { action: 'branch' }))).toContain('* feat')
    // checkout(ref) 无 force → 切回 main
    await tool.execute('g12', { action: 'checkout', ref: 'main' })
    expect(git(repo, 'rev-parse --abbrev-ref HEAD').trim()).toBe('main')

    expect(approve.fn).not.toHaveBeenCalled()
  })
})

// ─── GIT-4 / GIT-7 / GIT-8：拒绝、未注入、参数校验 ───────────────────────────

describe('git 工具 — 审批的边界', () => {
  it('GIT-4: approveOp 抛错 → 操作不执行、错误上抛（不被 usageError 吞成成功）', async () => {
    const bare = makeDir()
    const approve = approveSpy('User denied git init')
    const tool = createGitTool({ getEnv: () => envFor(bare), approveOp: approve.fn })

    await expect(tool.execute('d1', { action: 'init' })).rejects.toThrow('User denied git init')
    expect(existsSync(join(bare, '.git'))).toBe(false)
  })

  it('GIT-4: 被拒的 restore 不改动工作区', async () => {
    const repo = makeRepoWithCommit()
    nodeFs.writeFileSync(join(repo, 'a.txt'), 'locally edited\n')
    const approve = approveSpy('User denied git restore a.txt')
    const tool = createGitTool({ getEnv: () => envFor(repo), approveOp: approve.fn })

    await expect(tool.execute('d2', { action: 'restore', paths: ['a.txt'] })).rejects.toThrow(
      'User denied git restore'
    )
    expect(nodeFs.readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('locally edited\n')
  })

  it('GIT-7: 未注入 approveOp → 不审批直接执行', async () => {
    const bare = makeDir()
    const tool = createGitTool({ getEnv: () => envFor(bare) })

    const out = await tool.execute('d3', { action: 'init' })
    expect(textOf(out)).not.toContain('Error')
    expect(existsSync(join(bare, '.git'))).toBe(true)
  })

  it('GIT-8: 参数校验先于审批 —— branch(delete:true) 缺 name 时 approveOp 零调用', async () => {
    const repo = makeRepoWithCommit()
    const approve = approveSpy()
    const tool = createGitTool({ getEnv: () => envFor(repo), approveOp: approve.fn })

    const out = await tool.execute('d4', { action: 'branch', delete: true })
    expect(textOf(out)).toContain('"name" is required when delete:true')
    expect(approve.fn).not.toHaveBeenCalled()
  })

  it('GIT-8: 缺必选参数（restore 无 paths）同样先于审批被拒', async () => {
    const repo = makeRepoWithCommit()
    const approve = approveSpy()
    const tool = createGitTool({ getEnv: () => envFor(repo), approveOp: approve.fn })

    const out = await tool.execute('d5', { action: 'restore' })
    expect(textOf(out)).toContain('Missing required parameter "paths"')
    expect(approve.fn).not.toHaveBeenCalled()
  })
})

// ─── GIT-5：resolveDir 与 approveOp 的先后 ──────────────────────────────────

describe('git 工具 — dir 与审批的顺序', () => {
  it('GIT-5: resolveDir 先于 approveOp，且命令行带 (dir: ...)', async () => {
    const work = makeRepoWithCommit()
    const other = makeDir()
    const order: string[] = []
    const approve = approveSpy('stop here')
    const tool = createGitTool({
      getEnv: () => envFor(work),
      resolveDir: async (requested) => {
        order.push(`resolveDir:${requested}`)
        return other
      },
      approveOp: async (info) => {
        order.push('approveOp')
        return approve.fn(info as ApproveCall)
      }
    })

    await expect(tool.execute('o1', { action: 'init', dir: 'sub/repo' })).rejects.toThrow(
      'stop here'
    )

    expect(order).toEqual(['resolveDir:sub/repo', 'approveOp'])
    expect(approve.calls[0].command).toBe('git init (dir: sub/repo)')
    // 审批被拒 → 目标目录里没有建出仓库
    expect(existsSync(join(other, '.git'))).toBe(false)
  })

  it('GIT-5: resolveDir 拒绝时 approveOp 完全不触发', async () => {
    const work = makeRepoWithCommit()
    const approve = approveSpy()
    const tool = createGitTool({
      getEnv: () => envFor(work),
      resolveDir: async () => {
        throw new Error('User denied access to /secret')
      },
      approveOp: approve.fn
    })

    const out = await tool.execute('o2', { action: 'init', dir: '/secret' })
    expect(textOf(out)).toContain('Cannot access repository dir "/secret"')
    expect(approve.fn).not.toHaveBeenCalled()
  })
})
