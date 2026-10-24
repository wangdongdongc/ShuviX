/**
 * 远程访问的安全策略（2026-10-19，docs/network-policy/design.md）—— 网络服务一律监听 0.0.0.0，谁能连、能做什么由
 * 安全策略定：内置的 network-admission 只放这台电脑，用户写同名策略替换它；策略在 socket / request / channel / path
 * 四个点位上判，拒绝记进内存里的拒绝记录（status.denials）。一个桌面实例，从外面看：真的 HTTP / WebSocket 打到本机的
 * **私有地址**上（对端地址就是它 —— 策略据此把它当「别的设备」），状态经主窗口 IPC，策略文件直接写进隔离的
 * `~/.shuvix/policies`（不经应用 —— 接住它们靠策略目录的签名核对：判定路径至多 1 秒、远程访问开着时每 3 秒），
 * 设置页经 pages.ts，设置库经 sqlite。这台电脑没有私有 IPv4 网卡 → 要局域网地址的用例跳过（说明原因）。
 *
 * NP-1  内置准入：127.0.0.1 → 200 并发设备 cookie；局域网地址 → 403，正文是「只有这台电脑」那句话 + `Device:` /
 *       `Address:` 两行，被拒的应答同样发设备 cookie；带着那个 cookie 再来 → 合并成同一条拒绝（count 2）；经局域网地址的
 *       WebSocket 升级同样被拒；status：admission builtin、只列 127.0.0.1、denials 列出它们
 * NP-2  写一份同名用户策略（规则为空）替换内置：几秒内局域网地址 → 200，admission override、列出私有地址；经局域网地址的
 *       WebSocket 连得上，客户端行带着升级时那个 cookie 的设备 ID
 * NP-3  再写一份「这台电脑以外只能调读通道」的策略：局域网的 WebSocket 上 session:list 照常、session:create 回
 *       `ok:false` + `code 'denied'`（话是规则的 prompt），会话没有建出来；127.0.0.1 上 session:create 照常；拒绝记录里
 *       有它（stage channel、规则 lan-read-only#0）
 * NP-RO 同一份只读策略下，从局域网地址在应用的浏览器里打开 web 客户端：会话列表照样渲染（初始化的几样各管各的，
 *       admin 的 provider.listAll 被拒不连带会话列表），打开一条有消息的会话看到消息，web 的设置页打开；页面每次加载都调的
 *       app:window-ready / notification:reportActiveSession / consumePendingOpenSession 是 read、不被拒；每条拒绝都在
 *       channel 点位、规则 lan-read-only#0；被拒的通道打印出来
 * NP-SC 按 scope 写的策略（「这台电脑以外只给 app / sessions / preferences」，2026-10-23）：局域网的 socket 上建会话、
 *       和 agent 对话、换字号照常；终端、读文件、看安全策略、关沙箱被拒，话是规则的 prompt，拒绝记录带 scope；文件路由
 *       （request 点位，scope files）403；从局域网地址打开 web 客户端，这么多 scope 被拒，会话列表与消息照样出来
 * NP-4  一个经局域网地址连着、什么也不发的 WebSocket：写一份拒绝它的 network-admission（不经应用）→ 定时核对接住，
 *       它以 1008 断开、原因是规则的话；127.0.0.1 上的连接照旧
 * NP-5  删掉用户策略回到内置：设置页的引导是 builtin 那一段（端口代进去）、带两个按钮、客户端行带设备 ID、「最近拒绝」
 *       与 status 同序；点「让 agent 帮我设置」→ 新建一条会话（不属于项目、知识库 shuvix）、主窗口切过去、输入框里是
 *       提示词（带端口、状态、network-policy、network-admission.md、连着的设备 ID），没有发出去（没有消息、没有请求）
 * NP-6  停用内置 network-admission（md 扩展元数据的开关）：admission disabled、引导是警告、局域网地址 → 200；
 *       再启用 → 回到 builtin、局域网地址 → 403
 * NP-7  桌面迁移：老版本留下 network.lan 'true' → 重启后写了 network-admission（沿用内置 id、规则为空），两个旧键删掉，
 *       admission override、局域网地址 → 200；设置页的引导是 override 那一句、按钮是「让 agent 帮我调整」
 * NP-8  桌面迁移（只开放给一个网络）：network.lan 'true' + network.lanInterface <网卡> → 重启后策略只放这台电脑与那块
 *       网卡的网段；那个地址 → 200；两个旧键删掉
 *
 * 约定同 web-client.e2e.ts：界面语言先设成 en；从不在缺省端口 7766 上打开。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import { connectTabPage } from '../../harness/browserFixtures'
import { sleep, until, type CdpClient } from '../../harness/cdp'
import { startFakeProvider, type FakeProvider } from '../../harness/fakeProvider'
import { freePort, launchApp, type E2EApp } from '../../harness/launch'
import {
  BUILTIN_ADMISSION_SENTENCE,
  closeBrowserTab,
  deviceCookieOf,
  evalWithGesture,
  httpProbe,
  loopbackOnlyPolicy,
  NETWORK_ADMISSION_FILE,
  networkDenialLines,
  networkStatus,
  openAdmissionPolicy,
  openWebClient,
  privateIPv4Addresses,
  privateIPv4Networks,
  readUserPolicy,
  removeUserPolicy,
  waitBrowserTab,
  writeUserPolicy,
  type NetworkStatus,
  type WebClientHandle
} from '../../harness/networkFixtures'
import {
  chatPane,
  networkSettingsPane,
  sidebarPane,
  type NetworkSettingsShot
} from '../../harness/pages'
import { seedFakeProvider, sqliteJson, waitRendererReady } from '../../harness/seed'
import { connectWs, type WsClient } from '../../harness/wsClient'

const MODEL = 'e2e-model'
const READ_ONLY_FILE = 'lan-read-only.md'
const READ_ONLY_PROMPT = 'NP-3 devices on the local network may only look.'
const PHONE_FILE = 'lan-phone.md'
const PHONE_PROMPT = 'NP-SC this device may only chat.'
const NP4_PROMPT = 'NP-4 from now on only this computer may connect.'
/** 一个合法的设备 ID（22 个 base64url 字符）—— 冒充一台早就拿到 cookie 的浏览器 */
const FIXED_DEVICE = 'NPe2eDeviceAAAAAAAAAAA'
const ADMISSION_OBJECT_ID = 'policy:builtin:network-admission'

/** 「这台电脑以外只能调读通道」：拒绝非回环主体的每条 access 不是 read 的 RPC */
const READ_ONLY_POLICY = [
  '---',
  'shuvix: policy v1',
  'name: lan-read-only',
  'shuvix-displayName: NP read-only devices',
  'shuvix-policy-scope:',
  '  subject.kind: [network]',
  '  object.type: [channel]',
  'shuvix-policy-rules:',
  '  - effect: deny',
  '    action: [invoke]',
  `    match: "!inCidr(subject.address, ['127.0.0.0/8', '::1']) && object.access != 'read'"`,
  `    prompt: ${READ_ONLY_PROMPT}`,
  '---',
  ''
].join('\n')

/** 「这台电脑以外只给 app / sessions / preferences」—— 按 scope 写，三个点位一条规则 */
const PHONE_POLICY = [
  '---',
  'shuvix: policy v1',
  'name: lan-phone',
  'shuvix-displayName: NP phone',
  'shuvix-policy-rules:',
  '  - effect: deny',
  '    subject.kind: [network]',
  '    object.type: [request, channel, path]',
  `    match: "!inCidr(subject.address, ['127.0.0.0/8', '::1']) && !(object.scope in ['app', 'sessions', 'preferences'])"`,
  `    prompt: ${PHONE_PROMPT}`,
  '---',
  ''
].join('\n')

const LAN = privateIPv4Addresses()[0]
const NO_LAN = 'this computer has no private IPv4 address to reach itself from "another device"'

let app: E2EApp
let provider: FakeProvider
let settings: CdpClient | undefined
const sockets: WsClient[] = []
let P = 0
let roSession = ''

const status = (): Promise<NetworkStatus> => networkStatus(app.main)

/** 经局域网地址（缺省 LAN）的一次 HTTP 请求 */
const lanProbe = (opts: { path?: string; headers?: Record<string, string>; ip?: string } = {}) =>
  httpProbe({
    port: P,
    connectHost: opts.ip ?? LAN,
    host: `${opts.ip ?? LAN}:${P}`,
    path: opts.path,
    headers: opts.headers
  })

/** 等局域网地址回到某个状态码（带固定的设备 cookie：轮询的拒绝合并成一条，不刷满拒绝记录） */
const lanStatusBecomes = (code: number, what: string, ip?: string): Promise<unknown> =>
  until(
    async () =>
      (await lanProbe({ ip, headers: { Cookie: `shuvix_device=${FIXED_DEVICE}` } })).status === code
        ? true
        : null,
    what,
    10_000
  )

async function connect(opts: Parameters<typeof connectWs>[1] = {}): Promise<WsClient> {
  const ws = await connectWs(P, opts)
  sockets.push(ws)
  return ws
}

function closeSockets(): void {
  for (const ws of sockets.splice(0)) ws.close()
}

function closeSettings(): void {
  try {
    settings?.close()
  } catch {
    /* 已经关了 */
  }
  settings = undefined
}

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

const settingsRows = (): Array<{ key: string; value: string }> =>
  sqliteJson<{ key: string; value: string }>(
    app.home,
    "select key, value from settings where key like 'network.%' order by key"
  )

/** 关掉这个实例、留着 HOME 原样再起一次（启动时的迁移就跑在这一步） */
async function restart(): Promise<void> {
  closeSockets()
  closeSettings()
  const home = app.home
  await app.stop({ keepHome: true })
  app = await launchApp({ home })
  await waitRendererReady(app.main)
}

beforeAll(async () => {
  app = await launchApp()
  await app.main.eval(`window.api.settings.set({ key: 'general.language', value: 'en' })`)
  provider = await startFakeProvider()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(app.main)
  P = await freePort()
  await app.main.eval(`window.api.network.setPort(${P})`)
  const on = await app.main.eval<NetworkStatus>('window.api.network.setEnabled(true)')
  if (!on.listening) throw new Error(`network access did not start: ${JSON.stringify(on)}`)
})

afterAll(async () => {
  closeSockets()
  closeSettings()
  await provider?.close().catch(() => undefined)
  await app?.stop()
})

describe('network access: who may connect is a security policy', () => {
  it('NP-1 the builtin admission: this computer gets in, a private address gets a 403 that says why', async (ctx) => {
    const local = await httpProbe({ port: P })
    expect(local.status).toBe(200)
    expect(deviceCookieOf(local.headers)?.value).toMatch(/^[A-Za-z0-9_-]{22}$/)
    const s0 = await status()
    expect(s0).toMatchObject({ admission: 'builtin', denials: [], listening: true })
    expect(s0.addresses).toEqual([`http://127.0.0.1:${P}`])

    if (!LAN) ctx.skip(NO_LAN)
    const refused = await lanProbe()
    expect(refused.status).toBe(403)
    const issued = deviceCookieOf(refused.headers)
    expect(issued?.value).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(issued?.header).toContain('; HttpOnly; SameSite=Strict')
    const body = refused.body?.toString('utf8') ?? ''
    expect(body).toContain(BUILTIN_ADMISSION_SENTENCE)
    expect(body).toContain(`Device: ${issued?.value} · Address: ${LAN}`)
    expect(refused.headers?.['content-type']).toBe('text/plain; charset=utf-8')

    // 同一台设备（带着刚发的 cookie）再来：同一条拒绝，count 2；不再发新 cookie
    const again = await lanProbe({ headers: { Cookie: `shuvix_device=${issued?.value}` } })
    expect(again.status).toBe(403)
    expect(deviceCookieOf(again.headers)).toBeNull()
    // WebSocket 升级同样过 request 点位
    await expect(connectWs(P, { host: LAN, timeoutMs: 5000 })).rejects.toThrow()

    const s = await until(async () => {
      const st = await status()
      return st.denials.length === 2 ? st : null
    }, 'two denials: the page (twice, merged) and the socket upgrade')
    expect(s.admission).toBe('builtin')
    expect(s.addresses).toEqual([`http://127.0.0.1:${P}`])
    const page = s.denials.find((d) => d.summary === 'GET /')
    expect(page).toMatchObject({
      stage: 'request',
      address: LAN,
      device: issued?.value,
      rule: 'network-admission#0',
      count: 2,
      downgraded: false
    })
    expect(page?.policies).toHaveLength(1)
    expect(s.denials.find((d) => d.summary === 'GET /ws')).toMatchObject({
      stage: 'request',
      address: LAN,
      rule: 'network-admission#0'
    })
  })

  it('NP-2 a user network-admission with no rules replaces the builtin: other devices get in within seconds', async (ctx) => {
    if (!LAN) ctx.skip(NO_LAN)
    writeUserPolicy(app.home, NETWORK_ADMISSION_FILE, openAdmissionPolicy())
    await lanStatusBecomes(200, 'the private address is let in')
    const page = await lanProbe()
    expect(page.status).toBe(200)
    expect(page.body?.toString('utf8')).toContain('<div id="root">')

    const s = await status()
    expect(s.admission).toBe('override')
    expect(s.addresses.at(-1)).toBe(`http://127.0.0.1:${P}`)
    expect(s.addresses).toContain(`http://${LAN}:${P}`)

    const lan = await connect({ host: LAN, headers: { Cookie: `shuvix_device=${FIXED_DEVICE}` } })
    expect(await lan.invoke<unknown[]>('session:list')).toBeInstanceOf(Array)
    const listed = await until(async () => {
      const st = await status()
      return st.clients.find((c) => c.remoteAddress === LAN) ?? null
    }, 'the LAN client is listed')
    expect(listed.device).toBe(FIXED_DEVICE)
  })

  it('NP-3 a policy that lets other devices only read: write channels are denied over the LAN socket, read ones work', async (ctx) => {
    if (!LAN) ctx.skip(NO_LAN)
    writeUserPolicy(app.home, READ_ONLY_FILE, READ_ONLY_POLICY)
    // 列表路径每次都核策略目录（判定与它共用一份缓存）：读一次状态，新文件就进了判定 —— 不必等那 1 秒的节流
    await status()
    const lan = await connect({ host: LAN })
    const before = await app.main.eval<number>('window.api.session.list().then((ss) => ss.length)')

    const created = await lan.invokeRaw('session:create', [{ title: 'NP-3 from the LAN' }])
    expect(created.ok).toBe(false)
    expect(created.error).toStrictEqual({ code: 'denied', message: READ_ONLY_PROMPT })
    const listed = await lan.invokeRaw('session:list')
    expect(listed.ok).toBe(true)
    expect((listed.value as unknown[]).length).toBe(before)
    expect(
      await app.main.eval<string[]>(
        'window.api.session.list().then((ss) => ss.map((s) => s.title))'
      )
    ).not.toContain('NP-3 from the LAN')

    // 这台电脑上的连接不受它管
    const local = await connect()
    const mine = await local.invoke<{ id: string; title: string }>('session:create', {
      title: 'NP-3 local'
    })
    expect(mine.title).toBe('NP-3 local')
    await local.invoke('session:delete', mine.id)

    const denial = (await status()).denials.find((d) => d.summary === 'session:create')
    expect(denial).toMatchObject({
      stage: 'channel',
      address: LAN,
      rule: 'lan-read-only#0',
      policies: ['NP read-only devices'],
      downgraded: false
    })
    expect(lan.isOpen()).toBe(true)
  })

  it('NP-RO viewing from a read-only device: the web client still renders; the denied view-time channels are listed', async (ctx) => {
    if (!LAN) ctx.skip(NO_LAN)
    closeSockets()
    // 自成一体（单跑这一条也成立）：放开的准入 + 只读策略
    writeUserPolicy(app.home, NETWORK_ADMISSION_FILE, openAdmissionPolicy())
    writeUserPolicy(app.home, READ_ONLY_FILE, READ_ONLY_POLICY)
    expect((await status()).admission).toBe('override')
    // 一条有消息的会话（假提供商答一句）
    roSession = await app.main.eval<string>(
      `window.api.session.create({ title: 'NP-RO chat', projectId: null }).then((s) => s.id)`
    )
    provider.reset()
    provider.script({ text: 'NP-RO reply', usage: { prompt: 20, completion: 3 } })
    await app.main.eval(
      `window.api.agent.prompt({ sessionId: ${JSON.stringify(roSession)}, text: 'NP-RO question' })`
    )
    await until(
      async () =>
        (
          await app.main.eval<Array<{ role: string }>>(
            `window.api.message.list(${JSON.stringify(roSession)})`
          )
        ).length === 2,
      'the seeded session has its two messages'
    )

    const logMark = networkDenialLines(app).length
    /** 从 logMark 起这一路被拒的通道（日志里每个合并窗口一行，比 status 的最近 20 条全），打印出来 */
    const report = async (phase: string): Promise<string[]> => {
      await sleep(300)
      const lines = networkDenialLines(app)
        .slice(logMark)
        .filter((l) => l.address === LAN)
      const channels = [
        ...new Set(lines.filter((l) => l.stage === 'channel').map((l) => l.summary))
      ]
      console.log(`[NP-RO] ${phase}: ${channels.length} channel(s): ${JSON.stringify(channels)}`)
      return channels
    }

    const opened: WebClientHandle[] = []
    let settingsTabId: string | undefined
    let settingsPage: CdpClient | undefined
    try {
      // 严格只读：开 web 客户端，等它安定。会话列表照样出来 —— useAppInit 的三样初始化各管各的，provider.listAll
      // （admin：返回值带 apiKey）被拒不连带会话列表
      const web = await openWebClient(app, P, { host: LAN })
      opened.push(web)
      expect(await web.page.eval<string>('location.href')).toBe(`http://${LAN}:${P}/`)
      const page = web.page
      const sidebar = sidebarPane(page)
      await until(
        async () => ((await sidebar.titles()).includes('NP-RO chat') ? true : null),
        'the read-only page renders the session list'
      )
      await sleep(2000)
      const atLoad = await report('strict read-only, page loaded')
      // 页面每次加载都调、只改界面状态的几条标成了 read：只读设备调得通
      for (const viewTime of [
        'app:window-ready',
        'notification:reportActiveSession',
        'notification:consumePendingOpenSession'
      ]) {
        expect(atLoad, viewTime).not.toContain(viewTime)
      }
      expect(await sidebar.openSession('NP-RO chat')).toBe(true)
      const chat = chatPane(page)
      await chat.ready()
      const items = await until(async () => {
        const settled = await chat.settledItems()
        return settled.length === 2 ? settled : null
      }, 'the opened session shows its messages')
      expect(items.map(({ role, text }) => ({ role, text }))).toEqual([
        { role: 'user', text: 'NP-RO question' },
        { role: 'assistant', text: 'NP-RO reply' }
      ])
      await sleep(2500)
      await report('strict read-only, session opened')

      // web 的设置页：一个新标签页（window.open 要一次用户手势）
      const settingsUrl = `http://${LAN}:${P}/#settings/general`
      expect(
        await evalWithGesture(page, `Promise.resolve(window.api.app.openSettings('general'))`)
      ).toStrictEqual({ success: true })
      settingsTabId = (await waitBrowserTab(app, (u) => u === settingsUrl, 'the web settings tab'))
        .id
      settingsPage = await until(
        () => connectTabPage(app.port, (u) => u === settingsUrl),
        'the web settings page target'
      )
      const webSettings = await until(async () => {
        const shot = await networkSettingsPane(settingsPage!).shot()
        return shot.present && shot.toggle === 'on' ? shot : null
      }, 'the web settings page shows network access on')
      expect(webSettings.admission).toBe('override')
      await sleep(2500)
      await report('strict read-only, settings opened')

      // 被拒之后页面照旧：会话列表与消息都还在
      expect(await sidebar.titles()).toContain('NP-RO chat')
      expect((await chat.settledItems()).length).toBe(2)
    } finally {
      const all = await report('all phases').catch(() => [])
      console.log(`[NP-RO] every channel denied while viewing:\n${JSON.stringify(all, null, 2)}`)
      try {
        settingsPage?.close()
      } catch {
        /* 已经关了 */
      }
      if (settingsTabId) await closeBrowserTab(app, settingsTabId)
      for (const handle of opened) await handle.close()
    }
    // 只有那份只读策略拒绝了它们：准入是放开的，拒绝只能在 channel 点位上
    const lines = networkDenialLines(app)
      .slice(logMark)
      .filter((l) => l.address === LAN)
    for (const line of lines) {
      expect(`${line.stage} ${line.rule}`, line.summary).toBe('channel lan-read-only#0')
    }
    await until(
      async () => (await status()).clients.every((c) => c.remoteAddress !== LAN),
      'the web pages are gone'
    )
  }, 150_000)

  it('NP-SC a policy written on scopes: a chat-only device chats and changes its font size; terminal, files, security and the sandbox are refused', async (ctx) => {
    if (!LAN) ctx.skip(NO_LAN)
    closeSockets()
    removeUserPolicy(app.home, READ_ONLY_FILE)
    writeUserPolicy(app.home, NETWORK_ADMISSION_FILE, openAdmissionPolicy())
    writeUserPolicy(app.home, PHONE_FILE, PHONE_POLICY)
    await status()
    const lan = await connect({ host: LAN, headers: { Cookie: `shuvix_device=${FIXED_DEVICE}` } })
    const denied = { code: 'denied', message: PHONE_PROMPT }

    // sessions：建会话、和 agent 对话
    const created = await lan.invoke<{ id: string }>('session:create', { title: 'NP-SC chat' })
    provider.reset()
    provider.script({ text: 'NP-SC reply', usage: { prompt: 20, completion: 3 } })
    await lan.invoke('agent:prompt', { sessionId: created.id, text: 'NP-SC question' })
    await until(
      async () =>
        (
          await app.main.eval<Array<{ role: string }>>(
            `window.api.message.list(${JSON.stringify(created.id)})`
          )
        ).length === 2,
      'the LAN device talked to the agent'
    )
    expect(await lan.invoke<unknown[]>('session:list')).toBeInstanceOf(Array)

    // settings:set 按 key：字号是 preferences / write，放；沙箱是 security / admin，拒
    const fontBefore = await app.main.eval<string | undefined>(
      `window.api.settings.get('general.fontSize')`
    )
    expect(
      (await lan.invokeRaw('settings:set', [{ key: 'general.fontSize', value: '15' }])).ok
    ).toBe(true)
    expect(await app.main.eval<string>(`window.api.settings.get('general.fontSize')`)).toBe('15')
    await app.main.eval(
      `window.api.settings.set({ key: 'general.fontSize', value: ${JSON.stringify(fontBefore ?? '14')} })`
    )
    const sandboxBefore = await app.main.eval<string | undefined>(
      `window.api.settings.get('sandbox.enabled')`
    )
    const sandbox = await lan.invokeRaw('settings:set', [
      { key: 'sandbox.enabled', value: 'false' }
    ])
    expect(sandbox.ok).toBe(false)
    expect(sandbox.error).toStrictEqual(denied)
    expect(
      await app.main.eval<string | undefined>(`window.api.settings.get('sandbox.enabled')`)
    ).toBe(sandboxBefore)

    // 别的 scope：终端、文件、安全
    for (const [channel, args] of [
      ['terminal:create', [{ sessionId: created.id }]],
      ['files:read', [{ path: '/etc/hosts' }]],
      ['policy:list', []]
    ] as Array<[string, unknown[]]>) {
      const r = await lan.invokeRaw(channel, args)
      expect(r.ok, channel).toBe(false)
      expect(r.error, channel).toStrictEqual(denied)
    }
    // 文件路由在 request 点位上就是 files
    const media = await lanProbe({
      path: '/files/media?path=%2Fetc%2Fhosts',
      headers: { Cookie: `shuvix_device=${FIXED_DEVICE}` }
    })
    expect(media.status).toBe(403)
    expect(media.body?.toString('utf8')).toContain(PHONE_PROMPT)

    const denials = (await status()).denials
    const scopeOf = (summary: string): string | undefined =>
      denials.find((d) => d.address === LAN && d.summary === summary)?.scope
    expect(scopeOf('terminal:create')).toBe('terminal')
    expect(scopeOf('files:read')).toBe('files')
    expect(scopeOf('policy:list')).toBe('security')
    // settings:set 的拒绝记录带着 key
    expect(scopeOf('settings:set sandbox.enabled')).toBe('security')
    expect(scopeOf('GET /files/media')).toBe('files')

    // web 客户端：app 与 sessions 之外全被拒，页面照样出来、会话能打开
    const logMark = networkDenialLines(app).length
    const web = await openWebClient(app, P, { host: LAN })
    try {
      const sidebar = sidebarPane(web.page)
      await until(
        async () => ((await sidebar.titles()).includes('NP-SC chat') ? true : null),
        'the chat-only page renders the session list'
      )
      expect(await sidebar.openSession('NP-SC chat')).toBe(true)
      const chat = chatPane(web.page)
      await chat.ready()
      const items = await until(async () => {
        const settled = await chat.settledItems()
        return settled.length === 2 ? settled : null
      }, 'the opened session shows its messages')
      expect(items.map(({ role, text }) => ({ role, text }))).toEqual([
        { role: 'user', text: 'NP-SC question' },
        { role: 'assistant', text: 'NP-SC reply' }
      ])
      await sleep(2000)
      const refused = [
        ...new Set(
          networkDenialLines(app)
            .slice(logMark)
            .filter((l) => l.address === LAN && l.stage === 'channel')
            .map((l) => l.summary)
        )
      ]
      console.log(`[NP-SC] channels the chat-only page was refused: ${JSON.stringify(refused)}`)
      expect(await sidebar.titles()).toContain('NP-SC chat')
    } finally {
      await web.close()
      await lan.invoke('session:delete', created.id).catch(() => undefined)
      removeUserPolicy(app.home, PHONE_FILE)
    }
  }, 150_000)

  it('NP-4 a policy written while a LAN client is connected disconnects it with 1008 on the next refresh', async (ctx) => {
    if (!LAN) ctx.skip(NO_LAN)
    removeUserPolicy(app.home, READ_ONLY_FILE)
    const lan = await connect({ host: LAN })
    const local = await connect()
    expect(await lan.invoke<unknown[]>('session:list')).toBeInstanceOf(Array)

    // 不经应用写（像 agent 的 write 或外部编辑器那样），之后什么也不问 —— 只有远程访问开着时的定时核对能接住它
    const t0 = Date.now()
    writeUserPolicy(app.home, NETWORK_ADMISSION_FILE, loopbackOnlyPolicy(NP4_PROMPT))
    const closed = await Promise.race([
      lan.closedWith(),
      sleep(8000).then(() => ({ code: -1, reason: 'still open after 8 s' }))
    ])
    expect(closed).toStrictEqual({ code: 1008, reason: NP4_PROMPT })
    expect(Date.now() - t0).toBeLessThan(7000)
    expect(local.isOpen()).toBe(true)
    expect(await local.invoke<unknown[]>('session:list')).toBeInstanceOf(Array)

    const refused = await lanProbe()
    expect(refused.status).toBe(403)
    expect(refused.body?.toString('utf8')).toContain(NP4_PROMPT)
    expect((await status()).admission).toBe('override')
  })

  it('NP-5 back on the builtin admission, Settings show the guide; "Set up with an agent" opens a new session with the prompt in its input box, unsent', async () => {
    closeSockets()
    removeUserPolicy(app.home, NETWORK_ADMISSION_FILE)
    removeUserPolicy(app.home, READ_ONLY_FILE)
    await until(async () => (await status()).admission === 'builtin', 'admission back to builtin')
    // 一台带设备 ID 的浏览器连着：设置页列出它的设备 ID，提示词里也带着它
    await connect({ headers: { Cookie: `shuvix_device=${FIXED_DEVICE}` } })
    const s = await until(async () => {
      const st = await status()
      return st.clients.some((c) => c.device === FIXED_DEVICE) ? st : null
    }, 'the client with a device ID is listed')

    settings = await app.openSettings('general')
    const shot = await shotWhen(
      (sh) =>
        sh.admission === 'builtin' &&
        sh.clientDevices.includes(FIXED_DEVICE) &&
        sh.denials.length === s.denials.length,
      'the builtin guide in Settings'
    )
    expect(shot).toMatchObject({
      toggle: 'on',
      admissionText: en.settings.networkAdmission_builtin.replaceAll('{{port}}', String(P)),
      policyChat: en.settings.networkPolicySetUp,
      policyCopy: true,
      addresses: [`http://127.0.0.1:${P}`]
    })
    expect(shot.denials).toEqual(
      s.denials.map((d) => ({ stage: d.stage, summary: d.summary, scope: d.scope }))
    )

    const requestsBefore = provider.requests().length
    const sessionsBefore = await app.main.eval<string[]>(
      'window.api.session.list().then((ss) => ss.map((s) => s.id))'
    )
    await networkSettingsPane(settings).clickPolicyChat()

    const title = en.settings.networkPolicyChatTitle
    const created = await until(
      async () =>
        (
          await app.main.eval<Array<{ id: string; title: string; projectId?: string | null }>>(
            'window.api.session.list()'
          )
        ).find((row) => row.title === title && !sessionsBefore.includes(row.id)) ?? null,
      'the new policy session'
    )
    expect(created.projectId ?? null).toBeNull()
    expect(
      await app.main.eval<string[] | undefined>(
        `window.api.session.getById(${JSON.stringify(created.id)}).then((x) => x?.settings?.knowledgeBases)`
      )
    ).toEqual(['shuvix'])

    // 主窗口切到它，提示词填进输入框
    await until(
      async () => (await sidebarPane(app.main).activeTitle()) === title,
      'the main window switched to the new session'
    )
    const chat = chatPane(app.main)
    await chat.ready()
    const draft = await until(async () => {
      const value = await chat.inputValue()
      return value.length > 0 ? value : null
    }, 'the prompt is in the input box')
    const head = en.settings.networkPrompt
      .split('{{state}}')[0]
      .replace('{{port}}', String(P))
      .replace('{{headless}}', '')
    expect(draft.startsWith(`${head}${en.settings.networkPromptState_builtin}`), draft).toBe(true)
    expect(draft).toContain('network-policy')
    expect(draft).toContain('network-admission.md')
    expect(draft).toContain(`http://127.0.0.1:${P}`)
    expect(draft).toContain(FIXED_DEVICE)

    // 没有发出去
    await sleep(1500)
    expect(await chat.inputValue()).toBe(draft)
    expect(
      await app.main.eval<unknown[]>(`window.api.message.list(${JSON.stringify(created.id)})`)
    ).toEqual([])
    expect(provider.requests()).toHaveLength(requestsBefore)
  })

  it('NP-6 disabling the builtin network-admission lets every private address in; enabling it again closes the door', async (ctx) => {
    const off = await app.main.eval<{ success: boolean }>(
      `window.api.mdMeta.setEnabled({ objectId: '${ADMISSION_OBJECT_ID}', enabled: false })`
    )
    expect(off.success).toBe(true)
    try {
      await until(async () => (await status()).admission === 'disabled', 'admission disabled')
      const shot = await shotWhen((sh) => sh.admission === 'disabled', 'the disabled warning')
      expect(shot.admissionText).toBe(en.settings.networkAdmission_disabled)
      expect(shot.policyChat).toBe(en.settings.networkPolicySetUp)
      if (!LAN) ctx.skip(NO_LAN)
      expect((await status()).addresses).toContain(`http://${LAN}:${P}`)
      await lanStatusBecomes(200, 'the private address is let in while disabled')
    } finally {
      await app.main.eval(
        `window.api.mdMeta.setEnabled({ objectId: '${ADMISSION_OBJECT_ID}', enabled: true })`
      )
    }
    await until(async () => (await status()).admission === 'builtin', 'admission builtin again')
    await shotWhen((sh) => sh.admission === 'builtin', 'the builtin guide again')
    await lanStatusBecomes(403, 'the private address is refused again')
  })

  it('NP-7 migration: an old network.lan "true" becomes a user network-admission with no rules', async (ctx) => {
    await app.main.eval(`window.api.settings.set({ key: 'network.lan', value: 'true' })`)
    // 运行中写进去什么也不改（迁移只在启动时）
    expect(readUserPolicy(app.home, NETWORK_ADMISSION_FILE)).toBeNull()
    expect((await status()).admission).toBe('builtin')
    await restart()

    const policy = readUserPolicy(app.home, NETWORK_ADMISSION_FILE)
    expect(policy).not.toBeNull()
    expect(policy).toContain('\nshuvix-id: policy:builtin:network-admission\n')
    expect(policy).toContain('\nname: network-admission\n')
    expect(policy).toContain('\nshuvix-policy-rules: []\n')
    expect(settingsRows()).toEqual([
      { key: 'network.enabled', value: 'true' },
      { key: 'network.port', value: String(P) }
    ])
    const s = await until(async () => {
      const st = await status()
      return st.listening ? st : null
    }, 'listening again after the restart')
    expect(s.admission).toBe('override')

    settings = await app.openSettings('general')
    const shot = await shotWhen((sh) => sh.admission === 'override', 'the override guide')
    expect(shot.admissionText).toBe(en.settings.networkAdmission_override)
    expect(shot.policyChat).toBe(en.settings.networkPolicyAdjust)

    if (!LAN) ctx.skip(NO_LAN)
    expect(s.addresses).toContain(`http://${LAN}:${P}`)
    expect((await lanProbe()).status).toBe(200)
  }, 120_000)

  it('NP-8 migration: an old network.lan + network.lanInterface lets in this computer and that network only', async (ctx) => {
    const chosen = privateIPv4Networks()[0]
    if (!chosen) ctx.skip(NO_LAN)
    removeUserPolicy(app.home, NETWORK_ADMISSION_FILE)
    await app.main.eval(`window.api.settings.set({ key: 'network.lan', value: 'true' })`)
    await app.main.eval(
      `window.api.settings.set({ key: 'network.lanInterface', value: ${JSON.stringify(chosen.interface)} })`
    )
    await restart()

    const policy = readUserPolicy(app.home, NETWORK_ADMISSION_FILE)
    expect(policy).toContain('\nname: network-admission\n')
    expect(policy).toContain(
      `match: "!(inCidr(subject.address, ['127.0.0.0/8', '::1', '${chosen.cidr}']))"`
    )
    expect(settingsRows()).toEqual([
      { key: 'network.enabled', value: 'true' },
      { key: 'network.port', value: String(P) }
    ])
    await until(async () => (await status()).listening, 'listening again after the restart')
    expect((await status()).admission).toBe('override')
    expect((await httpProbe({ port: P })).status).toBe(200)
    expect((await lanProbe({ ip: chosen.address })).status).toBe(200)
  }, 120_000)
})
