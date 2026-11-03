/**
 * 询问与网络客户端（2026-11-02）：询问不看有没有客户端连着，徽标是后来连上的客户端自己补的 —— `ask_count` 是事件，它不在的
 * 时候发的都错过了，所以挂载时、重连之后（web 客户端补发 `session.listChanged`）各取一份 `agent.askCounts()`。
 *
 *   AR-E1 无头（Node 的 WebSocket）：回复挂着时唯一的客户端断开，放行之后询问在零个客户端时挂上：没有下一次请求。新客户端的
 *         agent:askCounts 是 {sid:1}；agent:respondToInput 之后有下一次请求（没有 Aborted），计数变成 {}
 *   AR-E2 web 客户端（实例自己浏览器里的一个 tab）在询问之后才打开：不用打开那条会话，行上就有徽标；打开、在 web 上答，
 *         主窗口的视图里也没了
 *   AR-E3 socket 断着时主窗口那边起了询问：连回来徽标自己出现，不用刷新
 *   AR-E4 徽标亮着，断开，主窗口答了：连回来徽标没了
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sleep, until } from '../../harness/cdp'
import {
  startFakeProvider,
  type FakeProvider,
  type FakeRequest,
  type FakeTurn
} from '../../harness/fakeProvider'
import { freePort, launchApp, type E2EApp, type E2EHeadlessApp } from '../../harness/launch'
import {
  openWebClient,
  type NetworkStatus,
  type WebClientHandle
} from '../../harness/networkFixtures'
import { chatPane, sidebarPane, webClientPane } from '../../harness/pages'
import { seedFakeProvider, waitRendererReady } from '../../harness/seed'
import { syncProbe, type SyncProbe } from '../../harness/sync'
import { connectWs, type WsClient } from '../../harness/wsClient'

const MODEL = 'e2e-model'

interface ToolMessage {
  role: string
  content?: unknown
}
const toolMessages = (req: FakeRequest): ToolMessage[] =>
  ((req.body.messages ?? []) as ToolMessage[]).filter((m) => m.role === 'tool')

const askCall = (id: string): NonNullable<FakeTurn['toolCalls']> => [
  {
    id,
    name: 'ask',
    args: JSON.stringify({
      question: 'Which one?',
      options: [
        { label: 'A', description: 'first' },
        { label: 'B', description: 'second' }
      ]
    })
  }
]

/** 一轮：先问 `callId`，答了之后回 `reply`。按 `mark` 认领（并发、别的请求都不打乱） */
function scriptAskRun(
  p: FakeProvider,
  mark: string,
  callId: string,
  extra: Partial<FakeTurn> = {}
): void {
  p.script(
    {
      toolCalls: askCall(callId),
      when: (req) => req.raw.includes(mark) && toolMessages(req).length === 0,
      usage: { prompt: 80, completion: 6 },
      ...extra
    },
    {
      text: `${mark} finished`,
      when: (req) => req.raw.includes(mark) && toolMessages(req).length === 1,
      usage: { prompt: 90, completion: 4 }
    }
  )
}

describe('AR-E1 headless: an ask with no client', () => {
  let app: E2EHeadlessApp
  let provider: FakeProvider
  let client: WsClient | undefined

  beforeAll(async () => {
    app = await launchApp({ headless: true })
    provider = await startFakeProvider()
  })

  afterAll(async () => {
    client?.close()
    await provider?.close()
    await app?.stop()
  })

  it('AR-E1 waits with zero clients; a new client counts it and answers it', async () => {
    const MARK = 'AR-E1 please ask me'
    const setup = await connectWs(app.networkPort)
    const added = await setup.invoke<{ id: string }>('provider:add', {
      name: 'E2E Fake',
      baseUrl: provider.baseUrl,
      apiKey: 'e2e',
      apiProtocol: 'openai-completions'
    })
    await setup.invoke('provider:addModel', { providerId: added.id, modelId: MODEL })
    await setup.invoke('settings:set', { key: 'general.defaultProvider', value: added.id })
    await setup.invoke('settings:set', { key: 'general.defaultModel', value: MODEL })
    const session = await setup.invoke<{ id: string }>('session:create', { title: 'Ordinary' })
    scriptAskRun(provider, MARK, 'call_ask', { holdMs: 60_000, holdKey: 'gone' })
    void setup.invoke('agent:prompt', { sessionId: session.id, text: MARK }).catch(() => undefined)
    await until(() => provider.holding('gone'), 'model mid-reply', 20_000)

    setup.close()
    await setup.closed()
    await sleep(500)
    provider.release('gone')
    await sleep(3000)
    const requests = (): FakeRequest[] => provider.requests().filter((r) => r.raw.includes(MARK))
    expect(requests()).toHaveLength(1)

    client = await connectWs(app.networkPort)
    await until(
      async () =>
        (await client!.invoke<Record<string, number>>('agent:askCounts'))[session.id] === 1,
      'the new client counts the ask',
      20_000
    )
    expect(await client.invoke('agent:askCounts')).toEqual({ [session.id]: 1 })

    await client.invoke('agent:respondToInput', {
      sessionId: session.id,
      requestId: 'call_ask',
      response: { kind: 'choice', selections: ['A'] }
    })
    await until(
      () => requests().some((r) => toolMessages(r).length === 1),
      'the answer reached the model',
      20_000
    )
    const tools = toolMessages(requests().at(-1)!)
    expect(JSON.stringify(tools)).toContain('User selected: A')
    expect(JSON.stringify(tools)).not.toContain('Aborted')
    await until(
      async () => Object.keys(await client!.invoke<object>('agent:askCounts')).length === 0,
      'the count is empty',
      20_000
    )
  }, 120_000)
})

describe('AR-E2..4 web client', () => {
  let app: E2EApp
  let provider: FakeProvider
  let web: WebClientHandle | undefined
  let probe: SyncProbe
  let P1 = 0
  let P2 = 0

  const setPort = (port: number): Promise<NetworkStatus> =>
    app.main.eval<NetworkStatus>(`window.api.network.setPort(${JSON.stringify(port)})`)

  const createSession = (title: string): Promise<string> =>
    app.main.eval<string>(
      `window.api.session.create(${JSON.stringify({ title })}).then((s) => s.id)`
    )

  /** 主窗口发一句，让它停在询问上 */
  async function raiseAsk(sid: string, mark: string, callId: string): Promise<void> {
    scriptAskRun(provider, mark, callId)
    await app.main.eval(
      `(window.api.agent.prompt(${JSON.stringify({ sessionId: sid, text: mark })}).catch(() => undefined), true)`
    )
    await probe.waitView(sid, (view) => view.asks.some((ask) => ask.id === callId), 20_000)
  }

  /** 让页面的 WebSocket 断开，等它看到断线；`reconnect` 把服务端放回原端口，等它连回来 */
  async function dropConnection(): Promise<{ reconnect(): Promise<void> }> {
    const pane = webClientPane(web!.page)
    await setPort(P2)
    await until(
      async () => (await pane.connectionBanner()) === 'reconnecting',
      'the page shows the reconnecting banner'
    )
    return {
      reconnect: async () => {
        await setPort(P1)
        await until(
          async () => (await pane.connectionBanner()) === null,
          'the page reconnects',
          20_000
        )
      }
    }
  }

  beforeAll(async () => {
    app = await launchApp()
    await app.main.eval(`window.api.settings.set({ key: 'general.language', value: 'en' })`)
    provider = await startFakeProvider()
    await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
    await waitRendererReady(app.main)
    probe = syncProbe(app.main)
    P1 = await freePort()
    do {
      P2 = await freePort()
    } while (P2 === P1)
    await setPort(P1)
    await app.main.eval(`window.api.network.setEnabled(true)`)
  })

  afterAll(async () => {
    if (web) await web.close().catch(() => undefined)
    await provider?.close().catch(() => undefined)
    await app?.stop()
  })

  it('AR-E2 a client opened after the ask shows the badge; answering from the web clears the main view', async () => {
    const TITLE = 'AR-E2'
    const MARK = 'AR-E2 please ask me'
    const sid = await createSession(TITLE)
    await raiseAsk(sid, MARK, 'call_e2')

    web = await openWebClient(app, P1)
    const page = web.page
    const sidebar = sidebarPane(page)
    await until(
      async () => (await sidebar.pendingAsks(TITLE)) === 1,
      'the badge is on the row without opening the session',
      20_000
    )

    expect(await sidebar.openSession(TITLE)).toBe(true)
    const chat = chatPane(page)
    await chat.ready()
    await until(
      async () => (await chat.pendingPanel()).open,
      'the web client shows the card',
      20_000
    )
    await page.eval(
      `window.api.agent.respondToInput(${JSON.stringify({
        sessionId: sid,
        requestId: 'call_e2',
        response: { kind: 'choice', selections: ['A'] }
      })})`
    )
    await probe.waitAskGone(sid, 'call_e2', 20_000)
    await until(
      () => provider.requests().some((r) => r.raw.includes(MARK) && toolMessages(r).length === 1),
      'the answer reached the model',
      20_000
    )
    await until(async () => (await sidebar.pendingAsks(TITLE)) === null, 'badge gone', 20_000)
  }, 120_000)

  it('AR-E3 an ask raised while the socket is down shows its badge after reconnecting, with no reload', async () => {
    const TITLE = 'AR-E3'
    const sid = await createSession(TITLE)
    const sidebar = sidebarPane(web!.page)
    await until(async () => (await sidebar.titles()).includes(TITLE), 'the session is listed')
    expect(await sidebar.pendingAsks(TITLE)).toBeNull()
    // 这个页面从头到尾是同一份：放个记号，重连之后还在 = 没有刷新过
    await web!.page.eval('(window.__arE3NoReload = true)')

    const link = await dropConnection()
    await raiseAsk(sid, 'AR-E3 please ask me', 'call_e3')
    await sleep(300)
    expect(await sidebar.pendingAsks(TITLE)).toBeNull()

    await link.reconnect()
    await until(
      async () => (await sidebar.pendingAsks(TITLE)) === 1,
      'the badge appears after reconnecting',
      20_000
    )
    expect(await web!.page.eval('window.__arE3NoReload === true')).toBe(true)
  }, 120_000)

  it('AR-E4 answered from the main window while the socket was down: the badge is gone after reconnecting', async () => {
    const TITLE = 'AR-E3'
    const sidebar = sidebarPane(web!.page)
    const sid = await app.main.eval<string>(
      `window.api.session.list().then((ss) => ss.find((s) => s.title === ${JSON.stringify(TITLE)}).id)`
    )
    expect(await sidebar.pendingAsks(TITLE)).toBe(1)

    const link = await dropConnection()
    await app.main.eval(
      `window.api.agent.respondToInput(${JSON.stringify({
        sessionId: sid,
        requestId: 'call_e3',
        response: { kind: 'choice', selections: ['B'] }
      })})`
    )
    await probe.waitAskGone(sid, 'call_e3', 20_000)
    // 断着：页面还不知道
    expect(await sidebar.pendingAsks(TITLE)).toBe(1)

    await link.reconnect()
    await until(
      async () => (await sidebar.pendingAsks(TITLE)) === null,
      'the badge is gone after reconnecting',
      20_000
    )
  }, 120_000)
})
