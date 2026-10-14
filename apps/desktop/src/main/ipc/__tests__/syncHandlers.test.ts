/**
 * 视图同步的 IPC 注册（`ipc/syncHandlers`，pi 1.2 / chord2）—— 链路表 `hub` 是模块级的懒单例，服务端也是
 * （`syncWiring`），通道注册表（`ipc/registry`）同样，所以每个用例 `vi.resetModules()` 之后重新 import；注册之后经
 * IPC 适配器（`ipc/ipcAdapter`）挂到假 / 替身 ipcMain 上，与主入口的接法一样。electron 是替身；会话宿主换成 viewRig 的
 * 假宿主（`getSessionHost` 记调用）；行表 / 旧格式读取器 / 派生 agent 路由 / logger 换成可控的替身。
 *
 *   SH-1 恰好一个 `on('sync:frame')`，没有 `sync:invoke` 的 handle（缺省的 electron ipcMain 与注入的都一样）
 *   SH-2 import + 注册不建服务端、不碰会话宿主（PIN-12）；第一个 hello 建服务端（还不碰宿主）；第一次订阅一条
 *        durable 会话 → `peek(id)` 恰好一次
 *   SH-3 webContents 7 发来的帧开一条主体 `webContentsId: 7` 的链路，回帧发回 7
 *   SH-4 `receive` 抛错 → 记一笔 warn，不从监听器里抛出去
 *   SH-5 经 IPC 订阅空的 sessionId → 客户端错误 `invalid`，什么都没持有
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SyncTarget } from '@shuvix/chat-protocol/sync'
import type { SessionView } from '@shuvix/chat-protocol/types/sessionView'
import {
  fakeViewHost,
  type FakeViewHost
} from '../../../../../../packages/agent-runtime/src/sync/__tests__/support/viewRig'
import {
  FakeIpcMain,
  FakeWebContents,
  settle,
  syncWindow,
  until,
  type SyncWindow
} from '../../frontend/sync/__tests__/support/ipcLinkRig'
import type { SyncWebContents } from '../../frontend/sync/ipcLink'

const holder = vi.hoisted(() => ({
  host: undefined as unknown,
  created: false,
  getSessionHost: vi.fn(),
  electronOn: vi.fn(),
  electronHandle: vi.fn(),
  logs: [] as string[]
}))

vi.mock('electron', () => ({
  ipcMain: { on: holder.electronOn, handle: holder.electronHandle },
  webContents: { fromId: vi.fn(() => undefined) }
}))
vi.mock('../../services/sessionHost', () => ({
  getSessionHost: () => {
    holder.getSessionHost()
    holder.created = true
    return holder.host
  },
  peekSessionHost: () => (holder.created ? holder.host : undefined)
}))
vi.mock('../../services/sessionRecords', () => ({
  sessionRecords: { pick: () => undefined }
}))
vi.mock('../../services/sessionStorage', () => ({
  readLegacyTranscript: () => null
}))
vi.mock('../../agents/AgentManager', () => ({
  agentManager: { locate: () => undefined }
}))
vi.mock('../../logger', () => ({
  createLogger: (name: string) => ({
    info: () => {},
    debug: () => {},
    warn: (message: string) => holder.logs.push(`${name} warn: ${message}`),
    error: (message: string) => holder.logs.push(`${name} error: ${message}`)
  })
}))

type HandlersModule = typeof import('../syncHandlers')
type WiringModule = typeof import('../../frontend/sync/syncWiring')
type AdapterModule = typeof import('../ipcAdapter')

const S1: SyncTarget = { kind: 'session', sessionId: 's1' }
const HELLO = { t: 'hello', name: 'renderer', kind: 'client', epoch: 1 } as const

let windows: SyncWindow[] = []
let wiring: WiringModule | undefined

/** 新的模块实例（hub / 服务端 / 通道注册表都是新的） */
async function fresh(): Promise<{
  handlers: HandlersModule
  wiring: WiringModule
  adapter: AdapterModule
}> {
  vi.resetModules()
  const handlers = await import('../syncHandlers')
  const adapter = await import('../ipcAdapter')
  wiring = await import('../../frontend/sync/syncWiring')
  return { handlers, wiring, adapter }
}

/** 注册 + 经 IPC 适配器挂到 ipcMain 上（不给就是 electron 的替身 ipcMain） */
function register(
  { handlers, adapter }: { handlers: HandlersModule; adapter: AdapterModule },
  ipcMain?: FakeIpcMain
): void {
  handlers.registerSyncHandlers()
  adapter.attachIpcAdapter(ipcMain)
}

function page(wc: FakeWebContents, ipcMain: FakeIpcMain): SyncWindow {
  const window = syncWindow(wc, ipcMain)
  windows.push(window)
  return window
}

beforeEach(async () => {
  for (const window of windows) window.client.dispose()
  windows = []
  await settle()
  await wiring?.peekSyncHub()?.dispose()
  wiring = undefined
  const host: FakeViewHost = fakeViewHost()
  host.add('s1')
  holder.host = host
  holder.created = false
  holder.getSessionHost.mockClear()
  holder.electronOn.mockClear()
  holder.electronHandle.mockClear()
  holder.logs.length = 0
})

function viewHost(): FakeViewHost {
  return holder.host as FakeViewHost
}

describe('SH-1 registration', () => {
  it('SH-1 registers exactly one on("sync:frame") and no sync:invoke handler', async () => {
    const modules = await fresh()
    const ipcMain = new FakeIpcMain()
    register(modules, ipcMain)
    expect(ipcMain.count('sync:frame')).toBe(1)
    expect([...ipcMain.listeners.keys()]).toEqual(['sync:frame'])
    expect(ipcMain.handled).toEqual([])
  })

  it('SH-1 the default electron ipcMain gets the same single listener', async () => {
    const modules = await fresh()
    register(modules)
    expect(holder.electronOn).toHaveBeenCalledTimes(1)
    expect(holder.electronOn.mock.calls[0]![0]).toBe('sync:frame')
    expect(holder.electronHandle).not.toHaveBeenCalled()
  })
})

describe('SH-2 lazy creation (PIN-12)', () => {
  it('SH-2 import + register build nothing; the first hello builds the server; the first durable subscribe peeks once', async () => {
    const modules = await fresh()
    const { wiring } = modules
    const ipcMain = new FakeIpcMain()
    register(modules, ipcMain)
    expect(wiring.peekSyncHub()).toBeUndefined()
    expect(holder.getSessionHost).not.toHaveBeenCalled()

    // 第一个 hello：建服务端，仍不碰会话宿主
    const probe = new FakeWebContents(3)
    ipcMain.emitFrom(probe, 'sync:frame', 'probe.1', HELLO)
    const server = wiring.peekSyncHub()
    expect(server).toBeDefined()
    expect(holder.getSessionHost).not.toHaveBeenCalled()
    expect(viewHost().peeks).toEqual([])

    // 第一次订阅一条 durable 会话：peek 恰好一次
    const window = page(new FakeWebContents(7), ipcMain)
    const sub = window.client.acquire<SessionView>(S1)
    await until(() => sub.state().status === 'live', 'live')
    expect(viewHost().peeks).toEqual(['s1'])
    expect(sub.value()).toEqual(viewHost().session('s1')!.root.value)
    expect(wiring.peekSyncHub()).toBe(server)
    expect(server!.hasSubscribers('s1')).toBe(true)
    await settle()
    expect(viewHost().peeks).toEqual(['s1'])
  })
})

describe('SH-3 the sender is the principal', () => {
  it('SH-3 a frame from webContents 7 opens a link with webContentsId 7; the answer goes back to 7', async () => {
    const modules = await fresh()
    const { wiring } = modules
    const ipcMain = new FakeIpcMain()
    register(modules, ipcMain)
    const server = wiring.getSyncHub()
    const accept = vi.spyOn(server, 'accept')
    const wc7 = new FakeWebContents(7)
    const wc8 = new FakeWebContents(8)

    ipcMain.emitFrom(wc7, 'sync:frame', 'L1', HELLO)
    expect(accept).toHaveBeenCalledTimes(1)
    expect(accept.mock.calls[0]![1]).toEqual({ kind: 'window', webContentsId: 7 })
    // 服务端的 hello 回到 7（同一个链路 id），8 什么都没收到
    expect(wc7.frames()).toEqual([['L1', expect.objectContaining({ t: 'hello', kind: 'host' })]])
    expect(wc8.sent).toEqual([])

    ipcMain.emitFrom(wc8, 'sync:frame', 'L1', HELLO)
    expect(accept).toHaveBeenCalledTimes(2)
    expect(accept.mock.calls[1]![1]).toEqual({ kind: 'window', webContentsId: 8 })
    expect(wc8.frames()).toHaveLength(1)
    expect(wc7.frames()).toHaveLength(1)
  })
})

describe('SH-4 a failing receive', () => {
  it('SH-4 an error thrown inside receive is logged and not rethrown out of the listener', async () => {
    const modules = await fresh()
    const { wiring } = modules
    const ipcMain = new FakeIpcMain()
    register(modules, ipcMain)
    const broken: SyncWebContents = {
      id: 9,
      send: () => {},
      isDestroyed: () => false,
      on: () => {
        throw new Error('listener table broken')
      },
      removeListener: () => {}
    }
    expect(() => ipcMain.emitFrom(broken, 'sync:frame', 'L1', HELLO)).not.toThrow()
    expect(holder.logs).toHaveLength(1)
    expect(holder.logs[0]).toMatch(/^SyncIpc warn: /)
    expect(holder.logs[0]).toContain('webContents 9')
    expect(holder.logs[0]).toContain('listener table broken')

    // 没有 sender 的事件同样只记一笔
    const listener = [...ipcMain.listeners.get('sync:frame')!][0]!
    expect(() =>
      listener({ sender: undefined as unknown as SyncWebContents }, 'L1', HELLO)
    ).not.toThrow()
    expect(holder.logs).toHaveLength(2)
    expect(holder.logs[1]).toContain('webContents undefined')
    expect(wiring.peekSyncHub()).toBeUndefined()
  })
})

describe('SH-5 invalid input over IPC', () => {
  it('SH-5 an empty sessionId → client error "invalid", nothing held', async () => {
    const modules = await fresh()
    const { wiring } = modules
    const ipcMain = new FakeIpcMain()
    register(modules, ipcMain)
    const wc = new FakeWebContents(7)
    const window = page(wc, ipcMain)
    const sub = window.client.acquire<SessionView>({ kind: 'session', sessionId: '' })
    await until(() => sub.state().status === 'error', 'error')
    expect(sub.state()).toEqual({ status: 'error', code: 'invalid' })
    expect(sub.value()).toBeUndefined()
    // 判定来自服务端：拒绝是经 IPC 回来的一帧 gone
    expect(
      wc
        .frames()
        .some(
          ([, frame]) =>
            (frame as { t?: unknown }).t === 'gone' &&
            (frame as { error?: { code?: unknown } }).error?.code === 'invalid'
        )
    ).toBe(true)
    await settle()
    expect(viewHost().peeks).toEqual([])
    expect(holder.getSessionHost).not.toHaveBeenCalled()
    expect(wiring.peekSyncHub()?.hasSubscribers('') ?? false).toBe(false)
  })
})
