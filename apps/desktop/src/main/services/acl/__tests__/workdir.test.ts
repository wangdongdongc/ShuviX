/**
 * 会话权限表的工作目录来源（acl/workdir.ts `sessionWorkingDirectory`）—— 与 sessionService 的 workingDirectoryOf
 * 同一个口径：所属项目（或 bot 会话引用的工作项目，chat-protocol `projectContextIdOf`）的根；否则会话自带的
 * `settings.workingDirectory`（fork / 子会话共用的临时工作区、工作项目被删后的路径快照）；再否则本会话的临时工作区
 * （只算路径、不建目录）。
 *
 *   WK-1  成员会话 → 项目根；引用工作项目的 bot 会话 → 那个项目的根（快照让位于项目此刻的路径）；项目被删 → 快照；
 *         快照也没有 → 临时工作区（create: false）；空白 / 非字符串的引用不算；行不在 → 临时工作区
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  rows: {} as Record<string, { projectId: string | null; settings?: Record<string, unknown> }>,
  projects: {} as Record<string, { path: string }>,
  tempCalls: [] as Array<[string, unknown]>,
  projectPicks: [] as string[]
}))

vi.mock('../../../dao/projectDao', () => ({
  projectDao: {
    pick: (id: string) => {
      state.projectPicks.push(id)
      return state.projects[id] ? { ...state.projects[id] } : undefined
    }
  }
}))
vi.mock('../../../utils/paths', () => ({
  getTempWorkspace: (id: string, options?: unknown) => {
    state.tempCalls.push([id, options])
    return `/tmp-ws/${id}`
  }
}))
vi.mock('../../sessionRecords', () => ({
  sessionRecords: {
    pick: (id: string) => (state.rows[id] ? structuredClone(state.rows[id]) : undefined)
  }
}))

import { sessionWorkingDirectory } from '../workdir'

beforeEach(() => {
  state.rows = {}
  state.projects = { p1: { path: '/work/p1' }, p2: { path: '/work/p2' } }
  state.tempCalls = []
  state.projectPicks = []
})

describe('WK-1 sessionWorkingDirectory follows the project a session belongs to or references', () => {
  it('WK-1 a member session → its project root', () => {
    state.rows.M = { projectId: 'p1', settings: {} }
    expect(sessionWorkingDirectory('M')).toBe('/work/p1')
    expect(state.tempCalls).toEqual([])
  })

  it("WK-1 a bot session referencing a work project → that project's current root, not the snapshot", () => {
    state.rows.B = {
      projectId: null,
      settings: { bot: 'scout', workProject: 'p2', workingDirectory: '/old/snapshot' }
    }
    expect(sessionWorkingDirectory('B')).toBe('/work/p2')
    expect(state.projectPicks).toEqual(['p2'])
    expect(state.tempCalls).toEqual([])
  })

  it('WK-1 the referenced project is gone → the path snapshot', () => {
    state.rows.B = {
      projectId: null,
      settings: { bot: 'scout', workProject: 'gone', workingDirectory: '/old/snapshot' }
    }
    expect(sessionWorkingDirectory('B')).toBe('/old/snapshot')
    expect(state.tempCalls).toEqual([])
  })

  it('WK-1 neither the project nor a snapshot → its own temp workspace, without creating it', () => {
    state.rows.B = { projectId: null, settings: { bot: 'scout', workProject: 'gone' } }
    expect(sessionWorkingDirectory('B')).toBe('/tmp-ws/B')
    expect(state.tempCalls).toEqual([['B', { create: false }]])
  })

  it('WK-1 a blank or non-string reference is no reference: snapshot, then temp workspace', () => {
    state.rows.A = { projectId: null, settings: { workProject: '   ', workingDirectory: '/snap' } }
    expect(sessionWorkingDirectory('A')).toBe('/snap')
    state.rows.N = { projectId: null, settings: { workProject: 42 } }
    expect(sessionWorkingDirectory('N')).toBe('/tmp-ws/N')
    // 空白引用不去查项目表
    expect(state.projectPicks).toEqual([])
  })

  it('WK-1 a member whose project row is gone → its own working directory key, else temp', () => {
    state.rows.F = { projectId: 'gone', settings: { workingDirectory: '/shared/tmp' } }
    expect(sessionWorkingDirectory('F')).toBe('/shared/tmp')
    state.rows.G = { projectId: 'gone', settings: {} }
    expect(sessionWorkingDirectory('G')).toBe('/tmp-ws/G')
  })

  it('WK-1 a project with an empty path counts as no project path', () => {
    state.projects.p3 = { path: '' }
    state.rows.B = { projectId: null, settings: { workProject: 'p3', workingDirectory: '/snap' } }
    expect(sessionWorkingDirectory('B')).toBe('/snap')
  })

  it('WK-1 a missing row → the temp workspace of that id', () => {
    expect(sessionWorkingDirectory('ghost')).toBe('/tmp-ws/ghost')
    expect(state.tempCalls).toEqual([['ghost', { create: false }]])
  })
})
