/**
 * 记下「这条会话用过这个组件」（`noteUse.ts`）：项目从会话行取，只作信息关联（Widget 面板的项目标签），记不下来不影响调用。
 * 组件的 MCP 服务器与 `widget` 工具共用它（它们各自「什么时候记」在各自的测试里）。
 *
 *   NU-1 按 (会话, [projectId, settings]) 读；会话的项目；bot 会话引用的工作项目；成员关系优先
 *   NU-2 隐藏的承载项目、空串、读不到会话行 → null
 *   NU-3 读会话行抛错、记账抛错 → 不抛
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  pick: vi.fn(),
  noteSessionUse: vi.fn()
}))

vi.mock('../../sessionRecords', () => ({ sessionRecords: { pick: h.pick } }))
vi.mock('../widgetService', () => ({ widgetService: { noteSessionUse: h.noteSessionUse } }))

import { noteWidgetUse } from '../noteUse'

beforeEach(() => {
  h.pick.mockReset()
  h.noteSessionUse.mockReset()
})

describe('noteWidgetUse', () => {
  it.each<[string, unknown, string | null]>([
    ['项目里的会话', { projectId: 'p1', settings: {} }, 'p1'],
    [
      'bot 会话引用的工作项目',
      { projectId: null, settings: { bot: 'b', workProject: 'p2' } },
      'p2'
    ],
    ['成员关系优先于引用', { projectId: 'p1', settings: { workProject: 'p2' } }, 'p1'],
    ['隐藏的承载项目', { projectId: '__agents__', settings: {} }, null],
    ['引用隐藏的承载项目', { projectId: null, settings: { workProject: '__knowledge__' } }, null],
    ['没有项目', { projectId: null, settings: {} }, null],
    ['空串', { projectId: '', settings: {} }, null],
    ['读不到会话行', undefined, null]
  ])('NU-1/2 %s → 记 (id, 会话, %s)', (_l, row, project) => {
    h.pick.mockReturnValue(row)
    noteWidgetUse('a-b', 's1')
    expect(h.pick).toHaveBeenCalledWith('s1', ['projectId', 'settings'])
    expect(h.noteSessionUse).toHaveBeenCalledTimes(1)
    expect(h.noteSessionUse).toHaveBeenCalledWith('a-b', 's1', project)
  })

  it('NU-3 读会话行抛错：不抛，也不记', () => {
    h.pick.mockImplementation(() => {
      throw new Error('db gone')
    })
    expect(() => noteWidgetUse('a-b', 's1')).not.toThrow()
    expect(h.noteSessionUse).not.toHaveBeenCalled()
  })

  it('NU-3 记账抛错：不抛', () => {
    h.pick.mockReturnValue({ projectId: 'p1', settings: {} })
    h.noteSessionUse.mockImplementation(() => {
      throw new Error('disk full')
    })
    expect(() => noteWidgetUse('a-b', 's1')).not.toThrow()
  })
})
