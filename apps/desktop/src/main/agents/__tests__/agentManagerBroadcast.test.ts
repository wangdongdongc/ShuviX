/**
 * AgentManager 的接线：派生 agent 路由自己发的事件（sub_session_register /
 * sub_session_end）必须走 **electronEventSink**，也就是同时落到聊天前端**和**通知决策器（P2-05-25）；
 * 路由的依赖恰好那五样、会话宿主惰性取（P2-05-51）。
 *
 * 断言看着琐碎，坏起来却完全无声 —— 决策器只能靠 register 记 sub→root 血缘（事件流里
 * 子 agent 与根会话完全同构，同一套 HarnessSession，只是 sessionId 是子会话 id）。
 * 少了这一路，每个子 agent 跑完的 agent_end 都会被当成「一轮结束」弹一条「已完成」，
 * 标题还因为查不到会话行而落到「未命名会话」。
 *
 * 唯独不能替掉的是 agentRuntimeAdapters —— 被测的正是它那条旁路，所以这里假的是它
 * 下游的两个出口（chatFrontendRegistry / notificationService）。
 */
import { describe, it, expect, vi } from 'vitest'
import type { ChatEvent } from '@shuvix/chat-protocol/events'

type RouterDeps = {
  broadcast: (event: ChatEvent) => void
  sessions: { get: (id: string) => unknown; peek: (id: string) => Promise<unknown> }
}

const mocks = vi.hoisted(() => ({
  deps: { value: undefined as RouterDeps | undefined },
  frontendBroadcast: vi.fn(),
  notify: vi.fn(),
  host: { get: vi.fn(), peek: vi.fn() },
  getSessionHost: vi.fn()
}))

vi.mock('@shuvix/agent-runtime', () => ({
  createSubAgentManager: (deps: RouterDeps) => {
    mocks.deps.value = deps
    return {}
  }
}))
// 路由接线之外的依赖：都只在真跑一轮时才用得上。刻意**没有** `../agentHost` 的替身 —— 路由不再经旧的
// 创建入口派发（P2-05-51）
vi.mock('../../services/sessionHost', () => ({ getSessionHost: mocks.getSessionHost }))
vi.mock('../../services/taskRegistry', () => ({ taskRegistry: { tag: 'tasks' } }))
// electronEventSink 的两个下游出口 —— 断言就下在这里
vi.mock('../../frontend/core', () => ({
  chatFrontendRegistry: { broadcast: mocks.frontendBroadcast, hasCapability: vi.fn(() => false) }
}))
vi.mock('../../services/notificationService', () => ({ notifyOnChatEvent: mocks.notify }))
vi.mock('../../services/chromeBridge', () => ({ observeChromeTabRun: vi.fn() }))
vi.mock('../../i18n', () => ({ t: (key: string) => key }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

import '../AgentManager'

/** 模块初始化时有没有建会话宿主（导入之后立刻记下） */
const hostCallsAtImport = mocks.getSessionHost.mock.calls.length

const registerEvent: ChatEvent = {
  type: 'sub_session_register',
  sessionId: 'sub-1',
  parentSessionId: 'sess-root',
  rootSessionId: 'sess-root',
  parentToolCallId: 'tool-call-1',
  subAgentName: 'explore',
  displayName: 'Explore',
  description: '找点东西',
  systemPrompt: '',
  prompt: ''
}

describe('AgentManager —— 派生 agent 事件的出口', () => {
  it('sub_session_register 同时到达聊天前端与通知决策器', () => {
    mocks.deps.value?.broadcast(registerEvent)
    expect(mocks.frontendBroadcast).toHaveBeenCalledWith(registerEvent)
    // 血缘只有这一条路能到决策器：走 chatFrontendRegistry 就直接漏了
    expect(mocks.notify).toHaveBeenCalledWith(registerEvent)
  })

  it('sub_session_end 同样两处都到 —— 决策器靠它销血缘', () => {
    const end: ChatEvent = {
      type: 'sub_session_end',
      sessionId: 'sub-1',
      parentSessionId: 'sess-root',
      result: '找完了'
    }
    mocks.deps.value?.broadcast(end)
    expect(mocks.frontendBroadcast).toHaveBeenCalledWith(end)
    expect(mocks.notify).toHaveBeenCalledWith(end)
  })
})

describe('AgentManager —— 路由的接线（P2-05-51）', () => {
  it('工厂依赖恰好是 broadcast / getAbortedNote / logger / sessions / tasks', () => {
    expect(Object.keys(mocks.deps.value ?? {}).sort()).toEqual([
      'broadcast',
      'getAbortedNote',
      'logger',
      'sessions',
      'tasks'
    ])
    expect((mocks.deps.value as unknown as { tasks: unknown }).tasks).toEqual({ tag: 'tasks' })
  })

  it('sessions 惰性：导入时不建宿主；每次 get / peek 现取单例宿主', async () => {
    expect(hostCallsAtImport).toBe(0)
    mocks.getSessionHost.mockReturnValue(mocks.host)
    mocks.host.get.mockReturnValue('open-s1')
    mocks.host.peek.mockResolvedValue('peeked-s2')
    const sessions = mocks.deps.value!.sessions
    expect(sessions.get('s1')).toBe('open-s1')
    expect(await sessions.peek('s2')).toBe('peeked-s2')
    expect(mocks.host.get).toHaveBeenCalledWith('s1')
    expect(mocks.host.peek).toHaveBeenCalledWith('s2')
    expect(mocks.getSessionHost).toHaveBeenCalledTimes(2)
  })
})
