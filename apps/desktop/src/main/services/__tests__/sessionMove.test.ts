/**
 * 把别的项目的会话搬进调用方所在的项目（services/sessionMove.ts，`session` 工具 `move-session` 的语义；
 * docs/project-split-design.md §4.2 / §4.4）。sessionRecords / projectDao / sessionService / 运行状态 / 广播都用替身。
 *
 *   SM-1  整次调用不成立：调用方不是一条会话；调用方不在项目里（临时对话、bot 会话、ShuviX 文件的笔记本、标签页
 *         会话、项目行没了）；一条都没点名；点得太多
 *   SM-2  逐条判定里搬不了的：自己、没有这条、子会话（点出父会话）、bot 会话 / 引用工作项目的、内存会话、标签页
 *         会话、不属于任何项目、ShuviX 文件的笔记本、正在一轮当中（running / waiting-input / interrupted）、子会话
 *         正在一轮当中、本项目里已有同一份文件的笔记本
 *   SM-3  能搬的带上原项目与子会话；已经在本项目的单列；id 去空白、去重
 *   SM-4  apply：根会话与子会话一起改归属；目录相同不重建系统提示词；整批只广播一次会话列表
 *   SM-5  apply：两个项目目录不同 → 这棵树每条都重建系统提示词；重建不成（忙 / 抛错）计数，不拦搬动
 *   SM-6  apply 再判一遍：出卡之后开始跑的、被删的不搬（带原因），被别处搬进来的算「已经在了」；一条都没搬成不广播
 *   SM-7  rebaseNotebookPath 与搬动时的 notebookPath：新根之内是相对路径（forward-slash），之外是绝对路径
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session, SessionSettings } from '../../dao/types/session'

const mocks = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown>>(),
  ephemeral: new Set<string>(),
  projects: new Map<string, { id: string; name: string; path: string }>(),
  status: new Map<string, string>(),
  rebuild: vi.fn(),
  listChanged: vi.fn(),
  configChanged: vi.fn()
}))

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))
vi.mock('../../dao/projectDao', () => ({
  projectDao: { pick: (id: string) => mocks.projects.get(id) }
}))
vi.mock('../../utils/sessionConfigBroadcast', () => ({
  broadcastSessionListChanged: mocks.listChanged,
  broadcastSessionConfigChanged: mocks.configChanged
}))
vi.mock('../sessionService', () => ({
  sessionService: { rebuildSystemPrompt: mocks.rebuild }
}))
vi.mock('../subSessionRunner', () => ({
  sessionRunStatus: (id: string) => mocks.status.get(id) ?? 'idle'
}))
vi.mock('../sessionRecords', () => {
  const row = (id: string): Session | undefined => mocks.rows.get(id) as Session | undefined
  return {
    sessionRecords: {
      pick: (id: string) => row(id),
      pickSettings: (id: string) => row(id)?.settings,
      isEphemeral: (id: string) => mocks.ephemeral.has(id),
      findChildren: (parentId: string) =>
        [...mocks.rows.values()].filter((r) => (r as unknown as Session).parentId === parentId),
      findByProjectAndNotebookPath: (projectId: string, notebookPath: string) =>
        [...mocks.rows.values()].find((r) => {
          const s = r as unknown as Session
          return s.projectId === projectId && s.settings.notebookPath === notebookPath
        }),
      updateProjectId: (id: string, projectId: string | null) => {
        const r = row(id)
        if (r) r.projectId = projectId
      },
      updateSettings: (id: string, patch: SessionSettings) => {
        const r = row(id)
        if (r) r.settings = { ...r.settings, ...patch }
      }
    }
  }
})

import {
  applySessionMove,
  planSessionMove,
  rebaseNotebookPath,
  SESSION_MOVE_MAX,
  type SessionMovePlan
} from '../sessionMove'

const KNOWLEDGE_CARRIER = '__knowledge__'

function add(
  id: string,
  projectId: string | null,
  over: { parentId?: string; settings?: SessionSettings; title?: string } = {}
): void {
  mocks.rows.set(id, {
    id,
    title: over.title ?? `T-${id}`,
    projectId,
    parentId: over.parentId ?? null,
    settings: over.settings ?? {},
    createdAt: 1,
    updatedAt: 1,
    lastActiveAt: 1
  })
}

const projectOf = (id: string): string | null =>
  (mocks.rows.get(id) as unknown as Session).projectId

function plan(ids: string[], caller = 'me'): SessionMovePlan {
  const result = planSessionMove(caller, ids)
  if ('error' in result) throw new Error(`unexpected plan error: ${result.error}`)
  return result
}

beforeEach(() => {
  mocks.rows.clear()
  mocks.ephemeral.clear()
  mocks.status.clear()
  mocks.projects = new Map([
    ['pA', { id: 'pA', name: 'Big', path: '/work/big' }],
    ['pB', { id: 'pB', name: 'Auth', path: '/work/big' }],
    ['pC', { id: 'pC', name: 'Elsewhere', path: '/work/else' }]
  ])
  mocks.rebuild.mockReset().mockResolvedValue({ success: true })
  mocks.listChanged.mockReset()
  mocks.configChanged.mockReset()
  add('me', 'pB')
})

describe('planSessionMove：整次调用不成立（SM-1）', () => {
  it('SM-1 调用方不是一条会话 / 不在项目里 / 没点名 / 点得太多', () => {
    expect(planSessionMove('ghost', ['a'])).toEqual({
      error: expect.stringContaining('not attached to a session')
    })

    add('temp', null)
    add('bot', null, { settings: { bot: 'helper', workProject: 'pA' } })
    add('note', KNOWLEDGE_CARRIER, { settings: { notebookPath: 'projects/pA/x.md' } })
    add('tab', 'pA', { settings: { chromeTab: { installId: 'i', runId: 'r', tabId: 1 } } })
    add('orphan', 'gone')
    for (const caller of ['temp', 'bot', 'note', 'tab', 'orphan']) {
      expect(planSessionMove(caller, ['a']), caller).toEqual({
        error: expect.stringContaining('does not belong to a project')
      })
    }

    expect(planSessionMove('me', [])).toEqual({ error: expect.stringContaining('session_ids') })
    expect(planSessionMove('me', ['  ', ''])).toEqual({
      error: expect.stringContaining('session_ids')
    })
    const many = Array.from({ length: SESSION_MOVE_MAX + 1 }, (_, i) => `s${i}`)
    expect(planSessionMove('me', many)).toEqual({
      error: expect.stringContaining(`at most ${SESSION_MOVE_MAX}`)
    })
  })
})

describe('planSessionMove：逐条判定（SM-2 / SM-3）', () => {
  it('SM-2 搬不了的各有原因，都不进 candidates', () => {
    add('root', 'pA')
    add('child', 'pA', { parentId: 'root' })
    add('botSession', null, { settings: { bot: 'helper' } })
    add('botWork', null, { settings: { workProject: 'pA' } })
    add('mem', 'pA')
    mocks.ephemeral.add('mem')
    add('tab', 'pA', { settings: { chromeTab: { installId: 'i', runId: 'r', tabId: 7 } } })
    add('temp', null)
    add('entryNote', KNOWLEDGE_CARRIER, { settings: { notebookPath: 'projects/pA/x.md' } })
    add('running', 'pA')
    add('asking', 'pA')
    add('cut', 'pA')
    mocks.status.set('running', 'running')
    mocks.status.set('asking', 'waiting-input')
    mocks.status.set('cut', 'interrupted')
    add('busyKid', 'pA')
    add('kid', 'pA', { parentId: 'busyKid' })
    mocks.status.set('kid', 'running')
    // 本项目（pB，与 pA 同目录）里已经有 docs/a.md 的笔记本
    add('noteHere', 'pB', { settings: { notebookPath: 'docs/a.md' } })
    add('noteThere', 'pA', { settings: { notebookPath: 'docs/a.md' } })

    const result = plan([
      'me',
      'nope',
      'child',
      'botSession',
      'botWork',
      'mem',
      'tab',
      'temp',
      'entryNote',
      'running',
      'asking',
      'cut',
      'busyKid',
      'noteThere'
    ])
    expect(result.candidates).toEqual([])
    expect(result.already).toEqual([])
    const reasons = Object.fromEntries(result.refused.map((r) => [r.id, r]))
    expect(reasons.me).toEqual({ id: 'me', reason: 'That is this session itself.' })
    expect(reasons.nope).toEqual({ id: 'nope', reason: expect.stringContaining('No session') })
    expect(reasons.child).toEqual({
      id: 'child',
      title: 'T-child',
      reason: expect.stringContaining('sub-session of "T-root" (root)')
    })
    expect(reasons.botSession.reason).toContain('belongs to a bot')
    expect(reasons.botWork.reason).toContain('belongs to a bot')
    expect(reasons.mem.reason).toContain('temporary session')
    expect(reasons.tab.reason).toContain('temporary session')
    expect(reasons.temp.reason).toContain('does not belong to a project')
    expect(reasons.entryNote.reason).toContain('notebook of a file ShuviX manages')
    expect(reasons.running.reason).toContain('status: running')
    expect(reasons.asking.reason).toContain('status: waiting-input')
    expect(reasons.cut.reason).toContain('status: interrupted')
    expect(reasons.busyKid.reason).toContain('One of its sub-sessions')
    expect(reasons.noteThere.reason).toContain('already has a notebook session')
    expect(result.refused).toHaveLength(14)
  })

  it('SM-3 能搬的带原项目与子会话；已经在本项目的单列；id 去空白、去重', () => {
    add('a', 'pA')
    add('a1', 'pA', { parentId: 'a' })
    add('a2', 'pA', { parentId: 'a' })
    add('c', 'pC')
    add('here', 'pB')
    add('lost', 'gone')

    const result = plan([' a ', 'a', 'c', 'here', 'lost'])
    expect(result.project).toEqual({ id: 'pB', name: 'Auth', path: '/work/big' })
    expect(result.candidates).toEqual([
      {
        id: 'a',
        title: 'T-a',
        fromProject: { id: 'pA', name: 'Big', path: '/work/big' },
        children: ['a1', 'a2']
      },
      {
        id: 'c',
        title: 'T-c',
        fromProject: { id: 'pC', name: 'Elsewhere', path: '/work/else' },
        children: []
      },
      // 原项目的行读不到：名字与目录是空串，照样能搬
      { id: 'lost', title: 'T-lost', fromProject: { id: 'gone', name: '', path: '' }, children: [] }
    ])
    expect(result.already).toEqual([{ id: 'here', title: 'T-here' }])
    expect(result.refused).toEqual([])
  })
})

describe('applySessionMove（SM-4 / SM-5 / SM-6）', () => {
  it('SM-4 根会话与子会话一起改归属；目录相同不重建；会话列表整批只广播一次', async () => {
    add('a', 'pA')
    add('a1', 'pA', { parentId: 'a' })
    add('b', 'pA')
    add('fork', 'pA')

    const outcome = await applySessionMove('me', plan(['a', 'b']))
    expect(outcome.moved).toEqual([
      {
        id: 'a',
        title: 'T-a',
        fromProject: 'Big',
        subSessions: 1,
        directoryChanged: false,
        promptNotRebuilt: 0
      },
      {
        id: 'b',
        title: 'T-b',
        fromProject: 'Big',
        subSessions: 0,
        directoryChanged: false,
        promptNotRebuilt: 0
      }
    ])
    expect([projectOf('a'), projectOf('a1'), projectOf('b')]).toEqual(['pB', 'pB', 'pB'])
    // 没点名的会话原地不动
    expect(projectOf('fork')).toBe('pA')
    expect(mocks.rebuild).not.toHaveBeenCalled()
    expect(mocks.listChanged).toHaveBeenCalledTimes(1)
    expect(mocks.configChanged.mock.calls.map((c) => c[0])).toEqual(['a', 'a1', 'b'])
  })

  it('SM-5 目录不同：这棵树每条都重建系统提示词；重建不成只计数', async () => {
    add('c', 'pC')
    add('c1', 'pC', { parentId: 'c' })
    add('c2', 'pC', { parentId: 'c' })
    mocks.rebuild
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false, reason: 'busy' })
      .mockRejectedValueOnce(new Error('store closed'))

    const outcome = await applySessionMove('me', plan(['c']))
    expect(mocks.rebuild.mock.calls.map((c) => c[0])).toEqual(['c', 'c1', 'c2'])
    expect(outcome.moved).toEqual([
      {
        id: 'c',
        title: 'T-c',
        fromProject: 'Elsewhere',
        subSessions: 2,
        directoryChanged: true,
        promptNotRebuilt: 2
      }
    ])
    expect([projectOf('c'), projectOf('c1'), projectOf('c2')]).toEqual(['pB', 'pB', 'pB'])
  })

  it('SM-5b 原项目的行读不到：当作目录不同，重建', async () => {
    add('lost', 'gone')
    const outcome = await applySessionMove('me', plan(['lost']))
    expect(outcome.moved[0]).toMatchObject({ directoryChanged: true, promptNotRebuilt: 0 })
    expect(mocks.rebuild).toHaveBeenCalledWith('lost')
  })

  it('SM-6 出卡之后变了的：开始跑的、被删的不搬，被别处搬进来的算已经在了；计划里的拒绝原样带回', async () => {
    add('a', 'pA')
    add('b', 'pA')
    add('c', 'pA')
    add('ok', 'pA')
    const planned = plan(['a', 'b', 'c', 'ok', 'nope'])
    expect(planned.candidates.map((c) => c.id)).toEqual(['a', 'b', 'c', 'ok'])

    mocks.status.set('a', 'running')
    mocks.rows.delete('b')
    ;(mocks.rows.get('c') as Record<string, unknown>).projectId = 'pB'

    const outcome = await applySessionMove('me', planned)
    expect(outcome.moved.map((m) => m.id)).toEqual(['ok'])
    expect(outcome.already).toEqual([{ id: 'c', title: 'T-c' }])
    expect(outcome.refused.map((r) => r.id)).toEqual(['nope', 'a', 'b'])
    expect(projectOf('a')).toBe('pA')
    expect(mocks.listChanged).toHaveBeenCalledTimes(1)
  })

  it('SM-6b 一条都没搬成：不广播', async () => {
    add('a', 'pA')
    const planned = plan(['a'])
    mocks.status.set('a', 'running')
    const outcome = await applySessionMove('me', planned)
    expect(outcome.moved).toEqual([])
    expect(mocks.listChanged).not.toHaveBeenCalled()
    expect(mocks.configChanged).not.toHaveBeenCalled()
  })
})

describe('笔记本路径（SM-7）', () => {
  it('SM-7 rebaseNotebookPath：新根之内相对（forward-slash），之外绝对；旧根读不到时相对路径原样', () => {
    expect(rebaseNotebookPath('docs/a.md', '/work/big', '/work/big')).toBe('docs/a.md')
    expect(rebaseNotebookPath('auth/docs/a.md', '/work/big', '/work/big/auth')).toBe('docs/a.md')
    expect(rebaseNotebookPath('docs/a.md', '/work/big', '/work/else')).toBe('/work/big/docs/a.md')
    expect(rebaseNotebookPath('/outside/n.md', '/work/big', '/work/else')).toBe('/outside/n.md')
    expect(rebaseNotebookPath('/work/else/n.md', '/work/big', '/work/else')).toBe('n.md')
    expect(rebaseNotebookPath('docs/a.md', '', '/work/else')).toBe('docs/a.md')
  })

  it('SM-7 搬笔记本会话：路径照新根重写，文件不动；同目录的不写', async () => {
    add('note', 'pA', { settings: { notebookPath: 'docs/a.md' } })
    mocks.projects.set('pB', { id: 'pB', name: 'Auth', path: '/work/else' })
    await applySessionMove('me', plan(['note']))
    expect((mocks.rows.get('note') as unknown as Session).settings.notebookPath).toBe(
      '/work/big/docs/a.md'
    )

    add('note2', 'pA', { settings: { notebookPath: 'docs/b.md' } })
    mocks.projects.set('pB', { id: 'pB', name: 'Auth', path: '/work/big' })
    await applySessionMove('me', plan(['note2']))
    expect((mocks.rows.get('note2') as unknown as Session).settings.notebookPath).toBe('docs/b.md')
  })
})
