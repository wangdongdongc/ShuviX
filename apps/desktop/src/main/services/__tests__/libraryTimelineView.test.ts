/**
 * services/libraryTimelineView.ts —— `library:timeline` 给界面的那一份：库里的条目原样，加上它们所属会话的标题、
 * 项目名、是不是笔记本（测试设计 docs/file-library-timeline-tests.md §6，TL-74…TL-80；TL-81 按削减名单略去）。
 *
 * 替身：`../fileLibrary` 的 libraryTimeline 回夹具；`../sessionRecords` 的 pick / pickSettings 与 `../projectService`
 * 的 getById 是查夹具表的间谍。`isHiddenProjectId` 用真的。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LibraryTimelineEntry } from '@shuvix/chat-protocol/fileLibrary'

const state = vi.hoisted(() => ({
  entries: [] as unknown[],
  rows: {} as Record<string, { title: string; projectId: string | null } | undefined>,
  settings: {} as Record<string, Record<string, unknown> | undefined>,
  projects: {} as Record<string, { name: string } | undefined>,
  pick: vi.fn(),
  pickSettings: vi.fn(),
  getById: vi.fn()
}))

vi.mock('../fileLibrary', () => ({ libraryTimeline: () => state.entries }))
vi.mock('../sessionRecords', () => ({
  sessionRecords: { pick: state.pick, pickSettings: state.pickSettings }
}))
vi.mock('../projectService', () => ({ projectService: { getById: state.getById } }))

import { libraryTimelineView } from '../libraryTimelineView'

let seq = 0
function entry(sessionId: string | null): LibraryTimelineEntry {
  const id = `item-${++seq}`
  return {
    item: {
      id,
      name: `${id}.png`,
      fileName: `${id}.png`,
      kind: 'image',
      mime: 'image/png',
      size: 1,
      storage: 'managed',
      source: 'chat-image',
      createdAt: 1
    },
    sessionId,
    relation: sessionId ? 'sent' : null,
    at: 1
  }
}

beforeEach(() => {
  state.entries = []
  state.rows = {}
  state.settings = {}
  state.projects = {}
  state.pick.mockReset().mockImplementation((id: string) => state.rows[id])
  state.pickSettings.mockReset().mockImplementation((id: string) => state.settings[id])
  state.getById.mockReset().mockImplementation((id: string) => state.projects[id])
})

describe('libraryTimelineView', () => {
  it('TL-74 条目原样；sessions 只有标题与用得上的键；没有会话的条目不占键', () => {
    state.entries = [entry('S1'), entry('S2'), entry(null)]
    state.rows = {
      S1: { title: 'Trip plan', projectId: 'p1' },
      S2: { title: 'Loose chat', projectId: null }
    }
    state.projects = { p1: { name: 'Alpha' } }

    const view = libraryTimelineView()

    expect(view.entries).toBe(state.entries)
    expect(view.sessions).toStrictEqual({
      S1: { title: 'Trip plan', projectName: 'Alpha' },
      S2: { title: 'Loose chat' }
    })
  })

  it('TL-75 同一条会话的三条：只查一次', () => {
    state.entries = [entry('S1'), entry('S1'), entry('S1')]
    state.rows = { S1: { title: 'T', projectId: null } }
    libraryTimelineView()
    expect(state.pick).toHaveBeenCalledTimes(1)
    expect(state.pick.mock.calls[0][0]).toBe('S1')
  })

  it('TL-76 会话行已经不在：不进 sessions，不查它的设置，条目还在', () => {
    state.entries = [entry('gone')]
    const view = libraryTimelineView()
    expect(view.sessions).toStrictEqual({})
    expect(state.pickSettings).not.toHaveBeenCalled()
    expect(view.entries).toHaveLength(1)
    expect(view.entries[0].sessionId).toBe('gone')
  })

  it('TL-77 Bot 会话：项目名取它引用的工作项目', () => {
    state.entries = [entry('S1')]
    state.rows = { S1: { title: 'Bot chat', projectId: null } }
    state.settings = { S1: { workProject: 'p2' } }
    state.projects = { p2: { name: 'Beta' } }
    expect(libraryTimelineView().sessions).toStrictEqual({
      S1: { title: 'Bot chat', projectName: 'Beta' }
    })
  })

  it.each(['__agents__', '__knowledge_user__', '__skills:foo__'])(
    'TL-78 隐藏的承载项目 %s：没有项目名，也不去查它',
    (projectId) => {
      state.entries = [entry('S1')]
      state.rows = { S1: { title: 'Note', projectId } }
      state.projects = { [projectId]: { name: 'Hidden' } }
      expect(libraryTimelineView().sessions.S1).not.toHaveProperty('projectName')
      expect(state.getById).not.toHaveBeenCalled()
    }
  )

  it('TL-79 项目已经不在：没有项目名，标题还在', () => {
    state.entries = [entry('S1')]
    state.rows = { S1: { title: 'Orphan', projectId: 'p-gone' } }
    expect(libraryTimelineView().sessions).toStrictEqual({ S1: { title: 'Orphan' } })
    expect(state.getById).toHaveBeenCalledWith('p-gone')
  })

  it('TL-80 notebookPath 有值 → notebook: true；空串、没有 → 没有这个键', () => {
    state.entries = [entry('N'), entry('E'), entry('P')]
    state.rows = {
      N: { title: 'n', projectId: null },
      E: { title: 'e', projectId: null },
      P: { title: 'p', projectId: null }
    }
    state.settings = { N: { notebookPath: 'notes/a.md' }, E: { notebookPath: '' } }
    expect(libraryTimelineView().sessions).toStrictEqual({
      N: { title: 'n', notebook: true },
      E: { title: 'e' },
      P: { title: 'p' }
    })
  })
})
