// @vitest-environment jsdom
/**
 * 输入框里对模型藏起来的值（docs/auto-redaction-design.md §14；jsdom）：
 *
 *   SC-1 （桌面）「+」→ 菜单（模型不能看图时只有「添加敏感信息」）→ 表单：不回显的输入框、三个类别；添加 → 光标处一个
 *        胶囊（镜像层 `data-secret-chip`），textarea 里是胶囊文字、不是真值；发送 → agent.prompt 带着真值与
 *        secrets；乐观占位气泡里没有真值
 *   SC-2 打开表单时选中了一段 → 预填、添加后替换那一段；Esc 关掉表单什么都不加
 *   SC-3 提示：停笔之后问 redaction.inspect（会话 + 正文 + 粘贴全文）；提示行列出那一项，正文里画虚线；点「隐藏」→
 *        换成胶囊、提示收起；发送带着它
 *   SC-4 提示的 ×：提示收起，照原样发（secrets 为空），同一个值不再提示
 *   SC-5 退格紧贴胶囊尾部 → 整个删掉；删掉之后发送不再带它
 *   SC-6 （触屏）「+」→ 底部面板 → 「添加敏感信息」→ 表单面板（16px 输入框）→ 添加 → 胶囊
 *   SC-7 宿主没有 inspect（旧宿主 / 渠道端）：不提示、照常发
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type { AvailableModel, ProviderInfo } from '@shuvix/chat-protocol/types/provider'
import type { RedactionHint } from '@shuvix/chat-protocol/utils/redactionPlaceholders'

vi.mock('@shuvix/chat-ui', () => {
  const api = (): unknown => (globalThis as unknown as { window: { api: unknown } }).window.api
  return {
    getHostApi: api,
    getSessionChannelApi: api,
    useChatHost: () => ({
      models: {
        activeProvider: 'prov-1',
        activeModel: 'model-m',
        setActiveProvider: vi.fn(),
        setActiveModel: vi.fn()
      }
    })
  }
})

import { applySessionView, useChatStore } from '../../../stores/chatStore'
import { useModelCatalogStore } from '../../../stores/modelCatalogStore'
import { InputArea, type InputAreaProps } from '../InputArea'
import { V, resetStore } from '../../../__tests__/support/views'
import { ChatHostContext, type ChatHostValue } from '../../../host/chatHostContext'
import { HINT_DEBOUNCE_MS } from '../../../hooks/useRedactionHints'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const P = 'prov-1'
const M = 'model-m'
const PASSWORD = 'Xk9#mP2q'

let prompt: ReturnType<typeof vi.fn>
let inspect: ReturnType<typeof vi.fn> | undefined
/** inspect 交回的：按文本交给一个函数算 */
let hintsFor: (text: string) => RedactionHint[] = () => []

function buildApi(withInspect = true): Record<string, unknown> {
  prompt = vi.fn(async () => ({ success: true }))
  inspect = withInspect
    ? vi.fn(async (params: { texts: string[] }) => params.texts.map((t) => hintsFor(t)))
    : undefined
  return {
    session: { list: async () => [], updateEnabledTools: vi.fn(async () => ({ success: true })) },
    agent: {
      init: async () => ({ success: true }),
      prompt,
      steer: vi.fn(async () => ({ success: true })),
      followUp: vi.fn(async () => ({ success: true })),
      abort: vi.fn(async () => ({ success: true })),
      respondToInput: vi.fn(async () => ({ success: true }))
    },
    ...(inspect ? { redaction: { inspect } } : {}),
    tools: { list: async () => [] },
    files: { scan: async () => ({ root: null, paths: [] }) },
    mentions: { listKnowledgeEntries: async () => [] },
    events: { subscribe: () => () => {} },
    app: { openSettings: () => {} }
  }
}

const PROVIDER: ProviderInfo = {
  id: P,
  name: 'openai',
  displayName: 'Prov One',
  apiKey: '',
  baseUrl: '',
  apiProtocol: 'openai-completions' as ProviderInfo['apiProtocol'],
  metadata: '',
  isBuiltin: 0,
  isEnabled: 1,
  sortOrder: 0,
  createdAt: 0,
  updatedAt: 0
}
const MODEL: AvailableModel = {
  id: 'row-m',
  providerId: P,
  modelId: M,
  isEnabled: 1,
  sortOrder: 0,
  capabilities: '{}',
  providerName: 'openai'
}

let container: HTMLDivElement
let root: Root

async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })
}

async function mountInput(touch = false): Promise<void> {
  await act(async () => {
    const Area = InputArea as (props: InputAreaProps) => React.JSX.Element
    const area = createElement(Area, { inline: true })
    root.render(
      touch
        ? createElement(
            ChatHostContext.Provider,
            { value: { density: 'touch' } as ChatHostValue },
            area
          )
        : area
    )
  })
  await flush()
}

const textarea = (): HTMLTextAreaElement => container.querySelector('textarea')!
const plus = (): HTMLButtonElement => container.querySelector('button[data-attach-button]')!
const q = <T extends Element = HTMLElement>(selector: string): T | null =>
  document.body.querySelector<T>(selector)

function setNative(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement
  Object.getOwnPropertyDescriptor(proto.prototype, 'value')!.set!.call(el, value)
}

async function type(value: string, caret = value.length): Promise<void> {
  const el = textarea()
  await act(async () => {
    setNative(el, value)
    el.selectionStart = el.selectionEnd = caret
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await flush()
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    ;(el as HTMLElement).click()
  })
  await flush()
}

async function key(el: Element, keyName: string): Promise<void> {
  await act(async () => {
    el.dispatchEvent(
      new KeyboardEvent('keydown', { key: keyName, bubbles: true, cancelable: true })
    )
  })
  await flush()
}

async function fillSecret(value: string, category?: string): Promise<void> {
  const input = q<HTMLInputElement>('[data-secret-input]')!
  await act(async () => {
    setNative(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  if (category) await click(q(`[data-secret-category="${category}"]`)!)
  await click(q('[data-secret-add]')!)
}

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    showSupportNotice: false
  })
  Element.prototype.scrollIntoView = vi.fn()
})

beforeEach(() => {
  hintsFor = () => []
  ;(window as unknown as { api: unknown }).api = buildApi()
  useModelCatalogStore.setState({ loaded: true, providers: [PROVIDER], availableModels: [MODEL] })
  resetStore('s1')
  useChatStore.setState({
    sessions: [
      {
        id: 's1',
        title: 's1',
        projectId: null,
        parentId: null,
        settings: {},
        createdAt: 0,
        updatedAt: 0,
        lastActiveAt: 0
      }
    ],
    slashCommands: [],
    modelSupportsVision: false,
    maxContextTokens: 0
  })
  act(() => applySessionView('s1', V('s1', { run: { state: 'idle' } })))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

describe('+ 添加敏感信息', () => {
  it('SC-1 菜单 → 表单 → 胶囊；发送带真值与 secrets，乐观气泡里没有真值', async () => {
    await mountInput()
    await type('use ')
    await click(plus())
    expect(q('[data-plus-panel]')).not.toBeNull()
    expect(q('[data-plus-images]')).toBeNull()
    await click(q('[data-plus-secret]')!)
    const input = q<HTMLInputElement>('[data-secret-input]')!
    expect(input.type).toBe('password')
    expect(
      [...document.body.querySelectorAll('[data-secret-category]')].map(
        (b) => (b as HTMLElement).dataset.secretCategory
      )
    ).toEqual(['PASSWORD', 'API_KEY', 'SECRET'])
    await fillSecret(PASSWORD, 'API_KEY')

    const chipText = '[🔒 API key #1]'
    expect(q('[data-plus-panel]')).toBeNull()
    expect(textarea().value).toBe(`use ${chipText}`)
    expect(textarea().value).not.toContain(PASSWORD)
    expect(container.querySelector('[data-secret-chip]')!.textContent).toBe(chipText)

    // 回之前看一眼乐观气泡
    let release: () => void = () => {}
    prompt.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve({ success: true })))
    )
    await key(textarea(), 'Enter')
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(prompt.mock.calls[0]![0]).toEqual({
      sessionId: 's1',
      text: `use ${PASSWORD}`,
      secrets: [{ value: PASSWORD, category: 'API_KEY' }]
    })
    const pending = JSON.stringify(useChatStore.getState().sessionPendingPrompt.s1)
    expect(pending).toContain(chipText)
    expect(pending).not.toContain(PASSWORD)
    expect(textarea().value).toBe('')
    await act(async () => release())
    await flush()
  })

  it('SC-2 选中一段再打开：预填并替换那一段；Esc 什么都不加', async () => {
    await mountInput()
    await type(`root / ${PASSWORD} ok`)
    const el = textarea()
    el.selectionStart = 7
    el.selectionEnd = 7 + PASSWORD.length
    await click(plus())
    await click(q('[data-plus-secret]')!)
    expect(q<HTMLInputElement>('[data-secret-input]')!.value).toBe(PASSWORD)
    await click(q('[data-secret-add]')!)
    expect(textarea().value).toBe('root / [🔒 Password #1] ok')

    await click(plus())
    await click(q('[data-plus-secret]')!)
    await key(q('[data-secret-input]')!, 'Escape')
    expect(q('[data-secret-form]')).toBeNull()
    expect(textarea().value).toBe('root / [🔒 Password #1] ok')
  })
})

describe('提示', () => {
  const hintPassword = (text: string): RedactionHint[] => {
    const i = text.indexOf(PASSWORD)
    return i === -1 ? [] : [{ start: i, end: i + PASSWORD.length, category: 'PASSWORD' }]
  }

  it('SC-3 停笔后问 inspect；提示行 + 虚线；点「隐藏」→ 胶囊，发送带着它', async () => {
    hintsFor = hintPassword
    await mountInput()
    await type(`sudo password ${PASSWORD} please`)
    expect(q('[data-redaction-hints]')).toBeNull()
    await flush(HINT_DEBOUNCE_MS + 50)
    expect(inspect).toHaveBeenCalled()
    expect(inspect!.mock.calls.at(-1)![0]).toEqual({
      sessionId: 's1',
      provider: P,
      model: M,
      texts: [`sudo password ${PASSWORD} please`]
    })
    const bar = q('[data-redaction-hints]')!
    expect(bar.querySelector('[data-redaction-hint="PASSWORD"]')!.textContent).toBe('Password Xk9…')
    expect(bar.textContent).not.toContain(PASSWORD)
    expect(container.querySelector('[data-redaction-hint-span]')!.textContent).toBe(PASSWORD)

    await click(bar.querySelector('[data-redaction-hide-all]')!)
    expect(textarea().value).toBe('sudo password [🔒 Password #1] please')
    expect(q('[data-redaction-hints]')).toBeNull()

    await key(textarea(), 'Enter')
    expect(prompt.mock.calls[0]![0]).toMatchObject({
      text: `sudo password ${PASSWORD} please`,
      secrets: [{ value: PASSWORD, category: 'PASSWORD' }]
    })
  })

  it('SC-4 ×：提示收起、照原样发；同一个值不再提示', async () => {
    hintsFor = hintPassword
    await mountInput()
    await type(`pw ${PASSWORD}`)
    await flush(HINT_DEBOUNCE_MS + 50)
    await click(q('[data-redaction-hints-dismiss]')!)
    expect(q('[data-redaction-hints]')).toBeNull()
    await type(`pw ${PASSWORD} again`)
    await flush(HINT_DEBOUNCE_MS + 50)
    expect(q('[data-redaction-hints]')).toBeNull()
    await key(textarea(), 'Enter')
    expect(prompt.mock.calls[0]![0]).toEqual({
      sessionId: 's1',
      text: `pw ${PASSWORD} again`,
      secrets: []
    })
  })

  it('SC-7 宿主没有 inspect：不提示、照常发', async () => {
    ;(window as unknown as { api: unknown }).api = buildApi(false)
    hintsFor = hintPassword
    await mountInput()
    await type(`pw ${PASSWORD}`)
    await flush(HINT_DEBOUNCE_MS + 50)
    expect(q('[data-redaction-hints]')).toBeNull()
    await key(textarea(), 'Enter')
    expect(prompt.mock.calls[0]![0]).toMatchObject({ text: `pw ${PASSWORD}`, secrets: [] })
  })
})

describe('胶囊的编辑与触屏', () => {
  it('SC-5 退格紧贴胶囊尾部 → 整个删掉；之后发送不带它', async () => {
    await mountInput()
    await type('x ')
    await click(plus())
    await click(q('[data-plus-secret]')!)
    await fillSecret(PASSWORD)
    const value = textarea().value
    textarea().selectionStart = textarea().selectionEnd = value.length
    await key(textarea(), 'Backspace')
    expect(textarea().value).toBe('x ')
    await type('x done')
    await key(textarea(), 'Enter')
    expect(prompt.mock.calls[0]![0]).toEqual({ sessionId: 's1', text: 'x done', secrets: [] })
  })

  it('SC-6 触屏：底部面板 → 表单面板（16px）→ 胶囊', async () => {
    await mountInput(true)
    await click(plus())
    expect(q('[data-touch-sheet="plus"]')).not.toBeNull()
    await click(q('[data-plus-secret]')!)
    expect(q('[data-touch-sheet="plus"]')).toBeNull()
    expect(q('[data-touch-sheet="secret"]')).not.toBeNull()
    expect(q('[data-secret-input]')!.className).toContain('text-[16px]')
    await fillSecret(PASSWORD)
    expect(q('[data-touch-sheet="secret"]')).toBeNull()
    expect(textarea().value).toBe('[🔒 Password #1]')
  })
})
