/**
 * triggerLogService —— 触发日志（trigger_logs，迁移 v35）：bot 触发分发每次命中 / 跳过 / 条件出错记一条，
 * 设置 → 触发源 一页列出。
 *
 * 服务 + 真的 DAO 跑在**真的 SQLite** 上（node:sqlite 内存库，全部迁移建表；BaseDao 换成直接在这个库上 prepare）。
 * appEventBus 与 logger 是桩。服务是模块单例、修剪计数在实例里 —— 每个用例 resetModules 后重新 import，
 * 拿一个全新的服务与 DAO（DB 出错的用例在那个 DAO 上 spyOn）。
 *
 *   TLS-1  record：交回 uuid v7；存下的一行 = 输入 + id + createdAt = updatedAt = 此刻；广播一次 trigger.logged
 *   TLS-2  finish：改 outcome / error / updatedAt（createdAt 不动）；completed 的 error 是 ''；每次广播一次
 *   TLS-3  finish(null, …)：不碰库、不广播、不抛
 *   TLS-4  list 新的在前；同一毫秒按 id 倒序（uuid v7 随生成先后递增 = 后记的在前）
 *   TLS-5  list 的条数：缺省 100；0 / 负数夹到 1；超过 1000 夹到 1000；list 不广播
 *   TLS-6  每记 50 条修剪一次、只留最新的 1000 条：第 1050 条之前表里 1049 条，之后 1000 条，留下的是最新的那些
 *   TLS-7  写失败的那几次不计入修剪的计数
 *   TLS-8  库出错不往外抛：insert 抛 → record 交回 null、一条告警、不广播；updateOutcome 抛 → finish 一条告警、
 *          不广播；prune 抛 → record 不抛、一条告警、那一行照样写进了表
 *   TLS-9  clear：删光、广播一次
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'

const h = vi.hoisted(() => ({
  db: null as unknown,
  publish: vi.fn(),
  warn: vi.fn()
}))

vi.mock('../../dao/database', () => {
  class BaseDao {
    protected get db(): { prepare: (sql: string) => unknown } {
      return h.db as { prepare: (sql: string) => unknown }
    }
    protected stmt(sql: string): unknown {
      return (h.db as { prepare: (sql: string) => unknown }).prepare(sql)
    }
  }
  return { BaseDao, databaseManager: { getDb: () => h.db } }
})
vi.mock('../../utils/appEventBus', () => ({ appEventBus: { publish: h.publish } }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: h.warn, error: vi.fn(), debug: vi.fn() })
}))

import { migrations } from '../../dao/migrations'
import type { TriggerLogInput } from '../triggerLogService'

type Db = Parameters<(typeof migrations)[number]['up']>[0]
type ServiceModule = typeof import('../triggerLogService')
type DaoModule = typeof import('../../dao/triggerLogDao')

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const T0 = Date.UTC(2026, 9, 24, 10, 0, 0)

let svcMod: ServiceModule
let service: ServiceModule['triggerLogService']
let dao: DaoModule['triggerLogDao']

const db = (): DatabaseSync => h.db as DatabaseSync
const rowCount = (): number =>
  (db().prepare('SELECT COUNT(*) AS n FROM trigger_logs').get() as { n: number }).n
const publishedTypes = (): unknown[] => h.publish.mock.calls.map((c) => c[0])

function input(over: Partial<TriggerLogInput> = {}): TriggerLogInput {
  return {
    sourceId: 'timer:builtin:minute',
    trigger: 'timer.fired',
    bot: 'ticker',
    botDisplayName: 'Ticker',
    botFile: 'ticker.md',
    bindingIndex: 0,
    when: '',
    outcome: 'started',
    sessionId: 's-1',
    error: '',
    event: {
      sourceId: 'timer:builtin:minute',
      firedAt: '2026-10-24T10:00:00.000Z',
      local: { date: '2026-10-24', time: '18:00', weekday: 6, hour: 18, minute: 0 },
      trigger: 'timer.fired'
    },
    ...over
  }
}

beforeEach(async () => {
  const fresh = new DatabaseSync(':memory:')
  for (const m of migrations) m.up(fresh as unknown as Db)
  h.db = fresh
  h.publish.mockReset()
  h.warn.mockReset()
  vi.resetModules()
  svcMod = await import('../triggerLogService')
  service = svcMod.triggerLogService
  dao = (await import('../../dao/triggerLogDao')).triggerLogDao
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('record / finish', () => {
  it('TLS-1 record：交回 uuid v7；存下的一行 = 输入 + id + createdAt = updatedAt = 此刻；广播一次 trigger.logged', () => {
    const data = input({ bindingIndex: 2, when: "event.local.time == '18:00'" })
    const id = service.record(data)
    expect(id).toMatch(UUID_V7)
    expect(dao.list(10)).toStrictEqual([{ ...data, id, createdAt: T0, updatedAt: T0 }])
    expect(publishedTypes()).toEqual([{ type: 'trigger.logged' }])
    expect(h.warn).not.toHaveBeenCalled()
  })

  it("TLS-2 finish：改 outcome / error / updatedAt（createdAt 不动）；completed 的 error 是 ''；每次广播一次", () => {
    const ok = service.record(input({ sessionId: 's-ok' }))!
    const bad = service.record(input({ sessionId: 's-bad' }))!
    h.publish.mockClear()

    vi.setSystemTime(T0 + 5_000)
    service.finish(ok, 'completed')
    vi.setSystemTime(T0 + 7_000)
    service.finish(bad, 'failed', 'model refused')

    const byId = new Map(dao.list(10).map((r) => [r.id, r]))
    expect(byId.get(ok)).toMatchObject({
      outcome: 'completed',
      error: '',
      createdAt: T0,
      updatedAt: T0 + 5_000,
      sessionId: 's-ok'
    })
    expect(byId.get(bad)).toMatchObject({
      outcome: 'failed',
      error: 'model refused',
      createdAt: T0,
      updatedAt: T0 + 7_000,
      sessionId: 's-bad'
    })
    expect(publishedTypes()).toEqual([{ type: 'trigger.logged' }, { type: 'trigger.logged' }])
  })

  it('TLS-3 finish(null, …)：不碰库、不广播、不抛', () => {
    service.record(input())
    h.publish.mockClear()
    const update = vi.spyOn(dao, 'updateOutcome')
    const before = db().prepare('SELECT * FROM trigger_logs').all()

    expect(() => service.finish(null, 'failed', 'whatever')).not.toThrow()
    expect(update).not.toHaveBeenCalled()
    expect(h.publish).not.toHaveBeenCalled()
    expect(db().prepare('SELECT * FROM trigger_logs').all()).toEqual(before)
  })
})

describe('list', () => {
  it('TLS-4 新的在前；同一毫秒按 id 倒序（后记的在前）', () => {
    const early = service.record(input({ bot: 'early' }))!
    vi.setSystemTime(T0 + 60_000)
    const sameMs = [
      service.record(input({ bot: 'x' }))!,
      service.record(input({ bot: 'y' }))!,
      service.record(input({ bot: 'z' }))!
    ]
    expect([...sameMs].sort()).toEqual(sameMs)
    expect(service.list().map((r) => r.id)).toEqual([...sameMs].reverse().concat(early))
    expect(service.list().map((r) => r.createdAt)).toEqual([
      T0 + 60_000,
      T0 + 60_000,
      T0 + 60_000,
      T0
    ])
  })

  it('TLS-5 条数：缺省 100；0 / 负数夹到 1；超过 1000 夹到 1000；list 不广播', () => {
    expect(svcMod.LIST_LIMIT).toBe(100)
    expect(svcMod.MAX_ROWS).toBe(1000)
    // 直接经 DAO 写 1005 条（绕开服务的修剪）：createdAt = 序号，最新的是 1004
    for (let i = 0; i < 1005; i++) {
      dao.insert({ ...input(), id: `r-${String(i).padStart(4, '0')}`, createdAt: i, updatedAt: i })
    }
    const listed = service.list()
    expect(listed).toHaveLength(100)
    expect(listed[0].id).toBe('r-1004')
    expect(listed[99].id).toBe('r-0905')
    expect(service.list(1).map((r) => r.id)).toEqual(['r-1004'])
    expect(service.list(0).map((r) => r.id)).toEqual(['r-1004'])
    expect(service.list(-3).map((r) => r.id)).toEqual(['r-1004'])
    expect(service.list(1000)).toHaveLength(1000)
    const capped = service.list(5000)
    expect(capped).toHaveLength(1000)
    expect(capped.at(-1)!.id).toBe('r-0005')
    expect(h.publish).not.toHaveBeenCalled()
  })
})

describe('修剪', () => {
  it('TLS-6 每记 50 条修剪一次、只留最新的 1000 条', () => {
    const prune = vi.spyOn(dao, 'prune')
    const recorded: string[] = []
    const recordOne = (i: number): void => {
      vi.setSystemTime(T0 + i)
      recorded.push(service.record(input({ sessionId: `s-${i}` }))!)
    }
    for (let i = 1; i <= 49; i++) recordOne(i)
    expect(prune).not.toHaveBeenCalled()
    recordOne(50)
    expect(prune.mock.calls).toEqual([[1000]])

    for (let i = 51; i <= 1049; i++) recordOne(i)
    // 第 50、100 … 1000 条各修剪一次（20 次），表里还不到上限时什么都不删
    expect(prune).toHaveBeenCalledTimes(20)
    expect(rowCount()).toBe(1049)

    recordOne(1050)
    expect(prune).toHaveBeenCalledTimes(21)
    for (const call of prune.mock.calls) expect(call).toEqual([1000])
    expect(rowCount()).toBe(1000)
    // 留下的是最新的 1000 条（第 51 … 1050 条），最早的 50 条出局
    const kept = new Set(
      (db().prepare('SELECT id FROM trigger_logs').all() as Array<{ id: string }>).map((r) => r.id)
    )
    expect(recorded.slice(50).every((id) => kept.has(id))).toBe(true)
    expect(recorded.slice(0, 50).some((id) => kept.has(id))).toBe(false)
    expect(service.list(1)[0].sessionId).toBe('s-1050')
  })

  it('TLS-7 写失败的那几次不计入修剪的计数', () => {
    const prune = vi.spyOn(dao, 'prune')
    for (let i = 0; i < 49; i++) service.record(input())
    const insert = vi.spyOn(dao, 'insert').mockImplementation(() => {
      throw new Error('SQLITE_BUSY')
    })
    for (let i = 0; i < 10; i++) expect(service.record(input())).toBeNull()
    expect(prune).not.toHaveBeenCalled()

    insert.mockRestore()
    expect(service.record(input())).toMatch(UUID_V7)
    expect(prune.mock.calls).toEqual([[1000]])
    expect(rowCount()).toBe(50)
  })
})

describe('库出错不往外抛', () => {
  it('TLS-8 insert / updateOutcome / prune 抛错：不抛、各一条告警；insert 与 updateOutcome 失败不广播', () => {
    // insert 抛（Error 与非 Error）
    const insert = vi.spyOn(dao, 'insert').mockImplementationOnce(() => {
      throw new Error('SQLITE_FULL: database or disk is full')
    })
    let id: string | null = 'unset'
    expect(() => (id = service.record(input()))).not.toThrow()
    expect(id).toBeNull()
    insert.mockImplementationOnce(() => {
      throw 'disk I/O error'
    })
    expect(service.record(input())).toBeNull()
    expect(h.warn).toHaveBeenCalledTimes(2)
    expect(String(h.warn.mock.calls[0][0])).toContain('SQLITE_FULL: database or disk is full')
    expect(String(h.warn.mock.calls[1][0])).toContain('disk I/O error')
    expect(h.publish).not.toHaveBeenCalled()
    expect(rowCount()).toBe(0)

    // updateOutcome 抛
    const ok = service.record(input())!
    h.publish.mockClear()
    h.warn.mockClear()
    vi.spyOn(dao, 'updateOutcome').mockImplementationOnce(() => {
      throw new Error('SQLITE_READONLY')
    })
    expect(() => service.finish(ok, 'completed')).not.toThrow()
    expect(h.warn).toHaveBeenCalledTimes(1)
    expect(String(h.warn.mock.calls[0][0])).toContain('SQLITE_READONLY')
    expect(h.publish).not.toHaveBeenCalled()
    expect(dao.list(1)[0]).toMatchObject({ id: ok, outcome: 'started' })

    // prune 抛（第 50 条成功写入的那一次）：record 不抛、一条告警，那一行照样在表里
    h.warn.mockClear()
    vi.spyOn(dao, 'prune').mockImplementationOnce(() => {
      throw new Error('SQLITE_LOCKED')
    })
    for (let i = 0; i < 48; i++) service.record(input())
    expect(rowCount()).toBe(49)
    expect(() => service.record(input({ sessionId: 's-50th' }))).not.toThrow()
    expect(h.warn).toHaveBeenCalledTimes(1)
    expect(String(h.warn.mock.calls[0][0])).toContain('SQLITE_LOCKED')
    expect(rowCount()).toBe(50)
    expect(dao.list(100).some((r) => r.sessionId === 's-50th')).toBe(true)
  })
})

describe('clear', () => {
  it('TLS-9 删光、广播一次', () => {
    for (let i = 0; i < 3; i++) service.record(input())
    h.publish.mockClear()
    service.clear()
    expect(rowCount()).toBe(0)
    expect(service.list()).toEqual([])
    expect(publishedTypes()).toEqual([{ type: 'trigger.logged' }])
  })
})
