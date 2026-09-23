/**
 * 带着 md 冷启动 —— Windows / Linux 上「用 ShuviX 打开」一个 md 且应用还没在跑：文件在 argv 里。
 *
 * 契约：
 *   - 这次启动带来的 md（argv 里扩展名是 md、确实是个文件的那些）**至少一个**真开出了窗口 →
 *     只开 md 窗口，不开主窗口；一个都没开成（不存在、其实是目录、根本不是 md）→ 照常开主窗口，
 *     不能让用户面对一个没有窗口的应用；
 *   - 同一个文件的几种写法只开一个窗口；
 *   - 相对参数按**启动进程的工作目录**解析。
 *
 * 每条用例是一次独立的启动（argv 只在启动那一刻给）。「没有主窗口」按 CDP target 断：主窗口的
 * target 一个都没有，且留一段落定窗口再看一次（主窗口若要开，是在 md 窗口之后才开的）。
 *
 *   CS-1 一个 md → 恰一个 #markdown-window，没有主窗口；主进程日志有「不开主窗口」那一行
 *   CS-2 两个文件 + 其中一个的另一种写法 → 恰两个 md 窗口
 *   CS-3 argv 里只有不存在的 .md、一个 .txt、一个叫 x.md 的目录 → 主窗口照开，没有 md 窗口
 *   CS-4 相对参数按启动时的 cwd 解析
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { listTargets, isMainPage, sleep } from '../../harness/cdp'
import { launchApp, type E2EAppBase } from '../../harness/launch'
import { logLines, userDir, type UserDir } from '../../harness/markdownFixtures'

let files: UserDir
let app: E2EAppBase | null = null

/** 主窗口若要开，会在 md 窗口之后才出现：留这么久再下「没有」的结论 */
const SETTLE_MS = 2500

beforeAll(() => {
  files = userDir()
  files.file('a.md', '# A\n\nalpha\n')
  files.file('b.md', '# B\n\nbeta\n')
  files.file('notes.txt', 'plain\n')
  files.dir('x.md')
  files.file('sub/rel.md', '# Rel\n')
})

afterEach(async () => {
  await app?.stop()
  app = null
})

afterAll(() => {
  files.remove()
})

async function mainTargets(port: number): Promise<number> {
  return (await listTargets(port)).filter((t) => isMainPage(t)).length
}

describe('带着 md 冷启动', () => {
  it('CS-1 一个 md → 恰一个 md 窗口，没有主窗口；日志说不开主窗口', async () => {
    const a = join(files.root, 'a.md')
    app = await launchApp({ args: [a], expectMainWindow: false })
    await sleep(SETTLE_MS)

    const windows = await app.markdownWindows()
    expect(windows.map((w) => w.path)).toEqual([a])
    expect(await mainTargets(app.port)).toBe(0)
    expect(await app.mainWindow()).toBeNull()
    expect(logLines(app.mainLog(), '不开主窗口')).toHaveLength(1)
    expect(logLines(app.mainLog(), `打开 ${a} session=`)).toHaveLength(1)
  })

  it('CS-2 两个文件 + 其中一个的另一种写法 → 恰两个 md 窗口', async () => {
    const a = join(files.root, 'a.md')
    const b = join(files.root, 'b.md')
    app = await launchApp({
      args: [a, b, join(files.root, 'sub', '..', 'a.md')],
      expectMainWindow: false,
      markdownWindows: 2
    })
    await sleep(SETTLE_MS)

    const windows = await app.markdownWindows()
    expect(windows.map((w) => w.path).sort()).toEqual([a, b].sort())
    // 两个窗口两条会话
    expect(new Set(windows.map((w) => w.sessionId)).size).toBe(2)
    expect(await mainTargets(app.port)).toBe(0)
    expect(logLines(app.mainLog(), '从系统打开 2 个 md 文件')).toHaveLength(1)
  })

  it('CS-3 只有不存在的 .md / .txt / 叫 x.md 的目录 → 主窗口照开，没有 md 窗口', async () => {
    app = await launchApp({
      args: [
        join(files.root, 'missing.md'),
        join(files.root, 'notes.txt'),
        join(files.root, 'x.md')
      ]
    })
    await sleep(SETTLE_MS)

    expect(await app.markdownWindows()).toEqual([])
    expect(await mainTargets(app.port)).toBe(1)
    expect(logLines(app.mainLog(), '不开主窗口')).toEqual([])
    expect(logLines(app.mainLog(), '(MarkdownWindow)')).toEqual([])
  })

  it('CS-4 相对参数按启动进程的 cwd 解析', async () => {
    app = await launchApp({
      args: ['rel.md'],
      cwd: join(files.root, 'sub'),
      expectMainWindow: false
    })
    const windows = await app.markdownWindows()
    expect(windows.map((w) => w.path)).toEqual([join(files.root, 'sub', 'rel.md')])
    await sleep(SETTLE_MS)
    expect(await mainTargets(app.port)).toBe(0)
  })
})
