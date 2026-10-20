/**
 * liveDocumentBridge —— 主进程把 agent 的 doc_* 调用转给显示着那份文档的编辑器，等它的答复；没有编辑器就
 * 交给调用方的磁盘回落。
 *
 * 契约（liveDocumentBridge.ts 文件头 + chat-protocol liveDocument.ts）：
 *   - 没有编辑器挂着 / 挂着的窗口已销毁 / 已摘下 → 调 onDisk，交回它的结果，什么都不发；
 *   - 去程 `liveDoc:request {requestId, sessionId, attachId, op}` 发给挂着的那个 webContents；回程只认**发请求的那个**
 *     webContents（别的窗口作答被忽略并记一条 warn），`{ ok: false }` 是正常结果（resolve，不 reject）；
 *   - detach（编辑器摘下）让发给它的在途请求立刻失败（「…editor … closed」），不发撤回，别的会话不受影响；
 *   - 中止 → 「Aborted.」+ 发 `liveDoc:cancel`；已中止的 signal 什么都不发；了结之后的中止无效；
 *   - 超时：读 15s、改 45s，超时发撤回（窗口已销毁则不发）并 warn；
 *   - **同一条会话的请求逐个发**：前一个了结才发下一个，超时从真正发出算；排队期间被中止的不发就失败，
 *     排队期间编辑器摘下了的轮到时走磁盘；不同会话之间互不排队。
 *
 * 假 WebContents 只记 send；计时用假定时器（只假 setTimeout / clearTimeout / Date，微任务照常跑）。
 * 模块级状态（窗口表、在途表、队列）每条用例都要新的：beforeEach 里 resetModules 后重新导入。
 *
 *   B1 没编辑器 / 已销毁 / 已摘下 → 走 onDisk，什么都没发
 *   B2 发出请求的形状；同一个窗口的答复了结它；{ok:false} 也是 resolve
 *   B3 别的窗口作答 → 忽略 + warn，真答复照样了结；未知 id / 第二次答复 → 无事发生
 *   B4 detach → 这条会话在途的请求立刻失败（closed），别的会话不受影响，不发撤回
 *   B5 中止 → Aborted. + liveDoc:cancel；已中止的 signal 什么都不发；了结后再中止无效
 *   B6 超时：读 15s / 改 45s / 插入 45s；超时发撤回（已销毁不发）并 warn
 *   B8 排队：同会话逐个发；第二个的超时从它自己发出时算；排队中被中止 → 不发就失败；排队中摘下 → 轮到时走磁盘；
 *      异会话不互等
 *   B9 挂接栈（同一条会话可能有几个编辑器挂着）：请求发给最后挂上的那个，带它的 attachId；它摘下了轮到前一个；
 *      摘下较早的不影响最新的；同一窗口重挂载（新旧两个 attachId）摘旧的 → 发给新的；再挂一次 = 挪到最后、不留重复；
 *      最新的窗口已销毁（还没来事件）→ 发给前一个活着的、不走磁盘；在途时摘下最新的 → 立刻 closed、下一个发给前一个；
 *      摘一个不认识的 id → 无事；带着别的窗口摘 → 无事（只摘调用方自己挂的）
 *   B10 窗口的生命周期：`destroyed` / 主框架 `did-navigate` / `render-process-gone` 都摘掉它挂的全部 —— 在途的
 *      立刻 closed（不发撤回、定时器清掉），会话落到别的窗口或磁盘；did-navigate 的监听跨重挂载一直在；每个窗口
 *      恰好挂一次这三个监听（不挂 did-navigate-in-page）；摘掉之后迟到的答复无事发生
 *   B11 磁盘与编辑器同一条队：前一个磁盘操作挂着时占着队，期间挂上的编辑器要等它了结才收到下一个
 *      （走哪条路轮到时才定）；磁盘操作失败也放行下一个
 *   B12 已中止的 signal、没有编辑器 → 「Aborted.」，磁盘不调
 *   B13 交给编辑器之前的门（beforeLive，doc_* 拿它判会话权限表）：有编辑器才调、先调完才发；门抛错 → 不发、照原样
 *       失败；过门期间编辑器摘下 → 走磁盘；过门期间被中止 → Aborted.、不发；没有编辑器 → 不调门、直接磁盘
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
  on: ReturnType<typeof vi.fn>
  once: ReturnType<typeof vi.fn>
  /** 触发经 on / once 挂上的监听（once 的只触发一次） */
  emit(event: string): void
  destroyed: boolean
  isDestroyed(): boolean
  /** 记下的去程请求 */
  requests(): LiveDocRequest[]
  /** 记下的撤回 */
  cancels(): string[]
  asWc(): WebContents
}

function fakeContents(): FakeContents {
  const firedOnce = new Set<number>()
  const wc: FakeContents = {
    send: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    emit: (event) => {
      for (const [name, fn] of wc.on.mock.calls) if (name === event) (fn as () => void)()
      wc.once.mock.calls.forEach(([name, fn], i) => {
        if (name !== event || firedOnce.has(i)) return
        firedOnce.add(i)
        ;(fn as () => void)()
      })
    },
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
const OK_EDIT: LiveDocResult = {
  ok: true,
  kind: 'edit',
  line: 3,
  context: '3│b',
  waitedMs: 0,
  text: 'b'
}
const DISK_READ: LiveDocResult = { ok: true, kind: 'read', text: 'from disk' }
const CLOSED =
  'The editor showing this document closed before the change was confirmed. Call doc_read to see the document as it is now.'
const TIMED_OUT = 'The editor showing this document did not respond in time.'

/** 磁盘回落（每条用例重置） */
const disk = vi.fn<() => Promise<LiveDocResult>>()

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
  disk.mockResolvedValue(DISK_READ)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('B1 没有编辑器 → 磁盘回落', () => {
  it('从没 attach → 调 onDisk，交回它的结果', async () => {
    await expect(bridge.requestLiveDocument('s1', READ, undefined, disk)).resolves.toEqual(
      DISK_READ
    )
    expect(disk).toHaveBeenCalledTimes(1)
  })

  it('窗口已销毁 → 同样走磁盘，什么都没发', async () => {
    const wc = fakeContents()
    bridge.attachLiveDocument('s1', wc.asWc(), 'a1')
    wc.destroyed = true
    await expect(bridge.requestLiveDocument('s1', EDIT, undefined, disk)).resolves.toEqual(
      DISK_READ
    )
    expect(wc.send).not.toHaveBeenCalled()
  })

  it('detach 之后 → 走磁盘，什么都没发', async () => {
    const wc = fakeContents()
    bridge.attachLiveDocument('s1', wc.asWc(), 'a1')
    bridge.detachLiveDocument('s1', 'a1')
    await expect(bridge.requestLiveDocument('s1', READ, undefined, disk)).resolves.toEqual(
      DISK_READ
    )
    expect(wc.send).not.toHaveBeenCalled()
  })

  it('onDisk 抛错 → 原样 reject', async () => {
    disk.mockRejectedValueOnce(new Error('disk failed'))
    await expect(bridge.requestLiveDocument('s1', READ, undefined, disk)).rejects.toThrow(
      'disk failed'
    )
  })
})

describe('B2 一来一回', () => {
  it('发出 liveDoc:request {requestId, sessionId, attachId, op}；同一个窗口的答复了结它', async () => {
    const wc = fakeContents()
    bridge.attachLiveDocument('s1', wc.asWc(), 'a1')
    const p = track(bridge.requestLiveDocument('s1', EDIT, undefined, disk))
    await flush()

    expect(wc.send).toHaveBeenCalledTimes(1)
    const [req] = wc.requests()
    expect(req).toEqual({
      requestId: expect.any(String),
      sessionId: 's1',
      attachId: 'a1',
      op: EDIT
    })
    expect(req.requestId.length).toBeGreaterThan(0)
    expect(p.state()).toBe('pending')

    bridge.resolveLiveDocumentResponse(wc.asWc(), req.requestId, OK_EDIT)
    await flush()
    expect(p.state()).toBe('resolved')
    expect(p.value()).toEqual(OK_EDIT)
  })

  it('{ ok: false } 是正常结果：resolve 而不是 reject', async () => {
    const wc = fakeContents()
    bridge.attachLiveDocument('s1', wc.asWc(), 'a1')
    const p = bridge.requestLiveDocument('s1', EDIT, undefined, disk)
    await flush()
    const failure: LiveDocResult = { ok: false, error: '`find` does not match' }
    bridge.resolveLiveDocumentResponse(wc.asWc(), wc.requests()[0].requestId, failure)
    await expect(p).resolves.toEqual(failure)
  })

  it('每个请求一个新的 requestId', async () => {
    const wc = fakeContents()
    bridge.attachLiveDocument('s1', wc.asWc(), 'a1')
    const first = bridge.requestLiveDocument('s1', READ, undefined, disk)
    await flush()
    bridge.resolveLiveDocumentResponse(wc.asWc(), wc.requests()[0].requestId, OK_READ)
    await first
    const second = track(bridge.requestLiveDocument('s1', READ, undefined, disk))
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
    bridge.attachLiveDocument('s1', wc.asWc(), 'a1')
    const p = track(bridge.requestLiveDocument('s1', READ, undefined, disk))
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
    bridge.attachLiveDocument('s1', wc.asWc(), 'a1')
    expect(() =>
      bridge.resolveLiveDocumentResponse(wc.asWc(), 'no-such-request', OK_READ)
    ).not.toThrow()

    const p = track(bridge.requestLiveDocument('s1', READ, undefined, disk))
    await flush()
    const { requestId } = wc.requests()[0]
    bridge.resolveLiveDocumentResponse(wc.asWc(), requestId, OK_READ)
    bridge.resolveLiveDocumentResponse(wc.asWc(), requestId, { ok: false, error: 'late' })
    await flush()
    expect(p.value()).toEqual(OK_READ)
    expect(log.warn).not.toHaveBeenCalled()
  })
})

describe('B4 编辑器摘下（detach）', () => {
  it('这条会话在途的请求立刻失败（closed）；别的会话不受影响；不发撤回', async () => {
    const w1 = fakeContents()
    const w2 = fakeContents()
    bridge.attachLiveDocument('s1', w1.asWc(), 'a1')
    bridge.attachLiveDocument('s2', w2.asWc(), 'a1')
    const p1 = track(bridge.requestLiveDocument('s1', EDIT, undefined, disk))
    const p2 = track(bridge.requestLiveDocument('s2', EDIT, undefined, disk))
    await flush()

    bridge.detachLiveDocument('s1', 'a1')
    await flush()
    expect(p1.state()).toBe('rejected')
    expect(p1.error()!.message).toBe(CLOSED)
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
    bridge.attachLiveDocument('s1', wc.asWc(), 'a1')
    const ac = new AbortController()
    const p = track(bridge.requestLiveDocument('s1', EDIT, ac.signal, disk))
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
    bridge.attachLiveDocument('s1', wc.asWc(), 'a1')
    const ac = new AbortController()
    ac.abort()
    await expect(bridge.requestLiveDocument('s1', READ, ac.signal, disk)).rejects.toThrow(
      'Aborted.'
    )
    expect(wc.send).not.toHaveBeenCalled()
  })

  it('了结之后再中止 → 无效（不发撤回）', async () => {
    const wc = fakeContents()
    bridge.attachLiveDocument('s1', wc.asWc(), 'a1')
    const ac = new AbortController()
    const p = bridge.requestLiveDocument('s1', READ, ac.signal, disk)
    await flush()
    bridge.resolveLiveDocumentResponse(wc.asWc(), wc.requests()[0].requestId, OK_READ)
    await expect(p).resolves.toEqual(OK_READ)
    ac.abort()
    await flush()
    expect(wc.cancels()).toEqual([])
  })

  it('窗口已销毁时中止 → 照样失败，但不往销毁的窗口发撤回', async () => {
    const wc = fakeContents()
    bridge.attachLiveDocument('s1', wc.asWc(), 'a1')
    const ac = new AbortController()
    const p = track(bridge.requestLiveDocument('s1', EDIT, ac.signal, disk))
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
    bridge.attachLiveDocument('s1', wc.asWc(), 'a1')
    const p = track(bridge.requestLiveDocument('s1', op, undefined, disk))
    await flush()
    const { requestId } = wc.requests()[0]

    await vi.advanceTimersByTimeAsync(ms - 1)
    expect(p.state()).toBe('pending')
    await vi.advanceTimersByTimeAsync(1)
    await flush()
    expect(p.state()).toBe('rejected')
    expect(p.error()!.message).toBe(TIMED_OUT)
    expect(wc.cancels()).toEqual([requestId])
    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(String(log.warn.mock.calls[0][0])).toContain('s1')
    expect(String(log.warn.mock.calls[0][0])).toContain(op.kind)
  })

  it('窗口已销毁时超时 → 失败，不发撤回', async () => {
    const wc = fakeContents()
    bridge.attachLiveDocument('s1', wc.asWc(), 'a1')
    const p = track(bridge.requestLiveDocument('s1', READ, undefined, disk))
    await flush()
    wc.destroyed = true
    await vi.advanceTimersByTimeAsync(15_000)
    await flush()
    expect(p.state()).toBe('rejected')
    expect(wc.cancels()).toEqual([])
  })

  it('答复在超时之前到 → 定时器被清掉，之后不再触发撤回', async () => {
    const wc = fakeContents()
    bridge.attachLiveDocument('s1', wc.asWc(), 'a1')
    const p = bridge.requestLiveDocument('s1', READ, undefined, disk)
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
    bridge.attachLiveDocument('s1', wc.asWc(), 'a1')
    const first = track(bridge.requestLiveDocument('s1', EDIT, undefined, disk))
    const second = track(bridge.requestLiveDocument('s1', INSERT, undefined, disk))
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
    bridge.attachLiveDocument('s1', wc.asWc(), 'a1')
    const first = track(bridge.requestLiveDocument('s1', READ, undefined, disk))
    const second = track(bridge.requestLiveDocument('s1', READ, undefined, disk))
    await flush()
    await vi.advanceTimersByTimeAsync(15_000)
    await flush()
    expect(first.state()).toBe('rejected')
    expect(wc.requests()).toHaveLength(2)
    expect(second.state()).toBe('pending')
  })

  it('第二个的超时从它自己发出时算，而不是从排队时算', async () => {
    const wc = fakeContents()
    bridge.attachLiveDocument('s1', wc.asWc(), 'a1')
    const first = track(bridge.requestLiveDocument('s1', EDIT, undefined, disk))
    const second = track(bridge.requestLiveDocument('s1', READ, undefined, disk))
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
    bridge.attachLiveDocument('s1', wc.asWc(), 'a1')
    const ac = new AbortController()
    const first = track(bridge.requestLiveDocument('s1', EDIT, undefined, disk))
    const second = track(bridge.requestLiveDocument('s1', INSERT, ac.signal, disk))
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

  it('排队中编辑器摘下 → 在途的失败，排队的从不发出、轮到时走磁盘', async () => {
    const wc = fakeContents()
    bridge.attachLiveDocument('s1', wc.asWc(), 'a1')
    const first = track(bridge.requestLiveDocument('s1', EDIT, undefined, disk))
    const second = track(bridge.requestLiveDocument('s1', READ, undefined, disk))
    await flush()

    bridge.detachLiveDocument('s1', 'a1')
    await flush()
    expect(first.error()!.message).toBe(CLOSED)
    expect(second.state()).toBe('resolved')
    expect(second.value()).toEqual(DISK_READ)
    expect(disk).toHaveBeenCalledTimes(1)
    expect(wc.requests()).toHaveLength(1)
  })

  it('不同会话互不排队', async () => {
    const w1 = fakeContents()
    const w2 = fakeContents()
    bridge.attachLiveDocument('s1', w1.asWc(), 'a1')
    bridge.attachLiveDocument('s2', w2.asWc(), 'a1')
    track(bridge.requestLiveDocument('s1', EDIT, undefined, disk))
    const other = track(bridge.requestLiveDocument('s2', READ, undefined, disk))
    await flush()
    expect(w1.requests()).toHaveLength(1)
    expect(w2.requests()).toHaveLength(1)
    bridge.resolveLiveDocumentResponse(w2.asWc(), w2.requests()[0].requestId, OK_READ)
    await flush()
    expect(other.state()).toBe('resolved')
  })
})

describe('B9 挂接栈：发给最后挂上的那个', () => {
  it('B9a 两个窗口挂着同一条会话 → 请求只发给最新的、带它的 attachId', async () => {
    const older = fakeContents()
    const newer = fakeContents()
    bridge.attachLiveDocument('s1', older.asWc(), 'a-old')
    bridge.attachLiveDocument('s1', newer.asWc(), 'a-new')
    const p = track(bridge.requestLiveDocument('s1', READ, undefined, disk))
    await flush()
    expect(newer.requests()).toEqual([
      { requestId: expect.any(String), sessionId: 's1', attachId: 'a-new', op: READ }
    ])
    expect(older.send).not.toHaveBeenCalled()
    bridge.resolveLiveDocumentResponse(newer.asWc(), newer.requests()[0].requestId, OK_READ)
    await flush()
    expect(p.value()).toEqual(OK_READ)
    expect(disk).not.toHaveBeenCalled()
  })

  it('B9b 摘下最新的 → 轮到前一个', async () => {
    const older = fakeContents()
    const newer = fakeContents()
    bridge.attachLiveDocument('s1', older.asWc(), 'a-old')
    bridge.attachLiveDocument('s1', newer.asWc(), 'a-new')
    bridge.detachLiveDocument('s1', 'a-new', newer.asWc())
    track(bridge.requestLiveDocument('s1', READ, undefined, disk))
    await flush()
    expect(older.requests().map((r) => r.attachId)).toEqual(['a-old'])
    expect(newer.send).not.toHaveBeenCalled()
  })

  it('B9c 摘下较早的 → 最新的照旧收', async () => {
    const older = fakeContents()
    const newer = fakeContents()
    bridge.attachLiveDocument('s1', older.asWc(), 'a-old')
    bridge.attachLiveDocument('s1', newer.asWc(), 'a-new')
    bridge.detachLiveDocument('s1', 'a-old', older.asWc())
    track(bridge.requestLiveDocument('s1', READ, undefined, disk))
    await flush()
    expect(newer.requests().map((r) => r.attachId)).toEqual(['a-new'])
    expect(older.send).not.toHaveBeenCalled()
  })

  it('B9d 同一窗口重挂载（旧 id 挂着时新 id 挂上，再摘旧的）→ 请求带的是新 id', async () => {
    const wc = fakeContents()
    bridge.attachLiveDocument('s1', wc.asWc(), 'view-1')
    bridge.attachLiveDocument('s1', wc.asWc(), 'view-2')
    bridge.detachLiveDocument('s1', 'view-1', wc.asWc())
    track(bridge.requestLiveDocument('s1', READ, undefined, disk))
    await flush()
    expect(wc.requests().map((r) => r.attachId)).toEqual(['view-2'])
    expect(disk).not.toHaveBeenCalled()
  })

  it('B9e 同一个 attachId 再挂一次 = 挪到最后，不留重复（摘一次就真摘掉了）', async () => {
    const w1 = fakeContents()
    const w2 = fakeContents()
    bridge.attachLiveDocument('s1', w1.asWc(), 'a1')
    bridge.attachLiveDocument('s1', w2.asWc(), 'a2')
    bridge.attachLiveDocument('s1', w1.asWc(), 'a1')
    const first = track(bridge.requestLiveDocument('s1', READ, undefined, disk))
    await flush()
    expect(w1.requests().map((r) => r.attachId)).toEqual(['a1'])
    bridge.resolveLiveDocumentResponse(w1.asWc(), w1.requests()[0].requestId, OK_READ)
    await flush()
    expect(first.state()).toBe('resolved')

    bridge.detachLiveDocument('s1', 'a1', w1.asWc())
    track(bridge.requestLiveDocument('s1', READ, undefined, disk))
    await flush()
    // a1 只留过一份：摘一次之后轮到 w2，而不是又落回 w1
    expect(w1.requests()).toHaveLength(1)
    expect(w2.requests().map((r) => r.attachId)).toEqual(['a2'])
  })

  it('B9f 最新的窗口已销毁（还没来 destroyed 事件）→ 发给前一个活着的，不走磁盘', async () => {
    const older = fakeContents()
    const newer = fakeContents()
    bridge.attachLiveDocument('s1', older.asWc(), 'a-old')
    bridge.attachLiveDocument('s1', newer.asWc(), 'a-new')
    newer.destroyed = true
    track(bridge.requestLiveDocument('s1', READ, undefined, disk))
    await flush()
    expect(older.requests().map((r) => r.attachId)).toEqual(['a-old'])
    expect(newer.send).not.toHaveBeenCalled()
    expect(disk).not.toHaveBeenCalled()
  })

  it('B9g 在途时摘下最新的 → 立刻 closed；下一个请求发给前一个', async () => {
    const older = fakeContents()
    const newer = fakeContents()
    bridge.attachLiveDocument('s1', older.asWc(), 'a-old')
    bridge.attachLiveDocument('s1', newer.asWc(), 'a-new')
    const first = track(bridge.requestLiveDocument('s1', EDIT, undefined, disk))
    await flush()
    expect(newer.requests()).toHaveLength(1)

    bridge.detachLiveDocument('s1', 'a-new', newer.asWc())
    await flush()
    expect(first.state()).toBe('rejected')
    expect(first.error()!.message).toBe(CLOSED)
    expect(vi.getTimerCount()).toBe(0)

    track(bridge.requestLiveDocument('s1', READ, undefined, disk))
    await flush()
    expect(older.requests().map((r) => r.attachId)).toEqual(['a-old'])
    expect(newer.requests()).toHaveLength(1)
  })

  it('B9h 摘一个不认识的 id（或别的会话）→ 无事：在途的照等、挂着的照收', async () => {
    const wc = fakeContents()
    bridge.attachLiveDocument('s1', wc.asWc(), 'a1')
    const p = track(bridge.requestLiveDocument('s1', READ, undefined, disk))
    await flush()
    bridge.detachLiveDocument('s1', 'no-such-id')
    bridge.detachLiveDocument('s-other', 'a1')
    await flush()
    expect(p.state()).toBe('pending')
    bridge.resolveLiveDocumentResponse(wc.asWc(), wc.requests()[0].requestId, OK_READ)
    await flush()
    expect(p.state()).toBe('resolved')
    track(bridge.requestLiveDocument('s1', READ, undefined, disk))
    await flush()
    expect(wc.requests()).toHaveLength(2)
    expect(disk).not.toHaveBeenCalled()
  })

  it('B9i 带着别的窗口摘 → 无事（只摘调用方自己挂的那一个）', async () => {
    const owner = fakeContents()
    const other = fakeContents()
    bridge.attachLiveDocument('s1', owner.asWc(), 'a1')
    const p = track(bridge.requestLiveDocument('s1', EDIT, undefined, disk))
    await flush()
    bridge.detachLiveDocument('s1', 'a1', other.asWc())
    await flush()
    expect(p.state()).toBe('pending')
    bridge.resolveLiveDocumentResponse(owner.asWc(), owner.requests()[0].requestId, OK_EDIT)
    await flush()
    expect(p.value()).toEqual(OK_EDIT)

    track(bridge.requestLiveDocument('s1', READ, undefined, disk))
    await flush()
    expect(owner.requests()).toHaveLength(2)
    expect(other.send).not.toHaveBeenCalled()
    expect(disk).not.toHaveBeenCalled()
  })
})

describe('B10 窗口的生命周期', () => {
  it('B10a destroyed → 它的在途请求立刻 closed（不发撤回、定时器清掉）；会话落到别的窗口或磁盘', async () => {
    const dying = fakeContents()
    const other = fakeContents()
    // s1：other 在前、dying 最新；s2：只有 dying
    bridge.attachLiveDocument('s1', other.asWc(), 'a-other')
    bridge.attachLiveDocument('s1', dying.asWc(), 'a-dying')
    bridge.attachLiveDocument('s2', dying.asWc(), 'a-dying-2')
    const p1 = track(bridge.requestLiveDocument('s1', EDIT, undefined, disk))
    const p2 = track(bridge.requestLiveDocument('s2', READ, undefined, disk))
    await flush()
    expect(dying.requests()).toHaveLength(2)
    expect(vi.getTimerCount()).toBe(2)

    dying.destroyed = true
    dying.emit('destroyed')
    await flush()
    expect(p1.error()?.message).toBe(CLOSED)
    expect(p2.error()?.message).toBe(CLOSED)
    expect(dying.cancels()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)

    track(bridge.requestLiveDocument('s1', READ, undefined, disk))
    const viaDisk = track(bridge.requestLiveDocument('s2', READ, undefined, disk))
    await flush()
    expect(other.requests().map((r) => r.attachId)).toEqual(['a-other'])
    expect(viaDisk.value()).toEqual(DISK_READ)
    expect(disk).toHaveBeenCalledTimes(1)
    expect(dying.requests()).toHaveLength(2)
  })

  it('B10b 主框架 did-navigate → 同样摘掉（窗口没销毁也一样）；别的窗口不受影响；重挂载之后再导航照样摘', async () => {
    const page = fakeContents()
    const other = fakeContents()
    bridge.attachLiveDocument('s1', page.asWc(), 'a1')
    bridge.attachLiveDocument('s2', other.asWc(), 'a1')
    const p1 = track(bridge.requestLiveDocument('s1', EDIT, undefined, disk))
    const p2 = track(bridge.requestLiveDocument('s2', EDIT, undefined, disk))
    await flush()

    page.emit('did-navigate')
    await flush()
    expect(p1.error()?.message).toBe(CLOSED)
    expect(page.cancels()).toEqual([])
    expect(p2.state()).toBe('pending')

    // 没有编辑器了 → 磁盘
    const viaDisk = track(bridge.requestLiveDocument('s1', READ, undefined, disk))
    await flush()
    expect(viaDisk.value()).toEqual(DISK_READ)

    // 重载后的页面自己再挂 → 又收得到；再导航一次 → 又摘掉（监听一直在）
    bridge.attachLiveDocument('s1', page.asWc(), 'a2')
    const p3 = track(bridge.requestLiveDocument('s1', EDIT, undefined, disk))
    await flush()
    expect(page.requests().map((r) => r.attachId)).toEqual(['a1', 'a2'])
    page.emit('did-navigate')
    await flush()
    expect(p3.error()?.message).toBe(CLOSED)

    // 另一个窗口那条一直在等，答了照样了结
    bridge.resolveLiveDocumentResponse(other.asWc(), other.requests()[0].requestId, OK_EDIT)
    await flush()
    expect(p2.value()).toEqual(OK_EDIT)
  })

  it('B10c 每个窗口恰好挂一次：once(destroyed)、on(did-navigate)、on(render-process-gone)；不挂 did-navigate-in-page', () => {
    const wc = fakeContents()
    bridge.attachLiveDocument('s1', wc.asWc(), 'a1')
    bridge.attachLiveDocument('s1', wc.asWc(), 'a2')
    bridge.attachLiveDocument('s2', wc.asWc(), 'a1')
    bridge.detachLiveDocument('s1', 'a1', wc.asWc())
    bridge.attachLiveDocument('s1', wc.asWc(), 'a1')
    expect(wc.once.mock.calls.map(([name]) => name)).toEqual(['destroyed'])
    expect(wc.on.mock.calls.map(([name]) => name).sort()).toEqual([
      'did-navigate',
      'render-process-gone'
    ])
    const all = [...wc.on.mock.calls, ...wc.once.mock.calls].map(([name]) => name)
    expect(all).not.toContain('did-navigate-in-page')
  })

  it('B10d 摘掉之后迟到的答复：无事发生（不抛、不 warn、结局不变）', async () => {
    const wc = fakeContents()
    bridge.attachLiveDocument('s1', wc.asWc(), 'a1')
    const p = track(bridge.requestLiveDocument('s1', EDIT, undefined, disk))
    await flush()
    const { requestId } = wc.requests()[0]
    wc.emit('did-navigate')
    await flush()
    expect(p.state()).toBe('rejected')
    expect(() => bridge.resolveLiveDocumentResponse(wc.asWc(), requestId, OK_EDIT)).not.toThrow()
    await flush()
    expect(p.state()).toBe('rejected')
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('B10e render-process-gone → 与 destroyed 一样摘掉：在途立刻 closed、定时器清掉，之后走磁盘', async () => {
    const wc = fakeContents()
    bridge.attachLiveDocument('s1', wc.asWc(), 'a1')
    const p = track(bridge.requestLiveDocument('s1', EDIT, undefined, disk))
    await flush()
    wc.emit('render-process-gone')
    await flush()
    expect(p.error()?.message).toBe(CLOSED)
    expect(wc.cancels()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
    // 崩溃的页面不会答复：不再发给它，落到磁盘
    const next = track(bridge.requestLiveDocument('s1', READ, undefined, disk))
    await flush()
    expect(next.value()).toEqual(DISK_READ)
    expect(wc.requests()).toHaveLength(1)
  })
})

describe('B11 磁盘与编辑器同一条队', () => {
  /** 一个由用例决定何时了结的磁盘操作 */
  function deferredDisk(): {
    fn: ReturnType<typeof vi.fn<() => Promise<LiveDocResult>>>
    resolve: (r: LiveDocResult) => void
    reject: (e: Error) => void
  } {
    let resolve!: (r: LiveDocResult) => void
    let reject!: (e: Error) => void
    const promise = new Promise<LiveDocResult>((res, rej) => {
      resolve = res
      reject = rej
    })
    return { fn: vi.fn(() => promise), resolve, reject }
  }

  it('B11a 磁盘操作挂着时占着队；期间挂上的编辑器等它了结才收到下一个（走哪条路轮到时才定）', async () => {
    const first = deferredDisk()
    const secondDisk = vi.fn<() => Promise<LiveDocResult>>().mockResolvedValue(DISK_READ)
    const p1 = track(bridge.requestLiveDocument('s1', EDIT, undefined, first.fn))
    const p2 = track(bridge.requestLiveDocument('s1', READ, undefined, secondDisk))
    await flush()
    expect(first.fn).toHaveBeenCalledTimes(1)

    const wc = fakeContents()
    bridge.attachLiveDocument('s1', wc.asWc(), 'a1')
    await flush()
    expect(wc.send).not.toHaveBeenCalled()
    expect(p2.state()).toBe('pending')

    first.resolve(OK_EDIT)
    await flush()
    expect(p1.value()).toEqual(OK_EDIT)
    expect(wc.requests().map((r) => r.op)).toEqual([READ])
    expect(secondDisk).not.toHaveBeenCalled()

    bridge.resolveLiveDocumentResponse(wc.asWc(), wc.requests()[0].requestId, OK_READ)
    await flush()
    expect(p2.value()).toEqual(OK_READ)
  })

  it('B11b 磁盘操作失败也放行下一个', async () => {
    const first = deferredDisk()
    const p1 = track(bridge.requestLiveDocument('s1', EDIT, undefined, first.fn))
    const p2 = track(bridge.requestLiveDocument('s1', READ, undefined, disk))
    await flush()
    expect(disk).not.toHaveBeenCalled()
    first.reject(new Error('disk broke'))
    await flush()
    expect(p1.error()?.message).toBe('disk broke')
    expect(p2.value()).toEqual(DISK_READ)
    expect(disk).toHaveBeenCalledTimes(1)
  })
})

describe('B12 已中止的 signal、没有编辑器', () => {
  it('B12 → 「Aborted.」，磁盘不调；不占队（下一个照常走）', async () => {
    const ac = new AbortController()
    ac.abort()
    await expect(bridge.requestLiveDocument('s1', EDIT, ac.signal, disk)).rejects.toThrow(
      'Aborted.'
    )
    expect(disk).not.toHaveBeenCalled()
    await expect(bridge.requestLiveDocument('s1', READ, undefined, disk)).resolves.toEqual(
      DISK_READ
    )
    expect(disk).toHaveBeenCalledTimes(1)
  })
})

describe('B13 交给编辑器之前的门', () => {
  it('有编辑器：先过门再发；门抛错 → 不发、原样失败', async () => {
    const wc = fakeContents()
    bridge.attachLiveDocument('s1', wc.asWc(), 'a1')
    let release: () => void = () => {}
    const gate = vi.fn(() => new Promise<void>((r) => (release = r)))
    const p = track(bridge.requestLiveDocument('s1', EDIT, undefined, disk, gate))
    await flush()
    expect(gate).toHaveBeenCalledTimes(1)
    expect(wc.send).not.toHaveBeenCalled()
    release()
    await flush()
    expect(wc.requests()).toHaveLength(1)
    bridge.resolveLiveDocumentResponse(wc.asWc(), wc.requests()[0].requestId, OK_EDIT)
    await flush()
    expect(p.value()).toEqual(OK_EDIT)

    const denied = track(
      bridge.requestLiveDocument('s1', EDIT, undefined, disk, async () => {
        throw new Error('Blocked by policy')
      })
    )
    await flush()
    expect(denied.state()).toBe('rejected')
    expect(denied.error()?.message).toBe('Blocked by policy')
    expect(wc.requests()).toHaveLength(1)
    expect(disk).not.toHaveBeenCalled()
  })

  it('过门期间编辑器摘下 → 走磁盘；过门期间被中止 → Aborted.、不发', async () => {
    const wc = fakeContents()
    bridge.attachLiveDocument('s1', wc.asWc(), 'a1')
    const detached = track(
      bridge.requestLiveDocument('s1', READ, undefined, disk, async () => {
        bridge.detachLiveDocument('s1', 'a1', wc.asWc())
      })
    )
    await flush()
    expect(detached.value()).toEqual(DISK_READ)
    expect(wc.send).not.toHaveBeenCalled()

    bridge.attachLiveDocument('s1', wc.asWc(), 'a2')
    const ac = new AbortController()
    const aborted = track(
      bridge.requestLiveDocument('s1', EDIT, ac.signal, disk, async () => {
        ac.abort()
      })
    )
    await flush()
    expect(aborted.state()).toBe('rejected')
    expect(aborted.error()?.message).toBe('Aborted.')
    expect(wc.requests()).toHaveLength(0)
  })

  it('没有编辑器：不调门，直接磁盘', async () => {
    const gate = vi.fn(async () => undefined)
    const p = track(bridge.requestLiveDocument('s1', READ, undefined, disk, gate))
    await flush()
    expect(p.value()).toEqual(DISK_READ)
    expect(gate).not.toHaveBeenCalled()
  })
})
