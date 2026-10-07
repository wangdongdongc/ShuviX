/**
 * 退出（应用生命周期）—— 一次 Cmd+Q 就真的退出；会话在退出前关好（封顶），下次启动原样都在。
 *
 * 退出一律经 harness 的 `app.quit()`：SIGTERM → Electron 在一个**原生任务**里调 `Browser::Quit()`，
 * 与菜单「退出」（Cmd+Q 的 `terminate:`）同一个入口、调用栈上没有 JS（见 launch.ts）。v0.2.0 的 bug
 * 只在这条路上出现：会话宿主的退出钩子在 closeAll 落定的 promise 回调里直接 `app.quit()`，而 closeAll
 * 常常在 `before-quit` 那次派发的 microtask 清空里就落定了 —— 重入 `Browser::Quit()`，外层把
 * `is_quitting_` 写回 false，最后一个窗口关掉时只发 `window-all-closed`：窗口没了、进程还在、宿主已封存。
 * `stop()` 的 SIGKILL 兜底一直把它盖住，所以这里断「进程**自己**退出」。
 *
 * 每条用例一个（或两个）实例：退出是一次性的。
 *
 *   QUIT-1 开着一条有消息的会话（宿主已建）：一次退出进程自己退掉，JS 退出流程走完；其余清理恰好跑一次
 *          （主日志各一行）；同一个 HOME 再起，会话的消息都在、运行状态 idle
 *   QUIT-2 正跑着一轮（回复挂住）：一次退出照样退掉；再起，会话报 interrupted（busy 标记熬过退出），
 *          用户那条消息在
 *   QUIT-3 从没建过会话宿主（只开着主窗口）：一次退出退掉，清理一次
 *   QUIT-4 退出被一个窗口拒绝（设置窗口的 beforeunload 取消了关闭）：会话已关、宿主已封存、主窗口已关，
 *          进程还在；第二个实例把主窗口重新建出来 —— 会话照样读得出消息（宿主撤销了封存），主日志记下这件事
 */
import { afterEach, describe, expect, it } from 'vitest'
import { until } from '../../harness/cdp'
import { launchApp, spawnSecondInstance, type E2EApp } from '../../harness/launch'
import { startFakeProvider, type FakeProvider } from '../../harness/fakeProvider'
import { seedFakeProvider, waitRendererReady } from '../../harness/seed'

const MODEL = 'e2e-model'
/** 其余退出清理留在主日志里的两行（destroyAllTabs / mcpService.disconnectAll） */
const TEARDOWN_LINES = ['All browser tabs destroyed', 'disconnectAll:']
/** sessionHost.ts 的 resume() 撤销封存时记的一行 */
const RESUMED_LINE = '退出没有走完，应用继续运行'

interface ListedMessage {
  role: string
  content: string
}

/** 本条用例起的实例与假提供商（afterEach 收走：已经退掉的实例 stop 只清 HOME） */
let instances: E2EApp[] = []
let providers: FakeProvider[] = []

afterEach(async () => {
  for (const app of instances) await app.stop()
  for (const provider of providers) await provider.close()
  instances = []
  providers = []
})

async function launch(home?: string): Promise<E2EApp> {
  const app = await launchApp(home ? { home } : {})
  instances.push(app)
  await waitRendererReady(app.main)
  return app
}

/** 停掉（已经退掉的）实例、留着 HOME，用同一个 HOME 再起一个 —— afterEach 只收新的那个（连 HOME） */
async function relaunch(first: E2EApp): Promise<E2EApp> {
  await first.stop({ keepHome: true })
  instances = instances.filter((app) => app !== first)
  return launch(first.home)
}

async function fakeProvider(app: E2EApp): Promise<FakeProvider> {
  const provider = await startFakeProvider()
  providers.push(provider)
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  return provider
}

function createSession(app: E2EApp, title: string): Promise<string> {
  return app.main.eval<string>(
    `window.api.session.create(${JSON.stringify({ title })}).then((s) => s.id)`
  )
}

function listMessages(app: E2EApp, sid: string): Promise<ListedMessage[]> {
  return app.main.eval<ListedMessage[]>(`window.api.message.list(${JSON.stringify(sid)})`)
}

async function runStateOf(app: E2EApp, sid: string): Promise<string | undefined> {
  const sessions =
    await app.main.eval<Array<{ id: string; settings: { runState?: string } }>>(
      `window.api.session.list()`
    )
  return sessions.find((s) => s.id === sid)?.settings.runState
}

const brief = (m: ListedMessage): string => `${m.role}:${m.content}`

/** 主日志里含 `needle` 的行数 */
function countLines(app: E2EApp, needle: string): number {
  return app
    .mainLog()
    .split('\n')
    .filter((line) => line.includes(needle)).length
}

/** 一轮跑完的会话（宿主随之建出来） */
async function sessionWithAnswer(app: E2EApp, provider: FakeProvider): Promise<string> {
  const sid = await createSession(app, 'QUIT-answered')
  provider.script({ text: 'kept answer' })
  await app.main.eval(`window.api.agent.prompt(${JSON.stringify({ sessionId: sid, text: 'hi' })})`)
  expect((await listMessages(app, sid)).map(brief)).toEqual(['user:hi', 'assistant:kept answer'])
  return sid
}

describe('QUIT-1 one quit with an open session', () => {
  it('the process exits on its own, teardown runs once, and the next launch shows the messages', async () => {
    const first = await launch()
    const provider = await fakeProvider(first)
    const sid = await sessionWithAnswer(first, provider)

    const outcome = await first.quit()
    expect(outcome, first.output().slice(-2000)).toMatchObject({ exited: true, jsExited: true })
    for (const line of TEARDOWN_LINES) expect(countLines(first, line), line).toBe(1)
    expect(countLines(first, '没有全部关停')).toBe(0)

    const next = await relaunch(first)
    expect((await listMessages(next, sid)).map(brief)).toEqual(['user:hi', 'assistant:kept answer'])
    expect(await runStateOf(next, sid)).toBe('idle')
  }, 180_000)
})

describe('QUIT-2 one quit during a run', () => {
  it('the process exits on its own; the next launch reports the run interrupted with the user message kept', async () => {
    const first = await launch()
    const provider = await fakeProvider(first)
    const sid = await createSession(first, 'QUIT-busy')
    provider.script({ text: 'never finished', holdMs: 60_000 })
    // 不 await：prompt 要等整轮落定才回，而这一轮挂着
    await first.main.eval(
      `(window.api.agent.prompt(${JSON.stringify({ sessionId: sid, text: 'first' })}), true)`
    )
    await until(() => provider.holding(), 'turn holding')

    const outcome = await first.quit()
    expect(outcome, first.output().slice(-2000)).toMatchObject({ exited: true, jsExited: true })
    for (const line of TEARDOWN_LINES) expect(countLines(first, line), line).toBe(1)

    const next = await relaunch(first)
    expect(await runStateOf(next, sid)).toBe('interrupted')
    expect((await listMessages(next, sid)).map(brief)).toContain('user:first')
  }, 180_000)
})

describe('QUIT-3 one quit before any session was opened', () => {
  it('the process exits on its own and teardown runs once', async () => {
    const app = await launch()
    const outcome = await app.quit()
    expect(outcome, app.output().slice(-2000)).toMatchObject({ exited: true, jsExited: true })
    for (const line of TEARDOWN_LINES) expect(countLines(app, line), line).toBe(1)
  }, 120_000)
})

describe('QUIT-4 a quit a window refused', () => {
  it('sessions closed for the quit read back again once the main window is recreated', async () => {
    const app = await launch()
    const provider = await fakeProvider(app)
    const sid = await sessionWithAnswer(app, provider)

    // 设置窗口拒绝关闭：Electron 把 beforeunload 的取消当作「这次退出取消了」
    const settings = await app.openSettings()
    await settings.eval(`(window.addEventListener('beforeunload', (e) => {
      e.preventDefault()
      e.returnValue = false
    }), true)`)
    settings.close()

    const outcome = await app.quit({ timeoutMs: 6000 })
    expect(outcome.exited, app.output().slice(-2000)).toBe(false)
    // 会话已为退出关好、其余清理也跑过了，主窗口已关 —— 只剩设置窗口
    for (const line of TEARDOWN_LINES) expect(countLines(app, line), line).toBe(1)
    expect(await app.mainWindow()).toBeNull()

    // 第二个实例（再点一次应用图标；macOS 上点 Dock 走同一个 createWindow）把主窗口建回来
    const second = await spawnSecondInstance(app)
    expect(second.code).toBe(0)
    const main = await until(() => app.mainWindow(), 'main window recreated', 60_000)
    try {
      await until(
        async () =>
          (await main.eval<ListedMessage[]>(`window.api.message.list(${JSON.stringify(sid)})`))
            .length === 2,
        'messages readable again'
      )
      expect(
        (await main.eval<ListedMessage[]>(`window.api.message.list(${JSON.stringify(sid)})`)).map(
          brief
        )
      ).toEqual(['user:hi', 'assistant:kept answer'])
      expect(countLines(app, RESUMED_LINE)).toBe(1)
    } finally {
      main.close()
    }
  }, 180_000)
})
