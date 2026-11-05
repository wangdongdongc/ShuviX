// @vitest-environment jsdom
/**
 * 对话里的会话链接 —— 带图标、点了切到那条会话（jsdom）。走生产的 MarkdownText，判定表在 utils/rehypeSessionLinks.test.ts。
 *
 *   SC-1  模型写的链接：一颗按钮，前面有图标，文字是它写的；DOM 里没有 href，也没有 shuvix: 地址
 *   SC-2  点一下切到那条会话，没有消息 id 不发滚动请求
 *   SC-3  带消息 id：先切会话、再请求滚动
 *   SC-4  只写了地址：显示当前标题，不显示地址
 *   SC-5  文字是另一个地址也骗不了人：显示的、打开的都是真正的目标
 *   SC-6  会话列表变了 chip 跟着变（不重新解析 markdown）
 *   SC-7  会话不在列表里：一段带图标的文字，没有按钮，悬停说明它不在了
 *   SC-8  宿主不能切会话 / 没有宿主：一段文字，悬停是标题，不抛
 *   SC-9  Chrome 侧边栏的形状（没有 openSession、列表是空的）：不说「不存在」，裸地址显示地址
 *   SC-10 不认的 shuvix:// 地址：没有 chip，属性里也没有那个地址
 *   SC-11 外链文字里的地址：不是 chip，只是外链
 *   SC-12 文字里的路径 / 图片 / 另一个地址：单独一颗按钮，点一下只开一次，没有嵌套警告
 *   SC-13 文字里的图片不显示，只有图片时显示标题
 *   SC-14 代码块里的地址：代码文字原样
 *   SC-15 指向当前会话并带消息 id：只滚动，输入框草稿不动
 *   SC-16 手写 data-session-link 伪造不出来
 *   SC-17 文字是脱敏占位符：作为文字显示，仍打开目标
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'

vi.mock('@shuvix/chat-ui', () => ({ getHostApi: () => null }))

import { ChatHostContext, type ChatHostValue } from '../../../host/chatHostContext'
import { useChatStore } from '../../../stores/chatStore'
import { MarkdownText } from '../markdownComponents'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
let openSession: ReturnType<typeof vi.fn<(sessionId: string) => void>>

type Session = ReturnType<typeof useChatStore.getState>['sessions'][number]

const session = (id: string, title: string): Session => ({ id, title }) as unknown as Session
const seed = (...sessions: Session[]): void => {
  act(() => useChatStore.setState({ sessions }))
}

function render(element: ReactElement): void {
  act(() => root.render(element))
}

function withHost(host: Partial<ChatHostValue> | null, text: string): ReactElement {
  const body = createElement(MarkdownText, { text })
  if (!host) return body
  return createElement(ChatHostContext.Provider, { value: host as ChatHostValue }, body)
}

/** 能切会话的宿主（主窗口 / 手机） */
const show = (text: string): void => render(withHost({ openSession }, text))

function click(el: Element): MouseEvent {
  const ev = new MouseEvent('click', { bubbles: true, cancelable: true })
  act(() => {
    el.dispatchEvent(ev)
  })
  return ev
}

const chips = (): HTMLElement[] => [
  ...container.querySelectorAll<HTMLElement>('[data-session-link]')
]
const chip = (): HTMLElement => {
  const all = chips()
  expect(all).toHaveLength(1)
  return all[0]
}
const hasIcon = (el: Element): boolean => el.firstElementChild?.tagName.toLowerCase() === 'svg'
/** 全 DOM 所有属性的值 */
const allAttrs = (): string[] =>
  [...container.querySelectorAll('*')].flatMap((el) => [...el.attributes].map((a) => a.value))

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    showSupportNotice: false
  })
})

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  openSession = vi.fn<(sessionId: string) => void>()
  useChatStore.setState({
    sessions: [session('a', 'Title A'), session('b', 'Title B')],
    activeSessionId: null,
    inputText: '',
    scrollToMessageRequest: null
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('SC-1..3 · 点得动', () => {
  it('SC-1 一颗按钮，前面有图标，文字是模型写的；DOM 里没有地址', () => {
    show('see [written label](shuvix://session/a) now')
    const el = chip()
    expect(el.tagName).toBe('BUTTON')
    expect(el.getAttribute('data-session-link')).toBe('a')
    expect(hasIcon(el)).toBe(true)
    expect(el.textContent).toBe('written label')
    expect(el.getAttribute('title')).toContain('Title A')
    expect(el.getAttribute('title')).toContain(en.message.originOpenHint)
    expect(container.querySelector('a')).toBeNull()
    expect(allAttrs().filter((v) => v.includes('shuvix:'))).toEqual([])
  })

  it('SC-2 点一下切到那条会话，没有消息 id 不发滚动请求', () => {
    show('[t](shuvix://session/a)')
    click(chip())
    expect(openSession.mock.calls).toEqual([['a']])
    expect(useChatStore.getState().scrollToMessageRequest).toBeNull()
  })

  it('SC-3 带消息 id：先切会话，再请求滚动', () => {
    const order: string[] = []
    openSession.mockImplementation(() => {
      order.push(`open:${useChatStore.getState().scrollToMessageRequest === null}`)
    })
    show('[t](shuvix://session/a#e1)')
    click(chip())
    expect(order).toEqual(['open:true'])
    expect(useChatStore.getState().scrollToMessageRequest).toMatchObject({
      sessionId: 'a',
      messageId: 'e1'
    })
  })
})

describe('SC-4..6 · 显示什么', () => {
  it.each([
    ['裸地址', 'see shuvix://session/a here'],
    ['行内代码', 'see `shuvix://session/a` here'],
    ['空文字', '[](shuvix://session/a)'],
    ['文字就是地址', '[shuvix://session/a](shuvix://session/a)'],
    ['尖括号', '<shuvix://session/a>']
  ])('SC-4 %s：显示当前标题，不显示地址', (_label, text) => {
    show(text)
    expect(chip().textContent).toBe('Title A')
    expect(container.textContent).not.toContain('shuvix:')
  })

  it.each([
    ['纯文字', '[shuvix://session/a](shuvix://session/b)'],
    ['行内代码', '[`shuvix://session/a`](shuvix://session/b)']
  ])('SC-5 文字是另一个地址（%s）：显示和打开的都是真正的目标', (_label, text) => {
    show(text)
    const el = chip()
    expect(el.getAttribute('data-session-link')).toBe('b')
    click(el)
    expect(openSession.mock.calls).toEqual([['b']])
    expect(el.textContent).toBe('Title B')
  })

  it('SC-6 列表变了跟着变：改名、删掉、晚到', () => {
    show('see shuvix://session/a and shuvix://session/late here')
    const byId = (id: string): HTMLElement =>
      container.querySelector<HTMLElement>(`[data-session-link="${id}"]`)!
    expect(byId('a').textContent).toBe('Title A')
    expect(byId('late').tagName).toBe('SPAN')

    seed(session('a', 'Renamed'), session('late', 'Arrived'))
    expect(byId('a').textContent).toBe('Renamed')
    expect(byId('late').tagName).toBe('BUTTON')
    expect(byId('late').textContent).toBe('Arrived')

    seed(session('late', 'Arrived'))
    expect(byId('a').tagName).toBe('SPAN')
    expect(byId('a').textContent).toBe('shuvix://session/a')
  })
})

describe('SC-7..9 · 点不动的时候不画按钮', () => {
  it('SC-7 会话不在列表里：文字 + 图标，悬停说它不在了，点了什么也不发生', () => {
    show('[kept label](shuvix://session/gone)')
    const el = chip()
    expect(el.tagName).toBe('SPAN')
    expect(container.querySelector('button')).toBeNull()
    expect(hasIcon(el)).toBe(true)
    expect(el.textContent).toBe('kept label')
    expect(el.getAttribute('title')).toBe(en.message.sessionLinkGone)
    click(el)
    expect(openSession).not.toHaveBeenCalled()
    expect(useChatStore.getState().activeSessionId).toBeNull()
  })

  it('SC-7 只写了地址且会话不在：显示地址，模型引用的内容不丢', () => {
    show('see shuvix://session/gone#e1 here')
    expect(chip().textContent).toBe('shuvix://session/gone#e1')
  })

  it.each([
    ['宿主不给 openSession', {} as Partial<ChatHostValue>],
    ['没有宿主', null]
  ])('SC-8 %s：文字，悬停是标题，不说它不在了', (_label, host) => {
    render(withHost(host, '[label](shuvix://session/a)'))
    const el = chip()
    expect(el.tagName).toBe('SPAN')
    expect(container.querySelector('button')).toBeNull()
    expect(hasIcon(el)).toBe(true)
    expect(el.getAttribute('title')).toBe('Title A')
  })

  it('SC-9 Chrome 侧边栏的形状：没有 title，裸地址显示地址', () => {
    useChatStore.setState({ sessions: [] })
    render(withHost({}, 'see shuvix://session/a here'))
    const el = chip()
    expect(el.tagName).toBe('SPAN')
    expect(el.hasAttribute('title')).toBe(false)
    expect(el.textContent).toBe('shuvix://session/a')
  })
})

describe('SC-10..11 · 不是会话链接的', () => {
  it.each([
    '[label](shuvix://settings)',
    '[label](shuvix://knowledge/x)',
    '[label](shuvix://session/a?x=1)',
    '[label](shuvix://session/a/b)'
  ])('SC-10 %s：没有 chip，属性里没有地址，文字还在', (text) => {
    show(text)
    expect(chips()).toEqual([])
    expect(allAttrs().filter((v) => v.includes('shuvix:'))).toEqual([])
    expect(container.textContent).toContain('label')
  })

  it.each([
    '[`shuvix://session/a`](https://evil.example/)',
    '[shuvix://session/a](https://evil.example/)'
  ])('SC-11 %s：只是外链，里面没有 chip', (text) => {
    show(text)
    expect(chips()).toEqual([])
    const a = container.querySelector('a')
    expect(a?.getAttribute('href')).toBe('https://evil.example/')
    expect(a?.querySelector('button')).toBeNull()
  })
})

describe('SC-12..13 · 文字里的内容', () => {
  it.each([
    ['另一个地址', '[see `shuvix://session/a`](shuvix://session/b)', 'see shuvix://session/a'],
    ['路径', '[`/a/b.txt`](shuvix://session/b)', '/a/b.txt'],
    ['图片', '[x ![i](https://h.example/p.png)](shuvix://session/b)', 'x']
  ])('SC-12 %s：一颗按钮，点一下只开一次', (_label, text, label) => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    show(text)
    expect(container.querySelector('button button')).toBeNull()
    expect(container.querySelectorAll('button')).toHaveLength(1)
    const el = chip()
    expect(el.getAttribute('data-session-link')).toBe('b')
    expect(el.textContent).toBe(label)
    click(el)
    expect(openSession.mock.calls).toEqual([['b']])
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('SC-13 文字里的图片不取；只有图片时显示标题', () => {
    show('[x ![i](https://h.example/p.png)](shuvix://session/a)')
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('[data-held-image]')).toBeNull()
    act(() => root.unmount())
    root = createRoot(container)
    show('[![i](https://h.example/p.png)](shuvix://session/a)')
    expect(chip().textContent).toBe('Title A')
    expect(container.querySelector('img')).toBeNull()
  })
})

describe('SC-14..17', () => {
  it.each([
    ['没写语言的围栏', '```\nshuvix://session/a\n```'],
    ['缩进代码块', '    shuvix://session/a'],
    ['text 围栏', '```text\nshuvix://session/a\n```']
  ])('SC-14 %s：代码文字原样', (_label, text) => {
    show(text)
    expect(chips()).toEqual([])
    expect(container.querySelector('pre code')?.textContent?.trim()).toBe('shuvix://session/a')
  })

  it('SC-15 指向当前会话并带消息 id：滚动请求落下，输入框草稿不动', () => {
    useChatStore.setState({ activeSessionId: 'a', inputText: 'half typed' })
    openSession.mockImplementation((id) => useChatStore.getState().setActiveSessionId(id))
    show('[t](shuvix://session/a#e1)')
    click(chip())
    const state = useChatStore.getState()
    expect(state.activeSessionId).toBe('a')
    expect(state.inputText).toBe('half typed')
    expect(state.scrollToMessageRequest).toMatchObject({ sessionId: 'a', messageId: 'e1' })
  })

  it.each([
    '<button data-session-link="a">x</button>',
    '<span data-session-link="a">x</span>',
    '<session-link session="a">x</session-link>'
  ])('SC-16 %s 伪造不出来', (text) => {
    show(text)
    expect(chips()).toEqual([])
  })

  it('SC-17 文字是脱敏占位符：作为文字显示，仍打开目标', () => {
    show('[{{EMAIL_abcdefgh}}](shuvix://session/a)')
    const el = chip()
    expect(el.textContent).toBe('{{EMAIL_abcdefgh}}')
    expect(el.querySelector('button, [role="button"]')).toBeNull()
    click(el)
    expect(openSession.mock.calls).toEqual([['a']])
  })
})
