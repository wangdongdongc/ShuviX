// @vitest-environment jsdom
/**
 * 「重新生成」从 MessageRenderer 到 AssistantBubble 的那一段（jsdom）。
 *
 * MessageRenderer 把调用方给的（稳定的）`onRegenerate` 原样交给最后一张卡，卡用自己的**代表消息 id**
 * （组末条）调用它 —— 不再每次渲染新建一个闭包，于是最后一张卡的 memo 不会次次失效。钉的是：
 *
 *   R-1 一张覆盖两条消息的卡：点一次，回调恰好被调一次、参数恰是组末条 id（不是组首、不是 key、不是空）
 *   R-2 两轮：只有最后一张卡有按钮
 *   R-3 lastAssistantId 为 null：哪儿都没有按钮
 *   R-4 流式卡（代表消息是占位）：没有按钮，也没有操作行
 *   R-5 最后一张卡但没给 onRegenerate：没有按钮
 *   R-6 同一个 item、同一个回调再渲染一次：卡不重渲染；换一个回调：重渲染
 *   R-7 lastAssistantId 从这张卡挪走：卡重渲染、按钮消失
 *   R-8 直接渲染 AssistantBubble：单条卡 / 三条卡都以组末条 id 调用
 *
 * 可见项由真的 `buildVisibleItems` 造（R-6 的「同一个 item」依赖它的复用）。渲染次数的探针：`useTtsPlayback`
 * 只有 AssistantBubble 调，桩里计数即卡的渲染次数。包入口（`getHostApi`）顶掉，i18n 走真 en 资源。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type { ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'

const probe = vi.hoisted(() => ({ renders: 0 }))

vi.mock('@shuvix/chat-ui', () => ({ getHostApi: () => null }))
vi.mock('../../../hooks/useTtsPlayback', () => {
  const tts = {
    isPlaying: false,
    isLoading: false,
    playingMessageId: null,
    speak: () => {},
    stop: () => {}
  }
  return {
    useTtsPlayback: () => {
      probe.renders++
      return tts
    }
  }
})

import { AssistantBubble } from '../AssistantBubble'
import { MessageRenderer, STREAMING_PLACEHOLDER_ID, type VisibleItem } from '../MessageRenderer'
import { buildVisibleItems } from '../conversationItems'
import { assistant, resetStore, text, toolBlock, user } from '../../../__tests__/support/views'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const SID = 's1'

let container: HTMLDivElement
let root: Root

function renderItems(
  items: VisibleItem[],
  lastAssistantId: string | null,
  onRegenerate?: (id: string) => void
): void {
  act(() =>
    root.render(
      createElement(
        'div',
        null,
        items.map((item) =>
          createElement(MessageRenderer, { key: item.key, item, lastAssistantId, onRegenerate })
        )
      )
    )
  )
}

const regenButtons = (scope: ParentNode = container): HTMLButtonElement[] => [
  ...scope.querySelectorAll<HTMLButtonElement>('button[title="Regenerate"]')
]
const rowOf = (msgId: string): HTMLElement =>
  container.querySelector<HTMLElement>(`[data-msg-id="${msgId}"]`)!
const click = (el: HTMLElement): void => {
  act(() => el.click())
}

/** 一轮带工具的回答：工具调用一条、终答一条（每次新对象，免得撞上 buildVisibleItems 的缓存） */
const toolTurn = (toolId: string, finalId: string, answer: string): ChatMessage[] => [
  assistant(toolId, [toolBlock(`${toolId}-t`, 'read', {}, { result: 'ok' })], SID),
  assistant(finalId, [text(answer)], SID)
]

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    showSupportNotice: false
  })
})

beforeEach(() => {
  resetStore(SID)
  probe.renders = 0
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('按钮在哪、点了用哪个 id（R-1…R-5）', () => {
  it('R-1 一张覆盖两条消息的卡：点一次 → 回调恰好一次、参数恰是组末条 a2', () => {
    const items = buildVisibleItems([user('u1', 'q', SID), ...toolTurn('a1', 'a2', 'fin')], false)
    expect(items[1].msgs!.map((m) => m.id)).toEqual(['a1', 'a2'])
    const spy = vi.fn()
    renderItems(items, 'a2', spy)

    const buttons = regenButtons()
    expect(buttons).toHaveLength(1)
    click(buttons[0])
    expect(spy).toHaveBeenCalledTimes(1)
    // 恰一个参数、就是组末条 id —— 不是组首 a1、不是 key turn:1.0，也不是不带参数的调用
    expect(spy.mock.calls[0]).toEqual(['a2'])
  })

  it('R-2 两轮：第一轮的卡没有按钮，第二轮的有；点它 → a2', () => {
    const items = buildVisibleItems(
      [
        user('u1', 'q1', SID),
        assistant('a1', [text('one')], SID),
        user('u2', 'q2', SID),
        assistant('a2', [text('two')], SID)
      ],
      false
    )
    const spy = vi.fn()
    renderItems(items, 'a2', spy)
    expect(regenButtons(rowOf('a1'))).toHaveLength(0)
    expect(regenButtons(rowOf('a2'))).toHaveLength(1)
    expect(regenButtons()).toHaveLength(1)
    click(regenButtons(rowOf('a2'))[0])
    expect(spy.mock.calls).toEqual([['a2']])
  })

  it('R-3 lastAssistantId 为 null：哪儿都没有按钮，回调从未被调', () => {
    const items = buildVisibleItems([user('u1', 'q', SID), ...toolTurn('b1', 'b2', 'fin')], false)
    const spy = vi.fn()
    renderItems(items, null, spy)
    expect(regenButtons()).toHaveLength(0)
    expect(spy).not.toHaveBeenCalled()
  })

  it('R-4 流式卡（代表消息是占位）：即使 lastAssistantId 是组里那条，也没有按钮、没有操作行', () => {
    const items = buildVisibleItems(
      [user('u1', 'q', SID), assistant('c1', [toolBlock('c1-t', 'read')], SID)],
      true
    )
    const card = items.at(-1)!
    expect(card.isStreamingPlaceholder).toBe(true)
    renderItems(items, 'c1', vi.fn())
    expect(regenButtons()).toHaveLength(0)
    // 操作行（复制 / 朗读 / 源码 / 重新生成那一行）整行不在：卡里一个操作按钮都没有
    const row = rowOf(STREAMING_PLACEHOLDER_ID)
    expect(row.querySelector('[data-tool-name="read"]')).not.toBeNull()
    for (const title of ['Copy', 'Read aloud', 'Show source']) {
      expect(row.querySelector(`button[title="${title}"]`), title).toBeNull()
    }
  })

  it('R-5 最后一张卡、但没给 onRegenerate：没有按钮', () => {
    const items = buildVisibleItems([user('u1', 'q', SID), ...toolTurn('d1', 'd2', 'fin')], false)
    renderItems(items, 'd2')
    expect(regenButtons()).toHaveLength(0)
  })
})

describe('稳定的回调不让最后一张卡重渲染（R-6 / R-7）', () => {
  it('R-6 同一个 item + 同一个回调再渲染：卡不重渲染；换成新的回调：重渲染一次', () => {
    const items = buildVisibleItems([user('u1', 'q', SID), ...toolTurn('e1', 'e2', 'fin')], false)
    const card = items[1]
    const fn = vi.fn()
    const renderCard = (onRegenerate: (id: string) => void): void =>
      act(() =>
        root.render(
          createElement(MessageRenderer, { item: card, lastAssistantId: 'e2', onRegenerate })
        )
      )

    renderCard(fn)
    expect(probe.renders).toBe(1)
    renderCard(fn)
    expect(probe.renders).toBe(1)
    renderCard(vi.fn())
    expect(probe.renders).toBe(2)
  })

  it('R-7 lastAssistantId 从 f2 换成 null：卡重渲染、按钮消失', () => {
    const items = buildVisibleItems([user('u1', 'q', SID), ...toolTurn('f1', 'f2', 'fin')], false)
    const fn = vi.fn()
    renderItems(items, 'f2', fn)
    expect(regenButtons()).toHaveLength(1)
    const before = probe.renders

    renderItems(items, null, fn)
    expect(probe.renders).toBe(before + 1)
    expect(regenButtons()).toHaveLength(0)
  })
})

describe('AssistantBubble 直接调用（R-8）', () => {
  it('R-8 单条卡以 a9 调用；三条卡以组末条 id 调用', () => {
    const spy = vi.fn()
    act(() =>
      root.render(
        createElement(AssistantBubble, {
          msgs: [assistant('a9', [text('nine')], SID)],
          onRegenerate: spy
        })
      )
    )
    click(regenButtons()[0])
    expect(spy.mock.calls).toEqual([['a9']])

    const msgs = [
      assistant('g1', [toolBlock('g1-t', 'read', {}, { result: 'ok' })], SID),
      assistant('g2', [toolBlock('g2-t', 'read', {}, { result: 'ok' })], SID),
      assistant('g3', [text('done')], SID)
    ]
    spy.mockClear()
    act(() => root.render(createElement(AssistantBubble, { msgs, onRegenerate: spy })))
    click(regenButtons()[0])
    expect(spy.mock.calls).toEqual([[msgs.at(-1)!.id]])
    expect(spy.mock.calls[0][0]).toBe('g3')
  })
})
