/**
 * knowledgeNotes —— 侧栏「知识库」分组点行的后端：隐藏承载项目（id = KNOWLEDGE_PROJECT_ID，
 * path = **shuvix 根**）按需插入、历史行漂移自愈；笔记本会话按归一后的根相对路径一文件一会话
 * 复用；**落不进任何 bundle 的路径在碰任何东西之前就被拒绝** —— 根下的散文件、容器里的散文件、
 * bundle 目录本身、越界路径与空路径都不是条目。
 *
 * dao / sessionService 是替身；services/knowledge 只替到接口那一层：三个导出转发**真的**
 * knowledgePaths（它只依赖 utils/paths，不会拖进扫描 / git / okf-minisearch），
 * 好让「什么路径算数」「按什么键查重」这两条语义真的被验证。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KNOWLEDGE_PROJECT_ID } from '@shuvix/chat-protocol/knowledge'
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
    bundleFilePath: real.bundleFilePath,
    locateBundle: real.locateBundle
  }
})

import { projectDao } from '../../dao/projectDao'
import { sessionDao } from '../../dao/sessionDao'
import { appEventBus } from '../../utils/appEventBus'
import { sessionService } from '../sessionService'
import { ensureKnowledgeProject, openKnowledgeNote } from '../knowledgeNotes'

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
