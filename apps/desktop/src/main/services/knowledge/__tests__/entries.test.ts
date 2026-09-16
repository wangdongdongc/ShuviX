/**
 * entries —— 侧栏 / 管理页的条目清单：扫描**全部 bundle**（项目库 + 用户库）+ toKnowledgeEntry 投影。
 * 钉两件事：清单是只读的（没有 bundle 就是空清单，不顺手建任何东西）；每条的 `path` 与
 * `bundle` 用两个根共用的 id 名字空间（`projects/<id>/…` / `knowledge/<库名>/…`），所以跨 bundle、
 * 跨根都唯一，而信任档 / 核实时序 / 过期 / generated 章经真实扫描逐条投影到位。投影本身的判定表在
 * agent-runtime 的 entryView 测试里，这里验的是「扫描 → 投影」这条真实链路。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

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
import {
  BUNDLE,
  OTHER_BUNDLE,
  PROJECTS,
  makeTempRoot,
  seedConcept,
  seedFile,
  userRootOf
} from './fixture'

let root: string

beforeEach(() => {
  root = makeTempRoot()
  state.root = root
  state.projects = {}
  invalidateKnowledgeScan()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(userRootOf(root), { recursive: true, force: true })
})

describe('listKnowledgeEntries', () => {
  it('EN-1 还没有任何 bundle：清单为空，报的是两个根 —— 清单只读，不建根、不建容器、不种任何规范文件', async () => {
    const { root: reported, entries } = await listKnowledgeEntries()

    expect(reported).toBe(root)
    expect(entries).toEqual([])
    expect(readdirSync(root)).toEqual([])
    expect(existsSync(`${root}-user`)).toBe(false)

    // 根目录整个不存在时同样是空清单，而不是把它建出来
    state.root = `${root}-missing`
    invalidateKnowledgeScan()
    expect(await listKnowledgeEntries()).toEqual({
      root: `${root}-missing`,
      userRoot: `${root}-missing-user`,
      entries: [],
      dirs: [],
      bundleNames: {}
    })
    expect(existsSync(`${root}-missing`)).toBe(false)
    state.root = root
  })

  it('EN-2 多个 bundle 经真实扫描投影：path 带 bundle 前缀（子目录里的条目 bundle 仍是 bundle 根）；早先生成形状的 index / log 不进清单，无 type 与带外家 shuvix 标记的文件按文件名照常列出（不合规也不藏）；容器散文件与非容器目录不进清单；信任档 / 核实时序 / 过期 / generated 章逐条到位', async () => {
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
    seedFile(root, `${BUNDLE}/log.md`, '## 2026-09-09\n\n- **Creation** /a.md — A\n')
    seedFile(root, `${BUNDLE}/plain.md`, '---\ntitle: plain\n---\n\nno type\n')
    seedFile(root, `${BUNDLE}/old.md`, '---\nshuvix: memory v1\ntype: Memory\n---\n\nold\n')
    seedConcept(root, `${OTHER_BUNDLE}/b.md`, ['type: Memory', 'title: B', 'description: db'])
    seedConcept(root, `${PROJECTS}/stray.md`, ['type: Memory', 'title: Stray'])
    seedConcept(root, 'other/c.md', ['type: Memory', 'title: C'])

    const { entries } = await listKnowledgeEntries()
    const byPath = Object.fromEntries(entries.map((e) => [e.path, e]))

    expect(Object.keys(byPath).sort()).toEqual([
      `${BUNDLE}/a.md`,
      `${BUNDLE}/old.md`,
      `${BUNDLE}/plain.md`,
      `${BUNDLE}/project.md`,
      `${BUNDLE}/sub/s.md`,
      `${OTHER_BUNDLE}/b.md`
    ])
    // 不合规的 md（无 type / 外家标记）照常一行：文件名当标题，其余取合规条目的缺省值
    for (const [path, title] of [
      [`${BUNDLE}/plain.md`, 'plain'],
      [`${BUNDLE}/old.md`, 'old']
    ]) {
      expect(byPath[path], path).toEqual({
        path,
        bundle: BUNDLE,
        type: '',
        title,
        description: '',
        status: 'stable',
        tags: [],
        trustTier: 'unverified',
        verifiedCurrent: false,
        stale: false
      })
    }
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
   * 项目库的目录名是项目 id —— 不给人看。显示名随清单下发（bundleNames），按 id 查项目**当前**的名字：
   * 改名即时生效，不靠任何写在库里的文件；查不到（项目已删）就不给，侧栏回落目录名；用户库不在其中。
   */
  it('EN-5 bundleNames：项目库按 id 取项目当前名字；项目已删不给；用户库不给；条目自己的标题不受影响', async () => {
    seedConcept(root, 'projects/p1/a.md', ['type: Memory', 'title: A'])
    seedConcept(root, 'projects/p-deleted/b.md', ['type: Memory', 'title: B'])
    seedConcept(userRootOf(root), 'notes/c.md', ['type: Memory', 'title: C'])
    state.projects = { p1: { name: 'New Name' } }

    const listed = await listKnowledgeEntries()
    expect(listed.bundleNames).toEqual({ 'projects/p1': 'New Name' })
    const titles = new Map(listed.entries.map((e) => [e.path, e.title] as const))
    expect(titles.get('projects/p1/a.md')).toBe('A')
    expect(titles.get('projects/p-deleted/b.md')).toBe('B')
    expect(titles.get('knowledge/notes/c.md')).toBe('C')
  })

  it('EN-6 用户库进清单：path / bundle 用 `knowledge/<库名>` 名字空间；没有 frontmatter / 没有 type / 别家标记的 md 照常一行；ShuviX 早先生成形状的 log、隐藏目录、非 md、用户根散文件、没有 md 的库都不出现，用户手写的 index / log 照常一行（标题取第一个 # 标题）；拷进来的 project.md 就是普通条目；清单只读', async () => {
    const userRoot = userRootOf(root)
    const notes = join(userRoot, 'notes')
    seedConcept(userRoot, 'notes/a.md', ['type: Memory', 'title: A', 'status: draft'])
    seedConcept(userRoot, 'notes/sub/b.md', ['type: Memory', 'title: B'])
    seedFile(userRoot, 'notes/plain.md', '# plain\n\nno frontmatter\n')
    seedFile(userRoot, 'notes/untyped.md', '---\ntitle: x\n---\n\nno type\n')
    seedFile(userRoot, 'notes/foreign.md', '---\nshuvix: agent v1\ntype: Memory\n---\n\nforeign\n')
    seedFile(userRoot, 'notes/index.md', '# my index\n')
    seedFile(userRoot, 'notes/log.md', '# my log\n')
    seedFile(userRoot, 'notes/sub/index.md', '# sub index\n')
    // ShuviX 早先生成的 log（只有日期标题与列表行）：不再维护、也不当笔记
    seedFile(userRoot, 'notes/sub/log.md', '## 2026-09-09\n\n- **Creation** /b.md\n')
    seedConcept(userRoot, 'notes/.trash/y.md', ['type: Memory', 'title: Y'])
    // 拷进用户库的 project.md 是用户自己的文件：resource 恰好指向一个现存项目也不换标题
    seedConcept(userRoot, 'notes/project.md', [
      'type: Project',
      'title: Mine',
      'resource: shuvix://project/p1'
    ])
    state.projects = { p1: { name: 'Live Name' } }
    mkdirSync(join(userRoot, 'empty'))
    seedFile(userRoot, 'imgs/pic.png', 'png')
    seedConcept(userRoot, '.trash/x.md', ['type: Memory', 'title: X'])
    seedFile(userRoot, 'readme.md', '# readme\n')
    seedConcept(root, 'projects/p1/a.md', ['type: Memory', 'title: PA'])
    const notesBefore = readdirSync(notes).sort()

    const listed = await listKnowledgeEntries()
    expect(listed.root).toBe(root)
    expect(listed.userRoot).toBe(`${root}-user`)
    // 恰好这些：empty / imgs 没有 md、.trash 与 readme 不在任何库里；生成形状的 log 不列，手写的 index / log 是笔记
    expect(listed.entries.map((e) => e.path).sort()).toEqual([
      'knowledge/notes/a.md',
      'knowledge/notes/foreign.md',
      'knowledge/notes/index.md',
      'knowledge/notes/log.md',
      'knowledge/notes/plain.md',
      'knowledge/notes/project.md',
      'knowledge/notes/sub/b.md',
      'knowledge/notes/sub/index.md',
      'knowledge/notes/untyped.md',
      'projects/p1/a.md'
    ])
    expect(listed.bundleNames).toEqual({ 'projects/p1': 'Live Name' })
    const byPath = Object.fromEntries(listed.entries.map((e) => [e.path, e]))

    expect(byPath['knowledge/notes/a.md']).toMatchObject({
      bundle: 'knowledge/notes',
      type: 'Memory',
      title: 'A',
      status: 'draft'
    })
    // 子目录里的条目仍属于库根
    expect(byPath['knowledge/notes/sub/b.md']).toMatchObject({ bundle: 'knowledge/notes' })
    for (const [path, title] of [
      ['knowledge/notes/plain.md', 'plain'],
      // frontmatter 里有 title 就用它（没有 type 也一样）
      ['knowledge/notes/untyped.md', 'x'],
      ['knowledge/notes/foreign.md', 'foreign']
    ]) {
      expect(byPath[path], path).toStrictEqual({
        path,
        bundle: 'knowledge/notes',
        type: '',
        title,
        description: '',
        status: 'stable',
        tags: [],
        trustTier: 'unverified',
        verifiedCurrent: false,
        stale: false
      })
    }
    for (const [path, title] of [
      ['knowledge/notes/index.md', 'my index'],
      ['knowledge/notes/log.md', 'my log'],
      ['knowledge/notes/sub/index.md', 'sub index']
    ]) {
      expect(byPath[path], path).toMatchObject({ bundle: 'knowledge/notes', type: '', title })
    }
    expect(byPath['knowledge/notes/project.md']).toMatchObject({
      bundle: 'knowledge/notes',
      type: 'Project',
      title: 'Mine'
    })
    expect(byPath['projects/p1/a.md']).toMatchObject({ bundle: 'projects/p1', title: 'PA' })

    // 只读：用户的文件夹原样
    expect(readdirSync(notes).sort()).toEqual(notesBefore)
    expect(readdirSync(join(userRoot, 'empty'))).toEqual([])
  })

  /**
   * project.md 已撤销（设计附录 L）：显示名只看 projectDao 里项目当前的名字，库里残留的旧章程不再参与命名，
   * 它就是一篇普通的笔记，照常自己占一行。
   */
  it('EN-7 残留的旧 project.md 不再给库命名：bundleNames 恒取项目当前名字，project.md 自己是一行', async () => {
    seedConcept(root, 'projects/p1/project.md', [
      'type: Project',
      'title: Old Charter',
      'resource: shuvix://project/p1'
    ])
    state.projects = { p1: { name: 'New Name' } }

    const listed = await listKnowledgeEntries()
    expect(listed.bundleNames).toEqual({ 'projects/p1': 'New Name' })
    expect(listed.entries.map((e) => e.path)).toEqual(['projects/p1/project.md'])
    expect(listed.entries[0]).toMatchObject({
      bundle: 'projects/p1',
      title: 'Old Charter',
      type: 'Project'
    })
  })
})
