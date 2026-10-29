/**
 * widgetHandlers —— Widget 面板用到的两条 IPC：独立窗口状态、打开方式的记忆。
 * 处理函数只做参数整形 + 透传，判定在服务里。
 *
 *   IW-3 widgetWindow:status：丢掉非字符串；回 {open: openIds(), preferWindow: preferWindowIds(list)}；不是数组 → preferWindowIds([])
 *   IW-4 widgetWindow:setPreferWindow：缺 id / id 不是字符串 → {success:false}；value 只认 true（'true' 存成 false）
 *   IW-5 window.api 的 widgetWindow.status / widgetWindow.setPreferWindow 走的就是这两条通道、各转发一个参数
 *   IW-6 主屏那两条没了：API_TABLE.widget 里没有 getIcon / setHomeOrder，也没注册 widget:getIcon / widget:setHomeOrder
 *   IW-7 widget:list 给每个组件补上 projects（{id, name}，按 projectIds 的顺序）：删掉了的项目、隐藏的承载项目不出标签，
 *        隐藏的 id 根本不去查；别的字段（含 projectIds）原样；没有项目 → []
 *   IW-8 一次列表里同一个项目 id 只查一次名字；下一次列表再查（改了名就跟着变）
 *   IW-9 widget:listArchived 同 IW-7
 *   IW-10 查某个项目的名字抛错 → 只少那一个标签，列表照样给
 *
 * electron 是替身（handle 收进 Map），widget 服务、项目服务与窗口服务整个替掉。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { API_TABLE } from '../../../shared/apiTable'

type Handler = (event: unknown, ...args: unknown[]) => unknown

const state = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  openIds: vi.fn(),
  preferWindowIds: vi.fn(),
  setPreferWindow: vi.fn(),
  listActive: vi.fn(),
  listArchived: vi.fn(),
  getProjectById: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      state.handlers.set(channel, fn)
    }
  },
  dialog: { showSaveDialog: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') },
  shell: { showItemInFolder: vi.fn() }
}))
vi.mock('../../services/widget', () => ({
  widgetService: { listActive: state.listActive, listArchived: state.listArchived },
  widgetServer: {},
  exportWidget: vi.fn(),
  resolveExportZipPath: vi.fn(),
  WidgetExportError: class WidgetExportError extends Error {}
}))
// 列表补项目名（widgetHandlers 的 withProjectTags）：真的项目服务要数据库
vi.mock('../../services/projectService', () => ({
  projectService: { getById: state.getProjectById }
}))
vi.mock('../../services/widgetWindowService', () => ({
  openIds: state.openIds,
  preferWindowIds: state.preferWindowIds,
  setPreferWindow: state.setPreferWindow,
  open: vi.fn(),
  close: vi.fn(),
  setAlwaysOnTop: vi.fn(),
  getAlwaysOnTop: vi.fn()
}))

import { registerWidgetHandlers } from '../widgetHandlers'
import { attachIpcAdapter } from '../ipcAdapter'

const IPC_EVENT = { sender: { id: 1 } }
/** 已注册的处理函数（发送方 = webContents 1；事件参数由这里补上） */
const handler =
  (channel: string): ((...args: unknown[]) => unknown) =>
  (...args) => {
    const fn = state.handlers.get(channel)
    if (!fn) throw new Error(`no handler for ${channel}`)
    return fn(IPC_EVENT, ...args)
  }

registerWidgetHandlers()
attachIpcAdapter()

beforeEach(() => {
  state.openIds.mockReset().mockReturnValue([])
  state.preferWindowIds.mockReset().mockReturnValue([])
  state.setPreferWindow.mockReset()
  state.listActive.mockReset().mockReturnValue([])
  state.listArchived.mockReset().mockReturnValue([])
  state.getProjectById.mockReset()
})

describe('widgetWindow:status（IW-3）', () => {
  it('IW-3 丢掉非字符串，回 open 与 preferWindow', async () => {
    state.openIds.mockReturnValue(['x-y'])
    state.preferWindowIds.mockReturnValue(['a-b'])
    expect(await handler('widgetWindow:status')(['a-b', 3, null, 'c-d'])).toEqual({
      open: ['x-y'],
      preferWindow: ['a-b']
    })
    expect(state.preferWindowIds).toHaveBeenCalledWith(['a-b', 'c-d'])
  })

  it('IW-3 不是数组 → preferWindowIds([])', async () => {
    state.openIds.mockReturnValue(['x-y'])
    const result = await handler('widgetWindow:status')(undefined)
    expect(state.preferWindowIds).toHaveBeenCalledWith([])
    expect(result).toEqual({ open: ['x-y'], preferWindow: [] })

    await handler('widgetWindow:status')('a-b')
    expect(state.preferWindowIds).toHaveBeenLastCalledWith([])
  })
})

describe('widgetWindow:setPreferWindow（IW-4）', () => {
  it('IW-4 缺 id / id 不是字符串 → {success:false}，不写', async () => {
    for (const bad of [undefined, null, {}, { id: 7, value: true }, { value: true }]) {
      expect(await handler('widgetWindow:setPreferWindow')(bad)).toEqual({ success: false })
    }
    expect(state.setPreferWindow).not.toHaveBeenCalled()
  })

  it('IW-4 value 只认 true', async () => {
    expect(await handler('widgetWindow:setPreferWindow')({ id: 'a-b', value: true })).toEqual({
      success: true
    })
    expect(state.setPreferWindow).toHaveBeenLastCalledWith('a-b', true)

    await handler('widgetWindow:setPreferWindow')({ id: 'a-b', value: 'true' })
    expect(state.setPreferWindow).toHaveBeenLastCalledWith('a-b', false)

    await handler('widgetWindow:setPreferWindow')({ id: 'a-b' })
    expect(state.setPreferWindow).toHaveBeenLastCalledWith('a-b', false)
  })
})

describe('通道表（IW-5）', () => {
  it('IW-5 两个成员走的就是这两条通道、各转发一个参数', () => {
    expect(API_TABLE.widgetWindow.status).toEqual({
      kind: 'invoke',
      channel: 'widgetWindow:status',
      args: 1
    })
    expect(API_TABLE.widgetWindow.setPreferWindow).toEqual({
      kind: 'invoke',
      channel: 'widgetWindow:setPreferWindow',
      args: 1
    })
    for (const channel of ['widgetWindow:status', 'widgetWindow:setPreferWindow']) {
      expect(state.handlers.has(channel), channel).toBe(true)
    }
  })
})

describe('主屏的两条通道已去掉（IW-6）', () => {
  it('IW-6 API_TABLE.widget 没有 getIcon / setHomeOrder，处理函数也没注册', () => {
    expect(Object.keys(API_TABLE.widget)).not.toContain('getIcon')
    expect(Object.keys(API_TABLE.widget)).not.toContain('setHomeOrder')
    // 注册是真的发生了（别的 widget 通道都在），不是整张表空着
    expect(state.handlers.has('widget:delete')).toBe(true)
    for (const channel of ['widget:getIcon', 'widget:setHomeOrder']) {
      expect(state.handlers.has(channel), channel).toBe(false)
    }
  })
})

/** 一份组件摘要（WidgetSummary 的形状） */
const summary = (id: string, projectIds: string[]): Record<string, unknown> => ({
  id,
  name: id.toUpperCase(),
  description: `about ${id}`,
  createdAt: 1,
  updatedAt: 2,
  lastOpenedAt: 3,
  archivedAt: 0,
  projectIds
})

/** 项目表：p1 → One，p2 → Two，别的都没有 */
const NAMES: Record<string, string> = { p1: 'One', p2: 'Two' }
const projectsByName = (id: string): { id: string; name: string } | undefined =>
  NAMES[id] === undefined ? undefined : { id, name: NAMES[id] }

describe.each([
  ['widget:list', 'IW-7', () => state.listActive],
  ['widget:listArchived', 'IW-9', () => state.listArchived]
])('%s 补项目名', (channel, caseId, listOf) => {
  it(`${caseId} 按 projectIds 的顺序给 {id, name}；删掉的与隐藏的不出，隐藏的不查；别的字段原样`, async () => {
    const a = summary('aa-a', ['p2', 'gone', '__knowledge__', 'p1'])
    const b = summary('bb-b', [])
    listOf().mockReturnValue([a, b])
    state.getProjectById.mockImplementation(projectsByName)

    const out = (await handler(channel)()) as Array<Record<string, unknown>>

    expect(out).toEqual([
      {
        ...a,
        projects: [
          { id: 'p2', name: 'Two' },
          { id: 'p1', name: 'One' }
        ]
      },
      { ...b, projects: [] }
    ])
    expect(out[0].projectIds).toEqual(['p2', 'gone', '__knowledge__', 'p1'])
    const asked = state.getProjectById.mock.calls.map((c) => c[0])
    expect(asked).not.toContain('__knowledge__')
    expect([...asked].sort()).toEqual(['gone', 'p1', 'p2'])
  })
})

describe('项目名的查法（IW-8、IW-10）', () => {
  it('IW-8 一次列表里共用的项目 id 只查一次；下一次列表再查，改了的名字跟着变', async () => {
    state.listActive.mockReturnValue([summary('aa-a', ['p1', 'p2']), summary('bb-b', ['p1'])])
    state.getProjectById.mockImplementation(projectsByName)

    const first = (await handler('widget:list')()) as Array<{ projects: unknown }>
    expect(first.map((w) => w.projects)).toEqual([
      [
        { id: 'p1', name: 'One' },
        { id: 'p2', name: 'Two' }
      ],
      [{ id: 'p1', name: 'One' }]
    ])
    expect(state.getProjectById.mock.calls.map((c) => c[0])).toEqual(['p1', 'p2'])

    state.getProjectById.mockClear()
    NAMES.p1 = 'One renamed'
    try {
      const second = (await handler('widget:list')()) as Array<{ projects: unknown }>
      expect(state.getProjectById.mock.calls.map((c) => c[0])).toEqual(['p1', 'p2'])
      expect(second[1].projects).toEqual([{ id: 'p1', name: 'One renamed' }])
    } finally {
      NAMES.p1 = 'One'
    }
  })

  it('IW-10 查一个项目抛错 → 只少那一个标签，列表照样给', async () => {
    state.listActive.mockReturnValue([
      summary('aa-a', ['p1', 'bad', 'p2']),
      summary('bb-b', ['bad'])
    ])
    state.getProjectById.mockImplementation((id: string) => {
      if (id === 'bad') throw new Error('SQLITE_BUSY')
      return projectsByName(id)
    })

    const out = (await handler('widget:list')()) as Array<{ id: string; projects: unknown }>

    expect(out.map((w) => [w.id, w.projects])).toEqual([
      [
        'aa-a',
        [
          { id: 'p1', name: 'One' },
          { id: 'p2', name: 'Two' }
        ]
      ],
      ['bb-b', []]
    ])
  })
})
