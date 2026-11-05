/**
 * 后台任务与网络客户端：`bg_task` 是事件，客户端不在的时候发的都错过了，所以挂载时、重连之后（web 客户端补发
 * `session.listChanged`）各取一份 `bgTask.listAll()`。
 *
 *   BGW-E1 web 客户端在任务开始之后才打开：不用打开那条会话，行上就亮着
 *   BGW-E2 socket 断着时任务结束了：连回来行自己灭，不用刷新
 *
 * 后台命令等一个标记文件（相对路径，同 sidebar-bg-running）。`session.autoResume` 关掉：否则退出的通知起一轮，行又亮。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sleep, until } from '../../harness/cdp'
import { startFakeProvider, type FakeProvider } from '../../harness/fakeProvider'
import { freePort, launchApp, type E2EApp } from '../../harness/launch'
import {
  openWebClient,
  type NetworkStatus,
  type WebClientHandle
} from '../../harness/networkFixtures'
import { sidebarPane, webClientPane } from '../../harness/pages'
import {
  createProject,
  eventRecorder,
  installAutoAllow,
  seedFakeProvider,
  waitRendererReady,
  type EventRecorder
} from '../../harness/seed'

const MODEL = 'e2e-model'
const SENTINEL = 'bg.release'
const COMMAND = `until [ -f ${SENTINEL} ]; do sleep 0.2; done`
const TITLE = 'BGW-A'

describe('background tasks and the web client', () => {
  let app: E2EApp
  let provider: FakeProvider
  let events: EventRecorder
  let web: WebClientHandle | undefined
  let projDir = ''
  let sid = ''
  let P1 = 0
  let P2 = 0

  const setPort = (port: number): Promise<NetworkStatus> =>
    app.main.eval<NetworkStatus>(`window.api.network.setPort(${JSON.stringify(port)})`)

  const taskEnded = (): Promise<boolean> =>
    app.main.eval<boolean>(
      `window.api.bgTask.list(${JSON.stringify({ sessionId: sid })}).then((ts) => ts.length === 1 && ts[0].endedAt !== null)`
    )

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
    await app.main.eval(`window.api.settings.set({ key: 'session.autoResume', value: 'false' })`)
    provider = await startFakeProvider()
    await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
    await waitRendererReady(app.main)

    projDir = join(app.home, 'proj-bg-web')
    mkdirSync(projDir, { recursive: true })
    const project = await createProject(app.main, { name: 'BgWebProj', path: projDir })
    sid = await app.main.eval<string>(
      `window.api.session.create(${JSON.stringify({ title: TITLE, projectId: project.id })}).then((s) => s.id)`
    )

    events = eventRecorder(app.main)
    await events.install()
    await installAutoAllow(app.main)

    P1 = await freePort()
    do {
      P2 = await freePort()
    } while (P2 === P1)
    await setPort(P1)
    await app.main.eval(`window.api.network.setEnabled(true)`)
  }, 120_000)

  afterAll(async () => {
    if (web) await web.close().catch(() => undefined)
    await provider?.close().catch(() => undefined)
    await app?.stop()
  })

  it('BGW-E1 a client opened after the task started lights the row without opening the session', async () => {
    provider.script(
      {
        toolCalls: [
          {
            id: 'call_bg_web',
            name: 'bash',
            args: JSON.stringify({
              command: COMMAND,
              description: 'wait for the sentinel',
              run_in_background: true
            })
          }
        ],
        usage: { prompt: 20, completion: 4 }
      },
      { text: 'started', usage: { prompt: 30, completion: 2 } }
    )
    await app.main.eval(
      `(window.api.agent.prompt(${JSON.stringify({ sessionId: sid, text: 'start it' })}).catch(() => undefined), true)`
    )
    await events.waitFor('agent_end', { sessionId: sid })

    web = await openWebClient(app, P1)
    const sidebar = sidebarPane(web.page)
    await until(
      async () => (await sidebar.titles()).includes(TITLE),
      'the session is listed',
      20_000
    )
    await until(
      () => sidebar.rowRunning(TITLE),
      'the row is running without opening the session',
      20_000
    )
    await sleep(500)
    expect(await sidebar.rowRunning(TITLE)).toBe(true)
  }, 120_000)

  it('BGW-E2 a task that ended while the socket was down goes out after reconnecting, with no reload', async () => {
    const sidebar = sidebarPane(web!.page)
    expect(await sidebar.rowRunning(TITLE)).toBe(true)
    // 这个页面从头到尾是同一份：放个记号，重连之后还在 = 没有刷新过
    await web!.page.eval('(window.__bgwNoReload = true)')

    const link = await dropConnection()
    writeFileSync(join(projDir, SENTINEL), '')
    await until(taskEnded, 'the task ended on the desktop side', 20_000)
    // 断着：页面还不知道
    await sleep(300)
    expect(await sidebar.rowRunning(TITLE)).toBe(true)

    await link.reconnect()
    await until(
      async () => !(await sidebar.rowRunning(TITLE)),
      'the row goes out after reconnecting',
      20_000
    )
    expect(await web!.page.eval('window.__bgwNoReload === true')).toBe(true)
  }, 120_000)
})
