/**
 * 网络访问（server mode phase B / C）的门、静态路由、设置页那一节、监听失败的那一行、跨重启的持久化，以及经通用设置路径
 * 关掉 —— 全部从外面看：原始 HTTP / 升级握手打到服务上，状态经主窗口 IPC 读，设置页经 pages.ts 读。
 *
 * NW-10 缺省启动；关着时风险说明也看得见
 * NW-11 输入校验：不合法的值什么也不改
 * NW-12 在设置页里打开；地址 = 本机私有 IPv4 接口 + 127.0.0.1（phase D：不再列 localhost）
 * NW-12b 在设置页里提交端口
 * NW-13 静态路由（web.html、资源、不给桌面入口、不出目录、坏请求、方法）
 * NW-14 普通请求的 Host 门
 * NW-15 升级的门（Host / Origin / 路径）；对的升级成功、设置页实时列出
 * NW-16 别的源的真网页开不了 socket；同源页面可以；关掉 tab 客户端就走
 * NW-17 （有私有网卡时）从局域网地址也能打开
 * NW-18 端口被占：错误那一行，然后恢复
 * NW-19 设置跨重启保留
 * NW-20 （最后）通用的设置路径也能关掉
 *
 * 约定同 web-client.e2e.ts：界面语言先设成 en；从不在缺省端口 7766 上打开；HTTP 探测一律连 127.0.0.1、只伪造 Host 头。
 */
import { existsSync, readFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { networkInterfaces } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import {
  connectTabPage,
  startFixtureServer,
  type FixtureServer
} from '../../harness/browserFixtures'
import { sleep, until, type CdpClient } from '../../harness/cdp'
import { freePort, launchApp, type E2EApp } from '../../harness/launch'
import {
  httpProbe,
  networkStatus,
  openWebClient,
  rawHttpProbe,
  upgradeProbe,
  type NetworkStatus,
  type WebClientHandle
} from '../../harness/networkFixtures'
import { networkSettingsPane, type NetworkSettingsShot } from '../../harness/pages'
import { sqliteJson, waitRendererReady } from '../../harness/seed'

const DESKTOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const RENDERER_OUT = join(DESKTOP_ROOT, 'out', 'renderer')
const PORT_INVALID = 'The port must be an integer between 1024 and 65535.'
const HOST_REFUSED = 'Use an IP address or localhost with the ShuviX port.'
const ORIGIN_REFUSED = 'Cross-origin WebSocket connections are refused.'

let app: E2EApp
let settings: CdpClient | undefined
let fixture: FixtureServer | undefined
let blocker: Server | undefined
/** 升级成功拿到的原始 socket（用完就毁；失败时 afterAll 兜底） */
const rawSockets: Socket[] = []
/** 开着的浏览器 tab 页面（失败时 afterAll 兜底关） */
const openTabs: Array<{ page: CdpClient | null; tabId: string }> = []
let webClient: WebClientHandle | undefined
let P = 0
let Pb = 0
let webHtml: Buffer = Buffer.alloc(0)

const status = (): Promise<NetworkStatus> => networkStatus(app.main)

const setPort = (port: unknown): Promise<NetworkStatus> =>
  app.main.eval<NetworkStatus>(`window.api.network.setPort(${JSON.stringify(port)})`)

/** 主窗口里调一次，回拒绝的消息（resolve 了 → null） */
const rejectionOf = (expr: string): Promise<string | null> =>
  app.main.eval<string | null>(`Promise.resolve().then(() => ${expr}).then(
    () => null,
    (e) => String(e?.message ?? e)
  )`)

const shotWhen = (
  pred: (s: NetworkSettingsShot) => boolean,
  what: string,
  timeoutMs?: number
): Promise<NetworkSettingsShot> =>
  until(
    async () => {
      const shot = await networkSettingsPane(settings!).shot()
      return shot.present && pred(shot) ? shot : null
    },
    what,
    timeoutMs
  )

/** spec 进程自己看到的私有 IPv4 网卡地址（与服务列出的应当相同；手写判断，不引产品的 guards.ts） */
function privateIPv4Addresses(): string[] {
  const out: string[] = []
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      const family = entry.family as unknown
      if (entry.internal || (family !== 'IPv4' && family !== 4)) continue
      const [a, b] = entry.address.split('.').map(Number)
      const isPrivate =
        a === 10 ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 169 && b === 254)
      if (isPrivate && !out.includes(entry.address)) out.push(entry.address)
    }
  }
  return out
}

const destroySockets = (): void => {
  for (const socket of rawSockets.splice(0)) socket.destroy()
}

async function closeTab(entry: { page: CdpClient | null; tabId: string }): Promise<void> {
  try {
    entry.page?.close()
  } catch {
    /* 已经关了 */
  }
  entry.page = null
  await app.main
    .eval(`window.api.browserView.closeTab(${JSON.stringify(entry.tabId)})`)
    .catch(() => undefined)
  const at = openTabs.indexOf(entry)
  if (at >= 0) openTabs.splice(at, 1)
}

beforeAll(async () => {
  app = await launchApp()
  await app.main.eval(`window.api.settings.set({ key: 'general.language', value: 'en' })`)
  await waitRendererReady(app.main)
  P = await freePort()
  do {
    Pb = await freePort()
  } while (Pb === P)
  fixture = await startFixtureServer()
  settings = await app.openSettings('general')
  webHtml = readFileSync(join(RENDERER_OUT, 'web.html'))
})

afterAll(async () => {
  destroySockets()
  if (blocker) await new Promise<void>((r) => blocker!.close(() => r()))
  if (webClient) await webClient.close().catch(() => undefined)
  if (app) for (const entry of [...openTabs]) await closeTab(entry)
  try {
    settings?.close()
  } catch {
    /* 已经关了 */
  }
  await fixture?.close().catch(() => undefined)
  await app?.stop()
})

describe('network access: guards, routes and settings', () => {
  it('NW-10 a default launch does not listen; the risk text is visible while off', async () => {
    const initial = await status()
    expect(initial).toStrictEqual({
      enabled: false,
      port: 7766,
      listening: false,
      addresses: [],
      clients: []
    })
    expect('error' in initial).toBe(false)
    expect(sqliteJson(app.home, "select key from settings where key like 'network.%'")).toEqual([])

    const shot = await shotWhen(() => true, 'network section in the settings window')
    expect(shot).toStrictEqual({
      present: true,
      toggle: 'off',
      risk: en.settings.networkRisk,
      riskVisible: true,
      addresses: [],
      clients: [],
      clientTitles: [],
      error: null
    })
  })

  it('NW-11 input validation leaves the state untouched', async () => {
    for (const bad of [80, 1023, 65536, 1.5, '8080']) {
      const message = await rejectionOf(`window.api.network.setPort(${JSON.stringify(bad)})`)
      expect(message, `setPort(${JSON.stringify(bad)})`).toContain(PORT_INVALID)
    }
    expect(await rejectionOf(`window.api.network.setEnabled('true')`)).toContain(
      'enabled must be a boolean'
    )
    expect(await status()).toMatchObject({ enabled: false, port: 7766, listening: false })
    expect(sqliteJson(app.home, "select key from settings where key like 'network.%'")).toEqual([])
  })

  it('NW-12 switching on from the Settings UI', async () => {
    expect(await setPort(P)).toMatchObject({ enabled: false, port: P, listening: false })
    await shotWhen((s) => s.toggle === 'off', 'settings switch is off')
    await networkSettingsPane(settings!).clickToggle()
    await until(async () => (await status()).listening, 'listening after the toggle')

    const on = await status()
    expect(on).toMatchObject({ enabled: true, port: P, clients: [] })
    expect('error' in on).toBe(false)
    expect(on.addresses.at(-1)).toBe(`http://127.0.0.1:${P}`)
    expect([...on.addresses.slice(0, -1)].sort()).toEqual(
      privateIPv4Addresses()
        .map((a) => `http://${a}:${P}`)
        .sort()
    )

    const shot = await shotWhen((s) => s.toggle === 'on', 'settings switch is on')
    expect(shot).toMatchObject({ toggle: 'on', addresses: on.addresses, clients: [] })

    expect(
      sqliteJson<{ key: string; value: string }>(
        app.home,
        "select key, value from settings where key like 'network.%' order by key"
      )
    ).toEqual([
      { key: 'network.enabled', value: 'true' },
      { key: 'network.port', value: String(P) }
    ])
  })

  it('NW-12b committing a port in the Settings UI moves the server; an invalid one changes nothing', async () => {
    let P3 = 0
    do {
      P3 = await freePort()
    } while (P3 === P || P3 === Pb)
    const pane = networkSettingsPane(settings!)

    await pane.commitPort(String(P3))
    await until(async () => {
      const s = await status()
      return s.port === P3 && s.listening
    }, `listening on ${P3} after committing it in the UI`)
    expect((await httpProbe({ port: P3 })).status).toBe(200)
    expect(await httpProbe({ port: P })).toMatchObject({ error: 'ECONNREFUSED' })

    await pane.commitPort('80')
    await sleep(500)
    expect(await status()).toMatchObject({ port: P3, listening: true })

    // 回到 P（经同一个输入框）
    await pane.commitPort(String(P))
    await until(async () => {
      const s = await status()
      return s.port === P && s.listening
    }, `back on ${P}`)
    expect((await httpProbe({ port: P })).status).toBe(200)
  })

  it('NW-13 static routes serve the web client and nothing else', async () => {
    const host = `127.0.0.1:${P}`
    const root = await httpProbe({ port: P, host })
    expect(root.status).toBe(200)
    expect(root.headers?.['content-type']).toBe('text/html; charset=utf-8')
    expect(root.headers?.['x-content-type-options']).toBe('nosniff')
    expect(root.body?.equals(webHtml)).toBe(true)
    for (const path of ['/web.html', '/?x=1']) {
      const same = await httpProbe({ port: P, host, path })
      expect(same.status, path).toBe(200)
      expect(same.body?.equals(webHtml), path).toBe(true)
    }
    const head = await httpProbe({ port: P, host, method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.headers?.['content-length']).toBe(String(webHtml.length))
    expect(head.body?.length).toBe(0)

    // web.html 引的资源
    const html = webHtml.toString('utf8')
    const script = /src="\.\/assets\/([^"]+\.js)"/.exec(html)?.[1]
    expect(script, 'web.html references a script under ./assets/').toBeTruthy()
    const js = await httpProbe({ port: P, host, path: `/assets/${script}` })
    expect(js.status).toBe(200)
    expect(js.headers?.['content-type']).toBe('text/javascript; charset=utf-8')
    expect(js.body?.equals(readFileSync(join(RENDERER_OUT, 'assets', script!)))).toBe(true)
    const css = /href="\.\/assets\/([^"]+\.css)"/.exec(html)?.[1]
    if (css) {
      const sheet = await httpProbe({ port: P, host, path: `/assets/${css}` })
      expect(sheet.status).toBe(200)
      expect(sheet.headers?.['content-type']).toBe('text/css; charset=utf-8')
    }

    // 桌面入口不给（大小写不敏感的文件系统上 /INDEX.HTML 读到的是同一个文件）
    expect(existsSync(join(RENDERER_OUT, 'index.html')), 'precondition: index.html is built').toBe(
      true
    )
    for (const path of ['/index.html', '/INDEX.HTML', '/assets/', '/assets', '/nope.js']) {
      expect((await httpProbe({ port: P, host, path })).status, path).toBe(404)
    }

    // 不出目录
    expect(existsSync(join(DESKTOP_ROOT, 'out', 'main', 'index.js')), 'precondition').toBe(true)
    for (const path of [
      '/../main/index.js',
      '/%2e%2e/main/index.js',
      '/assets/..%2f..%2fmain%2findex.js'
    ]) {
      expect((await httpProbe({ port: P, host, path })).status, path).toBe(404)
    }

    // 坏请求与方法
    expect((await httpProbe({ port: P, host, path: '/%00' })).status).toBe(400)
    expect((await httpProbe({ port: P, host, path: '/%E0%A4%A' })).status).toBe(400)
    const post = await httpProbe({ port: P, host, method: 'POST' })
    expect(post.status).toBe(405)
    expect(post.headers?.allow).toBe('GET, HEAD')
  })

  it('NW-14 the Host guard on plain requests', async () => {
    for (const host of [`127.0.0.1:${P}`, `localhost:${P}`, `LOCALHOST:${P}`, `[::1]:${P}`]) {
      expect((await httpProbe({ port: P, host })).status, host).toBe(200)
    }
    for (const host of [
      `evil.example:${P}`,
      '127.0.0.1',
      `127.0.0.1:${P + 1}`,
      `127.0.0.1.nip.io:${P}`,
      `[localhost]:${P}`,
      `127.0.0.1:0${P}`
    ]) {
      const refused = await httpProbe({ port: P, host })
      expect(refused.status, host).toBe(421)
      expect(refused.headers?.connection, host).toBe('close')
      expect(refused.body?.toString('utf8'), host).toBe(HOST_REFUSED)
    }
    // 没有 Host：HTTP/1.1 的请求 Node 自己先答 400（`requireHostHeader`，门还轮不到）；HTTP/1.0 可以不带 Host —— 到门上 421
    const noHost11 = await httpProbe({ port: P, host: null })
    expect(noHost11.status).toBe(400)
    const noHost10 = await rawHttpProbe(P, 'GET / HTTP/1.0\r\n\r\n')
    expect(noHost10).toMatchObject({ status: 421, body: HOST_REFUSED })

    expect(
      (await httpProbe({ port: P, host: `evil.example:${P}`, path: '/web.html' })).status
    ).toBe(421)
    // Origin 只在升级时看
    expect(
      (await httpProbe({ port: P, host: `127.0.0.1:${P}`, origin: 'http://evil.example' })).status
    ).toBe(200)
  })

  it('NW-15 upgrade guards; a correct upgrade succeeds and shows in Settings live', async () => {
    const host = `127.0.0.1:${P}`
    const misdirected = await upgradeProbe({
      port: P,
      host: `evil.example:${P}`,
      origin: `http://evil.example:${P}`
    })
    expect(misdirected).toMatchObject({ status: 421, body: HOST_REFUSED })

    for (const origin of [
      'http://evil.example',
      null,
      `http://localhost:${P}`,
      `https://127.0.0.1:${P}`,
      `http://127.0.0.1:${P}/`
    ]) {
      const refused = await upgradeProbe({ port: P, host, origin })
      expect(refused, String(origin)).toMatchObject({ status: 403, body: ORIGIN_REFUSED })
    }
    // 路径先于 Origin 判
    expect(await upgradeProbe({ port: P, host, path: '/socket' })).toMatchObject({ status: 404 })
    expect((await status()).clients).toEqual([])

    const ok = await upgradeProbe({ port: P, host, userAgent: 'nw-e2e-probe/1' })
    expect(ok.status).toBe(101)
    if (ok.upgraded) rawSockets.push(ok.socket)
    const listed = await until(async () => {
      const s = await status()
      return s.clients.length === 1 ? s.clients[0] : null
    }, 'the upgraded probe is listed')
    expect(listed).toMatchObject({ remoteAddress: '127.0.0.1', userAgent: 'nw-e2e-probe/1' })
    const shot = await shotWhen(
      (s) => s.clients.length === 1 && s.clients[0] === listed.id,
      'settings list the probe client'
    )
    expect(shot.clientTitles).toEqual(['127.0.0.1'])

    const viaLocalhost = await upgradeProbe({ port: P, host: `localhost:${P}` })
    expect(viaLocalhost.status).toBe(101)
    if (viaLocalhost.upgraded) rawSockets.push(viaLocalhost.socket)
    await until(async () => (await status()).clients.length === 2, 'two probe clients')

    destroySockets()
    await until(async () => (await status()).clients.length === 0, 'probe clients gone')
    await shotWhen((s) => s.clients.length === 0, 'settings show no clients')
  })

  it('NW-16 a real page from another origin cannot open the socket; a same-origin page can; closing the tab drops the client', async () => {
    const fixtureUrl = fixture!.url('/ask-me.html')
    const tabId = await app.main.eval<string>(
      `window.api.browserView.createTab(${JSON.stringify(fixtureUrl)})`
    )
    const foreign = { page: null as CdpClient | null, tabId }
    openTabs.push(foreign)
    const page = await until(
      () => connectTabPage(app.port, (u) => u.startsWith(fixture!.origin)),
      'the fixture page target'
    )
    foreign.page = page
    await until(
      async () => (await page.eval<string>('document.readyState')) === 'complete',
      'fixture page loaded'
    )
    const outcome = await page.eval<string>(`new Promise((resolve) => {
      const ws = new WebSocket('ws://127.0.0.1:${P}/ws')
      const timer = setTimeout(() => resolve('timeout'), 5000)
      ws.onopen = () => { clearTimeout(timer); ws.close(); resolve('open') }
      ws.onclose = (e) => { clearTimeout(timer); resolve('closed:' + e.code) }
    })`)
    expect(outcome).not.toBe('open')
    await sleep(300)
    expect((await status()).clients).toEqual([])
    await closeTab(foreign)

    webClient = await openWebClient(app, P)
    await until(async () => (await status()).clients.length === 1, 'the same-origin page connects')
    await app.main.eval(`window.api.browserView.closeTab(${JSON.stringify(webClient.tabId)})`)
    webClient.page.close()
    webClient = undefined
    await until(async () => (await status()).clients.length === 0, 'closing the tab drops it')
    await shotWhen((s) => s.clients.length === 0, 'settings show no clients after the tab closed')
  })

  it('NW-17 the listed private addresses open the page from the local network', async (ctx) => {
    const lan = (await status()).addresses
      .map((a) => /^http:\/\/(\d+\.\d+\.\d+\.\d+):\d+$/.exec(a)?.[1])
      .filter((ip): ip is string => ip !== undefined)
    if (lan.length === 0) ctx.skip()
    for (const ip of lan) {
      const page = await httpProbe({ port: P, connectHost: ip, host: `${ip}:${P}` })
      expect(page.status, ip).toBe(200)
      expect(page.body?.equals(webHtml), ip).toBe(true)
    }
  })

  it('NW-18 a port in use shows the error row, then recovers', async () => {
    const server = createServer()
    blocker = server
    await new Promise<void>((r, j) => {
      server.once('error', j)
      server.listen(Pb, '0.0.0.0', () => r())
    })

    expect(await setPort(Pb)).toStrictEqual({
      enabled: true,
      port: Pb,
      listening: false,
      addresses: [],
      clients: [],
      error: 'EADDRINUSE'
    })
    // 换端口之前旧的服务已经停了
    expect(await httpProbe({ port: P })).toMatchObject({ error: 'ECONNREFUSED' })

    const shot = await shotWhen((s) => s.error !== null, 'settings show the listen error')
    expect(shot.error).toBe(en.settings.networkErrorInUse.replace('{{port}}', String(Pb)))
    expect(shot.addresses).toEqual([])

    await new Promise<void>((r) => server.close(() => r()))
    blocker = undefined
    const back = await setPort(P)
    expect(back).toMatchObject({ enabled: true, port: P, listening: true })
    expect('error' in back).toBe(false)
    await shotWhen((s) => s.error === null && s.toggle === 'on', 'the error row is gone')
  })

  it('NW-19 the setting persists across a restart', async () => {
    try {
      settings?.close()
    } catch {
      /* 已经关了 */
    }
    settings = undefined
    const home = app.home
    await app.stop({ keepHome: true })
    app = await launchApp({ home })

    // 不经任何 IPC 写：启动时按设置对账
    const restored = await until(
      async () => {
        const s = await status()
        return s.listening ? s : null
      },
      'listening again after the restart',
      20_000
    )
    expect(restored).toMatchObject({ enabled: true, port: P, listening: true, clients: [] })
    const root = await httpProbe({ port: P })
    expect(root.status).toBe(200)
    expect(root.body?.equals(webHtml)).toBe(true)
  }, 120_000)

  it('NW-20 the generic settings path switches it off too (only a literal true enables)', async () => {
    await app.main.eval(`window.api.settings.set({ key: 'network.enabled', value: 'false' })`)
    await until(async () => !(await status()).listening, 'stopped listening via settings.set')
    const off = await status()
    expect(off).toMatchObject({ enabled: false, addresses: [] })
    expect(await httpProbe({ port: P })).toMatchObject({ error: 'ECONNREFUSED' })

    await app.main.eval(`window.api.settings.set({ key: 'network.enabled', value: 'TRUE' })`)
    // setPort 等对账的队列走完，回的就是 'TRUE' 之后的状态
    expect(await setPort(P)).toMatchObject({ enabled: false, listening: false })
    expect(await httpProbe({ port: P })).toMatchObject({ error: 'ECONNREFUSED' })
  })
})
