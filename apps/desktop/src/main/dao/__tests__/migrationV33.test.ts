/**
 * 迁移 v33 —— 会话权限表 `session_acl`：建表与唯一索引，并把旧会话设置里的 allowList 搬成 user 行、删掉该键。
 *
 * 在**真的 SQLite** 上跑（node:sqlite 的内存库，同 migrationV32.test）：按顺序跑 v1 起的每一个 up()。
 *
 *   MV33-1  新库跑到 v33：恰十列，类型 / NOT NULL / 默认值 / 主键逐一钉住；唯一索引按 (会话, 种类, 来源, 来源键, 目标)
 *   MV33-2  搬 allowList：Read(...) → read、Write(...) → write，kind 'path'、source 'user'、sourceKey ''，
 *           时间取会话的 updatedAt；同一路径既 Read 又 Write 合成一行 write（顺序无关）；重复条目只一行
 *   MV33-3  不认的条目丢掉：历史 Bash(...) / SSH(...)、小写 read(...)、空括号、非字符串；键照样删掉
 *   MV33-4  allowList 键被删，设置里别的键原样；没有 allowList 的会话、坏 JSON 的会话一字不动
 *   MV33-5  再跑一遍 v33（user_version 被拨回）：不抛，表与会话行原样
 *   MV33-6  约束：唯一索引挡住同一 (会话, 种类, 来源, 来源键, 目标) 的第二行；来源键不同即可共存
 *   MV33-7  迁移表里 v33 恰一条，版本号严格递增
 */
import { describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

import { migrations } from '../migrations'

type Db = Parameters<(typeof migrations)[number]['up']>[0]
type Row = Record<string, unknown>

/** 按顺序跑迁移；`before[v]` 在跑第 v 版之前调 */
function migrate(db: DatabaseSync, before: Record<number, () => void> = {}, upTo = 33): void {
  for (const m of migrations) {
    if (m.version > upTo) break
    before[m.version]?.()
    m.up(db as unknown as Db)
  }
}

const v33 = (): (typeof migrations)[number] => migrations.find((m) => m.version === 33)!

function insertSession(db: DatabaseSync, id: string, settings: string, updatedAt = 20): void {
  db.prepare(
    'INSERT INTO sessions (id, title, projectId, parentId, settings, createdAt, updatedAt, lastActiveAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, 't', null, null, settings, 10, updatedAt, 30)
}

const aclRows = (db: DatabaseSync): Row[] =>
  db
    .prepare(
      'SELECT sessionId, kind, target, access, source, sourceKey, attrs, createdAt, updatedAt FROM session_acl ORDER BY sessionId, target'
    )
    .all() as Row[]

const settingsOf = (db: DatabaseSync, id: string): string =>
  (db.prepare('SELECT settings FROM sessions WHERE id = ?').get(id) as Row).settings as string

function userRow(sessionId: string, target: string, access: string, at = 20): Row {
  return {
    sessionId,
    kind: 'path',
    target,
    access,
    source: 'user',
    sourceKey: '',
    attrs: '{}',
    createdAt: at,
    updatedAt: at
  }
}

describe('迁移 v33：session_acl', () => {
  it('MV33-1 新库跑到 v33：恰十列；唯一索引按 (会话, 种类, 来源, 来源键, 目标)', () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)

    const cols = (db.prepare('PRAGMA table_info(session_acl)').all() as Row[]).map((c) => [
      c.name,
      c.type,
      c.notnull,
      c.dflt_value,
      c.pk
    ])
    expect(cols).toEqual([
      ['id', 'TEXT', 0, null, 1],
      ['sessionId', 'TEXT', 1, null, 0],
      ['kind', 'TEXT', 1, null, 0],
      ['target', 'TEXT', 1, null, 0],
      ['access', 'TEXT', 1, null, 0],
      ['source', 'TEXT', 1, null, 0],
      ['sourceKey', 'TEXT', 1, "''", 0],
      ['attrs', 'TEXT', 1, "'{}'", 0],
      ['createdAt', 'INTEGER', 1, null, 0],
      ['updatedAt', 'INTEGER', 1, null, 0]
    ])

    const indexes = db.prepare('PRAGMA index_list(session_acl)').all() as Row[]
    const unique = indexes.find((i) => i.name === 'idx_session_acl_entry')
    expect(unique?.unique).toBe(1)
    const columns = (db.prepare('PRAGMA index_info(idx_session_acl_entry)').all() as Row[]).map(
      (c) => c.name
    )
    expect(columns).toEqual(['sessionId', 'kind', 'source', 'sourceKey', 'target'])
  })

  it('MV33-2 搬 allowList：Read → read、Write → write；同一路径读写合成 write；重复条目只一行', () => {
    const db = new DatabaseSync(':memory:')
    migrate(db, {
      33: () => {
        insertSession(
          db,
          's1',
          JSON.stringify({
            allowList: ['Read(/a)', 'Write(/b)', 'Read(/c)', 'Write(/c)', 'Read(/a)']
          }),
          50
        )
        // 先 Write 后 Read：合成仍是 write
        insertSession(db, 's2', JSON.stringify({ allowList: ['Write(/d)', 'Read(/d)'] }), 60)
      }
    })

    expect(aclRows(db)).toEqual([
      userRow('s1', '/a', 'read', 50),
      userRow('s1', '/b', 'write', 50),
      userRow('s1', '/c', 'write', 50),
      userRow('s2', '/d', 'write', 60)
    ])
    // id 是不重样的 uuid
    const ids = (db.prepare('SELECT id FROM session_acl').all() as Row[]).map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('MV33-3 不认的条目丢掉，键照样删掉', () => {
    const db = new DatabaseSync(':memory:')
    migrate(db, {
      33: () => {
        insertSession(
          db,
          's1',
          JSON.stringify({
            allowList: [
              'Bash(npm run *)',
              'SSH(host:ls)',
              'read(/x)',
              'Read()',
              42,
              null,
              'Write(/ok)'
            ]
          })
        )
        insertSession(db, 's2', JSON.stringify({ allowList: ['Bash(git *)'] }))
        insertSession(db, 's3', JSON.stringify({ allowList: 'Read(/not-a-list)' }))
      }
    })

    expect(aclRows(db)).toEqual([userRow('s1', '/ok', 'write')])
    for (const id of ['s1', 's2', 's3']) {
      expect(JSON.parse(settingsOf(db, id))).not.toHaveProperty('allowList')
    }
  })

  it('MV33-4 allowList 键被删、别的键原样；没有 allowList 的、坏 JSON 的会话一字不动', () => {
    const db = new DatabaseSync(':memory:')
    const untouched = '{"enabledTools":["mcp:ssh"],"note":"allowList is mentioned here"}'
    migrate(db, {
      33: () => {
        insertSession(
          db,
          's1',
          JSON.stringify({ enabledTools: ['skill:x'], allowList: ['Read(/a)'], knowledgeBases: [] })
        )
        insertSession(db, 's2', untouched)
        insertSession(db, 's3', '{"allowList": [broken')
      }
    })

    expect(JSON.parse(settingsOf(db, 's1'))).toEqual({
      enabledTools: ['skill:x'],
      knowledgeBases: []
    })
    expect(settingsOf(db, 's2')).toBe(untouched)
    expect(settingsOf(db, 's3')).toBe('{"allowList": [broken')
    expect(aclRows(db)).toEqual([userRow('s1', '/a', 'read')])
  })

  it('MV33-5 再跑一遍 v33：不抛，表与会话行原样', () => {
    const db = new DatabaseSync(':memory:')
    migrate(db, {
      33: () => insertSession(db, 's1', JSON.stringify({ allowList: ['Write(/w)'] }))
    })
    const aclBefore = aclRows(db)
    const sessionsBefore = db.prepare('SELECT * FROM sessions').all()

    expect(() => v33().up(db as unknown as Db)).not.toThrow()
    expect(aclRows(db)).toEqual(aclBefore)
    expect(db.prepare('SELECT * FROM sessions').all()).toEqual(sessionsBefore)
  })

  it('MV33-6 唯一索引挡住同一 (会话, 种类, 来源, 来源键, 目标) 的第二行；来源键不同即可共存', () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    const insert = (id: string, source: string, sourceKey: string): void => {
      db.prepare(
        `INSERT INTO session_acl (id, sessionId, kind, target, access, source, sourceKey, createdAt, updatedAt)
         VALUES (?, 's1', 'path', '/p', 'read', ?, ?, 1, 1)`
      ).run(id, source, sourceKey)
    }
    insert('a', 'user', '')
    expect(() => insert('b', 'user', '')).toThrow(/UNIQUE/)
    insert('c', 'widget', 'w1')
    insert('d', 'widget', 'w2')
    insert('e', 'knowledge', 'notes')
    expect(db.prepare('SELECT COUNT(*) AS n FROM session_acl').get()).toEqual({ n: 4 })
  })

  it('MV33-7 迁移表里 v33 恰一条，版本号严格递增', () => {
    expect(migrations.filter((m) => m.version === 33)).toHaveLength(1)
    migrations.forEach((m, i) => expect(m.version).toBe(i + 1))
  })
})
