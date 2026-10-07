import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { info, warn, error, spawnSync } = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  spawnSync: vi.fn()
}))
// perf.ts → logger：不 mock 的话 electron-log 会写进真实的用户日志
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info, warn, error }),
  default: { transports: { file: { getFile: () => ({ path: '/x/logs/main.log' }) } } }
}))
vi.mock('node:child_process', () => ({ spawnSync }))

import { onPerfStep, type PerfStepPhase } from '../../../perf'
import { parseStallSpec, simulateStartupStall } from '../simulate'

describe('parseStallSpec', () => {
  it('parses <where>:<ms>[:native]', () => {
    expect(parseStallSpec('createWindow:3000')).toEqual({
      where: 'createWindow',
      ms: 3000,
      native: false
    })
    expect(parseStallSpec('preReady:1500:native')).toEqual({
      where: 'preReady',
      ms: 1500,
      native: true
    })
    expect(parseStallSpec('createWindow:60000')).toEqual({
      where: 'createWindow',
      ms: 60000,
      native: false
    })
  })

  it.each([
    undefined,
    '',
    'ready:3000',
    'createwindow:3000',
    'createWindow',
    'createWindow:',
    'createWindow:abc',
    'createWindow:0',
    'createWindow:-5',
    'createWindow:60001',
    'createWindow:Infinity',
    'createWindow:3000:busy',
    'createWindow:3000:',
    'createWindow:3000:native:extra'
  ])('rejects %j', (spec) => {
    expect(parseStallSpec(spec)).toBeNull()
  })
})

describe('simulateStartupStall', () => {
  const listener = vi.fn<(label: string, phase: PerfStepPhase) => void>()

  beforeEach(() => {
    listener.mockReset()
    spawnSync.mockReset()
    onPerfStep(listener)
  })
  afterEach(() => {
    onPerfStep(null)
    vi.unstubAllEnvs()
  })

  it('does nothing without the env var or for another site', () => {
    vi.stubEnv('SHUVIX_E2E_SIMULATE_STALL', undefined)
    simulateStartupStall('createWindow')
    simulateStartupStall('preReady')
    vi.stubEnv('SHUVIX_E2E_SIMULATE_STALL', 'preReady:30')
    simulateStartupStall('createWindow')
    expect(listener).not.toHaveBeenCalled()
    expect(spawnSync).not.toHaveBeenCalled()
  })

  it('busy-waits inside a Perf step at the matching site', () => {
    vi.stubEnv('SHUVIX_E2E_SIMULATE_STALL', 'createWindow:30')
    const t0 = performance.now()
    simulateStartupStall('createWindow')
    expect(performance.now() - t0).toBeGreaterThanOrEqual(30)
    expect(listener.mock.calls).toEqual([
      ['simulated stall (busy 30ms)', 'in'],
      ['simulated stall (busy 30ms)', 'after']
    ])
    expect(spawnSync).not.toHaveBeenCalled()
  })

  it('native mode runs a synchronous sleep between in and after', () => {
    vi.stubEnv('SHUVIX_E2E_SIMULATE_STALL', 'createWindow:30:native')
    simulateStartupStall('createWindow')
    expect(spawnSync).toHaveBeenCalledTimes(1)
    expect(spawnSync).toHaveBeenCalledWith('/bin/sleep', ['0.03'])
    expect(listener.mock.calls).toEqual([
      ['simulated stall (native 30ms)', 'in'],
      ['simulated stall (native 30ms)', 'after']
    ])
    const [inOrder, afterOrder] = listener.mock.invocationCallOrder
    const sleepOrder = spawnSync.mock.invocationCallOrder[0]
    expect(sleepOrder).toBeGreaterThan(inOrder)
    expect(sleepOrder).toBeLessThan(afterOrder)
  })
})
