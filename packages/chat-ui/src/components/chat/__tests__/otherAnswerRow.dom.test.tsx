// @vitest-environment jsdom
/**
 * 询问卡片的最后一行（OtherAnswerRow，jsdom）：不选上面的行，直接写一句话交回 AI。挂真的 PendingInputsPanel，草稿走真 store。
 *
 *   R-1  位置：审批卡在拒绝之后、是最后一个；选项题在选项与确认键之间、不在会滚的那一段里；两张卡各自的提示语
 *   R-2  只有空白：没有发送键，回车什么都不发；' x\n' → 发送键出来
 *   R-3  桌面回车：恰一次、整理过的 {kind:'other', text, secrets:[]}，投给选中的那条（步进到第二条也一样）；拦下回车
 *   R-4  Shift+回车、组字（isComposing / keyCode 229）、长按连发：不发、不拦
 *   R-5  触屏：回车不发、不拦；⌘ / Ctrl+回车与发送键发；text-base（iOS 不放大）
 *   R-6  被拒：字还在，[data-other-error] 报原文，没有未处理的 rejection；两种断线都是 connectionLost；打字清错，重发
 *   R-7  回复没回来：再按回车、再点键都只有一次，键禁用；被拒后恢复
 *   R-8  A→B→A：字还在、B 是空的；勾选不丢字、打字不丢勾选；视图里没了 → 草稿没了；另一条会话互不相干
 *   R-9  新询问到来：不抢焦点
 *   R-10 焦点在这一行按 1：打字（不答、不拦）；焦点在 body 按 1：选行；三行时 4 什么都不做；这一行没有序号
 *   R-11 选项题只有底部一个发送键（这一行没有自己的键）：又勾又写 → 一次答复带上两样（点键、回车一样）；只写字 → other；
 *        只勾、或勾 + 空白 → 没有 note 和 secrets；被拒：字和勾都还在，[data-other-error] 报原文，没有未处理的 rejection；
 *        回复没回来：再点、再回车都只有一次
 *   R-12 被悬浮输入卡片盖住时列表上移到刚好露出（留 12px）；没盖住不动；值变了或聚焦时才量，且只在焦点在这里时；
 *        不在对话列表里（笔记本抽屉）什么都不做
 *   R-13 经 useChatActions：IPC 只有 {sessionId, requestId, response}，没有 attachedPaths
 *
 * 状态只经 `applySessionView` 写；包入口 `@shuvix/chat-ui` 顶掉，i18n 走真 en 资源；不写 JSX。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type {
  AskInputRequest,
  ChoiceInputRequest,
  InputRequest,
  InputResponse
} from '@shuvix/chat-protocol/types/inputRequest'

const host = vi.hoisted(() => ({ api: {} as Record<string, unknown> }))
vi.mock('@shuvix/chat-ui', () => ({
  getHostApi: () => host.api,
  getSessionChannelApi: () => host.api
}))

import { applySessionView } from '../../../stores/chatStore'
import { useChatActions } from '../../../hooks/useChatActions'
import { V, resetStore, store } from '../../../__tests__/support/views'
import {
  collectUnhandled,
  deferred,
  handlerError,
  lost,
  notSent
} from '../../../__tests__/support/sendFailure'
import { PendingInputsPanel } from '../PendingInputsPanel'
import { ChatHostContext, type ChatHostValue } from '../../../host/chatHostContext'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const ASK1: AskInputRequest = {
  id: 'r1',
  kind: 'ask',
  toolName: 'bash',
  command: 'ls',
  createdAt: 0
}
const ASK2: AskInputRequest = {
  id: 'r2',
  kind: 'ask',
  toolName: 'bash',
  command: 'pwd',
  createdAt: 1
}
const CHOICE: ChoiceInputRequest = {
  id: 'r3',
  kind: 'choice',
  toolName: 'ask',
  question: 'Which?',
  options: [
    { label: 'A', description: '' },
    { label: 'B', description: '' },
    { label: 'C', description: '' }
  ],
  createdAt: 2
}
const OTHER = (text: string): InputResponse => ({ kind: 'other', text, secrets: [] })

let container: HTMLDivElement
let root: Root
let onResponse: Mock<(requestId: string, response: InputResponse) => void | Promise<void>>

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
    showSupportNotice: false
  })
})

beforeEach(() => {
  host.api = {}
  resetStore('s1')
  onResponse = vi.fn<(requestId: string, response: InputResponse) => void | Promise<void>>()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
})

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function setAsks(asks: InputRequest[], sessionId = 's1'): void {
  act(() => applySessionView(sessionId, V(sessionId, { run: { state: 'busy' }, asks })))
}

async function mount(asks: InputRequest[], opts: { touch?: boolean } = {}): Promise<void> {
  setAsks(asks)
  const panel = createElement(PendingInputsPanel, { onResponse })
  act(() => {
    root.render(
      opts.touch
        ? createElement(
            ChatHostContext.Provider,
            { value: { density: 'touch' } as ChatHostValue },
            panel
          )
        : panel
    )
  })
  await flush()
}

const row = (): HTMLElement => container.querySelector<HTMLElement>('[data-other-row]')!
const input = (): HTMLTextAreaElement =>
  container.querySelector<HTMLTextAreaElement>('[data-other-input]')!
const submit = (): HTMLButtonElement | null =>
  container.querySelector<HTMLButtonElement>('[data-other-submit]')
const errorText = (): string | null =>
  container.querySelector('[data-other-error]')?.textContent ?? null
const failure = (error: string): string => en.input.sendFailed.replace('{{error}}', error)
const choiceRow = (label: string): HTMLButtonElement =>
  container.querySelector<HTMLButtonElement>(`[data-choice-option="${label}"]`)!
const confirm = (): HTMLButtonElement =>
  container.querySelector<HTMLButtonElement>('[data-choice-confirm]')!
const follows = (a: Node, b: Node): boolean =>
  !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
const draftOf = (requestId: string, sessionId = 's1'): unknown =>
  store().sessionInputDrafts[sessionId]?.[requestId]

async function type(value: string): Promise<void> {
  const el = input()
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await flush()
}

/** 在这一行上按键；回 dispatchEvent 的结果（false = 被拦下） */
async function press(key: string, init: KeyboardEventInit = {}): Promise<boolean> {
  let result = true
  await act(async () => {
    result = input().dispatchEvent(
      new KeyboardEvent('keydown', {
        key,
        bubbles: true,
        cancelable: true,
        composed: true,
        ...init
      })
    )
  })
  await flush()
  return result
}
async function click(el: HTMLElement): Promise<void> {
  act(() => el.click())
  await flush()
}
async function step(which: 'prev' | 'next'): Promise<void> {
  await click(
    container.querySelector<HTMLButtonElement>(`button[aria-label="${en.pendingInputs[which]}"]`)!
  )
}

describe('位置与提示语', () => {
  it('R-1 审批卡：拒绝之后的最后一行，不在会滚的那一段里；提示语是「换个做法」', async () => {
    await mount([ASK1])
    const options = [...container.querySelectorAll('[data-ask-option]')]
    const deny = container.querySelector('[data-ask-option="deny"]')!
    expect(options.at(-1)).toBe(deny)
    expect(follows(deny, row())).toBe(true)
    expect(row().closest('.overflow-y-auto')).toBeNull()
    expect(row().nextElementSibling).toBeNull()
    expect(input().placeholder).toBe(en.pendingInputs.otherPlaceholderAsk)
    expect(input().getAttribute('aria-label')).toBe(en.pendingInputs.otherPlaceholderAsk)
  })

  it('R-1 选项题：选项与确认键之间，不在会滚的那一段里；提示语是「自己的回答」', async () => {
    await mount([CHOICE])
    expect(follows(choiceRow('C'), row())).toBe(true)
    expect(follows(row(), confirm())).toBe(true)
    expect(choiceRow('C').closest('.overflow-y-auto')).not.toBeNull()
    expect(row().closest('.overflow-y-auto')).toBeNull()
    expect(input().placeholder).toBe(en.pendingInputs.otherPlaceholderChoice)
  })
})

describe('发送', () => {
  it('R-2 只有空白：没有发送键，回车什么都不发；有字了键才出来', async () => {
    await mount([ASK1])
    expect(submit()).toBeNull()
    await type('   ')
    expect(submit()).toBeNull()
    await press('Enter')
    expect(onResponse).not.toHaveBeenCalled()

    await type(' x\n')
    expect(submit()).not.toBeNull()
    expect(submit()!.title).toBe(en.input.send)
    expect(submit()!.getAttribute('aria-label')).toBe(en.input.send)
  })

  it('R-3 桌面回车：恰一次，整理过的 other；拦下回车', async () => {
    await mount([ASK1])
    await type(' x\n')
    expect(await press('Enter')).toBe(false)
    expect(onResponse).toHaveBeenCalledTimes(1)
    expect(onResponse.mock.calls[0]![0]).toBe('r1')
    expect(onResponse.mock.calls[0]![1]).toEqual({ kind: 'other', text: 'x', secrets: [] })
  })

  it('R-3 步进到第二条：投给第二条', async () => {
    await mount([ASK1, ASK2])
    await step('next')
    await type('for the second')
    await press('Enter')
    expect(onResponse.mock.calls).toEqual([['r2', OTHER('for the second')]])
  })

  it.each<[string, KeyboardEventInit]>([
    ['Shift+回车', { shiftKey: true }],
    ['组字中（isComposing）', { isComposing: true }],
    ['确认候选（keyCode 229）', { keyCode: 229 }],
    ['长按连发', { repeat: true }]
  ])('R-4 %s：不发、不拦', async (_label, init) => {
    await mount([ASK1])
    await type('x')
    expect(await press('Enter', init)).toBe(true)
    expect(onResponse).not.toHaveBeenCalled()
  })

  it('R-5 触屏：回车是换行（不发、不拦）；字号 text-base，桌面不是', async () => {
    await mount([ASK1], { touch: true })
    await type('x')
    expect(await press('Enter')).toBe(true)
    expect(onResponse).not.toHaveBeenCalled()
    expect(input().className.split(/\s+/)).toContain('text-base')
  })

  it('R-5 桌面的字号不是 text-base', async () => {
    await mount([ASK1])
    expect(input().className.split(/\s+/)).not.toContain('text-base')
  })

  it.each<[string, KeyboardEventInit]>([
    ['⌘+回车', { metaKey: true }],
    ['Ctrl+回车', { ctrlKey: true }]
  ])('R-5 触屏 %s：拦下并发出', async (_label, init) => {
    await mount([ASK1], { touch: true })
    await type('x')
    expect(await press('Enter', init)).toBe(false)
    expect(onResponse.mock.calls).toEqual([['r1', OTHER('x')]])
  })

  it('R-5 触屏发送键：发出', async () => {
    await mount([ASK1], { touch: true })
    await type('x')
    await click(submit()!)
    expect(onResponse.mock.calls).toEqual([['r1', OTHER('x')]])
  })
})

describe('投递失败', () => {
  it('R-6 被拒：字还在，报原文，没有未处理的 rejection；打字清错；重发', async () => {
    onResponse.mockRejectedValueOnce(handlerError('nope'))
    await mount([ASK1])
    await type('my answer')
    const unhandled = await collectUnhandled(async () => {
      await press('Enter')
      await flush()
    })
    expect(unhandled).toEqual([])
    expect(input().value).toBe('my answer')
    expect(errorText()).toBe(failure('nope'))

    await type('my answer again')
    expect(errorText()).toBeNull()

    onResponse.mockResolvedValueOnce(undefined)
    await press('Enter')
    expect(onResponse).toHaveBeenCalledTimes(2)
    expect(onResponse.mock.calls[1]).toEqual(['r1', OTHER('my answer again')])
    expect(errorText()).toBeNull()
  })

  it.each<[string, () => Error]>([
    ['lost', lost],
    ['notSent', notSent]
  ])('R-6 断线（%s）：一句固定的话，不报原文', async (_label, make) => {
    onResponse.mockRejectedValueOnce(make())
    await mount([ASK1])
    await type('x')
    await press('Enter')
    expect(errorText()).toBe(failure(en.input.connectionLost))
    expect(input().value).toBe('x')
  })

  it('R-6 同步抛出的也接得住', async () => {
    onResponse.mockImplementationOnce(() => {
      throw new Error('sync boom')
    })
    await mount([ASK1])
    await type('x')
    const unhandled = await collectUnhandled(async () => {
      await press('Enter')
      await flush()
    })
    expect(unhandled).toEqual([])
    expect(errorText()).toBe(failure('sync boom'))
  })

  it('R-6 重发那一刻清掉旧错', async () => {
    onResponse.mockRejectedValueOnce(handlerError('first'))
    await mount([ASK1])
    await type('x')
    await press('Enter')
    expect(errorText()).toBe(failure('first'))

    const reply = deferred<void>()
    onResponse.mockReturnValueOnce(reply.promise)
    await press('Enter')
    expect(errorText()).toBeNull()
    await act(async () => reply.resolve())
    await flush()
  })

  it('R-7 回复没回来：再按回车、再点键都只有一次，键禁用；被拒后恢复', async () => {
    const reply = deferred<void>()
    onResponse.mockReturnValueOnce(reply.promise)
    await mount([ASK1])
    await type('x')
    await press('Enter')
    expect(onResponse).toHaveBeenCalledTimes(1)
    expect(submit()!.disabled).toBe(true)

    await press('Enter')
    await click(submit()!)
    expect(onResponse).toHaveBeenCalledTimes(1)

    await act(async () => reply.reject(handlerError('later')))
    await flush()
    expect(submit()!.disabled).toBe(false)
    onResponse.mockResolvedValueOnce(undefined)
    await click(submit()!)
    expect(onResponse).toHaveBeenCalledTimes(2)
  })
})

describe('草稿', () => {
  it('R-8 A→B→A：字还在，B 是空的', async () => {
    await mount([ASK1, ASK2])
    await type('on a')
    await step('next')
    expect(input().value).toBe('')
    await step('prev')
    expect(input().value).toBe('on a')
    expect(draftOf('r2')).toEqual({})
  })

  it('R-8 勾选不丢字，打字不丢勾选', async () => {
    await mount([CHOICE])
    await type('words')
    await click(choiceRow('A'))
    expect(draftOf('r3')).toEqual({ selected: ['A'], otherText: 'words' })
    expect(input().value).toBe('words')

    await type('more words')
    expect(draftOf('r3')).toEqual({ selected: ['A'], otherText: 'more words' })
    expect(choiceRow('A').getAttribute('aria-pressed')).toBe('true')
  })

  it('R-8 审批卡：打字不丢已有的其它字段', async () => {
    await mount([ASK1])
    act(() => store().setInputDraft('s1', 'r1', { previewPatterns: ['p'] }))
    await flush()
    await type('words')
    expect(draftOf('r1')).toEqual({ previewPatterns: ['p'], otherText: 'words' })
  })

  it('R-8 视图里没了：草稿跟着没了；同一个 id 再来是空的', async () => {
    await mount([ASK1, ASK2])
    await type('on a')
    setAsks([ASK2])
    await flush()
    expect(draftOf('r1')).toBeUndefined()
    setAsks([ASK1, ASK2])
    await flush()
    expect(input().value).toBe('')
  })

  it('R-8 另一条会话：同一个请求 id 互不相干', async () => {
    await mount([ASK1])
    await type('in s1')
    setAsks([ASK1], 's2')
    act(() => store().setActiveSessionId('s2'))
    await flush()
    expect(input().value).toBe('')
    await type('in s2')
    expect(draftOf('r1', 's1')).toEqual({ otherText: 'in s1' })
    expect(draftOf('r1', 's2')).toEqual({ otherText: 'in s2' })

    act(() => store().setActiveSessionId('s1'))
    await flush()
    expect(input().value).toBe('in s1')
  })
})

describe('焦点与数字键', () => {
  it('R-9 新询问到来：焦点留在原来的地方', async () => {
    const composer = document.createElement('textarea')
    document.body.appendChild(composer)
    composer.focus()
    await mount([])
    expect(document.activeElement).toBe(composer)

    setAsks([ASK1])
    await flush()
    expect(input()).not.toBeNull()
    expect(document.activeElement).toBe(composer)

    setAsks([ASK1, ASK2])
    await flush()
    expect(document.activeElement).toBe(composer)
  })

  it('R-9 焦点在这一行时后面又来一条：焦点与字都不动', async () => {
    await mount([ASK1])
    await type('half')
    input().focus()
    const focused = input()
    setAsks([ASK1, ASK2])
    await flush()
    expect(document.activeElement).toBe(focused)
    expect(focused.isConnected).toBe(true)
    expect(input().value).toBe('half')
  })

  it('R-10 焦点在这一行按 1：是打字，不答、不拦', async () => {
    await mount([ASK1])
    input().focus()
    expect(await press('1')).toBe(true)
    expect(onResponse).not.toHaveBeenCalled()
  })

  it('R-10 焦点在 body 按 1：选行（对照）', async () => {
    await mount([ASK1])
    expect(document.activeElement).toBe(document.body)
    let result = true
    await act(async () => {
      result = document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: '1', bubbles: true, cancelable: true, composed: true })
      )
    })
    expect(result).toBe(false)
    expect(onResponse.mock.calls).toEqual([['r1', { kind: 'ask', allowed: true }]])
  })

  it('R-10 三个选项：4 什么都不做（这一行不占序号）；这一行没有数字', async () => {
    await mount([CHOICE])
    let result = false
    await act(async () => {
      result = document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: '4', bubbles: true, cancelable: true, composed: true })
      )
    })
    await flush()
    expect(result).toBe(true)
    expect(draftOf('r3')).toEqual({ selected: [] })
    expect(onResponse).not.toHaveBeenCalled()
    expect(row().textContent).not.toMatch(/\d/)
    expect(row().querySelector('.tabular-nums')).toBeNull()
  })
})

describe('选项题只有一个发送键', () => {
  const BOTH = { kind: 'choice', selections: ['B'], note: 'only the frontend', secrets: [] }

  it('R-11 这一行没有自己的键；又勾又写，点键：一次答复带上两样', async () => {
    await mount([CHOICE])
    await click(choiceRow('B'))
    await type('  only the frontend \n')
    expect(submit()).toBeNull()
    expect(confirm().textContent).toBe('Send (1)')
    await click(confirm())
    expect(onResponse.mock.calls).toEqual([['r3', BOTH]])
  })

  it('R-11 又勾又写，回车：同一份答复', async () => {
    await mount([CHOICE])
    await click(choiceRow('B'))
    await type('only the frontend')
    await press('Enter')
    expect(onResponse.mock.calls).toEqual([['r3', BOTH]])
  })

  it('R-11 只写字：键可点，投 other', async () => {
    await mount([CHOICE])
    await type('only words')
    expect(confirm().disabled).toBe(false)
    expect(confirm().textContent).toBe('Send')
    await click(confirm())
    expect(onResponse.mock.calls).toEqual([
      ['r3', { kind: 'other', text: 'only words', secrets: [] }]
    ])
  })

  it.each([
    ['只勾', ''],
    ['勾 + 空白', '  \n ']
  ])('R-11 %s：投勾选，没有 note 和 secrets', async (_label, words) => {
    await mount([CHOICE])
    await click(choiceRow('B'))
    if (words) await type(words)
    await click(confirm())
    expect(onResponse.mock.calls).toEqual([['r3', { kind: 'choice', selections: ['B'] }]])
  })

  it('R-11 什么都没有：键禁用，回车不发', async () => {
    await mount([CHOICE])
    await type('   ')
    expect(confirm().disabled).toBe(true)
    await press('Enter')
    expect(onResponse).not.toHaveBeenCalled()
  })

  it('R-11 被拒：字和勾都还在，报原文，没有未处理的 rejection', async () => {
    onResponse.mockRejectedValueOnce(handlerError('boom'))
    await mount([CHOICE])
    await click(choiceRow('B'))
    await type('note')
    const unhandled = await collectUnhandled(async () => {
      await click(confirm())
      await flush()
    })
    expect(unhandled).toEqual([])
    expect(errorText()).toBe(failure('boom'))
    expect(input().value).toBe('note')
    expect(choiceRow('B').getAttribute('aria-pressed')).toBe('true')
  })

  it('R-11 回复没回来：再点、再回车都只有一次，键禁用', async () => {
    const pending = deferred<void>()
    onResponse.mockReturnValueOnce(pending.promise)
    await mount([CHOICE])
    await click(choiceRow('B'))
    await click(confirm())
    expect(confirm().disabled).toBe(true)
    await click(confirm())
    await press('Enter')
    expect(onResponse).toHaveBeenCalledTimes(1)
    await act(async () => pending.resolve(undefined))
    await flush()
    expect(confirm().disabled).toBe(false)
  })
})

describe('滚动', () => {
  const COMPOSER_H = 100
  const SCROLLER_BOTTOM = 800
  /** 露出来要满足的下沿：滚动区底 - 输入卡片盖住的 - 12px */
  const LIMIT = SCROLLER_BOTTOM - COMPOSER_H - 12

  // jsdom 的 getComputedStyle 不继承自定义属性：直接给量到的值
  beforeEach(() => {
    const real = window.getComputedStyle.bind(window)
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el, pseudo) => {
      const style = real(el, pseudo)
      const original = style.getPropertyValue.bind(style)
      style.getPropertyValue = (name: string) =>
        name === '--chat-input-h' ? `${COMPOSER_H}px` : original(name)
      return style
    })
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** 把面板放进对话列表（滚动容器），矩形是桩：jsdom 没有布局 */
  async function mountInList(rowBottom: number): Promise<HTMLElement> {
    setAsks([ASK1])
    act(() => {
      root.render(
        createElement(
          'div',
          { 'data-virtuoso-scroller': '' },
          createElement(PendingInputsPanel, { onResponse })
        )
      )
    })
    await flush()
    const scroller = container.querySelector<HTMLElement>('[data-virtuoso-scroller]')!
    scroller.getBoundingClientRect = () => ({ bottom: SCROLLER_BOTTOM }) as DOMRect
    row().getBoundingClientRect = () => ({ bottom: rowBottom }) as DOMRect
    scroller.scrollTop = 500
    return scroller
  }

  it('R-12 焦点在这里、值变了、被盖住：上移到刚好露出', async () => {
    const scroller = await mountInList(LIMIT + 62)
    act(() => input().focus())
    scroller.scrollTop = 500
    await type('a')
    expect(scroller.scrollTop).toBe(562)
  })

  it('R-12 聚焦时被盖住：同样上移', async () => {
    const scroller = await mountInList(LIMIT + 30)
    act(() => input().focus())
    expect(scroller.scrollTop).toBe(530)
  })

  it('R-12 下沿正好在界上、或没被盖住：不动', async () => {
    const scroller = await mountInList(LIMIT)
    act(() => input().focus())
    await type('a')
    expect(scroller.scrollTop).toBe(500)
    row().getBoundingClientRect = () => ({ bottom: LIMIT - 200 }) as DOMRect
    await type('ab')
    expect(scroller.scrollTop).toBe(500)
  })

  it('R-12 焦点不在这里：值变了也不动', async () => {
    const scroller = await mountInList(LIMIT + 62)
    expect(document.activeElement).not.toBe(input())
    await type('a')
    await type('ab')
    expect(scroller.scrollTop).toBe(500)
  })

  it('R-12 值没变（后面又来一条让它重渲染）：不动', async () => {
    const scroller = await mountInList(LIMIT + 62)
    act(() => input().focus())
    scroller.scrollTop = 500
    setAsks([ASK1, ASK2])
    await flush()
    expect(scroller.scrollTop).toBe(500)
  })

  it('R-12 不在对话列表里：聚焦和打字都不抛', async () => {
    await mount([ASK1])
    act(() => input().focus())
    await type('a')
    expect(input().value).toBe('a')
  })
})

describe('接到 IPC', () => {
  function Wired(): React.JSX.Element {
    const { handleInputResponse } = useChatActions('s1')
    return createElement(PendingInputsPanel, { onResponse: handleInputResponse })
  }

  it('R-13 经 useChatActions：恰是 {sessionId, requestId, response}，没有 attachedPaths', async () => {
    const respondToInput = vi.fn(async () => ({ success: true }))
    host.api = { agent: { respondToInput } }
    setAsks([ASK1])
    act(() => root.render(createElement(Wired)))
    await flush()
    await type(' answer\n')
    await press('Enter')
    expect(respondToInput).toHaveBeenCalledTimes(1)
    const payload = (
      respondToInput.mock.calls as unknown as Array<[Record<string, unknown>]>
    )[0]![0]
    expect(payload).toEqual({
      sessionId: 's1',
      requestId: 'r1',
      response: { kind: 'other', text: 'answer', secrets: [] }
    })
    expect(Object.keys(payload).sort()).toEqual(['requestId', 'response', 'sessionId'])
  })

  it('R-13 IPC 被拒：错误回到这一行', async () => {
    const respondToInput = vi.fn(async () => {
      throw notSent()
    })
    host.api = { agent: { respondToInput } }
    setAsks([ASK1])
    act(() => root.render(createElement(Wired)))
    await flush()
    await type('x')
    const unhandled = await collectUnhandled(async () => {
      await press('Enter')
      await flush()
    })
    expect(unhandled).toEqual([])
    expect(errorText()).toBe(failure(en.input.connectionLost))
    expect(input().value).toBe('x')
  })
})
