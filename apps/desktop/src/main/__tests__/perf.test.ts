import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { info, warn, error } = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }))
// 不 mock 的话 electron-log 会写进真实的用户日志
vi.mock('../logger', () => ({
  createLogger: () => ({ info, warn, error }),
  default: { transports: { file: { getFile: () => ({ path: '/x/logs/main.log' }) } } }
}))

import {
  SLOW_STEP_MS,
  mark,
  measure,
  measureAsync,
  onPerfStep,
  sinceLaunchMs,
  step,
  type PerfStepPhase
} from '../perf'

let t = 0
const listener = vi.fn<(label: string, phase: PerfStepPhase) => void>()

beforeEach(() => {
  t = 0
  vi.spyOn(performance, 'now').mockImplementation(() => t)
  listener.mockReset()
  info.mockReset()
  warn.mockReset()
  error.mockReset()
  onPerfStep(listener)
})
afterEach(() => {
  onPerfStep(null)
  vi.restoreAllMocks()
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

describe('mark', () => {
  it('reports the milestone as passed and logs its offset since launch', () => {
    t = 1234.4
    mark('m')
    expect(listener.mock.calls).toEqual([['m', 'after']])
    expect(info).toHaveBeenCalledTimes(1)
    expect(info.mock.calls[0][0]).toMatch(/^m — \+\d+ms since launch$/)
    expect(info.mock.calls[0][0]).toBe('m — +1234ms since launch')
  })
})

describe('measure', () => {
  it('reports in before running fn and after once it returns', () => {
    const result = measure('x', () => {
      expect(listener.mock.calls).toEqual([['x', 'in']])
      return 42
    })
    expect(result).toBe(42)
    expect(listener.mock.calls).toEqual([
      ['x', 'in'],
      ['x', 'after']
    ])
    expect(info).toHaveBeenCalledTimes(1)
    expect(info.mock.calls[0][0]).toMatch(/^x — \d+ms$/)
  })

  it('rethrows, still logs and still reports after', () => {
    const boom = new Error('boom')
    expect(() =>
      measure('x', () => {
        throw boom
      })
    ).toThrow(boom)
    expect(info.mock.calls[0][0]).toMatch(/^x — \d+ms$/)
    expect(listener.mock.calls.at(-1)).toEqual(['x', 'after'])
  })
})

describe('measureAsync', () => {
  it('reports in while pending and after once settled', async () => {
    const d = deferred<string>()
    const p = measureAsync('a', () => d.promise)
    await Promise.resolve()
    expect(listener.mock.calls).toEqual([['a', 'in']])
    expect(info).not.toHaveBeenCalled()
    d.resolve('ok')
    expect(await p).toBe('ok')
    expect(listener.mock.calls).toEqual([
      ['a', 'in'],
      ['a', 'after']
    ])
    expect(info.mock.calls[0][0]).toMatch(/^a — \d+ms$/)
  })

  it('rejects with the same error and still reports after', async () => {
    const boom = new Error('boom')
    const d = deferred<string>()
    const p = measureAsync('a', () => d.promise)
    d.reject(boom)
    await expect(p).rejects.toBe(boom)
    expect(listener.mock.calls.at(-1)).toEqual(['a', 'after'])
    expect(info).toHaveBeenCalledTimes(1)
  })
})

describe('step', () => {
  it('a fast step reports in/after, returns the value and logs nothing', () => {
    const result = step('s', () => {
      expect(listener.mock.calls).toEqual([['s', 'in']])
      return 'v'
    })
    expect(result).toBe('v')
    expect(listener.mock.calls).toEqual([
      ['s', 'in'],
      ['s', 'after']
    ])
    expect(info).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it('a fast step that throws rethrows and still reports after', () => {
    const boom = new Error('boom')
    expect(() =>
      step('s', () => {
        throw boom
      })
    ).toThrow(boom)
    expect(listener.mock.calls.at(-1)).toEqual(['s', 'after'])
    expect(warn).not.toHaveBeenCalled()
  })

  it('a slow step (>= SLOW_STEP_MS) is logged as a warning with its offset', () => {
    t = 1000
    step('s', () => {
      t = 1000 + SLOW_STEP_MS
    })
    expect(warn.mock.calls).toEqual([['slow step: s — 200ms (at +1200ms)']])
    expect(info).not.toHaveBeenCalled()
  })

  it('just under SLOW_STEP_MS logs nothing', () => {
    t = 1000
    step('s', () => {
      t = 1000 + SLOW_STEP_MS - 0.1
    })
    expect(warn).not.toHaveBeenCalled()
    expect(info).not.toHaveBeenCalled()
  })

  it('a slow step that throws is still logged', () => {
    t = 1000
    expect(() =>
      step('s', () => {
        t = 1000 + SLOW_STEP_MS
        throw new Error('boom')
      })
    ).toThrow('boom')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls.at(-1)).toEqual(['s', 'after'])
  })
})

describe('onPerfStep', () => {
  it('a throwing listener never breaks the instrumented code', async () => {
    onPerfStep(() => {
      throw new Error('listener failed')
    })
    expect(() => mark('m')).not.toThrow()
    expect(measure('x', () => 1)).toBe(1)
    expect(await measureAsync('a', async () => 2)).toBe(2)
    expect(step('s', () => 3)).toBe(3)
  })

  it('has a single subscriber: a new one replaces the old, null stops all', () => {
    const second = vi.fn()
    onPerfStep(second)
    mark('m')
    expect(listener).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledWith('m', 'after')
    onPerfStep(null)
    mark('n')
    step('s', () => undefined)
    expect(second).toHaveBeenCalledTimes(1)
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('sinceLaunchMs', () => {
  it('is performance.now() (the process time origin)', () => {
    t = 987.6
    expect(sinceLaunchMs()).toBe(987.6)
  })
})
