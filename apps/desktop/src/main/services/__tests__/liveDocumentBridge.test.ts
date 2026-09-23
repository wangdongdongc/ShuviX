/**
 * liveDocumentBridge —— 主进程把 agent 的 doc_* 调用转给开着那份文档的窗口，等它的答复。
 *
 * 契约（liveDocumentBridge.ts 文件头 + chat-protocol liveDocument.ts）：
 *   - 没有窗口 / 窗口已销毁 → 立刻失败，什么都不发；
 *   - 去程 `liveDoc:request {requestId, sessionId, op}` 发给挂着的那个 webContents；回程只认**发请求的那个**
 *     webContents（别的窗口作答被忽略并记一条 warn），`{ ok: false }` 是正常结果（resolve，不 reject）；
 *   - detach（关窗）让这条会话在途的请求立刻失败（「…window was closed」），不发撤回，别的会话不受影响；
 *   - 中止 → 「Aborted.」+ 发 `liveDoc:cancel`；已中止的 signal 什么都不发；了结之后的中止无效；
 *   - 超时：读 15s、改 45s，超时发撤回（窗口已销毁则不发）并 warn；
 *   - **同一条会话的请求逐个发**：前一个了结才发下一个，超时从真正发出算；排队期间被中止或窗口关了的，
 *     不发就失败；不同会话之间互不排队。
 *
 * 假 WebContents 只记 send；计时用假定时器（只假 setTimeout / clearTimeout / Date，微任务照常跑）。
 * 模块级状态（窗口表、在途表、队列）每条用例都要新的：beforeEach 里 resetModules 后重新导入。
 *
 *   B1 没窗口 / 已销毁 → reject「No document window…」，什么都没发
 *   B2 发出请求的形状；同一个窗口的答复了结它；{ok:false} 也是 resolve
 *   B3 别的窗口作答 → 忽略 + warn，真答复照样了结；未知 id / 第二次答复 → 无事发生
 *   B4 detach → 这条会话在途的请求立刻失败（closed），别的会话不受影响，不发撤回
 *   B5 中止 → Aborted. + liveDoc:cancel；已中止的 signal 什么都不发；了结后再中止无效
 *   B6 超时：读 15s / 改 45s / 插入 45s；超时发撤回（已销毁不发）并 warn
 *   B8 排队：同会话逐个发；第二个的超时从它自己发出时算；排队中被中止 / 窗口关了 → 不发就失败；异会话不互等
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import type { LiveDocOp, LiveDocRequest, LiveDocResult } from '@shuvix/chat-protocol/liveDocument'

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('../../logger', () => ({ createLogger: () => log }))

type Bridge = typeof import('../liveDocumentBridge')
let bridge: Bridge

interface FakeContents {
  send: ReturnType<typeof vi.fn>
  destroyed: boolean
  isDestroyed(): boolean
  /** 记下的去程请求 */
  requests(): LiveDocRequest[]
  /** 记下的撤回 */
  cancels(): string[]
  asWc(): WebContents
}

function fakeContents(): FakeContents {
  const wc: FakeContents = {
    send: vi.fn(),
    destroyed: false,
    isDestroyed: () => wc.destroyed,
    requests: () =>
      wc.send.mock.calls
        .filter((c) => c[0] === 'liveDoc:request')
        .map((c) => c[1] as LiveDocRequest),
    cancels: () =>
      wc.send.mock.calls
        .filter((c) => c[0] === 'liveDoc:cancel')
        .map((c) => (c[1] as { requestId: string }).requestId),
    asWc: () => wc as unknown as WebContents
  }
  return wc
}

const READ: LiveDocOp = { kind: 'read' }
const EDIT: LiveDocOp = { kind: 'edit', toolCallId: 'tc-e', find: 'a', replace: 'b' }
const INSERT: LiveDocOp = { kind: 'insert', toolCallId: 'tc-i', text: 'x' }
const OK_READ: LiveDocResult = {
  ok: true,
  kind: 'read',
  text: 'doc',
  user: { cursorLine: 1, visibleFromLine: 1, visibleToLine: 1, lastEditAgoMs: null }
}
const OK_EDIT: LiveDocResult = { ok: true, kind: 'edit', line: 3, context: '3│b', waitedMs: 0 }

/** 让排队的 then 链跑完（微任务 + 一次真实的宏任务） */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
  await new Promise<void>((r) => setImmediate(r))
}

/** 追踪一个 Promise 的结局，不让 rejection 变成未处理 */
function track<T>(p: Promise<T>): {
  state: () => 'pending' | 'resolved' | 'rejected'
  value: () => T | undefined
  error: () => Error | undefined
} {
  let state: 'pending' | 'resolved' | 'rejected' = 'pending'
  let value: T | undefined
  let error: Error | undefined
  p.then(
    (v) => {
      state = 'resolved'
      value = v
    },
    (e: Error) => {
      state = 'rejected'
      error = e
    }
  )
  return { state: () => state, value: () => value, error: () => error }
}

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  bridge = await import('../liveDocumentBridge')
})

afterEach(() => {
  vi.useRealTimers()
})

describe('B1 没有窗口', () => {
  it('从没 attach → reject「No document window…」', async () => {
    await expect(bridge.requestLiveDocument('s1', READ)).rejects.toThrow(
      'No document window is open for this session.'
    )
  })

  it('窗口已销毁 → 同样失败，什么都没发', async () => {
    const wc = fakeContents()
    bridge.attachLiveDocument('s1', wc.asWc())
    wc.destroyed = true
    await expect(bridge.requestLiveDocument('s1', EDIT)).rejects.toThrow(/^No document window/)
    expect(wc.send).not.toHaveBeenCalled()
  })

  it('detach 之后 → 失败，什么都没发', async () => {
    const wc = fakeContents()
    bridge.attachLiveDocument('s1', wc.asWc())
    bridge.detachLiveDocument('s1')
    await expect(bridge.requestLiveDocument('s1', READ)).rejects.toThrow(/^No document window/)
    expect(wc.send).not.toHaveBeenCalled()
  })
})

describe('B2 一来一回', () => {
  it('发出 liveDoc:request {requestId, sessionId, op}；同一个窗口的答复了结它', async () => {
    const wc = fakeContents()
    bridge.attachLiveDocument('s1', wc.asWc())
    const p = track(bridge.requestLiveDocument('s1', EDIT))
    await flush()

    expect(wc.send).toHaveBeenCalledTimes(1)
    const [req] = wc.requests()
    expect(req).toEqual({ requestId: expect.any(String), sessionId: 's1', op: EDIT })
    expect(req.requestId.length).toBeGreaterThan(0)
    expect(p.state()).toBe('pending')

    bridge.resolveLiveDocumentResponse(wc.asWc(), req.requestId, OK_EDIT)
    await flush()
    expect(p.state()).toBe('resolved')
    expect(p.value()).toEqual(OK_EDIT)
  })

  it('{ ok: false } 是正常结果：resolve 而不是 reject', async () => {
    const wc = fakeContents()
    bridge.attachLiveDocument('s1', wc.asWc())
    const p = bridge.requestLiveDocument('s1', EDIT)
    await flush()
    const failure: LiveDocResult = { ok: false, error: '`find` does not match' }
    bridge.resolveLiveDocumentResponse(wc.asWc(), wc.requests()[0].requestId, failure)
    await expect(p).resolves.toEqual(failure)
  })

  it('每个请求一个新的 requestId', async () => {
    const wc = fakeContents()
    bridge.attachLiveDocument('s1', wc.asWc())
    const first = bridge.requestLiveDocument('s1', READ)
    await flush()
    bridge.resolveLiveDocumentResponse(wc.asWc(), wc.requests()[0].requestId, OK_READ)
    await first
    const second = track(bridge.requestLiveDocument('s1', READ))
    await flush()
    const [a, b] = wc.requests()
    expect(a.requestId).not.toBe(b.requestId)
    bridge.resolveLiveDocumentResponse(wc.asWc(), b.requestId, OK_READ)
    await flush()
    expect(second.state()).toBe('resolved')
  })
})

describe('B3 只认发请求的那个窗口', () => {
  it('别的窗口作答 → 忽略 + warn；真答复照样了结', async () => {
    const wc = fakeContents()
    const intruder = fakeContents()
    bridge.attachLiveDocument('s1', wc.asWc())
    const p = track(bridge.requestLiveDocument('s1', READ))
    await flush()
    const { requestId } = wc.requests()[0]

    bridge.resolveLiveDocumentResponse(intruder.asWc(), requestId, {
      ok: false,
      error: 'forged'
    })
    await flush()
    expect(p.state()).toBe('pending')
    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(String(log.warn.mock.calls[0][0])).toContain(requestId)

    bridge.resolveLiveDocumentResponse(wc.asWc(), requestId, OK_READ)
    await flush()
    expect(p.state()).toBe('resolved')
    expect(p.value()).toEqual(OK_READ)
  })

  it('未知 id / 第二次答复 → 无事发生（不抛、不 warn）', async () => {
    const wc = fakeContents()
    bridge.attachLiveDocument('s1', wc.asWc())
    expect(() =>
      bridge.resolveLiveDocumentResponse(wc.asWc(), 'no-such-request', OK_READ)
    ).not.toThrow()

    const p = track(bridge.requestLiveDocument('s1', READ))
    await flush()
    const { requestId } = wc.requests()[0]
    bridge.resolveLiveDocumentResponse(wc.asWc(), requestId, OK_READ)
    bridge.resolveLiveDocumentResponse(wc.asWc(), requestId, { ok: false, error: 'late' })
    await flush()
    expect(p.value()).toEqual(OK_READ)
    expect(log.warn).not.toHaveBeenCalled()
  })
})

describe('B4 关窗（detach）', () => {
  it('这条会话在途的请求立刻失败（closed）；别的会话不受影响；不发撤回', async () => {
    const w1 = fakeContents()
    const w2 = fakeContents()
    bridge.attachLiveDocument('s1', w1.asWc())
    bridge.attachLiveDocument('s2', w2.asWc())
    const p1 = track(bridge.requestLiveDocument('s1', EDIT))
    const p2 = track(bridge.requestLiveDocument('s2', EDIT))
    await flush()

    bridge.detachLiveDocument('s1')
    await flush()
    expect(p1.state()).toBe('rejected')
    expect(p1.error()!.message).toBe('The document window was closed.')
    expect(p2.state()).toBe('pending')
    expect(w1.cancels()).toEqual([])

    // 立刻：没有等到任何超时
    expect(vi.getTimerCount()).toBe(1)
    bridge.resolveLiveDocumentResponse(w2.asWc(), w2.requests()[0].requestId, OK_EDIT)
    await flush()
    expect(p2.state()).toBe('resolved')
    // 关掉的那条迟到的答复：无事发生
    expect(() =>
      bridge.resolveLiveDocumentResponse(w1.asWc(), w1.requests()[0].requestId, OK_EDIT)
    ).not.toThrow()
  })
})

describe('B5 中止', () => {
  it('中止在途的请求 → Aborted. + liveDoc:cancel {requestId}', async () => {
    const wc = fakeContents()
    bridge.attachLiveDocument('s1', wc.asWc())
    const ac = new AbortController()
    const p = track(bridge.requestLiveDocument('s1', EDIT, ac.signal))
    await flush()
    const { requestId } = wc.requests()[0]

    ac.abort()
    await flush()
    expect(p.state()).toBe('rejected')
    expect(p.error()!.message).toBe('Aborted.')
    expect(wc.cancels()).toEqual([requestId])
    // 之后窗口的答复不再算数
    bridge.resolveLiveDocumentResponse(wc.asWc(), requestId, OK_EDIT)
    await flush()
    expect(p.state()).toBe('rejected')
  })

  it('已中止的 signal → 立刻失败，什么都不发', async () => {
    const wc = fakeContents()
    bridge.attachLiveDocument('s1', wc.asWc())
    const ac = new AbortController()
    ac.abort()
    await expect(bridge.requestLiveDocument('s1', READ, ac.signal)).rejects.toThrow('Aborted.')
    expect(wc.send).not.toHaveBeenCalled()
  })

  it('了结之后再中止 → 无效（不发撤回）', async () => {
    const wc = fakeContents()
    bridge.attachLiveDocument('s1', wc.asWc())
    const ac = new AbortController()
    const p = bridge.requestLiveDocument('s1', READ, ac.signal)
    await flush()
    bridge.resolveLiveDocumentResponse(wc.asWc(), wc.requests()[0].requestId, OK_READ)
    await expect(p).resolves.toEqual(OK_READ)
    ac.abort()
    await flush()
    expect(wc.cancels()).toEqual([])
  })

  it('窗口已销毁时中止 → 照样失败，但不往销毁的窗口发撤回', async () => {
    const wc = fakeContents()
    bridge.attachLiveDocument('s1', wc.asWc())
    const ac = new AbortController()
    const p = track(bridge.requestLiveDocument('s1', EDIT, ac.signal))
    await flush()
    wc.destroyed = true
    ac.abort()
    await flush()
    expect(p.error()!.message).toBe('Aborted.')
    expect(wc.cancels()).toEqual([])
  })
})

describe('B6 超时', () => {
  it.each([
    ['读', READ, 15_000],
    ['改', EDIT, 45_000],
    ['插入', INSERT, 45_000]
  ])('%s：到点前还在等，到点 → 失败 + 撤回 + warn', async (_label, op, ms) => {
    const wc = fakeContents()
    bridge.attachLiveDocument('s1', wc.asWc())
    const p = track(bridge.requestLiveDocument('s1', op))
    await flush()
    const { requestId } = wc.requests()[0]

    await vi.advanceTimersByTimeAsync(ms - 1)
    expect(p.state()).toBe('pending')
    await vi.advanceTimersByTimeAsync(1)
    await flush()
    expect(p.state()).toBe('rejected')
    expect(p.error()!.message).toBe('The document window did not respond in time.')
    expect(wc.cancels()).toEqual([requestId])
    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(String(log.warn.mock.calls[0][0])).toContain('s1')
    expect(String(log.warn.mock.calls[0][0])).toContain(op.kind)
  })

  it('窗口已销毁时超时 → 失败，不发撤回', async () => {
    const wc = fakeContents()
    bridge.attachLiveDocument('s1', wc.asWc())
    const p = track(bridge.requestLiveDocument('s1', READ))
    await flush()
    wc.destroyed = true
    await vi.advanceTimersByTimeAsync(15_000)
    await flush()
    expect(p.state()).toBe('rejected')
    expect(wc.cancels()).toEqual([])
  })

  it('答复在超时之前到 → 定时器被清掉，之后不再触发撤回', async () => {
    const wc = fakeContents()
    bridge.attachLiveDocument('s1', wc.asWc())
    const p = bridge.requestLiveDocument('s1', READ)
    await flush()
    bridge.resolveLiveDocumentResponse(wc.asWc(), wc.requests()[0].requestId, OK_READ)
    await p
    await vi.advanceTimersByTimeAsync(60_000)
    expect(wc.cancels()).toEqual([])
    expect(log.warn).not.toHaveBeenCalled()
  })
})

describe('B8 同一条会话逐个发', () => {
  it('两个请求：前一个了结之前只发了第一个；了结之后才发第二个', async () => {
    const wc = fakeContents()
    bridge.attachLiveDocument('s1', wc.asWc())
    const first = track(bridge.requestLiveDocument('s1', EDIT))
    const second = track(bridge.requestLiveDocument('s1', INSERT))
    await flush()
    expect(wc.requests().map((r) => r.op.kind)).toEqual(['edit'])

    bridge.resolveLiveDocumentResponse(wc.asWc(), wc.requests()[0].requestId, OK_EDIT)
    await flush()
    expect(first.state()).toBe('resolved')
    expect(wc.requests().map((r) => r.op.kind)).toEqual(['edit', 'insert'])
    expect(second.state()).toBe('pending')

    bridge.resolveLiveDocumentResponse(wc.asWc(), wc.requests()[1].requestId, {
      ...OK_EDIT,
      kind: 'insert'
    })
    await flush()
    expect(second.state()).toBe('resolved')
  })

  it('前一个失败（{ok:false} / 超时）也放行下一个', async () => {
    const wc = fakeContents()
    bridge.attachLiveDocument('s1', wc.asWc())
    const first = track(bridge.requestLiveDocument('s1', READ))
    const second = track(bridge.requestLiveDocument('s1', READ))
    await flush()
    await vi.advanceTimersByTimeAsync(15_000)
    await flush()
    expect(first.state()).toBe('rejected')
    expect(wc.requests()).toHaveLength(2)
    expect(second.state()).toBe('pending')
  })

  it('第二个的超时从它自己发出时算，而不是从排队时算', async () => {
    const wc = fakeContents()
    bridge.attachLiveDocument('s1', wc.asWc())
    const first = track(bridge.requestLiveDocument('s1', EDIT))
    const second = track(bridge.requestLiveDocument('s1', READ))
    await flush()

    // 第一个拖了 40s 才答复（比读的 15s 超时还长）
    await vi.advanceTimersByTimeAsync(40_000)
    bridge.resolveLiveDocumentResponse(wc.asWc(), wc.requests()[0].requestId, OK_EDIT)
    await flush()
    expect(first.state()).toBe('resolved')
    expect(wc.requests()).toHaveLength(2)

    await vi.advanceTimersByTimeAsync(14_999)
    expect(second.state()).toBe('pending')
    await vi.advanceTimersByTimeAsync(1)
    await flush()
    expect(second.state()).toBe('rejected')
    expect(second.error()!.message).toContain('did not respond in time')
  })

  it('排队中被中止 → 失败，而且从不发出', async () => {
    const wc = fakeContents()
    bridge.attachLiveDocument('s1', wc.asWc())
    const ac = new AbortController()
    const first = track(bridge.requestLiveDocument('s1', EDIT))
    const second = track(bridge.requestLiveDocument('s1', INSERT, ac.signal))
    await flush()
    ac.abort()
    await flush()

    bridge.resolveLiveDocumentResponse(wc.asWc(), wc.requests()[0].requestId, OK_EDIT)
    await flush()
    expect(first.state()).toBe('resolved')
    expect(second.state()).toBe('rejected')
    expect(second.error()!.message).toBe('Aborted.')
    expect(wc.requests().map((r) => r.op.kind)).toEqual(['edit'])
    expect(wc.cancels()).toEqual([])
  })

  it('排队中窗口关了 → 在途的与排队的都失败，排队的从不发出', async () => {
    const wc = fakeContents()
    bridge.attachLiveDocument('s1', wc.asWc())
    const first = track(bridge.requestLiveDocument('s1', EDIT))
    const second = track(bridge.requestLiveDocument('s1', READ))
    await flush()

    bridge.detachLiveDocument('s1')
    await flush()
    expect(first.error()!.message).toBe('The document window was closed.')
    expect(second.state()).toBe('rejected')
    expect(wc.requests()).toHaveLength(1)
  })

  it('不同会话互不排队', async () => {
    const w1 = fakeContents()
    const w2 = fakeContents()
    bridge.attachLiveDocument('s1', w1.asWc())
    bridge.attachLiveDocument('s2', w2.asWc())
    track(bridge.requestLiveDocument('s1', EDIT))
    const other = track(bridge.requestLiveDocument('s2', READ))
    await flush()
    expect(w1.requests()).toHaveLength(1)
    expect(w2.requests()).toHaveLength(1)
    bridge.resolveLiveDocumentResponse(w2.asWc(), w2.requests()[0].requestId, OK_READ)
    await flush()
    expect(other.state()).toBe('resolved')
  })
})
