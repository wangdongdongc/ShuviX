/**
 * sessionHandlers —— IPC `session:create` 滤掉 `chromeTab`。
 *
 * Chrome 标签页会话只由 Chrome 前端开（它核对过是哪个浏览器、哪个标签页）；渲染层（以及 window.api
 * 跟着导航到的任何页面）传来的 chromeTab 一律不认 —— 否则谁都能造一条挂在任意标签页上的会话，
 * 再以侧边栏的身份去碰它。其余字段原样交给 sessionService.create；不传参数就是不传。
 *
 * electron 是替身（handle 收进 Map）；sessionService 只替到 create 那一层。
 *
 *   SH-2 内存会话是主进程内部的选项（create 的**第二个**参数），渲染层经 IPC 建不出来：
 *        载荷里带 `ephemeral: true`，create 收到的也只有一个参数
 *   SH-3 自带工作目录同样是主进程内部的选项：载荷里带 `workingDirectory`，create 也只收到一个参数
 *        （它留在 params 里 —— sessionService.create 不从 params 读它，见 sessionServiceWorkingDirectory 的 WD-6）
 *   SH-4 `runtime:statuses` 是异步的：处理函数交回网关的 Promise（ssh 那一份可能要读用户的 ssh 配置，
 *        不能同步挂住主进程），落定后形状原样（`{ db?, 'ssh:<alias>'… }`），且在这条会话的操作上下文里跑
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: unknown, ...args: unknown[]) => unknown

const state = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  create: vi.fn(),
  getRuntimeStatuses: vi.fn(),
  contexts: [] as unknown[]
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
  chatGateway: { getRuntimeStatuses: state.getRuntimeStatuses },
  operationContext: {
    run: (ctx: unknown, fn: () => unknown) => {
      state.contexts.push(ctx)
      return fn()
    }
  },
  createElectronContext: (sessionId: string) => ({ electron: sessionId })
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

describe('SH-2 session:create 建不出内存会话', () => {
  it('SH-2 载荷带 ephemeral: true → create 只收到一个参数（没有 options）', () => {
    invoke('session:create', { title: 'x', ephemeral: true })
    expect(state.create).toHaveBeenCalledTimes(1)
    expect(state.create.mock.calls[0]).toHaveLength(1)
  })
})

describe('SH-3 session:create 给不了自带工作目录', () => {
  it('SH-3 载荷带 workingDirectory → create 只收到一个参数（没有 options）', () => {
    invoke('session:create', { title: 'x', workingDirectory: '/Users/someone/private' })
    expect(state.create).toHaveBeenCalledTimes(1)
    expect(state.create.mock.calls[0]).toHaveLength(1)
  })

  it('SH-3 与 ephemeral 一起带 → 仍只有一个参数', () => {
    invoke('session:create', { workingDirectory: '/tmp/x', ephemeral: true })
    expect(state.create.mock.calls[0]).toHaveLength(1)
  })
})

describe('SH-4 runtime:statuses 是异步的', () => {
  it('SH-4 交回网关的 Promise，落定后形状原样，在这条会话的上下文里跑', async () => {
    const statuses = {
      db: { label: 'pg', icon: 'Database', color: '#22c55e' },
      'ssh:web': { label: 'web', icon: 'Terminal', color: '#38bdf8' }
    }
    state.getRuntimeStatuses.mockResolvedValue(statuses)
    state.contexts.length = 0

    const result = invoke('runtime:statuses', 's1')
    expect(result).toBeInstanceOf(Promise)
    await expect(result).resolves.toEqual(statuses)
    expect(state.getRuntimeStatuses.mock.calls).toEqual([['s1']])
    expect(state.contexts).toEqual([{ electron: 's1' }])
  })
})
