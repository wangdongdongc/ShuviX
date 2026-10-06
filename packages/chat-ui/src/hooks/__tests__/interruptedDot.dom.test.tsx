// @vitest-environment jsdom
/**
 * 侧栏「被中断」圆点的新鲜度（jsdom，P3-12-21，PIN-18 —— 渲染端规则）：
 *
 *   - 列表里 `s1` 的 `runState:'interrupted'` → 圆点在；
 *   - `s1` 的 `agent_start` 生命周期事件 → 本端就地清掉（主进程写镜像不广播）；
 *   - `s1` 订阅着视图时以视图的 `run.state` 为准：idle / busy 压掉圆点，interrupted 显示它；
 *   - 之后重新拉到的列表说 `idle` → 照旧是清掉的。
 *
 * 选择器 `selectInterruptedSessions` 是 ProjectSessionGroups 喂给 SessionItem 的那一份；`useAgentEvents` 挂在一个
 * 空组件上（mock 骨架同 useAgentEvents.dom.test.tsx）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ChatEvent } from '@shuvix/chat-protocol/events'

const mocks = vi.hoisted(() => ({
  listeners: new Set<(event: ChatEvent) => void>()
}))

vi.mock('@shuvix/chat-ui', () => {
  const api = {
    agent: {
      onEvent: (callback: (event: ChatEvent) => void) => {
        mocks.listeners.add(callback)
        return () => mocks.listeners.delete(callback)
      }
    },
    message: { list: async () => [] },
    session: { list: async () => [] },
    events: { subscribe: () => () => {} }
  }
  return {
    getChatApi: () => api,
    getSessionChannelApi: () => api,
    useChatHost: () => ({ voice: { ttsEnabled: false } })
  }
})
vi.mock('../../services/tts/ttsPlayer', () => ({
  ttsPlayer: { isPlaying: false, isLoading: false, speak: vi.fn(), stop: vi.fn() }
}))
vi.mock('../../api/chatApi', () => ({
  getSessionChannelApi: () => ({ events: { subscribe: () => () => {} } })
}))

import { useAgentEvents } from '../useAgentEvents'
import {
  applySessionView,
  releaseSessionView,
  selectInterruptedSessions,
  useChatStore,
  type Session
} from '../../stores/chatStore'
import { V, resetStore, store } from '../../__tests__/support/views'

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

function emit(event: Record<string, unknown>): void {
  act(() => {
    for (const listener of [...mocks.listeners]) listener(event as unknown as ChatEvent)
  })
}

function row(id: string, runState?: Session['settings']['runState']): Session {
  return {
    id,
    title: id,
    projectId: null,
    parentId: null,
    settings: runState === undefined ? {} : { runState },
    createdAt: 0,
    updatedAt: 0,
    lastActiveAt: 0
  }
}

const dots = (): Record<string, boolean> => selectInterruptedSessions(store())

beforeEach(() => {
  resetStore(null)
  mocks.listeners.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(createElement(Host)))
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('P3-12-21 dot freshness', () => {
  it('P3-12-21 the list value shows the dot; agent_start for s1 clears it locally; a refetch that says idle keeps it cleared', () => {
    act(() => store().setSessions([row('s1', 'interrupted'), row('s2', 'interrupted'), row('s3')]))
    expect(dots()).toEqual({ s1: true, s2: true })
    emit({ type: 'agent_start', sessionId: 's1' })
    expect(dots()).toEqual({ s2: true })
    act(() => store().setSessions([row('s1', 'idle'), row('s2', 'interrupted'), row('s3')]))
    expect(dots()).toEqual({ s2: true })
  })

  it("P3-12-21 while s1's view is subscribed, its run.state decides: idle / busy suppress the dot, interrupted shows it", () => {
    act(() => store().setSessions([row('s1', 'interrupted')]))
    act(() => store().setActiveSessionId('s1'))
    act(() => applySessionView('s1', V('s1', { run: { state: 'idle' } })))
    expect(dots()).toEqual({})
    act(() => applySessionView('s1', V('s1', { run: { state: 'busy' } })))
    expect(dots()).toEqual({})
    act(() => applySessionView('s1', V('s1', { run: { state: 'interrupted' } })))
    expect(dots()).toEqual({ s1: true })
    // 列表说 idle、视图说 interrupted：视图为准
    act(() => store().setSessions([row('s1', 'idle')]))
    expect(dots()).toEqual({ s1: true })
    // 退订之后回到列表的值
    act(() => releaseSessionView('s1'))
    expect(dots()).toEqual({})
  })

  it('P3-12-21 the selector is reference-stable while the answer does not change', () => {
    act(() => store().setSessions([row('s1', 'interrupted')]))
    const first = dots()
    act(() => useChatStore.setState({ inputText: 'typing' }))
    act(() => store().setSessions([row('s1', 'interrupted')]))
    expect(dots()).toBe(first)
  })
})
