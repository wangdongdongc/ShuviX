import { BaseDao } from './database'
import { decryptOrEmpty, encrypt, isEncrypted } from '../utils/crypto'
import type { McpServer } from './types'

/** 没有配置的 env / headers：明文存着就行，不必为它生成密钥（钥匙环可能因此弹框） */
const EMPTY_JSON = '{}'

/** 落库的写法 */
function seal(json: string): string {
  return json === EMPTY_JSON ? json : encrypt(json)
}

/** 读出来的写法：不是密文（`{}`、这一版之前写下的旧行）原样回；解不开读成空对象，界面上显示为空，用户重填 */
function open(stored: string): string {
  return decryptOrEmpty(stored) || EMPTY_JSON
}

function openRow<T extends Partial<Pick<McpServer, 'env' | 'headers'>>>(row: T): T {
  return {
    ...row,
    ...(row.env !== undefined ? { env: open(row.env) } : {}),
    ...(row.headers !== undefined ? { headers: open(row.headers) } : {})
  }
}

/**
 * MCP Server DAO — mcp_servers 表的纯数据访问操作
 *
 * `env` / `headers` 里常有 API token：落库是密文（同 providers.apiKey），经这个 DAO 读写的都是明文 JSON，
 * 调用方不用管。这一版之前写下的行不迁移（用户裁定），下次保存时才变成密文。
 */
export class McpDao extends BaseDao {
  /** 获取所有 MCP Server，按创建时间排序 */
  findAll(): McpServer[] {
    const rows = this.stmt('SELECT * FROM mcp_servers ORDER BY createdAt ASC').all() as McpServer[]
    return rows.map(openRow)
  }

  /** 获取所有已启用的 MCP Server */
  findEnabled(): McpServer[] {
    const rows = this.stmt(
      'SELECT * FROM mcp_servers WHERE isEnabled = 1 ORDER BY createdAt ASC'
    ).all() as McpServer[]
    return rows.map(openRow)
  }

  /** 根据 ID 获取单个 MCP Server */
  findById(id: string): McpServer | undefined {
    const row = this.stmt('SELECT * FROM mcp_servers WHERE id = ?').get(id) as McpServer | undefined
    return row && openRow(row)
  }

  /** 根据名称查找（名称唯一） */
  findByName(name: string): McpServer | undefined {
    const row = this.stmt('SELECT * FROM mcp_servers WHERE name = ?').get(name) as
      | McpServer
      | undefined
    return row && openRow(row)
  }

  /** 按需查询：只 SELECT 指定字段 */
  pick<K extends keyof McpServer>(id: string, fields: K[]): Pick<McpServer, K> | undefined {
    const columns = fields.map((f) => String(f)).join(', ')
    const row = this.stmt(`SELECT ${columns} FROM mcp_servers WHERE id = ?`).get(id) as
      | Pick<McpServer, K>
      | undefined
    return row && openRow(row)
  }

  /** 插入 MCP Server */
  insert(server: McpServer): void {
    this.stmt(
      `INSERT INTO mcp_servers (id, name, type, command, args, env, url, headers, isEnabled, cachedTools, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      server.id,
      server.name,
      server.type,
      server.command,
      server.args,
      seal(server.env),
      server.url,
      seal(server.headers),
      server.isEnabled,
      server.cachedTools || '[]',
      server.createdAt,
      server.updatedAt
    )
  }

  /** 更新 MCP Server */
  update(
    id: string,
    fields: Partial<
      Pick<
        McpServer,
        'name' | 'type' | 'command' | 'args' | 'env' | 'url' | 'headers' | 'isEnabled'
      >
    >
  ): void {
    const sets: string[] = []
    const values: unknown[] = []
    if (fields.name !== undefined) {
      sets.push('name = ?')
      values.push(fields.name)
    }
    if (fields.type !== undefined) {
      sets.push('type = ?')
      values.push(fields.type)
    }
    if (fields.command !== undefined) {
      sets.push('command = ?')
      values.push(fields.command)
    }
    if (fields.args !== undefined) {
      sets.push('args = ?')
      values.push(fields.args)
    }
    if (fields.env !== undefined && !this.wouldEraseUnreadable(id, 'env', fields.env)) {
      sets.push('env = ?')
      values.push(seal(fields.env))
    }
    if (fields.url !== undefined) {
      sets.push('url = ?')
      values.push(fields.url)
    }
    if (fields.headers !== undefined && !this.wouldEraseUnreadable(id, 'headers', fields.headers)) {
      sets.push('headers = ?')
      values.push(seal(fields.headers))
    }
    if (fields.isEnabled !== undefined) {
      sets.push('isEnabled = ?')
      values.push(fields.isEnabled)
    }
    if (sets.length === 0) return
    sets.push('updatedAt = ?')
    values.push(Date.now())
    values.push(id)
    this.db.prepare(`UPDATE mcp_servers SET ${sets.join(', ')} WHERE id = ?`).run(...values)
  }

  /**
   * 这一列是解不开的密文（钥匙环拒绝、换了机器）时，界面读到的是空：把设置对话框存回来的「空」写下去，
   * 钥匙环恢复后也找不回原值了。所以空值不覆盖它（utils/crypto.ts `decryptOrEmpty` 说的那条约定）
   */
  private wouldEraseUnreadable(id: string, column: 'env' | 'headers', next: string): boolean {
    if (next !== EMPTY_JSON) return false
    const row = this.stmt(`SELECT ${column} AS value FROM mcp_servers WHERE id = ?`).get(id) as
      | { value: string }
      | undefined
    return !!row && isEncrypted(row.value) && decryptOrEmpty(row.value) === ''
  }

  /** 更新缓存的工具列表（JSON 字符串） */
  updateCachedTools(id: string, tools: string): void {
    this.stmt('UPDATE mcp_servers SET cachedTools = ? WHERE id = ?').run(tools, id)
  }

  /** 删除 MCP Server（内置 server 不可删除） */
  deleteById(id: string): void {
    this.stmt('DELETE FROM mcp_servers WHERE id = ? AND isBuiltin = 0').run(id)
  }
}

export const mcpDao = new McpDao()
