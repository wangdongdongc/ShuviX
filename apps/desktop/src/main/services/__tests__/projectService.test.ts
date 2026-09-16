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
  projectDao: {
    findAllActive: vi.fn(),
    findAllArchived: vi.fn(),
    findById: vi.fn(),
    pick: vi.fn(),
    insert: vi.fn(),
    update: vi.fn()
  }
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

/**
 * `settings` 里的三样东西（扩展能力 / 知识库 / 工具设置）由**不同界面分别保存**：项目编辑弹窗
 * 只在用户动过知识库时才把它带上（`kbTouched`），环境变量那半截又只写 `tool`。所以 `update`
 * 必须是**按键合并**而不是整份覆盖 —— 覆盖的话，一次「只改知识库」的保存会把项目的扩展能力与
 * 环境变量一并抹掉。`create` 那侧则要区分「给了空数组」（明确选了一个库都不要）与「没给」
 * （这个项目还没选过，会话跟着缺省走）。
 */
describe('projectService — settings 合并（PS-3 / PS-4）', () => {
  /** projectDao.update 收到的 patch */
  const patch = (): Record<string, unknown> =>
    vi.mocked(projectDao.update).mock.calls.at(-1)![1] as unknown as Record<string, unknown>

  it('PS-3 update 的 settings 是合并不是覆盖：只传知识库，扩展能力与工具设置原样留着', () => {
    const existing = {
      enabledTools: ['skill:a'],
      tool: { envVars: [{ key: 'K', value: 'v' }] }
    }
    vi.mocked(projectDao.pick).mockReturnValue({ settings: existing } as never)

    projectService.update('p1', { knowledgeBases: ['notes'] })
    expect(patch().settings).toEqual({ ...existing, knowledgeBases: ['notes'] })

    // 不传就不动：这个项目继续跟着缺省走（弹窗没动过知识库时就是这一条）
    projectService.update('p1', { enabledTools: ['skill:b'] })
    expect(patch().settings).toEqual({ ...existing, enabledTools: ['skill:b'] })
    expect('knowledgeBases' in (patch().settings as object)).toBe(false)

    // 传空数组照写（明确选了「一个库都不用」，不是「没意见」）
    projectService.update('p1', { knowledgeBases: [] })
    expect((patch().settings as { knowledgeBases: string[] }).knowledgeBases).toEqual([])
  })

  it('PS-4 create 带 knowledgeBases（含空数组）落进 settings；不带则该键不存在', () => {
    const inserted = (): Record<string, unknown> =>
      (vi.mocked(projectDao.insert).mock.calls.at(-1)![0] as unknown as { settings: object })
        .settings as Record<string, unknown>

    projectService.create({ path: '/tmp/shuvix-unit/p-a', knowledgeBases: ['notes', 'project'] })
    expect(inserted().knowledgeBases).toEqual(['notes', 'project'])

    projectService.create({ path: '/tmp/shuvix-unit/p-b', knowledgeBases: [] })
    expect('knowledgeBases' in inserted()).toBe(true)
    expect(inserted().knowledgeBases).toEqual([])

    projectService.create({ path: '/tmp/shuvix-unit/p-c' })
    expect('knowledgeBases' in inserted()).toBe(false)
  })
})
