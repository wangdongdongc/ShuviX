import { BaseDao } from './database'
import type { Project, ProjectSettings } from './types'

/**
 * DB 原始行类型:
 * - settings 在 DB 中为 JSON 字符串
 * - systemPrompt 列存项目提示词纯文本（历史上曾存 `{"sections":[...]}` JSON 信封，
 *   卡片形态已废弃：读取时识别到旧信封按空处理，不做迁移）
 */
type ProjectRow = Omit<Project, 'settings'> & {
  settings: string
}

/** 安全解析 settings JSON,失败返回空对象 */
function safeParseSettings(json: string | undefined | null): ProjectSettings {
  try {
    return JSON.parse(json || '{}')
  } catch {
    return {}
  }
}

/** systemPrompt 列纯文本读取：旧卡片 JSON 信封视为已废弃（断代，按空），其余原样 */
function decodeProjectPrompt(raw: string | undefined | null): string {
  const text = (raw ?? '').trim()
  if (!text.startsWith('{')) return raw ?? ''
  try {
    const parsed: unknown = JSON.parse(text)
    if (
      parsed &&
      typeof parsed === 'object' &&
      Array.isArray((parsed as { sections?: unknown }).sections)
    ) {
      return ''
    }
  } catch {
    /* 非信封 JSON，按纯文本 */
  }
  return raw ?? ''
}

/** 将 DB 行映射为应用层 Project 对象 */
function parseRow(row: ProjectRow): Project {
  const { settings, systemPrompt, ...rest } = row
  return {
    ...rest,
    settings: safeParseSettings(settings),
    systemPrompt: decodeProjectPrompt(systemPrompt)
  }
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

  /**
   * 按需查询:只 SELECT 指定字段
   * - settings 字段会自动 JSON 解析
   * - systemPrompt 字段自动做旧信封废弃处理
   */
  pick<K extends keyof Project>(id: string, fields: K[]): Pick<Project, K> | undefined {
    const row = this.stmt(`SELECT ${fields.map(String).join(', ')} FROM projects WHERE id = ?`).get(
      id
    ) as Record<string, unknown> | undefined
    if (!row) return undefined
    if ('settings' in row) {
      row.settings = safeParseSettings(row.settings as string)
    }
    if ('systemPrompt' in row) {
      row.systemPrompt = decodeProjectPrompt(row.systemPrompt as string)
    }
    return row as Pick<Project, K>
  }

  /** 插入项目 */
  insert(project: Project): void {
    this.stmt(
      'INSERT INTO projects (id, name, path, systemPrompt, settings, archivedAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      project.id,
      project.name,
      project.path,
      project.systemPrompt,
      JSON.stringify(project.settings),
      project.archivedAt,
      project.createdAt,
      project.updatedAt
    )
  }

  /** 更新项目 */
  update(
    id: string,
    fields: Partial<Pick<Project, 'name' | 'path' | 'systemPrompt' | 'settings' | 'archivedAt'>>
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
