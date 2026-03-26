import { v7 as uuidv7 } from 'uuid'
import { BaseDao } from './database'
import { encrypt, decrypt } from '../utils/crypto'
import type { DbAuthType, DbCredential, DbCredentialMetadata, DbType } from './types'

/** DB 原始行类型（readonly 为 0/1 整数，metadata 为 JSON 字符串） */
type DbCredentialRow = Omit<DbCredential, 'readonly' | 'metadata'> & {
  readonly: number
  metadata: string
}

function parseRow(row: DbCredentialRow): DbCredential {
  return {
    ...row,
    password: decrypt(row.password),
    token: decrypt(row.token),
    connStr: decrypt(row.connStr),
    readonly: row.readonly === 1,
    metadata: JSON.parse(row.metadata || '{}') as DbCredentialMetadata
  }
}

/**
 * DB Credential DAO — db_credentials 表的纯数据访问操作
 * password 字段加密存储
 */
export class DbCredentialDao extends BaseDao {
  /** 获取所有凭据（解密） */
  findAll(): DbCredential[] {
    const rows = this.stmt(
      'SELECT * FROM db_credentials ORDER BY createdAt ASC'
    ).all() as DbCredentialRow[]
    return rows.map(parseRow)
  }

  /** 获取所有凭据（剥离 password，供 UI 展示） */
  findAllSafe(): Omit<DbCredential, 'password'>[] {
    const rows = this.stmt(
      'SELECT id, name, dbType, host, port, username, database, readonly, metadata, createdAt, updatedAt FROM db_credentials ORDER BY createdAt ASC'
    ).all() as Omit<DbCredentialRow, 'password'>[]
    return rows.map((r) => ({
      ...r,
      readonly: r.readonly === 1,
      metadata: JSON.parse(r.metadata || '{}') as DbCredentialMetadata
    }))
  }

  /** 获取所有凭据的名称 + 类型 + 只读标志（供工具描述注入） */
  findAllNamesWithType(): Array<{ name: string; dbType: DbType; readonly: boolean }> {
    const rows = this.stmt(
      'SELECT name, dbType, readonly FROM db_credentials ORDER BY createdAt ASC'
    ).all() as Array<{ name: string; dbType: DbType; readonly: number }>
    return rows.map((r) => ({ ...r, readonly: r.readonly === 1 }))
  }

  /** 根据名称获取凭据（解密） */
  findByName(name: string): DbCredential | undefined {
    const row = this.stmt('SELECT * FROM db_credentials WHERE name = ?').get(name) as
      | DbCredentialRow
      | undefined
    return row ? parseRow(row) : undefined
  }

  /** 插入凭据（password / token / connStr 加密），返回 id */
  insert(credential: {
    name: string
    dbType: DbType
    host?: string
    port?: number
    username?: string
    password?: string
    database?: string
    authType?: DbAuthType
    token?: string
    connStr?: string
    readonly?: boolean
    metadata?: DbCredentialMetadata
  }): string {
    const existing = this.stmt('SELECT id FROM db_credentials WHERE name = ?').get(credential.name)
    if (existing) {
      throw new Error(`DB credential name "${credential.name}" already exists`)
    }
    const id = uuidv7()
    const now = Date.now()
    this.stmt(
      `INSERT INTO db_credentials
         (id, name, dbType, host, port, username, password, database, authType, token, connStr, readonly, metadata, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      credential.name,
      credential.dbType,
      credential.host ?? '',
      credential.port ?? 0,
      credential.username ?? '',
      encrypt(credential.password ?? ''),
      credential.database ?? '',
      credential.authType ?? 'password',
      encrypt(credential.token ?? ''),
      encrypt(credential.connStr ?? ''),
      credential.readonly !== false ? 1 : 0,
      JSON.stringify(credential.metadata ?? {}),
      now,
      now
    )
    return id
  }

  /** 更新凭据（password / token / connStr 重新加密） */
  update(
    id: string,
    fields: Partial<{
      name: string
      dbType: DbType
      host: string
      port: number
      username: string
      password: string
      database: string
      authType: DbAuthType
      token: string
      connStr: string
      readonly: boolean
      metadata: DbCredentialMetadata
    }>
  ): void {
    const sets: string[] = []
    const values: unknown[] = []
    if (fields.name !== undefined) {
      sets.push('name = ?')
      values.push(fields.name)
    }
    if (fields.dbType !== undefined) {
      sets.push('dbType = ?')
      values.push(fields.dbType)
    }
    if (fields.host !== undefined) {
      sets.push('host = ?')
      values.push(fields.host)
    }
    if (fields.port !== undefined) {
      sets.push('port = ?')
      values.push(fields.port)
    }
    if (fields.username !== undefined) {
      sets.push('username = ?')
      values.push(fields.username)
    }
    if (fields.password !== undefined) {
      sets.push('password = ?')
      values.push(encrypt(fields.password))
    }
    if (fields.database !== undefined) {
      sets.push('database = ?')
      values.push(fields.database)
    }
    if (fields.authType !== undefined) {
      sets.push('authType = ?')
      values.push(fields.authType)
    }
    if (fields.token !== undefined) {
      sets.push('token = ?')
      values.push(encrypt(fields.token))
    }
    if (fields.connStr !== undefined) {
      sets.push('connStr = ?')
      values.push(encrypt(fields.connStr))
    }
    if (fields.readonly !== undefined) {
      sets.push('readonly = ?')
      values.push(fields.readonly ? 1 : 0)
    }
    if (fields.metadata !== undefined) {
      sets.push('metadata = ?')
      values.push(JSON.stringify(fields.metadata))
    }
    if (sets.length === 0) return
    sets.push('updatedAt = ?')
    values.push(Date.now())
    values.push(id)
    this.db.prepare(`UPDATE db_credentials SET ${sets.join(', ')} WHERE id = ?`).run(...values)
  }

  /** 删除凭据 */
  deleteById(id: string): void {
    this.stmt('DELETE FROM db_credentials WHERE id = ?').run(id)
  }
}

export const dbCredentialDao = new DbCredentialDao()
