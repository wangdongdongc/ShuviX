/**
 * scan —— **按 bundle** 扫：一个 bundle 下全部 .md（ripgrep，跳过隐藏文件与目录）→ 概念清单，路径
 * bundle 相对，按 (mtime, size) 缓存、键是 `<bundle>/<rel>`。一次扫描只看一个 bundle，
 * 别的 bundle 既不进清单也不被失效 —— 那正是 bundle 边界的意思。
 * knowledgePaths 的两根 / bundle 路径算术（含「这条绝对路径属于哪个 bundle」）也在这里钉。
 *
 * 用户库：用户根下每个非隐藏子目录都是一个库（不要标记，空目录也算），bundle id `knowledge/<库名>`
 * 与项目库共用一个名字空间；扫描同样只读。
 *
 * 内置库（随应用发布、只读）：第三个根，磁盘上比另两个多一层语言目录（`<库名>/<语言>/…`），而 id
 * 里没有它 —— 那一层由 `builtinLanguageDir` 按界面语言现算。所以「哪一版生效」随时会变，而 bundle id、
 * 缓存键、侧栏那一行都不该跟着变；反过来，只有生效的那一版属于 bundle。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, readdirSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

const state = vi.hoisted(() => ({ root: '', language: 'en' }))

vi.mock('../../../utils/paths', () => ({
  getShuvixKnowledgeRootDir: () => state.root,
  getUserKnowledgeRootDir: () => `${state.root}-user`,
  // 内置库根替身：缺省不存在的兄弟目录 —— 不种东西的用例里就是「没有内置库」
  getBuiltinKnowledgeDir: () => `${state.root}-builtin`
}))
// 语言目录取自 i18next 单例。不桩的话 `i18next.language` 是 undefined，代码一路回落 `en`，
// 「按界面语言切哪一版」这件事就测不出来；getter 读可变 state，用例中途改 language 下一次调用即生效。
vi.mock('i18next', () => ({
  default: {
    get language(): string {
      return state.language
    },
    t: (key: string) => key
  }
}))
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

import {
  BUILTIN_CONTAINER,
  PROJECTS_CONTAINER,
  USER_CONTAINER,
  builtinBundleId,
  builtinLanguageDir,
  bundleDir,
  bundleFilePath,
  entryFilePath,
  isBuiltinBundle,
  isUserBundle,
  isValidLibraryName,
  locateBundle,
  toBuiltinRelative,
  toShuvixRelative,
  toUserRelative,
  userBundleId
} from '../knowledgePaths'
import {
  invalidateKnowledgeScan,
  knownKnowledgePaths,
  listBuiltinBundles,
  listBundleDirs,
  listBundles,
  listUserLibraries,
  scanAllBundles,
  scanBundle
} from '../scan'
import {
  BUNDLE,
  OTHER_BUNDLE,
  PROJECTS,
  builtinLangAt,
  builtinRootOf,
  bundleAt,
  conceptText,
  fileAt,
  makeTempRoot,
  seedBuiltin,
  seedBuiltinConcept,
  seedConcept,
  seedFile,
  userRootOf
} from './fixture'

let root: string

beforeEach(() => {
  root = makeTempRoot()
  state.root = root
  state.language = 'en'
  invalidateKnowledgeScan()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(userRootOf(root), { recursive: true, force: true })
  // 内置根与用户根一样在 root 之外：种过内置库的用例靠这一条清理
  rmSync(builtinRootOf(root), { recursive: true, force: true })
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

/**
 * 目录清单是**空目录唯一的来源**：手动新建的知识库与文件夹第一时间就是空的，条目扫描（ripgrep 找 md）
 * 根本看不见它们。它是普通目录遍历，隐藏目录连同整棵子树一概不算库的内容 —— 与条目扫描同口径。
 */
describe('listBundleDirs', () => {
  it('SN-8 一个 bundle 下全部非隐藏子目录：bundle 相对、深度优先、字典序；隐藏目录连同整棵子树都不出现；bundle 不存在 → 空且不抛；limit 是硬上限（先序截断）', () => {
    const dir = bundleAt(root, BUNDLE)
    for (const rel of ['a/x', 'b', '.git/objects', '.obsidian']) {
      mkdirSync(join(dir, ...rel.split('/')), { recursive: true })
    }

    // .git / .obsidian 自己不出现，`.git/objects` 这样的子树也一并不出现
    expect(listBundleDirs(BUNDLE)).toEqual(['a', 'a/x', 'b'])
    expect(listBundleDirs(OTHER_BUNDLE)).toEqual([])
    // 上限按先序截断：先把 a 整棵走完，再轮到 b
    expect(listBundleDirs(BUNDLE, 2)).toEqual(['a', 'a/x'])
  })
})

/**
 * 内置库的路径算术：磁盘上多出来的语言那一层**不进 id**，由 `builtinLanguageDir` 每次现算。
 * 这是内置库与另两个根唯一的形状差异，也是最容易被写成「id 里带语言」的地方 —— 那样一切语言
 * 相关的东西（缓存键、侧栏行、笔记本会话）都会随界面语言分裂成好几份。
 */
describe('内置库：路径算术（磁盘多一层语言目录）', () => {
  it('SN-9 三个根共用一个名字空间：`builtin/<库名>/<rel>` 落到 `<内置根>/<库名>/<当前语言>/<rel>`（语言那一层不进 id），另两个根的解析一字不变；首段判定按归一后的路径认 `builtin`', () => {
    state.language = 'zh'
    seedBuiltinConcept(root, 'shuvix/zh/a.md', ['type: Memory', 'title: A-zh'])
    seedBuiltinConcept(root, 'shuvix/en/a.md', ['type: Memory', 'title: A-en'])

    expect(BUILTIN_CONTAINER).toBe('builtin')
    expect(builtinBundleId('shuvix')).toBe('builtin/shuvix')
    // bundle 目录就是语言那一层
    expect(bundleDir('builtin/shuvix')).toBe(builtinLangAt(root, 'shuvix', 'zh'))
    expect(bundleFilePath('builtin/shuvix', 'sub/a.md')).toBe(
      join(builtinLangAt(root, 'shuvix', 'zh'), 'sub', 'a.md')
    )
    expect(entryFilePath('builtin/shuvix/a.md')).toBe(
      join(builtinLangAt(root, 'shuvix', 'zh'), 'a.md')
    )
    // 另两个根：多一个容器名不改变它们的算术
    expect(entryFilePath('knowledge/notes/a.md')).toBe(join(userRootOf(root), 'notes', 'a.md'))
    expect(entryFilePath('projects/p1/a.md')).toBe(join(root, 'projects', 'p1', 'a.md'))

    // `./builtin/…` 也是内置库：只读闸认的是归一后的首段，否则多一种写法就多一条绕过去的路
    for (const id of [
      'builtin/shuvix',
      'builtin/x/a.md',
      './builtin/x',
      'builtin\\x',
      '/builtin/x'
    ]) {
      expect(isBuiltinBundle(id), id).toBe(true)
    }
    for (const id of ['builtins/x', 'x/builtin', 'knowledge/builtin/x', 'projects/p1']) {
      expect(isBuiltinBundle(id), id).toBe(false)
    }
    // 首段不同，三者天然不撞
    expect(isUserBundle('builtin/shuvix/a.md')).toBe(false)
    expect(isBuiltinBundle('knowledge/notes/a.md')).toBe(false)
  })

  it('SN-10 生效的语言目录每次现算：界面语言取基础段（`zh-CN` → `zh`），没发这一版就回落 `en`；不缓存 —— 改完界面语言（或磁盘上多出那一版）下一次调用就换', () => {
    seedBuiltin(root, 'shuvix/zh/a.md', '# zh\n')
    seedBuiltin(root, 'shuvix/en/a.md', '# en\n')

    state.language = 'zh-CN'
    expect(builtinLanguageDir('shuvix')).toBe('zh')
    state.language = 'ja'
    expect(builtinLanguageDir('shuvix')).toBe('en')
    state.language = 'de'
    expect(builtinLanguageDir('shuvix')).toBe('en')
    // 换回去立刻还是 zh：没有一次性算好存着
    state.language = 'zh-CN'
    expect(builtinLanguageDir('shuvix')).toBe('zh')
    // 整个库都不在（开发期没拷资源）也只是回落，不抛
    expect(builtinLanguageDir('missing')).toBe('en')

    // 磁盘那一侧同样是现算：补上 ja 版之后，下一次调用（连同 bundleDir）就指向它
    state.language = 'ja'
    expect(builtinLanguageDir('shuvix')).toBe('en')
    seedBuiltin(root, 'shuvix/ja/a.md', '# ja\n')
    expect(builtinLanguageDir('shuvix')).toBe('ja')
    expect(bundleDir('builtin/shuvix')).toBe(builtinLangAt(root, 'shuvix', 'ja'))
  })

  it('SN-11 locateBundle 的内置库边界是 `<库名>/<语言>`，且只认此刻生效的那一版：别的语言的同名文件、容器与库目录本身、少了语言层的路径、任一隐藏段都不属于任何 bundle', () => {
    state.language = 'zh'
    seedBuiltinConcept(root, 'shuvix/zh/a.md', ['type: Memory', 'title: A-zh'])
    seedBuiltinConcept(root, 'shuvix/en/a.md', ['type: Memory', 'title: A-en'])
    seedBuiltinConcept(root, 'shuvix/zh/.trash/a.md', ['type: Memory', 'title: T'])
    seedBuiltin(root, 'shuvix/a.md', '# 少了语言层\n')
    seedBuiltin(root, 'README.md', '# 容器下的散文件\n')

    const builtinRoot = builtinRootOf(root)
    const zh = builtinLangAt(root, 'shuvix', 'zh')
    expect(toBuiltinRelative(join(zh, 'a.md'))).toBe('shuvix/zh/a.md')
    expect(toBuiltinRelative(`${builtinRoot}\\shuvix\\zh\\a.md`)).toBe('shuvix/zh/a.md')
    expect(toBuiltinRelative(builtinRoot)).toBeNull()
    expect(toBuiltinRelative(`${builtinRoot}x/shuvix/zh/a.md`)).toBeNull()

    expect(locateBundle(join(zh, 'a.md'))).toEqual({ bundle: 'builtin/shuvix', rel: 'a.md' })
    expect(locateBundle(join(zh, 'sub', 'a.md'))).toEqual({
      bundle: 'builtin/shuvix',
      rel: 'sub/a.md'
    })
    for (const abs of [
      // 另一个语言版本：文件实实在在存在，但此刻不生效 —— 写钩子与变更管线据此绕开它
      join(builtinLangAt(root, 'shuvix', 'en'), 'a.md'),
      // 容器自己、容器下的散文件、库目录自己、语言目录（= bundle 目录）自己
      builtinRoot,
      join(builtinRoot, 'README.md'),
      join(builtinRoot, 'shuvix'),
      zh,
      // 少了语言那一层
      join(builtinRoot, 'shuvix', 'a.md'),
      // 任一段隐藏：库内的回收站、隐藏的「库」
      join(zh, '.trash', 'a.md'),
      join(builtinRoot, '.hidden', 'zh', 'a.md')
    ]) {
      expect(locateBundle(abs), abs).toBeNull()
    }
  })

  it('SN-12 id 经 entryFilePath → locateBundle 往返不变（三个根同理）；用 `..` 绕出去的写法按 join 解完的真实位置落回它所在的那个 bundle，而不是首段声称的那个', () => {
    state.language = 'zh'
    seedBuiltin(root, 'shuvix/zh/a.md', '# zh\n')
    seedBuiltin(root, 'shuvix/zh/sub/a.md', '# zh sub\n')

    for (const [id, bundle, rel] of [
      ['builtin/shuvix/sub/a.md', 'builtin/shuvix', 'sub/a.md'],
      ['knowledge/notes/a.md', 'knowledge/notes', 'a.md'],
      ['projects/p1/a.md', 'projects/p1', 'a.md']
    ]) {
      expect(locateBundle(entryFilePath(id)), id).toEqual({ bundle, rel })
    }

    // 从内置根 `..` 出去再进用户根：算术上落在用户库里，locateBundle 就答用户库
    const intoUser = `builtin/shuvix/../../../${basename(userRootOf(root))}/notes/a.md`
    expect(entryFilePath(intoUser)).toBe(join(userRootOf(root), 'notes', 'a.md'))
    expect(locateBundle(entryFilePath(intoUser))).toEqual({
      bundle: 'knowledge/notes',
      rel: 'a.md'
    })

    // 反向同理：首段写着 `knowledge` 也照样能落到内置库的文件上 —— 只读的判定因此必须走
    // locateBundle 的答案，而不是 id 自称的首段
    const intoBuiltin = `knowledge/../${basename(builtinRootOf(root))}/shuvix/zh/a.md`
    expect(entryFilePath(intoBuiltin)).toBe(join(builtinLangAt(root, 'shuvix', 'zh'), 'a.md'))
    expect(locateBundle(entryFilePath(intoBuiltin))).toEqual({
      bundle: 'builtin/shuvix',
      rel: 'a.md'
    })
    expect(isBuiltinBundle(intoBuiltin)).toBe(false)
  })
})

/**
 * 内置库的清单与扫描：与用户库同路（一个目录一个库、只扫非隐藏 md、缓存键带 bundle 前缀），
 * 差别只在「哪一层是 bundle 目录」。清单的判据必须**深到语言那一层** —— 它与 `bases` / 缺省选择 /
 * 围栏（sessionBundle 的 builtinTarget 按语言目录 existsSync 判）说的得是同一件事。
 */
describe('内置库：listBuiltinBundles / listBundles / scanBundle / listBundleDirs', () => {
  it('SN-13 内置根下每个非隐藏子目录都是一个库（字典序）；隐藏目录与容器下的散文件不算；根不在（开发期没拷、打包漏了）→ 空且不抛', () => {
    state.language = 'zh'
    seedBuiltin(root, 'alpha/zh/a.md', '# a\n')
    // 只发了 en：回落到得到的那一版，照样是一个库
    seedBuiltin(root, 'beta/en/b.md', '# b\n')
    seedBuiltin(root, '.hidden/zh/x.md', '# x\n')
    seedBuiltin(root, 'README.md', 'not a library')

    expect(listBuiltinBundles()).toEqual(['builtin/alpha', 'builtin/beta'])

    rmSync(builtinRootOf(root), { recursive: true, force: true })
    expect(listBuiltinBundles()).toEqual([])
    expect(listBundles()).toEqual([])
  })

  it('SN-13b 只发了别的语言、又没有 en 兜底的库不进清单：否则侧栏会多一行永远空的只读库，而 bases / 缺省选择 / 围栏里都没有它 —— 同一件东西两个答案', async () => {
    state.language = 'zh'
    seedBuiltin(root, 'alpha/zh/a.md', '# a\n')
    seedBuiltin(root, 'solo/fr/a.md', '# fr\n')

    // 库目录在，但生效的那一版（当前语言 → 回落 en）不在
    expect(builtinLanguageDir('solo')).toBe('en')
    expect(listBuiltinBundles()).toEqual(['builtin/alpha'])
    expect(listBundles()).not.toContain('builtin/solo')
    // 它真被列出来会是什么样：一行空库
    expect(await scanBundle('builtin/solo')).toEqual({
      bundle: 'builtin/solo',
      files: [],
      concepts: [],
      notes: []
    })
  })

  it('SN-14 listBundles 的次序是项目库 → 用户库 → 内置库（内置库垫底：它是说明书，不是用户的内容），scanAllBundles 逐个扫且次序一致', async () => {
    state.language = 'zh'
    seedConcept(root, 'projects/p1/a.md', ['type: Memory', 'title: P'])
    seedConcept(userRootOf(root), 'notes/a.md', ['type: Memory', 'title: N'])
    seedBuiltin(root, 'shuvix/zh/a.md', '# s\n')

    expect(listBundles()).toEqual(['projects/p1', 'knowledge/notes', 'builtin/shuvix'])
    expect((await scanAllBundles()).map((s) => s.bundle)).toEqual([
      'projects/p1',
      'knowledge/notes',
      'builtin/shuvix'
    ])
  })

  it('SN-15 扫内置库与用户库同路：只扫此刻生效的语言那一层（别的语言的 md 一概不进 files / concepts / notes），缓存键是不含语言段的 `builtin/<库名>/<rel>`，失效按 bundle 划界', async () => {
    state.language = 'zh'
    seedBuiltinConcept(root, 'shuvix/zh/a.md', ['type: Memory', 'title: A-zh', 'description: d'])
    seedBuiltin(root, 'shuvix/zh/plain.md', '# 普通笔记\n\nbody\n')
    seedBuiltinConcept(root, 'shuvix/zh/sub/b.md', ['type: Memory', 'title: B'])
    seedBuiltinConcept(root, 'shuvix/zh/.trash/x.md', ['type: Memory', 'title: X'])
    seedBuiltinConcept(root, 'shuvix/en/a.md', ['type: Memory', 'title: A-en', 'description: d'])
    seedConcept(userRootOf(root), 'notes/a.md', ['type: Memory', 'title: N'])

    const scan = await scanBundle('builtin/shuvix')
    expect(scan.bundle).toBe('builtin/shuvix')
    // 路径是 bundle 相对（不带 `zh/`），隐藏子树不扫，另一语言的 a.md 根本不在这棵树里
    expect(scan.files.map((f) => f.path)).toEqual(['a.md', 'plain.md', 'sub/b.md'])
    expect(scan.concepts.map((c) => c.title)).toEqual(['A-zh', 'B'])
    expect(scan.notes.map((n) => n.path)).toEqual(['a.md', 'plain.md', 'sub/b.md'])

    await scanBundle('knowledge/notes')
    expect(knownKnowledgePaths().has('builtin/shuvix/a.md')).toBe(true)
    expect([...knownKnowledgePaths()].some((k) => k.includes('/zh/'))).toBe(false)
    // 精确失效用的也是这把不含语言的键
    invalidateKnowledgeScan('builtin/shuvix', 'a.md')
    expect(knownKnowledgePaths().has('builtin/shuvix/a.md')).toBe(false)
    expect(knownKnowledgePaths().has('builtin/shuvix/sub/b.md')).toBe(true)
    // 整库失效只清这一个 bundle
    invalidateKnowledgeScan('builtin/shuvix')
    expect([...knownKnowledgePaths()].filter((k) => k.startsWith('builtin/'))).toEqual([])
    expect(knownKnowledgePaths().has('knowledge/notes/a.md')).toBe(true)
  })

  it('SN-16 listBundleDirs 列的是语言目录**之内**的子目录（`sub` 而不是 `zh/sub`）：隐藏子树与别的语言版本都不出现；bundle 不存在 → 空且不抛', () => {
    state.language = 'zh'
    const zh = builtinLangAt(root, 'shuvix', 'zh')
    for (const rel of ['sub/deep', '.trash', 'sub/.hidden']) {
      mkdirSync(join(zh, ...rel.split('/')), { recursive: true })
    }
    mkdirSync(join(builtinLangAt(root, 'shuvix', 'en'), 'other'), { recursive: true })

    expect(listBundleDirs('builtin/shuvix')).toEqual(['sub', 'sub/deep'])
    expect(listBundleDirs('builtin/missing')).toEqual([])
  })
})
