/**
 * 知识库分组的树形派生 —— `KnowledgeEntry[]` → 目录树（buildKnowledgeTree）。
 *
 * 判定全在这个纯函数里，UI 只是照树画：顶层作用域目录固定序、只画有文件的目录、章程 /
 * 绑定概念（project.md / bot.md）置首且按位置识别、绑定概念的 title 给目录命名
 * 而自己那行退回文件名 stem、目录与文件各按显示名排、路径归一 + 去重。这里逐条钉住，
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

const entry = (path: string, over: Partial<KnowledgeEntry> = {}): KnowledgeEntry => ({
  path,
  scope: null,
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
   * 根级文件（用户自己放的、或外部工具写的）落在根、不造目录、也不是章程 ——
   * 宿主不再往库里种任何根级规范文件，章程只剩两种绑定概念（project.md / bot.md）。
   */
  it('KT-2 根级文件：行落在根、label 是它的 title、不是章程、不给根命名、不造目录', () => {
    const note = entry('NOTES.md', { type: 'Guide', title: 'House rules' })
    const root = buildKnowledgeTree([note])
    expect(root.files).toEqual([{ entry: note, charter: false, label: 'House rules' }])
    expect(root.title).toBeNull()
    expect(root.dirs).toEqual([])
  })

  it('KT-3 多个根级文件：一个都不是章程，按显示名排，仍不造目录', () => {
    const root = buildKnowledgeTree([
      entry('notes.md', { title: 'Notes' }),
      entry('house.md', { title: 'Anchors' })
    ])
    expect(paths(root)).toEqual(['house.md', 'notes.md'])
    expect(root.files.map((f) => f.charter)).toEqual([false, false])
    expect(root.dirs).toEqual([])
  })

  it('KT-4 顶层固定序：全局 → 项目 → 会话 → Bots → Wiki → 来源，未知目录殿后按名排；六个作用域目录带 scopeDir、未知的为 null', () => {
    const root = buildKnowledgeTree([
      entry('raw/r.md'),
      entry('wiki/t/w.md'),
      entry('bots/b/x.md'),
      entry('sessions/s.md'),
      entry('projects/p/x.md'),
      entry('global/g.md'),
      entry('zeta/z.md'),
      entry('archive/a.md')
    ])
    expect(names(root)).toEqual([
      'global',
      'projects',
      'sessions',
      'bots',
      'wiki',
      'raw',
      'archive',
      'zeta'
    ])
    expect(root.dirs.map((d) => d.scopeDir)).toEqual([
      'global',
      'projects',
      'sessions',
      'bots',
      'wiki',
      'raw',
      null,
      null
    ])
  })

  it('KT-5 只画有文件的目录，中间链路物化：projects → acme（空文件、无标题、无固定文案）→ sessions（固定文案）；bots 下的 sessions 不是固定文案', () => {
    expect(names(buildKnowledgeTree([entry('global/a.md')]))).toEqual(['global'])

    const root = buildKnowledgeTree([entry('projects/acme/sessions/2026-09-01-s.md')])
    expect(names(root)).toEqual(['projects'])
    const projects = root.dirs[0]
    expect(projects.files).toEqual([])
    expect(names(projects)).toEqual(['acme'])
    const acme = projects.dirs[0]
    expect(acme).toMatchObject({
      path: 'projects/acme',
      name: 'acme',
      scopeDir: null,
      title: null,
      files: []
    })
    expect(names(acme)).toEqual(['sessions'])
    const sessions = acme.dirs[0]
    expect(sessions).toMatchObject({
      path: 'projects/acme/sessions',
      name: 'sessions',
      scopeDir: 'sessions',
      title: null,
      dirs: []
    })
    expect(paths(sessions)).toEqual(['projects/acme/sessions/2026-09-01-s.md'])

    const botSessions = dirAt(
      buildKnowledgeTree([entry('bots/helper/sessions/x.md')]),
      'bots/helper/sessions'
    )
    expect(botSessions).toMatchObject({ path: 'bots/helper/sessions', scopeDir: null })
  })
})

describe('buildKnowledgeTree — 章程 / 绑定概念', () => {
  it('KT-6 绑定概念给目录命名、置首、自己那行显示文件名 stem；其余行 label 即 title', () => {
    const root = buildKnowledgeTree([
      entry('projects/acme/notes.md', { title: 'Notes' }),
      entry('projects/acme/project.md', { type: 'Project', title: 'ACME Corp' }),
      entry('projects/acme/api.md', { title: 'API' }),
      entry('bots/helper/bot.md', { type: 'Bot', title: 'Helper Bot' }),
      entry('bots/helper/memo.md', { title: 'Memo' })
    ])

    const acme = dirAt(root, 'projects/acme')
    expect(acme.title).toBe('ACME Corp')
    expect(paths(acme)).toEqual([
      'projects/acme/project.md',
      'projects/acme/api.md',
      'projects/acme/notes.md'
    ])
    expect(acme.files.map((f) => f.charter)).toEqual([true, false, false])
    expect(labels(acme)).toEqual(['project', 'API', 'Notes'])

    const helper = dirAt(root, 'bots/helper')
    expect(helper.title).toBe('Helper Bot')
    expect(paths(helper)).toEqual(['bots/helper/bot.md', 'bots/helper/memo.md'])
    expect(helper.files.map((f) => f.charter)).toEqual([true, false])
    expect(labels(helper)).toEqual(['bot', 'Memo'])
  })

  it('KT-7 章程识别按位置：只有 projects/<slug>/project.md 与 bots/<name>/bot.md 算，同名文件放错层级 / 错目录一律不算、也不给目录命名', () => {
    const root = buildKnowledgeTree([
      entry('projects/project.md', { title: 'P0' }),
      entry('projects/acme/sub/project.md', { title: 'P1' }),
      entry('wiki/topic/project.md', { title: 'P2' }),
      entry('bots/helper/project.md', { title: 'P3' }),
      entry('projects/acme/bot.md', { title: 'B' }),
      entry('project.md', { title: 'P4' })
    ])
    const files = allFiles(root)
    expect(files).toHaveLength(6)
    expect(files.filter((f) => f.charter).map((f) => f.entry.path)).toEqual([])
    expect(
      allDirs(root)
        .filter((d) => d.title !== null)
        .map((d) => d.path)
    ).toEqual([])
  })

  it('KT-8 绑定概念的 title 规则：全空白不命名目录；首尾空白裁掉；等于 stem（解析器缺省）视同没写 —— 三种情况都仍是章程、置首、label 为 stem', () => {
    const blank = dirAt(
      buildKnowledgeTree([
        entry('projects/acme/x.md', { title: 'X' }),
        entry('projects/acme/project.md', { title: '   ' })
      ]),
      'projects/acme'
    )
    expect(blank.title).toBeNull()
    expect(paths(blank)).toEqual(['projects/acme/project.md', 'projects/acme/x.md'])
    expect(blank.files[0]).toMatchObject({ charter: true, label: 'project' })

    const padded = dirAt(
      buildKnowledgeTree([entry('projects/acme/project.md', { title: '  ACME  ' })]),
      'projects/acme'
    )
    expect(padded.title).toBe('ACME')
    expect(padded.files[0]).toMatchObject({ charter: true, label: 'project' })

    const dflt = dirAt(
      buildKnowledgeTree([entry('projects/acme/project.md', { title: 'project' })]),
      'projects/acme'
    )
    expect(dflt.title).toBeNull()
    expect(dflt.files[0]).toMatchObject({ charter: true, label: 'project' })
  })

  it('KT-9 没有 project.md 的项目目录按 slug 显示；有章程则 dirDisplayName 取章程 title', () => {
    const orphan = dirAt(buildKnowledgeTree([entry('projects/orphan/notes.md')]), 'projects/orphan')
    expect(orphan).toMatchObject({ title: null, scopeDir: null })
    expect(dirDisplayName(orphan)).toBe('orphan')

    const named = dirAt(
      buildKnowledgeTree([entry('projects/acme/project.md', { title: 'ACME Corp' })]),
      'projects/acme'
    )
    expect(dirDisplayName(named)).toBe('ACME Corp')
  })
})

describe('buildKnowledgeTree — 排序', () => {
  it('KT-10 同级目录按显示名排：章程 title 参与、无章程用 slug', () => {
    const root = buildKnowledgeTree([
      entry('projects/z-proj/project.md', { title: 'Alpha Inc' }),
      entry('projects/a-proj/project.md', { title: 'Zeta Ltd' }),
      entry('projects/m-proj/notes.md')
    ])
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
  it('KT-12 反斜杠 / 前导 ./ 与 / / 重复分隔符 / 尾随 / 都归一；同路径取首条；空路径与 "/" 跳过；不造 "." 或空名目录；不改输入', () => {
    const inputs = [
      entry('\\projects\\acme\\project.md', { type: 'Project', title: 'ACME' }),
      entry('/global/a.md', { title: 'A first' }),
      entry('./global/b.md', { title: 'B' }),
      entry('global//c.md', { title: 'C' }),
      entry('raw/d.md/', { title: 'D' }),
      entry('global/a.md', { title: 'A second' }),
      entry('', { title: 'empty' }),
      entry('/', { title: 'slash' })
    ]
    const snapshot = structuredClone(inputs)

    const root = buildKnowledgeTree(inputs)
    expect(inputs).toEqual(snapshot)

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

    const acme = dirAt(root, 'projects/acme')
    expect(acme.title).toBe('ACME')
    expect(acme.files[0]).toMatchObject({ charter: true, label: 'project' })
  })
})
