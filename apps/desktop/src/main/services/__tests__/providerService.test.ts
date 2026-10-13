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
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import { BUILTIN_PROVIDERS } from '@shuvix/chat-protocol/providerCatalog'
import type { Provider, ProviderModel } from '../../types'

const hoisted = vi.hoisted(() => ({
  rows: [] as unknown[],
  /** providerId → 模型行 */
  models: new Map<string, ProviderModel[]>(),
  upserts: [] as Array<[string, string[]]>,
  patches: [] as Array<[string, unknown]>,
  infoLines: [] as string[]
}))

vi.mock('../../dao/providerDao', () => ({
  providerDao: {
    findAll: () => hoisted.rows,
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
vi.mock('../models', () => ({ resolveRequestApiKey: async () => undefined }))
vi.mock('../../utils/appEventBus', () => ({ appEventBus: { publish: () => {} } }))
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
})

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
