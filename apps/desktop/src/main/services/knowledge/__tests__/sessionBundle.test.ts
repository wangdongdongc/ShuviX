/**
 * sessionBundle —— 「这条会话有哪几个知识库」以及工具参数里的 `base` 解析到哪个 bundle。
 *
 * **项目库是隐式的**（2026-10-10，接替退役的项目记忆）：会话属于（真实的）项目，`project` 就恒启用、
 * 排在最前，不管各级选择写了什么（`[]` 也一样）；它不是配置卡的候选项，存量选择里残留的 `project` 读时
 * 剔掉。隐藏载体项目（`__agents__` …）不算项目（SB-P1..P10）。
 *
 * 其余的库由用户圈定，是一条**活的回落链**（不落库、不快照）：会话设过 → 父会话设过 → 项目设过 →
 * **缺省一个都不启用**。与扩展能力勾选的快照语义刻意不同 —— 知识库是每次调用现查的。
 *
 * 选择是**硬边界**：`bases` 只列启用且此刻真在的库，点名没启用的名字报错并列出启用了哪些。
 * 库名按目录清单精确匹配（NFC 归一、大小写敏感）；保留名有两个 —— `project` 是项目库、`shuvix` 是只读的
 * 内置库（SB-19..27），同名的用户目录都够不着。
 * `sessionBundle` 本身仍然只回答「本会话所属项目的库是哪一个」，不判断目录建没建过（读宽）。
 *
 * **内置说明书对 ShuviX 文件的笔记本也是隐式的**（2026-10-30，SB-M1..M8）：会话挂在安全策略 / hook / 智能体 /
 * bot / 技能 / 知识库的承载项目下（chat-protocol `shuvixFileKindOfProject`），`shuvix` 就恒启用、排在用户圈定的
 * 库之前，不归选择管（`[]` 也一样），配置卡里也不再列它；日报 / 跟踪项与普通会话照旧。
 *
 * dao 是替身（这里不验 SQL），路径与目录清单用真的。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import { renderKnowledgeGuide } from '@shuvix/agent-runtime'
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
import { skillExternalProjectId } from '@shuvix/chat-protocol/skillNotes'
import {
  builtinManualDir,
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

  it('SB-3 resolveBase 的 `project`（去首尾空白）与 sessionBundle 是同一个结果；不必勾选（隐式启用）', async () => {
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
  it('SB-5 谁都没设过 → 用户库一个都不启用（项目会话只有隐式的项目库）；勾上之后按磁盘拼写解析、去首尾空白；只读', async () => {
    const userRoot = userRootOf(root)
    seedConcept(userRoot, 'notes/a.md', ['type: Memory', 'title: A'])
    mkdirSync(join(userRoot, '读书笔记'))
    const notes = {
      bundle: 'knowledge/notes',
      dir: join(userRoot, 'notes'),
      label: 'knowledge base "notes"'
    }

    // 缺省是空的：磁盘上有两个库，照样一个用户库都不启用 —— 范围得用户自己圈；项目会话只有隐式的项目库
    inProject()
    expect((await listBases('s1')).map((b) => b.base)).toEqual(['project'])
    expect(await resolveBase('s1', 'notes')).toEqual({
      error: `"notes" is not one of this session's knowledge bases. Enabled: "project".`
    })
    mockPick({ projectId: null })
    expect(await listBases('s1')).toEqual([])
    expect(await resolveBase('s1', 'notes')).toEqual({ error: NO_BASES })

    // 勾上之后：项目库恒在最前，用户库按选择写的那一份；选择里残留的 project 不改变它的位置
    inProject(['notes', '读书笔记', 'project'])
    expect(await resolveBase('s1', 'notes')).toEqual(notes)
    expect(await resolveBase('s1', '  读书笔记 ')).toEqual({
      bundle: 'knowledge/读书笔记',
      dir: join(userRoot, '读书笔记'),
      label: 'knowledge base "读书笔记"'
    })
    expect((await listBases('s1')).map((b) => b.base)).toEqual(['project', 'notes', '读书笔记'])

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

    // 不在项目里：勾了 project 也解析不出来（这条会话没有项目库），直说原因；同名的用户目录更够不着
    mockPick({ projectId: null, settings: { knowledgeBases: ['project'] } })
    expect(await resolveBase('s1', ' project ')).toEqual({ error: NO_PROJECT })
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

  it('SB-8 listBases：项目库打头，其余是启用且此刻真的在的库、按选择的顺序；选了但已经不在的悄悄跳过；列举本身不建任何东西', async () => {
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
      { base: 'project', label: 'project "Acme Corp"', dir: bundleAt(root, 'projects/p1') },
      { base: 'notes', label: 'knowledge base "notes"', dir: join(userRoot, 'notes') },
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
    expect((await listBases('s1')).map((b) => b.base)).toEqual(['project', 'alpha'])

    // 父会话设过：压过项目那份（子会话抄上一级）
    mockPick({ projectId: 'p1', parentId: 'parent' })
    mockSessionRow('parent', { projectId: 'p1', settings: { knowledgeBases: ['notes'] } })
    expect((await listBases('s1')).map((b) => b.base)).toEqual(['project', 'notes'])

    // 会话自己设过：压过父会话与项目
    mockPick({
      projectId: 'p1',
      parentId: 'parent',
      settings: { knowledgeBases: ['alpha', 'project'] }
    })
    mockSessionRow('parent', { projectId: 'p1', settings: { knowledgeBases: ['notes'] } })
    expect((await listBases('s1')).map((b) => b.base)).toEqual(['project', 'alpha'])
  })

  it('SB-10 knowledgeBaseOptions：候选只有用户库（项目库隐式启用，从不是候选项）；explicit 说明是不是有人明确设过', async () => {
    const userRoot = userRootOf(root)
    for (const name of ['alpha', 'notes']) mkdirSync(join(userRoot, name), { recursive: true })

    // 没给会话（项目配置对话框）：候选只有用户库、不给选择
    expect(knowledgeBaseOptions()).toEqual({
      options: [
        { name: 'alpha', label: 'alpha' },
        { name: 'notes', label: 'notes' }
      ],
      selected: [],
      explicit: false
    })

    // 会话没设过、项目也没设过 → 候选照列，但一个都没勾（缺省是空的），explicit 为假；
    // 会话在项目里也不多出 project 这一项
    inProject()
    expect(knowledgeBaseOptions('s1')).toEqual({
      options: [
        { name: 'alpha', label: 'alpha' },
        { name: 'notes', label: 'notes' }
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

  it('SB-11 「设过」只看是不是数组：项目设成 [] → 这个项目的会话一个用户库都不启用（只剩隐式的项目库），不往缺省落', async () => {
    seedBases('alpha', 'notes')
    inProject()
    // 空数组是一个明确的选择（「这个项目的会话不用我的知识库」），不是「没意见」；项目库不归选择管
    mockProjectBases('p1', [])

    expect(await baseNames()).toEqual(['project'])
    expect(await resolveBase('s1', 'notes')).toEqual({
      error: `"notes" is not one of this session's knowledge bases. Enabled: "project".`
    })
    expect(await resolveBase('s1', 'project')).toEqual(sessionBundle('s1'))
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
    expect(await baseNames()).toEqual(['project', 'alpha'])

    // 三级都是坏值 → 落到缺省，也就是一个用户库都不启用（项目库照旧在）
    projects.set('p1', { settings: { knowledgeBases: {} } })
    expect(await baseNames()).toEqual(['project'])
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

    // project 从来不是候选项（有项目时它隐式启用，没项目时它解析不出来）—— 这里也一样没有
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

    // 围栏列的名字是**磁盘上的拼写**：归一只在 enabledTargets 里做一次，两侧不各过滤一遍；项目库打头。
    // 每行带库目录（条目由 agent 直接 write 进去再 submit）
    expect(enabledBaseChoices('s1')).toEqual([
      { name: 'project', label: 'Acme Corp', dir: bundleAt(root, 'projects/p1') },
      { name: nfd, label: '', dir: join(userRoot, nfd) }
    ])
    // 同一份结果：围栏列得出来的，工具就解析得到
    expect(await resolveBase('s1', nfc)).toEqual({
      bundle: `knowledge/${nfd}`,
      dir: join(userRoot, nfd),
      label: `knowledge base "${nfd}"`
    })
    expect((await listBases('s1')).map((b) => b.base)).toEqual(['project', nfd])
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
  const BUILTIN_NOTE = 'read-only: search and read it, never write or submit here'
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
    expect(await baseNames()).toEqual(['project'])
    mockPick({ projectId: null })
    expect(await baseNames()).toEqual([])

    // 勾上就有：项目库之后按选择写的那一份，不再有「垫底」这条内建规则
    inProject(['shuvix', 'alpha'])
    expect(await baseNames()).toEqual(['project', 'shuvix', 'alpha'])
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
    // 存量选择里残留的 project：读时剔掉，但「有人明确设过」照样成立
    inProject(['notes', 'project'])

    // (a) 内置根整个不存在
    expect(knowledgeBaseOptions('s1')).toEqual({
      options: [{ name: 'notes', label: 'notes' }],
      selected: ['notes'],
      explicit: true
    })
    expect(await baseNames()).toEqual(['project', 'notes'])
    expect(await resolveBase('s1', 'shuvix')).toEqual({
      error: `"shuvix" is not one of this session's knowledge bases. Enabled: "project", "notes".`
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
    expect(knowledgeBaseOptions('s1').options.map((o) => o.name)).toEqual(['notes'])
    expect(await baseNames()).toEqual(['project', 'notes'])
    expect(await resolveBase('s1', 'shuvix')).toEqual({
      error: `"shuvix" is not one of this session's knowledge bases. Enabled: "project", "notes".`
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

  it('SB-24 listBases 只给内置那一行 note（只读提示）与绝对目录，项目库 / 用户库那两行不带 note', async () => {
    const userRoot = seedBases('notes')
    seedBuiltinConcept(root, 'shuvix/en/agent-md.md', ['type: Guide', 'title: Agent md'])
    inProject(['notes', 'shuvix'])

    // toStrictEqual：多一个键少一个键都算错 —— 「只有内置那一行有 note」正是这条要钉的
    const bases = await listBases('s1')
    expect(bases).toStrictEqual([
      { base: 'project', label: 'project "Acme Corp"', dir: bundleAt(root, 'projects/p1') },
      { base: 'notes', label: 'knowledge base "notes"', dir: join(userRoot, 'notes') },
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

  it('SB-25 配置卡里的内置项：name 恒为 shuvix、label 走 i18n 的 knowledge.builtinBaseName；不传会话的项目对话框口径同样有它、同样垫底（两边都没有 project）', () => {
    seedBases('notes')
    seedBuiltinBase()
    const builtinOption = { name: 'shuvix', label: BUILTIN_DISPLAY_NAME }

    // 项目配置对话框（不传 sessionId）配的是「这个项目的新会话用哪些」—— 内置库也该能勾
    expect(knowledgeBaseOptions()).toEqual({
      options: [{ name: 'notes', label: 'notes' }, builtinOption],
      selected: [],
      explicit: false
    })

    // 会话配置卡：同一项、同样垫底；人读名与语言一起变，不是磁盘上的目录名
    inProject()
    expect(knowledgeBaseOptions('s1').options).toEqual([
      { name: 'notes', label: 'notes' },
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
      { name: 'notes', label: '', dir: expect.any(String) },
      { name: 'shuvix', label: expect.stringContaining('read-only'), dir: expect.any(String) }
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

/**
 * 隐式的项目库（SB-P1..P10，2026-10-10 接替退役的项目记忆）。四条主线：
 *   - 会话属于真实项目 → `project` **恒启用、排在最前**，与各级选择无关（`[]` 也一样）。
 *   - 它**不是候选项**：配置卡里没有它，存量选择里残留的 `project` 读时剔掉（`explicit` 照算 ——
 *     毕竟有人设过）。
 *   - 没有项目（或 projectId 悬空、或是隐藏载体项目）→ 没有这个库，点名回 NO_PROJECT 那句。
 *   - 解析只读：不建项目目录，不写库。
 */
describe('SB-P1..P10 隐式的项目库', () => {
  /** 建若干用户库目录，返回用户根 */
  const seedBases = (...names: string[]): string => {
    const userRoot = userRootOf(root)
    for (const name of names) mkdirSync(join(userRoot, name), { recursive: true })
    return userRoot
  }
  const baseNames = async (): Promise<string[]> => (await listBases('s1')).map((b) => b.base)
  const notInBases = (name: string, enabled: string): { error: string } => ({
    error: `"${name}" is not one of this session's knowledge bases. Enabled: ${enabled}.`
  })

  it('SB-P1 项目会话、谁都没勾：listBases / 围栏清单 / 围栏正文都只有项目库；配置卡里没勾也没有它；不建任何目录', async () => {
    seedBases('alpha', 'notes')
    inProject()

    expect(await listBases('s1')).toStrictEqual([
      { base: 'project', label: 'project "Acme Corp"', dir: bundleAt(root, 'projects/p1') }
    ])
    expect(enabledBaseChoices('s1')).toEqual([
      { name: 'project', label: 'Acme Corp', dir: bundleAt(root, 'projects/p1') }
    ])
    // `<knowledge_bases>` 围栏的正文就是拿这份清单渲染的：项目会话开箱就有那一行
    expect(renderKnowledgeGuide(enabledBaseChoices('s1'))).toContain('- project — Acme Corp')
    expect(knowledgeBaseOptions('s1')).toEqual({
      options: [
        { name: 'alpha', label: 'alpha' },
        { name: 'notes', label: 'notes' }
      ],
      selected: [],
      explicit: false
    })
    expect(existsSync(join(root, PROJECTS))).toBe(false)
    expect(sessionDao.updateSettings).not.toHaveBeenCalled()
  })

  it('SB-P2 明确设成 [] —— 会话自己 / 父会话 / 项目 哪一级都一样：用户库一个不要，项目库照旧在', async () => {
    seedBases('alpha', 'notes')
    vi.mocked(projectDao.findById).mockReturnValue(PROJECT)

    // 会话自己
    mockPick({ projectId: 'p1', settings: { knowledgeBases: [] } })
    expect(await baseNames()).toEqual(['project'])

    // 父会话
    mockPick({ projectId: 'p1', parentId: 'parent' })
    mockSessionRow('parent', { projectId: 'p1', settings: { knowledgeBases: [] } })
    expect(await baseNames()).toEqual(['project'])

    // 项目
    mockPick({ projectId: 'p1' })
    mockProjectBases('p1', [])
    expect(await baseNames()).toEqual(['project'])
  })

  it('SB-P3 存量选择里的 `project` 每一级都在读时剔掉（含首尾空白的写法）；explicit 仍为真', () => {
    seedBases('alpha', 'notes')
    vi.mocked(projectDao.findById).mockReturnValue(PROJECT)

    // 会话自己
    mockPick({ projectId: 'p1', settings: { knowledgeBases: [' project ', 'notes', 'project'] } })
    expect(knowledgeBaseOptions('s1')).toMatchObject({ selected: ['notes'], explicit: true })

    // 只剩 project 一项：selected 空了，但「有人设过」不变（裁决：有意如此）
    mockPick({ projectId: 'p1', settings: { knowledgeBases: ['project'] } })
    expect(knowledgeBaseOptions('s1')).toMatchObject({ selected: [], explicit: true })

    // 父会话
    mockPick({ projectId: 'p1', parentId: 'parent' })
    mockSessionRow('parent', {
      projectId: 'p1',
      settings: { knowledgeBases: ['project', 'notes'] }
    })
    expect(knowledgeBaseOptions('s1')).toMatchObject({ selected: ['notes'], explicit: true })

    // 项目
    mockPick({ projectId: 'p1' })
    mockProjectBases('p1', ['project', 'alpha'])
    expect(knowledgeBaseOptions('s1')).toMatchObject({ selected: ['alpha'], explicit: true })

    // 不在项目里的会话同样剔掉（那里它本来就解析不出来）
    mockPick({ projectId: null, settings: { knowledgeBases: ['project', 'notes'] } })
    expect(knowledgeBaseOptions('s1')).toMatchObject({ selected: ['notes'], explicit: true })
  })

  it('SB-P4 项目库只出现一次：选择里写多少遍 project 都不重复', async () => {
    seedBases('notes')
    inProject(['project', 'notes', ' project ', 'project'])

    expect(await baseNames()).toEqual(['project', 'notes'])
    expect(enabledBaseChoices('s1').map((c) => c.name)).toEqual(['project', 'notes'])
  })

  it('SB-P5 目录恰好叫 project 的用户库：被保留名遮住，永远不是候选项；点名 project 解析到项目库', async () => {
    const userRoot = seedBases('notes')
    seedConcept(userRoot, 'project/a.md', ['type: Memory', 'title: A'])

    expect(knowledgeBaseOptions().options.map((o) => o.name)).toEqual(['notes'])
    inProject(['notes'])
    expect(knowledgeBaseOptions('s1').options.map((o) => o.name)).toEqual(['notes'])
    expect(await resolveBase('s1', 'project')).toEqual({
      bundle: 'projects/p1',
      dir: bundleAt(root, 'projects/p1'),
      label: 'project "Acme Corp"'
    })

    // 没项目时也够不着那个目录
    mockPick({ projectId: null, settings: { knowledgeBases: ['project', 'notes'] } })
    expect(await baseNames()).toEqual(['notes'])
    expect(readdirSync(join(userRoot, 'project'))).toEqual(['a.md'])
  })

  it('SB-P6 子会话（同项目）：项目库打头，用户库抄父会话那一份；父会话设成 [] 时只剩项目库', async () => {
    seedBases('alpha', 'notes')
    vi.mocked(projectDao.findById).mockReturnValue(PROJECT)

    mockPick({ projectId: 'p1', parentId: 'parent' })
    mockSessionRow('parent', { projectId: 'p1', settings: { knowledgeBases: ['notes'] } })
    expect(await baseNames()).toEqual(['project', 'notes'])

    mockSessionRow('parent', { projectId: 'p1', settings: { knowledgeBases: [] } })
    expect(await baseNames()).toEqual(['project'])
  })

  it('SB-P7 没有项目就点不中 project：不属于项目 / projectId 悬空 都回 NO_PROJECT；保留名大小写敏感，`Project` 走通用报错', async () => {
    seedBases('notes')

    // 不属于项目：就算勾了用户库，点名 project 也直说「没有项目」而不是「没启用」
    mockPick({ projectId: null, settings: { knowledgeBases: ['notes'] } })
    expect(await resolveBase('s1', 'project')).toEqual({ error: NO_PROJECT })
    // 一个库都没启用时同样如此
    mockPick({ projectId: null })
    expect(await resolveBase('s1', ' project ')).toEqual({ error: NO_PROJECT })

    // projectId 指向已删除的项目
    mockPick({ projectId: 'gone', settings: { knowledgeBases: ['notes'] } })
    vi.mocked(projectDao.findById).mockReturnValue(undefined)
    expect(await baseNames()).toEqual(['notes'])
    expect(await resolveBase('s1', 'project')).toEqual({ error: NO_PROJECT })

    // 大小写敏感：`Project` 不是保留名
    inProject()
    expect(await resolveBase('s1', 'Project')).toEqual(notInBases('Project', '"project"'))
    expect(existsSync(join(root, PROJECTS))).toBe(false)
  })

  it('SB-P8 项目改名即时生效：listBases 的标签与围栏里的项目名都跟着项目当前的名字', async () => {
    inProject()
    expect(enabledBaseChoices('s1')).toMatchObject([{ name: 'project', label: 'Acme Corp' }])

    vi.mocked(projectDao.findById).mockReturnValue({ ...PROJECT, name: 'Acme Labs' })
    expect(enabledBaseChoices('s1')).toMatchObject([{ name: 'project', label: 'Acme Labs' }])
    expect((await listBases('s1'))[0]).toMatchObject({
      base: 'project',
      label: 'project "Acme Labs"'
    })
  })

  it('SB-P9 项目会话点名不认识的库：报错里列出的启用清单是项目库（不是「一个都没启用」）', async () => {
    seedBases('notes')
    inProject()

    expect(await resolveBase('s1', 'nope')).toEqual(notInBases('nope', '"project"'))
    expect(await resolveBase('s1', 'notes')).toEqual(notInBases('notes', '"project"'))
  })

  it('SB-P10 隐藏载体项目不算项目：没有隐式的项目库，点名 project 回 NO_PROJECT（这里没种内置说明书 —— 载体隐式带的说明书见 SB-M）', async () => {
    // 这几个载体都是 ShuviX 文件的笔记本，会隐式启用内置说明书 `shuvix`；这条只钉「没有项目库」，所以不种内置库，
    // 启用清单因此是空的（种了内置库的情形见 SB-M1）
    seedBases('notes')
    for (const hidden of ['__agents__', '__knowledge__', '__bots__']) {
      // 载体项目行在库里是真有的 —— 判据是「隐藏」，不是「找不到」
      vi.mocked(projectDao.findById).mockReturnValue({ ...PROJECT, id: hidden, name: hidden })

      mockPick({ projectId: hidden })
      expect(await listBases('s1'), hidden).toEqual([])
      expect(enabledBaseChoices('s1'), hidden).toEqual([])
      expect(await resolveBase('s1', 'project'), hidden).toEqual({ error: NO_PROJECT })
      expect(sessionBundle('s1'), hidden).toEqual({ error: NO_PROJECT })

      // 用户勾的库照常
      mockPick({ projectId: hidden, settings: { knowledgeBases: ['notes'] } })
      expect(await baseNames(), hidden).toEqual(['notes'])
    }
    expect(existsSync(join(root, PROJECTS))).toBe(false)
  })
})

/**
 * ShuviX 文件笔记本隐式启用内置说明书（SB-M1..M8，2026-10-30）。四条主线：
 *   - 会话挂在 ShuviX 文件的承载项目下（策略 / agent / bot / hook / 技能 / 知识库，含内置的只读载体）→ `shuvix`
 *     恒启用、排在用户圈定的库之前，与各级选择无关（`[]` 也一样）；选择里也写了 `shuvix` 不重复。
 *   - 内置库不在（开发期没拷资源）→ 隐式的那份也没有，别的库照常，不建任何目录。
 *   - 载体之外（普通项目、无项目、日报、跟踪项）照旧：不勾就没有。
 *   - 配置卡在载体会话里不列 `shuvix`（恒启用，列成没勾的选项只会误导）；`selected` 仍是原样的选择。
 */
describe('SB-M ShuviX 文件笔记本隐式启用内置说明书', () => {
  const BUILTIN_LABEL = 'ShuviX reference (read-only)'
  const BUILTIN_NOTE = 'read-only: search and read it, never write or submit here'
  const BUILTIN_DISPLAY_NAME = 'i18n(knowledge.builtinBaseName)'
  /** 几种 ShuviX 文件的载体（注册表、内置注册表、技能外部目录、知识库用户库） */
  const CARRIERS = [
    '__policies__',
    '__agents_builtin__',
    '__bots__',
    skillExternalProjectId('ext'),
    '__knowledge_user__'
  ]

  const seedBases = (...names: string[]): string => {
    const userRoot = userRootOf(root)
    for (const name of names) mkdirSync(join(userRoot, name), { recursive: true })
    return userRoot
  }
  const builtinDir = (lang = 'en'): string => builtinLangAt(root, 'shuvix', lang)
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
  /** 内置库在围栏里那句说明（没导出）：隔着公开面取 —— 普通会话勾上 shuvix 时它拿到的那一句 */
  const guideLabel = (): string => {
    mockPick({ projectId: null, settings: { knowledgeBases: ['shuvix'] } })
    const label = enabledBaseChoices('s1').find((c) => c.name === 'shuvix')?.label ?? ''
    sessions.clear()
    return label
  }

  it.each(CARRIERS)(
    'SB-M1 载体 %s、谁都没勾：bases 只有说明书（带只读提示）、围栏里有它、点名 shuvix 解析到只读的内置库',
    async (carrier) => {
      seedBases('notes')
      seedBuiltinBase()
      const label = guideLabel()
      expect(label, '语料自检：围栏那句说明非空').toContain('read-only')
      mockPick({ projectId: carrier })

      expect(await listBases('s1')).toStrictEqual([
        { base: 'shuvix', label: BUILTIN_LABEL, dir: builtinDir(), note: BUILTIN_NOTE }
      ])
      expect(enabledBaseChoices('s1')).toEqual([{ name: 'shuvix', dir: builtinDir(), label }])
      expect(await resolveBase('s1', 'shuvix')).toEqual(builtinTarget())
      const guide = renderKnowledgeGuide(enabledBaseChoices('s1'))
      expect(guide).not.toBeNull()
      expect(guide).toContain('shuvix')
      // 隐式启用只是解析：不写会话设置
      expect(sessionDao.updateSettings).not.toHaveBeenCalled()
    }
  )

  it('SB-M2 载体里同时勾了用户库：说明书打头、用户库按选择的顺序；选择里也写了 shuvix 不重复', async () => {
    seedBases('notes')
    seedBuiltinBase()
    for (const bases of [['notes'], ['notes', 'shuvix'], ['shuvix', 'shuvix', 'notes']]) {
      const what = JSON.stringify(bases)
      mockPick({ projectId: '__policies__', settings: { knowledgeBases: bases } })
      expect(await baseNames(), what).toEqual(['shuvix', 'notes'])
      expect(
        enabledBaseChoices('s1').map((c) => c.name),
        what
      ).toEqual(['shuvix', 'notes'])
    }
  })

  it('SB-M3 明确设成 [] —— 会话自己 / 父会话 / 项目 哪一级都一样：说明书照旧在', async () => {
    seedBases('notes')
    seedBuiltinBase()

    // 会话自己
    mockPick({ projectId: '__hooks__', settings: { knowledgeBases: [] } })
    expect(await baseNames()).toEqual(['shuvix'])

    // 父会话
    mockPick({ projectId: '__hooks__', parentId: 'parent' })
    mockSessionRow('parent', { projectId: '__hooks__', settings: { knowledgeBases: [] } })
    expect(await baseNames()).toEqual(['shuvix'])

    // 项目（载体项目行的 settings）
    mockPick({ projectId: '__hooks__' })
    mockProjectBases('__hooks__', [])
    expect(await baseNames()).toEqual(['shuvix'])
  })

  it('SB-M4 内置库不在：载体会话没有隐式的那份；点名 shuvix 按「一个都没启用」/「不在启用清单里」报错；全程不建目录', async () => {
    seedBases('notes')

    mockPick({ projectId: '__policies__' })
    expect(await listBases('s1')).toEqual([])
    expect(enabledBaseChoices('s1')).toEqual([])
    expect(await resolveBase('s1', 'shuvix')).toEqual({ error: NO_BASES })

    mockPick({ projectId: '__policies__', settings: { knowledgeBases: ['notes'] } })
    expect(await baseNames()).toEqual(['notes'])
    expect(await resolveBase('s1', 'shuvix')).toEqual({
      error: `"shuvix" is not one of this session's knowledge bases. Enabled: "notes".`
    })

    // 探到不存在的内置根不该把它捎带建出来；载体也不建项目库
    expect(existsSync(builtinRootOf(root))).toBe(false)
    expect(existsSync(join(root, PROJECTS))).toBe(false)
  })

  it('SB-M5 载体之外没有隐式的说明书：普通项目 / 无项目 / 日报 / 跟踪项；勾上照旧按选择排；载体正控制组', async () => {
    seedBases('alpha', 'notes')
    seedBuiltinBase()

    // 正控制组：同一份磁盘布局，载体会话确实有它 —— 下面的「没有」不是因为内置库没种好
    mockPick({ projectId: '__hooks__' })
    expect(await baseNames()).toEqual(['shuvix'])

    inProject()
    expect(await baseNames()).toEqual(['project'])

    mockPick({ projectId: null })
    expect(await baseNames()).toEqual([])

    // 日报、跟踪项是用户自己的笔记：隐藏载体，但不是 ShuviX 文件
    for (const userNotes of ['__daily__', '__tracking__']) {
      mockPick({ projectId: userNotes })
      expect(await baseNames(), userNotes).toEqual([])
    }

    // 回归：普通项目里勾上的说明书照旧排在选择写的位置
    inProject(['shuvix', 'alpha'])
    expect(await baseNames()).toEqual(['project', 'shuvix', 'alpha'])
  })

  it('SB-M6 界面语言 zh：隐式那份指到 zh 那一版，builtinManualDir() 同一个目录；内置库不在 → null', async () => {
    seedBuiltinBase('en')
    seedBuiltinBase('zh')
    i18n.language = 'zh'
    try {
      mockPick({ projectId: '__agents__' })
      const bases = await listBases('s1')
      expect(bases.map((b) => b.base)).toEqual(['shuvix'])
      expect(bases[0].dir).toBe(builtinDir('zh'))
      expect(builtinManualDir()).toBe(builtinDir('zh'))
      // 同一个函数：提示词里指路用的目录 = 知识库里那个库的目录
      expect(builtinManualDir()).toBe(enabledBaseChoices('s1')[0].dir)

      rmSync(builtinRootOf(root), { recursive: true, force: true })
      expect(builtinManualDir()).toBeNull()
      expect(existsSync(builtinRootOf(root))).toBe(false)
    } finally {
      i18n.language = 'en'
    }
  })

  it('SB-M7 载体会话点名不认识的库：报错列出启用清单里的 shuvix（不是「一个都没启用」）', async () => {
    seedBases('notes')
    seedBuiltinBase()
    mockPick({ projectId: '__bots__' })

    expect(await resolveBase('s1', 'nope')).toEqual({
      error: `"nope" is not one of this session's knowledge bases. Enabled: "shuvix".`
    })
    // 存在但没勾的用户库同样
    expect(await resolveBase('s1', 'notes')).toEqual({
      error: `"notes" is not one of this session's knowledge bases. Enabled: "shuvix".`
    })
  })

  it('SB-M8 knowledgeBaseOptions：载体会话的候选里没有 shuvix（用户库照列）；普通项目会话与项目对话框照旧垫底；selected 是原样的选择', () => {
    seedBases('alpha', 'notes')
    seedBuiltinBase()
    const builtinOption = { name: 'shuvix', label: BUILTIN_DISPLAY_NAME }

    // 载体会话：说明书恒启用，不再是候选项；选择原样交回（改了名、已不在的库照留；写了 shuvix 也留着）
    mockPick({
      projectId: '__policies__',
      settings: { knowledgeBases: ['notes', 'renamed-away', 'shuvix'] }
    })
    expect(knowledgeBaseOptions('s1')).toEqual({
      options: [
        { name: 'alpha', label: 'alpha' },
        { name: 'notes', label: 'notes' }
      ],
      selected: ['notes', 'renamed-away', 'shuvix'],
      explicit: true
    })

    // 普通项目会话：照旧垫底
    inProject()
    expect(knowledgeBaseOptions('s1').options).toEqual([
      { name: 'alpha', label: 'alpha' },
      { name: 'notes', label: 'notes' },
      builtinOption
    ])

    // 项目对话框（不传会话）：照旧垫底
    expect(knowledgeBaseOptions().options).toEqual([
      { name: 'alpha', label: 'alpha' },
      { name: 'notes', label: 'notes' },
      builtinOption
    ])
  })
})
