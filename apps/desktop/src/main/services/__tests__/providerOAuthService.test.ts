/**
 * providerOAuthService —— 订阅登录的宿主编排（pi 1.0 起凭据的存 / 刷 / 给归模型层）。
 * 支持三家内置 provider：xai（设备码）、kimi-coding（设备码）、openai（浏览器回调 + manual_code 提问）。
 *
 * 除 RR-2 / RR-3 外全程无网络：登录类用例给一个假的 `models`（login / logout 是 spy），状态与退出类
 * 用例用真的 agent-runtime 模型注册表跑在内存假端口上（checkAuth / logout 是真的凭据库）。RR-2 / RR-3
 * 让真的 pi Kimi 流程打一个**进程内**的假授权服务器（`KIMI_CODE_OAUTH_HOST` 指过去），从不碰 auth.kimi.com；
 * RR-1 让真的 OpenAI 流程在绑定 1455 端口**之前**就失败（设备 ID 不合法），从不碰 auth.openai.com。
 *
 * 行与支持：
 *   OAS-3′ 三家内置行（含 uuid id 的旧库）supports / login / status 都认；anthropic、拼成同名的自定义行、
 *          不存在的 id 一律不支持 —— login 直接失败且 models.login 不被调用，status 恰为四个假值（不带 slug）
 *   OAS-1′ 三家各登录一次：models.login(<slug>,'oauth',{signal,notify,prompt},{getDeviceId})；成功 →
 *          {success:true} + 一次 providers.changed
 *   OAS-8b′ status.slug 按行给；pending 只在**那一行**的登录进行中为 true
 *   EV-1   device_code / auth_url（带 instructions）/ info / progress 原样、按序到 notify
 *   OAS-4  同一 provider 登录进行中再登录 → 报错，login 只被调一次
 *   OAS-5′ cancelLogin → {success:false, error, cancelled:true}；OAS-6′ 普通失败恰为 {success:false,error}
 *   LC-1 / LC-2 登录名额在结束后释放；取消一行不影响另一行，空取消什么也不做
 * 提问桥（PB-*）：pi 的 `prompt()` 变成界面的 prompt / prompt_closed 一对事件，`answerPrompt` 送回答案。
 *   PB-1 manual_code 被回答；PB-2 text / secret 保留种类、没有 placeholder 时不带这个键；PB-3 select 拒绝
 *   且不推事件、登录失败点名 select；PB-4 pi 中止提问 → 拒绝、恰一条 prompt_closed、之后答不上；PB-5 已中止
 *   的 signal → 立即拒绝、不推事件；PB-6 id 不对 → false 且提问仍可答；PB-7 新提问取代旧的；PB-8 重复回答；
 *   PB-9 取消登录时提问开着；PB-10 / PB-11 登录结束（成功 / 失败）时提问还开着 → finally 收起；PB-12 经别的
 *   行回答 → false；PB-13 两个登录并行互不串；PB-14 没有登录时回答 → false
 * 安装 ID（DID-*）：OpenAI 要的稳定 UUID —— 注入的照用；缺省实现存在设置表 `provider.oauthDeviceId`，
 *   第一次要时生成并只写一次、之后（含新实例）恒同、已存的原样返回、不问的流程（xai / kimi）一笔不写
 * 真注册表（OAS-10 / RR-*）：status / logout 走凭据库；RR-1 设备 ID 经 options 真的到了 pi；RR-2 完整的
 *   Kimi 设备码流程落库、status 报到期时间、logout 只清凭据；RR-3 拒绝授权 / 轮询中取消
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthEvent, AuthInteraction, Models } from '@earendil-works/pi-ai'
import {
  createModelRegistry,
  type ProviderCredentialPort,
  type ProviderRow
} from '@shuvix/agent-runtime'

const hoisted = vi.hoisted(() => ({
  /** 设置表（内存）：key → value */
  settings: new Map<string, string>(),
  /** 设置表的每一次写入（断言「只写一次」「一笔不写」） */
  upserts: [] as Array<[string, string]>,
  /** 缺省依赖拿到的 models / port（`new ProviderOAuthService()` 用，见 DID-*） */
  models: undefined as unknown,
  port: undefined as unknown
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/nonexistent/shuvix-unit/user-data', isPackaged: false }
}))
vi.mock('../../dao/providerDao', () => ({ providerDao: {} }))
// dao/database.ts 一 import 就建库 —— 设置表换成内存 Map（形状同 SettingsDao 的两个方法）
vi.mock('../../dao/settingsDao', () => ({
  settingsDao: {
    findByKey: (key: string) => hoisted.settings.get(key),
    upsert: (key: string, value: string) => {
      hoisted.upserts.push([key, value])
      hoisted.settings.set(key, value)
    }
  }
}))
// 缺省依赖的模型层接线：转给当前用例的假 models / 假端口
vi.mock('../models', () => ({
  getModelRegistry: () => ({ models: hoisted.models }),
  providerCredentialPort: {
    listProviders: () => (hoisted.port as ProviderCredentialPort).listProviders(),
    readOAuth: (id: string) => (hoisted.port as ProviderCredentialPort).readOAuth(id),
    clearOAuth: (id: string) => (hoisted.port as ProviderCredentialPort).clearOAuth(id)
  }
}))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
}))

import {
  ProviderOAuthService,
  type ProviderOAuthDeps,
  type ProviderOAuthEvent
} from '../providerOAuthService'

const XAI_UUID = '0193a7c2-0000-7000-8000-0000000000a1'
const KIMI_UUID = '0193a7c2-0000-7000-8000-0000000000b1'
const CUSTOM_UUID = '0193a7c2-0000-7000-8000-0000000000c1'
const CUSTOM_OPENAI_UUID = '0193a7c2-0000-7000-8000-0000000000c2'
const CUSTOM_KIMI_UUID = '0193a7c2-0000-7000-8000-0000000000c3'
const DEVICE_ID = '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DEVICE_ID_KEY = 'provider.oauthDeviceId'

/** 三家支持的内置行：行 id → pi slug */
const SUPPORTED: ReadonlyArray<readonly [string, string]> = [
  [XAI_UUID, 'xai'],
  [KIMI_UUID, 'kimi-coding'],
  ['openai', 'openai']
]
/** 不支持的行：内置 anthropic、三条拼成支持名字的自定义行、不存在的 id */
const UNSUPPORTED = ['anthropic', CUSTOM_UUID, CUSTOM_OPENAI_UUID, CUSTOM_KIMI_UUID, 'no-such-row']

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

const CREDENTIAL = { type: 'oauth', access: 'a', refresh: 'r', expires: 1 }

function fakeModels(): FakeModels {
  return {
    login: vi.fn(async () => CREDENTIAL),
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
    deviceId: () => DEVICE_ID,
    ...deps
  })
}

/** login 里拿到的 interaction（第三个参数） */
function interactionOf(call = 0): AuthInteraction {
  return models.login.mock.calls[call][2] as AuthInteraction
}

/** login 里拿到的 options（第四个参数） */
function optionsOf(call = 0): { getDeviceId?: () => string } | undefined {
  return models.login.mock.calls[call][3] as { getDeviceId?: () => string } | undefined
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

/**
 * 由用例决定何时结束的登录：`resolve()` 成功、`reject(err)` 失败；signal 中止时以 pi 的
 * 「Login cancelled」拒绝。按调用顺序存，并行登录各取各的。
 */
interface ControlledLogin {
  interaction: AuthInteraction
  resolve: () => void
  reject: (err: Error) => void
}
function controlledLogins(): ControlledLogin[] {
  const started: ControlledLogin[] = []
  models.login.mockImplementation(
    (_id: string, _type: string, interaction: AuthInteraction) =>
      new Promise((resolve, reject) => {
        interaction.signal?.addEventListener('abort', () => reject(new Error('Login cancelled')))
        started.push({
          interaction,
          resolve: () => resolve(CREDENTIAL),
          reject
        })
      })
  )
  return started
}

/** 把一次提问的拒绝接住（免得成了未处理的 rejection），并留下结局供断言 */
interface Tracked<T> {
  promise: Promise<T>
  settled: () => 'pending' | 'resolved' | 'rejected'
  error: () => unknown
}
function track<T>(promise: Promise<T>): Tracked<T> {
  let state: 'pending' | 'resolved' | 'rejected' = 'pending'
  let reason: unknown
  promise.then(
    () => (state = 'resolved'),
    (err) => {
      state = 'rejected'
      reason = err
    }
  )
  return { promise, settled: () => state, error: () => reason }
}

const promptsOf = (
  events: ProviderOAuthEvent[]
): Extract<ProviderOAuthEvent, { type: 'prompt' }>[] =>
  events.filter((e): e is Extract<ProviderOAuthEvent, { type: 'prompt' }> => e.type === 'prompt')
const closedOf = (events: ProviderOAuthEvent[]): string[] =>
  events.flatMap((e) => (e.type === 'prompt_closed' ? [e.promptId] : []))

/** 微任务排空（提问的开 / 关都是同步通知，Promise 的结局要等一拍） */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  port = fakePort([
    row({ id: XAI_UUID, name: 'xai', apiKey: 'sk-xai' }),
    row({ id: KIMI_UUID, name: 'kimi-coding', apiKey: 'sk-kimi' }),
    row({ id: 'openai', name: 'openai' }),
    row({ id: 'anthropic', name: 'anthropic' }),
    // 名字有 UNIQUE 约束（大小写不同即可）：一条「拼成 xai」的自定义行
    row({ id: CUSTOM_UUID, name: 'XAI', isBuiltin: false, apiKey: 'sk-custom' }),
    // 假端口不查 UNIQUE：两条名字与支持的 slug 一字不差的自定义行（判据是 isBuiltin，不是名字）
    row({ id: CUSTOM_OPENAI_UUID, name: 'openai', isBuiltin: false, apiKey: 'sk-c-openai' }),
    row({ id: CUSTOM_KIMI_UUID, name: 'kimi-coding', isBuiltin: false, apiKey: 'sk-c-kimi' })
  ])
  models = fakeModels()
  published = 0
  service = build()
  hoisted.settings.clear()
  hoisted.upserts.length = 0
  hoisted.models = models
  hoisted.port = port
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('which rows support subscription sign-in', () => {
  it('OAS-3′ the three builtin rows (incl. uuid ids) are supported; look-alikes and others are not', async () => {
    for (const [id] of SUPPORTED) expect(service.supports(id), id).toBe(true)

    for (const id of UNSUPPORTED) {
      expect(service.supports(id), id).toBe(false)
      const result = await service.login(id, () => {})
      expect(result.success, id).toBe(false)
      expect(result.error, id).toBeTruthy()
      expect(result.cancelled, id).toBeUndefined()
      // 不支持的状态恰是四个假值：不带 slug 这个键
      expect(await service.status(id), id).toStrictEqual({
        supported: false,
        connected: false,
        expiresAt: null,
        pending: false
      })
    }
    expect(models.login).not.toHaveBeenCalled()
    expect(models.checkAuth).not.toHaveBeenCalled()
    expect(published).toBe(0)
  })
})

describe('login', () => {
  it.each(SUPPORTED)(
    'OAS-1′ row %s logs in through models.login under slug %s with the device-id option',
    async (id, slug) => {
      const events: ProviderOAuthEvent[] = []
      const result = await service.login(id, (event) => events.push(event))

      expect(result).toEqual({ success: true })
      expect(models.login).toHaveBeenCalledTimes(1)
      const [providerId, type, interaction, options] = models.login.mock.calls[0] as [
        string,
        string,
        AuthInteraction,
        { getDeviceId?: () => string }
      ]
      expect(providerId).toBe(slug)
      expect(type).toBe('oauth')
      expect(interaction.signal).toBeInstanceOf(AbortSignal)
      expect(interaction.signal?.aborted).toBe(false)
      expect(typeof interaction.notify).toBe('function')
      expect(typeof interaction.prompt).toBe('function')
      // notify 就是调用方的那一个：pi 推的事件原样到调用方
      interaction.notify({ type: 'progress', message: 'late' })
      expect(events).toEqual([{ type: 'progress', message: 'late' }])
      expect(typeof options.getDeviceId).toBe('function')
      expect(options.getDeviceId?.()).toBe(DEVICE_ID)
      expect(published).toBe(1)
    }
  )

  it('EV-1 device_code / auth_url / info / progress reach notify unchanged and in order', async () => {
    const piEvents: AuthEvent[] = [
      {
        type: 'device_code',
        userCode: 'ABCD-1234',
        verificationUri: 'https://accounts.x.ai/device?code=ABCD-1234',
        intervalSeconds: 5,
        expiresInSeconds: 900
      },
      {
        type: 'auth_url',
        url: 'https://auth.example/authorize?state=s',
        instructions: 'Complete sign-in in your browser.'
      },
      {
        type: 'info',
        message: 'heads up',
        links: [{ url: 'https://docs.example', label: 'docs' }]
      },
      { type: 'progress', message: 'Exchanging authorization code for tokens...' }
    ]
    models.login.mockImplementation(
      async (_id: string, _type: string, interaction: AuthInteraction) => {
        for (const event of piEvents) interaction.notify(event)
        return CREDENTIAL
      }
    )
    const events: ProviderOAuthEvent[] = []

    expect(await service.login('openai', (event) => events.push(event))).toEqual({ success: true })
    expect(events).toEqual(piEvents)
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

  it('OAS-5′ cancelLogin aborts the flow: cancelled result, pending cleared, nothing published', async () => {
    hangingLogin()

    const pending = service.login(XAI_UUID, () => {})
    await vi.waitFor(() => expect(models.login).toHaveBeenCalled())
    service.cancelLogin(XAI_UUID)
    const result = await pending

    expect(interactionOf().signal?.aborted).toBe(true)
    expect(result).toEqual({ success: false, error: 'aborted by user', cancelled: true })
    expect((await service.status(XAI_UUID)).pending).toBe(false)
    expect(published).toBe(0)
  })

  it('OAS-6′ a plain failure is reported with its message, carries no cancelled key, publishes nothing', async () => {
    models.login.mockRejectedValue(new Error('device code expired'))

    const result = await service.login(XAI_UUID, () => {})

    expect(result).toStrictEqual({ success: false, error: 'device code expired' })
    expect(published).toBe(0)
  })

  it('LC-1 the login slot is released after a finished login: the same row can sign in again with a fresh signal', async () => {
    expect(await service.login(KIMI_UUID, () => {})).toEqual({ success: true })
    models.login.mockRejectedValueOnce(new Error('boom'))
    expect((await service.login(KIMI_UUID, () => {})).success).toBe(false)
    expect(await service.login(KIMI_UUID, () => {})).toEqual({ success: true })

    expect(models.login).toHaveBeenCalledTimes(3)
    expect(interactionOf(2).signal?.aborted).toBe(false)
    expect(interactionOf(2).signal).not.toBe(interactionOf(0).signal)
  })

  it('LC-2 cancelling one row leaves another row’s login running; cancelling with no login is a no-op', async () => {
    const logins = controlledLogins()
    const xai = service.login(XAI_UUID, () => {})
    const openai = service.login('openai', () => {})
    await vi.waitFor(() => expect(logins).toHaveLength(2))

    service.cancelLogin(XAI_UUID)
    expect(await xai).toMatchObject({ success: false, cancelled: true })
    expect(logins[1].interaction.signal?.aborted).toBe(false)
    expect((await service.status('openai')).pending).toBe(true)

    // 没有登录在跑的行 / 不支持的行：什么也不发生
    expect(() => service.cancelLogin(KIMI_UUID)).not.toThrow()
    expect(() => service.cancelLogin('anthropic')).not.toThrow()

    logins[1].resolve()
    expect(await openai).toEqual({ success: true })
    expect(published).toBe(1)
  })
})

describe('prompt bridge', () => {
  /** 在 openai 行起一个由用例控制的登录，返回它的 interaction 与事件流 */
  async function startOpenAI(): Promise<{
    login: Promise<{ success: boolean; error?: string; cancelled?: boolean }>
    control: ControlledLogin
    events: ProviderOAuthEvent[]
  }> {
    const logins = controlledLogins()
    const events: ProviderOAuthEvent[] = []
    const login = service.login('openai', (event) => events.push(event))
    await vi.waitFor(() => expect(logins).toHaveLength(1))
    return { login, control: logins[0], events }
  }

  it('PB-1 a manual_code prompt reaches the UI, is answered, and closes exactly once', async () => {
    const { login, control, events } = await startOpenAI()

    const answer = track(
      control.interaction.prompt({
        type: 'manual_code',
        message: 'paste the final redirect URL',
        placeholder: 'http://127.0.0.1:1455/auth/callback'
      })
    )
    const [prompt] = promptsOf(events)
    expect(prompt).toEqual({
      type: 'prompt',
      promptId: expect.any(String),
      input: 'manual_code',
      message: 'paste the final redirect URL',
      placeholder: 'http://127.0.0.1:1455/auth/callback'
    })
    expect(prompt.promptId).not.toBe('')

    expect(service.answerPrompt('openai', prompt.promptId, 'http://127.0.0.1:1455/x')).toBe(true)
    await expect(answer.promise).resolves.toBe('http://127.0.0.1:1455/x')
    expect(closedOf(events)).toEqual([prompt.promptId])

    control.resolve()
    expect(await login).toEqual({ success: true })
    // 登录收尾不再补一条 prompt_closed（提问已经收过了）
    expect(closedOf(events)).toEqual([prompt.promptId])
  })

  it('PB-2 text and secret prompts keep their kind; no placeholder key when the flow gave none', async () => {
    const { login, control, events } = await startOpenAI()

    const text = track(control.interaction.prompt({ type: 'text', message: 'Code?' }))
    const textEvent = promptsOf(events)[0]
    expect(textEvent).toEqual({
      type: 'prompt',
      promptId: expect.any(String),
      input: 'text',
      message: 'Code?'
    })
    expect('placeholder' in textEvent).toBe(false)
    expect(service.answerPrompt('openai', textEvent.promptId, 'abc')).toBe(true)
    await expect(text.promise).resolves.toBe('abc')

    const secret = track(
      control.interaction.prompt({ type: 'secret', message: 'Password?', placeholder: '••••' })
    )
    const secretEvent = promptsOf(events)[1]
    expect(secretEvent).toEqual({
      type: 'prompt',
      promptId: expect.any(String),
      input: 'secret',
      message: 'Password?',
      placeholder: '••••'
    })
    expect(secretEvent.promptId).not.toBe(textEvent.promptId)
    expect(service.answerPrompt('openai', secretEvent.promptId, 'hunter2')).toBe(true)
    await expect(secret.promise).resolves.toBe('hunter2')

    control.resolve()
    await login
  })

  it('PB-3 a select prompt is refused: no prompt event, and the login fails naming select', async () => {
    models.login.mockImplementation(
      async (_id: string, _type: string, interaction: AuthInteraction) => {
        await interaction.prompt({
          type: 'select',
          message: 'Pick an account',
          options: [{ id: 'a', label: 'A' }]
        })
        return CREDENTIAL
      }
    )
    const events: ProviderOAuthEvent[] = []

    const result = await service.login('openai', (event) => events.push(event))

    expect(result.success).toBe(false)
    expect(result.cancelled).toBeUndefined()
    expect(result.error).toMatch(/select/)
    expect(events.filter((e) => e.type === 'prompt' || e.type === 'prompt_closed')).toEqual([])
    expect(published).toBe(0)
  })

  it('PB-4 pi aborting the prompt (the callback won) rejects it, closes it once, and a late answer is refused', async () => {
    const { login, control, events } = await startOpenAI()
    const promptAbort = new AbortController()

    const answer = track(
      control.interaction.prompt({
        type: 'manual_code',
        message: 'paste',
        signal: promptAbort.signal
      })
    )
    const [prompt] = promptsOf(events)
    promptAbort.abort()
    await flush()

    expect(answer.settled()).toBe('rejected')
    expect(closedOf(events)).toEqual([prompt.promptId])
    expect(service.answerPrompt('openai', prompt.promptId, 'too late')).toBe(false)

    control.resolve()
    expect(await login).toEqual({ success: true })
    expect(closedOf(events)).toEqual([prompt.promptId])
  })

  it('PB-5 a prompt whose signal is already aborted rejects at once and sends nothing', async () => {
    const { login, control, events } = await startOpenAI()
    const aborted = new AbortController()
    aborted.abort()

    await expect(
      control.interaction.prompt({ type: 'manual_code', message: 'paste', signal: aborted.signal })
    ).rejects.toThrow()
    expect(events).toEqual([])

    control.resolve()
    await login
    expect(closedOf(events)).toEqual([])
  })

  it('PB-6 an answer with the wrong prompt id is refused and the prompt stays answerable', async () => {
    const { login, control, events } = await startOpenAI()

    const answer = track(control.interaction.prompt({ type: 'manual_code', message: 'paste' }))
    const [prompt] = promptsOf(events)

    expect(service.answerPrompt('openai', `${prompt.promptId}-x`, 'nope')).toBe(false)
    await flush()
    expect(answer.settled()).toBe('pending')
    expect(closedOf(events)).toEqual([])

    expect(service.answerPrompt('openai', prompt.promptId, 'yes')).toBe(true)
    await expect(answer.promise).resolves.toBe('yes')

    control.resolve()
    await login
  })

  it('PB-7 a newer prompt supersedes the open one: A closes before B opens, only B is answerable', async () => {
    const { login, control, events } = await startOpenAI()

    const first = track(control.interaction.prompt({ type: 'text', message: 'A' }))
    const second = track(control.interaction.prompt({ type: 'text', message: 'B' }))
    const [a, b] = promptsOf(events)
    expect(a.message).toBe('A')
    expect(b.message).toBe('B')
    expect(events.map((e) => [e.type, 'promptId' in e ? e.promptId : ''])).toEqual([
      ['prompt', a.promptId],
      ['prompt_closed', a.promptId],
      ['prompt', b.promptId]
    ])
    await flush()
    expect(first.settled()).toBe('rejected')

    expect(service.answerPrompt('openai', a.promptId, 'for A')).toBe(false)
    expect(service.answerPrompt('openai', b.promptId, 'for B')).toBe(true)
    await expect(second.promise).resolves.toBe('for B')

    control.resolve()
    await login
  })

  it('PB-8 answering twice: the second answer is refused, one resolve, one prompt_closed', async () => {
    const { login, control, events } = await startOpenAI()
    let resolutions = 0

    const answer = control.interaction
      .prompt({ type: 'manual_code', message: 'paste' })
      .then((v) => {
        resolutions += 1
        return v
      })
    const [prompt] = promptsOf(events)

    expect(service.answerPrompt('openai', prompt.promptId, 'first')).toBe(true)
    expect(service.answerPrompt('openai', prompt.promptId, 'second')).toBe(false)
    await expect(answer).resolves.toBe('first')
    await flush()
    expect(resolutions).toBe(1)
    expect(closedOf(events)).toEqual([prompt.promptId])

    control.resolve()
    await login
  })

  it('PB-9 cancelling the login with a prompt open closes it, rejects it, and reports cancelled', async () => {
    const events: ProviderOAuthEvent[] = []
    let answer: Tracked<string> | undefined
    // pi 的形状：提问挂在登录的 signal 上，登录等的就是这个提问
    models.login.mockImplementation(
      async (_id: string, _type: string, interaction: AuthInteraction) => {
        answer = track(
          interaction.prompt({ type: 'manual_code', message: 'paste', signal: interaction.signal })
        )
        await answer.promise
        return CREDENTIAL
      }
    )
    const login = service.login('openai', (event) => events.push(event))
    await vi.waitFor(() => expect(promptsOf(events)).toHaveLength(1))
    const [prompt] = promptsOf(events)

    service.cancelLogin('openai')
    const result = await login

    expect(closedOf(events)).toEqual([prompt.promptId])
    expect(answer?.settled()).toBe('rejected')
    expect(result.success).toBe(false)
    expect(result.cancelled).toBe(true)
    expect(published).toBe(0)
    expect(service.answerPrompt('openai', prompt.promptId, 'late')).toBe(false)
    expect((await service.status('openai')).pending).toBe(false)
  })

  it('PB-10 the login succeeding with a prompt still open: the finally closes it, a late answer is refused', async () => {
    const { login, control, events } = await startOpenAI()

    // 不带 signal 的提问：只有登录收尾能收起它
    const answer = track(control.interaction.prompt({ type: 'manual_code', message: 'paste' }))
    const [prompt] = promptsOf(events)

    control.resolve()
    expect(await login).toEqual({ success: true })
    await flush()

    expect(closedOf(events)).toEqual([prompt.promptId])
    expect(answer.settled()).toBe('rejected')
    expect(service.answerPrompt('openai', prompt.promptId, 'late')).toBe(false)
    expect(published).toBe(1)
  })

  it('PB-11 the login failing with a prompt still open: same cleanup, error result, nothing published', async () => {
    const { login, control, events } = await startOpenAI()

    const answer = track(control.interaction.prompt({ type: 'manual_code', message: 'paste' }))
    const [prompt] = promptsOf(events)

    control.reject(new Error('Port 1455 is in use'))
    expect(await login).toStrictEqual({ success: false, error: 'Port 1455 is in use' })
    await flush()

    expect(closedOf(events)).toEqual([prompt.promptId])
    expect(answer.settled()).toBe('rejected')
    expect(service.answerPrompt('openai', prompt.promptId, 'late')).toBe(false)
    expect(published).toBe(0)
  })

  it('PB-12 an answer sent through another row (the xai row, a custom "openai" row) is refused', async () => {
    const { login, control, events } = await startOpenAI()

    const answer = track(control.interaction.prompt({ type: 'manual_code', message: 'paste' }))
    const [prompt] = promptsOf(events)

    expect(service.answerPrompt(XAI_UUID, prompt.promptId, 'wrong row')).toBe(false)
    expect(service.answerPrompt(CUSTOM_OPENAI_UUID, prompt.promptId, 'look-alike')).toBe(false)
    expect(service.answerPrompt('anthropic', prompt.promptId, 'unsupported')).toBe(false)
    await flush()
    expect(answer.settled()).toBe('pending')
    expect(closedOf(events)).toEqual([])

    expect(service.answerPrompt('openai', prompt.promptId, 'right row')).toBe(true)
    await expect(answer.promise).resolves.toBe('right row')

    control.resolve()
    await login
  })

  it('PB-13 two logins running at once keep their prompts and events apart', async () => {
    const logins = controlledLogins()
    const xaiEvents: ProviderOAuthEvent[] = []
    const openaiEvents: ProviderOAuthEvent[] = []
    const xai = service.login(XAI_UUID, (event) => xaiEvents.push(event))
    const openai = service.login('openai', (event) => openaiEvents.push(event))
    await vi.waitFor(() => expect(logins).toHaveLength(2))

    const xaiAnswer = track(logins[0].interaction.prompt({ type: 'text', message: 'xai?' }))
    const openaiAnswer = track(logins[1].interaction.prompt({ type: 'text', message: 'openai?' }))
    const [xaiPrompt] = promptsOf(xaiEvents)
    const [openaiPrompt] = promptsOf(openaiEvents)
    expect(promptsOf(xaiEvents).map((p) => p.message)).toEqual(['xai?'])
    expect(promptsOf(openaiEvents).map((p) => p.message)).toEqual(['openai?'])

    // 用对方的 promptId / 经对方的行都答不上
    expect(service.answerPrompt('openai', xaiPrompt.promptId, 'x')).toBe(false)
    expect(service.answerPrompt(XAI_UUID, openaiPrompt.promptId, 'x')).toBe(false)

    expect(service.answerPrompt(XAI_UUID, xaiPrompt.promptId, 'for xai')).toBe(true)
    await expect(xaiAnswer.promise).resolves.toBe('for xai')
    await flush()
    expect(openaiAnswer.settled()).toBe('pending')
    expect(closedOf(openaiEvents)).toEqual([])

    expect(service.answerPrompt('openai', openaiPrompt.promptId, 'for openai')).toBe(true)
    await expect(openaiAnswer.promise).resolves.toBe('for openai')

    logins[0].resolve()
    logins[1].resolve()
    await Promise.all([xai, openai])
    expect(closedOf(xaiEvents)).toEqual([xaiPrompt.promptId])
    expect(closedOf(openaiEvents)).toEqual([openaiPrompt.promptId])
  })

  it('PB-14 answering when no login runs is refused', () => {
    expect(service.answerPrompt('openai', 'any-id', 'value')).toBe(false)
    expect(service.answerPrompt('no-such-row', 'any-id', 'value')).toBe(false)
  })
})

describe('logout', () => {
  it('OAS-7′ cancels a running login (closing its open prompt), logs out under the slug, then publishes', async () => {
    const logins = controlledLogins()
    const events: ProviderOAuthEvent[] = []
    const pending = service.login('openai', (event) => events.push(event))
    await vi.waitFor(() => expect(logins).toHaveLength(1))
    const answer = track(logins[0].interaction.prompt({ type: 'manual_code', message: 'paste' }))
    const [prompt] = promptsOf(events)

    await service.logout('openai')

    expect(logins[0].interaction.signal?.aborted).toBe(true)
    expect(models.logout).toHaveBeenCalledTimes(1)
    expect(models.logout.mock.calls[0][0]).toBe('openai')
    expect(await pending).toMatchObject({ success: false, cancelled: true })
    await flush()
    expect(closedOf(events)).toEqual([prompt.promptId])
    expect(answer.settled()).toBe('rejected')
    expect(published).toBe(1)
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
  it.each(SUPPORTED)(
    'OAS-8b′ row %s reports slug %s; connected comes from checkAuth, expiresAt from the stored record',
    async (id, slug) => {
      models.checkAuth.mockResolvedValue({ source: 'OAuth', type: 'oauth' })
      port.oauth.set(id, '{"type":"oauth","access":"a","refresh":"r","expires":1700000000000}')

      expect(await service.status(id)).toStrictEqual({
        supported: true,
        slug,
        connected: true,
        expiresAt: 1700000000000,
        pending: false
      })
      expect(models.checkAuth.mock.calls[0][0]).toBe(slug)
    }
  )

  it('OAS-8b′ pending is true only for the row whose login is running', async () => {
    hangingLogin()
    const login = service.login(KIMI_UUID, () => {})
    await vi.waitFor(() => expect(models.login).toHaveBeenCalled())

    expect((await service.status(KIMI_UUID)).pending).toBe(true)
    expect((await service.status(XAI_UUID)).pending).toBe(false)
    expect((await service.status('openai')).pending).toBe(false)
    // 不支持的行（哪怕名字一样）永远 pending:false
    expect((await service.status(CUSTOM_KIMI_UUID)).pending).toBe(false)

    service.cancelLogin(KIMI_UUID)
    await login
    expect((await service.status(KIMI_UUID)).pending).toBe(false)
  })

  it('OAS-8c an API key alone is not "connected"; a throwing checkAuth reads as not connected', async () => {
    models.checkAuth.mockResolvedValue({ source: 'stored credential', type: 'api_key' })
    expect(await service.status(XAI_UUID)).toMatchObject({ connected: false, expiresAt: null })

    models.checkAuth.mockRejectedValue(new Error('store unreadable'))
    expect(await service.status(XAI_UUID)).toMatchObject({
      supported: true,
      slug: 'xai',
      connected: false,
      expiresAt: null
    })
  })
})

describe('installation device id', () => {
  /** 一个会向 options 要设备 ID 的登录（OpenAI 的形状），把要到的值记下来 */
  function askingLogin(asked: string[]): void {
    models.login.mockImplementation(
      async (
        _id: string,
        _type: string,
        _interaction: AuthInteraction,
        options?: { getDeviceId?: () => string }
      ) => {
        asked.push(options?.getDeviceId?.() ?? '(none)')
        return CREDENTIAL
      }
    )
  }

  it('DID-1 an injected deviceId dep is what the flow gets', async () => {
    const svc = build({ deviceId: () => 'injected-id' })
    const asked: string[] = []
    askingLogin(asked)

    await svc.login('openai', () => {})

    expect(asked).toEqual(['injected-id'])
    expect(optionsOf()?.getDeviceId?.()).toBe('injected-id')
    expect(hoisted.upserts).toEqual([])
  })

  it('DID-2 default deps: the first ask generates a UUID and stores it once under provider.oauthDeviceId', async () => {
    const svc = new ProviderOAuthService()
    const asked: string[] = []
    askingLogin(asked)

    expect(await svc.login('openai', () => {})).toEqual({ success: true })

    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatch(UUID_RE)
    expect(hoisted.upserts).toEqual([[DEVICE_ID_KEY, asked[0]]])
  })

  it('DID-3 default deps: the same id on later asks, later logins and a fresh service instance', async () => {
    const svc = new ProviderOAuthService()
    const asked: string[] = []
    askingLogin(asked)

    await svc.login('openai', () => {})
    const getDeviceId = optionsOf(0)?.getDeviceId
    asked.push(getDeviceId?.() ?? '', getDeviceId?.() ?? '')
    await svc.login('openai', () => {})
    await new ProviderOAuthService().login('openai', () => {})

    expect(asked).toHaveLength(5)
    expect(new Set(asked).size).toBe(1)
    expect(asked[0]).toMatch(UUID_RE)
    expect(hoisted.upserts).toHaveLength(1)
  })

  it('DID-4 default deps: a stored value is returned verbatim and nothing is written', async () => {
    hoisted.settings.set(DEVICE_ID_KEY, 'stored-value-kept-as-is')
    const asked: string[] = []
    askingLogin(asked)

    await new ProviderOAuthService().login('openai', () => {})

    expect(asked).toEqual(['stored-value-kept-as-is'])
    expect(hoisted.upserts).toEqual([])
  })

  it('DID-5 default deps: xai / kimi logins that never ask for the id write nothing', async () => {
    const svc = new ProviderOAuthService()

    expect(await svc.login(XAI_UUID, () => {})).toEqual({ success: true })
    expect(await svc.login(KIMI_UUID, () => {})).toEqual({ success: true })

    expect(models.login).toHaveBeenCalledTimes(2)
    expect(hoisted.upserts).toEqual([])
    expect(hoisted.settings.has(DEVICE_ID_KEY)).toBe(false)
  })
})

describe('OAS-10 against the real model registry (credential store over the fake port)', () => {
  function realService(deps: Partial<ProviderOAuthDeps> = {}): ProviderOAuthService {
    const registry = createModelRegistry({ port })
    return build({ models: () => registry.models, ...deps })
  }

  it('status reads the uuid builtin row through the slug; a corrupt record reads as signed out', async () => {
    const svc = realService()
    expect((await svc.status(XAI_UUID)).connected).toBe(false)

    const expires = Date.now() + 3_600_000
    // 上一代写入口的记录形状（没有 type）
    port.oauth.set(XAI_UUID, JSON.stringify({ access: 'a', refresh: 'r', expires }))
    expect(await svc.status(XAI_UUID)).toEqual({
      supported: true,
      slug: 'xai',
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

  it('RR-1 the device-id option reaches pi: an invalid id fails the OpenAI flow before it binds a port', async () => {
    const svc = realService({ deviceId: () => 'not-a-uuid' })
    const events: ProviderOAuthEvent[] = []

    const result = await svc.login('openai', (event) => events.push(event))

    expect(result.success).toBe(false)
    expect(result.cancelled).toBeUndefined()
    expect(result.error).toMatch(/requires a device ID/)
    // 失败在授权地址生成之前：没有 auth_url、没有提问
    expect(events).toEqual([])
    expect(port.oauth.has('openai')).toBe(false)
    expect(published).toBe(0)
  })
})

// ─── 进程内的假 Kimi 授权服务器（RR-2 / RR-3）───

interface FakeKimiAuth {
  base: string
  /** 设备授权请求的次数 */
  deviceRequests: number
  /** 令牌轮询的次数 */
  polls: number
  /** 第 n 次轮询（从 1 数）回什么 */
  answer: (poll: number) => { status: number; body: Record<string, unknown> }
  close: () => Promise<void>
}

const KIMI_USER_CODE = 'KIMI-7788'
const KIMI_EXPIRES_IN = 3600

async function startFakeKimiAuth(): Promise<FakeKimiAuth> {
  const state: FakeKimiAuth = {
    base: '',
    deviceRequests: 0,
    polls: 0,
    answer: (poll: number) =>
      poll < 2
        ? { status: 400, body: { error: 'authorization_pending' } }
        : {
            status: 200,
            body: {
              access_token: 'kimi-access',
              refresh_token: 'kimi-refresh',
              expires_in: KIMI_EXPIRES_IN,
              token_type: 'Bearer'
            }
          },
    close: async () => {}
  }
  const reply = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume()
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/api/oauth/device_authorization') {
        state.deviceRequests += 1
        reply(res, 200, {
          device_code: 'kimi-device-code',
          user_code: KIMI_USER_CODE,
          verification_uri: `${state.base}/device`,
          verification_uri_complete: `${state.base}/device?user_code=${KIMI_USER_CODE}`,
          // pi 把间隔下限钳在 1 秒
          interval: 1,
          expires_in: 600
        })
        return
      }
      if (req.method === 'POST' && req.url === '/api/oauth/token') {
        state.polls += 1
        const { status, body } = state.answer(state.polls)
        reply(res, status, body)
        return
      }
      reply(res, 404, { error: 'not_found' })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  state.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  state.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
  return state
}

describe('RR against the real registry and pi’s real Kimi device flow (in-process fake auth host)', () => {
  let fake: FakeKimiAuth

  beforeEach(async () => {
    fake = await startFakeKimiAuth()
    vi.stubEnv('KIMI_CODE_OAUTH_HOST', fake.base)
  })

  afterEach(async () => {
    await fake.close()
  })

  function realService(): ProviderOAuthService {
    const registry = createModelRegistry({ port })
    return build({ models: () => registry.models })
  }

  it('RR-2 signs in end to end: device code shown, credential stored, status connected, logout keeps the key', async () => {
    const svc = realService()
    const events: ProviderOAuthEvent[] = []

    const before = Date.now()
    const result = await svc.login(KIMI_UUID, (event) => events.push(event))
    const after = Date.now()

    expect(result).toEqual({ success: true })
    const device = events.find((e) => e.type === 'device_code')
    expect(device).toMatchObject({
      type: 'device_code',
      userCode: KIMI_USER_CODE,
      verificationUri: `${fake.base}/device?user_code=${KIMI_USER_CODE}`
    })
    expect(fake.deviceRequests).toBe(1)
    expect(fake.polls).toBe(2)
    expect(published).toBe(1)
    // 凭据落在 kimi 那一行（按行 id），别的行一条没有
    expect([...port.oauth.keys()]).toEqual([KIMI_UUID])

    const status = await svc.status(KIMI_UUID)
    expect(status).toMatchObject({
      supported: true,
      slug: 'kimi-coding',
      connected: true,
      pending: false
    })
    expect(status.expiresAt).toBeGreaterThanOrEqual(before + KIMI_EXPIRES_IN * 1000)
    expect(status.expiresAt).toBeLessThanOrEqual(after + KIMI_EXPIRES_IN * 1000)

    await svc.logout(KIMI_UUID)
    expect((await svc.status(KIMI_UUID)).connected).toBe(false)
    expect(port.oauth.has(KIMI_UUID)).toBe(false)
    expect(port.rows.find((r) => r.id === KIMI_UUID)?.apiKey).toBe('sk-kimi')
  }, 15_000)

  it('RR-3 a denied authorization fails with pi’s message and stores nothing', async () => {
    fake.answer = () => ({ status: 400, body: { error: 'access_denied' } })
    const svc = realService()

    const result = await svc.login(KIMI_UUID, () => {})

    expect(result).toStrictEqual({ success: false, error: 'Kimi Code login was denied.' })
    expect(port.oauth.size).toBe(0)
    expect((await svc.status(KIMI_UUID)).connected).toBe(false)
    expect(published).toBe(0)
  }, 15_000)

  it('RR-3 cancelling while polling ends the login as cancelled and stops polling', async () => {
    fake.answer = () => ({ status: 400, body: { error: 'authorization_pending' } })
    const svc = realService()

    const login = svc.login(KIMI_UUID, () => {})
    await vi.waitFor(() => expect(fake.polls).toBeGreaterThanOrEqual(1), { timeout: 5000 })
    svc.cancelLogin(KIMI_UUID)
    const result = await login
    const pollsAtCancel = fake.polls

    expect(result.success).toBe(false)
    expect(result.cancelled).toBe(true)
    expect(port.oauth.size).toBe(0)
    // 一个轮询间隔（1 秒）之后也没有新的轮询
    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect(fake.polls).toBe(pollsAtCancel)
  }, 15_000)
})
