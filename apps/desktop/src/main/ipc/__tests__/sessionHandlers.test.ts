/**
 * sessionHandlers —— IPC `session:create` 滤掉 `chromeTab`。
 *
 * Chrome 标签页会话只由 Chrome 前端开（它核对过是哪个浏览器、哪个标签页）；渲染层（以及 window.api
 * 跟着导航到的任何页面）传来的 chromeTab 一律不认 —— 否则谁都能造一条挂在任意标签页上的会话，
 * 再以侧边栏的身份去碰它。其余字段原样交给 sessionService.create；不传参数就是不传。
 *
 * electron 是替身（handle 收进 Map）；sessionService 只替到 create 那一层。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: unknown, ...args: unknown[]) => unknown

const state = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  create: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: Handler) => {
      state.handlers.set(channel, handler)
    }
  },
  dialog: { showOpenDialog: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn() }
}))
vi.mock('../../services/sessionService', () => ({ sessionService: { create: state.create } }))
vi.mock('../../services/filesWatcherService', () => ({ closeWatcherIfWorkingDirectory: vi.fn() }))
vi.mock('../../frontend', () => ({
  chatGateway: {},
  operationContext: { run: (_ctx: unknown, fn: () => unknown) => fn() },
  createElectronContext: vi.fn()
}))
vi.mock('../../services/pinnedChatService', () => ({ isPinned: vi.fn(), unpin: vi.fn() }))

import { registerSessionHandlers } from '../sessionHandlers'

registerSessionHandlers()

/** 像渲染端 invoke 那样调一个已注册的处理函数 */
const invoke = (channel: string, ...args: unknown[]): unknown => {
  const handler = state.handlers.get(channel)
  if (!handler) throw new Error(`no handler for ${channel}`)
  return handler({}, ...args)
}

const BINDING = { installId: 'i1', runId: 'r1', tabId: 5 }

beforeEach(() => {
  state.create.mockReset()
  state.create.mockImplementation((params: unknown) => ({ id: 's-new', params }))
})

describe('SH-1 session:create 滤掉 chromeTab', () => {
  it('SH-1 带 chromeTab → create 收到的 chromeTab 是 undefined，其余原样', () => {
    const result = invoke('session:create', { title: 'x', chromeTab: BINDING })
    expect(state.create.mock.calls).toEqual([[{ title: 'x', chromeTab: undefined }]])
    expect(state.create.mock.calls[0][0].chromeTab).toBeUndefined()
    expect(result).toEqual({ id: 's-new', params: { title: 'x', chromeTab: undefined } })
  })

  it('SH-1 不传参数 → create(undefined)', () => {
    invoke('session:create')
    expect(state.create.mock.calls).toEqual([[undefined]])
    expect(state.create.mock.calls[0]).toHaveLength(1)
  })

  it('SH-1 其余字段原样透传（项目、父会话、笔记本、bot、记忆 slug、标题）', () => {
    const params = {
      title: 't',
      projectId: 'p1',
      parentId: 'P',
      notebookPath: 'notes/a.md',
      bot: 'scout',
      memorySlug: 'm'
    }
    invoke('session:create', params)
    expect(state.create.mock.calls[0][0]).toEqual({ ...params, chromeTab: undefined })
    expect(state.create.mock.calls[0][0]).toMatchObject(params)
  })

  it('SH-1 不改调用方传进来的对象', () => {
    const params = { title: 'x', chromeTab: { ...BINDING } }
    invoke('session:create', params)
    expect(params.chromeTab).toEqual(BINDING)
    expect(state.create.mock.calls[0][0]).not.toBe(params)
  })
})
