import { BaseDao } from './database'
import type { Project, ProjectSettings } from './types'

/** DB 原始行类型（settings 在 DB 中为 JSON 字符串） */
type ProjectRow = Omit<Project, 'settings'> & { settings: string }

/** 安全解析 JSON，失败返回空对象 */
function safeParse(json: string | undefined | null): ProjectSettings {
  try {
    return JSON.parse(json || '{}')
  } catch {
    return {}
  }
}

/** 将 DB 行的 settings 字符串解析为类型化对象 */
function parseRow(row: ProjectRow): Project {
  return { ...row, settings: safeParse(row.settings) }
}

/**
 * Project DAO — 项目表的纯数据访问操作
 */
export class ProjectDao extends BaseDao {
  /** 获取所有项目，按更新时间倒序 */
  findAll(): Project[] {
    const rows = this.stmt('SELECT * FROM projects ORDER BY updatedAt DESC').all() as ProjectRow[]
    return rows.map(parseRow)
  }

  /** 获取未归档项目，按更新时间倒序 */
  findAllActive(): Project[] {
    const rows = this.stmt(
      'SELECT * FROM projects WHERE archivedAt = 0 ORDER BY updatedAt DESC'
    ).all() as ProjectRow[]
    return rows.map(parseRow)
  }

  /** 获取已归档项目，按归档时间倒序 */
  findAllArchived(): Project[] {
    const rows = this.stmt(
      'SELECT * FROM projects WHERE archivedAt > 0 ORDER BY archivedAt DESC'
    ).all() as ProjectRow[]
    return rows.map(parseRow)
  }

  /** 根据 ID 获取单个项目 */
  findById(id: string): Project | undefined {
    const row = this.stmt('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined
    return row ? parseRow(row) : undefined
  }

  /** 根据路径查找项目 */
  findByPath(path: string): Project | undefined {
    const row = this.stmt('SELECT * FROM projects WHERE path = ?').get(path) as
      | ProjectRow
      | undefined
    return row ? parseRow(row) : undefined
  }

  /** 按需查询：只 SELECT 指定字段，settings 仅在需要时解析 */
  pick<K extends keyof Project>(id: string, fields: K[]): Pick<Project, K> | undefined {
    const columns = fields.map((f) => String(f)).join(', ')
    const row = this.stmt(`SELECT ${columns} FROM projects WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined
    if (!row) return undefined
    if ('settings' in row) {
      row.settings = safeParse(row.settings as string)
    }
    return row as Pick<Project, K>
  }

  /** 插入项目 */
  insert(project: Project): void {
    this.stmt(
      'INSERT INTO projects (id, name, path, systemPrompt, dockerEnabled, dockerImage, sandboxEnabled, settings, archivedAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      project.id,
      project.name,
      project.path,
      project.systemPrompt,
      project.dockerEnabled,
      project.dockerImage,
      project.sandboxEnabled,
      JSON.stringify(project.settings),
      project.archivedAt,
      project.createdAt,
      project.updatedAt
    )
  }

  /** 更新项目 */
  update(
    id: string,
    fields: Partial<
      Pick<
        Project,
        | 'name'
        | 'path'
        | 'systemPrompt'
        | 'dockerEnabled'
        | 'dockerImage'
        | 'sandboxEnabled'
        | 'settings'
        | 'archivedAt'
      >
    >
  ): void {
    const sets: string[] = []
    const values: (string | number)[] = []
    if (fields.name !== undefined) {
      sets.push('name = ?')
      values.push(fields.name)
    }
    if (fields.path !== undefined) {
      sets.push('path = ?')
      values.push(fields.path)
    }
    if (fields.systemPrompt !== undefined) {
      sets.push('systemPrompt = ?')
      values.push(fields.systemPrompt)
    }
    if (fields.dockerEnabled !== undefined) {
      sets.push('dockerEnabled = ?')
      values.push(fields.dockerEnabled)
    }
    if (fields.dockerImage !== undefined) {
      sets.push('dockerImage = ?')
      values.push(fields.dockerImage)
    }
    if (fields.sandboxEnabled !== undefined) {
      sets.push('sandboxEnabled = ?')
      values.push(fields.sandboxEnabled)
    }
    if (fields.settings !== undefined) {
      sets.push('settings = ?')
      values.push(JSON.stringify(fields.settings))
    }
    if (fields.archivedAt !== undefined) {
      sets.push('archivedAt = ?')
      values.push(fields.archivedAt)
    }
    if (sets.length === 0) return
    sets.push('updatedAt = ?')
    values.push(Date.now())
    values.push(id)
    this.db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...values)
  }

  /** 删除项目及其所有关联会话（消息通过 FK CASCADE 自动删除） */
  deleteById(id: string): void {
    this.stmt('DELETE FROM sessions WHERE projectId = ?').run(id)
    this.stmt('DELETE FROM projects WHERE id = ?').run(id)
  }
}

export const projectDao = new ProjectDao()
