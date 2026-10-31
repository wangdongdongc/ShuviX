// @vitest-environment jsdom
/**
 * 任务列表在输入框卡片里的位置（jsdom，docs/task-list-design.md §3.4）：
 *
 *   TLU-16  卡片里 `[data-task-list]` 排在待处理输入（accessory）与 `[data-queue-panel]` 之前
 *   TLU-17  旧格式会话（legacy 视图）的卡片里没有任务列表，哪怕消息里有成功的列表调用
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

describe('任务列表在输入框卡片里的位置', () => {
  it('TLU-16 [data-task-list] 排在待处理输入（accessory）与 [data-queue-panel] 之前', async () => {
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

    const list = taskList()
    const accessory = container.querySelector('[data-test-accessory]')
    const queue = container.querySelector('[data-queue-panel]')
    expect(list).not.toBeNull()
    expect(accessory).not.toBeNull()
    expect(queue).not.toBeNull()
    expect(list!.getAttribute('data-task-list-phase')).toBe('running')
    expect(precedes(list!, accessory!)).toBe(true)
    expect(precedes(accessory!, queue!)).toBe(true)
    // 三者同在卡片本体里、是兄弟（不是谁套在谁里面）
    expect(list!.parentElement).toBe(accessory!.parentElement)
    expect(list!.parentElement).toBe(queue!.parentElement)
  })

  it('TLU-17 legacy 视图：卡片里只有只读横幅，没有任务列表（消息里有成功的列表调用也一样）', async () => {
    act(() =>
      applySessionView(
        's1',
        V('s1', {
          source: 'legacy',
          capabilities: { send: false, rollback: false, continue: false },
          messages: WITH_LIST,
          run: { state: 'busy' }
        })
      )
    )
    await mountInput()
    expect(container.querySelector('[data-legacy-banner]')).not.toBeNull()
    expect(taskList()).toBeNull()

    // 对照：同样的消息换成 durable 视图 → 列表出现
    act(() => applySessionView('s1', V('s1', { messages: WITH_LIST, run: { state: 'busy' } })))
    await flush()
    expect(taskList()).not.toBeNull()
  })
})
