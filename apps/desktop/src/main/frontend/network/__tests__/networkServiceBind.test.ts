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
 */
import type { networkInterfaces } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNetworkTransport } from '../transport'
import type * as ServiceModule from '../index'

type Call = ['start', number, string | undefined] | ['stop', string | undefined]

const fake = vi.hoisted(() => ({
  calls: [] as Call[],
  /** 下一次 start 抛它（抛一次就清掉） */
  failNext: undefined as unknown
}))

vi.mock('../server', () => ({
  createNetworkServer: () => {
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
const NO_IFACES = {} as ReturnType<typeof networkInterfaces>

let mod: typeof ServiceModule
let settings: Map<string, string>
let services: ServiceModule.NetworkService[]

beforeEach(async () => {
  mod = await import('../index')
  fake.calls.length = 0
  fake.failNext = undefined
  settings = new Map()
  services = []
})

afterEach(async () => {
  for (const svc of services) await svc.shutdown()
})

/** 不给 host：绑的地址由局域网开关决定（产品的缺省路径） */
function makeService(): ServiceModule.NetworkService {
  const svc = new mod.NetworkService({
    readSetting: (k) => settings.get(k),
    writeSetting: (k, v) => settings.set(k, v),
    rendererDir: () => '/nonexistent',
    interfaces: () => NO_IFACES,
    publishChanged: () => {},
    transport: createNetworkTransport()
  })
  services.push(svc)
  return svc
}

function enable(port: number): void {
  settings.set('network.enabled', 'true')
  settings.set('network.port', String(port))
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
