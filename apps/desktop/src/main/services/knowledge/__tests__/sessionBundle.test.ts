/**
 * sessionBundle —— 「这条会话有哪几个知识库」以及工具参数里的 `base` 解析到哪个 bundle。
 *
 * **项目库是隐式的**（2026-10-10，接替退役的项目记忆）：会话属于（真实的）项目，`project` 就恒启用、
 * 排在最前，不管各级选择写了什么（`[]` 也一样）；它不是配置卡的候选项，存量选择里残留的 `project` 读时
 * 剔掉。隐藏载体项目（`__agents__` …）不算项目（SB-P1..P10）。
 *
 * **内置说明书 `shuvix` 也是隐式的**（2026-11-14 裁决：始终可查，不是选项；SB-D1..D7）：每条会话都有它、排在
 * **最后**（项目库 → 用户勾的库 → 说明书），不管各级选择写了什么（`[]` 也一样）；它不是配置卡的候选项，存量选择
 * 里残留的 `shuvix` 读时剔掉。目录不在（开发期没拷资源）就没有它，别的一切照旧。
 *
 * 其余的库由用户圈定，是一条**活的回落链**（不落库、不快照）：会话设过 → 父会话设过 → 项目设过 →
 * **缺省一个都不启用**。显式的 `[]` 是「这条会话不用我自己的库」。与扩展能力勾选的快照语义刻意不同 —— 知识库是
 * 每次调用现查的。夹具里内置库根默认不存在（见 mock），所以没种内置库的用例里看不到说明书。
 *
 * 选择是**硬边界**：`bases` 只列启用且此刻真在的库，点名没启用的名字报错并列出启用了哪些。
 * 库名按目录清单精确匹配（NFC 归一、大小写敏感）；保留名有两个 —— `project` 是项目库、`shuvix` 是只读的
 * 内置库（SB-19..27），同名的用户目录都够不着。
 * `sessionBundle` 本身仍然只回答「本会话所属项目的库是哪一个」，不判断目录建没建过（读宽）。
 *
 * ShuviX 文件的笔记本（安全策略 / hook / 智能体 / bot / 技能 / 知识库的承载项目，SB-M1..M8）不再是特例：
 * 2026-10-30 起它们先隐式带上说明书、排在选择之前；现在与每条会话一样，说明书排在最后。
 *
 * **bot 会话引用的工作项目**（`settings.workProject`，它不是项目的成员）同样有项目库、同样按那个项目回落（KB-B1）。
 *
 * dao 是替身（这里不验 SQL），路径与目录清单用真的。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
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
vi.mock('../../../dao/projectDao', () => ({
  projectDao: { findById: vi.fn(), pick: vi.fn(), findAllActive: vi.fn(() => []) }
}))
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
  projectBaseNamed,
  resolveBase,
  selectedBaseNames,
  sessionBundle
} from '../sessionBundle'
import { invalidateKnowledgeScan } from '../scan'
import { setBotKnowledgeHost } from '../botBases'
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
 * 会话属于项目 p1。`bases` 是这条会话自己的选择 —— 缺省里没有用户库，所以要用到某个用户库的用例必须
 * 显式勾上；不传就是「谁都没设过」，用户库一个都不启用（说明书是隐式的，种了内置库才看得到）。
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
    expect(sessionDao.pick).toHaveBeenCalledWith('s1', ['projectId', 'settings'])
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

    // 缺省里没有用户库：磁盘上有两个库，照样一个都不启用 —— 范围得用户自己圈；项目会话只有隐式的项目库
    // （隐式的内置说明书这条没种，见 SB-D1）
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
    // 缺省里没有用户库，「列出启用了哪些」得先勾上两个 —— 下面那段错误文案钉的正是这份清单
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

  it('SB-10 knowledgeBaseOptions：候选只有用户库（项目库隐式启用，从不是候选项）；用户库缺省一个都不勾；explicit 说明是不是有人明确设过', async () => {
    const userRoot = userRootOf(root)
    for (const name of ['alpha', 'notes']) mkdirSync(join(userRoot, name), { recursive: true })

    // 没给会话（项目配置对话框）：这里内置库目录不在，候选只有用户库、选择也是空的（SB-D6）
    expect(knowledgeBaseOptions()).toEqual({
      options: [
        { name: 'alpha', label: 'alpha' },
        { name: 'notes', label: 'notes' }
      ],
      selected: [],
      explicit: false
    })

    // 会话没设过、项目也没设过 → 候选照列，一个都没勾（选择是空的），explicit 为假；
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
 *   - 「设过」的判据只有一个 —— **是不是数组**。`[]` 是一个明确的「我的库一个都不要」，不能往下一级落；
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

    // 落到项目那一份 —— 拿一个用户库收尾才看得出「上面两级确实被跳过了」：
    // 这里没种内置库，缺省解析出来是空的，直接断 [] 分不清「跳过了」与「没跳过但都是空」
    mockProjectBases('p1', ['alpha'])
    expect(await baseNames()).toEqual(['project', 'alpha'])

    // 三级都是坏值 → 落到缺省：一个用户库都不启用（项目库照旧在；隐式的内置说明书这里没种，见 SB-D1）
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

    // project 从来不是候选项（有项目时它隐式启用，没项目时它解析不出来）—— 这里也一样没有；没人设过，一个都不勾
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
    // 不带库目录（2026-11-08：库目录只有知识库管理员知道）
    expect(enabledBaseChoices('s1')).toEqual([
      { name: 'project', label: 'Acme Corp' },
      { name: nfd, label: '' }
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
 *   - 它是**隐式的、垫底的**（2026-11-14 裁决：始终可查，不是选项）：每条会话都有它、排在项目库与用户勾的库之后
 *     —— 说明书不是用户的内容；配置卡里不列它、取消不掉，选择里写了它也不重复。
 *   - 它**只读**，而且**缺席是正常态**：开发期没拷资源、打包漏了，都只该让它自己消失，不能带累别的库。
 */
describe('SB-19..27 内置库（只读、保留名、垫底）', () => {
  /** builtinTarget 的回包（`bundleDir` 现算到语言那一层） */
  const BUILTIN_LABEL = 'ShuviX reference (read-only)'
  /** listBases 只给它这一行加的只读提示 */
  const BUILTIN_NOTE = 'read-only: search and read it; nothing can be submitted here'
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

  it('SB-19 内置库对每条会话都隐式、永远垫底：谁都没设过时用户库一个不带、只有它（项目会话排在项目库之后）；有人设过时排在设的那份之后，选择里写它的位置不算数', async () => {
    seedBases('alpha', 'notes')
    seedBuiltinBase()

    // 说明书随应用发布、就在那儿；用户库在磁盘上照样不启用，选择也是空的（它不在选择里）
    inProject()
    expect(knowledgeBaseOptions('s1')).toMatchObject({ selected: [], explicit: false })
    expect(await baseNames()).toEqual(['project', 'shuvix'])
    mockPick({ projectId: null })
    expect(await baseNames()).toEqual(['shuvix'])

    // 勾上别的：项目库 → 选择写的那一份 → 说明书；选择里把 shuvix 写在前面也挪不动它
    inProject(['shuvix', 'alpha'])
    expect(await baseNames()).toEqual(['project', 'alpha', 'shuvix'])
    inProject(['alpha', 'notes'])
    expect(await baseNames()).toEqual(['project', 'alpha', 'notes', 'shuvix'])
  })

  it('SB-20 `shuvix` 是第二个保留名：目录恰好叫 shuvix 的用户库进不了候选（内置那一项也不是候选），点名 shuvix 解析到内置库', async () => {
    const userRoot = seedBases('notes')
    // 同名的用户库：真有内容，但保留名优先 —— 这是与 `project` 一样的一条已知代价
    seedConcept(userRoot, 'shuvix/a.md', ['type: Memory', 'title: A'])
    seedBuiltinBase()
    mockPick({ projectId: null, settings: { knowledgeBases: ['notes', 'shuvix'] } })

    // 候选里没有 shuvix 这一行：用户那个目录被保留名遮住，内置库又是隐式的、不是选项
    expect(knowledgeBaseOptions('s1').options).toEqual([{ name: 'notes', label: 'notes' }])
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

  it('SB-23 内置库取消不掉：显式的 [] 或一份不含 shuvix 的选择都照样有它，选择里点名 shuvix 也不重复', async () => {
    seedBases('notes')
    seedBuiltinBase()

    // 不含 shuvix 的明确选择：用户库之后照样有它
    mockPick({ projectId: null, settings: { knowledgeBases: ['notes'] } })
    expect(await baseNames()).toEqual(['notes', 'shuvix'])
    expect(await resolveBase('s1', 'shuvix')).toEqual(builtinTarget())

    // 显式的 []：「我的库一个都不要」，说明书不归它管
    mockPick({ projectId: null, settings: { knowledgeBases: [] } })
    expect(await baseNames()).toEqual(['shuvix'])
    expect(await resolveBase('s1', 'shuvix')).toEqual(builtinTarget())

    // 点名了 shuvix（存量选择）：只出现一次、仍然垫底
    mockPick({ projectId: null, settings: { knowledgeBases: ['shuvix'] } })
    expect(await baseNames()).toEqual(['shuvix'])
    mockPick({ projectId: null, settings: { knowledgeBases: ['shuvix', 'notes', ' shuvix '] } })
    expect(await baseNames()).toEqual(['notes', 'shuvix'])
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

  it('SB-25 配置卡里没有内置项：不传会话的项目对话框口径与各种会话（项目 / 无项目 / 子会话 / bot / ShuviX 文件笔记本 / 日报）的候选都只有用户库，没有 shuvix 也没有 project', () => {
    seedBases('notes')
    seedBuiltinBase()
    const userOnly = [{ name: 'notes', label: 'notes' }]

    // 项目配置对话框（不传 sessionId）：说明书恒启用，没得勾；选择是空的
    expect(knowledgeBaseOptions()).toEqual({ options: userOnly, selected: [], explicit: false })

    // 会话配置卡：哪种会话都一样
    const kinds: Array<[string, () => void]> = [
      ['project', () => inProject()],
      ['no project', () => mockPick({ projectId: null })],
      [
        'sub-session',
        () => {
          mockPick({ projectId: null, parentId: 'parent' })
          mockSessionRow('parent', { projectId: null })
        }
      ],
      [
        'bot',
        () => {
          vi.mocked(projectDao.findById).mockReturnValue(PROJECT)
          mockPick({ projectId: null, settings: { bot: 'scout', workProject: 'p1' } })
        }
      ],
      ['shuvix-file notebook', () => mockPick({ projectId: '__policies__' })],
      ['daily', () => mockPick({ projectId: '__daily__' })],
      ['missing row', () => mockPick(undefined)]
    ]
    for (const [kind, arrange] of kinds) {
      arrange()
      const { options, selected } = knowledgeBaseOptions('s1')
      expect(options, kind).toEqual(userOnly)
      expect(selected, kind).not.toContain('shuvix')
    }
  })

  it('SB-26 围栏给模型的内置库 label 是那句英文说明，不是 i18n 的人读名（配置卡里本就没有它）', () => {
    seedBases('notes')
    seedBuiltinBase()
    mockPick({ projectId: null, settings: { knowledgeBases: ['notes', 'shuvix'] } })

    // 围栏是提示词：要说清里面是什么、以及只读（免得模型把笔记往这里记）
    const choices = enabledBaseChoices('s1')
    expect(choices).toEqual([
      { name: 'notes', label: '' },
      {
        name: 'shuvix',
        label: expect.stringContaining('read-only'),
        readonly: true,
        note: expect.any(String)
      }
    ])

    // 模型读的是说明，不是界面上的产品名 —— 哪天有人把围栏的 label 换成 i18n 那个键，这条会红
    const guide = choices.find((c) => c.name === 'shuvix')?.label
    expect(guide).not.toBe(BUILTIN_DISPLAY_NAME)
    expect(knowledgeBaseOptions('s1').options.map((o) => o.name)).toEqual(['notes'])
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

  it('SB-P1 项目会话、谁都没勾（这里没种内置库）：listBases / 围栏清单 / 围栏正文都只有项目库；配置卡的候选里没有它、用户库都没勾；不建任何目录', async () => {
    seedBases('alpha', 'notes')
    inProject()

    expect(await listBases('s1')).toStrictEqual([
      { base: 'project', label: 'project "Acme Corp"', dir: bundleAt(root, 'projects/p1') }
    ])
    expect(enabledBaseChoices('s1')).toEqual([{ name: 'project', label: 'Acme Corp' }])
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

  it('SB-P10 隐藏载体项目不算项目：没有隐式的项目库，点名 project 回 NO_PROJECT（这里没种内置说明书 —— 载体里的说明书见 SB-M）', async () => {
    // 内置说明书对每条会话都隐式；这条只钉「没有项目库」，所以不种内置库，启用清单因此是空的（种了的情形见 SB-M1）
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
 * KB-B1：bot 会话只归属 bot（`projectId` 空），项目以引用 `settings.workProject` 记下 —— 项目知识库照样跟着项目来
 * （chat-protocol `projectContextIdOf`）：隐式的 `project` 库、项目设过的选择当回落，都按引用的那个项目算。
 */
describe('KB-B1 bot 会话引用的工作项目也有项目库', () => {
  const seedBases = (...names: string[]): void => {
    for (const name of names) mkdirSync(join(userRootOf(root), name), { recursive: true })
  }
  const baseNames = async (): Promise<string[]> => (await listBases('s1')).map((b) => b.base)

  it('KB-B1 引用 p1 的 bot 根会话 → sessionBundle 是 projects/p1，project 库打头、隐式启用；不建目录', async () => {
    seedBases('notes')
    vi.mocked(projectDao.findById).mockReturnValue(PROJECT)
    mockPick({ projectId: null, settings: { bot: 'scout', workProject: 'p1' } })

    expect(sessionBundle('s1')).toEqual({
      bundle: 'projects/p1',
      dir: bundleAt(root, 'projects/p1'),
      label: 'project "Acme Corp"'
    })
    expect(projectDao.findById).toHaveBeenCalledWith('p1')
    expect(await baseNames()).toEqual(['project'])
    expect(enabledBaseChoices('s1')).toEqual([{ name: 'project', label: 'Acme Corp' }])
    expect(existsSync(join(root, PROJECTS))).toBe(false)
  })

  it('KB-B1 项目设过的选择当回落（会话 / 父会话都没设过）；explicit 为真', async () => {
    seedBases('notes', 'alpha')
    vi.mocked(projectDao.findById).mockReturnValue(PROJECT)
    mockProjectBases('p1', ['notes'])
    mockPick({ projectId: null, settings: { bot: 'scout', workProject: 'p1' } })

    expect(await baseNames()).toEqual(['project', 'notes'])
    expect(knowledgeBaseOptions('s1')).toMatchObject({ selected: ['notes'], explicit: true })
  })

  it('KB-B1 bot 会话的子会话（同一份引用）：项目库打头；父会话没设过时按父会话引用的项目回落', async () => {
    seedBases('notes')
    vi.mocked(projectDao.findById).mockReturnValue(PROJECT)
    mockProjectBases('p1', ['notes'])
    mockPick({ projectId: null, parentId: 'parent', settings: { workProject: 'p1' } })
    mockSessionRow('parent', { projectId: null, settings: { bot: 'scout', workProject: 'p1' } })
    expect(await baseNames()).toEqual(['project', 'notes'])

    // 子会话行自己没有引用（旧数据）：回落链经父会话的引用找到项目那份选择
    mockPick({ projectId: null, parentId: 'parent' })
    mockSessionRow('parent', { projectId: null, settings: { bot: 'scout', workProject: 'p1' } })
    expect(knowledgeBaseOptions('s1')).toMatchObject({ selected: ['notes'], explicit: true })
  })

  it('KB-B1 引用的项目已被删 / 是隐藏载体 / 空白 → 没有项目库，点名 project 回 NO_PROJECT', async () => {
    seedBases('notes')
    vi.mocked(projectDao.findById).mockReturnValue(undefined)
    mockPick({ projectId: null, settings: { bot: 'scout', workProject: 'gone' } })
    expect(sessionBundle('s1')).toEqual({ error: NO_PROJECT })
    expect(await resolveBase('s1', 'project')).toEqual({ error: NO_PROJECT })

    vi.mocked(projectDao.findById).mockReturnValue({ ...PROJECT, id: '__agents__' })
    mockPick({ projectId: null, settings: { bot: 'scout', workProject: '__agents__' } })
    expect(sessionBundle('s1')).toEqual({ error: NO_PROJECT })

    vi.mocked(projectDao.findById).mockReturnValue(PROJECT)
    mockPick({ projectId: null, settings: { bot: 'scout', workProject: '   ' } })
    expect(sessionBundle('s1')).toEqual({ error: NO_PROJECT })
    expect(await baseNames()).toEqual([])
  })
})

/**
 * ShuviX 文件笔记本里的内置说明书（SB-M1..M8）。2026-10-30 起它们是唯一隐式带说明书的会话（排在选择之前）；
 * 2026-11-14 起说明书对每条会话都隐式，这些载体不再是特例。四条主线：
 *   - 会话挂在 ShuviX 文件的承载项目下（策略 / agent / bot / hook / 技能 / 知识库，含内置的只读载体）→ `shuvix`
 *     恒启用、**排在用户圈定的库之后**，与各级选择无关（`[]` 也一样）；选择里也写了 `shuvix` 不重复。
 *   - 内置库不在（开发期没拷资源）→ 隐式的那份也没有，别的库照常，不建任何目录。
 *   - 载体之外（普通项目、无项目、日报、跟踪项）一模一样：`[]` 也好、没人设过也好，都有它、都垫底。
 *   - 配置卡在哪种会话里都不列 `shuvix`；存量选择里的 `shuvix` 读时剔掉。
 */
describe('SB-M ShuviX 文件笔记本里的内置说明书（与每条会话一样隐式、垫底）', () => {
  const BUILTIN_LABEL = 'ShuviX reference (read-only)'
  const BUILTIN_NOTE = 'read-only: search and read it; nothing can be submitted here'
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
      expect(enabledBaseChoices('s1')).toEqual([
        { name: 'shuvix', label, readonly: true, note: expect.any(String) }
      ])
      expect(await resolveBase('s1', 'shuvix')).toEqual(builtinTarget())
      const guide = renderKnowledgeGuide(enabledBaseChoices('s1'))
      expect(guide).not.toBeNull()
      expect(guide).toContain('shuvix')
      // 隐式启用只是解析：不写会话设置
      expect(sessionDao.updateSettings).not.toHaveBeenCalled()
    }
  )

  it('SB-M2 载体里同时勾了用户库：用户库按选择的顺序、说明书垫底；选择里也写了 shuvix（写在哪儿都一样）不重复', async () => {
    seedBases('alpha', 'notes')
    seedBuiltinBase()
    for (const bases of [
      ['alpha', 'notes'],
      ['alpha', 'shuvix', 'notes'],
      ['shuvix', 'shuvix', 'alpha', 'notes']
    ]) {
      const what = JSON.stringify(bases)
      mockPick({ projectId: '__policies__', settings: { knowledgeBases: bases } })
      expect(await baseNames(), what).toEqual(['alpha', 'notes', 'shuvix'])
      expect(
        enabledBaseChoices('s1').map((c) => c.name),
        what
      ).toEqual(['alpha', 'notes', 'shuvix'])
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

  it('SB-M5 载体之外同样隐式：普通项目 / 无项目 / 日报 / 跟踪项，明确设成 [] 还是没人设过都有说明书、都垫底；勾上的用户库排在它前面', async () => {
    seedBases('alpha', 'notes')
    seedBuiltinBase()

    // 载体会话：[] 挡不住它
    mockPick({ projectId: '__hooks__', settings: { knowledgeBases: [] } })
    expect(await baseNames()).toEqual(['shuvix'])

    // 普通项目 / 无项目：一模一样
    inProject([])
    expect(await baseNames()).toEqual(['project', 'shuvix'])
    mockPick({ projectId: null, settings: { knowledgeBases: [] } })
    expect(await baseNames()).toEqual(['shuvix'])
    inProject()
    expect(await baseNames()).toEqual(['project', 'shuvix'])
    mockPick({ projectId: null })
    expect(await baseNames()).toEqual(['shuvix'])

    // 日报、跟踪项（用户自己的笔记，隐藏载体但不是 ShuviX 文件）：同样
    for (const userNotes of ['__daily__', '__tracking__']) {
      mockPick({ projectId: userNotes, settings: { knowledgeBases: [] } })
      expect(await baseNames(), userNotes).toEqual(['shuvix'])
      mockPick({ projectId: userNotes })
      expect(await baseNames(), userNotes).toEqual(['shuvix'])
    }

    // 顺序是项目库 → 选择 → 说明书，选择里把 shuvix 写在哪儿都不算数
    inProject(['alpha', 'shuvix'])
    expect(await baseNames()).toEqual(['project', 'alpha', 'shuvix'])
    inProject(['shuvix', 'alpha'])
    expect(await baseNames()).toEqual(['project', 'alpha', 'shuvix'])
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
      // 围栏只列库名（2026-11-08 起不带目录）：隐式那份照样在
      expect(enabledBaseChoices('s1').map((b) => b.name)).toEqual(['shuvix'])

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

  it('SB-M8 knowledgeBaseOptions：载体会话、普通项目会话、项目对话框的候选里都没有 shuvix（用户库照列）；selected 剔掉 shuvix、其余原样', () => {
    seedBases('alpha', 'notes')
    seedBuiltinBase()
    const userOptions = [
      { name: 'alpha', label: 'alpha' },
      { name: 'notes', label: 'notes' }
    ]

    // 载体会话：选择原样交回（改了名、已不在的库照留），只有存量的 shuvix 被剔掉
    mockPick({
      projectId: '__policies__',
      settings: { knowledgeBases: ['notes', 'renamed-away', 'shuvix'] }
    })
    expect(knowledgeBaseOptions('s1')).toEqual({
      options: userOptions,
      selected: ['notes', 'renamed-away'],
      explicit: true
    })

    // 普通项目会话
    inProject()
    expect(knowledgeBaseOptions('s1').options).toEqual(userOptions)

    // 项目对话框（不传会话）
    expect(knowledgeBaseOptions().options).toEqual(userOptions)
  })
})

/**
 * 内置说明书恒启用（SB-D1..D7，2026-11-14 裁决「始终可查，不是选项」，接替 2026-11-02 的「缺省启用、可取消」）。
 * 不知道说明书的 agent 替用户新建 bot 时只能去翻 `~/.shuvix` 和应用包。四条主线：
 *   - 它不在回落链里：`selectedBaseNames` 缺省是 `[]`，各级存量选择里的 `shuvix` 读时剔掉；显式的 `[]` 和
 *     任何一份明确的选择都去不掉它。项目外、谁都没勾的会话因此也有围栏（只列说明书）。
 *   - 内置库目录不在（开发期没拷资源）→ 哪儿都没有 shuvix，一切照旧，不抛、不留空围栏。
 *   - 围栏里那段说明只跟内置库走，指到的文件名是说明书里真实存在的那几篇（三语都有）。
 */
describe('SB-D 内置说明书恒启用', () => {
  const seedBases = (...names: string[]): void => {
    for (const name of names) mkdirSync(join(userRootOf(root), name), { recursive: true })
  }
  const seedBuiltinBase = (): void => {
    mkdirSync(builtinLangAt(root, 'shuvix', 'en'), { recursive: true })
  }
  const baseNames = async (): Promise<string[]> => (await listBases('s1')).map((b) => b.base)
  const shuvixRow = (): ReturnType<typeof enabledBaseChoices>[number] | undefined =>
    enabledBaseChoices('s1').find((c) => c.name === 'shuvix')

  it('SB-D1 谁都没设过：selectedBaseNames 是 []，但围栏清单里有 shuvix、排在最后、只读、带一段非空的说明；项目外的会话也有围栏', () => {
    seedBases('notes')
    seedBuiltinBase()

    for (const arrange of [() => mockPick({ projectId: null }), () => inProject()]) {
      arrange()
      expect(selectedBaseNames('s1')).toEqual([])
      expect(shuvixRow()).toMatchObject({ readonly: true, note: expect.stringMatching(/\S/) })
      expect(enabledBaseChoices('s1').at(-1)?.name).toBe('shuvix')
    }
    mockPick({ projectId: null })
    expect(renderKnowledgeGuide(enabledBaseChoices('s1'))).toContain('shuvix')
    // 活的回落链：解析不落库
    expect(sessionDao.updateSettings).not.toHaveBeenCalled()
  })

  it('SB-D2 显式的 [] —— 会话 / 父会话 / 项目 哪一级都一样，还有一份不含它的明确选择：选择照原样，shuvix 照样在、排最后；项目外的 [] 围栏里只剩说明书', async () => {
    seedBases('notes')
    seedBuiltinBase()
    vi.mocked(projectDao.findById).mockReturnValue(PROJECT)

    // 会话自己
    mockPick({ projectId: null, settings: { knowledgeBases: [] } })
    expect(selectedBaseNames('s1')).toEqual([])
    expect(await baseNames()).toEqual(['shuvix'])
    expect(renderKnowledgeGuide(enabledBaseChoices('s1'))).toContain('shuvix')

    // 父会话
    mockPick({ projectId: null, parentId: 'parent' })
    mockSessionRow('parent', { projectId: null, settings: { knowledgeBases: [] } })
    expect(selectedBaseNames('s1')).toEqual([])
    expect(await baseNames()).toEqual(['shuvix'])
    expect(renderKnowledgeGuide(enabledBaseChoices('s1'))).toContain('shuvix')

    // 项目：项目库打头、说明书垫底
    mockPick({ projectId: 'p1' })
    mockProjectBases('p1', [])
    expect(selectedBaseNames('s1')).toEqual([])
    expect(await baseNames()).toEqual(['project', 'shuvix'])

    // 一份不含它的明确选择
    mockPick({ projectId: null, settings: { knowledgeBases: ['notes'] } })
    expect(selectedBaseNames('s1')).toEqual(['notes'])
    expect(await baseNames()).toEqual(['notes', 'shuvix'])
    expect(shuvixRow()).toBeDefined()
  })

  it('SB-D3 内置库目录不在：哪儿都没有 shuvix（选择、启用清单、围栏、配置卡），不抛、不建目录；项目外没勾就没有围栏，点名它按「一个都没启用」报错', async () => {
    seedBases('notes')
    mockPick({ projectId: null })

    expect(selectedBaseNames('s1')).toEqual([])
    expect(enabledBaseChoices('s1')).toEqual([])
    expect(renderKnowledgeGuide(enabledBaseChoices('s1'))).toBeNull()
    expect(await listBases('s1')).toEqual([])
    expect(await resolveBase('s1', 'shuvix')).toEqual({ error: NO_BASES })
    expect(knowledgeBaseOptions('s1').options.map((o) => o.name)).toEqual(['notes'])

    // 存量选择里写了 shuvix、项目会话、ShuviX 文件笔记本：同样没有它
    mockPick({ projectId: null, settings: { knowledgeBases: ['shuvix', 'notes'] } })
    expect(selectedBaseNames('s1')).toEqual(['notes'])
    expect(await baseNames()).toEqual(['notes'])
    inProject()
    expect(await baseNames()).toEqual(['project'])
    mockPick({ projectId: '__agents__' })
    expect(await baseNames()).toEqual([])
    expect(existsSync(builtinRootOf(root))).toBe(false)
  })

  it('SB-D4 说明与只读标记只在 shuvix 那一行，项目库与用户库都没有', () => {
    seedBases('notes')
    seedBuiltinBase()
    inProject(['notes', 'shuvix'])

    const choices = enabledBaseChoices('s1')
    expect(choices.map((c) => c.name)).toEqual(['project', 'notes', 'shuvix'])
    for (const choice of choices) {
      if (choice.name === 'shuvix') {
        expect(choice.note, choice.name).toEqual(expect.stringMatching(/\S/))
        expect(choice.readonly, choice.name).toBe(true)
      } else {
        expect(choice.note, choice.name).toBeUndefined()
        expect(choice.readonly, choice.name).toBeFalsy()
      }
    }
  })

  it('SB-D5 说明里点名的 md 恰是那六篇，每一篇在仓库的 en / zh / ja 目录里都真的在', () => {
    seedBuiltinBase()
    mockPick({ projectId: null })

    const note = shuvixRow()?.note ?? ''
    // 按条目名点（`/agent-md.md`，经 knowledge 的 read），不给目录
    const named = [...note.matchAll(/`\/([^`]+\.md)`/g)].map((m) => m[1])
    expect([...named].sort()).toEqual(
      [
        'agent-md.md',
        'bot-md.md',
        'hook-md.md',
        'policy-md.md',
        'shuvix-files.md',
        'skills.md'
      ].sort()
    )

    // 这里读的是**仓库里的真实目录**（`utils/paths` 的替身只管隔离根，这一步不经过它）：
    // `…/apps/desktop/src/main/services/knowledge/__tests__` 往上五层是 apps/desktop
    const here = dirname(fileURLToPath(import.meta.url))
    const manual = resolve(here, '../../../../..', 'resources/knowledge/shuvix')
    for (const lang of ['en', 'zh', 'ja']) {
      for (const name of named) {
        expect(existsSync(join(manual, lang, name)), `${lang}/${name}`).toBe(true)
      }
    }
  })

  it('SB-D6 knowledgeBaseOptions() 不传会话（项目对话框口径）：selected 是 []、explicit 为假，候选里没有 shuvix —— 内置库目录在不在都一样', () => {
    seedBases('notes')
    expect(knowledgeBaseOptions()).toEqual({
      options: [{ name: 'notes', label: 'notes' }],
      selected: [],
      explicit: false
    })

    seedBuiltinBase()
    expect(knowledgeBaseOptions()).toEqual({
      options: [{ name: 'notes', label: 'notes' }],
      selected: [],
      explicit: false
    })
  })

  it('SB-D7 存量选择里的 shuvix 在会话 / 父会话 / 项目哪一级都读时剔掉（含首尾空白的写法）；只写了 shuvix 的那一级仍算「设过」，不往下落', async () => {
    seedBases('alpha', 'notes')
    seedBuiltinBase()
    vi.mocked(projectDao.findById).mockReturnValue(PROJECT)

    // 会话自己
    mockPick({ projectId: 'p1', settings: { knowledgeBases: [' shuvix ', 'notes', 'shuvix'] } })
    expect(selectedBaseNames('s1')).toEqual(['notes'])
    expect(await baseNames()).toEqual(['project', 'notes', 'shuvix'])

    // 父会话
    mockPick({ projectId: 'p1', parentId: 'parent' })
    mockSessionRow('parent', { projectId: 'p1', settings: { knowledgeBases: ['shuvix', 'alpha'] } })
    expect(selectedBaseNames('s1')).toEqual(['alpha'])
    expect(await baseNames()).toEqual(['project', 'alpha', 'shuvix'])

    // 项目
    mockPick({ projectId: 'p1' })
    mockProjectBases('p1', ['notes', 'shuvix'])
    expect(selectedBaseNames('s1')).toEqual(['notes'])
    expect(await baseNames()).toEqual(['project', 'notes', 'shuvix'])

    // 会话只写了 shuvix：剔完是 []，但那是一份明确的选择 —— 不落到项目那份 notes（与 SB-P3 的 project 同理）
    mockPick({ projectId: 'p1', settings: { knowledgeBases: ['shuvix'] } })
    expect(selectedBaseNames('s1')).toEqual([])
    expect(knowledgeBaseOptions('s1')).toMatchObject({ selected: [], explicit: true })
    expect(await baseNames()).toEqual(['project', 'shuvix'])
  })
})

/**
 * 另一个项目的项目库（`knowledge` 工具的 `project` 参数；docs/project-split-design.md §5.1）—— 只解析，不设门。
 *
 *   SB-M1 按名字找：去两头空白、不分大小写；给回 bundle / 目录 / 标签（标签是项目当前的名字）
 *   SB-M2 重名时按 id 找；名字恰好等于某个 id 时 id 优先
 *   SB-M3 没有这个项目（含隐藏载体项目、归档的 —— findAllActive 本来就不给归档的）→ error
 *   SB-M4 重名 → error 列出每个的 id 与目录，让它改传 id
 *   SB-M5 就是本会话自己的项目 → error（它的库是 `project`）
 *   SB-M6 那个项目还没有库目录 → error；不建目录
 */
describe('projectBaseNamed —— 另一个项目的库（SB-M）', () => {
  const project = (id: string, name: string, path = `/repos/${id}`): Project => ({
    ...PROJECT,
    id,
    name,
    path
  })
  const BIG = project('pBig', 'Big Thing')
  const active = (...list: Project[]): void => {
    vi.mocked(projectDao.findAllActive).mockReturnValue(list)
  }
  const seedBaseOf = (id: string): string => {
    seedConcept(root, `${PROJECTS}/${id}/a.md`, ['type: Memory', 'title: A'])
    return bundleAt(root, `${PROJECTS}/${id}`)
  }

  it('SB-M1 按名字找（去空白、不分大小写）：给回那个项目的 bundle、目录与标签', () => {
    inProject()
    active(PROJECT, BIG)
    const dir = seedBaseOf('pBig')
    for (const name of ['Big Thing', '  big thing ', 'BIG THING']) {
      expect(projectBaseNamed('s1', name), name).toEqual({
        bundle: `${PROJECTS}/pBig`,
        dir,
        label: 'project "Big Thing"'
      })
    }
  })

  it('SB-M2 按 id 找；重名的两个项目各自按 id 解析', () => {
    inProject()
    const twin = project('pTwin', 'Big Thing')
    active(PROJECT, BIG, twin)
    seedBaseOf('pBig')
    const twinDir = seedBaseOf('pTwin')
    expect(projectBaseNamed('s1', 'pTwin')).toEqual({
      bundle: `${PROJECTS}/pTwin`,
      dir: twinDir,
      label: 'project "Big Thing"'
    })
  })

  it('SB-M3 没有这个项目：error 让它去问用户；隐藏载体项目不算项目', () => {
    inProject()
    active(PROJECT, project('__agents__', 'Agents'))
    expect(projectBaseNamed('s1', 'Nope')).toEqual({
      error:
        'No project is named "Nope" (archived projects are not looked at). Ask the user for the project\'s exact name.'
    })
    expect(projectBaseNamed('s1', 'Agents')).toEqual({
      error: expect.stringContaining('No project is named "Agents"')
    })
  })

  it('SB-M4 重名：error 列出每个的 id 与目录，让它改传 id', () => {
    inProject()
    active(PROJECT, BIG, project('pTwin', 'big thing', '/repos/twin'))
    expect(projectBaseNamed('s1', 'Big Thing')).toEqual({
      error:
        '"Big Thing" names 2 projects: pBig (folder /repos/pBig); pTwin (folder /repos/twin). Pass the id of the one you mean as `project`.'
    })
  })

  it('SB-M5 就是本会话自己的项目：error 指回 base "project"', () => {
    inProject()
    active(PROJECT, BIG)
    seedBaseOf('p1')
    expect(projectBaseNamed('s1', 'acme corp')).toEqual({
      error:
        '"Acme Corp" is this session\'s own project: its base is "project" — leave `project` out.'
    })
  })

  it('SB-M6 那个项目还没有库：error；不建目录', () => {
    inProject()
    active(PROJECT, BIG)
    expect(projectBaseNamed('s1', 'Big Thing')).toEqual({
      error: 'Project "Big Thing" has no knowledge base yet — nothing was ever recorded in it.'
    })
    expect(existsSync(bundleAt(root, `${PROJECTS}/pBig`))).toBe(false)
  })
})

// ────────────────────── bot 自己的库（保留名 `bot`） ──────────────────────

/**
 * 每个 bot 一个库（2026-11-14）：bot 会话本身恒带它，排在项目库之后、用户勾的库之前，不是候选项；宿主（botService）
 * 经 setBotKnowledgeHost 注入「这条会话绑的 bot 的 key」与「key 的显示名」。别的会话（含 bot 开的子会话）宿主回 null。
 */
describe('SB-BOT bot 自己的库', () => {
  const NO_BOT = 'This session has no "bot" knowledge base — only a bot\'s own sessions have one.'
  const seedBases = (...names: string[]): void => {
    for (const name of names) mkdirSync(join(userRootOf(root), name), { recursive: true })
  }
  const seedBuiltinBase = (): void => {
    mkdirSync(builtinLangAt(root, 'shuvix', 'en'), { recursive: true })
  }
  /** s1 → k1（显示名可换）；别的会话 → null */
  const host = (names: Record<string, string> = { k1: 'Diary Helper' }): void =>
    setBotKnowledgeHost({
      keyOfSession: (sid) => (sid === 's1' ? 'k1' : null),
      displayNameOf: (key) => names[key]
    })
  const namesOf = async (sid: string): Promise<string[]> =>
    (await listBases(sid)).map((b) => b.base)

  afterEach(() => setBotKnowledgeHost(null))

  it('SB-BOT1 项目外的 bot 会话：bot 库打头、勾的库居中、说明书垫底；bot 那一行带 bot 的名字与绝对目录、不只读；不建目录', async () => {
    seedBases('notes')
    seedBuiltinBase()
    host()
    mockPick({ projectId: null, settings: { bot: 'diary', knowledgeBases: ['notes'] } })

    const bases = await listBases('s1')
    expect(bases.map((b) => b.base)).toEqual(['bot', 'notes', 'shuvix'])
    const bot = bases[0]
    expect(bot).toEqual({ base: 'bot', label: 'bot "Diary Helper"', dir: join(root, 'bots', 'k1') })
    expect(bot).not.toHaveProperty('note')
    expect(existsSync(join(root, 'bots'))).toBe(false)
  })

  it('SB-BOT2 有工作项目的 bot 会话：项目库 → bot 库 → 勾的库 → 说明书；围栏里 bot 那一行紧跟项目那一行', () => {
    seedBases('notes')
    seedBuiltinBase()
    host()
    vi.mocked(projectDao.findById).mockReturnValue(PROJECT)
    mockPick({
      projectId: null,
      settings: { bot: 'diary', workProject: 'p1', knowledgeBases: ['notes'] }
    })

    const choices = enabledBaseChoices('s1')
    expect(choices.map((c) => c.name)).toEqual(['project', 'bot', 'notes', 'shuvix'])
    expect(choices[1]).toMatchObject({ name: 'bot', label: 'Diary Helper' })
    expect(choices[1].readonly).toBeFalsy()
    const guide = renderKnowledgeGuide(choices)!
    expect(guide).toContain('- project — Acme Corp\n- bot — Diary Helper\n')
  })

  it('SB-BOT3 resolveBase(`bot`)：bot 会话里（含首尾空白）解析到 bots/<key>；别的会话回 NO_BOT —— 有勾的库 / 一个都没勾 / 有个用户目录恰好叫 bot 都一样；保留名大小写敏感', async () => {
    seedBases('notes', 'bot')
    host()
    mockPick({ projectId: null, settings: { bot: 'diary' } })
    const target = await resolveBase('s1', 'bot')
    expect(target).toMatchObject({ bundle: 'bots/k1', dir: join(root, 'bots', 'k1') })
    expect(await resolveBase('s1', '  bot  ')).toEqual(target)

    for (const bases of [['notes'], [], ['bot']]) {
      mockSessionRow('s2', { projectId: null, settings: { knowledgeBases: bases } })
      expect(await resolveBase('s2', 'bot'), JSON.stringify(bases)).toEqual({ error: NO_BOT })
    }
    mockSessionRow('s2', { projectId: null, settings: { knowledgeBases: ['notes'] } })
    expect(await resolveBase('s2', 'Bot')).toEqual({
      error: '"Bot" is not one of this session\'s knowledge bases. Enabled: "notes".'
    })
  })

  it('SB-BOT4 用户目录恰好叫 bot：被保留名遮住 —— 不是候选、选择里剔掉，listBases 里只有一行 bot 且是 bot 库；别的会话勾了 bot 也没有它', async () => {
    seedBases('bot', 'notes')
    host()
    mockPick({ projectId: null, settings: { bot: 'diary', knowledgeBases: ['bot', 'notes'] } })

    const opts = knowledgeBaseOptions('s1')
    expect(opts.options.map((o) => o.name)).toEqual(['notes'])
    expect(opts.selected).toEqual(['notes'])
    const bots = (await listBases('s1')).filter((b) => b.base === 'bot')
    expect(bots).toHaveLength(1)
    expect(bots[0].dir).toBe(join(root, 'bots', 'k1'))

    mockSessionRow('s2', { projectId: null, settings: { knowledgeBases: ['bot'] } })
    expect(await namesOf('s2')).toEqual([])
    expect(knowledgeBaseOptions('s2').options.map((o) => o.name)).toEqual(['notes'])
  })

  it('SB-BOT5 存量选择里的 bot 在会话 / 父会话 / 项目哪一级都读时剔掉（含首尾空白）；只写了 bot 的那一级仍算设过，不往下落', () => {
    seedBases('alpha', 'notes')
    vi.mocked(projectDao.findById).mockReturnValue(PROJECT)

    mockPick({ projectId: 'p1', settings: { knowledgeBases: [' bot ', 'notes', 'bot'] } })
    expect(selectedBaseNames('s1')).toEqual(['notes'])

    mockPick({ projectId: 'p1', parentId: 'parent' })
    mockSessionRow('parent', { projectId: 'p1', settings: { knowledgeBases: ['bot', 'alpha'] } })
    expect(selectedBaseNames('s1')).toEqual(['alpha'])

    mockPick({ projectId: 'p1' })
    mockProjectBases('p1', ['notes', 'bot'])
    expect(selectedBaseNames('s1')).toEqual(['notes'])

    // 只写了 bot：剔完是 []，但那是一份明确的选择 —— 不落到项目那份 notes
    mockPick({ projectId: 'p1', settings: { knowledgeBases: ['bot'] } })
    expect(selectedBaseNames('s1')).toEqual([])
    expect(knowledgeBaseOptions('s1')).toMatchObject({ selected: [], explicit: true })
  })

  it('SB-BOT6 key 有、显示名没有：listBases 的标签就是 `bot`，围栏那一行是 `- bot`（没有破折号）', async () => {
    host({})
    mockPick({ projectId: null, settings: { bot: 'diary' } })

    expect((await listBases('s1'))[0]).toMatchObject({ base: 'bot', label: 'bot' })
    const guide = renderKnowledgeGuide(enabledBaseChoices('s1'))!
    expect(guide.split('\n')).toContain('- bot')
    expect(guide).not.toContain('- bot —')
  })

  it('SB-BOT7 宿主没注入 / keyOfSession 抛错：没有 bot 库、点名 bot 回 NO_BOT，别的库照常，不抛', async () => {
    seedBases('notes')
    vi.mocked(projectDao.findById).mockReturnValue(PROJECT)
    mockPick({ projectId: 'p1', settings: { bot: 'diary', knowledgeBases: ['notes'] } })

    const check = async (): Promise<void> => {
      expect(await namesOf('s1')).toEqual(['project', 'notes'])
      expect(enabledBaseChoices('s1').map((c) => c.name)).toEqual(['project', 'notes'])
      expect(await resolveBase('s1', 'bot')).toEqual({ error: NO_BOT })
      expect(await resolveBase('s1', 'notes')).toMatchObject({ bundle: 'knowledge/notes' })
      expect(await resolveBase('s1', 'project')).toMatchObject({ bundle: 'projects/p1' })
    }
    setBotKnowledgeHost(null)
    await check()
    setBotKnowledgeHost({
      keyOfSession: () => {
        throw new Error('boom')
      },
      displayNameOf: () => 'X'
    })
    await check()
  })
})
