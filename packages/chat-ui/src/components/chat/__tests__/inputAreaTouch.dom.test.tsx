// @vitest-environment jsdom
/**
 * 输入卡片的触屏密度（ChatHost `density: 'touch'`，手机布局的 web 客户端；jsdom）：
 *
 *   T1  触屏 + 能看图：工具行第一个子节点是「+」（`data-attach-button`，aria-label / title = input.attach），
 *       在模型触发器之前；背后一个隐藏的 `<input type=file accept="image/*" multiple data-attach-input>`，
 *       点「+」= 点它一次
 *   T2  选好的文件走粘贴那条路：只收图片（按次序），收完把 input 的值清空（同一张图再选也要触发 change）；
 *       空选择什么都不加
 *   T3  「+」只在模型能看图、且这条会话能发时出现（两种密度都一样）；挂着时模型换成不能看图 → 消失
 *   T4  占位：触屏空闲 = input.placeholderTouch（能不能看图都一样）；运行中 = placeholderSteer；有待答的审批 =
 *       pendingInputs.otherPlaceholderAsk；桌面照旧（placeholderVision / placeholder）
 *   T4b （两种密度）待答的是审批 → otherPlaceholderAsk，是选项题 → otherPlaceholderChoice；两条都挂着时跟着选中项
 *       （setActiveInputId）换，换回来也跟着回来
 *   K1  （桌面）输入卡片顶上挂着审批卡（accessory = PendingInputsPanel）：焦点在输入框里按 1 → 不拦、不答、卡片
 *       还在；离开输入框（焦点回 body）再按 1 → 答「允许这一次」
 *   K2  同样挂着选项题：输入框里按 1 什么都不勾，确认键仍禁用
 *   K3  触屏、焦点不在输入框：body 上按 1 什么都不做
 *   T5  触屏回车 = 换行：不拦、不发；Shift+回车同样；Ctrl / ⌘ + 回车拦下并发出；发送键照发；运行中、有询问时
 *       回车同样什么都不发
 *   T6  斜杠命令弹层照旧吃回车（选中命令成芯片，不发）
 *   T7  触屏运行中没打字：只有停止（aria-label input.stopGen），没有队列档位、没有发送键；只有空白也一样
 *   T8  打了字：只有一颗「立即」（steer，aria-label queue.steer，title queue.touchSendHint，没有字），在停止
 *       之前；点它 → steer 一次、输入清空、那颗收起
 *   T9  长按（contextmenu）「立即」→ 拦下、弹 `[data-queue-menu]`：两行 steer / followUp，各带名字 + 说明；
 *       不调 IPC；选一行 → 发那一档、菜单关
 *   T10 菜单不自己冒出来：一敲键就关、改回原字也不回来；清空 → 连「立即」一起收；运行起停 → 关；mousedown
 *       在「立即」上不关、在外面关；停止键上长按什么都不弹
 *   T11 触屏 + 待答询问：一颗「投其它」（title pendingInputs.submitOther），空时禁用；没有档位；长按不弹菜单；
 *       投出去是 respondToInput {kind:'other'}，不 steer
 *   C1  桌面运行中：右键「立即」不弹菜单、不拦；两个档位照旧带字
 *   R1  用量环（两种密度）：点一下出数字（block）、再点收起；开着时 mousedown 在外面收、在环上不收；
 *       没有上限也没有用量 → 不画环
 *   T12 （MA-U20）待发附图的 ✕（aria-label common.delete）：触屏常驻、放大（w-6 h-6，图标 13，没有 opacity-0 /
 *       group-hover/img）；桌面 w-4 h-4、悬浮才显形（opacity-0 group-hover/img:opacity-100，图标 10）；两种密度
 *       点第一张的 ✕ 都只删第一张
 *
 * 后端是假的 `window.api`（同 inputAreaQueue.dom.test.tsx）；状态只经 `applySessionView` 写。触屏密度经
 * 真的 `ChatHostContext`（InputArea 从 `../../host/chatHostContext` 读 `useChatDensity`）；`useChatHost`
 * 仍由被顶掉的包入口给。`fileToImageData` 等 Image.onload（jsdom 里永远不来），顶成直接回一份。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type { AvailableModel, ProviderInfo } from '@shuvix/chat-protocol/types/provider'
import type { InputRequest } from '@shuvix/chat-protocol/types/inputRequest'

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

vi.mock('../../../utils/imageProcessing', () => ({
  fileToImageData: async (f: File) => ({
    data: f.name,
    mimeType: f.type,
    preview: 'data:' + f.type
  })
}))

import { applySessionView, useChatStore } from '../../../stores/chatStore'
import { useModelCatalogStore } from '../../../stores/modelCatalogStore'
import { InputArea, type InputAreaProps } from '../InputArea'
import { PendingInputsPanel } from '../PendingInputsPanel'
import { V, resetStore, store } from '../../../__tests__/support/views'
import {
  ChatHostContext,
  type ChatDensity,
  type ChatHostValue
} from '../../../host/chatHostContext'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const P = 'prov-1'
const M = 'model-m'

interface FakeAgent {
  init: () => Promise<unknown>
  prompt: ReturnType<typeof vi.fn>
  steer: ReturnType<typeof vi.fn>
  followUp: ReturnType<typeof vi.fn>
  abort: ReturnType<typeof vi.fn>
  respondToInput: ReturnType<typeof vi.fn>
}

let agent: FakeAgent
let updateEnabledTools: ReturnType<typeof vi.fn>

function buildApi(): Record<string, unknown> {
  agent = {
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
    abort: vi.fn(async () => ({ success: true })),
    respondToInput: vi.fn(async () => ({ success: true }))
  }
  updateEnabledTools = vi.fn(async () => ({ success: true }))
  return {
    session: { list: async () => [], updateEnabledTools },
    agent,
    tools: { list: async () => [] },
    files: { scan: async () => ({ root: null, paths: [] }) },
    mentions: { listKnowledgeEntries: async () => [] },
    events: { subscribe: () => () => {} },
    app: { openSettings: () => {} }
  }
}

/** 斜杠命令（同 inputAreaWelcomeSend.dom.test.tsx） */
const CMD = {
  commandId: 'cmd',
  name: 'Cmd',
  description: 'a command',
  template: 'Run: $ARGUMENTS',
  requiredTools: ['skill:req', 'skill:a']
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

const ASK: InputRequest = {
  id: 'r1',
  kind: 'ask',
  toolName: 'bash',
  command: 'ls',
  createdAt: 0
}

const CHOICE: InputRequest = {
  id: 'r2',
  kind: 'choice',
  toolName: 'ask',
  question: 'Which?',
  options: [
    { label: 'A', description: '' },
    { label: 'B', description: '' }
  ],
  createdAt: 1
}

let container: HTMLDivElement
let root: Root

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

/**
 * 挂输入卡片；`density` 给了就包一层宿主上下文（手机布局给 'touch'），不给 = 没有 Provider（compact）；
 * `accessory` = 卡片顶格（实际产品里是 PendingInputsPanel）
 */
async function mountInput(
  opts: { density?: ChatDensity; accessory?: React.ReactNode } = {}
): Promise<void> {
  await act(async () => {
    const Area = InputArea as (props: InputAreaProps) => React.JSX.Element
    const area = createElement(Area, { inline: true, accessory: opts.accessory })
    root.render(
      opts.density
        ? createElement(
            ChatHostContext.Provider,
            { value: { density: opts.density } as ChatHostValue },
            area
          )
        : area
    )
  })
  await flush()
}

const TOUCH = { density: 'touch' as const }

const textarea = (): HTMLTextAreaElement => container.querySelector('textarea')!

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

/** 按回车（可带修饰键）；返回 dispatchEvent 的结果：false = 被拦下（preventDefault） */
async function pressEnter(
  mods: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean } = {}
): Promise<boolean> {
  let result = true
  await act(async () => {
    result = textarea().dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...mods })
    )
  })
  await flush()
  return result
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    ;(el as HTMLElement).click()
  })
  await flush()
}

async function mousedown(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
  })
  await flush()
}

/** 长按（手机外壳把按住半秒变成 contextmenu）/ 右键；返回事件有没有被拦下 */
async function contextMenu(el: Element): Promise<boolean> {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
  await act(async () => {
    el.dispatchEvent(event)
  })
  await flush()
  return event.defaultPrevented
}

function busy(extra: Parameters<typeof V>[1] = {}): void {
  act(() => applySessionView('s1', V('s1', { run: { state: 'busy' }, ...extra })))
}
function idle(extra: Parameters<typeof V>[1] = {}): void {
  act(() => applySessionView('s1', V('s1', { run: { state: 'idle' }, ...extra })))
}

const tiers = (): HTMLButtonElement[] => [
  ...container.querySelectorAll<HTMLButtonElement>('[data-queue-tier]')
]
const menu = (): HTMLElement | null => container.querySelector<HTMLElement>('[data-queue-menu]')
/** 输入卡片上的那颗「立即」（菜单开着时菜单里还有一颗 steer，不认它） */
const steerButton = (): HTMLButtonElement | null =>
  tiers().find((b) => b.dataset.queueTier === 'steer' && !b.closest('[data-queue-menu]')) ?? null
const menuRow = (name: 'steer' | 'followUp'): HTMLButtonElement => {
  const el = menu()?.querySelector<HTMLButtonElement>(`[data-queue-tier="${name}"]`)
  if (!el) throw new Error(`queue menu row ${name} not rendered`)
  return el
}
const byAria = (label: string): HTMLButtonElement[] => [
  ...container.querySelectorAll<HTMLButtonElement>(`button[aria-label="${label}"]`)
]
const byTitle = (title: string): HTMLButtonElement[] => [
  ...container.querySelectorAll<HTMLButtonElement>(`button[title="${title}"]`)
]
const attachButton = (): HTMLButtonElement | null =>
  container.querySelector<HTMLButtonElement>('button[data-attach-button]')
const attachInput = (): HTMLInputElement | null =>
  container.querySelector<HTMLInputElement>('input[data-attach-input]')
const toolRow = (): HTMLElement => {
  const pickers = container.querySelector<HTMLElement>('[data-composer-pickers]')
  if (!pickers?.parentElement) throw new Error('composer tool row not rendered')
  return pickers.parentElement
}
const noIpc = (): void => {
  expect(agent.prompt).not.toHaveBeenCalled()
  expect(agent.steer).not.toHaveBeenCalled()
  expect(agent.followUp).not.toHaveBeenCalled()
  expect(agent.respondToInput).not.toHaveBeenCalled()
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
  idle()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

// ─── 附图「+」 ───────────────────────────────────────────────────────────────

describe('附图「+」', () => {
  it('TC-IA-T1 触屏 + 能看图：工具行第一个子节点是「+」、在模型触发器之前；隐藏的多选图片 input；点「+」= 点它一次', async () => {
    useChatStore.setState({ modelSupportsVision: true })
    await mountInput(TOUCH)
    const btn = attachButton()
    expect(btn).not.toBeNull()
    expect(toolRow().firstElementChild).toBe(btn)
    expect(btn!.getAttribute('aria-label')).toBe(en.input.attach)
    expect(btn!.title).toBe(en.input.attach)
    const trigger = container.querySelector('[data-model-trigger]')
    expect(trigger).not.toBeNull()
    expect(btn!.compareDocumentPosition(trigger!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    const input = attachInput()
    expect(input).not.toBeNull()
    expect(input!.type).toBe('file')
    expect(input!.getAttribute('accept')).toBe('image/*')
    expect(input!.multiple).toBe(true)
    expect(input!.hidden).toBe(true)

    const spy = vi.spyOn(input!, 'click').mockImplementation(() => {})
    await click(btn!)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('TC-IA-T2 选好的文件：只收图片（按次序）、收完清空 input 的值；再选一张 +1；空选择什么都不加', async () => {
    useChatStore.setState({ modelSupportsVision: true })
    await mountInput(TOUCH)
    const input = attachInput()!
    const valueSet = vi.fn()
    Object.defineProperty(input, 'value', { configurable: true, get: () => '', set: valueSet })
    const choose = async (files: File[]): Promise<void> => {
      Object.defineProperty(input, 'files', { configurable: true, value: files })
      await act(async () => {
        input.dispatchEvent(new Event('change', { bubbles: true }))
      })
      await flush()
    }
    const png = new File(['a'], 'a.png', { type: 'image/png' })
    const txt = new File(['n'], 'notes.txt', { type: 'text/plain' })
    const jpg = new File(['b'], 'b.jpg', { type: 'image/jpeg' })

    await choose([png, txt, jpg])
    expect(store().pendingImages.map((img) => [img.data, img.mimeType])).toEqual([
      ['a.png', 'image/png'],
      ['b.jpg', 'image/jpeg']
    ])
    expect(valueSet).toHaveBeenCalledTimes(1)
    expect(valueSet).toHaveBeenLastCalledWith('')

    await choose([png])
    expect(store().pendingImages).toHaveLength(3)
    expect(store().pendingImages[2]).toMatchObject({ data: 'a.png', mimeType: 'image/png' })
    expect(valueSet).toHaveBeenCalledTimes(2)

    await choose([])
    expect(store().pendingImages).toHaveLength(3)
    noIpc()
  })

  it.each<['compact' | 'touch']>([['compact'], ['touch']])(
    'TC-IA-T3 %s：不能看图 → 没有「+」；能看图 → 有；挂着时换成不能看图 → 没了；这条会话不能发（send:false）→ 没有',
    async (density) => {
      await mountInput(density === 'touch' ? TOUCH : {})
      expect(attachButton()).toBeNull()
      expect(attachInput()).toBeNull()

      act(() => useChatStore.setState({ modelSupportsVision: true }))
      await flush()
      expect(attachButton()).not.toBeNull()
      expect(attachInput()).not.toBeNull()

      act(() => useChatStore.setState({ modelSupportsVision: false }))
      await flush()
      expect(attachButton()).toBeNull()
      expect(attachInput()).toBeNull()

      act(() => useChatStore.setState({ modelSupportsVision: true }))
      idle({ capabilities: { send: false, rollback: true, continue: true } })
      await flush()
      expect(attachButton()).toBeNull()
      expect(attachInput()).toBeNull()
    }
  )
})

// ─── 占位文案 ────────────────────────────────────────────────────────────────

describe('占位文案', () => {
  it.each<[boolean]>([[true], [false]])(
    'TC-IA-T4 触屏空闲（能看图 = %s）→ input.placeholderTouch',
    async (vision) => {
      useChatStore.setState({ modelSupportsVision: vision })
      await mountInput(TOUCH)
      expect(textarea().placeholder).toBe(en.input.placeholderTouch)
    }
  )

  it('TC-IA-T4 触屏运行中 → placeholderSteer；有待答的审批 → pendingInputs.otherPlaceholderAsk', async () => {
    await mountInput(TOUCH)
    busy()
    await flush()
    expect(textarea().placeholder).toBe(en.input.placeholderSteer)
    busy({ asks: [ASK] })
    await flush()
    expect(textarea().placeholder).toBe(en.pendingInputs.otherPlaceholderAsk)
  })

  it.each<[boolean, string]>([
    [true, en.input.placeholderVision],
    [false, en.input.placeholder]
  ])('TC-IA-T4 桌面空闲（能看图 = %s）照旧', async (vision, expected) => {
    useChatStore.setState({ modelSupportsVision: vision })
    await mountInput()
    expect(textarea().placeholder).toBe(expected)
  })

  it.each<['compact' | 'touch']>([['compact'], ['touch']])(
    'TC-IA-T4b %s：审批 → otherPlaceholderAsk，选项题 → otherPlaceholderChoice；两条都在时跟着选中项换',
    async (density) => {
      await mountInput(density === 'touch' ? TOUCH : {})
      busy({ asks: [ASK] })
      await flush()
      expect(textarea().placeholder).toBe(en.pendingInputs.otherPlaceholderAsk)

      busy({ asks: [CHOICE] })
      await flush()
      expect(textarea().placeholder).toBe(en.pendingInputs.otherPlaceholderChoice)

      busy({ asks: [ASK, CHOICE] })
      await flush()
      expect(textarea().placeholder).toBe(en.pendingInputs.otherPlaceholderAsk)
      act(() => useChatStore.getState().setActiveInputId('s1', CHOICE.id))
      await flush()
      expect(textarea().placeholder).toBe(en.pendingInputs.otherPlaceholderChoice)
      act(() => useChatStore.getState().setActiveInputId('s1', ASK.id))
      await flush()
      expect(textarea().placeholder).toBe(en.pendingInputs.otherPlaceholderAsk)
    }
  )
})

// ─── 数字键与输入框 ──────────────────────────────────────────────────────────

describe('卡片顶上的选项行：输入框里打的数字不选行', () => {
  /** 在目标上派发一次 keydown（bubbles + cancelable + composed）；返回 dispatchEvent 的结果：false = 被拦下 */
  async function pressKey(key: string, target: EventTarget): Promise<boolean> {
    let result = true
    await act(async () => {
      result = target.dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, composed: true })
      )
    })
    await flush()
    return result
  }
  const askCard = (): Element | null => container.querySelector('[data-ask-card]')
  const choiceRows = (): string[] =>
    [...container.querySelectorAll<HTMLButtonElement>('[data-choice-option]')].map(
      (r) => r.getAttribute('aria-pressed') ?? ''
    )
  const confirmButton = (): HTMLButtonElement => {
    const el = container.querySelector<HTMLButtonElement>('[data-choice-confirm]')
    if (!el) throw new Error('confirm button not rendered')
    return el
  }
  async function blurComposer(): Promise<void> {
    await act(async () => {
      textarea().blur()
    })
    expect(document.activeElement).toBe(document.body)
  }

  it('TC-IA-K1 桌面：输入框里按 1 不拦、不答、卡片还在；离开输入框再按 1 → 允许这一次', async () => {
    const onResponse = vi.fn()
    await mountInput({ accessory: createElement(PendingInputsPanel, { onResponse }) })
    busy({ asks: [ASK] })
    await flush()
    expect(askCard()).not.toBeNull()

    textarea().focus()
    expect(document.activeElement).toBe(textarea())
    expect(await pressKey('1', textarea())).toBe(true)
    expect(onResponse).not.toHaveBeenCalled()
    expect(agent.respondToInput).not.toHaveBeenCalled()
    expect(askCard()).not.toBeNull()

    await blurComposer()
    expect(await pressKey('1', document.body)).toBe(false)
    expect(onResponse.mock.calls).toEqual([['r1', { kind: 'ask', allowed: true }]])
  })

  it('TC-IA-K2 桌面、选项题：输入框里按 1 什么都不勾，确认键仍禁用', async () => {
    const onResponse = vi.fn()
    await mountInput({ accessory: createElement(PendingInputsPanel, { onResponse }) })
    busy({ asks: [CHOICE] })
    await flush()
    expect(choiceRows()).toEqual(['false', 'false'])

    textarea().focus()
    expect(await pressKey('1', textarea())).toBe(true)
    expect(choiceRows()).toEqual(['false', 'false'])
    expect(confirmButton().disabled).toBe(true)
    expect(store().sessionInputDrafts.s1?.[CHOICE.id]).toEqual({ selected: [] })
    expect(onResponse).not.toHaveBeenCalled()
  })

  it('TC-IA-K3 触屏、焦点不在输入框：body 上按 1 什么都不做', async () => {
    const onResponse = vi.fn()
    await mountInput({ ...TOUCH, accessory: createElement(PendingInputsPanel, { onResponse }) })
    busy({ asks: [ASK] })
    await flush()
    expect(askCard()).not.toBeNull()
    await blurComposer()
    expect(await pressKey('1', document.body)).toBe(true)
    expect(onResponse).not.toHaveBeenCalled()
    expect(agent.respondToInput).not.toHaveBeenCalled()
    expect(askCard()).not.toBeNull()
  })
})

// ─── 回车 ────────────────────────────────────────────────────────────────────

describe('触屏的回车是换行', () => {
  it('TC-IA-T5 空闲：回车、Shift+回车都不拦、不发，字还在', async () => {
    await mountInput(TOUCH)
    await type('hello')
    expect(await pressEnter()).toBe(true)
    expect(await pressEnter({ shiftKey: true })).toBe(true)
    noIpc()
    expect(store().inputText).toBe('hello')
  })

  it.each<['ctrlKey' | 'metaKey']>([['ctrlKey'], ['metaKey']])(
    'TC-IA-T5 空闲：%s + 回车 → 拦下、agent.prompt 恰一次',
    async (mod) => {
      await mountInput(TOUCH)
      await type('hello')
      expect(await pressEnter({ [mod]: true })).toBe(false)
      expect(agent.prompt).toHaveBeenCalledTimes(1)
      expect(agent.prompt.mock.calls[0]![0]).toMatchObject({ sessionId: 's1', text: 'hello' })
      expect(store().inputText).toBe('')
    }
  )

  it('TC-IA-T5 空闲：点发送键 → agent.prompt 恰一次', async () => {
    await mountInput(TOUCH)
    await type('hello')
    const [send] = byAria(en.input.send)
    expect(send).toBeDefined()
    await click(send!)
    expect(agent.prompt).toHaveBeenCalledTimes(1)
    expect(agent.prompt.mock.calls[0]![0]).toMatchObject({ sessionId: 's1', text: 'hello' })
  })

  it('TC-IA-T5 运行中打了字：回车不拦，不 steer / followUp / prompt', async () => {
    await mountInput(TOUCH)
    busy()
    await flush()
    await type('steer me')
    expect(await pressEnter()).toBe(true)
    noIpc()
    expect(store().inputText).toBe('steer me')
  })

  it('TC-IA-T5 运行中有待答的询问：回车不投「其它」', async () => {
    await mountInput(TOUCH)
    busy({ asks: [ASK] })
    await flush()
    await type('do it differently')
    expect(await pressEnter()).toBe(true)
    noIpc()
  })

  it('TC-IA-T6 斜杠命令弹层照旧吃回车：选中 /cmd 成芯片，不发', async () => {
    useChatStore.setState({ slashCommands: [CMD] })
    await mountInput(TOUCH)
    await type('/cm')
    expect(await pressEnter()).toBe(false)
    expect(container.querySelector('[data-token-display="/cmd"]')).not.toBeNull()
    expect(store().inputText).toBe('')
    expect(agent.prompt).not.toHaveBeenCalled()
  })
})

// ─── 运行中的发送出口 ────────────────────────────────────────────────────────

describe('触屏运行中：一颗「立即」，长按出两档', () => {
  it('TC-IA-T7 没打字：只有停止；只有空白也一样', async () => {
    await mountInput(TOUCH)
    busy()
    await flush()
    expect(tiers()).toEqual([])
    expect(byAria(en.input.stopGen)).toHaveLength(1)
    expect(byAria(en.input.send)).toHaveLength(0)
    expect(byTitle(en.input.send)).toHaveLength(0)
    await type('   ')
    expect(tiers()).toEqual([])
    expect(byAria(en.input.stopGen)).toHaveLength(1)
  })

  it('TC-IA-T8 打了字：只有一颗 steer（aria-label / title、没有字），在停止之前；点它 → steer 一次、输入清空、那颗收起', async () => {
    await mountInput(TOUCH)
    busy()
    await flush()
    await type('steer me')
    expect(tiers().map((b) => b.dataset.queueTier)).toEqual(['steer'])
    const steer = steerButton()!
    expect(steer.getAttribute('aria-label')).toBe(en.queue.steer)
    expect(steer.title).toBe(en.queue.touchSendHint)
    expect(steer.textContent).toBe('')
    expect(container.querySelector('[data-queue-tier="followUp"]')).toBeNull()
    const [stop] = byAria(en.input.stopGen)
    expect(stop).toBeDefined()
    // 同一个按钮簇里，「立即」在停止前面
    expect(stop!.parentElement!.contains(steer)).toBe(true)
    expect(steer.compareDocumentPosition(stop!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    await click(steer)
    expect(agent.steer).toHaveBeenCalledTimes(1)
    expect(agent.steer.mock.calls[0]![0]).toEqual({ sessionId: 's1', text: 'steer me' })
    expect(agent.followUp).not.toHaveBeenCalled()
    expect(store().inputText).toBe('')
    expect(steerButton()).toBeNull()
  })

  it.each<['steer' | 'followUp']>([['steer'], ['followUp']])(
    'TC-IA-T9 长按「立即」→ 拦下、菜单两行带字、不调 IPC；选 %s → 只发那一档、菜单关',
    async (name) => {
      await mountInput(TOUCH)
      busy()
      await flush()
      await type('hold me')
      expect(await contextMenu(steerButton()!)).toBe(true)
      expect(menu()).not.toBeNull()
      const rows = [...menu()!.querySelectorAll<HTMLButtonElement>('[data-queue-tier]')]
      expect(rows.map((r) => r.dataset.queueTier)).toEqual(['steer', 'followUp'])
      expect(menuRow('steer').textContent).toBe(en.queue.steer + en.queue.steerHint)
      expect(menuRow('followUp').textContent).toBe(en.queue.followUp + en.queue.followUpHint)
      noIpc()

      await click(menuRow(name))
      const other = name === 'steer' ? agent.followUp : agent.steer
      expect(agent[name]).toHaveBeenCalledTimes(1)
      expect(agent[name].mock.calls[0]![0]).toEqual({ sessionId: 's1', text: 'hold me' })
      expect(other).not.toHaveBeenCalled()
      expect(agent.prompt).not.toHaveBeenCalled()
      expect(menu()).toBeNull()
    }
  )

  it('TC-IA-T10 菜单从不自己冒出来', async () => {
    await mountInput(TOUCH)
    busy()
    await flush()
    await type('abc')
    await contextMenu(steerButton()!)
    expect(menu()).not.toBeNull()

    // 一敲键就关；改回原字也不回来
    await type('abcd')
    expect(menu()).toBeNull()
    await type('abc')
    expect(menu()).toBeNull()
    // 清空：「立即」与菜单一起收；再打字，「立即」回来、菜单不回来
    await type('')
    expect(steerButton()).toBeNull()
    expect(menu()).toBeNull()
    await type('abc')
    expect(steerButton()).not.toBeNull()
    expect(menu()).toBeNull()

    // 运行停了 → 关；再跑起来、字还是那段 → 不回来
    await contextMenu(steerButton()!)
    expect(menu()).not.toBeNull()
    idle()
    await flush()
    expect(menu()).toBeNull()
    expect(steerButton()).toBeNull()
    busy()
    await flush()
    expect(store().inputText).toBe('abc')
    expect(steerButton()).not.toBeNull()
    expect(menu()).toBeNull()

    // mousedown 在「立即」上不关，在外面关
    await contextMenu(steerButton()!)
    expect(menu()).not.toBeNull()
    await mousedown(steerButton()!)
    expect(menu()).not.toBeNull()
    await mousedown(document.body)
    expect(menu()).toBeNull()

    // 停止键上长按什么都不弹
    await contextMenu(byAria(en.input.stopGen)[0]!)
    expect(menu()).toBeNull()
    noIpc()
  })

  it('TC-IA-T11 有待答的询问：一颗「投其它」，空时禁用；没有档位；长按不弹菜单；投出去是 respondToInput other', async () => {
    await mountInput(TOUCH)
    busy({ asks: [ASK] })
    await flush()
    const buttons = byTitle(en.pendingInputs.submitOther)
    expect(buttons).toHaveLength(1)
    expect(buttons[0]!.disabled).toBe(true)
    expect(tiers()).toEqual([])

    await type('other text')
    const submit = byTitle(en.pendingInputs.submitOther)[0]!
    expect(submit.disabled).toBe(false)
    expect(tiers()).toEqual([])
    await contextMenu(submit)
    expect(menu()).toBeNull()

    await click(submit)
    expect(agent.respondToInput).toHaveBeenCalledTimes(1)
    expect(agent.respondToInput.mock.calls[0]![0]).toMatchObject({
      sessionId: 's1',
      requestId: 'r1',
      response: { kind: 'other', text: 'other text' }
    })
    expect(agent.steer).not.toHaveBeenCalled()
    expect(agent.followUp).not.toHaveBeenCalled()
  })

  it('TC-IA-C1 桌面运行中：右键「立即」不弹菜单、不拦；两档照旧带字', async () => {
    await mountInput()
    busy()
    await flush()
    await type('desk')
    expect(tiers().map((b) => [b.dataset.queueTier, b.textContent])).toEqual([
      ['steer', en.queue.steer],
      ['followUp', en.queue.followUp]
    ])
    expect(await contextMenu(tiers()[0]!)).toBe(false)
    expect(menu()).toBeNull()
    noIpc()
  })
})

// ─── 上下文用量环 ────────────────────────────────────────────────────────────

describe('上下文用量环：点一下出数字', () => {
  const ring = (): HTMLElement | null => container.querySelector<HTMLElement>('[data-context-ring]')
  const tip = (): HTMLElement => {
    const el = ring()?.querySelector<HTMLElement>('[data-context-tooltip]')
    if (!el) throw new Error('context tooltip not rendered')
    return el
  }
  const shown = (): boolean => {
    const cls = tip().classList
    if (cls.contains('block') === cls.contains('hidden')) {
      throw new Error(`ambiguous tooltip state: ${tip().className}`)
    }
    return cls.contains('block')
  }

  it.each<['compact' | 'touch']>([['compact'], ['touch']])(
    'TC-IA-R1 %s：收着 → 点 → 出（带百分比）→ 再点收；开着时 mousedown 在外面收、在环上不收',
    async (density) => {
      useChatStore.setState({ maxContextTokens: 100_000 })
      idle({ context: { usedTokens: 25_000 } })
      await mountInput(density === 'touch' ? TOUCH : {})
      expect(ring()).not.toBeNull()
      expect(shown()).toBe(false)

      await click(ring()!)
      expect(shown()).toBe(true)
      expect(tip().textContent).toContain(' · 25%')

      await click(ring()!)
      expect(shown()).toBe(false)

      await click(ring()!)
      expect(shown()).toBe(true)
      await mousedown(document.body)
      expect(shown()).toBe(false)

      await click(ring()!)
      expect(shown()).toBe(true)
      await mousedown(ring()!)
      expect(shown()).toBe(true)
    }
  )

  it('TC-IA-R1 没有上限也没有用量 → 不画环', async () => {
    useChatStore.setState({ maxContextTokens: 0 })
    await mountInput(TOUCH)
    expect(store().usedContextTokens).toBeNull()
    expect(ring()).toBeNull()
  })
})

// ─── 待发附图的删除键 ────────────────────────────────────────────────────────

describe('待发附图的 ✕', () => {
  const IMAGES = [
    { data: 'first', mimeType: 'image/png', preview: 'data:image/png;first' },
    { data: 'second', mimeType: 'image/jpeg', preview: 'data:image/jpeg;second' }
  ]
  const removeButtons = (): HTMLButtonElement[] => byAria(en.common.delete)
  const classesOf = (el: Element): string[] => (el.getAttribute('class') ?? '').split(/\s+/)

  it.each<['compact' | 'touch']>([['compact'], ['touch']])(
    'TC-IA-T12 %s：两张待发附图各一颗 ✕；尺寸与显形按密度；点第一颗只删第一张',
    async (density) => {
      await mountInput(density === 'touch' ? TOUCH : {})
      act(() => useChatStore.setState({ pendingImages: IMAGES.map((img) => ({ ...img })) }))
      await flush()
      const buttons = removeButtons()
      expect(buttons).toHaveLength(2)
      for (const btn of buttons) {
        const cls = classesOf(btn)
        const svg = btn.querySelector('svg')
        if (density === 'touch') {
          expect(cls).toEqual(expect.arrayContaining(['w-6', 'h-6']))
          expect(cls).not.toContain('w-4')
          expect(cls).not.toContain('opacity-0')
          expect(cls.some((c) => c.startsWith('group-hover'))).toBe(false)
          expect(svg?.getAttribute('width')).toBe('13')
        } else {
          expect(cls).toEqual(
            expect.arrayContaining(['w-4', 'h-4', 'opacity-0', 'group-hover/img:opacity-100'])
          )
          expect(cls).not.toContain('w-6')
          expect(svg?.getAttribute('width')).toBe('10')
        }
      }

      await click(buttons[0]!)
      expect(store().pendingImages).toHaveLength(1)
      expect(store().pendingImages[0]).toMatchObject({ data: 'second', mimeType: 'image/jpeg' })
      expect(removeButtons()).toHaveLength(1)
      expect(container.querySelector('img[src="data:image/jpeg;second"]')).not.toBeNull()
      expect(container.querySelector('img[src="data:image/png;first"]')).toBeNull()
      noIpc()
    }
  )
})
