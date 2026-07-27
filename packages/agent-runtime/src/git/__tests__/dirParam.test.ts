/**
 * "dir" 参数 —— tool 层行为探针。
 *
 * 覆盖：resolveDir 归一（相对→绝对）、按 action 读/写语义传参、宿主拒绝回显、
 * 未注入 resolveDir 时带 dir 的调用被拒、缺省仍操作 getEnv().dir、多仓库缓存互不串扰。
 */
import { describe, it, expect, afterEach } from 'vitest'
import * as nodeFs from 'node:fs'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import type { GitEnv, GitFsClient } from '../env'
import { createGitTool } from '../tool'
import type { GitAction } from '../ops'

const dirs: string[] = []

afterEach(() => {
  for (const d of dirs.splice(0)) {
    nodeFs.rmSync(d, { recursive: true, force: true })
  }
})

function makeDir(): string {
  const d = nodeFs.mkdtempSync(join(tmpdir(), 'shuvix-gitdir-'))
  dirs.push(d)
  return d
}

function makeRepo(): string {
  const d = makeDir()
  execSync('git init -b main', { cwd: d, stdio: 'ignore' })
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

describe('git tool dir 参数', () => {
  it('未注入 resolveDir 时带 dir 的调用被拒绝（不落到工作目录仓库上）', async () => {
    const work = makeRepo()
    const tool = createGitTool({ getEnv: () => envFor(work) })
    const out = await tool.execute('t1', { action: 'status', dir: '/elsewhere' })
    expect(textOf(out)).toContain('"dir" parameter is not supported')
  })

  it('resolveDir 归一相对路径并按读/写语义收到 mutates 标记', async () => {
    const work = makeRepo()
    const other = makeRepo()
    nodeFs.writeFileSync(join(other, 'a.txt'), 'hi')
    const calls: { requested: string; action: GitAction; mutates: boolean }[] = []
    const tool = createGitTool({
      getEnv: () => envFor(work),
      resolveDir: async (requested, opts) => {
        calls.push({ requested, action: opts.action, mutates: opts.mutates })
        return other
      }
    })

    const status = await tool.execute('t2', { action: 'status', dir: 'rel/other' })
    expect(textOf(status)).toContain('a.txt')
    const add = await tool.execute('t3', { action: 'add', dir: 'rel/other', paths: ['a.txt'] })
    expect(textOf(add)).not.toContain('Error')

    expect(calls).toEqual([
      { requested: 'rel/other', action: 'status', mutates: false },
      { requested: 'rel/other', action: 'add', mutates: true }
    ])
  })

  it('resolveDir 拒绝（throw）→ 回显错误文本，不执行操作', async () => {
    const work = makeRepo()
    const tool = createGitTool({
      getEnv: () => envFor(work),
      resolveDir: async () => {
        throw new Error('User denied access to /secret')
      }
    })
    const out = await tool.execute('t4', { action: 'init', dir: '/secret' })
    expect(textOf(out)).toContain('Cannot access repository dir "/secret"')
    expect(textOf(out)).toContain('User denied access')
  })

  it('缺省（无 dir）仍操作 getEnv().dir，且与 dir 仓库互不串扰', async () => {
    const work = makeRepo()
    const other = makeRepo()
    nodeFs.writeFileSync(join(work, 'work.txt'), 'w')
    nodeFs.writeFileSync(join(other, 'other.txt'), 'o')
    const tool = createGitTool({
      getEnv: () => envFor(work),
      resolveDir: async () => other
    })

    const workStatus = textOf(await tool.execute('t5', { action: 'status' }))
    expect(workStatus).toContain('work.txt')
    expect(workStatus).not.toContain('other.txt')

    const otherStatus = textOf(await tool.execute('t6', { action: 'status', dir: other }))
    expect(otherStatus).toContain('other.txt')
    expect(otherStatus).not.toContain('work.txt')
  })
})
