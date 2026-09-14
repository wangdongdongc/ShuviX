/**
 * knowledgeNotes —— 侧栏「知识库」分组点行的后端：两个隐藏承载项目（项目库 KNOWLEDGE_PROJECT_ID，
 * path = **shuvix 根**；用户库 KNOWLEDGE_USER_PROJECT_ID，path = **用户根**）按需插入、历史行漂移自愈；
 * 笔记本会话按归一后的根相对路径一文件一会话复用（用户库的 notebookPath 去掉首段 `knowledge/`，两个
 * 承载项目之间不复用）；**落不进任何 bundle 的路径在碰任何东西之前就被拒绝** —— 根下的散文件、
 * 容器里的散文件、bundle 目录本身、隐藏目录、越界路径与空路径都不是条目。
 *
 * dao / sessionService 是替身；services/knowledge 只替到接口那一层：路径相关的导出转发**真的**
 * knowledgePaths（它只依赖 utils/paths，不会拖进扫描 / git / okf-minisearch），
 * 好让「什么路径算数」「按什么键查重」这两条语义真的被验证。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { KNOWLEDGE_PROJECT_ID, KNOWLEDGE_USER_PROJECT_ID } from '@shuvix/chat-protocol/knowledge'
import type { Project, Session } from '../../types'

const state = vi.hoisted(() => ({ root: '' }))

vi.mock('../../utils/paths', () => ({
  getShuvixKnowledgeRootDir: () => state.root,
  getUserKnowledgeRootDir: () => `${state.root}-user`
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
    locateBundle: real.locateBundle,
    USER_CONTAINER: real.USER_CONTAINER
  }
})

import { projectDao } from '../../dao/projectDao'
import { sessionDao } from '../../dao/sessionDao'
import { appEventBus } from '../../utils/appEventBus'
import { sessionService } from '../sessionService'
import {
  ensureKnowledgeProject,
  ensureKnowledgeUserProject,
  openKnowledgeNote
} from '../knowledgeNotes'

const publish = vi.spyOn(appEventBus, 'publish')

const KNOWLEDGE_PROJECT_NAME = '知识库'
const ENTRY = 'projects/acme/a.md'

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
  vi.mocked(projectDao.findById).mockReturnValue(undefined)
  vi.mocked(sessionDao.findByProjectAndNotebookPath).mockReturnValue(undefined)
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
