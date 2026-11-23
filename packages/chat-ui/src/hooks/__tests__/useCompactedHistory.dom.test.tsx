// @vitest-environment jsdom
/**
 * `useCompactedHistory`（jsdom）—— 往上翻到顶时把压缩掉的那一段接在上面。宿主经 `setChatApi` 注入一份只有
 * `message.listCompacted` 的假 HostApi，每次调用交回一个手里攥着的 deferred。
 *
 *   C-1 有锚点：canLoad；load → listCompacted({sessionId, compactionId: 锚点})，在途时 canLoad false、再 load 不发；
 *       回来 → 一段（最旧在前）；那段以摘要开头 → 下一次取的是那条摘要
 *   C-2 取回的那段不以摘要开头 / 空段 → 到头了（canLoad false，load 不再发）
 *   C-3 查重：已在当前视图或已取回的 id 不再出现；滤完什么都不剩 → 到头了
 *   C-4 取失败 → 到头了（这次打开不再取），不抛
 *   C-5 没有宿主 / 宿主没有 message.listCompacted / 没有锚点 → canLoad false，load 什么都不做
 *   C-6 锚点换了（又压缩了一次）→ 已取回的段立刻作废；旧锚点那次迟到的结果被忽略；下一次按新锚点取，不卡在「在取」
 *   C-6b 换会话（同一个挂载）同样作废
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ChatApi } from '@shuvix/chat-protocol/chatApi'
import type { ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'
import { setChatApi } from '../../api/chatApi'
import { useCompactedHistory, type CompactedHistory } from '../useCompactedHistory'
import { assistant, text, user } from '../../__tests__/support/views'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

interface Call {
  params: { sessionId: string; compactionId: string }
  resolve: (messages: ChatMessage[]) => void
  reject: (error: unknown) => void
}

let calls: Call[]
let listCompacted: ReturnType<typeof vi.fn>
let container: HTMLDivElement
let root: Root
let hook: CompactedHistory

const summary = (id: string, content = `summary ${id}`): ChatMessage =>
  assistant(id, [text(content)], 's1', { isCompactionSummary: true })

function Probe({ sessionId, messages }: { sessionId: string; messages: ChatMessage[] }): null {
  const value = useCompactedHistory(sessionId, messages)
  useEffect(() => {
    hook = value
  })
  return null
}

function render(messages: ChatMessage[], sessionId = 's1'): void {
  act(() => root.render(createElement(Probe, { sessionId, messages })))
}

function load(): void {
  act(() => hook.load())
}

async function settle(call: Call, result: ChatMessage[] | Error): Promise<void> {
  await act(async () => {
    if (result instanceof Error) call.reject(result)
    else call.resolve(result)
    await Promise.resolve()
    await Promise.resolve()
  })
}

const segIds = (): string[][] => hook.segments.map((s) => s.messages.map((m) => m.id))

const current = (): ChatMessage[] => [
  summary('10'),
  user('11', 'u3'),
  assistant('12', [text('a3')])
]

beforeEach(() => {
  calls = []
  listCompacted = vi.fn(
    (params: Call['params']) =>
      new Promise<ChatMessage[]>((resolve, reject) => calls.push({ params, resolve, reject }))
  )
  setChatApi({ message: { listCompacted } } as unknown as ChatApi)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  setChatApi(null as unknown as ChatApi)
})

describe('useCompactedHistory', () => {
  it('C-1 loads above the anchor, blocks while in flight, then chains to the summary the segment starts with', async () => {
    render(current())
    expect(hook.canLoad).toBe(true)
    expect(hook.segments).toEqual([])
    const before = hook.segments
    render(current())
    // 空的时候引用稳定
    expect(hook.segments).toBe(before)

    load()
    expect(calls.map((c) => c.params)).toEqual([{ sessionId: 's1', compactionId: '10' }])
    expect(hook.canLoad).toBe(false)
    load()
    expect(listCompacted).toHaveBeenCalledTimes(1)

    await settle(calls[0]!, [summary('5'), user('6', 'u2'), assistant('7', [text('a2')])])
    expect(segIds()).toEqual([['5', '6', '7']])
    expect(hook.segments[0]!.compactionId).toBe('10')
    expect(hook.canLoad).toBe(true)

    load()
    expect(calls[1]!.params).toEqual({ sessionId: 's1', compactionId: '5' })
    await settle(calls[1]!, [user('1', 'u1'), assistant('2', [text('a1')])])
    // 最旧的一段在前
    expect(segIds()).toEqual([
      ['1', '2'],
      ['5', '6', '7']
    ])
    expect(hook.segments.map((s) => s.compactionId)).toEqual(['5', '10'])
    // C-2：这段不以摘要开头 → 到头了
    expect(hook.canLoad).toBe(false)
    load()
    expect(listCompacted).toHaveBeenCalledTimes(2)
  })

  it('C-2 an empty segment ends the chain', async () => {
    render(current())
    load()
    await settle(calls[0]!, [])
    expect(hook.segments).toEqual([])
    expect(hook.canLoad).toBe(false)
    load()
    expect(listCompacted).toHaveBeenCalledTimes(1)
  })

  it('C-3 ids already shown (current view or a loaded segment) are dropped; nothing left → done', async () => {
    render(current())
    load()
    // '11' 已在当前视图
    await settle(calls[0]!, [summary('5'), user('6', 'u2'), user('11', 'dup')])
    expect(segIds()).toEqual([['5', '6']])
    load()
    // '6' 已在取回的段里、'12' 在当前视图：滤完什么都不剩
    await settle(calls[1]!, [user('6', 'dup'), assistant('12', [text('dup')])])
    expect(segIds()).toEqual([['5', '6']])
    expect(hook.canLoad).toBe(false)
  })

  it('C-4 a failed fetch stops loading for this opening, without throwing', async () => {
    render(current())
    load()
    await settle(calls[0]!, new Error('boom'))
    expect(hook.segments).toEqual([])
    expect(hook.canLoad).toBe(false)
    load()
    expect(listCompacted).toHaveBeenCalledTimes(1)
  })

  it('C-5 no anchor, no host, or a host without message.listCompacted → canLoad false and load does nothing', () => {
    render([user('1', 'u1'), assistant('2', [text('a1')])])
    expect(hook.canLoad).toBe(false)
    load()
    expect(listCompacted).not.toHaveBeenCalled()

    setChatApi(null as unknown as ChatApi)
    render(current())
    expect(hook.canLoad).toBe(false)
    load()

    setChatApi({ message: {} } as unknown as ChatApi)
    render(current())
    expect(hook.canLoad).toBe(false)
    load()
    expect(listCompacted).not.toHaveBeenCalled()
  })

  it('C-6 the anchor changes: loaded segments are dropped at once, a late answer for the old anchor is ignored, the next load uses the new anchor', async () => {
    render(current())
    load()
    await settle(calls[0]!, [summary('5'), user('6', 'u2')])
    expect(segIds()).toEqual([['5', '6']])
    load()
    expect(calls[1]!.params.compactionId).toBe('5')

    // 又压缩了一次：当前视图的第一条换成了 20
    const next = [summary('20'), user('21', 'u4')]
    render(next)
    expect(hook.segments).toEqual([])
    // 不卡在旧锚点那次「在取」
    expect(hook.canLoad).toBe(true)

    // 旧锚点那次迟到的结果：看不见
    await settle(calls[1]!, [user('1', 'u1')])
    expect(hook.segments).toEqual([])
    expect(hook.canLoad).toBe(true)

    load()
    expect(calls[2]!.params).toEqual({ sessionId: 's1', compactionId: '20' })
    await settle(calls[2]!, [summary('10'), user('11', 'u3')])
    expect(segIds()).toEqual([['10', '11']])
    expect(hook.canLoad).toBe(true)
  })

  it('C-6 the anchor goes away (no summary first any more) → nothing shown, nothing to load', async () => {
    render(current())
    load()
    await settle(calls[0]!, [summary('5'), user('6', 'u2')])
    render([user('30', 'after rollback')])
    expect(hook.segments).toEqual([])
    expect(hook.canLoad).toBe(false)
  })

  it('C-6b another session on the same mount: segments are dropped and the next load asks for that session', async () => {
    render(current(), 's1')
    load()
    await settle(calls[0]!, [summary('5'), user('6', 'u2')])
    render(current(), 's2')
    expect(hook.segments).toEqual([])
    load()
    expect(calls[1]!.params).toEqual({ sessionId: 's2', compactionId: '10' })
  })
})
