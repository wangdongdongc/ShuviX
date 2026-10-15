/**
 * 网络访问（server mode phase B / C）的用户流程 —— 一个真的浏览器页面（应用自己的浏览器里一个没有 preload 的 tab）
 * 打开 `http://127.0.0.1:<端口>/`，经 WebSocket 用与桌面窗口同一张通道表、同一套处理函数。
 *
 * NW-1  缺省不监听；在空闲端口上打开 → 开始监听
 * NW-2  那个页面就是 web 客户端：`window.api` 能用、没有任何 Electron 全局；设置页列出这个客户端
 * NW-3  会话列表在页面里渲染、跟着实时推送走
 * NW-4  页面里发的提示词流式回到页面、落进 message.list
 * NW-5  运行中的询问卡片在页面里答复：工具看见答复，运行继续
 * NW-6  只有桌面能用的通道在服务端被拒（主进程什么也不做）；页面里「在文件管理器中打开」换成显示服务端路径的卡片
 *       （phase D），浏览器里没有对应物的（悬浮窗）当场拒并给一条看得见的提示
 * NW-7  页面里打开设置 → 浏览器里一个新 tab 开 `#settings/general`
 * NW-8  换端口让服务重启 → 同一个页面重连回来，断着时错过的变化补上，整条链路恢复
 * NW-9  （最后）在设置里关掉 → 客户端被断开
 *
 * 约定：界面语言先设成 en；**从不在缺省端口 7766 上打开**（开发者自己的 ShuviX 可能占着），一律先 setPort(空闲端口)
 * 再 setEnabled(true)；会话只经主进程 IPC 带明确标题创建（不跑 titler，假提供商的 FIFO 干净）。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import { connectTabPage } from '../../harness/browserFixtures'
import { listTargets, sleep, until, type CdpClient } from '../../harness/cdp'
import { startFakeProvider, type FakeProvider } from '../../harness/fakeProvider'
import { freePort, launchApp, type E2EApp } from '../../harness/launch'
import {
  httpProbe,
  networkStatus,
  openWebClient,
  shellOpens,
  wsInvokeInPage,
  type NetworkStatus,
  type WebClientHandle
} from '../../harness/networkFixtures'
import {
  chatPane,
  networkSettingsPane,
  sidebarPane,
  webClientPane,
  type NetworkSettingsShot
} from '../../harness/pages'
import {
  appEventRecorder,
  createProject,
  eventRecorder,
  securityDecisions,
  seedFakeProvider,
  sqlite,
  waitRendererReady,
  type AppEventRecorder,
  type EventRecorder
} from '../../harness/seed'
import { syncProbe } from '../../harness/sync'

const MODEL = 'e2e-model'
const PORT_INVALID = 'The port must be an integer between 1024 and 65535.'

/** message.list 的一条（只声明本文件读的字段） */
interface ListedMessage {
  id: string
  role: string
  content: string
}

/** 页面里一次被拒的调用 */
interface Rejection {
  ok: boolean
  code?: string
  message?: string
}

let app: E2EApp
let provider: FakeProvider
let web: WebClientHandle | undefined
let settings: CdpClient | undefined
/** NW-7 开的第二个 web tab（失败时 afterAll 兜底关） */
const settingsTab: { page: CdpClient | null; tabId: string | null } = { page: null, tabId: null }
let mainAppEvents: AppEventRecorder
let webEvents: EventRecorder
let P1 = 0
let P2 = 0
let projectId = ''
let outside = ''
let clientId1 = ''
let knowledgeRoot = ''
const sids = { chat: '', ask: '' }

const status = (): Promise<NetworkStatus> => networkStatus(app.main)

const setPort = (port: unknown): Promise<NetworkStatus> =>
  app.main.eval<NetworkStatus>(`window.api.network.setPort(${JSON.stringify(port)})`)

const setEnabled = (on: boolean): Promise<NetworkStatus> =>
  app.main.eval<NetworkStatus>(`window.api.network.setEnabled(${JSON.stringify(on)})`)

const createSession = (title: string): Promise<string> =>
  app.main.eval<string>(
    `window.api.session.create(${JSON.stringify({ title, projectId })}).then((s) => s.id)`
  )

const listMessages = (sid: string): Promise<ListedMessage[]> =>
  app.main.eval<ListedMessage[]>(`window.api.message.list(${JSON.stringify(sid)})`)

/** 在 web 页面里调一次 `window.api.<expr>`，回它的结局（拒绝时带 code / message） */
const settleInWeb = (expr: string): Promise<Rejection & { value?: unknown }> =>
  web!.page.eval(
    `Promise.resolve().then(() => window.api.${expr}).then(
      (value) => ({ ok: true, value }),
      (e) => ({ ok: false, code: e?.code, message: e?.message })
    )`
  )

const webPage = (): CdpClient => web!.page

/** 桌面设置窗里网络访问一节的快照：等到满足 pred 才回 */
const settingsShotWhen = (
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

/** 关掉 NW-7 开的那个 web 设置 tab（不抛） */
async function closeSettingsTab(): Promise<void> {
  try {
    settingsTab.page?.close()
  } catch {
    /* 已经关了 */
  }
  settingsTab.page = null
  const tabId = settingsTab.tabId
  settingsTab.tabId = null
  if (tabId) {
    await app.main
      .eval(`window.api.browserView.closeTab(${JSON.stringify(tabId)})`)
      .catch(() => undefined)
  }
}

/** 桌面的设置窗 target（file:// 里 `#settings` 的那些） */
const desktopSettingsTargets = async (): Promise<number> =>
  (await listTargets(app.port)).filter(
    (t) => t.type === 'page' && t.url.startsWith('file://') && t.url.includes('#settings')
  ).length

beforeAll(async () => {
  app = await launchApp()
  await app.main.eval(`window.api.settings.set({ key: 'general.language', value: 'en' })`)
  provider = await startFakeProvider()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(app.main)

  const projDir = join(app.home, 'proj-nw')
  mkdirSync(projDir, { recursive: true })
  // 家目录里、会话目录以外 → ask-on-external-path#0 的读询问
  outside = join(app.home, 'nw-outside')
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, 'denied.txt'), 'NW-DENIED\n')
  writeFileSync(join(outside, 'allowed.txt'), 'NW-ALLOWED\n')
  projectId = (await createProject(app.main, { name: 'NetProj', path: projDir })).id
  sids.chat = await createSession('NW-chat')
  sids.ask = await createSession('NW-ask')
  knowledgeRoot = join(app.home, '.shuvix', 'knowledge')

  P1 = await freePort()
  do {
    P2 = await freePort()
  } while (P2 === P1)

  mainAppEvents = appEventRecorder(app.main)
  await mainAppEvents.install()
})

afterAll(async () => {
  if (app) await closeSettingsTab()
  try {
    settings?.close()
  } catch {
    /* 已经关了 */
  }
  if (web) await web.close().catch(() => undefined)
  await provider?.close().catch(() => undefined)
  await app?.stop()
})

describe('network access: the web client in a real page', () => {
  it('NW-1 a default launch does not listen; enabling on a free port starts the server', async () => {
    const initial = await status()
    expect(initial).toStrictEqual({
      enabled: false,
      port: 7766,
      lan: false,
      listening: false,
      addresses: [],
      clients: []
    })
    expect('error' in initial).toBe(false)

    expect(await setPort(P1)).toStrictEqual({
      enabled: false,
      port: P1,
      lan: false,
      listening: false,
      addresses: [],
      clients: []
    })

    await mainAppEvents.clear()
    const on = await setEnabled(true)
    expect(on).toMatchObject({
      enabled: true,
      port: P1,
      listening: true,
      clients: [],
      lan: false,
      bindAddress: '127.0.0.1'
    })
    expect('error' in on).toBe(false)
    // 局域网开关缺省关：只监听 127.0.0.1、只列它（phase D：列 127.0.0.1 而不是 localhost —— localhost 可能先解析成 ::1）
    expect(on.addresses).toStrictEqual([`http://127.0.0.1:${P1}`])
    await until(
      async () => (await mainAppEvents.count('network.changed')) >= 1,
      'network.changed after enabling'
    )

    const page = await httpProbe({ port: P1, host: `127.0.0.1:${P1}` })
    expect(page.status).toBe(200)
    expect(String(page.headers?.['content-type'])).toMatch(/^text\/html/)
  })

  it('NW-2 the plain page is the web client: working window.api, no Electron globals; Settings lists it', async () => {
    const t0 = Date.now()
    web = await openWebClient(app, P1)

    const facts = await webPage().eval<Record<string, string>>(`({
      platform: window.api.app.platform,
      electron: typeof window.electron,
      process: typeof process,
      require: typeof require,
      href: location.href,
      title: document.title,
      csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? ''
    })`)
    expect(facts).toMatchObject({
      platform: 'web',
      electron: 'undefined',
      process: 'undefined',
      require: 'undefined',
      href: `http://127.0.0.1:${P1}/`,
      title: 'ShuviX'
    })
    expect(facts.csp).toContain(`connect-src 'self' ws: wss: https:`)
    expect(facts.csp).not.toContain('shuvix-')

    const webIds = await webPage().eval<string[]>(
      `window.api.session.list().then((ss) => ss.map((s) => s.id).sort())`
    )
    const mainIds = await app.main.eval<string[]>(
      `window.api.session.list().then((ss) => ss.map((s) => s.id).sort())`
    )
    expect(webIds).toEqual(mainIds)
    expect(webIds).toEqual(expect.arrayContaining([sids.chat, sids.ask]))

    const withClient = await until(async () => {
      const s = await status()
      return s.clients.length === 1 ? s : null
    }, 'one network client listed')
    const client = withClient.clients[0]
    expect(client.id).toMatch(/^ws:\d+$/)
    expect(client.remoteAddress).toBe('127.0.0.1')
    expect(client.userAgent).toBe(await webPage().eval<string>('navigator.userAgent'))
    expect(client.connectedAt).toBeGreaterThanOrEqual(t0)
    expect(client.connectedAt).toBeLessThanOrEqual(Date.now())
    clientId1 = client.id

    const fromWeb = await webPage().eval<NetworkStatus>('window.api.network.status()')
    expect(fromWeb.clients.map((c) => c.id)).toEqual([clientId1])

    const pane = webClientPane(webPage())
    expect(await pane.connectionBanner()).toBeNull()
    await sleep(1000)
    expect(await pane.connectionBanner()).toBeNull()
    expect(await pane.desktopOnlyNotice()).toBeNull()

    settings = await app.openSettings('general')
    const shot = await settingsShotWhen((s) => s.clients.length === 1, 'settings list the client')
    expect(shot).toStrictEqual({
      present: true,
      toggle: 'on',
      toggleDisabled: false,
      lan: 'off',
      lanDisabled: false,
      portDisabled: false,
      localOnly: en.settings.networkLocalOnly.replaceAll('{{port}}', String(P1)),
      headlessNote: null,
      headlessLanNote: null,
      headlessPortNote: null,
      risk: en.settings.networkRisk,
      riskVisible: true,
      addresses: withClient.addresses,
      clients: [clientId1],
      clientTitles: ['127.0.0.1'],
      error: null
    })
  })

  it('NW-3 the session list renders in the page and follows live pushes', async () => {
    const sidebar = sidebarPane(webPage())
    await until(async () => {
      const titles = await sidebar.titles()
      return titles.includes('NW-chat') && titles.includes('NW-ask')
    }, 'web sidebar shows the seeded sessions')

    await webPage().eval('window.__nwMarker = "nw-3"')
    await createSession('NW-live')
    await until(
      async () => (await sidebar.titles()).includes('NW-live'),
      'web sidebar picks up a session created in main'
    )
    expect(await webPage().eval('window.__nwMarker')).toBe('nw-3')
  })

  it('NW-4 a prompt sent from the page streams into the page and lands in message.list', async () => {
    webEvents = eventRecorder(webPage())
    await webEvents.install()
    provider.reset()
    provider.script({
      text: ['Hello', ' from', ' web'],
      chunkDelayMs: 30,
      holdMs: 20_000,
      usage: { prompt: 20, completion: 3 }
    })

    const chat = chatPane(webPage())
    expect(await sidebarPane(webPage()).openSession('NW-chat')).toBe(true)
    await chat.ready()
    await chat.typeAndSend('ping web')

    await until(() => provider.holding(), 'provider holding the streamed turn')
    await syncProbe(webPage()).waitView(
      sids.chat,
      (v) => v.run.state === 'busy' && v.live?.message.content === 'Hello from web',
      15_000,
      'web view shows the live card mid-stream'
    )
    expect(await chat.isBusy()).toBe(true)

    provider.release()
    await webEvents.waitFor('agent_end', { sessionId: sids.chat })
    await chat.waitIdle()

    const lifecycle = (await webEvents.all())
      .filter((e) => e.sessionId === sids.chat)
      .map((e) => e.type)
      .filter((t) => t === 'agent_created' || t === 'agent_start' || t === 'agent_end')
    expect(lifecycle).toEqual(['agent_created', 'agent_start', 'agent_end'])

    expect(
      (await chat.settledItems()).map(({ role, type, text }) => ({ role, type, text }))
    ).toEqual([
      { role: 'user', type: 'text', text: 'ping web' },
      { role: 'assistant', type: 'message', text: 'Hello from web' }
    ])

    const messages = await listMessages(sids.chat)
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(messages.map((m) => m.content)).toEqual(['ping web', 'Hello from web'])

    expect(provider.requests()).toHaveLength(1)
    expect(provider.requests()[0].lastUserText).toBe('ping web')
  })

  it('NW-5 ask cards raised by the run are answered from the page; the tool sees the answer and the run continues', async () => {
    const denied = join(outside, 'denied.txt')
    const allowed = join(outside, 'allowed.txt')
    provider.reset()
    provider.script(
      {
        toolCalls: [{ id: 'call_nw_deny', name: 'read', args: JSON.stringify({ path: denied }) }],
        usage: { prompt: 20, completion: 3 }
      },
      {
        toolCalls: [{ id: 'call_nw_allow', name: 'read', args: JSON.stringify({ path: allowed }) }],
        usage: { prompt: 20, completion: 3 }
      },
      { text: 'asks done', usage: { prompt: 20, completion: 3 } }
    )

    const chat = chatPane(webPage())
    expect(await sidebarPane(webPage()).openSession('NW-ask')).toBe(true)
    await chat.ready()
    await chat.typeAndSend('read both files')

    // 第一张卡：页面里看得见；主窗口的视图里同一条询问（询问是共享视图的一部分）
    const mainProbe = syncProbe(app.main)
    const first = await mainProbe.nextAsk(sids.ask)
    const firstCard = await until(async () => {
      const shot = await chat.pendingAskShot()
      return shot && shot.preview.includes('denied.txt') ? shot : null
    }, 'first ask card in the web page')
    expect(firstCard.preview).toContain('denied.txt')
    expect((await mainProbe.viewOf(sids.ask))?.asks.length).toBeGreaterThan(0)
    await chat.answerPendingAsk('deny')
    await mainProbe.waitAskGone(sids.ask, first.id)

    const second = await mainProbe.nextAsk(sids.ask)
    expect(second.id).not.toBe(first.id)
    await until(async () => {
      const shot = await chat.pendingAskShot()
      return shot && shot.preview.includes('allowed.txt') ? shot : null
    }, 'second ask card in the web page')
    await chat.answerPendingAsk('allow')
    await mainProbe.waitAskGone(sids.ask, second.id)

    await webEvents.waitFor('agent_end', { sessionId: sids.ask })
    await chat.waitIdle()

    const results = await mainProbe.toolResults(sids.ask)
    const deny = results.find((r) => r.toolCallId === 'call_nw_deny')
    const allow = results.find((r) => r.toolCallId === 'call_nw_allow')
    expect(deny?.isError).toBe(true)
    expect(deny?.result).not.toContain('NW-DENIED')
    expect(allow?.isError).toBe(false)
    expect(allow?.result).toContain('NW-ALLOWED')

    const requests = provider.requests()
    expect(requests).toHaveLength(3)
    expect(requests[2].raw).toContain('NW-ALLOWED')
    expect(requests[2].raw).not.toContain('NW-DENIED')

    const settled = await chat.settledItems()
    expect(settled.filter((i) => i.role === 'assistant').at(-1)?.text).toBe('asks done')

    const decisions = securityDecisions(app)
    expect(decisions.filter((d) => d.toolCallId === 'call_nw_deny')).toEqual([
      expect.objectContaining({
        action: 'read',
        effect: 'ask',
        winning: 'ask-on-external-path#0',
        userResponse: 'denied'
      })
    ])
    expect(decisions.filter((d) => d.toolCallId === 'call_nw_allow')).toEqual([
      expect.objectContaining({
        action: 'read',
        effect: 'ask',
        winning: 'ask-on-external-path#0',
        userResponse: 'allowed'
      })
    ])
  })

  it('NW-6 desktop-only calls are refused on the server (the main process does nothing); in the page, open-folder shows the server path and the rest get a visible notice', async () => {
    const pane = webClientPane(webPage())
    expect(shellOpens(app), 'precondition: nothing handed to the file manager yet').toEqual([])

    // 客户端（phase D）：「在文件管理器中打开」显示服务端路径（不走到服务端的那条桌面通道）
    expect(await settleInWeb(`app.openFolder('/nonexistent-nw')`)).toStrictEqual({
      ok: true,
      value: { success: true }
    })
    expect(
      await until(async () => {
        const notice = await pane.pathNotice()
        return notice?.channel === 'app:open-folder' ? notice : null
      }, 'path notice for app:open-folder')
    ).toStrictEqual({
      channel: 'app:open-folder',
      path: '/nonexistent-nw',
      text: '/nonexistent-nw'
    })
    // 无参的那几条：先经 fs:locateFolder 问到路径（与桌面一样，目录不在就建好）
    expect(await settleInWeb('knowledge.openFolder()')).toStrictEqual({
      ok: true,
      value: { success: true }
    })
    await until(async () => {
      const notice = await pane.pathNotice()
      return notice?.channel === 'knowledge:openFolder' && notice.path === knowledgeRoot
    }, 'path notice for knowledge:openFolder shows the user knowledge root')
    expect(existsSync(knowledgeRoot)).toBe(true)
    expect(await pane.closePathNotice()).toBe(true)
    await until(async () => (await pane.pathNotice()) === null, 'path notice closed')
    // 浏览器里没有对应物的（悬浮窗）：当场拒绝 + 看得见的提示
    expect(await settleInWeb(`pinChat.pin(${JSON.stringify(sids.chat)})`)).toStrictEqual({
      ok: false,
      code: 'desktop_only',
      message: '"pinChat:pin" is only available in the desktop app for now'
    })
    await until(
      async () => (await pane.desktopOnlyNotice()) === 'pinChat:pin',
      'desktop-only notice for pinChat:pin'
    )
    await until(
      async () => (await pane.desktopOnlyNotice()) === null,
      'desktop-only notice goes away by itself',
      10_000
    )
    // 主进程一样都没交给系统文件管理器
    expect(shellOpens(app)).toEqual([])

    // 处理函数自己的错误原样回到页面（没有 IPC 的前缀）
    expect(await settleInWeb('network.setPort(80)')).toStrictEqual({
      ok: false,
      code: 'handler_error',
      message: PORT_INVALID
    })
    const afterBadPort = await status()
    expect(afterBadPort.port).toBe(P1)
    expect(afterBadPort.clients.map((c) => c.id)).toEqual([clientId1])

    // 服务端：另开一条 socket 发原始帧
    const version = await app.main.eval<string>('window.api.app.getVersion()')
    const widthBefore = await app.main.eval<number>('window.outerWidth')
    const [openFolder, nope, syncFrame, windowReady, appVersion, adjust, netStatus, malformed] =
      await wsInvokeInPage(
        webPage(),
        [
          { id: 1, channel: 'knowledge:openFolder', args: [] },
          { id: 2, channel: 'nope:nothing', args: [] },
          { id: 3, channel: 'sync:frame', args: [] },
          { id: 4, channel: 'app:window-ready', args: [] },
          { id: 5, channel: 'app:version', args: [] },
          { id: 6, channel: 'app:adjust-window-width', args: [40] },
          { id: 7, channel: 'network:status', args: [] }
        ],
        [{ id: 99, text: '{"t":"invoke","id":99,"channel":"app:version","args":"nope"}' }]
      )
    expect(openFolder).toStrictEqual({
      t: 'result',
      id: 1,
      ok: false,
      error: {
        code: 'desktop_only',
        message: '"knowledge:openFolder" is only available in the desktop app for now'
      }
    })
    // 服务端拒了就不执行处理函数：没有交给系统文件管理器
    expect(shellOpens(app)).toEqual([])
    expect(nope).toStrictEqual({
      t: 'result',
      id: 2,
      ok: false,
      error: { code: 'unknown_channel', message: 'No handler registered for "nope:nothing"' }
    })
    expect(syncFrame).toMatchObject({ id: 3, ok: false, error: { code: 'unknown_channel' } })
    expect(windowReady).toMatchObject({ id: 4, ok: false, error: { code: 'unknown_channel' } })
    expect(appVersion).toStrictEqual({ t: 'result', id: 5, ok: true, value: version })
    expect(adjust).toStrictEqual({ t: 'result', id: 6, ok: true })
    expect(await app.main.eval<number>('window.outerWidth')).toBe(widthBefore)
    expect(netStatus).toMatchObject({ id: 7, ok: true })
    expect((netStatus?.value as NetworkStatus).clients).toHaveLength(2)
    expect(malformed).toStrictEqual({
      t: 'result',
      id: 99,
      ok: false,
      error: { code: 'bad_request', message: 'Malformed request.' }
    })

    await until(async () => {
      const s = await status()
      return s.clients.length === 1 && s.clients[0].id === clientId1
    }, 'the helper socket is gone; only the page stays connected')
  })

  it('NW-7 on the web, app.openSettings opens #settings/general in a new browser tab', async () => {
    const desktopSettingsBefore = await desktopSettingsTargets()
    const settingsUrl = `http://127.0.0.1:${P1}/#settings/general`
    // window.open 带一次用户手势（与在页面上点一下等价）
    const opened = await webPage().send<{ result?: { value?: unknown } }>('Runtime.evaluate', {
      expression: `Promise.resolve(window.api.app.openSettings('general'))`,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    })
    expect(opened.result?.value).toStrictEqual({ success: true })

    const tab = await until(
      async () =>
        (
          await app.main.eval<Array<{ id: string; url: string }>>(
            'window.api.browserView.listTabs()'
          )
        ).find((t) => t.url === settingsUrl) ?? null,
      'a browser tab on #settings/general'
    )
    settingsTab.tabId = tab.id
    try {
      const page = await until(
        () => connectTabPage(app.port, (u) => u === settingsUrl),
        'the #settings/general tab page target'
      )
      settingsTab.page = page
      // 状态拉回来之前开关画成关着的（禁用态）—— 等它拿到状态
      const shot = await until(async () => {
        const s = await networkSettingsPane(page).shot()
        return s.present && s.toggle === 'on' ? s : null
      }, 'network section in the web settings page shows the switch on')
      expect(shot.risk).toBe(en.settings.networkRisk)
      await until(
        async () => (await status()).clients.length === 2,
        'the settings tab connects too'
      )
    } finally {
      // 失败也要关掉：多出来的一个客户端会让后面的用例数错
      await closeSettingsTab()
    }
    await until(async () => (await status()).clients.length === 1, 'the settings tab client drops')
    expect(await desktopSettingsTargets()).toBe(desktopSettingsBefore)
  })

  it('NW-8 after a server restart caused by a port change, the same page reconnects', async () => {
    const pane = webClientPane(webPage())
    await webPage().eval('window.__nwMarker = "nw-8"')
    const since = await webEvents.mark()

    const moved = await setPort(P2)
    expect(moved).toMatchObject({ port: P2, listening: true, clients: [] })

    await until(
      async () => (await pane.connectionBanner()) === 'reconnecting',
      'reconnecting banner in the page'
    )
    expect(await pane.connectionBannerText()).toBe(en.web.reconnecting)

    // 断着的时候
    expect(await settleInWeb('session.list()')).toMatchObject({ ok: false, code: 'disconnected' })
    // 本地当场拒的桌面专属通道不需要连接（phase D 之后 app.openFolder 有本地实现，换成悬浮窗）
    expect(await settleInWeb(`pinChat.pin('x')`)).toMatchObject({
      ok: false,
      code: 'desktop_only'
    })
    expect(await httpProbe({ port: P1 })).toMatchObject({ error: 'ECONNREFUSED' })
    expect((await httpProbe({ port: P2, host: `127.0.0.1:${P2}` })).status).toBe(200)
    expect((await httpProbe({ port: P2, host: `127.0.0.1:${P1}` })).status).toBe(421)
    const down = await until(async () => {
      const s = await status()
      return s.clients.length === 0 ? s : null
    }, 'no clients while the page is reconnecting')
    for (const address of down.addresses) expect(address.endsWith(`:${P2}`)).toBe(true)
    const downShot = await settingsShotWhen(
      (s) => s.clients.length === 0 && s.addresses.every((a) => a.endsWith(`:${P2}`)),
      'settings show the new port and no clients'
    )
    expect(downShot.addresses.length).toBeGreaterThan(0)

    // 断着时的变化：这条 session.listChanged 推送页面收不到
    await createSession('NW-while-down')

    const back = await setPort(P1)
    expect(back).toMatchObject({ port: P1, listening: true })

    await until(
      async () => (await pane.connectionBanner()) === null,
      'the page reconnects (banner gone)',
      20_000
    )
    const reconnected = await until(
      async () => {
        const s = await status()
        return s.clients.length === 1 ? s : null
      },
      'the page is listed again',
      20_000
    )
    const clientId2 = reconnected.clients[0].id
    expect(clientId2).not.toBe(clientId1)

    expect(await webPage().eval('window.__nwMarker')).toBe('nw-8')

    const titles = await webPage().eval<string[]>(
      'window.api.session.list().then((ss) => ss.map((s) => s.title))'
    )
    expect(titles).toContain('NW-while-down')
    await until(
      async () => (await sidebarPane(webPage()).titles()).includes('NW-while-down'),
      'the web sidebar resyncs after reconnecting'
    )
    await settingsShotWhen(
      (s) => s.clients.length === 1 && s.clients[0] === clientId2,
      'settings list the reconnected client'
    )

    // 整条链路恢复
    provider.reset()
    provider.script({ text: 'Back online', usage: { prompt: 20, completion: 3 } })
    const chat = chatPane(webPage())
    expect(await sidebarPane(webPage()).openSession('NW-chat')).toBe(true)
    await chat.ready()
    await chat.typeAndSend('ping after reconnect')
    await webEvents.waitFor('agent_end', { sessionId: sids.chat, since })
    await chat.waitIdle()
    await until(
      async () => (await chat.settledItems()).length === 4,
      'four settled items in NW-chat'
    )
    const settled = await chat.settledItems()
    expect(settled.at(-1)).toMatchObject({ role: 'assistant', text: 'Back online' })
    expect(await listMessages(sids.chat)).toHaveLength(4)
  }, 90_000)

  it('NW-9 switching off in Settings drops the client', async () => {
    const pane = webClientPane(webPage())
    await networkSettingsPane(settings!).clickToggle()
    await until(async () => !(await status()).listening, 'stopped listening')

    const off = await status()
    expect(off).toStrictEqual({
      enabled: false,
      port: P1,
      lan: false,
      listening: false,
      addresses: [],
      clients: []
    })
    expect(sqlite(app.home, "select value from settings where key='network.enabled'").trim()).toBe(
      'false'
    )

    await until(
      async () => (await pane.connectionBanner()) === 'reconnecting',
      'the page shows the reconnecting banner'
    )
    expect(await settleInWeb('session.list()')).toMatchObject({ ok: false, code: 'disconnected' })
    expect(await httpProbe({ port: P1 })).toMatchObject({ error: 'ECONNREFUSED' })

    const shot = await settingsShotWhen((s) => s.toggle === 'off', 'settings show the switch off')
    expect(shot).toMatchObject({ toggle: 'off', addresses: [], clients: [], riskVisible: true })

    await sleep(1500)
    expect(await pane.connectionBanner()).toBe('reconnecting')
    expect((await status()).clients).toEqual([])
  })
})
