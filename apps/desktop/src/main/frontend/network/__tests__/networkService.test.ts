/**
 * `frontend/network/index.ts` —— 网络访问服务（server mode phase B §B1）：按设置对账（开 → 监听、关 → 停止并断开、换端口 →
 * 先断开再换）、状态、写设置的两个入口、连接注册成聊天前端、跟着 `settings.changed` 走、退出。服务绑 127.0.0.1，网卡是假的；
 * 设置读写走注入的 Map；`network.changed` 是 spy。logger / settingsDao / settingsService / chatFrontendRegistry / 视图同步接线
 * 是替身，appEventBus 是真的。NSV-14 `vi.resetModules()` 后重新导入（注册表有模块级状态）。
 *
 *   LA-1  listenAddresses：每个非内部、私有的 IPv4 接口一条（数字 family 也认、去重），外加 127.0.0.1（phase D：不再是 localhost）；空表 → 只有 127.0.0.1
 *   LA-2  公网地址与 CGNAT（100.64/10）不列；172.16/12 与 169.254/16 列
 *   NSV-1 关着：status 恰是 {enabled:false, port:7766, listening:false, addresses:[], clients:[], admission:'builtin',
 *         denials:[]}（没有 error 键）；对账不发 changed
 *   NSV-2 开着：对账 → 在 P 上监听，status 地址只有 127.0.0.1（内置准入只放这台电脑）；changed 一次；GET / → 200
 *   NSV-3 设置没变再对账：不重启（客户端还开着），不再发 changed
 *   NSV-4 换端口：客户端以 1001 'network port changed' 断开；旧端口不再服务、新端口服务；changed 恰 +2；unregister 调到
 *   NSV-5 关掉：客户端 1001 'network access turned off'；端口放开；listening false、地址空；changed +2；unregister 调到
 *   NSV-6 端口被占：对账从不拒绝；listening false、error 'EADDRINUSE'、地址空；changed +1；端口空出来再
 *         对账 → 监听、没有 error
 *   NSV-7 出错又从没监听过时关掉 → changed +1、error 清掉；关着、没出错、没监听 → 对账什么也不发
 *   NSV-8 setEnabled：写 'true' / 'false'，回改完之后的状态；非布尔 → 拒绝 'enabled must be a boolean'，什么也不写
 *   NSV-9 setPort：1024 / 65535 写成字符串、状态的端口跟着变；不合法 → 拒绝（固定的一句话），什么也不写
 *   NSV-10 存着的端口 'abc' → status().port === 7766
 *   NSV-11 客户端列表：id / remoteAddress / userAgent / device / connectedAt；断开之后为空
 *   NSV-12 连上：registerDefault 收到 id 'network:'+clientId、userInput 的前端；连上与断开各发一次 changed
 *   NSV-13 init（注入传输）：registerViewAuthorizer('network', fn) 且 fn() 为真；settings.changed 只在 keys 缺失或含
 *          network.* 时对账；init 两次只订阅、登记一次
 *   NSV-14 init 不注入传输：传输挂到注册表（isClientAlive 认得连着的客户端）；第二次 init 不抛；注入传输时不挂（测试接缝）
 *   NSV-15 shutdown：客户端 1001 'ShuviX is quitting'；地址空；之后对账 / settings.changed 都不再开始监听
 *   NSV-16 开着时两次并发对账 → 只启动一次（status 没有 error）
 *   NSV-17 readSetting 抛 → 对账照样 resolve；之后读得出来的对账照常开始监听
 *   NSV-18 phase D 的路由由 init 交进来：不给 → `/lib/x` 404；给了 fileRoutes / widgetProxy → `/lib/x` 200（读取收到
 *          'x'）、`/w/a-b/` 503（widget 服务没在跑）；之后不带参数的 init 不清掉已经交进来的路由
 *
 * 无头运行（`setHeadless`，docs/headless/design.md §1）：
 *   NSH-1  network.enabled 缺、network.port = Q：setHeadless({port:P}) → 在 P 上监听，status 恰带 headless:true；Q 空着；
 *          什么也不写；network.* 设置一个都不读
 *   NSH-2  存着 network.enabled='false' 照样监听 P
 *   NSH-3  setEnabled(false) → 拒绝（code 'headless'）；不写；照样监听、连着的客户端照样开着
 *   NSH-4  setEnabled(true) → 回状态（headless、listening）；不写
 *   NSH-5  setEnabled('true') → 'enabled must be a boolean'（先校验）
 *   NSH-6  setPort(P) → 回状态、不写；换别的合法端口 → 拒绝（code 'headless'），照样在 P、客户端开着；1023 / '7766' →
 *          端口那句、不带 code 'headless'
 *   NSH-7  init 之后设置里关掉网络访问、换端口并发 settings.changed → 照样在 P、客户端开着、changed 没多
 *   NSH-8  P 被占 → 对账照样 resolve；listening false、error EADDRINUSE、地址空、headless、enabled；
 *          空出来再对账 → 监听
 *   NSH-9  setHeadless 的端口不合法（1023 / 65536 / 1.5 / NaN）→ 抛端口那句；之后 status 没有 headless 键
 *   NSH-10 桌面模式的 status 没有 headless 键
 *   NSH-11 setHeadless 之后、对账之前：status 恰是 {enabled:true, port:P, listening:false, …, headless:true}
 *   NSH-12 无头的 shutdown：客户端 1001 'ShuviX is quitting'、端口放开；之后对账不再开始监听
 *
 * 安全策略（2026-10-19，docs/network-policy/design.md；策略那一侧是假的，判定按用例给的函数回）：
 *   NSP-1  没接策略：admission 'builtin'、denials []、地址只有 127.0.0.1；GET / 200 且发一个 22 位的 shuvix_device；带着它再来
 *          不再发；连上的客户端在列表里带着设备 ID
 *   NSP-2  request 点位拒绝 → 403，正文是规则的话 + 「Device: …」「Address: 127.0.0.1」；拒绝记录一条（stage request、
 *          GET /、规则 p#0），同样的再来一次 → 还是一条、count 2
 *   NSP-3  socket 点位拒绝 → 连接直接断开（请求出错）
 *   NSP-4  升级（route socket）被拒 → 403
 *   NSP-5  policy.changed：连着的客户端按升级时的事实重判，新被拒的以 1008 断开、原因是规则的话
 *   NSP-6  监听时定时核策略目录；关掉之后不再核
 *   NSP-7  admission 由策略那一侧给：override / disabled → 地址是 listenAddresses 那一份
 *   NSP-8  迁移（桌面）：network.lan='true' → 写一份规则为空的 network-admission、删掉两个旧键；还指定了 eth1（SCOPED_IFACES）
 *          → 写进 192.168.50.10/24；已有同名用户策略 → 不写、照样删键；没开局域网 → 不写；没接策略 → 什么也不动
 *   NSP-9  迁移（无头）：--lan / --bind 同样写；不删设置
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir, type NetworkInterfaceInfo, type networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import type { GateVerdict, SecurityObject, SecuritySubject } from '@shuvix/agent-runtime'
import { createNetworkTransport } from '../transport'
import type * as ServiceModule from '../index'

const mocks = vi.hoisted(() => ({
  registerDefault: vi.fn(),
  unregister: vi.fn(),
  registerViewAuthorizer: vi.fn(),
  accept: vi.fn()
}))

vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
}))
vi.mock('../../../dao/settingsDao', () => ({ settingsDao: { findByKey: vi.fn() } }))
vi.mock('../../../services/settingsService', () => ({ settingsService: { set: vi.fn() } }))
vi.mock('../../core', () => ({
  chatFrontendRegistry: { registerDefault: mocks.registerDefault, unregister: mocks.unregister }
}))
vi.mock('../../sync/syncWiring', () => ({
  getSyncHub: () => ({ accept: mocks.accept }),
  registerViewAuthorizer: mocks.registerViewAuthorizer
}))

type Interfaces = ReturnType<typeof networkInterfaces>

const iface = (address: string, family: string | number, internal = false): NetworkInterfaceInfo =>
  ({
    address,
    family,
    internal,
    netmask: '',
    mac: '',
    cidr: null
  }) as unknown as NetworkInterfaceInfo

const FAKE_IFACES: Interfaces = {
  en0: [iface('192.168.1.10', 'IPv4'), iface('fe80::1', 'IPv6')],
  lo0: [iface('127.0.0.1', 'IPv4', true)],
  utun: [iface('10.0.0.2', 4)],
  dup: [iface('192.168.1.10', 'IPv4')],
  x: undefined
}

/** 带真的掩码（Node 给的那样：netmask 与 cidr 都有） */
const v4 = (address: string, prefix: number, internal = false): NetworkInterfaceInfo =>
  ({
    address,
    family: 'IPv4',
    internal,
    netmask: [0, 1, 2, 3]
      .map((i) => ((0xffffffff << (32 - prefix)) >>> (24 - i * 8)) & 0xff)
      .join('.'),
    mac: '',
    cidr: `${address}/${prefix}`
  }) as unknown as NetworkInterfaceInfo

const SCOPED_IFACES: Interfaces = {
  eth0: [v4('10.0.0.5', 24)],
  eth1: [v4('192.168.50.10', 24)],
  lo0: [v4('127.0.0.1', 8, true)]
}

let mod: typeof ServiceModule
let tmp: string
let settings: Map<string, string>
let writes: Array<[string, string]>
let removes: string[]
let changed: ReturnType<typeof vi.fn<() => void>>
let services: ServiceModule.NetworkService[]
let sockets: WebSocket[]
let blockers: Array<ReturnType<typeof createNetServer>>

beforeEach(async () => {
  mod = await import('../index')
  mocks.registerDefault.mockReset()
  mocks.unregister.mockReset()
  mocks.registerViewAuthorizer.mockReset()
  tmp = mkdtempSync(join(tmpdir(), 'shuvix-net-svc-'))
  writeFileSync(join(tmp, 'web.html'), '<p>web</p>')
  settings = new Map()
  writes = []
  removes = []
  changed = vi.fn()
  services = []
  sockets = []
  blockers = []
})

afterEach(async () => {
  for (const ws of sockets) ws.terminate()
  for (const svc of services) await svc.shutdown()
  for (const blocker of blockers)
    await new Promise<void>((resolve) => blocker.close(() => resolve()))
  rmSync(tmp, { recursive: true, force: true })
})

function makeService(
  overrides: Partial<ServiceModule.NetworkServiceDeps> = {},
  service: typeof ServiceModule = mod
): ServiceModule.NetworkService {
  const svc = new service.NetworkService({
    readSetting: (k) => settings.get(k),
    writeSetting: (k, v) => {
      writes.push([k, v])
      settings.set(k, v)
    },
    removeSetting: (k) => {
      removes.push(k)
      settings.delete(k)
    },
    rendererDir: () => tmp,
    host: '127.0.0.1',
    interfaces: () => FAKE_IFACES,
    publishChanged: changed,
    transport: createNetworkTransport(),
    ...overrides
  })
  services.push(svc)
  return svc
}

async function freePort(): Promise<number> {
  const probe = createNetServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()))
  const { port } = probe.address() as { port: number }
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

async function occupy(port: number): Promise<ReturnType<typeof createNetServer>> {
  const blocker = createNetServer()
  await new Promise<void>((resolve) => blocker.listen(port, '127.0.0.1', () => resolve()))
  blockers.push(blocker)
  return blocker
}

async function release(blocker: ReturnType<typeof createNetServer>): Promise<void> {
  blockers.splice(blockers.indexOf(blocker), 1)
  await new Promise<void>((resolve) => blocker.close(() => resolve()))
}

function enable(port: number): void {
  settings.set('network.enabled', 'true')
  settings.set('network.port', String(port))
}

function getStatus(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: '/', agent: false }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode ?? 0))
    })
    req.on('error', reject)
    req.end()
  })
}

/** 升级被拒时的状态码（被接受 → 拒绝） */
function upgradeStatus(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: `http://127.0.0.1:${port}` })
    sockets.push(ws)
    ws.on('unexpected-response', (_req, res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    ws.on('open', () => reject(new Error('the upgrade was accepted')))
    ws.on('error', reject)
  })
}

function getPathStatus(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, agent: false }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode ?? 0))
    })
    req.on('error', reject)
    req.end()
  })
}

async function canListen(port: number): Promise<boolean> {
  const probe = createNetServer()
  const ok = await new Promise<boolean>((resolve) => {
    probe.once('error', () => resolve(false))
    probe.listen(port, '127.0.0.1', () => resolve(true))
  })
  if (ok) await new Promise<void>((resolve) => probe.close(() => resolve()))
  return ok
}

interface Client {
  ws: WebSocket
  closed: Promise<{ code: number; reason: string }>
}

async function connect(port: number, userAgent?: string): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
    origin: `http://127.0.0.1:${port}`,
    headers: userAgent === undefined ? undefined : { 'user-agent': userAgent }
  })
  sockets.push(ws)
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }))
  )
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
  return { ws, closed }
}

describe('LA listenAddresses', () => {
  it('LA-1 私有的非内部 IPv4（数字 family 也认、去重）+ 127.0.0.1；空表 → 只有 127.0.0.1', () => {
    expect(mod.listenAddresses(8123, FAKE_IFACES)).toStrictEqual([
      'http://192.168.1.10:8123',
      'http://10.0.0.2:8123',
      'http://127.0.0.1:8123'
    ])
    expect(mod.listenAddresses(8123, {})).toStrictEqual(['http://127.0.0.1:8123'])
  })

  it('LA-2 公网地址与 CGNAT 不列；172.16/12、169.254/16 列', () => {
    expect(
      mod.listenAddresses(9000, {
        wan: [iface('8.8.8.8', 'IPv4'), iface('100.64.1.2', 'IPv4')],
        tailscale: [iface('100.100.1.1', 'IPv4')],
        docker: [iface('172.20.0.5', 'IPv4')],
        ll: [iface('169.254.3.4', 'IPv4')]
      })
    ).toStrictEqual(['http://172.20.0.5:9000', 'http://169.254.3.4:9000', 'http://127.0.0.1:9000'])
  })
})

describe('NSV-1..NSV-7 对账', () => {
  it('NSV-1 关着：status 的形状；对账不发 changed', async () => {
    const svc = makeService()
    const status = svc.status()
    expect(status).toStrictEqual({
      enabled: false,
      port: 7766,
      admission: 'builtin',
      denials: [],
      listening: false,
      addresses: [],
      clients: []
    })
    expect('error' in status).toBe(false)
    await svc.reconcile()
    expect(changed).not.toHaveBeenCalled()
  })

  it('NSV-2 开着：在 P 上监听，status 带地址；changed 一次；GET / → 200', async () => {
    const P = await freePort()
    enable(P)
    const svc = makeService()
    await svc.reconcile()
    // 局域网开关缺省关：只列 127.0.0.1（局域网地址那一份见 NSL-2）；FAKE_IFACES 没有掩码 → 没有能挑的网络
    expect(svc.status()).toStrictEqual({
      enabled: true,
      port: P,
      admission: 'builtin',
      denials: [],
      listening: true,
      addresses: [`http://127.0.0.1:${P}`],
      clients: []
    })
    expect(changed).toHaveBeenCalledTimes(1)
    expect(await getStatus(P)).toBe(200)
  })

  it('NSV-3 设置没变再对账：不重启，不再发 changed', async () => {
    const P = await freePort()
    enable(P)
    const svc = makeService()
    await svc.reconcile()
    const client = await connect(P)
    const before = changed.mock.calls.length
    await svc.reconcile()
    expect(changed.mock.calls.length).toBe(before)
    expect(client.ws.readyState).toBe(WebSocket.OPEN)
  })

  it("NSV-4 换端口：1001 'network port changed'；旧端口不服务、新端口服务；changed +2；unregister", async () => {
    const P = await freePort()
    const P2 = await freePort()
    enable(P)
    const svc = makeService()
    await svc.reconcile()
    const client = await connect(P)
    const clientId = svc.status().clients[0].id
    const before = changed.mock.calls.length
    settings.set('network.port', String(P2))
    await svc.reconcile()
    expect(await client.closed).toStrictEqual({ code: 1001, reason: 'network port changed' })
    await expect(getStatus(P)).rejects.toMatchObject({ code: 'ECONNREFUSED' })
    expect(await getStatus(P2)).toBe(200)
    expect(svc.status().port).toBe(P2)
    expect(changed.mock.calls.length - before).toBe(2)
    expect(mocks.unregister).toHaveBeenCalledWith('network:' + clientId)
  })

  it("NSV-5 关掉：1001 'network access turned off'；端口放开；changed +2；unregister", async () => {
    const P = await freePort()
    enable(P)
    const svc = makeService()
    await svc.reconcile()
    const client = await connect(P)
    const clientId = svc.status().clients[0].id
    const before = changed.mock.calls.length
    settings.set('network.enabled', 'false')
    await svc.reconcile()
    expect(await client.closed).toStrictEqual({ code: 1001, reason: 'network access turned off' })
    expect(await canListen(P)).toBe(true)
    const status = svc.status()
    expect(status.listening).toBe(false)
    expect(status.addresses).toStrictEqual([])
    expect(changed.mock.calls.length - before).toBe(2)
    expect(mocks.unregister).toHaveBeenCalledWith('network:' + clientId)
  })

  it('NSV-6 端口被占：从不拒绝；error EADDRINUSE；空出来再对账 → 监听', async () => {
    const P = await freePort()
    const blocker = await occupy(P)
    enable(P)
    const svc = makeService()
    await expect(svc.reconcile()).resolves.toBeUndefined()
    const status = svc.status()
    expect(status.listening).toBe(false)
    expect(status.error).toBe('EADDRINUSE')
    expect(status.addresses).toStrictEqual([])
    expect(changed).toHaveBeenCalledTimes(1)

    await release(blocker)
    await svc.reconcile()
    const after = svc.status()
    expect(after.listening).toBe(true)
    expect('error' in after).toBe(false)
    expect(changed).toHaveBeenCalledTimes(2)
  })

  it('NSV-7 出错后关掉 → changed +1、error 清掉；关着没出错 → 不发', async () => {
    const P = await freePort()
    await occupy(P)
    enable(P)
    const svc = makeService()
    await svc.reconcile()
    expect(svc.status().error).toBe('EADDRINUSE')
    settings.set('network.enabled', 'false')
    await svc.reconcile()
    expect(changed).toHaveBeenCalledTimes(2)
    expect('error' in svc.status()).toBe(false)
    await svc.reconcile()
    expect(changed).toHaveBeenCalledTimes(2)
  })
})

describe('NSV-8..NSV-10 写设置', () => {
  it('NSV-8 setEnabled', async () => {
    const P = await freePort()
    settings.set('network.port', String(P))
    const svc = makeService()
    const on = await svc.setEnabled(true)
    expect(writes).toStrictEqual([['network.enabled', 'true']])
    expect(on.listening).toBe(true)
    expect(on.enabled).toBe(true)
    const off = await svc.setEnabled(false)
    expect(writes).toStrictEqual([
      ['network.enabled', 'true'],
      ['network.enabled', 'false']
    ])
    expect(off.listening).toBe(false)
    for (const bad of ['true', 1, undefined]) {
      await expect(svc.setEnabled(bad)).rejects.toThrow('enabled must be a boolean')
    }
    expect(writes).toHaveLength(2)
  })

  it('NSV-9 setPort', async () => {
    const svc = makeService()
    for (const port of [1024, 65535]) {
      const status = await svc.setPort(port)
      expect(writes.at(-1)).toStrictEqual(['network.port', String(port)])
      expect(status.port).toBe(port)
      expect(status.listening).toBe(false)
    }
    const count = writes.length
    for (const bad of [1023, 65536, 7766.5, '7766', NaN, undefined]) {
      await expect(svc.setPort(bad)).rejects.toThrow(
        'The port must be an integer between 1024 and 65535.'
      )
    }
    expect(writes).toHaveLength(count)
  })

  it("NSV-10 存着的端口 'abc' → 7766", () => {
    settings.set('network.port', 'abc')
    expect(makeService().status().port).toBe(7766)
  })
})

describe('NSV-11 / NSV-12 客户端', () => {
  it('NSV-11 客户端列表；断开之后为空', async () => {
    const P = await freePort()
    enable(P)
    const svc = makeService()
    await svc.reconcile()
    const before = Date.now()
    const client = await connect(P, 'test-agent/1.0')
    const after = Date.now()
    const clients = svc.status().clients
    expect(clients).toStrictEqual([
      {
        id: expect.stringMatching(/^ws:\d+$/),
        remoteAddress: '127.0.0.1',
        userAgent: 'test-agent/1.0',
        device: '',
        connectedAt: expect.any(Number)
      }
    ])
    expect(clients[0].connectedAt).toBeGreaterThanOrEqual(before)
    expect(clients[0].connectedAt).toBeLessThanOrEqual(after)
    client.ws.close()
    await vi.waitFor(() => expect(svc.status().clients).toStrictEqual([]))
  })

  it('NSV-12 连上：registerDefault 收到网络前端；连上与断开各发一次 changed', async () => {
    const P = await freePort()
    enable(P)
    const svc = makeService()
    await svc.reconcile()
    const base = changed.mock.calls.length
    const client = await connect(P)
    await vi.waitFor(() => expect(mocks.registerDefault).toHaveBeenCalledTimes(1))
    const id = svc.status().clients[0].id
    const frontend = mocks.registerDefault.mock.calls[0][0]
    expect(frontend.id).toBe('network:' + id)
    expect(frontend.capabilities.userInput).toBe(true)
    expect(changed.mock.calls.length - base).toBe(1)
    client.ws.close()
    await vi.waitFor(() => expect(changed.mock.calls.length - base).toBe(2))
    expect(mocks.unregister).toHaveBeenCalledWith('network:' + id)
  })
})

describe('NSV-13 / NSV-14 init', () => {
  it('NSV-13 视图核对一律放行；settings.changed 只在 keys 缺失或含 network.* 时对账；两次 init 只装一次', async () => {
    const { appEventBus } = await import('../../../utils/appEventBus')
    const P = await freePort()
    settings.set('network.port', String(P))
    const svc = makeService()
    await svc.init()
    await svc.init()
    expect(mocks.registerViewAuthorizer).toHaveBeenCalledTimes(1)
    const [kind, authorize] = mocks.registerViewAuthorizer.mock.calls[0] as [string, () => boolean]
    expect(kind).toBe('network')
    expect(authorize()).toBe(true)

    const reconcile = vi.spyOn(svc, 'reconcile')
    settings.set('network.enabled', 'true')
    appEventBus.publish({ type: 'settings.changed', keys: ['general.language'] })
    expect(reconcile).not.toHaveBeenCalled()
    appEventBus.publish({ type: 'settings.changed', keys: ['network.port'] })
    expect(reconcile).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(svc.status().listening).toBe(true))

    appEventBus.publish({ type: 'settings.changed' } as never)
    expect(reconcile).toHaveBeenCalledTimes(2)
    appEventBus.publish({ type: 'network.changed' })
    expect(reconcile).toHaveBeenCalledTimes(2)
    appEventBus.publish({ type: 'settings.changed', keys: ['network.port'] })
    expect(reconcile).toHaveBeenCalledTimes(3)
  })

  it('NSV-14 不注入传输：挂到注册表；第二次 init 不抛；注入传输则不挂（测试接缝）', async () => {
    vi.resetModules()
    const registry = await import('../../../ipc/registry')
    const fresh = await import('../index')
    const P = await freePort()
    enable(P)
    const svc = makeService({ transport: undefined }, fresh)
    await svc.init()
    await expect(svc.init()).resolves.toBeUndefined()
    await connect(P)
    const ref = svc.transport.connections()[0].client
    expect(registry.isClientAlive(ref)).toBe(true)

    // 注入传输的服务不挂到注册表：它的连接对注册表是陌生的
    const P2 = await freePort()
    settings.set('network.port', String(P2))
    const injected = makeService({}, fresh)
    await injected.init()
    await connect(P2)
    const injectedRef = injected.transport.connections()[0].client
    expect(registry.isClientAlive(injectedRef)).toBe(false)
  })
})

describe('NSV-15..NSV-17 退出与并发', () => {
  it("NSV-15 shutdown：1001 'ShuviX is quitting'；之后不再开始监听", async () => {
    const { appEventBus } = await import('../../../utils/appEventBus')
    const P = await freePort()
    enable(P)
    const svc = makeService()
    await svc.init()
    const client = await connect(P)
    await svc.shutdown()
    expect(await client.closed).toStrictEqual({ code: 1001, reason: 'ShuviX is quitting' })
    expect(svc.status().listening).toBe(false)
    await svc.reconcile()
    appEventBus.publish({ type: 'settings.changed', keys: ['network.enabled'] })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(svc.status().listening).toBe(false)
    expect(await canListen(P)).toBe(true)
  })

  it('NSV-16 两次并发对账 → 只启动一次', async () => {
    const P = await freePort()
    enable(P)
    const svc = makeService()
    await Promise.all([svc.reconcile(), svc.reconcile()])
    const status = svc.status()
    expect(status.listening).toBe(true)
    expect('error' in status).toBe(false)
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('NSV-17 readSetting 抛 → 对账照样 resolve；之后照常', async () => {
    const P = await freePort()
    enable(P)
    let broken = true
    const svc = makeService({
      readSetting: (k) => {
        if (broken) throw new Error('db locked')
        return settings.get(k)
      }
    })
    await expect(svc.reconcile()).resolves.toBeUndefined()
    broken = false
    await svc.reconcile()
    expect(svc.status().listening).toBe(true)
  })
})

describe('NSV-18 phase D 的路由', () => {
  it('NSV-18 init 不给路由 → 404；给了 → /lib 与 /w 接上；之后不带参数的 init 保留它们', async () => {
    const P = await freePort()
    enable(P)
    const svc = makeService()
    await svc.init()
    expect(await getPathStatus(P, '/lib/x')).toBe(404)
    expect(await getPathStatus(P, '/w/a-b/')).toBe(404)

    const readSandboxLib = vi.fn(async (_name: string) => Buffer.from('lib body'))
    const target = vi.fn(() => undefined)
    await svc.init({
      fileRoutes: { readSandboxLib, resolvePreviewPath: (_s, p) => p },
      widgetProxy: { target }
    })
    expect(await getPathStatus(P, '/lib/x')).toBe(200)
    expect(readSandboxLib).toHaveBeenCalledWith('x')
    expect(await getPathStatus(P, '/w/a-b/')).toBe(503)
    expect(target).toHaveBeenCalledTimes(1)

    await svc.init()
    expect(await getPathStatus(P, '/lib/x')).toBe(200)
    expect(await getPathStatus(P, '/w/a-b/')).toBe(503)
    expect(readSandboxLib).toHaveBeenCalledTimes(2)
    expect(target).toHaveBeenCalledTimes(2)
  })
})

describe('NSH 无头运行', () => {
  it('NSH-1 强制开着、端口固定、不读也不写 network.* 设置', async () => {
    const P = await freePort()
    const Q = await freePort()
    settings.set('network.port', String(Q))
    const readSetting = vi.fn((k: string) => settings.get(k))
    const svc = makeService({ readSetting })
    svc.setHeadless({ port: P })
    await svc.reconcile()
    // FAKE_IFACES 没有掩码 → 没有能挑的网络
    expect(svc.status()).toStrictEqual({
      enabled: true,
      port: P,
      admission: 'builtin',
      denials: [],
      listening: true,
      addresses: [`http://127.0.0.1:${P}`],
      clients: [],
      headless: true
    })
    expect(await getStatus(P)).toBe(200)
    expect(await canListen(Q)).toBe(true)
    expect(writes).toStrictEqual([])
    expect(readSetting.mock.calls.filter(([k]) => k.startsWith('network.'))).toStrictEqual([])
  })

  it("NSH-2 存着 network.enabled='false' 照样监听", async () => {
    const P = await freePort()
    settings.set('network.enabled', 'false')
    const svc = makeService()
    svc.setHeadless({ port: P })
    await svc.reconcile()
    expect(svc.status().listening).toBe(true)
    expect(await getStatus(P)).toBe(200)
  })

  it('NSH-3 setEnabled(false) 拒绝；不写；照样监听、客户端开着', async () => {
    const P = await freePort()
    const svc = makeService()
    svc.setHeadless({ port: P })
    await svc.reconcile()
    const client = await connect(P)
    const error = await svc.setEnabled(false).then(
      () => null,
      (e: unknown) => e as Error & { code?: string }
    )
    expect(error).not.toBeNull()
    expect(error!.code).toBe('headless')
    expect(error!.message).toContain('headless')
    expect(writes).toStrictEqual([])
    expect(svc.status().listening).toBe(true)
    expect(await getStatus(P)).toBe(200)
    expect(client.ws.readyState).toBe(WebSocket.OPEN)
  })

  it('NSH-4 setEnabled(true) 回状态；不写', async () => {
    const P = await freePort()
    const svc = makeService()
    svc.setHeadless({ port: P })
    await svc.reconcile()
    const status = await svc.setEnabled(true)
    expect(status.headless).toBe(true)
    expect(status.listening).toBe(true)
    expect(status.enabled).toBe(true)
    expect(writes).toStrictEqual([])
  })

  it("NSH-5 setEnabled('true') → 先校验", async () => {
    const svc = makeService()
    svc.setHeadless({ port: await freePort() })
    const error = await svc.setEnabled('true').then(
      () => null,
      (e: unknown) => e as Error & { code?: string }
    )
    expect(error?.message).toBe('enabled must be a boolean')
    expect(error?.code).toBeUndefined()
  })

  it('NSH-6 setPort：同一个端口回状态；换端口拒绝；不合法照旧那句', async () => {
    const P = await freePort()
    const other = await freePort()
    const svc = makeService()
    svc.setHeadless({ port: P })
    await svc.reconcile()
    const client = await connect(P)
    const same = await svc.setPort(P)
    expect(same.port).toBe(P)
    expect(same.headless).toBe(true)
    expect(writes).toStrictEqual([])

    const refused = await svc.setPort(other).then(
      () => null,
      (e: unknown) => e as Error & { code?: string }
    )
    expect(refused?.code).toBe('headless')
    expect(svc.status().port).toBe(P)
    expect(svc.status().listening).toBe(true)
    expect(await getStatus(P)).toBe(200)
    await expect(getStatus(other)).rejects.toMatchObject({ code: 'ECONNREFUSED' })
    expect(client.ws.readyState).toBe(WebSocket.OPEN)

    for (const bad of [1023, '7766']) {
      const error = await svc.setPort(bad).then(
        () => null,
        (e: unknown) => e as Error & { code?: string }
      )
      expect(error?.message).toBe('The port must be an integer between 1024 and 65535.')
      expect(error?.code).not.toBe('headless')
    }
    expect(writes).toStrictEqual([])
  })

  it('NSH-7 设置里关掉 / 换端口：照样在 P、客户端开着、changed 没多', async () => {
    const { appEventBus } = await import('../../../utils/appEventBus')
    const P = await freePort()
    const other = await freePort()
    const svc = makeService()
    svc.setHeadless({ port: P })
    await svc.init()
    const client = await connect(P)
    await vi.waitFor(() => expect(svc.status().clients).toHaveLength(1))
    const before = changed.mock.calls.length

    settings.set('network.enabled', 'false')
    appEventBus.publish({ type: 'settings.changed', keys: ['network.enabled'] })
    await svc.reconcile()
    settings.set('network.port', String(other))
    appEventBus.publish({ type: 'settings.changed', keys: ['network.port'] })
    await svc.reconcile()

    expect(svc.status().listening).toBe(true)
    expect(svc.status().port).toBe(P)
    expect(await getStatus(P)).toBe(200)
    expect(client.ws.readyState).toBe(WebSocket.OPEN)
    expect(changed.mock.calls.length).toBe(before)
  })

  it('NSH-8 端口被占：对账照样 resolve；状态带原因；空出来再对账 → 监听', async () => {
    const P = await freePort()
    const blocker = await occupy(P)
    const svc = makeService()
    svc.setHeadless({ port: P })
    await expect(svc.reconcile()).resolves.toBeUndefined()
    const status = svc.status()
    expect(status.listening).toBe(false)
    expect(status.error).toBe('EADDRINUSE')
    expect(status.addresses).toStrictEqual([])
    expect(status.headless).toBe(true)
    expect(status.enabled).toBe(true)

    await release(blocker)
    await svc.reconcile()
    expect(svc.status().listening).toBe(true)
    expect('error' in svc.status()).toBe(false)
  })

  it('NSH-9 setHeadless 的端口不合法 → 抛；之后没有 headless 键', () => {
    const svc = makeService()
    for (const bad of [1023, 65536, 1.5, NaN]) {
      expect(() => svc.setHeadless({ port: bad }), String(bad)).toThrow(
        'The port must be an integer between 1024 and 65535.'
      )
    }
    expect('headless' in svc.status()).toBe(false)
  })

  it('NSH-10 桌面模式没有 headless 键', () => {
    expect('headless' in makeService().status()).toBe(false)
  })

  it('NSH-11 对账之前的状态', async () => {
    const P = await freePort()
    const svc = makeService()
    svc.setHeadless({ port: P })
    // FAKE_IFACES 没有掩码 → 没有能挑的网络
    expect(svc.status()).toStrictEqual({
      enabled: true,
      port: P,
      admission: 'builtin',
      denials: [],
      listening: false,
      addresses: [],
      clients: [],
      headless: true
    })
  })

  it("NSH-12 无头的 shutdown：1001 'ShuviX is quitting'、端口放开、之后不再开始监听", async () => {
    const P = await freePort()
    const svc = makeService()
    svc.setHeadless({ port: P })
    await svc.init()
    const client = await connect(P)
    await svc.shutdown()
    expect(await client.closed).toStrictEqual({ code: 1001, reason: 'ShuviX is quitting' })
    expect(await canListen(P)).toBe(true)
    await svc.reconcile()
    expect(svc.status().listening).toBe(false)
    expect(await canListen(P)).toBe(true)
  })
})

// ─────────────────────────── 安全策略（NSP） ───────────────────────────

const allowed = (): GateVerdict => ({
  allowed: true,
  downgraded: false,
  decision: { effect: 'allow', tier: 'default', matched: [], winning: 'default:x' }
})

const denied = (message = 'Go away.'): GateVerdict => ({
  allowed: false,
  downgraded: false,
  message,
  decision: {
    effect: 'deny',
    tier: 'deny',
    matched: ['p#0'],
    winning: 'p#0',
    prompt: { text: message, rules: ['p#0'], policies: ['P'] }
  }
})

type Decide = (subject: SecuritySubject, action: string, object: SecurityObject) => GateVerdict

/** 假的策略那一侧：判定交给 decide（可以中途换），其余记下 */
function fakeSecurity(
  initial: Decide = () => allowed(),
  over: Partial<ServiceModule.NetworkSecurityDeps> = {}
): ServiceModule.NetworkSecurityDeps & {
  decide: Decide
  refreshes: number
  created: string[]
} {
  const security = {
    decide: initial,
    refreshes: 0,
    created: [] as string[],
    contextFor: (subject: SecuritySubject) => ({
      judgeGate: (action: string, object: SecurityObject) =>
        security.decide(subject, action, object)
    }),
    admission: () => 'builtin' as const,
    refreshPolicies: () => {
      security.refreshes++
    },
    hasUserAdmission: () => false,
    createPolicy: (text: string) => {
      security.created.push(text)
      return { success: true }
    },
    ...over
  }
  return security
}

function getWithHeaders(
  port: number,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: string; setCookie: string[] }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path: '/', agent: false, headers },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => (body += chunk))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body, setCookie: res.headers['set-cookie'] ?? [] })
        )
      }
    )
    req.on('error', reject)
    req.end()
  })
}

const DEVICE = 'AAAAAAAAAAAAAAAAAAAAAA'

describe('NSP 安全策略', () => {
  it('NSP-1 没接策略：builtin、没有拒绝、只列 127.0.0.1；发设备 cookie，带着再来不再发；客户端带设备 ID', async () => {
    const P = await freePort()
    enable(P)
    const svc = makeService()
    await svc.reconcile()
    const status = svc.status()
    expect(status.admission).toBe('builtin')
    expect(status.denials).toEqual([])
    expect(status.addresses).toEqual([`http://127.0.0.1:${P}`])
    const first = await getWithHeaders(P)
    expect(first.status).toBe(200)
    expect(first.setCookie).toHaveLength(1)
    expect(first.setCookie[0]).toMatch(
      /^shuvix_device=[A-Za-z0-9_-]{22}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+$/
    )
    const again = await getWithHeaders(P, { cookie: `x=1; shuvix_device=${DEVICE}` })
    expect(again.setCookie).toEqual([])
    const ws = new WebSocket(`ws://127.0.0.1:${P}/ws`, {
      origin: `http://127.0.0.1:${P}`,
      headers: { cookie: `shuvix_device=${DEVICE}` }
    })
    sockets.push(ws)
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
    })
    await vi.waitFor(() => expect(svc.status().clients.map((c) => c.device)).toEqual([DEVICE]))
  })

  it('NSP-2 request 被拒 → 403，正文有规则的话、设备与地址；拒绝记录一条，同样的再来合并', async () => {
    const P = await freePort()
    enable(P)
    const security = fakeSecurity((_s, _a, object) =>
      object.type === 'request' && object.route === 'page' ? denied('Not you.') : allowed()
    )
    const svc = makeService()
    await svc.init({ security })
    const res = await getWithHeaders(P, { cookie: `shuvix_device=${DEVICE}` })
    expect(res.status).toBe(403)
    expect(res.body).toContain('Not you.')
    expect(res.body).toContain(`Device: ${DEVICE}`)
    expect(res.body).toContain('Address: 127.0.0.1')
    await getWithHeaders(P, { cookie: `shuvix_device=${DEVICE}` })
    const denials = svc.status().denials
    expect(denials).toHaveLength(1)
    expect(denials[0]).toMatchObject({
      stage: 'request',
      summary: 'GET /',
      address: '127.0.0.1',
      device: DEVICE,
      rule: 'p#0',
      policies: ['P'],
      count: 2,
      downgraded: false
    })
  })

  it('NSP-3 socket 被拒 → 连接直接断开', async () => {
    const P = await freePort()
    enable(P)
    const svc = makeService()
    await svc.init({
      security: fakeSecurity((_s, _a, object) => (object.type === 'socket' ? denied() : allowed()))
    })
    await expect(getStatus(P)).rejects.toThrow()
    expect(svc.status().denials[0]).toMatchObject({ stage: 'socket' })
  })

  it('NSP-4 升级被拒 → 403', async () => {
    const P = await freePort()
    enable(P)
    const svc = makeService()
    await svc.init({
      security: fakeSecurity((_s, _a, object) =>
        object.type === 'request' && object.route === 'socket' ? denied() : allowed()
      )
    })
    expect(await getStatus(P)).toBe(200)
    expect(await upgradeStatus(P)).toBe(403)
  })

  it('NSP-5 policy.changed：按升级时的事实重判，新被拒的以 1008 断开', async () => {
    const P = await freePort()
    enable(P)
    const security = fakeSecurity()
    const svc = makeService()
    await svc.init({ security })
    const client = await connect(P)
    security.decide = (subject, _a, object) =>
      object.type === 'request' &&
      object.route === 'socket' &&
      subject.attrs?.address === '127.0.0.1'
        ? denied('Policy changed.')
        : allowed()
    const { appEventBus } = await import('../../../utils/appEventBus')
    appEventBus.publish({ type: 'policy.changed' })
    expect(await client.closed).toEqual({ code: 1008, reason: 'Policy changed.' })
  })

  it('NSP-6 监听时定时核策略目录；关掉之后不再核', async () => {
    const P = await freePort()
    enable(P)
    const security = fakeSecurity()
    const svc = makeService({ policyRefreshMs: 10 })
    await svc.init({ security })
    await vi.waitFor(() => expect(security.refreshes).toBeGreaterThanOrEqual(2))
    await svc.setEnabled(false)
    const after = security.refreshes
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(security.refreshes).toBe(after)
  })

  it('NSP-7 admission 由策略那一侧给：override / disabled 时列每个私有接口', async () => {
    for (const admission of ['override', 'disabled'] as const) {
      const P = await freePort()
      enable(P)
      const svc = makeService()
      await svc.init({ security: fakeSecurity(undefined, { admission: () => admission }) })
      const status = svc.status()
      expect(status.admission).toBe(admission)
      expect(status.addresses).toEqual(mod.listenAddresses(P, FAKE_IFACES))
      await svc.shutdown()
    }
  })

  it('NSP-8 迁移（桌面）：开过局域网共享 → 写一份 network-admission、删掉旧键', async () => {
    settings.set('network.lan', 'true')
    const security = fakeSecurity()
    await makeService().init({ security })
    expect(security.created).toHaveLength(1)
    expect(security.created[0]).toContain('name: network-admission')
    expect(security.created[0]).toContain('shuvix-policy-rules: []')
    expect(removes.sort()).toEqual(['network.lan'])

    // 还指定了网络：按那块网卡的网段写
    settings.clear()
    removes = []
    settings.set('network.lan', 'true')
    settings.set('network.lanInterface', 'eth1')
    const scoped = fakeSecurity()
    await makeService({ interfaces: () => SCOPED_IFACES }).init({ security: scoped })
    expect(scoped.created).toHaveLength(1)
    expect(scoped.created[0]).toContain("'192.168.50.10/24'")
    expect(removes.sort()).toEqual(['network.lan', 'network.lanInterface'])

    // 已有同名用户策略：不写，照样删键
    settings.clear()
    removes = []
    settings.set('network.lan', 'true')
    const existing = fakeSecurity(undefined, { hasUserAdmission: () => true })
    await makeService().init({ security: existing })
    expect(existing.created).toEqual([])
    expect(removes).toEqual(['network.lan'])

    // 没开局域网共享：不写；留着的 'false' 照样删
    settings.clear()
    removes = []
    settings.set('network.lan', 'false')
    const off = fakeSecurity()
    await makeService().init({ security: off })
    expect(off.created).toEqual([])
    expect(removes).toEqual(['network.lan'])

    // 没接策略：什么也不动
    settings.clear()
    removes = []
    settings.set('network.lan', 'true')
    await makeService().init()
    expect(removes).toEqual([])
    expect(settings.get('network.lan')).toBe('true')
  })

  it('NSP-9 迁移（无头）：--lan / --bind 同样写；不删设置', async () => {
    settings.set('network.lan', 'true')
    const lan = fakeSecurity()
    const svc = makeService()
    svc.setHeadless({ port: await freePort(), lan: true })
    await svc.init({ security: lan })
    expect(lan.created).toHaveLength(1)
    expect(lan.created[0]).toContain('shuvix-policy-rules: []')
    expect(removes).toEqual([])

    const bind = fakeSecurity()
    const scoped = makeService({ interfaces: () => SCOPED_IFACES })
    scoped.setHeadless({ port: await freePort(), bind: 'eth1' })
    await scoped.init({ security: bind })
    expect(bind.created[0]).toContain("'192.168.50.10/24'")

    const none = fakeSecurity()
    const plain = makeService()
    plain.setHeadless({ port: await freePort() })
    await plain.init({ security: none })
    expect(none.created).toEqual([])
  })
})
