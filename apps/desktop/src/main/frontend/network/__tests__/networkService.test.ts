/**
 * `frontend/network/index.ts` —— 网络访问服务（server mode phase B §B1）：按设置对账（开 → 监听、关 → 停止并断开、换端口 →
 * 先断开再换）、状态、写设置的两个入口、连接注册成聊天前端、跟着 `settings.changed` 走、退出。服务绑 127.0.0.1，网卡是假的；
 * 设置读写走注入的 Map；`network.changed` 是 spy。logger / settingsDao / settingsService / chatFrontendRegistry / 视图同步接线
 * 是替身，appEventBus 是真的。NSV-14 `vi.resetModules()` 后重新导入（注册表有模块级状态）。
 *
 *   LA-1  listenAddresses：每个非内部、私有的 IPv4 接口一条（数字 family 也认、去重），外加 127.0.0.1（phase D：不再是 localhost）；空表 → 只有 127.0.0.1
 *   LA-2  公网地址与 CGNAT（100.64/10）不列；172.16/12 与 169.254/16 列
 *   NSV-1 关着：status 恰是 {enabled:false, port:7766, listening:false, addresses:[], clients:[]}（没有 error 键）；对账不发 changed
 *   NSV-2 开着：对账 → 在 P 上监听，status 带地址；changed 一次；GET / → 200
 *   NSV-3 设置没变再对账：不重启（客户端还开着），不再发 changed
 *   NSV-4 换端口：客户端以 1001 'network port changed' 断开；旧端口不再服务、新端口服务；changed 恰 +2；unregister 调到
 *   NSV-5 关掉：客户端 1001 'network access turned off'；端口放开；listening false、地址空；changed +2；unregister 调到
 *   NSV-6 端口被占：对账从不拒绝；listening false、error 'EADDRINUSE'、地址空；changed +1；端口空出来再对账 → 监听、没有 error
 *   NSV-7 出错又从没监听过时关掉 → changed +1、error 清掉；关着、没出错、没监听 → 对账什么也不发
 *   NSV-8 setEnabled：写 'true' / 'false'，回改完之后的状态；非布尔 → 拒绝 'enabled must be a boolean'，什么也不写
 *   NSV-9 setPort：1024 / 65535 写成字符串、状态的端口跟着变；不合法 → 拒绝（固定的一句话），什么也不写
 *   NSV-10 存着的端口 'abc' → status().port === 7766
 *   NSV-11 客户端列表：id / remoteAddress / userAgent / connectedAt；断开之后为空
 *   NSV-12 连上：registerDefault 收到 id 'network:'+clientId、userInput 的前端；连上与断开各发一次 changed
 *   NSV-13 init（注入传输）：registerViewAuthorizer('network', fn) 且 fn() 为真；settings.changed 只在 keys 缺失或含
 *          network.* 时对账；init 两次只订阅、登记一次
 *   NSV-14 init 不注入传输：传输挂到注册表（isClientAlive 认得连着的客户端）；第二次 init 不抛；注入传输时不挂（测试接缝）
 *   NSV-15 shutdown：客户端 1001 'ShuviX is quitting'；之后对账 / settings.changed 都不再开始监听
 *   NSV-16 开着时两次并发对账 → 只启动一次（status 没有 error）
 *   NSV-17 readSetting 抛 → 对账照样 resolve；之后读得出来的对账照常开始监听
 *   NSV-18 phase D 的路由由 init 交进来：不给 → `/lib/x` 404；给了 fileRoutes / widgetProxy → `/lib/x` 200（读取收到
 *          'x'）、`/w/a-b/` 503（widget 服务没在跑）；之后不带参数的 init 不清掉已经交进来的路由
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir, type NetworkInterfaceInfo, type networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
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

let mod: typeof ServiceModule
let tmp: string
let settings: Map<string, string>
let writes: Array<[string, string]>
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
    expect(svc.status()).toStrictEqual({
      enabled: true,
      port: P,
      listening: true,
      addresses: mod.listenAddresses(P, FAKE_IFACES),
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
