/**
 * scan —— **按 bundle** 扫：一个 bundle 下全部 .md（ripgrep，跳过 .git）→ 概念清单，路径
 * bundle 相对，按 (mtime, size) 缓存、键是 `<bundle>/<rel>`。一次扫描只看一个 bundle，
 * 别的 bundle 既不进清单也不被失效 —— 那正是 bundle 边界的意思。
 * knowledgePaths 的两根 / bundle 路径算术（含「这条绝对路径属于哪个 bundle」）也在这里钉。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const state = vi.hoisted(() => ({ root: '' }))

vi.mock('../../../utils/paths', () => ({
  getShuvixKnowledgeRootDir: () => state.root,
  getUserKnowledgeRootDir: () => `${state.root}-user`
}))
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

import {
  PROJECTS_CONTAINER,
  bundleDir,
  bundleFilePath,
  locateBundle,
  toShuvixRelative
} from '../knowledgePaths'
import {
  invalidateKnowledgeScan,
  knownKnowledgePaths,
  listBundles,
  scanAllBundles,
  scanBundle
} from '../scan'
import {
  BUNDLE,
  OTHER_BUNDLE,
  PROJECTS,
  bundleAt,
  conceptText,
  fileAt,
  makeTempRoot,
  seedConcept,
  seedFile
} from './fixture'

let root: string

beforeEach(() => {
  root = makeTempRoot()
  state.root = root
  invalidateKnowledgeScan()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('knowledgePaths', () => {
  it('SN-1 bundle 路径算术：bundleDir / bundleFilePath 按平台分隔符拼；toShuvixRelative 根下 → forward-slash 相对路径、根本身与同前缀兄弟目录 → null；locateBundle 只认 `projects/<slug>` 这一层边界', () => {
    expect(PROJECTS_CONTAINER).toBe(PROJECTS)
    expect(bundleDir(BUNDLE)).toBe(join(root, 'projects', 'acme'))
    expect(bundleFilePath(BUNDLE, 'sub/x.md')).toBe(join(root, 'projects', 'acme', 'sub', 'x.md'))
    // 空 bundle id = 根本身：IPC / 笔记本按「根相对路径」还原绝对路径走这条
    expect(bundleFilePath('', 'projects/acme/x.md')).toBe(fileAt(root, BUNDLE, 'x.md'))

    expect(toShuvixRelative(fileAt(root, BUNDLE, 'x.md'))).toBe('projects/acme/x.md')
    expect(toShuvixRelative(`${root}\\projects\\acme\\x.md`)).toBe('projects/acme/x.md')
    expect(toShuvixRelative(root)).toBeNull()
    expect(toShuvixRelative(`${root}-other/projects/acme/x.md`)).toBeNull()

    expect(locateBundle(fileAt(root, BUNDLE, 'x.md'))).toEqual({ bundle: BUNDLE, rel: 'x.md' })
    expect(locateBundle(fileAt(root, BUNDLE, 'sub/x.md'))).toEqual({
      bundle: BUNDLE,
      rel: 'sub/x.md'
    })
    // bundle 目录本身不在任何 bundle「内」—— 宿主由目录反查 bundle id 时要拼上 index.md
    expect(locateBundle(bundleAt(root, BUNDLE))).toBeNull()
    expect(locateBundle(join(bundleAt(root, BUNDLE), 'index.md'))).toEqual({
      bundle: BUNDLE,
      rel: 'index.md'
    })
    // 容器里的散文件、根下的散文件、别的顶层目录、根外：都不属于任何 bundle
    expect(locateBundle(join(root, 'projects', 'x.md'))).toBeNull()
    expect(locateBundle(join(root, 'x.md'))).toBeNull()
    expect(locateBundle(join(root, 'other', 'acme', 'x.md'))).toBeNull()
    expect(locateBundle('/elsewhere/projects/acme/x.md')).toBeNull()
  })
})

describe('scanBundle', () => {
  it('SN-2 一个 bundle 下全部 .md（跳过 .git 与非 md），bundle 相对路径字典序；概念只算带 type 且无外家 shuvix 标记的；别的 bundle 不串台；目录不存在 → 空且不抛', async () => {
    seedFile(root, `${BUNDLE}/index.md`, '---\nokf_version: "0.2"\n---\n')
    seedFile(root, `${BUNDLE}/log.md`, '## 2026-09-09\n\n- x\n')
    seedFile(root, `${BUNDLE}/sub/index.md`, '')
    seedConcept(root, `${BUNDLE}/a.md`, ['type: Memory', 'title: A', 'description: da'])
    seedFile(root, `${BUNDLE}/notes.md`, '---\ntitle: notes\n---\n\nno type\n')
    seedFile(root, `${BUNDLE}/old.md`, '---\nshuvix: memory v1\ntype: Memory\n---\n\nold\n')
    seedFile(root, `${BUNDLE}/.git/x.md`, '---\ntype: Memory\n---\n\nhidden\n')
    seedFile(root, `${BUNDLE}/raw.txt`, 'not markdown')
    seedConcept(root, `${OTHER_BUNDLE}/b.md`, ['type: Memory', 'title: B', 'description: db'])

    const scan = await scanBundle(BUNDLE)
    expect(scan.bundle).toBe(BUNDLE)
    expect(scan.files.map((f) => f.path)).toEqual([
      'a.md',
      'index.md',
      'log.md',
      'notes.md',
      'old.md',
      'sub/index.md'
    ])
    expect(scan.concepts.map((c) => c.path)).toEqual(['a.md'])
    expect(scan.files.find((f) => f.path === 'a.md')!.text).toContain('title: A')
    // 缓存键带 bundle 前缀，所以两个 bundle 里的同名文件不会互相覆盖
    expect(await scanBundle(OTHER_BUNDLE)).toMatchObject({
      bundle: OTHER_BUNDLE,
      concepts: [expect.objectContaining({ path: 'b.md', title: 'B' })]
    })

    expect(await scanBundle(`${PROJECTS}/missing`)).toEqual({
      bundle: `${PROJECTS}/missing`,
      files: [],
      concepts: []
    })
  })

  it('SN-3 (mtime, size) 缓存：尺寸或 mtime 变即自然失效；同尺寸 + 同 mtime 的改写读不到，直到失效；失效按 bundle 划界（精确一条 / 整个 bundle / 全表）；删除的文件在下次扫描后从已知路径消失', async () => {
    const abs = seedConcept(root, `${BUNDLE}/a.md`, ['type: Memory', 'title: A1', 'description: d'])
    const other = seedConcept(root, `${OTHER_BUNDLE}/a.md`, [
      'type: Memory',
      'title: O1',
      'description: d'
    ])
    const t1 = new Date(1_700_000_000_000)
    utimesSync(abs, t1, t1)
    utimesSync(other, t1, t1)
    expect((await scanBundle(BUNDLE)).concepts[0].title).toBe('A1')
    expect((await scanBundle(OTHER_BUNDLE)).concepts[0].title).toBe('O1')
    expect(knownKnowledgePaths().has(`${BUNDLE}/a.md`)).toBe(true)
    expect(knownKnowledgePaths().has(`${OTHER_BUNDLE}/a.md`)).toBe(true)

    // 尺寸变 + mtime 变 → 自然失效
    writeFileSync(abs, conceptText(['type: Memory', 'title: A-long', 'description: d']))
    const t2 = new Date(1_700_000_001_000)
    utimesSync(abs, t2, t2)
    expect((await scanBundle(BUNDLE)).concepts[0].title).toBe('A-long')

    // 同尺寸 + mtime 复原 → 命中缓存（陈旧）；精确失效后才读到新内容
    writeFileSync(abs, conceptText(['type: Memory', 'title: B-long', 'description: d']))
    utimesSync(abs, t2, t2)
    expect((await scanBundle(BUNDLE)).concepts[0].title).toBe('A-long')
    invalidateKnowledgeScan(BUNDLE, '/a.md')
    expect((await scanBundle(BUNDLE)).concepts[0].title).toBe('B-long')

    // 失效不跨 bundle：整个 BUNDLE 失效后，OTHER 仍读缓存里的陈旧内容
    writeFileSync(other, conceptText(['type: Memory', 'title: O2', 'description: d']))
    utimesSync(other, t1, t1)
    invalidateKnowledgeScan(BUNDLE)
    expect((await scanBundle(OTHER_BUNDLE)).concepts[0].title).toBe('O1')
    invalidateKnowledgeScan()
    expect((await scanBundle(OTHER_BUNDLE)).concepts[0].title).toBe('O2')

    unlinkSync(abs)
    expect((await scanBundle(BUNDLE)).concepts).toEqual([])
    expect(knownKnowledgePaths().has(`${BUNDLE}/a.md`)).toBe(false)
    expect(knownKnowledgePaths().has(`${OTHER_BUNDLE}/a.md`)).toBe(true)
  })
})

describe('listBundles / scanAllBundles', () => {
  it('SN-4 磁盘上现存的 bundle 就是容器下的目录（隐藏目录与散文件不算，字典序）；容器 / 根不存在 → 空且不抛；scanAllBundles 逐个扫、结果与 bundle 一一对应', async () => {
    expect(listBundles()).toEqual([])
    expect(await scanAllBundles()).toEqual([])

    seedConcept(root, `${BUNDLE}/a.md`, ['type: Memory', 'title: A', 'description: da'])
    seedConcept(root, `${OTHER_BUNDLE}/b.md`, ['type: Memory', 'title: B', 'description: db'])
    mkdirSync(join(root, PROJECTS, '.hidden'), { recursive: true })
    seedFile(root, `${PROJECTS}/README.md`, 'not a bundle')
    seedConcept(root, 'other/c.md', ['type: Memory', 'title: C', 'description: dc'])

    expect(listBundles()).toEqual([BUNDLE, OTHER_BUNDLE])
    const scans = await scanAllBundles()
    expect(scans.map((s) => s.bundle)).toEqual([BUNDLE, OTHER_BUNDLE])
    expect(scans.map((s) => s.concepts.map((c) => c.path))).toEqual([['a.md'], ['b.md']])

    state.root = join(root, 'missing')
    invalidateKnowledgeScan()
    expect(listBundles()).toEqual([])
    expect(await scanAllBundles()).toEqual([])
  })
})
