/**
 * sessionBundle —— 会话 → 目标 bundle。本期只有一条规则：**根会话所属项目的那一个**。
 * 钉：`create` 为真时懒建（真的建出目录 + 绑定概念 + 仓库）、为假时只解析；两条「没有目标」
 * 的软失败各回一句可读的话而不是抛错 —— 工具把它当软条件，文案会原样出现在 agent 面前。
 *
 * dao 是替身（这里不验 SQL），bundles / 投影 / git 用真的：会话这一侧要证明的正是
 * 「解析出来的 bundle 就是宿主真会建出来的那一个」。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
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
import { sessionBundle } from '../sessionBundle'
import { flushKnowledgeCommits } from '../repo'
import { invalidateKnowledgeScan } from '../scan'
import { PROJECTS, bundleAt, fileAt, gitCommitCount, makeTempRoot } from './fixture'

const NO_PROJECT =
  'This session does not belong to a project, and the knowledge base is per project — open the session inside a project first.'

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
