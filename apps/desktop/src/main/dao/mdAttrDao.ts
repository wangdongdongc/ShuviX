import { BaseDao } from './database'
import { MD_ATTR_NAMESPACES, isJsonValue, type MdAttrNamespace } from '@shuvix/chat-protocol/mdMeta'
import type { MdAttr, MdAttrKey } from './types'

/** md_attrs 的原始行（value 仍是 JSON 文本） */
interface MdAttrRow {
  objectId: string
  scope: string
  ns: string
  key: string
  value: string
  updatedAt: number
}

/**
 * 原始行 → MdAttr；value 解析不了、或 ns 不认识的行返回 null。这两种行只可能来自手改数据库 ——
 * 读的一侧跳过它们，而不是让一行坏数据拖垮整张表的读取。
 */
function parseRow(row: MdAttrRow): MdAttr | null {
  if (!(MD_ATTR_NAMESPACES as readonly string[]).includes(row.ns)) return null
  let value: unknown
  try {
    value = JSON.parse(row.value)
  } catch {
    return null
  }
  return { ...row, ns: row.ns as MdAttrNamespace, value }
}

/**
 * md 扩展元数据 DAO（表 md_attrs，迁移 v31）—— 纯数据访问。设计见 docs/md-metadata-design.md：
 * 挂在文件 frontmatter 的 `shuvix-id` 上，一个顶层键一行。「id 必须已经在文件里」「键在白名单内」
 * 「补进去之后解析器仍然通过」这些校验属于上层的 store，这里只守一条数据契约：value 必须是 JSON
 * 能原样表达的值（JSON.stringify 会把 NaN 悄悄写成 null，存进去就不是原来的值了）。
 */
export class MdAttrDao extends BaseDao {
  /** 全部元数据（启动时载入内存快照用） */
  findAll(): MdAttr[] {
    const rows = this.stmt(
      'SELECT objectId, scope, ns, key, value, updatedAt FROM md_attrs'
    ).all() as MdAttrRow[]
    return rows.map(parseRow).filter((attr): attr is MdAttr => attr !== null)
  }

  /** 一个对象的全部元数据（所有 scope / ns） */
  findByObject(objectId: string): MdAttr[] {
    const rows = this.stmt(
      'SELECT objectId, scope, ns, key, value, updatedAt FROM md_attrs WHERE objectId = ?'
    ).all(objectId) as MdAttrRow[]
    return rows.map(parseRow).filter((attr): attr is MdAttr => attr !== null)
  }

  /**
   * 写入一个键（已有则替换值、刷新 updatedAt）。抛错、什么都不写：value 不是 JSON 能原样表达的值，
   * 或 ns 不在词表里（读的一侧会跳过这种行 —— 写得进去却读不回来，不如当场拒绝）
   */
  upsert(attr: MdAttrKey & { value: unknown }): void {
    if (!(MD_ATTR_NAMESPACES as readonly string[]).includes(attr.ns)) {
      throw new Error(`md_attrs: unknown namespace '${attr.ns}'`)
    }
    if (!isJsonValue(attr.value)) {
      throw new Error(`md_attrs: value for '${attr.key}' is not representable as JSON`)
    }
    this.stmt(
      `INSERT INTO md_attrs (objectId, scope, ns, key, value, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (objectId, scope, ns, key)
       DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt`
    ).run(
      attr.objectId,
      attr.scope ?? '',
      attr.ns,
      attr.key,
      JSON.stringify(attr.value),
      Date.now()
    )
  }

  /** 删除一个键；返回是否真有一行被删 */
  delete(key: MdAttrKey): boolean {
    const result = this.stmt(
      'DELETE FROM md_attrs WHERE objectId = ? AND scope = ? AND ns = ? AND key = ?'
    ).run(key.objectId, key.scope ?? '', key.ns, key.key)
    return result.changes > 0
  }

  /** 删除一个对象的全部元数据；返回删掉的行数 */
  deleteByObject(objectId: string): number {
    return this.stmt('DELETE FROM md_attrs WHERE objectId = ?').run(objectId).changes
  }
}

export const mdAttrDao = new MdAttrDao()
