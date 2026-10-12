/**
 * 迁移 v32 —— 分类器调用日志表 `classifier_logs`：每次调用分类模型一行（场景、对象摘要、题目与发送
 * 内容、答案、耗时、状态），与分类场景无关。只建表与两个索引，不搬数据、不碰别的表。
 *
 * 在**真的 SQLite** 上跑（node:sqlite 的内存库，同 migrationV31.test）：按顺序跑 v1 起的每一个 up()。
 *
 *   MV32-1  新库跑到 v32：恰十五列，类型 / NOT NULL / 默认值 / 主键逐一钉住
 *   MV32-2  表已在且有行时再跑一遍 v32（e2e 迁移用例会拨回 user_version 重跑）：不抛，行原样
 *   MV32-3  v32 只多出这一张表（与它的索引）：其余 schema 与会话行逐字不变
 *   MV32-4  约束：id 重复被拒；createdAt / scene / status 必填；只给必填列时其余取默认值；显式 NULL 被拒
 *   MV32-5  索引：createdAt 倒序一个、(scene, createdAt 倒序) 一个，外加主键自带的那一个
 *   MV32-6  迁移表里 v32 恰一条，版本号严格递增
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

import { migrations } from '../migrations'

type Db = Parameters<(typeof migrations)[number]['up']>[0]
type Row = Record<string, unknown>

afterEach(() => {
  vi.restoreAllMocks()
})

/** 按顺序跑迁移；`before[v]` 在跑第 v 版之前调 */
function migrate(db: DatabaseSync, before: Record<number, () => void> = {}, upTo = 32): void {
  for (const m of migrations) {
    if (m.version > upTo) break
    before[m.version]?.()
    m.up(db as unknown as Db)
  }
}

const v32 = (): (typeof migrations)[number] => migrations.find((m) => m.version === 32)!

function insertLog(db: DatabaseSync, row: Row): void {
  const keys = Object.keys(row)
  db.prepare(
    `INSERT INTO classifier_logs (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`
  ).run(...(Object.values(row) as Array<string | number | null>))
}

const logRows = (db: DatabaseSync): Row[] =>
  db.prepare('SELECT * FROM classifier_logs ORDER BY id').all() as Row[]

/** 一行完整的日志（各列都给值） */
function logRow(over: Row = {}): Row {
  return {
    id: '0199d3a2-7b3e-7c4d-9a1f-2e5b8c7d6f10',
    createdAt: 1_000,
    scene: 'command-risk',
    sessionId: 's1',
    toolCallId: 'tc-1',
    subject: 'ls -la',
    provider: 'openrouter',
    model: '~typesafe/jev-latest',
    request: '{"state":{"command":"ls -la"}}',
    response: '{"category":{"type":"choice"}}',
    status: 'ok',
    error: '',
    ms: 120,
    inputTokens: 42,
    cost: 0.0001,
    ...over
  }
}

describe('迁移 v32：classifier_logs', () => {
  it('MV32-1 新库跑到 v32：恰十五列，类型 / NOT NULL / 默认值 / 主键逐一钉住', () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)

    const cols = (db.prepare('PRAGMA table_info(classifier_logs)').all() as Row[]).map((c) => [
      c.name,
      c.type,
      c.notnull,
      c.dflt_value,
      c.pk
    ])
    expect(cols).toEqual([
      ['id', 'TEXT', 0, null, 1],
      ['createdAt', 'INTEGER', 1, null, 0],
      ['scene', 'TEXT', 1, null, 0],
      // SQLite 把默认值以 SQL 字面量回出来（带引号）
      ['sessionId', 'TEXT', 1, "''", 0],
      ['toolCallId', 'TEXT', 1, "''", 0],
      ['subject', 'TEXT', 1, "''", 0],
      ['provider', 'TEXT', 1, "''", 0],
      ['model', 'TEXT', 1, "''", 0],
      ['request', 'TEXT', 1, "''", 0],
      ['response', 'TEXT', 1, "''", 0],
      ['status', 'TEXT', 1, null, 0],
      ['error', 'TEXT', 1, "''", 0],
      ['ms', 'INTEGER', 1, '0', 0],
      ['inputTokens', 'INTEGER', 1, '0', 0],
      ['cost', 'REAL', 1, '0', 0]
    ])
  })

  it('MV32-2 表已在且有行时再跑一遍 v32：不抛，行原样', () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    insertLog(db, logRow())
    insertLog(db, logRow({ id: 'b', status: 'failed', error: 'error: 401', response: '' }))
    const before = logRows(db)

    expect(() => v32().up(db as unknown as Db)).not.toThrow()
    expect(logRows(db)).toEqual(before)
  })

  it('MV32-3 v32 只多出这一张表与它的索引：其余 schema 与会话行逐字不变', () => {
    const db = new DatabaseSync(':memory:')
    const schema = (): Row[] =>
      db
        .prepare(
          "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE tbl_name != 'classifier_logs' ORDER BY type, name"
        )
        .all() as Row[]
    const sessions = (): Row[] => db.prepare('SELECT * FROM sessions ORDER BY id').all() as Row[]

    let schemaBefore: Row[] = []
    let sessionsBefore: Row[] = []
    migrate(db, {
      32: () => {
        db.prepare(
          'INSERT INTO sessions (id, title, projectId, parentId, settings, createdAt, updatedAt, lastActiveAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).run('s1', 'title', null, null, '{"enabledTools":["mcp:ssh"]}', 1, 2, 3)
        schemaBefore = schema()
        sessionsBefore = sessions()
        expect(
          db.prepare("SELECT name FROM sqlite_master WHERE tbl_name = 'classifier_logs'").all()
        ).toEqual([])
      }
    })

    expect(schemaBefore.length).toBeGreaterThan(0)
    expect(schema()).toEqual(schemaBefore)
    expect(sessionsBefore).toHaveLength(1)
    expect(sessions()).toEqual(sessionsBefore)
    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'classifier_logs'")
        .all()
    ).toHaveLength(1)
  })

  it('MV32-4 约束：id 重复被拒；必填列（createdAt / scene / status）缺了被拒；只给必填列时其余取默认值；显式 NULL 被拒', () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)

    insertLog(db, logRow())
    expect(() => insertLog(db, logRow({ subject: 'other' }))).toThrow(/UNIQUE|PRIMARY/)

    for (const column of ['createdAt', 'scene', 'status']) {
      const { [column]: _omitted, ...rest } = logRow({ id: `missing-${column}` })
      expect(() => insertLog(db, rest), column).toThrow(/NOT NULL/)
    }

    insertLog(db, { id: 'minimal', createdAt: 5, scene: 'command-risk', status: 'misconfigured' })
    const minimal = db.prepare("SELECT * FROM classifier_logs WHERE id = 'minimal'").get() as Row
    expect(minimal).toEqual({
      id: 'minimal',
      createdAt: 5,
      scene: 'command-risk',
      sessionId: '',
      toolCallId: '',
      subject: '',
      provider: '',
      model: '',
      request: '',
      response: '',
      status: 'misconfigured',
      error: '',
      ms: 0,
      inputTokens: 0,
      cost: 0
    })

    for (const column of [
      'createdAt',
      'scene',
      'sessionId',
      'toolCallId',
      'subject',
      'provider',
      'model',
      'request',
      'response',
      'status',
      'error',
      'ms',
      'inputTokens',
      'cost'
    ]) {
      expect(() => insertLog(db, logRow({ id: `null-${column}`, [column]: null })), column).toThrow(
        /NOT NULL/
      )
    }
    expect(logRows(db).map((r) => r.id)).toEqual([
      '0199d3a2-7b3e-7c4d-9a1f-2e5b8c7d6f10',
      'minimal'
    ])
  })

  it('MV32-5 索引：createdAt 倒序、(scene, createdAt 倒序) 各一个，外加主键自带的那一个', () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    const indexes = (db.prepare('PRAGMA index_list(classifier_logs)').all() as Row[])
      .map((i) => [i.name, i.origin, i.unique])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    expect(indexes).toEqual([
      ['idx_classifier_logs_createdAt', 'c', 0],
      ['idx_classifier_logs_scene', 'c', 0],
      ['sqlite_autoindex_classifier_logs_1', 'pk', 1]
    ])
    const columnsOf = (name: string): Array<[unknown, unknown]> =>
      (db.prepare(`PRAGMA index_xinfo(${name})`).all() as Row[])
        .filter((c) => c.key === 1)
        .map((c) => [c.name, c.desc])
    expect(columnsOf('idx_classifier_logs_createdAt')).toEqual([['createdAt', 1]])
    expect(columnsOf('idx_classifier_logs_scene')).toEqual([
      ['scene', 0],
      ['createdAt', 1]
    ])
  })

  it('MV32-6 迁移表里 v32 恰一条，版本号严格递增', () => {
    expect(migrations.filter((m) => m.version === 32)).toHaveLength(1)
    for (let i = 1; i < migrations.length; i++) {
      expect(migrations[i].version, `#${i}`).toBeGreaterThan(migrations[i - 1].version)
    }
  })
})
