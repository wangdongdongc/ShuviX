import { databaseManager } from './database'
import type { Project } from '../types'

/**
 * Project DAO — 项目表的纯数据访问操作
 */
export class ProjectDao {
  private get db() {
    return databaseManager.getDb()
  }

  /** 获取所有项目，按更新时间倒序 */
  findAll(): Project[] {
    return this.db
      .prepare('SELECT * FROM projects ORDER BY updatedAt DESC')
      .all() as Project[]
  }

  /** 根据 ID 获取单个项目 */
  findById(id: string): Project | undefined {
    return this.db
      .prepare('SELECT * FROM projects WHERE id = ?')
      .get(id) as Project | undefined
  }

  /** 根据路径查找项目 */
  findByPath(path: string): Project | undefined {
    return this.db
      .prepare('SELECT * FROM projects WHERE path = ?')
      .get(path) as Project | undefined
  }

  /** 插入项目 */
  insert(project: Project): void {
    this.db
      .prepare(
        'INSERT INTO projects (id, name, path, systemPrompt, dockerEnabled, dockerImage, settings, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        project.id,
        project.name,
        project.path,
        project.systemPrompt,
        project.dockerEnabled,
        project.dockerImage,
        project.settings,
        project.createdAt,
        project.updatedAt
      )
  }

  /** 更新项目 */
  update(id: string, fields: Partial<Pick<Project, 'name' | 'path' | 'systemPrompt' | 'dockerEnabled' | 'dockerImage' | 'settings'>>): void {
    const sets: string[] = []
    const values: any[] = []
    if (fields.name !== undefined) { sets.push('name = ?'); values.push(fields.name) }
    if (fields.path !== undefined) { sets.push('path = ?'); values.push(fields.path) }
    if (fields.systemPrompt !== undefined) { sets.push('systemPrompt = ?'); values.push(fields.systemPrompt) }
    if (fields.dockerEnabled !== undefined) { sets.push('dockerEnabled = ?'); values.push(fields.dockerEnabled) }
    if (fields.dockerImage !== undefined) { sets.push('dockerImage = ?'); values.push(fields.dockerImage) }
    if (fields.settings !== undefined) { sets.push('settings = ?'); values.push(fields.settings) }
    if (sets.length === 0) return
    sets.push('updatedAt = ?')
    values.push(Date.now())
    values.push(id)
    this.db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...values)
  }

  /** 删除项目（关联 session 的 projectId 会被 SET NULL） */
  deleteById(id: string): void {
    // 先将关联 session 的 projectId 置空
    this.db.prepare('UPDATE sessions SET projectId = NULL WHERE projectId = ?').run(id)
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id)
  }
}

export const projectDao = new ProjectDao()
