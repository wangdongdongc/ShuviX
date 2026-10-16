/**
 * 无头运行 + `--bind <网卡>`（只开放给一个网络，2026-10-15）—— 一个 `launchApp({ headless: true, bind })` 的实例：只在
 * 那块网卡的地址上监听，就绪那一行与状态只列那一个地址，127.0.0.1 连不上；网络由启动参数定，换不了。网卡取 spec 进程
 * 自己算的第一个候选（`lanCandidatesOf()`）；这台电脑没有私有 IPv4 网卡 → 整个文件跳过。
 *
 * HB-1 就绪那一行恰是 `ShuviX headless: ready — open one of: http://<地址>:<P>/`
 * HB-2 network:status：lan、headless、lanInterface = 那块网卡、lanNetwork = 那个候选、bindAddress = 那个地址、地址只列它；
 *      lanCandidates = lanCandidatesOf()
 * HB-3 那个地址上 GET / → 200；127.0.0.1 → ECONNREFUSED；别的网卡的私有地址 → ECONNREFUSED
 * HB-4 network:setLanInterface(null) / 别的网卡 → code 'headless'；同一块 → 回状态；setLan(false) → code 'headless'；照旧监听
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchApp, type E2EHeadlessApp } from '../../harness/launch'
import {
  httpProbe,
  lanCandidatesOf,
  privateIPv4Addresses,
  type NetworkLanInfo,
  type NetworkStatus
} from '../../harness/networkFixtures'
import { connectWs, WsInvokeError, type WsClient } from '../../harness/wsClient'

const candidates = lanCandidatesOf()
const chosen: NetworkLanInfo | undefined = candidates[0]

let app: E2EHeadlessApp
let ws: WsClient | undefined
let P = 0

const status = (): Promise<NetworkStatus> => ws!.invoke<NetworkStatus>('network:status')

async function refusalOf(channel: string, ...args: unknown[]): Promise<WsInvokeError | null> {
  try {
    await ws!.invoke(channel, ...args)
    return null
  } catch (error) {
    if (error instanceof WsInvokeError) return error
    throw error
  }
}

describe.skipIf(chosen === undefined)('headless --bind: shared on one network only', () => {
  beforeAll(async () => {
    app = await launchApp({ headless: true, bind: chosen!.interface })
    P = app.networkPort
    ws = await connectWs(P, { host: chosen!.address })
  })

  afterAll(async () => {
    ws?.close()
    await app?.stop()
  })

  it('HB-1 the ready line lists only the address of that interface', () => {
    expect(app.readyLine).toBe(
      `ShuviX headless: ready — open one of: http://${chosen!.address}:${P}/`
    )
    expect(app.urls).toStrictEqual([`http://${chosen!.address}:${P}/`])
  })

  it('HB-2 network:status: lan, headless, scoped to that interface', async () => {
    const s = await status()
    expect(s).toMatchObject({
      enabled: true,
      port: P,
      lan: true,
      headless: true,
      listening: true,
      lanInterface: chosen!.interface,
      bindAddress: chosen!.address
    })
    expect(s.lanNetwork).toStrictEqual(chosen)
    expect(s.addresses).toStrictEqual([`http://${chosen!.address}:${P}`])
    expect(s.lanCandidates).toStrictEqual(candidates)
    expect('error' in s).toBe(false)
  })

  it('HB-3 only that address serves; 127.0.0.1 and the other private addresses refuse', async () => {
    const page = await httpProbe({
      port: P,
      connectHost: chosen!.address,
      host: `${chosen!.address}:${P}`
    })
    expect(page.status).toBe(200)
    expect(page.body?.toString('utf8')).toContain('<div id="root">')
    expect(await httpProbe({ port: P })).toMatchObject({ error: 'ECONNREFUSED' })
    for (const ip of privateIPv4Addresses().filter((a) => a !== chosen!.address)) {
      expect(await httpProbe({ port: P, connectHost: ip, host: `${ip}:${P}` }), ip).toMatchObject({
        error: 'ECONNREFUSED'
      })
    }
  })

  it('HB-4 the network is chosen at startup: changing it is refused, the same one is fine', async () => {
    const all = await refusalOf('network:setLanInterface', null)
    expect(all?.code).toBe('headless')
    expect(all?.message).toContain('--bind <interface or address>')
    const other = await refusalOf('network:setLanInterface', 'shuvix-nope0')
    expect(other?.code).toBe('headless')

    const same = await ws!.invoke<NetworkStatus>('network:setLanInterface', chosen!.interface)
    expect(same.lanInterface).toBe(chosen!.interface)
    expect(same.listening).toBe(true)

    const lanOff = await refusalOf('network:setLan', false)
    expect(lanOff?.code).toBe('headless')

    expect(ws!.isOpen()).toBe(true)
    const after = await status()
    expect(after.bindAddress).toBe(chosen!.address)
    expect(after.listening).toBe(true)
  })
})
