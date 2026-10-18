// @vitest-environment jsdom
/**
 * 整条链上的渲染成本（jsdom）：真的 Conversation → buildVisibleItems → MessageRenderer → AssistantBubble。
 *
 * 单个部件各有自己的用例（assistantBubbleLive / messageRendererRegenerate / conversationItems）；这里看它们
 * 接起来之后，运行中的会话里**上一轮那张已落定的卡**是不是真的一次都不重画：
 *
 *   INT-1 历史 [u1, a0, u2] + 运行中的实时卡：推流式正文与 MCP 连接 → 上一轮的卡 0 次额外渲染，流式卡每次都跟着走
 *   INT-2 本轮第一条助手消息 a1（带工具）落盘、并进流式卡（lastAssistantId 随之从 null 变成 a1，整张列表的
 *         渲染回调换了一个）→ 上一轮的卡仍 0 次额外渲染、它的正文没重新解析、卡的 DOM 节点还是同一个
 *
 * 桩：Virtuoso 换成直接把每一项画出来的壳（每一项外面套一层卡标签的 Context，P1 按卡计数）；输入区、待处理
 * 输入、Footer、确认框顶成空壳；`useChatActions` 交回模块级的稳定回调（与真的 useCallback 一样不随渲染换）；
 * 包入口给 `useChatHost` / `getHostApi`。探针与 assistantBubbleLive 同款：`useTtsPlayback` 计渲染次数、
 * `react-markdown` 透传包装记解析次数。数据走真的 chatStore（`applySessionView`）。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type Context, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type { AssistantBlock, ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'

interface VirtuosoStubProps {
  data: Array<{ key: string }>
  itemContent: (index: number, item: unknown) => ReactNode
  computeItemKey: (index: number, item: unknown) => string
}

const probe = vi.hoisted(() => ({
  /** 卡标签（可见项 key）→ AssistantBubble 渲染次数 */
  renders: new Map<string, number>(),
  /** react-markdown 每渲染一次记下它的源文本 */
  parses: [] as string[],
  card: null as Context<string> | null,
  /** 模块级的稳定回调（真的 useChatActions 里是 useCallback） */
  noop: () => {}
}))

vi.mock('@shuvix/chat-ui', () => ({
  useChatHost: () => ({ appearance: { focusMode: false } }),
  getHostApi: () => null
}))
vi.mock('../../../hooks/useTtsPlayback', async () => {
  const React = await import('react')
  const card = React.createContext('')
  probe.card = card
  const tts = {
    isPlaying: false,
    isLoading: false,
    playingMessageId: null,
    speak: () => {},
    stop: () => {}
  }
  return {
    useTtsPlayback: () => {
      const label = React.useContext(card)
      probe.renders.set(label, (probe.renders.get(label) ?? 0) + 1)
      return tts
    }
  }
})
vi.mock('react-markdown', async (importOriginal) => {
  const real = await importOriginal<typeof import('react-markdown')>()
  const React = await import('react')
  const Real = real.default
  return {
    ...real,
    default: (props: Parameters<typeof Real>[0]) => {
      probe.parses.push(typeof props.children === 'string' ? props.children : '')
      return React.createElement(Real, props)
    }
  }
})
vi.mock('react-virtuoso', async () => {
  const React = await import('react')
  const Virtuoso = React.forwardRef<unknown, VirtuosoStubProps>(function VirtuosoStub(props, ref) {
    React.useImperativeHandle(ref, () => ({ scrollToIndex: () => {} }), [])
    return React.createElement(
      'div',
      { 'data-virtuoso-stub': '' },
      props.data.map((item, i) => {
        const key = props.computeItemKey(i, item)
        return React.createElement(
          probe.card!.Provider,
          { key, value: key },
          props.itemContent(i, item)
        )
      })
    )
  })
  return { Virtuoso }
})
vi.mock('../InputArea', () => ({ InputArea: () => null }))
vi.mock('../PendingInputsPanel', () => ({ PendingInputsPanel: () => null }))
vi.mock('../StreamingFooter', () => ({ StreamingFooter: () => null }))
vi.mock('../../common/ConfirmDialog', () => ({ ConfirmDialog: () => null }))
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

import { applySessionView, useChatStore } from '../../../stores/chatStore'
import { Conversation } from '../Conversation'
import {
  V,
  assistant,
  liveCard,
  resetStore,
  text,
  toolBlock,
  user
} from '../../../__tests__/support/views'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const SID = 's1'
/** 上一轮那张已落定的卡（第 1 轮第 0 张）与本轮的流式卡（第 2 轮第 0 张） */
const SETTLED = 'turn:1.0'
const LIVE = 'turn:2.0'
const A0_TEXT = 'zero answer with **bold**'

let container: HTMLDivElement
let root: Root

const u1 = user('u1', 'first', SID)
const a0 = assistant('a0', [text(A0_TEXT)], SID)
const u2 = user('u2', 'second', SID)

function push(messages: ChatMessage[], liveBlocks: AssistantBlock[], taskId = 1): void {
  act(() =>
    applySessionView(
      SID,
      V(SID, { messages, live: liveCard(taskId, liveBlocks), run: { state: 'busy' } })
    )
  )
}

const renders = (label: string): number => probe.renders.get(label) ?? 0
const parsesOf = (md: string): number => probe.parses.filter((p) => p === md).length
const row = (msgId: string): HTMLElement | null =>
  container.querySelector<HTMLElement>(`[data-msg-id="${msgId}"]`)

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
  probe.renders.clear()
  probe.parses.length = 0
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  push([u1, a0, u2], [text('Hel')])
  act(() => root.render(createElement(Conversation, { sessionId: SID })))
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

describe('运行中的会话里，上一轮的卡不跟着重画（INT-1 / INT-2）', () => {
  it('INT-1 推流式正文与 MCP 连接：上一轮的卡 0 次额外渲染，流式卡每次都跟着走', () => {
    expect(row('a0')!.textContent).toContain('zero answer with bold')
    expect(row('streaming-live')!.textContent).toContain('Hel')
    const settledBase = renders(SETTLED)
    expect(settledBase).toBe(1)

    const updates: Array<[string, () => void]> = [
      ['正文 Hello', () => push([u1, a0, u2], [text('Hello')])],
      ['正文 Hello world', () => push([u1, a0, u2], [text('Hello world')])],
      [
        'MCP github',
        () => act(() => useChatStore.getState().setMcpConnecting(SID, 'github', true))
      ],
      ['MCP 清空', () => act(() => useChatStore.getState().clearMcpConnecting(SID))]
    ]
    for (const [what, update] of updates) {
      const before = renders(LIVE)
      update()
      expect(renders(LIVE), `${what}：流式卡`).toBeGreaterThan(before)
      expect(renders(SETTLED), `${what}：上一轮的卡`).toBe(settledBase)
    }
    expect(row('streaming-live')!.textContent).toContain('Hello world')
    expect(parsesOf(A0_TEXT)).toBe(1)
  })

  it('INT-2 本轮第一条助手消息（带工具）落盘、并进流式卡：上一轮的卡仍不重画、正文不重新解析、DOM 节点不换', () => {
    const settledBase = renders(SETTLED)
    const a0Row = row('a0')
    const a0Body = a0Row!.querySelector('.markdown-body')
    expect(parsesOf(A0_TEXT)).toBe(1)

    const a1 = assistant('a1', [text('let me look'), toolBlock('t1', 'read', { path: 'x' })], SID)
    push([u1, a0, u2, a1], [text('next')], 2)

    // 流式卡这一组现在是 [a1, 占位]：中间文本在过程区，流式正文在下面
    const liveRow = row('streaming-live')!
    expect(liveRow.textContent).toContain('let me look')
    expect(liveRow.textContent).toContain('next')
    expect(liveRow.querySelector('[data-tool-name="read"]')).not.toBeNull()

    expect(renders(SETTLED)).toBe(settledBase)
    expect(parsesOf(A0_TEXT)).toBe(1)
    expect(row('a0')).toBe(a0Row)
    expect(row('a0')!.querySelector('.markdown-body')).toBe(a0Body)
  })
})
