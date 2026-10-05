// @vitest-environment jsdom
/**
 * `useSessionView` / `useAgentView` 这一层（jsdom）—— 钩子把 syncClient 交出的值经唯一写入口写进 store：
 *
 *   P3-08-01 挂上、等稳：store 里的视图 = 服务端的值；绑定没有错误
 *   P3-08-04 订阅失败：钩子状态 {error, code}、只订一次、这条会话的切片一个都不写
 *   P3-08-07 不可用：钩子报 unavailable、store 回到空视图的值（PIN-14）；之后 replaced → 又是 live、store 是新值
 *   P3-08-08 两个使用方：一次订阅；卸掉一个不退订、视图切片还在；都卸掉退订一次、切片丢掉
 *   P3-08-09 A → B → A（React 合批内）：最终 store 是 A 的；B 的切片不残留
 *   P3-08-24 useAgentView：订阅 `{kind:'agent'}`；service_not_found → error + code、不建条目；卸载退订一次
 *
 * 渠道是 `fakeServer` 的真 chord 服务端，经 `setSessionChannelApi` 注入。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { SessionChannelApi } from '@shuvix/chat-protocol/chatApi'
import type { SyncTarget } from '@shuvix/chat-protocol/sync'
import { emptySessionView, type AgentView } from '@shuvix/chat-protocol/types/sessionView'
import { setSessionChannelApi } from '../../api/chatApi'
import { useChatStore } from '../../stores/chatStore'
import { useSubSessionStore } from '../../stores/subSessionStore'
import { useSessionView } from '../useSessionView'
import { useAgentView } from '../useAgentView'
import type { ViewBindingState } from '../../sync/syncClient'
import { fakeServer, type FakeServer } from '../../sync/__tests__/support/fakeServer'
import { V, liveCard, resetStore, store, text, user } from '../../__tests__/support/views'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const S1: SyncTarget = { kind: 'session', sessionId: 's1' }

let container: HTMLDivElement
let root: Root
let server: FakeServer

function inject(s: FakeServer): void {
  setSessionChannelApi({ sync: s.channel } as unknown as SessionChannelApi)
}

const states: Record<string, ViewBindingState> = {}

function SessionProbe({ id, tag }: { id: string | null; tag: string }): null {
  const state = useSessionView(id)
  useEffect(() => {
    states[tag] = state
  })
  return null
}

function AgentProbe({ id }: { id: string | null }): null {
  const state = useAgentView(id)
  useEffect(() => {
    states.agent = state
  })
  return null
}

function render(element: ReturnType<typeof createElement>): void {
  act(() => {
    root.render(element)
  })
}

async function settle(): Promise<void> {
  await act(async () => {
    await server.settle()
  })
}

beforeEach(() => {
  resetStore('s1')
  useSubSessionStore.setState({ subSessions: {} })
  for (const key of Object.keys(states)) delete states[key]
  server = fakeServer()
  inject(server)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('useSessionView', () => {
  it('P3-08-01 挂上、等稳：store 里的视图 = 服务端的值；绑定 live', async () => {
    server = fakeServer({ framesBeforeReply: 2 })
    inject(server)
    server.serve(
      S1,
      V('s1', {
        messages: [user('u1', 'hi')],
        live: liveCard(3, [text('He')]),
        run: { state: 'busy' }
      })
    )
    render(createElement(SessionProbe, { id: 's1', tag: 'a' }))
    await settle()
    expect(store().sessionViews.s1).toEqual(server.value(S1))
    expect(states.a).toEqual({ status: 'live' })
    expect(store().messages).toEqual((server.value(S1) as ReturnType<typeof V>).messages)
  })

  it('P3-08-04 订阅失败：钩子 {error, code}、只订一次、这条会话的切片一个都不写', async () => {
    server.serve(S1, V('s1'))
    server.failSubscribe('service_not_found')
    render(createElement(SessionProbe, { id: 's1', tag: 'a' }))
    await settle()
    expect(states.a).toEqual({ status: 'error', code: 'service_not_found' })
    expect(server.calls.filter((c) => /^(subscribe|fail):/.test(c))).toHaveLength(1)
    expect(store().sessionViews.s1).toBeUndefined()
    expect(store().sessionStreams.s1).toBeUndefined()
    expect(store().sessionPendingInputs.s1).toBeUndefined()
    expect(store().messages).toEqual([])
  })

  it('P3-08-07 不可用 → unavailable、store 回到空视图的值（PIN-14）；replaced → live、store 是新值', async () => {
    server.serve(
      S1,
      V('s1', {
        messages: [user('u1', 'hi')],
        run: { state: 'busy' },
        asks: [{ id: 'r1', kind: 'ask', toolName: 'bash', command: 'ls', createdAt: 0 }]
      })
    )
    render(createElement(SessionProbe, { id: 's1', tag: 'a' }))
    await settle()
    expect(store().messages).toHaveLength(1)
    // 本地叠加：一行本地错误
    act(() => store().addLocalError('s1', 'local boom'))

    act(() => server.withdraw(S1))
    await settle()
    expect(states.a).toEqual({ status: 'unavailable' })
    expect(store().sessionViews.s1).toEqual(emptySessionView('s1'))
    expect(store().sessionStreams.s1.isStreaming).toBe(false)
    expect(store().sessionPendingInputs.s1).toBeUndefined()
    // 本地叠加保留
    expect(store().messages.map((m) => m.content)).toEqual(['local boom'])

    act(() => server.replace(S1, V('s1', { messages: [user('u9', 'back')] })))
    await settle()
    expect(states.a).toEqual({ status: 'live' })
    expect(store().sessionViews.s1.messages.map((m) => m.id)).toEqual(['u9'])
  })

  it('P3-08-08 两个使用方：一次订阅；卸一个不退订、切片还在；都卸掉退订一次、切片丢掉', async () => {
    server.serve(S1, V('s1', { messages: [user('u1', 'hi')] }))
    render(
      createElement('div', null, [
        createElement(SessionProbe, { key: 'a', id: 's1', tag: 'a' }),
        createElement(SessionProbe, { key: 'b', id: 's1', tag: 'b' })
      ])
    )
    await settle()
    expect(server.calls.filter((c) => c.startsWith('subscribe:'))).toHaveLength(1)
    render(
      createElement('div', null, [createElement(SessionProbe, { key: 'a', id: 's1', tag: 'a' })])
    )
    await settle()
    expect(server.calls.filter((c) => c.startsWith('unsubscribe:'))).toHaveLength(0)
    expect(store().sessionViews.s1).toBeDefined()
    render(createElement('div', null, []))
    await settle()
    expect(server.calls.filter((c) => c.startsWith('unsubscribe:'))).toHaveLength(1)
    expect(server.frameListeners.active).toBe(0)
    expect(store().sessionViews.s1).toBeUndefined()
  })

  it('P3-08-09 A → B → A（一次合批）：最终是 A；B 的切片不残留；服务端对 B 没有订阅', async () => {
    const A: SyncTarget = { kind: 'session', sessionId: 'A' }
    const B: SyncTarget = { kind: 'session', sessionId: 'B' }
    server.serve(A, V('A', { messages: [user('a1', 'from A', 'A')] }))
    server.serve(B, V('B', { messages: [user('b1', 'from B', 'B')] }))
    act(() => store().setActiveSessionId('A'))
    function Active(): null {
      const id = useChatStore((s) => s.activeSessionId)
      useSessionView(id)
      return null
    }
    render(createElement(Active))
    act(() => {
      store().setActiveSessionId('B')
      store().setActiveSessionId('A')
    })
    await settle()
    expect(store().activeSessionId).toBe('A')
    expect(store().messages.map((m) => m.id)).toEqual(['a1'])
    expect(store().sessionViews.B).toBeUndefined()
    expect(server.subscriptions(B)).toEqual([])
  })
})

describe('useAgentView', () => {
  const AGENT: SyncTarget = { kind: 'agent', agentId: 'a1' }
  const agentView = (): AgentView => ({
    v: 1,
    agentId: 'a1',
    sessionId: 's1',
    conversationId: 2,
    messages: [user('7', 'go', 'a1')],
    live: liveCard(9, [text('wor')], undefined, 'a1'),
    toolRuns: {},
    run: { state: 'busy' },
    context: { usedTokens: null }
  })

  function registerA1(): void {
    useSubSessionStore.getState().register({
      subSessionId: 'a1',
      parentSessionId: 's1',
      subAgentName: 'explore',
      displayName: 'Explore',
      description: 'find',
      systemPrompt: 'SYS',
      prompt: 'PROMPT'
    })
  }

  it('P3-08-24 订阅 {kind:agent}：值镜像进登记过的条目；卸载退订一次', async () => {
    registerA1()
    server.serve(AGENT, agentView())
    render(createElement(AgentProbe, { id: 'a1' }))
    await settle()
    expect(states.agent).toEqual({ status: 'live' })
    const entry = useSubSessionStore.getState().subSessions.a1
    expect(entry.messages.map((m) => m.id)).toEqual(['7'])
    expect(entry.streamingContent).toBe('wor')
    expect(server.subscriptions(AGENT)).toHaveLength(1)
    render(createElement(AgentProbe, { id: null }))
    await settle()
    expect(server.calls.filter((c) => c.startsWith('unsubscribe:'))).toHaveLength(1)
  })

  it('P3-08-24 service_not_found → error + code、不建条目', async () => {
    server.serve(AGENT, agentView())
    server.failSubscribe('service_not_found')
    render(createElement(AgentProbe, { id: 'a1' }))
    await settle()
    expect(states.agent).toEqual({ status: 'error', code: 'service_not_found' })
    expect(useSubSessionStore.getState().subSessions.a1).toBeUndefined()
  })
})
