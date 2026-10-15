/**
 * 桌面应用与无头运行共用一份数据（docs/headless/design.md §1 Lifecycle）—— 同一个 HOME 上依次：桌面 → 无头 → 桌面。
 * 桌面开着时要无头的第二个实例说「先退出桌面应用」（退出码 1）、桌面也不弹窗；无头运行取设置里的端口，但不读局域网
 * 开关、不写任何设置；SIGINT 让它好好退出；之后的桌面应用一切照旧。
 *
 * HD-1 桌面启动：状态没有 headless 键、网络访问关着；存一个空闲端口 P（照旧不监听）；关着时也存下局域网开关
 * HD-2 关掉主窗口后，`--headless` / SHUVIX_HEADLESS=1 的第二个实例 → 退出码 1、那一行；主窗口没有被带回来
 * HD-3 留着一份过期的 headless.json（pid 已退出；或 pid 活着但不是锁的持有者）→ 照样说桌面在跑、退出码 1；不开窗
 * HD-4 同一个 HOME 上 `--help` → 0 + 用法；不开窗
 * HD-5 对照：不带参数的第二个实例 → 0、没有 `ShuviX headless:` 那种行、主窗口回来
 * HD-6 桌面退出后同一个 HOME 无头启动（环境变量、命令行不带 --port）：就绪那一行只有 127.0.0.1:P；状态端口 P、headless、
 *      lan false、绑 127.0.0.1；设置照旧（network.enabled 不是 'true'、network.port 'P'、network.lan 'true'）
 * HD-7 SIGINT → 进程自己退出；开始退出 / 退出完各恰一行；地址文件删掉
 * HD-8 再以桌面启动：网络访问关着、不监听、端口 P、lan true、没有 headless / bindAddress；没有地址文件
 */
import { spawn } from 'node:child_process'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { sleep, until } from '../../harness/cdp'
import {
  freePort,
  launchApp,
  runToExit,
  spawnSecondInstance,
  type E2EApp,
  type E2EAppBase,
  type E2EHeadlessApp
} from '../../harness/launch'
import { networkStatus, type NetworkStatus } from '../../harness/networkFixtures'
import { sqliteJson } from '../../harness/seed'
import { connectWs } from '../../harness/wsClient'

const DESKTOP_LINE =
  'ShuviX headless: the ShuviX desktop app is already running for this user; quit it first, then start ShuviX headless'
const SHUTTING_DOWN = 'ShuviX headless: shutting down'
const STOPPED = 'ShuviX headless: stopped'

let d: E2EApp | undefined
let h: E2EHeadlessApp | undefined
let d2: E2EApp | undefined
let home = ''
let P = 0

const countLine = (text: string, line: string): number =>
  text.split('\n').filter((l) => l.replace(/\r$/, '') === line).length

/** 此刻有没有主窗口（连得上就关掉，不留客户端） */
async function hasMainWindow(app: E2EAppBase): Promise<boolean> {
  const client = await app.mainWindow()
  client?.close()
  return client !== null
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** 一个已经退出的进程的 pid */
async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  const pid = child.pid!
  await new Promise<void>((resolveExit) => child.on('exit', () => resolveExit()))
  return pid
}

const networkSettings = (): Array<{ key: string; value: string }> =>
  sqliteJson<{ key: string; value: string }>(
    home,
    "select key, value from settings where key like 'network.%' order by key"
  )

afterAll(async () => {
  for (const app of [d2, h, d]) await app?.stop({ keepHome: true }).catch(() => undefined)
  if (home) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

describe('headless and the desktop app share one data directory', () => {
  it('HD-1 desktop launch: not headless, off; a saved free port and the LAN switch', async () => {
    d = await launchApp()
    home = d.home
    const initial = await networkStatus(d.main)
    expect('headless' in initial).toBe(false)
    expect(initial.enabled).toBe(false)
    P = await freePort()
    const saved = await d.main.eval<NetworkStatus>(`window.api.network.setPort(${P})`)
    expect(saved).toMatchObject({ enabled: false, port: P, listening: false })
    const lan = await d.main.eval<NetworkStatus>('window.api.network.setLan(true)')
    expect(lan).toMatchObject({ enabled: false, lan: true, listening: false })
    expect(networkSettings()).toEqual([
      { key: 'network.lan', value: 'true' },
      { key: 'network.port', value: String(P) }
    ])
  }, 120_000)

  it('HD-2 a headless second instance is told to quit the desktop app first; no window pops up', async () => {
    await d!.main.eval('(setTimeout(() => window.close(), 50), true)').catch(() => undefined)
    await until(async () => !(await hasMainWindow(d!)), 'the main window is closed', 20_000)

    for (const variant of [
      { what: '--headless', args: ['--headless'] },
      { what: 'SHUVIX_HEADLESS=1', env: { SHUVIX_HEADLESS: '1' } }
    ]) {
      const second = await spawnSecondInstance(d!, variant)
      expect(second.code, `${variant.what}\n${second.output.slice(-1500)}`).toBe(1)
      expect(countLine(second.stdout, DESKTOP_LINE), variant.what).toBe(1)
      await sleep(2000)
      expect(await hasMainWindow(d!), variant.what).toBe(false)
    }
  }, 120_000)

  it('HD-3 a stale headless.json does not fool the second instance', async () => {
    const file = join(d!.userData, 'headless.json')
    try {
      const stale = [
        { pid: await exitedPid(), port: 1, urls: ['http://127.0.0.1:1'] },
        // 活着、但不是单实例锁的持有者（vitest 自己的进程）
        { pid: process.pid, urls: ['http://127.0.0.1:1'] }
      ]
      for (const address of stale) {
        writeFileSync(file, `${JSON.stringify(address)}\n`)
        const second = await spawnSecondInstance(d!, { args: ['--headless'] })
        expect(second.code, `${JSON.stringify(address)}\n${second.output.slice(-1500)}`).toBe(1)
        expect(countLine(second.stdout, DESKTOP_LINE)).toBe(1)
        expect(second.stdout).not.toContain('ShuviX headless: already running')
      }
      expect(await hasMainWindow(d!)).toBe(false)
    } finally {
      rmSync(file, { force: true })
    }
  }, 120_000)

  it('HD-4 --help on the same HOME prints the usage; no window appears', async () => {
    const result = await runToExit({ home, args: ['--help'] })
    expect(result.code, result.output.slice(-1500)).toBe(0)
    expect(result.stdout).toContain('Usage: shuvix --headless [--port <n>] [--lan]')
    await sleep(1500)
    expect(await hasMainWindow(d!)).toBe(false)
  }, 90_000)

  it('HD-5 control: a plain second instance brings the main window back', async () => {
    const second = await spawnSecondInstance(d!)
    expect(second.code, second.output.slice(-1500)).toBe(0)
    expect(second.stdout).not.toContain('ShuviX headless:')
    await until(() => hasMainWindow(d!), 'the main window comes back', 60_000)
  }, 90_000)

  it('HD-6 headless on the same HOME takes the saved port, not the LAN switch, and writes nothing', async () => {
    await d!.stop({ keepHome: true })
    d = undefined
    h = await launchApp({ home, headless: true, viaEnv: true, networkPort: 'setting' })
    expect(h.networkPort).toBe(P)
    expect(h.urls).toStrictEqual([`http://127.0.0.1:${P}/`])
    const ws = await connectWs(P)
    try {
      const s = await ws.invoke<NetworkStatus>('network:status')
      expect(s).toMatchObject({
        port: P,
        headless: true,
        lan: false,
        bindAddress: '127.0.0.1',
        listening: true
      })
    } finally {
      ws.close()
    }
    const saved = networkSettings()
    expect(saved.find((r) => r.key === 'network.enabled')?.value).not.toBe('true')
    expect(saved.find((r) => r.key === 'network.port')?.value).toBe(String(P))
    expect(saved.find((r) => r.key === 'network.lan')?.value).toBe('true')
  }, 120_000)

  it('HD-7 SIGINT quits it gracefully', async () => {
    process.kill(h!.pid, 'SIGINT')
    await until(() => !alive(h!.pid), 'the headless instance is gone after SIGINT', 45_000)
    const stdout = h!.stdout()
    expect(countLine(stdout, SHUTTING_DOWN), stdout.slice(-1500)).toBe(1)
    expect(countLine(stdout, STOPPED)).toBe(1)
    expect(stdout.indexOf(SHUTTING_DOWN)).toBeLessThan(stdout.indexOf(STOPPED))
    expect(existsSync(join(h!.userData, 'headless.json'))).toBe(false)
    await h!.stop({ keepHome: true })
    h = undefined
  }, 90_000)

  it('HD-8 the desktop app afterwards: off, the saved port and LAN switch, not headless', async () => {
    d2 = await launchApp({ home })
    const s = await networkStatus(d2.main)
    expect(s).toMatchObject({ enabled: false, listening: false, port: P, lan: true })
    expect('headless' in s).toBe(false)
    expect('bindAddress' in s).toBe(false)
    expect(existsSync(join(d2.userData, 'headless.json'))).toBe(false)
    await d2.stop({ keepHome: true })
    d2 = undefined
  }, 120_000)
})
