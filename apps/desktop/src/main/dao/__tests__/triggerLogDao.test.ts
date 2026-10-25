/**
 * TriggerLogDao —— 触发日志表 `trigger_logs`（迁移 v35）的纯数据访问。
 *
 * 在**真的 SQLite** 上跑（node:sqlite 的内存库，同 classifierLogDao.test）：按顺序跑全部迁移建表，
 * BaseDao 换成直接在这个库上 prepare。
 *
 *   TLD-1  insert → list 读回整条（14 个字段逐字，event 解析回同一个对象；`when` 里的引号 / 非 ASCII 原样）
 *   TLD-2  list 按 createdAt 倒序、同一毫秒按 id 倒序；limit 照给的截
 *   TLD-3  updateOutcome 只改 outcome / error / updatedAt；不给 error 写 ''（清掉上一次的）；不认识的 id 不动任何行
 *   TLD-4  event 列写坏（非 JSON / 数组 / null / 标量）→ 读出 {}
 *   TLD-5  clear 删光
 *   TLD-6  prune(keep)：只留最新的 keep 条（与 list 同一个顺序）；keep ≥ 行数不动；keep = 0 删光；空表不抛
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import type { TriggerLogEntry } from '@shuvix/chat-protocol/triggerSources'

const holder = vi.hoisted(() => ({ db: null as unknown }))

vi.mock('../database', () => {
  class BaseDao {
    protected get db(): { prepare: (sql: string) => unknown } {
      return holder.db as { prepare: (sql: string) => unknown }
    }
    protected stmt(sql: string): unknown {
      return (holder.db as { prepare: (sql: string) => unknown }).prepare(sql)
    }
  }
  return { BaseDao, databaseManager: { getDb: () => holder.db } }
})
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

import { migrations } from '../migrations'
import { triggerLogDao } from '../triggerLogDao'

type Db = Parameters<(typeof migrations)[number]['up']>[0]

const db = (): DatabaseSync => holder.db as DatabaseSync

beforeEach(() => {
  const fresh = new DatabaseSync(':memory:')
  for (const m of migrations) m.up(fresh as unknown as Db)
  holder.db = fresh
})

/** 一条完整的日志 */
function entry(over: Partial<TriggerLogEntry> = {}): TriggerLogEntry {
  return {
    id: '019a1b2c-0000-7000-8000-000000000001',
    createdAt: 1_000,
    updatedAt: 1_000,
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

const ids = (rows: TriggerLogEntry[]): string[] => rows.map((r) => r.id)

describe('TriggerLogDao', () => {
  it('TLD-1 insert → list 读回整条：14 个字段逐字，event 是同一个对象，`when` 里的引号与非 ASCII 原样', () => {
    const e = entry({
      bindingIndex: 3,
      when: `event.local.time == '18:00' && "日报" != ''`,
      outcome: 'condition-error',
      sessionId: '',
      error: "found no matching overload for 'activeSession(dyn)'",
      botDisplayName: '日报助手'
    })
    triggerLogDao.insert(e)
    const rows = triggerLogDao.list(10)
    expect(rows).toStrictEqual([e])
    // 表里 event 是 JSON 文本
    expect(db().prepare('SELECT event FROM trigger_logs').get()).toEqual({
      event: JSON.stringify(e.event)
    })
  })

  it('TLD-2 list 按 createdAt 倒序、同一毫秒按 id 倒序；limit 照给的截', () => {
    triggerLogDao.insert(entry({ id: 'a', createdAt: 1 }))
    triggerLogDao.insert(entry({ id: 'b', createdAt: 3 }))
    triggerLogDao.insert(entry({ id: 'c', createdAt: 2 }))
    triggerLogDao.insert(entry({ id: 'd1', createdAt: 5 }))
    triggerLogDao.insert(entry({ id: 'd2', createdAt: 5 }))

    expect(ids(triggerLogDao.list(100))).toEqual(['d2', 'd1', 'b', 'c', 'a'])
    expect(ids(triggerLogDao.list(2))).toEqual(['d2', 'd1'])
    expect(ids(triggerLogDao.list(1))).toEqual(['d2'])
  })

  it("TLD-3 updateOutcome 只改 outcome / error / updatedAt；不给 error 写 ''；不认识的 id 不动任何行", () => {
    const started = entry({ id: 'run', createdAt: 100, updatedAt: 100 })
    const other = entry({ id: 'other', createdAt: 50, updatedAt: 50, sessionId: 's-0' })
    triggerLogDao.insert(started)
    triggerLogDao.insert(other)

    triggerLogDao.updateOutcome('run', {
      outcome: 'failed',
      error: 'model refused',
      updatedAt: 200
    })
    expect(triggerLogDao.list(10)).toStrictEqual([
      { ...started, outcome: 'failed', error: 'model refused', updatedAt: 200 },
      other
    ])

    // 不给 error：写成 ''（上一次的错误被清掉）
    triggerLogDao.updateOutcome('run', { outcome: 'completed', updatedAt: 300 })
    expect(triggerLogDao.list(10)).toStrictEqual([
      { ...started, outcome: 'completed', error: '', updatedAt: 300 },
      other
    ])

    const before = db().prepare('SELECT * FROM trigger_logs ORDER BY id').all()
    triggerLogDao.updateOutcome('missing', { outcome: 'failed', error: 'x', updatedAt: 400 })
    expect(db().prepare('SELECT * FROM trigger_logs ORDER BY id').all()).toEqual(before)
  })

  it('TLD-4 event 列写坏（非 JSON / 数组 / null / 字符串 / 数字）→ 读出 {}', () => {
    const corrupt = ['not json', '[1,2]', 'null', '"x"', '7']
    corrupt.forEach((text, i) => {
      db()
        .prepare(
          'INSERT INTO trigger_logs (id, createdAt, updatedAt, trigger, bot, outcome, event) VALUES (?, ?, ?, ?, ?, ?, ?)'
        )
        .run(`bad-${i}`, i, i, 'timer.fired', 'ticker', 'skipped', text)
    })
    const rows = triggerLogDao.list(10)
    expect(rows).toHaveLength(corrupt.length)
    for (const row of rows) expect(row.event, row.id).toStrictEqual({})
  })

  it('TLD-5 clear 删光', () => {
    for (const id of ['a', 'b', 'c']) triggerLogDao.insert(entry({ id }))
    expect(triggerLogDao.list(10)).toHaveLength(3)
    triggerLogDao.clear()
    expect(triggerLogDao.list(10)).toEqual([])
    expect(db().prepare('SELECT COUNT(*) AS n FROM trigger_logs').get()).toEqual({ n: 0 })
  })

  it('TLD-6 prune(keep)：只留最新的 keep 条（与 list 同一个顺序）；keep ≥ 行数不动；keep = 0 删光；空表不抛', () => {
    expect(() => triggerLogDao.prune(10)).not.toThrow()

    triggerLogDao.insert(entry({ id: 'a', createdAt: 1 }))
    triggerLogDao.insert(entry({ id: 'b', createdAt: 2 }))
    triggerLogDao.insert(entry({ id: 'c1', createdAt: 3 }))
    triggerLogDao.insert(entry({ id: 'c2', createdAt: 3 }))
    triggerLogDao.insert(entry({ id: 'd', createdAt: 4 }))

    triggerLogDao.prune(5)
    expect(ids(triggerLogDao.list(100))).toEqual(['d', 'c2', 'c1', 'b', 'a'])
    triggerLogDao.prune(50)
    expect(ids(triggerLogDao.list(100))).toEqual(['d', 'c2', 'c1', 'b', 'a'])

    // 同一毫秒按 id 倒序定先后：留 d、c2，c1 出局
    triggerLogDao.prune(2)
    expect(ids(triggerLogDao.list(100))).toEqual(['d', 'c2'])

    triggerLogDao.prune(0)
    expect(triggerLogDao.list(100)).toEqual([])
  })
})
