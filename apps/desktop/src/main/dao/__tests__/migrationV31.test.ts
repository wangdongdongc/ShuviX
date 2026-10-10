/**
 * 迁移 v31 —— md 扩展元数据表 `md_attrs`（设计 docs/md-metadata-design.md）：挂在 agent / bot / hook /
 * policy 文件 frontmatter 的 `shuvix-id` 上，一个顶层键一行。只建表，不搬任何数据、不碰别的表。
 *
 * 在**真的 SQLite** 上跑（node:sqlite 的内存库，同 migrationV30.test）：按顺序跑 v1 起的每一个 up()。
 *
 *   MV31-1  新库跑到 v31：恰六列，类型 / NOT NULL / 默认值 / 主键序（objectId, scope, ns, key）逐一钉住
 *   MV31-2  表已在且有行时再跑一遍 v31（e2e 迁移用例会拨回 user_version 重跑）：不抛，行原样
 *   MV31-3  v31 只多出这一张表：其余 schema 与会话行逐字不变
 *   MV31-4  主键与约束：同键重复插入被拒；scope 或 ns 不同就是两行；不写 scope = ''；任一列显式 NULL 被拒
 *   MV31-5  索引只有主键自带的那一个
 *   MV31-6  迁移表里 v31 恰一条，版本号严格递增
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
function migrate(db: DatabaseSync, before: Record<number, () => void> = {}, upTo = 31): void {
  for (const m of migrations) {
    if (m.version > upTo) break
    before[m.version]?.()
    m.up(db as unknown as Db)
  }
}

const v31 = (): (typeof migrations)[number] => migrations.find((m) => m.version === 31)!

function insertAttr(db: DatabaseSync, row: Row): void {
  const keys = Object.keys(row)
  db.prepare(
    `INSERT INTO md_attrs (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`
  ).run(...(Object.values(row) as Array<string | number | null>))
}

const attrRows = (db: DatabaseSync): Row[] =>
  db.prepare('SELECT * FROM md_attrs ORDER BY objectId, scope, ns, key').all() as Row[]

/** 一行完整的元数据（各列都给值） */
function attr(over: Row = {}): Row {
  return {
    objectId: '0199d3a2-7b3e-7c4d-9a1f-2e5b8c7d6f10',
    scope: '',
    ns: 'fm',
    key: 'shuvix-model',
    value: '"openai/gpt-5"',
    updatedAt: 1_000,
    ...over
  }
}

describe('迁移 v31：md_attrs', () => {
  it('MV31-1 新库跑到 v31：恰六列，类型 / NOT NULL / 默认值 / 主键序逐一钉住', () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)

    const cols = (db.prepare('PRAGMA table_info(md_attrs)').all() as Row[]).map((c) => [
      c.name,
      c.type,
      c.notnull,
      c.dflt_value,
      c.pk
    ])
    expect(cols).toEqual([
      ['objectId', 'TEXT', 1, null, 1],
      // SQLite 把默认值以 SQL 字面量回出来（带引号）
      ['scope', 'TEXT', 1, "''", 2],
      ['ns', 'TEXT', 1, null, 3],
      ['key', 'TEXT', 1, null, 4],
      ['value', 'TEXT', 1, null, 0],
      ['updatedAt', 'INTEGER', 1, null, 0]
    ])
  })

  it('MV31-2 表已在且有行时再跑一遍 v31：不抛，行原样', () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    insertAttr(db, attr())
    insertAttr(db, attr({ ns: 'meta', key: 'enabled', value: 'false', updatedAt: 2_000 }))
    const before = attrRows(db)

    expect(() => v31().up(db as unknown as Db)).not.toThrow()
    expect(attrRows(db)).toEqual(before)
  })

  it('MV31-3 v31 只多出这一张表：其余 schema 与会话行逐字不变', () => {
    const db = new DatabaseSync(':memory:')
    const schema = (): Row[] =>
      db
        .prepare(
          "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE tbl_name != 'md_attrs' ORDER BY type, name"
        )
        .all() as Row[]
    const sessions = (): Row[] => db.prepare('SELECT * FROM sessions ORDER BY id').all() as Row[]

    let schemaBefore: Row[] = []
    let sessionsBefore: Row[] = []
    migrate(db, {
      31: () => {
        db.prepare(
          'INSERT INTO sessions (id, title, projectId, parentId, settings, createdAt, updatedAt, lastActiveAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).run('s1', 'title', null, null, '{"enabledTools":["mcp:ssh"]}', 1, 2, 3)
        schemaBefore = schema()
        sessionsBefore = sessions()
        expect(
          db.prepare("SELECT name FROM sqlite_master WHERE tbl_name = 'md_attrs'").all()
        ).toEqual([])
      }
    })

    expect(schemaBefore.length).toBeGreaterThan(0)
    expect(schema()).toEqual(schemaBefore)
    expect(sessionsBefore).toHaveLength(1)
    expect(sessions()).toEqual(sessionsBefore)
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'md_attrs'").all()
    ).toHaveLength(1)
  })

  it('MV31-4 主键与约束：同键重复被拒；scope / ns 不同是两行；不写 scope = ""；任一列显式 NULL 被拒', () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)

    insertAttr(db, attr())
    expect(() => insertAttr(db, attr({ value: '"other"', updatedAt: 9 }))).toThrow(/UNIQUE|PRIMARY/)

    insertAttr(db, attr({ scope: 'project:p1' }))
    insertAttr(db, attr({ ns: 'meta' }))
    // 不写 scope：默认值 ''（与第一行撞主键 —— 换个 key 才插得进去）
    const { scope: _scope, ...noScope } = attr({ key: 'shuvix-thinking', value: '"low"' })
    insertAttr(db, noScope)

    const rows = attrRows(db).map((r) => [r.scope, r.ns, r.key, r.value])
    expect(rows).toEqual([
      ['', 'fm', 'shuvix-model', '"openai/gpt-5"'],
      ['', 'fm', 'shuvix-thinking', '"low"'],
      ['', 'meta', 'shuvix-model', '"openai/gpt-5"'],
      ['project:p1', 'fm', 'shuvix-model', '"openai/gpt-5"']
    ])

    for (const column of ['objectId', 'scope', 'ns', 'key', 'value', 'updatedAt']) {
      expect(() => insertAttr(db, attr({ key: `null-${column}`, [column]: null })), column).toThrow(
        /NOT NULL/
      )
    }
    expect(attrRows(db)).toHaveLength(4)
  })

  it('MV31-5 索引只有主键自带的那一个', () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    const indexes = (db.prepare('PRAGMA index_list(md_attrs)').all() as Row[]).map((i) => [
      i.origin,
      i.unique
    ])
    expect(indexes).toEqual([['pk', 1]])
  })

  it('MV31-6 迁移表里 v31 恰一条，版本号严格递增', () => {
    expect(migrations.filter((m) => m.version === 31)).toHaveLength(1)
    for (let i = 1; i < migrations.length; i++) {
      expect(migrations[i].version, `#${i}`).toBeGreaterThan(migrations[i - 1].version)
    }
  })
})
