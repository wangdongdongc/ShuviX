/**
 * 乐观占位的撤下规则（Q-P3-07，PIN-17）—— 视图驱动的那一半：
 *
 *   P3-08-32 视图里出现发送时没有的用户条目 → 同一次更新撤下；任何时刻都不会「两个都在」或「两个都不在」
 *   P3-08-33 什么算「新的用户条目」：发送时已有的（含更早的用户条目）、新的通知 / 助手条目都不算；
 *            第一条新的用户条目才算；运行中 steer / followUp 不建占位
 *   P3-08-36 占位只在发送方本端：另一份 store（另一个窗口）从来没有它，受理之后照样显示 u_new
 *   P3-08-37 发送后受理前切走：B 从不显示 A 的占位；切回 A 时快照带着 u_new，同一次更新里占位消失
 *
 * 不起 jsdom：纯 store 读写；P3-08-36 用 `vi.resetModules` 起第二份 store。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applySessionView,
  pendingPromptMessage,
  releaseSessionView,
  selectIsStreaming,
  selectPendingPrompt,
  useChatStore
} from '../chatStore'
import { buildVisibleItems } from '../../components/chat/conversationItems'
import { V, assistant, resetStore, store, text, user } from '../../__tests__/support/views'

beforeEach(() => {
  resetStore('s1')
})

const items = (): ReturnType<typeof buildVisibleItems> =>
  buildVisibleItems(store().messages, selectIsStreaming(store()), selectPendingPrompt(store()))

describe('P3-08-32 受理的那一帧撤下占位', () => {
  it('同一次更新：占位撤下、u_new 出现；全程没有「两个都在」也没有「两个都不在」', () => {
    applySessionView('s1', V('s1', { messages: [user('u1', 'old')], run: { state: 'idle' } }))
    const seen: Array<{ bubble: boolean; real: boolean }> = []
    const off = useChatStore.subscribe((s) =>
      seen.push({
        bubble: 's1' in s.sessionPendingPrompt,
        real: s.messages.some((m) => m.id === 'u_new')
      })
    )
    store().setPendingPrompt('s1', pendingPromptMessage('s1', 'hello'))
    applySessionView(
      's1',
      V('s1', { messages: [user('u1', 'old'), user('u_new', 'hello')], run: { state: 'busy' } })
    )
    off()
    expect('s1' in store().sessionPendingPrompt).toBe(false)
    expect(seen.some((s) => s.bubble && s.real)).toBe(false)
    expect(seen.some((s) => !s.bubble && !s.real)).toBe(false)
    expect(seen.at(-1)).toEqual({ bubble: false, real: true })
  })
})

describe('P3-08-33 什么算「新的用户条目」（PIN-17）', () => {
  it('发送时已有的、通知、助手条目都不撤；第一条新的用户条目才撤', () => {
    const before = [user('u0', 'older'), assistant('a0', [text('x')])]
    applySessionView('s1', V('s1', { messages: before, run: { state: 'idle' } }))
    store().setPendingPrompt('s1', pendingPromptMessage('s1', 'hello'))
    const bubble = (): boolean => 's1' in store().sessionPendingPrompt

    // 发送时就有的（含更早的用户条目）：一份等值的新视图
    applySessionView('s1', V('s1', { messages: [...before], run: { state: 'busy' } }))
    expect(bubble()).toBe(true)
    // 新的通知（user 形状但是系统通知）与新的助手条目：不撤
    const notice = user('n1', 'background done', 's1', { isSystemNotice: true })
    applySessionView(
      's1',
      V('s1', { messages: [...before, notice, assistant('a1', [text('y')])], run: { state: 'busy' } })
    )
    expect(bubble()).toBe(true)
    // 第一条新的用户条目：撤
    applySessionView(
      's1',
      V('s1', {
        messages: [...before, notice, assistant('a1', [text('y')]), user('u1', 'hello')],
        run: { state: 'busy' }
      })
    )
    expect(bubble()).toBe(false)
  })

  it('运行中 steer / followUp 不建占位（只有 prompt 走占位）', async () => {
    // 输入框的排队发送路径不调 setPendingPrompt：直接核对源码里只有一处发送路径建占位
    const { readFileSync } = await import('node:fs')
    const { join, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../components/chat/InputArea.tsx'),
      'utf8'
    )
    const queueSend = source.slice(source.indexOf('const handleQueueSend'))
    const body = queueSend.slice(0, queueSend.indexOf('\n  }\n'))
    expect(body).not.toMatch(/setPendingPrompt/)
    applySessionView('s1', V('s1', { run: { state: 'busy' } }))
    expect(selectPendingPrompt(store())).toBeNull()
  })
})

describe('P3-08-36 占位只在发送方本端', () => {
  it('第二份 store（另一个窗口）从来没有 s1 的占位；受理之后它也显示 u_new', async () => {
    vi.resetModules()
    const w2 = await import('../chatStore')
    w2.useChatStore.setState({ activeSessionId: 's1', active: { type: 'session', id: 's1' } })
    const w2Seen: boolean[] = []
    const off = w2.useChatStore.subscribe((s) => w2Seen.push('s1' in s.sessionPendingPrompt))

    // W1 发送
    applySessionView('s1', V('s1', { messages: [user('u1', 'old')], run: { state: 'idle' } }))
    w2.applySessionView('s1', V('s1', { messages: [user('u1', 'old')], run: { state: 'idle' } }))
    store().setPendingPrompt('s1', pendingPromptMessage('s1', 'hello'))
    const admitted = V('s1', {
      messages: [user('u1', 'old'), user('u_new', 'hello')],
      run: { state: 'busy' }
    })
    applySessionView('s1', admitted)
    w2.applySessionView('s1', admitted)
    off()
    expect(w2Seen.every((has) => !has)).toBe(true)
    expect(w2.useChatStore.getState().messages.map((m) => m.id)).toEqual(['u1', 'u_new'])
    expect(useChatStore.getState().messages.map((m) => m.id)).toEqual(['u1', 'u_new'])
  })
})

describe('P3-08-37 受理之前切走', () => {
  it('B 从不显示 A 的占位；切回 A 时快照带着 u_new，同一次更新里占位没了（不重复）', () => {
    store().setActiveSessionId('A')
    applySessionView('A', V('A', { messages: [user('a0', 'old', 'A')], run: { state: 'idle' } }))
    store().setPendingPrompt('A', pendingPromptMessage('A', 'hello'))

    const seen: Array<{ active: string | null; bubble: string | null; ids: string[] }> = []
    const off = useChatStore.subscribe((s) =>
      seen.push({
        active: s.activeSessionId,
        bubble: (s.activeSessionId && s.sessionPendingPrompt[s.activeSessionId]?.sessionId) || null,
        ids: s.messages.map((m) => m.id)
      })
    )
    // 切到 B：A 的订阅放手（视图切片丢掉），占位留着
    releaseSessionView('A')
    store().setActiveSessionId('B')
    applySessionView('B', V('B', { messages: [user('b0', 'b', 'B')] }))
    // A 在背后受理了 u_new（没人订阅，store 不知道）；切回 A，新的订阅交回快照
    store().setActiveSessionId('A')
    applySessionView(
      'A',
      V('A', {
        messages: [user('a0', 'old', 'A'), user('u_new', 'hello', 'A')],
        run: { state: 'busy' }
      })
    )
    off()
    expect(seen.filter((s) => s.active === 'B').every((s) => s.bubble === null)).toBe(true)
    const last = seen.at(-1)!
    expect(last).toEqual({ active: 'A', bubble: null, ids: ['a0', 'u_new'] })
    expect(items().filter((i) => i.key === 'pending-prompt')).toEqual([])
    // 在 A 上，u_new 出现之前占位一直在；出现那一刻同时消失
    const onA = seen.filter((s) => s.active === 'A')
    expect(onA.some((s) => s.bubble !== null && s.ids.includes('u_new'))).toBe(false)
  })
})
