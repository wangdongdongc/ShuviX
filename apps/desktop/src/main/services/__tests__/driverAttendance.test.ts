/**
 * 别的会话发进来的消息跟发送方那一轮的状态（docs/unattended-run-design.md §4）—— `withDriverAttendance`。
 *
 *   DA-1 没登记查询：原样交回（同一个对象），没有 unattended 键
 *   DA-2 发送方无人值守：新对象带 unattended:true，kind / sessionId / title 留着，入参不被改
 *   DA-3 发送方有人值守：原样交回；带进来的旧 unattended:true 被去掉（键不在，不是 false），入参不被改
 *   DA-4 查询抛错：按有人值守算，不抛
 *   DA-5 查询拿到的是发送方的会话 id
 *
 * 模块里的查询是进程级的：每条用例重置模块。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DrivingSessionRef } from '@shuvix/chat-protocol/types/inputRequest'

type Mod = typeof import('../driverAttendance')
let mod: Mod

beforeEach(async () => {
  vi.resetModules()
  mod = await import('../driverAttendance')
})

const PARENT: DrivingSessionRef = { kind: 'parent-session', sessionId: 'P1', title: 'Parent' }
const OTHER: DrivingSessionRef = { kind: 'session', sessionId: 'S9' }

describe('withDriverAttendance', () => {
  it('DA-1 没登记查询：同一个对象，没有 unattended 键', () => {
    const out = mod.withDriverAttendance(PARENT)
    expect(out).toBe(PARENT)
    expect(out).not.toHaveProperty('unattended')
  })

  it.each([PARENT, OTHER])(
    'DA-2 发送方无人值守：新对象带 unattended:true，其余原样（$kind）',
    (ref) => {
      mod.setDriverAttendanceLookup(() => true)
      const before = { ...ref }
      const out = mod.withDriverAttendance(ref)
      expect(out).not.toBe(ref)
      expect(out).toStrictEqual({ ...before, unattended: true })
      expect(ref).toStrictEqual(before)
    }
  )

  it('DA-3 发送方有人值守：没带标记的原样交回', () => {
    mod.setDriverAttendanceLookup(() => false)
    expect(mod.withDriverAttendance(PARENT)).toBe(PARENT)
  })

  it('DA-3 发送方有人值守：带进来的旧标记被去掉（键不在），入参不被改', () => {
    mod.setDriverAttendanceLookup(() => false)
    const stale: DrivingSessionRef = { ...PARENT, unattended: true }
    const out = mod.withDriverAttendance(stale)
    expect(out).toStrictEqual(PARENT)
    expect(out).not.toHaveProperty('unattended')
    expect(stale.unattended).toBe(true)

    const explicitFalse: DrivingSessionRef = { ...OTHER, unattended: false }
    expect(mod.withDriverAttendance(explicitFalse)).not.toHaveProperty('unattended')
  })

  it('DA-4 查询抛错：按有人值守算，不抛', () => {
    mod.setDriverAttendanceLookup(() => {
      throw new Error('host gone')
    })
    expect(mod.withDriverAttendance(PARENT)).toBe(PARENT)
    expect(mod.withDriverAttendance({ ...PARENT, unattended: true })).toStrictEqual(PARENT)
  })

  it('DA-5 查询拿到的是发送方的会话 id；后登记的查询顶替先前的', () => {
    const first = vi.fn(() => true)
    const lookup = vi.fn((id: string) => id === 'S9')
    mod.setDriverAttendanceLookup(first)
    mod.setDriverAttendanceLookup(lookup)
    expect(mod.withDriverAttendance(PARENT)).toBe(PARENT)
    expect(mod.withDriverAttendance(OTHER)).toStrictEqual({ ...OTHER, unattended: true })
    expect(lookup.mock.calls).toEqual([['P1'], ['S9']])
    expect(first).not.toHaveBeenCalled()
  })
})
