/**
 * providerOAuthService —— 订阅登录的宿主编排（pi 1.0 起凭据的存 / 刷 / 给归模型层）。
 * 全程无网络：登录类用例给一个假的 `models`（login / logout 是 spy），状态与退出类用例用真的
 * agent-runtime 模型注册表跑在内存假端口上（checkAuth / logout 是真的凭据库）。
 *
 *   OAS-1  内置 xai 行（id 是 uuid）登录 → models.login('xai','oauth', {signal, notify, prompt})；
 *          事件原样转给调用方；成功 → {success:true} + 一次 providers.changed
 *   OAS-2  prompt() 一律拒绝（设备码流程不该问问题）
 *   OAS-3  自定义行（哪怕名字拼成 xai）/ 不在支持表里的内置行 → 不支持，models.login 不被调用
 *   OAS-4  同一 provider 登录进行中再登录 → 报错，login 只被调一次；pending 进行中 true、结束后 false
 *   OAS-5  cancelLogin → signal 中止、{success:false}、pending 清掉、不广播
 *   OAS-6  models.login 拒绝 → {success:false, error: 原文}，不广播
 *   OAS-7  logout → 先取消进行中的登录，再 models.logout('xai')，然后广播
 *   OAS-8  status：不支持 → 全 false/null 且不问 models；有 OAuth → connected + 原记录的 expires；
 *          只有 key / 记录坏了 → 未登录；checkAuth 抛错 → 未登录
 *   OAS-9  logout 一条自定义行 → 直接按行清残留记录（不拿 slug 去问 models）
 *   OAS-10 真注册表：status / logout 走凭据库，按 slug 找到 uuid 内置行，key 不动
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthEvent, AuthInteraction, Models } from '@earendil-works/pi-ai'
import {
  createModelRegistry,
  type ProviderCredentialPort,
  type ProviderRow
} from '@shuvix/agent-runtime'

vi.mock('electron', () => ({
  app: { getPath: () => '/nonexistent/shuvix-unit/user-data', isPackaged: false }
}))
vi.mock('../../dao/providerDao', () => ({ providerDao: {} }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
}))

import { ProviderOAuthService, type ProviderOAuthDeps } from '../providerOAuthService'

const XAI_UUID = '0193a7c2-0000-7000-8000-0000000000a1'
const CUSTOM_UUID = '0193a7c2-0000-7000-8000-0000000000c1'

type FakePort = ProviderCredentialPort & { rows: ProviderRow[]; oauth: Map<string, string> }

function row(over: Partial<ProviderRow> & Pick<ProviderRow, 'id' | 'name'>): ProviderRow {
  return {
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

function fakePort(rows: ProviderRow[]): FakePort {
  const port: FakePort = {
    rows,
    oauth: new Map(),
    listProviders: () => port.rows,
    listModels: () => [],
    readOAuth: (id) => port.oauth.get(id),
    saveOAuth: (id, json) => void port.oauth.set(id, json),
    clearOAuth: vi.fn((id: string) => void port.oauth.delete(id))
  }
  return port
}

type FakeModels = Pick<Models, 'login' | 'logout' | 'checkAuth'> & {
  login: ReturnType<typeof vi.fn>
  logout: ReturnType<typeof vi.fn>
  checkAuth: ReturnType<typeof vi.fn>
}

function fakeModels(): FakeModels {
  return {
    login: vi.fn(async () => ({ type: 'oauth', access: 'a', refresh: 'r', expires: 1 })),
    logout: vi.fn(async () => {}),
    checkAuth: vi.fn(async () => undefined)
  } as FakeModels
}

let port: FakePort
let models: FakeModels
let published: number
let service: ProviderOAuthService

function build(deps: Partial<ProviderOAuthDeps> = {}): ProviderOAuthService {
  return new ProviderOAuthService({
    models: () => models,
    port: () => port,
    publishChanged: () => {
      published += 1
    },
    ...deps
  })
}

/** login 里拿到的 interaction（第三个参数） */
function interactionOf(call = 0): AuthInteraction {
  return models.login.mock.calls[call][2] as AuthInteraction
}

/** 一个挂住、直到 signal 中止才拒绝的登录 */
function hangingLogin(): void {
  models.login.mockImplementation(
    (_id: string, _type: string, interaction: AuthInteraction) =>
      new Promise((_resolve, reject) => {
        interaction.signal?.addEventListener('abort', () => reject(new Error('aborted by user')))
      })
  )
}

beforeEach(() => {
  port = fakePort([
    row({ id: XAI_UUID, name: 'xai', apiKey: 'sk-xai' }),
    row({ id: 'openai', name: 'openai' }),
    // name 有 UNIQUE 约束，大小写不同即可：一条「拼成 xai」的自定义行
    row({ id: CUSTOM_UUID, name: 'XAI', isBuiltin: false, apiKey: 'sk-custom' })
  ])
  models = fakeModels()
  published = 0
  service = build()
})

describe('login', () => {
  it('OAS-1 a builtin xai row (uuid id) logs in through models.login under the slug', async () => {
    const events: AuthEvent[] = []
    models.login.mockImplementation(
      async (_id: string, _type: string, interaction: AuthInteraction) => {
        interaction.notify({
          type: 'device_code',
          userCode: 'ABCD-1234',
          verificationUri: 'https://accounts.x.ai/device'
        })
        interaction.notify({ type: 'progress', message: 'waiting' })
        return { type: 'oauth', access: 'a', refresh: 'r', expires: 1 }
      }
    )

    const result = await service.login(XAI_UUID, (event) => events.push(event))

    expect(result).toEqual({ success: true })
    expect(models.login).toHaveBeenCalledTimes(1)
    const [providerId, type, interaction] = models.login.mock.calls[0] as [
      string,
      string,
      AuthInteraction
    ]
    expect(providerId).toBe('xai')
    expect(type).toBe('oauth')
    expect(interaction.signal).toBeInstanceOf(AbortSignal)
    expect(interaction.signal?.aborted).toBe(false)
    expect(events).toEqual([
      {
        type: 'device_code',
        userCode: 'ABCD-1234',
        verificationUri: 'https://accounts.x.ai/device'
      },
      { type: 'progress', message: 'waiting' }
    ])
    expect(published).toBe(1)
  })

  it('OAS-2 the interaction prompt always rejects (the device-code flow asks nothing)', async () => {
    await service.login(XAI_UUID, () => {})

    await expect(interactionOf().prompt({ type: 'text', message: 'code?' })).rejects.toThrow(/text/)
  })

  it('OAS-3 a custom row spelling the slug, and a builtin row outside the list, are not supported', async () => {
    for (const id of [CUSTOM_UUID, 'openai', 'no-such-row']) {
      const result = await service.login(id, () => {})
      expect(result.success, id).toBe(false)
      expect(result.error, id).toBeTruthy()
      expect(service.supports(id), id).toBe(false)
    }
    expect(models.login).not.toHaveBeenCalled()
    expect(published).toBe(0)
    expect(service.supports(XAI_UUID)).toBe(true)
  })

  it('OAS-4 one login per provider at a time; pending is true only while it runs', async () => {
    hangingLogin()

    const first = service.login(XAI_UUID, () => {})
    await vi.waitFor(() => expect(models.login).toHaveBeenCalledTimes(1))
    expect((await service.status(XAI_UUID)).pending).toBe(true)

    const second = await service.login(XAI_UUID, () => {})
    expect(second.success).toBe(false)
    expect(second.error).toBeTruthy()
    expect(models.login).toHaveBeenCalledTimes(1)

    service.cancelLogin(XAI_UUID)
    await first
    expect((await service.status(XAI_UUID)).pending).toBe(false)
  })

  it('OAS-5 cancelLogin aborts the flow: failure result, pending cleared, nothing published', async () => {
    hangingLogin()

    const pending = service.login(XAI_UUID, () => {})
    await vi.waitFor(() => expect(models.login).toHaveBeenCalled())
    service.cancelLogin(XAI_UUID)
    const result = await pending

    expect(interactionOf().signal?.aborted).toBe(true)
    expect(result).toEqual({ success: false, error: 'aborted by user' })
    expect((await service.status(XAI_UUID)).pending).toBe(false)
    expect(published).toBe(0)
  })

  it('OAS-6 a rejected login is reported with its message and publishes nothing', async () => {
    models.login.mockRejectedValue(new Error('device code expired'))

    const result = await service.login(XAI_UUID, () => {})

    expect(result).toEqual({ success: false, error: 'device code expired' })
    expect(published).toBe(0)
  })
})

describe('logout', () => {
  it('OAS-7 cancels a running login, logs out under the slug, then publishes', async () => {
    hangingLogin()
    const pending = service.login(XAI_UUID, () => {})
    await vi.waitFor(() => expect(models.login).toHaveBeenCalled())

    await service.logout(XAI_UUID)

    expect(interactionOf().signal?.aborted).toBe(true)
    expect(models.logout).toHaveBeenCalledTimes(1)
    expect(models.logout.mock.calls[0][0]).toBe('xai')
    expect(published).toBe(1)
    expect((await pending).success).toBe(false)
  })

  it('OAS-9 a custom row is cleared by row id, never logged out under a slug', async () => {
    port.oauth.set(CUSTOM_UUID, '{"access":"stray","refresh":"r","expires":1}')

    await service.logout(CUSTOM_UUID)

    expect(models.logout).not.toHaveBeenCalled()
    expect(port.clearOAuth).toHaveBeenCalledWith(CUSTOM_UUID)
    expect(port.oauth.has(CUSTOM_UUID)).toBe(false)
    expect(published).toBe(1)
  })
})

describe('status', () => {
  it('OAS-8a unsupported rows answer all-false without asking the models', async () => {
    for (const id of [CUSTOM_UUID, 'openai', 'no-such-row']) {
      expect(await service.status(id)).toEqual({
        supported: false,
        connected: false,
        expiresAt: null,
        pending: false
      })
    }
    expect(models.checkAuth).not.toHaveBeenCalled()
  })

  it('OAS-8b connected when checkAuth answers oauth; expiresAt comes from the stored record', async () => {
    models.checkAuth.mockResolvedValue({ source: 'OAuth', type: 'oauth' })
    port.oauth.set(XAI_UUID, '{"type":"oauth","access":"a","refresh":"r","expires":1700000000000}')

    expect(await service.status(XAI_UUID)).toEqual({
      supported: true,
      connected: true,
      expiresAt: 1700000000000,
      pending: false
    })
    expect(models.checkAuth.mock.calls[0][0]).toBe('xai')
  })

  it('OAS-8c an API key alone is not "connected"; a throwing checkAuth reads as not connected', async () => {
    models.checkAuth.mockResolvedValue({ source: 'stored credential', type: 'api_key' })
    expect(await service.status(XAI_UUID)).toMatchObject({ connected: false, expiresAt: null })

    models.checkAuth.mockRejectedValue(new Error('store unreadable'))
    expect(await service.status(XAI_UUID)).toMatchObject({
      supported: true,
      connected: false,
      expiresAt: null
    })
  })
})

describe('OAS-10 against the real model registry (credential store over the fake port)', () => {
  function realService(): ProviderOAuthService {
    const registry = createModelRegistry({ port })
    return build({ models: () => registry.models })
  }

  it('status reads the uuid builtin row through the slug; a corrupt record reads as signed out', async () => {
    const svc = realService()
    expect((await svc.status(XAI_UUID)).connected).toBe(false)

    const expires = Date.now() + 3_600_000
    // 上一代写入口的记录形状（没有 type）
    port.oauth.set(XAI_UUID, JSON.stringify({ access: 'a', refresh: 'r', expires }))
    expect(await svc.status(XAI_UUID)).toEqual({
      supported: true,
      connected: true,
      expiresAt: expires,
      pending: false
    })

    port.oauth.set(XAI_UUID, '{not json')
    expect(await svc.status(XAI_UUID)).toMatchObject({ connected: false, expiresAt: null })
  })

  it('logout clears the builtin row record by its row id and keeps the API key', async () => {
    const svc = realService()
    port.oauth.set(
      XAI_UUID,
      JSON.stringify({ access: 'a', refresh: 'r', expires: Date.now() + 1e6 })
    )
    port.oauth.set(CUSTOM_UUID, JSON.stringify({ access: 'c', refresh: 'c', expires: 1 }))

    await svc.logout(XAI_UUID)

    expect(port.clearOAuth).toHaveBeenCalledWith(XAI_UUID)
    expect(port.oauth.has(XAI_UUID)).toBe(false)
    expect(port.oauth.has(CUSTOM_UUID)).toBe(true)
    expect(port.rows.find((r) => r.id === XAI_UUID)?.apiKey).toBe('sk-xai')
    expect((await svc.status(XAI_UUID)).connected).toBe(false)
  })
})
