/**
 * P3-01-10 · 视图同步的线协议：目标的形状、目标守卫、键、not-found 码。
 */
import { describe, expect, expectTypeOf, it } from 'vitest'
import { isSyncTarget, SYNC_NOT_FOUND, syncTargetKey, type SyncTarget } from './sync'

describe('P3-01-10 · sync.ts', () => {
  it('the target shape and the not-found code', () => {
    expectTypeOf<SyncTarget>().toEqualTypeOf<
      { kind: 'session'; sessionId: string } | { kind: 'agent'; agentId: string }
    >()
    expect(SYNC_NOT_FOUND).toBe('not_found')
  })

  it('the target guard accepts the two kinds and rejects everything else', () => {
    expect(isSyncTarget({ kind: 'session', sessionId: 's1' })).toBe(true)
    expect(isSyncTarget({ kind: 'agent', agentId: 'a1' })).toBe(true)
    const rejected: unknown[] = [
      { kind: 'session' },
      { kind: 'agent' },
      { kind: 'session', agentId: 'a1' },
      { kind: 'agent', sessionId: 's1' },
      { kind: 'session', sessionId: '' },
      { kind: 'agent', agentId: '' },
      { kind: 'session', sessionId: 7 },
      { kind: 'monitor', sessionId: 's1' },
      'session:s1',
      42,
      undefined,
      null,
      [{ kind: 'session', sessionId: 's1' }],
      Object.assign([], { kind: 'session', sessionId: 's1' })
    ]
    for (const value of rejected) expect(isSyncTarget(value), JSON.stringify(value)).toBe(false)
  })

  it('keys: a session and an agent with the same id never collide', () => {
    expect(syncTargetKey({ kind: 'session', sessionId: 'x' })).toBe('session:x')
    expect(syncTargetKey({ kind: 'agent', agentId: 'x' })).toBe('agent:x')
    expect(syncTargetKey({ kind: 'session', sessionId: 'x' })).not.toBe(
      syncTargetKey({ kind: 'agent', agentId: 'x' })
    )
  })
})
