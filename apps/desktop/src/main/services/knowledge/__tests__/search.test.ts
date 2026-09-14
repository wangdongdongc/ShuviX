/**
 * search —— 一个 bundle 的检索（okf-minisearch）。钉的是中文分词那次修复：MiniSearch 默认只按
 * 空白与标点切词，中文两个标点之间的一整段曾是一个词，段中间的词（「令牌」）一条都搜不到。
 * 这里走「扫描 → 建索引 → 检索」的真实链路，不碰内部的分词函数。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync } from 'node:fs'

const state = vi.hoisted(() => ({ root: '' }))

vi.mock('../../../utils/paths', () => ({
  getShuvixKnowledgeRootDir: () => state.root,
  getUserKnowledgeRootDir: () => `${state.root}-user`
}))
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

import { invalidateKnowledgeScan } from '../scan'
import { invalidateKnowledgeSearch, searchBundle } from '../search'
import { BUNDLE, makeTempRoot, seedConcept } from './fixture'

let root: string

beforeEach(() => {
  root = makeTempRoot()
  state.root = root
  invalidateKnowledgeScan()
  invalidateKnowledgeSearch()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const seed = (): void => {
  seedConcept(
    root,
    `${BUNDLE}/token.md`,
    ['type: Memory', 'title: 鉴权与令牌刷新', 'description: 改动登录时看', 'status: stable'],
    '访问令牌过期后，用刷新令牌换一个新的访问令牌。'
  )
  seedConcept(
    root,
    `${BUNDLE}/pipeline.md`,
    ['type: Memory', 'title: Build pipeline', 'description: before merging', 'status: stable'],
    'The pipeline runs the full end-to-end suite before merge.'
  )
  seedConcept(
    root,
    `${BUNDLE}/old.md`,
    ['type: Memory', 'title: 旧的令牌方案', 'description: 已废弃', 'status: deprecated'],
    '以前用长期令牌。'
  )
}

describe('searchBundle', () => {
  it('SR-1 中文段落中间的词能搜到（默认分词器会把整段当成一个词）', async () => {
    seed()
    for (const q of ['令牌', '刷新', '访问令牌']) {
      const paths = (await searchBundle(BUNDLE, q, { limit: 10 })).map((h) => h.path)
      expect(paths, q).toContain('token.md')
    }
  })

  it('SR-2 英文与整段标题照旧能搜到；deprecated 不出现在结果里', async () => {
    seed()
    expect((await searchBundle(BUNDLE, 'pipeline', { limit: 10 })).map((h) => h.path)).toEqual([
      'pipeline.md'
    ])
    expect(
      (await searchBundle(BUNDLE, '鉴权与令牌刷新', { limit: 10 })).map((h) => h.path)
    ).toContain('token.md')
    const paths = (await searchBundle(BUNDLE, '令牌', { limit: 10 })).map((h) => h.path)
    expect(paths).not.toContain('old.md')
  })

  it('SR-3 片段里不残留分词用的词界标记，回来的是原文', async () => {
    seed()
    const [hit] = await searchBundle(BUNDLE, '令牌', { limit: 1 })
    expect(hit.snippet).toBeDefined()
    expect(hit.snippet).not.toMatch(/\u200A/)
    expect(hit.snippet).toContain('访问令牌过期后')
  })
})
