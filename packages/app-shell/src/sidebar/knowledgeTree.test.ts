/**
 * 知识库分组的树形派生 —— `KnowledgeEntry[]` + 宿主给的显示名 → 目录树（buildKnowledgeTree）。
 *
 * 判定全在这个纯函数里，UI 只是照树画：顶层作用域目录固定序、只画有文件的目录、目录显示名只来自
 * 宿主随清单下发的 `names`（bundle id → 名字：项目库的目录名是项目 id，靠它显示项目当前的名字）
 * 而库里没有哪个文件享受特殊待遇（project.md 也只是一行）、目录与文件各按显示名排、路径归一 +
 * 去重、用户库（`knowledge/<库名>`）不包一层而是提到根上与项目容器平级。这里逐条钉住，
 * 组件层不再单测这些判定。
 */
import { describe, it, expect } from 'vitest'
import type { KnowledgeEntry } from '@shuvix/chat-protocol/knowledge'
import {
  buildKnowledgeTree,
  dirDisplayName,
  type KnowledgeTreeDir,
  type KnowledgeTreeFile
} from './knowledgeTree'

/** 文件名 stem（解析器给 title 的缺省值） */
const stemOf = (path: string): string =>
  path
    .replace(/\\/g, '/')
    .slice(path.replace(/\\/g, '/').lastIndexOf('/') + 1)
    .replace(/\.(md|markdown|mdx)$/i, '')

/** bundle 只影响条目的归属列，不影响树形派生 —— 树只看 path */
const entry = (path: string, over: Partial<KnowledgeEntry> = {}): KnowledgeEntry => ({
  path,
  bundle: path.split('/').slice(0, 2).join('/'),
  type: 'Memory',
  title: stemOf(path),
  description: '',
  status: 'stable',
  tags: [],
  trustTier: 'unverified',
  verifiedCurrent: false,
  stale: false,
  ...over
})

const names = (dir: KnowledgeTreeDir): string[] => dir.dirs.map((d) => d.name)
const paths = (dir: KnowledgeTreeDir): string[] => dir.files.map((f) => f.entry.path)
const labels = (dir: KnowledgeTreeDir): string[] => dir.files.map((f) => f.label)

/** 按目录路径下钻（找不到即抛，失败信息带路径） */
const dirAt = (root: KnowledgeTreeDir, path: string): KnowledgeTreeDir => {
  let node = root
  for (const seg of path.split('/')) {
    const next = node.dirs.find((d) => d.name === seg)
    if (!next) throw new Error(`no dir '${path}' (stuck at '${node.path}')`)
    node = next
  }
  return node
}

const allDirs = (node: KnowledgeTreeDir): KnowledgeTreeDir[] =>
  node.dirs.flatMap((d) => [d, ...allDirs(d)])
const allFiles = (node: KnowledgeTreeDir): KnowledgeTreeFile[] => [
  ...node.files,
  ...node.dirs.flatMap(allFiles)
]

describe('buildKnowledgeTree — 根与顶层', () => {
  it('KT-1 空清单 → 只有根：无目录、无文件、无标题', () => {
    expect(buildKnowledgeTree([])).toEqual({
      path: '',
      name: '',
      scopeDir: null,
      title: null,
      dirs: [],
      files: []
    })
  })

  /**
   * 根级文件（用户自己放的、或外部工具写的）落在根、不造目录 —— 宿主不往库里种任何规范文件，
   * 也没有哪个文件名会被当成章程。
   */
  it('KT-2 根级文件：行落在根、label 是它的 title、不给根命名、不造目录', () => {
    const note = entry('NOTES.md', { type: 'Guide', title: 'House rules' })
    const root = buildKnowledgeTree([note])
    expect(root.files).toEqual([{ entry: note, label: 'House rules' }])
    expect(root.title).toBeNull()
    expect(root.dirs).toEqual([])
  })

  it('KT-3 多个根级文件：按显示名排，仍不造目录', () => {
    const root = buildKnowledgeTree([
      entry('notes.md', { title: 'Notes' }),
      entry('house.md', { title: 'Anchors' })
    ])
    expect(paths(root)).toEqual(['house.md', 'notes.md'])
    expect(root.dirs).toEqual([])
  })

  /**
   * 顶层只有一个固定文案的目录：项目 bundle 的容器 `projects/`（UI 按 scopeDir 取 i18n）。
   * 别的顶层目录一律按目录名显示、排在它之后 —— 曾经的 global / sessions / bots / wiki / raw
   * 五个保留名字都已退役，这里顺带钉住它们不再享受任何特殊待遇。
   */
  it('KT-4 顶层：projects 居首带 scopeDir，其余按名排、scopeDir 为 null', () => {
    const root = buildKnowledgeTree([
      entry('raw/r.md'),
      entry('wiki/t/w.md'),
      entry('bots/b/x.md'),
      entry('projects/p/x.md'),
      entry('global/g.md'),
      entry('archive/a.md')
    ])
    expect(names(root)).toEqual(['projects', 'archive', 'bots', 'global', 'raw', 'wiki'])
    expect(root.dirs.map((d) => d.scopeDir)).toEqual(['projects', null, null, null, null, null])
  })

  it('KT-5 只画有文件的目录，中间链路物化：projects → acme（空文件、无标题）→ 子目录', () => {
    const root = buildKnowledgeTree([entry('projects/acme/auth/session.md')])
    expect(names(root)).toEqual(['projects'])
    const projects = root.dirs[0]
    expect(projects.files).toEqual([])
    expect(projects.scopeDir).toBe('projects')
    expect(names(projects)).toEqual(['acme'])
    const acme = projects.dirs[0]
    expect(acme).toMatchObject({
      path: 'projects/acme',
      name: 'acme',
      scopeDir: null,
      title: null,
      files: []
    })
    expect(names(acme)).toEqual(['auth'])
    expect(acme.dirs[0].scopeDir).toBeNull()
  })

  it('KT-6 目录显示名只来自 names：按目录 path 精确命中，容器与子目录不沾；每个文件都占一行 —— project.md / bot.md 也不例外，label 即 title', () => {
    const root = buildKnowledgeTree(
      [
        entry('projects/acme/notes.md', { title: 'Notes' }),
        entry('projects/acme/project.md', { title: 'Old Charter' }),
        entry('projects/acme/sub/api.md', { title: 'API' }),
        entry('bots/helper/bot.md', { title: 'Helper Bot' }),
        entry('bots/helper/memo.md', { title: 'Memo' })
      ],
      { 'projects/acme': 'ACME Corp' }
    )

    const acme = dirAt(root, 'projects/acme')
    expect(acme.title).toBe('ACME Corp')
    // project.md 不给目录命名、也不藏起来：它只是库里的一篇笔记
    expect(paths(acme)).toEqual(['projects/acme/notes.md', 'projects/acme/project.md'])
    expect(labels(acme)).toEqual(['Notes', 'Old Charter'])
    // 名字只落在 key 那一层
    expect(dirAt(root, 'projects').title).toBeNull()
    expect(dirAt(root, 'projects/acme/sub').title).toBeNull()

    const helper = dirAt(root, 'bots/helper')
    expect(helper.title).toBeNull()
    expect(labels(helper)).toEqual(['Helper Bot', 'Memo'])
  })

  it('KT-7 没有 names 就没有目录标题：project.md 放在哪一层（包括 projects/<id>/project.md 这个旧章程位置）都只是一行，谁也不给目录命名', () => {
    const root = buildKnowledgeTree([
      entry('projects/project.md', { title: 'P0' }),
      entry('projects/acme/project.md', { title: 'P1' }),
      entry('projects/acme/sub/project.md', { title: 'P2' }),
      entry('wiki/topic/project.md', { title: 'P3' }),
      entry('projects/acme/bot.md', { title: 'B' }),
      entry('project.md', { title: 'P4' })
    ])
    expect(allFiles(root)).toHaveLength(6)
    expect(
      allDirs(root)
        .filter((d) => d.title !== null)
        .map((d) => d.path)
    ).toEqual([])
  })

  it('KT-8 names 的取值规则：首尾空白裁掉；全空白等于没给；只认自有键（原型上的 constructor 之类不算）；给了名字却没有文件的库不造目录', () => {
    const root = buildKnowledgeTree(
      [entry('projects/padded/x.md'), entry('projects/blank/x.md'), entry('constructor/x.md')],
      { 'projects/padded': '  ACME  ', 'projects/blank': '   ', 'projects/gone': 'Gone' }
    )
    expect(dirAt(root, 'projects/padded').title).toBe('ACME')
    expect(dirAt(root, 'projects/blank').title).toBeNull()
    expect(dirAt(root, 'constructor').title).toBeNull()
    expect(allDirs(root).map((d) => d.path)).not.toContain('projects/gone')
  })

  it('KT-9 dirDisplayName：有名字取名字；没有（项目已删、names 里没有它）回落目录名', () => {
    const root = buildKnowledgeTree([entry('projects/p1/a.md'), entry('projects/p2/b.md')], {
      'projects/p1': 'Acme Corp'
    })
    expect(dirDisplayName(dirAt(root, 'projects/p1'))).toBe('Acme Corp')
    const orphan = dirAt(root, 'projects/p2')
    expect(orphan).toMatchObject({ title: null, scopeDir: null })
    expect(dirDisplayName(orphan)).toBe('p2')
  })
})

describe('buildKnowledgeTree — 排序', () => {
  it('KT-10 同级目录按显示名排：names 给的名字参与、没有名字的用目录名', () => {
    const root = buildKnowledgeTree(
      [
        entry('projects/z-proj/x.md'),
        entry('projects/a-proj/x.md'),
        entry('projects/m-proj/notes.md')
      ],
      { 'projects/z-proj': 'Alpha Inc', 'projects/a-proj': 'Zeta Ltd' }
    )
    expect(names(dirAt(root, 'projects'))).toEqual(['z-proj', 'm-proj', 'a-proj'])
  })

  it('KT-11 文件按 label 排：数字自然序、大小写不敏感、中文按 zh-CN；同 label 按路径。只钉两两相对序，不钉跨文字的绝对序', () => {
    const inputs = [
      entry('global/n10.md', { title: 'note-10' }),
      entry('global/n2.md', { title: 'note-2' }),
      entry('global/banana.md', { title: 'Banana' }),
      entry('global/apple.md', { title: 'apple' }),
      entry('global/xj.md', { title: '香蕉' }),
      entry('global/pg.md', { title: '苹果' }),
      entry('global/b.md', { title: 'Same' }),
      entry('global/a.md', { title: 'Same' })
    ]
    const order = paths(dirAt(buildKnowledgeTree(inputs), 'global'))
    expect([...order].sort()).toEqual(inputs.map((e) => e.path).sort())

    const before = (a: string, b: string): void =>
      expect(order.indexOf(a), `${a} before ${b}`).toBeLessThan(order.indexOf(b))
    before('global/n2.md', 'global/n10.md')
    before('global/apple.md', 'global/banana.md')
    before('global/pg.md', 'global/xj.md')
    before('global/a.md', 'global/b.md')
    // 同 label 的两条相邻（路径只是并列时的决胜）
    expect(order.indexOf('global/b.md')).toBe(order.indexOf('global/a.md') + 1)
  })
})

describe('buildKnowledgeTree — 路径归一、去重、纯度', () => {
  it('KT-12 反斜杠 / 前导 ./ 与 / / 重复分隔符 / 尾随 / 都归一；names 按归一后的目录 path 命中；同路径取首条；空路径与 "/" 跳过；不造 "." 或空名目录；不改输入', () => {
    const inputs = [
      entry('\\projects\\acme\\project.md', { title: 'ACME charter' }),
      entry('/global/a.md', { title: 'A first' }),
      entry('./global/b.md', { title: 'B' }),
      entry('global//c.md', { title: 'C' }),
      entry('raw/d.md/', { title: 'D' }),
      entry('global/a.md', { title: 'A second' }),
      entry('', { title: 'empty' }),
      entry('/', { title: 'slash' })
    ]
    const snapshot = structuredClone(inputs)
    const bundleNames = { 'projects/acme': 'ACME' }

    const root = buildKnowledgeTree(inputs, bundleNames)
    expect(inputs).toEqual(snapshot)
    expect(bundleNames).toEqual({ 'projects/acme': 'ACME' })

    const acme = dirAt(root, 'projects/acme')
    expect(acme.title).toBe('ACME')
    expect(paths(acme)).toEqual(['projects/acme/project.md'])

    const files = allFiles(root)
    expect(files.map((f) => f.entry.path).sort()).toEqual([
      'global/a.md',
      'global/b.md',
      'global/c.md',
      'projects/acme/project.md',
      'raw/d.md'
    ])
    expect(root.files).toEqual([])
    const dirNames = allDirs(root).map((d) => d.name)
    expect(dirNames).not.toContain('.')
    expect(dirNames).not.toContain('')

    expect(files.find((f) => f.entry.path === 'global/a.md')?.entry.title).toBe('A first')
  })
})

/**
 * 用户库（条目 id `knowledge/<库名>/…`）与 Projects 容器**平级平铺**，不包「我的知识库」一层
 * （设计附录 U）。提上来的节点保留完整 path（行 key、复制路径都靠它），name 才是库名 —— 所以
 * 这里按 name 下钻的 `dirAt` 用末段名（`notes`），不是 `knowledge/notes`。
 */
describe('buildKnowledgeTree — 用户库', () => {
  it('KT-13 用户库提到根上、与 projects 容器平级：projects 置顶、库按名排；任何层级都没有 knowledge 节点；文件保留完整 id', () => {
    const root = buildKnowledgeTree(
      [
        entry('knowledge/zeta/z.md'),
        entry('projects/p1/a.md'),
        entry('knowledge/notes/b.md'),
        entry('knowledge/notes/sub/c.md'),
        entry('knowledge/读书笔记/d.md'),
        entry('knowledge/Alpha/e.md')
      ],
      { 'projects/p1': 'Acme' }
    )

    expect(root.dirs[0]).toMatchObject({ path: 'projects', scopeDir: 'projects' })
    expect(dirAt(root, 'projects/p1').title).toBe('Acme')
    const userPaths = root.dirs.slice(1).map((d) => d.path)
    expect([...userPaths].sort()).toEqual(
      ['knowledge/Alpha', 'knowledge/notes', 'knowledge/zeta', 'knowledge/读书笔记'].sort()
    )
    // 只钉拉丁字母之间的相对序；汉字排在哪由 zh-CN 排序规则定，不在这里钉
    const before = (a: string, b: string): void =>
      expect(userPaths.indexOf(a), `${a} before ${b}`).toBeLessThan(userPaths.indexOf(b))
    before('knowledge/Alpha', 'knowledge/notes')
    before('knowledge/notes', 'knowledge/zeta')

    // 容器节点提完就拿掉：哪一层都不剩 `knowledge`
    expect(allDirs(root).map((d) => d.path)).not.toContain('knowledge')

    for (const name of ['zeta', 'notes', '读书笔记', 'Alpha']) {
      expect(dirAt(root, name)).toMatchObject({
        path: `knowledge/${name}`,
        name,
        scopeDir: null,
        title: null
      })
    }
    const notes = dirAt(root, 'notes')
    expect(paths(notes)).toEqual(['knowledge/notes/b.md'])
    expect(notes.dirs.map((d) => d.path)).toEqual(['knowledge/notes/sub'])
    expect(paths(dirAt(root, 'notes/sub'))).toEqual(['knowledge/notes/sub/c.md'])

    // 清单里只有用户库：根上恰好是这些库，没有根级文件
    const userOnly = buildKnowledgeTree([
      entry('knowledge/notes/b.md'),
      entry('knowledge/Alpha/e.md')
    ])
    expect(userOnly.dirs.map((d) => d.path)).toEqual(['knowledge/Alpha', 'knowledge/notes'])
    expect(userOnly.files).toEqual([])
  })

  it('KT-14 撞名守卫：库名 projects 不被当成项目容器、它里面的同名子目录也拿不到项目名；库名 knowledge 照常提上来', () => {
    // 置顶与 scopeDir 都按 path 判、不按 name：`knowledge/projects` 只是一个恰好叫 projects 的库
    const clash = buildKnowledgeTree([
      entry('knowledge/projects/x.md'),
      entry('knowledge/aaa/y.md'),
      entry('projects/p1/a.md')
    ])
    expect(clash.dirs[0]).toMatchObject({ path: 'projects', scopeDir: 'projects' })
    expect(clash.dirs.map((d) => d.path)).toEqual([
      'projects',
      'knowledge/aaa',
      'knowledge/projects'
    ])
    const userProjects = clash.dirs[2]
    expect(userProjects).toMatchObject({ name: 'projects', scopeDir: null, title: null })
    // 两个同名目录各管各的文件，不合并
    expect(paths(userProjects)).toEqual(['knowledge/projects/x.md'])
    expect(allFiles(clash.dirs[0]).map((f) => f.entry.path)).toEqual(['projects/p1/a.md'])

    // 库名恰好是容器名 knowledge：提上来的是这个库本身，文件还在
    const nested = buildKnowledgeTree([entry('knowledge/knowledge/x.md')])
    expect(nested.dirs.map((d) => d.path)).toEqual(['knowledge/knowledge'])
    expect(nested.dirs[0]).toMatchObject({ name: 'knowledge', scopeDir: null, title: null })
    expect(paths(nested.dirs[0])).toEqual(['knowledge/knowledge/x.md'])

    // 名字按 path 命中、不按 name：库 `knowledge/projects` 里的 `p1/` 不是项目库 p1，project.md 也只是一行
    const lookalike = buildKnowledgeTree(
      [entry('projects/p1/a.md'), entry('knowledge/projects/p1/project.md', { title: 'P' })],
      { 'projects/p1': 'Acme' }
    )
    expect(lookalike.dirs.map((d) => d.path)).toEqual(['projects', 'knowledge/projects'])
    expect(lookalike.dirs[0].dirs[0]).toMatchObject({ path: 'projects/p1', title: 'Acme' })
    const inner = lookalike.dirs[1].dirs[0]
    expect(inner).toMatchObject({ path: 'knowledge/projects/p1', title: null })
    expect(labels(inner)).toEqual(['P'])
  })
})
