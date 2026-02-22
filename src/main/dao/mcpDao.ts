import { databaseManager } from './database'
import type { McpServer } from '../types'

/**
 * MCP Server DAO — mcp_servers 表的纯数据访问操作
 */
export class McpDao {
  private get db() {
    return databaseManager.getDb()
  }

  /** 获取所有 MCP Server，按创建时间排序 */
  findAll(): McpServer[] {
    return this.db
      .prepare('SELECT * FROM mcp_servers ORDER BY createdAt ASC')
      .all() as McpServer[]
  }

  /** 获取所有已启用的 MCP Server */
  findEnabled(): McpServer[] {
    return this.db
      .prepare('SELECT * FROM mcp_servers WHERE isEnabled = 1 ORDER BY createdAt ASC')
      .all() as McpServer[]
  }

  /** 根据 ID 获取单个 MCP Server */
  findById(id: string): McpServer | undefined {
    return this.db
      .prepare('SELECT * FROM mcp_servers WHERE id = ?')
      .get(id) as McpServer | undefined
  }

  /** 根据名称查找（名称唯一） */
  findByName(name: string): McpServer | undefined {
    return this.db
      .prepare('SELECT * FROM mcp_servers WHERE name = ?')
      .get(name) as McpServer | undefined
  }

  /** 插入 MCP Server */
  insert(server: McpServer): void {
    this.db
      .prepare(
        `INSERT INTO mcp_servers (id, name, type, command, args, env, url, headers, isEnabled, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        server.id,
        server.name,
        server.type,
        server.command,
        server.args,
        server.env,
        server.url,
        server.headers,
        server.isEnabled,
        server.createdAt,
        server.updatedAt
      )
  }

  /** 更新 MCP Server */
  update(
    id: string,
    fields: Partial<Pick<McpServer, 'name' | 'type' | 'command' | 'args' | 'env' | 'url' | 'headers' | 'isEnabled'>>
  ): void {
    const sets: string[] = []
    const values: unknown[] = []
    if (fields.name !== undefined) { sets.push('name = ?'); values.push(fields.name) }
    if (fields.type !== undefined) { sets.push('type = ?'); values.push(fields.type) }
    if (fields.command !== undefined) { sets.push('command = ?'); values.push(fields.command) }
    if (fields.args !== undefined) { sets.push('args = ?'); values.push(fields.args) }
    if (fields.env !== undefined) { sets.push('env = ?'); values.push(fields.env) }
    if (fields.url !== undefined) { sets.push('url = ?'); values.push(fields.url) }
    if (fields.headers !== undefined) { sets.push('headers = ?'); values.push(fields.headers) }
    if (fields.isEnabled !== undefined) { sets.push('isEnabled = ?'); values.push(fields.isEnabled) }
    if (sets.length === 0) return
    sets.push('updatedAt = ?')
    values.push(Date.now())
    values.push(id)
    this.db.prepare(`UPDATE mcp_servers SET ${sets.join(', ')} WHERE id = ?`).run(...values)
  }

  /** 删除 MCP Server */
  deleteById(id: string): void {
    this.db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id)
  }
}

export const mcpDao = new McpDao()
