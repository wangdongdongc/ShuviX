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
import { InputRequestForm } from '../InputRequestForm'
import { FormInputForm } from '../inputs/FormInputForm'
import { emptyFormDraft, type FormDraft } from '../inputs/drafts'
import { useChatStore } from '../../../stores/chatStore'
import { resetStore } from '../../../__tests__/support/views'

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
  onSubmit: (res: InputResponse) => void | Promise<void> = vi.fn(),
  onDraftSpy: (draft: FormDraft) => void = vi.fn()
): { getDraft: () => FormDraft } {
  let currentDraft: FormDraft = emptyFormDraft()
  const render = (): void => {
    act(() => {
      root.render(
        createElement(FormInputForm, {
          key: request.id,
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
    // AF-15: 显隐按钮 title / aria-label 为真实译文，不含裸 key
    expect(toggleBtn.title).toBe(en.input.secretShow)
    expect(toggleBtn.getAttribute('aria-label')).toBe(en.input.secretShow)
    expect(toggleBtn.title).not.toContain('toolCall.askField')

    act(() => toggleBtn.click())
    expect(pwdInput.type).toBe('text')
    expect(toggleBtn.title).toBe(en.input.secretHide)
    expect(toggleBtn.getAttribute('aria-label')).toBe(en.input.secretHide)

    act(() => toggleBtn.click())
    expect(pwdInput.type).toBe('password')
    expect(toggleBtn.title).toBe(en.input.secretShow)
  })

  it('FF-2 & FF-3 必填校验、提交 FormResponse（text 裁剪、secret 保留首尾空格）且敏感值绝不进入草稿', () => {
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
      values: { username: 'alice', password: '  s3cr3t-pass  ', note: '' }
    })
  })

  it('FF-4 / AF-15 / AF-16 多行 secret 字段渲染 textarea、切换 WebkitTextSecurity、纯空白禁用提交、保留原值与换行', () => {
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

    // AF-15: 多行 secret 显隐切换 WebkitTextSecurity
    const securityOf = (): string =>
      (ta.style as CSSStyleDeclaration & { WebkitTextSecurity?: string }).WebkitTextSecurity ?? ''
    expect(securityOf()).toBe('disc')
    const toggleBtn = container.querySelector<HTMLButtonElement>('[data-form-field="pem"] button')!
    expect(toggleBtn.title).toBe(en.input.secretShow)
    act(() => toggleBtn.click())
    expect(securityOf()).toBe('')
    expect(toggleBtn.title).toBe(en.input.secretHide)
    act(() => toggleBtn.click())
    expect(securityOf()).toBe('disc')

    // AF-16: 多行必填纯空白禁用提交
    const submitBtn = container.querySelector<HTMLButtonElement>('[data-form-submit]')!
    setInputValue(ta, '   \n\t  ')
    expect(submitBtn.disabled).toBe(true)

    const pem = '  -----BEGIN KEY-----\nabc\n-----END KEY-----  '
    setInputValue(ta, pem)
    expect(submitBtn.disabled).toBe(false)
    act(() => submitBtn.click())
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

  it('AF-16 键盘流：单行 Enter 跳下一项 / 末项提交；多行 Enter 不提交而 Ctrl/Cmd+Enter 提交；IME 组合态不提交', async () => {
    const flushMicrotasks = async (): Promise<void> => {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0))
      })
    }
    const onSubmit = vi.fn<(res: InputResponse) => void>()
    const req: FormInputRequest = {
      id: 'tc-form-kbd',
      kind: 'form',
      toolName: 'ask',
      question: 'Keyboard flow',
      fields: [
        { key: 'user', label: 'User', type: 'text', required: true },
        { key: 'pass', label: 'Pass', type: 'secret', required: true }
      ],
      createdAt: 0
    }
    renderForm(req, onSubmit)
    const userInput = container.querySelector<HTMLInputElement>(
      '[data-form-field="user"] [data-form-field-input]'
    )!
    const passInput = container.querySelector<HTMLInputElement>(
      '[data-form-field="pass"] [data-form-field-input]'
    )!

    setInputValue(userInput, 'alice')
    setInputValue(passInput, 's3cr3t')

    // IME 组合态（isComposing / keyCode 229）不跳转也不提交
    userInput.focus()
    const imeEvent = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    Object.defineProperty(imeEvent, 'isComposing', { value: true })
    act(() => {
      userInput.dispatchEvent(imeEvent)
    })
    expect(document.activeElement).toBe(userInput)
    expect(onSubmit).not.toHaveBeenCalled()

    // 单行 Enter 跳到下一项
    act(() => {
      userInput.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      )
    })
    expect(document.activeElement).toBe(passInput)
    expect(onSubmit).not.toHaveBeenCalled()

    // 末项 IME keyCode=229 不提交
    const ime229 = new KeyboardEvent('keydown', {
      key: 'Enter',
      keyCode: 229,
      bubbles: true,
      cancelable: true
    })
    act(() => {
      passInput.dispatchEvent(ime229)
    })
    expect(onSubmit).not.toHaveBeenCalled()

    // 末项 Enter 提交
    act(() => {
      passInput.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      )
    })
    await flushMicrotasks()
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledWith({
      kind: 'form',
      values: { user: 'alice', pass: 's3cr3t' }
    })

    // 多行字段：普通 Enter 不提交，Ctrl+Enter / Cmd+Enter 提交
    const multiSubmit = vi.fn<(res: InputResponse) => void>()
    renderForm(
      {
        id: 'tc-form-multi',
        kind: 'form',
        toolName: 'ask',
        question: 'Multiline',
        fields: [{ key: 'notes', label: 'Notes', type: 'text', multiline: true, required: true }],
        createdAt: 0
      },
      multiSubmit
    )
    const ta = container.querySelector<HTMLTextAreaElement>(
      '[data-form-field="notes"] textarea[data-form-field-input]'
    )!
    setInputValue(ta, 'line1\nline2')
    act(() => {
      ta.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      )
    })
    expect(multiSubmit).not.toHaveBeenCalled()

    act(() => {
      ta.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          ctrlKey: true,
          bubbles: true,
          cancelable: true
        })
      )
    })
    await flushMicrotasks()
    expect(multiSubmit).toHaveBeenCalledTimes(1)

    act(() => {
      ta.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          metaKey: true,
          bubbles: true,
          cancelable: true
        })
      )
    })
    await flushMicrotasks()
    expect(multiSubmit).toHaveBeenCalledTimes(2)
  })

  it('AF-17 经 InputRequestForm + useChatStore 卸载重挂：text 从草稿恢复，secret 为空且不进 sessionInputDrafts', async () => {
    resetStore('s-form')
    const mount = (): void => {
      act(() => {
        root.render(
          createElement(InputRequestForm, {
            sessionId: 's-form',
            request: FORM_REQUEST,
            onResponse: vi.fn()
          })
        )
      })
    }
    mount()
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    const userInput = container.querySelector<HTMLInputElement>(
      '[data-form-field="username"] [data-form-field-input]'
    )!
    const pwdInput = container.querySelector<HTMLInputElement>(
      '[data-form-field="password"] [data-form-field-input]'
    )!
    setInputValue(userInput, 'bob')
    setInputValue(pwdInput, 'top-secret-999')

    const drafts = useChatStore.getState().sessionInputDrafts['s-form']?.[FORM_REQUEST.id] as
      | FormDraft
      | undefined
    expect(drafts?.values.username).toBe('bob')
    expect(drafts?.values.password).toBeUndefined()
    expect(JSON.stringify(useChatStore.getState().sessionInputDrafts)).not.toContain(
      'top-secret-999'
    )

    // 卸载再重挂
    act(() => root.unmount())
    root = createRoot(container)
    mount()
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    const remountedUser = container.querySelector<HTMLInputElement>(
      '[data-form-field="username"] [data-form-field-input]'
    )!
    const remountedPwd = container.querySelector<HTMLInputElement>(
      '[data-form-field="password"] [data-form-field-input]'
    )!
    expect(remountedUser.value).toBe('bob')
    expect(remountedPwd.value).toBe('')
  })

  it('AF-18 onSubmit pending 期间防重入；reject 时保留卡片并展示 [data-other-error]', async () => {
    let rejectPending!: (err: Error) => void
    const onSubmit = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectPending = reject
        })
    )
    renderForm(
      {
        id: 'tc-form-err',
        kind: 'form',
        toolName: 'ask',
        question: 'Submit test',
        fields: [{ key: 'host', label: 'Host', type: 'text', required: true }],
        createdAt: 0
      },
      onSubmit
    )
    const input = container.querySelector<HTMLInputElement>(
      '[data-form-field="host"] [data-form-field-input]'
    )!
    const submitBtn = (): HTMLButtonElement =>
      container.querySelector<HTMLButtonElement>('[data-form-submit]')!
    setInputValue(input, 'db.internal')

    // 第一次点击进入 pending
    act(() => submitBtn().click())
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(submitBtn().disabled).toBe(true)

    // pending 期间再次点击不重入
    act(() => submitBtn().click())
    expect(onSubmit).toHaveBeenCalledTimes(1)

    // reject 后卡片仍在并显示错误
    await act(async () => {
      rejectPending(new Error('Vault is locked'))
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(container.querySelector('[data-form-card]')).not.toBeNull()
    expect(container.querySelector('[data-other-error]')?.textContent).toContain('Vault is locked')
    expect(submitBtn().disabled).toBe(false)
  })
})
