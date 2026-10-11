/**
 * mentionEntries —— 聊天输入框 `@` 引用「知识库」源的候选清单。口径与 knowledge 工具同一份
 * （enabledTargets）：项目会话的**隐式项目库**打头，其余是用户圈定且真在的库，按选择的顺序；
 * 每条带上发给 agent 的指针（`baseName` + `bundlePath`）与所属库的显示名。清单只读，不建任何东西。
 *
 * dao 是替身，路径与目录清单、扫描（ripgrep）用真的。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
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
vi.mock('i18next', () => ({
  default: { language: 'en', t: (key: string) => `i18n(${key})` }
}))
vi.mock('../../../dao/projectDao', () => ({ projectDao: { findById: vi.fn(), pick: vi.fn() } }))
vi.mock('../../../dao/sessionDao', () => ({
  sessionDao: { pick: vi.fn(), updateSettings: vi.fn() }
}))

import { projectDao } from '../../../dao/projectDao'
import { sessionDao } from '../../../dao/sessionDao'
import { listKnowledgeMentionEntries } from '../mentionEntries'
import { invalidateKnowledgeScan } from '../scan'
import { PROJECTS, builtinRootOf, makeTempRoot, seedConcept, userRootOf } from './fixture'

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
const sessions = new Map<string, Record<string, unknown>>()

const session = (row: Record<string, unknown>): void => {
  sessions.clear()
  sessions.set('s1', row)
}

/** 种一条概念（title / description 都给，断言时看得见） */
const seedEntry = (base: string, rel: string, title: string, description = ''): void => {
  seedConcept(base, rel, [
    'type: Memory',
    `title: ${title}`,
    ...(description ? [`description: ${description}`] : [])
  ])
}

beforeEach(() => {
  vi.clearAllMocks()
  sessions.clear()
  vi.mocked(sessionDao.pick).mockImplementation(((id: string) =>
    sessions.get(id)) as unknown as typeof sessionDao.pick)
  vi.mocked(projectDao.pick).mockReturnValue(undefined)
  vi.mocked(projectDao.findById).mockReturnValue(PROJECT)
  root = makeTempRoot()
  state.root = root
  invalidateKnowledgeScan()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(userRootOf(root), { recursive: true, force: true })
  rmSync(builtinRootOf(root), { recursive: true, force: true })
})

describe('listKnowledgeMentionEntries', () => {
  it('ME-1 项目库的条目打头（baseName project、显示名是项目名、路径用共享 id 空间），其后是用户勾的库', async () => {
    seedEntry(root, 'projects/p1/b.md', 'Bee', 'second')
    seedEntry(root, 'projects/p1/a.md', 'Ay', 'first')
    seedEntry(userRootOf(root), 'kb-a/x.md', 'Ex')
    session({ projectId: 'p1', settings: { knowledgeBases: ['kb-a'] } })

    expect(await listKnowledgeMentionEntries('s1')).toEqual([
      {
        path: 'projects/p1/a.md',
        baseName: 'project',
        bundlePath: '/a.md',
        title: 'Ay',
        description: 'first',
        bundleLabel: 'Acme Corp'
      },
      {
        path: 'projects/p1/b.md',
        baseName: 'project',
        bundlePath: '/b.md',
        title: 'Bee',
        description: 'second',
        bundleLabel: 'Acme Corp'
      },
      {
        path: 'knowledge/kb-a/x.md',
        baseName: 'kb-a',
        bundlePath: '/x.md',
        title: 'Ex',
        description: '',
        bundleLabel: 'kb-a'
      }
    ])
  })

  it('ME-2 项目会话谁都没勾：只有项目库的条目（用户库在磁盘上也不进来）', async () => {
    seedEntry(root, 'projects/p1/a.md', 'Ay')
    seedEntry(userRootOf(root), 'kb-a/x.md', 'Ex')
    session({ projectId: 'p1' })

    const entries = await listKnowledgeMentionEntries('s1')
    expect(entries.map((e) => [e.baseName, e.path])).toEqual([['project', 'projects/p1/a.md']])
  })

  it('ME-3 项目库目录还不存在：空清单，且不把它建出来', async () => {
    session({ projectId: 'p1' })

    expect(await listKnowledgeMentionEntries('s1')).toEqual([])
    expect(existsSync(join(root, PROJECTS))).toBe(false)
  })

  it('ME-4 不属于项目的会话：没有项目库；存量选择里的 project 剔掉，只剩用户库', async () => {
    seedEntry(root, 'projects/p1/a.md', 'Ay')
    seedEntry(userRootOf(root), 'kb-a/x.md', 'Ex')

    session({ projectId: null })
    expect(await listKnowledgeMentionEntries('s1')).toEqual([])

    session({ projectId: null, settings: { knowledgeBases: ['project', 'kb-a'] } })
    const entries = await listKnowledgeMentionEntries('s1')
    expect(entries.map((e) => [e.baseName, e.path])).toEqual([['kb-a', 'knowledge/kb-a/x.md']])
  })

  it('ME-5 项目名为空白时显示名退回 `project`', async () => {
    seedEntry(root, 'projects/p1/a.md', 'Ay')
    vi.mocked(projectDao.findById).mockReturnValue({ ...PROJECT, name: '   ' })
    session({ projectId: 'p1' })

    const entries = await listKnowledgeMentionEntries('s1')
    expect(entries.map((e) => [e.baseName, e.bundleLabel])).toEqual([['project', 'project']])
  })

  it('ME-6 隐藏载体项目不算项目：笔记本会话的 `@` 清单里没有项目库', async () => {
    seedEntry(root, 'projects/__agents__/a.md', 'Ay')
    vi.mocked(projectDao.findById).mockReturnValue({ ...PROJECT, id: '__agents__' })
    session({ projectId: '__agents__' })

    expect(await listKnowledgeMentionEntries('s1')).toEqual([])
  })
})
