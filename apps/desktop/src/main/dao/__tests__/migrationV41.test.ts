/**
 * 迁移 v41 —— 文件库的元数据表（docs/file-library-design.md §3）：文件、版本、分类、标签与标签组、字段、关联，
 * 外加 deletedAt / sha256 / (targetType, targetId) 三个索引。
 *
 * 在**真的 SQLite** 上跑（node:sqlite 的内存库，同 migrationV39.test）：先跑到 v40，再跑 v41。MIG41-3 的后半走真的
 * runMigrations（better-sqlite3 的 pragma / transaction 由一层薄壳给出，同 migrationV37.test）。
 *
 *   MIG41-1  表结构与设计稿 §3 一致：11 张表、列集合、主键、library_tags 的 UNIQUE(groupId, name)、三个索引覆盖的列
 *   MIG41-2  默认值：只给必填列插一行 item → storage managed、currentVersion 1、kind other、source import、deletedAt NULL；
 *            link 不写 origin → derived
 *   MIG41-3  重跑 v41（user_version 拨回 40）：不抛、行原样；真的 runMigrations 把 v40 库推到最新，已有表的行原样
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

import { migrations, runMigrations } from '../migrations'

type Db = Parameters<(typeof migrations)[number]['up']>[0]
type Row = Record<string, unknown>

afterEach(() => {
  vi.restoreAllMocks()
})

/** 跑到 v40 的库 */
function at40(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  for (const m of migrations) {
    if (m.version > 40) break
    m.up(db as unknown as Db)
  }
  return db
}

const v41 = (): (typeof migrations)[number] => migrations.find((m) => m.version === 41)!

function at41(): DatabaseSync {
  const db = at40()
  v41().up(db as unknown as Db)
  return db
}

function insert(db: DatabaseSync, table: string, row: Row): void {
  const keys = Object.keys(row)
  db.prepare(
    `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`
  ).run(...(Object.values(row) as Array<string | number | null>))
}

interface ColumnInfo {
  name: string
  pk: number
}

const columnsOf = (db: DatabaseSync, table: string): ColumnInfo[] =>
  db.prepare(`PRAGMA table_info(${table})`).all() as unknown as ColumnInfo[]

const columnSet = (db: DatabaseSync, table: string): string[] =>
  columnsOf(db, table)
    .map((c) => c.name)
    .sort()

/** 主键列（按 pk 序号） */
const primaryKeyOf = (db: DatabaseSync, table: string): string[] =>
  columnsOf(db, table)
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name)

interface IndexListRow {
  name: string
  unique: number
  origin: string
}

const indexesOf = (db: DatabaseSync, table: string): IndexListRow[] =>
  db.prepare(`PRAGMA index_list(${table})`).all() as unknown as IndexListRow[]

const indexColumns = (db: DatabaseSync, index: string): string[] =>
  (
    db.prepare(`PRAGMA index_info(${index})`).all() as unknown as Array<{
      seqno: number
      name: string
    }>
  )
    .sort((a, b) => a.seqno - b.seqno)
    .map((r) => r.name)

const allOf = (db: DatabaseSync, table: string): Row[] =>
  db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Row[]

const userVersion = (db: DatabaseSync): number =>
  (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version

/** 设计稿 §3 的列（逐表） */
const SCHEMA: Record<string, string[]> = {
  library_items: [
    'id',
    'name',
    'storage',
    'externalPath',
    'currentVersion',
    'kind',
    'source',
    'description',
    'createdAt',
    'updatedAt',
    'deletedAt'
  ],
  library_versions: [
    'itemId',
    'version',
    'sha256',
    'size',
    'mime',
    'fileName',
    'width',
    'height',
    'durationMs',
    'createdAt'
  ],
  library_categories: ['id', 'parentId', 'name', 'sort', 'createdAt'],
  library_item_categories: ['itemId', 'categoryId'],
  library_tag_groups: ['id', 'name', 'color', 'exclusive', 'sort'],
  library_tags: ['id', 'groupId', 'name', 'color', 'sort'],
  library_item_tags: ['itemId', 'tagId'],
  library_fields: ['id', 'name', 'type', 'options', 'sort'],
  library_item_fields: ['itemId', 'fieldId', 'value'],
  library_links: ['itemId', 'targetType', 'targetId', 'relation', 'origin', 'context', 'createdAt']
}

const PRIMARY_KEYS: Record<string, string[]> = {
  library_items: ['id'],
  library_versions: ['itemId', 'version'],
  library_categories: ['id'],
  library_item_categories: ['itemId', 'categoryId'],
  library_tag_groups: ['id'],
  library_tags: ['id'],
  library_item_tags: ['itemId', 'tagId'],
  library_fields: ['id'],
  library_item_fields: ['itemId', 'fieldId'],
  library_links: ['itemId', 'targetType', 'targetId', 'relation']
}

describe('迁移 v41：文件库的表', () => {
  it('MIG41-1 表结构与设计稿 §3 一致：表、列集合、主键、UNIQUE(groupId, name)、三个索引', () => {
    const db = at40()
    const before = new Set(
      (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
          name: string
        }>
      ).map((r) => r.name)
    )
    v41().up(db as unknown as Db)

    const created = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as Array<{
        name: string
      }>
    )
      .map((r) => r.name)
      .filter((name) => !before.has(name))
    // §3 列出的是 10 张表（测试设计写的「11 张」是数错了：items、versions、categories、item_categories、tag_groups、
    // tags、item_tags、fields、item_fields、links），v41 恰好建这些、不多不少
    expect(created.every((name) => name.startsWith('library_'))).toBe(true)
    expect(created.sort()).toEqual(Object.keys(SCHEMA).sort())
    expect(created).toHaveLength(10)

    for (const [table, columns] of Object.entries(SCHEMA)) {
      expect(columnSet(db, table), table).toEqual([...columns].sort())
    }
    for (const [table, pk] of Object.entries(PRIMARY_KEYS)) {
      expect(primaryKeyOf(db, table), table).toEqual(pk)
    }

    // library_tags 的 UNIQUE(groupId, name)：一条 origin 'u' 的唯一索引，恰好覆盖这两列
    const uniques = indexesOf(db, 'library_tags').filter((i) => i.unique === 1 && i.origin === 'u')
    expect(uniques).toHaveLength(1)
    expect(indexColumns(db, uniques[0].name)).toEqual(['groupId', 'name'])
    // 约束是真的在起作用
    insert(db, 'library_tags', { id: 't1', groupId: 'g', name: 'red' })
    expect(() => insert(db, 'library_tags', { id: 't2', groupId: 'g', name: 'red' })).toThrow(
      /UNIQUE/
    )
    insert(db, 'library_tags', { id: 't3', groupId: 'g2', name: 'red' })

    // 三个索引：deletedAt、sha256、(targetType, targetId)
    const createdIndexes = (table: string): string[] =>
      indexesOf(db, table)
        .filter((i) => i.origin === 'c')
        .map((i) => i.name)
    expect(createdIndexes('library_items').map((n) => indexColumns(db, n))).toEqual([['deletedAt']])
    expect(createdIndexes('library_versions').map((n) => indexColumns(db, n))).toEqual([['sha256']])
    expect(createdIndexes('library_links').map((n) => indexColumns(db, n))).toEqual([
      ['targetType', 'targetId']
    ])
  })

  it('MIG41-2 默认值：item 只给 id/name/createdAt/updatedAt；link 不写 origin', () => {
    const db = at41()
    insert(db, 'library_items', { id: 'i1', name: 'a.png', createdAt: 10, updatedAt: 10 })
    insert(db, 'library_links', {
      itemId: 'i1',
      targetType: 'note',
      targetId: '/n.md',
      relation: 'embedded',
      createdAt: 10
    })

    const item = db.prepare("SELECT * FROM library_items WHERE id = 'i1'").get() as Row
    expect(item).toMatchObject({
      storage: 'managed',
      currentVersion: 1,
      kind: 'other',
      source: 'import',
      deletedAt: null,
      externalPath: null,
      description: null
    })
    const link = db.prepare("SELECT * FROM library_links WHERE itemId = 'i1'").get() as Row
    expect(link.origin).toBe('derived')
    expect(link.context).toBeNull()
  })

  it('MIG41-3 重跑 v41（user_version 拨回 40）：不抛，已有的行原样', () => {
    const db = at41()
    insert(db, 'library_items', { id: 'i1', name: 'a.png', createdAt: 10, updatedAt: 10 })
    insert(db, 'library_versions', {
      itemId: 'i1',
      version: 1,
      sha256: 'abc',
      size: 3,
      mime: 'image/png',
      fileName: 'a.png',
      createdAt: 10
    })
    insert(db, 'library_links', {
      itemId: 'i1',
      targetType: 'session',
      targetId: 's1',
      relation: 'sent',
      context: '{"entryId":7}',
      createdAt: 10
    })
    insert(db, 'library_tags', { id: 't1', groupId: 'g', name: 'red' })
    const snapshot = Object.fromEntries(Object.keys(SCHEMA).map((t) => [t, allOf(db, t)]))
    db.exec('PRAGMA user_version = 40')

    expect(() => v41().up(db as unknown as Db)).not.toThrow()

    for (const table of Object.keys(SCHEMA)) {
      expect(allOf(db, table), table).toEqual(snapshot[table])
    }
  })

  it('MIG41-3 真的 runMigrations：v40 库 → 最新；已有表的行原样', () => {
    /** runMigrations 用到的 better-sqlite3 面（同 migrationV37.test） */
    function betterSqliteShim(raw: DatabaseSync): Parameters<typeof runMigrations>[0] {
      return {
        prepare: (sql: string) => raw.prepare(sql),
        exec: (sql: string) => raw.exec(sql),
        pragma: (source: string, opts?: { simple?: boolean }) => {
          if (source.includes('=')) {
            raw.exec(`PRAGMA ${source}`)
            return []
          }
          const row = raw.prepare(`PRAGMA ${source}`).get() as Row
          return opts?.simple ? Object.values(row)[0] : [row]
        },
        transaction: (fn: () => void) => () => {
          raw.exec('BEGIN')
          try {
            fn()
            raw.exec('COMMIT')
          } catch (err) {
            raw.exec('ROLLBACK')
            throw err
          }
        }
      } as unknown as Parameters<typeof runMigrations>[0]
    }

    const db = at40()
    db.exec('PRAGMA user_version = 40')
    insert(db, 'session_unread', { sessionId: 's1', since: 5, anchorAt: 6, failed: 1, manual: 0 })
    const unreadBefore = allOf(db, 'session_unread')

    expect(runMigrations(betterSqliteShim(db))).toBe(migrations.at(-1)!.version - 40)

    expect(userVersion(db)).toBe(migrations.at(-1)!.version)
    expect(userVersion(db)).toBeGreaterThanOrEqual(41)
    expect(allOf(db, 'session_unread')).toEqual(unreadBefore)
    expect(columnSet(db, 'library_items')).toEqual([...SCHEMA.library_items].sort())
  })
})
