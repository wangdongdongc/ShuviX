// @vitest-environment jsdom
/**
 * 乐观占位走输入框的那两条（jsdom，Q-P3-07）：
 *
 *   P3-08-31 空闲时经输入框发送：任何视图帧到达之前占位就在，列表是 […, pending-prompt, streaming-live]；
 *            MCP 连接态照常记下
 *   P3-08-34 prompt 先落定：以 {error} 落定（没被受理）→ 占位撤下、没有用户项；被拒 → 占位撤下、显示发送失败
 *
 * 后端是假的 `window.api`（同 inputAreaWelcomeSend.dom.test.tsx 的做法），`agent.prompt` 由用例掌握何时落定。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import type { AvailableModel, ProviderInfo } from '@shuvix/chat-protocol/types/provider'

const mocks = vi.hoisted(() => ({
  models: { activeProvider: 'prov-1', activeModel: 'model-m' }
}))

vi.mock('@shuvix/chat-ui', () => {
  const api = (): unknown => (globalThis as unknown as { window: { api: unknown } }).window.api
  return {
    getHostApi: api,
    getSessionChannelApi: api,
    useChatHost: () => ({
      models: {
        activeProvider: mocks.models.activeProvider,
        activeModel: mocks.models.activeModel,
        setActiveProvider: vi.fn(),
        setActiveModel: vi.fn()
      }
    })
  }
})

import {
  applySessionView,
  selectIsStreaming,
  selectMcpConnecting,
  selectPendingPrompt,
  useChatStore
} from '../../../stores/chatStore'
import { useModelCatalogStore } from '../../../stores/modelCatalogStore'
import { InputArea, type InputAreaProps } from '../InputArea'
import { buildVisibleItems } from '../conversationItems'
import { V, assistant, resetStore, store, text, user } from '../../../__tests__/support/views'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const P = 'prov-1'
const M = 'model-m'

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

let prompt: Deferred<{ error?: string }>

function buildApi(): Record<string, unknown> {
  return {
    session: { list: async () => [] },
    agent: {
      init: async () => ({
        success: true,
        created: true,
        provider: P,
        model: M,
        capabilities: {},
        modelMetadata: {},
        workingDirectory: '/w',
        enabledTools: []
      }),
      prompt: vi.fn(() => prompt.promise),
      abort: async () => ({ success: true }),
      respondToInput: async () => ({ success: true })
    },
    tools: { list: async () => [] },
    files: { scan: async () => ({ root: null, paths: [] }) },
    mentions: { listKnowledgeEntries: async () => [] },
    events: { subscribe: () => () => {} },
    app: { openSettings: () => {} }
  }
}

let container: HTMLDivElement
let root: Root

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function mount(): Promise<void> {
  await act(async () => {
    const Area = InputArea as (props: InputAreaProps) => React.JSX.Element
    root.render(createElement(Area, { inline: true }))
  })
  await flush()
}

async function typeAndSend(value: string): Promise<void> {
  const el = container.querySelector('textarea')!
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(el, value)
    el.selectionStart = el.selectionEnd = value.length
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await flush()
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  await flush()
}

const items = (): ReturnType<typeof buildVisibleItems> =>
  buildVisibleItems(store().messages, selectIsStreaming(store()), selectPendingPrompt(store()))

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

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'zh',
    resources: { zh: { translation: zh } },
    showSupportNotice: false
  })
  Element.prototype.scrollIntoView = vi.fn()
})

beforeEach(() => {
  prompt = deferred()
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
    slashCommands: []
  })
  applySessionView(
    's1',
    V('s1', { messages: [user('u1', 'earlier'), assistant('a1', [text('ok')])], run: { state: 'idle' } })
  )
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

describe('乐观占位：经输入框发送（Q-P3-07）', () => {
  it('P3-08-31 发出之后、任何帧到达之前：占位在、列表 […, pending-prompt, streaming-live]；MCP 连接态照记', async () => {
    await mount()
    await typeAndSend('hello')
    expect(selectPendingPrompt(store())?.content).toBe('hello')
    expect(items().slice(-2).map((i) => i.key)).toEqual(['pending-prompt', 'turn:2.0'])
    expect(items().at(-1)!.msgs!.map((m) => m.id)).toEqual(['streaming-live'])
    act(() => store().setMcpConnecting('s1', 'x', true))
    expect(selectMcpConnecting(store())).toEqual(['x'])
    // 收尾：prompt 落定
    await act(async () => prompt.resolve({}))
    await flush()
  })

  it('P3-08-34 prompt 以 {error} 先于受理落定：占位撤下、没有新的用户项', async () => {
    await mount()
    await typeAndSend('refused')
    expect(selectPendingPrompt(store())).not.toBeNull()
    await act(async () => prompt.resolve({ error: 'model missing' }))
    await flush()
    expect(selectPendingPrompt(store())).toBeNull()
    expect(items().map((i) => i.key)).toEqual(['u1', 'turn:1.0'])
    expect(selectIsStreaming(store())).toBe(false)
  })

  it('P3-08-34 prompt 被拒：占位撤下，显示发送失败的文字', async () => {
    await mount()
    await typeAndSend('boom')
    await act(async () => prompt.reject(new Error('IPC exploded')))
    await flush()
    expect(selectPendingPrompt(store())).toBeNull()
    expect(container.querySelector('[data-send-error]')?.textContent).toContain('IPC exploded')
  })
})
