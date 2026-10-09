/**
 * 订阅登录 —— Kimi Code（设备码流程），从设置窗口的提供商页一路走到凭据落库，全程打**假**授权服务器。
 *
 * 链路全是正式实现：设置页 ProviderTab → preload → `provider:oauthLogin` → providerOAuthService →
 * 模型层的 `models.login('kimi-coding', 'oauth')` → pi 的 Kimi 设备码流程 → 凭据库落库。只有两处是替身：
 *   - Kimi 授权服务器是 vitest 进程里的 `startFakeKimiAuth`，实例经 `launchApp({ env })` 的
 *     `KIMI_CODE_OAUTH_HOST` 打它（pi 自己认的覆盖变量），从不碰 auth.kimi.com；
 *   - `shell.openExternal` 被 bootstrap.cjs 换成记录器：地址照样过 externalOpen 的闸，只是不真的交给
 *     系统浏览器 —— 「自动打开了哪个地址」读 `externalOpens(app)`。
 *
 *   E-K1 登录：设备码 = 假服务器发的用户码；自动打开的恰是 verification_uri_complete；假服务器那边批准 →
 *        已登录（IPC 状态 connected、到期时间约为 now + expires_in）；退出 → 登录按钮回来、IPC 未登录
 *   E-K2 重开按钮：同一个地址再记一笔（不是新的登录）
 *   E-K3 轮询中取消：不报错、登录按钮回来；假服务器之后再也收不到这次的轮询
 *   E-K4 拒绝授权：显示 pi 的「Kimi Code login was denied.」，不落库
 *   E-K5 不支持的内置行（Anthropic、Moonshot）没有登录按钮，IPC 报不支持
 *   E-K6 轮询中关掉设置窗口 → 登录被取消：假服务器之后收不到轮询；IPC 不再 pending；重开设置是登录按钮
 *
 * 五个用例共用一个实例、按顺序接力（每个用例结束时都回到「未登录、没有登录在跑」）。界面文案随界面语言，
 * 所以只断 `data-oauth-*` 的有无与 pi / 假服务器给的原文（用户码、错误句子），不认译文字面。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sleep, until, type CdpClient } from '../../harness/cdp'
import { launchApp, uncaughtExceptions, type E2EApp } from '../../harness/launch'
import {
  FAKE_KIMI_EXPIRES_IN,
  closeWindow,
  externalOpens,
  providerOAuthPane,
  startFakeKimiAuth,
  type FakeKimiAuth,
  type ProviderOAuthPane
} from '../../harness/providerOAuthFixtures'

interface OAuthStatus {
  supported: boolean
  slug?: string
  connected: boolean
  expiresAt: number | null
  pending: boolean
}

let app: E2EApp | undefined
let fake: FakeKimiAuth | undefined
let settings: CdpClient | undefined
let pane: ProviderOAuthPane
/** 各内置行的 id（按 pi slug 找；新库上 id 就是 slug，老库上是 uuid） */
const ids: Record<string, string> = {}

const live = (): E2EApp => {
  if (!app) throw new Error('app not running')
  return app
}
const auth = (): FakeKimiAuth => {
  if (!fake) throw new Error('fake Kimi auth host not running')
  return fake
}

const status = (id: string): Promise<OAuthStatus> =>
  live().main.eval<OAuthStatus>(`window.api.provider.oauthStatus(${JSON.stringify(id)})`)

/** 自动打开 / 重开过某个地址的次数 */
const opened = (url: string): number => externalOpens(live()).filter((u) => u === url).length

/** 选中 Kimi 那一行，等登录按钮出来（每个用例的起点：未登录、没有登录在跑） */
async function atKimiSignedOut(): Promise<void> {
  await pane.selectProvider(ids['kimi-coding'])
  await pane.waitFor((s) => !!s.signin && !s.cancel, 'kimi sign-in button')
}

/** 点登录，等设备码出来；回这次的设备授权 */
async function signInUntilDeviceCode(): Promise<ReturnType<FakeKimiAuth['latest']>> {
  const before = auth().devices.length
  await pane.signIn()
  await until(() => auth().devices.length > before, 'device authorization reached the fake host')
  const device = auth().latest()
  const shown = await pane.waitFor((s) => s.deviceCode !== null, 'device code shown')
  expect(shown.deviceCode).toBe(device.userCode)
  return device
}

beforeAll(async () => {
  fake = await startFakeKimiAuth()
  app = await launchApp({ env: { KIMI_CODE_OAUTH_HOST: fake.base } })
  const rows = await live().main.eval<Array<{ id: string; name: string; isBuiltin: number }>>(
    'window.api.provider.listAll()'
  )
  for (const slug of ['kimi-coding', 'anthropic', 'moonshotai']) {
    const row = rows.find((r) => r.isBuiltin && r.name === slug)
    if (!row) throw new Error(`builtin provider row ${slug} not seeded`)
    ids[slug] = row.id
  }
  settings = await live().openSettings('providers')
  pane = providerOAuthPane(settings)
})

afterAll(async () => {
  settings?.close()
  await app?.stop()
  await fake?.close()
})

describe('Kimi Code subscription sign-in (device code)', () => {
  it('E-K1 signs in through the fake host, shows the user code, opens the verification page, then signs out', async () => {
    const kimi = ids['kimi-coding']
    expect(await status(kimi)).toEqual({
      supported: true,
      slug: 'kimi-coding',
      connected: false,
      expiresAt: null,
      pending: false
    })
    await atKimiSignedOut()

    const device = await signInUntilDeviceCode()
    expect((await pane.state()).cancel).toBe(true)
    expect((await status(kimi)).pending).toBe(true)
    // 自动打开的恰是 verification_uri_complete，且只这一个
    await until(() => externalOpens(live()).length >= 1, 'verification page opened')
    expect(externalOpens(live())).toEqual([device.verificationUriComplete])

    // 至少轮询过一次「还在等」，再在服务器那边批准
    await until(() => auth().polls(device.deviceCode) >= 1, 'first token poll')
    const before = Date.now()
    auth().approve()
    const done = await pane.waitFor((s) => s.connected, 'connected')
    const after = Date.now()
    expect(done).toMatchObject({ signin: null, cancel: false, deviceCode: null, error: null })
    expect(done.signout).toBe(true)

    const signedIn = await status(kimi)
    expect(signedIn).toMatchObject({ supported: true, connected: true, pending: false })
    expect(signedIn.expiresAt).toBeGreaterThanOrEqual(before + FAKE_KIMI_EXPIRES_IN * 1000)
    expect(signedIn.expiresAt).toBeLessThanOrEqual(after + FAKE_KIMI_EXPIRES_IN * 1000)

    await pane.signOut()
    await pane.waitFor((s) => !!s.signin && !s.connected, 'sign-in button back after sign out')
    expect(await status(kimi)).toMatchObject({ connected: false, expiresAt: null, pending: false })
    expect(uncaughtExceptions(live())).toBe('')
  })

  it('E-K2 the reopen button opens the same verification page once more', async () => {
    await atKimiSignedOut()
    const device = await signInUntilDeviceCode()
    await until(() => opened(device.verificationUriComplete) === 1, 'verification page opened once')
    expect((await pane.state()).reopen).toBe(true)

    await pane.reopen()

    await until(() => opened(device.verificationUriComplete) === 2, 'verification page reopened')
    // 同一次登录：没有发起新的设备授权
    expect(auth().latest().deviceCode).toBe(device.deviceCode)

    await pane.cancel()
    await pane.waitFor((s) => !!s.signin && !s.cancel, 'sign-in button back after cancel')
  })

  it('E-K3 cancelling while polling: no error, sign-in back, and the fake host sees no more polls', async () => {
    const kimi = ids['kimi-coding']
    await atKimiSignedOut()
    const device = await signInUntilDeviceCode()
    await until(() => auth().polls(device.deviceCode) >= 1, 'first token poll')

    await pane.cancel()

    const after = await pane.waitFor((s) => !!s.signin && !s.cancel, 'sign-in button back')
    expect(after.error).toBeNull()
    expect(after.deviceCode).toBeNull()
    expect(await status(kimi)).toMatchObject({ connected: false, pending: false })
    await sleep(300)
    const polls = auth().polls(device.deviceCode)
    // 轮询间隔是 1 秒：两个半间隔里一次都没有就是停了
    await sleep(2_500)
    expect(auth().polls(device.deviceCode)).toBe(polls)
  })

  it('E-K4 a denied authorization shows pi’s message and stores nothing', async () => {
    const kimi = ids['kimi-coding']
    await atKimiSignedOut()
    await signInUntilDeviceCode()

    auth().deny()

    const failed = await pane.waitFor((s) => s.error !== null, 'error shown')
    expect(failed.error).toBe('Kimi Code login was denied.')
    expect(failed.signin).not.toBeNull()
    expect(failed.connected).toBe(false)
    expect(await status(kimi)).toMatchObject({ connected: false, pending: false })
  })

  it('E-K5 unsupported builtin rows (Anthropic, Moonshot) have no sign-in', async () => {
    for (const slug of ['anthropic', 'moonshotai']) {
      expect(await status(ids[slug]), slug).toEqual({
        supported: false,
        connected: false,
        expiresAt: null,
        pending: false
      })
      // 先落在一家支持的上（块出现），再切过去：块消失，且状态查回来之后也不再出现
      await atKimiSignedOut()
      await pane.selectProvider(ids[slug])
      await pane.waitFor((s) => s.signin === null, `${slug}: no sign-in`)
      await sleep(500)
      expect(await pane.state(), slug).toEqual({
        signin: null,
        connected: false,
        signout: false,
        cancel: false,
        deviceCode: null,
        browser: null,
        reopen: false,
        prompt: null,
        error: null
      })
    }
  })

  it('E-K6 closing the settings window mid-poll cancels the login', async () => {
    const kimi = ids['kimi-coding']
    await atKimiSignedOut()
    const device = await signInUntilDeviceCode()
    await until(() => auth().polls(device.deviceCode) >= 1, 'first token poll')
    expect((await status(kimi)).pending).toBe(true)

    await closeWindow(settings!)
    settings = undefined

    await until(async () => !(await status(kimi)).pending, 'login no longer pending')
    await sleep(300)
    const polls = auth().polls(device.deviceCode)
    await sleep(2_500)
    expect(auth().polls(device.deviceCode)).toBe(polls)
    expect(await status(kimi)).toMatchObject({ connected: false, pending: false })

    settings = await live().openSettings('providers')
    pane = providerOAuthPane(settings)
    await pane.selectProvider(kimi)
    const reopened = await pane.waitFor((s) => !!s.signin, 'sign-in button in the reopened window')
    expect(reopened.cancel).toBe(false)
    expect(reopened.deviceCode).toBeNull()
    expect(uncaughtExceptions(live())).toBe('')
  })
})
