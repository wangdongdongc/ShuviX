/**
 * macOS 的「用 ShuviX 打开」—— 文件不在 argv 里，只经 `open-file` 事件到（冷启动时早于 ready）；
 * 应用已在跑时再点 Dock / `open -a` 是 `activate`。只有经 LaunchServices 启动才走得到这两条路，
 * 直接 spawn 二进制（其余 spec 的做法）走不到。
 *
 * **默认跳过**，`SHUVIX_E2E_LAUNCHSERVICES=1` 且在 macOS 上才跑：LaunchServices 是全局的，
 * `open -a Electron.app` 找的是「那个在跑的 Electron.app」—— 机器上任何别的 com.github.Electron
 * 应用（另一个 worktree 的 e2e、别的 Electron 开发项目）都可能收到这些事件。beforeAll 先查一遍，
 * 有别的 Electron.app 在跑就直接失败，而不是去驱动别人的进程。
 *
 * 实例不是本进程的子进程（`open -n` 交给 LaunchServices 起），收尾按调试端口 pkill。
 * 隔离照旧：`--env` 给 fake HOME 与 userData，调试端口现借一个。
 *
 *   LS-1 冷启动 open-file（`open -n -a Electron.app a.md --args bootstrap …`）→ md 窗口，没有主窗口
 *   LS-2 已在跑时 open-file b.md → 第二个 md 窗口，仍没有主窗口
 *   LS-3 已在跑、md 窗口开着时不带文件的 `open -a` → 建出主窗口
 *   LS-4 已在跑时 open-file 一个 .txt → 忽略（日志里一行「忽略」），不开窗
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  isMainPage,
  isMarkdownWindowPage,
  listTargets,
  markdownWindowOf,
  sleep,
  until
} from '../../harness/cdp'
import { freePort } from '../../harness/launch'
import { logLines, userDir, type UserDir } from '../../harness/markdownFixtures'

const ENABLED = process.platform === 'darwin' && process.env.SHUVIX_E2E_LAUNCHSERVICES === '1'

const DESKTOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const ELECTRON_APP = resolve(DESKTOP_ROOT, '../../node_modules/electron/dist/Electron.app')
const BOOTSTRAP = join(DESKTOP_ROOT, 'e2e/harness/bootstrap.cjs')
/** 任何一个 Electron.app 进程（含别的项目的）—— LaunchServices 分不清它们 */
const ELECTRON_PROC = 'Electron.app/Contents/MacOS/Electron'
const SETTLE_MS = 2500

let files: UserDir
let home: string
let port: number
let aPath: string
let bPath: string
let txtPath: string

const mainLog = (): string => {
  const file = join(home, 'Library', 'Logs', 'Electron', 'main.log')
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

const markdownPaths = async (): Promise<string[]> =>
  (await listTargets(port).catch(() => []))
    .filter((t) => isMarkdownWindowPage(t))
    .map((t) => markdownWindowOf(t)?.path ?? '')
    .sort()

const mainCount = async (): Promise<number> =>
  (await listTargets(port).catch(() => [])).filter((t) => isMainPage(t)).length

/** `open` 交给 LaunchServices；它自己很快就返回，不等应用起来 */
function open(args: string[]): void {
  execFileSync('open', args, { stdio: 'ignore' })
}

describe.skipIf(!ENABLED)('LaunchServices（macOS open-file / activate）', () => {
  beforeAll(async () => {
    const others = spawnSync('pgrep', ['-fl', ELECTRON_PROC], { encoding: 'utf8' })
    if (others.stdout.trim()) {
      throw new Error(
        `another Electron.app is running — LaunchServices would route events to it:\n${others.stdout}`
      )
    }
    expect(existsSync(ELECTRON_APP)).toBe(true)
    files = userDir()
    aPath = files.file('a.md', '# A\n')
    bPath = files.file('b.md', '# B\n')
    txtPath = files.file('notes.txt', 'plain\n')
    home = mkdtempSync('/private/tmp/shuvix-e2e-ls-')
    mkdirSync(join(home, 'userdata'), { recursive: true })
    port = await freePort()
  })

  afterAll(async () => {
    if (port) spawnSync('pkill', ['-f', `remote-debugging-port=${port}`])
    // 等进程真的走完（userdata 在它手里）
    for (let i = 0; i < 50; i++) {
      const alive = spawnSync('pgrep', ['-f', `remote-debugging-port=${port}`]).status === 0
      if (!alive) break
      await sleep(100)
    }
    if (home) rmSync(home, { recursive: true, force: true })
    files?.remove()
  })

  it('LS-1 冷启动 open-file → md 窗口，没有主窗口', async () => {
    open([
      '-n',
      '-a',
      ELECTRON_APP,
      '--env',
      `HOME=${home}`,
      '--env',
      `SHUVIX_VERIFY_USERDATA=${join(home, 'userdata')}`,
      aPath,
      '--args',
      BOOTSTRAP,
      `--remote-debugging-port=${port}`,
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding'
    ])
    await until(
      async () => (await markdownPaths()).includes(aPath),
      'md window from a cold open-file',
      60_000
    )
    await sleep(SETTLE_MS)
    expect(await markdownPaths()).toEqual([aPath])
    expect(await mainCount()).toBe(0)
    expect(logLines(mainLog(), '不开主窗口')).toHaveLength(1)
  }, 90_000)

  it('LS-2 已在跑时 open-file b.md → 第二个 md 窗口，仍没有主窗口', async () => {
    open(['-a', ELECTRON_APP, bPath])
    await until(
      async () => (await markdownPaths()).includes(bPath),
      'second md window from a warm open-file'
    )
    await sleep(SETTLE_MS)
    expect(await markdownPaths()).toEqual([aPath, bPath].sort())
    expect(await mainCount()).toBe(0)
  })

  it('LS-4 已在跑时 open-file 一个 .txt → 忽略，不开窗', async () => {
    open(['-a', ELECTRON_APP, txtPath])
    await until(
      () => logLines(mainLog(), `忽略: ${txtPath}`).length === 1,
      'the .txt open-file ignored in the log'
    )
    await sleep(SETTLE_MS)
    expect(await markdownPaths()).toEqual([aPath, bPath].sort())
    expect(await mainCount()).toBe(0)
  })

  it('LS-3 md 窗口开着时不带文件的 open -a（activate）→ 建出主窗口', async () => {
    open(['-a', ELECTRON_APP])
    await until(async () => (await mainCount()) === 1, 'main window created on activate')
    await sleep(SETTLE_MS)
    expect(await mainCount()).toBe(1)
    expect(await markdownPaths()).toEqual([aPath, bPath].sort())
  })
})
