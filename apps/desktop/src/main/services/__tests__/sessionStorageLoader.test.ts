/**
 * D10-08 —— node:sqlite 只在第一次真要打开新格式会话时加载，且加载之前警告过滤已经装上（Q20）。
 *
 * 适配器模块（`@earendil-works/pi-durable/storage/sqlite/node`，它在模块顶层 import node:sqlite）换成
 * 一个数加载次数的工厂：加载那一刻顺手记下过滤器装没装。工厂穿透到真件，打开的是临时目录里的真文件。
 * 单独一个文件：这个 mock 对整个文件生效。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { backgroundContext } from '@shuvix/agent-runtime'

const holder = vi.hoisted(() => ({
  db: null as unknown,
  sessionsDir: '',
  loads: 0,
  filterAtLoad: [] as boolean[]
}))

vi.mock('@earendil-works/pi-durable/storage/sqlite/node', async (importOriginal) => {
  holder.loads++
  const { sqliteWarningFilterInstalled } = await import('../../utils/nodeWarnings')
  holder.filterAtLoad.push(sqliteWarningFilterInstalled())
  return importOriginal()
})
vi.mock('../../dao/database', () => {
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
vi.mock('../../utils/paths', () => ({ getSessionsDir: () => holder.sessionsDir }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

import { migrations } from '../../dao/migrations'
import type { Session } from '../../dao/types'
import { sessionRecords } from '../sessionRecords'
import { openSessionStorage } from '../sessionStorage'

type Db = Parameters<(typeof migrations)[number]['up']>[0]

function session(id: string): Session {
  return {
    id,
    title: id,
    projectId: null,
    parentId: null,
    storageKind: 'durable-sqlite-1',
    settings: {},
    createdAt: 1,
    updatedAt: 1,
    lastActiveAt: 1
  }
}

beforeEach(() => {
  const db = new DatabaseSync(':memory:')
  for (const m of migrations) m.up(db as unknown as Db)
  holder.db = db
  holder.sessionsDir = mkdtempSync(join(tmpdir(), 'shuvix-loader-'))
})

afterEach(() => {
  rmSync(holder.sessionsDir, { recursive: true, force: true })
})

describe('D10-08 动态加载与过滤器的先后', () => {
  it('D10-08 import 不加载；内存会话不加载；第一次新格式打开恰加载一次（过滤器已装）；之后不再加载', async () => {
    // import sessionStorage 本身没有加载适配器
    expect(holder.loads).toBe(0)

    sessionRecords.insert(session('e1'), { ephemeral: true })
    const memory = await openSessionStorage('e1')
    await memory.close(backgroundContext)
    expect(holder.loads).toBe(0)

    sessionRecords.insert(session('d1'))
    const first = await openSessionStorage('d1')
    expect(holder.loads).toBe(1)
    expect(holder.filterAtLoad).toEqual([true])
    await first.close(backgroundContext)

    sessionRecords.insert(session('d2'))
    const second = await openSessionStorage('d2')
    await second.close(backgroundContext)
    expect(holder.loads).toBe(1)
  })

  it('D10-08 静态：sessionStorage.ts 不静态 import node:sqlite 或适配器，只有 import(…)', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../sessionStorage.ts', import.meta.url)),
      'utf-8'
    )
    expect(source).not.toMatch(/^import[^\n]*['"]node:sqlite['"]/m)
    expect(source).not.toMatch(/^import[^\n]*storage\/sqlite\/node['"]/m)
    expect(source).not.toMatch(/from\s+['"]@earendil-works\/pi-durable\/storage\/sqlite\/node['"]/)
    expect(source).toMatch(/await import\(\s*['"]@earendil-works\/pi-durable\/storage\/sqlite\/node['"]\s*\)/)
  })
})
