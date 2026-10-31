/**
 * projectService —— 隐藏项目的过滤口径。只承载笔记本会话的隐藏项目有六个：旧 wiki（`__wiki__`）、
 * 知识库 v2（`__knowledge__`），以及 bot / agent / 安全策略 / hook 四个注册表目录
 * （`REGISTRY_NOTE_PROJECT_IDS` —— 打开一份注册表 md，就是打开挂在它下面的笔记本会话）。
 * list / listArchived 不能把它们露到项目列表里，但 getById 不过滤 —— 它们的会话要能正常解析出
 * 所属项目。只 mock projectDao；id 取契约常量而非字面量，常量改了这里跟着改，字面量会让测试在
 * 过滤失效时还绿着。
 *
 * PH-2（文件末尾）：改项目路径时，引用它当工作位置的 bot 会话的路径快照跟着搬。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { KNOWLEDGE_PROJECT_ID, KNOWLEDGE_USER_PROJECT_ID } from '@shuvix/chat-protocol/knowledge'
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
// 改路径时要扫引用这个项目的 bot 会话（路径快照跟着搬）：会话行桩掉，免得拉起数据库
vi.mock('../sessionRecords', () => ({
  sessionRecords: { findAll: vi.fn(() => []), updateSettings: vi.fn() }
}))

import { projectDao } from '../../dao/projectDao'
import { sessionRecords } from '../sessionRecords'
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
  it('PS-1 list / listArchived 隐去知识库与四个注册表目录的隐藏项目（排在头、中、尾都一样），其余保持 dao 的顺序', () => {
    // 漏认一个注册表 id，第一次打开那一类 md 之后，项目列表里就多出一个叫 Bots / Agents 的项目
    const p1 = project('p1')
    const p2 = project('p2')
    const p3 = project('p3', { archivedAt: 5 })
    const userKnowledge = project(KNOWLEDGE_USER_PROJECT_ID)
    const knowledge = project(KNOWLEDGE_PROJECT_ID, { archivedAt: 5 })
    const bots = project(REGISTRY_NOTE_PROJECT_IDS.bot)
    const agents = project(REGISTRY_NOTE_PROJECT_IDS.agent)
    const policies = project(REGISTRY_NOTE_PROJECT_IDS.policy, { archivedAt: 5 })
    const hooks = project(REGISTRY_NOTE_PROJECT_IDS.hook)
    vi.mocked(projectDao.findAllActive).mockReturnValue([
      bots,
      p1,
      userKnowledge,
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
      userKnowledge,
      agents
    ])

    expect(projectService.list()).toEqual([p1, p2])
    expect(projectService.listArchived()).toEqual([p3])
  })

  it('PS-2 getById 不过滤：知识库与四个注册表目录的隐藏项目照常返回；未知 id → undefined', () => {
    // 渲染端按 id 取项目行来认它的会话；隐藏只是「不进列表」，不是「查不到」
    const hidden = [
      KNOWLEDGE_PROJECT_ID,
      KNOWLEDGE_USER_PROJECT_ID,
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
describe('projectService — 按名字找项目（bot 触发绑定的 project 键）', () => {
  it('PN-1 projectsNamed：去掉两头空白、不分大小写，只看没归档的、不含隐藏项目；同名几个回几个', () => {
    const tiny = project('p1', { name: 'tiny-cli' })
    const tinyUpper = project('p2', { name: ' Tiny-CLI ' })
    const other = project('p3', { name: 'tiny-cli-2' })
    const hidden = project(REGISTRY_NOTE_PROJECT_IDS.bot, { name: 'tiny-cli' })
    vi.mocked(projectDao.findAllActive).mockReturnValue([tiny, other, hidden, tinyUpper])
    vi.mocked(projectDao.findAllArchived).mockReturnValue([project('p4', { name: 'archived', archivedAt: 5 })])

    expect(projectService.projectsNamed('TINY-cli ')).toEqual([tiny, tinyUpper])
    expect(projectService.projectsNamed('tiny-cli-2')).toEqual([other])
    expect(projectService.projectsNamed('archived')).toEqual([])
    expect(projectService.projectsNamed('nope')).toEqual([])
  })
})

describe('projectService — settings 合并（PS-3 / PS-4）', () => {
  /** projectDao.update 收到的 patch */
  const patch = (): Record<string, unknown> =>
    vi.mocked(projectDao.update).mock.calls.at(-1)![1] as unknown as Record<string, unknown>

  it('PS-3 update 的 settings 是合并不是覆盖：只传知识库，扩展能力与工具设置原样留着', () => {
    const existing = {
      enabledTools: ['mcp:a'],
      tool: { envVars: [{ key: 'K', value: 'v' }] }
    }
    vi.mocked(projectDao.pick).mockReturnValue({ settings: existing } as never)

    projectService.update('p1', { knowledgeBases: ['notes'] })
    expect(patch().settings).toEqual({ ...existing, knowledgeBases: ['notes'] })

    // 不传就不动：这个项目继续跟着缺省走（弹窗没动过知识库时就是这一条）
    projectService.update('p1', { enabledTools: ['mcp:b'] })
    expect(patch().settings).toEqual({ ...existing, enabledTools: ['mcp:b'] })
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

/**
 * PH-2：bot 会话只归属 bot，引用一个项目当工作位置（`settings.workProject`）时另记一份项目路径的快照
 * （`settings.workingDirectory`）—— 项目被删时退回那里。项目改了路径，快照跟着搬，否则删项目之后它退回一个已经
 * 不在的旧路径。只改引用**这个**项目、快照与新路径不同的那几条；成员会话不带快照，不碰。
 */
describe('projectService — 改路径时引用它的会话的路径快照跟着搬（PH-2）', () => {
  type Row = { id: string; projectId: string | null; settings: Record<string, unknown> }
  const seed = (rows: Row[]): void => {
    vi.mocked(sessionRecords.findAll).mockReturnValue(rows as never)
  }
  const rewrites = (): unknown[][] => vi.mocked(sessionRecords.updateSettings).mock.calls

  it('PH-2 只改引用 p1、快照与新路径不同的会话；新路径按 resolve 规范化后写', () => {
    seed([
      {
        id: 'bot',
        projectId: null,
        settings: { bot: 'scout', workProject: 'p1', workingDirectory: '/old' }
      },
      { id: 'child', projectId: null, settings: { workProject: ' p1 ', workingDirectory: '/old' } },
      { id: 'no-snap', projectId: null, settings: { bot: 'scout', workProject: 'p1' } },
      { id: 'same', projectId: null, settings: { workProject: 'p1', workingDirectory: '/new/p1' } },
      { id: 'member', projectId: 'p1', settings: { enabledTools: [] } },
      { id: 'other', projectId: null, settings: { workProject: 'p2', workingDirectory: '/old' } },
      { id: 'blank', projectId: null, settings: { workProject: '  ', workingDirectory: '/old' } },
      { id: 'temp', projectId: null, settings: { workingDirectory: '/old' } }
    ])

    projectService.update('p1', { path: '/new/./p1/' })

    expect(vi.mocked(projectDao.update).mock.calls.at(-1)![1]).toEqual({ path: '/new/p1' })
    expect(rewrites()).toEqual([
      ['bot', { workingDirectory: '/new/p1' }],
      ['child', { workingDirectory: '/new/p1' }],
      ['no-snap', { workingDirectory: '/new/p1' }]
    ])
  })

  it('PH-2 不改路径就不扫会话', () => {
    seed([
      { id: 'bot', projectId: null, settings: { workProject: 'p1', workingDirectory: '/old' } }
    ])
    projectService.update('p1', { name: 'Renamed', systemPrompt: 'x', knowledgeBases: [] })
    expect(sessionRecords.findAll).not.toHaveBeenCalled()
    expect(sessionRecords.updateSettings).not.toHaveBeenCalled()
  })
})
