/**
 * 迁移 v30 —— `sessions` 增加 `storageKind` 列：已有会话一律标为 `harness-v3-jsonl`，之后建的会话
 * 不点名时也是它。存储换代时新会话用新类型、旧会话保留原类型 —— 永不迁移会话数据，这一列就是分流依据。
 *
 * 在**真的 SQLite** 上跑（node:sqlite 的内存库，同 migrationV29.test）：按顺序跑 v1 起的每一个 up()，
 * 已有会话在 v30 之前插进去，用的只有 v29 时的那几列。
 *
 *   MV30-1  新库跑到 v30：列形状 = TEXT NOT NULL，默认值是 v3 的那个字面量
 *   MV30-2  v30 之前已有的会话（含子会话、settings 有内容的）全部补成 v3，其余列逐字节不变
 *   MV30-3  v30 之后：不点名 → v3；点名 durable-sqlite-1 → 原样；显式 NULL → NOT NULL 拒绝
 *   MV30-4  user_version 被拨回去、v30 再跑一遍（e2e 迁移用例重跑 v27 / v28 时如此）：不抛错，已有的值不动
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

import { HARNESS_V3_JSONL } from '@shuvix/chat-protocol/sessionStorageKind'
import { migrations } from '../migrations'

type Db = Parameters<(typeof migrations)[number]['up']>[0]
type Row = Record<string, unknown>

afterEach(() => {
  vi.restoreAllMocks()
})

/** 按顺序跑迁移；`before[v]` 在跑第 v 版之前调（已有的行在那一刻已经在库里了） */
function migrate(db: DatabaseSync, before: Record<number, () => void> = {}, upTo = 30): void {
  for (const m of migrations) {
    if (m.version > upTo) break
    before[m.version]?.()
    m.up(db as unknown as Db)
  }
}

function insert(db: DatabaseSync, row: Row): void {
  const keys = Object.keys(row)
  db.prepare(
    `INSERT INTO sessions (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`
  ).run(...(Object.values(row) as Array<string | number | null>))
}

const allRows = (db: DatabaseSync): Row[] =>
  db.prepare('SELECT * FROM sessions ORDER BY id').all() as Row[]

/** v29 时的一行会话：只有那时就有的列 */
function v29Session(id: string, over: Row = {}): Row {
  return {
    id,
    title: `title ${id}`,
    projectId: null,
    parentId: null,
    settings: '{}',
    createdAt: 1_000,
    updatedAt: 2_000,
    lastActiveAt: 3_000,
    ...over
  }
}

describe('迁移 v30：sessions.storageKind', () => {
  it('MV30-1 新库跑到 v30：TEXT NOT NULL，默认值是 v3 的字面量', () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)

    const cols = db.prepare('PRAGMA table_info(sessions)').all() as Row[]
    const col = cols.find((c) => c.name === 'storageKind')
    expect(col).toMatchObject({ name: 'storageKind', type: 'TEXT', notnull: 1, pk: 0 })
    // SQLite 把默认值以 SQL 字面量的形式回出来（带引号）
    expect(col!.dflt_value).toBe(`'${HARNESS_V3_JSONL}'`)
  })

  it('MV30-2 已有会话全部补成 v3，其余列逐字节不变', () => {
    const db = new DatabaseSync(':memory:')
    let before: Row[] = []
    migrate(db, {
      30: () => {
        insert(db, v29Session('a', { projectId: 'p1' }))
        insert(db, v29Session('b', { parentId: 'a', projectId: 'p1', createdAt: 1_001 }))
        insert(
          db,
          v29Session('c', {
            // 有内容的 settings：迁移不碰它（对象、数组、中文、嵌套都原样）
            settings: JSON.stringify({
              enabledTools: ['mcp:ssh', 'skill:builtin:drawing'],
              chromeTab: { installId: 'i1', runId: 'r1', tabId: 5 },
              notebookPath: '笔记/a.md',
              coEdit: true
            })
          })
        )
        before = allRows(db)
      }
    })

    expect(before).toHaveLength(3)
    const after = allRows(db)
    expect(after.map((r) => r.storageKind)).toEqual([
      HARNESS_V3_JSONL,
      HARNESS_V3_JSONL,
      HARNESS_V3_JSONL
    ])
    // 其余每一列与迁移前一字不差（settings 是 TEXT，比的就是原文）
    expect(after.map(({ storageKind: _k, ...rest }) => rest)).toEqual(before)
  })

  it('MV30-3 v30 之后：不点名 → v3；点名 durable-sqlite-1 → 原样；显式 NULL → 拒绝', () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)

    insert(db, v29Session('implicit'))
    insert(db, { ...v29Session('durable'), storageKind: 'durable-sqlite-1' })
    expect(() => insert(db, { ...v29Session('nulled'), storageKind: null })).toThrow(/NOT NULL/)

    const kinds = Object.fromEntries(allRows(db).map((r) => [r.id, r.storageKind]))
    expect(kinds).toEqual({ implicit: HARNESS_V3_JSONL, durable: 'durable-sqlite-1' })
  })

  it('MV30-4 列已在时再跑一遍 v30：不抛错（不重复加列），已有会话的类型原样', () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    insert(db, { ...v29Session('d'), storageKind: 'durable-sqlite-1' })
    const v30 = migrations.find((m) => m.version === 30)!
    expect(() => v30.up(db as unknown as Db)).not.toThrow()
    expect(allRows(db).map((r) => r.storageKind)).toEqual(['durable-sqlite-1'])
  })
})
