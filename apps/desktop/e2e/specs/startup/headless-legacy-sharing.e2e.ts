/**
 * 无头运行的弃用参数 `--lan` / `--bind`（2026-10-19，docs/network-policy/design.md §6）—— 谁能连如今由安全策略
 * network-admission 定，实例一律监听 0.0.0.0；这两个参数照旧被接受（已有的服务文件不至于起不来），启动时打印一行弃用
 * 说明，并在**还没有**同名用户策略时按它们写一份 `~/.shuvix/policies/network-admission.md`，复现从前的范围：
 * `--lan` → 规则为空（任何私有地址都能连）；`--bind <网卡>` → 只放这台电脑与那块网卡的网段；`--bind` 一块这台电脑上
 * 没有的网卡 → 只放这台电脑与「从那块网卡进来的」。从外面看：stdout、策略文件、真的 HTTP 打到本机的私有地址上。
 *
 * HLS-1 `--lan`（新 HOME）：弃用说明恰一行、在就绪那一行之前；写了 network-admission（沿用内置的 id、规则为空）；
 *       准入 override；就绪那一行 = 本机私有 IPv4 地址（集合相等）+ 最后的 127.0.0.1；状态与 headless.json 同一份地址
 * HLS-2 （有私有网卡时）每个私有地址上 GET / → 200、经它的 WebSocket 连得上（客户端行的对端地址就是它）；
 *       smoke --expect-lan 全部通过
 * HLS-3 第二个实例 `--headless` → 退出码 0、打印与就绪那一行同样的地址
 * HLS-4 同一个 HOME 上用户改过那份策略（换成只放这台电脑、话也换了）后再带 `--lan` 启动：弃用说明照样一行，文件逐字节
 *       不变（不覆盖）；局域网地址 → 403、正文是用户那句话
 * HLS-5 `SHUVIX_BIND=shuvix-nope0`（这台电脑上没有的网卡，经环境变量）：照常就绪（不再 ENOINTERFACE）；
 *       `--bind shuvix-nope0` 的弃用说明；策略按「从那块网卡进来」写；127.0.0.1 → 200；局域网地址 → 403、正文说
 *       「connecting through shuvix-nope0」
 * HLS-6 （有私有网卡时）`--bind <第一块私有网卡>`：策略里是那块网卡的网段；那个地址 → 200；127.0.0.1 → 200；别的网段里的
 *       私有地址 → 403
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import {
  launchApp,
  spawnSecondInstance,
  type E2EHeadlessApp,
  type HeadlessLaunchOptions
} from '../../harness/launch'
import {
  httpProbe,
  loopbackOnlyPolicy,
  NETWORK_ADMISSION_FILE,
  privateIPv4Addresses,
  privateIPv4Networks,
  readUserPolicy,
  writeUserPolicy,
  type NetworkStatus
} from '../../harness/networkFixtures'
import { connectWs, type WsClient } from '../../harness/wsClient'

const DESKTOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const REPO_ROOT = resolve(DESKTOP_ROOT, '../..')
const SMOKE = join(REPO_ROOT, 'scripts', 'headless-smoke.mjs')

/** 弃用说明（src/main/utils/headless.ts 的 headlessDeprecationLine；e2e 按值钉住） */
const deprecationLine = (flag: string): string =>
  `ShuviX headless: ${flag} is deprecated — who can connect is now the security policy ` +
  'network-admission; if you have none yet, it is written from this option once ' +
  '(~/.shuvix/policies/network-admission.md)'

const READY_PREFIX = 'ShuviX headless: ready — open one of: '
const HLS4_PROMPT = 'HLS-4 the user narrowed this down to this computer.'

const lanIps = privateIPv4Addresses()
const networks = privateIPv4Networks()

let app: E2EHeadlessApp | undefined
let ws: WsClient | undefined
const sockets: WsClient[] = []
let P = 0

const status = (): Promise<NetworkStatus> => ws!.invoke<NetworkStatus>('network:status')
const noSlash = (url: string): string => url.replace(/\/$/, '')
const lines = (text: string): string[] => text.split('\n').map((l) => l.replace(/\r$/, ''))
const countLine = (text: string, line: string): number =>
  lines(text).filter((l) => l === line).length

/** 换一个实例：关掉上一个（`keepHome` 留着它的 HOME 给下一个用）的连接与进程 */
async function stopApp(keepHome = false): Promise<void> {
  for (const socket of sockets.splice(0)) socket.close()
  ws?.close()
  ws = undefined
  await app?.stop({ keepHome })
  app = undefined
}

/** IPv4 地址在不在 `a.b.c.d/n` 里（只为挑出「别的网段」的本机地址） */
function inCidr4(ip: string, cidr: string): boolean {
  const toInt = (a: string): number =>
    a.split('.').reduce((acc, octet) => ((acc << 8) | Number(octet)) >>> 0, 0)
  const [base, bits] = cidr.split('/')
  const prefix = Number(bits)
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  return (toInt(ip) & mask) >>> 0 === (toInt(base) & mask) >>> 0
}

async function start(opts: Omit<HeadlessLaunchOptions, 'headless'>): Promise<void> {
  app = await launchApp({ ...opts, headless: true })
  P = app.networkPort
  ws = await connectWs(P)
}

afterAll(async () => {
  await stopApp()
})

describe('headless: the deprecated --lan / --bind become a network-admission policy', () => {
  it('HLS-1 --lan prints the deprecation line once and writes the policy; other devices are advertised', async () => {
    await start({ lan: true })
    const stdout = app!.stdout()
    const deprecated = deprecationLine('--lan')
    expect(countLine(stdout, deprecated), stdout).toBe(1)
    expect(lines(stdout).indexOf(deprecated)).toBeLessThan(
      lines(stdout).findIndex((l) => l.startsWith(READY_PREFIX))
    )

    const policy = readUserPolicy(app!.home, NETWORK_ADMISSION_FILE)
    expect(policy).not.toBeNull()
    expect(policy).toContain('\nshuvix-id: policy:builtin:network-admission\n')
    expect(policy).toContain('\nname: network-admission\n')
    expect(policy).toContain('\nshuvix-policy-rules: []\n')

    expect(app!.urls.at(-1)).toBe(`http://127.0.0.1:${P}/`)
    expect([...app!.urls.slice(0, -1)].sort()).toStrictEqual(
      lanIps.map((ip) => `http://${ip}:${P}/`).sort()
    )
    const s = await status()
    expect(s).toMatchObject({
      enabled: true,
      port: P,
      listening: true,
      headless: true,
      admission: 'override',
      denials: []
    })
    expect('error' in s).toBe(false)
    expect(s.addresses).toStrictEqual(app!.urls.map(noSlash))
    const address = JSON.parse(readFileSync(join(app!.userData, 'headless.json'), 'utf8')) as {
      urls: string[]
    }
    expect(address).toStrictEqual({ pid: app!.pid, port: P, urls: s.addresses })
  }, 120_000)

  it('HLS-2 every private address serves the web client and its socket; the smoke client passes with --expect-lan', async (ctx) => {
    if (lanIps.length === 0) ctx.skip()
    for (const ip of lanIps) {
      const page = await httpProbe({ port: P, connectHost: ip, host: `${ip}:${P}` })
      expect(page.status, ip).toBe(200)
      expect(page.body?.toString('utf8'), ip).toContain('<div id="root">')
      const lan = await connectWs(P, { host: ip })
      sockets.push(lan)
      expect(await lan.invoke<unknown[]>('session:list'), ip).toBeInstanceOf(Array)
      expect(
        (await status()).clients.map((c) => c.remoteAddress),
        ip
      ).toContain(ip)
    }
    expect((await status()).denials).toEqual([])

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
    const smoke = out.split('\n').filter((l) => l.trim().length > 0)
    expect(code, out).toBe(0)
    expect(smoke.at(-1)).toBe('headless smoke: all checks passed')
    expect(smoke.filter((l) => l.startsWith('FAIL'))).toStrictEqual([])
    expect(
      smoke.some((l) => l.startsWith('ok network:status') && l.includes('admission override'))
    ).toBe(true)
  }, 150_000)

  it('HLS-3 a second instance prints the same addresses as the ready line', async () => {
    const second = await spawnSecondInstance(app!, { args: ['--headless'] })
    expect(second.code, second.output.slice(-1500)).toBe(0)
    const line = `ShuviX headless: already running — open one of: ${app!.urls.join(' ')}`
    expect(second.stdout.split('\n').filter((l) => l === line)).toHaveLength(1)
  }, 60_000)

  it('HLS-4 a later --lan start leaves the policy the user edited alone', async (ctx) => {
    const home = app!.home
    await stopApp(true)
    const edited = loopbackOnlyPolicy(HLS4_PROMPT)
    writeUserPolicy(home, NETWORK_ADMISSION_FILE, edited)

    await start({ home, lan: true })
    expect(countLine(app!.stdout(), deprecationLine('--lan'))).toBe(1)
    expect(readUserPolicy(home, NETWORK_ADMISSION_FILE)).toBe(edited)
    expect((await status()).admission).toBe('override')
    expect((await httpProbe({ port: P })).status).toBe(200)

    if (lanIps.length === 0) ctx.skip()
    for (const ip of lanIps) {
      const refused = await httpProbe({ port: P, connectHost: ip, host: `${ip}:${P}` })
      expect(refused.status, ip).toBe(403)
      expect(refused.body?.toString('utf8'), ip).toContain(HLS4_PROMPT)
    }
    const denials = (await status()).denials
    expect(denials.map((d) => d.rule)).toEqual(lanIps.map(() => 'network-admission#0'))
  }, 120_000)

  it('HLS-5 SHUVIX_BIND naming an interface this computer does not have still starts; the policy keys on that interface', async (ctx) => {
    await stopApp()
    await start({ env: { SHUVIX_BIND: 'shuvix-nope0' } })
    expect(countLine(app!.stdout(), deprecationLine('--bind shuvix-nope0'))).toBe(1)
    expect(app!.stdout()).not.toContain('ENOINTERFACE')

    const policy = readUserPolicy(app!.home, NETWORK_ADMISSION_FILE)
    expect(policy).toContain('\nname: network-admission\n')
    expect(policy).toContain(
      `match: "!(inCidr(subject.address, ['127.0.0.0/8', '::1']) || subject.interface == 'shuvix-nope0')"`
    )
    expect((await status()).admission).toBe('override')
    expect((await httpProbe({ port: P })).status).toBe(200)

    if (lanIps.length === 0) ctx.skip()
    for (const ip of lanIps) {
      const refused = await httpProbe({ port: P, connectHost: ip, host: `${ip}:${P}` })
      expect(refused.status, ip).toBe(403)
      expect(refused.body?.toString('utf8'), ip).toContain(
        'This ShuviX only accepts connections from the computer it runs on and devices connecting through shuvix-nope0.'
      )
    }
  }, 120_000)

  it('HLS-6 --bind <interface> lets in that network only', async (ctx) => {
    await stopApp()
    const chosen = networks[0]
    if (chosen === undefined) ctx.skip()
    await start({ bind: chosen.interface })
    expect(countLine(app!.stdout(), deprecationLine(`--bind ${chosen.interface}`))).toBe(1)

    const policy = readUserPolicy(app!.home, NETWORK_ADMISSION_FILE)
    expect(policy).toContain(
      `match: "!(inCidr(subject.address, ['127.0.0.0/8', '::1', '${chosen.cidr}']))"`
    )
    expect((await status()).admission).toBe('override')

    expect((await httpProbe({ port: P })).status).toBe(200)
    const page = await httpProbe({
      port: P,
      connectHost: chosen.address,
      host: `${chosen.address}:${P}`
    })
    expect(page.status).toBe(200)
    expect(page.body?.toString('utf8')).toContain('<div id="root">')
    // 别的网卡上的私有地址：同一台电脑，但不在那个网段里 —— 照样按「别的设备」拒绝
    for (const ip of lanIps.filter((a) => !inCidr4(a, chosen.cidr))) {
      const refused = await httpProbe({ port: P, connectHost: ip, host: `${ip}:${P}` })
      expect(refused.status, ip).toBe(403)
    }
  }, 120_000)
})
