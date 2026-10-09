/**
 * providerHandlers —— 订阅登录的两条 IPC：`provider:oauthLogin`（挂到登录结束，期间把服务的事件
 * 映射成 `provider:oauth-event` 推给**发起方窗口**）与 `provider:oauthAnswer`（回答登录中的提问）。
 *
 *   IPC-1  device_code → {providerId, kind:'device_code', userCode, verificationUri, expiresInSeconds}，
 *          并把验证页经 routeExternalUrl(verificationUri, {parent: 发起方窗口}) 打开
 *   IPC-2  auth_url → 恰为 {providerId, kind:'auth_url', url}（instructions 不下发）+ routeExternalUrl(url)
 *   IPC-3  prompt / prompt_closed 照映射，不打开任何东西
 *   IPC-4  info / progress → {kind:'message', message}
 *   IPC-5  发起方窗口已销毁：什么也不发、不抛，照样回登录结果
 *   IPC-6  原样回服务的结果（含 cancelled）
 *   IPC-7  oauthAnswer → answerPrompt(id, promptId, value)，{success} 跟着服务的答复
 *   IPC-8  routeExternalUrl 答 false / 一直不答：结果不受影响（它按构造从不拒绝，见 externalOpen/gate.ts）
 *   IPC-9  登录结束（成功 / 失败 / 取消）后推一条 {providerId, kind:'finished'}，且是最后一条；
 *          窗口已销毁则不推
 *   IPC-10 登录中窗口销毁 → cancelLogin(id)；正常结束后撤掉监听（之后再销毁不取消任何东西）
 *   IPC-11 窗口销毁之后不再打开任何外部地址
 *
 * electron 是替身（handle 收进 Map；BrowserWindow.fromWebContents 回一个可辨认的窗口）；
 * providerOAuthService / externalOpen 是 spy；发起方的 webContents 是一个 EventEmitter。
 */
import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderOAuthEvent } from '../../services/providerOAuthService'

type Handler = (event: unknown, ...args: unknown[]) => unknown

const state = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  /** fromWebContents 回的「发起方窗口」 */
  parent: { id: 'settings-window' },
  fromWebContents: [] as unknown[]
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: Handler) => {
      state.handlers.set(channel, handler)
    }
  },
  BrowserWindow: {
    fromWebContents: (contents: unknown) => {
      state.fromWebContents.push(contents)
      return state.parent
    }
  }
}))
vi.mock('../../services/externalOpen', () => ({
  routeExternalUrl: vi.fn(async () => true)
}))
vi.mock('../../services/providerService', () => ({ providerService: {} }))
vi.mock('../../services/providerOAuthService', () => ({
  providerOAuthService: {
    status: vi.fn(),
    login: vi.fn(),
    answerPrompt: vi.fn(),
    cancelLogin: vi.fn(),
    logout: vi.fn()
  }
}))

import { routeExternalUrl } from '../../services/externalOpen'
import { providerOAuthService } from '../../services/providerOAuthService'
import { registerProviderHandlers } from '../providerHandlers'

registerProviderHandlers()

const route = vi.mocked(routeExternalUrl)
const oauth = vi.mocked(providerOAuthService)

const PROVIDER = 'prov-openai'
const CHANNEL = 'provider:oauth-event'

/** 发起方的 webContents：记下发出的消息，`destroy()` 像窗口关闭那样发 'destroyed' */
class FakeSender extends EventEmitter {
  destroyed = false
  sent: Array<[string, unknown]> = []
  isDestroyed(): boolean {
    return this.destroyed
  }
  send(channel: string, payload: unknown): void {
    if (this.destroyed) throw new Error('send on a destroyed webContents')
    this.sent.push([channel, payload])
  }
  destroy(): void {
    this.destroyed = true
    this.emit('destroyed')
  }
  /** 推到 provider:oauth-event 的载荷（按顺序） */
  events(): unknown[] {
    return this.sent.filter(([channel]) => channel === CHANNEL).map(([, payload]) => payload)
  }
}

type LoginResult = { success: boolean; error?: string; cancelled?: boolean }

/**
 * 服务的 login 由用例驱动：拿到 notify 后推事件，`finish(result)` 结束。
 * 返回 IPC 那一侧的 Promise 与控制柄。
 */
async function startLogin(
  sender: FakeSender,
  id = PROVIDER
): Promise<{
  ipc: Promise<LoginResult>
  notify: (event: ProviderOAuthEvent) => void
  finish: (result: LoginResult) => void
}> {
  let notify: ((event: ProviderOAuthEvent) => void) | undefined
  let finish: ((result: LoginResult) => void) | undefined
  oauth.login.mockImplementationOnce(
    (_id: string, n: (event: ProviderOAuthEvent) => void) =>
      new Promise<LoginResult>((resolve) => {
        notify = n
        finish = resolve
      })
  )
  const handler = state.handlers.get('provider:oauthLogin')
  if (!handler) throw new Error('provider:oauthLogin not registered')
  const ipc = handler({ sender }, id) as Promise<LoginResult>
  await vi.waitFor(() => expect(notify).toBeDefined())
  return { ipc, notify: notify!, finish: finish! }
}

const invoke = (channel: string, ...args: unknown[]): unknown => {
  const handler = state.handlers.get(channel)
  if (!handler) throw new Error(`no handler for ${channel}`)
  return handler({ sender: new FakeSender() }, ...args)
}

beforeEach(() => {
  vi.clearAllMocks()
  route.mockImplementation(async () => true)
  state.fromWebContents.length = 0
})

describe('provider:oauthLogin event mapping', () => {
  it('IPC-1 device_code is forwarded without intervalSeconds and the verification page is opened on the sender’s window', async () => {
    const sender = new FakeSender()
    const { ipc, notify, finish } = await startLogin(sender)
    expect(oauth.login).toHaveBeenCalledWith(PROVIDER, expect.any(Function))

    notify({
      type: 'device_code',
      userCode: 'ABCD-1234',
      verificationUri: 'https://auth.example/device?user_code=ABCD-1234',
      intervalSeconds: 5,
      expiresInSeconds: 900
    })

    expect(sender.events()).toEqual([
      {
        providerId: PROVIDER,
        kind: 'device_code',
        userCode: 'ABCD-1234',
        verificationUri: 'https://auth.example/device?user_code=ABCD-1234',
        expiresInSeconds: 900
      }
    ])
    expect(sender.events()[0]).not.toHaveProperty('intervalSeconds')
    expect(route).toHaveBeenCalledTimes(1)
    expect(route).toHaveBeenCalledWith('https://auth.example/device?user_code=ABCD-1234', {
      parent: state.parent
    })
    expect(state.fromWebContents).toEqual([sender])

    finish({ success: true })
    await ipc
  })

  it('IPC-2 auth_url is forwarded as exactly {providerId, kind, url} and the URL is opened', async () => {
    const sender = new FakeSender()
    const { ipc, notify, finish } = await startLogin(sender)
    const url = 'https://auth.example/authorize?state=s&ext_agent_host_id=urn%3Auuid%3Ax'

    notify({ type: 'auth_url', url, instructions: 'Complete sign-in in your browser.' })

    expect(sender.events()).toStrictEqual([{ providerId: PROVIDER, kind: 'auth_url', url }])
    expect(route).toHaveBeenCalledTimes(1)
    expect(route).toHaveBeenCalledWith(url, { parent: state.parent })

    finish({ success: true })
    await ipc
  })

  it('IPC-3 prompt and prompt_closed are forwarded and open nothing', async () => {
    const sender = new FakeSender()
    const { ipc, notify, finish } = await startLogin(sender)

    notify({
      type: 'prompt',
      promptId: 'p-1',
      input: 'manual_code',
      message: 'paste the final redirect URL',
      placeholder: 'http://127.0.0.1:1455/auth/callback'
    })
    notify({ type: 'prompt', promptId: 'p-2', input: 'secret', message: 'Password?' })
    notify({ type: 'prompt_closed', promptId: 'p-1' })

    expect(sender.events()).toEqual([
      {
        providerId: PROVIDER,
        kind: 'prompt',
        promptId: 'p-1',
        input: 'manual_code',
        message: 'paste the final redirect URL',
        placeholder: 'http://127.0.0.1:1455/auth/callback'
      },
      {
        providerId: PROVIDER,
        kind: 'prompt',
        promptId: 'p-2',
        input: 'secret',
        message: 'Password?'
      },
      { providerId: PROVIDER, kind: 'prompt_closed', promptId: 'p-1' }
    ])
    expect(route).not.toHaveBeenCalled()

    finish({ success: true })
    await ipc
  })

  it('IPC-4 info and progress become one-line messages', async () => {
    const sender = new FakeSender()
    const { ipc, notify, finish } = await startLogin(sender)

    notify({ type: 'info', message: 'heads up', links: [{ url: 'https://docs.example' }] })
    notify({ type: 'progress', message: 'Exchanging authorization code for tokens...' })

    expect(sender.events()).toStrictEqual([
      { providerId: PROVIDER, kind: 'message', message: 'heads up' },
      {
        providerId: PROVIDER,
        kind: 'message',
        message: 'Exchanging authorization code for tokens...'
      }
    ])
    expect(route).not.toHaveBeenCalled()

    finish({ success: true })
    await ipc
  })
})

describe('provider:oauthLogin lifetime', () => {
  it('IPC-5 a destroyed sender gets nothing, nothing throws, and the result still comes back', async () => {
    const sender = new FakeSender()
    const { ipc, notify, finish } = await startLogin(sender)
    sender.destroy()

    expect(() => {
      notify({ type: 'device_code', userCode: 'X', verificationUri: 'https://auth.example/d' })
      notify({ type: 'auth_url', url: 'https://auth.example/a' })
      notify({ type: 'prompt', promptId: 'p', input: 'text', message: 'm' })
      notify({ type: 'prompt_closed', promptId: 'p' })
      notify({ type: 'progress', message: 'm' })
    }).not.toThrow()
    finish({ success: false, error: 'Login cancelled', cancelled: true })

    await expect(ipc).resolves.toEqual({
      success: false,
      error: 'Login cancelled',
      cancelled: true
    })
    expect(sender.sent).toEqual([])
  })

  it.each<LoginResult>([
    { success: true },
    { success: false, error: 'device code expired' },
    { success: false, error: 'Login cancelled', cancelled: true }
  ])(
    'IPC-6 / IPC-9 returns the service result unchanged (%o) and sends finished last',
    async (result) => {
      const sender = new FakeSender()
      const { ipc, notify, finish } = await startLogin(sender)
      notify({ type: 'progress', message: 'working' })

      finish(result)

      await expect(ipc).resolves.toStrictEqual(result)
      const events = sender.events()
      expect(events).toHaveLength(2)
      expect(events.at(-1)).toStrictEqual({ providerId: PROVIDER, kind: 'finished' })
      expect(events.filter((e) => (e as { kind: string }).kind === 'finished')).toHaveLength(1)
    }
  )

  it('IPC-9 no finished event when the sender was destroyed', async () => {
    const sender = new FakeSender()
    const { ipc, finish } = await startLogin(sender)
    sender.destroy()

    finish({ success: false, error: 'Login cancelled', cancelled: true })
    await ipc

    expect(sender.sent).toEqual([])
  })

  it('IPC-10 the sender being destroyed mid-login cancels that login', async () => {
    const sender = new FakeSender()
    const { ipc, finish } = await startLogin(sender)
    expect(oauth.cancelLogin).not.toHaveBeenCalled()

    sender.destroy()

    expect(oauth.cancelLogin).toHaveBeenCalledTimes(1)
    expect(oauth.cancelLogin).toHaveBeenCalledWith(PROVIDER)

    finish({ success: false, error: 'Login cancelled', cancelled: true })
    await ipc
    expect(oauth.cancelLogin).toHaveBeenCalledTimes(1)
  })

  it('IPC-10 after a normal settle the destroyed listener is removed: a later destroy cancels nothing', async () => {
    const sender = new FakeSender()
    const { ipc, finish } = await startLogin(sender)
    expect(sender.listenerCount('destroyed')).toBe(1)

    finish({ success: true })
    await ipc
    expect(sender.listenerCount('destroyed')).toBe(0)

    sender.destroy()
    expect(oauth.cancelLogin).not.toHaveBeenCalled()
  })

  it('IPC-11 nothing is opened externally once the sender is destroyed', async () => {
    const sender = new FakeSender()
    const { ipc, notify, finish } = await startLogin(sender)
    sender.destroy()

    notify({ type: 'device_code', userCode: 'X', verificationUri: 'https://auth.example/d' })
    notify({ type: 'auth_url', url: 'https://auth.example/a' })

    expect(route).not.toHaveBeenCalled()
    finish({ success: false, error: 'Login cancelled', cancelled: true })
    await ipc
  })

  it('IPC-8 routeExternalUrl answering false, or never answering, does not touch the result', async () => {
    route.mockImplementationOnce(async () => false)
    const sender = new FakeSender()
    const first = await startLogin(sender)
    first.notify({ type: 'device_code', userCode: 'X', verificationUri: 'https://auth.example/d' })
    first.finish({ success: true })
    await expect(first.ipc).resolves.toEqual({ success: true })

    route.mockImplementationOnce(() => new Promise<boolean>(() => {}))
    const second = await startLogin(new FakeSender())
    second.notify({ type: 'auth_url', url: 'https://auth.example/a' })
    second.finish({ success: false, error: 'boom' })
    await expect(second.ipc).resolves.toEqual({ success: false, error: 'boom' })
    expect(route).toHaveBeenCalledTimes(2)
  })
})

describe('provider:oauthAnswer', () => {
  it('IPC-7 forwards (id, promptId, value) to answerPrompt and mirrors its answer as {success}', async () => {
    oauth.answerPrompt.mockReturnValueOnce(true)
    expect(
      await invoke('provider:oauthAnswer', {
        id: PROVIDER,
        promptId: 'p-1',
        value: 'http://127.0.0.1:1455/auth/callback?code=c'
      })
    ).toEqual({ success: true })
    expect(oauth.answerPrompt).toHaveBeenLastCalledWith(
      PROVIDER,
      'p-1',
      'http://127.0.0.1:1455/auth/callback?code=c'
    )

    oauth.answerPrompt.mockReturnValueOnce(false)
    expect(
      await invoke('provider:oauthAnswer', { id: PROVIDER, promptId: 'stale', value: 'v' })
    ).toEqual({ success: false })
    expect(oauth.answerPrompt).toHaveBeenLastCalledWith(PROVIDER, 'stale', 'v')
    expect(oauth.answerPrompt).toHaveBeenCalledTimes(2)
  })
})
