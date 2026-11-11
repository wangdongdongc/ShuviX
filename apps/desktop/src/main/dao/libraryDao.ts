import { BaseDao } from './database'
import type { LibraryItemRow, LibraryLinkRow, NewLibraryItem } from './types/library'
import type { LibraryLinkRelation, LibraryLinkTarget } from '@shuvix/chat-protocol/fileLibrary'

const ITEM_COLUMNS = `i.id, i.name, i.storage, i.externalPath, i.currentVersion, i.kind, i.source, i.description,
  i.createdAt, i.updatedAt, i.deletedAt, v.sha256, v.size, v.mime, v.fileName, v.width, v.height, v.durationMs`

const ITEM_FROM = `library_items i JOIN library_versions v ON v.itemId = i.id AND v.version = i.currentVersion`

/**
 * 文件库的元数据（迁移 v41，docs/file-library-design.md §3）—— 纯数据访问。文件本身怎么落盘、去重、
 * 关联什么时候派生，是上层 services/fileLibrary.ts 的事。
 *
 * L1 只用到文件、版本、关联三张表；分类、标签、字段的表已经建好，管理页（L2）再来读写。
 */
export class LibraryDao extends BaseDao {
  /** 一件文件（含回收站里的）；不存在 → null */
  findItem(id: string): LibraryItemRow | null {
    const row = this.stmt(`SELECT ${ITEM_COLUMNS} FROM ${ITEM_FROM} WHERE i.id = ?`).get(id) as
      | LibraryItemRow
      | undefined
    return row ?? null
  }

  /** 内容相同的托管文件（去重用，含回收站里的）；最早的那件 */
  findManagedBySha(sha256: string): LibraryItemRow | null {
    const row = this.stmt(
      `SELECT ${ITEM_COLUMNS} FROM ${ITEM_FROM}
       WHERE v.sha256 = ? AND i.storage = 'managed'
       ORDER BY i.createdAt ASC, i.id ASC LIMIT 1`
    ).get(sha256) as LibraryItemRow | undefined
    return row ?? null
  }

  /** 新建一件（第 1 版） */
  insertItem(item: NewLibraryItem): void {
    this.transaction(() => {
      this.stmt(
        `INSERT INTO library_items (id, name, storage, externalPath, currentVersion, kind, source, description,
           createdAt, updatedAt, deletedAt)
         VALUES (?, ?, ?, ?, 1, ?, ?, NULL, ?, ?, NULL)`
      ).run(
        item.id,
        item.name,
        item.storage,
        item.externalPath ?? null,
        item.kind,
        item.source,
        item.createdAt,
        item.createdAt
      )
      this.stmt(
        `INSERT INTO library_versions (itemId, version, sha256, size, mime, fileName, width, height, durationMs, createdAt)
         VALUES (?, 1, ?, ?, ?, ?, ?, ?, NULL, ?)`
      ).run(
        item.id,
        item.sha256,
        item.size,
        item.mime,
        item.fileName,
        item.width ?? null,
        item.height ?? null,
        item.createdAt
      )
    })
  }

  /** 进回收站（`at`）或恢复（null）；回改动的行数 */
  setDeletedAt(id: string, at: number | null, now: number): number {
    return this.stmt('UPDATE library_items SET deletedAt = ?, updatedAt = ? WHERE id = ?').run(
      at,
      now,
      id
    ).changes
  }

  /** 彻底删掉一件的全部元数据（清空回收站）；文件目录由上层删 */
  purgeItem(id: string): void {
    this.transaction(() => {
      for (const table of [
        'library_versions',
        'library_item_categories',
        'library_item_tags',
        'library_item_fields',
        'library_links'
      ]) {
        this.stmt(`DELETE FROM ${table} WHERE itemId = ?`).run(id)
      }
      this.stmt('DELETE FROM library_items WHERE id = ?').run(id)
    })
  }

  /** 回收站里的全部 id */
  listDeletedIds(): string[] {
    return (
      this.stmt('SELECT id FROM library_items WHERE deletedAt IS NOT NULL').all() as Array<{
        id: string
      }>
    ).map((r) => r.id)
  }

  /** 加一条关联（已有同一条就只更新 context） */
  addLink(link: LibraryLinkRow): void {
    this.stmt(
      `INSERT INTO library_links (itemId, targetType, targetId, relation, origin, context, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(itemId, targetType, targetId, relation) DO UPDATE SET context = excluded.context`
    ).run(
      link.itemId,
      link.targetType,
      link.targetId,
      link.relation,
      link.origin,
      link.context,
      link.createdAt
    )
  }

  /**
   * 把一个目标的某种派生关联整体换成 `itemIds`（笔记保存时按正文重算 `embedded`）。
   * 只换派生的：手动绑定不动。库里没有的 id 跳过。回实际写下的 id。
   */
  replaceDerivedLinks(
    targetType: LibraryLinkTarget,
    targetId: string,
    relation: LibraryLinkRelation,
    itemIds: string[],
    now: number
  ): string[] {
    return this.transaction(() => {
      const before = new Map(
        (
          this.stmt(
            `SELECT itemId, createdAt FROM library_links
             WHERE targetType = ? AND targetId = ? AND relation = ? AND origin = 'derived'`
          ).all(targetType, targetId, relation) as Array<{ itemId: string; createdAt: number }>
        ).map((r) => [r.itemId, r.createdAt])
      )
      this.stmt(
        `DELETE FROM library_links WHERE targetType = ? AND targetId = ? AND relation = ? AND origin = 'derived'`
      ).run(targetType, targetId, relation)
      const exists = this.stmt('SELECT 1 FROM library_items WHERE id = ?')
      const insert = this.stmt(
        `INSERT OR IGNORE INTO library_links (itemId, targetType, targetId, relation, origin, context, createdAt)
         VALUES (?, ?, ?, ?, 'derived', NULL, ?)`
      )
      const written: string[] = []
      for (const id of itemIds) {
        if (!exists.get(id)) continue
        insert.run(id, targetType, targetId, relation, before.get(id) ?? now)
        written.push(id)
      }
      return written
    })
  }

  /** 一件文件的全部关联 */
  linksOfItem(itemId: string): LibraryLinkRow[] {
    return this.stmt(
      `SELECT itemId, targetType, targetId, relation, origin, context, createdAt FROM library_links
       WHERE itemId = ? ORDER BY createdAt ASC`
    ).all(itemId) as LibraryLinkRow[]
  }

  /** 一个目标关联的全部文件 id（去重） */
  itemIdsOfTarget(targetType: LibraryLinkTarget, targetId: string): string[] {
    return (
      this.stmt(
        'SELECT DISTINCT itemId FROM library_links WHERE targetType = ? AND targetId = ?'
      ).all(targetType, targetId) as Array<{ itemId: string }>
    ).map((r) => r.itemId)
  }

  /** 这件文件是否与某个目标有任何关联 */
  isLinked(itemId: string, targetType: LibraryLinkTarget, targetId: string): boolean {
    return !!this.stmt(
      'SELECT 1 FROM library_links WHERE itemId = ? AND targetType = ? AND targetId = ? LIMIT 1'
    ).get(itemId, targetType, targetId)
  }

  /** 删掉一个目标的全部关联（删会话时）；回删掉的行数 */
  deleteLinksOfTarget(targetType: LibraryLinkTarget, targetId: string): number {
    return this.stmt('DELETE FROM library_links WHERE targetType = ? AND targetId = ?').run(
      targetType,
      targetId
    ).changes
  }

  /** 把一个目标的关联复制给另一个（分支会话：复制关联，不复制文件）；回复制的行数 */
  copyLinksOfTarget(targetType: LibraryLinkTarget, fromId: string, toId: string): number {
    return this.stmt(
      `INSERT OR IGNORE INTO library_links (itemId, targetType, targetId, relation, origin, context, createdAt)
       SELECT itemId, targetType, ?, relation, origin, context, createdAt FROM library_links
       WHERE targetType = ? AND targetId = ?`
    ).run(toId, targetType, fromId).changes
  }

  /**
   * 在一个事务里跑 `fn`。已在事务里就直接跑 —— 不嵌套 BEGIN。
   * 不用 better-sqlite3 的 `db.transaction`：单测跑在 node:sqlite 上，那边没有这个方法（同 sessionAclDao）
   */
  transaction<T>(fn: () => T): T {
    const db = this.db as unknown as {
      exec(sql: string): void
      inTransaction?: boolean
      isTransaction?: boolean
    }
    if (db.inTransaction || db.isTransaction) return fn()
    db.exec('BEGIN')
    try {
      const result = fn()
      db.exec('COMMIT')
      return result
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }
}

export const libraryDao = new LibraryDao()
