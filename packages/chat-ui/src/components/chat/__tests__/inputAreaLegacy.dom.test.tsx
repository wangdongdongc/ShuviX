// @vitest-environment jsdom
/**
 * 旧格式会话的输入卡片（jsdom，P4-01，§2A）：
 *
 *   P4-01-01 legacy 视图：`[data-legacy-banner]` 出现，文案逐字是 `chat.legacySessionReadOnly`；没有中断横幅
 *   P4-01-02 卡片里只有横幅：没有输入框、发送按钮、模型 / 工具选择器、分档按钮、队列面板、待处理输入；
 *            什么也发不出去（prompt / steer / followUp / continue），不建占位
 *   P4-01-03 [新建对话]（`sidebar.newChat`）：`session.create({projectId})` 用当前行的项目 → list → 选中新会话；
 *            不删、不清空、不发消息
 *   P4-01-04 当前行没有项目 / 不在 `store.sessions` 里：`create({projectId:null})`（PIN-03）
 *   P4-01-05 连点只建一条；等待期间按钮禁用；落定后切到新会话
 *   P4-01-06 建会话失败：`[data-send-error]` 显示原因，按钮恢复，仍停在 s1，横幅还在（PIN-04）
 *   P4-01-07 渠道端（没有 HostApi）：横幅与文案在，没有 [新建对话]，也没有输入框
 *   P4-01-08 durable idle / busy、none、没有视图、欢迎页：都没有旧格式横幅
 *   P4-01-09 两条横幅永不同时出现
 *   P4-01-10 横幅只看 `source`，不看能力位：durable + `send:false` 只禁用输入框，没有横幅
 *   P4-01-11 legacy → durable（清空之后）或切到别的会话：横幅消失，输入框恢复
 *   P4-01-12 抽屉里的 InputArea（thread 插槽）同样有横幅（PIN-18）；卡片里只剩抽屉 + 横幅
 *   P4-01-13 文案来自既有键（三种语言逐字），切到 zh 渲染 zh 文案
 *   P4-01-14 InputArea 源码里不再有「phase 4」注释
 *   P4-01-15 legacy 视图根本没有输入框（文案在横幅里）；durable + `send:false` 仍是禁用输入框 + 只读提示
 *   P4-01-16 [新建对话] 是不起眼的幽灵按钮：`data-variant="subtle"`，不带主色实心按钮的类
 *
 * 后端是假的 `window.api`（同 inputAreaInterrupted.dom.test.tsx）；视图只经 `applySessionView` 写。
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
import type { Session } from '@shuvix/chat-protocol/chatApi'
import { emptySessionView, type SessionView } from '@shuvix/chat-protocol/types/sessionView'

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
const NEW_ID = 'new-1'

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

function row(id: string, projectId: string | null): Session {
  return {
    id,
    title: id,
    projectId,
    parentId: null,
    settings: {},
    createdAt: 0,
    updatedAt: 0,
    lastActiveAt: 0
  } as Session
}

type Fn = ReturnType<typeof vi.fn>
let api: {
  session: { create: Fn; list: Fn; delete: Fn; clear: Fn }
  agent: {
    continue: Fn
    prompt: Fn
    steer: Fn
    followUp: Fn
    clearMessages: Fn
  }
}
/** `session.list` 的返回（P4-01-03 断言 store.sessions 等于它） */
let listResult: Session[]

function buildApi(): Record<string, unknown> {
  return {
    session: {
      create: vi.fn(async (p?: { projectId?: string | null }) => row(NEW_ID, p?.projectId ?? null)),
      list: vi.fn(async () => listResult),
      delete: vi.fn(async () => undefined),
      clear: vi.fn(async () => ({ success: true }))
    },
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
      continue: vi.fn(async () => ({ success: true })),
      steer: vi.fn(async () => ({ success: true })),
      followUp: vi.fn(async () => ({ success: true })),
      clearMessages: vi.fn(async () => ({ success: true })),
      withdrawQueued: vi.fn(async () => ({ result: 'aborted' as const })),
      abort: vi.fn(async () => ({ success: true })),
      respondToInput: async () => ({ success: true })
    },
    // 一个 MCP 条目：让工具选择器在非 legacy 视图里真的渲染出来（空列表时它本就不渲染）
    tools: {
      list: async () => [
        { name: 'mcp:ctx', label: 'ctx', group: 'mcp:ctx', serverStatus: 'connected' }
      ]
    },
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

const MESSAGES = [user('u1', 'first'), assistant('a1', [text('old answer')])]

function legacyView(overrides: Partial<SessionView> = {}, sid = SID): SessionView {
  return V(sid, {
    source: 'legacy',
    capabilities: { send: false, rollback: false, continue: false },
    run: { state: 'idle' },
    messages: MESSAGES,
    ...overrides
  })
}

function durableView(overrides: Partial<SessionView> = {}, sid = SID): SessionView {
  return V(sid, { messages: MESSAGES, run: { state: 'idle' }, ...overrides })
}

async function apply(v: SessionView, sid = SID): Promise<void> {
  await act(async () => applySessionView(sid, v))
}

const legacyBanner = (): HTMLElement | null => container.querySelector('[data-legacy-banner]')
const interruptedBanner = (): HTMLElement | null =>
  container.querySelector('[data-interrupted-banner]')
const newChatButton = (): HTMLButtonElement | null =>
  container.querySelector<HTMLButtonElement>('[data-legacy-new-chat]')
const textarea = (): HTMLTextAreaElement => container.querySelector('textarea')!
const maybeTextarea = (): HTMLTextAreaElement | null => container.querySelector('textarea')
const maybeSendButton = (): HTMLButtonElement | null =>
  container.querySelector<HTMLButtonElement>(`button[title="${en.input.send}"]`)
const toolPicker = (): Element | null => container.querySelector('[data-tool-picker]')
/** 输入卡片本体（横幅的父元素）—— 它的直接子元素就是「卡片里有什么」 */
const card = (): HTMLElement => legacyBanner()!.parentElement!
/** legacy 视图里卡片上没有任何编辑入口：输入框、发送、选择器、分档按钮全都不在 */
function expectNoComposer(): void {
  expect(maybeTextarea()).toBeNull()
  expect(container.querySelector('input, select, [contenteditable]')).toBeNull()
  expect(maybeSendButton()).toBeNull()
  expect(toolPicker()).toBeNull()
  // 模型选择器（ModelSelect inline）会把当前模型名渲染出来；横幅里不该有它
  expect(container.textContent).not.toContain(M)
  expect(tierButtons()).toEqual([])
}
const sendButton = (): HTMLButtonElement =>
  container.querySelector<HTMLButtonElement>(`button[title="${en.input.send}"]`)!
const tierButtons = (): Element[] => [
  ...container.querySelectorAll(
    `[title="${en.queue.steerHint}"], [title="${en.queue.followUpHint}"]`
  )
]

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

async function pressEnter(target: Element = textarea()): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
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
  listResult = [row(SID, 'p1'), row(NEW_ID, 'p1')]
  const built = buildApi()
  api = built as unknown as typeof api
  ;(window as unknown as { api: unknown }).api = built
  useModelCatalogStore.setState({ loaded: true, providers: [PROVIDER], availableModels: [MODEL] })
  resetStore(SID)
  useChatStore.setState({ sessions: [row(SID, 'p1')], slashCommands: [] })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  if (i18n.language !== 'en') await i18n.changeLanguage('en')
})

describe('P4-01-01 / 02 legacy view', () => {
  it('P4-01-01 the legacy banner shows with the exact read-only copy and no interrupted banner', async () => {
    await apply(legacyView())
    await mount()
    expect(legacyBanner()).not.toBeNull()
    expect(legacyBanner()!.querySelector('[data-legacy-text]')!.textContent).toBe(
      en.chat.legacySessionReadOnly
    )
    expect(interruptedBanner()).toBeNull()
  })

  it('P4-01-02 no textarea, send button, model / tool picker or tier buttons; nothing can be sent, no pending bubble', async () => {
    await apply(legacyView())
    await mount()
    expectNoComposer()
    // 草稿里残留的文本也发不出去：没有输入框可按回车，Enter 落在横幅上什么也不做
    act(() => store().setInputText('hello'))
    await pressEnter(legacyBanner()!)
    expectNoComposer()
    expect(api.agent.prompt).not.toHaveBeenCalled()
    expect(api.agent.steer).not.toHaveBeenCalled()
    expect(api.agent.followUp).not.toHaveBeenCalled()
    expect(api.agent.continue).not.toHaveBeenCalled()
    expect(selectPendingPrompt(store())).toBeNull()
  })

  it('P4-01-02 the banner is the only content of the card: no queue panel, no pending-input accessory', async () => {
    await apply(legacyView())
    await mount({ inline: true, accessory: createElement('div', { 'data-accessory': '' }) })
    expect([...card().children]).toEqual([legacyBanner()])
    expect(container.querySelector('[data-accessory]')).toBeNull()
    expect(interruptedBanner()).toBeNull()
    // 卡片上唯一的按钮就是 [新建对话]
    expect([...container.querySelectorAll('button')]).toEqual([newChatButton()])
  })

  it('P4-01-02 even a busy legacy view (run.state busy) shows no stop button or tier buttons', async () => {
    await apply(legacyView({ run: { state: 'busy' } }))
    await mount()
    expectNoComposer()
    expect(container.querySelector(`button[title="${en.input.stopGen}"]`)).toBeNull()
  })
})

describe('P4-01-03 .. 07 [New chat]', () => {
  it("P4-01-03 [New chat] creates in the row's project, lists, selects the new session; nothing destructive", async () => {
    await apply(legacyView())
    await mount()
    expect(newChatButton()!.textContent).toBe(en.sidebar.newChat)
    await click(newChatButton()!)
    await flush()
    expect(api.session.create.mock.calls).toEqual([[{ projectId: 'p1' }]])
    expect(api.session.list).toHaveBeenCalledTimes(1)
    expect(api.session.create.mock.invocationCallOrder[0]).toBeLessThan(
      api.session.list.mock.invocationCallOrder[0]!
    )
    expect(store().activeSessionId).toBe(NEW_ID)
    expect(store().sessions).toEqual(listResult)
    expect(api.session.delete).not.toHaveBeenCalled()
    expect(api.session.clear).not.toHaveBeenCalled()
    expect(api.agent.clearMessages).not.toHaveBeenCalled()
    expect(api.agent.prompt).not.toHaveBeenCalled()
  })

  it.each<[string, Session[]]>([
    ['s1 has no project', [row(SID, null)]],
    ['s1 is not in store.sessions', []]
  ])('P4-01-04 %s: create({projectId: null})', async (_label, sessions) => {
    act(() => useChatStore.setState({ sessions }))
    await apply(legacyView())
    await mount()
    await click(newChatButton()!)
    await flush()
    expect(api.session.create.mock.calls).toEqual([[{ projectId: null }]])
  })

  it('P4-01-05 a double click creates once; the button is disabled while pending; the session switches after it resolves', async () => {
    const pending = deferred<Session>()
    api.session.create.mockImplementation(() => pending.promise)
    await apply(legacyView())
    await mount()
    await click(newChatButton()!)
    await click(newChatButton()!)
    expect(api.session.create).toHaveBeenCalledTimes(1)
    expect(newChatButton()!.disabled).toBe(true)
    expect(store().activeSessionId).toBe(SID)
    await act(async () => pending.resolve(row(NEW_ID, 'p1')))
    await flush()
    expect(api.session.create).toHaveBeenCalledTimes(1)
    expect(store().activeSessionId).toBe(NEW_ID)
  })

  it('P4-01-06 a failed create: the send-error line shows x, the button is re-enabled, s1 stays active, the banner stays', async () => {
    api.session.create.mockImplementation(async () => {
      throw new Error('x')
    })
    await apply(legacyView())
    await mount()
    await click(newChatButton()!)
    await flush()
    expect(container.querySelector('[data-send-error]')?.textContent).toBe(
      en.input.sendFailed.replace('{{error}}', 'x')
    )
    expect(newChatButton()!.disabled).toBe(false)
    expect(store().activeSessionId).toBe(SID)
    expect(legacyBanner()).not.toBeNull()
  })

  it('P4-01-07 channel mode (no HostApi): the banner and copy show, no [New chat], no composer', async () => {
    mocks.hasHost = false
    await apply(legacyView())
    await mount()
    expect(legacyBanner()).not.toBeNull()
    expect(legacyBanner()!.querySelector('[data-legacy-text]')!.textContent).toBe(
      en.chat.legacySessionReadOnly
    )
    expect(newChatButton()).toBeNull()
    expectNoComposer()
    expect([...card().children]).toEqual([legacyBanner()])
    expect(api.session.create).not.toHaveBeenCalled()
  })
})

describe('P4-01-08 .. 11 other views and transitions', () => {
  it.each<[string, () => Promise<void>, boolean]>([
    ['durable idle', () => apply(durableView()), false],
    ['durable busy', () => apply(durableView({ run: { state: 'busy' } })), true],
    ['none (emptySessionView, send:true)', () => apply(emptySessionView(SID)), false],
    ['no view applied', async () => {}, false],
    [
      'welcome page (activeSessionId null)',
      async () => {
        act(() => resetStore(null))
      },
      false
    ]
  ])('P4-01-08 %s: no legacy banner, composer enabled', async (_label, setup, busy) => {
    await setup()
    await mount()
    expect(legacyBanner()).toBeNull()
    expect(textarea().disabled).toBe(false)
    expect(maybeSendButton() !== null || busy).toBe(true)
    if (busy) expect(tierButtons()).toHaveLength(2)
  })

  it.each<[string, SessionView, 'legacy' | 'interrupted']>([
    ['a durable interrupted view', durableView({ run: { state: 'interrupted' } }), 'interrupted'],
    [
      'a legacy view with run.state interrupted',
      legacyView({ run: { state: 'interrupted' } }),
      'legacy'
    ]
  ])('P4-01-09 %s: exactly one of the two banners', async (_label, v, expected) => {
    await apply(v)
    await mount()
    expect(legacyBanner() !== null).toBe(expected === 'legacy')
    expect(interruptedBanner() !== null).toBe(expected === 'interrupted')
    expect([legacyBanner(), interruptedBanner()].filter(Boolean)).toHaveLength(1)
  })

  it('P4-01-10 the banner keys on source, not capability: durable + send:false disables the textarea without a banner', async () => {
    await apply(durableView({ capabilities: { send: false, rollback: true, continue: true } }))
    await mount()
    expect(textarea().disabled).toBe(true)
    expect(sendButton().disabled).toBe(true)
    // 对照：非 legacy 视图里工具选择器与模型名都在（expectNoComposer 的两条否定断言因此不是空转）
    expect(toolPicker()).not.toBeNull()
    expect(container.textContent).toContain(M)
    expect(legacyBanner()).toBeNull()
  })

  it('P4-01-11 the same s1 going legacy → durable idle (after a clear): the banner goes, the textarea is enabled', async () => {
    await apply(legacyView())
    await mount()
    expect(legacyBanner()).not.toBeNull()
    await apply(durableView({ messages: [] }))
    expect(legacyBanner()).toBeNull()
    expect(textarea().disabled).toBe(false)
  })

  it('P4-01-11 switching activeSessionId to a durable s2: the banner goes, the textarea is enabled', async () => {
    await apply(legacyView())
    await apply(durableView({}, 's2'), 's2')
    await mount()
    expect(legacyBanner()).not.toBeNull()
    act(() => store().setActiveSessionId('s2'))
    await flush()
    expect(legacyBanner()).toBeNull()
    expect(textarea().disabled).toBe(false)
  })
})

describe('P4-01-12 .. 15 hosts, copy, source, placeholder', () => {
  it('P4-01-12 the drawer InputArea (thread slot) shows the banner too, under the drawer and nothing else', async () => {
    await apply(legacyView())
    await mount({ thread: createElement('div', { 'data-thread': '' }) })
    expect(container.querySelector('[data-thread]')).not.toBeNull()
    expect(legacyBanner()).not.toBeNull()
    expect(newChatButton()).not.toBeNull()
    expect([...card().children]).toEqual([container.querySelector('[data-thread]'), legacyBanner()])
    expectNoComposer()
  })

  it('P4-01-13 the copy comes from the existing keys, unchanged in zh, en and ja', () => {
    expect(en.chat.legacySessionReadOnly).toBe(
      'This conversation was created by an earlier version of ShuviX and is read-only. Clear it or start a new session to continue.'
    )
    expect(zh.chat.legacySessionReadOnly).toBe(
      '这条会话由旧版本 ShuviX 创建，只能查看。清空它或新建一条会话即可继续。'
    )
    expect(ja.chat.legacySessionReadOnly).toBe(
      'この会話は以前のバージョンの ShuviX で作成されたため、閲覧のみ可能です。続けるには会話をクリアするか、新しいセッションを開始してください。'
    )
    expect([en.sidebar.newChat, zh.sidebar.newChat, ja.sidebar.newChat]).toEqual([
      'New Chat',
      '新建对话',
      '新規チャット'
    ])
  })

  it('P4-01-13 with i18n switched to zh the banner renders the zh copy and label', async () => {
    i18n.addResourceBundle('zh', 'translation', zh, true, true)
    await act(async () => {
      await i18n.changeLanguage('zh')
    })
    await apply(legacyView())
    await mount()
    expect(legacyBanner()!.querySelector('[data-legacy-text]')!.textContent).toBe(
      zh.chat.legacySessionReadOnly
    )
    expect(newChatButton()!.textContent).toBe(zh.sidebar.newChat)
  })

  it('P4-01-14 the "phase 4" comment is gone from InputArea.tsx', async () => {
    const { readFileSync } = await import('node:fs')
    const { join, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../InputArea.tsx'),
      'utf8'
    )
    expect(source).not.toMatch(/phase 4/i)
    expect(source).not.toContain('横幅是 phase 4 的事')
  })

  it('P4-01-15 a legacy view has no textarea at all (the banner carries the copy)', async () => {
    await apply(legacyView())
    await mount()
    expect(maybeTextarea()).toBeNull()
    expect(legacyBanner()!.textContent).toContain(en.chat.legacySessionReadOnly)
  })

  it('P4-01-15 a durable send:false view keeps the read-only placeholder', async () => {
    await apply(durableView({ capabilities: { send: false, rollback: true, continue: true } }))
    await mount()
    expect(textarea().placeholder).toBe(en.chat.legacySessionReadOnly)
  })
})

describe('P4-01-16 [New chat] is inconspicuous', () => {
  it('P4-01-16 the button is the subtle (ghost) variant, never the primary filled button', async () => {
    await apply(legacyView())
    await mount()
    const btn = newChatButton()!
    expect(btn.dataset.variant).toBe('subtle')
    for (const primary of ['bg-accent', 'text-white', 'hover:bg-accent-hover']) {
      expect(btn.classList.contains(primary)).toBe(false)
    }
  })

  it('P4-01-16 it stays subtle while a create is pending (disabled, not swapped for a filled style)', async () => {
    const pending = deferred<Session>()
    api.session.create.mockImplementation(() => pending.promise)
    await apply(legacyView())
    await mount()
    await click(newChatButton()!)
    const btn = newChatButton()!
    expect(btn.disabled).toBe(true)
    expect(btn.dataset.variant).toBe('subtle')
    expect(btn.classList.contains('bg-accent')).toBe(false)
    await act(async () => pending.resolve(row(NEW_ID, 'p1')))
    await flush()
  })
})
