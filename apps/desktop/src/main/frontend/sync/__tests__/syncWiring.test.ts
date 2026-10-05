/**
 * 视图同步的桌面接线（P3-05，docs/pi-durable/p3-050710a-test-design.md）—— 单元部分：
 *
 *   P3-05-13 扇出派发（按登记次序、同一个对象；关闭原因原样）
 *   P3-05-14 注销与隔离（重复注销无事、抛错的监听器只记一笔、派发途中新登记的这一轮不调）
 *   P3-05-16 hub 的宿主适配（sealed 现读、读它不建宿主；peek 交回宿主 peek 的同一个实例；类型层
 *            DurableSession 满足 SyncSession）
 *   P3-05-19 legacyView 矩阵（行 / 存储类型 / 读不出来，PIN-05）—— 真文件的那一半在 syncWiringIntegration
 *   P3-05-21 resolveAgent 经路由（原样交回；认不出 → 订阅经 IPC 信封以 service_not_found 拒绝；会话目标从不
 *            问路由）—— 重启之后的那一半在 syncWiringIntegration
 *
 * 会话宿主模块整个换成假的（FakeSessionHost；记 getSessionHost 的调用），行表与旧格式读取器换成可控的替身。
 */
import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { createServiceSubscribeCall, type JsonValue } from '@earendil-works/chord'
import type { DurableSession, SyncAgentRef, SyncSession } from '@shuvix/agent-runtime'
import { CHAT_VIEW_SERVICE_ID } from '@shuvix/chat-protocol/sync'
import type { ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'

const holder = vi.hoisted(() => ({
  host: undefined as unknown,
  created: false,
  getSessionHost: vi.fn(),
  rows: new Map<string, { id: string; storageKind?: string | null }>(),
  readLegacyTranscript: vi.fn<(id: string) => unknown>(),
  locate: vi.fn<(agentId: string) => unknown>()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  webContents: { fromId: vi.fn(() => undefined) }
}))
vi.mock('../../../services/sessionHost', () => ({
  getSessionHost: () => {
    holder.getSessionHost()
    holder.created = true
    return holder.host
  },
  peekSessionHost: () => (holder.created ? holder.host : undefined)
}))
vi.mock('../../../services/sessionRecords', () => ({
  sessionRecords: {
    pick: (id: string, fields: string[]) => {
      const row = holder.rows.get(id)
      return row ? Object.fromEntries(fields.map((f) => [f, row[f as keyof typeof row]])) : undefined
    }
  }
}))
vi.mock('../../../services/sessionStorage', () => ({
  readLegacyTranscript: (id: string) => holder.readLegacyTranscript(id)
}))
vi.mock('../../../agents/AgentManager', () => ({
  agentManager: { locate: (agentId: string) => holder.locate(agentId) }
}))
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
}))

import {
  createSessionHookFanout,
  createSyncHubHost,
  getSyncHub,
  legacyViewOf,
  peekSyncHub,
  resetSyncHubForTests,
  resolveAgentOf,
  sessionHostHooks
} from '../syncWiring'
import { registerSyncHandlers } from '../../../ipc/syncHandlers'
import { FakeSessionHost } from '../../../services/__tests__/support/fakeSessionHost'
import { FakeIpcMain, FakeWebContents, settle } from './support/ipcRig'
import { FakeSyncSession } from './support/fakeSync'

const session = (id: string): SyncSession => new FakeSyncSession(id)

beforeEach(() => {
  resetSyncHubForTests()
  holder.host = new FakeSessionHost()
  holder.created = false
  holder.getSessionHost.mockClear()
  holder.rows.clear()
  holder.readLegacyTranscript.mockReset()
  holder.locate.mockReset()
})

describe('P3-05-13 扇出派发', () => {
  it('P3-05-13 经 hub 面登记 L1、L2 → opened(s) 先 L1 后 L2，各一次、同一个对象', () => {
    const order: string[] = []
    const seen: SyncSession[] = []
    const host = createSyncHubHost()
    const off1 = host.onSessionOpened((s) => {
      order.push('L1')
      seen.push(s)
    })
    const off2 = host.onSessionOpened((s) => {
      order.push('L2')
      seen.push(s)
    })
    const s = session('s1')
    sessionHostHooks.opened(s)
    expect(order).toEqual(['L1', 'L2'])
    expect(seen).toHaveLength(2)
    expect(seen[0]).toBe(s)
    expect(seen[1]).toBe(s)
    off1()
    off2()
  })

  it.each(['remove', 'invalidate', 'destroy'] as const)(
    "P3-05-13 关闭监听器原样收到 (id, '%s')",
    (reason) => {
      const calls: unknown[][] = []
      const off = createSyncHubHost().onSessionClosed((...args) => void calls.push(args))
      sessionHostHooks.closed('s1', reason)
      expect(calls).toEqual([['s1', reason]])
      off()
    }
  )
})

describe('P3-05-14 注销与隔离', () => {
  it('P3-05-14 L1 注销之后只调 L2；重复注销无事', () => {
    const fanout = createSessionHookFanout<SyncSession>()
    const l1 = vi.fn()
    const l2 = vi.fn()
    const off1 = fanout.onSessionOpened(l1)
    fanout.onSessionOpened(l2)
    off1()
    off1()
    fanout.opened(session('s1'))
    expect(l1).not.toHaveBeenCalled()
    expect(l2).toHaveBeenCalledTimes(1)
  })

  it('P3-05-14 抛错的 L1 只记一笔、L2 照调、opened 不抛（关闭同理）', () => {
    const warn = vi.fn()
    const fanout = createSessionHookFanout<SyncSession>({ logger: { warn } })
    const l2 = vi.fn()
    fanout.onSessionOpened(() => {
      throw new Error('boom')
    })
    fanout.onSessionOpened(l2)
    expect(() => fanout.opened(session('s1'))).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain('boom')
    expect(l2).toHaveBeenCalledTimes(1)

    const c2 = vi.fn()
    fanout.onSessionClosed(() => {
      throw new Error('bang')
    })
    fanout.onSessionClosed(c2)
    expect(() => fanout.closed('s1', 'remove')).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(2)
    expect(c2).toHaveBeenCalledWith('s1', 'remove')
  })

  it('P3-05-14 派发途中新登记的监听器这一轮不调，下一轮才调', () => {
    const fanout = createSessionHookFanout<SyncSession>()
    const late = vi.fn()
    fanout.onSessionOpened(() => {
      fanout.onSessionOpened(late)
    })
    fanout.opened(session('s1'))
    expect(late).not.toHaveBeenCalled()
    fanout.opened(session('s2'))
    expect(late).toHaveBeenCalledTimes(1)
  })
})

describe('P3-05-16 hub 的宿主适配', () => {
  it('P3-05-16 sealed 现读：宿主没建 → false 且读它不建；closeAll 之后 → true，不必重新接线', async () => {
    const adapter = createSyncHubHost()
    expect(adapter.sealed).toBe(false)
    expect(holder.getSessionHost).not.toHaveBeenCalled()
    expect(holder.created).toBe(false)

    const host = holder.host as FakeSessionHost
    await adapter.peek('nope')
    expect(holder.getSessionHost).toHaveBeenCalledTimes(1)
    expect(adapter.sealed).toBe(false)
    await host.closeAll()
    expect(adapter.sealed).toBe(true)
  })

  it('P3-05-16 peek(id) 交回的就是 getSessionHost().peek(id) 的那个 DurableSession 实例', async () => {
    const host = holder.host as FakeSessionHost
    const opened = host.put('s1')
    const adapter = createSyncHubHost()
    const viaAdapter = await adapter.peek('s1')
    expect(viaAdapter).toBe(opened)
    expect(viaAdapter).toBe(await host.peek('s1'))
    expect(await adapter.peek('missing')).toBeUndefined()
  })

  it('P3-05-16 类型层：DurableSession 满足 SyncSession（projector、agentProjector(SyncAgentRef)）', () => {
    expectTypeOf<DurableSession>().toMatchTypeOf<SyncSession>()
    expectTypeOf<DurableSession['agentProjector']>().toBeCallableWith({
      agentId: 'a1',
      conversationId: 5
    } satisfies SyncAgentRef)
  })
})

describe('P3-05-19 legacyView 矩阵', () => {
  const messages = [
    { id: 'u1', sessionId: 'old', role: 'user', content: 'hi', createdAt: 1 }
  ] as unknown as ChatMessage[]

  it('P3-05-19 旧格式行 + 读得出 → {messages} 就是 readLegacyTranscript(id).messages', () => {
    holder.rows.set('old', { id: 'old', storageKind: 'harness-v3-jsonl' })
    holder.readLegacyTranscript.mockReturnValue({ messages, issues: [] })
    const view = legacyViewOf('old')
    expect(view).toEqual({ messages })
    expect(view!.messages).toBe(messages)
    expect(holder.readLegacyTranscript).toHaveBeenCalledWith('old')
  })

  it('P3-05-19 存储类型缺省（v30 之前的行）按旧格式', () => {
    holder.rows.set('old', { id: 'old', storageKind: null })
    holder.readLegacyTranscript.mockReturnValue({ messages, issues: [] })
    expect(legacyViewOf('old')).toEqual({ messages })
  })

  it('P3-05-19 新格式行 → undefined，从不读 .jsonl；查不到行 → undefined；不认识的存储类型 → undefined', () => {
    holder.rows.set('new', { id: 'new', storageKind: 'durable-sqlite-1' })
    holder.rows.set('future', { id: 'future', storageKind: 'durable-sqlite-9' })
    expect(legacyViewOf('new')).toBeUndefined()
    expect(legacyViewOf('missing')).toBeUndefined()
    expect(legacyViewOf('future')).toBeUndefined()
    expect(holder.readLegacyTranscript).not.toHaveBeenCalled()
  })

  it('P3-05-19 旧格式行但 .jsonl 不在 / 读坏了 → {messages:[]}（PIN-05：仍是只读的旧格式视图）', () => {
    holder.rows.set('old', { id: 'old', storageKind: 'harness-v3-jsonl' })
    holder.readLegacyTranscript.mockReturnValueOnce(null)
    expect(legacyViewOf('old')).toEqual({ messages: [] })
    holder.readLegacyTranscript.mockImplementationOnce(() => {
      throw new Error('corrupt')
    })
    expect(legacyViewOf('old')).toEqual({ messages: [] })
  })
})

describe('P3-05-21 resolveAgent 经路由', () => {
  it("P3-05-21 agentManager.locate('a1') → {sessionId:'s1', conversationId:5} 原样交回", async () => {
    const location = { sessionId: 's1', conversationId: 5 }
    holder.locate.mockReturnValue(location)
    expect(await resolveAgentOf('a1')).toBe(location)
    expect(holder.locate).toHaveBeenCalledWith('a1')
  })

  it('P3-05-21 认不出的 agentId → undefined；订阅经 IPC 信封以 service_not_found 拒绝；会话目标从不问路由', async () => {
    holder.locate.mockReturnValue(undefined)
    expect(await resolveAgentOf('ghost')).toBeUndefined()
    holder.locate.mockClear()

    const ipc = new FakeIpcMain()
    const wc = new FakeWebContents(7)
    registerSyncHandlers(ipc, { lookup: (id) => (id === 7 ? wc : undefined) })
    const sub = (id: string): JsonValue =>
      createServiceSubscribeCall(id, CHAT_VIEW_SERVICE_ID, 'singleton') as unknown as JsonValue

    const reply = await ipc.invokeAs(wc, 'sync:invoke', { kind: 'agent', agentId: 'ghost' }, sub('a'))
    expect(reply).toMatchObject({ ok: false, error: { code: 'service_not_found' } })
    expect(holder.locate).toHaveBeenCalledTimes(1)
    expect(peekSyncHub()!.hasSubscribers('s1')).toBe(false)

    // 会话目标：从不问路由（hub peek 宿主；没有存储 → none 视图）
    holder.locate.mockClear()
    holder.rows.set('s1', { id: 's1', storageKind: 'durable-sqlite-1' })
    const ok = await ipc.invokeAs(wc, 'sync:invoke', { kind: 'session', sessionId: 's1' }, sub('b'))
    expect(ok).toMatchObject({ ok: true })
    await settle()
    expect(holder.locate).not.toHaveBeenCalled()
    expect(getSyncHub().hasSubscribers('s1')).toBe(true)
  })
})
