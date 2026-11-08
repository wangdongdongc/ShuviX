// @vitest-environment jsdom
/**
 * 审批卡片上的改设置预览（preview kind settings）与要用户自己填的值（request.fields）。
 *
 *   AF-1  改设置预览：顶行是「改设置」的动作名；预览里是宿主写的那句话、逐行的标签与值（按原顺序）、通道名；
 *         有宿主也只有允许 + 拒绝两行（卡上不给记住）
 *   AF-2  没有 fields：允许交出的答复恰是 `{ kind: 'ask', allowed: true }`，没有 values 键
 *   AF-3  必填的没填（或只有空白）：允许那一行 disabled、第二行说为什么；点它、按 1 都不交；填上之后可点、说明消失
 *   AF-4  批准时 values 恰是 fields 的键：填的值去掉首尾空白，没填的可选项是空串；点行与按 1 交出同一份
 *   AF-5  输入框里的回车：必填还空着 → 不交、焦点跳到第一个空着的必填项；都填了 → 桌面上等于批准；触屏不批准
 *   AF-6  焦点在输入框里按数字键：不选行（事件不拦），什么都不交
 *   AF-7  秘密项是 password 输入框，眼睛按钮切换明文 / 打码；输入框不受控 —— 填的值不出现在 innerHTML 里
 *   AF-8  拒绝、写一句话都不带 values
 *   AF-9  会话询问带 fields：没有「允许并记住」那一行
 *   AF-10 触屏档：输入框一行 44px（h-11）、16px 字（只断 class）
 *   AF-11 经对话流末尾的卡片答完：询问从视图里没了之后，填过的值不在 DOM 里，也从没进过 store（草稿里没有）
 *
 * 包入口 `@shuvix/chat-ui` 顶掉（AskForm 从那里取 getHostApi）；i18n 走真 en 资源。不写 JSX，一律 createElement。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type {
  AskField,
  AskInputRequest,
  AskSettingsPreview,
  InputResponse
} from '@shuvix/chat-protocol/types/inputRequest'

const host = vi.hoisted(() => ({ api: {} as unknown }))
vi.mock('@shuvix/chat-ui', () => ({ getHostApi: () => host.api }))

import { AskForm } from '../inputs/AskForm'
import { PendingInputsPanel } from '../PendingInputsPanel'
import { applySessionView, useChatStore } from '../../../stores/chatStore'
import { V, resetStore, store } from '../../../__tests__/support/views'
import { ChatHostContext, type ChatHostValue } from '../../../host/chatHostContext'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

/** 一个认得出的值：在哪儿出现都一眼看得到 */
const SECRET = 'ghp_TOPSECRET_9f8e7d'

const SETTINGS: AskSettingsPreview = {
  kind: 'settings',
  channel: 'mcp:add',
  title: 'Add MCP server github',
  rows: [
    { label: 'Name', value: 'github' },
    { label: 'Command', value: 'npx -y @modelcontextprotocol/server-github' },
    { label: 'GITHUB_TOKEN', value: 'you fill in below' }
  ]
}
const TOKEN: AskField = {
  key: 'env.GITHUB_TOKEN',
  label: 'GITHUB_TOKEN',
  secret: true,
  required: true
}
const HOST: AskField = {
  key: 'env.GITHUB_HOST',
  label: 'GITHUB_HOST',
  secret: false,
  required: false
}

const settingsAsk = (extra: Partial<AskInputRequest> = {}): AskInputRequest => ({
  id: 'tc-1',
  kind: 'ask',
  toolName: 'shuvix',
  command: 'shuvix mcp:add github',
  createdAt: 0,
  preview: SETTINGS,
  ...extra
})

let container: HTMLDivElement
let root: Root
let renderSeq = 0

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
  useChatStore.setState({ toolPresentations: {} })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
})

function render(
  request: AskInputRequest,
  opts: { touch?: boolean; draft?: { otherText?: string } } = {}
): ReturnType<typeof vi.fn> {
  const onSubmit = vi.fn()
  const form = createElement(AskForm, {
    key: `card-${++renderSeq}`,
    request,
    draft: opts.draft ?? {},
    onDraftChange: vi.fn(),
    onSubmit: onSubmit as (response: InputResponse) => void
  })
  act(() => {
    root.render(
      opts.touch
        ? createElement(
            ChatHostContext.Provider,
            { value: { density: 'touch' } as ChatHostValue },
            form
          )
        : form
    )
  })
  return onSubmit
}

/** 在目标（缺省 = 此刻的焦点，没有就 body）上派发一次 keydown；回 dispatchEvent 的结果（false = 被拦下） */
function press(key: string, target?: EventTarget): boolean {
  const at = target ?? document.activeElement ?? document.body
  let result = true
  act(() => {
    result = at.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, composed: true })
    )
  })
  return result
}

/** 像用户打字那样写进输入框：走原生 setter，React 的 onChange 才认 */
function typeInto(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    el.focus()
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const q = <T extends Element = HTMLElement>(selector: string): T | null =>
  container.querySelector<T>(selector)
const input = (key: string): HTMLInputElement => {
  const el = q<HTMLInputElement>(`[data-ask-field="${key}"] [data-ask-field-input]`)
  if (!el) throw new Error(`field ${key} not rendered`)
  return el
}
const row = (id: string): HTMLButtonElement => {
  const el = q<HTMLButtonElement>(`[data-ask-option="${id}"]`)
  if (!el) throw new Error(`option row ${id} not rendered`)
  return el
}
const rowIds = (): string[] =>
  [...container.querySelectorAll<HTMLElement>('[data-ask-option]')].map(
    (r) => r.dataset.askOption ?? ''
  )
const click = (el: HTMLElement): void => act(() => el.click())
const tr = (key: string, opts?: Record<string, unknown>): string => {
  const text = i18n.t(key, opts)
  expect(text, key).not.toBe(key)
  return text
}

describe('改设置预览', () => {
  it('AF-1 顶行是动作名；宿主那句话、逐行的标签与值、通道名都摆出来；只有允许 + 拒绝', () => {
    render(settingsAsk())

    expect(q('[data-ask-title]')?.textContent).toBe(tr('toolCall.settingsAskChange'))
    const preview = q('[data-ask-settings]')!
    expect(preview.getAttribute('data-ask-settings')).toBe('mcp:add')
    expect(q('[data-ask-settings-title]')?.textContent).toBe('Add MCP server github')

    const labels = [...container.querySelectorAll('[data-ask-settings-label]')].map(
      (el) => el.textContent
    )
    const values = [...container.querySelectorAll('[data-ask-settings-value]')].map(
      (el) => el.textContent
    )
    expect(labels).toEqual(['Name', 'Command', 'GITHUB_TOKEN'])
    expect(values).toEqual([
      'github',
      'npx -y @modelcontextprotocol/server-github',
      'you fill in below'
    ])
    // 值是等宽、能折行的（只断 class）
    const value = container.querySelector('[data-ask-settings-value]')!
    expect(value.classList.contains('font-mono')).toBe(true)
    expect(value.classList.contains('break-all')).toBe(true)

    const channel = q('[data-ask-settings-channel]')!
    expect(channel.textContent).toContain(tr('toolCall.settingsAskChannel'))
    expect(channel.textContent).toContain('mcp:add')

    expect(rowIds()).toEqual(['allow', 'deny'])
  })

  it('AF-1 没有行：只有那句话与通道名，不崩', () => {
    render(settingsAsk({ preview: { ...SETTINGS, rows: [] } }))
    expect(q('[data-ask-settings-title]')?.textContent).toBe('Add MCP server github')
    expect(container.querySelector('[data-ask-settings-label]')).toBeNull()
  })

  it('AF-2 没有 fields：没有输入框；允许交出的答复不带 values', () => {
    const onSubmit = render(settingsAsk())
    expect(q('[data-ask-fields]')).toBeNull()
    expect(row('allow').disabled).toBe(false)
    click(row('allow'))
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit.mock.lastCall![0]).toEqual({ kind: 'ask', allowed: true })
  })
})

describe('卡上要填的值', () => {
  it('AF-3 必填的没填：允许灰着、说明为什么；点它、按 1 都不交；只有空白也不算；填上之后可点', () => {
    const onSubmit = render(settingsAsk({ fields: [TOKEN, HOST] }))

    expect(q('[data-ask-fields]')?.textContent).toContain(tr('toolCall.askFieldsNote'))
    expect(row('allow').disabled).toBe(true)
    expect(row('allow').querySelector('[data-option-detail]')?.textContent).toBe(
      tr('toolCall.askFieldsMissing', { count: 1 })
    )
    click(row('allow'))
    press('1', document.body)
    expect(onSubmit).not.toHaveBeenCalled()

    typeInto(input(TOKEN.key), '   ')
    expect(row('allow').disabled).toBe(true)

    // 可选项填了也不顶用
    typeInto(input(HOST.key), 'github.example.test')
    expect(row('allow').disabled).toBe(true)

    typeInto(input(TOKEN.key), SECRET)
    expect(row('allow').disabled).toBe(false)
    expect(row('allow').querySelector('[data-option-detail]')).toBeNull()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('AF-3 两个必填：说明用复数；只填一个仍灰着', () => {
    const second: AskField = { key: 'header.X-Org', label: 'X-Org', secret: false, required: true }
    render(settingsAsk({ fields: [TOKEN, second] }))
    expect(row('allow').querySelector('[data-option-detail]')?.textContent).toBe(
      tr('toolCall.askFieldsMissing', { count: 2 })
    )
    typeInto(input(TOKEN.key), SECRET)
    expect(row('allow').disabled).toBe(true)
    expect(row('allow').querySelector('[data-option-detail]')?.textContent).toBe(
      tr('toolCall.askFieldsMissing', { count: 1 })
    )
  })

  it('AF-3 可选项的标签旁标着「可选」，必填项没有', () => {
    render(settingsAsk({ fields: [TOKEN, HOST] }))
    expect(q(`[data-ask-field="${HOST.key}"] [data-ask-field-optional]`)?.textContent).toBe(
      tr('toolCall.askFieldOptional')
    )
    expect(q(`[data-ask-field="${TOKEN.key}"] [data-ask-field-optional]`)).toBeNull()
    expect(q(`[data-ask-field="${TOKEN.key}"] label`)?.textContent).toBe('GITHUB_TOKEN')
  })

  it('AF-4 批准：values 恰是 fields 的键，去掉首尾空白，没填的可选项是空串', () => {
    const onSubmit = render(settingsAsk({ fields: [TOKEN, HOST] }))
    typeInto(input(TOKEN.key), `  ${SECRET}\n`)
    click(row('allow'))
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit.mock.lastCall![0]).toEqual({
      kind: 'ask',
      allowed: true,
      values: { [TOKEN.key]: SECRET, [HOST.key]: '' }
    })
  })

  it('AF-4 焦点不在输入框里时按 1 = 点允许那一行，交出同一份', () => {
    const onSubmit = render(settingsAsk({ fields: [TOKEN, HOST] }))
    typeInto(input(TOKEN.key), SECRET)
    typeInto(input(HOST.key), 'ghe.example.test')
    act(() => input(HOST.key).blur())
    expect(press('1', document.body)).toBe(false)
    expect(onSubmit.mock.lastCall![0]).toEqual({
      kind: 'ask',
      allowed: true,
      values: { [TOKEN.key]: SECRET, [HOST.key]: 'ghe.example.test' }
    })
  })

  it('AF-5 回车：必填还空着 → 不交、焦点跳到空着的必填项；都填了 → 批准', () => {
    const onSubmit = render(settingsAsk({ fields: [TOKEN, HOST] }))
    typeInto(input(HOST.key), 'ghe.example.test')
    expect(press('Enter', input(HOST.key))).toBe(false)
    expect(onSubmit).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(input(TOKEN.key))

    typeInto(input(TOKEN.key), SECRET)
    press('Enter', input(TOKEN.key))
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit.mock.lastCall![0]).toMatchObject({
      kind: 'ask',
      allowed: true,
      values: { [TOKEN.key]: SECRET }
    })
  })

  it('AF-5 触屏：回车从不批准，填完了跳到下一项，最后一项收起键盘', () => {
    const onSubmit = render(settingsAsk({ fields: [TOKEN, HOST] }), { touch: true })
    typeInto(input(TOKEN.key), SECRET)
    press('Enter', input(TOKEN.key))
    expect(document.activeElement).toBe(input(HOST.key))
    press('Enter', input(HOST.key))
    expect(document.activeElement).not.toBe(input(HOST.key))
    expect(onSubmit).not.toHaveBeenCalled()
    // 批准走选项行
    click(row('allow'))
    expect(onSubmit.mock.lastCall![0]).toMatchObject({ allowed: true })
  })

  it('AF-6 焦点在输入框里：数字键是打字，不选行、不拦事件', () => {
    const onSubmit = render(settingsAsk({ fields: [TOKEN, HOST] }))
    typeInto(input(TOKEN.key), SECRET)
    for (const key of ['1', '2']) {
      expect(press(key, input(TOKEN.key))).toBe(true)
      expect(press(key, input(HOST.key))).toBe(true)
    }
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('AF-7 秘密项打码，眼睛按钮切换；可选的明文项没有眼睛；填的值不在 innerHTML 里', () => {
    render(settingsAsk({ fields: [TOKEN, HOST] }))
    expect(input(TOKEN.key).type).toBe('password')
    expect(input(HOST.key).type).toBe('text')
    expect(q(`[data-ask-field="${HOST.key}"] [data-ask-field-reveal]`)).toBeNull()

    typeInto(input(TOKEN.key), SECRET)
    const reveal = q<HTMLButtonElement>(`[data-ask-field="${TOKEN.key}"] [data-ask-field-reveal]`)!
    expect(reveal.getAttribute('aria-label')).toBe(tr('input.secretShow'))
    click(reveal)
    expect(input(TOKEN.key).type).toBe('text')
    expect(reveal.getAttribute('aria-label')).toBe(tr('input.secretHide'))
    // 换了 type 值还在
    expect(input(TOKEN.key).value).toBe(SECRET)
    click(reveal)
    expect(input(TOKEN.key).type).toBe('password')

    expect(input(TOKEN.key).hasAttribute('value')).toBe(false)
    expect(container.innerHTML).not.toContain(SECRET)
  })

  it('AF-8 拒绝不带 values', () => {
    const onSubmit = render(settingsAsk({ fields: [TOKEN] }))
    typeInto(input(TOKEN.key), SECRET)
    click(row('deny'))
    expect(onSubmit.mock.lastCall![0]).toEqual({ kind: 'ask', allowed: false })
  })

  it('AF-8 写一句话发出去：是「其它」，不带 values', () => {
    const onSubmit = render(settingsAsk({ fields: [TOKEN] }), {
      draft: { otherText: 'Use the org token instead' }
    })
    typeInto(input(TOKEN.key), SECRET)
    click(q<HTMLButtonElement>('[data-other-submit]')!)
    expect(onSubmit.mock.lastCall![0]).toEqual({
      kind: 'other',
      text: 'Use the org token instead',
      secrets: []
    })
  })

  it('AF-9 会话询问带 fields：有宿主也没有「允许并记住」', () => {
    render(
      settingsAsk({
        preview: undefined,
        toolName: 'session',
        command: 'session "Plan" (s-2)',
        session: { sessionId: 's-2', title: 'Plan', access: 'write', operation: 'prompt-session' },
        fields: [TOKEN]
      })
    )
    expect(rowIds()).toEqual(['allow', 'deny'])
  })

  it('AF-10 触屏档：输入框那一行 44px、16px 字（只断 class）', () => {
    render(settingsAsk({ fields: [TOKEN] }), { touch: true })
    const box = input(TOKEN.key).parentElement!
    expect(box.classList.contains('h-11')).toBe(true)
    expect(input(TOKEN.key).classList.contains('text-base')).toBe(true)
    const reveal = q(`[data-ask-field="${TOKEN.key}"] [data-ask-field-reveal]`)!
    expect(reveal.classList.contains('h-11')).toBe(true)
  })
})

describe('答完之后', () => {
  it('AF-11 询问从视图里没了：填过的值不在 DOM 里，也从没进过 store', async () => {
    const ask = settingsAsk({ id: 'r1', fields: [TOKEN] })
    const onResponse = vi.fn<(requestId: string, response: InputResponse) => void>()
    act(() => applySessionView('s1', V('s1', { run: { state: 'busy' }, asks: [ask] })))
    act(() => {
      root.render(createElement(PendingInputsPanel, { onResponse, placement: 'conversation' }))
    })
    // 面板在 effect 里建草稿，挂上之后等一拍
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    typeInto(input(TOKEN.key), SECRET)
    // 草稿在共享的 store 里：值不进去
    expect(JSON.stringify(store().sessionInputDrafts)).not.toContain(SECRET)

    click(row('allow'))
    expect(onResponse).toHaveBeenCalledWith('r1', {
      kind: 'ask',
      allowed: true,
      values: { [TOKEN.key]: SECRET }
    })

    // 宿主收下答复，询问从视图里没了
    act(() => applySessionView('s1', V('s1', { run: { state: 'busy' }, asks: [] })))
    expect(q('[data-ask-card]')).toBeNull()
    expect(container.innerHTML).not.toContain(SECRET)
    expect(container.textContent).not.toContain(SECRET)
    expect(document.body.innerHTML).not.toContain(SECRET)
    expect(JSON.stringify(store().sessionInputDrafts)).not.toContain(SECRET)
    expect(JSON.stringify(store().sessionPendingInputs)).not.toContain(SECRET)
  })
})
