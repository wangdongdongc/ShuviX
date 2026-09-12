/**
 * entries —— 侧栏 / 管理页的条目清单：扫描**全部 bundle** + toKnowledgeEntry 投影。
 * 钉两件事：清单是只读的（没有 bundle 就是空清单，不顺手建任何东西）；每条的 `path` 与
 * `bundle` 都相对 shuvix 根，所以跨 bundle 唯一，而信任档 / 核实时序 / 过期 / generated 章
 * 经真实扫描逐条投影到位。投影本身的判定表在 agent-runtime 的 entryView 测试里，
 * 这里验的是「扫描 → 投影」这条真实链路。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, readdirSync, rmSync } from 'node:fs'

const state = vi.hoisted(() => ({
  root: '',
  projects: {} as Record<string, { name: string } | undefined>
}))

vi.mock('../../../utils/paths', () => ({
  getShuvixKnowledgeRootDir: () => state.root,
  getUserKnowledgeRootDir: () => `${state.root}-user`
}))
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))
// 绑定概念的显示名取项目**当前**的名字 —— 目录名是 id，文件里的 title 是建库那一刻记下的
vi.mock('../../../dao/projectDao', () => ({
  projectDao: { findById: (id: string) => state.projects[id] }
}))

import { listKnowledgeEntries } from '../entries'
import { invalidateKnowledgeScan } from '../scan'
import { BUNDLE, OTHER_BUNDLE, PROJECTS, makeTempRoot, seedConcept, seedFile } from './fixture'

let root: string

beforeEach(() => {
  root = makeTempRoot()
  state.root = root
  state.projects = {}
  invalidateKnowledgeScan()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('listKnowledgeEntries', () => {
  it('EN-1 还没有任何 bundle：清单为空，报的是 shuvix 根 —— 清单只读，不建根、不建容器、不种任何规范文件', async () => {
    const { root: reported, entries } = await listKnowledgeEntries()

    expect(reported).toBe(root)
    expect(entries).toEqual([])
    expect(readdirSync(root)).toEqual([])

    // 根目录整个不存在时同样是空清单，而不是把它建出来
    state.root = `${root}-missing`
    invalidateKnowledgeScan()
    expect(await listKnowledgeEntries()).toEqual({ root: `${root}-missing`, entries: [] })
    expect(existsSync(`${root}-missing`)).toBe(false)
    state.root = root
  })

  it('EN-2 多个 bundle 经真实扫描投影：path 带 bundle 前缀（子目录里的条目 bundle 仍是 bundle 根）；保留文件、无 type 与带外家 shuvix 标记的文件不是条目；容器散文件与非容器目录不进清单；信任档 / 核实时序 / 过期 / generated 章逐条到位', async () => {
    seedConcept(root, `${BUNDLE}/project.md`, [
      'type: Project',
      'title: ACME',
      'resource: shuvix://project/p1',
      // 已退役的键当未知键留着：带着它的旧文件照常解析
      'shuvix_pinned: true'
    ])
    seedConcept(root, `${BUNDLE}/a.md`, [
      'type: Memory',
      'title: A',
      'description: da',
      'tags: [x, y]',
      'stale_after: 2000-01-01',
      'verified: [{ by: human:alice, at: 2026-09-01T00:00:00Z }]',
      'generated: { by: agent:coding/gpt-5, at: 2026-09-05T00:00:00Z }'
    ])
    seedConcept(root, `${BUNDLE}/sub/s.md`, ['type: Memory', 'title: S', 'stale_after: 2999-12-31'])
    seedFile(root, `${BUNDLE}/index.md`, '---\nokf_version: "0.2"\n---\n')
    seedFile(root, `${BUNDLE}/log.md`, '## 2026-09-09\n\n- x\n')
    seedFile(root, `${BUNDLE}/plain.md`, '---\ntitle: plain\n---\n\nno type\n')
    seedFile(root, `${BUNDLE}/old.md`, '---\nshuvix: memory v1\ntype: Memory\n---\n\nold\n')
    seedConcept(root, `${OTHER_BUNDLE}/b.md`, ['type: Memory', 'title: B', 'description: db'])
    seedConcept(root, `${PROJECTS}/stray.md`, ['type: Memory', 'title: Stray'])
    seedConcept(root, 'other/c.md', ['type: Memory', 'title: C'])

    const { entries } = await listKnowledgeEntries()
    const byPath = Object.fromEntries(entries.map((e) => [e.path, e]))

    expect(Object.keys(byPath).sort()).toEqual([
      `${BUNDLE}/a.md`,
      `${BUNDLE}/project.md`,
      `${BUNDLE}/sub/s.md`,
      `${OTHER_BUNDLE}/b.md`
    ])
    expect(byPath[`${BUNDLE}/a.md`]).toMatchObject({
      bundle: BUNDLE,
      type: 'Memory',
      title: 'A',
      description: 'da',
      status: 'stable',
      tags: ['x', 'y'],
      trustTier: 'human-reviewed',
      // verified 早于 generated：核实背书的不是当前内容
      verifiedCurrent: false,
      stale: true,
      generatedAt: '2026-09-05T00:00:00Z',
      generatedBy: 'agent:coding/gpt-5'
    })
    // 子目录里的条目仍属于 bundle 根，不是「另一个 bundle」
    expect(byPath[`${BUNDLE}/sub/s.md`]).toMatchObject({ bundle: BUNDLE, stale: false })
    expect(byPath[`${BUNDLE}/project.md`]).toMatchObject({ bundle: BUNDLE, type: 'Project' })
    expect(byPath[`${OTHER_BUNDLE}/b.md`]).toMatchObject({
      bundle: OTHER_BUNDLE,
      trustTier: 'unverified',
      verifiedCurrent: false,
      stale: false
    })
    for (const e of entries) expect(e.path, e.path).not.toMatch(/\\|^\//)
  })

  /**
   * 目录名是项目 id，而 project.md 里的 title 是**建库那一刻**记下的名字 —— 项目改名之后它就旧了。
   * 侧栏该显示用户此刻认得的那个名字，所以绑定概念的 title 在视图层换成项目的当前名字；
   * 文件本身不回写（每次改名塞一条提交，只为一行显示，不划算）。
   */
  it('EN-5 绑定概念的 title 取项目当前名字；项目已删 / 非绑定概念一概原样', async () => {
    seedConcept(root, `${BUNDLE}/project.md`, [
      'type: Project',
      'title: Old Name',
      'resource: shuvix://project/p1'
    ])
    seedConcept(root, `${BUNDLE}/a.md`, ['type: Memory', 'title: A'])
    seedConcept(root, `${OTHER_BUNDLE}/project.md`, [
      'type: Project',
      'title: Gone',
      'resource: shuvix://project/p-deleted'
    ])
    state.projects = { p1: { name: 'New Name' } }

    const byPath = new Map(
      (await listKnowledgeEntries()).entries.map((e) => [e.path, e.title] as const)
    )
    expect(byPath.get(`${BUNDLE}/project.md`)).toBe('New Name')
    // 普通条目不碰；项目查不到（已删）时保留文件里的 title，不留空
    expect(byPath.get(`${BUNDLE}/a.md`)).toBe('A')
    expect(byPath.get(`${OTHER_BUNDLE}/project.md`)).toBe('Gone')
  })
})
