/**
 * 浏览器设置 + 提供商/模型存储 —— chrome.storage.local（扩展宿主的 provider 数据层，
 * 对应桌面的 providerDao；UI 复用共享 ProviderTab）。
 *
 * - 通用设置 KV（主题/字号/选中模型）
 * - 内置提供商目录来自 @shuvix/chat-protocol（与桌面同源），默认禁用，配置后启用
 * - 自定义提供商 + 每提供商模型（增删/启停/能力/远程同步）持久化于 chrome.storage
 * - apiKey 落盘前经 WebCrypto AES 混淆（见 secretCrypto；与桌面 utils/crypto 同级别，非真静态加密）
 */
import { v4 as uuid } from 'uuid'
import type {
  ProviderInfo,
  ProviderModelInfo,
  AvailableModel,
  ApiProtocol
} from '@shuvix/chat-protocol/types/provider'
import { BUILTIN_PROVIDERS } from '@shuvix/chat-protocol/providerCatalog'
import { fetchProviderModels } from '@shuvix/chat-protocol/utils/providerModels'
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import { encryptSecret, decryptSecret } from './secretCrypto'
import { appEventBus } from '../runtime/appEventBus'

/** 提供商/模型数据变更后发布事件（数据层，覆盖所有调用方，与桌面 providerService 对称） */
function notifyProvidersChanged(): void {
  appEventBus.publish({ type: 'providers.changed' })
}

const KEY_SETTINGS = 'settings'
const KEY_OVERRIDES = 'providerOverrides'
const KEY_CUSTOM = 'customProviderIds'
const KEY_MODELS = 'providerModels'

/** 提供商配置覆盖（内置 provider 存差异；自定义 provider 存全量） */
interface ProviderOverride {
  apiKey?: string
  baseUrl?: string
  name?: string
  displayName?: string
  apiProtocol?: ApiProtocol
  metadata?: string
  isEnabled?: 0 | 1
  isBuiltin: 0 | 1
  sortOrder?: number
}
interface StoredModel {
  modelId: string
  isEnabled: 0 | 1
  capabilities: string
  sortOrder: number
}

// 内存缓存（main.tsx 启动时 loadState 后，list* 同步读取）
let overrides: Record<string, ProviderOverride> = {}
let customIds: string[] = []
let models: Record<string, StoredModel[]> = {}
let loaded = false

async function readLocal<T>(key: string, fallback: T): Promise<T> {
  const obj = await chrome.storage.local.get(key)
  return (obj[key] as T) ?? fallback
}
async function writeLocal(key: string, value: unknown): Promise<void> {
  await chrome.storage.local.set({ [key]: value })
}

/**
 * KEY_SETTINGS 的读-改-写串行化锁。
 * 通用设置 KV 是单个对象,多个 set 并发时各自「读同一快照→写回」会互相覆盖丢键
 * （典型：ModelPicker 同时 set activeProvider + activeModel，后写者覆盖前者 →
 * 新建会话 provider 停在旧默认、model 却是新选的，造成 provider/model 错位）。
 * 串行化保证每次写都基于上一次写后的最新值。
 */
let settingsWriteChain: Promise<void> = Promise.resolve()

/** 落盘 overrides：内存里 apiKey 是明文，写盘前加密一份（不动内存）。 */
async function persistOverrides(): Promise<void> {
  const enc: Record<string, ProviderOverride> = {}
  for (const [id, o] of Object.entries(overrides)) {
    enc[id] = o.apiKey ? { ...o, apiKey: await encryptSecret(o.apiKey) } : o
  }
  await writeLocal(KEY_OVERRIDES, enc)
}

function modelKey(providerId: string, modelId: string): string {
  return `${providerId}:${modelId}`
}
function splitModelKey(id: string): { providerId: string; modelId: string } {
  const i = id.indexOf(':')
  return { providerId: id.slice(0, i), modelId: id.slice(i + 1) }
}

function providerNameOf(id: string): string {
  return (
    overrides[id]?.displayName || BUILTIN_PROVIDERS.find((p) => p.name === id)?.displayName || id
  )
}

function toProviderModelInfo(providerId: string, m: StoredModel, i: number): ProviderModelInfo {
  return {
    id: modelKey(providerId, m.modelId),
    providerId,
    modelId: m.modelId,
    isEnabled: m.isEnabled,
    sortOrder: m.sortOrder ?? i,
    capabilities: m.capabilities
  }
}

export const settingsStore = {
  // ─── 通用设置 KV ───
  async getAll(): Promise<Record<string, string>> {
    return readLocal<Record<string, string>>(KEY_SETTINGS, {})
  },
  async get(key: string): Promise<string | undefined> {
    return (await this.getAll())[key]
  },
  async set(key: string, value: string): Promise<void> {
    // 串行化读-改-写（见 settingsWriteChain 说明），避免并发 set 互相覆盖丢键
    const run = settingsWriteChain.then(async () => {
      const all = await readLocal<Record<string, string>>(KEY_SETTINGS, {})
      all[key] = value
      await writeLocal(KEY_SETTINGS, all)
      appEventBus.publish({ type: 'settings.changed', keys: [key] })
    })
    settingsWriteChain = run.catch(() => {})
    return run
  },

  // ─── 启动载入（让 list* 同步可读） ───
  async loadState(): Promise<void> {
    if (loaded) return
    overrides = await readLocal<Record<string, ProviderOverride>>(KEY_OVERRIDES, {})
    // apiKey 落盘是密文，解密回内存（旧明文/空值原样返回，无需迁移）
    for (const o of Object.values(overrides)) {
      if (o.apiKey) o.apiKey = await decryptSecret(o.apiKey)
    }
    customIds = await readLocal<string[]>(KEY_CUSTOM, [])
    models = await readLocal<Record<string, StoredModel[]>>(KEY_MODELS, {})
    loaded = true
  },

  // ─── 提供商列表（内置目录 + 覆盖 + 自定义） ───
  listProviders(): ProviderInfo[] {
    const builtin: ProviderInfo[] = BUILTIN_PROVIDERS.map((p, i) => {
      const o = overrides[p.name] ?? ({ isBuiltin: 1 } as ProviderOverride)
      return {
        id: p.name,
        name: p.name,
        displayName: p.displayName,
        apiKey: o.apiKey ?? '',
        baseUrl: p.baseUrl, // 内置 URL 恒由目录/注册表决定，用户不可改
        apiProtocol: o.apiProtocol ?? 'openai-completions',
        metadata: o.metadata ?? '',
        isBuiltin: 1,
        isEnabled: o.isEnabled ?? 0, // 内置默认禁用，配置后启用（与桌面一致）
        sortOrder: i,
        createdAt: 0,
        updatedAt: 0
      }
    })
    const custom: ProviderInfo[] = customIds
      .map((id) => {
        const o = overrides[id]
        if (!o) return null
        return {
          id,
          name: o.name ?? id,
          displayName: o.displayName ?? o.name ?? id,
          apiKey: o.apiKey ?? '',
          baseUrl: o.baseUrl ?? '',
          apiProtocol: o.apiProtocol ?? 'openai-completions',
          metadata: o.metadata ?? '',
          isBuiltin: 0,
          isEnabled: o.isEnabled ?? 1,
          sortOrder: 1000 + (o.sortOrder ?? 0),
          createdAt: 0,
          updatedAt: 0
        } as ProviderInfo
      })
      .filter((p): p is ProviderInfo => !!p)
    return [...builtin, ...custom]
  },

  listModelsFor(providerId: string): ProviderModelInfo[] {
    return (models[providerId] ?? []).map((m, i) => toProviderModelInfo(providerId, m, i))
  },

  /** 仅「已启用 provider」下「已启用模型」（供模型选择器） */
  listAvailableModels(): AvailableModel[] {
    const enabledProviders = new Set(
      this.listProviders()
        .filter((p) => p.isEnabled)
        .map((p) => p.id)
    )
    const out: AvailableModel[] = []
    for (const [providerId, list] of Object.entries(models)) {
      if (!enabledProviders.has(providerId)) continue
      list.forEach((m, i) => {
        if (m.isEnabled) {
          out.push({
            ...toProviderModelInfo(providerId, m, i),
            providerName: providerNameOf(providerId)
          })
        }
      })
    }
    return out
  },

  // ─── apiKey / provider 配置 ───
  getApiKey(providerId: string): string | undefined {
    return overrides[providerId]?.apiKey || undefined
  },
  async setApiKey(providerId: string, apiKey: string): Promise<void> {
    await this.updateConfig(providerId, { apiKey })
  },
  getProviderWithKey(providerId: string): ProviderInfo | undefined {
    return this.listProviders().find((p) => p.id === providerId)
  },

  /**
   * 默认选择 —— 取首个「已启用 provider 下已启用模型」（按 provider/模型顺序）。
   * 都没有则返回空（此时 ApiKeyGate 会拦截使用）。替代写死 anthropic/claude-opus-4-8。
   */
  getDefaultSelection(): { provider: string; model: string } {
    const first = this.listAvailableModels()[0]
    return first
      ? { provider: first.providerId, model: first.modelId }
      : { provider: '', model: '' }
  },

  /**
   * 新建会话的选择 —— 读「设置中的默认模型」(general.defaultProvider/defaultModel，
   * 仅由设置页写，与每会话的 ModelPicker 选择互不影响，对齐桌面 sessionService.create)。
   * 校验 model 确属该已启用 provider；缺省/不一致则回退首个可用模型，避免 provider/model 错位。
   */
  async getNewSessionSelection(): Promise<{ provider: string; model: string }> {
    await this.loadState()
    const provider = await this.get('general.defaultProvider')
    const model = await this.get('general.defaultModel')
    if (provider && model) {
      const enabledProvider = this.listProviders().some((p) => p.id === provider && p.isEnabled)
      const modelBelongs = this.listModelsFor(provider).some(
        (m) => m.modelId === model && m.isEnabled
      )
      if (enabledProvider && modelBelongs) return { provider, model }
    }
    return this.getDefaultSelection()
  },

  /** 读「设置中的默认模型」原始值（设置页 ModelDefaults 显示用，未配置则空） */
  async getConfiguredDefault(): Promise<{ provider: string; model: string }> {
    return {
      provider: (await this.get('general.defaultProvider')) ?? '',
      model: (await this.get('general.defaultModel')) ?? ''
    }
  },

  async updateConfig(
    id: string,
    patch: Partial<
      Pick<ProviderOverride, 'apiKey' | 'baseUrl' | 'name' | 'apiProtocol' | 'metadata'>
    >
  ): Promise<void> {
    await this.loadState()
    const isBuiltin = BUILTIN_PROVIDERS.some((p) => p.name === id) ? 1 : 0
    // 内置 provider 不接受 baseUrl 覆盖（URL 由注册表决定）
    const applied = isBuiltin ? { ...patch, baseUrl: undefined } : patch
    overrides[id] = { ...overrides[id], isBuiltin, ...applied }
    await persistOverrides()
    notifyProvidersChanged()
  },

  async toggleEnabled(id: string, isEnabled: boolean): Promise<void> {
    await this.loadState()
    const isBuiltin = BUILTIN_PROVIDERS.some((p) => p.name === id) ? 1 : 0
    overrides[id] = { ...overrides[id], isBuiltin, isEnabled: isEnabled ? 1 : 0 }
    await persistOverrides()
    // 启用内置 provider 时即时补齐 pi-ai 模型，免重启即可在选择器看到正确 model id
    if (isBuiltin && isEnabled) await this.syncBuiltinModels(id)
    notifyProvidersChanged()
  },

  async addCustomProvider(p: {
    name: string
    baseUrl: string
    apiKey: string
    apiProtocol: ApiProtocol
    metadata?: string
  }): Promise<string> {
    await this.loadState()
    const id = `custom-${uuid()}`
    overrides[id] = {
      isBuiltin: 0,
      name: p.name,
      displayName: p.name,
      baseUrl: p.baseUrl,
      apiKey: p.apiKey,
      apiProtocol: p.apiProtocol,
      metadata: p.metadata ?? '',
      isEnabled: 1,
      sortOrder: customIds.length
    }
    customIds = [...customIds, id]
    await persistOverrides()
    await writeLocal(KEY_CUSTOM, customIds)
    notifyProvidersChanged()
    return id
  },

  async deleteProvider(id: string): Promise<void> {
    await this.loadState()
    delete overrides[id]
    delete models[id]
    customIds = customIds.filter((x) => x !== id)
    await persistOverrides()
    await writeLocal(KEY_CUSTOM, customIds)
    await writeLocal(KEY_MODELS, models)
    notifyProvidersChanged()
  },

  async addModel(providerId: string, modelId: string): Promise<void> {
    await this.loadState()
    const list = models[providerId] ?? []
    if (!list.some((m) => m.modelId === modelId)) {
      list.push({ modelId, isEnabled: 1, capabilities: '{}', sortOrder: list.length })
      models[providerId] = list
      await writeLocal(KEY_MODELS, models)
      notifyProvidersChanged()
    }
  },

  async deleteModel(id: string): Promise<void> {
    await this.loadState()
    const { providerId, modelId } = splitModelKey(id)
    const list = models[providerId]
    if (list) {
      models[providerId] = list.filter((m) => m.modelId !== modelId)
      await writeLocal(KEY_MODELS, models)
      notifyProvidersChanged()
    }
  },

  async toggleModelEnabled(id: string, isEnabled: boolean): Promise<void> {
    await this.loadState()
    const { providerId, modelId } = splitModelKey(id)
    const m = models[providerId]?.find((x) => x.modelId === modelId)
    if (m) {
      m.isEnabled = isEnabled ? 1 : 0
      await writeLocal(KEY_MODELS, models)
      notifyProvidersChanged()
    }
  },

  async updateModelCapabilities(id: string, capabilities: Record<string, unknown>): Promise<void> {
    await this.loadState()
    const { providerId, modelId } = splitModelKey(id)
    const m = models[providerId]?.find((x) => x.modelId === modelId)
    if (m) {
      m.capabilities = JSON.stringify(capabilities)
      await writeLocal(KEY_MODELS, models)
      notifyProvidersChanged()
    }
  },

  /**
   * 同步模型列表。
   * - 内置 provider：从 pi-ai 注册表 `getBuiltinModels(slug)` 取（与桌面 syncBuiltinModels 一致）。
   *   这点对 anthropic 协议的内置 provider（如 kimi-coding 的 kimi-for-coding）尤为关键：
   *   只有拿到 pi-ai 注册的精确 model id，resolveModel 的 getBuiltinModel 才能解析出正确 api/路径，
   *   否则回退到 openai-completions 打错端点 → 404。
   * - 自定义 provider：HTTP 拉取 /models（复用共享 fetch）。
   */
  async syncModels(
    providerId: string
  ): Promise<{ providerId: string; total: number; added: number }> {
    await this.loadState()
    const provider = this.getProviderWithKey(providerId)
    if (!provider) throw new Error(`未找到提供商：${providerId}`)

    if (provider.isBuiltin) {
      const r = await this.syncBuiltinModels(providerId)
      notifyProvidersChanged()
      return r
    }

    if (!provider.apiKey?.trim()) throw new Error('请先配置 API Key')
    const fetched = await fetchProviderModels({
      apiProtocol: provider.apiProtocol,
      apiKey: provider.apiKey,
      baseUrl: provider.baseUrl
    })
    const list = models[providerId] ?? []
    const existing = new Set(list.map((m) => m.modelId))
    let added = 0
    fetched.forEach((modelId) => {
      if (!existing.has(modelId)) {
        list.push({ modelId, isEnabled: 1, capabilities: '{}', sortOrder: list.length })
        added += 1
      }
    })
    models[providerId] = list
    await writeLocal(KEY_MODELS, models)
    notifyProvidersChanged()
    return { providerId, total: fetched.length, added }
  },

  /** 内置 provider：从 pi-ai 注册表 upsert 模型 + 能力（providerId 即 pi-ai slug） */
  async syncBuiltinModels(
    providerId: string
  ): Promise<{ providerId: string; total: number; added: number }> {
    await this.loadState()
    // 不能用 KnownProvider：pi-ai 的 KnownProvider 比 getBuiltinModels 实际接受的
    // provider 联合更宽（如 'radius'），直接取形参类型才不会漂移。
    const piModels = getBuiltinModels(providerId as Parameters<typeof getBuiltinModels>[0]) ?? []
    const list = models[providerId] ?? []
    const byId = new Map(list.map((m) => [m.modelId, m]))
    let added = 0
    piModels.forEach((pm, i) => {
      const caps = JSON.stringify({
        reasoning: pm.reasoning || false,
        vision: (pm.input as string[])?.includes('image') || false,
        maxInputTokens: pm.contextWindow,
        maxOutputTokens: pm.maxTokens
      })
      const existing = byId.get(pm.id)
      if (existing) {
        existing.capabilities = caps // 与 pi-ai 同步能力
      } else {
        // 仅同步用户已启用 provider 的模型，故默认启用即可直接在选择器出现
        list.push({ modelId: pm.id, isEnabled: 1, capabilities: caps, sortOrder: list.length + i })
        added += 1
      }
    })
    models[providerId] = list
    await writeLocal(KEY_MODELS, models)
    return { providerId, total: piModels.length, added }
  },

  /** 启动时为「已启用的内置 provider」补齐 pi-ai 模型（对齐桌面 syncAllBuiltinModels） */
  async syncEnabledBuiltinModels(): Promise<void> {
    await this.loadState()
    const enabledBuiltins = this.listProviders().filter((p) => p.isBuiltin && p.isEnabled)
    for (const p of enabledBuiltins) {
      try {
        await this.syncBuiltinModels(p.id)
      } catch {
        /* 单个 provider 失败不阻塞其余 */
      }
    }
  }
}
