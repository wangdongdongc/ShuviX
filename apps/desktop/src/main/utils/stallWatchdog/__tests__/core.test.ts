import { describe, expect, it, vi, type Mock } from 'vitest'
import { createWatchdogCore, type WatchdogCoreDeps } from '../core'
import type { NativeSampleResult, StackCapture, WorkerToMain } from '../protocol'

const CAPTURED: StackCapture = {
  state: 'captured',
  frames: [{ functionName: 'busy', url: 'file:///x/out/main/index.js', line: 3, column: 7 }]
}
const SAMPLE_OK: NativeSampleResult = { ok: true, file: '/l/s.txt', mainThread: ['h', '1 a'] }

const PING = { type: 'ping' } as const

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

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

interface Harness {
  /** 可变的假时钟 / 心跳 / 步骤编码 */
  s: { now: number; beat: number; stepCode: number }
  post: Mock<(msg: WorkerToMain) => void>
  stack: { request: Mock<() => void>; take: Mock<() => StackCapture> }
  readStepCode: Mock<() => number>
  runNativeSample: Mock<() => Promise<NativeSampleResult>>
  tick(now: number, beat?: number): WorkerToMain[]
  run(from: number, to: number, beat?: number): WorkerToMain[][]
  posted(): WorkerToMain[]
  nonPings(): WorkerToMain[]
}

/**
 * 可变的假时钟 + 心跳 + 步骤编码，注入 core。
 * `tick(now, beat?)` 推一拍并返回这一拍发出的消息；`run(from, to, beat?)` 每 500ms 一拍（含两端）。
 */
function setup(over: Partial<WatchdogCoreDeps> = {}): Harness {
  const s = { now: 0, beat: 0, stepCode: 0 }
  const post = vi.fn<(msg: WorkerToMain) => void>()
  const stack = { request: vi.fn<() => void>(), take: vi.fn((): StackCapture => CAPTURED) }
  const readStepCode = vi.fn(() => s.stepCode)
  const runNativeSample = vi.fn((): Promise<NativeSampleResult> => Promise.resolve(SAMPLE_OK))
  const core = createWatchdogCore({
    thresholdMs: 2000,
    suspendGapMs: 10_000,
    nowMs: () => s.now,
    readBeatAtMs: () => s.beat,
    readStepCode,
    post,
    stack,
    nativeSample: { afterMs: 4000, maxPerProcess: 2 },
    runNativeSample,
    ...over
  })
  const posted = (): WorkerToMain[] => post.mock.calls.map((c) => c[0])
  const tick = (now: number, beat?: number): WorkerToMain[] => {
    if (beat !== undefined) s.beat = beat
    s.now = now
    const from = post.mock.calls.length
    core.tick()
    return posted().slice(from)
  }
  const run = (from: number, to: number, beat?: number): WorkerToMain[][] => {
    const out: WorkerToMain[][] = []
    for (let t = from; t <= to; t += 500) out.push(tick(t, beat))
    return out
  }
  const nonPings = (): WorkerToMain[] => posted().filter((m) => m.type !== 'ping')
  return { s, post, stack, readStepCode, runNativeSample, tick, run, posted, nonPings }
}

describe('createWatchdogCore', () => {
  it('is quiet while the main thread keeps beating', () => {
    const h = setup()
    for (let i = 1; i <= 20; i++) h.tick(i * 500, i * 500)
    expect(h.posted()).toEqual(Array.from({ length: 20 }, () => PING))
    expect(h.stack.request).not.toHaveBeenCalled()
    expect(h.stack.take).not.toHaveBeenCalled()
    expect(h.readStepCode).not.toHaveBeenCalled()
    expect(h.runNativeSample).not.toHaveBeenCalled()
  })

  it('pings first on every tick, including the start and end ticks of a stall', () => {
    const h = setup()
    const ticks = [...h.run(500, 6000, 0), h.tick(6500, 6400)]
    for (const posts of ticks) expect(posts[0]).toEqual(PING)
    expect(ticks.at(-1)?.map((m) => m.type)).toEqual(['ping', 'stall'])
  })

  it('on stall start requests a stack and snapshots the step once', () => {
    const h = setup()
    h.s.stepCode = 7
    h.run(1000, 2500, 1000)
    expect(h.stack.request).not.toHaveBeenCalled()
    expect(h.tick(3000)).toEqual([PING])
    expect(h.stack.request).toHaveBeenCalledTimes(1)
    expect(h.readStepCode).toHaveBeenCalledTimes(1)
    h.s.stepCode = 9
    h.run(3500, 4000)
    expect(h.stack.request).toHaveBeenCalledTimes(1)
    expect(h.readStepCode).toHaveBeenCalledTimes(1)
  })

  it('on stall end posts the report with the step snapshot and the taken stack', () => {
    const h = setup()
    h.s.stepCode = 7
    h.run(1000, 3000, 1000)
    h.s.stepCode = 9
    h.run(3500, 4000)
    expect(h.tick(4500, 4300)).toEqual([
      PING,
      {
        type: 'stall',
        seq: 1,
        lastBeatAtMs: 1000,
        resumedAtMs: 4300,
        durationMs: 3300,
        stepCode: 7,
        stack: CAPTURED
      }
    ])
    expect(h.stack.take).toHaveBeenCalledTimes(1)
    expect(h.stack.take.mock.invocationCallOrder[0]).toBeGreaterThan(
      h.stack.request.mock.invocationCallOrder[0]
    )
  })

  it('numbers stalls and snapshots each one’s own step', () => {
    const h = setup()
    h.s.stepCode = 7
    h.run(1000, 3000, 1000)
    h.tick(3500, 3400)
    h.s.stepCode = 11
    h.run(4000, 5500, 3400)
    h.s.stepCode = 12
    h.run(6000, 6500, 3400)
    h.tick(7000, 6900)
    const stalls = h.nonPings()
    expect(stalls).toHaveLength(2)
    expect(stalls[0]).toMatchObject({ type: 'stall', seq: 1, stepCode: 7 })
    expect(stalls[1]).toMatchObject({
      type: 'stall',
      seq: 2,
      stepCode: 11,
      lastBeatAtMs: 3400,
      resumedAtMs: 6900
    })
    expect(h.readStepCode).toHaveBeenCalledTimes(2)
  })

  it('reports why the stack was not captured when capture is off', () => {
    const withReason = setup({ stack: null, stackOffReason: 'X' })
    withReason.run(500, 2000, 0)
    withReason.tick(2500, 2400)
    expect(withReason.nonPings()[0]).toMatchObject({
      type: 'stall',
      stack: { state: 'skipped', reason: 'X' }
    })

    const noReason = setup({ stack: null })
    noReason.run(500, 2000, 0)
    noReason.tick(2500, 2400)
    expect(noReason.nonPings()[0]).toMatchObject({
      type: 'stall',
      stack: { state: 'skipped', reason: 'stack capture is off' }
    })
  })

  it('takes a native sample once the stall has lasted afterMs (>=)', async () => {
    const h = setup()
    h.run(500, 3500, 0)
    expect(h.runNativeSample).not.toHaveBeenCalled()
    h.tick(4000)
    expect(h.runNativeSample).toHaveBeenCalledTimes(1)
    h.run(4500, 6000)
    expect(h.runNativeSample).toHaveBeenCalledTimes(1)
    await flush()
    expect(h.nonPings()).toEqual([
      { type: 'sample', seq: 1, durationSoFarMs: 4000, result: SAMPLE_OK }
    ])
  })

  it('a sample that resolves during the stall is posted before the stall report', async () => {
    const h = setup()
    h.run(500, 4000, 0)
    await flush()
    h.run(4500, 5000)
    h.tick(5500, 5400)
    const msgs = h.nonPings()
    expect(msgs.map((m) => m.type)).toEqual(['sample', 'stall'])
    expect(msgs.map((m) => (m as { seq: number }).seq)).toEqual([1, 1])
  })

  it('a late sample keeps the seq of the stall it was taken in', async () => {
    const d = deferred<NativeSampleResult>()
    const h = setup({ runNativeSample: vi.fn(() => d.promise) })
    h.run(500, 4000, 0)
    h.tick(4500, 4400)
    h.run(5000, 6500, 4400)
    expect(h.nonPings().map((m) => m.type)).toEqual(['stall'])
    d.resolve(SAMPLE_OK)
    await flush()
    expect(h.nonPings().at(-1)).toEqual({
      type: 'sample',
      seq: 1,
      durationSoFarMs: 4000,
      result: SAMPLE_OK
    })
  })

  it('a rejected sample is reported as a failed result', async () => {
    const err = setup({ runNativeSample: vi.fn(() => Promise.reject(new Error('spawn failed'))) })
    err.run(500, 4000, 0)
    await flush()
    expect(err.nonPings()).toEqual([
      {
        type: 'sample',
        seq: 1,
        durationSoFarMs: 4000,
        result: { ok: false, error: 'spawn failed' }
      }
    ])

    const str = setup({ runNativeSample: vi.fn(() => Promise.reject('nope')) })
    str.run(500, 4000, 0)
    await flush()
    expect(str.nonPings()).toEqual([
      { type: 'sample', seq: 1, durationSoFarMs: 4000, result: { ok: false, error: 'nope' } }
    ])
  })

  it('never samples a stall that ends before afterMs, even on the tick that would reach it', async () => {
    const short = setup()
    short.run(500, 2000, 0)
    short.tick(2500, 2400)
    await flush()
    expect(short.runNativeSample).not.toHaveBeenCalled()

    const edge = setup()
    edge.run(500, 3500, 0)
    // 本该到 afterMs 的这一拍，主线程恢复了
    expect(edge.tick(4000, 3900).map((m) => m.type)).toEqual(['ping', 'stall'])
    await flush()
    expect(edge.runNativeSample).not.toHaveBeenCalled()
  })

  it('samples at most maxPerProcess stalls; a failed sample still counts', async () => {
    let calls = 0
    const runNativeSample = vi.fn(() =>
      ++calls === 1 ? Promise.reject(new Error('boom')) : Promise.resolve(SAMPLE_OK)
    )
    const h = setup({ runNativeSample })
    // 三次长卡顿：每次从上一次的恢复点起卡 5s
    let beat = 0
    let now = 0
    for (let i = 0; i < 3; i++) {
      for (let t = now + 500; t <= now + 5000; t += 500) h.tick(t, beat)
      now += 5500
      beat = now - 100
      h.tick(now, beat)
      await flush()
    }
    expect(runNativeSample).toHaveBeenCalledTimes(2)
    const samples = h.nonPings().filter((m) => m.type === 'sample')
    expect(samples.map((m) => m.seq)).toEqual([1, 2])
    expect(h.nonPings().filter((m) => m.type === 'stall')).toHaveLength(3)
  })

  it('never samples without a sample config or runner', async () => {
    const noConfig = setup({ nativeSample: null })
    noConfig.run(500, 8000, 0)
    await flush()
    expect(noConfig.runNativeSample).not.toHaveBeenCalled()
    expect(noConfig.nonPings()).toEqual([])

    const noRunner = setup({ runNativeSample: undefined })
    noRunner.run(500, 8000, 0)
    await flush()
    expect(noRunner.nonPings()).toEqual([])
  })

  it('samples on the start tick when afterMs is below the threshold', async () => {
    const h = setup({ nativeSample: { afterMs: 1000, maxPerProcess: 2 } })
    h.run(500, 1500, 0)
    expect(h.runNativeSample).not.toHaveBeenCalled()
    h.tick(2000)
    expect(h.stack.request).toHaveBeenCalledTimes(1)
    expect(h.runNativeSample).toHaveBeenCalledTimes(1)
    await flush()
    expect(h.nonPings()).toEqual([
      { type: 'sample', seq: 1, durationSoFarMs: 2000, result: SAMPLE_OK }
    ])
  })

  it('does not count the silence before a worker suspension', () => {
    const h = setup({ suspendGapMs: 1500 })
    h.tick(500, 0)
    expect(h.tick(10_000)).toEqual([PING])
    expect(h.stack.request).not.toHaveBeenCalled()
    for (const posts of h.run(10_500, 11_500)) expect(posts).toEqual([PING])
    expect(h.stack.request).not.toHaveBeenCalled()
    h.tick(12_000)
    expect(h.stack.request).toHaveBeenCalledTimes(1)
    h.tick(12_500, 12_400)
    expect(h.nonPings()).toEqual([
      expect.objectContaining({
        type: 'stall',
        seq: 1,
        lastBeatAtMs: 10_000,
        resumedAtMs: 12_400,
        durationMs: 2400
      })
    ])
  })
})
