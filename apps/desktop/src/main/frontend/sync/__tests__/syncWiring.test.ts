/**
 * 视图同步的桌面接线（P3-05，docs/pi-durable/p3-050710a-test-design.md）—— 单元部分（pi 1.2 换成 chord2 之后
 * 还适用的那些；链路与服务端的用例由下一轮测试设计补上）：
 *
 *   P3-05-13 扇出派发（按登记次序、同一个对象；关闭原因原样）
 *   P3-05-14 注销与隔离（重复注销无事、抛错的监听器只记一笔、派发途中新登记的这一轮不调）
 *   P3-05-16 服务端的宿主适配（sealed 现读、读它不建宿主；peek 交回宿主 peek 的同一个实例；类型层
 *            DurableSession 满足 SyncSession）
 *   P3-05-19 legacyView 矩阵（行 / 存储类型 / 读不出来，PIN-05）
 *   P3-05-21 resolveAgent 经路由（原样交回；认不出 → undefined）
 *   VA-1     主体核对：window 什么都能看；没登记的种类一律不让看；登记 / 注销只摘自己的
 *   SW-1     服务端单例：懒建、peekSyncHub 不建、resetSyncHubForTests 关掉旧的（之后它拒收链路）、下一次是新的
 *   SW-2     异步核对：判定原样交回（同一个 promise）；被拒的 promise 也原样往外传（不改成 false ——
 *            服务端把被拒的判定当作 forbidden，那一半在 viewServer 的用例里）
 *
 * 会话宿主模块整个换成假的（FakeSessionHost；记 getSessionHost 的调用），行表与旧格式读取器换成可控的替身。
 */
import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import {
  FrameLink,
  type DurableSession,
  type SyncAgentRef,
  type SyncSession
} from '@shuvix/agent-runtime'
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
      return row
        ? Object.fromEntries(fields.map((f) => [f, row[f as keyof typeof row]]))
        : undefined
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
  authorizeView,
  createSessionHookFanout,
  createSyncHubHost,
  getSyncHub,
  legacyViewOf,
  peekSyncHub,
  registerViewAuthorizer,
  resetSyncHubForTests,
  resolveAgentOf,
  sessionHostHooks
} from '../syncWiring'
import { FakeSessionHost } from '../../../services/__tests__/support/fakeSessionHost'

const session = (id: string): SyncSession => ({
  sessionId: id,
  projector: async () => {
    throw new Error('not used')
  },
  agentProjector: async () => undefined
})

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
    // 主进程的扇出按 DurableSession 定型（P3-08：会话信号也登记在它上面）；hub 只用 SyncSession 那一面
    sessionHostHooks.opened(s as unknown as Parameters<typeof sessionHostHooks.opened>[0])
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

  it('P3-05-21 认不出的 agentId → undefined', async () => {
    holder.locate.mockReturnValue(undefined)
    expect(await resolveAgentOf('ghost')).toBeUndefined()
  })
})

describe('VA-1 主体核对', () => {
  const target = { kind: 'session', sessionId: 's1' } as const

  it('VA-1 window 什么都能看；没登记的种类一律不让看', () => {
    expect(authorizeView({ kind: 'window', webContentsId: 1 }, target)).toBe(true)
    expect(authorizeView({ kind: 'stranger' }, target)).toBe(false)
  })

  it('VA-1 登记一种主体的核对；注销只摘自己登记的那一个；核对抛错 = 不让看', () => {
    const first = vi.fn(() => true)
    const offFirst = registerViewAuthorizer('probe', first)
    expect(authorizeView({ kind: 'probe' }, target)).toBe(true)
    expect(first).toHaveBeenCalledWith({ kind: 'probe' }, target)
    const second = vi.fn(() => {
      throw new Error('boom')
    })
    const offSecond = registerViewAuthorizer('probe', second)
    offFirst()
    expect(authorizeView({ kind: 'probe' }, target)).toBe(false)
    offSecond()
    expect(authorizeView({ kind: 'probe' }, target)).toBe(false)
  })
})

describe('SW-1 服务端单例', () => {
  it('SW-1 getSyncHub 懒建同一个实例；peekSyncHub 之前 undefined、之后同一个；reset 关掉旧的，下一次是新的', () => {
    expect(peekSyncHub()).toBeUndefined()
    const first = getSyncHub()
    expect(getSyncHub()).toBe(first)
    expect(peekSyncHub()).toBe(first)
    // 建服务端不建会话宿主（宿主在第一次 peek 时才建）
    expect(holder.getSessionHost).not.toHaveBeenCalled()

    const dispose = vi.spyOn(first, 'dispose')
    resetSyncHubForTests()
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(peekSyncHub()).toBeUndefined()
    // 旧的真的关了：新链路一来就收到 bye
    const sent: unknown[] = []
    const link = new FrameLink((frame) => void sent.push(frame))
    first.accept(link, { kind: 'window', webContentsId: 1 })
    expect(link.closed).toBe(true)
    expect(sent).toEqual([{ t: 'bye', reason: 'view server disposed' }])

    const second = getSyncHub()
    expect(second).not.toBe(first)
    expect(peekSyncHub()).toBe(second)
    expect(getSyncHub()).toBe(second)
  })

  it('SW-1 没建过时 reset 无事', () => {
    expect(peekSyncHub()).toBeUndefined()
    expect(() => resetSyncHubForTests()).not.toThrow()
    expect(peekSyncHub()).toBeUndefined()
  })
})

describe('SW-2 异步核对', () => {
  const target = { kind: 'session', sessionId: 's1' } as const

  it('SW-2 异步判定原样交回：同一个 promise，true / false 照旧，主体与目标原样交给核对', async () => {
    const yes = Promise.resolve(true)
    const allow = vi.fn(() => yes)
    const offYes = registerViewAuthorizer('async-yes', allow)
    const verdict = authorizeView({ kind: 'async-yes', id: 1 }, target)
    expect(verdict).toBe(yes)
    await expect(verdict).resolves.toBe(true)
    expect(allow).toHaveBeenCalledWith({ kind: 'async-yes', id: 1 }, target)
    offYes()

    const no = Promise.resolve(false)
    const offNo = registerViewAuthorizer('async-no', () => no)
    const refused = authorizeView({ kind: 'async-no' }, target)
    expect(refused).toBe(no)
    await expect(refused).resolves.toBe(false)
    offNo()
  })

  it('SW-2 被拒的 promise 原样往外传（authorizeView 不把它改成 false）', async () => {
    const error = new Error('lookup failed')
    const rejected = Promise.reject(error)
    rejected.catch(() => undefined)
    const off = registerViewAuthorizer('async-broken', () => rejected)
    const verdict = authorizeView({ kind: 'async-broken' }, target)
    expect(verdict).toBe(rejected)
    await expect(verdict).rejects.toBe(error)
    off()
  })
})
