/**
 * 一轮的卡片 key 走视图之后仍然稳（P3-08-26…29）—— 对话流的项由 `buildVisibleItems(messages, isStreaming,
 * pending)` 从 store 现算；store 只由 `applySessionView`（加乐观占位）写。每次 store 变化都记一份 items，
 * 断言跨所有状态：
 *
 *   26 纯文字的一轮：发送 → 受理（u2 + busy）→ 'He' → 'Hello' → 等值 reset → 落盘 a2（idle）
 *   27 一轮工具：实时工具调用 → 落盘 a1(tool) + toolRuns → 实时终答 → 落盘 a2
 *   28 重试折叠：失败的尝试被投影折掉（视图里从不出现错误行）→ 第二次尝试 → 终答带 retried
 *   29 中止：实时 'par' → 中止落盘一条 'par'（idle）—— 卡片一直在
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { SessionView } from '@shuvix/chat-protocol/types/sessionView'
import {
  applySessionView,
  pendingPromptMessage,
  selectIsStreaming,
  selectPendingPrompt,
  useChatStore
} from '../../../stores/chatStore'
import { buildVisibleItems } from '../conversationItems'
import type { VisibleItem } from '../MessageRenderer'
import {
  V,
  assistant,
  liveCard,
  resetStore,
  store,
  text,
  toolBlock,
  user
} from '../../../__tests__/support/views'

const items = (): VisibleItem[] =>
  buildVisibleItems(store().messages, selectIsStreaming(store()), selectPendingPrompt(store()))

/** 订阅 store，每次变化记一份 items */
function recorder(): { states: VisibleItem[][]; stop: () => void } {
  const states: VisibleItem[][] = [items()]
  const stop = useChatStore.subscribe(() => states.push(items()))
  return { states, stop }
}

const cardOf = (state: VisibleItem[], key: string): VisibleItem | undefined =>
  state.find((item) => item.key === key)

beforeEach(() => {
  resetStore('s1')
})

describe('P3-08-26 纯文字的一轮', () => {
  it('第二轮的卡 key 恒为 turn:2.0；用户项先是 pending-prompt、u2 一到换成它；位置不挪；reset 不动 key 与 msg', () => {
    const turn1 = [user('u1', 'first'), assistant('a1', [text('one')])]
    applySessionView('s1', V('s1', { messages: turn1, run: { state: 'idle' } }))
    const rec = recorder()

    // UI 发送：占位气泡
    store().setPendingPrompt('s1', pendingPromptMessage('s1', 'second'))
    const admitted: SessionView = V('s1', {
      messages: [...turn1, user('u2', 'second')],
      run: { state: 'busy' }
    })
    applySessionView('s1', admitted)
    applySessionView('s1', { ...admitted, live: liveCard(4, [text('He')]) })
    applySessionView('s1', { ...admitted, live: liveCard(4, [text('Hello')]) })
    const beforeReset = items()
    const inputsBefore = {
      messages: store().messages,
      stream: store().sessionStreams.s1,
      pending: selectPendingPrompt(store())
    }
    applySessionView(
      's1',
      JSON.parse(JSON.stringify({ ...admitted, live: liveCard(4, [text('Hello')]) })) as SessionView
    )
    const afterReset = items()
    // 列表的三个输入引用都没变 —— Conversation 的 useMemo 交回同一份 items（占位卡对象也是同一个）
    expect(store().messages).toBe(inputsBefore.messages)
    expect(store().sessionStreams.s1).toBe(inputsBefore.stream)
    expect(selectPendingPrompt(store())).toBe(inputsBefore.pending)
    applySessionView(
      's1',
      V('s1', {
        messages: [...turn1, user('u2', 'second'), assistant('a2', [text('Hello')])],
        run: { state: 'idle' }
      })
    )
    rec.stop()

    const withSecondTurn = rec.states.filter((s) => s.length > 2)
    expect(withSecondTurn.length).toBeGreaterThanOrEqual(5)
    for (const state of withSecondTurn) {
      // 位置不挪：0 = u1，1 = 第一轮的卡，2 = 第二轮的用户项，3 = 第二轮的卡（有卡时）
      expect(state[0].key).toBe('u1')
      expect(state[1].key).toBe('turn:1.0')
      expect(['pending-prompt', 'u2']).toContain(state[2].key)
      if (state.length > 3) expect(state[3].key).toBe('turn:2.0')
      expect(state.length).toBeLessThanOrEqual(4)
    }
    // 用户项：u2 出现之前都是占位，之后都是 u2（不会回到占位）
    const userKeys = withSecondTurn.map((s) => s[2].key)
    const firstReal = userKeys.indexOf('u2')
    expect(firstReal).toBeGreaterThan(0)
    expect(userKeys.slice(0, firstReal).every((k) => k === 'pending-prompt')).toBe(true)
    expect(userKeys.slice(firstReal).every((k) => k === 'u2')).toBe(true)
    // 每个有第二轮卡的状态里它都在
    expect(withSecondTurn.every((s) => cardOf(s, 'turn:2.0') !== undefined)).toBe(true)
    // reset：key 不动、落盘消息的身份不动（流式占位卡由 buildVisibleItems 现造，靠上面的 memo 输入稳住）
    expect(afterReset.map((i) => i.key)).toEqual(beforeReset.map((i) => i.key))
    afterReset.forEach((item, i) => {
      if (!item.isStreamingPlaceholder) expect(item.msg).toBe(beforeReset[i].msg)
    })
  })
})

describe('P3-08-27 一轮工具', () => {
  it('key 恒为 turn:1.0；msgs 依次 [streaming-live] → [a1, streaming-live] → [a1, a2]；从不出现第二张卡', () => {
    const u1 = user('u1', 'go')
    const rec = recorder()
    applySessionView(
      's1',
      V('s1', {
        messages: [u1],
        live: liveCard(2, [toolBlock('c1', 'read', { path: 'x' })]),
        run: { state: 'busy' }
      })
    )
    const a1 = assistant('a1', [toolBlock('c1', 'read', { path: 'x' })])
    applySessionView(
      's1',
      V('s1', { messages: [u1, a1], toolRuns: { c1: { status: 'running' } }, run: { state: 'busy' } })
    )
    const a1done = assistant('a1', [toolBlock('c1', 'read', { path: 'x' }, { result: 'ok' })])
    applySessionView(
      's1',
      V('s1', {
        messages: [u1, a1done],
        live: liveCard(2, [text('final')]),
        run: { state: 'busy' }
      })
    )
    applySessionView(
      's1',
      V('s1', { messages: [u1, a1done, assistant('a2', [text('final')])], run: { state: 'idle' } })
    )
    rec.stop()
    const cards = rec.states.filter((s) => s.some((i) => i.key.startsWith('turn:')))
    const sequence: string[][] = []
    for (const state of cards) {
      const turnItems = state.filter((i) => i.key.startsWith('turn:'))
      expect(turnItems.map((i) => i.key)).toEqual(['turn:1.0'])
      const ids = turnItems[0].msgs!.map((m) => m.id)
      if (JSON.stringify(sequence.at(-1)) !== JSON.stringify(ids)) sequence.push(ids)
    }
    expect(sequence).toEqual([['streaming-live'], ['a1', 'streaming-live'], ['a1', 'a2']])
  })
})

describe('P3-08-28 重试折叠', () => {
  it('一张卡、key 恒定、任何时候都没有错误行；终答带 retried', () => {
    const u1 = user('u1', 'go')
    const rec = recorder()
    applySessionView('s1', V('s1', { messages: [u1], live: liveCard(3, [text('att')]), run: { state: 'busy' } }))
    // 第一次尝试失败：投影把错误条目折掉（同一个任务还在跑），退避期间没有实时卡
    applySessionView(
      's1',
      V('s1', {
        messages: [u1],
        live: null,
        run: { state: 'busy', retry: { attempt: 1, at: 1000, error: '429' } }
      })
    )
    applySessionView('s1', V('s1', { messages: [u1], live: liveCard(3, [text('try 2')]), run: { state: 'busy' } }))
    applySessionView(
      's1',
      V('s1', {
        messages: [u1, assistant('a', [text('try 2')], 's1', { retried: { count: 1, lastError: '429' } })],
        run: { state: 'idle' }
      })
    )
    rec.stop()
    for (const state of rec.states.slice(1)) {
      expect(state.filter((i) => i.key.startsWith('turn:')).map((i) => i.key)).toEqual(['turn:1.0'])
      expect(state.some((i) => i.msg.type === 'error_event')).toBe(false)
    }
    const final = rec.states.at(-1)!.find((i) => i.key === 'turn:1.0')!
    expect(final.msg.metadata).toMatchObject({ retried: { count: 1 } })
  })
})

describe('P3-08-29 中止', () => {
  it('key 恒定；卡片一直在、内容是 par', () => {
    const u1 = user('u1', 'go')
    const rec = recorder()
    applySessionView('s1', V('s1', { messages: [u1], live: liveCard(3, [text('par')]), run: { state: 'busy' } }))
    applySessionView(
      's1',
      V('s1', { messages: [u1, assistant('a-par', [text('par')])], run: { state: 'idle' } })
    )
    rec.stop()
    for (const state of rec.states.slice(1)) {
      const card = state.find((i) => i.key === 'turn:1.0')
      expect(card).toBeDefined()
    }
    const last = rec.states.at(-1)!.find((i) => i.key === 'turn:1.0')!
    expect(last.msg.content).toBe('par')
    expect(store().sessionStreams.s1.isStreaming).toBe(false)
  })
})
