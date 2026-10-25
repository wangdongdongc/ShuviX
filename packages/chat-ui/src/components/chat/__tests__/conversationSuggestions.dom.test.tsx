// @vitest-environment jsdom
/**
 * 提议卡片在真的 Conversation 里（`suggest` 工具，2026-10-25；jsdom）：Conversation → `suggestionStatesOf(messages)` →
 * `SuggestionContext` → AssistantBubble → SuggestionCards。状态不另存，全从视图里的消息读出，所以会话视图一变卡片就跟着变。
 *
 *   C-10 只有那组提议、之后没人说话 → 开着（按钮可点）；之后来了一条用户消息 → 关了（没有按钮、一句「已关闭」）；
 *        之后那条用户消息的来源带着指向它的引用 → 采纳（那张卡 `data-suggestion-accepted`，其余压淡）；之后只来了一条
 *        系统通知（后台完成）→ 什么都不变，仍开着；点按钮带的是这条会话的 id
 *
 * 桩照抄 conversationFork.dom.test.tsx：Virtuoso 换成直接把每一项画出来的壳；输入区、待处理输入、Footer 顶成空壳；
 * `useChatActions` 交回稳定回调；包入口给 `useChatHost` 与 `getHostApi: () => null`。宿主经 `setChatApi` 注入
 * （session.list + suggestion.accept）。数据走真的 chatStore。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type { ChatApi } from '@shuvix/chat-protocol/chatApi'
import { DURABLE_SQLITE_1 } from '@shuvix/chat-protocol/sessionStorageKind'
import type { AcceptSuggestionResult } from '@shuvix/chat-protocol/suggestions'
import type { AssistantToolBlock, ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'

interface VirtuosoStubProps {
  data: Array<{ key: string }>
  itemContent: (index: number, item: unknown) => ReactNode
  computeItemKey: (index: number, item: unknown) => string
}

const probe = vi.hoisted(() => ({
  host: { appearance: { focusMode: false } },
  noop: () => {}
}))

vi.mock('@shuvix/chat-ui', () => ({
  useChatHost: () => probe.host,
  getHostApi: () => null
}))
vi.mock('react-virtuoso', async () => {
  const React = await import('react')
  const Virtuoso = React.forwardRef<unknown, VirtuosoStubProps>(function VirtuosoStub(props, ref) {
    React.useImperativeHandle(ref, () => ({ scrollToIndex: () => {} }), [])
    return React.createElement(
      'div',
      { 'data-virtuoso-stub': '' },
      props.data.map((item, i) =>
        React.createElement(
          React.Fragment,
          { key: props.computeItemKey(i, item) },
          props.itemContent(i, item)
        )
      )
    )
  })
  return { Virtuoso }
})
vi.mock('../InputArea', () => ({ InputArea: () => null }))
vi.mock('../PendingInputsPanel', () => ({ PendingInputsPanel: () => null }))
vi.mock('../StreamingFooter', () => ({ StreamingFooter: () => null }))
vi.mock('../../../hooks/useChatActions', () => {
  const actions = {
    handleRollback: probe.noop,
    pendingRollbackId: null,
    confirmRollback: probe.noop,
    cancelRollback: probe.noop,
    handleRegenerate: probe.noop,
    canRollback: true,
    handleInputResponse: probe.noop
  }
  return { useChatActions: () => actions }
})

import { setChatApi } from '../../../api/chatApi'
import { applySessionView, useChatStore, type Session } from '../../../stores/chatStore'
import { Conversation } from '../Conversation'
import { V, assistant, resetStore, text, user } from '../../../__tests__/support/views'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const SID = 's1'

let container: HTMLDivElement
let root: Root
let accept: ReturnType<typeof vi.fn<(params: unknown) => Promise<AcceptSuggestionResult>>>

const SESSION = {
  id: SID,
  title: 'Suggestions',
  projectId: 'p1',
  parentId: null,
  settings: {},
  createdAt: 0,
  updatedAt: 0,
  lastActiveAt: 0,
  storageKind: DURABLE_SQLITE_1
} as unknown as Session

const suggestBlock: AssistantToolBlock = {
  type: 'tool',
  toolCallId: 'call_0',
  toolName: 'suggest',
  args: {
    suggestions: [
      { title: 'Add tests', message: 'Yes, add tests' },
      { title: 'Update docs', message: 'Please update the README' }
    ]
  },
  result: 'Shown 2 suggestions'
}

/** u1 · 卡 [a1：提议 + 终答] —— 之后接上 `after` */
const history = (...after: ChatMessage[]): ChatMessage[] => [
  user('u1', 'hi', SID),
  assistant('a1', [suggestBlock, text('Here is what I did.')], SID),
  ...after
]

function load(messages: ChatMessage[]): void {
  act(() => {
    useChatStore.setState({ sessions: [SESSION] })
    applySessionView(SID, V(SID, { messages }))
  })
}

function render(): void {
  act(() => root.render(createElement(Conversation, { sessionId: SID })))
}

const group = (): HTMLElement | null => container.querySelector<HTMLElement>('[data-suggestions]')
const buttons = (): HTMLButtonElement[] => [
  ...container.querySelectorAll<HTMLButtonElement>('[data-suggestion-accept]')
]
const cards = (): HTMLElement[] => [
  ...container.querySelectorAll<HTMLElement>('[data-suggestion-index]')
]

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    showSupportNotice: false
  })
  Element.prototype.scrollIntoView = vi.fn()
})

beforeEach(() => {
  vi.useFakeTimers()
  resetStore(SID)
  accept = vi.fn(async () => ({ success: true }) as AcceptSuggestionResult)
  setChatApi({
    session: { list: vi.fn(async () => [SESSION]) },
    suggestion: { accept }
  } as unknown as ChatApi)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

describe('C-10 卡片状态跟着会话视图走', () => {
  it('C-10 之后没人说话 → 开着，按钮可点；点它带的是这条会话的 id', async () => {
    load(history())
    render()
    expect(group()!.getAttribute('data-suggestion-state')).toBe('open')
    expect(buttons()).toHaveLength(2)
    await act(async () => {
      buttons()[1]!.click()
      await Promise.resolve()
    })
    expect(accept.mock.calls).toStrictEqual([
      [{ sessionId: SID, messageId: 'a1', toolCallId: 'call_0', index: 1 }]
    ])
  })

  it('C-10 之后来了一条用户消息 → 关了：没有按钮，一句「已关闭」', () => {
    load(history())
    render()
    expect(buttons()).toHaveLength(2)
    load(history(user('u2', 'something else', SID)))
    expect(group()!.getAttribute('data-suggestion-state')).toBe('closed')
    expect(buttons()).toHaveLength(0)
    expect(container.textContent).toContain(en.suggestion.closed)
  })

  it('C-10 之后那条用户消息的来源带着指向它的引用 → 采纳：那张卡标已采纳，另一张压淡', () => {
    load(history())
    render()
    load(
      history(
        user('u2', 'Please update the README', SID, {
          origin: { kind: 'local', suggestion: { messageId: 'a1', toolCallId: 'call_0', index: 1 } }
        })
      )
    )
    expect(group()!.getAttribute('data-suggestion-state')).toBe('accepted')
    expect(buttons()).toHaveLength(0)
    const [first, second] = cards()
    expect(second!.hasAttribute('data-suggestion-accepted')).toBe(true)
    expect(first!.hasAttribute('data-suggestion-accepted')).toBe(false)
    expect(first!.className).toContain('opacity-50')
    // 用户气泡上有「采纳的提议」标签
    expect(container.querySelector('[data-msg-id="u2"] [data-origin-suggestion]')).not.toBeNull()
  })

  it('C-10 之后只来了一条系统通知（后台完成）→ 什么都不变，仍开着', () => {
    load(
      history(
        user('n1', '<background-task id="1" status="completed">done</background-task>', SID, {
          isSystemNotice: true
        })
      )
    )
    render()
    expect(group()!.getAttribute('data-suggestion-state')).toBe('open')
    expect(buttons()).toHaveLength(2)
    expect(buttons().every((b) => !b.disabled)).toBe(true)
  })
})
