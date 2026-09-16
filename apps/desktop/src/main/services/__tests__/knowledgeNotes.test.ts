/**
 * knowledgeNotes —— 侧栏「知识库」分组点行的后端：三个隐藏承载项目（项目库 KNOWLEDGE_PROJECT_ID，
 * path = **shuvix 根**；用户库 KNOWLEDGE_USER_PROJECT_ID，path = **用户根**；内置库
 * KNOWLEDGE_BUILTIN_PROJECT_ID，path = 该库**当前语言那一版**的目录）按需插入、历史行漂移自愈；
 * 笔记本会话按归一后的承载项目相对路径一文件一会话复用（用户库的 notebookPath 去掉首段 `knowledge/`，
 * 内置库的是**库内相对路径**——语言那一层不进 notebookPath，三个承载项目之间不复用）；
 * **落不进任何 bundle 的路径在碰任何东西之前就被拒绝** —— 根下的散文件、容器里的散文件、
 * bundle 目录本身、隐藏目录、越界路径与空路径都不是条目。
 *
 * dao / sessionService 是替身；services/knowledge 只替到接口那一层：路径相关的导出转发**真的**
 * knowledgePaths（它只依赖 utils/paths + i18next，不会拖进扫描 / git / okf-minisearch），
 * 好让「什么路径算数」「按什么键查重」这两条语义真的被验证；只有磁盘扫描那一个导出
 * （listBuiltinBundles）是纯替身，用例直接摆布它的答案。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import {
  KNOWLEDGE_BUILTIN_PROJECT_ID,
  KNOWLEDGE_PROJECT_ID,
  KNOWLEDGE_USER_PROJECT_ID
} from '@shuvix/chat-protocol/knowledge'
import type { Project, Session } from '../../types'

const state = vi.hoisted(() => ({ root: '', language: 'en' }))
const logSpy = vi.hoisted(() => ({ warn: vi.fn() }))

vi.mock('../../utils/paths', () => ({
  getShuvixKnowledgeRootDir: () => state.root,
  getUserKnowledgeRootDir: () => `${state.root}-user`,
  // 内置库根替身：缺省不存在的兄弟目录 —— 不种东西的用例里就是「没有内置库」
  getBuiltinKnowledgeDir: () => `${state.root}-builtin`
}))
// 内置库的语言目录取自 i18next 单例。不桩的话 `i18next.language` 是 undefined，代码一路回落 `en`，
// 「切语言换哪一版」这件事就测不出来；getter 读可变 state，用例中途改 language 下一次调用即生效。
vi.mock('i18next', () => ({
  default: {
    get language(): string {
      return state.language
    },
    t: (key: string) => key
  }
}))
// 「不止一个内置库就什么都不做**并记一笔**」是 KN-17 的断言对象，故 logger 也替身
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: logSpy.warn, error: () => {} })
}))
vi.mock('../../dao/projectDao', () => ({
  projectDao: { findById: vi.fn(), insert: vi.fn(), update: vi.fn() }
}))
vi.mock('../../dao/sessionDao', () => ({
  sessionDao: { findByProjectAndNotebookPath: vi.fn() }
}))
vi.mock('../sessionService', () => ({
  sessionService: {
    create: vi.fn((p: Record<string, unknown> | undefined) => ({ id: 's-new', ...p }))
  }
}))
vi.mock('../knowledge', async () => {
  const real = await vi.importActual<typeof import('../knowledge/knowledgePaths')>(
    '../knowledge/knowledgePaths'
  )
  return {
    getShuvixKnowledgeRoot: real.getShuvixKnowledgeRoot,
    getUserKnowledgeRoot: real.getUserKnowledgeRoot,
    entryFilePath: real.entryFilePath,
    isUserBundle: real.isUserBundle,
    isBuiltinBundle: real.isBuiltinBundle,
    bundleDir: real.bundleDir,
    locateBundle: real.locateBundle,
    USER_CONTAINER: real.USER_CONTAINER,
    // 唯一要读磁盘的导出：内置库有几个由用例说了算
    listBuiltinBundles: vi.fn((): string[] => [])
  }
})

import { projectDao } from '../../dao/projectDao'
import { sessionDao } from '../../dao/sessionDao'
import { appEventBus } from '../../utils/appEventBus'
import { listBuiltinBundles } from '../knowledge'
import { sessionService } from '../sessionService'
import {
  ensureKnowledgeProject,
  ensureKnowledgeUserProject,
  openKnowledgeNote,
  syncKnowledgeBuiltinProject
} from '../knowledgeNotes'

const publish = vi.spyOn(appEventBus, 'publish')

const KNOWLEDGE_PROJECT_NAME = '知识库'
const KNOWLEDGE_BUILTIN_PROJECT_NAME = 'ShuviX 系统说明'
const ENTRY = 'projects/acme/a.md'

/** 本期唯一的内置库（工具里的保留名 shuvix）；首段 `builtin` 是保留容器名，磁盘上没有这个目录 */
const BUILTIN_BASE = 'shuvix'
const BUILTIN_BUNDLE = `builtin/${BUILTIN_BASE}`
const BUILTIN_ENTRY = `${BUILTIN_BUNDLE}/a.md`

const builtinRoot = (): string => `${state.root}-builtin`

/** 内置库某一版语言的目录（`<内置根>/<库名>/<语言>`）—— bundle 目录就是这一层 */
const builtinLangDir = (lang: string): string => join(builtinRoot(), BUILTIN_BASE, lang)

/**
 * 往内置根种这个库的若干版语言。`builtinLanguageDir` 是一次 stat：目录不在就回落 `en`，
 * 所以「zh 那一版存在」必须真在磁盘上。内置根在 state.root 之外，靠 afterEach 清。
 */
function seedBuiltin(langs: string[]): void {
  for (const lang of langs) {
    const dir = builtinLangDir(lang)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'a.md'), `# ${lang}\n`, 'utf-8')
  }
}

/** 一行与当前根一致的隐藏项目（over 用来制造漂移） */
const knowledgeRow = (over: Partial<Project> = {}): Project => ({
  id: KNOWLEDGE_PROJECT_ID,
  name: KNOWLEDGE_PROJECT_NAME,
  path: state.root,
  systemPrompt: '',
  settings: {},
  archivedAt: 0,
  createdAt: 100,
  updatedAt: 200,
  ...over
})

beforeEach(() => {
  vi.clearAllMocks()
  // 不存在的临时路径：ensureKnowledgeProject 不该把它建出来（KN-4）
  state.root = join(
    tmpdir(),
    `shuvix-kb-notes-${process.pid}-${Math.random().toString(36).slice(2)}`
  )
  state.language = 'en'
  vi.mocked(projectDao.findById).mockReturnValue(undefined)
  vi.mocked(sessionDao.findByProjectAndNotebookPath).mockReturnValue(undefined)
  // 缺省「一个内置库都没有」：要它有的用例自己摆
  vi.mocked(listBuiltinBundles).mockReturnValue([])
})

afterEach(() => {
  // 内置根与用户根一样在 state.root 之外：种过内置库的用例靠这一条清理
  rmSync(builtinRoot(), { recursive: true, force: true })
})

describe('ensureKnowledgeProject', () => {
  it('KN-1 首次：findById 无 → insert 一行隐藏项目（固定 id / 名 / path = shuvix 根 / 空提示词 / 空配置 / 未归档 / 两个时间戳相同），返回同一行；不 update、不广播 project.changed', () => {
    const before = Date.now()
    const project = ensureKnowledgeProject()
    const after = Date.now()

    expect(projectDao.findById).toHaveBeenCalledWith(KNOWLEDGE_PROJECT_ID)
    expect(projectDao.insert).toHaveBeenCalledTimes(1)
    const inserted = vi.mocked(projectDao.insert).mock.calls[0][0]
    expect(inserted).toEqual({
      id: KNOWLEDGE_PROJECT_ID,
      name: KNOWLEDGE_PROJECT_NAME,
      path: state.root,
      systemPrompt: '',
      settings: {},
      archivedAt: 0,
      createdAt: expect.any(Number),
      updatedAt: inserted.createdAt
    })
    expect(inserted.createdAt).toBeGreaterThanOrEqual(before)
    expect(inserted.createdAt).toBeLessThanOrEqual(after)
    expect(project).toEqual(inserted)

    expect(projectDao.update).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
  })

  it('KN-2 已有且一致的行原样返回；不 insert、不 update', () => {
    const row = knowledgeRow()
    vi.mocked(projectDao.findById).mockReturnValue(row)

    expect(ensureKnowledgeProject()).toBe(row)
    expect(projectDao.insert).not.toHaveBeenCalled()
    expect(projectDao.update).not.toHaveBeenCalled()
  })

  it('KN-3 自愈：path 漂移只补 path、name 漂移只补 name、都漂移一次 update 带两键；返回值合并补丁、其余字段保留', () => {
    // (a) home 目录迁移：只有 path 不一致
    const moved = knowledgeRow({ path: '/old/home/.shuvix/knowledge-shuvix' })
    vi.mocked(projectDao.findById).mockReturnValue(moved)
    let out = ensureKnowledgeProject()
    expect(projectDao.update).toHaveBeenCalledTimes(1)
    expect(projectDao.update).toHaveBeenLastCalledWith(KNOWLEDGE_PROJECT_ID, { path: state.root })
    expect(out).toEqual({ ...moved, path: state.root })

    // (b) 只有 name 不一致
    const renamed = knowledgeRow({ name: 'Wiki' })
    vi.mocked(projectDao.findById).mockReturnValue(renamed)
    out = ensureKnowledgeProject()
    expect(projectDao.update).toHaveBeenCalledTimes(2)
    expect(projectDao.update).toHaveBeenLastCalledWith(KNOWLEDGE_PROJECT_ID, {
      name: KNOWLEDGE_PROJECT_NAME
    })
    expect(out).toEqual({ ...renamed, name: KNOWLEDGE_PROJECT_NAME })

    // (c) 两者都漂移：一次 update 带两个键
    const both = knowledgeRow({ name: 'Wiki', path: '/old/home/.shuvix/knowledge-shuvix' })
    vi.mocked(projectDao.findById).mockReturnValue(both)
    out = ensureKnowledgeProject()
    expect(projectDao.update).toHaveBeenCalledTimes(3)
    expect(projectDao.update).toHaveBeenLastCalledWith(KNOWLEDGE_PROJECT_ID, {
      path: state.root,
      name: KNOWLEDGE_PROJECT_NAME
    })
    expect(out).toEqual({ ...both, path: state.root, name: KNOWLEDGE_PROJECT_NAME })

    expect(projectDao.insert).not.toHaveBeenCalled()
  })

  it('KN-4 不建目录：目录归写入 / 建 bundle 时懒建，插项目行不该顺手把根目录建出来', () => {
    ensureKnowledgeProject()
    expect(existsSync(state.root)).toBe(false)
  })
})

describe('openKnowledgeNote', () => {
  it('KN-5 无既有会话：先确保项目行、再 create（projectId / 归一后的根相对路径 / 文件名 stem 为标题）；扩展名剥离大小写不敏感', async () => {
    const session = await openKnowledgeNote(ENTRY)

    expect(sessionService.create).toHaveBeenCalledTimes(1)
    expect(sessionService.create).toHaveBeenCalledWith({
      projectId: KNOWLEDGE_PROJECT_ID,
      notebookPath: ENTRY,
      title: 'a'
    })
    expect(session).toEqual({
      id: 's-new',
      projectId: KNOWLEDGE_PROJECT_ID,
      notebookPath: ENTRY,
      title: 'a'
    })
    expect(projectDao.insert).toHaveBeenCalledTimes(1)

    const order = (fn: { mock: { invocationCallOrder: number[] } }): number =>
      fn.mock.invocationCallOrder[0]
    expect(order(vi.mocked(projectDao.insert))).toBeLessThan(
      order(vi.mocked(sessionService.create))
    )

    await openKnowledgeNote('projects/acme/B.MD')
    expect(sessionService.create).toHaveBeenLastCalledWith({
      projectId: KNOWLEDGE_PROJECT_ID,
      notebookPath: 'projects/acme/B.MD',
      title: 'B'
    })
    await openKnowledgeNote('projects/acme/sub/c.markdown')
    expect(sessionService.create).toHaveBeenLastCalledWith({
      projectId: KNOWLEDGE_PROJECT_ID,
      notebookPath: 'projects/acme/sub/c.markdown',
      title: 'c'
    })
  })

  it('KN-6 标题：给了则裁首尾空白；全空白回落文件名 stem；notebookPath 不受标题影响', async () => {
    await openKnowledgeNote(ENTRY, ' Nice Title ')
    expect(sessionService.create).toHaveBeenLastCalledWith({
      projectId: KNOWLEDGE_PROJECT_ID,
      notebookPath: ENTRY,
      title: 'Nice Title'
    })

    await openKnowledgeNote(ENTRY, '   ')
    expect(sessionService.create).toHaveBeenLastCalledWith({
      projectId: KNOWLEDGE_PROJECT_ID,
      notebookPath: ENTRY,
      title: 'a'
    })
  })

  it('KN-7 复用按归一路径：反斜杠 / 前导 "/" / "./" + 重复分隔符 + 尾随 "/" 都查到同一会话，不 create，查询键恒为 projects/acme/a.md', async () => {
    const existing = {
      id: 's-old',
      title: 'a',
      projectId: KNOWLEDGE_PROJECT_ID,
      parentId: null,
      settings: { notebookPath: ENTRY },
      createdAt: 1,
      updatedAt: 1
    } as Session
    vi.mocked(sessionDao.findByProjectAndNotebookPath).mockImplementation((projectId, path) =>
      projectId === KNOWLEDGE_PROJECT_ID && path === ENTRY ? existing : undefined
    )

    for (const raw of ['projects\\acme\\a.md', `/${ENTRY}`, './projects//acme/a.md/']) {
      expect(await openKnowledgeNote(raw), raw).toBe(existing)
    }
    expect(sessionService.create).not.toHaveBeenCalled()
    expect(vi.mocked(sessionDao.findByProjectAndNotebookPath).mock.calls).toEqual([
      [KNOWLEDGE_PROJECT_ID, ENTRY],
      [KNOWLEDGE_PROJECT_ID, ENTRY],
      [KNOWLEDGE_PROJECT_ID, ENTRY]
    ])
  })

  it('KN-8 守门：落不进任何 bundle 的路径直接拒绝（越界 / 空 / "/" / 根下散文件 / 容器里的散文件 / bundle 目录本身）—— 未查 / 插项目行、未查 / 建会话', async () => {
    const bad = [
      '../x.md',
      'projects/acme/../../x.md',
      '',
      '/',
      'x.md',
      'projects/stray.md',
      'projects/acme',
      // 旧的作用域目录已经不存在：global/ 下的路径也落不进任何 bundle
      'global/a.md'
    ]
    for (const path of bad) {
      await expect(openKnowledgeNote(path), path).rejects.toThrow(/Invalid knowledge path/)
    }
    expect(projectDao.findById).not.toHaveBeenCalled()
    expect(projectDao.insert).not.toHaveBeenCalled()
    expect(sessionDao.findByProjectAndNotebookPath).not.toHaveBeenCalled()
    expect(sessionService.create).not.toHaveBeenCalled()
  })
})

describe('ensureKnowledgeUserProject', () => {
  it('KN-9 用户库的承载项目：首次 insert 一行（固定 id / 名 / path = 用户根），不 update、不广播、不建目录；一致的行原样返回；path 漂移只补 path；与项目库的承载项目是两行', () => {
    const userRoot = `${state.root}-user`
    const before = Date.now()
    const project = ensureKnowledgeUserProject()
    const after = Date.now()

    expect(projectDao.findById).toHaveBeenCalledWith(KNOWLEDGE_USER_PROJECT_ID)
    expect(projectDao.insert).toHaveBeenCalledTimes(1)
    const inserted = vi.mocked(projectDao.insert).mock.calls[0][0]
    expect(inserted).toEqual({
      id: '__knowledge_user__',
      name: '用户知识库',
      path: userRoot,
      systemPrompt: '',
      settings: {},
      archivedAt: 0,
      createdAt: expect.any(Number),
      updatedAt: inserted.createdAt
    })
    expect(inserted.createdAt).toBeGreaterThanOrEqual(before)
    expect(inserted.createdAt).toBeLessThanOrEqual(after)
    expect(project).toEqual(inserted)
    expect(projectDao.update).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
    // 插项目行不顺手建目录：用户根要等用户（或「打开目录」）把它建出来
    expect(existsSync(userRoot)).toBe(false)

    // 已有且一致：原样返回
    const row: Project = { ...inserted }
    vi.mocked(projectDao.findById).mockReturnValue(row)
    expect(ensureKnowledgeUserProject()).toBe(row)
    expect(projectDao.update).not.toHaveBeenCalled()

    // path 漂移（home 目录迁移）：只补 path
    const moved: Project = { ...inserted, path: '/old/home/.shuvix/knowledge' }
    vi.mocked(projectDao.findById).mockReturnValue(moved)
    expect(ensureKnowledgeUserProject()).toEqual({ ...moved, path: userRoot })
    expect(vi.mocked(projectDao.update).mock.calls).toEqual([
      [KNOWLEDGE_USER_PROJECT_ID, { path: userRoot }]
    ])
    expect(projectDao.insert).toHaveBeenCalledTimes(1)

    // 两个承载项目：各插各的一行，id / path / name 都不同
    vi.mocked(projectDao.findById).mockReturnValue(undefined)
    vi.mocked(projectDao.insert).mockClear()
    ensureKnowledgeProject()
    ensureKnowledgeUserProject()
    expect(vi.mocked(projectDao.insert).mock.calls.map(([p]) => [p.id, p.path, p.name])).toEqual([
      [KNOWLEDGE_PROJECT_ID, state.root, KNOWLEDGE_PROJECT_NAME],
      [KNOWLEDGE_USER_PROJECT_ID, userRoot, '用户知识库']
    ])
  })
})

describe('openKnowledgeNote —— 用户库', () => {
  const order = (fn: { mock: { invocationCallOrder: number[] } }): number =>
    fn.mock.invocationCallOrder[0]

  it('KN-10 用户库条目挂在 `__knowledge_user__` 下，notebookPath = 条目 id 去掉首段 `knowledge/`：只确保这一个承载项目、先插行再建会话；项目库条目照旧挂 `__knowledge__`', async () => {
    const session = await openKnowledgeNote('knowledge/notes/sub/A.md')

    expect(vi.mocked(projectDao.findById).mock.calls).toEqual([[KNOWLEDGE_USER_PROJECT_ID]])
    expect(vi.mocked(sessionDao.findByProjectAndNotebookPath).mock.calls).toEqual([
      [KNOWLEDGE_USER_PROJECT_ID, 'notes/sub/A.md']
    ])
    expect(sessionService.create).toHaveBeenCalledTimes(1)
    expect(sessionService.create).toHaveBeenCalledWith({
      projectId: KNOWLEDGE_USER_PROJECT_ID,
      notebookPath: 'notes/sub/A.md',
      title: 'A'
    })
    expect(session).toMatchObject({ id: 's-new', projectId: KNOWLEDGE_USER_PROJECT_ID })
    expect(vi.mocked(projectDao.insert).mock.calls.map(([p]) => p.id)).toEqual([
      KNOWLEDGE_USER_PROJECT_ID
    ])
    expect(order(vi.mocked(projectDao.insert))).toBeLessThan(
      order(vi.mocked(sessionService.create))
    )

    await openKnowledgeNote('knowledge/读书笔记/x.md', ' 读书 ')
    expect(sessionService.create).toHaveBeenLastCalledWith({
      projectId: KNOWLEDGE_USER_PROJECT_ID,
      notebookPath: '读书笔记/x.md',
      title: '读书'
    })

    // 回归：项目库条目的承载项目与 notebookPath 与引入用户库之前逐字一致
    await openKnowledgeNote(ENTRY)
    expect(projectDao.findById).toHaveBeenLastCalledWith(KNOWLEDGE_PROJECT_ID)
    expect(sessionService.create).toHaveBeenLastCalledWith({
      projectId: KNOWLEDGE_PROJECT_ID,
      notebookPath: ENTRY,
      title: 'a'
    })
  })

  it('KN-11 用户库的复用键归一（反斜杠 / 前导 "/" / "./" + 重复分隔符 + 尾随 "/" / 库内 ".."）恒为 notes/a.md；同形的项目库路径是另一个承载项目的键，不跨承载项目复用', async () => {
    const existing = {
      id: 's-user',
      title: 'a',
      projectId: KNOWLEDGE_USER_PROJECT_ID,
      parentId: null,
      settings: { notebookPath: 'notes/a.md' },
      createdAt: 1,
      updatedAt: 1
    } as Session
    vi.mocked(sessionDao.findByProjectAndNotebookPath).mockImplementation((projectId, path) =>
      projectId === KNOWLEDGE_USER_PROJECT_ID && path === 'notes/a.md' ? existing : undefined
    )

    const raws = [
      'knowledge\\notes\\a.md',
      '/knowledge/notes/a.md',
      './knowledge//notes/a.md/',
      'knowledge/notes/sub/../a.md'
    ]
    for (const raw of raws) {
      expect(await openKnowledgeNote(raw), raw).toBe(existing)
    }
    expect(sessionService.create).not.toHaveBeenCalled()
    expect(vi.mocked(sessionDao.findByProjectAndNotebookPath).mock.calls).toEqual(
      raws.map(() => [KNOWLEDGE_USER_PROJECT_ID, 'notes/a.md'])
    )

    // 对照：projects/notes/a.md 走项目库的承载项目，查的是另一个键，结果是新建
    const created = await openKnowledgeNote('projects/notes/a.md')
    expect(sessionDao.findByProjectAndNotebookPath).toHaveBeenLastCalledWith(
      KNOWLEDGE_PROJECT_ID,
      'projects/notes/a.md'
    )
    expect(created).not.toBe(existing)
    expect(sessionService.create).toHaveBeenCalledTimes(1)
    expect(sessionService.create).toHaveBeenCalledWith({
      projectId: KNOWLEDGE_PROJECT_ID,
      notebookPath: 'projects/notes/a.md',
      title: 'a'
    })
  })

  it('KN-12 [白盒] 用 ".." 绕回另一个根的写法落回规范形：承载项目与 notebookPath 按真正落到的根定，notebookPath 不含 ".."', async () => {
    // 替身根是兄弟目录 X 与 X-user：从一个根的首段出发 `..` 一下就进了另一个根
    const base = basename(state.root)

    await openKnowledgeNote(`knowledge/../${base}/projects/acme/a.md`)
    expect(sessionService.create).toHaveBeenLastCalledWith({
      projectId: KNOWLEDGE_PROJECT_ID,
      notebookPath: 'projects/acme/a.md',
      title: 'a'
    })

    await openKnowledgeNote(`projects/../../${base}-user/notes/a.md`)
    expect(sessionService.create).toHaveBeenLastCalledWith({
      projectId: KNOWLEDGE_USER_PROJECT_ID,
      notebookPath: 'notes/a.md',
      title: 'a'
    })

    expect(sessionService.create).toHaveBeenCalledTimes(2)
    for (const [params] of vi.mocked(sessionService.create).mock.calls) {
      expect(params?.notebookPath).not.toContain('..')
    }
  })

  it('KN-13 守门（用户库一侧）：用户根本身 / 用户根下散文件 / 库目录本身 / 隐藏目录（根下、库内、项目库的 .git）/ 越出用户根 —— 一律拒绝，四个 dao / 会话调用都没发生', async () => {
    const bad = [
      'knowledge',
      'knowledge/',
      'knowledge/readme.md',
      'knowledge/notes',
      'knowledge/notes/',
      'knowledge/.trash/a.md',
      'knowledge/../x.md',
      'knowledge/notes/../../x.md',
      'knowledge/../../x.md',
      'knowledge/notes/.trash/a.md',
      'knowledge/notes/sub/.hidden/a.md',
      'projects/acme/.git/a.md'
    ]
    for (const path of bad) {
      await expect(openKnowledgeNote(path), path).rejects.toThrow(/Invalid knowledge path/)
    }
    expect(projectDao.findById).not.toHaveBeenCalled()
    expect(projectDao.insert).not.toHaveBeenCalled()
    expect(sessionDao.findByProjectAndNotebookPath).not.toHaveBeenCalled()
    expect(sessionService.create).not.toHaveBeenCalled()
  })
})

describe('openKnowledgeNote —— 内置库', () => {
  const order = (fn: { mock: { invocationCallOrder: number[] } }): number =>
    fn.mock.invocationCallOrder[0]

  beforeEach(() => {
    // 两版语言都在磁盘上：en 是此刻生效的那一版，zh 用来钉「另一版不属于任何 bundle」
    seedBuiltin(['en', 'zh'])
  })

  it('KN-14 内置库条目挂在 `__knowledge_builtin__` 下：承载项目 path = 当前语言那一版的目录、notebookPath = **库内相对路径**（不含 `builtin/<库名>/`、也不含语言段）；只确保这一个承载项目，另两个不被 ensure 出来', async () => {
    const session = await openKnowledgeNote(BUILTIN_ENTRY)

    // 只问了内置库那一行：项目库 / 用户库的承载项目没被顺手建出来
    expect(vi.mocked(projectDao.findById).mock.calls).toEqual([[KNOWLEDGE_BUILTIN_PROJECT_ID]])
    expect(projectDao.insert).toHaveBeenCalledTimes(1)
    const inserted = vi.mocked(projectDao.insert).mock.calls[0][0]
    expect(inserted).toMatchObject({
      id: KNOWLEDGE_BUILTIN_PROJECT_ID,
      name: KNOWLEDGE_BUILTIN_PROJECT_NAME,
      // 语言那一层就是 bundle 目录：承载项目指的是它，不是库目录、更不是内置根
      path: builtinLangDir('en')
    })
    expect(projectDao.update).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()

    // 查重键与建会话都用库内相对路径
    expect(vi.mocked(sessionDao.findByProjectAndNotebookPath).mock.calls).toEqual([
      [KNOWLEDGE_BUILTIN_PROJECT_ID, 'a.md']
    ])
    expect(sessionService.create).toHaveBeenCalledTimes(1)
    expect(sessionService.create).toHaveBeenCalledWith({
      projectId: KNOWLEDGE_BUILTIN_PROJECT_ID,
      notebookPath: 'a.md',
      title: 'a'
    })
    expect(session).toEqual({
      id: 's-new',
      projectId: KNOWLEDGE_BUILTIN_PROJECT_ID,
      notebookPath: 'a.md',
      title: 'a'
    })
    expect(order(vi.mocked(projectDao.insert))).toBeLessThan(
      order(vi.mocked(sessionService.create))
    )

    // 子目录同理：语言段不进 notebookPath，库内层级原样保留
    await openKnowledgeNote(`${BUILTIN_BUNDLE}/guides/md.md`, ' 文件格式 ')
    expect(sessionService.create).toHaveBeenLastCalledWith({
      projectId: KNOWLEDGE_BUILTIN_PROJECT_ID,
      notebookPath: 'guides/md.md',
      title: '文件格式'
    })
  })

  it('KN-15 复用：同一条内置条目再开回同一条会话，归一写法（前导 "/" / 反斜杠 / "./" + 重复分隔符 + 尾随 "/" / 库内 ".."）都查同一个键；同形的用户库路径 `knowledge/shuvix/a.md` 是另一个承载项目的键，不跨承载项目复用', async () => {
    const existing = {
      id: 's-builtin',
      title: 'a',
      projectId: KNOWLEDGE_BUILTIN_PROJECT_ID,
      parentId: null,
      settings: { notebookPath: 'a.md' },
      createdAt: 1,
      updatedAt: 1
    } as Session
    vi.mocked(sessionDao.findByProjectAndNotebookPath).mockImplementation((projectId, path) =>
      projectId === KNOWLEDGE_BUILTIN_PROJECT_ID && path === 'a.md' ? existing : undefined
    )

    const raws = [
      BUILTIN_ENTRY,
      `/${BUILTIN_ENTRY}`,
      'builtin\\shuvix\\a.md',
      './builtin//shuvix/a.md/',
      'builtin/shuvix/sub/../a.md'
    ]
    for (const raw of raws) {
      expect(await openKnowledgeNote(raw), raw).toBe(existing)
    }
    expect(sessionService.create).not.toHaveBeenCalled()
    expect(vi.mocked(sessionDao.findByProjectAndNotebookPath).mock.calls).toEqual(
      raws.map(() => [KNOWLEDGE_BUILTIN_PROJECT_ID, 'a.md'])
    )

    // 对照：同形的用户库路径（用户根下真有个叫 shuvix 的库时）走用户库的承载项目，键也不同 → 新建
    const created = await openKnowledgeNote(`knowledge/${BUILTIN_BASE}/a.md`)
    expect(sessionDao.findByProjectAndNotebookPath).toHaveBeenLastCalledWith(
      KNOWLEDGE_USER_PROJECT_ID,
      'shuvix/a.md'
    )
    expect(created).not.toBe(existing)
    expect(sessionService.create).toHaveBeenCalledTimes(1)
    expect(sessionService.create).toHaveBeenCalledWith({
      projectId: KNOWLEDGE_USER_PROJECT_ID,
      notebookPath: 'shuvix/a.md',
      title: 'a'
    })
  })

  it('KN-16 守门（内置库一侧）：容器本身 / 容器里的散文件 / 库目录本身 / 越界 / **另一语言那一版** / 隐藏段 —— 一律拒绝，四个 dao / 会话调用都没发生', async () => {
    const bad = [
      // 保留容器名本身不是 bundle（磁盘上根本没有这个目录）
      'builtin',
      'builtin/',
      // 容器里的散文件：库名那一段必须是目录
      'builtin/x.md',
      // 库目录本身（语言那一层之上）不是 bundle
      BUILTIN_BUNDLE,
      `${BUILTIN_BUNDLE}/`,
      // 越界：`..` 被 join 消解后落在内置根之外 / 内置根下的散文件位置
      'builtin/../x.md',
      'builtin/shuvix/../../x.md',
      // **另一语言那一版**：id 里没有语言段，只能靠 `..` 拐过去 —— 生效的只有 en 那一版
      'builtin/shuvix/../zh/a.md',
      // 隐藏段不是库的内容（与扫描口径一致）
      'builtin/shuvix/.trash/a.md',
      'builtin/.hidden/a.md'
    ]
    for (const path of bad) {
      await expect(openKnowledgeNote(path), path).rejects.toThrow(/Invalid knowledge path/)
    }
    expect(projectDao.findById).not.toHaveBeenCalled()
    expect(projectDao.insert).not.toHaveBeenCalled()
    expect(sessionDao.findByProjectAndNotebookPath).not.toHaveBeenCalled()
    expect(sessionService.create).not.toHaveBeenCalled()

    // 拒的是「另一版」而不是「带 `..`」：同一个写法在界面语言是 zh 时落回生效的那一版，照常受理
    state.language = 'zh'
    await openKnowledgeNote('builtin/shuvix/../zh/a.md')
    expect(sessionService.create).toHaveBeenCalledWith({
      projectId: KNOWLEDGE_BUILTIN_PROJECT_ID,
      notebookPath: 'a.md',
      title: 'a'
    })
  })
})

describe('syncKnowledgeBuiltinProject', () => {
  /** 一行内置库的承载项目（path 缺省指向 en 那一版） */
  const builtinRow = (over: Partial<Project> = {}): Project => ({
    id: KNOWLEDGE_BUILTIN_PROJECT_ID,
    name: KNOWLEDGE_BUILTIN_PROJECT_NAME,
    path: builtinLangDir('en'),
    systemPrompt: '',
    settings: {},
    archivedAt: 0,
    createdAt: 100,
    updatedAt: 200,
    ...over
  })

  it('KN-17 (a) 承载项目已存在且内置库恰一个 → path 指向新语言那一版；(b) 承载项目不存在 → 什么都不做（不凭空建，连有几个库都不问）；(c) 不止一个 → 不动并记一笔 warn；(d) 一个都没有 → 不动且不吭声', () => {
    seedBuiltin(['en', 'zh'])

    // (a) 切到 zh 后：只改 path，name 不动、不插行
    vi.mocked(projectDao.findById).mockReturnValue(builtinRow())
    vi.mocked(listBuiltinBundles).mockReturnValue([BUILTIN_BUNDLE])
    state.language = 'zh'
    syncKnowledgeBuiltinProject()
    expect(vi.mocked(projectDao.update).mock.calls).toEqual([
      [KNOWLEDGE_BUILTIN_PROJECT_ID, { path: builtinLangDir('zh') }]
    ])
    expect(projectDao.insert).not.toHaveBeenCalled()
    expect(logSpy.warn).not.toHaveBeenCalled()

    // 同一版语言再同步一次：没有漂移就不写
    vi.clearAllMocks()
    vi.mocked(projectDao.findById).mockReturnValue(builtinRow({ path: builtinLangDir('zh') }))
    vi.mocked(listBuiltinBundles).mockReturnValue([BUILTIN_BUNDLE])
    syncKnowledgeBuiltinProject()
    expect(projectDao.update).not.toHaveBeenCalled()
    expect(projectDao.insert).not.toHaveBeenCalled()

    // (b) 从没打开过内置条目 → 没有这个承载项目：什么都不做，也不必去问磁盘上有几个库
    vi.clearAllMocks()
    vi.mocked(projectDao.findById).mockReturnValue(undefined)
    vi.mocked(listBuiltinBundles).mockReturnValue([BUILTIN_BUNDLE])
    syncKnowledgeBuiltinProject()
    expect(projectDao.findById).toHaveBeenCalledWith(KNOWLEDGE_BUILTIN_PROJECT_ID)
    expect(listBuiltinBundles).not.toHaveBeenCalled()
    expect(projectDao.insert).not.toHaveBeenCalled()
    expect(projectDao.update).not.toHaveBeenCalled()
    expect(logSpy.warn).not.toHaveBeenCalled()

    // (c1) 不止一个内置库：一个承载项目只服务一个库 —— 宁可让那一行继续指着旧语言那一版
    // （下面 findById 给的就是 zh 那一版，而界面语言已经是 en），也不让「最后一个赢」悄悄发生
    vi.clearAllMocks()
    state.language = 'en'
    vi.mocked(projectDao.findById).mockReturnValue(builtinRow({ path: builtinLangDir('zh') }))
    vi.mocked(listBuiltinBundles).mockReturnValue([BUILTIN_BUNDLE, 'builtin/other'])
    syncKnowledgeBuiltinProject()
    expect(projectDao.update).not.toHaveBeenCalled()
    expect(projectDao.insert).not.toHaveBeenCalled()
    expect(logSpy.warn).toHaveBeenCalledTimes(1)
    expect(vi.mocked(logSpy.warn).mock.calls[0][0]).toMatch(/one carrier serves one base.*found 2/)

    // (d) 一个都没有（资源没发到位、或这个库只发了别的语言）：同样不动，但**不吭声** ——
    // 没什么可指的不是故障，承载项目留在原处就是此刻最好的结果；每切一次语言报一行警告只是噪音
    vi.clearAllMocks()
    vi.mocked(projectDao.findById).mockReturnValue(builtinRow({ path: builtinLangDir('zh') }))
    vi.mocked(listBuiltinBundles).mockReturnValue([])
    syncKnowledgeBuiltinProject()
    expect(projectDao.update).not.toHaveBeenCalled()
    expect(projectDao.insert).not.toHaveBeenCalled()
    expect(logSpy.warn).not.toHaveBeenCalled()
  })

  it('KN-18 切语言后已开的笔记本会话 id 与 notebookPath 一字不改，变的只有承载项目的 path —— 各语言版本同名同路径，同一条会话下一次读文件就落到新目录', async () => {
    seedBuiltin(['en', 'zh'])

    // 承载项目的极小替身：update 落回行上，好让「path 此刻指向哪一版」在下一次 findById 看得见
    let carrier: Project | undefined
    vi.mocked(projectDao.findById).mockImplementation((id) =>
      id === KNOWLEDGE_BUILTIN_PROJECT_ID ? carrier : undefined
    )
    vi.mocked(projectDao.insert).mockImplementation((project) => {
      carrier = project
    })
    vi.mocked(projectDao.update).mockImplementation((id, fields) => {
      if (carrier && id === carrier.id) carrier = { ...carrier, ...fields }
    })
    // 每次建会话给一个新 id：万一切语言后又建了一条，「id 一字不改」才看得出来
    let seq = 0
    vi.mocked(sessionService.create).mockImplementation(
      (params) => ({ id: `s-${++seq}`, ...params }) as unknown as Session
    )

    // 1) en 那一版下打开：会话建在库内相对路径上
    const opened = await openKnowledgeNote(BUILTIN_ENTRY)
    expect(carrier?.path).toBe(builtinLangDir('en'))
    expect(opened).toMatchObject({
      id: 's-1',
      projectId: KNOWLEDGE_BUILTIN_PROJECT_ID,
      notebookPath: 'a.md'
    })

    // 这条会话此后查得到
    const existing = { ...opened } as Session
    vi.mocked(sessionDao.findByProjectAndNotebookPath).mockImplementation((projectId, path) =>
      projectId === KNOWLEDGE_BUILTIN_PROJECT_ID && path === 'a.md' ? existing : undefined
    )

    // 2) 切语言：sync 只改承载项目的 path，会话一行都不碰
    state.language = 'zh'
    vi.mocked(listBuiltinBundles).mockReturnValue([BUILTIN_BUNDLE])
    vi.mocked(sessionService.create).mockClear()
    vi.mocked(sessionDao.findByProjectAndNotebookPath).mockClear()
    syncKnowledgeBuiltinProject()
    expect(carrier?.path).toBe(builtinLangDir('zh'))
    expect(sessionDao.findByProjectAndNotebookPath).not.toHaveBeenCalled()
    expect(sessionService.create).not.toHaveBeenCalled()

    // 3) 同一条路径再开：还是那条会话，id 与 notebookPath 一字不改；path 已经是新语言，不再漂移
    vi.mocked(projectDao.update).mockClear()
    const again = await openKnowledgeNote(BUILTIN_ENTRY)
    expect(again).toBe(existing)
    expect(again.id).toBe(opened.id)
    expect(vi.mocked(sessionDao.findByProjectAndNotebookPath).mock.calls).toEqual([
      [KNOWLEDGE_BUILTIN_PROJECT_ID, 'a.md']
    ])
    expect(sessionService.create).not.toHaveBeenCalled()
    expect(projectDao.update).not.toHaveBeenCalled()
    expect(carrier?.path).toBe(builtinLangDir('zh'))
  })
})
