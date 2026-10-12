/**
 * ClassifierLogDao —— 分类器调用日志表 `classifier_logs` 的纯数据访问（迁移 v32）。
 *
 * 在**真的 SQLite** 上跑（node:sqlite 的内存库，同 mdAttrDao.test）：按顺序跑全部迁移建表，
 * BaseDao 换成直接在这个库上 prepare。
 *
 *   CLD-1  insert → getById 读回整行（十五列逐字）；没有这一行 → undefined
 *   CLD-2  list 不带 request、带会话标题（LEFT JOIN sessions：会话不在 / sessionId 为空 → ''）
 *   CLD-3  list 按 createdAt 倒序；同一毫秒按 id 倒序
 *   CLD-4  list 筛选：scene / sessionId / status 各自与组合；空串筛选当没给
 *   CLD-5  list 的 limit：缺省 200；给了就照给的截
 *   CLD-6  scenes：去重、按名字升序；空表 → []
 *   CLD-7  clear 删光；之后 list / scenes 都空
 *   CLD-8  prune(keep)：只留最新的 keep 条（同一毫秒按 id 倒序定先后，与 list 同一个顺序）
 *   CLD-9  prune 的边界：keep ≥ 行数 → 不动；keep = 0 → 删光；空表不抛
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'

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
import { classifierLogDao } from '../classifierLogDao'
import type { ClassifierLog } from '../types'

type Db = Parameters<(typeof migrations)[number]['up']>[0]
type Row = Record<string, unknown>

const db = (): DatabaseSync => holder.db as DatabaseSync

beforeEach(() => {
  const fresh = new DatabaseSync(':memory:')
  for (const m of migrations) m.up(fresh as unknown as Db)
  holder.db = fresh
})

/** 一行完整的日志 */
function log(over: Partial<ClassifierLog> = {}): ClassifierLog {
  return {
    id: '0199d3a2-0000-7000-8000-000000000001',
    createdAt: 1_000,
    scene: 'command-risk',
    sessionId: 's1',
    toolCallId: 'tc-1',
    subject: 'ls -la',
    provider: 'openrouter',
    model: '~typesafe/jev-latest',
    request: '{"state":{"command":"ls -la"},"questions":{}}',
    response: '{"category":{"type":"choice","choice":"read_only"}}',
    status: 'ok',
    error: '',
    ms: 120,
    inputTokens: 42,
    cost: 0.00012,
    ...over
  }
}

function insertSession(id: string, title: string): void {
  db()
    .prepare(
      'INSERT INTO sessions (id, title, projectId, parentId, settings, createdAt, updatedAt, lastActiveAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(id, title, null, null, '{}', 1, 2, 3)
}

const ids = (rows: Array<{ id: string }>): string[] => rows.map((r) => r.id)
const allIds = (): string[] =>
  (db().prepare('SELECT id FROM classifier_logs ORDER BY id').all() as Row[]).map((r) =>
    String(r.id)
  )

describe('ClassifierLogDao', () => {
  it('CLD-1 insert → getById 读回整行；没有这一行 → undefined', () => {
    const row = log()
    classifierLogDao.insert(row)
    expect(classifierLogDao.getById(row.id)).toEqual(row)
    expect(classifierLogDao.getById('nope')).toBeUndefined()
  })

  it("CLD-2 list 不带 request、带会话标题（会话不在 / sessionId 为空 → ''）", () => {
    insertSession('s1', 'My session')
    classifierLogDao.insert(log({ id: 'a', createdAt: 3, sessionId: 's1' }))
    classifierLogDao.insert(log({ id: 'b', createdAt: 2, sessionId: 'gone' }))
    classifierLogDao.insert(log({ id: 'c', createdAt: 1, sessionId: '' }))

    const rows = classifierLogDao.list()
    expect(ids(rows)).toEqual(['a', 'b', 'c'])
    for (const row of rows) expect(row).not.toHaveProperty('request')
    expect(rows.map((r) => r.sessionTitle)).toEqual(['My session', '', ''])

    const { request: _request, ...rest } = log({ id: 'a', createdAt: 3, sessionId: 's1' })
    expect(rows[0]).toEqual({ ...rest, sessionTitle: 'My session' })
  })

  it('CLD-3 list 按 createdAt 倒序，同一毫秒按 id 倒序', () => {
    classifierLogDao.insert(log({ id: '01-old', createdAt: 1 }))
    classifierLogDao.insert(log({ id: '02-tie-a', createdAt: 5 }))
    classifierLogDao.insert(log({ id: '03-newest', createdAt: 9 }))
    classifierLogDao.insert(log({ id: '04-tie-b', createdAt: 5 }))
    expect(ids(classifierLogDao.list())).toEqual(['03-newest', '04-tie-b', '02-tie-a', '01-old'])
  })

  it('CLD-4 list 筛选：scene / sessionId / status 各自与组合；空串当没给', () => {
    classifierLogDao.insert(log({ id: 'a', createdAt: 4, scene: 'command-risk', sessionId: 's1' }))
    classifierLogDao.insert(
      log({ id: 'b', createdAt: 3, scene: 'command-risk', sessionId: 's2', status: 'failed' })
    )
    classifierLogDao.insert(log({ id: 'c', createdAt: 2, scene: 'other', sessionId: 's1' }))
    classifierLogDao.insert(
      log({ id: 'd', createdAt: 1, scene: 'other', sessionId: 's2', status: 'failed' })
    )

    expect(ids(classifierLogDao.list({ scene: 'other' }))).toEqual(['c', 'd'])
    expect(ids(classifierLogDao.list({ sessionId: 's1' }))).toEqual(['a', 'c'])
    expect(ids(classifierLogDao.list({ status: 'failed' }))).toEqual(['b', 'd'])
    expect(ids(classifierLogDao.list({ scene: 'command-risk', status: 'failed' }))).toEqual(['b'])
    expect(
      ids(classifierLogDao.list({ scene: 'other', sessionId: 's2', status: 'failed' }))
    ).toEqual(['d'])
    expect(
      ids(classifierLogDao.list({ scene: 'other', sessionId: 's1', status: 'failed' }))
    ).toEqual([])
    expect(ids(classifierLogDao.list({ scene: '', sessionId: '', status: '' }))).toEqual([
      'a',
      'b',
      'c',
      'd'
    ])
  })

  it('CLD-5 list 的 limit：缺省 200；给了就照给的截（最新的那几条）', () => {
    const insertMany = db().prepare(
      `INSERT INTO classifier_logs (id, createdAt, scene, status) VALUES (?, ?, 'command-risk', 'ok')`
    )
    for (let i = 0; i < 205; i++) insertMany.run(`id-${String(i).padStart(3, '0')}`, i)
    expect(classifierLogDao.list()).toHaveLength(200)
    expect(classifierLogDao.list()[0].id).toBe('id-204')
    expect(ids(classifierLogDao.list({ limit: 3 }))).toEqual(['id-204', 'id-203', 'id-202'])
  })

  it('CLD-6 scenes：去重、按名字升序；空表 → []', () => {
    expect(classifierLogDao.scenes()).toEqual([])
    classifierLogDao.insert(log({ id: 'a', scene: 'zeta' }))
    classifierLogDao.insert(log({ id: 'b', scene: 'command-risk' }))
    classifierLogDao.insert(log({ id: 'c', scene: 'zeta' }))
    expect(classifierLogDao.scenes()).toEqual(['command-risk', 'zeta'])
  })

  it('CLD-7 clear 删光；之后 list / scenes 都空', () => {
    classifierLogDao.insert(log({ id: 'a' }))
    classifierLogDao.insert(log({ id: 'b', scene: 'other' }))
    classifierLogDao.clear()
    expect(allIds()).toEqual([])
    expect(classifierLogDao.list()).toEqual([])
    expect(classifierLogDao.scenes()).toEqual([])
  })

  it('CLD-8 prune(keep) 只留最新的 keep 条；同一毫秒按 id 倒序定先后（与 list 同一个顺序）', () => {
    classifierLogDao.insert(log({ id: '01', createdAt: 1 }))
    classifierLogDao.insert(log({ id: '02', createdAt: 5 }))
    classifierLogDao.insert(log({ id: '03', createdAt: 5 }))
    classifierLogDao.insert(log({ id: '04', createdAt: 9 }))
    classifierLogDao.insert(log({ id: '05', createdAt: 5 }))

    const expected = ids(classifierLogDao.list()).slice(0, 3)
    expect(expected).toEqual(['04', '05', '03'])
    classifierLogDao.prune(3)
    expect(ids(classifierLogDao.list())).toEqual(expected)
    expect(allIds()).toEqual(['03', '04', '05'])
  })

  it('CLD-9 prune 的边界：keep ≥ 行数不动；keep = 0 删光；空表不抛', () => {
    expect(() => classifierLogDao.prune(10)).not.toThrow()
    classifierLogDao.insert(log({ id: 'a', createdAt: 1 }))
    classifierLogDao.insert(log({ id: 'b', createdAt: 2 }))
    classifierLogDao.prune(2)
    expect(allIds()).toEqual(['a', 'b'])
    classifierLogDao.prune(5)
    expect(allIds()).toEqual(['a', 'b'])
    classifierLogDao.prune(0)
    expect(allIds()).toEqual([])
  })
})
