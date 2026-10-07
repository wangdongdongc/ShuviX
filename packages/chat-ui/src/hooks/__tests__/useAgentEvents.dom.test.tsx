// @vitest-environment jsdom
/**
 * 余项事件分发（jsdom，P3-08）—— `useAgentEvents` 只剩不属于内容的信号：
 *
 *   P3-08-30 agent_end 先于终答帧：卡片一直在、正文从不为空；isStreaming 只在带 a2 的那次更新（或之后）才翻
 *   P3-08-35 余项不撤占位：error（MCP 连不上）、agent_closing{true} 都不撤；agent_end 只收 MCP 连接态
 *   P3-08-38 已删除的类型：store 不变、不抛；rAF 一次都没调（含卸载）；不拉 message.list
 *   P3-08-39 留下来的处理：register / end、created、closing、mcp_connecting、runtime_event、bg_task；
 *            browser_event 不在这里处理
 *   P3-08-40 没人订阅视图的会话：agent_start / agent_end 翻侧栏转圈；订阅着的会话余项不抢先
 *   P3-08-41 tool_review 先于工具进度：工具一出现就是审查中；messages 引用不变；别的会话不受影响
 *   P3-08-42 本地错误行（PIN-02）：熬过三次视图更新（含一次落盘）、挂在到达时的最后一条之后；切走即清；
 *            非当前会话的 error 什么都不加
 *   LA-R1 agent_closing{false} 重拉 agent.init：锁着时 init 报的是锁的工具选择（option A），关停完毕之后 store
 *         里的勾选回到会话设置那一份；closing{true} 不拉
 *   P3-08-59 TTS（PIN-03）：一轮以 ok 收尾才读、每个条目只读一次（agent_end 先到也一样）；reset / 重挂不重读；
 *            关着 / 非当前 / aborted / error / 空内容 / 派生 agent 都不读；agent_start 停掉正在播的
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ChatEvent } from '@shuvix/chat-protocol/events'

const mocks = vi.hoisted(() => ({
  listeners: new Set<(event: ChatEvent) => void>(),
  messageList: vi.fn(async () => []),
  agentInit: vi.fn(async (_req: { sessionId: string }) => ({
    success: true,
    created: false,
    enabledTools: ['mcp:from-settings']
  })),
  ttsEnabled: true as boolean,
  tts: {
    isPlaying: false,
    isLoading: false,
    speak: vi.fn(async () => {}),
    stop: vi.fn()
  }
}))

vi.mock('@shuvix/chat-ui', () => {
  const api = {
    agent: {
      onEvent: (callback: (event: ChatEvent) => void) => {
        mocks.listeners.add(callback)
        return () => mocks.listeners.delete(callback)
      },
      init: mocks.agentInit
    },
    message: { list: mocks.messageList },
    session: { list: async () => [] },
    events: { subscribe: () => () => {} }
  }
  return {
    getChatApi: () => api,
    getSessionChannelApi: () => api,
    useChatHost: () => ({ voice: { ttsEnabled: mocks.ttsEnabled } })
  }
})
vi.mock('../../services/tts/ttsPlayer', () => ({ ttsPlayer: mocks.tts }))
vi.mock('../../api/chatApi', () => ({
  getSessionChannelApi: () => ({ events: { subscribe: () => () => {} } })
}))

import { useAgentEvents } from '../useAgentEvents'
import {
  applySessionView,
  pendingPromptMessage,
  selectIsStreaming,
  selectPendingPrompt,
  selectStreamingContent,
  useChatStore
} from '../../stores/chatStore'
import { useSubSessionStore } from '../../stores/subSessionStore'
import { useBgTaskStore } from '../../stores/bgTaskStore'
import { buildVisibleItems } from '../../components/chat/conversationItems'
import {
  V,
  assistant,
  liveCard,
  resetStore,
  store,
  text,
  toolBlock,
  user
} from '../../__tests__/support/views'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

function Host(): null {
  useAgentEvents()
  return null
}

function emit(event: ChatEvent | Record<string, unknown>): void {
  act(() => {
    for (const listener of [...mocks.listeners]) listener(event as ChatEvent)
  })
}

function apply(...args: Parameters<typeof applySessionView>): void {
  act(() => applySessionView(...args))
}

const items = (): ReturnType<typeof buildVisibleItems> =>
  buildVisibleItems(store().messages, selectIsStreaming(store()), selectPendingPrompt(store()))

beforeEach(() => {
  resetStore('s1')
  useSubSessionStore.setState({ subSessions: {} })
  mocks.listeners.clear()
  mocks.messageList.mockClear()
  mocks.agentInit.mockClear()
  mocks.ttsEnabled = true
  mocks.tts.isPlaying = false
  mocks.tts.isLoading = false
  mocks.tts.speak.mockClear()
  mocks.tts.stop.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(createElement(Host)))
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('P3-08-38 已删除的类型', () => {
  it('store 不变、不抛；rAF 从不调用（含卸载）；不拉 message.list', () => {
    const raf = vi.spyOn(globalThis, 'requestAnimationFrame')
    const caf = vi.spyOn(globalThis, 'cancelAnimationFrame')
    apply('s1', V('s1', { messages: [user('u1', 'hi')], run: { state: 'busy' } }))
    const before = useChatStore.getState()
    for (const type of [
      'text_delta',
      'thinking_delta',
      'text_end',
      'assistant_message',
      'token_usage',
      'toolcall_generating',
      'tool_start',
      'tool_end',
      'image_data',
      'messages_reloaded',
      'user_message',
      'queue_update',
      'input_request',
      'input_request_resolved'
    ]) {
      expect(() =>
        emit({ type, sessionId: 's1', delta: 'x', message: '{}', request: { id: 'r' } })
      ).not.toThrow()
    }
    expect(useChatStore.getState()).toBe(before)
    act(() => root.unmount())
    root = createRoot(container)
    expect(raf).not.toHaveBeenCalled()
    expect(caf).not.toHaveBeenCalled()
    expect(mocks.messageList).not.toHaveBeenCalled()
    raf.mockRestore()
    caf.mockRestore()
  })
})

describe('P3-08-39 留下来的处理', () => {
  it('register / end → subSessionStore；created / closing / mcp_connecting / runtime_event / bg_task；browser_event 不处理', () => {
    emit({
      type: 'sub_session_register',
      sessionId: 'a1',
      parentSessionId: 's1',
      subAgentName: 'explore',
      displayName: 'Explore',
      description: 'find',
      systemPrompt: 'SYS',
      prompt: 'P'
    })
    expect(useSubSessionStore.getState().subSessions.a1?.displayName).toBe('Explore')
    emit({ type: 'sub_session_end', sessionId: 'a1', parentSessionId: 's1', result: 'done' })
    expect(useSubSessionStore.getState().subSessions.a1?.status).toBe('done')

    emit({ type: 'mcp_connecting', sessionId: 's1', server: 'x', connecting: true })
    expect(store().sessionMcpConnecting.s1).toEqual(['x'])
    emit({ type: 'agent_created', sessionId: 's1' })
    expect(store().sessionAgentCreated.s1).toBe(true)
    expect(store().sessionMcpConnecting.s1).toBeUndefined()
    emit({ type: 'mcp_connecting', sessionId: 's1', server: 'y', connecting: true })
    emit({ type: 'mcp_connecting', sessionId: 's1', server: 'y', connecting: false })
    expect(store().sessionMcpConnecting.s1).toBeUndefined()

    emit({ type: 'agent_closing', sessionId: 's1', closing: true })
    expect(store().sessionClosing.s1).toBe(true)
    emit({ type: 'agent_closing', sessionId: 's1', closing: false })
    expect(store().sessionClosing.s1).toBeUndefined()
    expect(store().sessionAgentCreated.s1).toBeUndefined()

    emit({ type: 'runtime_event', sessionId: 's1', runtimeId: 'ssh', status: { label: 'SSH' } })
    expect(store().sessionResources.s1.runtimes.ssh).toEqual({ label: 'SSH' })

    const upsert = vi.spyOn(useBgTaskStore.getState(), 'upsert')
    emit({ type: 'bg_task', sessionId: 's1', task: { taskId: 't1' } } as unknown as ChatEvent)
    expect(upsert).toHaveBeenCalledWith({ taskId: 't1' })
    // （任务快照只取了 taskId —— 处理器原样转交，不看其余字段）
    upsert.mockRestore()

    const before = useChatStore.getState()
    emit({ type: 'browser_event', sessionId: 's1', action: 'open', url: 'https://x' })
    expect(useChatStore.getState()).toBe(before)
  })

  it('ask_count → 询问计数（PIN-01）', () => {
    emit({ type: 'ask_count', sessionId: 'X', count: 2 })
    expect(store().sessionAskCounts.X).toBe(2)
    emit({ type: 'ask_count', sessionId: 'X', count: 0 })
    expect(store().sessionAskCounts.X).toBeUndefined()
  })
})

describe('P3-08-40 侧栏转圈', () => {
  it('没人订阅的会话 X：agent_start → 在跑；agent_end → 不在跑', () => {
    emit({ type: 'agent_start', sessionId: 'X' })
    expect(store().sessionStreams.X.isStreaming).toBe(true)
    emit({ type: 'agent_end', sessionId: 'X', reason: 'ok' })
    expect(store().sessionStreams.X.isStreaming).toBe(false)
  })

  it('订阅着的当前会话：余项从不抢在视图前面翻 isStreaming', () => {
    apply('s1', V('s1', { run: { state: 'idle' } }))
    emit({ type: 'agent_start', sessionId: 's1' })
    expect(selectIsStreaming(store())).toBe(false)
    apply('s1', V('s1', { run: { state: 'busy' } }))
    emit({ type: 'agent_end', sessionId: 's1', reason: 'ok' })
    expect(selectIsStreaming(store())).toBe(true)
  })
})

describe('P3-08-30 agent_end 先于终答帧', () => {
  it('每个记下的状态里卡片都在、正文不空；isStreaming 只在带 a2 的那次（或之后）才翻', () => {
    const u = user('u1', 'go')
    apply(
      's1',
      V('s1', { messages: [u], live: liveCard(2, [text('Hello')]), run: { state: 'busy' } })
    )
    const states: Array<{ hasCard: boolean; textOk: boolean; streaming: boolean; hasA2: boolean }> =
      []
    const off = useChatStore.subscribe((s) => {
      const list = buildVisibleItems(
        s.messages,
        s.sessionStreams.s1?.isStreaming ?? false,
        s.sessionPendingPrompt.s1 ?? null
      )
      const card = list.find((i) => i.key === 'turn:1.0')
      const placeholder = card?.isStreamingPlaceholder
      states.push({
        hasCard: card !== undefined,
        textOk: placeholder ? (s.sessionStreams.s1?.content ?? '') !== '' : !!card?.msg.content,
        streaming: s.sessionStreams.s1?.isStreaming ?? false,
        hasA2: s.messages.some((m) => m.id === 'a2')
      })
    })
    emit({ type: 'agent_end', sessionId: 's1', reason: 'ok' })
    apply(
      's1',
      V('s1', { messages: [u, assistant('a2', [text('Hello')])], run: { state: 'idle' } })
    )
    off()
    expect(states.every((s) => s.hasCard && s.textOk)).toBe(true)
    expect(states.some((s) => !s.streaming && !s.hasA2)).toBe(false)
    expect(selectIsStreaming(store())).toBe(false)
  })
})

describe('P3-08-35 余项不撤占位', () => {
  it('error（MCP 连不上）与 agent_closing{true} 都留着占位；agent_end 只收 MCP 连接态', () => {
    apply('s1', V('s1', { run: { state: 'idle' } }))
    act(() => store().setPendingPrompt('s1', pendingPromptMessage('s1', 'hello')))
    emit({ type: 'mcp_connecting', sessionId: 's1', server: 'x', connecting: true })
    emit({ type: 'error', sessionId: 's1', error: 'MCP x failed to connect' })
    expect(selectPendingPrompt(store())).not.toBeNull()
    emit({ type: 'agent_closing', sessionId: 's1', closing: true })
    expect(selectPendingPrompt(store())).not.toBeNull()
    emit({ type: 'mcp_connecting', sessionId: 's1', server: 'y', connecting: true })
    emit({ type: 'agent_end', sessionId: 's1', reason: 'error' })
    expect(selectPendingPrompt(store())).not.toBeNull()
    expect(store().sessionMcpConnecting.s1).toBeUndefined()
  })
})

describe('P3-08-41 tool_review 先于工具进度', () => {
  it('工具一出现就是审查中；做完即收；messages 引用不变；别的会话不受影响', () => {
    const card = assistant('a1', [toolBlock('A', 'bash', { command: 'ls' })])
    apply('s1', V('s1', { messages: [user('u', 'go'), card], run: { state: 'busy' } }))
    apply('B', V('B', { messages: [], toolRuns: {}, run: { state: 'busy' } }))
    const messages = store().messages
    emit({ type: 'tool_review', sessionId: 's1', toolCallId: 'A', reviewing: true })
    apply(
      's1',
      V('s1', {
        messages: [user('u', 'go'), card],
        toolRuns: { A: { status: 'running' } },
        run: { state: 'busy' }
      })
    )
    expect(store().sessionToolExecutions.s1[0]).toMatchObject({ toolCallId: 'A', reviewing: true })
    expect(store().messages).toBe(messages)
    expect(store().sessionToolReviewing.B).toBeUndefined()
    emit({ type: 'tool_review', sessionId: 's1', toolCallId: 'A', reviewing: false })
    expect(store().sessionToolExecutions.s1[0].reviewing).toBeFalsy()
    emit({ type: 'tool_review', sessionId: 's1', toolCallId: 'A', reviewing: true })
    apply(
      's1',
      V('s1', {
        messages: [
          user('u', 'go'),
          assistant('a1', [toolBlock('A', 'bash', { command: 'ls' }, { result: 'x' })])
        ],
        toolRuns: { A: { status: 'done' } },
        run: { state: 'busy' }
      })
    )
    expect(store().sessionToolExecutions.s1[0].reviewing).toBeFalsy()
  })
})

describe('P3-08-42 本地错误行（PIN-02）', () => {
  it('熬过三次视图更新（含一次落盘）、挂在到达时最后一条之后；切走即清；非当前会话的 error 什么都不加', () => {
    const u = user('u1', 'go')
    const a = assistant('a1', [text('one')])
    apply('s1', V('s1', { messages: [u, a], run: { state: 'busy' } }))
    emit({ type: 'error', sessionId: 's1', error: 'boom' })
    apply(
      's1',
      V('s1', { messages: [u, a], live: liveCard(3, [text('x')]), run: { state: 'busy' } })
    )
    apply(
      's1',
      V('s1', { messages: [u, a], live: liveCard(3, [text('xy')]), run: { state: 'busy' } })
    )
    apply(
      's1',
      V('s1', { messages: [u, a, assistant('a2', [text('xy')])], run: { state: 'idle' } })
    )
    expect(
      store().messages.map((m) => (m.type === 'error_event' ? `err:${m.content}` : m.id))
    ).toEqual(['u1', 'a1', 'err:boom', 'a2'])
    emit({ type: 'error', sessionId: 'other', error: 'elsewhere' })
    expect(store().messages.some((m) => m.content === 'elsewhere')).toBe(false)

    act(() => store().setActiveSessionId('B'))
    act(() => store().setActiveSessionId('s1'))
    expect(store().messages.some((m) => m.type === 'error_event')).toBe(false)
  })
})

describe('P3-08-59 TTS（PIN-03）', () => {
  const u = user('u1', 'go')
  function runTo(
    final: ReturnType<typeof assistant>,
    endFirst: boolean,
    reason: 'ok' | 'aborted' | 'error' = 'ok',
    sid = 's1'
  ): void {
    apply(
      sid,
      V(sid, { messages: [u], live: liveCard(2, [text(final.content)]), run: { state: 'busy' } })
    )
    if (endFirst) emit({ type: 'agent_end', sessionId: sid, reason })
    apply(sid, V(sid, { messages: [u, final], run: { state: 'idle' } }))
    if (!endFirst) emit({ type: 'agent_end', sessionId: sid, reason })
  }

  it('ok 收尾读一次（终答帧先到 / agent_end 先到都一样）；reset、重挂不再读', () => {
    runTo(assistant('41', [text('spoken answer')]), false)
    expect(mocks.tts.speak.mock.calls).toEqual([['spoken answer', '41']])
    apply(
      's1',
      JSON.parse(
        JSON.stringify(V('s1', { messages: [u, assistant('41', [text('spoken answer')])] }))
      )
    )
    expect(mocks.tts.speak).toHaveBeenCalledTimes(1)

    emit({ type: 'agent_start', sessionId: 's1' })
    runTo(assistant('42', [text('second')]), true)
    expect(mocks.tts.speak.mock.calls.at(-1)).toEqual(['second', '42'])
    expect(mocks.tts.speak).toHaveBeenCalledTimes(2)
  })

  it('长文截到 4000 字', () => {
    runTo(assistant('43', [text('x'.repeat(5000))]), false)
    expect((mocks.tts.speak.mock.calls[0] as unknown[])[0]).toHaveLength(4000)
  })

  it.each([
    ['关着', () => (mocks.ttsEnabled = false), 'ok' as const],
    ['aborted', () => {}, 'aborted' as const],
    ['error', () => {}, 'error' as const]
  ])('不读：%s', (_name, prepare, reason) => {
    act(() => root.unmount())
    prepare()
    root = createRoot(container)
    act(() => root.render(createElement(Host)))
    runTo(assistant('50', [text('nope')]), false, reason)
    expect(mocks.tts.speak).not.toHaveBeenCalled()
  })

  it('不读：非当前会话、空内容、派生 agent 的 agent_end', () => {
    runTo(assistant('60', [text('bg')]), false, 'ok', 'other')
    runTo(assistant('61', [text('   ')]), false)
    emit({
      type: 'sub_session_register',
      sessionId: 'a1',
      parentSessionId: 's1',
      subAgentName: 'explore',
      displayName: 'E',
      description: '',
      systemPrompt: '',
      prompt: ''
    })
    emit({ type: 'agent_end', sessionId: 'a1', reason: 'ok' })
    expect(mocks.tts.speak).not.toHaveBeenCalled()
  })

  it('agent_start 停掉正在播的', () => {
    mocks.tts.isPlaying = true
    emit({ type: 'agent_start', sessionId: 's1' })
    expect(mocks.tts.stop).toHaveBeenCalledTimes(1)
  })
})

describe('流式正文仍从视图读', () => {
  it('实时卡追加只改流式正文', () => {
    apply('s1', V('s1', { live: liveCard(1, [text('a')]), run: { state: 'busy' } }))
    expect(selectStreamingContent(store())).toBe('a')
    expect(items().at(-1)!.isStreamingPlaceholder).toBe(true)
  })
})

describe('LA-R1 agent_closing re-pulls the session tool state', () => {
  it("closing{false} re-pulls agent.init: the selection goes back to the session settings (while locked init reported the lock's); closing{true} does not", async () => {
    act(() => {
      useChatStore.setState({
        sessions: [
          {
            id: 's1',
            title: 's1',
            projectId: null,
            settings: { enabledTools: ['skill:pdf', 'mcp:ssh'] }
          } as unknown as ReturnType<typeof store>['sessions'][number]
        ],
        sessionAgentCreated: { s1: true }
      })
    })
    emit({ type: 'agent_closing', sessionId: 's1', closing: true })
    expect(mocks.agentInit).not.toHaveBeenCalled()
    emit({ type: 'agent_closing', sessionId: 's1', closing: false })
    await act(async () => {
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(mocks.agentInit).toHaveBeenCalledWith({ sessionId: 's1' }))
    await vi.waitFor(() =>
      expect(store().sessions.find((s) => s.id === 's1')?.settings.enabledTools).toEqual([
        'mcp:from-settings'
      ])
    )
    expect(store().sessionAgentCreated.s1).toBeUndefined()
  })
})
