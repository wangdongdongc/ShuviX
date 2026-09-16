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
  /** 界面语言：内置库生效的是哪一版按它现算（EN-11 靠改它切语言） */
  language: 'en',
  projects: {} as Record<string, { name: string } | undefined>
}))

vi.mock('../../../utils/paths', () => ({
  getShuvixKnowledgeRootDir: () => state.root,
  getUserKnowledgeRootDir: () => `${state.root}-user`,
  // 内置库根替身：不存在的兄弟目录 —— 这些用例里没有内置库
  getBuiltinKnowledgeDir: () => `${state.root}-builtin`
}))
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))
// 绑定概念的显示名取项目**当前**的名字 —— 目录名是 id，文件里的 title 是建库那一刻记下的
vi.mock('../../../dao/projectDao', () => ({
  projectDao: { findById: (id: string) => state.projects[id] }
}))
// 内置库的显示名（`t`）与生效语言（`language`）都读 i18next **单例**：桩掉才看得见「名字取的是哪个
// i18n 键」，也不必指望跑测时全局 i18n 正好初始化过、正好是哪种语言。桌面主进程那个 `../../../i18n`
// 是另一个模块，这里没人用它。
vi.mock('i18next', () => ({
  default: {
    t: (key: string) => `i18n:${key}`,
    get language(): string {
      return state.language
    }
  }
}))

import { listKnowledgeEntries } from '../entries'
import { builtinBaseDisplayName } from '../knowledgePaths'
import { invalidateKnowledgeScan } from '../scan'
import {
  BUNDLE,
  OTHER_BUNDLE,
  PROJECTS,
  builtinLangAt,
  builtinRootOf,
  makeTempRoot,
  seedBuiltin,
  seedBuiltinConcept,
  seedConcept,
  seedFile,
  treeOf,
  userRootOf
} from './fixture'

/** 本期唯一的内置库（保留名 `shuvix`）—— bundle id 的首段是保留容器名 `builtin` */
const BUILTIN = 'builtin/shuvix'

let root: string

beforeEach(() => {
  root = makeTempRoot()
  state.root = root
  state.language = 'en'
  state.projects = {}
  invalidateKnowledgeScan()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(userRootOf(root), { recursive: true, force: true })
  // 内置根也是 root 的兄弟目录：种过内置库的用例得自己收拾
  rmSync(builtinRootOf(root), { recursive: true, force: true })
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
      bundleNames: {},
      bundleDirs: {}
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

  /**
   * 目录跟着条目一起下发（`dirs`）：库本身 + 库里每一层非隐藏子目录，**空的也给** —— 手动新建的
   * 知识库与文件夹第一时间就是空的，条目扫描（ripgrep 找 md）根本看不见它们，清单里不给，
   * 侧栏就什么都画不出来，新建条目也就没有落点。容器（`projects` / `knowledge`）自己不是库。
   */
  it('EN-8 清单下发 dirs：每个库本身 + 库里每一层非隐藏子目录，空的也给；项目容器自己不在其中；没有 md 的库照样给；清单仍然只读', async () => {
    const userRoot = userRootOf(root)
    // 一个没有任何 md 的项目库（连子目录也空着）
    mkdirSync(join(root, PROJECTS, 'p1', 'sub'), { recursive: true })
    // 一个全空的用户库
    mkdirSync(join(userRoot, 'empty'), { recursive: true })
    seedConcept(userRoot, 'notes/a.md', ['type: Memory', 'title: A'])
    seedConcept(userRoot, 'notes/sub/b.md', ['type: Memory', 'title: B'])
    seedConcept(userRoot, 'notes/.trash/t.md', ['type: Memory', 'title: T'])
    const before = { shuvix: treeOf(root), user: treeOf(userRoot) }

    const listed = await listKnowledgeEntries()

    // 项目库在前、用户库在后（与 listBundles 同序），每个库后面紧跟它自己的子目录
    expect(listed.dirs).toEqual([
      'projects/p1',
      'projects/p1/sub',
      'knowledge/empty',
      'knowledge/notes',
      'knowledge/notes/sub'
    ])
    // 容器不是库：它们自己不占行
    expect(listed.dirs).not.toContain(PROJECTS)
    expect(listed.dirs).not.toContain('knowledge')
    // 隐藏段不是库的内容 —— 与条目扫描同口径
    expect(listed.dirs.filter((d) => d.split('/').some((seg) => seg.startsWith('.')))).toEqual([])

    // 空目录只有目录行，不凭空带来条目；隐藏目录里的 md 照旧不进清单
    expect(listed.entries.map((e) => e.path)).toEqual([
      'knowledge/notes/a.md',
      'knowledge/notes/sub/b.md'
    ])

    // 只读：下发目录不等于建目录
    expect({ shuvix: treeOf(root), user: treeOf(userRoot) }).toEqual(before)
  })

  /**
   * 随应用发布的内置库是第三个名字空间（`builtin/<库名>`）：目录不在两个根之下，而且库名底下还夹着
   * **语言那一层**。语言不进 id —— 生效的只有界面语言那一版，别的语言版本不属于任何 bundle，
   * 所以切换语言时同一个 id 读到的就是新语言的那份。
   */
  it('EN-9 内置库进清单：path / bundle 用 builtin/<库名> 名字空间，与项目库 / 用户库的同名文件互不串台；只有当前语言那一版进清单，语言段不进 id；清单仍然只读', async () => {
    seedConcept(root, 'projects/p1/guide.md', ['type: Memory', 'title: Project Guide'])
    seedConcept(userRootOf(root), 'notes/guide.md', ['type: Memory', 'title: User Guide'])
    seedBuiltinConcept(root, 'shuvix/en/guide.md', ['type: Memory', 'title: Guide EN'])
    seedBuiltinConcept(root, 'shuvix/en/sub/nested.md', ['type: Memory', 'title: Nested EN'])
    seedBuiltinConcept(root, 'shuvix/zh/guide.md', ['type: Memory', 'title: Guide ZH'])
    seedBuiltinConcept(root, 'shuvix/zh/only-zh.md', ['type: Memory', 'title: Only ZH'])
    const builtinBefore = treeOf(builtinRootOf(root))

    const listed = await listKnowledgeEntries()
    const byPath = Object.fromEntries(listed.entries.map((e) => [e.path, e]))

    // 三个根各自的 guide.md 各占一行：首段不同，天然不撞
    expect(Object.keys(byPath).sort()).toEqual([
      `${BUILTIN}/guide.md`,
      `${BUILTIN}/sub/nested.md`,
      'knowledge/notes/guide.md',
      'projects/p1/guide.md'
    ])
    expect(byPath[`${BUILTIN}/guide.md`]).toMatchObject({ bundle: BUILTIN, title: 'Guide EN' })
    // 子目录里的条目仍属于库根
    expect(byPath[`${BUILTIN}/sub/nested.md`]).toMatchObject({ bundle: BUILTIN })
    expect(byPath['knowledge/notes/guide.md']).toMatchObject({ bundle: 'knowledge/notes' })
    expect(byPath['projects/p1/guide.md']).toMatchObject({ bundle: 'projects/p1' })

    // 另一种语言那一版不属于任何 bundle：既不另占一行，也顶不掉生效的那一版
    const titles = listed.entries.map((e) => e.title)
    expect(titles).not.toContain('Guide ZH')
    expect(titles).not.toContain('Only ZH')
    // 语言那一层不进 id
    for (const e of listed.entries) {
      expect(e.path, e.path).not.toMatch(/(^|\/)(en|zh)\//)
      expect(e.path, e.path).not.toMatch(/\\|^\//)
    }

    // 清单只读 —— 应用包里的目录原样（改了会随下次更新消失，macOS 上还会破坏签名）
    expect(treeOf(builtinRootOf(root))).toEqual(builtinBefore)
  })

  it('EN-10 bundleNames 给内置库一个人读的名字：取 builtinBaseDisplayName()（与配置卡 chip 同一个 i18n 键），不是目录名 shuvix；项目库照旧取项目当前名字，用户库仍然不给', async () => {
    seedBuiltinConcept(root, 'shuvix/en/a.md', ['type: Memory', 'title: A'])
    seedConcept(root, 'projects/p1/b.md', ['type: Memory', 'title: B'])
    seedConcept(userRootOf(root), 'notes/c.md', ['type: Memory', 'title: C'])
    state.projects = { p1: { name: 'Live Name' } }

    const { bundleNames } = await listKnowledgeEntries()

    // 恰好这两个：用户库的名字就是目录名，不必随清单下发
    expect(bundleNames).toEqual({
      [BUILTIN]: 'i18n:knowledge.builtinBaseName',
      'projects/p1': 'Live Name'
    })
    // 侧栏那一行与两张配置卡读的是同一个键：改名只改一处
    expect(bundleNames[BUILTIN]).toBe(builtinBaseDisplayName())
    // 目录名（shuvix）不是显示名
    expect(bundleNames[BUILTIN]).not.toBe('shuvix')
  })

  /**
   * 内置库的目录在应用包里、路径里还夹着语言那一层 —— 侧栏靠 `root` / `userRoot` 两个根拼不出来，
   * 「复制路径」得用随清单下发的 `bundleDirs`。另两个根拼得出来，所以不给。
   */
  it('EN-11 bundleDirs 只给内置库：值是**当前语言**那一版的绝对目录，项目库 / 用户库不在其中；切语言后值跟着换，没有那一版回落 en', async () => {
    seedBuiltinConcept(root, 'shuvix/en/a.md', ['type: Memory', 'title: A'])
    seedBuiltinConcept(root, 'shuvix/zh/a.md', ['type: Memory', 'title: 甲'])
    seedConcept(root, 'projects/p1/b.md', ['type: Memory', 'title: B'])
    seedConcept(userRootOf(root), 'notes/c.md', ['type: Memory', 'title: C'])

    expect((await listKnowledgeEntries()).bundleDirs).toEqual({
      [BUILTIN]: builtinLangAt(root, 'shuvix', 'en')
    })

    // 界面语言换成 zh-CN：基础段 zh 那一版在，指向它（现算不缓存，下一次解析就换）。
    // 扫描缓存的键是 `<bundle>/<rel>`、不含语言段，同一个键换了语言就指向另一份文件 ——
    // 生产里由 `refreshBuiltinKnowledge()` 在 settings:set 改语言时失效掉，这里照着做
    state.language = 'zh-CN'
    invalidateKnowledgeScan()
    expect((await listKnowledgeEntries()).bundleDirs).toEqual({
      [BUILTIN]: builtinLangAt(root, 'shuvix', 'zh')
    })

    // 没有那一版就回落 en
    state.language = 'fr'
    invalidateKnowledgeScan()
    expect((await listKnowledgeEntries()).bundleDirs).toEqual({
      [BUILTIN]: builtinLangAt(root, 'shuvix', 'en')
    })
  })

  it('EN-12 内置库的 dirs：库本身 + 语言层**之内**的子目录（空的也给）；容器 builtin 自己不占行，语言段也不占行，别的语言那一层下面的子目录同样不给', async () => {
    const userRoot = userRootOf(root)
    mkdirSync(join(root, PROJECTS, 'p1', 'sub'), { recursive: true })
    mkdirSync(join(userRoot, 'notes'), { recursive: true })
    seedBuiltinConcept(root, 'shuvix/en/sub/a.md', ['type: Memory', 'title: A'])
    mkdirSync(join(builtinLangAt(root, 'shuvix', 'en'), 'empty'), { recursive: true })
    mkdirSync(join(builtinLangAt(root, 'shuvix', 'zh'), 'zh-only'), { recursive: true })

    const { dirs } = await listKnowledgeEntries()

    // 项目库 → 用户库 → 内置库（与 listBundles 同序），每个库后面紧跟它自己的子目录
    expect(dirs).toEqual([
      'projects/p1',
      'projects/p1/sub',
      'knowledge/notes',
      BUILTIN,
      `${BUILTIN}/empty`,
      `${BUILTIN}/sub`
    ])
    // 容器不是库：它自己不占行（`builtin` 在磁盘上根本没有对应目录）
    expect(dirs).not.toContain('builtin')
    // 语言那一层不进 id —— 它既不是目录行，也不是任何行里的一段
    expect(dirs.filter((d) => /(^|\/)(en|zh)(\/|$)/.test(d))).toEqual([])
    // 别的语言版本不属于任何 bundle：它下面的子目录同样不给
    expect(dirs).not.toContain(`${BUILTIN}/zh-only`)
  })

  it('EN-13 内置库里的不合规 md 照样一行：没有 frontmatter / 没有 type / 带别家 shuvix 标记的都列出，与用户库一视同仁（读宽）；早先生成形状的 log 仍然不列', async () => {
    seedBuiltin(root, 'shuvix/en/plain.md', '# plain\n\nno frontmatter\n')
    seedBuiltin(root, 'shuvix/en/untyped.md', '---\ntitle: x\n---\n\nno type\n')
    seedBuiltin(
      root,
      'shuvix/en/foreign.md',
      '---\nshuvix: agent v1\ntype: Memory\n---\n\nforeign\n'
    )
    seedBuiltinConcept(root, 'shuvix/en/ok.md', ['type: Memory', 'title: OK'])
    seedBuiltin(root, 'shuvix/en/log.md', '## 2026-09-09\n\n- **Creation** /ok.md\n')

    const listed = await listKnowledgeEntries()
    const byPath = Object.fromEntries(listed.entries.map((e) => [e.path, e]))

    expect(Object.keys(byPath).sort()).toEqual([
      `${BUILTIN}/foreign.md`,
      `${BUILTIN}/ok.md`,
      `${BUILTIN}/plain.md`,
      `${BUILTIN}/untyped.md`
    ])
    // 与用户库那一组（EN-6）逐字段同形：不合规也不藏，文件名 / frontmatter title 当标题
    for (const [path, title] of [
      [`${BUILTIN}/plain.md`, 'plain'],
      [`${BUILTIN}/untyped.md`, 'x'],
      [`${BUILTIN}/foreign.md`, 'foreign']
    ]) {
      expect(byPath[path], path).toStrictEqual({
        path,
        bundle: BUILTIN,
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
    expect(byPath[`${BUILTIN}/ok.md`]).toMatchObject({
      bundle: BUILTIN,
      type: 'Memory',
      title: 'OK'
    })
  })

  it('EN-14 内置根不存在（开发期没拷 / 打包漏了）：回包结构不变 —— bundleDirs 是空对象，另两个根照常；内置库是增益，缺席不建根也不连累别人', async () => {
    expect(existsSync(builtinRootOf(root))).toBe(false)
    seedConcept(root, 'projects/p1/a.md', ['type: Memory', 'title: A'])
    seedConcept(userRootOf(root), 'notes/b.md', ['type: Memory', 'title: B'])
    state.projects = { p1: { name: 'Live Name' } }

    const listed = await listKnowledgeEntries()

    expect(listed.bundleDirs).toEqual({})
    expect(listed.entries.map((e) => e.path).sort()).toEqual([
      'knowledge/notes/b.md',
      'projects/p1/a.md'
    ])
    expect(listed.dirs).toEqual(['projects/p1', 'knowledge/notes'])
    expect(listed.bundleNames).toEqual({ 'projects/p1': 'Live Name' })
    expect(existsSync(builtinRootOf(root))).toBe(false)
  })
})
