/**
 * configShareService × `mcp_servers.env` / `headers` 落库加密。
 *
 * configShareService.test.ts 把 mcpDao 整个替掉了，看不见密文；这里 DAO 和 crypto 都是真的（node:sqlite
 * 内存库 + 全部迁移，密钥文件进本文件的临时目录），只替 electron / providerDao / mcpService / appEventBus /
 * logger，分享串走 chat-protocol 的真编解码。要钉住的是：分享串里永远是明文值、绝不出现密文；导入写下去的
 * 永远是密文；导入一条空值不会抹掉解不开的密文。
 *
 *   CSS-1   带敏感值导出密文行：值是真的，分享串（编码前后）里没有密文
 *   CSS-2   不带敏感值：键留着、值是空串，秘密哪儿都找不到
 *   CSS-3   旧明文行两种导出都一样，库里还是明文
 *   CSS-4   解不开的行：导出里没有密文，库里不变
 *   CSS-5   导入新 server：存密文、读回真值；`{}` 还是 `{}`
 *   CSS-6   导入覆盖旧明文行：两列都变密文，装的是导入的值
 *   CSS-7   导入空值覆盖解不开的行：成功、密文不动、别的字段照写
 *   CSS-10  非 inproc 的内置行：合并进密文 env，结果还是密文
 *   CSS-12  往返：导出 → 删行 → 导入，值相同、密文字节不同
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  encodeConfigSharePayload,
  parseConfigSharePayload
} from '@shuvix/chat-protocol/configShareCore'
import type { ConfigSharePayload, ExportedMcpServer } from '@shuvix/chat-protocol/types/configShare'

const holder = vi.hoisted(() => ({ db: null as unknown, configDir: '' }))

vi.mock('electron', () => ({ app: { getVersion: () => '9.9.9' } }))
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
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('../../utils/paths', () => ({ getUserConfigDir: () => holder.configDir }))
vi.mock('../../dao/providerDao', () => ({
  providerDao: {
    findEnabled: vi.fn(() => []),
    findEnabledModels: vi.fn(() => []),
    findAll: vi.fn(() => [])
  }
}))
vi.mock('../../utils/appEventBus', () => ({ appEventBus: { publish: vi.fn() } }))
vi.mock('../mcpService', () => ({ mcpService: { disconnect: vi.fn(async () => {}) } }))

import { mcpDao } from '../../dao/mcpDao'
import { migrations } from '../../dao/migrations'
import type { McpServer } from '../../dao/types'
import { encrypt, installMasterKeyProtector, type MasterKeyProtector } from '../../utils/crypto'
import { configShareService } from '../configShareService'

type Db = Parameters<(typeof migrations)[number]['up']>[0]
type Row = Record<string, unknown>

const ENC = '$SHUVIX_ENC$'
const NAME = 'remote'
const ENV_OBJ = { TOKEN: 'sk-env-secret' }
const HEADERS_OBJ = { Authorization: 'Bearer sk-header-secret' }
const ENV = JSON.stringify(ENV_OBJ)
const HEADERS = JSON.stringify(HEADERS_OBJ)

/** 假的钥匙环（同 utils/__tests__/crypto.test.ts）：把 v2 密文变成「解不开」靠它拒绝 */
function fakeProtector(opts: { deny?: boolean } = {}): MasterKeyProtector {
  const mask = (b: Buffer): Buffer => Buffer.from(b.map((x) => x ^ 0x5a))
  return {
    available: () => true,
    protect: (key) => Buffer.concat([Buffer.from('KC1'), mask(key)]),
    unprotect: (blob) => {
      if (opts.deny) throw new Error('User canceled the keychain prompt')
      return mask(blob.subarray(3))
    }
  }
}

const db = (): DatabaseSync => holder.db as DatabaseSync
const rawByName = (name = NAME): Row =>
  db().prepare('SELECT * FROM mcp_servers WHERE name = ?').get(name) as Row

const server = (over: Partial<McpServer> = {}): McpServer => ({
  id: `id-${over.name ?? NAME}`,
  name: NAME,
  type: 'http',
  command: '',
  args: '[]',
  env: ENV,
  url: 'https://remote.example/mcp',
  headers: HEADERS,
  metadata: '{}',
  isEnabled: 1,
  isBuiltin: 0,
  cachedTools: '[]',
  createdAt: 1,
  updatedAt: 1,
  ...over
})

/** 裸 INSERT：这一版之前写下的行、或内置行（DAO 的 insert 不写 isBuiltin） */
function insertRaw(over: Partial<McpServer> = {}): void {
  const row = server(over)
  const cols = Object.keys(row)
  db()
    .prepare(`INSERT INTO mcp_servers (${cols.join(', ')}) VALUES (${cols.map(() => '?').join()})`)
    .run(...(Object.values(row) as Array<string | number>))
}

/** 造一行解不开的值：钥匙环可用时写下 v2，然后钥匙环开始拒绝 */
function insertUnreadable(over: Partial<McpServer> = {}): void {
  installMasterKeyProtector(fakeProtector())
  mcpDao.insert(server(over))
  expect(String(rawByName().env).startsWith(`${ENC}v2$`)).toBe(true)
  installMasterKeyProtector(fakeProtector({ deny: true }))
}

function exported(
  name: string,
  includeSensitive: boolean
): { encoded: string; text: string; payload: ConfigSharePayload; entry: ExportedMcpServer } {
  const encoded = configShareService.buildExportPayload({
    providers: [],
    mcpServers: [{ name, includeSensitive }]
  })
  const payload = parseConfigSharePayload(encoded)
  const entry = payload.mcpServers?.find((s) => s.name === name)
  if (!entry) throw new Error(`${name} missing from the export`)
  return { encoded, text: JSON.stringify(payload), payload, entry }
}

const entry = (over: Partial<ExportedMcpServer> = {}): ExportedMcpServer => ({
  name: NAME,
  type: 'http',
  command: null,
  args: [],
  env: ENV_OBJ,
  url: 'https://imported.example/mcp',
  headers: HEADERS_OBJ,
  metadata: null,
  sensitiveStripped: false,
  isBuiltin: false,
  ...over
})

/** 走真编解码导入 */
function importEntries(
  entries: ExportedMcpServer[]
): ReturnType<typeof configShareService.applyImportPayload> {
  const payload = parseConfigSharePayload(
    encodeConfigSharePayload({
      version: 1,
      exportedAt: '2026-11-02T00:00:00.000Z',
      appVersion: '9.9.9',
      mcpServers: entries
    })
  )
  return configShareService.applyImportPayload(payload, {
    providerNames: [],
    modelKeys: [],
    mcpNames: entries.map((e) => e.name)
  })
}

beforeAll(() => {
  holder.configDir = mkdtempSync(join(tmpdir(), 'shuvix-config-share-test-'))
})

afterAll(() => {
  rmSync(holder.configDir, { recursive: true, force: true })
})

beforeEach(() => {
  vi.clearAllMocks()
  delete process.env.SHUVIX_ENCRYPTION
  installMasterKeyProtector(null)
  const fresh = new DatabaseSync(':memory:')
  for (const m of migrations) m.up(fresh as unknown as Db)
  fresh.exec('DELETE FROM mcp_servers')
  holder.db = fresh
})

describe('导出', () => {
  it('CSS-1 带敏感值导出密文行：值是真的、sensitiveStripped 为 false，分享串里没有密文', () => {
    mcpDao.insert(server())
    expect(String(rawByName().env).startsWith(ENC)).toBe(true)

    const { encoded, text, entry: out } = exported(NAME, true)

    expect(out.env).toEqual(ENV_OBJ)
    expect(out.headers).toEqual(HEADERS_OBJ)
    expect(out.sensitiveStripped).toBe(false)
    expect(encoded).not.toContain(ENC)
    expect(text).not.toContain(ENC)
  })

  it('CSS-2 不带敏感值：键留着、值是空串、sensitiveStripped 为 true，秘密哪儿都找不到', () => {
    mcpDao.insert(server())

    const { text, entry: out } = exported(NAME, false)

    expect(out.env).toEqual({ TOKEN: '' })
    expect(out.headers).toEqual({ Authorization: '' })
    expect(out.sensitiveStripped).toBe(true)
    expect(text).not.toContain('sk-env-secret')
    expect(text).not.toContain('sk-header-secret')
    expect(text).not.toContain(ENC)
  })

  it('CSS-3 旧明文行：两种导出都和密文行一样，库里还是明文', () => {
    insertRaw()

    const full = exported(NAME, true)
    expect(full.entry.env).toEqual(ENV_OBJ)
    expect(full.entry.headers).toEqual(HEADERS_OBJ)
    expect(full.entry.sensitiveStripped).toBe(false)

    const stripped = exported(NAME, false)
    expect(stripped.entry.env).toEqual({ TOKEN: '' })
    expect(stripped.entry.headers).toEqual({ Authorization: '' })
    expect(stripped.entry.sensitiveStripped).toBe(true)
    expect(stripped.text).not.toContain('sk-env-secret')

    expect(rawByName()).toMatchObject({ env: ENV, headers: HEADERS })
  })

  it.each([
    ['带敏感值', true],
    ['不带敏感值', false]
  ])('CSS-4 解不开的行（%s）：导出里没有密文，库里不变', (_label, includeSensitive) => {
    insertUnreadable()
    const before = rawByName()

    const { encoded, text, entry: out } = exported(NAME, includeSensitive)

    expect(out.env).toEqual({})
    expect(out.headers).toEqual({})
    expect(encoded).not.toContain(ENC)
    expect(text).not.toContain(ENC)
    expect(rawByName()).toEqual(before)
  })
})

describe('导入', () => {
  it('CSS-5 新 server：存密文、读回真值；没有值的那台还是 `{}`', async () => {
    const result = await importEntries([
      entry(),
      entry({ name: 'bare', env: {}, headers: {}, url: 'https://bare.example/mcp' })
    ])
    expect(result.mcpServers).toEqual([
      { name: NAME, ok: true },
      { name: 'bare', ok: true }
    ])

    const { env, headers } = rawByName() as { env: string; headers: string }
    expect(env.startsWith(ENC)).toBe(true)
    expect(headers.startsWith(ENC)).toBe(true)
    expect(env).not.toContain('sk-env-secret')
    expect(headers).not.toContain('sk-header-secret')
    expect(mcpDao.findByName(NAME)).toMatchObject({ env: ENV, headers: HEADERS })

    expect(rawByName('bare')).toMatchObject({ env: '{}', headers: '{}' })
    expect(mcpDao.findByName('bare')).toMatchObject({ env: '{}', headers: '{}' })
  })

  it('CSS-6 覆盖旧明文行：两列都变密文，装的是导入的值', async () => {
    insertRaw({ env: '{"TOKEN":"legacy"}', headers: '{"Authorization":"Bearer legacy"}' })

    const result = await importEntries([entry()])
    expect(result.mcpServers).toEqual([{ name: NAME, ok: true }])

    const { env, headers } = rawByName() as { env: string; headers: string }
    expect(env.startsWith(ENC)).toBe(true)
    expect(headers.startsWith(ENC)).toBe(true)
    expect(env).not.toContain('legacy')
    expect(headers).not.toContain('legacy')
    expect(mcpDao.findByName(NAME)).toMatchObject({ env: ENV, headers: HEADERS })
  })

  it('CSS-7 空 env / headers 覆盖解不开的行：成功，密文不动，别的字段照写', async () => {
    insertUnreadable({ isEnabled: 0 })
    const { env, headers } = rawByName()

    const result = await importEntries([
      entry({ env: {}, headers: {}, url: 'https://imported.example/mcp' })
    ])

    expect(result.mcpServers).toEqual([{ name: NAME, ok: true }])
    expect(rawByName()).toMatchObject({
      env,
      headers,
      url: 'https://imported.example/mcp',
      isEnabled: 1
    })
  })

  it('CSS-10 非 inproc 的内置行：只接受有值的键，合并进原来的密文 env，结果还是密文', async () => {
    const stored = encrypt('{"KEEP":"k"}')
    expect(stored.startsWith(ENC)).toBe(true)
    insertRaw({ name: 'search', id: 'builtin-search', isBuiltin: 1, env: stored, headers: '{}' })

    const result = await importEntries([
      entry({
        name: 'search',
        isBuiltin: true,
        env: { A: '1', KEEP: '' },
        headers: null,
        url: null
      })
    ])

    expect(result.mcpServers).toEqual([{ name: 'search', ok: true }])
    expect(mcpDao.findByName('search')!.env).toBe('{"KEEP":"k","A":"1"}')
    const raw = rawByName('search') as { env: string }
    expect(raw.env.startsWith(ENC)).toBe(true)
    expect(raw.env).not.toBe(stored)
    expect(raw.env).not.toContain('KEEP')
  })

  it('CSS-12 往返：带敏感值导出 → 删行 → 导入，值相同，密文字节不同', async () => {
    mcpDao.insert(server())
    const before = rawByName()
    const { entry: out } = exported(NAME, true)

    mcpDao.deleteById(String(before.id))
    expect(mcpDao.findByName(NAME)).toBeUndefined()
    const result = await importEntries([out])
    expect(result.mcpServers).toEqual([{ name: NAME, ok: true }])

    expect(mcpDao.findByName(NAME)).toMatchObject({ env: ENV, headers: HEADERS })
    const after = rawByName()
    expect(String(after.env).startsWith(ENC)).toBe(true)
    expect(String(after.headers).startsWith(ENC)).toBe(true)
    expect(after.env).not.toBe(before.env)
    expect(after.headers).not.toBe(before.headers)
  })
})
