import { BaseDao } from './database'
import type { Project, ProjectSettings } from './types'
import {
  parsePromptSections,
  encodePromptSections
} from '@shuvix/chat-protocol/utils/promptSectionCodec'

/**
 * DB 原始行类型:
 * - settings 在 DB 中为 JSON 字符串
 * - systemPrompt 列在 DB 中存 `{"sections":[...]}` JSON 信封,解析后映射为应用层 `promptSections` 字段
 */
type ProjectRow = Omit<Project, 'settings' | 'promptSections'> & {
  settings: string
  systemPrompt: string
}

/** 安全解析 settings JSON,失败返回空对象 */
function safeParseSettings(json: string | undefined | null): ProjectSettings {
  try {
    return JSON.parse(json || '{}')
  } catch {
    return {}
  }
}

/** 将 DB 行映射为应用层 Project 对象 */
function parseRow(row: ProjectRow): Project {
  const { settings, systemPrompt, ...rest } = row
  return {
    ...rest,
    settings: safeParseSettings(settings),
    promptSections: parsePromptSections(systemPrompt)
  }
}

/**
 * Project DAO — 项目表的纯数据访问操作
 *
 * 注意:DB 列名仍为 `systemPrompt`(历史遗留),内容存 `{"sections":[...]}`
 * JSON 信封,DAO 内部映射为应用层 `promptSections` 字段。
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
   * - promptSections 字段映射为 SELECT systemPrompt 列,自动解析 JSON 信封
   */
  pick<K extends keyof Project>(id: string, fields: K[]): Pick<Project, K> | undefined {
    // 字段名 → DB 列名映射(promptSections 实际存在 systemPrompt 列)
    const columns = fields.map((f) => (f === 'promptSections' ? 'systemPrompt' : String(f)))
    const row = this.stmt(`SELECT ${columns.join(', ')} FROM projects WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined
    if (!row) return undefined
    if ('settings' in row) {
      row.settings = safeParseSettings(row.settings as string)
    }
    if ('systemPrompt' in row && fields.includes('promptSections' as K)) {
      const sections = parsePromptSections(row.systemPrompt as string)
      delete row.systemPrompt
      ;(row as Record<string, unknown>).promptSections = sections
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
      encodePromptSections(project.promptSections),
      JSON.stringify(project.settings),
      project.archivedAt,
      project.createdAt,
      project.updatedAt
    )
  }

  /** 更新项目 */
  update(
    id: string,
    fields: Partial<Pick<Project, 'name' | 'path' | 'promptSections' | 'settings' | 'archivedAt'>>
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
    if (fields.promptSections !== undefined) {
      sets.push('systemPrompt = ?')
      values.push(encodePromptSections(fields.promptSections))
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
