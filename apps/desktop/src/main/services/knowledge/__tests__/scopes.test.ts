/**
 * scopes —— 会话 → 作用域目录（设计 §3 / §5）。`global` 恒有；项目目录按 project.md 的 `resource`
 * 绑定查找（不存在时**不建**，首次写入才建）；bot 会话 → `bots/<name>`；会话摘要住在项目的
 * `sessions/`（无项目则顶层）。目录名是 slug（人可读、允许 Unicode），绑定真源是绑定概念。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { parseConceptText } from '@shuvix/agent-runtime'
import type { Project } from '../../../dao/types/project'

const state = vi.hoisted(() => ({
  root: '',
  sessions: {} as Record<
    string,
    { projectId?: string | null; settings?: { bot?: string } } | undefined
  >,
  projects: {} as Record<string, unknown>
}))

vi.mock('../../../utils/paths', () => ({
  getKnowledgeRootDir: () => state.root,
  getProjectMemoryDir: (id: string) => `${state.root}-memory/${id}`,
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

import { flushKnowledgeChanges } from '../changes'
import { isKnowledgeRootInitialized } from '../root'
import { invalidateKnowledgeScan } from '../scan'
import {
  ensureProjectScope,
  resolveSessionScopeTarget,
  sessionFenceScopes,
  sessionKnowledgeContext
} from '../scopes'
import { makeTempRoot, seedConcept } from './fixture'

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
  // 根目录是 parent 下尚不存在的子目录：只读路径必须不把它建出来
  root = join(parent, 'kb')
  state.root = root
  state.projects = { p1: acme }
  state.sessions = {
    's-p': { projectId: 'p1' },
    's-b': { settings: { bot: 'alice' } },
    's-0': {}
  }
  invalidateKnowledgeScan()
})

afterEach(async () => {
  await flushKnowledgeChanges()
  rmSync(parent, { recursive: true, force: true })
})

const dirsOf = (rel: string): string[] =>
  readdirSync(join(root, ...rel.split('/')), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()

describe('sessionKnowledgeContext / sessionFenceScopes（只读）', () => {
  it('DS-1 项目会话（尚无目录）/ bot 会话 / 都没有 → 上下文；围栏作用域清单的顺序与目录；不建根目录', async () => {
    expect(await sessionKnowledgeContext('s-p')).toEqual({
      project: acme,
      projectDir: null,
      bot: null,
      botDir: null
    })
    expect(await sessionKnowledgeContext('s-b')).toEqual({
      project: null,
      projectDir: null,
      bot: 'alice',
      botDir: null
    })
    expect(await sessionKnowledgeContext('s-0')).toEqual({
      project: null,
      projectDir: null,
      bot: null,
      botDir: null
    })
    expect(await sessionFenceScopes('s-p')).toEqual([
      { label: 'global', dir: 'global' },
      { label: 'project "Acme Corp"', dir: null },
      { label: 'session summaries', dir: 'sessions' }
    ])
    expect(await sessionFenceScopes('s-b')).toEqual([
      { label: 'global', dir: 'global' },
      { label: 'bot "alice"', dir: null },
      { label: 'session summaries', dir: 'sessions' }
    ])
    expect(await sessionFenceScopes('s-0')).toEqual([
      { label: 'global', dir: 'global' },
      { label: 'session summaries', dir: 'sessions' }
    ])
    expect(existsSync(root)).toBe(false)

    // 项目目录在场（按 resource 绑定，目录名只是 slug）：会话摘要住到项目下
    seedConcept(root, 'projects/acme/project.md', [
      'type: Project',
      'title: Acme Corp',
      'resource: shuvix://project/p1'
    ])
    invalidateKnowledgeScan()
    expect((await sessionKnowledgeContext('s-p')).projectDir).toBe('projects/acme')
    expect(await sessionFenceScopes('s-p')).toEqual([
      { label: 'global', dir: 'global' },
      { label: 'project "Acme Corp"', dir: 'projects/acme' },
      { label: 'session summaries', dir: 'projects/acme/sessions' }
    ])
  })
})

describe('ensureProjectScope', () => {
  it('DS-2 建 projects/<slug> + 绑定概念 project.md（宿主署名），幂等；同名项目 slug 追加 -2；改名不动目录；记一条 Creation 变更', async () => {
    expect(await ensureProjectScope(acme)).toBe('projects/acme-corp')
    expect(await ensureProjectScope(acme)).toBe('projects/acme-corp')
    const rel = 'projects/acme-corp/project.md'
    const text = readFileSync(join(root, ...rel.split('/')), 'utf-8')
    expect(text).toContain('\ntype: Project\n')
    expect(text).toContain('\ntitle: Acme Corp\n')
    expect(text).toContain('\nstatus: stable\n')
    expect(text).toContain('\nresource: "shuvix://project/p1"\n')
    const concept = parseConceptText(text, rel)!
    expect(concept).toMatchObject({
      type: 'Project',
      title: 'Acme Corp',
      resource: 'shuvix://project/p1',
      status: 'stable',
      sources: [{ resource: '/w/acme', title: 'project root' }]
    })
    expect(concept.generated?.by).toBe('process:shuvix')
    expect(dirsOf('projects')).toEqual(['acme-corp'])

    const twin: Project = { ...acme, id: 'p2' }
    expect(await ensureProjectScope(twin)).toBe('projects/acme-corp-2')
    expect(dirsOf('projects')).toEqual(['acme-corp', 'acme-corp-2'])
    // 项目改名：绑定靠 resource，目录不动
    expect(await ensureProjectScope({ ...acme, name: 'Acme Renamed' })).toBe('projects/acme-corp')
    expect(dirsOf('projects')).toEqual(['acme-corp', 'acme-corp-2'])

    await flushKnowledgeChanges()
    const log = readFileSync(join(root, 'log.md'), 'utf-8')
    expect(log).toContain(
      '- **Creation** /projects/acme-corp/project.md — Acme Corp · by process:shuvix'
    )
    expect(log).toContain(
      '- **Creation** /projects/acme-corp-2/project.md — Acme Corp · by process:shuvix'
    )
  })

  it('DS-5 Unicode 项目名直接当目录名', async () => {
    const zh: Project = { ...acme, id: 'p3', name: '登录服务', path: '/w/login' }
    expect(await ensureProjectScope(zh)).toBe('projects/登录服务')
    expect(existsSync(join(root, 'projects', '登录服务', 'project.md'))).toBe(true)
  })
})

describe('resolveSessionScopeTarget', () => {
  it('DS-3 create:false：尚无目录的项目 / 会话摘要 / 主题 → 可读 error；无项目要 project 指路 global；非 bot 会话要 bot 报错；wiki 无主题 / raw / global 直接给目录；不建根目录', async () => {
    const read = (
      session: string,
      scope: Parameters<typeof resolveSessionScopeTarget>[1],
      topic?: string
    ): ReturnType<typeof resolveSessionScopeTarget> =>
      resolveSessionScopeTarget(session, scope, { topic, create: false })

    expect(await read('s-p', 'project')).toEqual({
      error: 'Project "Acme Corp" has no knowledge entries yet.'
    })
    expect(await read('s-p', 'session')).toEqual({ error: 'No session summaries recorded yet.' })
    const noProject = (await read('s-0', 'project')) as { error: string }
    expect(noProject.error).toContain('use scope "global"')
    const noBot = (await read('s-0', 'bot')) as { error: string }
    expect(noBot.error).toContain('not bound to a bot')
    expect(await read('s-0', 'wiki')).toEqual({ dir: 'wiki', label: 'wiki' })
    expect(await read('s-0', 'wiki', 'auth')).toEqual({
      error: 'Wiki topic "auth" does not exist yet.'
    })
    expect(await read('s-0', 'raw')).toEqual({ dir: 'raw', label: 'raw sources' })
    expect(await read('s-0', 'global')).toEqual({ dir: 'global', label: 'global' })
    expect(existsSync(root)).toBe(false)
  })

  it('DS-4 create:true：项目 / 会话摘要（项目下或顶层，带 sessionResource）/ bot（建 bot.md）/ wiki 主题（建目录）；wiki 缺 topic 报错；根目录顺带种下', async () => {
    const create = (
      session: string,
      scope: Parameters<typeof resolveSessionScopeTarget>[1],
      topic?: string
    ): ReturnType<typeof resolveSessionScopeTarget> =>
      resolveSessionScopeTarget(session, scope, { topic, create: true })

    expect(await create('s-p', 'project')).toEqual({
      dir: 'projects/acme-corp',
      label: 'project "Acme Corp"'
    })
    expect(isKnowledgeRootInitialized()).toBe(true)
    expect(await create('s-p', 'session')).toEqual({
      dir: 'projects/acme-corp/sessions',
      label: 'session summaries',
      sessionResource: 'shuvix://session/s-p'
    })
    expect(await create('s-0', 'session')).toEqual({
      dir: 'sessions',
      label: 'session summaries',
      sessionResource: 'shuvix://session/s-0'
    })

    expect(await create('s-b', 'bot')).toEqual({ dir: 'bots/alice', label: 'bot "alice"' })
    const bot = parseConceptText(
      readFileSync(join(root, 'bots', 'alice', 'bot.md'), 'utf-8'),
      'bots/alice/bot.md'
    )!
    expect(bot).toMatchObject({
      type: 'Bot',
      title: 'alice',
      resource: 'shuvix://bot/alice',
      status: 'stable'
    })
    expect(bot.generated?.by).toBe('process:shuvix')
    // 再解析同一 bot：目录已在，不重复建
    expect(await create('s-b', 'bot')).toEqual({ dir: 'bots/alice', label: 'bot "alice"' })
    expect(dirsOf('bots')).toEqual(['alice'])

    expect(await create('s-0', 'wiki', 'Auth Flow')).toEqual({
      dir: 'wiki/auth-flow',
      label: 'wiki topic "Auth Flow"'
    })
    expect(existsSync(join(root, 'wiki', 'auth-flow'))).toBe(true)
    const noTopic = (await create('s-0', 'wiki')) as { error: string }
    expect(noTopic.error).toContain('needs `topic`')
    expect(await create('s-0', 'raw')).toEqual({ dir: 'raw', label: 'raw sources' })
    expect(existsSync(join(root, 'raw'))).toBe(true)
  })
})
