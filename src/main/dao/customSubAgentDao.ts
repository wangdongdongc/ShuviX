import { v7 as uuidv7 } from 'uuid'
import { BaseDao } from './database'
import type { CustomSubAgent, CustomSubAgentMetadata } from './types'

/** DB 原始行类型（tools/metadata 为 JSON 字符串，isBuiltin/isEnabled 为 0/1） */
type CustomSubAgentRow = Omit<CustomSubAgent, 'tools' | 'metadata' | 'isBuiltin' | 'isEnabled'> & {
  tools: string
  metadata: string
  isBuiltin: number
  isEnabled: number
}

function parseRow(row: CustomSubAgentRow): CustomSubAgent {
  return {
    ...row,
    tools: JSON.parse(row.tools || '[]') as string[],
    isBuiltin: row.isBuiltin === 1,
    isEnabled: row.isEnabled === 1,
    metadata: JSON.parse(row.metadata || '{}') as CustomSubAgentMetadata
  }
}

/**
 * CustomSubAgent DAO — custom_sub_agents 表的纯数据访问操作
 */
export class CustomSubAgentDao extends BaseDao {
  findAll(): CustomSubAgent[] {
    const rows = this.stmt(
      'SELECT * FROM custom_sub_agents ORDER BY isBuiltin DESC, createdAt ASC'
    ).all() as CustomSubAgentRow[]
    return rows.map(parseRow)
  }

  findBuiltin(): CustomSubAgent[] {
    const rows = this.stmt(
      'SELECT * FROM custom_sub_agents WHERE isBuiltin = 1 ORDER BY createdAt ASC'
    ).all() as CustomSubAgentRow[]
    return rows.map(parseRow)
  }

  findCustom(): CustomSubAgent[] {
    const rows = this.stmt(
      'SELECT * FROM custom_sub_agents WHERE isBuiltin = 0 ORDER BY createdAt ASC'
    ).all() as CustomSubAgentRow[]
    return rows.map(parseRow)
  }

  findEnabled(): CustomSubAgent[] {
    const rows = this.stmt(
      'SELECT * FROM custom_sub_agents WHERE isEnabled = 1 ORDER BY isBuiltin DESC, createdAt ASC'
    ).all() as CustomSubAgentRow[]
    return rows.map(parseRow)
  }

  findById(id: string): CustomSubAgent | undefined {
    const row = this.stmt('SELECT * FROM custom_sub_agents WHERE id = ?').get(id) as
      | CustomSubAgentRow
      | undefined
    return row ? parseRow(row) : undefined
  }

  findByName(name: string): CustomSubAgent | undefined {
    const row = this.stmt('SELECT * FROM custom_sub_agents WHERE name = ?').get(name) as
      | CustomSubAgentRow
      | undefined
    return row ? parseRow(row) : undefined
  }

  insert(agent: {
    name: string
    displayName: string
    description?: string
    systemPrompt?: string
    tools?: string[]
    maxTurns?: number
    metadata?: CustomSubAgentMetadata
  }): string {
    const existing = this.stmt('SELECT id FROM custom_sub_agents WHERE name = ?').get(agent.name)
    if (existing) {
      throw new Error(`Sub-agent name "${agent.name}" already exists`)
    }
    const id = uuidv7()
    const now = Date.now()
    this.stmt(
      `INSERT INTO custom_sub_agents
         (id, name, displayName, description, systemPrompt, tools, maxTurns, metadata, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      agent.name,
      agent.displayName,
      agent.description ?? '',
      agent.systemPrompt ?? '',
      JSON.stringify(agent.tools ?? []),
      agent.maxTurns ?? 40,
      JSON.stringify(agent.metadata ?? {}),
      now,
      now
    )
    return id
  }

  /** 更新子智能体（内置子智能体不可修改） */
  update(
    id: string,
    fields: Partial<{
      name: string
      displayName: string
      description: string
      systemPrompt: string
      tools: string[]
      maxTurns: number
      metadata: CustomSubAgentMetadata
    }>
  ): void {
    const sets: string[] = []
    const values: unknown[] = []
    if (fields.name !== undefined) {
      sets.push('name = ?')
      values.push(fields.name)
    }
    if (fields.displayName !== undefined) {
      sets.push('displayName = ?')
      values.push(fields.displayName)
    }
    if (fields.description !== undefined) {
      sets.push('description = ?')
      values.push(fields.description)
    }
    if (fields.systemPrompt !== undefined) {
      sets.push('systemPrompt = ?')
      values.push(fields.systemPrompt)
    }
    if (fields.tools !== undefined) {
      sets.push('tools = ?')
      values.push(JSON.stringify(fields.tools))
    }
    if (fields.maxTurns !== undefined) {
      sets.push('maxTurns = ?')
      values.push(fields.maxTurns)
    }
    if (fields.metadata !== undefined) {
      sets.push('metadata = ?')
      values.push(JSON.stringify(fields.metadata))
    }
    if (sets.length === 0) return
    sets.push('updatedAt = ?')
    values.push(Date.now())
    values.push(id)
    this.db.prepare(`UPDATE custom_sub_agents SET ${sets.join(', ')} WHERE id = ?`).run(...values)
  }

  /** 切换启用/禁用状态 */
  setEnabled(id: string, enabled: boolean): void {
    this.stmt('UPDATE custom_sub_agents SET isEnabled = ?, updatedAt = ? WHERE id = ?').run(
      enabled ? 1 : 0,
      Date.now(),
      id
    )
  }

  /** 删除子智能体（内置子智能体不可删除） */
  deleteById(id: string): void {
    this.stmt('DELETE FROM custom_sub_agents WHERE id = ? AND isBuiltin = 0').run(id)
  }
}

export const customSubAgentDao = new CustomSubAgentDao()
