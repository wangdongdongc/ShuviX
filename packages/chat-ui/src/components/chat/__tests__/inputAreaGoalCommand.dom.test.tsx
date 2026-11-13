// @vitest-environment jsdom
/**
 * 输入框的内置命令 `/goal`（目标，docs/goal-mode-design.md §16；jsdom）：`/goal 条件` 不当消息发，交给宿主的
 * `agent.goalStart` —— 宿主把这条会话 fork 一份作目标的管理员，界面切到交回的那条管理员会话。别的发送一概不受影响。
 *
 *   IG-1 敲 `/goal 条件` 回车 → 变芯片、goalStart(会话, 条件)，没有 prompt；成功之后输入框与芯片都清掉、会话列表
 *        刷新、打开交回的管理员会话（宿主有 `openSession` 用它，没有就 `setActiveSessionId`）
 *   IG-2 被拒 → 话和芯片都留着，卡片上是宿主那句话（不套「发送失败」），不开任何会话；再改一个字提示就没了；
 *        goalStart 抛错同样留话、报原因
 *   IG-3 弹层：`/go` 时 `/goal` 排第一、带「实验」标签；回车选中成芯片；只有芯片时回车 → 提示用法，不发、不开会话
 *   IG-4 等宿主回话的时候换到了别的会话 → 列表照样刷新，不替用户切走
 *   IG-5 普通消息、别的命令照常走 prompt，goalStart 一次没调
 *   IG-6 宿主没有 goalStart（旧宿主）/ 会话是笔记本 / 会话是目标的管理员 → 没有内置命令，`/goal x` 当普通文字发
 *   IG-7 会话在跑：`/goal x` 回车 → goalStart，不 steer
 *   IG-8 欢迎页：只发 `/goal` → 提示用法、不建会话；`/goal x` → 先建会话再设目标，成功后打开管理员会话
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
import type { GoalStartResult } from '@shuvix/chat-protocol/types/goal'

/** 宿主的 `openSession`（app-shell 给的导航口）：缺省有；`current = undefined` 模拟没有它的宿主 */
const hostNav = vi.hoisted(() => ({
  current: undefined as ((sessionId: string) => void) | undefined
}))

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
      },
      ...(hostNav.current ? { openSession: hostNav.current } : {})
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
/** goalStart 交回的管理员会话 */
const MANAGER = 'manager-1'
const CMD = {
  commandId: 'cmd',
  name: 'Cmd',
  description: 'a command',
  template: 'Run: $ARGUMENTS'
}

let prompt: ReturnType<typeof vi.fn>
let steer: ReturnType<typeof vi.fn>
let goalStart: ReturnType<typeof vi.fn>
let goalResults: Array<Deferred<GoalStartResult>>
let createSession: ReturnType<typeof vi.fn>
let listSessions: ReturnType<typeof vi.fn>
let openSession: ReturnType<typeof vi.fn<(sessionId: string) => void>>

function buildApi(opts: { goal?: boolean } = {}): Record<string, unknown> {
  goalResults = []
  prompt = vi.fn(async () => ({ success: true }))
  steer = vi.fn(async () => ({ success: true }))
  goalStart = vi.fn(() => {
    const next = deferred<GoalStartResult>()
    goalResults.push(next)
    return next.promise
  })
  createSession = vi.fn(async () => ({ id: 'new-session' }))
  // 宿主设好目标之后的列表：原会话 + fork 出来的管理员会话
  listSessions = vi.fn(async () => [row(A), row(MANAGER, { goalManagerOf: A })])
  return {
    session: { list: listSessions, create: createSession, delete: vi.fn(async () => ({})) },
    agent: {
      init: async () => ({ success: true }),
      prompt,
      steer,
      followUp: vi.fn(async () => ({ success: true })),
      abort: vi.fn(async () => ({ success: true })),
      respondToInput: vi.fn(async () => ({ success: true })),
      setModel: vi.fn(async () => ({ success: true })),
      setThinkingLevel: vi.fn(async () => ({ success: true })),
      ...(opts.goal === false ? {} : { goalStart })
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

/** 第 n 次 goalStart 落定（缺省最后一次） */
async function settleGoal(result: GoalStartResult, index = -1): Promise<void> {
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
  openSession = vi.fn<(sessionId: string) => void>()
  hostNav.current = openSession
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

const sessionIds = (): string[] => store().sessions.map((session) => session.id)

describe('/goal 条件', () => {
  it('IG-1 变芯片、goalStart、不发 prompt；成功后清空、刷新列表、打开管理员会话（openSession）', async () => {
    await mount()
    await type('/goal make tests pass')
    expect(shot()).toMatchObject({ text: 'make tests pass', slash: '/goal' })

    await pressEnter()
    expect(goalStart).toHaveBeenCalledTimes(1)
    expect(goalStart).toHaveBeenCalledWith({ sessionId: A, objective: 'make tests pass' })
    expect(prompt).not.toHaveBeenCalled()
    // 等宿主回话期间话还在，什么都没打开
    expect(shot()).toMatchObject({ text: 'make tests pass', slash: '/goal' })
    expect(openSession).not.toHaveBeenCalled()
    expect(sessionIds()).toEqual([A])

    await settleGoal({ ok: true, sessionId: MANAGER })
    expect(shot()).toMatchObject({ text: '', slash: null })
    expect(sendError()).toBeNull()
    expect(listSessions).toHaveBeenCalledTimes(1)
    expect(sessionIds()).toEqual([A, MANAGER])
    expect(openSession.mock.calls).toEqual([[MANAGER]])
    expect(prompt).not.toHaveBeenCalled()
  })

  it('IG-1 宿主没有 openSession → setActiveSessionId(管理员会话)', async () => {
    hostNav.current = undefined
    await mount()
    await send('/goal make tests pass')
    expect(store().activeSessionId).toBe(A)
    await settleGoal({ ok: true, sessionId: MANAGER })
    expect(store().activeSessionId).toBe(MANAGER)
    expect(sessionIds()).toEqual([A, MANAGER])
    expect(openSession).not.toHaveBeenCalled()
  })

  it('IG-1 刷新列表失败不算失败：照样清空、打开管理员会话', async () => {
    listSessions.mockRejectedValueOnce(new Error('list failed'))
    await mount()
    await send('/goal make tests pass')
    await settleGoal({ ok: true, sessionId: MANAGER })
    expect(shot()).toMatchObject({ text: '', slash: null })
    expect(sendError()).toBeNull()
    expect(sessionIds()).toEqual([A])
    expect(openSession.mock.calls).toEqual([[MANAGER]])
  })

  it('IG-2 被拒：话和芯片留着，卡片上是宿主那句话，不开会话；改一个字提示消失', async () => {
    await mount()
    await send('/goal make tests pass')
    await settleGoal({ ok: false, error: 'This session is busy. Set the goal when it stops.' })
    expect(shot()).toMatchObject({ text: 'make tests pass', slash: '/goal' })
    expect(sendError()).toBe('This session is busy. Set the goal when it stops.')
    expect(prompt).not.toHaveBeenCalled()
    expect(openSession).not.toHaveBeenCalled()
    expect(listSessions).not.toHaveBeenCalled()
    expect(store().activeSessionId).toBe(A)

    await type('make tests pass!')
    expect(sendError()).toBeNull()
  })

  it('IG-2 goalStart 抛错：话留着、报原因、不开会话；之后还能再发', async () => {
    await mount()
    await send('/goal make tests pass')
    await act(async () => goalResults.at(-1)!.reject(new Error('boom')))
    await flush()
    expect(shot()).toMatchObject({ text: 'make tests pass', slash: '/goal' })
    expect(sendError()).not.toBeNull()
    expect(openSession).not.toHaveBeenCalled()

    await pressEnter()
    expect(goalStart).toHaveBeenCalledTimes(2)
  })

  it('IG-4 等回话时换到了别的会话：列表照样刷新，不替用户切走', async () => {
    await mount()
    await send('/goal make tests pass')
    act(() => store().setActiveSessionId('elsewhere'))
    await settleGoal({ ok: true, sessionId: MANAGER })
    expect(sessionIds()).toEqual([A, MANAGER])
    expect(openSession).not.toHaveBeenCalled()
    expect(store().activeSessionId).toBe('elsewhere')
  })

  it('IG-9 长文粘贴芯片就地展开进条件', async () => {
    await mount()
    await type('/goal ')
    const long = longPaste('req')
    await pasteInto(textarea(), long)
    await pressEnter()
    expect(goalStart).toHaveBeenCalledTimes(1)
    const { objective } = goalStart.mock.calls[0][0] as { objective: string }
    expect(objective).toContain('req 0')
    expect(objective).toContain('req 11')
  })
})

describe('只发 /goal', () => {
  it('IG-3 弹层里排第一、带实验标签；选中成芯片；再回车 → 提示用法，不发、不开会话', async () => {
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
    expect(goalStart).not.toHaveBeenCalled()
    expect(sendError()).toBeNull()

    await pressEnter()
    expect(sendError()).toBe(en.goal.usageHint)
    expect(goalStart).not.toHaveBeenCalled()
    expect(prompt).not.toHaveBeenCalled()
    expect(openSession).not.toHaveBeenCalled()
    expect(listSessions).not.toHaveBeenCalled()
    expect(store().activeSessionId).toBe(A)
    // 芯片还在：接着写条件就行
    expect(shot()).toMatchObject({ text: '', slash: '/goal' })
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
    expect(goalStart).not.toHaveBeenCalled()
  })

  it('IG-6a 宿主没有 goalStart → 没有内置命令，`/goal x` 当文字发', async () => {
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
    expect(goalStart).not.toHaveBeenCalled()
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(prompt.mock.calls[0][0]).toMatchObject({ text: '/goal x' })
  })

  it('IG-6c 目标的管理员会话（settings.goalManagerOf）→ 没有内置命令，`/goal x` 当文字发', async () => {
    seed({ settings: { goalManagerOf: 'worker-1' } })
    await mount()
    await type('/go')
    expect(container.textContent).not.toContain('/goal')
    await send('/goal x')
    expect(goalStart).not.toHaveBeenCalled()
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(prompt.mock.calls[0][0]).toMatchObject({ text: '/goal x' })
  })

  it('IG-7 会话在跑：/goal x → goalStart，不 steer', async () => {
    applySessionView(
      A,
      V(A, {
        messages: [user('u1', 'earlier', A), assistant('a1', [text('ok')], A)],
        run: { state: 'busy' }
      })
    )
    await mount()
    await send('/goal keep going until green')
    expect(goalStart).toHaveBeenCalledWith({
      sessionId: A,
      objective: 'keep going until green'
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
    expect(goalStart).not.toHaveBeenCalled()
    expect(openSession).not.toHaveBeenCalled()
  })

  it('IG-8b /goal x → 先建会话，再在新会话上设目标；成功后清空、打开管理员会话', async () => {
    seed({ active: null })
    await mount()
    await send('/goal write the report')
    await flush()
    expect(createSession).toHaveBeenCalledTimes(1)
    expect(goalStart).toHaveBeenCalledWith({
      sessionId: 'new-session',
      objective: 'write the report'
    })
    expect(store().activeSessionId).toBe('new-session')
    await settleGoal({ ok: true, sessionId: MANAGER })
    expect(openSession.mock.calls).toEqual([[MANAGER]])
    expect(shot()).toMatchObject({ text: '', slash: null })
    expect(prompt).not.toHaveBeenCalled()
  })
})
