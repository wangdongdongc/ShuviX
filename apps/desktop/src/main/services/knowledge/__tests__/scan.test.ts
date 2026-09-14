/**
 * scan —— **按 bundle** 扫：一个 bundle 下全部 .md（ripgrep，跳过隐藏文件与目录）→ 概念清单，路径
 * bundle 相对，按 (mtime, size) 缓存、键是 `<bundle>/<rel>`。一次扫描只看一个 bundle，
 * 别的 bundle 既不进清单也不被失效 —— 那正是 bundle 边界的意思。
 * knowledgePaths 的两根 / bundle 路径算术（含「这条绝对路径属于哪个 bundle」）也在这里钉。
 *
 * 用户库：用户根下每个非隐藏子目录都是一个库（不要标记，空目录也算），bundle id `knowledge/<库名>`
 * 与项目库共用一个名字空间；扫描同样只读。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, readdirSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
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
  USER_CONTAINER,
  bundleDir,
  bundleFilePath,
  entryFilePath,
  isUserBundle,
  isValidLibraryName,
  locateBundle,
  toShuvixRelative,
  toUserRelative,
  userBundleId
} from '../knowledgePaths'
import {
  invalidateKnowledgeScan,
  knownKnowledgePaths,
  listBundles,
  listUserLibraries,
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
  seedFile,
  userRootOf
} from './fixture'

let root: string

beforeEach(() => {
  root = makeTempRoot()
  state.root = root
  invalidateKnowledgeScan()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(userRootOf(root), { recursive: true, force: true })
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

  it('SN-5 两个根共用一个名字空间：`knowledge/<库名>` 落用户根、其余落 shuvix 根；库名 = 单段非隐藏；locateBundle 的用户库边界是用户根下第一层，任一段隐藏即不属于任何库；id 经 entryFilePath → locateBundle 往返不变', () => {
    const userRoot = userRootOf(root)
    expect(USER_CONTAINER).toBe('knowledge')
    expect(userBundleId('notes')).toBe('knowledge/notes')
    expect(bundleDir('knowledge/notes')).toBe(join(userRoot, 'notes'))
    expect(bundleFilePath('knowledge/notes', 'sub/a.md')).toBe(
      join(userRoot, 'notes', 'sub', 'a.md')
    )
    // 按首段分派
    expect(entryFilePath('knowledge/notes/a.md')).toBe(join(userRoot, 'notes', 'a.md'))
    expect(entryFilePath('projects/p1/a.md')).toBe(join(root, 'projects', 'p1', 'a.md'))

    for (const id of ['knowledge/notes', '/knowledge/notes/x.md', 'knowledge\\notes']) {
      expect(isUserBundle(id), id).toBe(true)
    }
    for (const id of ['projects/p1', 'knowledgebase/x.md', 'notes/knowledge/x.md']) {
      expect(isUserBundle(id), id).toBe(false)
    }

    for (const name of ['', '.obsidian', '.', '..', 'a/b', 'a\\b']) {
      expect(isValidLibraryName(name), name).toBe(false)
    }
    for (const name of ['notes', '读书笔记', 'my notes', 'project']) {
      expect(isValidLibraryName(name), name).toBe(true)
    }

    expect(toUserRelative(userRoot)).toBeNull()
    expect(toUserRelative(`${userRoot}x/notes/a.md`)).toBeNull()
    expect(toUserRelative(`${userRoot}\\notes\\a.md`)).toBe('notes/a.md')

    expect(locateBundle(join(userRoot, 'notes', 'a.md'))).toEqual({
      bundle: 'knowledge/notes',
      rel: 'a.md'
    })
    expect(locateBundle(join(userRoot, 'notes', 'sub', 'a.md'))).toEqual({
      bundle: 'knowledge/notes',
      rel: 'sub/a.md'
    })
    expect(locateBundle(join(userRoot, 'notes', 'index.md'))).toEqual({
      bundle: 'knowledge/notes',
      rel: 'index.md'
    })
    for (const abs of [
      // 库目录本身、用户根下的散文件、用户根下的隐藏目录
      join(userRoot, 'notes'),
      join(userRoot, 'readme.md'),
      join(userRoot, '.trash', 'a.md'),
      // knowledge-shuvix 根下永远没有 `knowledge` 容器
      join(root, 'knowledge', 'notes', 'a.md'),
      // 任一段隐藏：库内的回收站 / 更深的隐藏目录 / 项目库的 .git
      join(userRoot, 'notes', '.trash', 'a.md'),
      join(userRoot, 'notes', 'sub', '.hidden', 'a.md'),
      join(root, 'projects', 'p1', '.git', 'x.md')
    ]) {
      expect(locateBundle(abs), abs).toBeNull()
    }

    for (const [id, bundle, rel] of [
      ['knowledge/notes/sub/a.md', 'knowledge/notes', 'sub/a.md'],
      ['projects/p1/a.md', 'projects/p1', 'a.md']
    ]) {
      expect(locateBundle(entryFilePath(id)), id).toEqual({ bundle, rel })
    }
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
      concepts: [],
      notes: []
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

describe('用户库：listUserLibraries / listBundles / scanAllBundles', () => {
  it('SN-6 用户根下每个非隐藏子目录都是一个库（不要标记，空目录也算），排在项目库之后；扫描跳过隐藏文件与目录，没有标记的 md 照样是概念；缓存键带 `knowledge/<库名>` 前缀、按 bundle 失效；扫描只读；用户根不存在 → 只剩项目库、不抛', async () => {
    const userRoot = userRootOf(root)
    const notes = join(userRoot, 'notes')
    seedConcept(userRoot, 'notes/a.md', ['type: Memory', 'title: A'])
    seedFile(userRoot, 'notes/plain.md', '# plain\n\nno frontmatter\n')
    seedConcept(userRoot, 'notes/.git/x.md', ['type: Memory', 'title: X'])
    seedConcept(userRoot, 'notes/sub/b.md', ['type: Memory', 'title: B'])
    seedConcept(userRoot, 'notes/.trash/d.md', ['type: Memory', 'title: D'])
    seedConcept(userRoot, 'notes/.obsidian/e.md', ['type: Memory', 'title: E'])
    mkdirSync(join(userRoot, 'alpha'))
    seedConcept(userRoot, '.obsidian/c.md', ['type: Memory', 'title: C'])
    seedFile(userRoot, 'readme.md', '# readme\n')
    seedConcept(root, 'projects/p1/project.md', [
      'type: Project',
      'title: P1',
      'resource: shuvix://project/p1'
    ])
    const notesBefore = readdirSync(notes).sort()

    expect(listUserLibraries()).toEqual(['alpha', 'notes'])
    expect(listBundles()).toEqual(['projects/p1', 'knowledge/alpha', 'knowledge/notes'])

    const scans = await scanAllBundles()
    expect(scans.map((s) => s.bundle)).toEqual([
      'projects/p1',
      'knowledge/alpha',
      'knowledge/notes'
    ])
    expect(scans[1]).toEqual({ bundle: 'knowledge/alpha', files: [], concepts: [], notes: [] })
    // 隐藏目录（.git / .trash / .obsidian）下的一概不扫
    expect(scans[2].files.map((f) => f.path)).toEqual(['a.md', 'plain.md', 'sub/b.md'])
    // 不需要自述标记：有 type 就是概念
    expect(scans[2].concepts.map((c) => c.path)).toEqual(['a.md', 'sub/b.md'])

    // 缓存键：两个根各带自己的前缀并存，失效按 bundle 划界
    expect(knownKnowledgePaths().has('knowledge/notes/a.md')).toBe(true)
    expect([...knownKnowledgePaths()].filter((k) => k.includes('/.'))).toEqual([])
    seedConcept(root, 'projects/p1/a.md', ['type: Memory', 'title: PA'])
    await scanBundle('projects/p1')
    expect(knownKnowledgePaths().has('knowledge/notes/a.md')).toBe(true)
    expect(knownKnowledgePaths().has('projects/p1/a.md')).toBe(true)
    invalidateKnowledgeScan('knowledge/notes')
    expect(knownKnowledgePaths().has('knowledge/notes/a.md')).toBe(false)
    expect(knownKnowledgePaths().has('projects/p1/a.md')).toBe(true)

    // 只读：扫描不往用户的文件夹里放任何东西（没有 index.md / log.md / .git 冒出来）
    expect(readdirSync(notes).sort()).toEqual(notesBefore)
    expect(readdirSync(join(userRoot, 'alpha'))).toEqual([])

    rmSync(userRoot, { recursive: true, force: true })
    expect(listUserLibraries()).toEqual([])
    expect(listBundles()).toEqual(['projects/p1'])
    expect((await scanAllBundles()).map((s) => s.bundle)).toEqual(['projects/p1'])
  })
})

/**
 * 读宽（设计附录 L）：files 是全部 md 原文，notes 是除 ShuviX 早先生成的 index / log 之外的每个 md，
 * concepts 只收合规的 OKF 条目 —— 保留名下用户自己的笔记是笔记，但永远不是条目。
 */
describe('scanBundle — 笔记清单', () => {
  it('SN-7 笔记清单：生成形状的保留文件只留在 files；手写保留名文件进 notes，但带 type 也不当概念；普通笔记按笔记取标题', async () => {
    seedConcept(root, `${BUNDLE}/a.md`, ['type: Memory', 'title: A', 'description: da'])
    seedFile(
      root,
      `${BUNDLE}/index.md`,
      '---\ntype: Memory\ntitle: Home\nstatus: draft\n---\n\n# Welcome\n'
    )
    seedFile(root, `${BUNDLE}/log.md`, '## 2026-09-09\n\n- **Creation** /a.md — A\n')
    seedFile(root, `${BUNDLE}/sub/index.md`, '## Entries\n\n* [X](x.md)\n')
    seedFile(root, `${BUNDLE}/plain.md`, '# Plain heading\n\nbody\n')

    const scan = await scanBundle(BUNDLE)
    expect(scan.files.map((f) => f.path)).toEqual([
      'a.md',
      'index.md',
      'log.md',
      'plain.md',
      'sub/index.md'
    ])
    expect(scan.concepts.map((c) => c.path)).toEqual(['a.md'])
    expect(scan.notes.map((n) => n.path)).toEqual(['a.md', 'index.md', 'plain.md'])
    const byPath = Object.fromEntries(scan.notes.map((n) => [n.path, n]))
    expect(byPath['index.md']).toMatchObject({
      title: 'Home',
      type: '',
      status: 'draft',
      concept: null
    })
    expect(byPath['plain.md'].title).toBe('Plain heading')
  })
})
