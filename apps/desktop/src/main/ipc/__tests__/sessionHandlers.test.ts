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
 *   SH-5 会话权限表的四个通道（取代 `session:removeAllowListEntry`）接到 services/acl（替身）：listAcl 原样
 *        交回表；grantAcl 只认 read / write（别的访问方式不碰服务，回 success: false）、按服务的结果回
 *        success 与那一行；setAclAccess 同样先验访问方式；removeAclEntry 回服务删没删
 *   RD-9 `session:updateEnabledTools` 等 sessionService.updateEnabledTools（有 agent 时当场重配，异步）落定，回
 *        `{ success: <它答的那一位> }` —— 不等的话 success 会是一个 Promise 对象，前端恒以为写进去了
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: unknown, ...args: unknown[]) => unknown

const state = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  create: vi.fn(),
  updateEnabledTools: vi.fn<(id: string, enabledTools: string[]) => Promise<boolean>>(),
  getRuntimeStatuses: vi.fn(),
  contexts: [] as unknown[],
  aclEntries: vi.fn((_id: string): unknown[] => []),
  aclGrantPath: vi.fn((_id: string, _path: string, _access: string): unknown => null),
  aclSetAccess: vi.fn((_id: string, _entryId: string, _access: string): boolean => false),
  aclRemove: vi.fn((_id: string, _entryId: string): boolean => false)
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
vi.mock('../../services/sessionService', () => ({
  sessionService: { create: state.create, updateEnabledTools: state.updateEnabledTools }
}))
vi.mock('../../services/acl', () => ({
  sessionAcl: {
    entries: state.aclEntries,
    entriesForDisplay: state.aclEntries,
    grantPath: state.aclGrantPath,
    setAccess: state.aclSetAccess,
    remove: state.aclRemove
  }
}))
vi.mock('../../services/filesWatcherService', () => ({ closeWatcherIfWorkingDirectory: vi.fn() }))
vi.mock('../../services/sessionMentions', () => ({ listSessionMentions: vi.fn(() => []) }))
vi.mock('../../frontend', () => ({
  chatGateway: { getRuntimeStatuses: state.getRuntimeStatuses },
  operationContext: {
    run: (ctx: unknown, fn: () => unknown) => {
      state.contexts.push(ctx)
      return fn()
    }
  },
  createClientContext: (_ctx: unknown, sessionId: string) => ({ electron: sessionId })
}))
vi.mock('../../services/pinnedChatService', () => ({ isPinned: vi.fn(), unpin: vi.fn() }))
vi.mock('../../services/sessionFork', () => ({ forkSession: vi.fn() }))

import { registerSessionHandlers } from '../sessionHandlers'
import { attachIpcAdapter } from '../ipcAdapter'

registerSessionHandlers()
// 注册表经 IPC 适配器挂到（替身）ipcMain 上：handlers 里收的是适配器包过的处理函数
attachIpcAdapter()

/** 像渲染端 invoke 那样调一个已注册的处理函数 */
const invoke = (channel: string, ...args: unknown[]): unknown => {
  const handler = state.handlers.get(channel)
  if (!handler) throw new Error(`no handler for ${channel}`)
  return handler({ sender: { id: 1 } }, ...args)
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

  it('SH-1 其余字段原样透传（项目、父会话、笔记本、bot、标题）', () => {
    const params = {
      title: 't',
      projectId: 'p1',
      parentId: 'P',
      notebookPath: 'notes/a.md',
      bot: 'scout'
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

describe('SH-5 会话权限表的通道', () => {
  beforeEach(() => {
    state.aclEntries.mockReset()
    state.aclGrantPath.mockReset()
    state.aclSetAccess.mockReset()
    state.aclRemove.mockReset()
  })

  const row = {
    id: 'e1',
    sessionId: 's1',
    kind: 'path',
    target: '/Users/u/notes',
    access: 'read',
    source: 'user',
    sourceKey: '',
    createdAt: 1,
    updatedAt: 1
  }

  it('SH-5 session:listAcl → 服务给的表原样', () => {
    state.aclEntries.mockReturnValue([row])
    expect(invoke('session:listAcl', 's1')).toEqual([row])
    expect(state.aclEntries.mock.calls).toEqual([['s1']])
  })

  it('SH-5 session:grantAcl：read / write 交给 grantPath（来源由服务记为 user），按结果回 success 与那一行；别的访问方式不碰服务', () => {
    state.aclGrantPath.mockReturnValueOnce(row)
    expect(
      invoke('session:grantAcl', { id: 's1', target: '/Users/u/notes', access: 'read' })
    ).toEqual({ success: true, entry: row })
    // 服务拒了（相对路径 / 会话不在）→ success: false
    expect(invoke('session:grantAcl', { id: 's1', target: 'rel', access: 'write' })).toEqual({
      success: false,
      entry: null
    })
    expect(state.aclGrantPath.mock.calls).toEqual([
      ['s1', '/Users/u/notes', 'read'],
      ['s1', 'rel', 'write']
    ])

    state.aclGrantPath.mockClear()
    for (const access of ['admin', 'execute', '', undefined]) {
      expect(invoke('session:grantAcl', { id: 's1', target: '/x', access })).toEqual({
        success: false,
        entry: null
      })
    }
    expect(state.aclGrantPath).not.toHaveBeenCalled()
  })

  it('SH-5 session:setAclAccess 先验访问方式再交给 setAccess；session:removeAclEntry 回服务删没删', () => {
    state.aclSetAccess.mockReturnValueOnce(true)
    expect(invoke('session:setAclAccess', { id: 's1', entryId: 'e1', access: 'write' })).toEqual({
      success: true
    })
    expect(invoke('session:setAclAccess', { id: 's1', entryId: 'e1', access: 'admin' })).toEqual({
      success: false
    })
    expect(state.aclSetAccess.mock.calls).toEqual([['s1', 'e1', 'write']])

    state.aclRemove.mockReturnValueOnce(true).mockReturnValueOnce(false)
    expect(invoke('session:removeAclEntry', { id: 's1', entryId: 'e1' })).toEqual({ success: true })
    expect(invoke('session:removeAclEntry', { id: 's1', entryId: 'workdir-row' })).toEqual({
      success: false
    })
    expect(state.aclRemove.mock.calls).toEqual([
      ['s1', 'e1'],
      ['s1', 'workdir-row']
    ])
  })

  it('SH-5 旧通道 session:removeAllowListEntry 不再注册', () => {
    expect(state.handlers.has('session:removeAllowListEntry')).toBe(false)
    for (const channel of [
      'session:listAcl',
      'session:grantAcl',
      'session:setAclAccess',
      'session:removeAclEntry'
    ]) {
      expect(state.handlers.has(channel), channel).toBe(true)
    }
  })
})

describe('RD-9 session:updateEnabledTools 等写入与重配落定', () => {
  it.each<[boolean]>([[true], [false]])(
    'RD-9 sessionService 答 %s → { success: 同一位 }；参数原样交出',
    async (answer) => {
      state.updateEnabledTools.mockReset().mockResolvedValue(answer)
      await expect(
        invoke('session:updateEnabledTools', { id: 's1', enabledTools: ['mcp:a', '-skill:b'] })
      ).resolves.toEqual({ success: answer })
      expect(state.updateEnabledTools.mock.calls).toEqual([['s1', ['mcp:a', '-skill:b']]])
    }
  )

  it('RD-9 重配挂着时不答；落定才回', async () => {
    let finish!: (ok: boolean) => void
    state.updateEnabledTools.mockReset().mockReturnValue(new Promise<boolean>((r) => (finish = r)))
    let result: unknown = 'pending'
    const pending = Promise.resolve(
      invoke('session:updateEnabledTools', { id: 's1', enabledTools: [] })
    ).then((r) => {
      result = r
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(result).toBe('pending')
    finish(true)
    await pending
    expect(result).toEqual({ success: true })
  })
})
