// @vitest-environment jsdom
/**
 * 结构化表单询问卡片（FormInputForm）：
 *   FF-1 渲染 text + secret 混合字段：secret 默认 password 打码并带「敏感信息」徽标与顶部加密提示；
 *        点击眼睛切换明文 / 打码
 *   FF-2 必填校验：必填项为空或仅空白时提交按钮禁用；填完后可提交并回传 FormResponse（单行去首尾空白）
 *   FF-3 草稿隔离：text 字段写入 draft.values，secret 字段**绝不**写入 onDraftChange
 *   FF-4 多行 secret 字段（multiline: true）渲染 textarea，保留换行不 trim
 *   FF-5 底部 OtherAnswerRow 独立发送 OtherResponse
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type { FormInputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import { FormInputForm } from '../inputs/FormInputForm'
import { emptyFormDraft, type FormDraft } from '../inputs/drafts'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const FORM_REQUEST: FormInputRequest = {
  id: 'tc-form-1',
  kind: 'form',
  toolName: 'ask',
  question: 'Enter credentials',
  detail: 'Needed for deployment',
  fields: [
    { key: 'username', label: 'Username', type: 'text', required: true },
    { key: 'password', label: 'Password', type: 'secret', required: true },
    { key: 'note', label: 'Note', type: 'text', required: false }
  ],
  createdAt: 0
}

let container: HTMLDivElement
let root: Root

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false }
  })
})

beforeEach(() => {
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

function renderForm(
  request: FormInputRequest,
  onSubmit: (res: InputResponse) => void = vi.fn(),
  onDraftSpy: (draft: FormDraft) => void = vi.fn()
): { getDraft: () => FormDraft } {
  let currentDraft: FormDraft = emptyFormDraft()
  const render = (): void => {
    act(() => {
      root.render(
        createElement(FormInputForm, {
          request,
          draft: currentDraft,
          onDraftChange: (next) => {
            currentDraft = next
            onDraftSpy(next)
            render()
          },
          onSubmit
        })
      )
    })
  }
  render()
  return { getDraft: () => currentDraft }
}

describe('FormInputForm', () => {
  it('FF-1 渲染 text + secret 字段，secret 默认打码并支持眼睛切换显隐', () => {
    renderForm(FORM_REQUEST)
    expect(container.querySelector('[data-form-secret-hint]')).not.toBeNull()
    expect(
      container.querySelector('[data-form-field="password"] [data-form-field-secret]')
    ).not.toBeNull()
    expect(
      container.querySelector('[data-form-field="username"] [data-form-field-secret]')
    ).toBeNull()

    const pwdInput = container.querySelector<HTMLInputElement>(
      '[data-form-field="password"] [data-form-field-input]'
    )!
    expect(pwdInput.type).toBe('password')

    const toggleBtn = container.querySelector<HTMLButtonElement>(
      '[data-form-field="password"] button'
    )!
    act(() => toggleBtn.click())
    expect(pwdInput.type).toBe('text')
    act(() => toggleBtn.click())
    expect(pwdInput.type).toBe('password')
  })

  it('FF-2 & FF-3 必填校验、提交 FormResponse 且敏感值绝不进入草稿', () => {
    const onSubmit = vi.fn<(res: InputResponse) => void>()
    const onDraft = vi.fn<(draft: FormDraft) => void>()
    const { getDraft } = renderForm(FORM_REQUEST, onSubmit, onDraft)

    const submitBtn = (): HTMLButtonElement =>
      container.querySelector<HTMLButtonElement>('[data-form-submit]')!
    expect(submitBtn().disabled).toBe(true)

    const userInput = container.querySelector<HTMLInputElement>(
      '[data-form-field="username"] [data-form-field-input]'
    )!
    const pwdInput = container.querySelector<HTMLInputElement>(
      '[data-form-field="password"] [data-form-field-input]'
    )!

    setInputValue(userInput, '  alice  ')
    expect(submitBtn().disabled).toBe(true)
    expect(getDraft().values.username).toBe('  alice  ')

    setInputValue(pwdInput, '  s3cr3t-pass  ')
    expect(submitBtn().disabled).toBe(false)
    // 敏感字段绝不进入 draft
    expect(getDraft().values.password).toBeUndefined()
    expect(JSON.stringify(onDraft.mock.calls)).not.toContain('s3cr3t-pass')

    act(() => submitBtn().click())
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledWith({
      kind: 'form',
      values: { username: 'alice', password: 's3cr3t-pass', note: '' }
    })
  })

  it('FF-4 多行 secret 字段渲染 textarea 并保留原始换行', () => {
    const onSubmit = vi.fn<(res: InputResponse) => void>()
    const req: FormInputRequest = {
      id: 'tc-form-pem',
      kind: 'form',
      toolName: 'ask',
      question: 'Paste private key',
      fields: [{ key: 'pem', label: 'Private Key', type: 'secret', multiline: true }],
      createdAt: 0
    }
    renderForm(req, onSubmit)
    const ta = container.querySelector<HTMLTextAreaElement>(
      '[data-form-field="pem"] textarea[data-form-field-input]'
    )!
    expect(ta).not.toBeNull()
    const pem = '-----BEGIN KEY-----\nabc\n-----END KEY-----'
    setInputValue(ta, pem)
    act(() => container.querySelector<HTMLButtonElement>('[data-form-submit]')!.click())
    expect(onSubmit).toHaveBeenCalledWith({ kind: 'form', values: { pem } })
  })

  it('FF-5 底部 OtherAnswerRow 可独立发送 OtherResponse', () => {
    const onSubmit = vi.fn<(res: InputResponse) => void>()
    renderForm(FORM_REQUEST, onSubmit)
    const otherInput = container.querySelector<HTMLTextAreaElement>('[data-other-input]')!
    setInputValue(otherInput, 'Use ~/.netrc instead')
    act(() => container.querySelector<HTMLButtonElement>('[data-other-submit]')!.click())
    expect(onSubmit).toHaveBeenCalledWith({
      kind: 'other',
      text: 'Use ~/.netrc instead',
      secrets: []
    })
  })
})
