/**
 * providerCredentialPort —— 模型层看 provider 表的端口，跑在**真的** ProviderDao + 真 SQL 上
 * （node:sqlite 内存库，迁移从 v1 跑起，同 dao 的迁移测试）与真的加密（utils/crypto，密钥文件放
 * 临时目录）。better-sqlite3 是给 Electron 编的，Node 单测加载不了，所以只把 BaseDao 的连接换掉。
 *
 *   PCP-1  listProviders：所有行（含停用）、布尔位、解密后的 key、无 key → ''、不带 oauth 列；与 findAll 同序
 *   PCP-2  某一行的 key 解不开 → 那一行读成 ''，其余行照常
 *   PCP-3  listModels：所有 provider 的所有模型行（含停用）、布尔位、capabilities 原文、NULL → ''
 *   PCP-4  saveOAuth(json) → readOAuth 逐字节返回原文：type 与 provider 自带的额外字段都在
 *   PCP-5  落库格式不变：oauth 列是 `$SHUVIX_ENC$v1$` 密文、不含令牌明文，decrypt 回来 = 原文
 *   PCP-6  旧记录（上一代写入口存的 {access, refresh, expires}，没有 type）照读；经凭据库读作 OAuth
 *   PCP-7  没有记录 / 密文解不开 → undefined（不抛）
 *   PCP-8  clearOAuth：记录没了、API key 不动、对外视图 oauthConnected 归 0
 *   PCP-9  saveApiKey → 加密落库，listProviders 读到新 key
 *   PCP-10 对外视图（经 IPC 给渲染进程的那份）只有 oauthConnected 一位，从不带凭据
 *
 *   ADR-1  内置行 id 是 uuid、name 是 xai：凭据库按 'xai' 找到它的 OAuth；按 uuid 找不到
 *   ADR-2  一条自定义行叫 "xai"：拿不到内置行的 OAuth；logout('xai') 只清内置那一行
 *   ADR-3  logout 之后 API key 接手（checkAuth 从 oauth 变 api_key）
 *   ADR-4  modelRefOf：内置 uuid 行 → {provider:'xai'}，自定义行 → {provider: 行 id}
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'

const state = vi.hoisted(() => ({ db: null as unknown as import('node:sqlite').DatabaseSync }))

vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
}))
// 只换连接：DAO 的 SQL 原样跑在 node:sqlite 上
vi.mock('../../../dao/database', () => {
  class BaseDao {
    protected get db(): DatabaseSync {
      return state.db
    }
    protected stmt(sql: string): ReturnType<DatabaseSync['prepare']> {
      return state.db.prepare(sql)
    }
  }
  return { BaseDao, databaseManager: { getDb: () => state.db } }
})
// 加密密钥文件放进一个只属于本文件的临时目录（绝不碰 ~/.shuvix）
vi.mock('../../../utils/paths', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'shuvix-port-test-'))
  return { getUserConfigDir: () => dir }
})

import { createDbCredentialStore, createModelRegistry } from '@shuvix/agent-runtime'
import { migrations } from '../../../dao/migrations'
import { ProviderDao } from '../../../dao/providerDao'
import { decrypt, encrypt } from '../../../utils/crypto'
import { createProviderCredentialPort } from '../providerCredentialPort'

type Db = Parameters<(typeof migrations)[number]['up']>[0]

const XAI_UUID = '0193a7c2-0000-7000-8000-0000000000a1'
const CUSTOM_UUID = '0193a7c2-0000-7000-8000-0000000000c1'
const ENC_PREFIX = '$SHUVIX_ENC$v1$'

let dao: ProviderDao

function insertProvider(row: {
  id: string
  name: string
  isBuiltin: 0 | 1
  isEnabled?: 0 | 1
  apiKey?: string
  rawApiKey?: string
  displayName?: string
  baseUrl?: string
  apiProtocol?: string
  metadata?: string
  sortOrder?: number
}): void {
  state.db
    .prepare(
      `INSERT INTO providers (id, name, displayName, apiKey, baseUrl, apiProtocol, metadata, isBuiltin, isEnabled, sortOrder, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)`
    )
    .run(
      row.id,
      row.name,
      row.displayName ?? '',
      row.rawApiKey ?? encrypt(row.apiKey ?? ''),
      row.baseUrl ?? '',
      row.apiProtocol ?? 'openai-completions',
      row.metadata ?? '{}',
      row.isBuiltin,
      row.isEnabled ?? 1,
      row.sortOrder ?? 0
    )
}

function insertModel(
  id: string,
  providerId: string,
  modelId: string,
  options: { isEnabled?: 0 | 1; capabilities?: string | null; sortOrder?: number } = {}
): void {
  state.db
    .prepare(
      'INSERT INTO provider_models (id, providerId, modelId, isEnabled, sortOrder, capabilities) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(
      id,
      providerId,
      modelId,
      options.isEnabled ?? 1,
      options.sortOrder ?? 0,
      options.capabilities === undefined ? '{}' : options.capabilities
    )
}

function rawOAuthColumn(id: string): string {
  return (state.db.prepare('SELECT oauth FROM providers WHERE id = ?').get(id) as { oauth: string })
    .oauth
}

function rawApiKeyColumn(id: string): string {
  return (
    state.db.prepare('SELECT apiKey FROM providers WHERE id = ?').get(id) as { apiKey: string }
  ).apiKey
}

beforeEach(() => {
  state.db = new DatabaseSync(':memory:')
  for (const m of migrations) m.up(state.db as unknown as Db)
  dao = new ProviderDao()
})

afterEach(() => {
  state.db.close()
})

describe('listProviders / listModels', () => {
  it('PCP-1 every row incl. disabled, booleans, decrypted key, no oauth column, findAll order', () => {
    insertProvider({ id: 'openai', name: 'openai', isBuiltin: 1, isEnabled: 0, sortOrder: 1 })
    insertProvider({
      id: XAI_UUID,
      name: 'xai',
      displayName: 'xAI',
      isBuiltin: 1,
      apiKey: 'sk-xai',
      sortOrder: 0
    })
    insertProvider({
      id: CUSTOM_UUID,
      name: 'My Proxy',
      isBuiltin: 0,
      apiKey: 'sk-proxy',
      baseUrl: 'http://proxy.test/v1',
      apiProtocol: 'anthropic-messages',
      metadata: '{"customHeaders":{"X-Key":"v"}}',
      sortOrder: 5
    })
    dao.saveOAuthJson(XAI_UUID, '{"type":"oauth","access":"a","refresh":"r","expires":1}')

    const rows = createProviderCredentialPort(dao).listProviders()

    expect(rows.map((r) => r.id)).toEqual(dao.findAll().map((p) => p.id))
    expect(rows.map((r) => r.id)).toEqual([CUSTOM_UUID, XAI_UUID, 'openai'])
    expect(rows).toEqual([
      {
        id: CUSTOM_UUID,
        name: 'My Proxy',
        displayName: '',
        isBuiltin: false,
        isEnabled: true,
        apiKey: 'sk-proxy',
        baseUrl: 'http://proxy.test/v1',
        apiProtocol: 'anthropic-messages',
        metadata: '{"customHeaders":{"X-Key":"v"}}'
      },
      {
        id: XAI_UUID,
        name: 'xai',
        displayName: 'xAI',
        isBuiltin: true,
        isEnabled: true,
        apiKey: 'sk-xai',
        baseUrl: '',
        apiProtocol: 'openai-completions',
        metadata: '{}'
      },
      {
        id: 'openai',
        name: 'openai',
        displayName: '',
        isBuiltin: true,
        isEnabled: false,
        apiKey: '',
        baseUrl: '',
        apiProtocol: 'openai-completions',
        metadata: '{}'
      }
    ])
    for (const row of rows) {
      expect(Object.keys(row)).not.toContain('oauth')
      expect(JSON.stringify(row)).not.toContain(ENC_PREFIX)
    }
  })

  it('PCP-2 a key that cannot be decrypted reads as "" and the other rows still list', () => {
    insertProvider({ id: 'xai', name: 'xai', isBuiltin: 1, apiKey: 'sk-good' })
    // 前缀对、密文坏（换过密钥文件 / 手改）：decrypt 会抛
    insertProvider({
      id: 'openai',
      name: 'openai',
      isBuiltin: 1,
      rawApiKey: `${ENC_PREFIX}00:00:00`
    })

    const rows = createProviderCredentialPort(dao).listProviders()

    expect(rows.find((r) => r.id === 'openai')?.apiKey).toBe('')
    expect(rows.find((r) => r.id === 'xai')?.apiKey).toBe('sk-good')
  })

  it('PCP-3 every model row of every provider incl. disabled; NULL capabilities → ""', () => {
    insertProvider({ id: 'xai', name: 'xai', isBuiltin: 1 })
    insertProvider({ id: CUSTOM_UUID, name: 'P', isBuiltin: 0 })
    insertModel('m1', 'xai', 'grok-4.5', { capabilities: '{"reasoning":true}', sortOrder: 0 })
    insertModel('m2', CUSTOM_UUID, 'llama', { isEnabled: 0, capabilities: null, sortOrder: 1 })

    const models = createProviderCredentialPort(dao).listModels()

    expect(models).toEqual([
      {
        providerId: 'xai',
        modelId: 'grok-4.5',
        isEnabled: true,
        capabilities: '{"reasoning":true}'
      },
      { providerId: CUSTOM_UUID, modelId: 'llama', isEnabled: false, capabilities: '' }
    ])
  })
})

describe('OAuth records', () => {
  beforeEach(() => {
    insertProvider({ id: XAI_UUID, name: 'xai', isBuiltin: 1, apiKey: 'sk-xai' })
  })

  it('PCP-4 saveOAuth → readOAuth returns the exact JSON text, extras included', () => {
    const port = createProviderCredentialPort(dao)
    const json = JSON.stringify({
      type: 'oauth',
      access: 'acc-1',
      refresh: 'ref-1',
      expires: 1_900_000_000_000,
      accountId: 'acct-42',
      enterprise: { url: 'https://corp.example', seats: 3 }
    })

    port.saveOAuth(XAI_UUID, json)

    expect(port.readOAuth(XAI_UUID)).toBe(json)
  })

  it('PCP-5 at rest: the column is $SHUVIX_ENC$v1$ ciphertext without the tokens; decrypt = JSON', () => {
    const port = createProviderCredentialPort(dao)
    const json = '{"type":"oauth","access":"secret-access","refresh":"secret-refresh","expires":5}'

    port.saveOAuth(XAI_UUID, json)

    const column = rawOAuthColumn(XAI_UUID)
    expect(column.startsWith(ENC_PREFIX)).toBe(true)
    expect(column).not.toContain('secret-access')
    expect(column).not.toContain('secret-refresh')
    expect(decrypt(column)).toBe(json)
  })

  it('PCP-6 a pre-1.0 record (no type) is read as is and the credential store reads it as OAuth', async () => {
    // 上一代写入口存的正是这个形状：encrypt(JSON.stringify({access, refresh, expires}))
    const legacy = JSON.stringify({ access: 'old-acc', refresh: 'old-ref', expires: 1234 })
    state.db.prepare('UPDATE providers SET oauth = ? WHERE id = ?').run(encrypt(legacy), XAI_UUID)
    const port = createProviderCredentialPort(dao)

    expect(port.readOAuth(XAI_UUID)).toBe(legacy)
    const credential = await createDbCredentialStore(port).read('xai')
    expect(credential).toEqual({
      type: 'oauth',
      access: 'old-acc',
      refresh: 'old-ref',
      expires: 1234
    })
  })

  it('PCP-7 no record, or a record that cannot be decrypted → undefined (never throws)', () => {
    const port = createProviderCredentialPort(dao)
    expect(port.readOAuth(XAI_UUID)).toBeUndefined()
    expect(port.readOAuth('no-such-row')).toBeUndefined()

    state.db
      .prepare('UPDATE providers SET oauth = ? WHERE id = ?')
      .run(`${ENC_PREFIX}00:00:00`, XAI_UUID)
    expect(() => port.readOAuth(XAI_UUID)).not.toThrow()
    expect(port.readOAuth(XAI_UUID)).toBeUndefined()
  })

  it('PCP-8 clearOAuth removes the record only: the key stays, oauthConnected goes back to 0', () => {
    const port = createProviderCredentialPort(dao)
    port.saveOAuth(XAI_UUID, '{"type":"oauth","access":"a","refresh":"r","expires":1}')
    expect(dao.findById(XAI_UUID)?.oauthConnected).toBe(1)

    port.clearOAuth(XAI_UUID)

    expect(port.readOAuth(XAI_UUID)).toBeUndefined()
    expect(rawOAuthColumn(XAI_UUID)).toBe('')
    expect(port.listProviders()[0].apiKey).toBe('sk-xai')
    expect(dao.findById(XAI_UUID)?.oauthConnected).toBe(0)
  })

  it('PCP-9 saveApiKey stores the key encrypted and listProviders reads it back', () => {
    const port = createProviderCredentialPort(dao)

    port.saveApiKey?.(XAI_UUID, 'sk-new')

    expect(rawApiKeyColumn(XAI_UUID).startsWith(ENC_PREFIX)).toBe(true)
    expect(rawApiKeyColumn(XAI_UUID)).not.toContain('sk-new')
    expect(port.listProviders()[0].apiKey).toBe('sk-new')
  })

  it('PCP-10 the renderer-facing view carries oauthConnected only, never the credential', () => {
    const port = createProviderCredentialPort(dao)
    port.saveOAuth(XAI_UUID, '{"type":"oauth","access":"acc-x","refresh":"ref-x","expires":1}')

    for (const view of [dao.findAll()[0], dao.findById(XAI_UUID)]) {
      expect(view?.oauthConnected).toBe(1)
      const text = JSON.stringify(view)
      expect(text).not.toContain('acc-x')
      expect(text).not.toContain('ref-x')
      expect(text).not.toContain(ENC_PREFIX)
      expect(Object.keys(view ?? {})).not.toContain('oauth')
    }
  })
})

describe('addressing through the port and the credential store', () => {
  const future = (): number => Date.now() + 60 * 60 * 1000

  beforeEach(() => {
    insertProvider({ id: XAI_UUID, name: 'xai', isBuiltin: 1, apiKey: 'sk-builtin' })
    // name 有 UNIQUE 约束 —— 大小写不同即可撞上同一个 slug 的「字面」
    insertProvider({ id: CUSTOM_UUID, name: 'XAI', isBuiltin: 0, apiKey: 'sk-custom' })
  })

  it('ADR-1 a builtin row with a uuid id is addressed by its slug, never by the uuid', async () => {
    const port = createProviderCredentialPort(dao)
    port.saveOAuth(
      XAI_UUID,
      JSON.stringify({ type: 'oauth', access: 'acc', refresh: 'ref', expires: future() })
    )
    const store = createDbCredentialStore(port)
    const registry = createModelRegistry({ port })

    expect(await store.read('xai')).toMatchObject({ type: 'oauth', access: 'acc' })
    expect(await store.read(XAI_UUID)).toBeUndefined()
    expect(await registry.models.checkAuth('xai')).toEqual({ source: 'OAuth', type: 'oauth' })
  })

  it('ADR-2 a custom row whose name spells the slug never gets the builtin OAuth; logout clears only the builtin', async () => {
    const port = createProviderCredentialPort(dao)
    port.saveOAuth(
      XAI_UUID,
      JSON.stringify({ type: 'oauth', access: 'acc', refresh: 'ref', expires: future() })
    )
    const registry = createModelRegistry({ port })

    const custom = await registry.models.getAuth(CUSTOM_UUID)
    expect(custom?.auth.apiKey).toBe('sk-custom')

    // 自定义行身上也放一条记录（手改过库）：logout('xai') 不该碰它
    port.saveOAuth(CUSTOM_UUID, '{"type":"oauth","access":"c","refresh":"c","expires":1}')
    await registry.models.logout('xai')

    expect(port.readOAuth(XAI_UUID)).toBeUndefined()
    expect(port.readOAuth(CUSTOM_UUID)).toBeDefined()
  })

  it('ADR-3 after logout the API key takes over again', async () => {
    const port = createProviderCredentialPort(dao)
    port.saveOAuth(
      XAI_UUID,
      JSON.stringify({ type: 'oauth', access: 'acc', refresh: 'ref', expires: future() })
    )
    const registry = createModelRegistry({ port })
    expect((await registry.models.checkAuth('xai'))?.type).toBe('oauth')

    await registry.models.logout('xai')

    expect((await registry.models.checkAuth('xai'))?.type).toBe('api_key')
    expect((await registry.models.getAuth('xai'))?.auth.apiKey).toBe('sk-builtin')
  })

  it('ADR-4 modelRefOf: builtin uuid row → slug, custom row → its row id, unknown row → undefined', () => {
    const registry = createModelRegistry({ port: createProviderCredentialPort(dao) })

    expect(registry.modelRefOf(XAI_UUID, 'grok-4.5')).toEqual({ provider: 'xai', id: 'grok-4.5' })
    expect(registry.modelRefOf(CUSTOM_UUID, 'llama')).toEqual({
      provider: CUSTOM_UUID,
      id: 'llama'
    })
    expect(registry.modelRefOf('no-such-row', 'x')).toBeUndefined()
  })
})
