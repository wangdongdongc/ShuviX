/**
 * sessionBundle —— 「这条会话有哪几个知识库」以及工具参数里的 `base` 解析到哪个 bundle。
 *
 * 选择是一条**活的回落链**（不落库、不快照）：会话设过 → 父会话设过 → 项目设过 → **缺省一个都不启用**。
 * 与扩展能力勾选的快照语义刻意不同 —— 知识库是每次调用现查的。
 *
 * 选择是**硬边界**：`bases` 只列启用且此刻真在的库，点名没启用的名字报错并列出启用了哪些。
 * 库名按目录清单精确匹配（NFC 归一、大小写敏感）；保留名有两个 —— `project` 是项目库、`shuvix` 是只读的
 * 内置库（SB-19..27），同名的用户目录都够不着。
 * `sessionBundle` 本身仍然只回答「本会话所属项目的库是哪一个」，不判断目录建没建过（读宽）。
 *
 * dao 是替身（这里不验 SQL），路径与目录清单用真的。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import type { Project } from '../../../dao/types/project'

const state = vi.hoisted(() => ({ root: '' }))

vi.mock('../../../utils/paths', () => ({
  getShuvixKnowledgeRootDir: () => state.root,
  getUserKnowledgeRootDir: () => `${state.root}-user`,
  // 内置库根替身：不存在的兄弟目录 —— 这些用例里没有内置库
  getBuiltinKnowledgeDir: () => `${state.root}-builtin`
}))
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))
// i18next 是单例：内置库的语言目录与人读名都从它现读。真身在单测里没 init（`t` 回 key 原文 /
// undefined），所以换成替身 —— `language` 决定语言那一层，`t` 回一个认得出的标记串
const i18n = vi.hoisted(() => ({ language: 'en' }))
vi.mock('i18next', () => ({
  default: {
    get language() {
      return i18n.language
    },
    t: (key: string) => `i18n(${key})`
  }
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
import {
  PROJECTS,
  builtinLangAt,
  builtinRootOf,
  bundleAt,
  makeTempRoot,
  seedBuiltinConcept,
  seedConcept,
  treeOf,
  userRootOf
} from './fixture'

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

/**
 * 会话属于项目 p1。`bases` 是这条会话自己的选择 —— 缺省是**空的**，所以要用到某个库的用例必须
 * 显式勾上；不传就是「谁都没设过」，那正是「一个库都不启用」。
 */
const inProject = (bases?: string[]): void => {
  mockPick({ projectId: 'p1', ...(bases ? { settings: { knowledgeBases: bases } } : {}) })
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
  // 内置根同样是 root 的兄弟目录：种过内置库的用例（SB-19..27）得自己收
  rmSync(builtinRootOf(root), { recursive: true, force: true })
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
    inProject(['project'])
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
  it('SB-5 谁都没设过 → 一个库都不启用（在不在项目里都一样）；勾上之后按磁盘拼写解析、去首尾空白；只读', async () => {
    const userRoot = userRootOf(root)
    seedConcept(userRoot, 'notes/a.md', ['type: Memory', 'title: A'])
    mkdirSync(join(userRoot, '读书笔记'))
    const notes = {
      bundle: 'knowledge/notes',
      dir: join(userRoot, 'notes'),
      label: 'knowledge base "notes"'
    }

    // 缺省是空的：磁盘上有两个库、会话还在项目里，照样一个都不启用 —— 范围得用户自己圈
    inProject()
    expect(await listBases('s1')).toEqual([])
    expect(await resolveBase('s1', 'notes')).toEqual({ error: NO_BASES })
    mockPick({ projectId: null })
    expect(await listBases('s1')).toEqual([])

    // 勾上之后：顺序就是选择写的那一份，项目库与用户库之间没有内建先后
    inProject(['notes', '读书笔记', 'project'])
    expect(await resolveBase('s1', 'notes')).toEqual(notes)
    expect(await resolveBase('s1', '  读书笔记 ')).toEqual({
      bundle: 'knowledge/读书笔记',
      dir: join(userRoot, '读书笔记'),
      label: 'knowledge base "读书笔记"'
    })
    expect((await listBases('s1')).map((b) => b.base)).toEqual(['notes', '读书笔记', 'project'])

    // 不在项目里：勾了也解析不出 project，用户库照旧
    mockPick({ projectId: null, settings: { knowledgeBases: ['notes', '读书笔记', 'project'] } })
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
    // 缺省是空的，「列出启用了哪些」得先勾上两个 —— 下面那段错误文案钉的正是这份清单
    mockPick({ projectId: null, settings: { knowledgeBases: ['alpha', 'notes'] } })
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
    // 选择里存的是 NFC 写法（界面上敲的 / 别的机器上写下的），磁盘上是 NFD
    mockPick({ projectId: null, settings: { knowledgeBases: [nfc] } })

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

    // 不在项目里：勾了 project 也解析不出来（这条会话没有项目库），同名的用户目录更够不着
    mockPick({ projectId: null, settings: { knowledgeBases: ['project'] } })
    expect(await resolveBase('s1', ' project ')).toEqual({ error: NO_BASES })
    expect(await listBases('s1')).toEqual([])

    inProject(['project'])
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

    // 会话没设过、项目也没设过 → 候选照列，但一个都没勾（缺省是空的），explicit 为假
    inProject()
    expect(knowledgeBaseOptions('s1')).toEqual({
      options: [
        { name: 'alpha', label: 'alpha' },
        { name: 'notes', label: 'notes' },
        { name: 'project', label: 'Acme Corp' }
      ],
      selected: [],
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

  it('SB-12 非数组不算设过，逐级下落', async () => {
    seedBases('alpha', 'notes')
    vi.mocked(projectDao.findById).mockReturnValue(PROJECT)
    // 会话与父会话都是坏值：手改过的 settings / 旧行 / 半截写入都可能长这样
    mockPick({ projectId: 'p1', parentId: 'parent', settings: { knowledgeBases: 'notes' } })
    mockSessionRow('parent', { projectId: 'p1', settings: { knowledgeBases: null } })

    // 落到项目那一份 —— 拿一个非空清单收尾才看得出「上面两级确实被跳过了」，
    // 缺省是空的之后，直接断 [] 分不清「跳过了」与「没跳过但都是空」
    mockProjectBases('p1', ['alpha'])
    expect(await baseNames()).toEqual(['alpha'])

    // 三级都是坏值 → 落到缺省，也就是一个都不启用
    projects.set('p1', { settings: { knowledgeBases: {} } })
    expect(await baseNames()).toEqual([])
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

    // 候选里的 project 只跟着**会话自己**的 projectId：放一个解析不出来的名字就是给用户挖坑
    expect(knowledgeBaseOptions('s1')).toEqual({
      options: [
        { name: 'alpha', label: 'alpha' },
        { name: 'notes', label: 'notes' }
      ],
      selected: [],
      explicit: false
    })
  })

  it('SB-16 活的、不落快照：选择里点名的库一建出来就可见，改一次选择立刻收窄；全程零写库', async () => {
    const userRoot = seedBases('notes')
    // 选择可以点名还不存在的库（别的机器上写下的、待建的）—— 此刻只解析得出 notes
    mockPick({ projectId: null, settings: { knowledgeBases: ['notes', 'alpha'] } })
    expect(await baseNames()).toEqual(['notes'])

    // 与扩展能力勾选的快照语义刻意不同：知识库是每次调用现查的
    mkdirSync(join(userRoot, 'alpha'))
    expect(await baseNames()).toEqual(['notes', 'alpha'])

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
      selected: [],
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

/**
 * 随应用发布的内置库（SB-19..27）。第三个 bundle 名字空间 `builtin/<库名>`，磁盘形状
 * `<内置根>/<库名>/<语言>/…` —— 语言那一层由界面语言现算，不进 bundle id。
 *
 * 三条主线：
 *   - 它是**第二个保留名**：与 `project` 同一条规则（保留名优先于同名用户目录），但大小写敏感。
 *   - 它**垫底**：配置卡候选里排在用户库与项目库之后 —— 说明书不是用户的内容。缺省里它同样没有
 *     （缺省一个都不启用），所以它是「勾得上的一项」，不是「自带的一项」。
 *   - 它**只读**，而且**缺席是正常态**：开发期没拷资源、打包漏了，都只该让它自己消失，不能带累别的库。
 */
describe('SB-19..27 内置库（只读、保留名、垫底）', () => {
  /** builtinTarget 的回包（`bundleDir` 现算到语言那一层） */
  const BUILTIN_LABEL = 'ShuviX reference (read-only)'
  /** listBases 只给它这一行加的只读提示 */
  const BUILTIN_NOTE = 'read-only: search and read it, never create or edit here'
  /** 配置卡的人读名：走 i18n 单例（替身把 key 原样包成标记串） */
  const BUILTIN_DISPLAY_NAME = 'i18n(knowledge.builtinBaseName)'

  /** 建若干用户库目录，返回用户根 */
  const seedBases = (...names: string[]): string => {
    const userRoot = userRootOf(root)
    for (const name of names) mkdirSync(join(userRoot, name), { recursive: true })
    return userRoot
  }
  /** 内置库的语言目录（bundle 目录就是这一层） */
  const builtinDir = (lang = 'en'): string => builtinLangAt(root, 'shuvix', lang)
  /** 种出内置库：builtinTarget 只判语言目录在不在，空目录就够 */
  const seedBuiltinBase = (lang = 'en'): string => {
    mkdirSync(builtinDir(lang), { recursive: true })
    return builtinDir(lang)
  }
  const builtinTarget = (lang = 'en'): Record<string, unknown> => ({
    bundle: 'builtin/shuvix',
    dir: builtinDir(lang),
    label: BUILTIN_LABEL,
    readonly: true
  })
  const baseNames = async (): Promise<string[]> => (await listBases('s1')).map((b) => b.base)

  it('SB-19 内置库不进缺省：谁都没设过时它和别的库一样不启用；勾上之后照解析', async () => {
    seedBases('alpha', 'notes')
    seedBuiltinBase()

    // 说明书随应用发布、就在那儿，但「在」不等于「启用」—— 缺省一个都不启用，它不例外
    inProject()
    expect(knowledgeBaseOptions('s1').selected).toEqual([])
    expect(await baseNames()).toEqual([])
    mockPick({ projectId: null })
    expect(await baseNames()).toEqual([])

    // 勾上就有：顺序按选择写的那一份，不再有「垫底」这条内建规则
    inProject(['shuvix', 'alpha'])
    expect(await baseNames()).toEqual(['shuvix', 'alpha'])
  })

  it('SB-20 `shuvix` 是第二个保留名：目录恰好叫 shuvix 的用户库进不了候选，点名 shuvix 解析到内置库', async () => {
    const userRoot = seedBases('notes')
    // 同名的用户库：真有内容，但保留名优先 —— 这是与 `project` 一样的一条已知代价
    seedConcept(userRoot, 'shuvix/a.md', ['type: Memory', 'title: A'])
    seedBuiltinBase()
    mockPick({ projectId: null, settings: { knowledgeBases: ['notes', 'shuvix'] } })

    // 候选里那一行 shuvix 是内置库（人读名是产品名），不是用户那个目录（那样 label 会是目录名）
    expect(knowledgeBaseOptions('s1').options).toEqual([
      { name: 'notes', label: 'notes' },
      { name: 'shuvix', label: BUILTIN_DISPLAY_NAME }
    ])
    expect(await resolveBase('s1', 'shuvix')).toEqual(builtinTarget())
    // 用户那一份原样躺着 —— 够不着工具不等于被动过
    expect(readdirSync(join(userRoot, 'shuvix'))).toEqual(['a.md'])
  })

  it('SB-21 resolveBase(`shuvix`) 回只读的内置 bundle（去首尾空白同结果）；保留名大小写敏感，`Shuvix` 不命中', async () => {
    seedBases('notes')
    seedBuiltinBase()
    mockPick({ projectId: null, settings: { knowledgeBases: ['notes', 'shuvix'] } })

    expect(await resolveBase('s1', 'shuvix')).toEqual(builtinTarget())
    expect(await resolveBase('s1', '  shuvix  ')).toEqual(builtinTarget())
    // 保留名与库名一样按 NFC 精确匹配（只归一、不折大小写）：差一个大小写就按「没启用」报错
    expect(await resolveBase('s1', 'Shuvix')).toEqual({
      error: `"Shuvix" is not one of this session's knowledge bases. Enabled: "notes", "shuvix".`
    })
  })

  it('SB-22 内置库不在（开发期没拷 / 打包漏了）：候选里没有它、点名报错、别的库照常工作，全程不建任何目录', async () => {
    const userRoot = seedBases('notes')
    inProject(['notes', 'project'])

    // (a) 内置根整个不存在
    expect(knowledgeBaseOptions('s1')).toEqual({
      options: [
        { name: 'notes', label: 'notes' },
        { name: 'project', label: 'Acme Corp' }
      ],
      selected: ['notes', 'project'],
      explicit: true
    })
    expect(await baseNames()).toEqual(['notes', 'project'])
    expect(await resolveBase('s1', 'shuvix')).toEqual({
      error: `"shuvix" is not one of this session's knowledge bases. Enabled: "notes", "project".`
    })
    // 缺席是增益的缺席：别的库该怎么用还怎么用
    expect(await resolveBase('s1', 'notes')).toEqual({
      bundle: 'knowledge/notes',
      dir: join(userRoot, 'notes'),
      label: 'knowledge base "notes"'
    })
    // 探到不存在的根不该把它捎带建出来（建出来就永远是一个空的只读库）
    expect(existsSync(builtinRootOf(root))).toBe(false)

    // (b) 库目录在、但没有生效语言那一版（只发了别的语言、又没 en 兜底）：同样当没有这个库
    mkdirSync(join(builtinRootOf(root), 'shuvix'), { recursive: true })
    expect(knowledgeBaseOptions('s1').options.map((o) => o.name)).toEqual(['notes', 'project'])
    expect(await baseNames()).toEqual(['notes', 'project'])
    expect(await resolveBase('s1', 'shuvix')).toEqual({
      error: `"shuvix" is not one of this session's knowledge bases. Enabled: "notes", "project".`
    })
    expect(treeOf(builtinRootOf(root))).toEqual(['shuvix/'])
  })

  it('SB-23 内置库可以取消勾选：选择里不写 shuvix 就没有它，只写 shuvix 就只剩它', async () => {
    seedBases('notes')
    seedBuiltinBase()

    // 它只是候选里多出来的一项，勾不勾全看用户 —— 不是强制项
    mockPick({ projectId: null, settings: { knowledgeBases: ['notes'] } })
    expect(await baseNames()).toEqual(['notes'])
    expect(await resolveBase('s1', 'shuvix')).toEqual({
      error: `"shuvix" is not one of this session's knowledge bases. Enabled: "notes".`
    })

    mockPick({ projectId: null, settings: { knowledgeBases: ['shuvix'] } })
    expect(await baseNames()).toEqual(['shuvix'])
    expect(await resolveBase('s1', 'shuvix')).toEqual(builtinTarget())
  })

  it('SB-24 listBases 只给内置那一行 note（只读提示）与绝对目录，用户库 / 项目库那两行不带 note', async () => {
    const userRoot = seedBases('notes')
    seedBuiltinConcept(root, 'shuvix/en/agent-md.md', ['type: Guide', 'title: Agent md'])
    inProject(['notes', 'project', 'shuvix'])

    // toStrictEqual：多一个键少一个键都算错 —— 「只有内置那一行有 note」正是这条要钉的
    const bases = await listBases('s1')
    expect(bases).toStrictEqual([
      { base: 'notes', label: 'knowledge base "notes"', dir: join(userRoot, 'notes') },
      { base: 'project', label: 'project "Acme Corp"', dir: bundleAt(root, 'projects/p1') },
      {
        base: 'shuvix',
        label: BUILTIN_LABEL,
        dir: builtinDir(),
        note: BUILTIN_NOTE
      }
    ])
    // dir 是绝对路径（工具拿它直接读盘），而且指到语言那一层，不是库目录
    // （`dir` 在契约里是可选的，所以「有值」与「是绝对路径」一起断）
    expect(bases.every((b) => !!b.dir && isAbsolute(b.dir))).toBe(true)
  })

  it('SB-25 配置卡里的内置项：name 恒为 shuvix、label 走 i18n 的 knowledge.builtinBaseName；不传会话的项目对话框口径同样有它、同样垫底', () => {
    seedBases('notes')
    seedBuiltinBase()
    const builtinOption = { name: 'shuvix', label: BUILTIN_DISPLAY_NAME }

    // 项目配置对话框（不传 sessionId）配的是「这个项目的新会话用哪些」—— 内置库也该能勾
    expect(knowledgeBaseOptions()).toEqual({
      options: [{ name: 'notes', label: 'notes' }, { name: 'project', label: '' }, builtinOption],
      selected: [],
      explicit: false
    })

    // 会话配置卡：同一项、同样垫底；人读名与语言一起变，不是磁盘上的目录名
    inProject()
    expect(knowledgeBaseOptions('s1').options).toEqual([
      { name: 'notes', label: 'notes' },
      { name: 'project', label: 'Acme Corp' },
      builtinOption
    ])
  })

  it('SB-26 围栏给模型的内置库 label 是那句英文说明，与配置卡的人读名刻意不是一回事', () => {
    seedBases('notes')
    seedBuiltinBase()
    mockPick({ projectId: null, settings: { knowledgeBases: ['notes', 'shuvix'] } })

    // 围栏是提示词：要说清里面是什么、以及只读（免得模型把笔记往这里记）
    const choices = enabledBaseChoices('s1')
    expect(choices).toEqual([
      { name: 'notes', label: '' },
      { name: 'shuvix', label: expect.stringContaining('read-only') }
    ])

    // 两张面：模型读的是说明，用户读的是产品名 —— 哪天有人把它们并成一个键，这条会红
    const guide = choices.find((c) => c.name === 'shuvix')?.label
    const shown = knowledgeBaseOptions('s1').options.find((o) => o.name === 'shuvix')?.label
    expect(shown).toBe(BUILTIN_DISPLAY_NAME)
    expect(guide).not.toBe(shown)
  })

  it('SB-27 围栏里那句说明不带路径也不带计数：不含 `/` 与任何数字', () => {
    seedBuiltinBase()
    mockPick({ projectId: null, settings: { knowledgeBases: ['shuvix'] } })

    // `<knowledge_bases>` 围栏承诺「无路径无计数」，e2e 正是拿这两类字符判的 —— 那句话一旦加上版本号
    // 或路径，本地全绿、CI 才炸。BUILTIN_GUIDE_LABEL 没有导出，所以隔着 enabledBaseChoices 这层公开面钉
    const label = enabledBaseChoices('s1').find((c) => c.name === 'shuvix')?.label ?? ''
    expect(label).not.toBe('')
    expect(label).not.toMatch(/[/\d]/)
  })
})
