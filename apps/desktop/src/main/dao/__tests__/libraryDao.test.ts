/**
 * LibraryDao —— 文件库的元数据（迁移 v41，docs/file-library-design.md §3）的纯数据访问。
 *
 * 在**真的 SQLite** 上跑（node:sqlite 的内存库，同 mdAttrDao.test）：按顺序跑全部迁移建表，BaseDao 换成直接在这个库上
 * prepare。时间都由调用方传入（DAO 不读时钟）。
 *
 *   LD-1  insertItem / findItem：item 与第 1 版的联表行；未知 id → null；回收站里的照样查得到
 *   LD-2  原子性：同 id 插两次第二次抛错、库里只剩第一件；version 插入失败 → items 也回滚；
 *         transaction 里调 replaceDerivedLinks 不重复 BEGIN，外层抛错两者都回滚
 *   LD-3  findManagedBySha：linked 的忽略；多件回最早的（同时回 id 小的）；回收站里的照样命中；没有 → null
 *   LD-4  setDeletedAt / listDeletedIds
 *   LD-5  purgeItem：六张 item 相关表里这件一行不剩，另一件原样
 *   LD-6  addLink 同主键覆盖写：一行，context 换新，createdAt / origin 留旧
 *   LD-7  replaceDerivedLinks：只换这个目标这种关系的派生行；保留旧 createdAt；跳过库里没有的；手动行与别的目标不动
 *   LD-8  linksOfItem / itemIdsOfTarget / isLinked；deleteLinksOfTarget；copyLinksOfTarget（OR IGNORE）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
import { libraryDao } from '../libraryDao'
import type { LibraryLinkRow, NewLibraryItem } from '../types/library'

type Db = Parameters<(typeof migrations)[number]['up']>[0]
type Row = Record<string, unknown>

const A = '0199d3a2-7b3e-7c4d-9a1f-2e5b8c7d6f10'
const B = '0199d3a2-0000-7000-8000-000000000000'
const C = '0199d3a2-0000-7000-8000-00000000000c'
const D = '0199d3a2-0000-7000-8000-00000000000d'
const X = '0199d3a2-0000-7000-8000-0000000000ff'

const db = (): DatabaseSync => holder.db as DatabaseSync

function newItem(id: string, over: Partial<NewLibraryItem> = {}): NewLibraryItem {
  return {
    id,
    name: `${id}.png`,
    storage: 'managed',
    kind: 'image',
    source: 'note-paste',
    sha256: `sha-${id}`,
    size: 123,
    mime: 'image/png',
    fileName: 'a.png',
    width: 40,
    height: 24,
    createdAt: 1_000,
    ...over
  }
}

function link(over: Partial<LibraryLinkRow> & Pick<LibraryLinkRow, 'itemId'>): LibraryLinkRow {
  return {
    targetType: 'session',
    targetId: 'S',
    relation: 'sent',
    origin: 'derived',
    context: null,
    createdAt: 1_000,
    ...over
  }
}

function insertRaw(table: string, row: Row): void {
  const keys = Object.keys(row)
  db()
    .prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`)
    .run(...(Object.values(row) as Array<string | number | null>))
}

const rowsOf = (table: string, where = '1 = 1', ...args: Array<string | number>): Row[] =>
  db()
    .prepare(`SELECT * FROM ${table} WHERE ${where} ORDER BY rowid`)
    .all(...args) as Row[]

const allLinks = (): Row[] =>
  db()
    .prepare('SELECT * FROM library_links ORDER BY itemId, targetType, targetId, relation')
    .all() as Row[]

beforeEach(() => {
  const fresh = new DatabaseSync(':memory:')
  for (const m of migrations) m.up(fresh as unknown as Db)
  holder.db = fresh
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('LibraryDao：文件与版本', () => {
  it('LD-1 insertItem / findItem：联表行字段齐全；未知 id → null；回收站里的照样查得到', () => {
    libraryDao.insertItem(newItem(A, { sha256: 'deadbeef', size: 4096 }))

    expect(libraryDao.findItem(A)).toEqual({
      id: A,
      name: `${A}.png`,
      storage: 'managed',
      externalPath: null,
      currentVersion: 1,
      kind: 'image',
      source: 'note-paste',
      description: null,
      createdAt: 1_000,
      updatedAt: 1_000,
      deletedAt: null,
      sha256: 'deadbeef',
      size: 4096,
      mime: 'image/png',
      fileName: 'a.png',
      width: 40,
      height: 24,
      durationMs: null
    })
    expect(libraryDao.findItem(B)).toBeNull()

    libraryDao.setDeletedAt(A, 2_000, 2_000)
    expect(libraryDao.findItem(A)?.deletedAt).toBe(2_000)
  })

  it('LD-1 没有宽高的文件：width / height 为 null；externalPath 原样存', () => {
    libraryDao.insertItem(
      newItem(A, {
        storage: 'linked',
        externalPath: '/x/r.pdf',
        kind: 'pdf',
        mime: 'application/pdf',
        fileName: 'r.pdf',
        width: undefined,
        height: undefined
      })
    )
    const row = libraryDao.findItem(A)!
    expect(row.width).toBeNull()
    expect(row.height).toBeNull()
    expect(row.externalPath).toBe('/x/r.pdf')
    expect(row.storage).toBe('linked')
  })

  it('LD-2 同 id 插两次：第二次抛错；库里只有第一件与它的一条版本行', () => {
    libraryDao.insertItem(newItem(A, { name: 'first.png' }))
    expect(() => libraryDao.insertItem(newItem(A, { name: 'second.png' }))).toThrow()

    expect(rowsOf('library_items')).toHaveLength(1)
    expect(libraryDao.findItem(A)?.name).toBe('first.png')
    expect(rowsOf('library_versions')).toHaveLength(1)
  })

  it('LD-2 version 插入失败（同 id 的 versions 行已在）：items 也回滚', () => {
    insertRaw('library_versions', {
      itemId: A,
      version: 1,
      sha256: 'other',
      size: 1,
      mime: 'x/y',
      fileName: 'z',
      createdAt: 1
    })
    expect(() => libraryDao.insertItem(newItem(A))).toThrow()

    expect(rowsOf('library_items')).toEqual([])
    expect(rowsOf('library_versions').map((r) => r.sha256)).toEqual(['other'])
    expect(db().isTransaction).toBe(false)
  })

  it('LD-2 transaction 嵌套：里面调 replaceDerivedLinks 不重复 BEGIN；外层抛错两者都回滚', () => {
    libraryDao.insertItem(newItem(A))
    const execSpy = vi.spyOn(db(), 'exec')

    const ok = libraryDao.transaction(() => {
      libraryDao.insertItem(newItem(B))
      return libraryDao.replaceDerivedLinks('note', '/n.md', 'embedded', [A, B], 5_000)
    })
    expect(ok).toEqual([A, B])
    expect(execSpy.mock.calls.filter(([sql]) => /BEGIN/i.test(String(sql)))).toHaveLength(1)
    expect(execSpy.mock.calls.filter(([sql]) => /COMMIT/i.test(String(sql)))).toHaveLength(1)
    execSpy.mockClear()

    expect(() =>
      libraryDao.transaction(() => {
        libraryDao.insertItem(newItem(C))
        libraryDao.replaceDerivedLinks('note', '/m.md', 'embedded', [A, C], 6_000)
        throw new Error('outer boom')
      })
    ).toThrow('outer boom')
    expect(execSpy.mock.calls.filter(([sql]) => /BEGIN/i.test(String(sql)))).toHaveLength(1)
    expect(execSpy.mock.calls.filter(([sql]) => /ROLLBACK/i.test(String(sql)))).toHaveLength(1)

    expect(libraryDao.findItem(C)).toBeNull()
    expect(rowsOf('library_links', 'targetId = ?', '/m.md')).toEqual([])
    // 第一次提交了的原样
    expect(libraryDao.findItem(B)).not.toBeNull()
    expect(libraryDao.itemIdsOfTarget('note', '/n.md').sort()).toEqual([A, B].sort())
    expect(db().isTransaction).toBe(false)
  })

  it('LD-3 findManagedBySha：同 sha 的 linked 忽略；多件回最早的、同一时间回 id 小的；回收站里照样命中；没有 → null', () => {
    libraryDao.insertItem(
      newItem(X, { sha256: 'same', storage: 'linked', externalPath: '/e', createdAt: 1 })
    )
    expect(libraryDao.findManagedBySha('same')).toBeNull()

    libraryDao.insertItem(newItem(D, { sha256: 'same', createdAt: 300 }))
    libraryDao.insertItem(newItem(C, { sha256: 'same', createdAt: 200 }))
    libraryDao.insertItem(newItem(B, { sha256: 'same', createdAt: 200 }))
    expect(libraryDao.findManagedBySha('same')?.id).toBe(B)

    libraryDao.setDeletedAt(B, 900, 900)
    expect(libraryDao.findManagedBySha('same')?.id).toBe(B)
    expect(libraryDao.findManagedBySha('nope')).toBeNull()
  })

  it('LD-4 setDeletedAt：进回收站回 1、deletedAt 与 updatedAt 都更新；null 恢复；未知 id 回 0；listDeletedIds 只列回收站里的', () => {
    libraryDao.insertItem(newItem(A))
    libraryDao.insertItem(newItem(B))

    expect(libraryDao.setDeletedAt(A, 5_000, 5_000)).toBe(1)
    expect(libraryDao.findItem(A)).toMatchObject({ deletedAt: 5_000, updatedAt: 5_000 })
    expect(libraryDao.listDeletedIds()).toEqual([A])

    expect(libraryDao.setDeletedAt(A, null, 6_000)).toBe(1)
    expect(libraryDao.findItem(A)).toMatchObject({ deletedAt: null, updatedAt: 6_000 })
    expect(libraryDao.listDeletedIds()).toEqual([])

    expect(libraryDao.setDeletedAt(X, 7_000, 7_000)).toBe(0)
    expect(libraryDao.findItem(B)?.updatedAt).toBe(1_000)
  })

  it('LD-5 purgeItem：这件在六张表里一行不剩，另一件原样', () => {
    for (const id of [A, B]) {
      libraryDao.insertItem(newItem(id))
      insertRaw('library_item_categories', { itemId: id, categoryId: 'cat' })
      insertRaw('library_item_tags', { itemId: id, tagId: 'tag' })
      insertRaw('library_item_fields', { itemId: id, fieldId: 'f', value: '"v"' })
      libraryDao.addLink(link({ itemId: id }))
      libraryDao.addLink(
        link({ itemId: id, targetType: 'note', targetId: '/n.md', relation: 'embedded' })
      )
    }
    const TABLES = [
      'library_items',
      'library_versions',
      'library_item_categories',
      'library_item_tags',
      'library_item_fields',
      'library_links'
    ]
    const keyOf = (t: string): string => (t === 'library_items' ? 'id' : 'itemId')
    const bBefore = Object.fromEntries(TABLES.map((t) => [t, rowsOf(t, `${keyOf(t)} = ?`, B)]))

    libraryDao.purgeItem(A)

    for (const t of TABLES) {
      expect(rowsOf(t, `${keyOf(t)} = ?`, A), t).toEqual([])
      expect(rowsOf(t, `${keyOf(t)} = ?`, B), t).toEqual(bBefore[t])
      expect(bBefore[t].length, t).toBeGreaterThan(0)
    }
  })
})

describe('LibraryDao：关联', () => {
  it('LD-6 addLink 同主键写两次：仍一行，context 换成第二次的，createdAt 与 origin 留第一次的', () => {
    libraryDao.addLink(
      link({ itemId: A, origin: 'derived', context: '{"entryId":1}', createdAt: 100 })
    )
    libraryDao.addLink(
      link({ itemId: A, origin: 'manual', context: '{"entryId":2}', createdAt: 999 })
    )
    expect(allLinks()).toEqual([
      {
        itemId: A,
        targetType: 'session',
        targetId: 'S',
        relation: 'sent',
        origin: 'derived',
        context: '{"entryId":2}',
        createdAt: 100
      }
    ])
  })

  it('LD-7 replaceDerivedLinks：只换 N 的派生 embedded；B 保留旧 createdAt、D 是 now、A 没了、X 跳过；C/S/M 不动；再传 [] 清空派生', () => {
    for (const id of [A, B, C, D]) libraryDao.insertItem(newItem(id))
    libraryDao.addLink(
      link({ itemId: A, targetType: 'note', targetId: 'N', relation: 'embedded', createdAt: 10 })
    )
    libraryDao.addLink(
      link({ itemId: B, targetType: 'note', targetId: 'N', relation: 'embedded', createdAt: 20 })
    )
    libraryDao.addLink(
      link({
        itemId: C,
        targetType: 'note',
        targetId: 'N',
        relation: 'embedded',
        origin: 'manual',
        createdAt: 30
      })
    )
    libraryDao.addLink(
      link({ itemId: A, targetType: 'session', targetId: 'S', relation: 'sent', createdAt: 40 })
    )
    libraryDao.addLink(
      link({ itemId: A, targetType: 'note', targetId: 'M', relation: 'embedded', createdAt: 50 })
    )
    const others = (): Row[] =>
      allLinks().filter(
        (r) => !(r.targetType === 'note' && r.targetId === 'N' && r.origin === 'derived')
      )
    const othersBefore = others()
    expect(othersBefore).toHaveLength(3)

    expect(libraryDao.replaceDerivedLinks('note', 'N', 'embedded', [B, D, X], 7_000)).toEqual([
      B,
      D
    ])

    const n = rowsOf(
      'library_links',
      "targetType = 'note' AND targetId = 'N' AND origin = 'derived'"
    ).map((r) => [r.itemId, r.createdAt])
    expect(n.sort()).toEqual(
      [
        [B, 20],
        [D, 7_000]
      ].sort()
    )
    expect(others()).toEqual(othersBefore)

    expect(libraryDao.replaceDerivedLinks('note', 'N', 'embedded', [], 8_000)).toEqual([])
    expect(
      rowsOf('library_links', "targetType = 'note' AND targetId = 'N'").map((r) => [
        r.itemId,
        r.origin
      ])
    ).toEqual([[C, 'manual']])
    expect(others()).toEqual(othersBefore)
  })

  it('LD-8 linksOfItem 按 createdAt 排序；itemIdsOfTarget 跨关系去重；isLinked 任一关系都算，换类型或 id 不算', () => {
    libraryDao.addLink(link({ itemId: A, targetId: 'S', relation: 'sent', createdAt: 30 }))
    libraryDao.addLink(link({ itemId: A, targetId: 'S', relation: 'attached', createdAt: 10 }))
    libraryDao.addLink(
      link({ itemId: A, targetType: 'note', targetId: 'S', relation: 'embedded', createdAt: 20 })
    )
    libraryDao.addLink(link({ itemId: B, targetId: 'S', relation: 'sent', createdAt: 5 }))

    expect(libraryDao.linksOfItem(A).map((l) => l.createdAt)).toEqual([10, 20, 30])
    expect(libraryDao.linksOfItem(A)[0]).toEqual({
      itemId: A,
      targetType: 'session',
      targetId: 'S',
      relation: 'attached',
      origin: 'derived',
      context: null,
      createdAt: 10
    })
    expect(libraryDao.itemIdsOfTarget('session', 'S').sort()).toEqual([A, B].sort())
    expect(libraryDao.itemIdsOfTarget('note', 'S')).toEqual([A])
    expect(libraryDao.itemIdsOfTarget('session', 'nobody')).toEqual([])

    expect(libraryDao.isLinked(A, 'session', 'S')).toBe(true)
    expect(libraryDao.isLinked(A, 'note', 'S')).toBe(true)
    expect(libraryDao.isLinked(A, 'project', 'S')).toBe(false)
    expect(libraryDao.isLinked(A, 'session', 'T')).toBe(false)
    expect(libraryDao.isLinked(C, 'session', 'S')).toBe(false)
  })

  it('LD-8 deleteLinksOfTarget：删掉 S 的全部行（含手动的）、回行数；笔记行与别的会话不动', () => {
    libraryDao.addLink(link({ itemId: A, targetId: 'S', relation: 'sent' }))
    libraryDao.addLink(link({ itemId: B, targetId: 'S', relation: 'attached', origin: 'manual' }))
    libraryDao.addLink(link({ itemId: A, targetId: 'T', relation: 'sent' }))
    libraryDao.addLink(link({ itemId: A, targetType: 'note', targetId: 'S', relation: 'embedded' }))
    const keep = allLinks().filter((r) => !(r.targetType === 'session' && r.targetId === 'S'))

    expect(libraryDao.deleteLinksOfTarget('session', 'S')).toBe(2)
    expect(allLinks()).toEqual(keep)
    expect(libraryDao.deleteLinksOfTarget('session', 'S')).toBe(0)
  })

  it('LD-8 copyLinksOfTarget：逐条连同 origin/context/createdAt 复制；F 已有的同主键行不动；回新增行数；S 不变', () => {
    libraryDao.addLink(
      link({ itemId: A, targetId: 'S', relation: 'sent', context: '{"entryId":7}', createdAt: 11 })
    )
    libraryDao.addLink(
      link({
        itemId: B,
        targetId: 'S',
        relation: 'attached',
        origin: 'manual',
        context: '{"source":"note-paste"}',
        createdAt: 22
      })
    )
    libraryDao.addLink(
      link({ itemId: C, targetType: 'note', targetId: 'S', relation: 'embedded', createdAt: 33 })
    )
    // F 已有一条与 S 的 (A, sent) 同主键的行：OR IGNORE，原样
    libraryDao.addLink(
      link({ itemId: A, targetId: 'F', relation: 'sent', context: '{"entryId":99}', createdAt: 44 })
    )
    const sBefore = rowsOf('library_links', "targetType = 'session' AND targetId = 'S'")

    expect(libraryDao.copyLinksOfTarget('session', 'S', 'F')).toBe(1)

    expect(rowsOf('library_links', "targetType = 'session' AND targetId = 'S'")).toEqual(sBefore)
    const f = rowsOf('library_links', "targetType = 'session' AND targetId = 'F'").sort((x, y) =>
      String(x.itemId).localeCompare(String(y.itemId))
    )
    expect(f).toEqual(
      [
        {
          itemId: A,
          targetType: 'session',
          targetId: 'F',
          relation: 'sent',
          origin: 'derived',
          context: '{"entryId":99}',
          createdAt: 44
        },
        {
          itemId: B,
          targetType: 'session',
          targetId: 'F',
          relation: 'attached',
          origin: 'manual',
          context: '{"source":"note-paste"}',
          createdAt: 22
        }
      ].sort((x, y) => x.itemId.localeCompare(y.itemId))
    )
    // 笔记那条（targetType 不同）没被带过去
    expect(libraryDao.isLinked(C, 'session', 'F')).toBe(false)
  })
})
