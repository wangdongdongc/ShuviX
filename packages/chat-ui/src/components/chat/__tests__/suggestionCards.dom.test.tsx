// @vitest-environment jsdom
/**
 * 提议卡片（`SuggestionCards`，`suggest` 工具，2026-10-25；jsdom）。卡片按调用参数画，状态（开着 / 采纳了哪条 / 关了）
 * 由 Conversation 按整条消息列表算好、经 `SuggestionContext` 往下给；点「采纳」→ `suggestion.accept`，主进程核对后把
 * 那条的话作为用户回复发进会话。
 *
 *   C-1 开着 + 宿主有 suggestion API：每条合法的提议一张卡、一颗采纳按钮；标题、detail、采纳后要发的那句话全文都在
 *   C-2 坏项（空位）不画，但下标照参数：点第三条发的是 `index: 2`
 *   C-3 点了 → `accept({sessionId, messageId, toolCallId, index})` 恰一次；等结果时所有按钮都禁用；成功之后仍禁用
 *       （等那条消息随视图到达）
 *   C-4 closed / not-found / failed（带原因）/ promise reject 各显示自己的那句错误，按钮重新可点
 *   C-5 accepted：那张卡标「已采纳」（`data-suggestion-accepted`），其余压淡，没有任何按钮
 *   C-6 closed（有 Provider）：没有按钮，卡片压淡，底下一句「对话已经往下走了」
 *   C-7 只读：宿主没有 suggestion API → 没有按钮（开着也一样）；没有 Provider → 没有按钮、也没有那句「已关闭」；
 *       Provider 里没有这一组的状态 → 当作关了
 *   C-8 参数里一条合法的都没有 → 什么都不画
 *   C-9 放在 AssistantBubble 里：落定的提议画在卡片最底下、终答之后，不进步骤组（两侧的 read 并成一组，计数不含它）；
 *       还在执行 / 出错的 suggest 调用照普通工具块画，没有卡片
 *
 * 宿主经 `setChatApi` 注入（只给 suggestion 这一面）；包入口 `@shuvix/chat-ui` 顶掉（getHostApi → null）；
 * i18n 走真 en 资源。文件是 .tsx 但不写 JSX，一律 createElement。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type { ChatApi } from '@shuvix/chat-protocol/chatApi'
import {
  suggestionGroupKey,
  type AcceptSuggestionResult,
  type SuggestionAcceptParams,
  type SuggestionGroupState
} from '@shuvix/chat-protocol/suggestions'
import type { AssistantToolBlock } from '@shuvix/chat-protocol/types/chatMessage'

vi.mock('@shuvix/chat-ui', () => ({ getHostApi: () => null }))

import { setChatApi } from '../../../api/chatApi'
import { SuggestionCards, SuggestionContext } from '../SuggestionCards'
import { AssistantBubble } from '../AssistantBubble'
import { assistant, resetStore, text, toolBlock } from '../../../__tests__/support/views'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const SID = 's1'
const MSG = 'a1'
const CALL = 'call_0'

const ITEMS = [
  {
    title: 'Add tests',
    message: 'Yes, also add tests for the parser\nand the lexer',
    detail: 'The parser has none'
  },
  { title: 'Update docs', message: 'Please update the README too' },
  { title: 'Ship it', message: 'Go ahead and open the PR' }
]

let container: HTMLDivElement
let root: Root
let accept: ReturnType<
  typeof vi.fn<(params: SuggestionAcceptParams) => Promise<AcceptSuggestionResult>>
>

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
    showSupportNotice: false
  })
})

beforeEach(() => {
  resetStore(SID)
  accept = vi.fn(async () => ({ success: true }) as AcceptSuggestionResult)
  setChatApi({ suggestion: { accept } } as unknown as ChatApi)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

// ─── 挂载 ──────────────────────────────────────────────────

function suggestBlock(
  suggestions: unknown = ITEMS,
  extra: Partial<AssistantToolBlock> = {}
): AssistantToolBlock {
  return {
    type: 'tool',
    toolCallId: CALL,
    toolName: 'suggest',
    args: { suggestions },
    result: 'Shown 3 suggestions',
    ...extra
  }
}

/** Provider 的值：这一组的状态（undefined = 没有 Provider） */
function provider(state: SuggestionGroupState | 'missing'): {
  sessionId: string
  states: ReadonlyMap<string, SuggestionGroupState>
} {
  return {
    sessionId: SID,
    states: new Map(state === 'missing' ? [] : [[suggestionGroupKey(MSG, CALL), state]])
  }
}

function render(node: ReactNode, state?: SuggestionGroupState | 'missing'): void {
  act(() => {
    root.render(
      state === undefined
        ? node
        : createElement(SuggestionContext.Provider, { value: provider(state) }, node)
    )
  })
}

function renderCards(
  state: SuggestionGroupState | 'missing' | undefined,
  suggestions: unknown = ITEMS
): void {
  render(
    createElement(SuggestionCards, { messageId: MSG, block: suggestBlock(suggestions) }),
    state
  )
}

const OPEN: SuggestionGroupState = { status: 'open' }

const cards = (): HTMLElement[] => [
  ...container.querySelectorAll<HTMLElement>('[data-suggestion-index]')
]
const buttons = (): HTMLButtonElement[] => [
  ...container.querySelectorAll<HTMLButtonElement>('[data-suggestion-accept]')
]
const messages = (): string[] =>
  [...container.querySelectorAll('[data-suggestion-message]')].map((el) => el.textContent ?? '')
const errorText = (): string | null =>
  container.querySelector('[data-suggestion-error]')?.textContent ?? null
const closedNote = (): boolean => (container.textContent ?? '').includes(en.suggestion.closed)
const dimmed = (el: HTMLElement): boolean => el.className.split(/\s+/).includes('opacity-50')

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const click = async (el: HTMLElement): Promise<void> => {
  await act(async () => {
    el.click()
    await Promise.resolve()
  })
}

// ─── C-1 / C-2 ─────────────────────────────────────────────

describe('C-1 开着：每条一张卡、一颗按钮', () => {
  it('C-1 三条合法提议 → 三张卡、三颗可点的按钮；标题 / detail / 要发的话全文都在', () => {
    renderCards(OPEN)
    const root = container.querySelector<HTMLElement>('[data-suggestions]')!
    expect(root.getAttribute('data-suggestion-state')).toBe('open')
    expect(cards().map((c) => c.getAttribute('data-suggestion-index'))).toStrictEqual([
      '0',
      '1',
      '2'
    ])
    expect(buttons()).toHaveLength(3)
    expect(buttons().every((b) => !b.disabled)).toBe(true)
    expect(buttons()[0]!.textContent).toBe(en.suggestion.accept)
    // 要发的那句话全文（含换行）原样在卡上
    expect(messages()).toStrictEqual(ITEMS.map((i) => i.message))
    expect(cards()[0]!.textContent).toContain('Add tests')
    expect(cards()[0]!.textContent).toContain('The parser has none')
    expect(cards()[1]!.textContent).toContain('Update docs')
    expect(container.textContent).toContain(en.suggestion.header)
    expect(cards().some(dimmed)).toBe(false)
    expect(closedNote()).toBe(false)
    expect(errorText()).toBeNull()
  })

  it('C-2 第二条是坏项（空位）：只画两张卡，下标 0 与 2；点第三条发 index 2', async () => {
    renderCards(OPEN, [ITEMS[0], { title: '', message: 'no title' }, ITEMS[2]])
    expect(cards().map((c) => c.getAttribute('data-suggestion-index'))).toStrictEqual(['0', '2'])
    expect(buttons()).toHaveLength(2)
    await click(buttons()[1]!)
    expect(accept.mock.calls).toStrictEqual([
      [{ sessionId: SID, messageId: MSG, toolCallId: CALL, index: 2 }]
    ])
  })
})

// ─── C-3 / C-4 ─────────────────────────────────────────────

describe('C-3 点采纳', () => {
  it('C-3 accept({sessionId, messageId, toolCallId, index}) 恰一次；等结果时全部禁用；成功之后仍禁用', async () => {
    const pending = deferred<AcceptSuggestionResult>()
    accept.mockImplementation(() => pending.promise)
    renderCards(OPEN)
    await click(buttons()[1]!)
    expect(accept.mock.calls).toStrictEqual([
      [{ sessionId: SID, messageId: MSG, toolCallId: CALL, index: 1 }]
    ])
    expect(buttons().every((b) => b.disabled)).toBe(true)
    // 禁用中再点不会再发
    await click(buttons()[0]!)
    expect(accept).toHaveBeenCalledTimes(1)

    await act(async () => {
      pending.resolve({ success: true })
      await pending.promise
    })
    expect(buttons()).toHaveLength(3)
    expect(buttons().every((b) => b.disabled)).toBe(true)
    expect(errorText()).toBeNull()
  })
})

describe('C-4 采纳没成', () => {
  it.each<[string, AcceptSuggestionResult, string]>([
    ['closed', { success: false, reason: 'closed' }, en.suggestion.errorClosed],
    ['not-found', { success: false, reason: 'not-found' }, en.suggestion.errorNotFound],
    [
      'failed',
      { success: false, reason: 'failed', error: 'The model refused' },
      'Could not send it: The model refused'
    ],
    ['failed 没给原因', { success: false, reason: 'failed' }, 'Could not send it: ']
  ])('C-4 %s → 自己的那句错误，按钮重新可点', async (_label, result, expected) => {
    accept.mockResolvedValue(result)
    renderCards(OPEN)
    await click(buttons()[0]!)
    expect(errorText()).toBe(expected)
    expect(buttons()).toHaveLength(3)
    expect(buttons().every((b) => !b.disabled)).toBe(true)
  })

  it('C-4 promise reject → errorFailed 带上异常的原文，按钮重新可点；再点一次成功就清掉错误', async () => {
    accept.mockRejectedValueOnce(new Error('IPC gone'))
    renderCards(OPEN)
    await click(buttons()[2]!)
    expect(errorText()).toBe('Could not send it: IPC gone')
    expect(buttons().every((b) => !b.disabled)).toBe(true)
    await click(buttons()[2]!)
    expect(accept).toHaveBeenCalledTimes(2)
    expect(errorText()).toBeNull()
  })
})

// ─── C-5 / C-6 / C-7 / C-8 ────────────────────────────────

describe('C-5 / C-6 采纳了 / 关了', () => {
  it('C-5 accepted index 1：那张卡标「已采纳」、不压淡；其余压淡；没有任何按钮；没有「已关闭」', () => {
    renderCards({ status: 'accepted', index: 1 })
    expect(
      container.querySelector('[data-suggestions]')!.getAttribute('data-suggestion-state')
    ).toBe('accepted')
    expect(buttons()).toHaveLength(0)
    const [first, second, third] = cards()
    expect(second!.hasAttribute('data-suggestion-accepted')).toBe(true)
    expect(second!.textContent).toContain(en.suggestion.accepted)
    expect(dimmed(second!)).toBe(false)
    for (const other of [first!, third!]) {
      expect(other.hasAttribute('data-suggestion-accepted')).toBe(false)
      expect(dimmed(other)).toBe(true)
    }
    expect(closedNote()).toBe(false)
    // 要发的话照样都在
    expect(messages()).toStrictEqual(ITEMS.map((i) => i.message))
  })

  it('C-6 closed（有 Provider）：没有按钮、都压淡、底下一句「已关闭」', () => {
    renderCards({ status: 'closed' })
    expect(buttons()).toHaveLength(0)
    expect(cards()).toHaveLength(3)
    expect(cards().every(dimmed)).toBe(true)
    expect(container.querySelector('[data-suggestion-accepted]')).toBeNull()
    expect(closedNote()).toBe(true)
  })
})

describe('C-7 只读', () => {
  it('C-7 宿主没有 suggestion API：开着也没有按钮；卡片与要发的话照画', () => {
    setChatApi({} as unknown as ChatApi)
    renderCards(OPEN)
    expect(cards()).toHaveLength(3)
    expect(buttons()).toHaveLength(0)
    expect(messages()).toStrictEqual(ITEMS.map((i) => i.message))
    expect(closedNote()).toBe(false)
  })

  it('C-7 没有 Provider：没有按钮，也没有「已关闭」那句（不知道会话往下走了没有）', () => {
    renderCards(undefined)
    expect(cards()).toHaveLength(3)
    expect(buttons()).toHaveLength(0)
    expect(closedNote()).toBe(false)
  })

  it('C-7 Provider 里没有这一组的状态 → 当作关了', () => {
    renderCards('missing')
    expect(buttons()).toHaveLength(0)
    expect(
      container.querySelector('[data-suggestions]')!.getAttribute('data-suggestion-state')
    ).toBe('closed')
    expect(closedNote()).toBe(true)
  })
})

describe('C-8 没有合法的提议', () => {
  it.each<[string, unknown]>([
    ['每条都坏', [{ title: '' }, null, { title: 'x', message: '  ' }]],
    ['空数组', []],
    ['不是数组', 'Add tests']
  ])('C-8 %s → 什么都不画', (_label, suggestions) => {
    renderCards(OPEN, suggestions)
    expect(container.querySelector('[data-suggestions]')).toBeNull()
    expect(container.innerHTML).toBe('')
  })
})

// ─── C-9 ───────────────────────────────────────────────────

describe('C-9 在助手卡片里的位置', () => {
  const read = (id: string): AssistantToolBlock =>
    toolBlock(id, 'read', { path: `/w/${id}.txt` }, { result: 'ok' }) as AssistantToolBlock

  function renderBubble(msgs: ReturnType<typeof assistant>[]): void {
    render(createElement(AssistantBubble, { msgs }), OPEN)
  }

  it('C-9 落定的 suggest：画在终答之后；夹在两个 read 之间也不进步骤组（两个 read 并成一组，计数 2）', () => {
    renderBubble([
      assistant(MSG, [read('r1'), suggestBlock(), read('r2')], SID),
      assistant('a2', [text('Final answer here')], SID)
    ])
    const suggestions = container.querySelector('[data-suggestions]')!
    expect(suggestions).not.toBeNull()
    expect(buttons()).toHaveLength(3)
    // 一个合并行，计数 2（两次 read），里面没有 suggest
    const groups = [...container.querySelectorAll('[data-step-group]')]
    expect(groups).toHaveLength(1)
    expect(container.querySelector('[data-group-count]')!.textContent).toBe('2')
    expect(container.querySelector('[data-tool-name="suggest"]')).toBeNull()
    // DOM 顺序：终答正文在前，提议卡片在后
    const answer = [...container.querySelectorAll('.markdown-body')].find((el) =>
      (el.textContent ?? '').includes('Final answer here')
    )!
    expect(answer).toBeDefined()
    expect(
      answer.compareDocumentPosition(suggestions) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    for (const group of groups) {
      expect(
        group.compareDocumentPosition(suggestions) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy()
    }
  })

  it('C-9 两张卡里各有一次提议（同一轮跨消息）→ 两组卡片，按消息顺序，都在终答之后', () => {
    const second = { ...suggestBlock([{ title: 'Later', message: 'later one' }]), toolCallId: 'c2' }
    render(
      createElement(AssistantBubble, {
        msgs: [
          assistant(MSG, [suggestBlock()], SID),
          assistant('a2', [second, read('r3')], SID),
          assistant('a3', [text('Done')], SID)
        ]
      }),
      OPEN
    )
    const groups = [...container.querySelectorAll('[data-suggestions]')]
    expect(groups).toHaveLength(2)
    expect(groups[1]!.textContent).toContain('later one')
  })

  it.each<[string, Partial<AssistantToolBlock>]>([
    ['还在执行（没有 result）', { result: undefined }],
    ['出错', { isError: true, result: 'suggestions[0].title must be a non-empty string' }]
  ])('C-9 %s 的 suggest：照普通工具块画，没有卡片', (_label, extra) => {
    renderBubble([
      assistant(MSG, [read('r1'), suggestBlock(ITEMS, extra)], SID),
      assistant('a2', [text('Final')], SID)
    ])
    expect(container.querySelector('[data-suggestions]')).toBeNull()
    expect(buttons()).toHaveLength(0)
    expect(container.querySelector('[data-tool-name="suggest"]')).not.toBeNull()
  })
})
