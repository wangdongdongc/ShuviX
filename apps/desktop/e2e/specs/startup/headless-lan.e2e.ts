/**
 * 无头运行 + `--lan`（docs/headless/design.md「LAN switch」）—— 一个 `launchApp({ headless: true, lan: true })` 的实例：
 * 监听 0.0.0.0，就绪那一行与状态列出本机的私有地址 + 127.0.0.1，局域网地址上真的打得开；共享由启动参数定，换不了。
 *
 * HLN-1 就绪那一行：本机私有 IPv4 地址（集合相等）+ 最后的 `http://127.0.0.1:<P>/`
 * HLN-2 network:status：lan true、绑 0.0.0.0、headless；地址 = 就绪那一行的地址去掉末尾的 /
 * HLN-3 每个私有地址上 GET / → 200（没有私有网卡就跳过）；smoke --expect-lan 全部通过
 * HLN-4 setLan(false) → code 'headless'；setLan(true) → ok；照旧绑 0.0.0.0
 * HLN-5 第二个实例 `--headless` → 退出码 0、打印与就绪那一行同样的地址
 * HLN-6 headless.json 的 urls = status.addresses
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchApp, spawnSecondInstance, type E2EHeadlessApp } from '../../harness/launch'
import { httpProbe, privateIPv4Addresses, type NetworkStatus } from '../../harness/networkFixtures'
import { connectWs, type WsClient } from '../../harness/wsClient'

const DESKTOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const REPO_ROOT = resolve(DESKTOP_ROOT, '../..')
const SMOKE = join(REPO_ROOT, 'scripts', 'headless-smoke.mjs')

let app: E2EHeadlessApp
let ws: WsClient | undefined
let P = 0

const status = (): Promise<NetworkStatus> => ws!.invoke<NetworkStatus>('network:status')
const noSlash = (url: string): string => url.replace(/\/$/, '')

beforeAll(async () => {
  app = await launchApp({ headless: true, lan: true })
  P = app.networkPort
  ws = await connectWs(P)
})

afterAll(async () => {
  ws?.close()
  await app?.stop()
})

describe('headless --lan: shared on the local network', () => {
  it('HLN-1 the ready line lists the private addresses, then 127.0.0.1', async () => {
    const loopback = `http://127.0.0.1:${P}/`
    expect(app.urls.at(-1)).toBe(loopback)
    expect([...app.urls.slice(0, -1)].sort()).toStrictEqual(
      privateIPv4Addresses()
        .map((ip) => `http://${ip}:${P}/`)
        .sort()
    )
    expect(app.readyLine).toBe(`ShuviX headless: ready — open one of: ${app.urls.join(' ')}`)
    // 没有私有网卡时只剩 127.0.0.1 —— 但照样绑 0.0.0.0
    expect((await status()).bindAddress).toBe('0.0.0.0')
  })

  it('HLN-2 network:status: lan, bound to 0.0.0.0, headless; the same addresses', async () => {
    const s = await status()
    expect(s).toMatchObject({
      enabled: true,
      port: P,
      lan: true,
      bindAddress: '0.0.0.0',
      listening: true,
      headless: true
    })
    expect('error' in s).toBe(false)
    expect(s.addresses).toStrictEqual(app.urls.map(noSlash))
  })

  it('HLN-3 every private address serves the web client; the smoke client passes with --expect-lan', async () => {
    for (const ip of privateIPv4Addresses()) {
      const page = await httpProbe({ port: P, connectHost: ip, host: `${ip}:${P}` })
      expect(page.status, ip).toBe(200)
      expect(page.body?.toString('utf8'), ip).toContain('<div id="root">')
    }
    const child = spawn(process.execPath, [SMOKE, `http://127.0.0.1:${P}/`, '--expect-lan'], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let out = ''
    child.stdout.on('data', (c: Buffer) => (out += c.toString()))
    child.stderr.on('data', (c: Buffer) => (out += c.toString()))
    const code = await new Promise<number | null>((resolveRun, rejectRun) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        rejectRun(new Error(`headless-smoke did not exit within 120 s\n${out.slice(-2000)}`))
      }, 120_000)
      child.on('exit', (c) => {
        clearTimeout(timer)
        resolveRun(c)
      })
    })
    const lines = out.split('\n').filter((l) => l.trim().length > 0)
    expect(code, out).toBe(0)
    expect(lines.at(-1)).toBe('headless smoke: all checks passed')
    expect(lines.filter((l) => l.startsWith('FAIL'))).toStrictEqual([])
  }, 150_000)

  it('HLN-4 sharing is fixed at startup: setLan(false) is refused, setLan(true) passes', async () => {
    const local = await ws!.invokeRaw('network:setLan', [false])
    expect(local.ok).toBe(false)
    expect(local.error?.code).toBe('headless')
    const lan = await ws!.invokeRaw('network:setLan', [true])
    expect(lan.ok).toBe(true)
    expect((lan.value as NetworkStatus).lan).toBe(true)
    expect(ws!.isOpen()).toBe(true)
    expect((await status()).bindAddress).toBe('0.0.0.0')
  })

  it('HLN-5 a second instance prints the same addresses as the ready line', async () => {
    const second = await spawnSecondInstance(app, { args: ['--headless'] })
    expect(second.code, second.output.slice(-1500)).toBe(0)
    const line = `ShuviX headless: already running — open one of: ${app.urls.join(' ')}`
    expect(second.stdout.split('\n').filter((l) => l === line)).toHaveLength(1)
  }, 60_000)

  it('HLN-6 headless.json lists the same addresses as network:status', async () => {
    const s = await status()
    const address = JSON.parse(readFileSync(join(app.userData, 'headless.json'), 'utf8')) as {
      urls: string[]
    }
    expect(address).toStrictEqual({ pid: app.pid, port: P, urls: s.addresses })
  })
})
