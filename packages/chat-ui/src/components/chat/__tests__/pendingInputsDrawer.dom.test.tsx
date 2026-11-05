// @vitest-environment jsdom
/**
 * 笔记本的询问（PendingInputsDrawer + ThreadDrawer，接线同 NotebookSession）：笔记本的主界面不是对话，询问还长在输入卡片里，
 * 所以这条路上没有对话流那张卡片、没有「等你批准」提示，数字键也不量位置（卡片总是看得见的）。
 *
 *   NB-1 面板在输入卡片里；没有 [data-pending-card]、没有 [data-pending-jump]
 *   NB-2 数字键直接答（外面没有滚动区也认）
 *   NB-3 折叠抽屉：面板收起；同一条不会自己展开；新的一条到了就展开
 *   NB-4 ThreadDrawer 里答完的选择题：[data-ask-record]；这份记录不挂数字键
 *   NB-5 接线（源码）：NotebookSession 给 accessory；ChatBody 与扩展不给
 *   NB-6 卡片最后一行在抽屉里；输入框回车 = steer；那一行回车 = 只答卡片，不 steer，待发图片不动
 *
 * NotebookSession 本身不挂（它从包入口取 chat-ui，还要真编辑器）：接线由 NB-5 钉。后端是假的 `window.api`；不写 JSX。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type { AvailableModel, ProviderInfo } from '@shuvix/chat-protocol/types/provider'
import type { InputRequest } from '@shuvix/chat-protocol/types/inputRequest'

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
import { PendingInputsDrawer } from '../PendingInputsDrawer'
import { ThreadDrawer } from '../ThreadDrawer'
import { V, assistant, resetStore, store, user } from '../../../__tests__/support/views'
import { fakeLink } from '../../../__tests__/support/sendFailure'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const P = 'prov-1'
const M = 'model-m'
const ASK: InputRequest = { id: 'r1', kind: 'ask', toolName: 'bash', command: 'ls', createdAt: 0 }
const ASK2: InputRequest = {
  id: 'r2',
  kind: 'ask',
  toolName: 'bash',
  command: 'pwd',
  createdAt: 1
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
let agent: {
  prompt: ReturnType<typeof vi.fn>
  steer: ReturnType<typeof vi.fn>
  respondToInput: ReturnType<typeof vi.fn>
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
  agent = {
    prompt: vi.fn(async () => ({ success: true })),
    steer: vi.fn(async () => ({ success: true })),
    respondToInput: vi.fn(async () => ({ success: true }))
  }
  ;(window as unknown as { api: unknown }).api = {
    sync: fakeLink(),
    session: { list: async () => [] },
    agent: {
      ...agent,
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
      abort: vi.fn(async () => ({ success: true }))
    },
    tools: { list: async () => [] },
    files: { scan: async () => ({ root: null, paths: [] }) },
    mentions: { listKnowledgeEntries: async () => [] },
    events: { subscribe: () => () => {} },
    app: { openSettings: () => {} }
  }
  useModelCatalogStore.setState({ loaded: true, providers: [PROVIDER], availableModels: [MODEL] })
  store().setActiveSessionId('s1')
  store().setInputText('')
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
  } as never)
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

async function mount(asks: InputRequest[], props: InputAreaProps = {}): Promise<void> {
  act(() => applySessionView('s1', V('s1', { run: { state: 'busy' }, asks })))
  await act(async () => {
    const Area = InputArea as (p: InputAreaProps) => React.JSX.Element
    root.render(createElement(Area, { inline: true, ...props }))
  })
  await flush()
}

const onResponse = vi.fn()

/** 输入卡片（描边那一层） */
const composer = (): HTMLTextAreaElement =>
  container.querySelector<HTMLTextAreaElement>('textarea:not([data-other-input])')!
const otherInput = (): HTMLTextAreaElement =>
  container.querySelector<HTMLTextAreaElement>('[data-other-input]')!
const card = (): HTMLElement => composer().closest<HTMLElement>('.rounded-2xl')!

async function typeInto(el: HTMLTextAreaElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(el, value)
    el.selectionStart = el.selectionEnd = value.length
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await flush()
}
async function enterOn(el: HTMLTextAreaElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    )
  })
  await flush()
}
const panel = (): Element | null => container.querySelector('[data-pending-inputs]')

function press(key: string): boolean {
  let result = true
  act(() => {
    result = document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, composed: true })
    )
  })
  return result
}

async function mountWithDrawer(asks: InputRequest[]): Promise<void> {
  onResponse.mockReset()
  await mount(asks, { accessory: createElement(PendingInputsDrawer, { onResponse }) })
}

describe('笔记本：询问在输入卡片里', () => {
  it('NB-1 面板在输入卡片里；对话流的卡片与提示都没有', async () => {
    await mountWithDrawer([ASK])
    expect(card().contains(panel())).toBe(true)
    expect(container.querySelector('[data-pending-card]')).toBeNull()
    expect(container.querySelector('[data-pending-jump]')).toBeNull()
  })

  it('NB-2 数字键直接答，不量位置', async () => {
    await mountWithDrawer([ASK])
    expect(container.querySelector('[data-virtuoso-scroller]')).toBeNull()
    expect(press('1')).toBe(false)
    expect(onResponse).toHaveBeenCalledTimes(1)
    expect(onResponse.mock.calls[0]![0]).toBe('r1')
    expect(onResponse.mock.calls[0]![1]).toMatchObject({ kind: 'ask', allowed: true })
  })

  it('NB-3 折叠抽屉：面板收起、同一条不自己展开；新的一条到了就展开', async () => {
    await mountWithDrawer([ASK])
    const strip = container.querySelector<HTMLButtonElement>(
      `button[title="${en.pendingInputs.collapse}"]`
    )!
    act(() => strip.click())
    expect(panel()).toBeNull()

    act(() => applySessionView('s1', V('s1', { run: { state: 'busy' }, asks: [ASK] })))
    await flush()
    expect(panel()).toBeNull()

    act(() => applySessionView('s1', V('s1', { run: { state: 'busy' }, asks: [ASK2] })))
    await flush()
    expect(panel()).not.toBeNull()
  })
})

describe('笔记本：卡片最后一行与输入框', () => {
  const IMAGE = { data: 'aGk=', mimeType: 'image/png', preview: 'data:image/png;base64,aGk=' }

  it('NB-6 那一行在抽屉的面板里（输入框的卡片之内）', async () => {
    await mountWithDrawer([ASK])
    expect(panel()!.contains(otherInput())).toBe(true)
    expect(card().contains(otherInput())).toBe(true)
    expect(otherInput()).not.toBe(composer())
  })

  it('NB-6 输入框回车：steer，不答卡片', async () => {
    await mountWithDrawer([ASK])
    await typeInto(composer(), 'keep going')
    await enterOn(composer())
    expect(agent.steer).toHaveBeenCalledTimes(1)
    expect(agent.steer.mock.calls[0]![0]).toMatchObject({ sessionId: 's1', text: 'keep going' })
    expect(onResponse).not.toHaveBeenCalled()
    expect(composer().value).toBe('')
    expect(panel()).not.toBeNull()
  })

  it('NB-6 那一行回车：只答卡片，不 steer；输入框的字与待发图片不动', async () => {
    await mountWithDrawer([ASK])
    await act(async () => useChatStore.setState({ pendingImages: [IMAGE] }))
    await flush()
    await typeInto(composer(), 'draft stays')
    await typeInto(otherInput(), 'do this instead')
    await enterOn(otherInput())
    expect(onResponse.mock.calls).toEqual([
      ['r1', { kind: 'other', text: 'do this instead', secrets: [] }]
    ])
    expect(agent.steer).not.toHaveBeenCalled()
    expect(agent.prompt).not.toHaveBeenCalled()
    expect(agent.respondToInput).not.toHaveBeenCalled()
    expect(composer().value).toBe('draft stays')
    expect(store().pendingImages).toEqual([IMAGE])
  })
})

describe('笔记本：答完的选择题', () => {
  it('NB-4 ThreadDrawer 里是记录；不挂数字键（1 不被拦）', async () => {
    const asked = assistant('a1', [
      {
        type: 'tool',
        toolCallId: 'q1',
        toolName: 'ask',
        args: { question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] },
        result: 'User selected: A',
        details: { type: 'ask', question: 'Which?', selections: ['A'] }
      }
    ])
    act(() =>
      applySessionView(
        's1',
        V('s1', { run: { state: 'idle' }, messages: [user('u1', 'go'), asked] })
      )
    )
    act(() => store().setThreadOpen('s1', true))
    await act(async () => {
      root.render(createElement(ThreadDrawer, { sessionId: 's1' }))
    })
    await flush()

    const record = container.querySelector('[data-ask-record]')
    expect(record).not.toBeNull()
    expect(record!.textContent).toContain('Which?')
    expect(press('1')).toBe(true)
  })
})

describe('接线', () => {
  const repo = resolve(__dirname, '../../../../../..')
  const source = (file: string): string => readFileSync(resolve(repo, file), 'utf8')

  it('NB-5 NotebookSession 给 accessory（抽屉）；ChatBody 与扩展不给', () => {
    expect(source('packages/app-shell/src/notebook/NotebookSession.tsx')).toMatch(
      /accessory=\{<PendingInputsDrawer /
    )
    expect(source('packages/app-shell/src/chat/ChatBody.tsx')).not.toContain('accessory')
    expect(source('packages/chat-ui/src/components/chat/Conversation.tsx')).not.toMatch(
      /<InputArea[^>]*accessory/
    )
    expect(source('apps/extension/src/sidepanel/App.tsx')).not.toContain('accessory')
  })
})
