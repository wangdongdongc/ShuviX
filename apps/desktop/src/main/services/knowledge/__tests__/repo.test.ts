/**
 * repo —— 整个 bundle 一个 git 仓库：存在性由宿主保证（init + 基线提交，幂等），每批观察到的
 * 变更提交一次（300ms 去抖合批），署名 ShuviX Knowledge，内容出自谁写在 trailer。
 * 一切失败只记日志 —— 非仓库根目录静默跳过。提交经真实 isomorphic-git 落盘、用 git CLI 读回。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const state = vi.hoisted(() => ({ root: '' }))

vi.mock('../../../utils/paths', () => ({
  getKnowledgeRootDir: () => state.root,
  getProjectMemoryDir: (id: string) => `${state.root}-memory/${id}`,
  listKnowledgeSessionDirs: () => []
}))
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

import { ensureKnowledgeRepo, flushKnowledgeCommits, queueKnowledgeCommit } from '../repo'
import {
  gitCommitCount,
  gitHeadFiles,
  gitHeadMessage,
  gitLog,
  gitStatus,
  makeTempRoot,
  seedConcept,
  seedFile
} from './fixture'

const SCHEMA = '---\ntype: Schema\ntitle: Schema\n---\n\nschema\n'

let root: string

beforeEach(() => {
  root = makeTempRoot()
  state.root = root
})

afterEach(async () => {
  await flushKnowledgeCommits()
  rmSync(root, { recursive: true, force: true })
})

describe('ensureKnowledgeRepo', () => {
  it('RP-1 非仓库根目录：init + 当前全部文件作基线一次提交（署名 ShuviX Knowledge）；再调不加提交；根目录不存在 → 不抛、不建 .git', async () => {
    seedFile(root, 'SCHEMA.md', SCHEMA)
    seedConcept(root, 'global/a.md', ['type: Memory', 'title: A'])

    await ensureKnowledgeRepo()
    expect(existsSync(join(root, '.git'))).toBe(true)
    expect(gitLog(root, '%s')).toEqual(['kb(init): knowledge base'])
    expect(gitLog(root, '%an <%ae>')).toEqual(['ShuviX Knowledge <knowledge@shuvix.local>'])
    expect(gitHeadFiles(root)).toEqual(['SCHEMA.md', 'global/a.md'])
    expect(gitStatus(root)).toBe('')

    await ensureKnowledgeRepo()
    expect(gitCommitCount(root)).toBe(1)

    state.root = join(root, 'missing')
    await expect(ensureKnowledgeRepo()).resolves.toBeUndefined()
    expect(existsSync(join(state.root, '.git'))).toBe(false)
  })
})

describe('queueKnowledgeCommit / flushKnowledgeCommits', () => {
  it('RP-2 单条：subject `kb(<op>): /<path>` + Knowledge-Op / Knowledge-Actor trailer；只提交列出的路径；无 actor 则无 Knowledge-Actor', async () => {
    seedFile(root, 'SCHEMA.md', SCHEMA)
    await ensureKnowledgeRepo()

    seedConcept(root, 'global/x.md', ['type: Memory', 'title: X'])
    seedFile(root, 'global/index.md', '## Entries\n\n* [X](x.md)\n')
    seedFile(root, 'log.md', '## 2026-09-09\n\n- **Creation** /global/x.md\n')
    seedConcept(root, 'global/other.md', ['type: Memory', 'title: Other'])

    queueKnowledgeCommit(['global/x.md', 'global/index.md', 'log.md'], {
      op: 'Creation',
      path: 'global/x.md',
      actor: 'shuvix-work/gpt-5'
    })
    await flushKnowledgeCommits()
    expect(gitHeadMessage(root)).toBe(
      'kb(creation): /global/x.md\n\nKnowledge-Op: creation\nKnowledge-Actor: shuvix-work/gpt-5'
    )
    expect(gitHeadFiles(root)).toEqual(['global/index.md', 'global/x.md', 'log.md'])
    // 没列出的脏文件不暂存
    expect(gitStatus(root)).toBe('?? global/other.md')

    queueKnowledgeCommit(['global/other.md'], { op: 'Update', path: 'global/other.md' })
    await flushKnowledgeCommits()
    expect(gitHeadMessage(root)).toBe('kb(update): /global/other.md\n\nKnowledge-Op: update')
    expect(gitStatus(root)).toBe('')
    expect(gitCommitCount(root)).toBe(3)
  })

  it('RP-3 去抖窗口内多次排队合成一条 batch 提交（逐条列出、actor 取首个）；非仓库根目录静默跳过', async () => {
    seedFile(root, 'SCHEMA.md', SCHEMA)
    await ensureKnowledgeRepo()
    seedConcept(root, 'a.md', ['type: Memory', 'title: A'])
    seedConcept(root, 'b.md', ['type: Memory', 'title: B', 'status: deprecated'])

    queueKnowledgeCommit(['a.md'], { op: 'Creation', path: 'a.md', actor: 'shuvix-work/gpt-5' })
    queueKnowledgeCommit(['b.md'], { op: 'Deprecation', path: 'b.md', actor: 'shuvix-work/gpt-5' })
    await flushKnowledgeCommits()
    expect(gitCommitCount(root)).toBe(2)
    expect(gitHeadMessage(root)).toBe(
      'kb(batch): 2 changes\n\n- creation /a.md\n- deprecation /b.md\n\nKnowledge-Op: batch\nKnowledge-Actor: shuvix-work/gpt-5'
    )
    expect(gitHeadFiles(root)).toEqual(['a.md', 'b.md'])

    const bare = makeTempRoot()
    try {
      state.root = bare
      seedConcept(bare, 'a.md', ['type: Memory', 'title: A'])
      queueKnowledgeCommit(['a.md'], { op: 'Creation', path: 'a.md' })
      await expect(flushKnowledgeCommits()).resolves.toBeUndefined()
      expect(existsSync(join(bare, '.git'))).toBe(false)
    } finally {
      rmSync(bare, { recursive: true, force: true })
    }
  })
})
