import type { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SLOT_BEAT_NS, SLOT_STEP, type WatchdogWorkerData, type WorkerToMain } from '../protocol'

interface FakeWorkerLike extends EventEmitter {
  path: string
  opts: { workerData: WatchdogWorkerData; name?: string }
  unref: ReturnType<typeof vi.fn>
  postMessage: ReturnType<typeof vi.fn>
  terminate: ReturnType<typeof vi.fn>
}

const h = vi.hoisted(() => ({
  workers: [] as FakeWorkerLike[],
  createError: null as Error | null,
  appHandlers: {} as Record<string, () => void>,
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  logFile: '/x/logs/main.log' as string,
  inspectorUrl: vi.fn((): string | undefined => undefined)
}))

vi.mock('node:worker_threads', async () => {
  const { EventEmitter: Emitter } = await import('node:events')
  class FakeWorker extends Emitter {
    unref = vi.fn()
    postMessage = vi.fn()
    terminate = vi.fn(() => Promise.resolve(0))
    constructor(
      public path: string,
      public opts: { workerData: WatchdogWorkerData; name?: string }
    ) {
      super()
      if (h.createError) throw h.createError
      h.workers.push(this as unknown as FakeWorkerLike)
    }
  }
  return { Worker: FakeWorker }
})
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn(() => '/fallback/logs'),
    once: (ev: string, cb: () => void) => {
      h.appHandlers[ev] = cb
    }
  }
}))
// 不 mock 的话 electron-log 会写进真实的用户日志
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: h.info, warn: h.warn, error: h.error }),
  default: { transports: { file: { getFile: () => ({ path: h.logFile }) } } }
}))
vi.mock('node:inspector', () => ({ url: h.inspectorUrl }))

type WatchdogModule = typeof import('../watchdog')
type PerfModule = typeof import('../../../perf')

/** 固定时钟：hrtime（ms → ns）与 performance.now */
let hrMs = 10_000
let perfNow = 2000
const ns = (ms: number): bigint => BigInt(ms) * 1_000_000n

const realPlatform = process.platform
const realExecArgv = process.execArgv
const setPlatform = (p: NodeJS.Platform): void => {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}

let watchdog: WatchdogModule
let perf: PerfModule

beforeEach(async () => {
  h.workers.length = 0
  h.createError = null
  h.appHandlers = {}
  h.logFile = '/x/logs/main.log'
  h.info.mockReset()
  h.warn.mockReset()
  h.error.mockReset()
  h.inspectorUrl.mockReset()
  h.inspectorUrl.mockReturnValue(undefined)
  hrMs = 10_000
  perfNow = 2000
  vi.spyOn(process.hrtime, 'bigint').mockImplementation(() => ns(hrMs))
  vi.spyOn(performance, 'now').mockImplementation(() => perfNow)
  process.execArgv = []
  setPlatform('darwin')
  // 模块级 started 标志：每个用例一份全新的 watchdog（以及它订阅的那份 perf）
  vi.resetModules()
  watchdog = await import('../watchdog')
  perf = await import('../../../perf')
})
afterEach(() => {
  perf.onPerfStep(null)
  setPlatform(realPlatform)
  process.execArgv = realExecArgv
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

function start(): FakeWorkerLike {
  watchdog.startStallWatchdog()
  expect(h.workers).toHaveLength(1)
  return h.workers[0]
}
const slotsOf = (w: FakeWorkerLike): BigInt64Array => new BigInt64Array(w.opts.workerData.sab)
const warnings = (): string[] => h.warn.mock.calls.map((c) => String(c[0]))
const send = (w: FakeWorkerLike, msg: WorkerToMain): void => {
  w.emit('message', msg)
}
const skipped = { state: 'skipped', reason: 'r' } as const

describe('startStallWatchdog', () => {
  it('SHUVIX_STALL_WATCHDOG=0 turns it off; starting twice builds one worker', async () => {
    vi.stubEnv('SHUVIX_STALL_WATCHDOG', '0')
    watchdog.startStallWatchdog()
    expect(h.workers).toHaveLength(0)

    vi.unstubAllEnvs()
    vi.resetModules()
    const fresh = await import('../watchdog')
    fresh.startStallWatchdog()
    fresh.startStallWatchdog()
    expect(h.workers).toHaveLength(1)
  })

  it('a failing Worker constructor only logs a warning', () => {
    h.createError = new Error('no worker for you')
    expect(() => watchdog.startStallWatchdog()).not.toThrow()
    expect(warnings()).toEqual(['stall watchdog not started: no worker for you'])
  })

  it('passes the tuning, stack and native-sample config to an unref’d worker', () => {
    const w = start()
    expect(w.path.endsWith('stallWatchdogWorker.js')).toBe(true)
    expect(w.opts.name).toBe('stall-watchdog')
    expect(w.unref).toHaveBeenCalledTimes(1)
    expect(w.opts.workerData).toMatchObject({
      tickMs: 500,
      thresholdMs: 2000,
      suspendGapMs: 1500,
      captureStack: true,
      nativeSample: {
        afterMs: 4000,
        seconds: 3,
        dir: '/x/logs',
        pid: process.pid,
        maxPerProcess: 2,
        keepFiles: 5
      }
    })
    expect(w.opts.workerData.sab).toBeInstanceOf(SharedArrayBuffer)
  })

  it('no native sampling off macOS', () => {
    setPlatform('linux')
    expect(start().opts.workerData.nativeSample).toBeNull()
  })

  it('no stack capture while an external inspector is attached', () => {
    h.inspectorUrl.mockReturnValue('ws://127.0.0.1:9229/abc')
    expect(start().opts.workerData.captureStack).toBe(false)
  })

  it('Perf steps write the step code and the beat into shared memory', () => {
    const w = start()
    const slots = slotsOf(w)
    expect(slots[SLOT_BEAT_NS]).toBe(ns(10_000))
    hrMs = 10_100
    perf.step('a', () => {
      expect(slots[SLOT_STEP]).toBe(2n)
      expect(slots[SLOT_BEAT_NS]).toBe(ns(10_100))
      hrMs = 10_150
    })
    expect(slots[SLOT_STEP]).toBe(3n)
    expect(slots[SLOT_BEAT_NS]).toBe(ns(10_150))

    hrMs = 11_000
    send(w, { type: 'ping' })
    expect(slots[SLOT_BEAT_NS]).toBe(ns(11_000))
    expect(h.warn).not.toHaveBeenCalled()
    expect(h.info).not.toHaveBeenCalled()
  })

  it('reports the main-thread-measured gap when it matches the stall origin', () => {
    const w = start()
    hrMs = 13_000
    send(w, { type: 'ping' })
    send(w, {
      type: 'stall',
      seq: 1,
      lastBeatAtMs: 10_000,
      resumedAtMs: 13_400,
      durationMs: 3400,
      stepCode: 0,
      stack: skipped
    })
    expect(warnings()).toEqual([
      'stall #1: main thread blocked 3.0s (+2000ms → +5000ms since launch), ' +
        'before any recorded step; JS stack: not captured (r)'
    ])
  })

  it('falls back to the worker’s resume time when the origins differ', () => {
    const w = start()
    hrMs = 13_000
    send(w, { type: 'ping' })
    send(w, {
      type: 'stall',
      seq: 1,
      lastBeatAtMs: 9999,
      resumedAtMs: 13_400,
      durationMs: 3401,
      stepCode: 0,
      stack: skipped
    })
    expect(warnings()[0]).toMatch(/^stall #1: main thread blocked 3\.4s \(\+1999ms → \+5400ms /)
  })

  it('back-to-back stalls each get their own main-thread-measured gap', () => {
    const w = start()
    // 两道空档都在第一份报告到达之前记下：10_000 → 13_000，13_000 → 16_000
    hrMs = 13_000
    send(w, { type: 'ping' })
    hrMs = 16_000
    send(w, { type: 'ping' })
    const stall = (seq: number, lastBeatAtMs: number, resumedAtMs: number): void =>
      send(w, {
        type: 'stall',
        seq,
        lastBeatAtMs,
        resumedAtMs,
        durationMs: resumedAtMs - lastBeatAtMs,
        stepCode: 0,
        stack: skipped
      })
    stall(1, 10_000, 13_400)
    stall(2, 13_000, 16_400)
    expect(warnings()).toEqual([
      'stall #1: main thread blocked 3.0s (+2000ms → +5000ms since launch), ' +
        'before any recorded step; JS stack: not captured (r)',
      'stall #2: main thread blocked 3.0s (+5000ms → +8000ms since launch), ' +
        'before any recorded step; JS stack: not captured (r)'
    ])
  })

  it('describes the step code through the same step table', () => {
    const w = start()
    perf.step('a', () => undefined)
    send(w, {
      type: 'stall',
      seq: 2,
      lastBeatAtMs: 10_000,
      resumedAtMs: 12_500,
      durationMs: 2500,
      stepCode: 2,
      stack: skipped
    })
    expect(warnings()[0]).toContain(', in "a"; JS stack: not captured (r)')
  })

  it('logs a native sample report', () => {
    const w = start()
    send(w, {
      type: 'sample',
      seq: 2,
      durationSoFarMs: 4210,
      result: { ok: true, file: '/l/f.txt', mainThread: ['h', '1 a'] }
    })
    expect(warnings()).toEqual([
      'stall #2: native sample of the blocked main thread (taken 4.2s into the stall; ' +
        'heaviest path, leaf last) → /l/f.txt\nh\n1 a'
    ])
  })

  it('stops logging after 100 reports, saying so once; pings keep working', () => {
    const w = start()
    const stall = (seq: number): WorkerToMain => ({
      type: 'stall',
      seq,
      lastBeatAtMs: 1,
      resumedAtMs: 2,
      durationMs: 1,
      stepCode: 0,
      stack: skipped
    })
    for (let i = 1; i <= 101; i++) send(w, stall(i))
    const all = warnings()
    expect(all).toHaveLength(101)
    expect(all.slice(0, 99).every((l) => l.startsWith('stall #'))).toBe(true)
    expect(all[98]).toMatch(/^stall #99: /)
    expect(all[99]).toBe('stall report limit (100) reached; further stalls are not logged')
    expect(all[100]).toMatch(/^stall #100: /)
    expect(all.some((l) => l.startsWith('stall #101:'))).toBe(false)

    hrMs = 20_000
    send(w, { type: 'ping' })
    expect(slotsOf(w)[SLOT_BEAT_NS]).toBe(ns(20_000))
  })

  it('a worker error turns the watchdog off', () => {
    const w = start()
    const slots = slotsOf(w)
    w.emit('error', new Error('boom'))
    expect(warnings()).toEqual(['stall watchdog off: worker failed: boom'])
    const before = slots[SLOT_STEP]
    perf.step('later', () => undefined)
    expect(slots[SLOT_STEP]).toBe(before)
  })

  it('on will-quit stops and terminates the worker and detaches from Perf', () => {
    const w = start()
    const slots = slotsOf(w)
    h.appHandlers['will-quit']()
    expect(w.postMessage).toHaveBeenCalledWith({ type: 'stop' })
    expect(w.terminate).toHaveBeenCalledTimes(1)
    perf.step('after quit', () => undefined)
    expect(slots[SLOT_STEP]).toBe(0n)
    // 退出途中 worker 再出错也被吞掉
    expect(() => w.emit('error', new Error('late'))).not.toThrow()
    expect(warnings()).toEqual([])
  })

  it('on will-quit a throwing postMessage is swallowed and terminate still runs', () => {
    const w = start()
    w.postMessage.mockImplementation(() => {
      throw new Error('worker gone')
    })
    expect(() => h.appHandlers['will-quit']()).not.toThrow()
    expect(w.terminate).toHaveBeenCalledTimes(1)
  })

  it('the message handler keeps its name (no bundler-rename warning)', () => {
    start()
    expect(warnings().some((l) => l.includes('renamed by the bundler'))).toBe(false)
  })
})
