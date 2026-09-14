/**
 * sessionBundle —— 工具里的 `project` 库：**根会话所属项目的那一个** bundle。
 * 钉：`create` 为真时懒建（真的建出目录 + 绑定概念 + 仓库）、为假时只解析；两条「没有目标」
 * 的软失败各回一句可读的话而不是抛错 —— 工具把它当软条件，文案会原样出现在 agent 面前。
 *
 * resolveBase / listBases —— 工具参数里的 `base`：`project` 转给 sessionBundle，其余名字按**目录清单**
 * 精确匹配用户根下的库（所有会话都看得见；从不建库、只读）。点名不存在 / 不合法的名字一律报错并列出
 * 可用库（隐藏目录、散文件、符号链接都不算库，也绝不越出用户根）；保留名 `project` 优先，同名的用户
 * 目录够不着，也不出现在 `bases` 与报错的候选里。
 *
 * dao 是替身（这里不验 SQL），bundles / 投影 / git 用真的：会话这一侧要证明的正是
 * 「解析出来的 bundle 就是宿主真会建出来的那一个」。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Project } from '../../../dao/types/project'

const state = vi.hoisted(() => ({ root: '' }))

vi.mock('../../../utils/paths', () => ({
  getShuvixKnowledgeRootDir: () => state.root,
  getUserKnowledgeRootDir: () => `${state.root}-user`
}))
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('../../../dao/projectDao', () => ({ projectDao: { findById: vi.fn() } }))
vi.mock('../../../dao/sessionDao', () => ({ sessionDao: { pick: vi.fn() } }))

import { projectDao } from '../../../dao/projectDao'
import { sessionDao } from '../../../dao/sessionDao'
import { listBases, resolveBase, sessionBundle } from '../sessionBundle'
import { flushKnowledgeCommits } from '../repo'
import { invalidateKnowledgeScan } from '../scan'
import {
  PROJECTS,
  bundleAt,
  fileAt,
  gitCommitCount,
  makeTempRoot,
  seedConcept,
  userRootOf
} from './fixture'

const NO_PROJECT =
  'This session does not belong to a project, so it has no "project" knowledge base — name one of the user\'s knowledge bases instead (call "bases" to list them).'

const PROJECT: Project = {
  id: 'p1',
  name: 'Acme Corp',
  path: '/repos/acme',
  systemPrompt: '',
  settings: {},
  archivedAt: 0,
  createdAt: 1,
  updatedAt: 1
}

let root: string

/** pick 的泛型签名在替身里塌成「整行」，这里只喂本模块真正取的那一列 */
const mockPick = (row: { projectId: string | null } | undefined): void => {
  vi.mocked(sessionDao.pick).mockReturnValue(row as ReturnType<typeof sessionDao.pick>)
}

const inProject = (): void => {
  mockPick({ projectId: 'p1' })
  vi.mocked(projectDao.findById).mockReturnValue(PROJECT)
}

beforeEach(() => {
  vi.clearAllMocks()
  root = makeTempRoot()
  state.root = root
  invalidateKnowledgeScan()
})

afterEach(async () => {
  await flushKnowledgeCommits()
  rmSync(root, { recursive: true, force: true })
  rmSync(userRootOf(root), { recursive: true, force: true })
})

describe('sessionBundle', () => {
  it('SB-1 会话在项目里 + create → 懒建那个 bundle 并返回 id / 绝对目录 / 人读标签；按根会话的 projectId 查', async () => {
    inProject()

    const target = await sessionBundle('s1', { create: true })

    expect(sessionDao.pick).toHaveBeenCalledWith('s1', ['projectId'])
    expect(projectDao.findById).toHaveBeenCalledWith('p1')
    expect(target).toEqual({
      bundle: 'projects/p1',
      dir: bundleAt(root, 'projects/p1'),
      label: 'project "Acme Corp"'
    })
    expect(existsSync(fileAt(root, 'projects/p1', 'project.md'))).toBe(true)
    expect(existsSync(fileAt(root, 'projects/p1', 'index.md'))).toBe(true)
  })

  it('SB-2 bundle 已存在时 create:false 也解析得到同一个；不重复建、不加提交', async () => {
    inProject()
    const created = await sessionBundle('s1', { create: true })
    const dir = bundleAt(root, 'projects/p1')
    const commits = gitCommitCount(dir)

    expect(await sessionBundle('s1', { create: false })).toEqual(created)
    expect(readdirSync(join(root, PROJECTS))).toEqual(['p1'])
    expect(gitCommitCount(dir)).toBe(commits)
  })

  it('SB-3 create:false 且还没有 bundle → 一句可读的话（不抛错），磁盘上什么都不建', async () => {
    inProject()

    expect(await sessionBundle('s1', { create: false })).toEqual({
      error: 'Project "Acme Corp" has no knowledge entries yet.'
    })
    expect(existsSync(join(root, PROJECTS))).toBe(false)
  })

  it('SB-4 没有项目就没有目标：会话不属于项目 / 会话行不存在 / projectId 指向已删除的项目行，三者都回同一句可读的话；不碰磁盘', async () => {
    const cases: Array<[string, () => void]> = [
      [
        'no project',
        () => {
          mockPick({ projectId: null })
        }
      ],
      [
        'no session row',
        () => {
          mockPick(undefined)
        }
      ],
      [
        'dangling projectId',
        () => {
          mockPick({ projectId: 'gone' })
          vi.mocked(projectDao.findById).mockReturnValue(undefined)
        }
      ]
    ]
    for (const [name, arrange] of cases) {
      arrange()
      expect(await sessionBundle('s1', { create: true }), name).toEqual({ error: NO_PROJECT })
      expect(await sessionBundle('s1', { create: false }), name).toEqual({ error: NO_PROJECT })
    }
    expect(existsSync(join(root, PROJECTS))).toBe(false)
  })
})

describe('resolveBase / listBases —— 用户库', () => {
  it('SB-5 用户库对所有会话可见：在不在项目里、create 真假都解析到同一个（名字去首尾空白，空文件夹也算库）；从不建库、只读', async () => {
    const userRoot = userRootOf(root)
    seedConcept(userRoot, 'notes/a.md', ['type: Memory', 'title: A'])
    mkdirSync(join(userRoot, '读书笔记'))
    const notes = {
      bundle: 'knowledge/notes',
      dir: join(userRoot, 'notes'),
      label: 'knowledge base "notes"'
    }
    const reading = {
      bundle: 'knowledge/读书笔记',
      dir: join(userRoot, '读书笔记'),
      label: 'knowledge base "读书笔记"'
    }

    const sessions: Array<[string, () => void]> = [
      ['in project', inProject],
      ['no project', () => mockPick({ projectId: null })]
    ]
    for (const [name, arrange] of sessions) {
      arrange()
      expect(await resolveBase('s1', 'notes', { create: false }), name).toEqual(notes)
      expect(await resolveBase('s1', 'notes', { create: true }), name).toEqual(notes)
      expect(await resolveBase('s1', '  读书笔记 ', { create: true }), name).toEqual(reading)
    }

    // 只读：库里没长出 index.md / log.md / .git，shuvix 根下也没有项目容器
    expect(readdirSync(join(userRoot, 'notes'))).toEqual(['a.md'])
    expect(readdirSync(join(userRoot, '读书笔记'))).toEqual([])
    expect(existsSync(join(root, PROJECTS))).toBe(false)
  })

  it('SB-6 不存在或不合法的库名：报错并列出可用库（字母序；隐藏目录、散文件、符号链接不算），create 真假一样；绝不建库、绝不越出用户根；用户根整个不存在时候选只剩 "project"', async () => {
    const userRoot = userRootOf(root)
    mkdirSync(join(userRoot, 'notes', 'sub'), { recursive: true })
    mkdirSync(join(userRoot, 'alpha'))
    mkdirSync(join(userRoot, '.hidden'))
    writeFileSync(join(userRoot, 'readme.md'), '# readme\n')
    // 指向用户根之外真实目录的符号链接：清单不认它，这里也不认
    symlinkSync(root, join(userRoot, 'link'), 'dir')
    inProject()
    const before = readdirSync(userRoot).sort()

    for (const raw of [
      'nope',
      'readme.md',
      '.hidden',
      '..',
      '.',
      'notes/sub',
      'notes\\sub',
      // 相对用户根拼出来正是真实存在的 shuvix 根
      `../${basename(root)}`,
      // 只有小写 notes/：大小写不敏感的文件系统上 stat 得到，但库名按清单精确匹配
      'Notes',
      'link'
    ]) {
      const error = `No knowledge base named "${raw.trim()}". Available: "project", "alpha", "notes".`
      expect(await resolveBase('s1', raw, { create: false }), raw).toEqual({ error })
      expect(await resolveBase('s1', raw, { create: true }), raw).toEqual({ error })
    }
    expect(readdirSync(userRoot).sort()).toEqual(before)
    expect(readdirSync(join(userRoot, 'notes'))).toEqual(['sub'])
    expect(readdirSync(join(userRoot, 'notes', 'sub'))).toEqual([])
    expect(existsSync(join(root, PROJECTS))).toBe(false)

    rmSync(userRoot, { recursive: true, force: true })
    for (const create of [false, true]) {
      expect(await resolveBase('s1', 'notes', { create }), String(create)).toEqual({
        error: 'No knowledge base named "notes". Available: "project".'
      })
    }
    expect(existsSync(userRoot)).toBe(false)
  })

  it('SB-6b NFD 目录名按磁盘拼写解析：NFC / NFD 两种写法都命中，bundle id 与标签用磁盘上的那个拼写', async () => {
    const userRoot = userRootOf(root)
    const nfd = 'cafe\u0301'
    const nfc = 'caf\u00e9'
    mkdirSync(join(userRoot, nfd), { recursive: true })
    // 前提：文件系统保留建目录时的拼写（APFS / ext4 都保留）
    expect(readdirSync(userRoot)).toEqual([nfd])
    mockPick({ projectId: null })

    const onDisk = {
      bundle: `knowledge/${nfd}`,
      dir: join(userRoot, nfd),
      label: `knowledge base "${nfd}"`
    }
    expect(await resolveBase('s1', nfc, { create: false })).toEqual(onDisk)
    expect(await resolveBase('s1', nfd, { create: false })).toEqual(onDisk)
  })

  it('SB-7 `project` 是保留名：同名用户目录够不着 —— 不在项目里回 NO_PROJECT、在项目里就是项目库，用户目录不受影响；它也不出现在 bases 与报错候选里', async () => {
    const userRoot = userRootOf(root)
    seedConcept(userRoot, 'project/a.md', ['type: Memory', 'title: A'])

    mockPick({ projectId: null })
    expect(await resolveBase('s1', ' project ', { create: true })).toEqual({ error: NO_PROJECT })
    expect(await listBases('s1')).toStrictEqual([
      { base: 'project', label: 'this project', note: 'this session does not belong to a project' }
    ])
    // 候选里 "project" 恰好一次：只有保留名那一个，同名目录不重复出现
    expect(await resolveBase('s1', 'nope', { create: false })).toEqual({
      error: 'No knowledge base named "nope". Available: "project".'
    })

    inProject()
    expect(await resolveBase('s1', ' project ', { create: true })).toEqual({
      bundle: 'projects/p1',
      dir: bundleAt(root, 'projects/p1'),
      label: 'project "Acme Corp"'
    })
    expect((await listBases('s1')).map((b) => b.base)).toEqual(['project'])
    expect(readdirSync(join(userRoot, 'project'))).toEqual(['a.md'])
  })

  it('SB-8 listBases：`project` 恒在首项（不在项目里 / 项目库还没建 / 已建三种说法），其后每个用户库（字母序，隐藏目录与散文件不算）；列举本身不建库', async () => {
    const userRoot = userRootOf(root)
    mkdirSync(join(userRoot, 'notes'), { recursive: true })
    mkdirSync(join(userRoot, 'alpha'))
    mkdirSync(join(userRoot, '.obsidian'))
    writeFileSync(join(userRoot, 'readme.md'), '# readme\n')
    const userBases = [
      { base: 'alpha', label: 'knowledge base "alpha"', dir: join(userRoot, 'alpha') },
      { base: 'notes', label: 'knowledge base "notes"', dir: join(userRoot, 'notes') }
    ]

    // (a) 不在项目里：project 项只有一句说明，没有 dir 键
    mockPick({ projectId: null })
    expect(await listBases('s1')).toStrictEqual([
      { base: 'project', label: 'this project', note: 'this session does not belong to a project' },
      ...userBases
    ])

    // (b) 在项目里、项目库还没建：说明第一次 create 会建出来 —— 列举本身不建
    inProject()
    expect(await listBases('s1')).toStrictEqual([
      {
        base: 'project',
        label: 'project "Acme Corp"',
        note: 'empty — the first "create" makes it'
      },
      ...userBases
    ])
    expect(existsSync(join(root, PROJECTS))).toBe(false)

    // (c) 建出来之后：带绝对目录，不再有说明
    await sessionBundle('s1', { create: true })
    const built = {
      base: 'project',
      label: 'project "Acme Corp"',
      dir: bundleAt(root, 'projects/p1')
    }
    expect(await listBases('s1')).toStrictEqual([built, ...userBases])

    // (d) 用户根不存在：只剩 project
    rmSync(userRoot, { recursive: true, force: true })
    expect(await listBases('s1')).toStrictEqual([built])
  })
})
