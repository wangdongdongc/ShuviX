/**
 * 改造时多出代码路径的那几个处理器（server mode phase A §3「17 个用到 event 的处理器」里推回调用方 / 认调用方 /
 * 要调用方窗口的），经**真的** IPC 适配器挂到假 ipcMain 上、以某个 webContents 的身份调用；服务一律替身。
 *
 *   CH-1 `tts:speakOnce`（wc7 调）：每片回调 → `wc7.send('tts:chunk', { filePath, index })`，别的窗口什么也收不到；
 *        合成途中 wc7 销毁 → 不再发、不抛，invoke 照样落定
 *   CH-2 `liveDoc:respond`（wc7 调）`{ requestId, result }` → `resolveLiveDocumentResponse(wc7 本身, requestId, result)`，
 *        回 `{ success: true }`
 *   CH-3 `notification:reportActiveSession(sid)`（wc7 调）→ `reportActiveSession(7, sid)`；没有窗口时
 *        （`fromWebContents` → null）`dialog:openDirectory` 回 null、`contextMenu:popup` 回 `{ actionId: null }`，
 *        不弹对话框、不建菜单
 *   CH-4 `liveDoc:attach`（wc7 调）`{ sessionId, attachId }` → `attachLiveDocument(sessionId, wc7 本身, attachId)`，
 *        回 `{ success: true }`
 *   CH-5 `liveDoc:detach`（wc7 调）→ `detachLiveDocument(sessionId, attachId, wc7 本身)`（只摘调用方自己挂的），
 *        回 `{ success: true }`
 *   CH-6 两条通道缺参数（没有参数 / 缺 attachId / 缺 sessionId / sessionId 空串）→ `{ success: false }`，不调桥
 *
 * 网络客户端（server mode phase B）调这些处理器：经注册表的定义直接以网络上下文调用（`listDefinitions()`），网络传输挂在
 * 注册表上、连接是假的（`frontend/network/__tests__/support/fakeNetworkConnection`）。
 *
 *   NH-1 `notification:reportActiveSession` 从网络来 → `reportActiveSession(null, sid)`，回 `{ success: true }`；null → (null, null)
 *   NH-2 `notification:consumePendingOpenSession` 从网络来 → null、不调服务；从窗口来 → 原样交回服务的结果
 *   NH-3 `liveDoc:respond` 从网络来 → `{ success: false }`，不调 resolveLiveDocumentResponse
 *   NH-4 `contextMenu:popup` / `dialog:openDirectory` 从网络来 → `{ actionId: null }` / null，不建菜单、不弹对话框，
 *        不查 fromWebContents / fromId
 *   NH-5 `tts:speakOnce` 从网络来：每片 → 那条连接收到 `{t:'push', channel:'tts:chunk', args:[{filePath, index}]}`；连接关了之后
 *        不再发，invoke 照样落定
 *   NH-6 `liveDoc:attach` 从网络来 → `{ success: false }`，不调 attachLiveDocument（网络客户端没有 webContents，
 *        它开着的笔记本走磁盘回落）
 *   NH-7 `liveDoc:detach` 从网络来 → `{ success: false }`，不调 detachLiveDocument
 *
 * electron 是替身（BrowserWindow / webContents / dialog / Menu）；webContents 用视图同步夹具的 `FakeWebContents`。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeWebContents } from '../../frontend/sync/__tests__/support/ipcLinkRig'

const state = vi.hoisted(() => ({
  getAllWindows: vi.fn((): unknown[] => []),
  fromWebContents: vi.fn((_contents: unknown): unknown => null),
  fromId: vi.fn((_id: number): unknown => undefined),
  showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: ['/picked'] })),
  buildFromTemplate: vi.fn(() => ({ popup: vi.fn() })),
  speakOnce: vi.fn(),
  resolveLiveDocumentResponse: vi.fn(),
  attachLiveDocument: vi.fn(),
  detachLiveDocument: vi.fn(),
  reportActiveSession: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: { getAllWindows: state.getAllWindows, fromWebContents: state.fromWebContents },
  webContents: { fromId: state.fromId },
  dialog: { showOpenDialog: state.showOpenDialog },
  Menu: { buildFromTemplate: state.buildFromTemplate }
}))
vi.mock('../../services/tts', () => ({
  ttsService: { speakOnce: state.speakOnce, abortSpeakOnce: vi.fn() }
}))
vi.mock('../../services/tts/qwen3ModelManager', () => ({
  qwen3ModelManager: {
    getStatus: vi.fn(),
    listVoices: vi.fn(),
    setup: vi.fn(),
    cancelSetup: vi.fn(),
    broadcastProgress: vi.fn()
  }
}))
vi.mock('../../services/liveDocumentBridge', () => ({
  resolveLiveDocumentResponse: state.resolveLiveDocumentResponse,
  attachLiveDocument: state.attachLiveDocument,
  detachLiveDocument: state.detachLiveDocument
}))
vi.mock('../../services/notificationService', () => ({
  reportActiveSession: state.reportActiveSession,
  consumePendingOpenSession: vi.fn()
}))
// sessionHandlers 的其余依赖（dialog:openDirectory 与它们无关）
// 会话权限表（services/acl）不在这组用例里：空表（真的那份落 SQLite，这里不起库）
vi.mock('../../services/acl', () => ({
  sessionAcl: { pathView: () => ({ read: [], write: [] }), sandboxEntries: () => [] }
}))
vi.mock('../../services/sessionService', () => ({ sessionService: {} }))
vi.mock('../../services/filesWatcherService', () => ({ closeWatcherIfWorkingDirectory: vi.fn() }))
vi.mock('../../frontend', () => ({
  chatGateway: {},
  operationContext: { run: (_ctx: unknown, fn: () => unknown) => fn() },
  createClientContext: vi.fn()
}))
vi.mock('../../services/pinnedChatService', () => ({ isPinned: vi.fn(), unpin: vi.fn() }))
vi.mock('../../services/sessionFork', () => ({ forkSession: vi.fn() }))

import { attachIpcAdapter } from '../ipcAdapter'
import { registerTtsHandlers } from '../ttsHandlers'
import { registerLiveDocumentHandlers } from '../liveDocumentHandlers'
import { registerNotificationHandlers } from '../notificationHandlers'
import { registerSessionHandlers } from '../sessionHandlers'
import { registerContextMenuHandlers } from '../contextMenuHandlers'
import { attachTransport, listDefinitions } from '../registry'
import { consumePendingOpenSession } from '../../services/notificationService'
import { createNetworkTransport } from '../../frontend/network/transport'
import {
  fakeConnection,
  netClient,
  netCtx
} from '../../frontend/network/__tests__/support/fakeNetworkConnection'

type IpcListener = (event: unknown, ...args: unknown[]) => unknown

/** 假 ipcMain：handle 收进 Map */
const handled = new Map<string, IpcListener>()
attachIpcAdapter({
  handle: (channel: string, listener: IpcListener) => {
    handled.set(channel, listener)
  },
  on: () => {}
} as never)
registerTtsHandlers()
registerLiveDocumentHandlers()
registerNotificationHandlers()
registerSessionHandlers()
registerContextMenuHandlers()
// 网络传输也挂上：推回网络客户端的东西经它到假连接
const networkTransport = createNetworkTransport()
attachTransport(networkTransport)

/** 以网络客户端 ws:1 的身份调一个已定义的处理器 */
function invokeFromNet(channel: string, ...args: unknown[]): unknown {
  const definition = listDefinitions().find((d) => d.channel === channel)
  if (!definition) throw new Error(`no definition for ${channel}`)
  return definition.fn(netCtx(1), ...args)
}

/** 以某个 webContents 的身份 invoke */
function invokeFrom(sender: FakeWebContents, channel: string, ...args: unknown[]): unknown {
  const listener = handled.get(channel)
  if (!listener) throw new Error(`no handler for ${channel}`)
  return listener({ sender }, ...args)
}

const windowOn = (wc: FakeWebContents): unknown => ({ isDestroyed: () => false, webContents: wc })

let wc7: FakeWebContents
let wc8: FakeWebContents

beforeEach(() => {
  vi.clearAllMocks()
  wc7 = new FakeWebContents(7)
  wc8 = new FakeWebContents(8)
  state.getAllWindows.mockImplementation(() => [windowOn(wc7), windowOn(wc8)])
  state.fromWebContents.mockImplementation(() => null)
  // 按 id 找会找到一个冒名的：推送应当认的是调用方那个对象
  state.fromId.mockImplementation(() => wc8)
})

/** tts 的 speakOnce 由用例驱动：拿到每片回调，`finish()` 结束 */
function controlSpeakOnce(): {
  chunk: () => (filePath: string, index: number) => void
  finish: () => void
} {
  let onChunk: ((filePath: string, index: number) => void) | undefined
  let resolve: (() => void) | undefined
  state.speakOnce.mockImplementation(
    (_params: unknown, cb: (filePath: string, index: number) => void) =>
      new Promise<void>((r) => {
        onChunk = cb
        resolve = r
      })
  )
  return {
    chunk: () => {
      if (!onChunk) throw new Error('speakOnce not called yet')
      return onChunk
    },
    finish: () => resolve?.()
  }
}

describe('CH-1 tts:speakOnce 把切片推回调用方', () => {
  it("CH-1 每片 → wc7.send('tts:chunk', { filePath, index })；别的窗口什么也收不到", async () => {
    const ctl = controlSpeakOnce()
    const pending = invokeFrom(wc7, 'tts:speakOnce', { text: 'hello' }) as Promise<unknown>
    expect(state.speakOnce).toHaveBeenCalledTimes(1)
    expect(state.speakOnce.mock.calls[0][0]).toEqual({ text: 'hello' })
    ctl.chunk()('/tmp/a.wav', 0)
    ctl.chunk()('/tmp/b.wav', 1)
    expect(wc7.sent).toEqual([
      ['tts:chunk', { filePath: '/tmp/a.wav', index: 0 }],
      ['tts:chunk', { filePath: '/tmp/b.wav', index: 1 }]
    ])
    ctl.finish()
    await expect(pending).resolves.toBeUndefined()
    expect(wc8.sent).toEqual([])
  })

  it('CH-1 合成途中 wc7 销毁 → 不再发、不抛，invoke 照样落定', async () => {
    const ctl = controlSpeakOnce()
    const pending = invokeFrom(wc7, 'tts:speakOnce', { text: 'hello' }) as Promise<unknown>
    ctl.chunk()('/tmp/a.wav', 0)
    wc7.destroy()
    wc7.throwOnSend = true
    expect(() => ctl.chunk()('/tmp/b.wav', 1)).not.toThrow()
    ctl.finish()
    await expect(pending).resolves.toBeUndefined()
    expect(wc7.sent).toEqual([['tts:chunk', { filePath: '/tmp/a.wav', index: 0 }]])
    expect(wc8.sent).toEqual([])
  })
})

describe('CH-2 liveDoc:respond 认的是调用方那个 webContents', () => {
  it('CH-2 → resolveLiveDocumentResponse(wc7 本身, requestId, result)，回 { success: true }', () => {
    const result = { ok: true, text: 'x' }
    expect(invokeFrom(wc7, 'liveDoc:respond', { requestId: 'r1', result })).toEqual({
      success: true
    })
    expect(state.resolveLiveDocumentResponse).toHaveBeenCalledTimes(1)
    const [sender, requestId, got] = state.resolveLiveDocumentResponse.mock.calls[0]
    expect(sender).toBe(wc7)
    expect(requestId).toBe('r1')
    expect(got).toBe(result)
    expect(state.fromId).not.toHaveBeenCalled()
  })
})

describe('CH-4 / CH-5 / CH-6 编辑器的挂接与摘下认的是调用方那个 webContents', () => {
  it('CH-4 liveDoc:attach → attachLiveDocument(s1, wc7 本身, a1)，回 { success: true }', () => {
    expect(invokeFrom(wc7, 'liveDoc:attach', { sessionId: 's1', attachId: 'a1' })).toEqual({
      success: true
    })
    expect(state.attachLiveDocument).toHaveBeenCalledTimes(1)
    const [sid, sender, attachId] = state.attachLiveDocument.mock.calls[0]
    expect(sid).toBe('s1')
    expect(sender).toBe(wc7)
    expect(attachId).toBe('a1')
    expect(state.detachLiveDocument).not.toHaveBeenCalled()
    expect(state.fromId).not.toHaveBeenCalled()
  })

  it('CH-5 liveDoc:detach → detachLiveDocument(s1, a1, wc7 本身)，回 { success: true }', () => {
    expect(invokeFrom(wc7, 'liveDoc:detach', { sessionId: 's1', attachId: 'a1' })).toEqual({
      success: true
    })
    expect(state.detachLiveDocument).toHaveBeenCalledTimes(1)
    const [sid, attachId, sender] = state.detachLiveDocument.mock.calls[0]
    expect(sid).toBe('s1')
    expect(attachId).toBe('a1')
    expect(sender).toBe(wc7)
    expect(state.attachLiveDocument).not.toHaveBeenCalled()
  })

  it.each([
    ['没有参数', undefined],
    ['缺 attachId', { sessionId: 's1' }],
    ['缺 sessionId', { attachId: 'a1' }],
    ['sessionId 空串', { sessionId: '', attachId: 'a1' }]
  ])('CH-6 %s → 两条通道都回 { success: false }，不调桥', (_label, params) => {
    expect(invokeFrom(wc7, 'liveDoc:attach', params)).toEqual({ success: false })
    expect(invokeFrom(wc7, 'liveDoc:detach', params)).toEqual({ success: false })
    expect(state.attachLiveDocument).not.toHaveBeenCalled()
    expect(state.detachLiveDocument).not.toHaveBeenCalled()
  })
})

describe('CH-3 按调用方报会话；没有窗口时不弹东西', () => {
  it('CH-3 notification:reportActiveSession(sid) → reportActiveSession(7, sid)', () => {
    expect(invokeFrom(wc7, 'notification:reportActiveSession', 's-1')).toEqual({ success: true })
    expect(invokeFrom(wc7, 'notification:reportActiveSession', null)).toEqual({ success: true })
    expect(state.reportActiveSession.mock.calls).toEqual([
      [7, 's-1'],
      [7, null]
    ])
  })

  it('CH-3 dialog:openDirectory 没有窗口 → null，不弹对话框', async () => {
    await expect(invokeFrom(wc7, 'dialog:openDirectory')).resolves.toBeNull()
    expect(state.fromWebContents.mock.calls.map(([c]) => c)).toEqual([wc7])
    expect(state.showOpenDialog).not.toHaveBeenCalled()
  })

  it('CH-3 contextMenu:popup 没有窗口 → { actionId: null }，不建菜单', async () => {
    await expect(
      invokeFrom(wc7, 'contextMenu:popup', { items: [{ id: 'a', label: 'A' }] })
    ).resolves.toEqual({ actionId: null })
    expect(state.fromWebContents.mock.calls.map(([c]) => c)).toEqual([wc7])
    expect(state.buildFromTemplate).not.toHaveBeenCalled()
  })
})

describe('NH-1 / NH-2 通知的两条通道从网络来', () => {
  it('NH-1 reportActiveSession(sid) → reportActiveSession(null, sid)；null → (null, null)', () => {
    expect(invokeFromNet('notification:reportActiveSession', 's1')).toEqual({ success: true })
    expect(invokeFromNet('notification:reportActiveSession', null)).toEqual({ success: true })
    expect(state.reportActiveSession.mock.calls).toEqual([
      [null, 's1'],
      [null, null]
    ])
  })

  it('NH-2 consumePendingOpenSession：网络 → null、不调服务；窗口 → 服务的结果', () => {
    const consume = vi.mocked(consumePendingOpenSession)
    consume.mockReturnValue('s5')
    expect(invokeFromNet('notification:consumePendingOpenSession')).toBeNull()
    expect(consume).not.toHaveBeenCalled()
    expect(invokeFrom(wc7, 'notification:consumePendingOpenSession')).toBe('s5')
    expect(consume).toHaveBeenCalledTimes(1)
  })
})

describe('NH-3 / NH-4 要窗口的处理器从网络来', () => {
  it('NH-3 liveDoc:respond → { success: false }，不调 resolveLiveDocumentResponse', () => {
    expect(
      invokeFromNet('liveDoc:respond', { requestId: 'r', result: { ok: true, text: 'x' } })
    ).toEqual({ success: false })
    expect(state.resolveLiveDocumentResponse).not.toHaveBeenCalled()
  })

  it('NH-4 contextMenu:popup → { actionId: null }；dialog:openDirectory → null；不查窗口', async () => {
    await expect(
      invokeFromNet('contextMenu:popup', { items: [{ id: 'a', label: 'A' }] })
    ).resolves.toEqual({ actionId: null })
    expect(state.buildFromTemplate).not.toHaveBeenCalled()
    await expect(invokeFromNet('dialog:openDirectory')).resolves.toBeNull()
    expect(state.showOpenDialog).not.toHaveBeenCalled()
    expect(state.fromWebContents).not.toHaveBeenCalled()
    expect(state.fromId).not.toHaveBeenCalled()
  })
})

describe('NH-6 / NH-7 编辑器的挂接与摘下从网络来', () => {
  it('NH-6 liveDoc:attach → { success: false }，不调 attachLiveDocument', () => {
    expect(invokeFromNet('liveDoc:attach', { sessionId: 's1', attachId: 'a1' })).toEqual({
      success: false
    })
    expect(state.attachLiveDocument).not.toHaveBeenCalled()
  })

  it('NH-7 liveDoc:detach → { success: false }，不调 detachLiveDocument', () => {
    expect(invokeFromNet('liveDoc:detach', { sessionId: 's1', attachId: 'a1' })).toEqual({
      success: false
    })
    expect(state.detachLiveDocument).not.toHaveBeenCalled()
  })
})

describe('NH-5 tts:speakOnce 推回网络客户端', () => {
  it('NH-5 每片 → 连接收到 tts:chunk 推送；关了之后不再发，invoke 照样落定', async () => {
    const conn = fakeConnection(netClient(1))
    networkTransport.add(conn)
    const ctl = controlSpeakOnce()
    const pending = invokeFromNet('tts:speakOnce', { text: 'hi' }) as Promise<unknown>
    ctl.chunk()('/tmp/a.wav', 0)
    ctl.chunk()('/tmp/b.wav', 1)
    expect(conn.sent).toStrictEqual([
      { t: 'push', channel: 'tts:chunk', args: [{ filePath: '/tmp/a.wav', index: 0 }] },
      { t: 'push', channel: 'tts:chunk', args: [{ filePath: '/tmp/b.wav', index: 1 }] }
    ])
    conn.close(1000, 'bye')
    expect(() => ctl.chunk()('/tmp/c.wav', 2)).not.toThrow()
    ctl.finish()
    await expect(pending).resolves.toBeUndefined()
    expect(conn.sent).toHaveLength(2)
    expect(wc7.sent).toEqual([])
    expect(wc8.sent).toEqual([])
  })
})
