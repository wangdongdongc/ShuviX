/**
 * 订阅登录（设置 → 提供商 → Subscription sign-in）的 e2e 夹具（`settings/provider-oauth-*`）。
 *
 *   - `startFakeKimiAuth` —— **vitest 进程里**的假 Kimi 授权服务器（RFC 8628 设备码：
 *     `/api/oauth/device_authorization` + `/api/oauth/token`），实例经 `launchApp({ env:
 *     { KIMI_CODE_OAUTH_HOST } })` 打它，从不碰 auth.kimi.com。每次设备授权发一个新的用户码 / 验证地址，
 *     轮询按 device_code 记账，「批准 / 拒绝」由 spec 决定 —— 「还在不在轮询」从服务器这一侧读；
 *   - `externalOpens` —— bootstrap.cjs 把 `shell.openExternal` 换成了记录器，这里读它记下的地址
 *     （自动打开的验证页 / 授权页、重开按钮）；
 *   - `portFree` —— 某个回环端口此刻能不能绑（OpenAI 浏览器登录的回调端口 1455 放没放）；
 *   - `providerOAuthPane` —— 设置窗口提供商页里订阅登录那一块的页面对象（`data-provider-row` /
 *     `data-oauth-*`）；`closeWindow` 关掉一个页面并等它真的没了。
 *
 * 这一块的选择器只有这两个 spec 用，跟它们的假服务器放在一起；别的 spec 也要用时挪进 pages.ts。
 */
import { existsSync, readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { sleep, until, type CdpClient } from './cdp'
import type { E2EAppBase } from './launch'

// ─── 外部打开的记录 ───

/** bootstrap.cjs 的记录文件名（在 userData 下；每行一个地址） */
export const EXTERNAL_OPEN_LOG = 'e2e-external-open.log'

/** 实例交给系统打开过的地址（按顺序）；一个都没有时回空数组 */
export function externalOpens(app: Pick<E2EAppBase, 'userData'>): string[] {
  const file = join(app.userData, EXTERNAL_OPEN_LOG)
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
}

// ─── 端口 ───

/** 某个端口此刻能不能绑（绑上立刻放掉） */
export function portFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createNetServer()
    srv.once('error', () => resolve(false))
    srv.listen(port, host, () => srv.close(() => resolve(true)))
  })
}

// ─── 假 Kimi 授权服务器 ───

type DeviceState = 'pending' | 'approved' | 'denied'

export interface FakeKimiDevice {
  deviceCode: string
  userCode: string
  /** pi 当作验证页打开的那个（`verification_uri_complete`） */
  verificationUriComplete: string
  state: DeviceState
}

export interface FakeKimiAuth {
  /** 授权服务器的根地址（给 `KIMI_CODE_OAUTH_HOST`） */
  base: string
  /** 发出过的设备授权（按顺序） */
  devices: FakeKimiDevice[]
  /** 最近一次设备授权；还没有时抛 */
  latest(): FakeKimiDevice
  /** 某个设备码收到的令牌轮询次数（不给就是全部） */
  polls(deviceCode?: string): number
  /** 批准 / 拒绝最近一次设备授权：下一次轮询拿到令牌 / access_denied */
  approve(): void
  deny(): void
  close(): Promise<void>
}

/** 令牌有效期（秒）—— 登录成功后状态里的到期时间约为 now + 它 */
export const FAKE_KIMI_EXPIRES_IN = 3600

export async function startFakeKimiAuth(): Promise<FakeKimiAuth> {
  const devices: FakeKimiDevice[] = []
  const polls: string[] = []
  let base = ''

  const reply = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()))
    req.on('end', () => {
      const form = new URLSearchParams(raw)
      if (req.method === 'POST' && req.url === '/api/oauth/device_authorization') {
        const n = String(devices.length + 1).padStart(4, '0')
        const device: FakeKimiDevice = {
          deviceCode: `e2e-device-${n}`,
          userCode: `KIMI-${n}`,
          verificationUriComplete: `${base}/device?user_code=KIMI-${n}`,
          state: 'pending'
        }
        devices.push(device)
        reply(res, 200, {
          device_code: device.deviceCode,
          user_code: device.userCode,
          verification_uri: `${base}/device`,
          verification_uri_complete: device.verificationUriComplete,
          // pi 把轮询间隔钳在 ≥ 1 秒
          interval: 1,
          expires_in: 600
        })
        return
      }
      if (req.method === 'POST' && req.url === '/api/oauth/token') {
        const deviceCode = form.get('device_code') ?? ''
        polls.push(deviceCode)
        const device = devices.find((d) => d.deviceCode === deviceCode)
        if (!device) return reply(res, 400, { error: 'invalid_grant' })
        if (device.state === 'denied') return reply(res, 400, { error: 'access_denied' })
        if (device.state === 'pending') return reply(res, 400, { error: 'authorization_pending' })
        reply(res, 200, {
          access_token: `e2e-access-${device.deviceCode}`,
          refresh_token: `e2e-refresh-${device.deviceCode}`,
          expires_in: FAKE_KIMI_EXPIRES_IN,
          token_type: 'Bearer'
        })
        return
      }
      reply(res, 404, { error: 'not_found' })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  const latest = (): FakeKimiDevice => {
    const device = devices.at(-1)
    if (!device) throw new Error('the fake Kimi auth host has issued no device code yet')
    return device
  }
  return {
    base,
    devices,
    latest,
    polls: (deviceCode) =>
      deviceCode === undefined ? polls.length : polls.filter((d) => d === deviceCode).length,
    approve: () => void (latest().state = 'approved'),
    deny: () => void (latest().state = 'denied'),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}

// ─── 设置窗口：提供商页的订阅登录块 ───

/** 订阅登录块此刻的样子（选中的那一家） */
export interface OAuthBlockState {
  /** 登录按钮的文字（没有按钮为 null） */
  signin: string | null
  connected: boolean
  signout: boolean
  /** 进行中（有取消按钮） */
  cancel: boolean
  /** 设备码（没有为 null） */
  deviceCode: string | null
  /** 浏览器登录的提示（没有为 null） */
  browser: string | null
  reopen: boolean
  /** 提问输入框（没有为 null） */
  prompt: { type: string; placeholder: string } | null
  /** 错误文字（没有为 null） */
  error: string | null
}

export interface ProviderOAuthPane {
  /** 点列表里的那一行（等它出现） */
  selectProvider(id: string): Promise<void>
  /** 订阅登录块此刻的样子 */
  state(): Promise<OAuthBlockState>
  /** 等状态满足条件（回最后一次读到的状态） */
  waitFor(
    pred: (s: OAuthBlockState) => boolean,
    what: string,
    timeoutMs?: number
  ): Promise<OAuthBlockState>
  signIn(): Promise<void>
  cancel(): Promise<void>
  signOut(): Promise<void>
  reopen(): Promise<void>
  /** 往提问输入框里写一段并点提交 */
  answer(value: string): Promise<void>
}

export function providerOAuthPane(settings: CdpClient): ProviderOAuthPane {
  const clickOAuth = async (name: string): Promise<void> => {
    const sel = `[data-oauth-${name}]`
    await until(
      () => settings.eval<boolean>(`!!document.querySelector(${JSON.stringify(sel)})`),
      `${sel} present`
    )
    await settings.eval(`document.querySelector(${JSON.stringify(sel)}).click()`)
  }
  const state = (): Promise<OAuthBlockState> =>
    settings.eval<OAuthBlockState>(`(() => {
      const q = (name) => document.querySelector('[data-oauth-' + name + ']')
      const text = (name) => { const el = q(name); return el ? (el.textContent || '').trim() : null }
      const prompt = q('prompt')
      return {
        signin: text('signin'),
        connected: !!q('connected'),
        signout: !!q('signout'),
        cancel: !!q('cancel'),
        deviceCode: text('device-code'),
        browser: text('browser'),
        reopen: !!q('reopen'),
        prompt: prompt ? { type: prompt.type, placeholder: prompt.placeholder } : null,
        error: text('error')
      }
    })()`)
  return {
    async selectProvider(id) {
      const sel = `[data-provider-row=${JSON.stringify(id)}]`
      await until(
        () => settings.eval<boolean>(`!!document.querySelector(${JSON.stringify(sel)})`),
        `provider row ${id}`
      )
      await settings.eval(`document.querySelector(${JSON.stringify(sel)}).click()`)
    },
    state,
    async waitFor(pred, what, timeoutMs = 25_000) {
      let last: OAuthBlockState | undefined
      await until(
        async () => {
          last = await state()
          return pred(last)
        },
        `${what} (last: ${JSON.stringify(last)})`,
        timeoutMs
      )
      return last!
    },
    signIn: () => clickOAuth('signin'),
    cancel: () => clickOAuth('cancel'),
    signOut: () => clickOAuth('signout'),
    reopen: () => clickOAuth('reopen'),
    async answer(value) {
      await until(
        () => settings.eval<boolean>(`!!document.querySelector('[data-oauth-prompt]')`),
        '[data-oauth-prompt] present'
      )
      await settings.eval(`(() => {
        const input = document.querySelector('[data-oauth-prompt]')
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(input, ${JSON.stringify(value)})
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })()`)
      await until(
        () =>
          settings.eval<boolean>(
            `!!document.querySelector('[data-oauth-prompt-submit]') && !document.querySelector('[data-oauth-prompt-submit]').disabled`
          ),
        'prompt submit enabled'
      )
      await clickOAuth('prompt-submit')
    }
  }
}

/**
 * 关掉一个页面（`window.close()`）并等它真的没了。CDP 客户端对断连的在途 eval 会立刻失败
 * （见 cdp.ts 的 connect），但 close 与回包赛跑，所以探活用 race 而不是裸 await。
 */
export async function closeWindow(client: CdpClient): Promise<void> {
  await client.eval('window.close()').catch(() => undefined)
  await until(async () => {
    const alive = await Promise.race([
      client.eval('1 + 1').then(
        () => true,
        () => false
      ),
      sleep(800).then(() => false)
    ])
    return alive ? null : true
  }, 'window destroyed')
}
