/**
 * P3-01-10 · 视图同步的线协议：服务 id、目标与帧的形状、目标守卫、键。
 */
import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  CHAT_VIEW_SERVICE_ID,
  isSyncTarget,
  reviveSyncInvokeError,
  syncInvokeError,
  syncInvokeFailure,
  syncTargetKey,
  type SyncFrame,
  type SyncTarget
} from './sync'

describe('P3-01-10 · sync.ts', () => {
  it('the service id, the target and frame shapes', () => {
    expect(CHAT_VIEW_SERVICE_ID).toBe('shuvix.chat.view')
    expectTypeOf<SyncTarget>().toEqualTypeOf<
      { kind: 'session'; sessionId: string } | { kind: 'agent'; agentId: string }
    >()
    expectTypeOf<SyncFrame['target']>().toEqualTypeOf<SyncTarget>()
    expectTypeOf<SyncFrame['subscriptionId']>().toEqualTypeOf<string>()
    expectTypeOf<keyof SyncFrame>().toEqualTypeOf<'target' | 'subscriptionId' | 'update'>()
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

  it('a full frame survives a JSON round trip deep-equal', () => {
    const frames: SyncFrame[] = [
      {
        target: { kind: 'session', sessionId: 's1' },
        subscriptionId: 'sub-1',
        update: { type: 'update', ops: [['a', [0, 'content'], 'xy']] }
      },
      { target: { kind: 'agent', agentId: 'a1' }, subscriptionId: 'sub-2', update: null }
    ]
    for (const frame of frames) expect(JSON.parse(JSON.stringify(frame))).toEqual(frame)
  })

  it('keys: a session and an agent with the same id never collide', () => {
    expect(syncTargetKey({ kind: 'session', sessionId: 'x' })).toBe('session:x')
    expect(syncTargetKey({ kind: 'agent', agentId: 'x' })).toBe('agent:x')
    expect(syncTargetKey({ kind: 'session', sessionId: 'x' })).not.toBe(
      syncTargetKey({ kind: 'agent', agentId: 'x' })
    )
  })
})

describe('sync invoke failures across contextBridge (P3-15)', () => {
  it('syncInvokeFailure is a plain object that survives a structured clone with its code', () => {
    const failure = syncInvokeFailure({ code: 'service_not_found', message: 'gone' })
    expect(failure).not.toBeInstanceOf(Error)
    expect(Object.getPrototypeOf(failure)).toBe(Object.prototype)
    expect(structuredClone(failure)).toEqual({ code: 'service_not_found', message: 'gone' })
    expect(syncInvokeFailure({ message: 'bare' })).toEqual({ message: 'bare' })
    // the reason for the plain object: a cloned Error keeps its message but drops `.code`
    const cloned = structuredClone(syncInvokeError({ code: 'service_not_found', message: 'gone' }))
    expect((cloned as { code?: string }).code).toBeUndefined()
  })

  it('reviveSyncInvokeError rebuilds the coded Error; Errors pass through; anything else wraps', () => {
    const revived = reviveSyncInvokeError({ code: 'service_not_found', message: 'gone' })
    expect(revived).toBeInstanceOf(Error)
    expect(revived.message).toBe('gone')
    expect(revived.code).toBe('service_not_found')

    const bare = reviveSyncInvokeError({ message: 'no code' })
    expect(bare).toBeInstanceOf(Error)
    expect(bare.code).toBeUndefined()

    const original = syncInvokeError({ code: 'unsupported', message: 'stub' })
    expect(reviveSyncInvokeError(original)).toBe(original)

    const odd = reviveSyncInvokeError('boom')
    expect(odd).toBeInstanceOf(Error)
    expect(odd.message).toBe('boom')
    expect(reviveSyncInvokeError({ code: 7 }).message).toBe('[object Object]')
  })
})
