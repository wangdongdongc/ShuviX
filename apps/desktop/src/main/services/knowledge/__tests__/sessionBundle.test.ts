/**
 * sessionBundle —— 「这条会话有哪几个知识库」以及工具参数里的 `base` 解析到哪个 bundle。
 *
 * 选择是一条**活的回落链**（不落库、不快照）：会话设过 → 父会话设过 → 项目设过 → 缺省「全部用户库 +
 * （属于项目时）项目库」。与扩展能力勾选的快照语义刻意不同 —— 知识库是每次调用现查的。
 *
 * 选择是**硬边界**：`bases` 只列启用且此刻真在的库，点名没启用的名字报错并列出启用了哪些。
 * 库名按目录清单精确匹配（NFC 归一、大小写敏感）；保留名 `project` 是项目库，同名的用户目录够不着。
 * `sessionBundle` 本身仍然只回答「本会话所属项目的库是哪一个」，不判断目录建没建过（读宽）。
 *
 * dao 是替身（这里不验 SQL），路径与目录清单用真的。
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
vi.mock('../../../dao/projectDao', () => ({ projectDao: { findById: vi.fn(), pick: vi.fn() } }))
// updateSettings 只为「活的、不落快照」那条留着断言面 —— 生产代码在这里一次都不该写库
vi.mock('../../../dao/sessionDao', () => ({
  sessionDao: { pick: vi.fn(), updateSettings: vi.fn() }
}))

import { projectDao } from '../../../dao/projectDao'
import { sessionDao } from '../../../dao/sessionDao'
import {
  enabledBaseChoices,
  knowledgeBaseOptions,
  listBases,
  resolveBase,
  sessionBundle
} from '../sessionBundle'
import { invalidateKnowledgeScan } from '../scan'
import { PROJECTS, bundleAt, makeTempRoot, seedConcept, userRootOf } from './fixture'

const NO_PROJECT =
  'This session does not belong to a project, so it has no "project" knowledge base.'

const NO_BASES =
  'No knowledge base is enabled for this session — the user picks which bases a session uses in its settings.'

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

/** 会话行替身：按 id 分发 —— 回落链会去问父会话 */
const sessions = new Map<string, Record<string, unknown>>()
/** 项目行替身（只喂 settings；项目本身另有 findById 替身） */
const projects = new Map<string, { settings?: Record<string, unknown> }>()

/** 本会话那一行（`undefined` = 会话不存在）；pick 的泛型签名在替身里塌成「整行」 */
const mockPick = (row: Record<string, unknown> | undefined): void => {
  sessions.clear()
  if (row) sessions.set('s1', row)
}

/** 另一条会话（父会话）那一行 */
const mockSessionRow = (id: string, row: Record<string, unknown>): void => {
  sessions.set(id, row)
}

/** 项目设过的选择 */
const mockProjectBases = (id: string, knowledgeBases: string[]): void => {
  projects.set(id, { settings: { knowledgeBases } })
}

const inProject = (): void => {
  mockPick({ projectId: 'p1' })
  vi.mocked(projectDao.findById).mockReturnValue(PROJECT)
}

beforeEach(() => {
  vi.clearAllMocks()
  sessions.clear()
  projects.clear()
  vi.mocked(sessionDao.pick).mockImplementation(((id: string) =>
    sessions.get(id)) as unknown as typeof sessionDao.pick)
  vi.mocked(projectDao.pick).mockImplementation(((id: string) =>
    projects.get(id)) as unknown as typeof projectDao.pick)
  root = makeTempRoot()
  state.root = root
  invalidateKnowledgeScan()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(userRootOf(root), { recursive: true, force: true })
})

describe('sessionBundle', () => {
  it('SB-1 会话在项目里 → 以项目 id 命名的目录（id / 绝对目录 / 人读标签）；按根会话的 projectId 查；目录还不存在也照样解析，且不建任何东西', () => {
    inProject()

    expect(sessionBundle('s1')).toEqual({
      bundle: 'projects/p1',
      dir: bundleAt(root, 'projects/p1'),
      label: 'project "Acme Corp"'
    })
    expect(sessionDao.pick).toHaveBeenCalledWith('s1', ['projectId'])
    expect(projectDao.findById).toHaveBeenCalledWith('p1')
    expect(existsSync(join(root, PROJECTS))).toBe(false)
  })

  it('SB-2 目录里已经有东西：解析结果一样，目录原样', () => {
    inProject()
    seedConcept(root, 'projects/p1/a.md', ['type: Memory', 'title: A'])
    const before = readdirSync(bundleAt(root, 'projects/p1'))

    expect(sessionBundle('s1')).toEqual({
      bundle: 'projects/p1',
      dir: bundleAt(root, 'projects/p1'),
      label: 'project "Acme Corp"'
    })
    expect(readdirSync(bundleAt(root, 'projects/p1'))).toEqual(before)
  })

  it('SB-3 resolveBase 的 `project`（去首尾空白）与 sessionBundle 是同一个结果', async () => {
    inProject()
    expect(await resolveBase('s1', ' project ')).toEqual(sessionBundle('s1'))
  })

  it('SB-4 没有项目就没有这个库：会话不属于项目 / 会话行不存在 / projectId 指向已删除的项目行，三者都回同一句可读的话；不碰磁盘', () => {
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
      expect(sessionBundle('s1'), name).toEqual({ error: NO_PROJECT })
    }
    expect(existsSync(join(root, PROJECTS))).toBe(false)
  })
})

describe('resolveBase / listBases —— 选择', () => {
  it('SB-5 谁都没设过 → 缺省「全部用户库 +（属于项目时）项目库」；名字去首尾空白、按 NFC 精确匹配；只读', async () => {
    const userRoot = userRootOf(root)
    seedConcept(userRoot, 'notes/a.md', ['type: Memory', 'title: A'])
    mkdirSync(join(userRoot, '读书笔记'))
    const notes = {
      bundle: 'knowledge/notes',
      dir: join(userRoot, 'notes'),
      label: 'knowledge base "notes"'
    }

    // 在项目里：两个用户库 + 项目库；项目库排在用户库之后 —— 它还在，但不再是主角
    inProject()
    expect(await resolveBase('s1', 'notes')).toEqual(notes)
    expect(await resolveBase('s1', '  读书笔记 ')).toEqual({
      bundle: 'knowledge/读书笔记',
      dir: join(userRoot, '读书笔记'),
      label: 'knowledge base "读书笔记"'
    })
    expect((await listBases('s1')).map((b) => b.base)).toEqual(['notes', '读书笔记', 'project'])

    // 不在项目里：只有用户库，`project` 不在其中
    mockPick({ projectId: null })
    expect(await resolveBase('s1', 'notes')).toEqual(notes)
    expect((await listBases('s1')).map((b) => b.base)).toEqual(['notes', '读书笔记'])

    // 只读：库里什么都没长出来，shuvix 根下也没有项目容器
    expect(readdirSync(join(userRoot, 'notes'))).toEqual(['a.md'])
    expect(readdirSync(join(userRoot, '读书笔记'))).toEqual([])
    expect(existsSync(join(root, PROJECTS))).toBe(false)
  })

  it('SB-6 点名没启用 / 不存在 / 不合法的名字：报错并列出启用了哪些；一个都没启用时另说一句；绝不建库、绝不越出用户根', async () => {
    const userRoot = userRootOf(root)
    mkdirSync(join(userRoot, 'notes', 'sub'), { recursive: true })
    mkdirSync(join(userRoot, 'alpha'))
    mkdirSync(join(userRoot, '.hidden'))
    writeFileSync(join(userRoot, 'readme.md'), '# readme\n')
    // 指向用户根之外真实目录的符号链接：清单不认它，这里也不认
    symlinkSync(root, join(userRoot, 'link'), 'dir')
    mockPick({ projectId: null })
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
      expect(await resolveBase('s1', raw), raw).toEqual({
        error: `"${raw.trim()}" is not one of this session's knowledge bases. Enabled: "alpha", "notes".`
      })
    }
    expect(readdirSync(userRoot).sort()).toEqual(before)
    expect(readdirSync(join(userRoot, 'notes'))).toEqual(['sub'])
    expect(existsSync(join(root, PROJECTS))).toBe(false)

    // 明确设成空 = 一个都不启用：这时候别让 agent 以为是自己名字写错了
    mockPick({ projectId: null, settings: { knowledgeBases: [] } })
    expect(await resolveBase('s1', 'notes')).toEqual({ error: NO_BASES })
    expect(await listBases('s1')).toEqual([])
  })

  it('SB-6b NFD 目录名按磁盘拼写解析：NFC / NFD 两种写法都命中，bundle id 与标签用磁盘上的那个拼写', async () => {
    const userRoot = userRootOf(root)
    const nfd = 'café'
    const nfc = 'café'
    mkdirSync(join(userRoot, nfd), { recursive: true })
    // 前提：文件系统保留建目录时的拼写（APFS / ext4 都保留）
    expect(readdirSync(userRoot)).toEqual([nfd])
    mockPick({ projectId: null })

    const onDisk = {
      bundle: `knowledge/${nfd}`,
      dir: join(userRoot, nfd),
      label: `knowledge base "${nfd}"`
    }
    expect(await resolveBase('s1', nfc)).toEqual(onDisk)
    expect(await resolveBase('s1', nfd)).toEqual(onDisk)
  })

  it('SB-7 `project` 是保留名：在项目里才有这一个库，同名的用户目录够不着；不在项目里时它压根不在启用清单里', async () => {
    const userRoot = userRootOf(root)
    seedConcept(userRoot, 'project/a.md', ['type: Memory', 'title: A'])

    // 不在项目里：缺省里没有 project，点名它就是「不是本会话的库」；同名目录也够不着
    mockPick({ projectId: null })
    expect(await resolveBase('s1', ' project ')).toEqual({ error: NO_BASES })
    expect(await listBases('s1')).toEqual([])

    inProject()
    expect(await resolveBase('s1', ' project ')).toEqual({
      bundle: 'projects/p1',
      dir: bundleAt(root, 'projects/p1'),
      label: 'project "Acme Corp"'
    })
    expect((await listBases('s1')).map((b) => b.base)).toEqual(['project'])
    expect(readdirSync(join(userRoot, 'project'))).toEqual(['a.md'])
  })

  it('SB-8 listBases：启用且此刻真的在的库，按选择的顺序；选了但已经不在的悄悄跳过；列举本身不建任何东西', async () => {
    const userRoot = userRootOf(root)
    mkdirSync(join(userRoot, 'notes'), { recursive: true })
    mkdirSync(join(userRoot, 'alpha'))
    inProject()
    // 顺序按选择写的那一份；'gone' 已经不在磁盘上 —— 跳过而不是报错
    mockPick({
      projectId: 'p1',
      settings: { knowledgeBases: ['notes', 'gone', 'project', 'alpha'] }
    })

    expect(await listBases('s1')).toStrictEqual([
      { base: 'notes', label: 'knowledge base "notes"', dir: join(userRoot, 'notes') },
      { base: 'project', label: 'project "Acme Corp"', dir: bundleAt(root, 'projects/p1') },
      { base: 'alpha', label: 'knowledge base "alpha"', dir: join(userRoot, 'alpha') }
    ])
    expect(existsSync(join(root, PROJECTS))).toBe(false)
  })

  it('SB-9 回落链：会话设过 → 父会话设过 → 项目设过 → 缺省；每一级都是整份替换', async () => {
    const userRoot = userRootOf(root)
    for (const name of ['alpha', 'notes']) mkdirSync(join(userRoot, name), { recursive: true })
    vi.mocked(projectDao.findById).mockReturnValue(PROJECT)

    // 项目设过：会话自己没设就用项目那份
    mockPick({ projectId: 'p1' })
    mockProjectBases('p1', ['alpha'])
    expect((await listBases('s1')).map((b) => b.base)).toEqual(['alpha'])

    // 父会话设过：压过项目那份（子会话抄上一级）
    mockPick({ projectId: 'p1', parentId: 'parent' })
    mockSessionRow('parent', { projectId: 'p1', settings: { knowledgeBases: ['notes'] } })
    expect((await listBases('s1')).map((b) => b.base)).toEqual(['notes'])

    // 会话自己设过：压过父会话与项目
    mockPick({
      projectId: 'p1',
      parentId: 'parent',
      settings: { knowledgeBases: ['project', 'alpha'] }
    })
    mockSessionRow('parent', { projectId: 'p1', settings: { knowledgeBases: ['notes'] } })
    expect((await listBases('s1')).map((b) => b.base)).toEqual(['project', 'alpha'])
  })

  it('SB-10 knowledgeBaseOptions：候选 = 用户库 +（有项目时）项目库；explicit 说明是不是有人明确设过', async () => {
    const userRoot = userRootOf(root)
    for (const name of ['alpha', 'notes']) mkdirSync(join(userRoot, name), { recursive: true })

    // 没给会话（项目配置对话框）：候选含项目库、不给选择
    expect(knowledgeBaseOptions()).toEqual({
      options: [
        { name: 'alpha', label: 'alpha' },
        { name: 'notes', label: 'notes' },
        { name: 'project', label: '' }
      ],
      selected: [],
      explicit: false
    })

    // 会话没设过、项目也没设过 → 勾的是缺省，explicit 为假
    inProject()
    expect(knowledgeBaseOptions('s1')).toEqual({
      options: [
        { name: 'alpha', label: 'alpha' },
        { name: 'notes', label: 'notes' },
        { name: 'project', label: 'Acme Corp' }
      ],
      selected: ['alpha', 'notes', 'project'],
      explicit: false
    })

    // 会话自己设过 → explicit
    mockPick({ projectId: 'p1', settings: { knowledgeBases: ['notes'] } })
    expect(knowledgeBaseOptions('s1')).toMatchObject({ selected: ['notes'], explicit: true })
  })
})

/**
 * 回落链的边角（SB-11..18）。三条主线：
 *   - 「设过」的判据只有一个 —— **是不是数组**。`[]` 是一个明确的「一个库都不要」，不能往缺省落；
 *     字符串 / null / 对象这类坏值则压根不算设过，继续往下一级找。
 *   - 选择是**活的**：不落快照、不写库，两次解析之间磁盘或设置变了，下一次就作数。
 *   - 围栏列的清单与工具解析的是**同一份结果**（同一次 enabledTargets），NFC 归一只做一次。
 */
describe('SB-11..18 回落链与围栏清单', () => {
  /** 建若干用户库目录，返回用户根 */
  const seedBases = (...names: string[]): string => {
    const userRoot = userRootOf(root)
    for (const name of names) mkdirSync(join(userRoot, name), { recursive: true })
    return userRoot
  }
  const baseNames = async (): Promise<string[]> => (await listBases('s1')).map((b) => b.base)

  it('SB-11 「设过」只看是不是数组：项目设成 [] → 这个项目的会话一个库都不启用，不往缺省落', async () => {
    seedBases('alpha', 'notes')
    inProject()
    // 空数组是一个明确的选择（「这个项目的会话不用知识库」），不是「没意见」
    mockProjectBases('p1', [])

    expect(await listBases('s1')).toEqual([])
    expect(await resolveBase('s1', 'notes')).toEqual({ error: NO_BASES })
    expect(await resolveBase('s1', 'project')).toEqual({ error: NO_BASES })
  })

  it('SB-12 非数组不算设过，逐级下落到缺省', async () => {
    seedBases('alpha', 'notes')
    vi.mocked(projectDao.findById).mockReturnValue(PROJECT)
    // 三级都是坏值：手改过的 settings / 旧行 / 半截写入都可能长这样
    mockPick({ projectId: 'p1', parentId: 'parent', settings: { knowledgeBases: 'notes' } })
    mockSessionRow('parent', { projectId: 'p1', settings: { knowledgeBases: null } })
    projects.set('p1', { settings: { knowledgeBases: {} } })

    // 缺省全量：两个用户库 + 项目库（顺序即缺省的拼接顺序）
    expect(await baseNames()).toEqual(['alpha', 'notes', 'project'])
  })

  it('SB-13 sanitize 每一级都生效：去首尾空白、去空、去重保序', async () => {
    seedBases('alpha', 'notes')
    mockPick({
      projectId: null,
      settings: { knowledgeBases: ['  notes ', 'notes', '', '   ', 'alpha'] }
    })

    expect(await baseNames()).toEqual(['notes', 'alpha'])
  })

  it('SB-14 explicit 走完整条回落链：项目设过、以及父会话设过，都算「有人明确设过」', async () => {
    seedBases('alpha', 'notes')
    vi.mocked(projectDao.findById).mockReturnValue(PROJECT)

    // (a) 项目设过、会话自己没设 → 界面上勾的就是项目那份，不该显示成「还没选过」
    mockPick({ projectId: 'p1' })
    mockProjectBases('p1', ['alpha'])
    expect(knowledgeBaseOptions('s1')).toMatchObject({ selected: ['alpha'], explicit: true })

    // (b) 父会话设过、会话与项目都没设 —— 漏掉这一级，子会话会显示成「还没选过」
    projects.clear()
    mockPick({ projectId: 'p1', parentId: 'parent' })
    mockSessionRow('parent', { projectId: 'p1', settings: { knowledgeBases: ['notes'] } })
    expect(knowledgeBaseOptions('s1')).toMatchObject({ selected: ['notes'], explicit: true })
  })

  it('SB-15 不属于任何项目的会话 → 候选里没有 `project`', async () => {
    seedBases('alpha', 'notes')
    mockPick({ projectId: null })

    // 缺省里的 project 只跟着**会话自己**的 projectId：候选里放一个解析不出来的名字就是给用户挖坑
    expect(knowledgeBaseOptions('s1')).toEqual({
      options: [
        { name: 'alpha', label: 'alpha' },
        { name: 'notes', label: 'notes' }
      ],
      selected: ['alpha', 'notes'],
      explicit: false
    })
  })

  it('SB-16 活的、不落快照：新建的库立刻可见，改一次选择立刻收窄；全程零写库', async () => {
    const userRoot = seedBases('notes')
    mockPick({ projectId: null })
    expect(await baseNames()).toEqual(['notes'])

    // 与扩展能力勾选的快照语义刻意不同：知识库是每次调用现查的
    mkdirSync(join(userRoot, 'alpha'))
    expect(await baseNames()).toEqual(['alpha', 'notes'])

    mockPick({ projectId: null, settings: { knowledgeBases: ['alpha'] } })
    expect(await baseNames()).toEqual(['alpha'])

    // 解析这条路只读：缺省从不被「补键」落库（补了就再也长不进新建的库）
    expect(sessionDao.updateSettings).not.toHaveBeenCalled()
  })

  it('SB-17 会话行不存在时 knowledgeBaseOptions 不抛', () => {
    seedBases('notes')
    mockPick(undefined)

    expect(knowledgeBaseOptions('s1')).toEqual({
      options: [{ name: 'notes', label: 'notes' }],
      selected: ['notes'],
      explicit: false
    })
  })

  it('SB-18 围栏用的清单与工具解析同源：NFD 目录名 + NFC 选择两边同一份结果；项目库带项目当前的名字', async () => {
    const userRoot = userRootOf(root)
    const nfd = 'café'
    const nfc = 'café'
    mkdirSync(join(userRoot, nfd), { recursive: true })
    expect(readdirSync(userRoot)).toEqual([nfd])
    inProject()
    // 选择里存的是 NFC 写法（用户在界面上输入 / 别的机器上写下的）
    mockPick({ projectId: 'p1', settings: { knowledgeBases: [nfc, 'project'] } })

    // 围栏列的名字是**磁盘上的拼写**：归一只在 enabledTargets 里做一次，两侧不各过滤一遍
    expect(enabledBaseChoices('s1')).toEqual([
      { name: nfd, label: '' },
      { name: 'project', label: 'Acme Corp' }
    ])
    // 同一份结果：围栏列得出来的，工具就解析得到
    expect(await resolveBase('s1', nfc)).toEqual({
      bundle: `knowledge/${nfd}`,
      dir: join(userRoot, nfd),
      label: `knowledge base "${nfd}"`
    })
    expect((await listBases('s1')).map((b) => b.base)).toEqual([nfd, 'project'])
  })
})
