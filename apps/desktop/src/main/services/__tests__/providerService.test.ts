/**
 * providerService —— 启动时从 pi-ai 同步内置提供商的模型行（`syncAllBuiltinModels` / `syncBuiltinModels`）。
 *
 * 只提供分类模型的内置提供商（TypeSafe）在 pi 的聊天目录里没有模型（`getBuiltinModels('typesafe')`
 * 为空），于是同步不为它写任何模型行：「不出现在会话的模型选择里」靠的就是它没有模型行。
 *
 * pi-ai 用真的（读真目录）；providerDao 换成内存假实现 —— 每个 `BUILTIN_PROVIDERS` 一条内置行
 * （id = name），记下每次 upsertModels / patchCapabilities。不用 node:sqlite：真 DAO 的
 * `upsertModels` 要 `db.transaction`，DatabaseSync 没有。
 *
 *   PS-1 全量同步：typesafe 一次 upsert / patch 都没有、日志不提它；假 DAO 本身管用（openai 恰按
 *        pi 目录的 id 写入）
 *   PS-2 单独同步 typesafe → {total:0, added:0}
 *
 * 手动同步（`syncModelsFromProvider`）：订阅登录的内置提供商取 pi 目录、不发请求；其余照旧拉
 * /models。providerDao 的假实现补上 `pick`，`resolveRequestApiKey` 换成可控的 vi.fn，事件总线
 * 记下发布的事件；`fetchProviderModels` 用真的，只把全局 `fetch` 打桩 —— 订阅场景里桩答
 * `{data: []}`（ChatGPT 登录令牌在 /v1/models 上拿到的就是这个），回归成「去拉 /models」会响亮地失败。
 *
 *   PS-3 openai 订阅登录：按 pi 目录同步（顺序照目录）、不发请求，已有的目录外模型保留，
 *        added 只算新的，发布 providers.changed
 *   PS-4 xai / kimi-coding 订阅登录：同样走目录（kimi-coding 的协议 anthropic-messages 远程路径
 *        根本不支持）
 *   PS-5 未订阅的内置 openai / 自定义提供商（即便 oauthConnected=1，规则只看内置）：照旧拉
 *        /models —— URL、Bearer、去重排序后写入
 *   PS-6 未订阅时远程答空列表仍然报错，不写不发
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import { BUILTIN_PROVIDERS } from '@shuvix/chat-protocol/providerCatalog'
import type { Provider, ProviderModel } from '../../types'

const hoisted = vi.hoisted(() => ({
  rows: [] as unknown[],
  /** providerId → 模型行 */
  models: new Map<string, ProviderModel[]>(),
  upserts: [] as Array<[string, string[]]>,
  patches: [] as Array<[string, unknown]>,
  infoLines: [] as string[],
  /** 模型层解析出的请求凭据（默认解析不出） */
  resolveKey: vi.fn<(providerId: string) => Promise<string | undefined>>(),
  /** appEventBus.publish 收到的事件 */
  published: [] as unknown[]
}))

vi.mock('../../dao/providerDao', () => ({
  providerDao: {
    findAll: () => hoisted.rows,
    pick: (id: string, fields: string[]) => {
      const row = (hoisted.rows as Array<Record<string, unknown>>).find((r) => r.id === id)
      if (!row) return undefined
      return Object.fromEntries(fields.map((f) => [f, row[f]]))
    },
    findModelsByProvider: (providerId: string) => hoisted.models.get(providerId) ?? [],
    upsertModels: (providerId: string, modelIds: string[]) => {
      hoisted.upserts.push([providerId, [...modelIds]])
      const list = hoisted.models.get(providerId) ?? []
      modelIds.forEach((modelId, idx) => {
        if (list.some((m) => m.modelId === modelId)) return
        list.push({
          id: `${providerId}:${modelId}`,
          providerId,
          modelId,
          isEnabled: 0,
          sortOrder: idx,
          capabilities: ''
        })
      })
      hoisted.models.set(providerId, list)
    },
    patchCapabilities: (id: string, patch: unknown) => {
      hoisted.patches.push([id, patch])
    }
  }
}))
vi.mock('../litellmService', () => ({
  litellmService: { isReady: () => false, getModelCapabilities: () => undefined }
}))
vi.mock('../models', () => ({
  resolveRequestApiKey: (providerId: string) => hoisted.resolveKey(providerId)
}))
vi.mock('../../utils/appEventBus', () => ({
  appEventBus: { publish: (event: unknown) => void hoisted.published.push(event) }
}))
vi.mock('../../logger', () => ({
  createLogger: () => ({
    info: (line: string) => void hoisted.infoLines.push(String(line)),
    warn: () => {},
    error: () => {},
    debug: () => {}
  })
}))

import { ProviderService } from '../providerService'

function builtinRow(name: string, displayName: string): Provider {
  return {
    id: name,
    name,
    displayName,
    apiKey: '',
    baseUrl: '',
    apiProtocol: 'openai-completions',
    metadata: '',
    isBuiltin: 1,
    isEnabled: 0,
    sortOrder: 0,
    createdAt: 0,
    updatedAt: 0,
    oauthConnected: 0
  }
}

beforeEach(() => {
  hoisted.rows = BUILTIN_PROVIDERS.map((entry) => builtinRow(entry.name, entry.displayName))
  hoisted.models.clear()
  hoisted.upserts.length = 0
  hoisted.patches.length = 0
  hoisted.infoLines.length = 0
  hoisted.published.length = 0
  hoisted.resolveKey.mockReset()
  hoisted.resolveKey.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** 用 row 替换同 id 的行，没有就追加 */
function setRow(row: Provider): void {
  const rows = hoisted.rows as Provider[]
  const idx = rows.findIndex((r) => r.id === row.id)
  if (idx >= 0) rows[idx] = row
  else rows.push(row)
}

/** 全局 fetch 打桩：每次都答 200 + body */
function stubFetch(body: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function catalogIds(slug: string): string[] {
  return getBuiltinModels(slug as Parameters<typeof getBuiltinModels>[0]).map((m) => m.id)
}

function defaultApiOf(slug: string): string {
  const entry = BUILTIN_PROVIDERS.find((p) => p.name === slug)
  if (!entry) throw new Error(`no builtin provider ${slug}`)
  return entry.defaultApi
}

describe('syncAllBuiltinModels', () => {
  it('PS-1 writes no model rows for typesafe and never logs it; openai gets exactly pi’s ids', () => {
    new ProviderService().syncAllBuiltinModels()

    expect(hoisted.upserts.filter(([providerId]) => providerId === 'typesafe')).toEqual([])
    expect(hoisted.patches.filter(([id]) => String(id).startsWith('typesafe:'))).toEqual([])
    expect(hoisted.models.get('typesafe')).toBeUndefined()

    // the fake DAO works: openai is upserted once with exactly the catalog ids
    const openaiIds = getBuiltinModels('openai').map((m) => m.id)
    expect(openaiIds.length).toBeGreaterThan(0)
    expect(hoisted.upserts.filter(([providerId]) => providerId === 'openai')).toEqual([
      ['openai', openaiIds]
    ])

    expect(hoisted.infoLines.length).toBeGreaterThan(0)
    expect(hoisted.infoLines.filter((line) => /typesafe/i.test(line))).toEqual([])
  })
})

describe('syncBuiltinModels', () => {
  it('PS-2 typesafe → {total:0, added:0}, nothing written', () => {
    expect(new ProviderService().syncBuiltinModels('typesafe', 'typesafe')).toEqual({
      total: 0,
      added: 0
    })
    expect(hoisted.upserts).toEqual([])
    expect(hoisted.patches).toEqual([])
  })
})

describe('syncModelsFromProvider', () => {
  it('PS-3 openai signed in with a subscription syncs from pi’s catalog and never fetches', async () => {
    setRow({
      ...builtinRow('openai', 'OpenAI'),
      oauthConnected: 1,
      apiKey: '',
      apiProtocol: 'openai-responses',
      baseUrl: 'https://api.openai.com/v1'
    })
    hoisted.resolveKey.mockResolvedValue('oauth-access-token')
    const fetchMock = stubFetch({ data: [] })

    const ids = catalogIds('openai')
    const n = ids.length
    expect(n).toBeGreaterThan(1)
    const seeded = (modelId: string, idx: number): ProviderModel => ({
      id: `openai:${modelId}`,
      providerId: 'openai',
      modelId,
      isEnabled: 1,
      sortOrder: idx,
      capabilities: ''
    })
    hoisted.models.set('openai', [seeded(ids[0], 0), seeded('legacy-model', 1)])

    await expect(new ProviderService().syncModelsFromProvider('openai')).resolves.toEqual({
      providerId: 'openai',
      total: n,
      added: n - 1
    })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(hoisted.upserts).toEqual([['openai', ids]])
    const modelIds = (hoisted.models.get('openai') ?? []).map((m) => m.modelId)
    expect(modelIds).toContain('legacy-model')
    for (const id of ids) expect(modelIds).toContain(id)
    expect(hoisted.published).toContainEqual({ type: 'providers.changed' })

    // every catalog row got its capabilities; the out-of-catalog row was left alone
    const patchedIds = hoisted.patches.map(([id]) => id)
    for (const id of ids) expect(patchedIds).toContain(`openai:${id}`)
    expect(patchedIds).not.toContain('openai:legacy-model')
  })

  it.each(['xai', 'kimi-coding'])(
    'PS-4 %s signed in with a subscription syncs from pi’s catalog and never fetches',
    async (slug) => {
      const entry = BUILTIN_PROVIDERS.find((p) => p.name === slug)
      expect(entry).toBeDefined()
      setRow({
        ...builtinRow(slug, entry!.displayName),
        oauthConnected: 1,
        apiProtocol: defaultApiOf(slug) as Provider['apiProtocol']
      })
      hoisted.resolveKey.mockResolvedValue('oauth-access-token')
      const fetchMock = stubFetch({ data: [] })

      const ids = catalogIds(slug)
      expect(ids.length).toBeGreaterThan(0)

      await expect(new ProviderService().syncModelsFromProvider(slug)).resolves.toEqual({
        providerId: slug,
        total: ids.length,
        added: ids.length
      })
      expect(fetchMock).not.toHaveBeenCalled()
      expect(hoisted.upserts).toEqual([[slug, ids]])
      expect(hoisted.published).toContainEqual({ type: 'providers.changed' })
    }
  )

  it.each([
    {
      label: 'builtin openai without a subscription',
      row: {
        ...builtinRow('openai', 'OpenAI'),
        oauthConnected: 0,
        baseUrl: '',
        apiProtocol: 'openai-completions'
      } as Provider,
      key: 'sk-test' as string | undefined,
      url: 'https://api.openai.com/v1/models',
      auth: 'Bearer sk-test'
    },
    {
      label: 'custom provider (oauthConnected=1 does not count: the rule is builtin-only)',
      row: {
        ...builtinRow('custom-1', 'My Relay'),
        id: 'custom-1',
        name: 'My Relay',
        isBuiltin: 0,
        oauthConnected: 1,
        baseUrl: 'https://relay.example/v1/',
        apiKey: 'sk-relay',
        apiProtocol: 'openai-completions'
      } as Provider,
      key: undefined as string | undefined,
      url: 'https://relay.example/v1/models',
      auth: 'Bearer sk-relay'
    }
  ])('PS-5 $label still fetches /models', async ({ row, key, url, auth }) => {
    setRow(row)
    hoisted.resolveKey.mockResolvedValue(key)
    const fetchMock = stubFetch({ data: [{ id: 'm-b' }, { id: 'm-a' }, { id: 'm-a' }] })

    await expect(new ProviderService().syncModelsFromProvider(row.id)).resolves.toEqual({
      providerId: row.id,
      total: 2,
      added: 2
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [calledUrl, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(calledUrl).toBe(url)
    expect((init.headers as Record<string, string>).Authorization).toBe(auth)
    expect(hoisted.upserts).toEqual([[row.id, ['m-a', 'm-b']]])
    expect(hoisted.published).toContainEqual({ type: 'providers.changed' })
  })

  it('PS-6 without a subscription an empty remote list still throws; nothing written or published', async () => {
    setRow({ ...builtinRow('openai', 'OpenAI'), oauthConnected: 0 })
    hoisted.resolveKey.mockResolvedValue('sk-test')
    const fetchMock = stubFetch({ data: [] })

    await expect(new ProviderService().syncModelsFromProvider('openai')).rejects.toThrow(
      /模型列表为空/
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(hoisted.upserts).toEqual([])
    expect(hoisted.published).toEqual([])
  })
})
