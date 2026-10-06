/**
 * 视图同步的 IPC 处理器（P3-05，docs/pi-durable/p3-050710a-test-design.md「IPC handler」）：
 *
 *   P3-05-08 `sync:invoke` 的注册与懒建（PIN-12）
 *   P3-05-09 错误带着 code 回来（PIN-01 信封；preload 以纯对象 `{code?, message}` 拒绝 —— 过 contextBridge
 *            不丢 code，渲染端经 reviveSyncInvokeError 还原成带 `.code` 的 Error，P3-15）
 *
 * hub 是真的（syncWiring 的单例），宿主是假的（会话宿主模块整个换掉，记 getSessionHost / peek）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createServiceSubscribeCall,
  RemoteServiceError,
  type JsonValue
} from '@earendil-works/chord'
import type { SyncHub } from '@shuvix/agent-runtime'
import {
  CHAT_VIEW_SERVICE_ID,
  reviveSyncInvokeError,
  type SyncTarget
} from '@shuvix/chat-protocol/sync'

const holder = vi.hoisted(() => ({
  host: undefined as unknown,
  created: false,
  getSessionHost: vi.fn(),
  createSessionHost: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  webContents: { fromId: vi.fn(() => undefined) }
}))
vi.mock('../../services/sessionHost', () => ({
  getSessionHost: (...args: unknown[]) => {
    holder.getSessionHost(...args)
    if (!holder.created) {
      holder.created = true
      holder.createSessionHost()
    }
    return holder.host
  },
  peekSessionHost: () => (holder.created ? holder.host : undefined)
}))
vi.mock('../../services/sessionRecords', () => ({
  sessionRecords: {
    pick: (id: string) =>
      id === 'missing' ? undefined : { id, storageKind: 'durable-sqlite-1' as string }
  }
}))
vi.mock('../../services/sessionStorage', () => ({ readLegacyTranscript: vi.fn(() => null) }))
vi.mock('../../agents/AgentManager', () => ({ agentManager: { locate: () => undefined } }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
}))

import { registerSyncHandlers, SYNC_INVOKE_CHANNEL } from '../syncHandlers'
import { peekSyncHub, resetSyncHubForTests } from '../../frontend/sync/syncWiring'
// eslint-disable-next-line boundaries/dependencies -- 信封的另一半在 preload：同一个用例里钉住「主进程 resolve 信封 → 渲染端抛带 code 的 Error」
import { createSyncBridge } from '../../../preload/syncBridge'
import {
  FakeIpcMain,
  FakeWebContents,
  fakeIpcRenderer,
  settle
} from '../../frontend/sync/__tests__/support/ipcRig'
import { FakeSyncHost } from '../../frontend/sync/__tests__/support/fakeSync'

/** 导入完这些模块时 getSessionHost / createSessionHost 被调了几次（应为 0：懒建） */
const callsAtImport = {
  get: holder.getSessionHost.mock.calls.length,
  create: holder.createSessionHost.mock.calls.length
}

const s1: SyncTarget = { kind: 'session', sessionId: 's1' }
const subscribe = (id: string): JsonValue =>
  createServiceSubscribeCall(id, CHAT_VIEW_SERVICE_ID, 'singleton') as unknown as JsonValue

let fakeHost: FakeSyncHost

beforeEach(() => {
  resetSyncHubForTests()
  fakeHost = new FakeSyncHost()
  fakeHost.add('s1')
  holder.host = { sealed: false, peek: vi.fn((id: string) => fakeHost.peek(id)) }
  holder.created = false
  holder.getSessionHost.mockClear()
  holder.createSessionHost.mockClear()
})

describe('P3-05-08 sync:invoke 的注册与懒建（PIN-12）', () => {
  it("P3-05-08 只在 'sync:invoke' 上注册恰一个处理器；它以 'ipc:7' 调 hub.invoke（同一组引用）并交回 hub 的值", async () => {
    const ipc = new FakeIpcMain()
    const value = { snapshot: true } as unknown as JsonValue
    const invoke = vi.fn(async () => value)
    registerSyncHandlers(ipc, { hub: () => ({ invoke }) as unknown as SyncHub })
    expect(ipc.handle).toHaveBeenCalledTimes(1)
    expect(ipc.handle.mock.calls[0]![0]).toBe('sync:invoke')
    expect(SYNC_INVOKE_CHANNEL).toBe('sync:invoke')

    const handler = ipc.handlers.get('sync:invoke')!
    const target = { kind: 'session', sessionId: 's1' }
    const call = { method: '$chord.service', args: [] }
    const reply = (await handler({ sender: { id: 7 } }, target, call)) as {
      ok: boolean
      value: unknown
    }
    expect(invoke).toHaveBeenCalledTimes(1)
    const [clientId, passedTarget, passedCall] = invoke.mock.calls[0] as unknown as unknown[]
    expect(clientId).toBe('ipc:7')
    expect(passedTarget).toBe(target)
    expect(passedCall).toBe(call)
    expect(reply.ok).toBe(true)
    expect(reply.value).toBe(value)
  })

  it('P3-05-08 import syncHandlers / syncWiring 并注册：不建 hub、不碰宿主；第一次订阅 durable 会话 → getSessionHost().peek(id) 恰一次', async () => {
    expect(callsAtImport).toEqual({ get: 0, create: 0 })
    const ipc = new FakeIpcMain()
    registerSyncHandlers(ipc, { lookup: () => undefined })
    expect(peekSyncHub()).toBeUndefined()
    expect(holder.getSessionHost).not.toHaveBeenCalled()
    expect(holder.createSessionHost).not.toHaveBeenCalled()

    const wc = new FakeWebContents(7)
    registerSyncHandlers(ipc, { lookup: (id) => (id === 7 ? wc : undefined) })
    const reply = (await ipc.invokeAs(wc, 'sync:invoke', s1, subscribe('a'))) as { ok: boolean }
    expect(reply.ok).toBe(true)
    expect(peekSyncHub()).toBeDefined()
    expect(holder.createSessionHost).toHaveBeenCalledTimes(1)
    const peek = (holder.host as { peek: ReturnType<typeof vi.fn> }).peek
    expect(peek).toHaveBeenCalledTimes(1)
    expect(peek).toHaveBeenCalledWith('s1')
  })
})

describe('P3-05-09 错误带着 code 回来（PIN-01）', () => {
  function rig(hub?: () => SyncHub): {
    ipc: FakeIpcMain
    wc: FakeWebContents
    bridge: ReturnType<typeof createSyncBridge>
  } {
    const ipc = new FakeIpcMain()
    const wc = new FakeWebContents(7)
    registerSyncHandlers(ipc, {
      lookup: (id) => (id === 7 ? wc : undefined),
      ...(hub === undefined ? {} : { hub })
    })
    return { ipc, wc, bridge: createSyncBridge(fakeIpcRenderer(wc, ipc)) }
  }

  it("P3-05-09 hub 以 RemoteServiceError('service_not_found') 拒绝 → 信封 {ok:false, error:{code, message}}；preload 的 sync.invoke 以纯对象 {code:'service_not_found', message} 拒绝，还原后是带 code 的 Error", async () => {
    const error = new RemoteServiceError('service_not_found', 'Unknown agent a9')
    const { ipc, wc, bridge } = rig(
      () =>
        ({
          invoke: async () => {
            throw error
          }
        }) as unknown as SyncHub
    )
    const reply = await ipc.invokeAs(wc, 'sync:invoke', s1, subscribe('a'))
    expect(reply).toEqual({
      ok: false,
      error: { code: 'service_not_found', message: error.message }
    })
    const rejected = await bridge.invoke(s1, subscribe('b')).catch((e: unknown) => e)
    // 纯对象（contextBridge 按值拷得过去）；structuredClone 近似那次拷贝
    expect(rejected).not.toBeInstanceOf(Error)
    expect(structuredClone(rejected)).toEqual({ code: 'service_not_found', message: error.message })
    const revived = reviveSyncInvokeError(structuredClone(rejected))
    expect(revived).toBeInstanceOf(Error)
    expect(revived.code).toBe('service_not_found')
    expect(revived.message).toBe(error.message)
  })

  it('P3-05-09 普通 Error → 带着 message 回来，code 为 undefined', async () => {
    const { ipc, wc, bridge } = rig(
      () =>
        ({
          invoke: async () => {
            throw new Error('plain failure')
          }
        }) as unknown as SyncHub
    )
    expect(await ipc.invokeAs(wc, 'sync:invoke', s1, subscribe('a'))).toEqual({
      ok: false,
      error: { message: 'plain failure' }
    })
    const rejected = (await bridge.invoke(s1, subscribe('b')).catch((e: unknown) => e)) as Error & {
      code?: string
    }
    expect(rejected.message).toBe('plain failure')
    expect(rejected.code).toBeUndefined()
  })

  it("P3-05-09 不合法的目标 {kind:'monitor'} → 被拒，hub 里什么都不留（每个 id 的 hasSubscribers 都是 false）", async () => {
    const { bridge } = rig()
    const rejected = await bridge
      .invoke({ kind: 'monitor' } as unknown as SyncTarget, subscribe('m'))
      .catch((e: unknown) => e)
    expect(rejected).not.toBeInstanceOf(Error)
    expect((rejected as { message: string }).message).toMatch(/Invalid sync target/)
    expect(reviveSyncInvokeError(rejected).message).toMatch(/Invalid sync target/)
    await settle()
    const hub = peekSyncHub()!
    for (const id of ['s1', 'monitor', 'ipc:7', '']) expect(hub.hasSubscribers(id)).toBe(false)
    expect(fakeHost.peeks).toEqual([])
  })
})
