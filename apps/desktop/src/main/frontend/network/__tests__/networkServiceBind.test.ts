/**
 * `frontend/network/index.ts` —— 网络服务**绑哪个地址**（局域网开关，2026-10-14）。服务**不给** `host`（产品的缺省路径），
 * `../server` 换成假的：只记 `start(port, host)` / `stop(reason)`，`port` / `host` 跟着最后一次 start 走 —— 单测从不真的
 * 绑 0.0.0.0（那会把测试机暴露到局域网上，macOS 还会为 node 弹防火墙框）。真的 0.0.0.0 在 e2e 里证。
 * logger / settingsDao / settingsService / chatFrontendRegistry / 视图同步接线是替身（与 networkService.test.ts 同一套）。
 *
 *   NSL-13a 局域网关 → start(P,'127.0.0.1')，bindAddress '127.0.0.1'
 *   NSL-13b setLan(true) → stop('network sharing changed') 再 start(P,'0.0.0.0')，bindAddress '0.0.0.0'
 *   NSL-13c 局域网开着换端口 → stop('network port changed') 再 start(P2,'0.0.0.0')
 *   NSL-13d 无头：setHeadless({port:P}) → start(P,'127.0.0.1')；setHeadless({port:P, lan:true}) → start(P,'0.0.0.0')
 *   NSL-13e start 抛 {code:'EADDRINUSE'} → error 记下、没有 bindAddress
 *
 * 只开放给一个网络（`network.lanInterface` / 无头的 `bind`，2026-10-15）。网卡表可变（`ifaces`：eth0 10.0.0.5/24、
 * eth1 192.168.50.10/24），假服务记下服务交给它的依赖（`fake.deps`，对端那道附加门 `acceptPeer` 从这里取）：
 *   NSL-14a 局域网开 + 'eth1' → 恰 start(P,'192.168.50.10')；状态 bindAddress / lanNetwork（恰三项）/ lanInterface / 地址只有那一个
 *   NSL-14b 存的是地址 '10.0.0.5' → start(P,'10.0.0.5')，lanNetwork.interface 'eth0'
 *   NSL-14c 'eth9' 找不到 → 不 start（更不退回 0.0.0.0）、error ENOINTERFACE、没在监听、没有 bindAddress / lanNetwork、
 *           地址空、lanInterface 'eth9'
 *   NSL-14d 在 eth1 上监听时 eth1 没了 → 恰 stop('the network it was shared on is gone')、ENOINTERFACE；回来 → 再 start、error 清掉
 *   NSL-14e eth1 换了地址 → stop('network sharing changed') + start 新地址；再对账不动；地址不变、掩码变了（B9）→ 也重启
 *   NSL-14f setLanInterface('eth0') → stop + start(P,'10.0.0.5')；null / '' → start(P,'0.0.0.0')、写 ''
 *   NSL-14g 局域网关 + 存着 'eth9' → start(P,'127.0.0.1')、没有 error、lanInterface 'eth9'、没有 lanNetwork；局域网关时
 *           setLanInterface('eth1') 不重启
 *   NSL-14h 局域网开在 eth1 → setLan(false) → 127.0.0.1 → setLan(true) → 回到 192.168.50.10（不是 0.0.0.0）
 *   NSL-14i 存着不合法的 'eth1;x'（B8）→ 不 start、ENOINTERFACE、lanInterface 'eth1;x'（宁可关着）
 *   NSL-14j 无头：bind 'eth1'（lan:false 也一样）→ start(P,'192.168.50.10')、lan / headless、lanInterface；不给 bind → 存着的
 *           lan / lanInterface 都不算（127.0.0.1，没有 lanInterface）；lan:true → 0.0.0.0
 *   NSL-14k 无头 bind 'eth9' → 不 start、ENOINTERFACE、enabled / lan / headless；bind 'a b' / 'fe80::1%eth0' → 抛固定那句、之后
 *           没有 headless；端口不合法先报端口
 *   NSL-14l acceptPeer：没在监听 → 一律放行；在 eth1 上 → 只放 192.168.50.0/24（含映射写法）；回到所有网络 → 放行；
 *           ENOINTERFACE 之后 → 放行（反正没在监听）
 *   NSL-14m status().lanCandidates 恰是 eth0、eth1 两项；关着、无头、对账之前都有
 *   NSL-14n 已经 ENOINTERFACE 且没在监听：再对账两次 → 不再发 network.changed（B10）
 */
import type { NetworkInterfaceInfo, networkInterfaces } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNetworkTransport } from '../transport'
import type * as ServiceModule from '../index'

type Call = ['start', number, string | undefined] | ['stop', string | undefined]

const fake = vi.hoisted(() => ({
  calls: [] as Call[],
  /** 下一次 start 抛它（抛一次就清掉） */
  failNext: undefined as unknown,
  /** 最近一次 createNetworkServer 收到的依赖 */
  deps: undefined as { acceptPeer?: (address: string) => boolean } | undefined
}))

vi.mock('../server', () => ({
  createNetworkServer: (deps: { acceptPeer?: (address: string) => boolean }) => {
    fake.deps = deps
    let port: number | undefined
    let host: string | undefined
    return {
      async start(p: number, h?: string): Promise<number> {
        fake.calls.push(['start', p, h])
        if (fake.failNext !== undefined) {
          const error = fake.failNext
          fake.failNext = undefined
          throw error
        }
        port = p
        host = h
        return p
      },
      async stop(reason?: string): Promise<void> {
        fake.calls.push(['stop', reason])
        port = undefined
        host = undefined
      },
      get port(): number | undefined {
        return port
      },
      get host(): string | undefined {
        return host
      }
    }
  }
}))
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
}))
vi.mock('../../../dao/settingsDao', () => ({ settingsDao: { findByKey: vi.fn() } }))
vi.mock('../../../services/settingsService', () => ({ settingsService: { set: vi.fn() } }))
vi.mock('../../core', () => ({
  chatFrontendRegistry: { registerDefault: vi.fn(), unregister: vi.fn() }
}))
vi.mock('../../sync/syncWiring', () => ({
  getSyncHub: () => ({ accept: vi.fn() }),
  registerViewAuthorizer: vi.fn()
}))

const P = 18123
const P2 = 18124

type Interfaces = ReturnType<typeof networkInterfaces>

function v4(address: string, netmask: string, prefix: number): NetworkInterfaceInfo {
  return {
    address,
    netmask,
    family: 'IPv4',
    mac: '00:00:00:00:00:00',
    internal: false,
    cidr: `${address}/${prefix}`
  } as NetworkInterfaceInfo
}

const ETH0 = v4('10.0.0.5', '255.255.255.0', 24)
const ETH1 = v4('192.168.50.10', '255.255.255.0', 24)
const ETH1_INFO = { interface: 'eth1', address: '192.168.50.10', cidr: '192.168.50.10/24' }
const ETH0_INFO = { interface: 'eth0', address: '10.0.0.5', cidr: '10.0.0.5/24' }

let mod: typeof ServiceModule
let settings: Map<string, string>
let writes: Array<[string, string]>
let changed: ReturnType<typeof vi.fn<() => void>>
let ifaces: Interfaces
let services: ServiceModule.NetworkService[]

beforeEach(async () => {
  mod = await import('../index')
  fake.calls.length = 0
  fake.failNext = undefined
  fake.deps = undefined
  settings = new Map()
  writes = []
  changed = vi.fn()
  ifaces = { eth0: [ETH0], eth1: [ETH1] }
  services = []
})

afterEach(async () => {
  for (const svc of services) await svc.shutdown()
})

/** 不给 host：绑的地址由局域网开关决定（产品的缺省路径） */
function makeService(): ServiceModule.NetworkService {
  const svc = new mod.NetworkService({
    readSetting: (k) => settings.get(k),
    writeSetting: (k, v) => {
      writes.push([k, v])
      settings.set(k, v)
    },
    rendererDir: () => '/nonexistent',
    interfaces: () => ifaces,
    publishChanged: changed,
    transport: createNetworkTransport()
  })
  services.push(svc)
  return svc
}

function enable(port: number): void {
  settings.set('network.enabled', 'true')
  settings.set('network.port', String(port))
}

/** 开着、局域网开、只开放给 `scope` */
function enableScoped(port: number, scope: string): void {
  enable(port)
  settings.set('network.lan', 'true')
  settings.set('network.lanInterface', scope)
}

function acceptPeer(address: string): boolean {
  const gate = fake.deps?.acceptPeer
  if (gate === undefined) throw new Error('the service gave the server no acceptPeer')
  return gate(address)
}

describe('NSL-13 绑的地址', () => {
  it('NSL-13a 局域网关 → 127.0.0.1', async () => {
    enable(P)
    const svc = makeService()
    await svc.reconcile()
    expect(fake.calls).toStrictEqual([['start', P, '127.0.0.1']])
    expect(svc.status().bindAddress).toBe('127.0.0.1')
    expect(svc.status().lan).toBe(false)
  })

  it("NSL-13b setLan(true) → 先停（'network sharing changed'）再绑 0.0.0.0", async () => {
    enable(P)
    const svc = makeService()
    await svc.reconcile()
    fake.calls.length = 0
    const status = await svc.setLan(true)
    expect(fake.calls).toStrictEqual([
      ['stop', 'network sharing changed'],
      ['start', P, '0.0.0.0']
    ])
    expect(status.bindAddress).toBe('0.0.0.0')
    expect(status.lan).toBe(true)

    fake.calls.length = 0
    const back = await svc.setLan(false)
    expect(fake.calls).toStrictEqual([
      ['stop', 'network sharing changed'],
      ['start', P, '127.0.0.1']
    ])
    expect(back.bindAddress).toBe('127.0.0.1')
  })

  it("NSL-13c 局域网开着换端口 → 'network port changed'，新端口照样绑 0.0.0.0", async () => {
    enable(P)
    settings.set('network.lan', 'true')
    const svc = makeService()
    await svc.reconcile()
    expect(fake.calls).toStrictEqual([['start', P, '0.0.0.0']])
    fake.calls.length = 0
    const status = await svc.setPort(P2)
    expect(fake.calls).toStrictEqual([
      ['stop', 'network port changed'],
      ['start', P2, '0.0.0.0']
    ])
    expect(status.bindAddress).toBe('0.0.0.0')
    expect(status.port).toBe(P2)
  })

  it('NSL-13d 无头：缺省 127.0.0.1，--lan → 0.0.0.0（存着的局域网开关不算）', async () => {
    settings.set('network.lan', 'true')
    const local = makeService()
    local.setHeadless({ port: P })
    await local.reconcile()
    expect(fake.calls).toStrictEqual([['start', P, '127.0.0.1']])
    expect(local.status().bindAddress).toBe('127.0.0.1')

    fake.calls.length = 0
    settings.set('network.lan', 'false')
    const shared = makeService()
    shared.setHeadless({ port: P, lan: true })
    await shared.reconcile()
    expect(fake.calls).toStrictEqual([['start', P, '0.0.0.0']])
    expect(shared.status().bindAddress).toBe('0.0.0.0')
  })

  it("NSL-13e start 抛 {code:'EADDRINUSE'} → error 记下、没有 bindAddress", async () => {
    enable(P)
    settings.set('network.lan', 'true')
    fake.failNext = Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' })
    const svc = makeService()
    await expect(svc.reconcile()).resolves.toBeUndefined()
    expect(fake.calls).toStrictEqual([['start', P, '0.0.0.0']])
    const status = svc.status()
    expect(status.error).toBe('EADDRINUSE')
    expect(status.listening).toBe(false)
    expect('bindAddress' in status).toBe(false)
  })
})

describe('NSL-14 只开放给一个网络', () => {
  it('NSL-14a 局域网开 + eth1 → 只在 eth1 的地址上监听', async () => {
    enableScoped(P, 'eth1')
    const svc = makeService()
    await svc.reconcile()
    expect(fake.calls).toStrictEqual([['start', P, '192.168.50.10']])
    const status = svc.status()
    expect(status.bindAddress).toBe('192.168.50.10')
    expect(status.lanNetwork).toStrictEqual(ETH1_INFO)
    expect(status.lanInterface).toBe('eth1')
    expect(status.lan).toBe(true)
    expect(status.listening).toBe(true)
    expect(status.addresses).toStrictEqual([`http://192.168.50.10:${P}`])
    expect('error' in status).toBe(false)
  })

  it('NSL-14b 存的是地址 → 绑那个地址，网络是它所在的网卡', async () => {
    enableScoped(P, '10.0.0.5')
    const svc = makeService()
    await svc.reconcile()
    expect(fake.calls).toStrictEqual([['start', P, '10.0.0.5']])
    const status = svc.status()
    expect(status.lanNetwork?.interface).toBe('eth0')
    expect(status.lanNetwork).toStrictEqual(ETH0_INFO)
    expect(status.lanInterface).toBe('10.0.0.5')
  })

  it('NSL-14c 找不到的网卡 → 不监听（不退回所有网络）', async () => {
    enableScoped(P, 'eth9')
    const svc = makeService()
    await expect(svc.reconcile()).resolves.toBeUndefined()
    expect(fake.calls).toStrictEqual([])
    const status = svc.status()
    expect(status.error).toBe('ENOINTERFACE')
    expect(status.listening).toBe(false)
    expect('bindAddress' in status).toBe(false)
    expect('lanNetwork' in status).toBe(false)
    expect(status.addresses).toStrictEqual([])
    expect(status.lanInterface).toBe('eth9')
    expect(status.enabled).toBe(true)
    expect(status.lan).toBe(true)
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('NSL-14d 网卡没了 → 停下、ENOINTERFACE；回来 → 再监听、error 清掉', async () => {
    enableScoped(P, 'eth1')
    const svc = makeService()
    await svc.reconcile()
    fake.calls.length = 0
    ifaces = { eth0: [ETH0] }
    await svc.reconcile()
    expect(fake.calls).toStrictEqual([['stop', 'the network it was shared on is gone']])
    const gone = svc.status()
    expect(gone.error).toBe('ENOINTERFACE')
    expect(gone.listening).toBe(false)
    expect('lanNetwork' in gone).toBe(false)
    expect('bindAddress' in gone).toBe(false)

    fake.calls.length = 0
    ifaces = { eth0: [ETH0], eth1: [ETH1] }
    await svc.reconcile()
    expect(fake.calls).toStrictEqual([['start', P, '192.168.50.10']])
    const back = svc.status()
    expect('error' in back).toBe(false)
    expect(back.listening).toBe(true)
    expect(back.lanNetwork).toStrictEqual(ETH1_INFO)
  })

  it('NSL-14e 网卡换了地址 / 换了掩码 → 重启到新的网段；没变 → 不动', async () => {
    enableScoped(P, 'eth1')
    const svc = makeService()
    await svc.reconcile()
    fake.calls.length = 0
    ifaces = { eth0: [ETH0], eth1: [v4('192.168.50.11', '255.255.255.0', 24)] }
    await svc.reconcile()
    expect(fake.calls).toStrictEqual([
      ['stop', 'network sharing changed'],
      ['start', P, '192.168.50.11']
    ])
    expect(svc.status().lanNetwork?.address).toBe('192.168.50.11')

    fake.calls.length = 0
    await svc.reconcile()
    expect(fake.calls).toStrictEqual([])

    // B9：地址不变、前缀变了 → 也重启（对端那道门按新网段核）
    ifaces = { eth0: [ETH0], eth1: [v4('192.168.50.11', '255.255.0.0', 16)] }
    await svc.reconcile()
    expect(fake.calls).toStrictEqual([
      ['stop', 'network sharing changed'],
      ['start', P, '192.168.50.11']
    ])
    expect(svc.status().lanNetwork).toStrictEqual({
      interface: 'eth1',
      address: '192.168.50.11',
      cidr: '192.168.50.11/16'
    })
  })

  it("NSL-14f setLanInterface：换网卡重启；null / '' → 所有网络、写 ''", async () => {
    enableScoped(P, 'eth1')
    const svc = makeService()
    await svc.reconcile()
    fake.calls.length = 0
    const onEth0 = await svc.setLanInterface('eth0')
    expect(writes).toStrictEqual([['network.lanInterface', 'eth0']])
    expect(fake.calls).toStrictEqual([
      ['stop', 'network sharing changed'],
      ['start', P, '10.0.0.5']
    ])
    expect(onEth0.lanNetwork).toStrictEqual(ETH0_INFO)
    expect(onEth0.bindAddress).toBe('10.0.0.5')

    fake.calls.length = 0
    const all = await svc.setLanInterface(null)
    expect(writes.at(-1)).toStrictEqual(['network.lanInterface', ''])
    expect(fake.calls).toStrictEqual([
      ['stop', 'network sharing changed'],
      ['start', P, '0.0.0.0']
    ])
    expect(all.bindAddress).toBe('0.0.0.0')
    expect('lanInterface' in all).toBe(false)
    expect('lanNetwork' in all).toBe(false)

    await svc.setLanInterface('eth1')
    fake.calls.length = 0
    const emptied = await svc.setLanInterface('')
    expect(writes.at(-1)).toStrictEqual(['network.lanInterface', ''])
    expect(fake.calls).toStrictEqual([
      ['stop', 'network sharing changed'],
      ['start', P, '0.0.0.0']
    ])
    expect(emptied.bindAddress).toBe('0.0.0.0')
    expect('lanInterface' in emptied).toBe(false)
  })

  it('NSL-14g 局域网关着：存着的网卡不看（127.0.0.1、没有 error）；换网卡不重启', async () => {
    enableScoped(P, 'eth9')
    settings.set('network.lan', 'false')
    const svc = makeService()
    await svc.reconcile()
    expect(fake.calls).toStrictEqual([['start', P, '127.0.0.1']])
    const status = svc.status()
    expect('error' in status).toBe(false)
    expect(status.lan).toBe(false)
    expect(status.lanInterface).toBe('eth9')
    expect('lanNetwork' in status).toBe(false)
    expect(status.bindAddress).toBe('127.0.0.1')

    fake.calls.length = 0
    const after = await svc.setLanInterface('eth1')
    expect(writes).toStrictEqual([['network.lanInterface', 'eth1']])
    expect(fake.calls).toStrictEqual([])
    expect(after.bindAddress).toBe('127.0.0.1')
    expect(after.lanInterface).toBe('eth1')
  })

  it('NSL-14h 局域网关了再开 → 回到 eth1，不是 0.0.0.0', async () => {
    enableScoped(P, 'eth1')
    const svc = makeService()
    await svc.reconcile()
    fake.calls.length = 0
    const off = await svc.setLan(false)
    expect(fake.calls).toStrictEqual([
      ['stop', 'network sharing changed'],
      ['start', P, '127.0.0.1']
    ])
    expect('lanNetwork' in off).toBe(false)
    fake.calls.length = 0
    const on = await svc.setLan(true)
    expect(fake.calls).toStrictEqual([
      ['stop', 'network sharing changed'],
      ['start', P, '192.168.50.10']
    ])
    expect(on.lanNetwork).toStrictEqual(ETH1_INFO)
  })

  it("NSL-14i 存着不合法的 'eth1;x' → 不监听、ENOINTERFACE（宁可关着）", async () => {
    enableScoped(P, 'eth1;x')
    const svc = makeService()
    await svc.reconcile()
    expect(fake.calls).toStrictEqual([])
    const status = svc.status()
    expect(status.error).toBe('ENOINTERFACE')
    expect(status.listening).toBe(false)
    expect(status.lanInterface).toBe('eth1;x')
    expect('bindAddress' in status).toBe(false)
  })

  it('NSL-14j 无头：bind 定网络；不给 bind 时存着的设置不算', async () => {
    const bound = makeService()
    bound.setHeadless({ port: P, lan: false, bind: 'eth1' })
    await bound.reconcile()
    expect(fake.calls).toStrictEqual([['start', P, '192.168.50.10']])
    const status = bound.status()
    expect(status.lan).toBe(true)
    expect(status.headless).toBe(true)
    expect(status.enabled).toBe(true)
    expect(status.lanInterface).toBe('eth1')
    expect(status.lanNetwork).toStrictEqual(ETH1_INFO)
    await bound.shutdown()

    fake.calls.length = 0
    settings.set('network.lan', 'true')
    settings.set('network.lanInterface', 'eth0')
    const local = makeService()
    local.setHeadless({ port: P })
    await local.reconcile()
    expect(fake.calls).toStrictEqual([['start', P, '127.0.0.1']])
    expect('lanInterface' in local.status()).toBe(false)
    expect('lanNetwork' in local.status()).toBe(false)
    await local.shutdown()

    fake.calls.length = 0
    const shared = makeService()
    shared.setHeadless({ port: P, lan: true })
    await shared.reconcile()
    expect(fake.calls).toStrictEqual([['start', P, '0.0.0.0']])
    expect('lanInterface' in shared.status()).toBe(false)
  })

  it('NSL-14k 无头 bind 找不到 → 不监听；不合法 → 抛；端口先校验', async () => {
    const missing = makeService()
    missing.setHeadless({ port: P, bind: 'eth9' })
    await missing.reconcile()
    expect(fake.calls).toStrictEqual([])
    const status = missing.status()
    expect(status.error).toBe('ENOINTERFACE')
    expect(status.listening).toBe(false)
    expect(status.enabled).toBe(true)
    expect(status.lan).toBe(true)
    expect(status.headless).toBe(true)
    expect(status.lanInterface).toBe('eth9')

    for (const bind of ['a b', 'fe80::1%eth0']) {
      const svc = makeService()
      expect(() => svc.setHeadless({ port: P, bind }), bind).toThrow(
        'The network must be an interface name or a local address.'
      )
      expect('headless' in svc.status(), bind).toBe(false)
    }

    const both = makeService()
    expect(() => both.setHeadless({ port: 80, bind: 'a b' })).toThrow(
      'The port must be an integer between 1024 and 65535.'
    )
  })

  it('NSL-14l acceptPeer：只在只开放给一个网络时按网段核', async () => {
    enableScoped(P, 'eth1')
    const svc = makeService()
    // 还没在监听：放行（只看私有地址那道门）
    expect(acceptPeer('8.8.8.8')).toBe(true)
    await svc.reconcile()
    for (const peer of ['192.168.50.77', '::ffff:192.168.50.77', '192.168.50.10']) {
      expect(acceptPeer(peer), peer).toBe(true)
    }
    for (const peer of ['192.168.51.1', '10.0.0.9', '127.0.0.1']) {
      expect(acceptPeer(peer), peer).toBe(false)
    }

    await svc.setLanInterface(null)
    expect(acceptPeer('10.0.0.9')).toBe(true)
    expect(acceptPeer('127.0.0.1')).toBe(true)

    await svc.setLanInterface('eth1')
    expect(acceptPeer('10.0.0.9')).toBe(false)
    await svc.setLanInterface('eth9')
    expect(svc.status().error).toBe('ENOINTERFACE')
    expect(acceptPeer('10.0.0.9')).toBe(true)
  })

  it('NSL-14m lanCandidates：每块网卡的私有 IPv4；关着 / 无头 / 对账之前都有', async () => {
    const CANDIDATES = [ETH0_INFO, ETH1_INFO]
    const off = makeService()
    expect(off.status().enabled).toBe(false)
    expect(off.status().lanCandidates).toStrictEqual(CANDIDATES)

    enableScoped(P, 'eth1')
    const desktop = makeService()
    expect(desktop.status().lanCandidates).toStrictEqual(CANDIDATES)
    await desktop.reconcile()
    expect(desktop.status().lanCandidates).toStrictEqual(CANDIDATES)
    await desktop.shutdown()

    const headless = makeService()
    headless.setHeadless({ port: P2 })
    expect(headless.status().lanCandidates).toStrictEqual(CANDIDATES)
  })

  it('NSL-14n 已经 ENOINTERFACE、没在监听：再对账不再发 network.changed', async () => {
    enableScoped(P, 'eth9')
    const svc = makeService()
    await svc.reconcile()
    expect(changed).toHaveBeenCalledTimes(1)
    await svc.reconcile()
    await svc.reconcile()
    expect(changed).toHaveBeenCalledTimes(1)
    expect(fake.calls).toStrictEqual([])
    expect(svc.status().error).toBe('ENOINTERFACE')
  })
})
