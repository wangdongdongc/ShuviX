// @vitest-environment jsdom
/**
 * 输入框卡片里没有任务列表（jsdom，docs/task-list-design.md §3.4）：2026-11-07 起列表在对话流末尾
 * （Conversation 的 Footer，见 conversationScroll.dom.test.tsx 的 CS-17）；笔记本经 thread 插槽自己放进卡片。
 *
 *   TLU-16  会话在跑、消息里有成功的列表调用：卡片里有 accessory 与 `[data-queue-panel]`，没有 `[data-task-list]`
 *   TLU-17  经 thread 插槽放进来的列表（笔记本的做法）排在 accessory 之前
 *
 * 后端是假的 `window.api`（同 inputAreaQueue.dom.test.tsx 的做法）；状态只经 `applySessionView` 写。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type { AvailableModel, ProviderInfo } from '@shuvix/chat-protocol/types/provider'
import type { ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'
import { TASK_LIST_TOOL_NAME } from '@shuvix/chat-protocol/taskList'

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
import { TaskListPanel } from '../TaskListPanel'
import { V, assistant, resetStore, text, toolBlock, user } from '../../../__tests__/support/views'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const P = 'prov-1'
const M = 'model-m'

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
      prompt: vi.fn(async () => ({ success: true })),
      steer: vi.fn(async () => ({ success: true })),
      followUp: vi.fn(async () => ({ success: true })),
      withdrawQueued: vi.fn(async () => ({ result: 'aborted' })),
      abort: vi.fn(async () => ({ success: true })),
      respondToInput: vi.fn(async () => ({ success: true }))
    },
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

/** 一个请求：用户消息 + 一张发了列表（同一条消息里还有一次真的调用）的卡 */
const WITH_LIST: ChatMessage[] = [
  user('u1', 'please'),
  assistant('a1', [
    text('starting'),
    toolBlock(
      'p1',
      TASK_LIST_TOOL_NAME,
      {
        items: [
          { content: 'Read the code', status: 'in_progress' },
          { content: 'Write the fix', status: 'pending' }
        ]
      },
      { result: 'Plan shown (2 steps).' }
    ),
    toolBlock('r1', 'read', {}, { result: 'x' })
  ])
]

let container: HTMLDivElement
let root: Root

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function mountInput(accessory?: React.ReactNode): Promise<void> {
  await act(async () => {
    const Area = InputArea as (props: InputAreaProps) => React.JSX.Element
    root.render(createElement(Area, { inline: true, accessory }))
  })
  await flush()
}

const taskList = (): HTMLElement | null => container.querySelector<HTMLElement>('[data-task-list]')

/** a 在文档里排在 b 之前 */
const precedes = (a: Element, b: Element): boolean =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    showSupportNotice: false
  })
  Element.prototype.scrollIntoView = vi.fn()
})

beforeEach(() => {
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
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

describe('输入框卡片与任务列表', () => {
  it('TLU-16 会话在跑、消息里有成功的列表调用：卡片里有待处理输入，没有任务列表（排着的输入也不在卡片里）', async () => {
    act(() =>
      applySessionView(
        's1',
        V('s1', {
          messages: WITH_LIST,
          run: { state: 'busy' },
          queue: [{ submissionId: 1, mode: 'followUp', text: 'later', imageCount: 0 }]
        })
      )
    )
    await mountInput(createElement('div', { 'data-test-accessory': '' }, 'ask'))

    expect(container.querySelector('[data-test-accessory]')).not.toBeNull()
    expect(container.querySelector('[data-queue-row]')).toBeNull()
    expect(taskList()).toBeNull()
  })

  it('TLU-17 笔记本的做法：经 thread 插槽放进来的列表排在待处理输入之前', async () => {
    act(() => applySessionView('s1', V('s1', { messages: WITH_LIST, run: { state: 'busy' } })))
    await act(async () => {
      const Area = InputArea as (props: InputAreaProps) => React.JSX.Element
      root.render(
        createElement(Area, {
          inline: true,
          thread: createElement(TaskListPanel, { placement: 'composer' }),
          accessory: createElement('div', { 'data-test-accessory': '' }, 'ask')
        })
      )
    })
    await flush()

    const list = taskList()
    const accessory = container.querySelector('[data-test-accessory]')
    expect(list).not.toBeNull()
    expect(list!.getAttribute('data-task-list-placement')).toBe('composer')
    expect(precedes(list!, accessory!)).toBe(true)
  })
})
