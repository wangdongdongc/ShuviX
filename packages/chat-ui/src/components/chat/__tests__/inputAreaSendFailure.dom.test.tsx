// @vitest-environment jsdom
/**
 * 发消息时连接断了（jsdom）：`agent.prompt` 要等整轮落定才回，web 客户端的 WebSocket 又常断，所以断线不等于发送失败。
 *
 * 规则一，已受理（视图里有了这条用户消息）：断线不算失败，只有别的错误才报原因，话不放回。
 *   SF-1 断线、连回、2×GRACE、终答到 → 全程没有失败提示，输入框空，不留定时器，终答进了 store
 *   SF-2 拒绝之前打了字 → 那些字不动
 *   SF-3 受理之后 handler_error → 报原因，话不放回
 *
 * 规则二，结果未知（`lost`，没看到受理）：占位留着，等视图回答；宽限只算连着的时间。
 *   SF-4 断着 10×GRACE → 占位在、还是在跑的形态、没有提示、输入框空
 *   SF-5 连回、GRACE-1 时视图带来这条用户消息 → 同一次更新换掉占位，没有提示、不放回，再过一个 GRACE 也没动静
 *   SF-6 连回、视图没带来 → GRACE-1 不变；GRACE 时占位撤下、不在跑、放回输入框、报 ERR，之后的渲染里 ERR 还在
 *   SF-7 连回、GRACE-1、又断、2×GRACE、再连 → 第二次连回之后满一个 GRACE 才算失败
 *   SF-8 SF-6 之后才到的视图（带这条消息、run busy）→ 提示消失，输入框的字不动，占位不回来
 *   SF-9 拒绝时已经连着 → 从拒绝那一刻算（之前跑了多久不算）
 *   SF-10 等待期间的重新同步只多了助手条目 / 系统通知 → 不算受理、不重新起算，GRACE 时失败
 *
 * 规则三，没发出去（`not-sent`）：当场失败。
 *   SF-11 同一次 flush：占位撤下、放回、ERR；onUp / onDown 从没登记
 *   SF-12 接着重发（调用挂着）→ 提示立刻消失，参数与第一次逐字段相等
 *
 * 放回的内容（经 notSent）：
 *   SF-13 前后的空格与换行原样
 *   SF-14 只有图片：图片按序放回、不重复，输入框空（`input.imageOnly` 的占位文案不出现）
 *   SF-15 命令芯片（带参数 / 不带参数）
 *   SF-16 @ 引用：镜像层胶囊回来，重发是同一个 at token，弹层不开
 *   SF-17 粘贴芯片：回来；放回之后退格整个删；新的长文粘贴用下一个序号、不撞
 *   SF-18 文字 + 图片 + @ + 粘贴 + 要藏的值（经 lost + GRACE）；命令芯片 + 粘贴 + 图片
 *   SF-19 handler_error 与抛出的非 Error：报原文、放回。两种连接错误在 en / zh / ja 都是本地化的那句，从不露出原始错误码
 *
 * 不盖掉新内容：
 *   SF-20 等待期间打了新字、插了新胶囊 → 都不动，重发带新的值，ERR 照报
 *   SF-21 等待期间只打了空白 → 当作空，放回
 *   SF-22 没打字，但选了新命令 / 附了新图 → 新内容不动、不与旧消息掺在一起，ERR 照报
 *   SF-23 切到 B（有字、有胶囊、有图）10×GRACE → B 一动不动、没有提示，A 的占位还在
 *   SF-24 切走再切回 A，视图没带来 → 切回之后满 GRACE，在 A 放回并报 ERR
 *   SF-25 切走 10×GRACE 再切回 A，视图里有这条消息且 idle → 没有提示、不放回
 *   SF-26 消息里有要藏的值和粘贴芯片，lost，InputArea 卸掉（手机返回），宽限过了再挂回来 → 真值不在 DOM，胶囊可用，ERR，重发相等
 *
 * 提示的显示（一个槽，记着是哪条会话的）：
 *   SE-1 去 idle 的 B 看不到，回 A 还在
 *   SE-2 去在跑的 B 再回 idle 的 A → 还在（A 没跑过）
 *   SE-3 / SE-4 A 的视图变 busy（别的设备发的 / 只多一条系统通知）→ 清掉
 *   SE-5 人在 B，A 跑了一轮又结束（没有视图订阅时用 markSessionRunning，agent_start / agent_end 走的就是它）→ 回 A 没了
 *   SE-6 放回本身不清提示，敲一个键才清
 *   SE-7 A 失败之后 B 也失败，回 A → B 的文字不出现在 A
 *   SE-8 欢迎页的失败只在欢迎页
 *   SE-9 在 B 敲键，A 的提示不受影响
 *   SE-10 运行中 steer 失败：这一轮跑着时一直在，只有那一轮结束之后又开始新一轮才清
 *
 * 后端是假的 `window.api`（同 inputAreaPendingBubble.dom.test.tsx），`agent.prompt` 由用例掌握何时落定；状态只经
 * `applySessionView` 写。假时钟（useFakeClock）：`flush` 不拨钟，宽限数得准。
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
import type { SessionView } from '@shuvix/chat-protocol/types/sessionView'

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
  releaseSessionView,
  selectIsStreaming,
  selectPendingPrompt,
  useChatStore,
  type PendingImage
} from '../../../stores/chatStore'
import { PROMPT_OUTCOME_GRACE_MS as GRACE } from '../../../stores/promptOutcome'
import { useModelCatalogStore } from '../../../stores/modelCatalogStore'
import { InputArea, type InputAreaProps } from '../InputArea'
import { V, assistant, resetStore, store, text, user } from '../../../__tests__/support/views'
import {
  addSecretChip,
  advance,
  composerShot,
  deferred,
  fakeLink,
  flush,
  handlerError,
  longPaste,
  lost,
  notSent,
  pasteInto,
  pressKey,
  typeInto,
  useFakeClock,
  type Deferred,
  type FakeLink
} from '../../../__tests__/support/sendFailure'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const P = 'prov-1'
const M = 'model-m'
const A = 's1'
const B = 's2'
const SECRET = 'Xk9#mP2q'

const IMG_1: PendingImage = {
  data: 'aGk=',
  mimeType: 'image/png',
  preview: 'data:image/png;base64,aGk='
}
const IMG_2: PendingImage = {
  data: 'eW8=',
  mimeType: 'image/jpeg',
  preview: 'data:image/jpeg;base64,eW8='
}
const CMD = {
  commandId: 'cmd',
  name: 'Cmd',
  description: 'a command',
  template: 'Run: $ARGUMENTS'
}

let link: FakeLink
let prompts: Array<Deferred<{ error?: string }>>
let prompt: ReturnType<typeof vi.fn>
let steer: ReturnType<typeof vi.fn>
let createSession: ReturnType<typeof vi.fn>

function buildApi(): Record<string, unknown> {
  link = fakeLink()
  prompts = []
  prompt = vi.fn(() => {
    const next = deferred<{ error?: string }>()
    prompts.push(next)
    return next.promise
  })
  steer = vi.fn(async () => ({ success: true }))
  createSession = vi.fn(async () => ({ id: 'new-session' }))
  return {
    session: { list: async () => [], create: createSession },
    agent: {
      init: async () => ({ success: true }),
      prompt,
      steer,
      followUp: vi.fn(async () => ({ success: true })),
      abort: vi.fn(async () => ({ success: true })),
      respondToInput: vi.fn(async () => ({ success: true }))
    },
    tools: { list: async () => [] },
    files: {
      scan: async () => ({ root: '/w/proj', paths: ['docs/a.ts', 'README.md'], truncated: false })
    },
    mentions: { listKnowledgeEntries: async () => [] },
    events: { subscribe: () => () => {} },
    app: { openSettings: () => {} },
    sync: link
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

async function mount(): Promise<void> {
  await act(async () => {
    const Area = InputArea as (props: InputAreaProps) => React.JSX.Element
    root.render(createElement(Area, { inline: true }))
  })
  await flush()
}

const textarea = (): HTMLTextAreaElement => container.querySelector('textarea')!
const shot = (): ReturnType<typeof composerShot> => composerShot(container)
const type = (value: string): Promise<void> => typeInto(textarea(), value)
const pressEnter = (): Promise<void> => pressKey(textarea(), 'Enter')
const paste = (value: string): Promise<void> => pasteInto(textarea(), value)
const addSecret = (value: string): Promise<void> => addSecretChip(container, value)

async function send(value: string): Promise<void> {
  await type(value)
  await pressEnter()
}

const sendError = (): string | null =>
  container.querySelector('[data-send-error]')?.textContent ?? null
const ERR = (): string => i18n.t('input.sendFailed', { error: i18n.t('input.connectionLost') })
const failedWith = (reason: string): string => i18n.t('input.sendFailed', { error: reason })

/** 这条消息发出去之后第 n 次调用的结果（缺省最后一次） */
async function rejectPrompt(error: unknown, index = -1): Promise<void> {
  await act(async () => prompts.at(index)!.reject(error))
  await flush()
}

const baseMessages = (sid: string): SessionView['messages'] => [
  user(`${sid}-u1`, 'earlier', sid),
  assistant(`${sid}-a1`, [text('ok')], sid)
]
const idleView = (sid: string, extra: SessionView['messages'] = []): SessionView =>
  V(sid, { messages: [...baseMessages(sid), ...extra], run: { state: 'idle' } })
const busyView = (sid: string, extra: SessionView['messages'] = []): SessionView =>
  V(sid, { messages: [...baseMessages(sid), ...extra], run: { state: 'busy' } })

async function applyView(sid: string, view: SessionView): Promise<void> {
  await act(async () => applySessionView(sid, view))
  await flush()
}

/** 切到别的会话（宿主那边跟着退订上一条的视图）；切过去的那条有视图就带上 */
async function switchTo(sid: string, view?: SessionView): Promise<void> {
  const from = store().activeSessionId
  await act(async () => {
    store().setActiveSessionId(sid)
    if (from && from !== sid) releaseSessionView(from)
    if (view) applySessionView(sid, view)
  })
  await flush()
}

const noticeEntry = (sid: string): SessionView['messages'][number] =>
  user(`${sid}-n1`, 'background done', sid, { isSystemNotice: true })

/** 让 InputArea 渲染一次（store 变了但不影响它算什么） */
async function rerender(): Promise<void> {
  await act(async () => store().setMcpConnecting(A, 'srv', true))
  await act(async () => store().clearMcpConnecting(A))
}

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en }, zh: { translation: zh }, ja: { translation: ja } },
    showSupportNotice: false
  })
  Element.prototype.scrollIntoView = vi.fn()
})

beforeEach(async () => {
  useFakeClock()
  await i18n.changeLanguage('en')
  ;(window as unknown as { api: unknown }).api = buildApi()
  useModelCatalogStore.setState({ loaded: true, providers: [PROVIDER], availableModels: [MODEL] })
  // 模块级的会话草稿不随 store 复位：把两条会话的都写空
  for (const sid of [B, A]) {
    store().setActiveSessionId(sid)
    store().setInputText('')
    store().clearPendingImages()
  }
  resetStore(A)
  const row = (id: string): ReturnType<typeof store>['sessions'][number] => ({
    id,
    title: id,
    projectId: null,
    parentId: null,
    settings: {},
    createdAt: 0,
    updatedAt: 0,
    lastActiveAt: 0
  })
  useChatStore.setState({
    sessions: [row(A), row(B)],
    slashCommands: [CMD],
    modelSupportsVision: false,
    maxContextTokens: 0,
    composerRestoreRequest: null
  })
  applySessionView(A, idleView(A))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  // 还在等结果的那几次发送：占位一撤就收工，不把订阅带进下一个用例
  useChatStore.setState({ sessionPendingPrompt: {}, composerRestoreRequest: null })
  await vi.advanceTimersByTimeAsync(0)
  vi.useRealTimers()
})

describe('规则一：已受理', () => {
  /** 发出去、视图带来了这条用户消息（一轮跑着） */
  async function sendAccepted(): Promise<void> {
    await send('hello')
    await applyView(A, busyView(A, [user('u_new', 'hello', A)]))
    expect(selectPendingPrompt(store())).toBeNull()
  }

  it('SF-1 断线、连回、2×GRACE、终答 → 全程没有提示，输入框空，不留定时器，终答进 store', async () => {
    await mount()
    await sendAccepted()

    act(() => link.goDown())
    await rejectPrompt(lost())
    expect(sendError()).toBeNull()
    act(() => link.goUp())
    await advance(2 * GRACE)
    expect(sendError()).toBeNull()
    await applyView(
      A,
      idleView(A, [user('u_new', 'hello', A), assistant('a_new', [text('answer')], A)])
    )
    expect(sendError()).toBeNull()
    expect(textarea().value).toBe('')
    expect(vi.getTimerCount()).toBe(0)
    expect(store().messages.at(-1)?.id).toBe('a_new')
    expect(link.onUp).not.toHaveBeenCalled()
  })

  it('SF-2 拒绝之前打了字 → 那些字不动', async () => {
    await mount()
    await sendAccepted()
    await type('next')
    await rejectPrompt(lost())
    await advance(2 * GRACE)
    expect(textarea().value).toBe('next')
    expect(sendError()).toBeNull()
  })

  it('SF-3 受理之后 handler_error → 报原因，话不放回', async () => {
    await mount()
    await sendAccepted()
    await rejectPrompt(handlerError('boom'))
    expect(sendError()).toBe(failedWith('boom'))
    expect(textarea().value).toBe('')
    expect(store().composerRestoreRequest).toBeNull()
  })
})

describe('规则二：结果未知', () => {
  /** SF-4 的起点：没看到受理，lost，断着过了 10×GRACE */
  async function lostAndDown(): Promise<void> {
    await mount()
    await send('hello')
    act(() => link.goDown())
    await rejectPrompt(lost())
    await advance(10 * GRACE)
  }

  it('SF-4 断着 10×GRACE → 占位在、在跑的形态、没有提示、输入框空', async () => {
    await lostAndDown()
    expect(selectPendingPrompt(store())?.content).toBe('hello')
    expect(selectIsStreaming(store())).toBe(true)
    expect(sendError()).toBeNull()
    expect(textarea().value).toBe('')
  })

  it('SF-5 连回、GRACE-1 时视图带来这条消息 → 同一次更新换掉占位；没有提示、不放回；再过 GRACE 也没动静', async () => {
    await lostAndDown()
    act(() => link.goUp())
    await advance(GRACE - 1)
    const seen: Array<{ bubble: boolean; real: boolean }> = []
    const off = useChatStore.subscribe((s) =>
      seen.push({
        bubble: A in s.sessionPendingPrompt,
        real: s.messages.some((m) => m.id === 'u_new')
      })
    )
    await applyView(A, busyView(A, [user('u_new', 'hello', A)]))
    off()
    expect(seen.some((s) => s.bubble && s.real)).toBe(false)
    expect(seen.some((s) => !s.bubble && !s.real)).toBe(false)
    expect(selectPendingPrompt(store())).toBeNull()
    expect(store().messages.at(-1)?.id).toBe('u_new')
    expect(sendError()).toBeNull()
    expect(textarea().value).toBe('')

    await advance(GRACE)
    expect(sendError()).toBeNull()
    expect(textarea().value).toBe('')
    expect(store().composerRestoreRequest).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('SF-6 连回、视图没带来 → GRACE-1 不变；GRACE 时占位撤下、不在跑、放回、ERR，之后的渲染里 ERR 还在', async () => {
    await lostAndDown()
    act(() => link.goUp())
    await advance(GRACE - 1)
    expect(selectPendingPrompt(store())).not.toBeNull()
    expect(selectIsStreaming(store())).toBe(true)
    expect(sendError()).toBeNull()
    expect(textarea().value).toBe('')

    await advance(1)
    expect(selectPendingPrompt(store())).toBeNull()
    expect(selectIsStreaming(store())).toBe(false)
    expect(textarea().value).toBe('hello')
    expect(sendError()).toBe(ERR())

    await rerender()
    await applyView(A, idleView(A, [assistant('a2', [text('unrelated')], A)]))
    await advance(GRACE)
    expect(sendError()).toBe(ERR())
    expect(textarea().value).toBe('hello')
  })

  it('SF-7 连回、GRACE-1、又断、2×GRACE、再连 → 第二次连回之后满 GRACE 才失败', async () => {
    await lostAndDown()
    act(() => link.goUp())
    await advance(GRACE - 1)
    act(() => link.goDown())
    await advance(2 * GRACE)
    expect(sendError()).toBeNull()
    act(() => link.goUp())
    await advance(GRACE - 1)
    expect(sendError()).toBeNull()
    expect(selectPendingPrompt(store())).not.toBeNull()
    await advance(1)
    expect(sendError()).toBe(ERR())
    expect(textarea().value).toBe('hello')
  })

  it('SF-8 放回之后才到的视图（带这条消息、busy）→ 提示消失，字不动，占位不回来', async () => {
    await lostAndDown()
    act(() => link.goUp())
    await advance(GRACE)
    expect(sendError()).toBe(ERR())

    await applyView(A, busyView(A, [user('u_new', 'hello', A)]))
    expect(sendError()).toBeNull()
    expect(textarea().value).toBe('hello')
    expect(selectPendingPrompt(store())).toBeNull()
  })

  it('SF-9 拒绝时已经连着 → 从拒绝那一刻算', async () => {
    await mount()
    await send('hello')
    await advance(3 * GRACE)
    expect(selectPendingPrompt(store())).not.toBeNull()
    await rejectPrompt(lost())
    await advance(GRACE - 1)
    expect(sendError()).toBeNull()
    expect(selectPendingPrompt(store())).not.toBeNull()
    await advance(1)
    expect(sendError()).toBe(ERR())
    expect(textarea().value).toBe('hello')
  })

  it.each<[string, () => SessionView['messages'][number]]>([
    ['助手条目', () => assistant('a2', [text('late')], A)],
    ['系统通知', () => noticeEntry(A)]
  ])('SF-10 等待期间的重新同步只多了%s → 不算受理、不重新起算', async (_label, entry) => {
    await mount()
    await send('hello')
    await rejectPrompt(lost())
    await advance(GRACE / 2)
    await applyView(A, idleView(A, [entry()]))
    expect(selectPendingPrompt(store())).not.toBeNull()
    await advance(GRACE / 2 - 1)
    expect(sendError()).toBeNull()
    await advance(1)
    expect(selectPendingPrompt(store())).toBeNull()
    expect(sendError()).toBe(ERR())
    expect(textarea().value).toBe('hello')
  })
})

describe('规则三：没发出去', () => {
  it('SF-11 同一次 flush：占位撤下、放回、ERR；onUp / onDown 从没登记', async () => {
    await mount()
    await send('hello')
    const clockBefore = Date.now()
    await act(async () => prompts.at(-1)!.reject(notSent()))
    expect(Date.now()).toBe(clockBefore)
    expect(selectPendingPrompt(store())).toBeNull()
    expect(textarea().value).toBe('hello')
    expect(sendError()).toBe(ERR())
    expect(link.onUp).not.toHaveBeenCalled()
    expect(link.onDown).not.toHaveBeenCalled()
  })

  it('SF-12 接着重发（调用挂着）→ 提示立刻消失，参数与第一次相等', async () => {
    await mount()
    await send('hello')
    await rejectPrompt(notSent())
    await pressEnter()
    expect(sendError()).toBeNull()
    expect(prompt).toHaveBeenCalledTimes(2)
    expect(prompt.mock.calls[1]![0]).toEqual(prompt.mock.calls[0]![0])
    expect(selectPendingPrompt(store())?.content).toBe('hello')
  })
})

describe('放回的内容', () => {
  /** 发一次、失败、放回；断言放回的样子与发送前一样，重发的参数与第一次一样 */
  async function expectRoundTrip(
    fail: () => Promise<void> = () => rejectPrompt(notSent())
  ): Promise<void> {
    const before = shot()
    await pressEnter()
    expect(textarea().value).toBe('')
    await fail()
    expect(shot()).toEqual(before)
    expect(sendError()).toBe(ERR())
    const calls = prompt.mock.calls.length
    await pressEnter()
    expect(prompt).toHaveBeenCalledTimes(calls + 1)
    expect(prompt.mock.calls[calls]![0]).toEqual(prompt.mock.calls[calls - 1]![0])
  }

  const popoverOpen = (): boolean => container.querySelector('[data-at-index]') !== null

  async function pickMention(): Promise<void> {
    await type('see @a')
    await flush()
    expect(popoverOpen()).toBe(true)
    await pressEnter()
    expect(popoverOpen()).toBe(false)
    expect(shot().chips).toEqual(['@a.ts'])
  }

  it('SF-13 前后的空格与换行原样', async () => {
    await mount()
    const raw = '  \n hello there \n\n  '
    await send(raw)
    expect(prompt.mock.calls[0]![0].text).toBe('hello there')
    await rejectPrompt(notSent())
    expect(textarea().value).toBe(raw)
    expect(sendError()).toBe(ERR())
  })

  it('SF-14 只有图片：按序放回、不重复，输入框空', async () => {
    await mount()
    await act(async () => useChatStore.setState({ pendingImages: [IMG_1, IMG_2] }))
    await expectRoundTrip()
    await rejectPrompt(notSent())
    expect(store().pendingImages).toEqual([IMG_1, IMG_2])
    expect(textarea().value).toBe('')
    expect(textarea().value).not.toContain(en.input.imageOnly)
    expect([...container.querySelectorAll('img')].map((img) => img.getAttribute('src'))).toEqual([
      IMG_1.preview,
      IMG_2.preview
    ])
  })

  it.each<[string, string, string]>([
    ['带参数', '/cmd do it', 'do it'],
    ['不带参数', '/cmd ', '']
  ])('SF-15 命令芯片（%s）回来，重发相等', async (_label, typed, args) => {
    await mount()
    await type(typed)
    expect(shot().slash).toBe('/cmd')
    expect(textarea().value).toBe(args)
    await expectRoundTrip()
    expect(prompt.mock.calls[0]![0].inlineTokens.t0).toMatchObject({ type: 'cmd', id: 'cmd' })
  })

  it('SF-16 @ 引用：胶囊回来，重发是同一个 at token，弹层不开', async () => {
    await mount()
    await pickMention()
    const before = shot()
    await pressEnter()
    const first = prompt.mock.calls[0]![0]
    expect(Object.values(first.inlineTokens as Record<string, { type: string }>)).toEqual([
      expect.objectContaining({ type: 'at', id: 'docs/a.ts' })
    ])
    await rejectPrompt(notSent())
    expect(shot()).toEqual(before)
    expect(popoverOpen()).toBe(false)
    await pressEnter()
    expect(prompt.mock.calls[1]![0]).toEqual(first)
  })

  describe('SF-17 粘贴芯片', () => {
    const TEXT = longPaste('line')
    const CHIP = 'Pasted text #1 · 12 lines'

    async function restored(): Promise<void> {
      await type('see ')
      await paste(TEXT)
      expect(shot().chips).toEqual([CHIP])
      const before = shot()
      await pressEnter()
      await rejectPrompt(notSent())
      expect(shot()).toEqual(before)
    }

    it('回来，重发相等', async () => {
      await mount()
      await type('see ')
      await paste(TEXT)
      await expectRoundTrip()
      expect(prompt.mock.calls[0]![0].inlineTokens.p0.payload).toBe(TEXT)
    })

    it('放回之后退格整个删；再粘贴用下一个序号', async () => {
      await mount()
      await restored()
      const el = textarea()
      el.selectionStart = el.selectionEnd = el.value.length
      await pressKey(el, 'Backspace')
      expect(textarea().value).toBe('see ')
      expect(shot().chips).toEqual([])
      await paste(longPaste('other'))
      expect(shot().chips).toEqual(['Pasted text #2 · 12 lines'])
    })

    it('放回之后接着粘贴：序号不撞，两段全文都发得出去', async () => {
      await mount()
      await restored()
      const other = longPaste('other')
      await paste(other)
      expect(shot().chips).toEqual([CHIP, 'Pasted text #2 · 12 lines'])
      await pressEnter()
      const tokens = prompt.mock.calls[1]![0].inlineTokens as Record<string, { payload: string }>
      expect(Object.values(tokens).map((token) => token.payload)).toEqual([TEXT, other])
    })
  })

  it('SF-18 文字 + 图片 + @ + 粘贴 + 要藏的值（lost + GRACE）', async () => {
    await mount()
    await pickMention()
    await paste(longPaste('line'))
    await type(`${textarea().value} and `)
    await addSecret(SECRET)
    await act(async () => useChatStore.setState({ pendingImages: [IMG_1] }))
    expect(shot().chips).toEqual(['@a.ts', 'Pasted text #1 · 12 lines'])
    expect(shot().secretChips).toHaveLength(1)
    await expectRoundTrip(async () => {
      await rejectPrompt(lost())
      await advance(GRACE)
    })
    expect(prompt.mock.calls[0]![0].secrets).toEqual([{ value: SECRET, category: 'PASSWORD' }])
    expect(prompt.mock.calls[0]![0].images).toHaveLength(1)
  })

  it('SF-18 命令芯片 + 粘贴 + 图片', async () => {
    await mount()
    await type('/cmd ')
    await paste(longPaste('line'))
    await act(async () => useChatStore.setState({ pendingImages: [IMG_2] }))
    expect(shot().slash).toBe('/cmd')
    expect(shot().chips).toHaveLength(1)
    await expectRoundTrip()
    expect(Object.keys(prompt.mock.calls[0]![0].inlineTokens)).toEqual(['t0', 'p0'])
  })

  it.each<[string, unknown, string]>([
    ['handler_error', handlerError('server said no'), 'server said no'],
    ['抛出的非 Error', 'plain failure', 'plain failure']
  ])('SF-19 %s：报原文、放回', async (_label, error, reason) => {
    await mount()
    await send('hello')
    await rejectPrompt(error)
    expect(sendError()).toBe(failedWith(reason))
    expect(textarea().value).toBe('hello')
    expect(selectPendingPrompt(store())).toBeNull()
  })

  it.each(['en', 'zh', 'ja'])('SF-19 %s：两种连接错误都是本地化的那句', async (lng) => {
    await act(async () => {
      await i18n.changeLanguage(lng)
    })
    await mount()
    const sentence = ({ en, zh, ja } as Record<string, typeof en>)[lng]!.input.connectionLost
    expect(sentence).toBeTruthy()
    expect(ERR()).toContain(sentence)
    const expectLocalized = (): void => {
      expect(sendError()).toBe(ERR())
      expect(sendError()).not.toMatch(/disconnected|not connected|not_connected/)
    }

    await send('hello')
    await rejectPrompt(notSent())
    expectLocalized()

    await pressEnter()
    await rejectPrompt(lost())
    expect(sendError()).toBeNull()
    await advance(GRACE)
    expectLocalized()
  })
})

describe('不盖掉新内容', () => {
  /** 发一条、lost，开始等（连着，宽限在走） */
  async function waiting(value = 'first'): Promise<void> {
    await mount()
    await send(value)
    await rejectPrompt(lost())
  }

  it('SF-20 等待期间打了新字、插了新胶囊 → 不动，重发带新的值，ERR 照报', async () => {
    await waiting()
    await type('new ')
    await addSecret(SECRET)
    const typed = shot()
    expect(typed.secretChips).toHaveLength(1)
    await advance(GRACE)
    expect(shot()).toEqual(typed)
    expect(sendError()).toBe(ERR())
    await pressEnter()
    expect(prompt.mock.calls[1]![0]).toEqual({
      sessionId: A,
      text: `new ${SECRET}`,
      secrets: [{ value: SECRET, category: 'PASSWORD' }]
    })
  })

  it('SF-21 等待期间只打了空白 → 当作空，放回', async () => {
    await waiting()
    await type('  \n ')
    await advance(GRACE)
    expect(textarea().value).toBe('first')
    expect(sendError()).toBe(ERR())
  })

  it('SF-22 选了新命令 → 芯片不动，旧消息不掺进来，ERR 照报', async () => {
    await waiting()
    await type('/cmd ')
    expect(shot().slash).toBe('/cmd')
    await advance(GRACE)
    expect(shot().slash).toBe('/cmd')
    expect(textarea().value).toBe('')
    expect(sendError()).toBe(ERR())
  })

  it('SF-22 附了新图 → 图不动，旧消息不掺进来，ERR 照报', async () => {
    await mount()
    await act(async () => useChatStore.setState({ pendingImages: [IMG_1] }))
    await send('first')
    expect(store().pendingImages).toEqual([])
    await rejectPrompt(lost())
    await act(async () => store().addPendingImage(IMG_2))
    await advance(GRACE)
    expect(store().pendingImages).toEqual([IMG_2])
    expect(textarea().value).toBe('')
    expect(sendError()).toBe(ERR())
  })

  it('SF-23 切到 B（有字、有胶囊、有图）10×GRACE → B 一动不动、没有提示，A 的占位还在', async () => {
    await waiting()
    await switchTo(B, idleView(B))
    await type('in b ')
    await paste(longPaste('line'))
    await act(async () => useChatStore.setState({ pendingImages: [IMG_1] }))
    const before = shot()
    expect(before.chips).toHaveLength(1)

    await advance(10 * GRACE)
    expect(shot()).toEqual(before)
    expect(sendError()).toBeNull()
    expect(store().sessionPendingPrompt[A]).toBeDefined()
    expect(store().composerRestoreRequest).toBeNull()
  })

  it('SF-24 切走再切回 A，视图没带来 → 切回之后满 GRACE，在 A 放回并报 ERR', async () => {
    await waiting()
    await advance(GRACE - 1)
    await switchTo(B, idleView(B))
    await advance(5 * GRACE)
    await switchTo(A, idleView(A))
    await advance(GRACE - 1)
    expect(sendError()).toBeNull()
    expect(textarea().value).toBe('')
    await advance(1)
    expect(store().activeSessionId).toBe(A)
    expect(textarea().value).toBe('first')
    expect(sendError()).toBe(ERR())
  })

  it('SF-25 切走 10×GRACE 再切回 A，视图里有这条消息且 idle → 没有提示、不放回', async () => {
    await waiting()
    await switchTo(B, idleView(B))
    await advance(10 * GRACE)
    await switchTo(
      A,
      idleView(A, [user('u_new', 'first', A), assistant('a_new', [text('done')], A)])
    )
    await advance(2 * GRACE)
    expect(selectPendingPrompt(store())).toBeNull()
    expect(sendError()).toBeNull()
    expect(textarea().value).toBe('')
    expect(store().composerRestoreRequest).toBeNull()
  })

  it('SF-26 InputArea 卸掉（手机返回），宽限过了再挂回来 → 真值不在 DOM，胶囊可用，ERR，重发相等', async () => {
    await mount()
    await type('use ')
    await addSecret(SECRET)
    await paste(longPaste('line'))
    const before = shot()
    await pressEnter()
    const first = prompt.mock.calls[0]![0]
    await rejectPrompt(lost())

    act(() => root.unmount())
    root = createRoot(container)
    await advance(GRACE)
    expect(store().composerRestoreRequest?.sessionId).toBe(A)
    expect(document.body.innerHTML).not.toContain(SECRET)

    await mount()
    expect(store().composerRestoreRequest).toBeNull()
    expect(shot()).toEqual(before)
    expect(document.body.innerHTML).not.toContain(SECRET)
    expect(textarea().value).not.toContain(SECRET)
    expect(sendError()).toBe(ERR())

    await pressEnter()
    expect(prompt.mock.calls[1]![0]).toEqual(first)
    expect(prompt.mock.calls[1]![0].secrets).toEqual([{ value: SECRET, category: 'PASSWORD' }])
  })
})

describe('提示的显示', () => {
  /** A 失败一次：话放回了，提示在 */
  async function failInA(value = 'for a'): Promise<void> {
    await send(value)
    await rejectPrompt(notSent())
    expect(sendError()).toBe(ERR())
  }

  it('SE-1 去 idle 的 B 看不到，回 A 还在', async () => {
    await mount()
    await failInA()
    await switchTo(B, idleView(B))
    expect(sendError()).toBeNull()
    await switchTo(A, idleView(A))
    expect(sendError()).toBe(ERR())
  })

  it('SE-2 去在跑的 B 再回 idle 的 A → 还在', async () => {
    await mount()
    await failInA()
    await switchTo(B, busyView(B))
    expect(selectIsStreaming(store())).toBe(true)
    expect(sendError()).toBeNull()
    await switchTo(A, idleView(A))
    expect(selectIsStreaming(store())).toBe(false)
    expect(sendError()).toBe(ERR())
  })

  it('SE-3 A 的视图变 busy（别的设备发的）→ 清掉，字不动', async () => {
    await mount()
    await failInA()
    await applyView(A, busyView(A, [user('u_other', 'from my phone', A)]))
    expect(sendError()).toBeNull()
    expect(textarea().value).toBe('for a')
  })

  it('SE-4 A 的视图变 busy，只多一条系统通知（自动续跑）→ 清掉', async () => {
    await mount()
    await failInA()
    await applyView(A, busyView(A, [noticeEntry(A)]))
    expect(sendError()).toBeNull()
    expect(textarea().value).toBe('for a')
  })

  it('SE-5 人在 B，A 跑了一轮又结束（agent_start / agent_end 的余项）→ 回 A 没了', async () => {
    await mount()
    await failInA()
    await switchTo(B, idleView(B))
    // A 的视图退订了：运行状态只剩事件喂的余项
    await act(async () => store().markSessionRunning(A, true))
    await act(async () => store().markSessionRunning(A, false))
    await switchTo(A, idleView(A))
    expect(sendError()).toBeNull()
  })

  it('SE-6 放回本身不清提示，敲一个键才清', async () => {
    await mount()
    await failInA()
    await rerender()
    expect(textarea().value).toBe('for a')
    expect(sendError()).toBe(ERR())
    await type('for a!')
    expect(sendError()).toBeNull()
  })

  it('SE-7 A 失败之后 B 也失败，回 A → B 的文字不出现在 A', async () => {
    await mount()
    await failInA()
    await switchTo(B, idleView(B))
    await send('for b')
    await rejectPrompt(handlerError('only in b'))
    expect(sendError()).toBe(failedWith('only in b'))
    await switchTo(A, idleView(A))
    expect(sendError() ?? '').not.toContain('only in b')
  })

  it('SE-8 欢迎页的失败只在欢迎页', async () => {
    createSession.mockRejectedValueOnce(new Error('create failed'))
    store().setActiveSessionId(null)
    await mount()
    await send('hello')
    expect(sendError()).toBe(failedWith('create failed'))
    expect(textarea().value).toBe('hello')
    await switchTo(A, idleView(A))
    expect(sendError()).toBeNull()
  })

  it('SE-9 在 B 敲键，A 的提示不受影响', async () => {
    await mount()
    await failInA()
    await switchTo(B, idleView(B))
    await type('typing in b')
    await switchTo(A, idleView(A))
    expect(sendError()).toBe(ERR())
  })

  it('SE-10 运行中 steer 失败：这一轮跑着时一直在；结束也还在；新一轮开始才清', async () => {
    steer.mockRejectedValueOnce(notSent())
    await mount()
    await applyView(A, busyView(A))
    await type('steer this')
    await pressEnter()
    expect(steer).toHaveBeenCalledTimes(1)
    expect(selectIsStreaming(store())).toBe(true)
    expect(sendError()).toBe(ERR())

    await rerender()
    await applyView(A, busyView(A, [assistant('a2', [text('still going')], A)]))
    expect(sendError()).toBe(ERR())

    await applyView(A, idleView(A, [assistant('a2', [text('done')], A)]))
    expect(sendError()).toBe(ERR())

    await applyView(A, busyView(A, [assistant('a2', [text('done')], A)]))
    expect(sendError()).toBeNull()
  })
})
