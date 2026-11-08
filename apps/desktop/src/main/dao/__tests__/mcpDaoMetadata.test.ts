/**
 * McpDao 的 metadata 列 —— 几方各写各的键（设置页的 cwd、McpManager 记住的 transport、addedBy……），
 * 所以写入一律**并进**已有的对象：给了值的键覆盖，undefined 的键删掉，没提到的键原样留着。
 * 明文存（不放 secret），也不碰 env / headers 的密文。
 *
 *   MD-1  insert 把 metadata 原样落库；空串落成 `{}`
 *   MD-2  update 的 metadata 是一次改动：并进去、别的键留着，算一次配置变更（updatedAt 前进）
 *   MD-3  undefined 删掉那个键；空改动不写库
 *   MD-4  mergeMetadata 只并 metadata，不动 updatedAt；行不存在什么也不做
 *   MD-5  读不懂的旧值（坏 JSON、数组、NULL 以外的怪东西）当空对象并
 *   MD-6  改 metadata 不碰 env / headers 的密文字节
 *
 * 与 mcpDaoSecrets.test.ts 同一套底座：真的 SQLite（node:sqlite 内存库 + 全部迁移）+ 真的 crypto.ts，
 * 密钥文件进每条用例自己的临时目录。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpDao } from '../mcpDao'
import type { McpServer } from '../types'

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

type Db = Parameters<(typeof migrations)[number]['up']>[0]
type Row = Record<string, unknown>

const ID = 'srv-1'
const T0 = 1_000
const T1 = 2_000

let dao: McpDao

const db = (): DatabaseSync => holder.db as DatabaseSync

/** 一行的全部字节（裸 SELECT，不经 DAO） */
const raw = (id = ID): Row => db().prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as Row

const metadataOf = (id = ID): unknown => JSON.parse(raw(id).metadata as string)

const server = (over: Partial<McpServer> = {}): McpServer => ({
  id: ID,
  name: 'srv-one',
  type: 'stdio',
  command: 'npx',
  args: '[]',
  env: '{"TOKEN":"sk-env"}',
  url: '',
  headers: '{"Authorization":"Bearer sk-h"}',
  metadata: '{}',
  isEnabled: 1,
  isBuiltin: 0,
  cachedTools: '[]',
  createdAt: T0,
  updatedAt: T0,
  ...over
})

/** 裸改 metadata 列（这一版之前、或别的写者留下的值） */
const setRawMetadata = (value: string, id = ID): void => {
  db().prepare('UPDATE mcp_servers SET metadata = ? WHERE id = ?').run(value, id)
}

beforeEach(async () => {
  holder.configDir = mkdtempSync(join(tmpdir(), 'shuvix-mcp-dao-metadata-'))
  delete process.env.SHUVIX_ENCRYPTION
  const fresh = new DatabaseSync(':memory:')
  for (const m of migrations) m.up(fresh as unknown as Db)
  fresh.exec('DELETE FROM mcp_servers')
  holder.db = fresh
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
  vi.resetModules()
  dao = (await import('../mcpDao')).mcpDao
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(holder.configDir, { recursive: true, force: true })
})

describe('insert', () => {
  it('MD-1 metadata 原样落库（明文），读回原样；空串落成 `{}`', () => {
    dao.insert(server({ metadata: '{"cwd":"/srv/tools"}' }))
    expect(raw().metadata).toBe('{"cwd":"/srv/tools"}')
    expect(dao.findById(ID)?.metadata).toBe('{"cwd":"/srv/tools"}')

    dao.insert(server({ id: 'srv-2', name: 'srv-two', metadata: '' }))
    expect(raw('srv-2').metadata).toBe('{}')
  })
})

describe('update 的 metadata', () => {
  it('MD-2 并进去：别的键留着；算一次配置变更，updatedAt 前进', () => {
    dao.insert(server({ metadata: '{"transport":"sse","addedBy":"agent"}' }))
    vi.setSystemTime(T1)

    dao.update(ID, { metadata: { cwd: '/srv/tools' } })

    expect(metadataOf()).toEqual({ transport: 'sse', addedBy: 'agent', cwd: '/srv/tools' })
    expect(raw().updatedAt).toBe(T1)

    dao.update(ID, { metadata: { cwd: '/srv/other' }, command: 'uvx' })
    expect(metadataOf()).toEqual({ transport: 'sse', addedBy: 'agent', cwd: '/srv/other' })
    expect(raw().command).toBe('uvx')
  })

  it('MD-3 undefined 删掉那个键；空改动（只有 `{}`）不写库', () => {
    dao.insert(server({ metadata: '{"transport":"sse","cwd":"/srv/tools"}' }))

    dao.update(ID, { metadata: { transport: undefined } })
    expect(metadataOf()).toEqual({ cwd: '/srv/tools' })

    vi.setSystemTime(T1)
    dao.update(ID, { metadata: {} })
    expect(raw().updatedAt).toBe(T0)
    expect(metadataOf()).toEqual({ cwd: '/srv/tools' })
  })
})

describe('mergeMetadata', () => {
  it('MD-4 只并 metadata，不动 updatedAt（运行时学到的，不是用户改了配置）', () => {
    dao.insert(server({ metadata: '{"cwd":"/srv/tools"}' }))
    vi.setSystemTime(T1)

    dao.mergeMetadata(ID, { transport: 'sse' })
    expect(metadataOf()).toEqual({ cwd: '/srv/tools', transport: 'sse' })

    dao.mergeMetadata(ID, { transport: undefined })
    expect(metadataOf()).toEqual({ cwd: '/srv/tools' })
    expect(raw().updatedAt).toBe(T0)
  })

  it('MD-4b 行不存在：什么也不做、不抛、不造行', () => {
    expect(() => dao.mergeMetadata('nope', { transport: 'sse' })).not.toThrow()
    expect((db().prepare('SELECT COUNT(*) AS n FROM mcp_servers').get() as { n: number }).n).toBe(0)
  })

  it.each(['not json', '[1,2]', '"text"', '42', 'null', ''])(
    'MD-5 读不懂的旧值 %j 当空对象并（两条写路径一样）',
    (stored) => {
      dao.insert(server())
      setRawMetadata(stored)
      dao.mergeMetadata(ID, { transport: 'sse' })
      expect(metadataOf()).toEqual({ transport: 'sse' })

      setRawMetadata(stored)
      dao.update(ID, { metadata: { cwd: '/a' } })
      expect(metadataOf()).toEqual({ cwd: '/a' })
    }
  )
})

describe('与密文列互不相干', () => {
  it('MD-6 改 metadata 不碰 env / headers 的密文字节，读回仍是原值', () => {
    dao.insert(server())
    const before = raw()
    expect(String(before.env)).toMatch(/^\$SHUVIX_ENC\$/)

    dao.update(ID, { metadata: { cwd: '/srv/tools' } })
    dao.mergeMetadata(ID, { transport: 'sse' })

    const after = raw()
    expect(after.env).toBe(before.env)
    expect(after.headers).toBe(before.headers)
    expect(dao.findById(ID)).toMatchObject({
      env: '{"TOKEN":"sk-env"}',
      headers: '{"Authorization":"Bearer sk-h"}'
    })
  })
})
