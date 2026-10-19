// @vitest-environment jsdom
/**
 * 对话里的「从这里分支」（`[data-fork-reply]`，jsdom）：真的 Conversation → buildVisibleItems →
 * MessageRenderer → AssistantBubble，加上真的 useSessionFork 与 ConfirmDialog。
 *
 * 契约：按钮只在「宿主有 `session.fork`、ChatHost 给了 `openSession`、这条会话形态给 fork（项目会话、
 * 新格式存储）、视图说能回退、视图空闲」全都成立时出现，每张定稿的助手卡一颗；点它以那张卡的
 * **最后一条消息** id 调 `session.fork`；成功 → `openSession(新 id)`，被拒 → 一个只有一颗按钮的说明框
 * （标题 `chat.forkFailedTitle`、正文是原因的文案），Close / Escape / 点遮罩都关掉它。
 *
 *   UI-1 条件都满足：每张定稿的助手卡都有按钮；用户气泡、错误行、压缩摘要行、系统通知行没有
 *   UI-2 任一条件缺了就没有按钮：宿主没有 fork；ChatHost 没有 openSession；形态不给（临时会话 / 旧格式存储 /
 *        笔记本）；视图说不能回退；视图在跑 / 被中断（视图还没到时连列表都不挂 —— 由 H-8 管选择器那一半）
 *   UI-3 点多条消息的卡 → fork({sessionId, messageId: 卡的最后一条})；没有终答的卡（轮中被打断）同样
 *   UI-4 空闲 → 在跑 → 空闲：按钮消失又回来
 *   UI-5 成功 → openSession(新 id)；被拒 → 说明框（一颗按钮），Close / Escape / 点遮罩关掉
 *   UI-6 只渲染 AssistantBubble：给了 onFork 但在流式 → 没有操作行；只有工具、没有正文、也没给 onRegenerate
 *        的卡仍有操作行，里面只有分支这一颗
 *   UI-7 渲染成本：可分支时运行中会话的流式更新不让已落定的卡重画
 *
 * 桩：Virtuoso 换成直接把每一项画出来的壳；输入区、待处理输入、Footer 顶成空壳；`useChatActions` 交回
 * 模块级的稳定回调；`useTtsPlayback` 计渲染次数（UI-7）；包入口给可变的 `useChatHost`（openSession 有无）
 * 与 `getHostApi: () => null`（只给别的部件看）。fork 所走的宿主经 `setChatApi` 注入。数据走真的 chatStore。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type Context, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type { ChatApi } from '@shuvix/chat-protocol/chatApi'
import type { SessionForkParams, SessionForkResult } from '@shuvix/chat-protocol/sessionFork'
import { DURABLE_SQLITE_1, HARNESS_V3_JSONL } from '@shuvix/chat-protocol/sessionStorageKind'
import type { ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'

interface VirtuosoStubProps {
  data: Array<{ key: string }>
  itemContent: (index: number, item: unknown) => ReactNode
  computeItemKey: (index: number, item: unknown) => string
}

const probe = vi.hoisted(() => ({
  /** ChatHost：`openSession` 有没有、是哪一个 */
  host: { appearance: { focusMode: false } } as {
    appearance: { focusMode: boolean }
    openSession?: (id: string) => void
  },
  /** 卡标签（可见项 key）→ AssistantBubble 渲染次数（UI-7） */
  renders: new Map<string, number>(),
  /** 卡标签的 Context（由 useTtsPlayback 的桩建、读；Virtuoso 的壳给每一项套上） */
  card: null as Context<string> | null,
  noop: () => {}
}))

vi.mock('@shuvix/chat-ui', () => ({
  useChatHost: () => probe.host,
  getHostApi: () => null
}))
vi.mock('../../../hooks/useTtsPlayback', async () => {
  const React = await import('react')
  const card = React.createContext('')
  probe.card = card
  const tts = {
    isPlaying: false,
    isLoading: false,
    playingMessageId: null,
    speak: () => {},
    stop: () => {}
  }
  return {
    useTtsPlayback: () => {
      const label = React.useContext(card)
      probe.renders.set(label, (probe.renders.get(label) ?? 0) + 1)
      return tts
    }
  }
})
vi.mock('react-virtuoso', async () => {
  const React = await import('react')
  const Virtuoso = React.forwardRef<unknown, VirtuosoStubProps>(function VirtuosoStub(props, ref) {
    React.useImperativeHandle(ref, () => ({ scrollToIndex: () => {} }), [])
    return React.createElement(
      'div',
      { 'data-virtuoso-stub': '' },
      props.data.map((item, i) => {
        const key = props.computeItemKey(i, item)
        return React.createElement(
          probe.card!.Provider,
          { key, value: key },
          props.itemContent(i, item)
        )
      })
    )
  })
  return { Virtuoso }
})
vi.mock('../InputArea', () => ({ InputArea: () => null }))
vi.mock('../PendingInputsPanel', () => ({ PendingInputsPanel: () => null }))
vi.mock('../StreamingFooter', () => ({ StreamingFooter: () => null }))
vi.mock('../../../hooks/useChatActions', () => {
  const actions = {
    handleRollback: probe.noop,
    pendingRollbackId: null,
    confirmRollback: probe.noop,
    cancelRollback: probe.noop,
    handleRegenerate: probe.noop,
    canRollback: true,
    handleInputResponse: probe.noop
  }
  return { useChatActions: () => actions }
})

import { setChatApi } from '../../../api/chatApi'
import { applySessionView, useChatStore, type Session } from '../../../stores/chatStore'
import { emptyStream } from '../../../stores/viewDerivation'
import { Conversation } from '../Conversation'
import { AssistantBubble } from '../AssistantBubble'
import {
  V,
  assistant,
  errorRow,
  liveCard,
  resetStore,
  text,
  toolBlock,
  user
} from '../../../__tests__/support/views'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const SID = 's1'
const NEW_ID = 'fork-1'

let container: HTMLDivElement
let root: Root

interface FakeHost {
  fork?: ReturnType<typeof vi.fn<(params: SessionForkParams) => Promise<SessionForkResult>>>
  list: ReturnType<typeof vi.fn<() => Promise<Session[]>>>
}
let host: FakeHost

function inject(h: FakeHost): void {
  host = h
  setChatApi({ session: h } as unknown as ChatApi)
}

function session(over: Partial<Session> & { storageKind?: string } = {}): Session {
  return {
    id: SID,
    title: 'Source',
    projectId: 'p1',
    parentId: null,
    settings: {},
    createdAt: 0,
    updatedAt: 0,
    lastActiveAt: 0,
    storageKind: DURABLE_SQLITE_1,
    ...over
  } as Session
}

/**
 * 一段历史（可见项依次是）：压缩摘要 c0 · 用户 u1 · 卡 [a1 工具, a2 终答] · 错误行 e1 · 用户 u2 · 卡 [a3] ·
 * 系统通知 n1（后台完成，自成一行）· 卡 [a4]
 */
const history = (): ChatMessage[] => [
  assistant('c0', [text('## Summary\nearlier things')], SID, { isCompactionSummary: true }),
  user('u1', 'first', SID),
  assistant('a1', [toolBlock('a1-t', 'read', { path: 'x' }, { result: 'ok' })], SID),
  assistant('a2', [text('two')], SID),
  errorRow('e1', 'boom', SID),
  user('u2', 'second', SID),
  assistant('a3', [text('three')], SID),
  user('n1', '<background-task id="1" status="completed">done</background-task>', SID, {
    isSystemNotice: true
  }),
  assistant('a4', [text('four')], SID)
]

function load(
  messages: ChatMessage[],
  over: Parameters<typeof V>[1] = {},
  s: Session | null = session()
): void {
  act(() => {
    if (s) useChatStore.setState({ sessions: [s] })
    applySessionView(SID, V(SID, { messages, ...over }))
  })
}

function render(): void {
  act(() => root.render(createElement(Conversation, { sessionId: SID })))
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

const forkButtons = (scope: ParentNode = container): HTMLButtonElement[] => [
  ...scope.querySelectorAll<HTMLButtonElement>('[data-fork-reply]')
]
const rowOf = (msgId: string): HTMLElement => {
  const el = container.querySelector<HTMLElement>(`[data-msg-id="${msgId}"]`)
  if (!el) throw new Error(`row ${msgId} not rendered`)
  return el
}
/** 有分支按钮的行（按 data-msg-id，即每张卡的锚点） */
const rowsWithFork = (): string[] =>
  forkButtons().map((b) => b.closest<HTMLElement>('[data-msg-id]')!.getAttribute('data-msg-id')!)
const dialog = (): HTMLElement | null => container.querySelector<HTMLElement>('.dialog-overlay')

async function clickFork(msgId: string): Promise<void> {
  const [button] = forkButtons(rowOf(msgId))
  expect(button, `fork button on ${msgId}`).toBeDefined()
  await act(async () => {
    button.click()
  })
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

beforeEach(() => {
  vi.useFakeTimers()
  resetStore(SID)
  probe.renders.clear()
  probe.host = { appearance: { focusMode: false }, openSession: vi.fn() }
  inject({
    fork: vi.fn(async () => ({ success: true as const, sessionId: NEW_ID })),
    list: vi.fn(async () => [session(), session({ id: NEW_ID })])
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

describe('按钮在哪（UI-1）', () => {
  it('UI-1 条件都满足：三张定稿的卡各一颗；用户气泡、错误行、压缩摘要、系统通知没有', () => {
    load(history())
    render()
    expect(rowsWithFork()).toEqual(['a2', 'a3', 'a4'])
    for (const id of ['c0', 'u1', 'e1', 'u2', 'n1']) {
      expect(forkButtons(rowOf(id)), id).toHaveLength(0)
    }
    // 每张卡恰好一颗，悬浮提示是 message.fork
    for (const id of ['a2', 'a3', 'a4']) {
      const buttons = forkButtons(rowOf(id))
      expect(buttons, id).toHaveLength(1)
      expect(buttons[0].title).toBe(en.message.fork)
    }
  })
})

describe('任一条件缺了就没有按钮（UI-2）', () => {
  it('UI-2 正控制：同样的历史在条件都满足时有按钮', () => {
    load(history())
    render()
    expect(forkButtons().length).toBe(3)
  })

  it('UI-2 宿主没有 session.fork', () => {
    inject({ list: vi.fn(async () => []) })
    load(history())
    render()
    expect(rowOf('a2')).toBeTruthy()
    expect(forkButtons()).toHaveLength(0)
  })

  it('UI-2 ChatHost 没给 openSession（悬浮窗 / md 窗口 / Chrome 侧边栏）', () => {
    probe.host = { appearance: { focusMode: false } }
    load(history())
    render()
    expect(rowOf('a2')).toBeTruthy()
    expect(forkButtons()).toHaveLength(0)
  })

  it.each<[string, Partial<Session> & { storageKind?: string }]>([
    ['临时会话（不属于项目）', { projectId: null }],
    ['旧格式存储', { storageKind: HARNESS_V3_JSONL }],
    ['缺省存储类型', { storageKind: undefined }],
    ['笔记本会话', { settings: { notebookPath: 'a.md' } }]
  ])('UI-2 形态不给：%s', (_label, over) => {
    load(history(), {}, session(over))
    render()
    expect(rowOf('a2')).toBeTruthy()
    expect(forkButtons()).toHaveLength(0)
  })

  it('UI-2 会话不在列表里', () => {
    load(history(), {}, null)
    render()
    expect(rowOf('a2')).toBeTruthy()
    expect(forkButtons()).toHaveLength(0)
  })

  it('UI-2 视图说不能回退（重新生成也跟着没了也无妨，这里只看分支）', () => {
    load(history(), { capabilities: { send: true, rollback: false, continue: true } })
    render()
    expect(rowOf('a2')).toBeTruthy()
    expect(forkButtons()).toHaveLength(0)
  })

  it.each<['busy' | 'interrupted']>([['busy'], ['interrupted']])(
    'UI-2 视图运行状态 %s：已落定的卡上也没有',
    (state) => {
      load(history(), { run: { state } })
      render()
      expect(rowOf('a2')).toBeTruthy()
      expect(forkButtons()).toHaveLength(0)
    }
  )

  it('UI-2 视图还没到：列表不挂，自然没有按钮', () => {
    act(() => useChatStore.setState({ sessions: [session()] }))
    render()
    expect(container.querySelector('[data-virtuoso-stub]')).toBeNull()
    expect(forkButtons()).toHaveLength(0)
  })
})

describe('点了用哪个 id（UI-3）', () => {
  it('UI-3 两条消息的卡 [a1, a2] → messageId a2；单条的卡 → 它自己', async () => {
    load(history())
    render()
    await clickFork('a2')
    expect(host.fork!.mock.calls).toEqual([[{ sessionId: SID, messageId: 'a2' }]])
    await clickFork('a3')
    expect(host.fork!.mock.calls[1]).toEqual([{ sessionId: SID, messageId: 'a3' }])
  })

  it('UI-3 没有终答的卡（轮中被打断，工具步后直接是下一条用户消息）→ 卡的最后一条', async () => {
    load([
      user('u1', 'first', SID),
      assistant('b1', [toolBlock('b1-t', 'read', {}, { result: 'ok' })], SID),
      assistant('b2', [toolBlock('b2-t', 'grep', {}, { result: 'ok' })], SID),
      user('u2', 'actually, stop', SID),
      assistant('b3', [text('ok')], SID)
    ])
    render()
    expect(rowsWithFork()).toEqual(['b2', 'b3'])
    await clickFork('b2')
    expect(host.fork!.mock.calls).toEqual([[{ sessionId: SID, messageId: 'b2' }]])
  })

  it('UI-3 列表末尾一张没有终答的卡（停在工具步上，没在跑）→ 卡的最后一条', async () => {
    load([
      user('u1', 'first', SID),
      assistant('d1', [toolBlock('d1-t', 'read', {}, { result: 'ok' })], SID),
      assistant('d2', [toolBlock('d2-t', 'read', {}, { result: 'ok' })], SID)
    ])
    render()
    expect(rowsWithFork()).toEqual(['d2'])
    await clickFork('d2')
    expect(host.fork!.mock.calls).toEqual([[{ sessionId: SID, messageId: 'd2' }]])
  })
})

describe('运行状态变化（UI-4）', () => {
  it('UI-4 空闲 → 在跑 → 空闲：按钮消失又回来', () => {
    const messages = history()
    load(messages)
    render()
    expect(rowsWithFork()).toEqual(['a2', 'a3', 'a4'])

    load([...messages, user('u3', 'third', SID)], {
      run: { state: 'busy' },
      live: liveCard(1, [text('Hel')], undefined, SID)
    })
    expect(rowOf('a2')).toBeTruthy()
    expect(forkButtons()).toHaveLength(0)

    const done = [...messages, user('u3', 'third', SID), assistant('a5', [text('five')], SID)]
    load(done)
    expect(rowsWithFork()).toEqual(['a2', 'a3', 'a4', 'a5'])
  })
})

describe('结果（UI-5）', () => {
  it('UI-5 成功 → openSession(新 id)；不出说明框', async () => {
    load(history())
    render()
    await clickFork('a4')
    expect(host.fork!).toHaveBeenCalledTimes(1)
    expect(host.list).toHaveBeenCalledTimes(1)
    expect(probe.host.openSession).toHaveBeenCalledTimes(1)
    expect(probe.host.openSession).toHaveBeenCalledWith(NEW_ID)
    expect(dialog()).toBeNull()
  })

  /** 点一次被拒，回到说明框 */
  async function refuse(reason: 'busy' | 'invalid_target' = 'busy'): Promise<HTMLElement> {
    host.fork!.mockResolvedValue({ success: false, reason })
    await clickFork('a2')
    const d = dialog()
    expect(d).not.toBeNull()
    return d!
  }

  it('UI-5 被拒 → 标题 chat.forkFailedTitle、正文是原因的文案、恰好一颗 Close；不 openSession', async () => {
    load(history())
    render()
    const d = await refuse('busy')
    expect(d.querySelector('h3')!.textContent).toBe(en.chat.forkFailedTitle)
    expect(d.textContent).toContain(en.chat.forkBusy)
    const buttons = d.querySelectorAll('button')
    expect(buttons).toHaveLength(1)
    expect(buttons[0].textContent).toBe(en.common.close)
    expect(probe.host.openSession).not.toHaveBeenCalled()
    expect(host.list).not.toHaveBeenCalled()
  })

  it('UI-5 另一种原因换另一句文案', async () => {
    load(history())
    render()
    const d = await refuse('invalid_target')
    expect(d.textContent).toContain(en.chat.forkInvalidTarget)
    expect(d.textContent).not.toContain(en.chat.forkBusy)
  })

  it('UI-5 fork 抛错 → 说明框写 chat.forkFailed', async () => {
    host.fork!.mockRejectedValue(new Error('ipc'))
    load(history())
    render()
    await clickFork('a2')
    expect(dialog()).not.toBeNull()
    expect(dialog()!.textContent).toContain(en.chat.forkFailed)
  })

  it('UI-5 点 Close → 说明框关掉', async () => {
    load(history())
    render()
    const d = await refuse()
    await act(async () => {
      d.querySelector('button')!.click()
    })
    expect(dialog()).toBeNull()
    // 关掉之后还能再点（不卡在在途 / 错误态）
    host.fork!.mockResolvedValue({ success: true, sessionId: NEW_ID })
    await clickFork('a2')
    expect(probe.host.openSession).toHaveBeenCalledWith(NEW_ID)
  })

  it('UI-5 Escape → 说明框（播完退出动画）关掉', async () => {
    load(history())
    render()
    await refuse()
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(dialog()).toBeNull()
  })

  it('UI-5 点遮罩 → 说明框关掉；点框里面不关', async () => {
    load(history())
    render()
    const d = await refuse()
    act(() => {
      ;(d.querySelector('h3') as HTMLElement).click()
    })
    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(dialog()).not.toBeNull()
    act(() => {
      d.click()
    })
    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(dialog()).toBeNull()
  })
})

describe('AssistantBubble 本身（UI-6）', () => {
  it('UI-6 给了 onFork 但在流式：没有操作行（没有分支按钮）', () => {
    act(() => {
      useChatStore.setState({
        sessionStreams: { [SID]: { ...emptyStream(true), content: 'Hel' } }
      })
    })
    act(() =>
      root.render(
        createElement(AssistantBubble, {
          msgs: [assistant('streaming-live', [], SID)],
          isStreaming: true,
          onFork: vi.fn()
        })
      )
    )
    expect(container.textContent).toContain('Hel')
    expect(forkButtons()).toHaveLength(0)
    expect(container.querySelector('button[title="Copy"]')).toBeNull()
  })

  it('UI-6 只有工具、没有正文、没给 onRegenerate 的卡：操作行仍在，里面只有分支一颗；点它以末条 id 调用', () => {
    const onFork = vi.fn()
    const msgs = [
      assistant('t1', [toolBlock('t1-t', 'read', {}, { result: 'ok' })], SID),
      assistant('t2', [toolBlock('t2-t', 'read', {}, { result: 'ok' })], SID)
    ]
    act(() => root.render(createElement(AssistantBubble, { msgs, onFork })))
    const buttons = forkButtons()
    expect(buttons).toHaveLength(1)
    const actionRow = buttons[0].parentElement!
    expect(actionRow.querySelectorAll('button')).toHaveLength(1)
    for (const title of ['Copy', 'Read aloud', 'Show source', 'Regenerate']) {
      expect(container.querySelector(`button[title="${title}"]`), title).toBeNull()
    }
    act(() => buttons[0].click())
    expect(onFork.mock.calls).toEqual([['t2']])
  })

  it('UI-6 同一张卡不给 onFork（也不给 onRegenerate）：没有操作行', () => {
    const msgs = [assistant('t1', [toolBlock('t1-t', 'read', {}, { result: 'ok' })], SID)]
    act(() => root.render(createElement(AssistantBubble, { msgs })))
    expect(forkButtons()).toHaveLength(0)
    expect(container.querySelectorAll('button[title]')).toHaveLength(0)
  })
})

describe('渲染成本（UI-7）', () => {
  /** 上一轮那张已落定的卡（第 1 轮第 0 张）与本轮的流式卡（第 2 轮第 0 张） */
  const SETTLED = 'turn:1.0'
  const LIVE = 'turn:2.0'
  const renders = (label: string): number => probe.renders.get(label) ?? 0

  it('UI-7 可分支的会话跑起来以后：分支按钮撤下那一次之外，流式更新不让已落定的卡重画', () => {
    const settled = [user('u1', 'first', SID), assistant('a1', [text('one')], SID)]
    load(settled)
    render()
    expect(rowsWithFork()).toEqual(['a1'])

    const running = [...settled, user('u2', 'second', SID)]
    const push = (t: string): void =>
      load(running, { run: { state: 'busy' }, live: liveCard(1, [text(t)], undefined, SID) })
    // 跑起来：分支按钮撤下（onFork 换成 undefined）—— 这一次已落定的卡重画是应该的
    push('He')
    expect(forkButtons()).toHaveLength(0)
    const settledRow = rowOf('a1')
    const settledBase = renders(SETTLED)

    for (const t of ['Hel', 'Hell', 'Hello']) {
      const before = renders(LIVE)
      push(t)
      expect(renders(LIVE), t).toBeGreaterThan(before)
      expect(renders(SETTLED), t).toBe(settledBase)
    }
    expect(rowOf('streaming-live').textContent).toContain('Hello')
    expect(rowOf('a1')).toBe(settledRow)

    // 跑完：按钮回来（落定卡这一次重画）
    load([...running, assistant('a2', [text('two')], SID)])
    expect(rowsWithFork()).toEqual(['a1', 'a2'])
  })
})
