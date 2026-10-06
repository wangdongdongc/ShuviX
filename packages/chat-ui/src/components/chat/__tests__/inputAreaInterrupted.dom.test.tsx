// @vitest-environment jsdom
/**
 * 被中断会话的输入卡片（jsdom，P3-12 Renderer 段）：
 *
 *   P3-12-09 横幅只在 durable 视图 `run.state:'interrupted'` 时出现：文案逐字（PIN-20）、[继续]、提示行；
 *            三种语言都有这几个键；idle / busy / legacy / none / 没有视图都没有横幅
 *   P3-12-10 点 [继续]：`agent.continue(sid)` 恰一次，等待期间按钮禁用、连点只发一次；横幅不乐观收起，
 *            视图离开 interrupted 才消失；变成 busy 时横幅没了、分档按钮出来；agent 关停中按钮禁用
 *   P3-12-11 继续失败（reject / {success:false}）：`[data-send-error]` 显示原因，按钮恢复，横幅还在
 *   P3-12-12 被中断时发消息 = abort-then-send：只走 `agent.prompt`（不 steer、不 continue）；占位气泡出现、
 *            输入框清空；横幅要等不再是 interrupted 的视图到了才消失
 *   P3-12-13 横幅的宿主：笔记本 / 抽屉里的 InputArea（thread 插槽）与没有 HostApi 的渠道端（Chrome 侧边栏）
 *            一样有横幅，继续走 `getSessionChannelApi()`
 *   Q-P3-21  旧格式会话（`capabilities.send:false`）：输入框禁用、占位文案是只读提示，回车发不出去
 *
 * 后端是假的 `window.api`（同 inputAreaPendingBubble.dom.test.tsx 的做法）；状态只经 `applySessionView` 写（PIN-23）。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import ja from '@shuvix/chat-protocol/i18n/locales/ja.json'
import type { AvailableModel, ProviderInfo } from '@shuvix/chat-protocol/types/provider'
import type { RunView, SessionView } from '@shuvix/chat-protocol/types/sessionView'

const mocks = vi.hoisted(() => ({
  models: { activeProvider: 'prov-1', activeModel: 'model-m' },
  /** false = 渠道端（没有 HostApi） */
  hasHost: true
}))

vi.mock('@shuvix/chat-ui', () => {
  const api = (): unknown => (globalThis as unknown as { window: { api: unknown } }).window.api
  return {
    getHostApi: () => (mocks.hasHost ? api() : null),
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

import { applySessionView, selectPendingPrompt, useChatStore } from '../../../stores/chatStore'
import { useModelCatalogStore } from '../../../stores/modelCatalogStore'
import { InputArea, type InputAreaProps } from '../InputArea'
import { V, assistant, resetStore, store, text, user } from '../../../__tests__/support/views'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const P = 'prov-1'
const M = 'model-m'
const SID = 's1'

const BANNER_EN = 'This run was interrupted when ShuviX closed'
const HINT_EN = 'Or send a new message — the interrupted run will be stopped first.'

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

let continueCall: Deferred<{ success: boolean; error?: string; code?: string }>
let api: {
  agent: {
    continue: ReturnType<typeof vi.fn>
    prompt: ReturnType<typeof vi.fn>
    steer: ReturnType<typeof vi.fn>
    followUp: ReturnType<typeof vi.fn>
  }
}

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
      prompt: vi.fn(() => new Promise(() => {})),
      continue: vi.fn(() => continueCall.promise),
      steer: vi.fn(async () => ({ success: true })),
      followUp: vi.fn(async () => ({ success: true })),
      withdrawQueued: vi.fn(async () => ({ result: 'aborted' as const })),
      abort: vi.fn(async () => ({ success: true })),
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

async function mount(props: InputAreaProps = { inline: true }): Promise<void> {
  await act(async () => {
    const Area = InputArea as (p: InputAreaProps) => React.JSX.Element
    root.render(createElement(Area, props))
  })
  await flush()
}

function view(run: RunView, overrides: Partial<SessionView> = {}): SessionView {
  return V(SID, {
    messages: [user('u1', 'first'), assistant('a1', [text('stale')])],
    run,
    ...overrides
  })
}

async function apply(v: SessionView): Promise<void> {
  await act(async () => applySessionView(SID, v))
}

const banner = (): HTMLElement | null => container.querySelector('[data-interrupted-banner]')
const continueButton = (): HTMLButtonElement =>
  container.querySelector<HTMLButtonElement>('[data-interrupted-continue]')!

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

async function type(value: string): Promise<void> {
  const el = container.querySelector('textarea')!
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(el, value)
    el.selectionStart = el.selectionEnd = value.length
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await flush()
}

async function pressEnter(): Promise<void> {
  const el = container.querySelector('textarea')!
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  await flush()
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

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    showSupportNotice: false
  })
  Element.prototype.scrollIntoView = vi.fn()
})

beforeEach(() => {
  mocks.hasHost = true
  continueCall = deferred()
  const built = buildApi()
  api = built as unknown as typeof api
  ;(window as unknown as { api: unknown }).api = built
  useModelCatalogStore.setState({ loaded: true, providers: [PROVIDER], availableModels: [MODEL] })
  resetStore(SID)
  useChatStore.setState({
    sessions: [
      {
        id: SID,
        title: SID,
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

describe('P3-12-09 banner visibility', () => {
  it('P3-12-09 an interrupted durable view: exact banner text, a [Continue] button and the hint line', async () => {
    await apply(view({ state: 'interrupted' }))
    await mount()
    expect(banner()).not.toBeNull()
    expect(banner()!.querySelector('[data-interrupted-text]')!.textContent).toBe(BANNER_EN)
    expect(continueButton().textContent).toBe('Continue')
    expect(continueButton().disabled).toBe(false)
    expect(banner()!.querySelector('[data-interrupted-hint]')!.textContent).toBe(HINT_EN)
  })

  it('P3-12-09 the run.interrupted* keys exist in zh, en and ja with the ruled copy (PIN-20)', () => {
    const copy = (locale: { run: Record<string, string> }): string[] => [
      locale.run.interruptedBanner,
      locale.run.interruptedContinue,
      locale.run.interruptedHint
    ]
    expect(copy(en)).toEqual([BANNER_EN, 'Continue', HINT_EN])
    expect(copy(zh)).toEqual([
      '此次运行在 ShuviX 关闭时被中断',
      '继续',
      '或直接发送新消息——将先停止被中断的运行。'
    ])
    expect(copy(ja)).toEqual([
      'この実行は ShuviX の終了時に中断されました',
      '続行',
      'または新しいメッセージを送信してください。中断された実行は先に停止されます。'
    ])
  })

  it.each<[string, SessionView | null]>([
    ['idle', view({ state: 'idle' })],
    ['busy', view({ state: 'busy' })],
    [
      'legacy',
      view(
        { state: 'interrupted' },
        { source: 'legacy', capabilities: { send: false, rollback: false, continue: false } }
      )
    ],
    ['none', { ...view({ state: 'interrupted' }), source: 'none' }],
    ['no view', null]
  ])('P3-12-09 no banner for a %s view', async (_label, v) => {
    if (v) await apply(v)
    await mount()
    expect(banner()).toBeNull()
  })
})

describe('P3-12-10 / 11 continue', () => {
  it('P3-12-10 one agent.continue(sid); disabled while pending; a double click sends one call; the banner stays until the view leaves interrupted', async () => {
    await apply(view({ state: 'interrupted' }))
    await mount()
    await click(continueButton())
    await click(continueButton())
    expect(api.agent.continue.mock.calls).toEqual([[SID]])
    expect(continueButton().disabled).toBe(true)
    // 调用落定（成功）但视图还没动：横幅照旧，不乐观收起
    await act(async () => continueCall.resolve({ success: true }))
    await flush()
    expect(banner()).not.toBeNull()
    expect(continueButton().disabled).toBe(true)
    await click(continueButton())
    expect(api.agent.continue).toHaveBeenCalledTimes(1)
    await apply(view({ state: 'idle' }))
    expect(banner()).toBeNull()
  })

  it('P3-12-10 when the view becomes busy, the banner is gone and the tier buttons appear', async () => {
    await apply(view({ state: 'interrupted' }))
    await mount()
    await click(continueButton())
    expect(container.querySelector('[title="' + en.queue.steerHint + '"]')).toBeNull()
    await apply(view({ state: 'busy' }))
    expect(banner()).toBeNull()
    expect(container.querySelector('[title="' + en.queue.steerHint + '"]')).not.toBeNull()
    expect(container.querySelector('[title="' + en.queue.followUpHint + '"]')).not.toBeNull()
  })

  it('P3-12-10 continue is disabled while the agent is closing', async () => {
    await apply(view({ state: 'interrupted' }))
    act(() => store().setAgentClosing(SID, true))
    await mount()
    expect(continueButton().disabled).toBe(true)
    await click(continueButton())
    expect(api.agent.continue).not.toHaveBeenCalled()
  })

  it.each<[string, () => void]>([
    ['the call rejects', () => continueCall.reject(new Error('x'))],
    ['it resolves {success:false}', () => continueCall.resolve({ success: false, error: 'x' })]
  ])(
    'P3-12-11 %s: the send-error line shows x, the button is re-enabled, the banner stays',
    async (_l, fail) => {
      await apply(view({ state: 'interrupted' }))
      await mount()
      await click(continueButton())
      expect(continueButton().disabled).toBe(true)
      await act(async () => fail())
      await flush()
      expect(container.querySelector('[data-send-error]')?.textContent).toBe(
        en.input.sendFailed.replace('{{error}}', 'x')
      )
      expect(continueButton().disabled).toBe(false)
      expect(banner()).not.toBeNull()
    }
  )
})

describe('P3-12-12 send while interrupted = abort-then-send', () => {
  it('P3-12-12 Enter goes through agent.prompt only; the pending bubble shows and the composer clears; the banner leaves only with a view that is not interrupted', async () => {
    await apply(view({ state: 'interrupted' }))
    await mount()
    await type('new question')
    await pressEnter()
    expect(api.agent.prompt).toHaveBeenCalledTimes(1)
    expect(api.agent.prompt.mock.calls[0]![0]).toMatchObject({
      sessionId: SID,
      text: 'new question'
    })
    expect(api.agent.steer).not.toHaveBeenCalled()
    expect(api.agent.followUp).not.toHaveBeenCalled()
    expect(api.agent.continue).not.toHaveBeenCalled()
    expect(selectPendingPrompt(store())?.content).toBe('new question')
    expect(container.querySelector('textarea')!.value).toBe('')
    // 还是 interrupted 的帧：横幅还在
    await apply(view({ state: 'interrupted' }))
    expect(banner()).not.toBeNull()
    await apply(
      view(
        { state: 'busy' },
        {
          messages: [
            user('u1', 'first'),
            assistant('a1', [text('stale')]),
            user('u2', 'new question')
          ]
        }
      )
    )
    expect(banner()).toBeNull()
  })
})

describe('P3-12-13 banner hosts', () => {
  it('P3-12-13 the drawer / notebook InputArea (thread slot) shows the banner too', async () => {
    await apply(view({ state: 'interrupted' }))
    await mount({ thread: createElement('div', { 'data-thread': '' }) })
    expect(container.querySelector('[data-thread]')).not.toBeNull()
    expect(banner()).not.toBeNull()
  })

  it('P3-12-13 with no HostApi (Chrome panel): the banner shows and Continue goes through getSessionChannelApi()', async () => {
    mocks.hasHost = false
    await apply(view({ state: 'interrupted' }))
    await mount()
    expect(banner()).not.toBeNull()
    await click(continueButton())
    expect(api.agent.continue.mock.calls).toEqual([[SID]])
  })
})

describe('Q-P3-21 legacy composer', () => {
  it('Q-P3-21 capabilities.send:false disables the textarea with the read-only placeholder; Enter sends nothing', async () => {
    await apply(
      view(
        { state: 'idle' },
        { source: 'legacy', capabilities: { send: false, rollback: false, continue: false } }
      )
    )
    await mount()
    const area = container.querySelector('textarea')!
    expect(area.disabled).toBe(true)
    expect(area.placeholder).toBe(en.chat.legacySessionReadOnly)
    act(() => store().setInputText('hello'))
    await pressEnter()
    expect(api.agent.prompt).not.toHaveBeenCalled()
  })

  it('Q-P3-21 a durable view (send:true) keeps the composer enabled', async () => {
    await apply(view({ state: 'idle' }))
    await mount()
    expect(container.querySelector('textarea')!.disabled).toBe(false)
  })
})
