// @vitest-environment jsdom
/**
 * InputArea 欢迎页直接发送（`createSessionForSend`）DOM 测试（jsdom）。
 *
 * 模型、思考档位与扩展能力都只在创建 Agent 那一刻读一次，所以欢迎页上的选择必须在 `agent.init`
 * 之前落进新会话：写的是选择器**此刻显示的**模型与档位（没动过也是它），扩展能力写欢迎页的草稿，
 * 写完清空草稿。顺序钉成一条时间线：
 *
 *   session.create → agent.setModel → agent.setThinkingLevel → session.updateEnabledTools
 *   → agent.init → session.list → agent.prompt
 *
 * 外加斜杠命令的依赖项落到它被发往的那条会话（新会话），以及已有会话 / 没选模型 / 新建失败三条边界。
 *
 * 后端整个是假的：`window.api` 一个对象同时充当 HostApi 与 SessionChannelApi（@ 引用的数据源直接读
 * `window.api`），所有调用按到达顺序记进同一条 timeline；`session.list` 的回包反映已经写进去的勾选。
 * 包入口 `@shuvix/chat-ui` 顶掉（同 toolPicker.dom.test.tsx），`useChatHost().models` 是固定的替身。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import type { AvailableModel, ProviderInfo } from '@shuvix/chat-protocol/types/provider'

interface Call {
  name: string
  args: unknown[]
}

const mocks = vi.hoisted(() => ({
  /** 宿主此刻显示的模型（null 字段 = 没选） */
  models: { activeProvider: 'prov-1', activeModel: 'model-m' },
  setActiveProvider: vi.fn(),
  setActiveModel: vi.fn()
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
        setActiveProvider: mocks.setActiveProvider,
        setActiveModel: mocks.setActiveModel
      }
    })
  }
})

import { useChatStore, type Session } from '../../../stores/chatStore'
import { useModelCatalogStore } from '../../../stores/modelCatalogStore'
import { InputArea, type InputAreaProps } from '../InputArea'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const P = 'prov-1'
const M = 'model-m'
const NEW = 'new-session'

// ─── 假后端 ────────────────────────────────────────────────────────────────

let timeline: Call[] = []
/** 后端的会话行（session.list 回的就是它们） */
let rows: Map<string, Session>
/** session.create 的行为（可换成 reject） */
let createImpl: () => Promise<Session>
/** agent.setModel 的行为（可换成 reject：新会话配到一半失败） */
let setModelImpl: () => Promise<{ success: boolean }>

const row = (id: string, enabledTools: string[] = []): Session => ({
  id,
  title: id,
  projectId: null,
  parentId: null,
  settings: { enabledTools },
  createdAt: 0,
  updatedAt: 0,
  lastActiveAt: 0
})

function record<A extends unknown[], R>(
  name: string,
  impl: (...args: A) => R
): Mock<(...args: A) => R> {
  return vi.fn((...args: A): R => {
    timeline.push({ name, args })
    return impl(...args)
  })
}

function buildApi(): Record<string, unknown> {
  return {
    session: {
      create: record('session.create', () => createImpl()),
      list: record('session.list', async () => [...rows.values()].map((r) => structuredClone(r))),
      updateEnabledTools: record(
        'session.updateEnabledTools',
        async (params: { id: string; enabledTools: string[] }) => {
          const r = rows.get(params.id)
          if (r) r.settings = { ...r.settings, enabledTools: [...params.enabledTools] }
          return { success: true }
        }
      ),
      delete: record('session.delete', async (id: string) => {
        rows.delete(id)
        return { success: true }
      })
    },
    agent: {
      setModel: record('agent.setModel', () => setModelImpl()),
      setThinkingLevel: record('agent.setThinkingLevel', async () => ({ success: true })),
      init: record('agent.init', async (params: { sessionId: string }) => ({
        success: true,
        created: false,
        provider: P,
        model: M,
        capabilities: {},
        modelMetadata: {},
        workingDirectory: '/w',
        enabledTools: rows.get(params.sessionId)?.settings.enabledTools ?? []
      })),
      prompt: record('agent.prompt', async () => ({ success: true })),
      abort: record('agent.abort', async () => ({ success: true })),
      respondToInput: record('agent.respondToInput', async () => ({ success: true }))
    },
    tools: {
      list: record('tools.list', async () => [
        { name: 'skill:a', label: 'a', group: '__skills__' },
        { name: 'skill:req', label: 'req', group: '__skills__' }
      ])
    },
    // @ 引用的数据源（会话出现后才去拉）
    files: { scan: record('files.scan', async () => ({ root: null, paths: [] })) },
    mentions: { listKnowledgeEntries: record('mentions.listKnowledgeEntries', async () => []) },
    events: { subscribe: record('events.subscribe', () => () => {}) },
    app: { openSettings: record('app.openSettings', () => {}) }
  }
}

/** 时间线里属于会话 / Agent 的那几步（工具列表、@ 引用的数据源不在此列） */
const steps = (): string[] =>
  timeline.map((c) => c.name).filter((n) => n.startsWith('session.') || n.startsWith('agent.'))
const callsOf = (name: string): unknown[][] =>
  timeline.filter((c) => c.name === name).map((c) => c.args)

// ─── 渲染与输入 ─────────────────────────────────────────────────────────────

let container: HTMLDivElement
let root: Root

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function mount(): Promise<void> {
  await act(async () => {
    // InputArea 的 props 形参带缺省值（可省），createElement 的重载认不出它收 inline —— 显式标一下
    const Area = InputArea as (props: InputAreaProps) => React.JSX.Element
    root.render(createElement(Area, { inline: true }))
  })
  await flush()
}

const textarea = (): HTMLTextAreaElement => {
  const el = container.querySelector('textarea')
  if (!el) throw new Error('textarea not rendered')
  return el
}

/** 像用户敲字那样改 textarea（走 React 的 onChange → handleInputChange） */
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
  await flush()
}

const store = (): ReturnType<typeof useChatStore.getState> => useChatStore.getState()

/** 卡片里的发送失败提示（不在屏为 null） */
const sendErrorText = (): string | null =>
  container.querySelector('[data-send-error]')?.textContent ?? null

/**
 * 期间冒出来的未处理 rejection。临时接管监听：断言「一条都没有」时，真冒出来的那条不会被测试框架
 * 当成本文件的错误吞掉，而是落进返回值、让断言如实失败
 */
async function collectUnhandled(run: () => Promise<void>): Promise<unknown[]> {
  const vitestListeners = process.listeners('unhandledRejection')
  process.removeAllListeners('unhandledRejection')
  const unhandled: unknown[] = []
  process.on('unhandledRejection', (reason) => unhandled.push(reason))
  try {
    await run()
  } finally {
    process.removeAllListeners('unhandledRejection')
    for (const l of vitestListeners) process.on('unhandledRejection', l)
  }
  return unhandled
}

/** 欢迎页：没有当前会话；显示 P/M、档位、草稿与命令都按给的种 */
function seedWelcome(opts: {
  draft?: string[]
  thinkingLevel?: string
  slashCommands?: ReturnType<typeof store>['slashCommands']
  model?: string
}): void {
  mocks.models.activeProvider = opts.model === '' ? '' : P
  mocks.models.activeModel = opts.model ?? M
  useChatStore.setState({
    sessions: [],
    sessionAgentCreated: {},
    sessionClosing: {},
    sessionStreams: {},
    sessionPendingPrompt: {},
    thinkingLevel: opts.thinkingLevel ?? 'low',
    welcomeEnabledTools: opts.draft ?? [],
    slashCommands: opts.slashCommands ?? [],
    inputText: '',
    pendingImages: []
  })
  store().setActiveSessionId(null)
  store().setInputText('')
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

const CMD = {
  commandId: 'cmd',
  name: 'Cmd',
  description: 'a command',
  template: 'Run: $ARGUMENTS',
  requiredTools: ['skill:req', 'skill:a']
}

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'zh',
    resources: { zh: { translation: zh } },
    showSupportNotice: false
  })
  // jsdom 没有 scrollIntoView（斜杠命令弹层挂载时会调）
  Element.prototype.scrollIntoView = vi.fn()
})

beforeEach(() => {
  timeline = []
  rows = new Map()
  createImpl = async () => {
    const r = row(NEW)
    rows.set(NEW, r)
    return structuredClone(r)
  }
  setModelImpl = async () => ({ success: true })
  ;(window as unknown as { api: unknown }).api = buildApi()
  useModelCatalogStore.setState({ loaded: true, providers: [PROVIDER], availableModels: [MODEL] })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

describe('欢迎页直接发送：选择在 agent.init 之前落进新会话', () => {
  it('WS-D-1 显示 P/M、档位 low、草稿 [skill:a] → create → setModel → setThinkingLevel → updateEnabledTools → init → list → prompt；草稿清空、切到新会话', async () => {
    seedWelcome({ draft: ['skill:a'], thinkingLevel: 'low' })
    await mount()
    await type('hello')
    await pressEnter()

    expect(steps()).toEqual([
      'session.create',
      'agent.setModel',
      'agent.setThinkingLevel',
      'session.updateEnabledTools',
      'agent.init',
      'session.list',
      'agent.prompt'
    ])
    expect(callsOf('agent.setModel')).toEqual([[{ sessionId: NEW, provider: P, model: M }]])
    expect(callsOf('agent.setThinkingLevel')).toEqual([[{ sessionId: NEW, level: 'low' }]])
    expect(callsOf('session.updateEnabledTools')).toEqual([
      [{ id: NEW, enabledTools: ['skill:a'] }]
    ])
    expect(callsOf('agent.init')).toEqual([[{ sessionId: NEW }]])
    const [prompt] = callsOf('agent.prompt')[0] as [{ sessionId: string; text: string }]
    expect(prompt.sessionId).toBe(NEW)
    expect(prompt.text).toBe('hello')

    expect(store().welcomeEnabledTools).toEqual([])
    expect(store().activeSessionId).toBe(NEW)
    expect(store().sessions.find((s) => s.id === NEW)?.settings.enabledTools).toEqual(['skill:a'])
  })

  it('WS-D-2 草稿为空 → 不调 updateEnabledTools，其余照常', async () => {
    seedWelcome({ draft: [] })
    await mount()
    await type('hello')
    await pressEnter()

    expect(steps()).toEqual([
      'session.create',
      'agent.setModel',
      'agent.setThinkingLevel',
      'agent.init',
      'session.list',
      'agent.prompt'
    ])
    expect(store().activeSessionId).toBe(NEW)
  })

  it('WS-D-3 没显示模型 → 回车不建会话；草稿与输入文本都保留', async () => {
    seedWelcome({ draft: ['skill:a'], model: '' })
    await mount()
    await type('hello')
    await pressEnter()

    expect(steps()).toEqual([])
    expect(store().welcomeEnabledTools).toEqual(['skill:a'])
    expect(store().inputText).toBe('hello')
    expect(textarea().value).toBe('hello')
    expect(store().activeSessionId).toBeNull()
  })

  it('WS-D-6 已有当前会话 → 不 create / setModel / setThinkingLevel；草稿非空也不动', async () => {
    seedWelcome({ draft: ['skill:a'] })
    rows.set('existing', row('existing', ['skill:x']))
    useChatStore.setState({ sessions: [row('existing', ['skill:x'])] })
    store().setActiveSessionId('existing')
    await mount()
    await type('hello')
    await pressEnter()

    expect(steps()).toEqual(['agent.prompt'])
    const [prompt] = callsOf('agent.prompt')[0] as [{ sessionId: string }]
    expect(prompt.sessionId).toBe('existing')
    expect(store().welcomeEnabledTools).toEqual(['skill:a'])
    expect(store().activeSessionId).toBe('existing')
  })

  it('WS-D-7 session.create reject → 卡片里写明失败原因、没有未处理的 rejection；草稿与输入文本都在、不调 prompt；再敲字提示消失', async () => {
    seedWelcome({ draft: ['skill:a'] })
    createImpl = () => Promise.reject(new Error('create failed'))
    await mount()
    await type('hello')

    const unhandled = await collectUnhandled(async () => {
      await pressEnter()
      await flush()
    })

    expect(unhandled).toEqual([])
    expect(steps()).toEqual(['session.create'])
    expect(store().welcomeEnabledTools).toEqual(['skill:a'])
    expect(store().activeSessionId).toBeNull()
    expect(store().inputText).toBe('hello')
    expect(sendErrorText()).toBe(i18n.t('input.sendFailed', { error: 'create failed' }))

    await type('hello again')
    expect(sendErrorText()).toBeNull()
  })

  it('WS-D-7b 新会话配到一半失败（setModel reject）→ 删掉这条半成品会话；不 init、不 prompt；草稿与输入都在，失败原因写在卡片里', async () => {
    seedWelcome({ draft: ['skill:a'] })
    setModelImpl = () => Promise.reject(new Error('set model failed'))
    await mount()
    await type('hello')

    const unhandled = await collectUnhandled(async () => {
      await pressEnter()
      await flush()
    })

    expect(unhandled).toEqual([])
    expect(steps()).toEqual(['session.create', 'agent.setModel', 'session.delete'])
    expect(callsOf('session.delete')).toEqual([[NEW]])
    expect(rows.has(NEW)).toBe(false)
    expect(store().welcomeEnabledTools).toEqual(['skill:a'])
    expect(store().activeSessionId).toBeNull()
    expect(store().inputText).toBe('hello')
    expect(sendErrorText()).toBe(i18n.t('input.sendFailed', { error: 'set model failed' }))
  })
})

describe('斜杠命令的依赖项落到它被发往的会话', () => {
  it('WS-D-4 键入 /cmd do it（没转成芯片的那条路，同回退恢复的草稿）→ 依赖项第二次写进新会话、排在 prompt 之前；草稿保持 []', async () => {
    seedWelcome({ draft: ['skill:a'], slashCommands: [CMD] })
    await mount()
    // 绕过 handleInputChange 的「带空格即转芯片」：与消息回退恢复的草稿同一条路 —— 发送时才解析命令
    await act(async () => {
      store().setInputText('/cmd do it')
    })
    await flush()
    await pressEnter()

    const writes = callsOf('session.updateEnabledTools')
    expect(writes).toEqual([
      [{ id: NEW, enabledTools: ['skill:a'] }],
      [{ id: NEW, enabledTools: ['skill:a', 'skill:req'] }]
    ])
    const order = steps()
    expect(order.lastIndexOf('session.updateEnabledTools')).toBeLessThan(
      order.indexOf('agent.prompt')
    )
    expect(order.indexOf('agent.init')).toBeLessThan(
      order.lastIndexOf('session.updateEnabledTools')
    )
    // 依赖项进的是新会话，不是（已清空的）草稿
    expect(store().welcomeEnabledTools).toEqual([])
    expect(store().sessions.find((s) => s.id === NEW)?.settings.enabledTools).toEqual([
      'skill:a',
      'skill:req'
    ])
    const [prompt] = callsOf('agent.prompt')[0] as [{ sessionId: string }]
    expect(prompt.sessionId).toBe(NEW)
  })

  it('WS-D-4b 欢迎页键入 /cmd 加空格（转成芯片）→ 依赖项立即进草稿、零 IPC；发送后经第一次 updateEnabledTools 落进新会话', async () => {
    seedWelcome({ draft: ['skill:a'], slashCommands: [CMD] })
    await mount()
    await type('/cmd ')

    expect(store().welcomeEnabledTools).toEqual(['skill:a', 'skill:req'])
    expect(steps()).toEqual([])

    await type('do it')
    await pressEnter()

    expect(callsOf('session.updateEnabledTools')).toEqual([
      [{ id: NEW, enabledTools: ['skill:a', 'skill:req'] }]
    ])
    expect(store().welcomeEnabledTools).toEqual([])
    const [prompt] = callsOf('agent.prompt')[0] as [{ sessionId: string; text: string }]
    expect(prompt.sessionId).toBe(NEW)
  })

  it('WS-D-4c 已有会话（还没有 Agent）里键入 /cmd 加空格 → 立即写进这条会话的勾选，草稿不动', async () => {
    seedWelcome({ draft: ['skill:x'], slashCommands: [CMD] })
    rows.set('existing', row('existing', ['skill:a']))
    useChatStore.setState({ sessions: [row('existing', ['skill:a'])] })
    store().setActiveSessionId('existing')
    await mount()
    await type('/cmd ')

    expect(callsOf('session.updateEnabledTools')).toEqual([
      [{ id: 'existing', enabledTools: ['skill:a', 'skill:req'] }]
    ])
    expect(store().welcomeEnabledTools).toEqual(['skill:x'])
  })

  it('WS-D-5 欢迎页弹层选命令（芯片）→ 依赖项立即进草稿、零 IPC；发送后经第一次 updateEnabledTools 落进新会话、草稿清空', async () => {
    seedWelcome({ draft: ['skill:a'], slashCommands: [CMD] })
    await mount()
    await type('/')
    const item = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('/cmd')
    )
    expect(item, 'slash popover item').toBeDefined()
    await act(async () => {
      item!.click()
    })
    await flush()

    expect(store().welcomeEnabledTools).toEqual(['skill:a', 'skill:req'])
    expect(steps()).toEqual([])

    await type('do it')
    await pressEnter()

    expect(callsOf('session.updateEnabledTools')).toEqual([
      [{ id: NEW, enabledTools: ['skill:a', 'skill:req'] }]
    ])
    expect(steps()).toEqual([
      'session.create',
      'agent.setModel',
      'agent.setThinkingLevel',
      'session.updateEnabledTools',
      'agent.init',
      'session.list',
      'agent.prompt'
    ])
    expect(store().welcomeEnabledTools).toEqual([])
  })
})
