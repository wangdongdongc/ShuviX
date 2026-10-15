/**
 * 无头运行（`shuvix --headless`，docs/headless/design.md §1）—— 一个缺省（不带 --lan）的无头实例，从外面看：stdout 的几行、
 * CDP 上没有任何页面、网络访问（Node 侧 WebSocket + 原始 HTTP）、地址文件、第二个实例、CLI、最后退出。用例按顺序跑，
 * 退出在最后。
 *
 * HE-1  就绪那一行恰是 `… open one of: http://127.0.0.1:<P>/`（缺省只给这台电脑），恰出现一次
 * HE-2  没有窗口：页面 target 一个都没有（启动时的主窗口、命令行上的 md 都没开），过一会儿也没有
 * HE-3  GET / → web 客户端
 * HE-4  network:status：开着、端口 P、lan false、绑 127.0.0.1、在监听、headless、没有 error、地址只有 127.0.0.1、客户端里有
 *       一个来自 127.0.0.1
 * HE-4b 本机每个私有 IPv4 地址上连不上（ECONNREFUSED）
 * HE-5  设置没被写：network.enabled / network.port 都读不到
 * HE-6  headless.json 恰是 {pid, port, urls: status.addresses}
 * HE-7  拒绝：关掉（code 'headless'，连接与服务照旧）、开（ok）、同一个端口（ok）、换端口（code 'headless'，新端口上没人）、
 *       不合法的端口（那句话、不是 headless）
 * HE-7e setLan：true → code 'headless'；false → ok；'x' → 'lan must be a boolean'；照旧绑 127.0.0.1
 * HE-8  经 settings:set 写 network.* → 无头实例不理：连接开着、照旧在 P、新端口上没人、照旧 127.0.0.1
 * HE-9  scripts/headless-smoke.mjs --expect-local 全部通过；之后没有它建的会话，照旧在监听
 * HE-9b smoke --expect-lan 对这个实例 → 退出码 1、那一行 FAIL
 * HE-11 CLI 的 `shuvix widget open demo` → 退出码 1，说无头不开窗；照旧没有页面
 * HE-12 第二个实例（带 / 不带 --headless、环境变量、另一个 --port、带一个 md）→ 退出码 0、打印这个实例的地址；不开窗、
 *       照旧在监听；另一个端口上没人
 * HE-13 地址文件还没有地址时第二个实例说「还在启动」（退出码 0）；地址文件原样还回去
 * HE-14 同一个 HOME 上 `--help` → 退出码 0、用法、不说「已经在跑」；实例照旧服务、照旧没有页面
 * HE-15 主进程没有未捕获的异常
 * HE-16 （最后）退出：进程自己退出、退出码 0；开始退出 / 退出完各恰一行且先后对；连着的客户端 1001；地址文件删掉；端口放开
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { listTargets, sleep } from '../../harness/cdp'
import {
  freePort,
  launchApp,
  runCli,
  runToExit,
  spawnSecondInstance,
  uncaughtExceptions,
  type E2EHeadlessApp
} from '../../harness/launch'
import { userDir, type UserDir } from '../../harness/markdownFixtures'
import { httpProbe, privateIPv4Addresses, type NetworkStatus } from '../../harness/networkFixtures'
import { connectWs, type WsClient } from '../../harness/wsClient'

const DESKTOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const REPO_ROOT = resolve(DESKTOP_ROOT, '../..')
const SMOKE = join(REPO_ROOT, 'scripts', 'headless-smoke.mjs')
const PORT_INVALID = 'The port must be an integer between 1024 and 65535.'
const SHUTTING_DOWN = 'ShuviX headless: shutting down'
const STOPPED = 'ShuviX headless: stopped'

let app: E2EHeadlessApp
let md: UserDir
let notes = ''
let ws: WsClient | undefined
let P = 0
let other = 0

/** 整行恰等于 `line` 的次数 */
const countLine = (text: string, line: string): number =>
  text.split('\n').filter((l) => l.replace(/\r$/, '') === line).length

const pageTargets = async (): Promise<string[]> =>
  (await listTargets(app.port)).filter((t) => t.type === 'page').map((t) => t.url)

const status = (): Promise<NetworkStatus> => ws!.invoke<NetworkStatus>('network:status')

const alreadyRunning = (): string =>
  `ShuviX headless: already running — open one of: http://127.0.0.1:${P}/`

/** 跑一次 smoke 客户端（node），回退出码与 stdout 的非空行 */
function runSmoke(args: string[]): Promise<{ code: number | null; lines: string[] }> {
  const child = spawn(process.execPath, [SMOKE, ...args], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let out = ''
  child.stdout.on('data', (c: Buffer) => (out += c.toString()))
  child.stderr.on('data', (c: Buffer) => (out += c.toString()))
  return new Promise((resolveRun, rejectRun) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      rejectRun(new Error(`headless-smoke did not exit within 120 s\n${out.slice(-2000)}`))
    }, 120_000)
    child.on('error', (err) => {
      clearTimeout(timer)
      rejectRun(err)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolveRun({ code, lines: out.split('\n').filter((l) => l.trim().length > 0) })
    })
  })
}

beforeAll(async () => {
  md = userDir('shuvix-headless-md-')
  notes = md.file('notes.md', '# hi\n')
  app = await launchApp({
    headless: true,
    args: ['--disable-gpu', '--ozone-platform=headless', notes]
  })
  P = app.networkPort
  ws = await connectWs(P)
  do {
    other = await freePort()
  } while (other === P)
})

afterAll(async () => {
  ws?.close()
  await app?.stop()
  md?.remove()
})

describe('headless: a default instance (this computer only)', () => {
  it('HE-1 the ready line lists 127.0.0.1 only, exactly once', () => {
    const url = `http://127.0.0.1:${P}/`
    expect(app.readyLine).toBe(`ShuviX headless: ready — open one of: ${url}`)
    expect(app.urls).toStrictEqual([url])
    expect(countLine(app.stdout(), app.readyLine)).toBe(1)
  })

  it('HE-2 no window at all: not at startup, not for the md file on the command line', async () => {
    expect(await pageTargets()).toStrictEqual([])
    await sleep(1500)
    expect(await pageTargets()).toStrictEqual([])
    expect(await app.mainWindow()).toBeNull()
    expect(await app.markdownWindows()).toStrictEqual([])
  })

  it('HE-3 GET / serves the web client', async () => {
    const page = await httpProbe({ port: P })
    expect(page.status).toBe(200)
    expect(String(page.headers?.['content-type'])).toMatch(/^text\/html/)
    expect(page.body?.toString('utf8')).toContain('<div id="root">')
  })

  it('HE-4 network:status: forced on, 127.0.0.1 only, headless', async () => {
    const s = await status()
    expect(s).toMatchObject({
      enabled: true,
      port: P,
      lan: false,
      bindAddress: '127.0.0.1',
      listening: true,
      headless: true
    })
    expect('error' in s).toBe(false)
    expect(s.addresses).toStrictEqual([`http://127.0.0.1:${P}`])
    expect(s.clients.some((c) => c.remoteAddress === '127.0.0.1')).toBe(true)
  })

  it('HE-4b the private addresses of this machine refuse', async (ctx) => {
    const ips = privateIPv4Addresses()
    if (ips.length === 0) ctx.skip()
    for (const ip of ips) {
      expect(await httpProbe({ port: P, connectHost: ip, host: `${ip}:${P}` }), ip).toMatchObject({
        error: 'ECONNREFUSED'
      })
    }
  })

  it('HE-5 the network settings were not written', async () => {
    for (const key of ['network.enabled', 'network.port', 'network.lan']) {
      const frame = await ws!.invokeRaw('settings:get', [key])
      expect(frame.ok, key).toBe(true)
      expect(frame.value ?? null, key).toBeNull()
    }
  })

  it('HE-6 headless.json carries the pid, the port and the advertised addresses', async () => {
    const s = await status()
    const address = JSON.parse(readFileSync(join(app.userData, 'headless.json'), 'utf8')) as unknown
    expect(address).toStrictEqual({ pid: app.pid, port: P, urls: s.addresses })
    expect(s.addresses).toStrictEqual([`http://127.0.0.1:${P}`])
  })

  it('HE-7 switching off and moving the port are refused (code headless); valid no-ops pass', async () => {
    const off = await ws!.invokeRaw('network:setEnabled', [false])
    expect(off.ok).toBe(false)
    expect(off.error?.code).toBe('headless')
    expect(ws!.isOpen()).toBe(true)
    expect((await status()).listening).toBe(true)
    expect((await httpProbe({ port: P })).status).toBe(200)

    const on = await ws!.invokeRaw('network:setEnabled', [true])
    expect(on.ok).toBe(true)
    expect((on.value as NetworkStatus).headless).toBe(true)

    const same = await ws!.invokeRaw('network:setPort', [P])
    expect(same.ok).toBe(true)
    const moved = await ws!.invokeRaw('network:setPort', [other])
    expect(moved.ok).toBe(false)
    expect(moved.error?.code).toBe('headless')
    expect(await httpProbe({ port: other })).toMatchObject({ error: 'ECONNREFUSED' })
    expect(await status()).toMatchObject({ port: P, listening: true })

    const invalid = await ws!.invokeRaw('network:setPort', [1023])
    expect(invalid.ok).toBe(false)
    expect(invalid.error?.message).toBe(PORT_INVALID)
    expect(invalid.error?.code).not.toBe('headless')
    expect(ws!.isOpen()).toBe(true)
  })

  it('HE-7e setLan: the other value is refused, the same value passes, a non-boolean is invalid', async () => {
    const lan = await ws!.invokeRaw('network:setLan', [true])
    expect(lan.ok).toBe(false)
    expect(lan.error?.code).toBe('headless')
    const local = await ws!.invokeRaw('network:setLan', [false])
    expect(local.ok).toBe(true)
    expect((local.value as NetworkStatus).lan).toBe(false)
    const bad = await ws!.invokeRaw('network:setLan', ['x'])
    expect(bad.ok).toBe(false)
    expect(bad.error?.message).toBe('lan must be a boolean')
    expect(ws!.isOpen()).toBe(true)
    expect((await status()).bindAddress).toBe('127.0.0.1')
  })

  it('HE-8 writing network.* through settings:set does not move a headless instance', async () => {
    let closed = false
    void ws!.closed().then(() => (closed = true))
    for (const [key, value] of [
      ['network.enabled', 'false'],
      ['network.port', String(other)],
      ['network.lan', 'true']
    ]) {
      await ws!.invoke('settings:set', { key, value })
    }
    await sleep(500)
    expect(closed).toBe(false)
    expect(ws!.isOpen()).toBe(true)
    expect(await status()).toMatchObject({
      enabled: true,
      port: P,
      listening: true,
      lan: false,
      bindAddress: '127.0.0.1'
    })
    expect((await httpProbe({ port: P })).status).toBe(200)
    expect(await httpProbe({ port: other })).toMatchObject({ error: 'ECONNREFUSED' })
  })

  it('HE-9 the smoke client passes against this instance (--expect-local)', async () => {
    const { code, lines } = await runSmoke([`http://127.0.0.1:${P}/`, '--expect-local'])
    expect(code, lines.join('\n')).toBe(0)
    expect(lines.at(-1)).toBe('headless smoke: all checks passed')
    for (const prefix of [
      'ok GET /',
      'ok WebSocket /ws',
      'ok network:status',
      'ok session:list',
      'ok session:create',
      'ok view sync',
      'ok network:setEnabled(false) refused',
      'ok session:delete'
    ]) {
      expect(
        lines.some((l) => l.startsWith(prefix)),
        prefix
      ).toBe(true)
    }
    expect(lines.filter((l) => l.startsWith('FAIL'))).toStrictEqual([])
    const sessions = await ws!.invoke<Array<{ title: string }>>('session:list')
    expect(sessions.filter((s) => s.title === 'Headless smoke check')).toStrictEqual([])
    expect((await status()).listening).toBe(true)
  }, 150_000)

  it('HE-9b the smoke client expecting --lan fails against this instance', async () => {
    const { code, lines } = await runSmoke([`http://127.0.0.1:${P}/`, '--expect-lan'])
    expect(code, lines.join('\n')).toBe(1)
    expect(
      lines.some((l) =>
        l.startsWith('FAIL network:status: expected to share on the local network (0.0.0.0)')
      ),
      lines.join('\n')
    ).toBe(true)
    expect(lines).not.toContain('headless smoke: all checks passed')
  }, 150_000)

  it('HE-11 `shuvix widget open demo` fails visibly: a headless instance opens no window', async () => {
    const result = await runCli(app, ['widget', 'open', 'demo'])
    expect(result.code, result.stderr).toBe(1)
    expect(result.stderr).toContain('running headless')
    expect(result.stderr).toContain('widget window for "demo"')
    expect(await pageTargets()).toStrictEqual([])
  })

  it('HE-12 a second instance prints this instance’s address and exits 0, whatever it asked for', async () => {
    const variants: Array<{ what: string; args?: string[]; env?: Record<string, string> }> = [
      { what: '--headless', args: ['--headless'] },
      { what: 'no arguments', args: [] },
      { what: 'SHUVIX_HEADLESS=1', env: { SHUVIX_HEADLESS: '1' } },
      { what: '--headless --port <other>', args: ['--headless', '--port', String(other)] },
      { what: 'an md file', args: [notes] }
    ]
    for (const variant of variants) {
      const second = await spawnSecondInstance(app, { args: variant.args, env: variant.env })
      expect(second.code, `${variant.what}\n${second.output.slice(-1500)}`).toBe(0)
      expect(countLine(second.stdout, alreadyRunning()), variant.what).toBe(1)
      expect(await pageTargets(), variant.what).toStrictEqual([])
      expect((await status()).listening, variant.what).toBe(true)
    }
    expect(await httpProbe({ port: other })).toMatchObject({ error: 'ECONNREFUSED' })
    await sleep(1000)
    expect(await pageTargets()).toStrictEqual([])
  }, 180_000)

  it('HE-13 an address file without addresses yet reads as still starting', async () => {
    const file = join(app.userData, 'headless.json')
    const original = readFileSync(file)
    try {
      writeFileSync(file, `${JSON.stringify({ pid: app.pid, urls: [] })}\n`)
      const second = await spawnSecondInstance(app, { args: ['--headless'] })
      expect(second.code, second.output.slice(-1500)).toBe(0)
      expect(countLine(second.stdout, 'ShuviX headless: already running (still starting)')).toBe(1)
    } finally {
      writeFileSync(file, original)
    }
    expect(readFileSync(file).equals(original)).toBe(true)
  }, 60_000)

  it('HE-14 --help on the same HOME prints the usage and leaves the instance alone', async () => {
    const result = await runToExit({ home: app.home, args: ['--help'] })
    expect(result.code, result.output.slice(-1500)).toBe(0)
    expect(result.stdout).toContain('Usage: shuvix --headless [--port <n>] [--lan]')
    expect(result.stdout).not.toContain('ShuviX headless: already running')
    expect((await httpProbe({ port: P })).status).toBe(200)
    expect((await status()).listening).toBe(true)
    expect(await pageTargets()).toStrictEqual([])
  }, 90_000)

  it('HE-15 no uncaught exception in the main process', () => {
    expect(uncaughtExceptions(app)).toBe('')
  })

  it('HE-16 quitting: exits on its own with code 0, says so in order, drops clients, removes the address file', async () => {
    const ws2 = await connectWs(P)
    const out = await app.quit({ timeoutMs: 45_000 })
    expect(out, app.output().slice(-2000)).toMatchObject({ exited: true, jsExited: true, code: 0 })
    const stdout = app.stdout()
    expect(countLine(stdout, SHUTTING_DOWN)).toBe(1)
    expect(countLine(stdout, STOPPED)).toBe(1)
    expect(stdout.indexOf(SHUTTING_DOWN)).toBeLessThan(stdout.indexOf(STOPPED))
    expect(await ws2.closed()).toBe(1001)
    expect(existsSync(join(app.userData, 'headless.json'))).toBe(false)
    expect(await httpProbe({ port: P })).toMatchObject({ error: 'ECONNREFUSED' })
  }, 90_000)
})
