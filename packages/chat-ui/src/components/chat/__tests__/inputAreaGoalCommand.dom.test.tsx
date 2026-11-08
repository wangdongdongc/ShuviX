// @vitest-environment jsdom
/**
 * 输入框的内置命令 `/goal`（目标模式，docs/goal-mode-design.md §3；jsdom）：`/goal 条件` 不当消息发，交给宿主的
 * `agent.goalAct`（set），别的发送一概不受影响。
 *
 *   IG-1 敲 `/goal 条件` 回车 → 变芯片、goalAct(set, 条件)，没有 prompt；成功之后输入框与芯片都清掉
 *   IG-2 被拒 → 话和芯片都留着，卡片上是宿主那句话（不套「发送失败」）；再改一个字提示就没了
 *   IG-3 弹层：`/go` 时 `/goal` 排第一、带「实验」标签；回车选中成芯片；只有芯片时回车 → 不发，打开「设新目标」编辑器
 *   IG-4 已有进行中的目标时只发 `/goal` → 打开「改目标」编辑器
 *   IG-5 普通消息、别的命令照常走 prompt，goalAct 一次没调
 *   IG-6 宿主没有 goalAct（旧宿主）/ 会话是笔记本 → 没有内置命令，`/goal x` 当普通文字发
 *   IG-7 会话在跑：`/goal x` 回车 → goalAct，不 steer
 *   IG-8 欢迎页：只发 `/goal` → 提示用法、不建会话；`/goal x` → 先建会话再设目标
 *   IG-9 条件里的长文粘贴芯片就地展开成文字
 *
 * 后端是假的 `window.api`（同 inputAreaSendFailure.dom.test.tsx）。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type { AvailableModel, ProviderInfo } from '@shuvix/chat-protocol/types/provider'
import type { GoalActResult, GoalView } from '@shuvix/chat-protocol/types/goal'

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
import { V, assistant, resetStore, store, text, user } from '../../../__tests__/support/views'
import {
  composerShot,
  deferred,
  fakeLink,
  flush,
  longPaste,
  pasteInto,
  pressKey,
  typeInto,
  type Deferred
} from '../../../__tests__/support/sendFailure'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const P = 'prov-1'
const M = 'model-m'
const A = 's1'
const CMD = {
  commandId: 'cmd',
  name: 'Cmd',
  description: 'a command',
  template: 'Run: $ARGUMENTS'
}

let prompt: ReturnType<typeof vi.fn>
let steer: ReturnType<typeof vi.fn>
let goalAct: ReturnType<typeof vi.fn>
let goalResults: Array<Deferred<GoalActResult>>
let createSession: ReturnType<typeof vi.fn>

function buildApi(opts: { goal?: boolean } = {}): Record<string, unknown> {
  goalResults = []
  prompt = vi.fn(async () => ({ success: true }))
  steer = vi.fn(async () => ({ success: true }))
  goalAct = vi.fn(() => {
    const next = deferred<GoalActResult>()
    goalResults.push(next)
    return next.promise
  })
  createSession = vi.fn(async () => ({ id: 'new-session' }))
  return {
    session: { list: async () => [], create: createSession, delete: vi.fn(async () => ({})) },
    agent: {
      init: async () => ({ success: true }),
      prompt,
      steer,
      followUp: vi.fn(async () => ({ success: true })),
      abort: vi.fn(async () => ({ success: true })),
      respondToInput: vi.fn(async () => ({ success: true })),
      setModel: vi.fn(async () => ({ success: true })),
      setThinkingLevel: vi.fn(async () => ({ success: true })),
      ...(opts.goal === false ? {} : { goalAct })
    },
    tools: { list: async () => [] },
    files: { scan: async () => ({ root: '/w/proj', paths: [], truncated: false }) },
    mentions: { listKnowledgeEntries: async () => [] },
    events: { subscribe: () => () => {} },
    app: { openSettings: () => {} },
    sync: fakeLink()
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

const row = (
  id: string,
  settings: Record<string, unknown> = {}
): ReturnType<typeof store>['sessions'][number] => ({
  id,
  title: id,
  projectId: null,
  parentId: null,
  settings,
  createdAt: 0,
  updatedAt: 0,
  lastActiveAt: 0
})

const GOAL: GoalView = {
  id: 'g_1',
  sessionId: A,
  objective: 'ship it',
  status: 'active',
  setAt: 0,
  limits: { costUsd: 5, maxTurns: 50, stallTurns: 3 },
  baselineCostUsd: 0,
  turns: 2,
  stalls: 0,
  activeMs: 0,
  costUsd: 0.5,
  judging: false,
    planning: false,
  checkerMissing: false
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
const sendError = (): string | null =>
  container.querySelector('[data-send-error]')?.textContent ?? null

async function send(value: string): Promise<void> {
  await type(value)
  await pressEnter()
}

/** 第 n 次 goalAct 落定（缺省最后一次） */
async function settleGoal(result: GoalActResult, index = -1): Promise<void> {
  await act(async () => goalResults.at(index)!.resolve(result))
  await flush()
}

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    showSupportNotice: false
  })
  Element.prototype.scrollIntoView = vi.fn()
})

function seed(opts: { active?: string | null; settings?: Record<string, unknown> } = {}): void {
  const active = opts.active === undefined ? A : opts.active
  for (const sid of [A, 'new-session']) {
    store().setActiveSessionId(sid)
    store().setInputText('')
  }
  store().setActiveSessionId(active)
  resetStore(active)
  useChatStore.setState({
    sessions: [row(A, opts.settings)],
    slashCommands: [CMD],
    modelSupportsVision: false,
    maxContextTokens: 0,
    composerRestoreRequest: null,
    sessionGoals: {},
    goalEditor: null,
    welcomeEnabledTools: [],
    welcomeKnowledgeBases: null
  })
  if (active) {
    applySessionView(
      active,
      V(active, {
        messages: [user('u1', 'earlier', active), assistant('a1', [text('ok')], active)],
        run: { state: 'idle' }
      })
    )
  }
}

beforeEach(() => {
  ;(window as unknown as { api: unknown }).api = buildApi()
  useModelCatalogStore.setState({ loaded: true, providers: [PROVIDER], availableModels: [MODEL] })
  seed()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

describe('/goal 条件', () => {
  it('IG-1 变芯片、goalAct(set)、不发 prompt；成功后清空', async () => {
    await mount()
    await type('/goal make tests pass')
    expect(shot()).toMatchObject({ text: 'make tests pass', slash: '/goal' })

    await pressEnter()
    expect(goalAct).toHaveBeenCalledTimes(1)
    expect(goalAct).toHaveBeenCalledWith({
      sessionId: A,
      action: { type: 'set', objective: 'make tests pass' }
    })
    expect(prompt).not.toHaveBeenCalled()
    // 等宿主回话期间话还在
    expect(shot()).toMatchObject({ text: 'make tests pass', slash: '/goal' })

    await settleGoal({ ok: true })
    expect(shot()).toMatchObject({ text: '', slash: null })
    expect(sendError()).toBeNull()
  })

  it('IG-2 被拒：话和芯片留着，卡片上是宿主那句话；改一个字提示消失', async () => {
    await mount()
    await send('/goal make tests pass')
    await settleGoal({ ok: false, error: 'Goals can be set only in your own conversations.' })
    expect(shot()).toMatchObject({ text: 'make tests pass', slash: '/goal' })
    expect(sendError()).toBe('Goals can be set only in your own conversations.')
    expect(prompt).not.toHaveBeenCalled()

    await type('make tests pass!')
    expect(sendError()).toBeNull()
  })

  it('IG-9 长文粘贴芯片就地展开进条件', async () => {
    await mount()
    await type('/goal ')
    const long = longPaste('req')
    await pasteInto(textarea(), long)
    await pressEnter()
    expect(goalAct).toHaveBeenCalledTimes(1)
    const objective = (goalAct.mock.calls[0][0] as { action: { objective: string } }).action
      .objective
    expect(objective).toContain('req 0')
    expect(objective).toContain('req 11')
  })
})

describe('只发 /goal', () => {
  it('IG-3 弹层里排第一、带实验标签；选中成芯片；再回车 → 打开「设新目标」编辑器，不发', async () => {
    await mount()
    await type('/go')
    const items = [...container.querySelectorAll('button')].filter((b) =>
      b.textContent?.startsWith('/')
    )
    expect(items[0]?.textContent).toContain('/goal')
    expect(items[0]?.querySelector('[data-experimental="goal"]')).not.toBeNull()

    await type('/goal')
    await pressEnter()
    expect(shot()).toMatchObject({ text: '', slash: '/goal' })
    expect(goalAct).not.toHaveBeenCalled()

    await pressEnter()
    expect(goalAct).not.toHaveBeenCalled()
    expect(prompt).not.toHaveBeenCalled()
    expect(store().goalEditor).toMatchObject({ sessionId: A, mode: 'new' })
    expect(shot()).toMatchObject({ text: '', slash: null })
  })

  it('IG-4 已有进行中的目标 → 打开「改目标」编辑器', async () => {
    useChatStore.setState({ sessionGoals: { [A]: GOAL } })
    await mount()
    await type('/goal')
    await pressEnter()
    await pressEnter()
    expect(store().goalEditor).toMatchObject({ sessionId: A, mode: 'edit' })
    expect(goalAct).not.toHaveBeenCalled()
  })
})

describe('别的发送不受影响', () => {
  it('IG-5 普通消息与别的命令走 prompt', async () => {
    await mount()
    await send('hello')
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(prompt.mock.calls[0][0]).toMatchObject({ sessionId: A, text: 'hello' })

    await send('/cmd do it')
    expect(prompt).toHaveBeenCalledTimes(2)
    const sent = prompt.mock.calls[1][0] as {
      inlineTokens: Record<string, { type: string; payload: string }>
    }
    expect(Object.values(sent.inlineTokens)[0]).toMatchObject({
      type: 'cmd',
      payload: 'Run: do it'
    })

    // 文字里提到 /goal 不算命令
    await send('please read /goal docs')
    expect(prompt).toHaveBeenCalledTimes(3)
    expect(goalAct).not.toHaveBeenCalled()
  })

  it('IG-6a 宿主没有 goalAct → 没有内置命令，`/goal x` 当文字发', async () => {
    ;(window as unknown as { api: unknown }).api = buildApi({ goal: false })
    await mount()
    await type('/go')
    expect(container.textContent).not.toContain('/goal')
    await send('/goal x')
    expect(shot().slash).toBeNull()
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(prompt.mock.calls[0][0]).toMatchObject({ text: '/goal x' })
  })

  it('IG-6b 笔记本会话 → 没有内置命令', async () => {
    seed({ settings: { notebookPath: 'notes/a.md' } })
    await mount()
    await send('/goal x')
    expect(goalAct).not.toHaveBeenCalled()
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(prompt.mock.calls[0][0]).toMatchObject({ text: '/goal x' })
  })

  it('IG-7 会话在跑：/goal x → goalAct，不 steer', async () => {
    applySessionView(
      A,
      V(A, {
        messages: [user('u1', 'earlier', A), assistant('a1', [text('ok')], A)],
        run: { state: 'busy' }
      })
    )
    await mount()
    await send('/goal keep going until green')
    expect(goalAct).toHaveBeenCalledWith({
      sessionId: A,
      action: { type: 'set', objective: 'keep going until green' }
    })
    expect(steer).not.toHaveBeenCalled()
    expect(prompt).not.toHaveBeenCalled()
  })
})

describe('欢迎页', () => {
  it('IG-8a 只发 /goal → 提示用法，不建会话', async () => {
    seed({ active: null })
    await mount()
    await type('/goal')
    await pressEnter()
    await pressEnter()
    expect(sendError()).toBe(en.goal.usageHint)
    expect(createSession).not.toHaveBeenCalled()
    expect(goalAct).not.toHaveBeenCalled()
  })

  it('IG-8b /goal x → 先建会话，再在新会话上设目标；成功后清空', async () => {
    seed({ active: null })
    await mount()
    await send('/goal write the report')
    await flush()
    expect(createSession).toHaveBeenCalledTimes(1)
    expect(goalAct).toHaveBeenCalledWith({
      sessionId: 'new-session',
      action: { type: 'set', objective: 'write the report' }
    })
    await settleGoal({ ok: true })
    expect(store().activeSessionId).toBe('new-session')
    expect(shot()).toMatchObject({ text: '', slash: null })
    expect(prompt).not.toHaveBeenCalled()
  })
})
