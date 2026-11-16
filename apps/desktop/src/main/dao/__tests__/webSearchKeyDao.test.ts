/**
 * WebSearchKeyDao —— 商业搜索 API 的密钥（`web_search_keys`，一家一行）：落库是密文，经 DAO 读写的是明文；
 * 没存、解不开都读成空串；只写这一张表（settings 表是明文，密钥不进去）。
 *
 * 在**真的 SQLite**（node:sqlite 内存库 + 全部迁移）和**真的 crypto.ts** 上跑，密钥文件进每条用例自己的临时
 * 目录（同 mcpDaoSecrets.test）。crypto.ts 的主密钥是模块状态，所以每条用例重新载入 DAO 与 crypto（`load()`）；
 * 同一个目录同一个库上再 `load()` 一次，就是重启。
 *
 *   WK-1  set 存密文，find 读回原样，updatedAt 是当时
 *   WK-2  没存 → 空串
 *   WK-3  同一家存两次：一行，后一次的值
 *   WK-4  删一家不动另一家；再删一次不抛
 *   WK-5  解不开（坏密文、别的主密钥加的密）→ 空串，不抛
 *   WK-6  重启后读得回
 *   WK-7  只写 web_search_keys，settings 表不动
 *   WK-8  字节级往返（非 ASCII、引号、4 KB）
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebSearchKeyDao } from '../webSearchKeyDao'

const holder = vi.hoisted(() => ({ db: null as unknown, configDir: '' }))

vi.mock('../database', () => {
  class BaseDao {
    protected get db(): { prepare: (sql: string) => unknown } {
      return holder.db as { prepare: (sql: string) => unknown }
    }
    protected stmt(sql: string): unknown {
      return (holder.db as { prepare: (sql: string) => unknown }).prepare(sql)
    }
  }
  return { BaseDao, databaseManager: { getDb: () => holder.db } }
})
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))
// 密钥文件放进每条用例自己的临时目录（绝不碰 ~/.shuvix）
vi.mock('../../utils/paths', () => ({ getUserConfigDir: () => holder.configDir }))

import { migrations } from '../migrations'

type Crypto = typeof import('../../utils/crypto')
type Db = Parameters<(typeof migrations)[number]['up']>[0]
type Row = { provider: string; apiKey: string; updatedAt: number }

const KEY = ['tvly', 'SECRETSECRET', '1234'].join('-')
const EXA_KEY = ['exa', 'ANOTHERSECRET', '9876'].join('-')
const T0 = 1_700_000_000_000

let dao: WebSearchKeyDao
let crypto: Crypto
const dirs: string[] = []

async function load(): Promise<void> {
  vi.resetModules()
  crypto = await import('../../utils/crypto')
  dao = (await import('../webSearchKeyDao')).webSearchKeyDao
}

function newConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'shuvix-web-search-key-test-'))
  dirs.push(dir)
  return dir
}

const db = (): DatabaseSync => holder.db as DatabaseSync
const raw = (provider: string): Row | undefined =>
  db().prepare('SELECT * FROM web_search_keys WHERE provider = ?').get(provider) as Row | undefined
const count = (table: string): number =>
  (db().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n

beforeEach(async () => {
  holder.configDir = newConfigDir()
  delete process.env.SHUVIX_ENCRYPTION
  const fresh = new DatabaseSync(':memory:')
  for (const m of migrations) m.up(fresh as unknown as Db)
  holder.db = fresh
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
  await load()
})

afterEach(() => {
  vi.useRealTimers()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  delete process.env.SHUVIX_ENCRYPTION
})

describe('WebSearchKeyDao', () => {
  it('WK-1 set stores ciphertext; find gives the key back; updatedAt is the time of writing', () => {
    dao.set('tavily', KEY)
    const row = raw('tavily')!
    expect(row.apiKey).not.toBe(KEY)
    expect(row.apiKey).not.toContain(KEY)
    expect(crypto.isEncrypted(row.apiKey)).toBe(true)
    expect(row.updatedAt).toBe(T0)
    expect(dao.find('tavily')).toBe(KEY)
  })

  it('WK-2 nothing stored reads as an empty string', () => {
    expect(dao.find('exa')).toBe('')
    expect(dao.find('tavily')).toBe('')
  })

  it('WK-3 a second set replaces the row', () => {
    dao.set('tavily', KEY)
    vi.setSystemTime(T0 + 5_000)
    const second = ['tvly', 'REPLACEMENT', 'abcd'].join('-')
    dao.set('tavily', second)
    expect(count('web_search_keys')).toBe(1)
    expect(dao.find('tavily')).toBe(second)
    expect(raw('tavily')!.updatedAt).toBe(T0 + 5_000)
    expect(raw('tavily')!.apiKey).not.toContain(second)
  })

  it('WK-4 delete removes one provider only; deleting again does not throw', () => {
    dao.set('tavily', KEY)
    dao.set('exa', EXA_KEY)
    dao.delete('tavily')
    expect(dao.find('tavily')).toBe('')
    expect(dao.find('exa')).toBe(EXA_KEY)
    expect(() => dao.delete('tavily')).not.toThrow()
    expect(count('web_search_keys')).toBe(1)
  })

  it('WK-5 a value that cannot be decrypted reads as an empty string', async () => {
    dao.set('tavily', KEY)
    db()
      .prepare('INSERT INTO web_search_keys (provider, apiKey, updatedAt) VALUES (?, ?, ?)')
      .run('exa', '$SHUVIX_ENC$v1$not-a-real-ciphertext', T0)
    expect(dao.find('exa')).toBe('')
    expect(dao.find('tavily')).toBe(KEY)

    // 换了主密钥（新的配置目录）：原来的密文解不开
    holder.configDir = newConfigDir()
    await load()
    expect(() => dao.find('tavily')).not.toThrow()
    expect(dao.find('tavily')).toBe('')
  })

  it('WK-6 the key is still readable after a restart', async () => {
    dao.set('tavily', KEY)
    await load()
    expect(dao.find('tavily')).toBe(KEY)
  })

  it('WK-7 only web_search_keys is written: the settings table stays as it was', () => {
    const before = db().prepare('SELECT * FROM settings ORDER BY key').all()
    dao.set('tavily', KEY)
    dao.set('exa', EXA_KEY)
    const after = db().prepare('SELECT * FROM settings ORDER BY key').all()
    expect(after).toEqual(before)
    const text = JSON.stringify(after)
    expect(text).not.toContain(KEY)
    expect(text).not.toContain(EXA_KEY)
    expect(text).not.toContain(raw('tavily')!.apiKey)
  })

  it.each<[string, string]>([
    ['non-ASCII', `${KEY}-密钥-ключ-🔑`],
    ['quotes', `${KEY}-"double"-'single'-\`back\`-\\`],
    ['4 KB', `${KEY}-${'k'.repeat(4096)}`]
  ])('WK-8 %s round-trips exactly', (_label, value) => {
    dao.set('exa', value)
    expect(dao.find('exa')).toBe(value)
    expect(raw('exa')!.apiKey).not.toContain(KEY)
  })
})
