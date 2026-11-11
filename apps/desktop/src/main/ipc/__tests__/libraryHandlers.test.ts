/**
 * `ipc/libraryHandlers.ts`（文件库 L1）—— `library:add`（一个文件进库）与只在桌面可用的 `library:pickFiles`（本机的
 * 选择文件对话框），外加通道表。经注册表的定义直接调用（`listDefinitions()`），ctx 分别给 ipc / network / agent。
 *
 * 替身照 fsHandlers.test.ts：electron 的 `dialog.showOpenDialog` 是间谍；services/fileLibrary 的 `addToLibrary` 回哨兵值、
 * `recordSessionAttached` 是间谍；`ipcAdapter.windowOf` 是间谍。
 *
 *   LH-1 桌面交路径：参数原样（label 只收字符串）、返回值原样
 *   LH-2 网络客户端与 agent 不能交路径（附件稿 §9）；交字节照常
 *   LH-3 参数不对 → refused「Invalid file.」，name 能取到就取、取不到为 ''；addToLibrary 不调
 *   LH-4 来源白名单：note-paste / note-drop / note-insert 原样，其余一律 import
 *   LH-5 library:pickFiles：没有窗口 / 取消 / 选了 0 个 → null；选了 → 路径原样；对话框参数
 *   LH-6 通道表：API_TABLE.library、CHANNEL_ACCESS、channelScopeOf、DESKTOP_ONLY_CHANNELS
 *   LH-7 （2026-11-11 补）sessionId：合法（isSafeSessionId）且进库成功 → recordSessionAttached(sessionId, item.id, source)；
 *        不合法、不是字符串、进库失败 → 不调
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import type { ClientContext } from '../registry'
import type { LibraryAddResult } from '@shuvix/chat-protocol/fileLibrary'

const state = vi.hoisted(() => ({
  showOpenDialog: vi.fn(),
  windowOf: vi.fn(),
  addToLibrary: vi.fn(),
  recordSessionAttached: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  app: { getPath: () => tmpdir() },
  dialog: { showOpenDialog: state.showOpenDialog },
  BrowserWindow: { fromWebContents: () => null }
}))
vi.mock('../ipcAdapter', () => ({ windowOf: state.windowOf }))
vi.mock('../../services/fileLibrary', () => ({
  addToLibrary: state.addToLibrary,
  recordSessionAttached: state.recordSessionAttached
}))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

import { listDefinitions } from '../registry'
import { registerLibraryHandlers } from '../libraryHandlers'
import { API_TABLE, DESKTOP_ONLY_CHANNELS } from '../../../shared/apiTable'
import { CHANNEL_ACCESS, channelScopeOf } from '../../../shared/channelAccess'

const ID = '0199d3a2-7b3e-7c4d-9a1f-2e5b8c7d6f10'

const winCtx: ClientContext = {
  client: { kind: 'window', id: 'ipc:7', webContentsId: 7 },
  transport: 'ipc'
}
const netCtx: ClientContext = {
  client: { kind: 'network', id: 'ws:1', remoteAddress: '192.168.1.20', userAgent: 'UA/1' },
  transport: 'network'
}
const agentCtx: ClientContext = {
  client: { kind: 'agent', id: 'agent:S', sessionId: 'S' },
  transport: 'agent'
}

/** addToLibrary 的哨兵返回值 */
const SENTINEL: LibraryAddResult = {
  ok: true,
  reused: false,
  item: {
    id: ID,
    name: 'a.png',
    fileName: 'a.png',
    kind: 'image',
    mime: 'image/png',
    size: 3,
    storage: 'managed',
    source: 'note-drop',
    createdAt: 1
  },
  markdown: `![a](shuvix://file/${ID}/a.png)`
}

function call(ctx: ClientContext, channel: string, ...args: unknown[]): unknown {
  const definition = listDefinitions().find((d) => d.channel === channel)
  if (!definition) throw new Error(`no definition for ${channel}`)
  return definition.fn(ctx, ...args)
}

const add = (ctx: ClientContext, params: unknown): Promise<LibraryAddResult> =>
  call(ctx, 'library:add', params) as Promise<LibraryAddResult>

const bytes = { kind: 'bytes', name: 'a.png', mimeType: 'image/png', dataBase64: 'AAEC' }

beforeAll(() => {
  registerLibraryHandlers()
})

beforeEach(() => {
  vi.clearAllMocks()
  state.addToLibrary.mockResolvedValue(SENTINEL)
})

describe('LH-1 桌面交路径', () => {
  it('参数原样交给 addToLibrary，返回值原样交回', async () => {
    const item = { kind: 'path', path: '/x/a.png' }
    const result = await add(winCtx, { item, source: 'note-drop', label: 'A' })

    expect(state.addToLibrary).toHaveBeenCalledTimes(1)
    expect(state.addToLibrary).toHaveBeenCalledWith({ item, source: 'note-drop', label: 'A' })
    expect(result).toBe(SENTINEL)
  })

  it.each<[string, unknown]>([
    ['null', null],
    ['5', 5],
    ['{}', {}]
  ])('label 是 %s：参数里没有 label 键', async (_l, label) => {
    await add(winCtx, { item: { kind: 'path', path: '/x/a.png' }, source: 'note-drop', label })
    const [arg] = state.addToLibrary.mock.calls[0] as [Record<string, unknown>]
    expect('label' in arg).toBe(false)
  })

  it("label '' 原样传", async () => {
    await add(winCtx, { item: bytes, source: 'note-paste', label: '' })
    expect(state.addToLibrary).toHaveBeenCalledWith({
      item: bytes,
      source: 'note-paste',
      label: ''
    })
  })
})

describe('LH-2 网络客户端与 agent 不能交路径', () => {
  it.each<[string, ClientContext]>([
    ['network', netCtx],
    ['agent', agentCtx]
  ])('%s 交 kind:path → refused，addToLibrary 不调', async (_l, ctx) => {
    const result = await add(ctx, {
      item: { kind: 'path', path: '/Users/x/a.png' },
      source: 'note-drop'
    })
    expect(result).toEqual({
      ok: false,
      reason: 'refused',
      name: 'a.png',
      message: 'Only file contents can be added from this client.'
    })
    expect(state.addToLibrary).not.toHaveBeenCalled()
  })

  it.each<[string, ClientContext]>([
    ['network', netCtx],
    ['agent', agentCtx]
  ])('%s 交 bytes → 照常交给 addToLibrary', async (_l, ctx) => {
    const result = await add(ctx, { item: bytes, source: 'note-paste' })
    expect(state.addToLibrary).toHaveBeenCalledWith({ item: bytes, source: 'note-paste' })
    expect(result).toBe(SENTINEL)
  })
})

describe('LH-3 参数不对 → refused「Invalid file.」', () => {
  it.each<[string, unknown, string]>([
    ['undefined', undefined, ''],
    ['null', null, ''],
    ['{}', {}, ''],
    ['{ item: null }', { item: null }, ''],
    ["path: ''", { item: { kind: 'path', path: '' }, source: 'note-drop' }, ''],
    [
      'bytes 缺 dataBase64',
      { item: { kind: 'bytes', name: 'a.png', mimeType: 'image/png' }, source: 'note-paste' },
      'a.png'
    ],
    [
      'bytes 缺 mimeType',
      { item: { kind: 'bytes', name: 'b.png', dataBase64: 'AA' }, source: 'note-paste' },
      'b.png'
    ]
  ])('%s', async (_l, params, name) => {
    const result = await add(winCtx, params)
    expect(result).toEqual({ ok: false, reason: 'refused', name, message: 'Invalid file.' })
    expect(state.addToLibrary).not.toHaveBeenCalled()
  })

  // 形状不对的入参（网络客户端交来的任意 JSON）：不抛，name 能取到就取、取不到为 ''（设计稿 LH-3；测试设计发现，2026-11-11 修）
  it.each<[string, unknown]>([
    ['path: 5', { item: { kind: 'path', path: 5 }, source: 'note-drop' }],
    [
      'bytes 的 name 不是字符串',
      { item: { kind: 'bytes', name: 5, mimeType: 'image/png', dataBase64: 'AA' } }
    ],
    ["kind: 'url'", { item: { kind: 'url', url: 'https://e.example/a.png' } }]
  ])('%s → name 为 ""，不抛', async (_l, params) => {
    const result = await add(winCtx, params)
    expect(result).toEqual({ ok: false, reason: 'refused', name: '', message: 'Invalid file.' })
    expect(state.addToLibrary).not.toHaveBeenCalled()
  })
})

describe('LH-4 来源白名单', () => {
  it.each(['note-paste', 'note-drop', 'note-insert'])('%s 原样', async (source) => {
    await add(winCtx, { item: bytes, source })
    expect(state.addToLibrary).toHaveBeenCalledWith({ item: bytes, source })
  })

  it.each<[string, unknown]>([
    ['chat-image', 'chat-image'],
    ['shown', 'shown'],
    ['artifact', 'artifact'],
    ['import', 'import'],
    ["'x'", 'x'],
    ['undefined', undefined],
    ['42', 42]
  ])('%s → import', async (_l, source) => {
    await add(netCtx, { item: bytes, source })
    expect(state.addToLibrary).toHaveBeenCalledWith({ item: bytes, source: 'import' })
  })
})

describe('LH-5 library:pickFiles', () => {
  const pick = (ctx: ClientContext = winCtx): Promise<string[] | null> =>
    call(ctx, 'library:pickFiles') as Promise<string[] | null>

  it('windowOf 回 null → null，对话框没开', async () => {
    state.windowOf.mockReturnValue(null)
    await expect(pick()).resolves.toBeNull()
    expect(state.windowOf).toHaveBeenCalledWith(winCtx)
    expect(state.showOpenDialog).not.toHaveBeenCalled()
  })

  it('取消 → null；选了 0 个 → null；选了两个 → 原样；参数是 (win, openFile + multiSelections)', async () => {
    const win = { id: 7 }
    state.windowOf.mockReturnValue(win)

    state.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] })
    await expect(pick()).resolves.toBeNull()
    state.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [] })
    await expect(pick()).resolves.toBeNull()
    state.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: ['/a/x.png', '/b/y.pdf']
    })
    await expect(pick()).resolves.toEqual(['/a/x.png', '/b/y.pdf'])

    expect(state.showOpenDialog).toHaveBeenCalledTimes(3)
    for (const args of state.showOpenDialog.mock.calls) {
      expect(args).toEqual([win, { properties: ['openFile', 'multiSelections'] }])
    }
  })
})

describe('LH-6 通道表', () => {
  it('API_TABLE.library：add（invoke，1 个参数）与 pickFiles（invoke，0 个参数）', () => {
    expect(API_TABLE.library).toEqual({
      add: { kind: 'invoke', channel: 'library:add', args: 1 },
      pickFiles: { kind: 'invoke', channel: 'library:pickFiles', args: 0 }
    })
  })

  it('CHANNEL_ACCESS 都是 write；scope 都是 files', () => {
    for (const channel of ['library:add', 'library:pickFiles']) {
      expect(CHANNEL_ACCESS[channel], channel).toBe('write')
      expect(channelScopeOf(channel), channel).toBe('files')
    }
  })

  it('DESKTOP_ONLY_CHANNELS 有 library:pickFiles、没有 library:add（网络客户端可以交字节）', () => {
    expect(Object.keys(DESKTOP_ONLY_CHANNELS)).toContain('library:pickFiles')
    expect(Object.keys(DESKTOP_ONLY_CHANNELS)).not.toContain('library:add')
  })

  it('两条通道都注册了处理器', () => {
    const channels = listDefinitions().map((d) => d.channel)
    expect(channels).toEqual(expect.arrayContaining(['library:add', 'library:pickFiles']))
  })
})

describe('LH-7 sessionId → recordSessionAttached', () => {
  it.each<[string, ClientContext]>([
    ['ipc', winCtx],
    ['network', netCtx]
  ])(
    '%s：合法 sessionId 且进库成功 → 调一次 (sessionId, item.id, source)；sessionId 不交给 addToLibrary',
    async (_l, ctx) => {
      const result = await add(ctx, { item: bytes, source: 'note-paste', sessionId: 'sess-1' })
      expect(result).toBe(SENTINEL)
      expect(state.recordSessionAttached).toHaveBeenCalledTimes(1)
      expect(state.recordSessionAttached).toHaveBeenCalledWith('sess-1', ID, 'note-paste')
      expect(state.addToLibrary).toHaveBeenCalledWith({ item: bytes, source: 'note-paste' })
    }
  )

  it('来源不在白名单：按归一后的 import 记', async () => {
    await add(winCtx, { item: bytes, source: 'chat-image', sessionId: 'sess-1' })
    expect(state.recordSessionAttached).toHaveBeenCalledWith('sess-1', ID, 'import')
  })

  it.each<[string, unknown]>([
    ['含 /', 'a/b'],
    ['含 \\', 'a\\b'],
    ['..', '..'],
    ['.', '.'],
    ['含 ..', 'x..y'],
    ['空串', ''],
    ['数字', 5],
    ['对象', { id: 'sess-1' }]
  ])('sessionId 不合法（%s）→ 不调，进库照常', async (_l, sessionId) => {
    const result = await add(winCtx, { item: bytes, source: 'note-paste', sessionId })
    expect(result).toBe(SENTINEL)
    expect(state.addToLibrary).toHaveBeenCalledTimes(1)
    expect(state.recordSessionAttached).not.toHaveBeenCalled()
  })

  it('进库失败 → 不调；结果原样', async () => {
    const failure: LibraryAddResult = {
      ok: false,
      name: 'a.png',
      reason: 'too-large',
      message: '32 MB'
    }
    state.addToLibrary.mockResolvedValueOnce(failure)
    await expect(
      add(winCtx, { item: bytes, source: 'note-paste', sessionId: 'sess-1' })
    ).resolves.toBe(failure)
    expect(state.recordSessionAttached).not.toHaveBeenCalled()
  })

  it('被拒（网络交路径、参数不对）→ 不调', async () => {
    await add(netCtx, {
      item: { kind: 'path', path: '/x/a.png' },
      source: 'note-drop',
      sessionId: 'sess-1'
    })
    await add(winCtx, { item: { kind: 'path', path: '' }, sessionId: 'sess-1' })
    expect(state.recordSessionAttached).not.toHaveBeenCalled()
  })
})
