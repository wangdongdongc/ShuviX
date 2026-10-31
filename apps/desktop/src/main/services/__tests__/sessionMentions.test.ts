/**
 * 输入框 `@` 会话的候选（services/sessionMentions.ts 的 listSessionMentions；sessionService / projectDao 用替身）。
 *
 *   XS-69 listSessionMentions(P)：
 *     - 去掉正在输入的这一条 P，其余按 lastActiveAt 倒序；
 *     - 项目名每个项目只读一次（读不到名字的项目也只读一次）；不属于项目的会话不读；
 *     - 父会话在列表里（含 P 自己）→ parentTitle = 它的标题；父会话不在列表里 → 没有 parentTitle；
 *     - 缺的字段是**没有这个键**，不是 undefined 值（项目名为空串 / 父会话标题为空串同样不给）；
 *     - 只给 id / title / projectName / parentTitle / lastActiveAt，不带 settings 之类。
 *   XS-69b bot 会话（只归属 bot、projectId 空）的 projectName 是它引用的工作项目（settings.workProject）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '../../dao/types/session'

const mocks = vi.hoisted(() => ({
  sessions: [] as Session[],
  projects: new Map<string, { name: string }>(),
  pick: vi.fn()
}))

vi.mock('../../dao/projectDao', () => ({
  projectDao: { pick: mocks.pick }
}))
vi.mock('../sessionService', () => ({
  sessionService: { list: () => mocks.sessions }
}))

import { listSessionMentions } from '../sessionMentions'

function session(
  id: string,
  lastActiveAt: number,
  over: Partial<Pick<Session, 'title' | 'projectId' | 'parentId'>> = {}
): Session {
  return {
    id,
    title: `Title ${id}`,
    projectId: null,
    parentId: null,
    settings: { workingDirectory: `/w/${id}` } as Session['settings'],
    createdAt: 1,
    updatedAt: 2,
    lastActiveAt,
    ...over
  }
}

beforeEach(() => {
  mocks.sessions = []
  mocks.projects = new Map([
    ['p-web', { name: 'Website' }],
    ['p-empty', { name: '' }]
  ])
  mocks.pick
    .mockReset()
    .mockImplementation((id: string, fields: string[]) =>
      mocks.projects.has(id)
        ? Object.fromEntries(fields.map((f) => [f, mocks.projects.get(id)![f as 'name']]))
        : undefined
    )
})

describe('listSessionMentions（XS-69）', () => {
  it('XS-69 去掉 P 自己，其余按最近活跃倒序', () => {
    mocks.sessions = [session('a', 100), session('P', 999), session('b', 300), session('c', 200)]
    const list = listSessionMentions('P')
    expect(list.map((e) => e.id)).toEqual(['b', 'c', 'a'])
    expect(list.map((e) => e.lastActiveAt)).toEqual([300, 200, 100])
    expect(list.some((e) => e.id === 'P')).toBe(false)
  })

  it('XS-69 P 不在列表里：全部照排', () => {
    mocks.sessions = [session('a', 1), session('b', 2)]
    expect(listSessionMentions('nope').map((e) => e.id)).toEqual(['b', 'a'])
  })

  it('XS-69 项目名每个项目只读一次；读不到的也只读一次；不属于项目的不读', () => {
    mocks.sessions = [
      session('a', 5, { projectId: 'p-web' }),
      session('b', 4, { projectId: 'p-web' }),
      session('c', 3, { projectId: 'p-gone' }),
      session('d', 2, { projectId: 'p-gone' }),
      session('e', 1)
    ]
    const list = listSessionMentions('P')
    expect(list.map((e) => [e.id, e.projectName])).toEqual([
      ['a', 'Website'],
      ['b', 'Website'],
      ['c', undefined],
      ['d', undefined],
      ['e', undefined]
    ])
    expect(mocks.pick).toHaveBeenCalledTimes(2)
    expect(mocks.pick).toHaveBeenCalledWith('p-web', ['name'])
    expect(mocks.pick).toHaveBeenCalledWith('p-gone', ['name'])
  })

  it('XS-69 父会话在列表里（含 P 自己）→ parentTitle；父会话不在 → 没有', () => {
    mocks.sessions = [
      session('P', 50, { title: 'Me, typing' }),
      session('parent', 40, { title: 'Planner' }),
      session('child', 30, { parentId: 'parent', title: 'Sub task' }),
      session('my-child', 20, { parentId: 'P', title: 'Mine' }),
      session('orphan', 10, { parentId: 'deleted-or-hidden', title: 'Orphan' })
    ]
    const byId = new Map(listSessionMentions('P').map((e) => [e.id, e]))
    expect(byId.get('child')!.parentTitle).toBe('Planner')
    expect(byId.get('my-child')!.parentTitle).toBe('Me, typing')
    expect(byId.get('orphan')).not.toHaveProperty('parentTitle')
    expect(byId.get('parent')).not.toHaveProperty('parentTitle')
  })

  it('XS-69 缺的字段是没有这个键：只给 id / title / projectName / parentTitle / lastActiveAt', () => {
    mocks.sessions = [
      session('full', 4, { title: 'Full', projectId: 'p-web', parentId: 'top' }),
      session('top', 3, { title: 'Top' }),
      session('empty-project', 2, { title: 'Empty project', projectId: 'p-empty' }),
      session('empty-parent-title', 1, { title: 'Child of untitled', parentId: 'untitled' }),
      session('untitled', 0, { title: '' })
    ]
    const list = listSessionMentions('P')
    expect(list).toEqual([
      { id: 'full', title: 'Full', projectName: 'Website', parentTitle: 'Top', lastActiveAt: 4 },
      { id: 'top', title: 'Top', lastActiveAt: 3 },
      { id: 'empty-project', title: 'Empty project', lastActiveAt: 2 },
      { id: 'empty-parent-title', title: 'Child of untitled', lastActiveAt: 1 },
      { id: 'untitled', title: '', lastActiveAt: 0 }
    ])
    expect(Object.keys(list[1])).toEqual(['id', 'title', 'lastActiveAt'])
    expect(Object.keys(list[2])).not.toContain('projectName')
    expect(Object.keys(list[3])).not.toContain('parentTitle')
    for (const entry of list) {
      expect(entry).not.toHaveProperty('settings')
      expect(entry).not.toHaveProperty('projectId')
      expect(entry).not.toHaveProperty('parentId')
    }
  })

  it('XS-69 没有别的会话 → []', () => {
    mocks.sessions = [session('P', 1)]
    expect(listSessionMentions('P')).toEqual([])
    mocks.sessions = []
    expect(listSessionMentions('P')).toEqual([])
    expect(mocks.pick).not.toHaveBeenCalled()
  })

  it('XS-69b bot 会话（projectId 空）标它引用的工作项目名；成员关系照旧优先；与成员会话共用一次读', () => {
    const withSettings = (s: Session, settings: Record<string, unknown>): Session => ({
      ...s,
      settings: { ...s.settings, ...settings } as Session['settings']
    })
    mocks.sessions = [
      withSettings(session('bot', 5), { bot: 'scout', workProject: 'p-web' }),
      session('member', 4, { projectId: 'p-web' }),
      withSettings(session('gone', 3), { bot: 'scout', workProject: 'p-gone' }),
      withSettings(session('blank', 2), { bot: 'scout', workProject: '  ' }),
      // 成员会话碰巧带着引用键（不该有）：所属项目说了算
      withSettings(session('both', 1, { projectId: 'p-web' }), { workProject: 'p-other' })
    ]
    const list = listSessionMentions('P')
    expect(list.map((e) => [e.id, e.projectName])).toEqual([
      ['bot', 'Website'],
      ['member', 'Website'],
      ['gone', undefined],
      ['blank', undefined],
      ['both', 'Website']
    ])
    expect(list.find((e) => e.id === 'gone')).not.toHaveProperty('projectName')
    expect(mocks.pick.mock.calls.map((c) => c[0]).sort()).toEqual(['p-gone', 'p-web'])
  })
})
