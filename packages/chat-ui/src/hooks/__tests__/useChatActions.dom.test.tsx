// @vitest-environment jsdom
/**
 * useChatActions 的回退 / 重新生成（P3-10b，docs/pi-durable/p3-10b1112-test-design.md「Renderer」）。
 *
 *   P3-10b-12 confirmRollback：message.rollback → agent.init → requestDraftRestore（原文 + 内联 Token）；
 *             从不 message.list —— 列表等视图推过来（P3-08 的 applySessionView 是唯一写入口）
 *   P3-10b-13 守卫不变：目标不在 / 是助手消息 / 不是用户文本 / 没有 HostApi（渠道端）→ 零 IPC、不回填
 *   P3-10b-14 回退被拒（`{success:false}`，PIN-02）：不回填草稿、不 init，输入框原样
 *   P3-10b-15 重新生成 = 回退 + 重发：rollback(最近的 user/text) → init → 乐观占位（原文 + Token）→ prompt 一次，
 *             没有 message.list；占位在 finally 撤（prompt reject 也撤）；回退被拒 → 没有占位、不 prompt
 *   P3-10b-16 重新生成的重入（PIN-07）：第一次没落定前连点两下 → 一次回退、一次 prompt
 *   P3-10b-17 重挂之后的 store：重新生成期间视图送来不含 U / A 的列表 → messages 换掉、占位还在；之后的视图
 *             带上新 user 条目 → 占位撤（Q-P3-07）；inputText 与草稿不动
 *   P3-10b-19 回退入口的门控（PIN-07）：乐观占位没有回退；视图 `capabilities.rollback` 为 false（旧格式 /
 *             none / 还没有视图）→ 没有回退 / 重新生成；durable 视图有（ThreadDrawer 与 Conversation 同一接线）
 *
 * store 只经视图喂：`seed()` 把消息装进一份 `SessionView`，经 `applySessionView` 写进去（同生产路径）。
 *
 * 后端整个是假的：`window.api` 一个对象同时充当 HostApi 与 SessionChannelApi，调用按到达顺序记进同一条
 * timeline；包入口 `@shuvix/chat-ui` 顶掉（同 inputAreaWelcomeSend.dom.test.tsx）。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import type {
  AssistantMessage,
  ChatMessage,
  ErrorEventMessage,
  InlineToken,
  UserTextMessage
} from '@shuvix/chat-protocol/types/chatMessage'
import { emptySessionView, type SessionView } from '@shuvix/chat-protocol/types/sessionView'

interface Call {
  name: string
  args: unknown[]
}

const mocks = vi.hoisted(() => ({
  /** false = 渠道端（没有 HostApi） */
  host: true
}))

vi.mock('@shuvix/chat-ui', () => {
  const api = (): unknown => (globalThis as unknown as { window: { api: unknown } }).window.api
  return {
    getHostApi: () => (mocks.host ? api() : null),
    getSessionChannelApi: api,
    useChatHost: () => ({ appearance: { focusMode: false } })
  }
})

import {
  PENDING_PROMPT_ID,
  applySessionView,
  selectPendingPrompt,
  useChatStore,
  type Session
} from '../../stores/chatStore'
import { V, resetStore } from '../../__tests__/support/views'
import { selectRollbackCapable, useChatActions, type UseChatActionsReturn } from '../useChatActions'
import { MessageRenderer } from '../../components/chat/MessageRenderer'
import { ThreadDrawer } from '../../components/chat/ThreadDrawer'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const SID = 's1'
const T: Record<string, InlineToken> = {
  t0: { type: 'cmd', id: 'review', displayText: '/review', payload: 'PAYLOAD' }
}

const user = (
  id: string,
  content: string,
  tokens?: Record<string, InlineToken>
): UserTextMessage => ({
  id,
  sessionId: SID,
  role: 'user',
  type: 'text',
  content,
  model: '',
  createdAt: 1,
  metadata: tokens ? { inlineTokens: tokens } : null
})
const assistant = (id: string, content = 'answer'): AssistantMessage => ({
  id,
  sessionId: SID,
  role: 'assistant',
  type: 'message',
  content,
  model: 'm',
  createdAt: 2,
  blocks: [{ type: 'text', text: content }],
  metadata: null
})
const errorEvent = (id: string): ErrorEventMessage => ({
  id,
  sessionId: SID,
  role: 'system_notify',
  type: 'error_event',
  content: 'boom',
  model: '',
  createdAt: 3,
  metadata: null
})

const row = (id: string): Session => ({
  id,
  title: id,
  projectId: null,
  parentId: null,
  settings: { enabledTools: [] },
  createdAt: 0,
  updatedAt: 0,
  lastActiveAt: 0
})

/** 旧格式（harness-v3-jsonl）会话的视图：只读，三项能力都关（同 agent-runtime 的 legacySessionView） */
const LEGACY: Partial<SessionView> = {
  source: 'legacy',
  capabilities: { send: false, rollback: false, continue: false },
  conversationId: null
}

// ─── 假后端 ────────────────────────────────────────────────────────────────

let timeline: Call[] = []
let rollbackImpl: () => Promise<{ success: boolean }>
let promptImpl: () => Promise<{ success: boolean }>
/** prompt 那一刻的乐观占位（content + tokens），没有则 null */
let pendingAtPrompt: Array<{ content: string; tokens: unknown } | null> = []

function record<A extends unknown[], R>(name: string, impl: (...args: A) => R): (...args: A) => R {
  return (...args: A): R => {
    timeline.push({ name, args })
    return impl(...args)
  }
}

function buildApi(): Record<string, unknown> {
  return {
    message: {
      rollback: record('message.rollback', () => rollbackImpl()),
      list: record('message.list', async () => [])
    },
    agent: {
      init: record('agent.init', async () => ({ success: true, created: false })),
      prompt: record('agent.prompt', () => {
        const pending = useChatStore.getState().sessionPendingPrompt[SID]
        pendingAtPrompt.push(
          pending ? { content: pending.content, tokens: pending.metadata?.inlineTokens } : null
        )
        return promptImpl()
      })
    },
    events: { subscribe: () => () => {} }
  }
}

const names = (): string[] => timeline.map((c) => c.name)
const callsOf = (name: string): unknown[][] =>
  timeline.filter((c) => c.name === name).map((c) => c.args)

/** 被记进 timeline 的 store 写入口（模块级只包一次） */
const originalRequestDraftRestore = useChatStore.getState().requestDraftRestore
useChatStore.setState({
  requestDraftRestore: (content, tokens) => {
    timeline.push({ name: 'store.requestDraftRestore', args: [content, tokens] })
    originalRequestDraftRestore(content, tokens)
  }
})

function deferred<T>(): {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
} {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// ─── 渲染 ───────────────────────────────────────────────────────────────────

let container: HTMLDivElement
let root: Root
let actions: UseChatActionsReturn

function Probe({ sessionId }: { sessionId: string | null }): null {
  const current = useChatActions(sessionId)
  // 交给用例的那一份在提交之后写（act 会冲刷 effect）
  useEffect(() => {
    actions = current
  })
  return null
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function mountProbe(sessionId: string | null = SID): Promise<void> {
  await act(async () => {
    root.render(createElement(Probe, { sessionId }))
  })
}

/** 选中一条消息去回退（handleRollback 写的是组件 state，得等重渲染） */
async function pickRollback(messageId: string): Promise<void> {
  await act(async () => actions.handleRollback(messageId))
  expect(actions.pendingRollbackId).toBe(messageId)
}

const store = (): ReturnType<typeof useChatStore.getState> => useChatStore.getState()

/** 选中 SID，把 `messages` 装进它的视图（缺省 durable，可回退）经 applySessionView 写进 store */
function seed(messages: ChatMessage[], view: Partial<SessionView> = {}): void {
  resetStore()
  useChatStore.setState({ sessions: [row(SID)], sessionThreadOpen: {}, draftRestoreRequest: null })
  store().setActiveSessionId(SID)
  applySessionView(SID, V(SID, { messages, ...view }))
}

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'zh',
    resources: { zh: { translation: zh } },
    showSupportNotice: false
  })
})

beforeEach(() => {
  timeline = []
  pendingAtPrompt = []
  mocks.host = true
  rollbackImpl = async () => ({ success: true })
  promptImpl = async () => ({ success: true })
  ;(window as unknown as { api: unknown }).api = buildApi()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

// ─── 回退 ───────────────────────────────────────────────────────────────────

describe('P3-10b-12 confirmRollback', () => {
  it('P3-10b-12 rollback → agent.init → requestDraftRestore(原文, Token)；从不 message.list，store 的消息原样（等下一份视图）', async () => {
    const messages = [user('5', 'hi', T), assistant('6')]
    seed(messages)
    const before = store().messages
    expect(before).toEqual(messages)
    await mountProbe()
    await pickRollback('5')
    await act(async () => actions.confirmRollback())

    expect(names()).toEqual(['message.rollback', 'agent.init', 'store.requestDraftRestore'])
    expect(callsOf('message.rollback')).toEqual([[{ sessionId: SID, messageId: '5' }]])
    expect(callsOf('agent.init')).toEqual([[{ sessionId: SID }]])
    expect(callsOf('store.requestDraftRestore')).toEqual([['hi', T]])
    expect(store().messages).toBe(before)
    expect(store().draftRestoreRequest).toMatchObject({ content: 'hi', inlineTokens: T })
    expect(actions.pendingRollbackId).toBeNull()
  })
})

describe('P3-10b-13 守卫不变', () => {
  it.each([
    ['目标不在', 'nope'],
    ['目标是助手消息', '6'],
    ['目标不是用户文本（error_event）', '7']
  ])('P3-10b-13 %s → 零 IPC、不回填', async (_label, target) => {
    seed([user('5', 'hi'), assistant('6'), errorEvent('7')])
    await mountProbe()
    await pickRollback(target)
    await act(async () => actions.confirmRollback())
    expect(timeline).toEqual([])
    expect(store().draftRestoreRequest).toBeNull()
  })

  it('P3-10b-13 没有 HostApi（渠道端）→ 零 IPC、不回填', async () => {
    seed([user('5', 'hi'), assistant('6')])
    mocks.host = false
    await mountProbe()
    await pickRollback('5')
    await act(async () => actions.confirmRollback())
    await act(async () => actions.handleRegenerate('6'))
    expect(timeline).toEqual([])
    expect(store().draftRestoreRequest).toBeNull()
  })
})

describe('P3-10b-14 回退被拒（PIN-02）', () => {
  it('P3-10b-14 message.rollback 回 {success:false} → 不回填草稿、不 init；输入框原样', async () => {
    seed([user('5', 'hi', T), assistant('6')])
    store().setInputText('typing something')
    rollbackImpl = async () => ({ success: false })
    await mountProbe()
    await pickRollback('5')
    await act(async () => actions.confirmRollback())
    expect(names()).toEqual(['message.rollback'])
    expect(store().draftRestoreRequest).toBeNull()
    expect(store().inputText).toBe('typing something')
  })
})

// ─── 重新生成 ───────────────────────────────────────────────────────────────

describe('P3-10b-15 重新生成 = 回退 + 重发', () => {
  it('P3-10b-15 rollback(最近的 user/text) → init → 占位（原文 + Token）→ prompt 一次；没有 message.list；占位在 finally 撤', async () => {
    seed([user('3', 'older'), assistant('4'), user('5', 'hi', T), assistant('6')])
    await mountProbe()
    await act(async () => actions.handleRegenerate('6'))

    expect(names()).toEqual(['message.rollback', 'agent.init', 'agent.prompt'])
    expect(callsOf('message.rollback')).toEqual([[{ sessionId: SID, messageId: '5' }]])
    expect(callsOf('agent.prompt')).toEqual([[{ sessionId: SID, text: 'hi', inlineTokens: T }]])
    expect(pendingAtPrompt).toEqual([{ content: 'hi', tokens: T }])
    expect(store().sessionPendingPrompt[SID] ?? null).toBeNull()
  })

  it('P3-10b-15 prompt reject → 占位照样撤（错误照常上抛）', async () => {
    seed([user('5', 'hi'), assistant('6')])
    promptImpl = () => Promise.reject(new Error('send failed'))
    await mountProbe()
    let caught: unknown
    await act(async () => {
      await actions.handleRegenerate('6').catch((e: unknown) => (caught = e))
    })
    expect((caught as Error).message).toBe('send failed')
    expect(pendingAtPrompt).toEqual([{ content: 'hi', tokens: undefined }])
    expect(store().sessionPendingPrompt[SID] ?? null).toBeNull()
  })

  it('P3-10b-15 回退被拒 {success:false} → 没有占位、不 init、不 prompt', async () => {
    seed([user('5', 'hi'), assistant('6')])
    rollbackImpl = async () => ({ success: false })
    await mountProbe()
    await act(async () => actions.handleRegenerate('6'))
    expect(names()).toEqual(['message.rollback'])
    expect(store().sessionPendingPrompt[SID] ?? null).toBeNull()
  })
})

describe('P3-10b-16 重新生成的重入（PIN-07）', () => {
  it('P3-10b-16 第一次没落定前连点两下 → 一次回退、一次 prompt；落定之后再点又能用', async () => {
    seed([user('5', 'hi'), assistant('6')])
    const gate = deferred<{ success: boolean }>()
    rollbackImpl = () => gate.promise
    await mountProbe()
    let first!: Promise<void>
    let second!: Promise<void>
    await act(async () => {
      first = actions.handleRegenerate('6')
      second = actions.handleRegenerate('6')
    })
    await act(async () => {
      gate.resolve({ success: true })
      await Promise.all([first, second])
    })
    expect(callsOf('message.rollback')).toHaveLength(1)
    expect(callsOf('agent.prompt')).toHaveLength(1)

    rollbackImpl = async () => ({ success: true })
    await act(async () => actions.handleRegenerate('6'))
    expect(callsOf('message.rollback')).toHaveLength(2)
    expect(callsOf('agent.prompt')).toHaveLength(2)
  })
})

describe('P3-10b-17 重挂之后的 store', () => {
  it('P3-10b-17 重新生成期间视图送来不含 U / A 的列表：messages 换掉、占位仍在；之后的视图带上新 user 条目 → 占位撤（Q-P3-07）；inputText 与草稿不动', async () => {
    seed([user('3', 'older'), assistant('4'), user('5', 'hi', T), assistant('6')])
    store().setInputText('typing something')
    const sent = deferred<{ success: boolean }>()
    promptImpl = () => sent.promise
    await mountProbe()
    let regenerating!: Promise<void>
    await act(async () => {
      regenerating = actions.handleRegenerate('6')
    })
    // prompt 在途：占位已顶上
    expect(names()).toEqual(['message.rollback', 'agent.init', 'agent.prompt'])
    expect(selectPendingPrompt(store())).toMatchObject({ id: PENDING_PROMPT_ID, content: 'hi' })

    // 回退后的视图：fork 上没有 U('5') / A('6')
    const forked = [user('3', 'older'), assistant('4')]
    await act(async () => applySessionView(SID, V(SID, { messages: forked, conversationId: 2 })))
    expect(store().messages).toEqual(forked)
    expect(selectPendingPrompt(store())).toMatchObject({
      id: PENDING_PROMPT_ID,
      content: 'hi',
      metadata: { inlineTokens: T }
    })

    // 重发的用户条目落库（新 id），运行开始：占位在同一次更新里撤
    await act(async () =>
      applySessionView(
        SID,
        V(SID, {
          messages: [...forked, user('7', 'hi', T)],
          conversationId: 2,
          run: { state: 'busy' }
        })
      )
    )
    expect(store().messages.map((m) => m.id)).toEqual(['3', '4', '7'])
    expect(selectPendingPrompt(store())).toBeNull()

    await act(async () => {
      sent.resolve({ success: true })
      await regenerating
    })
    expect(store().sessionPendingPrompt[SID] ?? null).toBeNull()
    expect(store().inputText).toBe('typing something')
    expect(store().pendingImages).toEqual([])
    expect(store().draftRestoreRequest).toBeNull()
    expect(callsOf('store.requestDraftRestore')).toEqual([])
  })
})

// ─── 门控 ───────────────────────────────────────────────────────────────────

describe('P3-10b-19 回退入口的门控（PIN-07）', () => {
  it('P3-10b-19 selectRollbackCapable 读视图的 capabilities.rollback：durable → true；旧格式 / none / 还没有视图 → false；没有会话 → false', () => {
    const withView = (view?: SessionView): ReturnType<typeof store> => {
      resetStore(SID)
      if (view) applySessionView(SID, view)
      return store()
    }
    expect(selectRollbackCapable(withView(V(SID)), SID)).toBe(true)
    expect(selectRollbackCapable(withView(V(SID, LEGACY)), SID)).toBe(false)
    expect(selectRollbackCapable(withView(emptySessionView(SID)), SID)).toBe(false)
    expect(selectRollbackCapable(withView(), SID)).toBe(false)
    expect(selectRollbackCapable(withView(V(SID)), 'other')).toBe(false)
    expect(selectRollbackCapable(withView(V(SID)), null)).toBe(false)
  })

  it('P3-10b-19 乐观占位（id pending-prompt）的气泡没有回退按钮，即便给了 onRollback', async () => {
    seed([])
    await act(async () => {
      root.render(
        createElement(MessageRenderer, {
          item: { key: PENDING_PROMPT_ID, msg: { ...user(PENDING_PROMPT_ID, 'sending') } },
          lastAssistantId: null,
          onRollback: () => {}
        })
      )
    })
    expect(container.textContent).toContain('sending')
    expect(container.querySelector('.lucide-rotate-ccw')).toBeNull()
  })

  /** ThreadDrawer 展开着（与 Conversation 同一接线：canRollback 决定传不传 onRollback / onRegenerate） */
  async function mountDrawer(view: Partial<SessionView>): Promise<void> {
    seed([user('5', 'hi'), assistant('6')], view)
    useChatStore.setState({ sessionThreadOpen: { [SID]: true } })
    await act(async () => {
      root.render(createElement(ThreadDrawer, { sessionId: SID }))
    })
    await flush()
  }

  const regenerateButton = (): Element | undefined =>
    [...container.querySelectorAll('button')].find(
      (b) => b.getAttribute('title') === i18n.t('message.regenerate')
    )

  it('P3-10b-19 durable 视图：用户气泡有回退、末条助手卡有重新生成', async () => {
    await mountDrawer({})
    expect(container.textContent).toContain('hi')
    expect(container.querySelector('.lucide-rotate-ccw')).not.toBeNull()
    expect(regenerateButton()).toBeDefined()
  })

  it('P3-10b-19 视图不能回退（旧格式只读）：没有回退、没有重新生成', async () => {
    await mountDrawer(LEGACY)
    expect(container.textContent).toContain('hi')
    expect(container.querySelector('.lucide-rotate-ccw')).toBeNull()
    expect(regenerateButton()).toBeUndefined()
  })
})
