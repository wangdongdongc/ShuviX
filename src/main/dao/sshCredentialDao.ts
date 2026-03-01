import { v7 as uuidv7 } from 'uuid'
import { BaseDao } from './database'
import { encrypt, decrypt } from '../services/crypto'
import type { SshCredential } from './types'

/** 解密凭据中的敏感字段 */
function decryptCredential<T extends SshCredential | undefined>(c: T): T {
  if (!c) return c
  return {
    ...c,
    password: decrypt(c.password),
    privateKey: decrypt(c.privateKey),
    passphrase: decrypt(c.passphrase)
  } as T
}

/**
 * SSH Credential DAO — ssh_credentials 表的纯数据访问操作
 * 敏感字段（password / privateKey / passphrase）加密存储
 */
export class SshCredentialDao extends BaseDao {
  /** 获取所有凭据（解密） */
  findAll(): SshCredential[] {
    const rows = this.db
      .prepare('SELECT * FROM ssh_credentials ORDER BY createdAt ASC')
      .all() as SshCredential[]
    return rows.map(decryptCredential)
  }

  /** 根据 ID 获取凭据（解密） */
  findById(id: string): SshCredential | undefined {
    const row = this.db.prepare('SELECT * FROM ssh_credentials WHERE id = ?').get(id) as
      | SshCredential
      | undefined
    return decryptCredential(row)
  }

  /** 根据名称获取凭据（解密） */
  findByName(name: string): SshCredential | undefined {
    const row = this.db.prepare('SELECT * FROM ssh_credentials WHERE name = ?').get(name) as
      | SshCredential
      | undefined
    return decryptCredential(row)
  }

  /** 仅获取所有凭据名称（无需解密，供工具描述注入） */
  findAllNames(): string[] {
    const rows = this.db
      .prepare('SELECT name FROM ssh_credentials ORDER BY createdAt ASC')
      .all() as { name: string }[]
    return rows.map((r) => r.name)
  }

  /** 插入凭据（敏感字段加密），返回 id */
  insert(credential: {
    name: string
    host: string
    port: number
    username: string
    authType: string
    password?: string
    privateKey?: string
    passphrase?: string
  }): string {
    const existing = this.db
      .prepare('SELECT id FROM ssh_credentials WHERE name = ?')
      .get(credential.name)
    if (existing) {
      throw new Error(`SSH credential name "${credential.name}" already exists`)
    }
    const id = uuidv7()
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO ssh_credentials (id, name, host, port, username, authType, password, privateKey, passphrase, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        credential.name,
        credential.host,
        credential.port,
        credential.username,
        credential.authType,
        encrypt(credential.password || ''),
        encrypt(credential.privateKey || ''),
        encrypt(credential.passphrase || ''),
        now,
        now
      )
    return id
  }

  /** 更新凭据（敏感字段重新加密） */
  update(
    id: string,
    fields: Partial<{
      name: string
      host: string
      port: number
      username: string
      authType: string
      password: string
      privateKey: string
      passphrase: string
    }>
  ): void {
    const sets: string[] = []
    const values: unknown[] = []
    if (fields.name !== undefined) {
      sets.push('name = ?')
      values.push(fields.name)
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
    if (fields.authType !== undefined) {
      sets.push('authType = ?')
      values.push(fields.authType)
    }
    if (fields.password !== undefined) {
      sets.push('password = ?')
      values.push(encrypt(fields.password))
    }
    if (fields.privateKey !== undefined) {
      sets.push('privateKey = ?')
      values.push(encrypt(fields.privateKey))
    }
    if (fields.passphrase !== undefined) {
      sets.push('passphrase = ?')
      values.push(encrypt(fields.passphrase))
    }
    if (sets.length === 0) return
    sets.push('updatedAt = ?')
    values.push(Date.now())
    values.push(id)
    this.db.prepare(`UPDATE ssh_credentials SET ${sets.join(', ')} WHERE id = ?`).run(...values)
  }

  /** 删除凭据 */
  deleteById(id: string): void {
    this.db.prepare('DELETE FROM ssh_credentials WHERE id = ?').run(id)
  }
}

export const sshCredentialDao = new SshCredentialDao()
