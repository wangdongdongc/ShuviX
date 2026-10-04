/**
 * 桌面端模型注册表（services/models/modelRegistry.ts）—— 单例、`providers.changed` 刷新、
 * llmNetwork 接线，以及给 P1-10/P1-11 用的两个小助手。端口一律是内存假的（真 DAO 那一面在
 * providerCredentialPort.test.ts）。
 *
 *   REG-1  懒建：import 时不读端口；第一次 getModelRegistry() 才建，之后同一个实例
 *   REG-2  appEventBus 发 providers.changed → refresh：新加的自定义模型随即可见
 *   REG-3  别的事件不触发刷新
 *   REG-4  刷新失败（端口抛错）：publish 不抛、只记 warn，旧的 provider 照用
 *   REG-5  resetModelRegistry 退订；下一次 getModelRegistry() 是新实例
 *   REG-6  单例套着 llmNetwork：请求在作用域里（fetch 收到 15 分钟 dispatcher），fetch 层的成因链
 *          贴回错误文案
 *   REG-7  （原 HG-4）DB 里的 key 解析成请求凭据，process.env 与子进程环境里都没有它
 *   SEL-1..3  resolveModelSelection：会话设置里存的是 provider **行 id** → ref + pi 模型
 *   RAK-1..3  resolveRequestApiKey：订阅令牌压过 key；自定义行用自己的 key；查无此行 → undefined
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@earendil-works/pi-ai'
import type { ProviderCredentialPort, ProviderModelRow, ProviderRow } from '@shuvix/agent-runtime'

const mocks = vi.hoisted(() => ({
  warn: vi.fn(),
  port: null as unknown as ProviderCredentialPort & {
    rows: ProviderRow[]
    modelRows: ProviderModelRow[]
    oauth: Map<string, string>
    listCalls: number
    failNextList: boolean
  }
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/nonexistent/shuvix-unit/user-data', isPackaged: false }
}))
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: mocks.warn, error: vi.fn(), debug: vi.fn() })
}))
// 单例用的端口换成内存假的（真端口读的是 better-sqlite3，单测里加载不了）
vi.mock('../providerCredentialPort', () => ({
  get providerCredentialPort() {
    return mocks.port
  }
}))

import { appEventBus } from '../../../utils/appEventBus'
import { buildSpawnEnv } from '../../../utils/paths'
import { installLlmNetwork } from '../llmNetwork'
import {
  createDesktopModelRegistry,
  getModelRegistry,
  resetModelRegistry,
  resolveModelSelection,
  resolveRequestApiKey
} from '../modelRegistry'

const XAI_UUID = '0193a7c2-0000-7000-8000-0000000000a1'
const CUSTOM_UUID = '0193a7c2-0000-7000-8000-0000000000c1'
const CTX: Context = {
  systemPrompt: 'SYS',
  messages: [{ role: 'user', content: 'hi', timestamp: 1 }]
}

function builtinRow(id: string, name: string, over: Partial<ProviderRow> = {}): ProviderRow {
  return {
    id,
    name,
    displayName: '',
    isBuiltin: true,
    isEnabled: true,
    apiKey: '',
    baseUrl: '',
    apiProtocol: '',
    metadata: '',
    ...over
  }
}

function customRow(id: string, over: Partial<ProviderRow> = {}): ProviderRow {
  return {
    id,
    name: 'My Proxy',
    displayName: '',
    isBuiltin: false,
    isEnabled: true,
    apiKey: 'sk-proxy',
    baseUrl: 'http://proxy.test/v1',
    apiProtocol: 'openai-completions',
    metadata: '',
    ...over
  }
}

function modelRow(providerId: string, modelId: string): ProviderModelRow {
  return { providerId, modelId, isEnabled: true, capabilities: '{}' }
}

function makePort(rows: ProviderRow[] = [], modelRows: ProviderModelRow[] = []): typeof mocks.port {
  const port: typeof mocks.port = {
    rows,
    modelRows,
    oauth: new Map(),
    listCalls: 0,
    failNextList: false,
    listProviders: () => {
      port.listCalls += 1
      if (port.failNextList) {
        port.failNextList = false
        throw new Error('db is gone')
      }
      return port.rows
    },
    listModels: () => port.modelRows,
    readOAuth: (id) => port.oauth.get(id),
    saveOAuth: (id, json) => void port.oauth.set(id, json),
    clearOAuth: (id) => void port.oauth.delete(id)
  }
  return port
}

beforeEach(() => {
  mocks.warn.mockClear()
  mocks.port = makePort([builtinRow(XAI_UUID, 'xai', { apiKey: 'sk-xai' })])
})

afterEach(() => {
  resetModelRegistry()
  vi.unstubAllGlobals()
})

describe('the singleton', () => {
  it('REG-1 is created lazily on first use and is the same instance afterwards', () => {
    // import 之后、第一次取之前：端口一次也没读过
    expect(mocks.port.listCalls).toBe(0)

    const first = getModelRegistry()
    expect(mocks.port.listCalls).toBeGreaterThan(0)
    expect(getModelRegistry()).toBe(first)
    expect(first.models.getModel('xai', 'grok-4.5')).toBeDefined()
  })

  it('REG-2 providers.changed on the app event bus refreshes it: a new custom model shows up', async () => {
    const registry = getModelRegistry()
    expect(registry.models.getModel(CUSTOM_UUID, 'llama')).toBeUndefined()

    mocks.port.rows.push(customRow(CUSTOM_UUID))
    mocks.port.modelRows.push(modelRow(CUSTOM_UUID, 'llama'))
    // 没广播之前：provider 的形状不会自己变
    expect(registry.models.getModel(CUSTOM_UUID, 'llama')).toBeUndefined()

    appEventBus.publish({ type: 'providers.changed' })
    await vi.waitFor(() => expect(registry.models.getModel(CUSTOM_UUID, 'llama')).toBeDefined())
  })

  it('REG-3 other app events do not refresh it', async () => {
    const registry = getModelRegistry()
    mocks.port.rows.push(customRow(CUSTOM_UUID))
    mocks.port.modelRows.push(modelRow(CUSTOM_UUID, 'llama'))
    const before = mocks.port.listCalls

    appEventBus.publish({ type: 'agent.changed' })
    appEventBus.publish({ type: 'settings.changed', key: 'general.language' } as never)
    await Promise.resolve()

    expect(mocks.port.listCalls).toBe(before)
    expect(registry.models.getModel(CUSTOM_UUID, 'llama')).toBeUndefined()
  })

  it('REG-4 a failing refresh is logged, never thrown at the publisher, and keeps the old providers', async () => {
    const registry = getModelRegistry()
    mocks.port.failNextList = true

    expect(() => appEventBus.publish({ type: 'providers.changed' })).not.toThrow()
    await vi.waitFor(() => expect(mocks.warn).toHaveBeenCalled())

    expect(String(mocks.warn.mock.calls[0][0])).toContain('db is gone')
    expect(registry.models.getModel('xai', 'grok-4.5')).toBeDefined()
  })

  it('REG-5 resetModelRegistry unsubscribes; the next getModelRegistry() is a new instance', async () => {
    const first = getModelRegistry()
    resetModelRegistry()
    const calls = mocks.port.listCalls

    appEventBus.publish({ type: 'providers.changed' })
    await Promise.resolve()
    expect(mocks.port.listCalls).toBe(calls)

    expect(getModelRegistry()).not.toBe(first)
  })
})

describe('REG-6 the singleton runs requests through llmNetwork', () => {
  /** 被 installLlmNetwork 包住的「原件」fetch：每条用例换自己的 handler */
  let handler: (input: unknown, init?: RequestInit) => Promise<Response>
  const seen: Array<{ url: string; init: (RequestInit & { dispatcher?: unknown }) | undefined }> =
    []
  let realFetch: typeof globalThis.fetch

  // installLlmNetwork 幂等（模块级位）且换的是全局 fetch：整组只装一次，原件转给可替换的
  // handler。不用 vi.stubGlobal —— 顶层 afterEach 的 unstubAllGlobals 会把包装一并拆掉
  beforeAll(() => {
    realFetch = globalThis.fetch
    globalThis.fetch = ((input: unknown, init?: RequestInit) => {
      seen.push({ url: input instanceof Request ? input.url : String(input), init })
      return handler(input, init)
    }) as typeof globalThis.fetch
    installLlmNetwork()
  })

  afterAll(() => {
    globalThis.fetch = realFetch
  })

  beforeEach(() => {
    seen.length = 0
    mocks.port = makePort([customRow(CUSTOM_UUID)], [modelRow(CUSTOM_UUID, 'llama')])
  })

  async function sendOnce(): Promise<string | undefined> {
    const registry = getModelRegistry()
    const model = registry.models.getModel(CUSTOM_UUID, 'llama')
    if (!model) throw new Error('no model')
    const result = await registry.models.streamSimple(model, CTX).result()
    expect(result.stopReason).toBe('error')
    return result.errorMessage
  }

  it('the provider request reaches fetch with the long-timeout dispatcher', async () => {
    handler = async () =>
      new Response('{"error":{"message":"stub"}}', {
        status: 401,
        headers: { 'content-type': 'application/json' }
      })

    await sendOnce()

    expect(seen).toHaveLength(1)
    expect(seen[0].url).toBe('http://proxy.test/v1/chat/completions')
    const dispatcher = seen[0].init?.dispatcher as { constructor: { name: string } } | undefined
    expect(dispatcher?.constructor.name).toBe('Agent')
  })

  it('a fetch-level failure gets its cause chain appended to the error text', async () => {
    handler = async () => {
      const socket = Object.assign(new Error('other side closed'), {
        name: 'SocketError',
        code: 'UND_ERR_SOCKET'
      })
      throw new TypeError('fetch failed', { cause: socket })
    }

    const errorMessage = await sendOnce()

    expect(errorMessage).toContain(
      '(TypeError: fetch failed <- SocketError: other side closed (UND_ERR_SOCKET))'
    )
  })
})

describe('REG-7 (HG-4) provider keys never reach process.env', () => {
  const ENV = 'OPENAI_API_KEY'
  let saved: string | undefined

  beforeEach(() => {
    saved = process.env[ENV]
    delete process.env[ENV]
  })

  afterEach(() => {
    if (saved === undefined) delete process.env[ENV]
    else process.env[ENV] = saved
  })

  it('a DB key resolved into request auth leaves process.env and the spawn env untouched', async () => {
    const registry = createDesktopModelRegistry({
      port: makePort([builtinRow('openai', 'openai', { apiKey: 'sk-test' })])
    })

    const auth = await registry.models.getAuth('openai')
    // key 确实交到了请求侧 —— 走的是凭据库，不是环境变量
    expect(auth?.auth.apiKey).toBe('sk-test')
    expect(auth?.source).toBe('stored credential')

    expect(process.env[ENV]).toBeUndefined()
    const spawnEnv = buildSpawnEnv()
    expect(spawnEnv).not.toHaveProperty(ENV)
    expect(Object.values(spawnEnv)).not.toContain('sk-test')
    registry.dispose()
  })
})

describe('resolveModelSelection (sessions.settings.model holds the provider ROW id)', () => {
  it('SEL-1 a builtin row with a uuid id resolves to the slug-addressed catalog model', () => {
    const registry = createDesktopModelRegistry({ port: mocks.port })

    const hit = resolveModelSelection(registry, { provider: XAI_UUID, modelId: 'grok-4.5' })

    expect(hit?.ref).toEqual({ provider: 'xai', id: 'grok-4.5' })
    expect(hit?.model?.provider).toBe('xai')
    expect(hit?.model?.id).toBe('grok-4.5')
  })

  it('SEL-2 a custom row resolves under its row id, disabled or not', () => {
    const port = makePort(
      [customRow(CUSTOM_UUID, { isEnabled: false })],
      [modelRow(CUSTOM_UUID, 'llama')]
    )
    const registry = createDesktopModelRegistry({ port })

    const hit = resolveModelSelection(registry, { provider: CUSTOM_UUID, modelId: 'llama' })

    expect(hit?.ref).toEqual({ provider: CUSTOM_UUID, id: 'llama' })
    expect(hit?.model?.baseUrl).toBe('http://proxy.test/v1')
  })

  it('SEL-3 a deleted row → undefined; an unknown model id → the ref without a model', () => {
    const registry = createDesktopModelRegistry({ port: mocks.port })

    expect(resolveModelSelection(registry, { provider: 'gone', modelId: 'x' })).toBeUndefined()
    const miss = resolveModelSelection(registry, { provider: XAI_UUID, modelId: 'no-such-model' })
    expect(miss?.ref).toEqual({ provider: 'xai', id: 'no-such-model' })
    expect(miss?.model).toBeUndefined()
  })
})

describe('resolveRequestApiKey', () => {
  it('RAK-1 a builtin row signed in with OAuth answers the access token, not its API key', async () => {
    const port = makePort([builtinRow(XAI_UUID, 'xai', { apiKey: 'sk-xai' })])
    port.oauth.set(
      XAI_UUID,
      JSON.stringify({ access: 'acc-sub', refresh: 'ref', expires: Date.now() + 3_600_000 })
    )
    const registry = createDesktopModelRegistry({ port })

    expect(await resolveRequestApiKey(XAI_UUID, registry, port)).toBe('acc-sub')
  })

  it('RAK-2 a custom row answers its stored key; a keyless custom row answers undefined', async () => {
    const port = makePort([customRow(CUSTOM_UUID), customRow('keyless', { apiKey: '' })])
    const registry = createDesktopModelRegistry({ port })

    expect(await resolveRequestApiKey(CUSTOM_UUID, registry, port)).toBe('sk-proxy')
    expect(await resolveRequestApiKey('keyless', registry, port)).toBeUndefined()
  })

  it('RAK-3 an unknown row answers undefined without asking the models', async () => {
    const getAuth = vi.fn()
    const port = makePort([])

    expect(await resolveRequestApiKey('nope', { models: { getAuth } as never }, port)).toBe(
      undefined
    )
    expect(getAuth).not.toHaveBeenCalled()
  })
})
