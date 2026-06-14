import { BaseDao } from './database'

/** Widget 记录（与 DB 行结构一致，metadata 已解析为对象） */
export interface Widget {
  id: string
  name: string
  description: string
  entryFile: string
  createdAt: number
  updatedAt: number
  lastOpenedAt: number
  openCount: number
  archivedAt: number
  metadata: Record<string, unknown>
}

type WidgetRow = Omit<Widget, 'metadata'> & { metadata: string }

function parseRow(row: WidgetRow): Widget {
  let metadata: Record<string, unknown> = {}
  try {
    metadata = JSON.parse(row.metadata || '{}')
  } catch {
    /* 损坏的 JSON 按空对象处理 */
  }
  return { ...row, metadata }
}

export class WidgetDao extends BaseDao {
  /** 所有未归档 widget，按最近打开时间倒序（未打开的按创建时间倒序） */
  findAllActive(): Widget[] {
    const rows = this.stmt(
      `SELECT * FROM widgets WHERE archivedAt = 0
       ORDER BY lastOpenedAt DESC, createdAt DESC`
    ).all() as WidgetRow[]
    return rows.map(parseRow)
  }

  findAllArchived(): Widget[] {
    const rows = this.stmt(
      'SELECT * FROM widgets WHERE archivedAt > 0 ORDER BY archivedAt DESC'
    ).all() as WidgetRow[]
    return rows.map(parseRow)
  }

  findById(id: string): Widget | undefined {
    const row = this.stmt('SELECT * FROM widgets WHERE id = ?').get(id) as WidgetRow | undefined
    return row ? parseRow(row) : undefined
  }

  insert(widget: Widget): void {
    this.stmt(
      `INSERT INTO widgets (id, name, description, entryFile, createdAt, updatedAt,
                            lastOpenedAt, openCount, archivedAt, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      widget.id,
      widget.name,
      widget.description,
      widget.entryFile,
      widget.createdAt,
      widget.updatedAt,
      widget.lastOpenedAt,
      widget.openCount,
      widget.archivedAt,
      JSON.stringify(widget.metadata)
    )
  }

  update(
    id: string,
    fields: Partial<Pick<Widget, 'name' | 'description' | 'entryFile' | 'archivedAt' | 'metadata'>>
  ): void {
    const sets: string[] = []
    const values: (string | number)[] = []
    if (fields.name !== undefined) {
      sets.push('name = ?')
      values.push(fields.name)
    }
    if (fields.description !== undefined) {
      sets.push('description = ?')
      values.push(fields.description)
    }
    if (fields.entryFile !== undefined) {
      sets.push('entryFile = ?')
      values.push(fields.entryFile)
    }
    if (fields.archivedAt !== undefined) {
      sets.push('archivedAt = ?')
      values.push(fields.archivedAt)
    }
    if (fields.metadata !== undefined) {
      sets.push('metadata = ?')
      values.push(JSON.stringify(fields.metadata))
    }
    if (sets.length === 0) return
    sets.push('updatedAt = ?')
    values.push(Date.now())
    values.push(id)
    this.db.prepare(`UPDATE widgets SET ${sets.join(', ')} WHERE id = ?`).run(...values)
  }

  /** 打开时的计数与时间戳更新 */
  markOpened(id: string): void {
    const now = Date.now()
    this.stmt(
      `UPDATE widgets SET lastOpenedAt = ?, openCount = openCount + 1, updatedAt = ? WHERE id = ?`
    ).run(now, now, id)
  }

  deleteById(id: string): void {
    this.stmt('DELETE FROM widgets WHERE id = ?').run(id)
  }
}

export const widgetDao = new WidgetDao()
