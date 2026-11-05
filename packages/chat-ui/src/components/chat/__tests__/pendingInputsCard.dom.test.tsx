// @vitest-environment jsdom
/**
 * 对话流末尾那张等人回答的卡片（PendingInputsCard）：外框与语义色，和数字键的把关 —— 卡片要整张露在滚动区里、
 * 且没被悬浮输入卡片压着才算数，否则一次按键就批准了一张没看见的卡。
 *
 *   PC-1 isCardOnScreen 的边界（1px 容差）；
 *   PC-2/3 没有询问 → 不画；ask / choice 的外框；
 *   PC-4..11 数字键的把关（位置是桩出来的矩形，每次按键那一刻才量）；
 *   PC-12 面板的两种摆法。
 *
 * jsdom 没有布局：矩形桩在 getBoundingClientRect 上；`--chat-input-h` 真写在祖先上，但 jsdom 的 getComputedStyle
 * 不继承自定义属性，这里替它走一遍祖先链。状态经 applySessionView 写，面板在 effect 里建草稿，挂上之后等一拍。
 * 不写 JSX，一律 createElement。
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

vi.mock('@shuvix/chat-ui', () => ({ getHostApi: () => ({}) }))

import { applySessionView } from '../../../stores/chatStore'
import { V, resetStore, store } from '../../../__tests__/support/views'
import { ChatHostContext, type ChatHostValue } from '../../../host/chatHostContext'
import { PendingInputsCard, isCardOnScreen } from '../PendingInputsCard'
import { PendingInputsPanel } from '../PendingInputsPanel'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const ASK: AskInputRequest = {
  id: 'r1',
  kind: 'ask',
  toolName: 'bash',
  command: 'ls',
  createdAt: 0
}
const CHOICE: ChoiceInputRequest = {
  id: 'r3',
  kind: 'choice',
  toolName: 'ask',
  question: 'Which?',
  options: [
    { label: 'A', description: '' },
    { label: 'B', description: '' }
  ],
  createdAt: 2
}

/** 滚动区 [0, 600]；输入卡片压着底下 100px，所以可见区的下沿是 500 */
const VIEW = { top: 0, bottom: 600 }
const INPUT_H = '100px'

let container: HTMLDivElement
let root: Root
let onResponse: Mock<(requestId: string, response: InputResponse) => void>
/** 卡片此刻的矩形（用例随时改，守卫按键那一刻才量） */
let cardRect: { top: number; bottom: number }

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
    showSupportNotice: false
  })
})

beforeEach(() => {
  resetStore('s1')
  onResponse = vi.fn<(requestId: string, response: InputResponse) => void>()
  cardRect = { top: 100, bottom: 400 }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  // jsdom 不继承自定义属性：替它走祖先链（真浏览器里这是继承来的）
  const real = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation((el, pseudo) => {
    const style = real(el, pseudo)
    const original = style.getPropertyValue.bind(style)
    style.getPropertyValue = (name: string) => {
      if (!name.startsWith('--')) return original(name)
      for (let at: Element | null = el; at; at = at.parentElement) {
        const value = (at as HTMLElement).style?.getPropertyValue(name)
        if (value) return value
      }
      return ''
    }
    return style
  })
})

afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

async function mount(
  asks: InputRequest[],
  opts: { scroller?: boolean; inputH?: string | null; density?: 'touch' } = {}
): Promise<void> {
  act(() => applySessionView('s1', V('s1', { run: { state: 'busy' }, asks })))
  const card = createElement(PendingInputsCard, { onResponse })
  const hosted = opts.density
    ? createElement(
        ChatHostContext.Provider,
        { value: { density: opts.density } as ChatHostValue },
        card
      )
    : card
  const inScroller =
    opts.scroller === false
      ? hosted
      : createElement(
          'div',
          {
            'data-virtuoso-scroller': '',
            ref: (el: HTMLElement | null) => {
              if (el) el.getBoundingClientRect = () => VIEW as DOMRect
            }
          },
          hosted
        )
  const inputH = opts.inputH === undefined ? INPUT_H : opts.inputH
  act(() => {
    root.render(
      createElement(
        'div',
        { style: inputH === null ? undefined : { '--chat-input-h': inputH } },
        inScroller
      )
    )
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  const el = container.querySelector<HTMLElement>('[data-pending-card]')
  if (el) el.getBoundingClientRect = () => cardRect as DOMRect
}

/** 按一下键；回 dispatchEvent 的结果（false = 被拦下） */
function press(key: string, target: EventTarget = document.body): boolean {
  let result = true
  act(() => {
    result = target.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, composed: true })
    )
  })
  return result
}

describe('isCardOnScreen', () => {
  const view = { top: 100, bottom: 700 }
  it.each([
    ['完全在里面', { top: 200, bottom: 400 }, 100, true],
    ['上沿越过 1px（容差之内）', { top: 99, bottom: 400 }, 100, true],
    ['上沿越过 2px', { top: 98, bottom: 400 }, 100, false],
    ['下沿压到输入卡片 1px（容差之内）', { top: 200, bottom: 601 }, 100, true],
    ['下沿压到输入卡片 2px', { top: 200, bottom: 602 }, 100, false],
    ['没有输入卡片（covered 0）：下沿贴着可见区', { top: 200, bottom: 700 }, 0, true],
    ['没有输入卡片：下沿越过 2px', { top: 200, bottom: 702 }, 0, false],
    ['卡片比可见区还高', { top: 90, bottom: 710 }, 0, false]
  ])('PC-1 %s', (_label, card, covered, expected) => {
    expect(isCardOnScreen(card, view, covered)).toBe(expected)
  })
})

describe('外框', () => {
  it('PC-2 没有询问：什么都不画', async () => {
    await mount([])
    expect(container.querySelector('[data-pending-card]')).toBeNull()
    expect(container.querySelector('[data-pending-inputs]')).toBeNull()
  })

  it('PC-3 审批用 warning 的外框，选择题用 accent 的', async () => {
    await mount([ASK])
    const ask = container.querySelector('[data-pending-card]')!
    expect(ask.getAttribute('data-pending-card')).toBe('ask')
    expect(ask.classList.contains('border-warning/45')).toBe(true)
    expect(ask.classList.contains('ring-warning/10')).toBe(true)

    await mount([CHOICE])
    const choice = container.querySelector('[data-pending-card]')!
    expect(choice.getAttribute('data-pending-card')).toBe('choice')
    expect(choice.classList.contains('border-accent/45')).toBe(true)
    expect(choice.classList.contains('ring-accent/10')).toBe(true)
  })
})

describe('数字键的把关', () => {
  it('PC-4 整张露着：1 答这张卡，事件被拦下', async () => {
    await mount([ASK])
    expect(press('1')).toBe(false)
    expect(onResponse).toHaveBeenCalledTimes(1)
    expect(onResponse.mock.calls[0]![0]).toBe('r1')
    expect(onResponse.mock.calls[0]![1]).toMatchObject({ kind: 'ask', allowed: true })
  })

  it('PC-5 卡片在视口上方：1 不答、不拦', async () => {
    await mount([ASK])
    cardRect = { top: -200, bottom: 100 }
    expect(press('1')).toBe(true)
    expect(onResponse).not.toHaveBeenCalled()
  })

  it('PC-6 下沿压进输入卡片 2px：不答；1px 之内算露着', async () => {
    await mount([ASK])
    cardRect = { top: 200, bottom: 502 }
    expect(press('1')).toBe(true)
    expect(onResponse).not.toHaveBeenCalled()

    cardRect = { top: 200, bottom: 501 }
    expect(press('1')).toBe(false)
    expect(onResponse).toHaveBeenCalledTimes(1)
  })

  it('PC-7 祖先上没有 --chat-input-h：按 0 算（下沿到滚动区底才算压着）', async () => {
    await mount([ASK], { inputH: null })
    cardRect = { top: 200, bottom: 590 }
    expect(press('1')).toBe(false)
    expect(onResponse).toHaveBeenCalledTimes(1)
  })

  it('PC-8 外面没有 [data-virtuoso-scroller]：宁可不算（失败闭合）', async () => {
    await mount([ASK], { scroller: false })
    expect(press('1')).toBe(true)
    expect(onResponse).not.toHaveBeenCalled()
  })

  it('PC-9 按键那一刻才量：不重渲染，移出去就不认，移回来又认', async () => {
    await mount([ASK])
    cardRect = { top: -300, bottom: -10 }
    expect(press('1')).toBe(true)
    expect(onResponse).not.toHaveBeenCalled()

    cardRect = { top: 100, bottom: 400 }
    expect(press('1')).toBe(false)
    expect(onResponse).toHaveBeenCalledTimes(1)
  })

  it('PC-10 选择题卡在屏幕外：数字键不改草稿；回到屏幕上才勾', async () => {
    await mount([CHOICE])
    cardRect = { top: -300, bottom: -10 }
    expect(press('1')).toBe(true)
    expect(store().sessionInputDrafts.s1?.r3).toMatchObject({ selected: [] })

    cardRect = { top: 100, bottom: 400 }
    expect(press('1')).toBe(false)
    expect(store().sessionInputDrafts.s1?.r3).toMatchObject({ selected: ['A'] })
    // 选择题要确认才交
    expect(onResponse).not.toHaveBeenCalled()
  })

  it('PC-11 卡片露着、焦点在输入框里：1 是打字；触屏档也不认', async () => {
    await mount([ASK])
    const textarea = document.createElement('textarea')
    document.body.appendChild(textarea)
    textarea.focus()
    expect(press('1', textarea)).toBe(true)
    expect(onResponse).not.toHaveBeenCalled()
    textarea.blur()
    textarea.remove()

    await mount([ASK], { density: 'touch' })
    expect(press('1')).toBe(true)
    expect(onResponse).not.toHaveBeenCalled()
  })
})

describe('面板的两种摆法', () => {
  it('PC-12 conversation：没有输入卡片顶格的圆角与分隔线；缺省（composer）有', async () => {
    await mount([ASK])
    const inCard = container.querySelector('[data-pending-inputs]')!
    expect(inCard.classList.contains('rounded-t-2xl')).toBe(false)
    expect(inCard.classList.contains('border-b')).toBe(false)

    act(() => {
      root.render(createElement(PendingInputsPanel, { onResponse }))
    })
    const inComposer = container.querySelector('[data-pending-inputs]')!
    expect(inComposer.classList.contains('rounded-t-2xl')).toBe(true)
    expect(inComposer.classList.contains('border-b')).toBe(true)
  })
})

describe('卡片随视图走', () => {
  it('PC-13 视图清空之后卡片就没了', async () => {
    await mount([ASK])
    act(() => applySessionView('s1', V('s1', { run: { state: 'idle' }, asks: [] })))
    expect(container.querySelector('[data-pending-card]')).toBeNull()
  })
})
