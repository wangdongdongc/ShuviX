// @vitest-environment jsdom
/**
 * 收件箱中的结构化表单询问（InboxAskRow / InboxAskCard，jsdom）：
 *   AF-22 kind: 'form' 在收件箱行与展开卡片中的渲染与就地提交：
 *         - InboxAskRow 渲染 data-inbox-ask="form"、question 摘要；含 secret 字段显示 KeyRound 锁图标，
 *           纯 text 字段显示 MessageCircleQuestion 图标
 *         - InboxAskCard 渲染 data-inbox-card="form" 并挂载真实 FormInputForm，可就地填写并提交 FormResponse
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type { FormInputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import { useChatStore, type Session } from '@shuvix/chat-ui'
import type { InboxAsk } from './inboxItems'
import { InboxAskCard, InboxAskRow } from './InboxAsks'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const SESSION: Session = {
  id: 'sess-form',
  title: 'Deploy service',
  projectId: null,
  parentId: null,
  settings: {},
  createdAt: 1,
  updatedAt: 1,
  lastActiveAt: 1
}

const SECRET_FORM: FormInputRequest = {
  id: 'form-inbox-1',
  kind: 'form',
  toolName: 'ask',
  question: 'Enter deploy credentials',
  fields: [
    { key: 'username', label: 'Username', type: 'text', required: true },
    { key: 'token', label: 'API Token', type: 'secret', required: true }
  ],
  createdAt: 1
}

const TEXT_FORM: FormInputRequest = {
  id: 'form-inbox-2',
  kind: 'form',
  toolName: 'ask',
  question: 'Enter target host',
  fields: [{ key: 'host', label: 'Host', type: 'text', required: true }],
  createdAt: 2
}

let container: HTMLDivElement
let root: Root

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
    showSupportNotice: false
  })
})

beforeEach(() => {
  useChatStore.setState({ sessionInputDrafts: {} })
  Element.prototype.scrollIntoView = vi.fn()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function setInputValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  act(() => {
    setter?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('InboxAskRow / InboxAskCard · kind: form（AF-22）', () => {
  it('AF-22 InboxAskRow 渲染 data-inbox-ask="form"、question 摘要；含敏感项显示锁图标，纯 text 显示问号图标', () => {
    const secretAsk: InboxAsk = { session: SESSION, request: SECRET_FORM }
    const onOpen = vi.fn()
    act(() => {
      root.render(
        createElement(InboxAskRow, {
          ask: secretAsk,
          waited: '1m',
          onOpen
        })
      )
    })

    const row = container.querySelector('[data-inbox-ask="form"]')
    expect(row).not.toBeNull()
    expect(row!.textContent).toContain('Enter deploy credentials')
    expect(row!.querySelector('svg.lucide-key-round')).not.toBeNull()

    // 纯 text 表单不显示锁图标，显示问号图标
    const textAsk: InboxAsk = { session: SESSION, request: TEXT_FORM }
    act(() => {
      root.render(
        createElement(InboxAskRow, {
          ask: textAsk,
          waited: '1m',
          onOpen
        })
      )
    })
    const textRow = container.querySelector('[data-inbox-ask="form"]')!
    expect(textRow.textContent).toContain('Enter target host')
    expect(textRow.querySelector('svg.lucide-key-round')).toBeNull()
    expect(textRow.querySelector('svg.lucide-shield-alert')).toBeNull()
    expect(textRow.querySelector('svg')).not.toBeNull()
  })

  it('AF-22 InboxAskCard 展开 data-inbox-card="form" 可就地填写并提交 FormResponse', async () => {
    const ask: InboxAsk = { session: SESSION, request: SECRET_FORM }
    const onResponse = vi.fn<(response: InputResponse) => Promise<void>>(async () => {})
    act(() => {
      root.render(
        createElement(InboxAskCard, {
          ask,
          waited: '2m',
          context: null,
          onCollapse: vi.fn(),
          onResponse
        })
      )
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    const card = container.querySelector('[data-inbox-card="form"]')
    expect(card).not.toBeNull()
    expect(card!.querySelector('svg.lucide-key-round')).not.toBeNull()

    const userInput = card!.querySelector<HTMLInputElement>(
      '[data-form-field="username"] [data-form-field-input]'
    )!
    const tokenInput = card!.querySelector<HTMLInputElement>(
      '[data-form-field="token"] [data-form-field-input]'
    )!
    setInputValue(userInput, 'alice')
    setInputValue(tokenInput, 'tok-secret-123')

    const submitBtn = card!.querySelector<HTMLButtonElement>('[data-form-submit]')!
    expect(submitBtn.disabled).toBe(false)
    act(() => submitBtn.click())
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(onResponse).toHaveBeenCalledTimes(1)
    expect(onResponse).toHaveBeenCalledWith({
      kind: 'form',
      values: { username: 'alice', token: 'tok-secret-123' }
    })
  })
})
