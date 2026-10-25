/**
 * electronEventSink（agentRuntimeAdapters.ts）的「产物引用钉版本」旁路：一轮的 `agent_end` 一到，按需加载会话宿主
 * 与 pins，钉住这一轮终答里的引用（`pinFinalReply(peekSessionHost()?.get(sid), sid)`）。
 *
 *   ES-AP-1 agent_end → pinFinalReply 恰一次，session 是 `peekSessionHost().get(sid)` 交回的那个；三路既有出口照收
 *   ES-AP-2 宿主还没建（peekSessionHost → undefined）→ pinFinalReply(undefined, sid)；派生 agent 的 agent_end
 *           （sessionId = agentId，宿主里没有）→ pinFinalReply(undefined, agentId)，由它自己判没什么可钉
 *   ES-AP-3 别的事件（agent_start / error / ask_count …）→ 不钉
 *   ES-AP-4 按需加载失败（sessionHost 模块加载抛错）：broadcast 不抛、另三路照旧各收一次、记一条 warn、不钉
 *   ES-AP-5 pinFinalReply 自己 reject：broadcast 不抛，记 warn
 *
 * 另三路出口（前端、通知、Chrome 租约）换成 spy；sessionHost 与 pins 换成桩（真的 sessionHost 带着整套运行时）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatEvent } from '@shuvix/chat-protocol/events'

const mocks = vi.hoisted(() => ({
  frontendBroadcast: vi.fn(),
  notify: vi.fn(),
  observe: vi.fn(),
  pinFinalReply: vi.fn(async (_session: unknown, _sid: string) => {}),
  get: vi.fn((_sid: string): unknown => undefined),
  hostBuilt: true,
  warns: [] as string[]
}))

vi.mock('../../frontend/core', () => ({
  chatFrontendRegistry: { broadcast: mocks.frontendBroadcast, hasCapability: vi.fn(() => false) }
}))
vi.mock('../notificationService', () => ({ notifyOnChatEvent: mocks.notify }))
vi.mock('../chromeBridge', () => ({ observeChromeTabRun: mocks.observe }))
vi.mock('../../logger', () => ({
  createLogger: () => ({
    info: () => {},
    error: () => {},
    debug: () => {},
    warn: (msg: string) => {
      mocks.warns.push(String(msg))
    }
  })
}))
/** 会话宿主的桩模块（函数声明：随模块提升，vi.mock / vi.doMock 的工厂都能用） */
function sessionHostStub(): Record<string, unknown> {
  return {
    peekSessionHost: () => (mocks.hostBuilt ? { get: (sid: string) => mocks.get(sid) } : undefined)
  }
}
vi.mock('../sessionHost', () => sessionHostStub())
vi.mock('../artifacts/pins', () => ({ pinFinalReply: mocks.pinFinalReply }))

type SinkModule = typeof import('../agentRuntimeAdapters')

async function loadSink(): Promise<SinkModule['electronEventSink']> {
  vi.resetModules()
  return (await import('../agentRuntimeAdapters')).electronEventSink
}

/** 让按需 import 与随后的 then / catch 落定 */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
}

const END: ChatEvent = { type: 'agent_end', sessionId: 's1', reason: 'ok' }

beforeEach(() => {
  for (const m of [mocks.frontendBroadcast, mocks.notify, mocks.observe, mocks.get]) m.mockReset()
  mocks.pinFinalReply.mockReset()
  mocks.pinFinalReply.mockResolvedValue(undefined)
  mocks.hostBuilt = true
  mocks.warns = []
})

describe('electronEventSink → 钉终答引用的版本', () => {
  it('ES-AP-1 agent_end → pinFinalReply(peekSessionHost().get(sid), sid) 恰一次；另三路照收', async () => {
    const session = { sentinel: 'durable-session' }
    mocks.get.mockImplementation((sid) => (sid === 's1' ? session : undefined))
    const sink = await loadSink()
    sink.broadcast(END)
    await vi.waitFor(() => expect(mocks.pinFinalReply).toHaveBeenCalledTimes(1))
    expect(mocks.get.mock.calls).toEqual([['s1']])
    expect(mocks.pinFinalReply.mock.calls[0][0]).toBe(session)
    expect(mocks.pinFinalReply.mock.calls[0][1]).toBe('s1')
    for (const spy of [mocks.frontendBroadcast, mocks.notify, mocks.observe]) {
      expect(spy.mock.calls).toEqual([[END]])
    }
    await settle()
    expect(mocks.pinFinalReply).toHaveBeenCalledTimes(1)
    expect(mocks.warns).toEqual([])
  })

  it('ES-AP-2 宿主还没建 → session undefined；派生 agent 的 agent_end → pinFinalReply(undefined, agentId)', async () => {
    mocks.hostBuilt = false
    let sink = await loadSink()
    sink.broadcast(END)
    await vi.waitFor(() => expect(mocks.pinFinalReply).toHaveBeenCalledTimes(1))
    expect(mocks.pinFinalReply.mock.calls[0]).toEqual([undefined, 's1'])

    mocks.hostBuilt = true
    mocks.pinFinalReply.mockClear()
    sink = await loadSink()
    sink.broadcast({ type: 'agent_end', sessionId: 'agent-a1', reason: 'ok' })
    await vi.waitFor(() => expect(mocks.pinFinalReply).toHaveBeenCalledTimes(1))
    expect(mocks.get.mock.calls).toEqual([['agent-a1']])
    expect(mocks.pinFinalReply.mock.calls[0]).toEqual([undefined, 'agent-a1'])
  })

  it.each<ChatEvent>([
    { type: 'agent_start', sessionId: 's1' },
    { type: 'error', sessionId: 's1', error: 'boom' },
    { type: 'ask_count', sessionId: 's1', count: 1 },
    { type: 'mcp_connecting', sessionId: 's1', server: 'x', connecting: true }
  ])('ES-AP-3 $type → 不钉', async (event) => {
    const sink = await loadSink()
    sink.broadcast(event)
    await settle()
    expect(mocks.pinFinalReply).not.toHaveBeenCalled()
    expect(mocks.get).not.toHaveBeenCalled()
    expect(mocks.frontendBroadcast.mock.calls).toEqual([[event]])
  })

  it('ES-AP-4 按需加载失败：broadcast 不抛、另三路各收一次、记 warn、不钉', async () => {
    vi.doMock('../sessionHost', () => {
      throw new Error('sessionHost failed to load')
    })
    try {
      const sink = await loadSink()
      expect(() => sink.broadcast(END)).not.toThrow()
      for (const spy of [mocks.frontendBroadcast, mocks.notify, mocks.observe]) {
        expect(spy.mock.calls).toEqual([[END]])
      }
      await vi.waitFor(() => expect(mocks.warns.length).toBeGreaterThan(0))
      // vitest 把工厂抛的错包了一层（「There was an error when mocking a module …」）：只认这一路自己的那条 warn
      expect(mocks.warns).toHaveLength(1)
      expect(mocks.warns[0]).toMatch(/^钉终答引用的版本失败: /)
      expect(mocks.pinFinalReply).not.toHaveBeenCalled()

      // 下一个事件照样每一路都走（加载失败不粘在汇上）
      sink.broadcast({ type: 'agent_start', sessionId: 's1' })
      expect(mocks.frontendBroadcast).toHaveBeenCalledTimes(2)
      expect(mocks.observe).toHaveBeenCalledTimes(2)
    } finally {
      vi.doMock('../sessionHost', () => sessionHostStub())
    }
  })

  it('ES-AP-5 pinFinalReply 自己 reject：broadcast 不抛，记 warn', async () => {
    mocks.pinFinalReply.mockRejectedValue(new Error('pin exploded'))
    const sink = await loadSink()
    expect(() => sink.broadcast(END)).not.toThrow()
    await vi.waitFor(() => expect(mocks.warns.join('\n')).toContain('pin exploded'))
    expect(mocks.frontendBroadcast.mock.calls).toEqual([[END]])
  })
})
