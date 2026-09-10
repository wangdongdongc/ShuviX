/**
 * inject —— `<knowledge>` 围栏的桌面接线（createAgent 的 resolveKnowledge seam）：
 * pinned = 本会话作用域里 shuvix_pinned 的非 deprecated 条目；索引 = 项目 → 全局 → bot →
 * 最近 5 条会话摘要（不含 deprecated 与绑定概念）；wiki 只给主题计数；旧项目记忆只读列出（D3）。
 * 根目录不存在也返回围栏（零条目时表头 + 写入段仍在）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Project } from '../../../dao/types/project'

const state = vi.hoisted(() => ({
  root: '',
  memoryRoot: '',
  sessions: {} as Record<
    string,
    { projectId?: string | null; settings?: { bot?: string } } | undefined
  >,
  projects: {} as Record<string, unknown>,
  memories: [] as Array<Record<string, unknown>>,
  scanned: [] as string[]
}))

vi.mock('../../../utils/paths', () => ({
  getKnowledgeRootDir: () => state.root,
  getProjectMemoryDir: (id: string) => `${state.memoryRoot}/${id}`,
  listKnowledgeSessionDirs: () => []
}))
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('../../../dao/projectDao', () => ({
  projectDao: { findById: (id: string) => state.projects[id] }
}))
vi.mock('../../../dao/sessionDao', () => ({
  sessionDao: { pick: (id: string) => state.sessions[id] }
}))
vi.mock('../../memory', () => ({
  scanProjectMemories: (projectId: string) => {
    state.scanned.push(projectId)
    return state.memories
  }
}))

import { resolveKnowledgeFence } from '../inject'
import { invalidateKnowledgeScan } from '../scan'
import { makeTempRoot, seedConcept, seedFile } from './fixture'

const acme: Project = {
  id: 'p1',
  name: 'Acme Corp',
  path: '/w/acme',
  systemPrompt: '',
  settings: {},
  archivedAt: 0,
  createdAt: 0,
  updatedAt: 0
}

let parent: string
let root: string

beforeEach(() => {
  parent = makeTempRoot()
  root = join(parent, 'kb')
  state.root = root
  state.memoryRoot = join(parent, 'memory')
  state.projects = { p1: acme }
  state.sessions = { s1: { projectId: 'p1', settings: { bot: 'alice' } }, s0: {} }
  state.memories = []
  state.scanned = []
  invalidateKnowledgeScan()
})

afterEach(() => {
  rmSync(parent, { recursive: true, force: true })
})

/** 某一节的正文（到下一个 `## ` 为止） */
const section = (text: string, heading: string): string => {
  const start = text.indexOf(heading)
  if (start < 0) return ''
  const next = text.indexOf('\n## ', start + heading.length)
  return next < 0 ? text.slice(start) : text.slice(start, next)
}

/** `## Index` 节里各行的路径（`- /path …` 的第二个词） */
const indexPaths = (text: string): string[] =>
  section(text, '## Index')
    .split('\n')
    .filter((l) => l.startsWith('- '))
    .map((l) => l.split(' ')[1])

function seedBundle(): void {
  seedConcept(
    root,
    'global/g-pin.md',
    ['type: Memory', 'title: Pin', 'description: dpin', 'shuvix_pinned: true'],
    'Always two spaces.'
  )
  seedConcept(root, 'global/g1.md', ['type: Memory', 'title: G1', 'description: dg1'])
  seedConcept(root, 'global/g-dep.md', [
    'type: Memory',
    'title: Gone',
    'description: dgone',
    'status: deprecated'
  ])
  seedConcept(root, 'projects/acme/project.md', [
    'type: Project',
    'title: Acme Corp',
    'description: binds',
    'resource: shuvix://project/p1'
  ])
  seedConcept(root, 'projects/acme/p1.md', ['type: Memory', 'title: P1', 'description: dp1'])
  seedConcept(root, 'projects/acme/p-dep.md', [
    'type: Memory',
    'title: PDep',
    'description: dpdep',
    'status: deprecated',
    'shuvix_pinned: true'
  ])
  for (let i = 1; i <= 7; i++) {
    seedConcept(root, `projects/acme/sessions/s${i}.md`, [
      'type: Session Summary',
      `title: S${i}`,
      `description: ds${i}`,
      'status: draft',
      `generated: { by: g, at: "2026-09-0${i}T00:00:00Z" }`
    ])
  }
  seedConcept(root, 'bots/alice/bot.md', [
    'type: Bot',
    'title: alice',
    'description: binds',
    'resource: shuvix://bot/alice'
  ])
  seedConcept(root, 'bots/alice/b1.md', ['type: Memory', 'title: B1', 'description: db1'])
  seedConcept(root, 'wiki/auth/a.md', ['type: Concept', 'title: WA', 'description: dwa'])
  seedConcept(root, 'wiki/auth/b.md', ['type: Concept', 'title: WB', 'description: dwb'])
  seedConcept(root, 'wiki/infra/c.md', ['type: Concept', 'title: WC', 'description: dwc'])
  seedFile(root, 'wiki/index.md', '## Sections\n\n* [auth](auth/index.md)\n')
}

describe('resolveKnowledgeFence', () => {
  it('IJ-1 挑选规则：pinned 只取本会话作用域里的非 deprecated；索引 项目 → 全局 → bot → 最近 5 条摘要；绑定概念与 deprecated 不进；wiki 只给主题计数；表头列出作用域目录', async () => {
    seedBundle()
    const fence = (await resolveKnowledgeFence('s1', { tools: ['knowledge'] }))!
    expect(fence).toContain(
      'Scopes in this session: global (/global), project "Acme Corp" (/projects/acme), bot "alice" (/bots/alice), session summaries (/projects/acme/sessions).'
    )

    const always = section(fence, '## Always applies')
    expect(always.split('\n').filter((l) => l.startsWith('### '))).toEqual(['### /global/g-pin.md'])
    expect(always).toContain('Always two spaces.')

    expect(indexPaths(fence)).toEqual([
      '/projects/acme/p1.md',
      '/global/g1.md',
      '/bots/alice/b1.md',
      '/projects/acme/sessions/s7.md',
      '/projects/acme/sessions/s6.md',
      '/projects/acme/sessions/s5.md',
      '/projects/acme/sessions/s4.md',
      '/projects/acme/sessions/s3.md',
      '/wiki/'
    ])
    expect(fence).toContain(
      '- /wiki/ — topics: auth (2), infra (1); read /wiki/<topic>/index.md for one'
    )
    for (const absent of [
      'g-dep.md',
      'p-dep.md',
      'project.md',
      'bot.md',
      'sessions/s1.md',
      'sessions/s2.md',
      'wiki/index.md',
      'wiki/auth/a.md'
    ]) {
      expect(fence, absent).not.toContain(absent)
    }
  })

  it('IJ-2 写入段按工具名单选口吻；旧项目记忆只读列出（绝对路径 + 召回条件）；无项目会话不扫旧记忆、无该节', async () => {
    seedBundle()
    state.memories = [
      { slug: 'auth-flow', name: '认证流程', description: 'desc', recall: 'when touching auth' }
    ]
    const withTool = (await resolveKnowledgeFence('s1', { tools: ['read', 'knowledge'] }))!
    expect(withTool).toContain('Call the `knowledge` tool with action "write"')
    expect(withTool).not.toContain('Write a markdown file under the scope directory')
    const withoutTool = (await resolveKnowledgeFence('s1', { tools: ['read', 'write'] }))!
    expect(withoutTool).toContain('Write a markdown file under the scope directory')
    expect(withoutTool).not.toContain('Call the `knowledge` tool')

    expect(state.scanned).toEqual(['p1', 'p1'])
    const legacy = section(withTool, '## Legacy project memories (read-only)')
    expect(legacy).toContain(
      `- ${join(state.memoryRoot, 'p1', 'auth-flow.md')} — when touching auth`
    )

    state.scanned = []
    const noProject = (await resolveKnowledgeFence('s0', { tools: ['knowledge'] }))!
    expect(noProject).not.toContain('## Legacy')
    expect(state.scanned).toEqual([])
  })

  it('IJ-3 根目录不存在、无项目：仍返回围栏 —— 表头、两个缺省作用域、空索引哨兵', async () => {
    const fence = (await resolveKnowledgeFence('s0', { tools: [] }))!
    expect(fence).toContain(`Knowledge base root: ${root} —`)
    expect(fence).toContain(
      'Scopes in this session: global (/global), session summaries (/sessions).'
    )
    expect(fence).toContain('No entries recorded yet.')
    expect(fence).not.toContain('## Always applies')
  })
})
