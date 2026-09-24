/**
 * 应用已在跑时再「用 ShuviX 打开」—— Windows / Linux 上文件经**第二个实例**的 argv 到达：它拿不到
 * 单实例锁，把 argv 与 cwd 交给第一个实例（`second-instance` 事件）然后退出。
 *
 * 契约：
 *   - 带 md 的第二个实例：第一个实例开那个 md 的窗口（相对参数按**第二个实例**的 cwd 解析），
 *     第二个实例自己退出、不开任何窗口；
 *   - 同一个文件换一种写法再来：还是那一个窗口（聚焦它），不建第二条会话；
 *   - 什么都不带的第二个实例（再点一次应用图标）= 要主窗口：从 md 启动的实例此刻才建主窗口，
 *     建出来是好用的；主窗口已开着就不再建第二个；关掉之后再来一次会重建；
 *   - 共享的窗口服务只装配一次（主窗口晚于 md 窗口出现时不再重复装配）。
 *
 * 一个实例跑完全部用例（带着 a.md 冷启动，没有主窗口），顺序即剧情。第二个实例与第一个共用
 * HOME / userData，所以它的日志也写进同一份 main.log —— 「只有一行打开」同时证明了第二个实例
 * 自己没去开窗。
 *
 *   SI-1 第二个实例带相对的 md 参数 → 退出码 0；第一个实例按第二个实例的 cwd 开出那个 md 窗口；没有主窗口
 *   SI-2 同一个文件换一种写法再来 → 仍一个窗口，「打开」那一行仍只有一条
 *   SI-3 从 md 冷启动之后，不带文件的第二个实例 → 主窗口建出来、好用；日志里没有重复注册的错误
 *   SI-4 主窗口开着时再来一个不带文件的 → 不建第二个主窗口；关掉主窗口后再来一个 → 重建
 *   SI-5 主窗口关掉之后再打开一个 md → 窗口照常开出来，主进程没有未捕获的异常
 *        （回归：md 窗口的 window-ready 碰了已销毁主窗口的 webContents → "Object has been destroyed"）
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isMainPage, listTargets, sleep, until, type CdpClient } from '../../harness/cdp'
import { launchApp, spawnSecondInstance, type E2EMarkdownApp } from '../../harness/launch'
import { logLines, userDir, type UserDir } from '../../harness/markdownFixtures'
import { sidebarPane } from '../../harness/pages'
import { waitRendererReady } from '../../harness/seed'

let app: E2EMarkdownApp
let files: UserDir
let aPath: string
let bPath: string

/** 该出现的窗口若要出现，这段时间足够了（「没有」的结论等它过去再下） */
const SETTLE_MS = 2500

beforeAll(async () => {
  files = userDir()
  aPath = files.file('a.md', '# A\n')
  bPath = files.file('sub/b.md', '# B\n')
  app = await launchApp({ args: [aPath], expectMainWindow: false })
}, 180_000)

afterAll(async () => {
  await app?.stop()
  files?.remove()
})

async function mainTargets(): Promise<Array<{ webSocketDebuggerUrl: string }>> {
  return (await listTargets(app.port)).filter((t) => isMainPage(t))
}

/** 主进程未捕获的异常（bootstrap.cjs 把它们记进这个文件，而不是弹原生框） */
function uncaughtExceptions(): string {
  const file = join(app.home, 'userdata', 'e2e-uncaught.log')
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

/** 主进程日志与实例输出里「重复注册 IPC 处理函数」一类的错误 */
function doubleRegistrationErrors(): string[] {
  const text = `${app.mainLog()}\n${app.output()}`
  return text.split('\n').filter((l) => /second handler|already registered/i.test(l))
}

describe('第二个实例带着 md', () => {
  it('SI-1 相对参数按第二个实例的 cwd 解析，第一个实例开出窗口；第二个实例退出、不开主窗口', async () => {
    const result = await spawnSecondInstance(app, { args: ['b.md'], cwd: join(files.root, 'sub') })
    expect(result.code).toBe(0)

    await until(
      async () => (await app.markdownWindows()).some((w) => w.path === bPath),
      'b.md window opened by the first instance'
    )
    await sleep(SETTLE_MS)
    expect((await app.markdownWindows()).map((w) => w.path).sort()).toEqual([aPath, bPath].sort())
    expect(await mainTargets()).toEqual([])
    expect(logLines(app.mainLog(), `打开 ${bPath} session=`)).toHaveLength(1)
  })

  it('SI-2 同一个文件换一种写法再来 → 仍一个窗口、仍只有一行打开', async () => {
    const sessionBefore = (await app.markdownWindows()).find((w) => w.path === bPath)!.sessionId
    const result = await spawnSecondInstance(app, {
      args: [join(files.root, 'sub', '..', 'sub', 'b.md')]
    })
    expect(result.code).toBe(0)
    await sleep(SETTLE_MS)

    const windows = await app.markdownWindows()
    expect(windows.filter((w) => w.path === bPath)).toHaveLength(1)
    expect(windows.find((w) => w.path === bPath)!.sessionId).toBe(sessionBefore)
    expect(logLines(app.mainLog(), `打开 ${bPath} session=`)).toHaveLength(1)
    expect(await mainTargets()).toEqual([])
  })
})

describe('第二个实例什么都不带 = 要主窗口', () => {
  it('SI-3 从 md 冷启动之后：主窗口此刻才建出来，好用；共享窗口服务没被重复装配', async () => {
    expect(await mainTargets()).toEqual([])
    const result = await spawnSecondInstance(app)
    expect(result.code).toBe(0)

    const main = await until(() => app.mainWindow(), 'main window created on demand')
    try {
      await waitRendererReady(main)
      // 好用：IPC 通、侧栏能列出新建的会话
      await main.eval(`window.api.session.create({ title: 'si3-control' })`)
      await until(
        () =>
          sidebarPane(main)
            .titles()
            .then((t) => t.includes('si3-control')),
        'sidebar lists a session created in the new main window'
      )
    } finally {
      main.close()
    }
    // md 窗口不受影响
    expect((await app.markdownWindows()).map((w) => w.path).sort()).toEqual([aPath, bPath].sort())
    expect(doubleRegistrationErrors()).toEqual([])
  })

  it('SI-4 主窗口开着时再来一个 → 不建第二个；关掉之后再来一个 → 重建', async () => {
    const before = await mainTargets()
    expect(before).toHaveLength(1)

    expect((await spawnSecondInstance(app)).code).toBe(0)
    await sleep(SETTLE_MS)
    const after = await mainTargets()
    expect(after).toHaveLength(1)
    expect(after[0].webSocketDebuggerUrl).toBe(before[0].webSocketDebuggerUrl)

    // 关掉主窗口（用户点关闭）：md 窗口都还在
    const main: CdpClient | null = await app.mainWindow()
    expect(main).not.toBeNull()
    await main!.eval('window.close()').catch(() => undefined)
    main!.close()
    await until(async () => (await mainTargets()).length === 0, 'main window closed')
    expect((await app.markdownWindows()).map((w) => w.path).sort()).toEqual([aPath, bPath].sort())

    expect((await spawnSecondInstance(app)).code).toBe(0)
    const again = await until(() => app.mainWindow(), 'main window recreated')
    try {
      await waitRendererReady(again)
      // 好用：IPC 通（能列出上一个主窗口里建的那条会话）
      const titles = await again.eval<string[]>(
        `window.api.session.list().then((ss) => ss.map((s) => s.title))`
      )
      expect(titles).toContain('si3-control')
    } finally {
      again.close()
    }
    expect(await mainTargets()).toHaveLength(1)
    expect(doubleRegistrationErrors()).toEqual([])
  })

  it('SI-5 主窗口关掉之后再打开一个 md → 窗口开出来，主进程没有未捕获的异常', async () => {
    const cPath = files.file('c.md', '# C\n')
    const main = await app.mainWindow()
    expect(main).not.toBeNull()
    await main!.eval('window.close()').catch(() => undefined)
    main!.close()
    await until(async () => (await mainTargets()).length === 0, 'main window closed')

    expect((await spawnSecondInstance(app, { args: [cPath] })).code).toBe(0)
    await until(
      async () => (await app.markdownWindows()).some((w) => w.path === cPath),
      'c.md window opened after the main window was closed'
    )
    // 渲染端挂载完才发 window-ready：等它过去再下「没有异常」的结论
    await sleep(SETTLE_MS)
    expect(uncaughtExceptions()).toBe('')
    expect(await mainTargets()).toEqual([])
  })
})
