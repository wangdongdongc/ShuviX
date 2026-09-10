/**
 * root —— 根目录懒初始化：mkdir、写种子（SCHEMA.md、global/）、投影 index/log、git init + 基线提交。
 * 幂等且串行：用户改过的种子从不覆盖，再调不记日志、不提交；并发调用只种一次。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { KNOWLEDGE_SCHEMA_SEED } from '@shuvix/agent-runtime'

const state = vi.hoisted(() => ({ root: '' }))

vi.mock('../../../utils/paths', () => ({
  getKnowledgeRootDir: () => state.root,
  getProjectMemoryDir: (id: string) => `${state.root}-memory/${id}`,
  listKnowledgeSessionDirs: () => []
}))
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

import { ensureKnowledgeRoot, isKnowledgeRootInitialized } from '../root'
import { invalidateKnowledgeScan } from '../scan'
import { gitCommitCount, gitLog, makeTempRoot } from './fixture'

let root: string

beforeEach(() => {
  root = makeTempRoot()
  state.root = root
  invalidateKnowledgeScan()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const creationCount = (dir: string): number =>
  readFileSync(join(dir, 'log.md'), 'utf-8').split('**Creation** /SCHEMA.md').length - 1

describe('ensureKnowledgeRoot', () => {
  it('RT-1 首次：种子（SCHEMA.md 逐字节、global/index.md）、根 index（okf_version + Bundle / Global memory 节）、log 首条 Creation（宿主署名）、git 基线提交', async () => {
    expect(isKnowledgeRootInitialized()).toBe(false)
    expect(await ensureKnowledgeRoot()).toBe(root)
    expect(isKnowledgeRootInitialized()).toBe(true)

    expect(readFileSync(join(root, 'SCHEMA.md'), 'utf-8')).toBe(KNOWLEDGE_SCHEMA_SEED)
    expect(existsSync(join(root, 'global', 'index.md'))).toBe(true)
    const index = readFileSync(join(root, 'index.md'), 'utf-8')
    expect(index.startsWith('---\nokf_version: "0.2"\n---\n\n')).toBe(true)
    expect(index).toContain('## Global memory')
    expect(index).toContain('## Bundle')
    expect(index).toMatch(/\* \[Knowledge base schema\]\(SCHEMA\.md\)/)
    expect(readFileSync(join(root, 'log.md'), 'utf-8')).toContain(
      '- **Creation** /SCHEMA.md — Knowledge base schema · by process:shuvix'
    )
    expect(existsSync(join(root, '.git'))).toBe(true)
    expect(gitLog(root, '%s')).toEqual(['kb(init): knowledge base'])
  })

  it('RT-2 幂等：用户改过的 SCHEMA.md 原样保留、不再记 Creation、不再提交；并发两次只种一次', async () => {
    await ensureKnowledgeRoot()
    appendFileSync(join(root, 'SCHEMA.md'), '\nUser rule: keep it short.\n')
    await ensureKnowledgeRoot()
    expect(readFileSync(join(root, 'SCHEMA.md'), 'utf-8')).toContain('User rule: keep it short.')
    expect(creationCount(root)).toBe(1)
    expect(gitCommitCount(root)).toBe(1)

    const fresh = makeTempRoot()
    try {
      state.root = fresh
      invalidateKnowledgeScan()
      await Promise.all([ensureKnowledgeRoot(), ensureKnowledgeRoot()])
      expect(creationCount(fresh)).toBe(1)
      expect(gitCommitCount(fresh)).toBe(1)
    } finally {
      rmSync(fresh, { recursive: true, force: true })
    }
  })
})
