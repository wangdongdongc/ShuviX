/**
 * repo —— **一个 bundle 一个 git 仓库**：存在性由宿主保证（init + 基线提交，幂等），每批观察到
 * 的变更提交一次（300ms 去抖合批），署名 ShuviX Knowledge、内容出自谁写在 trailer。
 * 去抖窗口跨 bundle 合批，但提交各进各的仓库 —— 没有任何跨仓库操作。一切失败只记日志：
 * 目录不存在 / 不是仓库都静默跳过。提交经真实 isomorphic-git 落盘、用 git CLI 读回。
 * 用户库同样一库一仓库：.git 建在用户根下的库目录里；已经是用户自己的仓库就原样沿用，一个提交都不加。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const state = vi.hoisted(() => ({ root: '' }))

vi.mock('../../../utils/paths', () => ({
  getShuvixKnowledgeRootDir: () => state.root,
  getUserKnowledgeRootDir: () => `${state.root}-user`,
  // 内置库根替身：不存在的兄弟目录 —— 这些用例里没有内置库
  getBuiltinKnowledgeDir: () => `${state.root}-builtin`
}))
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

import { ensureBundleRepo, flushKnowledgeCommits, queueKnowledgeCommit } from '../repo'
import {
  BUNDLE,
  OTHER_BUNDLE,
  PROJECTS,
  bundleAt,
  gitAsUser,
  gitCommitCount,
  gitHeadFiles,
  gitHeadMessage,
  gitLog,
  gitOutput,
  gitStatus,
  makeTempRoot,
  seedConcept,
  seedFile,
  userRootOf
} from './fixture'

const PROJECT_MD = '---\ntype: Project\ntitle: Acme\nresource: shuvix://project/p1\n---\n\nacme\n'

let root: string
let dir: string

beforeEach(() => {
  root = makeTempRoot()
  state.root = root
  dir = bundleAt(root, BUNDLE)
})

afterEach(async () => {
  await flushKnowledgeCommits()
  rmSync(root, { recursive: true, force: true })
  rmSync(userRootOf(root), { recursive: true, force: true })
})

describe('ensureBundleRepo', () => {
  it('RP-1 非仓库的 bundle 目录：init + 当前全部文件作基线一次提交（署名 ShuviX Knowledge）；再调不加提交；目录不存在 → 不抛、不建 .git', async () => {
    seedFile(root, `${BUNDLE}/project.md`, PROJECT_MD)
    seedConcept(root, `${BUNDLE}/a.md`, ['type: Memory', 'title: A'])

    await ensureBundleRepo(BUNDLE)
    expect(existsSync(join(dir, '.git'))).toBe(true)
    expect(gitLog(dir, '%s')).toEqual(['kb(init): knowledge base'])
    expect(gitLog(dir, '%an <%ae>')).toEqual(['ShuviX Knowledge <knowledge@shuvix.local>'])
    expect(gitHeadFiles(dir)).toEqual(['a.md', 'project.md'])
    expect(gitStatus(dir)).toBe('')

    await ensureBundleRepo(BUNDLE)
    expect(gitCommitCount(dir)).toBe(1)

    await expect(ensureBundleRepo(`${PROJECTS}/missing`)).resolves.toBeUndefined()
    expect(existsSync(join(bundleAt(root, `${PROJECTS}/missing`), '.git'))).toBe(false)
  })
})

describe('queueKnowledgeCommit / flushKnowledgeCommits', () => {
  it('RP-2 单条：subject `kb(<op>): /<path>` + Knowledge-Op / Knowledge-Actor trailer；只提交列出的路径；无 actor 则无 Knowledge-Actor', async () => {
    seedFile(root, `${BUNDLE}/project.md`, PROJECT_MD)
    await ensureBundleRepo(BUNDLE)

    seedConcept(root, `${BUNDLE}/x.md`, ['type: Memory', 'title: X'])
    seedFile(root, `${BUNDLE}/index.md`, '## Entries\n\n* [X](x.md)\n')
    seedFile(root, `${BUNDLE}/log.md`, '## 2026-09-09\n\n- **Creation** /x.md\n')
    seedConcept(root, `${BUNDLE}/other.md`, ['type: Memory', 'title: Other'])

    queueKnowledgeCommit(BUNDLE, ['x.md', 'index.md', 'log.md'], {
      op: 'Creation',
      path: 'x.md',
      actor: 'shuvix-work/gpt-5'
    })
    await flushKnowledgeCommits()
    expect(gitHeadMessage(dir)).toBe(
      'kb(creation): /x.md\n\nKnowledge-Op: creation\nKnowledge-Actor: shuvix-work/gpt-5'
    )
    expect(gitHeadFiles(dir)).toEqual(['index.md', 'log.md', 'x.md'])
    // 没列出的脏文件不暂存
    expect(gitStatus(dir)).toBe('?? other.md')

    queueKnowledgeCommit(BUNDLE, ['other.md'], { op: 'Update', path: 'other.md' })
    await flushKnowledgeCommits()
    expect(gitHeadMessage(dir)).toBe('kb(update): /other.md\n\nKnowledge-Op: update')
    expect(gitStatus(dir)).toBe('')
    expect(gitCommitCount(dir)).toBe(3)
  })

  it('RP-3 去抖窗口内同一 bundle 多次排队合成一条 batch 提交（逐条列出、actor 取首个）；同窗口的另一个 bundle 各提交各的仓库；非仓库目录静默跳过', async () => {
    const otherDir = bundleAt(root, OTHER_BUNDLE)
    seedFile(root, `${BUNDLE}/project.md`, PROJECT_MD)
    seedFile(root, `${OTHER_BUNDLE}/project.md`, PROJECT_MD)
    await ensureBundleRepo(BUNDLE)
    await ensureBundleRepo(OTHER_BUNDLE)
    seedConcept(root, `${BUNDLE}/a.md`, ['type: Memory', 'title: A'])
    seedConcept(root, `${BUNDLE}/b.md`, ['type: Memory', 'title: B', 'status: deprecated'])
    seedConcept(root, `${OTHER_BUNDLE}/c.md`, ['type: Memory', 'title: C'])

    queueKnowledgeCommit(BUNDLE, ['a.md'], {
      op: 'Creation',
      path: 'a.md',
      actor: 'shuvix-work/gpt-5'
    })
    queueKnowledgeCommit(BUNDLE, ['b.md'], {
      op: 'Update',
      path: 'b.md',
      actor: 'shuvix-work/gpt-5'
    })
    queueKnowledgeCommit(OTHER_BUNDLE, ['c.md'], { op: 'Creation', path: 'c.md' })
    await flushKnowledgeCommits()

    expect(gitCommitCount(dir)).toBe(2)
    expect(gitHeadMessage(dir)).toBe(
      'kb(batch): 2 changes\n\n- creation /a.md\n- update /b.md\n\nKnowledge-Op: batch\nKnowledge-Actor: shuvix-work/gpt-5'
    )
    expect(gitHeadFiles(dir)).toEqual(['a.md', 'b.md'])
    // 另一个 bundle 只收到属于它的那一条
    expect(gitCommitCount(otherDir)).toBe(2)
    expect(gitHeadMessage(otherDir)).toBe('kb(creation): /c.md\n\nKnowledge-Op: creation')
    expect(gitHeadFiles(otherDir)).toEqual(['c.md'])

    const bare = `${PROJECTS}/bare`
    mkdirSync(bundleAt(root, bare), { recursive: true })
    seedConcept(root, `${bare}/a.md`, ['type: Memory', 'title: A'])
    queueKnowledgeCommit(bare, ['a.md'], { op: 'Creation', path: 'a.md' })
    await expect(flushKnowledgeCommits()).resolves.toBeUndefined()
    expect(existsSync(join(bundleAt(root, bare), '.git'))).toBe(false)
  })
})

describe('ensureBundleRepo —— 用户库', () => {
  it('RP-4 .git 建在用户根下的库目录里，基线收下全部现有文件（嵌套目录与非 md 照收）；已经是用户自己的仓库时一个提交都不加、HEAD 不变；exclude 的文件不进基线，其余照收', async () => {
    const userRoot = userRootOf(root)
    const notes = join(userRoot, 'notes')
    seedConcept(userRoot, 'notes/a.md', ['type: Memory', 'title: A'])
    seedFile(userRoot, 'notes/sub/deep/b.md', '# b\n')
    seedFile(userRoot, 'notes/assets/pic.png', 'png')

    await ensureBundleRepo('knowledge/notes')
    expect(existsSync(join(notes, '.git'))).toBe(true)
    // 不是建在 shuvix 根下同形的路径里
    expect(existsSync(join(root, 'knowledge'))).toBe(false)
    expect(gitLog(notes, '%s')).toEqual(['kb(init): knowledge base'])
    expect(gitHeadFiles(notes)).toEqual(['a.md', 'assets/pic.png', 'sub/deep/b.md'])
    expect(gitStatus(notes)).toBe('')

    // 用户自己的仓库：原样沿用，连后来冒出来的未跟踪文件也不替用户提交
    const vault = join(userRoot, 'vault')
    seedFile(userRoot, 'vault/note.md', '# note\n')
    gitAsUser(vault, ['init'])
    gitAsUser(vault, ['add', '.'])
    gitAsUser(vault, ['commit', '-m', 'My notes'])
    const head = gitOutput(vault, ['rev-parse', 'HEAD']).trim()
    seedFile(userRoot, 'vault/later.md', '# later\n')
    await ensureBundleRepo('knowledge/vault')
    expect(gitCommitCount(vault)).toBe(1)
    expect(gitOutput(vault, ['rev-parse', 'HEAD']).trim()).toBe(head)
    expect(gitStatus(vault)).toBe('?? later.md')

    // exclude：本批刚写下的文件不进基线，其余照收
    const fresh = join(userRoot, 'fresh')
    seedFile(userRoot, 'fresh/old.md', '# old\n')
    seedFile(userRoot, 'fresh/img/x.png', 'png')
    seedFile(userRoot, 'fresh/new.md', '# new\n')
    await ensureBundleRepo('knowledge/fresh', { exclude: ['new.md'] })
    expect(gitLog(fresh, '%s')).toEqual(['kb(init): knowledge base'])
    expect(gitHeadFiles(fresh)).toEqual(['img/x.png', 'old.md'])
    expect(gitStatus(fresh)).toBe('?? new.md')
  })
})
