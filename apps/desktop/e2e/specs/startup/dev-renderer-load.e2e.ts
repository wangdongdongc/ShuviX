/**
 * 开发态加载渲染端（`utils/rendererPage.ts` 的 loadRendererPage）—— 真 Chromium 上的那一半。
 *
 * e2e 实例不是打包产物（is.dev 为真），给它 `ELECTRON_RENDERER_URL` 就走开发态的 http 加载；地址指向
 * spec 进程里的 `startRendererServer`（把本 checkout 的 out/renderer 当 dev server），由它决定
 * index.html 那一次请求是挂住、掐断还是照常给。单测（rendererPage.test.ts）用假窗口把计时、上限、
 * 关窗都钉死了；这里要看的是只有真浏览器才回答得了的几件事：
 *  - 一次**既不成功也不报错**的加载（请求收下了、永不回应）真的会在 5 秒后被重发，窗口最后出来；
 *  - 拿到页面之后（真 Chromium 的 did-navigate）计时器真的停了，不再有请求、不再有 warn；
 *  - 一次**明确失败**的加载（连接被掐）报出的是负的错误码、带地址，1 秒后重发能走通；
 *  - 一直失败：重发 10 次就收手，之后服务器再也收不到请求。
 *
 * 注意事项：
 *  - **不数「挂住」warn 的确切条数**：在这台 macOS 虚拟机上，第一次建窗卡在 GPU 初始化里约 15 秒，
 *    之后网络服务崩溃重启，正赶上的那次加载会自己挂住（请求根本没到服务器）—— 可能多一条。
 *  - `launchApp` 返回**不等于**页面加载好了：它认 target 看的是地址，等的是 `window.api`。加载还挂着时
 *    target 的地址就已经是 dev 地址（Chromium 报的是待提交的那个），而 preload 在窗口最初那个空文档里
 *    也会跑 —— 实测一个请求都还没到服务器，launchApp 就返回了；失败后的错误页同理（地址是失败的那个）。
 *    一律等「mainWindow visible」那一行与 `waitRendererReady`，也不拿「launchApp 返回了」当轮询的终点。
 *  - 请求挂着时 CDP 的 Runtime.evaluate 会卡上好几秒；harness 的 until 上限够用。
 *  - 要在 launchApp 还没返回时读主进程日志（E-2 / E-4），所以那两组先自己建 fake HOME 再 `launchApp({ home })`
 *    —— 日志落在 HOME 里，路径事先就知道。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sleep, until } from '../../harness/cdp'
import { launchApp, uncaughtExceptions, type E2EApp } from '../../harness/launch'
import { startRendererServer, type RendererServer } from '../../harness/rendererServer'
import { waitRendererReady } from '../../harness/seed'

const LAUNCH_TIMEOUT = 120_000
const VISIBLE = 'mainWindow visible (window-ready)'
const HANG = 'page did not start loading within 5000ms: '
const FAIL_RE = /page load failed \((-?\d+) ([^)]*)\): (\S+)/
const GIVE_UP = 'page still not loaded after 10 retries: '

const count = (text: string, needle: string): number => text.split(needle).length - 1

/** fake HOME 的父目录：与 launch.ts 同一条（短路径，cli.sock 有路径长度上限） */
const tmpBase = (): string => (existsSync('/private/tmp') ? '/private/tmp' : tmpdir())

/** 实例还在启动时就读它的主进程日志（与 launch.ts 的 mainLog 同两个候选位置） */
function mainLogIn(home: string): string {
  const file = [
    join(home, 'Library', 'Logs', 'Electron', 'main.log'),
    join(home, 'userdata', 'logs', 'main.log')
  ].find((f) => existsSync(f))
  return file ? readFileSync(file, 'utf8') : ''
}

/** 主进程没有未处理的拒绝：Node 的那行警告，或 Electron loadURL 拒绝的原文（`… loading '<url>'`） */
function expectNoUnhandledRejection(app: E2EApp, url: string): void {
  const out = app.output()
  expect(out).not.toMatch(/UnhandledPromiseRejection|Unhandled promise rejection/i)
  expect(out).not.toContain(`loading '${url}`)
}

/**
 * 一次还没返回的 launchApp。它失败了就别再等日志（失败时它会杀掉实例）；它**成功**返回却不是终点
 * （见文件头：页面可能还一次都没加载成）。
 */
function track<T>(promise: Promise<T>): {
  failed: () => Error | null
  outcome: Promise<T | Error>
} {
  let error: Error | null = null
  const outcome = promise.then(
    (value) => value,
    (err: unknown) => (error = err instanceof Error ? err : new Error(String(err)))
  )
  return { failed: () => error, outcome }
}

describe('E-1 a load that never starts is re-issued (dev renderer)', () => {
  let server: RendererServer
  let app: E2EApp

  beforeAll(async () => {
    // 第一次 index.html 请求收下、永不回应；之后的照常给
    server = await startRendererServer((nth) => (nth === 1 ? 'hold' : 'serve'))
    app = await launchApp({ env: { ELECTRON_RENDERER_URL: server.url } })
    await waitRendererReady(app.main)
    await until(() => app.mainLog().includes(VISIBLE), 'main window shown (window-ready)')
  }, LAUNCH_TIMEOUT)

  afterAll(async () => {
    await app?.stop()
    await server?.close()
  })

  it('E-1 the held load is re-issued after 5 s and the main window comes up', () => {
    const log = app.mainLog()
    const hangAt = log.indexOf(HANG + server.url)
    expect(hangAt, 'a "did not start loading" warning for the dev URL').toBeGreaterThanOrEqual(0)
    expect(log.indexOf(VISIBLE)).toBeGreaterThan(hangAt)
    expect(log).not.toContain(GIVE_UP)

    // 服务器这一侧：第一次被挂住，之后又来了一次、照常给了
    const index = server.indexRequests()
    expect(index[0]?.outcome).toBe('held')
    expect(index.slice(1).some((r) => r.outcome === 'served')).toBe(true)

    expect(uncaughtExceptions(app)).toBe('')
    expectNoUnhandledRejection(app, server.url)
  })

  it('E-1b once the page has committed nothing is re-issued any more', async () => {
    const failures = (): number =>
      (app.mainLog().match(new RegExp(FAIL_RE.source, 'g')) ?? []).length
    const requests = server.indexRequests().length
    const hangs = count(app.mainLog(), HANG)
    const fails = failures()
    // 比挂住计时器（5 秒）再多等一会儿：真 Chromium 的 did-navigate 没把它停掉的话，这里会多一次请求
    await sleep(6500)
    expect(server.indexRequests().length).toBe(requests)
    expect(count(app.mainLog(), HANG)).toBe(hangs)
    expect(failures()).toBe(fails)
  })

  it('E-3 the settings window loads from the dev server under #settings', async () => {
    const before = server.indexRequests().length
    const settings = await app.openSettings()
    try {
      await until(() => settings.eval<boolean>('!!window.api'), 'settings window.api')
      const href = await settings.eval<string>('location.href')
      expect(href.startsWith(`${server.url}#settings`), href).toBe(true)
      expect(
        server
          .indexRequests()
          .slice(before)
          .some((r) => r.outcome === 'served')
      ).toBe(true)
    } finally {
      settings.close()
    }
  })
})

describe('E-2 a load that fails is re-issued after a second (dev renderer)', () => {
  let server: RendererServer
  let home: string
  let app: E2EApp | undefined

  beforeAll(async () => {
    server = await startRendererServer('drop')
    home = mkdtempSync(join(tmpBase(), 'shuvix-e2e-'))
    const launch = track(launchApp({ home, env: { ELECTRON_RENDERER_URL: server.url } }))
    // 一直掐，直到产品把那次失败记下来；之后照常给（不让服务器自己「第一次掐、之后给」：
    // Chromium 若自己重试了被掐的请求，那次失败就根本不会到产品这里）
    await until(
      () => launch.failed() !== null || FAIL_RE.test(mainLogIn(home)),
      'first renderer load failure in the main log',
      90_000
    )
    server.setIndexPolicy('serve')
    const launched = await launch.outcome
    if (launched instanceof Error) throw launched
    app = launched
    await waitRendererReady(app.main)
    await until(() => app!.mainLog().includes(VISIBLE), 'main window shown (window-ready)')
  }, 150_000)

  afterAll(async () => {
    if (app) await app.stop()
    else if (home) rmSync(home, { recursive: true, force: true })
    await server?.close()
  })

  it('E-2 the failure is logged with a negative error code and the URL, then the page loads', () => {
    const log = app!.mainLog()
    const m = FAIL_RE.exec(log)
    expect(m, 'a "page load failed" line').not.toBeNull()
    const code = Number(m![1])
    expect(code).toBeLessThan(0)
    expect(code).not.toBe(-3)
    expect(m![2]).not.toBe('')
    expect(m![3]).toBe(server.url)
    expect(log.indexOf(VISIBLE)).toBeGreaterThan(m!.index)
    expect(log).not.toContain(GIVE_UP)

    // 服务器这一侧：先被掐过，之后又来、照常给了
    const index = server.indexRequests()
    const firstDropped = index.findIndex((r) => r.outcome === 'dropped')
    expect(firstDropped).toBeGreaterThanOrEqual(0)
    expect(index.slice(firstDropped + 1).some((r) => r.outcome === 'served')).toBe(true)

    expect(uncaughtExceptions(app!)).toBe('')
    expectNoUnhandledRejection(app!, server.url)
  })
})

describe('E-4 a dev server that keeps failing: ten re-issues, then it gives up', () => {
  let server: RendererServer
  let home: string
  let app: E2EApp | undefined

  afterAll(async () => {
    if (app) await app.stop()
    if (home) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    await server?.close()
  })

  it('E-4 eleven loads in all, one error line, and no request after it', async () => {
    server = await startRendererServer('drop')
    home = mkdtempSync(join(tmpBase(), 'shuvix-e2e-'))
    // 页面永远拿不到。launchApp 多半照样返回（见文件头）；万一它等不到 window.api 失败了，它会杀掉实例
    const launch = track(launchApp({ home, env: { ELECTRON_RENDERER_URL: server.url } }))
    void launch.outcome.then((v) => {
      if (!(v instanceof Error)) app = v
    })
    await until(
      () => launch.failed() !== null || mainLogIn(home).includes(GIVE_UP),
      'the give-up line in the main log',
      100_000
    )
    expect(launch.failed()?.message ?? '', 'launchApp failed before the product gave up').toBe('')

    const log = mainLogIn(home)
    expect(count(log, GIVE_UP + server.url)).toBe(1)
    // 每一次加载都以一条「挂住」或「失败」收场：第一次 + 10 次重发 = 11 条
    const hangs = count(log, HANG + server.url)
    const fails = (log.match(new RegExp(FAIL_RE.source, 'g')) ?? []).length
    expect(hangs + fails).toBe(11)

    // 服务器这一侧：到达的 index.html 都被掐了，每一次失败背后至少有一个请求
    const requests = server.indexRequests()
    expect(requests.every((r) => r.outcome === 'dropped')).toBe(true)
    expect(requests.length).toBeGreaterThanOrEqual(fails)

    // 收手之后再没有请求（失败后的重发间隔是 1 秒、挂住是 5 秒，多看一会儿）
    await sleep(6000)
    expect(launch.failed(), 'instance still alive through the quiet window').toBeNull()
    expect(server.indexRequests().length).toBe(requests.length)
    const after = mainLogIn(home)
    expect(count(after, HANG) + (after.match(new RegExp(FAIL_RE.source, 'g')) ?? []).length).toBe(
      11
    )
    expect(count(after, GIVE_UP)).toBe(1)
    // 实例收在 afterAll：launchApp 返回了就 stop；它失败了的话实例已经被它杀掉
    await launch.outcome
  }, 180_000)
})
