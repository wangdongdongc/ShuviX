/**
 * 订阅登录 —— OpenAI（Sign in with ChatGPT，浏览器回调流程），从设置窗口的提供商页起步。
 *
 * pi 的流程在本机 127.0.0.1:1455 起回调服务器、推授权页地址（`auth_url`），同时用 `manual_code` 提问与
 * 回调赛跑（浏览器回不到本机时把最后停下的地址粘回来）。链路全是正式实现；`shell.openExternal` 被
 * bootstrap.cjs 换成记录器，所以授权页**从不真的打开**，「打开了哪个地址」读 `externalOpens(app)`。
 *
 * 从不把真的 `state` + 授权码交回去（无论回调还是粘贴）：那会让 pi 去打真的 auth.openai.com 令牌端点。
 * 粘贴的只是一个起点就不对的地址，pi 在任何网络请求之前就拒绝它。
 *
 *   E-O1 登录：浏览器提示 + 粘贴栏；记下的授权地址带 `ext_agent_host_id=urn:uuid:<设置表里
 *        provider.oauthDeviceId 的那个 id>`，回调端口被占着；取消放开端口。停机（留 HOME）重启后 id 不变，
 *        再登录一次，授权地址里还是它
 *   E-O2 粘贴 `https://example.com/x` → 显示 pi 的「must start with http://127.0.0.1:1455…」，粘贴栏消失，
 *        1455 又能绑了
 *   E-O5 取消 → 不报错、1455 放开；再登录一次显示浏览器提示，而不是「Port 1455 is in use」
 *   E-O6 登录中关掉设置窗口 → 登录被取消、1455 放开（浏览器流程本身没有期限，不取消就一直占着端口）
 *
 * 1455 在启动前就被占（开发者自己的 Codex CLI / 另一个登录）时整份跳过 —— 那时 pi 只会报端口被占，
 * 什么也测不到。界面文案随界面语言，只断 `data-oauth-*` 的有无与 pi 给的原文。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { until, type CdpClient } from '../../harness/cdp'
import { launchApp, uncaughtExceptions, type E2EApp } from '../../harness/launch'
import {
  closeWindow,
  externalOpens,
  portFree,
  providerOAuthPane,
  type ProviderOAuthPane
} from '../../harness/providerOAuthFixtures'

const CALLBACK_PORT = 1455
const REDIRECT_URI = `http://127.0.0.1:${CALLBACK_PORT}/auth/callback`
const DEVICE_ID_KEY = 'provider.oauthDeviceId'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const callbackPortBusy = !(await portFree(CALLBACK_PORT))

interface OAuthStatus {
  supported: boolean
  slug?: string
  connected: boolean
  expiresAt: number | null
  pending: boolean
}

describe.skipIf(callbackPortBusy)('OpenAI subscription sign-in (browser callback)', () => {
  let app: E2EApp | undefined
  let settings: CdpClient | undefined
  let pane: ProviderOAuthPane
  let openaiId = ''

  const live = (): E2EApp => {
    if (!app) throw new Error('app not running')
    return app
  }

  const status = (): Promise<OAuthStatus> =>
    live().main.eval<OAuthStatus>(`window.api.provider.oauthStatus(${JSON.stringify(openaiId)})`)

  const storedDeviceId = (): Promise<string | undefined> =>
    live().main.eval<string | undefined>(
      `window.api.settings.get(${JSON.stringify(DEVICE_ID_KEY)})`
    )

  /** 记下的授权页地址（按顺序） */
  const authUrls = (): URL[] =>
    externalOpens(live())
      .map((u) => new URL(u))
      .filter((u) => u.hostname === 'auth.openai.com')

  async function openProviders(): Promise<void> {
    settings = await live().openSettings('providers')
    pane = providerOAuthPane(settings)
  }

  async function atOpenAISignedOut(): Promise<void> {
    await pane.selectProvider(openaiId)
    await pane.waitFor((s) => !!s.signin && !s.cancel, 'openai sign-in button')
  }

  /** 点登录，等浏览器提示与粘贴栏；回这次记下的授权地址 */
  async function signInUntilBrowser(): Promise<URL> {
    const before = authUrls().length
    await pane.signIn()
    const shown = await pane.waitFor(
      (s) => s.browser !== null && s.prompt !== null,
      'browser hint and paste field'
    )
    expect(shown.deviceCode).toBeNull()
    expect(shown.error).toBeNull()
    expect(shown.prompt).toEqual({ type: 'text', placeholder: REDIRECT_URI })
    await until(() => authUrls().length > before, 'authorization page recorded')
    expect(authUrls()).toHaveLength(before + 1)
    return authUrls()[before]
  }

  async function cancelAndFreePort(): Promise<void> {
    await pane.cancel()
    const after = await pane.waitFor((s) => !!s.signin && !s.cancel, 'sign-in button back')
    expect(after.error).toBeNull()
    expect(after.prompt).toBeNull()
    await until(() => portFree(CALLBACK_PORT), `port ${CALLBACK_PORT} released`)
  }

  beforeAll(async () => {
    app = await launchApp()
    const rows = await live().main.eval<Array<{ id: string; name: string; isBuiltin: number }>>(
      'window.api.provider.listAll()'
    )
    const row = rows.find((r) => r.isBuiltin && r.name === 'openai')
    if (!row) throw new Error('builtin provider row openai not seeded')
    openaiId = row.id
    await openProviders()
  })

  afterAll(async () => {
    settings?.close()
    await app?.stop()
  })

  it('E-O1 the authorization URL carries the stored installation id, which survives a restart', async () => {
    expect(await status()).toEqual({
      supported: true,
      slug: 'openai',
      connected: false,
      expiresAt: null,
      pending: false
    })
    expect(await storedDeviceId()).toBeFalsy()
    await atOpenAISignedOut()

    const url = await signInUntilBrowser()
    const deviceId = await storedDeviceId()
    expect(deviceId).toMatch(UUID_RE)
    expect(url.origin + url.pathname).toBe('https://auth.openai.com/api/accounts/authorize')
    expect(url.searchParams.get('ext_agent_host_id')).toBe(`urn:uuid:${deviceId!.toLowerCase()}`)
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI)
    expect((await status()).pending).toBe(true)
    // pi 的回调服务器占着 1455
    expect(await portFree(CALLBACK_PORT)).toBe(false)

    await cancelAndFreePort()
    expect((await status()).pending).toBe(false)

    // 停机留 HOME，再起：设置表里的 id 不变，下一次授权地址里还是它
    const home = live().home
    settings?.close()
    settings = undefined
    await live().stop({ keepHome: true })
    app = await launchApp({ home })
    await openProviders()
    expect(await storedDeviceId()).toBe(deviceId)

    await atOpenAISignedOut()
    const again = await signInUntilBrowser()
    expect(again.searchParams.get('ext_agent_host_id')).toBe(`urn:uuid:${deviceId!.toLowerCase()}`)
    // 同一次安装的两次登录：state 每次都是新的
    expect(again.searchParams.get('state')).not.toBe(url.searchParams.get('state'))
    await cancelAndFreePort()
  })

  it('E-O2 pasting an address that is not the callback fails with pi’s message and frees the port', async () => {
    await atOpenAISignedOut()
    await signInUntilBrowser()

    await pane.answer('https://example.com/x')

    const failed = await pane.waitFor((s) => s.error !== null, 'error shown')
    expect(failed.error).toContain(`must start with ${REDIRECT_URI}`)
    expect(failed.prompt).toBeNull()
    expect(failed.signin).not.toBeNull()
    expect(failed.cancel).toBe(false)
    await until(() => portFree(CALLBACK_PORT), `port ${CALLBACK_PORT} released`)
    expect(await status()).toMatchObject({ connected: false, pending: false })
  })

  it('E-O5 cancel frees the port: signing in again shows the browser hint, not "Port 1455 is in use"', async () => {
    await atOpenAISignedOut()
    await signInUntilBrowser()
    await cancelAndFreePort()

    await signInUntilBrowser()
    const state = await pane.state()
    expect(state.error).toBeNull()
    expect(state.browser).not.toBeNull()

    await cancelAndFreePort()
  })

  it('E-O6 closing the settings window mid-login cancels it and frees the port', async () => {
    await atOpenAISignedOut()
    await signInUntilBrowser()
    expect(await portFree(CALLBACK_PORT)).toBe(false)

    await closeWindow(settings!)
    settings = undefined

    await until(async () => !(await status()).pending, 'login no longer pending')
    await until(() => portFree(CALLBACK_PORT), `port ${CALLBACK_PORT} released`)

    await openProviders()
    await atOpenAISignedOut()
    expect((await pane.state()).error).toBeNull()
    expect(uncaughtExceptions(live())).toBe('')
  })
})
