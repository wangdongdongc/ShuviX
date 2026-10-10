/**
 * 「ShuviX 设置」条的写入队列（metaWriteQueue，node 环境）—— 组件外的按会话在途任务。
 *
 * 契约（CLAUDE.md「md extension metadata」：No id → no button，第一次改设置自动分配 id）：
 *   - Q-1..4 没有 id → 先往缓冲区写一个 UUIDv7（setObjectId），再轮询 mdMeta.get 直到磁盘上是它，然后
 *     setFill / unsetFill；缓冲区已有合法 id → 不分配，直接等它落盘；
 *   - Q-5/6/23 等待期间的后续编辑排进同一个任务（一个 id、同键后写覆盖先写，写的过程中新来的接着写）；
 *   - Q-7..13 三种失败（分配不了 / 迟迟没落盘 / 主进程拒绝）落成 error，下一次写入开始时清掉；
 *   - Q-14..18「换新 id」走同一条路，有在途任务时不做；
 *   - Q-19..22 会话互不相干、订阅可退、未知会话给初始态、reset 之后旧任务既不发通知也不删新任务；
 *   - Q-24 宿主没实现 mdMeta → 不抛，落成 not-saved。
 *
 * `@shuvix/chat-ui` 整个替掉（getChatApi 交替身）。时间一律假的：轮询 300ms 一次、20 次放弃。
 * 每条用例用独占的会话 id，并且不让任务跨用例轮询（要么把假磁盘指向 id，要么把时间推到放弃）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MdMetaNoteView, MdMetaWriteResult } from '@shuvix/chat-protocol/mdMeta'

const host = vi.hoisted(() => ({ api: {} as { mdMeta?: unknown } }))

vi.mock('@shuvix/chat-ui', () => ({ getChatApi: () => host.api }))

import {
  metaWriteState,
  requestMetaWrite,
  requestNewObjectId,
  resetMetaWritesForTests,
  subscribeMetaWrites,
  type MetaWriteState
} from './metaWriteQueue'

type GetFn = (p: { sessionId: string }) => Promise<MdMetaNoteView | null>
type SetFillFn = (p: {
  sessionId: string
  objectId: string
  key: string
  value: unknown
}) => Promise<MdMetaWriteResult>
type UnsetFillFn = (p: {
  sessionId: string
  objectId: string
  key: string
}) => Promise<MdMetaWriteResult>

const U = '0199d3a2-7b3e-7c4d-9a1f-2e5b8c7d6f10'
const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const MODEL = 'shuvix-model'
const THINKING = 'shuvix-thinking'
const POLL = 300

/** 每个会话磁盘上的 id（没有为 null / 缺省） */
let disk: Record<string, string | null>
let get: ReturnType<typeof vi.fn<GetFn>>
let setFill: ReturnType<typeof vi.fn<SetFillFn>>
let unsetFill: ReturnType<typeof vi.fn<UnsetFillFn>>
/** 每次 setObjectId 拿到的 id（按调用顺序） */
let assigned: string[]
let setObjectId: ReturnType<typeof vi.fn<(id: string) => boolean>>

const viewOf = (objectId: string | null): MdMetaNoteView => ({
  kind: 'agent',
  objectId,
  idStatus: objectId ? 'ok' : 'none',
  fillKeys: [MODEL, THINKING],
  fill: {},
  declared: [],
  warnings: [],
  readOnly: false
})

let seq = 0
/** 每条用例独占的会话 id */
const nextSession = (): string => `mq-${++seq}`

/** 让挂起的 promise 链（get → setFill → emit）走完，不推进时间 */
async function drain(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

/** 推进假时间并把随之而来的 promise 链走完 */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  await drain()
}

/** 把会话的假磁盘指向 id，再推进一个轮询间隔（首轮轮询在请求时就同步发生了，那时磁盘还没有它） */
async function catchUp(sessionId: string, id: string): Promise<void> {
  disk[sessionId] = id
  await advance(POLL)
}

/** 记录每次通知时的状态快照 */
function record(sessionId: string): MetaWriteState[] {
  const seen: MetaWriteState[] = []
  subscribeMetaWrites(sessionId, () => seen.push(metaWriteState(sessionId)))
  return seen
}

/** 没有 id 时写一项（缓冲区里没有合法 id） */
const writeNoId = (sessionId: string, key: string, value: string | null): void =>
  requestMetaWrite({ sessionId, bufferId: null, key, value, setObjectId })

const deferred = <T>(): { promise: Promise<T>; resolve: (v: T) => void } => {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const fillCalls = (): Array<{ objectId: string; key: string; value: unknown }> =>
  setFill.mock.calls.map(([p]) => ({ objectId: p.objectId, key: p.key, value: p.value }))

beforeEach(() => {
  vi.useFakeTimers()
  resetMetaWritesForTests()
  disk = {}
  get = vi.fn<GetFn>(async ({ sessionId }) => viewOf(disk[sessionId] ?? null))
  setFill = vi.fn<SetFillFn>(async () => ({ success: true }))
  unsetFill = vi.fn<UnsetFillFn>(async () => ({ success: true }))
  host.api = { mdMeta: { get, setFill, unsetFill } }
  assigned = []
  setObjectId = vi.fn<(id: string) => boolean>((id) => {
    assigned.push(id)
    return true
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('metaWriteQueue —— 没有 id：自动分配，等落盘，再写', () => {
  it('Q-1 同步分配 UUIDv7 并显示在途；首轮轮询立即发生，之后每 300ms 一次；磁盘追上 → setFill 恰一次，在途清空、written 记下', async () => {
    const s = nextSession()
    const seen = record(s)
    writeNoId(s, THINKING, 'low')

    // 同步：分配、在途、版本、通知
    expect(setObjectId).toHaveBeenCalledTimes(1)
    expect(assigned[0]).toMatch(V7)
    const st = metaWriteState(s)
    expect(st.pending).toEqual(new Map([[THINKING, 'low']]))
    expect(st.error).toBeNull()
    expect(st.version).toBe(1)
    expect(seen).toHaveLength(1)

    await drain()
    expect(get).toHaveBeenCalledTimes(1)
    expect(get).toHaveBeenLastCalledWith({ sessionId: s })
    expect(setFill).not.toHaveBeenCalled()

    await advance(POLL)
    expect(get).toHaveBeenCalledTimes(2)
    expect(setFill).not.toHaveBeenCalled()

    disk[s] = assigned[0]
    await advance(POLL)
    expect(get).toHaveBeenCalledTimes(3)
    expect(setFill).toHaveBeenCalledTimes(1)
    expect(setFill).toHaveBeenCalledWith({
      sessionId: s,
      objectId: assigned[0],
      key: THINKING,
      value: 'low'
    })
    expect(unsetFill).not.toHaveBeenCalled()
    const done = metaWriteState(s)
    expect(done.pending).toBeNull()
    expect(done.error).toBeNull()
    expect(done.written.get(THINKING)).toBe('low')

    await advance(POLL * 5)
    expect(get).toHaveBeenCalledTimes(3)
    expect(setObjectId).toHaveBeenCalledTimes(1)
  })

  it('Q-2 每次通知时版本恰比上一次多 1；没变化时同一引用，每次通知后换新引用', async () => {
    const s = nextSession()
    const refs: MetaWriteState[] = []
    subscribeMetaWrites(s, () => refs.push(metaWriteState(s)))
    const initial = metaWriteState(s)
    writeNoId(s, THINKING, 'low')
    const afterStart = metaWriteState(s)
    expect(afterStart).not.toBe(initial)
    expect(metaWriteState(s)).toBe(afterStart)

    await catchUp(s, assigned[0])
    expect(refs.length).toBeGreaterThan(1)
    let prevVersion = initial.version
    let prevRef: MetaWriteState = initial
    for (const snap of refs) {
      expect(snap.version).toBe(prevVersion + 1)
      expect(snap).not.toBe(prevRef)
      prevVersion = snap.version
      prevRef = snap
    }
    // 落定之后不再变化：同一引用
    expect(metaWriteState(s)).toBe(refs[refs.length - 1])
    expect(metaWriteState(s)).toBe(metaWriteState(s))
  })

  it('Q-3 缓冲区已有合法 U、磁盘也是 U → 不分配；首轮轮询即命中，不推进时间就 setFill(U)', async () => {
    const s = nextSession()
    disk[s] = U
    requestMetaWrite({ sessionId: s, bufferId: U, key: THINKING, value: 'high', setObjectId })
    expect(setObjectId).not.toHaveBeenCalled()
    expect(metaWriteState(s).pending).toEqual(new Map([[THINKING, 'high']]))
    await drain()
    expect(get).toHaveBeenCalledTimes(1)
    expect(setFill).toHaveBeenCalledTimes(1)
    expect(setFill).toHaveBeenCalledWith({
      sessionId: s,
      objectId: U,
      key: THINKING,
      value: 'high'
    })
    expect(metaWriteState(s).pending).toBeNull()
  })

  it('Q-4 值为 null → unsetFill（参数里没有 value），不调 setFill', async () => {
    const s = nextSession()
    disk[s] = U
    requestMetaWrite({ sessionId: s, bufferId: U, key: THINKING, value: null, setObjectId })
    expect(metaWriteState(s).pending).toEqual(new Map([[THINKING, null]]))
    await drain()
    expect(unsetFill).toHaveBeenCalledTimes(1)
    const [arg] = unsetFill.mock.calls[0]
    expect(arg).toEqual({ sessionId: s, objectId: U, key: THINKING })
    expect('value' in arg).toBe(false)
    expect(setFill).not.toHaveBeenCalled()
    expect(metaWriteState(s).written.get(THINKING)).toBeNull()
  })

  it.each([
    ['后续请求的 bufferId 仍为 null（换了一个 setObjectId）', 'null' as const],
    ['后续请求的 bufferId 已是分配到的 id', 'assigned' as const]
  ])(
    'Q-5 落盘之前又改别的键、又改同一键（%s）→ 只分配一次；在途合并；追上后恰两次 setFill，同键只写最后的值',
    async (_label, variant) => {
      const s = nextSession()
      writeNoId(s, THINKING, 'low')
      const id = assigned[0]
      await drain()

      const second = vi.fn<(id: string) => boolean>(() => true)
      const bufferId = variant === 'null' ? null : id
      const spy = variant === 'null' ? second : setObjectId
      requestMetaWrite({ sessionId: s, bufferId, key: MODEL, value: 'p/m', setObjectId: spy })
      requestMetaWrite({ sessionId: s, bufferId, key: THINKING, value: 'high', setObjectId: spy })

      expect(second).not.toHaveBeenCalled()
      expect(setObjectId).toHaveBeenCalledTimes(1)
      expect(metaWriteState(s).pending).toEqual(
        new Map([
          [THINKING, 'high'],
          [MODEL, 'p/m']
        ])
      )

      disk[s] = id
      await advance(POLL)
      expect(setFill).toHaveBeenCalledTimes(2)
      expect(fillCalls()).toEqual(
        expect.arrayContaining([
          { objectId: id, key: THINKING, value: 'high' },
          { objectId: id, key: MODEL, value: 'p/m' }
        ])
      )
      expect(fillCalls().some((c) => c.value === 'low')).toBe(false)
      expect(metaWriteState(s).pending).toBeNull()
    }
  )

  it('Q-6 正在写某一项时又来新键、又改正在写的那一键 → 全部写进去，那一键先旧后新各一次；不再轮询、不再分配', async () => {
    const s = nextSession()
    const held = deferred<MdMetaWriteResult>()
    setFill.mockImplementationOnce(() => held.promise)
    writeNoId(s, THINKING, 'low')
    await catchUp(s, assigned[0])
    expect(setFill).toHaveBeenCalledTimes(1)
    const getsAtWrite = get.mock.calls.length

    requestMetaWrite({ sessionId: s, bufferId: null, key: MODEL, value: 'p/m', setObjectId })
    requestMetaWrite({ sessionId: s, bufferId: null, key: THINKING, value: 'high', setObjectId })
    expect(metaWriteState(s).pending).toEqual(
      new Map([
        [MODEL, 'p/m'],
        [THINKING, 'high']
      ])
    )

    held.resolve({ success: true })
    await drain()
    expect(fillCalls()).toEqual([
      { objectId: assigned[0], key: THINKING, value: 'low' },
      { objectId: assigned[0], key: MODEL, value: 'p/m' },
      { objectId: assigned[0], key: THINKING, value: 'high' }
    ])
    expect(get).toHaveBeenCalledTimes(getsAtWrite)
    expect(setObjectId).toHaveBeenCalledTimes(1)
    expect(metaWriteState(s).pending).toBeNull()
    expect(metaWriteState(s).written).toEqual(
      new Map([
        [THINKING, 'high'],
        [MODEL, 'p/m']
      ])
    )
  })

  it('Q-23 同键 A、B、再 A → 先写 A（最后的值），再写 B', async () => {
    const s = nextSession()
    writeNoId(s, THINKING, 'low')
    writeNoId(s, MODEL, 'p/m')
    writeNoId(s, THINKING, 'medium')
    disk[s] = assigned[0]
    await advance(POLL)
    expect(fillCalls()).toEqual([
      { objectId: assigned[0], key: THINKING, value: 'medium' },
      { objectId: assigned[0], key: MODEL, value: 'p/m' }
    ])
  })
})

describe('metaWriteQueue —— 失败', () => {
  it('Q-7 setObjectId 回 false → cannot-assign，不轮询不写；下一次写入再试分配', async () => {
    const s = nextSession()
    setObjectId.mockReturnValueOnce(false)
    writeNoId(s, THINKING, 'low')
    const st = metaWriteState(s)
    expect(st.pending).toBeNull()
    expect(st.error).toEqual({ kind: 'cannot-assign' })
    await advance(10_000)
    expect(get).not.toHaveBeenCalled()
    expect(setFill).not.toHaveBeenCalled()
    expect(unsetFill).not.toHaveBeenCalled()

    writeNoId(s, THINKING, 'low')
    expect(setObjectId).toHaveBeenCalledTimes(2)
    // 第一次回 false 的那次没走默认实现，不在 assigned 里 —— 按调用记录取
    await catchUp(s, setObjectId.mock.calls[1][0])
    expect(setFill).toHaveBeenCalledTimes(1)
  })

  it('Q-8 磁盘一直没追上 → 恰 20 次 get（0、300 … 5700ms）后 not-saved；不写、不再查；5699ms 时还在等', async () => {
    const s = nextSession()
    writeNoId(s, THINKING, 'low')
    await drain()
    await advance(5699)
    expect(get).toHaveBeenCalledTimes(19)
    expect(metaWriteState(s).error).toBeNull()
    expect(metaWriteState(s).pending).not.toBeNull()

    await advance(1)
    expect(get).toHaveBeenCalledTimes(20)
    expect(metaWriteState(s)).toMatchObject({ pending: null, error: { kind: 'not-saved' } })
    expect(setFill).not.toHaveBeenCalled()
    expect(unsetFill).not.toHaveBeenCalled()

    await advance(5000)
    expect(get).toHaveBeenCalledTimes(20)
  })

  it('Q-9 get 先拒绝两次、第三次见到 id → 在 600ms 写入；一直拒绝 / 一直回 null → not-saved', async () => {
    const s = nextSession()
    get.mockRejectedValueOnce(new Error('ipc down')).mockRejectedValueOnce(new Error('ipc down'))
    writeNoId(s, THINKING, 'low')
    disk[s] = assigned[0]
    await drain()
    await advance(599)
    expect(setFill).not.toHaveBeenCalled()
    await advance(1)
    expect(setFill).toHaveBeenCalledTimes(1)
    expect(metaWriteState(s).error).toBeNull()

    const s2 = nextSession()
    get.mockRejectedValue(new Error('ipc down'))
    writeNoId(s2, THINKING, 'low')
    disk[s2] = assigned[1]
    await drain()
    await advance(POLL * 19)
    expect(metaWriteState(s2).error).toEqual({ kind: 'not-saved' })

    const s3 = nextSession()
    get.mockResolvedValue(null)
    writeNoId(s3, THINKING, 'low')
    disk[s3] = assigned[2]
    await drain()
    await advance(POLL * 19)
    expect(metaWriteState(s3).error).toEqual({ kind: 'not-saved' })
    expect(setFill).toHaveBeenCalledTimes(1)
  })

  it('Q-10 主进程拒绝：reason 原样带上；带 message 的带 message；setFill / unsetFill 抛错 → invalid-value + 错误信息', async () => {
    const run = async (
      value: string | null,
      setup: () => void
    ): Promise<MetaWriteState['error']> => {
      const s = nextSession()
      disk[s] = U
      setup()
      requestMetaWrite({ sessionId: s, bufferId: U, key: THINKING, value, setObjectId })
      await drain()
      expect(metaWriteState(s).pending).toBeNull()
      return metaWriteState(s).error
    }

    const noId = await run('low', () =>
      setFill.mockResolvedValueOnce({ success: false, reason: 'no-object-id' })
    )
    expect(noId).toEqual({ kind: 'rejected', reason: 'no-object-id', message: undefined })

    expect(
      await run('max', () =>
        setFill.mockResolvedValueOnce({
          success: false,
          reason: 'invalid-value',
          message: 'bad level'
        })
      )
    ).toEqual({ kind: 'rejected', reason: 'invalid-value', message: 'bad level' })

    expect(
      await run('low', () => setFill.mockRejectedValueOnce(new Error('ipc exploded')))
    ).toEqual({ kind: 'rejected', reason: 'invalid-value', message: 'ipc exploded' })

    expect(
      await run(null, () => unsetFill.mockRejectedValueOnce(new Error('ipc exploded')))
    ).toEqual({ kind: 'rejected', reason: 'invalid-value', message: 'ipc exploded' })
    expect(setObjectId).not.toHaveBeenCalled()
  })

  it('Q-11 两个键第一个被拒 → 第二个照写；最终 error 是第一个的，written 只有成功的那个；运行期间 error 一直为 null', async () => {
    const s = nextSession()
    const second = deferred<MdMetaWriteResult>()
    setFill
      .mockResolvedValueOnce({ success: false, reason: 'invalid-value', message: 'first bad' })
      .mockImplementationOnce(() => second.promise)
    writeNoId(s, THINKING, 'xx')
    writeNoId(s, MODEL, 'p/m')
    disk[s] = assigned[0]
    await advance(POLL)
    expect(setFill).toHaveBeenCalledTimes(2)
    // 第二项还在写：失败只在任务结束时落下
    expect(metaWriteState(s).error).toBeNull()
    expect(metaWriteState(s).pending).not.toBeNull()

    second.resolve({ success: true })
    await drain()
    const st = metaWriteState(s)
    expect(st.pending).toBeNull()
    expect(st.error).toEqual({ kind: 'rejected', reason: 'invalid-value', message: 'first bad' })
    expect(st.written).toEqual(new Map([[MODEL, 'p/m']]))
  })

  it('Q-11b 两个都失败 → error 是最后一个的', async () => {
    const s = nextSession()
    setFill
      .mockResolvedValueOnce({ success: false, reason: 'invalid-value', message: 'first bad' })
      .mockResolvedValueOnce({ success: false, reason: 'key-not-allowed' })
    writeNoId(s, THINKING, 'xx')
    writeNoId(s, MODEL, 'p/m')
    disk[s] = assigned[0]
    await advance(POLL)
    expect(metaWriteState(s).error).toEqual({
      kind: 'rejected',
      reason: 'key-not-allowed',
      message: undefined
    })
    expect(metaWriteState(s).written.size).toBe(0)
  })

  it('Q-12 rejected / not-saved / cannot-assign 之后，新的一次写入同步清掉 error', async () => {
    // rejected
    const s1 = nextSession()
    disk[s1] = U
    setFill.mockResolvedValueOnce({ success: false, reason: 'no-object-id' })
    requestMetaWrite({ sessionId: s1, bufferId: U, key: THINKING, value: 'low', setObjectId })
    await drain()
    expect(metaWriteState(s1).error?.kind).toBe('rejected')
    requestMetaWrite({ sessionId: s1, bufferId: U, key: THINKING, value: 'low', setObjectId })
    expect(metaWriteState(s1).error).toBeNull()
    await drain()

    // not-saved
    const s2 = nextSession()
    writeNoId(s2, THINKING, 'low')
    await advance(POLL * 20)
    expect(metaWriteState(s2).error?.kind).toBe('not-saved')
    requestMetaWrite({
      sessionId: s2,
      bufferId: assigned[0],
      key: THINKING,
      value: 'low',
      setObjectId
    })
    expect(metaWriteState(s2).error).toBeNull()
    await catchUp(s2, assigned[0])
    expect(metaWriteState(s2).pending).toBeNull()

    // cannot-assign
    const s3 = nextSession()
    setObjectId.mockReturnValueOnce(false)
    writeNoId(s3, THINKING, 'low')
    expect(metaWriteState(s3).error?.kind).toBe('cannot-assign')
    writeNoId(s3, THINKING, 'low')
    expect(metaWriteState(s3).error).toBeNull()
    await catchUp(s3, setObjectId.mock.calls[setObjectId.mock.calls.length - 1][0])
    expect(metaWriteState(s3).pending).toBeNull()
  })

  it('Q-13 not-saved 之后带着上次分配的 id 重试 → 不再分配，重新轮询，写在那个 id 下', async () => {
    const s = nextSession()
    writeNoId(s, THINKING, 'low')
    const id = assigned[0]
    await advance(POLL * 20)
    expect(metaWriteState(s).error).toEqual({ kind: 'not-saved' })
    const getsBefore = get.mock.calls.length

    requestMetaWrite({ sessionId: s, bufferId: id, key: THINKING, value: 'low', setObjectId })
    expect(setObjectId).toHaveBeenCalledTimes(1)
    await drain()
    expect(get.mock.calls.length).toBe(getsBefore + 1)
    disk[s] = id
    await advance(POLL)
    expect(fillCalls()).toEqual([{ objectId: id, key: THINKING, value: 'low' }])
  })
})

describe('metaWriteQueue —— 换新 id', () => {
  it('Q-14 没有在途任务 → 分配一个不同于 U 的 UUIDv7；在途是空 Map（不是 null）；落盘后清空，不写任何设置', async () => {
    const s = nextSession()
    disk[s] = U
    requestNewObjectId(s, setObjectId)
    expect(setObjectId).toHaveBeenCalledTimes(1)
    expect(assigned[0]).toMatch(V7)
    expect(assigned[0]).not.toBe(U)
    const st = metaWriteState(s)
    expect(st.pending).not.toBeNull()
    expect(st.pending?.size).toBe(0)

    await drain()
    expect(metaWriteState(s).pending).not.toBeNull()
    disk[s] = assigned[0]
    await advance(POLL)
    expect(metaWriteState(s)).toMatchObject({ pending: null, error: null })
    expect(setFill).not.toHaveBeenCalled()
    expect(unsetFill).not.toHaveBeenCalled()
  })

  it('Q-15 有在途任务时 → 不分配、状态引用不变；原任务照常完成', async () => {
    const s = nextSession()
    writeNoId(s, THINKING, 'low')
    const before = metaWriteState(s)
    const spy = vi.fn<(id: string) => boolean>(() => true)
    requestNewObjectId(s, spy)
    expect(spy).not.toHaveBeenCalled()
    expect(metaWriteState(s)).toBe(before)

    await catchUp(s, assigned[0])
    expect(fillCalls()).toEqual([{ objectId: assigned[0], key: THINKING, value: 'low' }])
    expect(metaWriteState(s).pending).toBeNull()
  })

  it('Q-16 换新 id 的任务进行中改设置 → 并进去：不再分配，setFill 用新 id 而不是 U', async () => {
    const s = nextSession()
    disk[s] = U
    requestNewObjectId(s, setObjectId)
    const fresh = assigned[0]
    requestMetaWrite({ sessionId: s, bufferId: U, key: THINKING, value: 'high', setObjectId })
    expect(setObjectId).toHaveBeenCalledTimes(1)
    expect(metaWriteState(s).pending).toEqual(new Map([[THINKING, 'high']]))

    disk[s] = fresh
    await advance(POLL)
    expect(fillCalls()).toEqual([{ objectId: fresh, key: THINKING, value: 'high' }])
  })

  it('Q-17 换新 id 时 setObjectId 回 false → cannot-assign，不轮询', async () => {
    const s = nextSession()
    disk[s] = U
    setObjectId.mockReturnValueOnce(false)
    requestNewObjectId(s, setObjectId)
    expect(metaWriteState(s)).toMatchObject({ pending: null, error: { kind: 'cannot-assign' } })
    await advance(3000)
    expect(get).not.toHaveBeenCalled()
  })

  it('Q-18 换新的 id 一直没落盘 → not-saved', async () => {
    const s = nextSession()
    disk[s] = U
    requestNewObjectId(s, setObjectId)
    await advance(POLL * 20)
    expect(metaWriteState(s)).toMatchObject({ pending: null, error: { kind: 'not-saved' } })
    expect(get).toHaveBeenCalledTimes(20)
  })
})

describe('metaWriteQueue —— 会话、订阅、初始态、reset', () => {
  it('Q-19 会话互不相干：s1 在途不挡 s2（各分配各的 id）；s2 的变化不通知 s1、不换 s1 的引用；s2 换新 id 也不被 s1 挡', async () => {
    const s1 = nextSession()
    const s2 = nextSession()
    const seen1 = record(s1)
    writeNoId(s1, THINKING, 'low')
    const s1State = metaWriteState(s1)
    expect(seen1).toHaveLength(1)

    writeNoId(s2, THINKING, 'high')
    expect(setObjectId).toHaveBeenCalledTimes(2)
    expect(assigned[1]).not.toBe(assigned[0])
    expect(metaWriteState(s2).pending).toEqual(new Map([[THINKING, 'high']]))
    expect(seen1).toHaveLength(1)
    expect(metaWriteState(s1)).toBe(s1State)

    await catchUp(s2, assigned[1])
    expect(fillCalls()).toEqual([{ objectId: assigned[1], key: THINKING, value: 'high' }])
    expect(metaWriteState(s1)).toBe(s1State)

    requestNewObjectId(s2, setObjectId)
    expect(setObjectId).toHaveBeenCalledTimes(3)
    disk[s2] = assigned[2]
    disk[s1] = assigned[0]
    await advance(POLL)
    expect(metaWriteState(s1).pending).toBeNull()
    expect(metaWriteState(s2).pending).toBeNull()
  })

  it('Q-20 退订的监听不再被叫，另一个照叫；重复退订无害', async () => {
    const s = nextSession()
    const a = vi.fn()
    const b = vi.fn()
    const offA = subscribeMetaWrites(s, a)
    subscribeMetaWrites(s, b)
    writeNoId(s, THINKING, 'low')
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)

    offA()
    offA()
    await catchUp(s, assigned[0])
    expect(a).toHaveBeenCalledTimes(1)
    expect(b.mock.calls.length).toBeGreaterThan(1)
  })

  it('Q-21 未知会话 → 初始态（written 是空 Map），重复取是同一引用', () => {
    const s = nextSession()
    const st = metaWriteState(s)
    expect(st.pending).toBeNull()
    expect(st.error).toBeNull()
    expect(st.version).toBe(0)
    expect(st.written).toBeInstanceOf(Map)
    expect(st.written.size).toBe(0)
    expect(metaWriteState(s)).toBe(st)
  })

  it('Q-22 reset → 回到初始态；旧监听不再被叫；被遗忘的任务不挡新的写入', async () => {
    const s = nextSession()
    const old = vi.fn()
    subscribeMetaWrites(s, old)
    writeNoId(s, THINKING, 'low')
    expect(old).toHaveBeenCalledTimes(1)

    resetMetaWritesForTests()
    expect(metaWriteState(s).version).toBe(0)
    expect(metaWriteState(s).pending).toBeNull()

    writeNoId(s, THINKING, 'high')
    expect(setObjectId).toHaveBeenCalledTimes(2)
    expect(metaWriteState(s).pending).toEqual(new Map([[THINKING, 'high']]))
    expect(metaWriteState(s).version).toBe(1)
    expect(old).toHaveBeenCalledTimes(1)

    disk[s] = assigned[1]
    await advance(POLL)
    expect(metaWriteState(s).pending).toBeNull()
  })

  it('Q-22b 任务轮询中 reset，随后旧任务的 id 落盘 → 旧任务不写、不发通知，也不删 reset 之后在同一会话开的新任务', async () => {
    const s = nextSession()
    writeNoId(s, THINKING, 'low')
    const oldId = assigned[0]
    await drain()

    resetMetaWritesForTests()
    const seen = record(s)
    writeNoId(s, MODEL, 'p/m')
    const newId = assigned[1]
    expect(seen).toHaveLength(1)
    await drain()

    disk[s] = oldId
    await advance(POLL)
    // 旧任务见到了自己的 id，但它已不是当前任务：不写、不通知
    expect(setFill).not.toHaveBeenCalled()
    expect(seen).toHaveLength(1)
    expect(metaWriteState(s).version).toBe(1)
    expect(metaWriteState(s).pending).toEqual(new Map([[MODEL, 'p/m']]))

    // 新任务还在：再改一项会并进去而不是另开
    writeNoId(s, THINKING, 'high')
    expect(setObjectId).toHaveBeenCalledTimes(2)

    disk[s] = newId
    await advance(POLL)
    expect(fillCalls()).toEqual([
      { objectId: newId, key: MODEL, value: 'p/m' },
      { objectId: newId, key: THINKING, value: 'high' }
    ])
    expect(metaWriteState(s)).toMatchObject({ pending: null, error: null })
  })

  it('Q-22c 任务轮询中 reset，旧任务随后超时 → 不往新状态里发 not-saved，也不删新任务', async () => {
    const s = nextSession()
    writeNoId(s, THINKING, 'low')
    await drain()
    await advance(3000)

    resetMetaWritesForTests()
    const seen = record(s)
    writeNoId(s, MODEL, 'p/m')
    const newId = assigned[1]
    await drain()

    // 旧任务在 5700ms（从它开始算）放弃；新任务此时还在等
    await advance(2800)
    expect(metaWriteState(s).error).toBeNull()
    expect(metaWriteState(s).pending).toEqual(new Map([[MODEL, 'p/m']]))
    expect(seen).toHaveLength(1)

    writeNoId(s, THINKING, 'high')
    expect(setObjectId).toHaveBeenCalledTimes(2)
    disk[s] = newId
    await advance(POLL)
    expect(fillCalls()).toEqual([
      { objectId: newId, key: MODEL, value: 'p/m' },
      { objectId: newId, key: THINKING, value: 'high' }
    ])
    expect(metaWriteState(s)).toMatchObject({ pending: null, error: null })
  })

  it('Q-24 宿主没实现 mdMeta → 照样分配，随后 not-saved，不抛', async () => {
    host.api = {}
    const s = nextSession()
    expect(() => writeNoId(s, THINKING, 'low')).not.toThrow()
    expect(setObjectId).toHaveBeenCalledTimes(1)
    await drain()
    expect(metaWriteState(s)).toMatchObject({ pending: null, error: { kind: 'not-saved' } })
  })
})
