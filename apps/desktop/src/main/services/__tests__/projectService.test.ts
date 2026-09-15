/**
 * projectService —— 隐藏项目的过滤口径。只承载笔记本会话的隐藏项目有六个：旧 wiki（`__wiki__`）、
 * 知识库 v2（`__knowledge__`），以及 bot / agent / 安全策略 / hook 四个注册表目录
 * （`REGISTRY_NOTE_PROJECT_IDS` —— 打开一份注册表 md，就是打开挂在它下面的笔记本会话）。
 * list / listArchived 不能把它们露到项目列表里，但 getById 不过滤 —— 它们的会话要能正常解析出
 * 所属项目。只 mock projectDao；id 取契约常量而非字面量，常量改了这里跟着改，字面量会让测试在
 * 过滤失效时还绿着。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { WIKI_PROJECT_ID } from '@shuvix/chat-protocol/wiki'
import { KNOWLEDGE_PROJECT_ID } from '@shuvix/chat-protocol/knowledge'
import { REGISTRY_NOTE_PROJECT_IDS } from '@shuvix/chat-protocol/registryNotes'
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
  it('PS-1 list / listArchived 隐去 wiki、知识库与四个注册表目录的隐藏项目（排在头、中、尾都一样），其余保持 dao 的顺序', () => {
    // 漏认一个注册表 id，第一次打开那一类 md 之后，项目列表里就多出一个叫 Bots / Agents 的项目
    const p1 = project('p1')
    const p2 = project('p2')
    const p3 = project('p3', { archivedAt: 5 })
    const wiki = project(WIKI_PROJECT_ID)
    const knowledge = project(KNOWLEDGE_PROJECT_ID, { archivedAt: 5 })
    const bots = project(REGISTRY_NOTE_PROJECT_IDS.bot)
    const agents = project(REGISTRY_NOTE_PROJECT_IDS.agent)
    const policies = project(REGISTRY_NOTE_PROJECT_IDS.policy, { archivedAt: 5 })
    const hooks = project(REGISTRY_NOTE_PROJECT_IDS.hook)
    vi.mocked(projectDao.findAllActive).mockReturnValue([
      bots,
      p1,
      wiki,
      agents,
      p2,
      policies,
      knowledge,
      hooks
    ])
    vi.mocked(projectDao.findAllArchived).mockReturnValue([
      knowledge,
      hooks,
      p3,
      bots,
      policies,
      wiki,
      agents
    ])

    expect(projectService.list()).toEqual([p1, p2])
    expect(projectService.listArchived()).toEqual([p3])
  })

  it('PS-2 getById 不过滤：wiki、知识库与四个注册表目录的隐藏项目照常返回；未知 id → undefined', () => {
    // 渲染端按 id 取项目行来认它的会话；隐藏只是「不进列表」，不是「查不到」
    const hidden = [
      WIKI_PROJECT_ID,
      KNOWLEDGE_PROJECT_ID,
      ...Object.values(REGISTRY_NOTE_PROJECT_IDS)
    ].map((id) => project(id))
    const rows: Record<string, Project> = Object.fromEntries(hidden.map((p) => [p.id, p]))
    vi.mocked(projectDao.findById).mockImplementation((id) => rows[id])

    for (const row of hidden) expect(projectService.getById(row.id), row.id).toBe(row)
    expect(projectService.getById('nope')).toBeUndefined()
    expect(projectDao.findById).toHaveBeenCalledWith('nope')
  })
})
