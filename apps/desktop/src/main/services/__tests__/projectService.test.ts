/**
 * projectService —— 隐藏项目的过滤口径。旧 wiki（`__wiki__`）与知识库 v2（`__knowledge__`）
 * 都是只承载笔记本会话的隐藏项目：list / listArchived 不能把它们露到项目列表里，但 getById
 * 不过滤 —— 它们的会话要能正常解析出所属项目。只 mock projectDao；id 取契约常量而非字面量，
 * 常量改了这里跟着改，字面量会让测试在过滤失效时还绿着。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { WIKI_PROJECT_ID } from '@shuvix/chat-protocol/wiki'
import { KNOWLEDGE_PROJECT_ID } from '@shuvix/chat-protocol/knowledge'
import type { Project } from '../../types'

vi.mock('../../dao/projectDao', () => ({
  projectDao: { findAllActive: vi.fn(), findAllArchived: vi.fn(), findById: vi.fn() }
}))

import { projectDao } from '../../dao/projectDao'
import { projectService } from '../projectService'

const project = (id: string, over: Partial<Project> = {}): Project => ({
  id,
  name: id,
  path: `/p/${id}`,
  systemPrompt: '',
  settings: {},
  archivedAt: 0,
  createdAt: 1,
  updatedAt: 1,
  ...over
})

beforeEach(() => {
  vi.clearAllMocks()
})

describe('projectService — 隐藏项目', () => {
  it('PS-1 list / listArchived 隐去 wiki 与知识库两个隐藏项目，其余保持 dao 的顺序', () => {
    const p1 = project('p1')
    const p2 = project('p2')
    const p3 = project('p3', { archivedAt: 5 })
    const wiki = project(WIKI_PROJECT_ID)
    const knowledge = project(KNOWLEDGE_PROJECT_ID, { archivedAt: 5 })
    vi.mocked(projectDao.findAllActive).mockReturnValue([p1, wiki, p2, knowledge])
    vi.mocked(projectDao.findAllArchived).mockReturnValue([knowledge, p3, wiki])

    expect(projectService.list()).toEqual([p1, p2])
    expect(projectService.listArchived()).toEqual([p3])
  })

  it('PS-2 getById 不过滤：隐藏项目照常返回；未知 id → undefined', () => {
    const wiki = project(WIKI_PROJECT_ID)
    const knowledge = project(KNOWLEDGE_PROJECT_ID)
    const rows: Record<string, Project> = {
      [WIKI_PROJECT_ID]: wiki,
      [KNOWLEDGE_PROJECT_ID]: knowledge
    }
    vi.mocked(projectDao.findById).mockImplementation((id) => rows[id])

    expect(projectService.getById(KNOWLEDGE_PROJECT_ID)).toBe(knowledge)
    expect(projectService.getById(WIKI_PROJECT_ID)).toBe(wiki)
    expect(projectService.getById('nope')).toBeUndefined()
    expect(projectDao.findById).toHaveBeenCalledWith('nope')
  })
})
