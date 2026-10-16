/**
 * 网络访问的局域网开关（`network.lan`，用户裁决 2026-10-14）—— 一个桌面实例：网络访问开着时缺省只监听 127.0.0.1，
 * 「允许局域网里的其他设备」开着才监听 0.0.0.0；切换会重启服务、断开客户端。从外面看：状态经主窗口 IPC、真的 HTTP 打到
 * 本机的私有地址上、设置库经 sqlite、设置页经 pages.ts。
 *
 * NL-1 打开网络访问（空闲端口，从不 7766）→ status 恰是只给这台电脑的那一份；127.0.0.1 → 200；私有地址 → ECONNREFUSED；
 *      库里没有 network.lan
 * NL-2 setLan(true)：连着的 WebSocket 以 1001 断开；lan、绑 0.0.0.0、地址 = 私有地址 + 127.0.0.1（最后）；库里 'true'；
 *      私有地址 → 200；127.0.0.1 照旧 200
 * NL-3 setLan(false)：客户端又被断开（1001）；私有地址又连不上；只列 127.0.0.1；库里 'false'
 * NL-4 通用的设置路径：settings.set network.lan 'true' → 0.0.0.0；'TRUE' → 回到 127.0.0.1、lan false
 * NL-5 setLan('true') → 'lan must be a boolean'；库里不变
 * NL-6 网络访问关着时 setLan(true) → lan true、不监听、没有 bindAddress；再打开网络访问 → 直接绑 0.0.0.0
 * NL-7 设置页：网络访问关着 → 局域网开关关着、点不了；打开后可点，「只有这台电脑」那一行（端口代进去）、风险说明在屏；
 *      点局域网开关 → lan true、那一行消失、列出的地址 = status.addresses
 * 只开放给一个网络（`network.lanInterface`，2026-10-15；状态里的 `lanCandidates` 在每条恰等用例里 = lanCandidatesOf()）：
 * NL-8 局域网开着时 setLanInterface('shuvix-nope0')（这台电脑上没有的网卡）→ 不监听、error ENOINTERFACE、没有
 *      bindAddress；127.0.0.1 与每个私有地址都 ECONNREFUSED；库里存着那个名字；设置页的错误行 = networkErrorNoInterface，
 *      「开放给」里是 'shuvix-nope0 (not found)' 且选中；setLanInterface(null) → 回到 0.0.0.0，库里 ''
 * NL-9 （没有私有 IPv4 网卡就跳过）在设置页的「开放给」里选第一个候选网卡 → 只绑它的地址：bindAddress = 那个地址、
 *      lanNetwork.interface = 那个网卡、地址只列它；127.0.0.1 → ECONNREFUSED；那个地址（Host 带它）→ 200；别的网卡的
 *      私有地址 → ECONNREFUSED；网段那句在屏
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import { until, type CdpClient } from '../../harness/cdp'
import { freePort, launchApp, type E2EApp } from '../../harness/launch'
import {
  httpProbe,
  lanCandidatesOf,
  networkStatus,
  privateIPv4Addresses,
  type NetworkStatus
} from '../../harness/networkFixtures'
import { networkSettingsPane, type NetworkSettingsShot } from '../../harness/pages'
import { sqliteJson, waitRendererReady } from '../../harness/seed'
import { connectWs, type WsClient } from '../../harness/wsClient'

let app: E2EApp
let settings: CdpClient | undefined
const sockets: WsClient[] = []
let P = 0

const status = (): Promise<NetworkStatus> => networkStatus(app.main)
const call = (expr: string): Promise<NetworkStatus> =>
  app.main.eval<NetworkStatus>(`window.api.network.${expr}`)
const lanRow = (): string | null =>
  sqliteJson<{ value: string }>(app.home, "select value from settings where key = 'network.lan'")[0]
    ?.value ?? null

const lanInterfaceRow = (): string | null =>
  sqliteJson<{ value: string }>(
    app.home,
    "select value from settings where key = 'network.lanInterface'"
  )[0]?.value ?? null

const lanUrls = (): string[] =>
  privateIPv4Addresses()
    .map((ip) => `http://${ip}:${P}`)
    .sort()

async function expectLanRefuses(): Promise<void> {
  for (const ip of privateIPv4Addresses()) {
    expect(await httpProbe({ port: P, connectHost: ip, host: `${ip}:${P}` }), ip).toMatchObject({
      error: 'ECONNREFUSED'
    })
  }
}

async function expectLanServes(): Promise<void> {
  for (const ip of privateIPv4Addresses()) {
    expect((await httpProbe({ port: P, connectHost: ip, host: `${ip}:${P}` })).status, ip).toBe(200)
  }
}

async function connect(): Promise<WsClient> {
  const ws = await connectWs(P)
  sockets.push(ws)
  return ws
}

const shotWhen = (
  pred: (s: NetworkSettingsShot) => boolean,
  what: string
): Promise<NetworkSettingsShot> =>
  until(async () => {
    const shot = await networkSettingsPane(settings!).shot()
    return shot.present && pred(shot) ? shot : null
  }, what)

beforeAll(async () => {
  app = await launchApp()
  await app.main.eval(`window.api.settings.set({ key: 'general.language', value: 'en' })`)
  await waitRendererReady(app.main)
  P = await freePort()
})

afterAll(async () => {
  for (const ws of sockets) ws.close()
  try {
    settings?.close()
  } catch {
    /* 已经关了 */
  }
  await app?.stop()
})

describe('network access: the LAN switch', () => {
  it('NL-1 switched on, it listens on 127.0.0.1 only', async () => {
    await call(`setPort(${P})`)
    const on = await call('setEnabled(true)')
    expect(on).toStrictEqual({
      enabled: true,
      port: P,
      lan: false,
      lanCandidates: lanCandidatesOf(),
      bindAddress: '127.0.0.1',
      listening: true,
      addresses: [`http://127.0.0.1:${P}`],
      clients: []
    })
    expect((await httpProbe({ port: P })).status).toBe(200)
    await expectLanRefuses()
    expect(lanRow()).toBeNull()
  })

  it('NL-2 setLan(true) rebinds to 0.0.0.0 and drops the clients', async () => {
    const ws = await connect()
    const shared = await call('setLan(true)')
    expect(await ws.closed()).toBe(1001)
    expect(shared).toMatchObject({ lan: true, bindAddress: '0.0.0.0', listening: true })
    expect(shared.addresses.at(-1)).toBe(`http://127.0.0.1:${P}`)
    expect([...shared.addresses.slice(0, -1)].sort()).toStrictEqual(lanUrls())
    expect(lanRow()).toBe('true')
    await expectLanServes()
    expect((await httpProbe({ port: P })).status).toBe(200)
  })

  it('NL-3 setLan(false) goes back to 127.0.0.1 and drops the clients again', async () => {
    const ws = await connect()
    const local = await call('setLan(false)')
    expect(await ws.closed()).toBe(1001)
    expect(local).toMatchObject({ lan: false, bindAddress: '127.0.0.1', listening: true })
    expect(local.addresses).toStrictEqual([`http://127.0.0.1:${P}`])
    await expectLanRefuses()
    expect(lanRow()).toBe('false')
  })

  it('NL-4 the generic settings path flips it too (only a literal true)', async () => {
    await app.main.eval(`window.api.settings.set({ key: 'network.lan', value: 'true' })`)
    await until(
      async () => (await status()).bindAddress === '0.0.0.0',
      'bound to 0.0.0.0 via settings.set'
    )
    await app.main.eval(`window.api.settings.set({ key: 'network.lan', value: 'TRUE' })`)
    const back = await until(async () => {
      const s = await status()
      return s.bindAddress === '127.0.0.1' ? s : null
    }, "back on 127.0.0.1 after 'TRUE'")
    expect(back.lan).toBe(false)
    expect(back.addresses).toStrictEqual([`http://127.0.0.1:${P}`])
  })

  it('NL-5 a non-boolean setLan is refused and writes nothing', async () => {
    const before = lanRow()
    const message = await app.main.eval<string | null>(
      `window.api.network.setLan('true').then(() => null, (e) => String(e?.message ?? e))`
    )
    expect(message).toContain('lan must be a boolean')
    expect(lanRow()).toBe(before)
  })

  it('NL-6 the LAN switch can be set while off; switching on then binds 0.0.0.0 directly', async () => {
    await call('setEnabled(false)')
    const off = await call('setLan(true)')
    expect(off).toMatchObject({ enabled: false, lan: true, listening: false })
    expect('bindAddress' in off).toBe(false)
    const on = await call('setEnabled(true)')
    expect(on).toMatchObject({ enabled: true, lan: true, listening: true, bindAddress: '0.0.0.0' })
    await expectLanServes()
  })

  it('NL-7 in Settings: locked while off; on → the local-only line; the LAN switch shares and the line goes', async () => {
    await call('setLan(false)')
    await call('setEnabled(false)')
    settings = await app.openSettings('general')
    const off = await shotWhen(
      (s) => s.toggle === 'off' && s.toggleDisabled === false,
      'network access off in Settings'
    )
    expect(off).toMatchObject({ lan: 'off', lanDisabled: true, localOnly: null })

    await networkSettingsPane(settings).clickToggle()
    const on = await shotWhen(
      (s) => s.toggle === 'on' && s.lanDisabled === false && s.addresses.length > 0,
      'network access on in Settings'
    )
    expect(on.lan).toBe('off')
    expect(on.localOnly).toBe(en.settings.networkLocalOnly.replaceAll('{{port}}', String(P)))
    expect(on.localOnly).toContain(`ssh -L ${P}:127.0.0.1:${P}`)
    expect(on.riskVisible).toBe(true)
    expect(on.risk).toBe(en.settings.networkRisk)
    expect(on.addresses).toStrictEqual([`http://127.0.0.1:${P}`])

    await networkSettingsPane(settings).clickLan()
    await until(async () => (await status()).lan, 'lan on after the click')
    const s = await until(async () => {
      const st = await status()
      return st.bindAddress === '0.0.0.0' ? st : null
    }, 'bound to 0.0.0.0 after the click')
    const shared = await shotWhen(
      (shot) =>
        shot.lan === 'on' &&
        shot.localOnly === null &&
        JSON.stringify(shot.addresses) === JSON.stringify(s.addresses),
      'Settings show the LAN switch on'
    )
    expect(shared.addresses).toStrictEqual(s.addresses)
    expect(shared.riskVisible).toBe(true)
    expect(lanRow()).toBe('true')
  })

  it('NL-8 an interface this computer does not have: not listening, ENOINTERFACE, shown in Settings', async () => {
    await call('setEnabled(true)')
    await call('setLan(true)')
    const missing = await call(`setLanInterface('shuvix-nope0')`)
    expect(missing).toMatchObject({
      enabled: true,
      lan: true,
      lanInterface: 'shuvix-nope0',
      listening: false,
      error: 'ENOINTERFACE',
      addresses: []
    })
    expect('bindAddress' in missing).toBe(false)
    expect('lanNetwork' in missing).toBe(false)
    expect(missing.lanCandidates).toStrictEqual(lanCandidatesOf())
    expect(await httpProbe({ port: P })).toMatchObject({ error: 'ECONNREFUSED' })
    await expectLanRefuses()
    expect(lanInterfaceRow()).toBe('shuvix-nope0')

    const shot = await shotWhen((s) => s.error !== null, 'Settings show the missing interface')
    expect(shot.error).toBe(
      en.settings.networkErrorNoInterface.replaceAll('{{name}}', 'shuvix-nope0')
    )
    const pane = networkSettingsPane(settings!)
    const picker = await until(async () => {
      const p = await pane.scopeOptions()
      return p?.value === 'shuvix-nope0' ? p : null
    }, 'the picker shows the missing interface')
    expect(picker.options.at(-1)).toStrictEqual({
      value: 'shuvix-nope0',
      text: en.settings.networkLanScopeMissing.replaceAll('{{name}}', 'shuvix-nope0')
    })
    expect(picker.options.at(-1)?.text).toBe('shuvix-nope0 (not found)')
    expect(await pane.scope()).toBe('shuvix-nope0')

    const all = await call('setLanInterface(null)')
    expect(all).toMatchObject({ lan: true, listening: true, bindAddress: '0.0.0.0' })
    expect('lanInterface' in all).toBe(false)
    expect('error' in all).toBe(false)
    expect(lanInterfaceRow()).toBe('')
    await expectLanServes()
  })

  it('NL-9 choosing an interface in Settings listens on its address only', async (ctx) => {
    const candidates = lanCandidatesOf()
    if (candidates.length === 0) ctx.skip()
    const chosen = candidates[0]
    const pane = networkSettingsPane(settings!)
    await until(async () => (await pane.scope()) === 'all', 'Settings show all networks')
    expect((await pane.scopeOptions())?.options.map((o) => o.value)).toStrictEqual([
      '',
      ...candidates.map((c) => c.interface)
    ])

    await pane.chooseScope(chosen.interface)
    const scoped = await until(async () => {
      const st = await status()
      return st.listening && st.lanNetwork?.interface === chosen.interface ? st : null
    }, `listening on ${chosen.interface} only`)
    expect(scoped.bindAddress).toBe(chosen.address)
    expect(scoped.lanInterface).toBe(chosen.interface)
    expect(scoped.lanNetwork).toStrictEqual(chosen)
    expect(scoped.addresses).toStrictEqual([`http://${chosen.address}:${P}`])
    expect(lanInterfaceRow()).toBe(chosen.interface)

    expect(await httpProbe({ port: P })).toMatchObject({ error: 'ECONNREFUSED' })
    const page = await httpProbe({
      port: P,
      connectHost: chosen.address,
      host: `${chosen.address}:${P}`
    })
    expect(page.status).toBe(200)
    for (const ip of privateIPv4Addresses().filter((a) => a !== chosen.address)) {
      expect(await httpProbe({ port: P, connectHost: ip, host: `${ip}:${P}` }), ip).toMatchObject({
        error: 'ECONNREFUSED'
      })
    }

    await until(async () => (await pane.scope()) === chosen.interface, 'Settings show the choice')
    expect((await pane.scopeOptions())?.value).toBe(chosen.interface)
    expect(await until(() => pane.scopeOnly(), 'the subnet line')).toBe(
      en.settings.networkLanScopeOnly.replaceAll('{{cidr}}', chosen.cidr)
    )
  })
})
