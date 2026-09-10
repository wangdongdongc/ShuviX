/**
 * entries —— 侧栏 / 管理页的条目清单：ensureKnowledgeRoot（分组首次展开即用户意图 → 懒建根）
 * + 真实扫描 + toKnowledgeEntry 投影。钉两件事：全新根目录被种下之后清单恰好是那一条
 * SCHEMA.md（保留文件 index.md / log.md 不是条目）；种好的 bundle 经真实扫描后作用域 / 信任档 /
 * 核实时序 / 过期 / 常驻 / generated 章逐条投影到位，非概念文件不出现。投影本身的判定表在
 * agent-runtime 的 entryView 测试里，这里验的是「扫描 → 投影」这条真实链路。
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

import { listKnowledgeEntries } from '../entries'
import { isKnowledgeRootInitialized } from '../root'
import { invalidateKnowledgeScan } from '../scan'
import { makeTempRoot, seedConcept, seedFile } from './fixture'

let root: string

beforeEach(() => {
  root = makeTempRoot()
  state.root = root
  invalidateKnowledgeScan()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('listKnowledgeEntries', () => {
  it('EN-1 全新根目录：先种根（SCHEMA.md / index.md / log.md / global/index.md / .git），清单恰好一条 SCHEMA.md 条目；保留文件不是条目', async () => {
    expect(isKnowledgeRootInitialized()).toBe(false)

    const { root: reported, entries } = await listKnowledgeEntries()

    expect(reported).toBe(root)
    for (const rel of ['SCHEMA.md', 'index.md', 'log.md', 'global/index.md', '.git']) {
      expect(existsSync(join(root, ...rel.split('/'))), rel).toBe(true)
    }

    expect(entries.map((e) => e.path)).toEqual(['SCHEMA.md'])
    const [schema] = entries
    expect(schema).toMatchObject({
      path: 'SCHEMA.md',
      scope: null,
      type: 'Schema',
      title: 'Knowledge base schema',
      status: 'stable',
      tags: ['schema'],
      trustTier: 'unverified',
      verifiedCurrent: false,
      stale: false,
      pinned: false
    })
    expect(schema.description.length).toBeGreaterThan(0)
    expect(schema).not.toHaveProperty('generatedAt')
    expect(schema).not.toHaveProperty('generatedBy')
  })

  it('EN-2 种好的 bundle 经真实扫描投影：作用域 / 信任档 / 核实时序 / 过期 / 常驻 / generated 章逐条到位；无 type 与带 shuvix 标记的文件不出现；路径为 forward-slash 相对路径', async () => {
    seedConcept(root, 'global/a.md', [
      'type: Memory',
      'title: A',
      'description: da',
      'stale_after: 2000-01-01',
      'verified: [{ by: human:alice, at: 2026-09-01T00:00:00Z }]',
      'generated: { by: agent:coding/gpt-5, at: 2026-09-05T00:00:00Z }'
    ])
    seedConcept(root, 'projects/acme/project.md', [
      'type: Project',
      'title: ACME',
      'resource: shuvix://project/p1',
      'shuvix_pinned: true'
    ])
    seedConcept(root, 'projects/acme/sessions/2026-09-01-s.md', [
      'type: Session Summary',
      'title: S',
      'stale_after: 2999-12-31'
    ])
    seedConcept(root, 'bots/helper/bot.md', [
      'type: Bot',
      'title: Helper',
      'resource: shuvix://bot/helper'
    ])
    seedFile(root, 'global/plain.md', '---\ntitle: plain\n---\n\nno type\n')
    seedFile(root, 'global/old.md', '---\nshuvix: memory v1\ntype: Memory\n---\n\nold\n')

    const { entries } = await listKnowledgeEntries()
    const byPath = Object.fromEntries(entries.map((e) => [e.path, e]))

    expect(Object.keys(byPath).sort()).toEqual([
      'SCHEMA.md',
      'bots/helper/bot.md',
      'global/a.md',
      'projects/acme/project.md',
      'projects/acme/sessions/2026-09-01-s.md'
    ])
    expect(byPath['global/a.md']).toMatchObject({
      scope: 'global',
      trustTier: 'human-reviewed',
      verifiedCurrent: false,
      stale: true,
      generatedAt: '2026-09-05T00:00:00Z',
      generatedBy: 'agent:coding/gpt-5'
    })
    expect(byPath['projects/acme/project.md']).toMatchObject({ scope: 'project', pinned: true })
    expect(byPath['projects/acme/sessions/2026-09-01-s.md']).toMatchObject({
      scope: 'session',
      stale: false
    })
    expect(byPath['bots/helper/bot.md']).toMatchObject({ scope: 'bot' })
    for (const e of entries) expect(e.path, e.path).not.toMatch(/\\|^\//)
  })
})
