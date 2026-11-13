// @vitest-environment jsdom
/**
 * 询问挂着时的输入框（jsdom）：这里只发消息，回答询问在卡片最后一行（OtherAnswerRow）。卡片搬进对话流之后语义色是那张卡片
 * 自己的 —— 输入卡片的描边只在询问面板长在它里面时（笔记本的 accessory）才换。
 *
 *   IA-1/2 没有 accessory：描边中性
 *   IA-3   有 accessory：描边按种类换色
 *   IA-4   有 accessory、没有询问：中性
 *   IA-8   + 添加的敏感信息：胶囊 + steer 带着 secrets，不答卡片，输入框清空
 *   IA-9   运行中有询问（审批 / 选择题 / 第二条在前台）回车：steer 一次，respondToInput 0 次，输入框清空，询问还在 store
 *   IA-10  运行中有询问：追加那一档照常；触屏：普通队列键，没有投「其它」的键
 *   IA-11  运行中有询问：提示语是 placeholderSteer（两种密度）；空闲有询问：普通提示语
 *   IA-12  空闲有询问，回车：prompt 一次，不答卡片
 *
 * 后端是假的 `window.api`（同 inputAreaQueue）；i18n 走真 en 资源；不写 JSX。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
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

import {
  applySessionView,
  selectActivePendingInput,
  selectPendingInputs,
  useChatStore
} from '../../../stores/chatStore'
import { useModelCatalogStore } from '../../../stores/modelCatalogStore'
import { InputArea, type InputAreaProps } from '../InputArea'
import { ChatHostContext, type ChatHostValue } from '../../../host/chatHostContext'
import { V, resetStore, store } from '../../../__tests__/support/views'
import { addSecretChip, clickOn, fakeLink } from '../../../__tests__/support/sendFailure'

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
const CHOICE: InputRequest = {
  id: 'r3',
  kind: 'choice',
  toolName: 'ask',
  question: 'Which?',
  options: [{ label: 'A', description: '' }],
  createdAt: 2
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
  followUp: ReturnType<typeof vi.fn>
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
    followUp: vi.fn(async () => ({ success: true })),
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

async function mount(
  asks: InputRequest[],
  props: InputAreaProps = {},
  opts: { touch?: boolean; state?: 'busy' | 'idle' } = {}
): Promise<void> {
  act(() => applySessionView('s1', V('s1', { run: { state: opts.state ?? 'busy' }, asks })))
  await act(async () => {
    const Area = InputArea as (p: InputAreaProps) => React.JSX.Element
    const area = createElement(Area, { inline: true, ...props })
    root.render(
      opts.touch
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

const textarea = (): HTMLTextAreaElement =>
  container.querySelector<HTMLTextAreaElement>('textarea:not([data-other-input])')!
/** 输入卡片（描边那一层） */
const card = (): HTMLElement => textarea().closest<HTMLElement>('.rounded-2xl')!
const cardClasses = (): string[] => card().className.split(/\s+/)
async function type(value: string): Promise<void> {
  const el = textarea()
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(el, value)
    el.selectionStart = el.selectionEnd = value.length
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await flush()
}
async function pressEnter(): Promise<void> {
  await act(async () => {
    textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  await flush()
}

const tiers = (): Array<string | undefined> =>
  [...container.querySelectorAll<HTMLButtonElement>('[data-queue-tier]')].map(
    (b) => b.dataset.queueTier
  )

const NEUTRAL = 'border-border-secondary/40'
const accessory = createElement('div', { 'data-accessory': '' })

describe('描边', () => {
  it('IA-1 审批、没有 accessory：描边中性，没有 ring', async () => {
    await mount([ASK])
    await type('x')
    expect(cardClasses()).toContain(NEUTRAL)
    expect(card().className).not.toContain('warning')
    expect(card().className).not.toContain('ring-')
  })

  it('IA-2 选择题、没有 accessory：描边中性，没有 ring', async () => {
    await mount([CHOICE])
    await type('x')
    expect(cardClasses()).toContain(NEUTRAL)
    expect(card().className).not.toContain('accent/45')
    expect(card().className).not.toContain('ring-')
  })

  it.each([
    ['审批', ASK, ['border-warning/45', 'ring-warning/10']],
    ['选择题', CHOICE, ['border-accent/45', 'ring-accent/10']]
  ] as const)('IA-3 %s、有 accessory（笔记本）：描边换色', async (_label, request, classes) => {
    await mount([request], { accessory })
    expect(cardClasses()).toEqual(expect.arrayContaining([...classes]))
    expect(container.querySelector('[data-accessory]')).not.toBeNull()
  })

  it('IA-4 有 accessory、没有询问：中性', async () => {
    await mount([], { accessory })
    expect(cardClasses()).toContain(NEUTRAL)
    expect(card().className).not.toContain('warning')
  })
})

describe('提示语', () => {
  it.each<['compact' | 'touch', string, InputRequest[]]>([
    ['compact', '审批', [ASK]],
    ['compact', '选择题', [CHOICE]],
    ['touch', '审批', [ASK]],
    ['touch', '选择题', [CHOICE]]
  ])('IA-11 %s 运行中、%s：placeholderSteer，不是卡片那两句', async (density, _label, asks) => {
    await mount(asks, {}, { touch: density === 'touch' })
    expect(textarea().placeholder).toBe(en.input.placeholderSteer)
  })

  it('IA-11 桌面空闲有询问：普通提示语', async () => {
    await mount([ASK], {}, { state: 'idle' })
    expect(textarea().placeholder).not.toBe(en.input.placeholderSteer)
    expect(textarea().placeholder).not.toBe(en.pendingInputs.otherPlaceholderAsk)
    expect(textarea().placeholder).not.toBe(en.pendingInputs.otherPlaceholderChoice)
    expect([en.input.placeholder, en.input.placeholderFiles, en.input.placeholderVision]).toContain(
      textarea().placeholder
    )
  })

  it('IA-11 触屏空闲有询问：普通提示语', async () => {
    await mount([ASK], {}, { state: 'idle', touch: true })
    expect(textarea().placeholder).toBe(en.input.placeholderTouch)
  })
})

describe('输入框只发消息', () => {
  it.each<[string, InputRequest[], string | null]>([
    ['审批', [ASK], null],
    ['选择题', [CHOICE], null],
    ['第二条在前台', [ASK, ASK2], 'r2']
  ])(
    'IA-9 运行中有询问（%s）回车：steer 一次，不答卡片，询问还在',
    async (_label, asks, active) => {
      await mount(asks)
      if (active) act(() => store().setActiveInputId('s1', active))
      await type('keep going')
      await pressEnter()
      expect(agent.steer).toHaveBeenCalledTimes(1)
      expect(agent.steer.mock.calls[0]![0]).toEqual({
        sessionId: 's1',
        text: 'keep going',
        secrets: []
      })
      expect(agent.respondToInput).not.toHaveBeenCalled()
      expect(agent.prompt).not.toHaveBeenCalled()
      expect(textarea().value).toBe('')
      expect(selectPendingInputs(store()).map((r) => r.id)).toEqual(asks.map((r) => r.id))
      expect(selectActivePendingInput(store())?.id).toBe(active ?? asks[0]!.id)
    }
  )

  it('IA-10 运行中有询问：两个档位都在；追加走 followUp，不答卡片', async () => {
    await mount([ASK])
    await type('after this')
    expect(tiers()).toEqual(['steer', 'followUp'])
    await clickOn(container.querySelector('[data-queue-tier="followUp"]')!)
    expect(agent.followUp).toHaveBeenCalledTimes(1)
    expect(agent.followUp.mock.calls[0]![0]).toEqual({
      sessionId: 's1',
      text: 'after this',
      secrets: []
    })
    expect(agent.steer).not.toHaveBeenCalled()
    expect(agent.respondToInput).not.toHaveBeenCalled()
    expect(selectPendingInputs(store()).map((r) => r.id)).toEqual(['r1'])
  })

  it('IA-10 触屏运行中有询问：普通队列键（没字时收起），没有投「其它」的键', async () => {
    await mount([ASK], {}, { touch: true })
    const send = (): Element | null => container.querySelector(`button[title="${en.input.send}"]`)
    const steer = (): HTMLButtonElement | null =>
      container.querySelector<HTMLButtonElement>(`button[aria-label="${en.queue.steer}"]`)
    expect(send()).toBeNull()
    expect(steer()).toBeNull()

    await type('on the phone')
    expect(send()).toBeNull()
    await clickOn(steer()!)
    expect(agent.steer).toHaveBeenCalledTimes(1)
    expect(agent.respondToInput).not.toHaveBeenCalled()
    expect(selectPendingInputs(store()).map((r) => r.id)).toEqual(['r1'])
  })

  it('IA-10 文案：submitOther 已从词表移除', () => {
    expect(Object.keys(en.pendingInputs)).not.toContain('submitOther')
  })

  it('IA-12 空闲有询问，回车：prompt 一次，不答卡片', async () => {
    await mount([ASK], {}, { state: 'idle' })
    await type('a new message')
    await pressEnter()
    expect(agent.prompt).toHaveBeenCalledTimes(1)
    expect(agent.prompt.mock.calls[0]![0]).toMatchObject({ sessionId: 's1', text: 'a new message' })
    expect(agent.respondToInput).not.toHaveBeenCalled()
    expect(agent.steer).not.toHaveBeenCalled()
    expect(textarea().value).toBe('')
  })

  it('IA-8 + 添加的敏感信息：胶囊跟着 steer 带上 secrets，不答卡片，输入框清空', async () => {
    await mount([ASK])
    await addSecretChip(container, 'hunter2-value')
    await flush()
    expect(container.querySelector('[data-token-kind="secret"]')).not.toBeNull()
    await type(`${textarea().value} use this`)
    await pressEnter()
    expect(agent.respondToInput).not.toHaveBeenCalled()
    expect(agent.steer).toHaveBeenCalledTimes(1)
    const sent = agent.steer.mock.calls[0]![0] as {
      text: string
      secrets: Array<{ value: string }>
    }
    expect(sent.secrets.map((x) => x.value)).toEqual(['hunter2-value'])
    expect(sent.text).toContain('hunter2-value')
    expect(textarea().value).toBe('')
  })
})
