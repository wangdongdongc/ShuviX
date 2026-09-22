/**
 * ChromeFrontend —— 一条标签页会话在一条桥连接上的推送口。
 *
 * 契约：
 *   - id `chrome:<连接 id>:<会话 id>`，能力 {streaming, userInput}（询问卡片在侧边栏里弹、里答）；
 *   - 收到的每条事件都原样经桥发出：`chat.event {sessionId: <绑定的会话>, event}` —— 子会话的事件
 *     被注册表回溯送到父会话的前端时，外层 sessionId 仍是它绑定的那条，事件自带自己的 id；
 *   - 它**只管推送**：不记轮次、不碰浏览器状态（调试租约由桌面事件流旁听，见 observeChromeTabRun）；
 *   - isAlive 跟着连接的 ready 走，注册表据此剪掉死前端。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatEvent } from '@shuvix/chat-protocol/events'
import type { BridgeConnection } from '../../../services/chromeBridge'

const mocks = vi.hoisted(() => ({
  chromeBrowserState: vi.fn(),
  observeChromeTabRun: vi.fn()
}))

vi.mock('../../../services/chromeBridge', () => ({
  chromeBrowserState: mocks.chromeBrowserState,
  existingChromeBrowserState: mocks.chromeBrowserState,
  observeChromeTabRun: mocks.observeChromeTabRun
}))
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

import { ChromeFrontend } from '../ChromeFrontend'
import { ChatFrontendRegistry } from '../../core/ChatFrontendRegistry'

interface FakeConn {
  id: string
  ready: boolean
  info?: { installId: string; runId: string }
  emit: ReturnType<typeof vi.fn>
}

let conn: FakeConn

beforeEach(() => {
  mocks.chromeBrowserState.mockReset()
  mocks.observeChromeTabRun.mockReset()
  conn = { id: 'conn-7', ready: true, info: { installId: 'i1', runId: 'r1' }, emit: vi.fn() }
})

const frontendFor = (sessionId: string, c: FakeConn = conn): ChromeFrontend =>
  new ChromeFrontend(c as unknown as BridgeConnection, sessionId)

describe('CF-1 身份与能力', () => {
  it('CF-1 id = chrome:<连接 id>:<会话 id>；能力 streaming + userInput', () => {
    const f = frontendFor('tab-s1')
    expect(f.id).toBe('chrome:conn-7:tab-s1')
    expect(f.capabilities).toStrictEqual({ streaming: true, userInput: true })
  })
})

describe('CF-2 / CF-3 每条事件原样经桥发出，只管推送', () => {
  const events: ChatEvent[] = [
    { type: 'agent_start', sessionId: 'tab-s1' },
    { type: 'text_delta', sessionId: 'tab-s1', delta: 'hel' },
    { type: 'input_request_resolved', sessionId: 'tab-s1', requestId: 'r-1' },
    { type: 'agent_end', sessionId: 'tab-s1' }
  ]

  it('CF-2 chat.event {sessionId: 绑定的会话, event}（事件对象本身，不拷贝不改写）', () => {
    const f = frontendFor('tab-s1')
    for (const e of events) f.sendEvent(e)
    expect(conn.emit.mock.calls).toEqual(
      events.map((e) => ['chat.event', { sessionId: 'tab-s1', event: e }])
    )
    expect(conn.emit.mock.calls[1][1].event).toBe(events[1])
  })

  it('CF-2 子会话的事件经父会话的前端发出：外层是绑定的会话，事件带它自己的 id', () => {
    const f = frontendFor('tab-s1')
    const sub: ChatEvent = { type: 'text_delta', sessionId: 'sub-9', delta: 'x' }
    f.sendEvent(sub)
    expect(conn.emit.mock.calls).toEqual([['chat.event', { sessionId: 'tab-s1', event: sub }]])
  })

  it('CF-3 agent_start / agent_end 不碰浏览器状态、不记轮次（有没有 info 都一样）', () => {
    frontendFor('tab-s1').sendEvent({ type: 'agent_start', sessionId: 'tab-s1' })
    frontendFor('tab-s1').sendEvent({ type: 'agent_end', sessionId: 'tab-s1' })
    const bare = { ...conn, info: undefined, emit: vi.fn() }
    frontendFor('tab-s1', bare).sendEvent({ type: 'agent_start', sessionId: 'tab-s1' })
    expect(mocks.chromeBrowserState).not.toHaveBeenCalled()
    expect(mocks.observeChromeTabRun).not.toHaveBeenCalled()
    // 事件照发
    expect(conn.emit).toHaveBeenCalledTimes(2)
    expect(bare.emit).toHaveBeenCalledTimes(1)
  })
})

describe('CF-4 isAlive 跟着连接的 ready 走', () => {
  it('CF-4 ready 真 → 活；连接断了（ready 假）→ 死；每次现读', () => {
    const f = frontendFor('tab-s1')
    expect(f.isAlive()).toBe(true)
    conn.ready = false
    expect(f.isAlive()).toBe(false)
    conn.ready = true
    expect(f.isAlive()).toBe(true)
  })
})

describe('CF-5 挂在真的 ChatFrontendRegistry 上', () => {
  it('CF-5 input_request 与 text_delta 都送得到；连接断了 → 下一次广播就把它剪掉', () => {
    const registry = new ChatFrontendRegistry()
    registry.bind('tab-s1', frontendFor('tab-s1'))

    const ask = {
      type: 'input_request',
      sessionId: 'tab-s1',
      request: { id: 'tc-1', kind: 'ask', toolName: 'mcp__chrome__click', createdAt: 1 }
    } as unknown as ChatEvent
    const delta: ChatEvent = { type: 'text_delta', sessionId: 'tab-s1', delta: 'hi' }
    registry.broadcast(ask)
    registry.broadcast(delta)
    expect(conn.emit.mock.calls.map(([, p]) => p.event)).toEqual([ask, delta])
    expect(registry.hasCapability('tab-s1', 'userInput')).toBe(true)

    // 连接断了：广播时被剪掉，之后连接「恢复」也不会再收到（重连会重新 open / bind）
    conn.ready = false
    registry.broadcast(delta)
    expect(conn.emit).toHaveBeenCalledTimes(2)
    expect(registry.getFrontends('tab-s1')).toEqual([])
    conn.ready = true
    registry.broadcast(delta)
    expect(conn.emit).toHaveBeenCalledTimes(2)
    expect(registry.hasCapability('tab-s1', 'userInput')).toBe(false)
  })

  it('CF-5 只绑在自己那条会话上：别的会话的事件收不到', () => {
    const registry = new ChatFrontendRegistry()
    registry.bind('tab-s1', frontendFor('tab-s1'))
    registry.broadcast({ type: 'text_delta', sessionId: 'desktop-1', delta: 'secret' })
    expect(conn.emit).not.toHaveBeenCalled()
  })
})
