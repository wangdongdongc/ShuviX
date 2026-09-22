/**
 * Chrome 桥的本地组件与握手 —— 真的桌面、真的 `cli.js native-host`，只有 Chrome 是假的。
 *
 * 这一片证明的是**接线**，单测各自证明不了的那些：
 *   - 安装器写出来的启动脚本真能把本地组件拉起来（路径写死的是这个 checkout 的 Electron 与 cli.js），
 *     宿主清单写进「装了的」浏览器目录、`path` 指向那个脚本 —— 假 Chrome 就按清单里的 `path` 拉起，
 *     正是 Chrome 读清单之后做的事（CBE-1 / CBE-2）；
 *   - 桌面与本地组件**各自**算出的 token 文件与 socket 路径是同一个（鉴权通过、握手成功）；
 *   - 握手的三种结局：就绪、协议版本不符、还没握手就发请求（CBE-2 / CBE-3 / CBE-4），以及设置页
 *     （`chromeExtension.status`）看到的就是这些；
 *   - 扩展关掉端口 → 本地组件自己退出（CBE-5）；
 *   - 桌面不在时本地组件替它回 `desktop-offline`，桌面回来后它自己重连、扩展重新握手，挂在标签页上的
 *     对话还是那一条（CBE-6 / CBE-7）。这一段要停机再起，用 `stop({ keepHome: true })` +
 *     `launchApp({ home })`：同一个 HOME，上一次启动写下的启动脚本还在 —— 与「Chrome 开着、ShuviX
 *     关着」的真实情形一样。
 *
 * 断言只走三处：假 Chrome 收到的帧、主窗口的 `window.api.chromeExtension.status()` / 会话 IPC、
 * 本地组件自己的退出码。本文件不起模型。
 */
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CHROME_BRIDGE_HOST_NAME, CHROME_EXTENSION_ID } from '@shuvix/chat-protocol/chromeBridge'
import { until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import { appEventRecorder, sqliteJson, type AppEventRecorder } from '../../harness/seed'
import {
  CHROME_EXTENSION_ORIGIN,
  HOST_MANIFEST_FILE,
  launcherOf,
  startFakeChrome,
  type FakeChrome
} from '../../harness/chromeFixtures'

const DESKTOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const CLI_JS = join(DESKTOP_ROOT, 'out', 'main', 'cli.js')

/** 设置页看到的一个浏览器 */
interface BrowserStatus {
  installId: string
  runId: string
  browser: string
  extensionVersion: string
  connectedAt: number
  state: 'ready' | 'mismatch'
  protocol: number
}

interface ExtensionStatus {
  listening: boolean
  browsers: BrowserStatus[]
  install: { launcher: string; installed: string[]; failed: Array<{ browser: string }> } | null
}

/** macOS / Linux 上「装了 Chrome」的判据：它的用户数据目录（hostInstaller 的 nativeHostTargets） */
function chromeUserDataDir(home: string): string {
  return process.platform === 'darwin'
    ? join(home, 'Library', 'Application Support', 'Google', 'Chrome')
    : join(home, '.config', 'google-chrome')
}

let app: E2EApp
let appEvents: AppEventRecorder
/** 贯穿全文件的那个浏览器：握手、开会话、看着桌面走了又回来 */
let chromeA: FakeChrome
/** 开在 CBE-2 的对话（挂在 A 的 5 号标签页上）—— CBE-7 要在桌面重启之后拿回同一条 */
let sidA5 = ''
const others: FakeChrome[] = []

const status = (): Promise<ExtensionStatus> =>
  app.main.eval<ExtensionStatus>(`window.api.chromeExtension.status()`)

/** 库里此刻的 Chrome 标签页会话（按 chromeTab 键判，不经 session.list —— 它们本就不在列表里） */
const tabSessionRows = (): Array<{ id: string; installId: string; tabId: number }> =>
  sqliteJson<{ id: string; installId: string; tabId: number }>(
    app.home,
    `SELECT id, json_extract(settings, '$.chromeTab.installId') AS installId,
            json_extract(settings, '$.chromeTab.tabId') AS tabId
       FROM sessions WHERE json_extract(settings, '$.chromeTab') IS NOT NULL`
  )

beforeAll(async () => {
  app = await launchApp()
  appEvents = appEventRecorder(app.main)
  await appEvents.install()
}, 120_000)

afterAll(async () => {
  for (const c of [chromeA, ...others]) await c?.close()
  await app?.stop()
})

describe.skipIf(process.platform === 'win32')('本地组件的安装与握手', () => {
  it('CBE-1 桌面启动就写好启动脚本；装了 Chrome 的机器上宿主清单指向它、只许 ShuviX 扩展', async () => {
    const launcher = launcherOf(app.home)
    await until(() => existsSync(launcher), 'native host launcher written at startup')
    // 可执行（Chrome 直接 exec 清单里的 path），写死的是这个 checkout 的 cli.js 与 Electron
    expect(statSync(launcher).mode & 0o111).not.toBe(0)
    const script = readFileSync(launcher, 'utf8')
    expect(script.startsWith('#!/bin/sh\n')).toBe(true)
    expect(script).toContain('unset NODE_OPTIONS')
    const exec = /ELECTRON_RUN_AS_NODE=1 exec '([^']+)' '([^']+)' native-host "\$@"/.exec(script)
    expect(exec, script).not.toBeNull()
    expect(existsSync(exec![1])).toBe(true)
    expect(exec![2]).toBe(CLI_JS)
    expect(existsSync(CLI_JS)).toBe(true)

    // 隔离 HOME 里没有任何浏览器：只写启动脚本，不替没装的浏览器建目录
    const first = await until(async () => {
      const s = await status()
      return s.listening && s.install ? s : null
    }, 'bridge listening and first install recorded')
    expect(first.browsers).toEqual([])
    expect(first.install).toEqual({ launcher, installed: [], failed: [] })
    expect(existsSync(chromeUserDataDir(app.home))).toBe(false)

    // 「装上」Chrome（它的用户数据目录出现了），设置页的「修复本地组件」重装一遍
    mkdirSync(chromeUserDataDir(app.home), { recursive: true })
    const repaired = await app.main.eval<ExtensionStatus>(`window.api.chromeExtension.repair()`)
    expect(repaired.install).toEqual({ launcher, installed: ['Google Chrome'], failed: [] })
    const manifestPath = join(
      chromeUserDataDir(app.home),
      'NativeMessagingHosts',
      HOST_MANIFEST_FILE
    )
    expect(JSON.parse(readFileSync(manifestPath, 'utf8'))).toEqual({
      name: CHROME_BRIDGE_HOST_NAME,
      description: 'ShuviX desktop bridge for the ShuviX Chrome extension',
      path: launcher,
      type: 'stdio',
      allowed_origins: [`chrome-extension://${CHROME_EXTENSION_ID}/`]
    })
  }, 120_000)

  it('CBE-2 Chrome 按清单拉起本地组件：先报「桌面在」，hello 之后就绪，设置页列出这个浏览器', async () => {
    const manifest = JSON.parse(
      readFileSync(
        join(chromeUserDataDir(app.home), 'NativeMessagingHosts', HOST_MANIFEST_FILE),
        'utf8'
      )
    ) as { path: string; allowed_origins: string[] }
    expect(manifest.allowed_origins).toEqual([CHROME_EXTENSION_ORIGIN])
    await appEvents.clear()

    chromeA = startFakeChrome({
      home: app.home,
      launcher: manifest.path,
      installId: 'inst-bridge-a',
      runId: 'run-a1',
      browser: 'E2E Chrome 140',
      tabs: [{ id: 5, title: 'Bridge Page', url: 'https://bridge.example/', active: true }]
    })
    await chromeA.waitHost('connected')
    // 鉴权过了才报「在」，而且只报一次
    expect(chromeA.hostStatuses().map((h) => h.desktop)).toEqual(['connected'])

    const welcome = await chromeA.hello()
    expect(welcome).toEqual({ type: 'welcome', protocol: 1, ok: true })
    const s = await status()
    expect(s.browsers).toEqual([
      {
        installId: 'inst-bridge-a',
        runId: 'run-a1',
        browser: 'E2E Chrome 140',
        extensionVersion: '0.0.0-e2e',
        connectedAt: expect.any(Number),
        state: 'ready',
        protocol: 1
      }
    ])
    // 设置页据此刷新
    await until(
      async () => (await appEvents.count('chromeExtension.changed')) > 0,
      'chromeExtension.changed reached the main window'
    )

    // 就绪之后的第一个请求：给这个标签页开一条对话（CBE-7 要在桌面重启之后拿回它）
    sidA5 = await chromeA.openTabSession(5)
    expect(sidA5).toMatch(/^[0-9a-f-]{36}$/)
    // stdout 只有帧：日志一律走 stderr，一行都没混进帧通道
    expect(chromeA.stderr()).toContain('connected to the desktop')
    expect(chromeA.stderr()).not.toContain('a frame that is not JSON')
  }, 120_000)

  it('CBE-3 还没 hello 就发请求：回 not-ready，设置页里没有它，也不建会话', async () => {
    const before = tabSessionRows().length
    const early = startFakeChrome({
      home: app.home,
      installId: 'inst-bridge-early',
      tabs: [{ id: 1, url: 'https://early.example/' }]
    })
    others.push(early)
    await early.waitHost('connected')
    const r = await early.request('tabSession.open', { tabId: 1, title: 'Early' })
    expect(r).toMatchObject({ type: 'response', ok: false, error: 'not-ready' })
    expect((await status()).browsers.map((b) => b.installId)).not.toContain('inst-bridge-early')
    expect(tabSessionRows().length).toBe(before)
  }, 120_000)

  it('CBE-4 协议版本对不上：welcome 不 ok，设置页标 mismatch，请求一律回 protocol-mismatch', async () => {
    const before = tabSessionRows().length
    const old = startFakeChrome({
      home: app.home,
      installId: 'inst-bridge-old',
      browser: 'E2E Chrome Old',
      extensionVersion: '0.0.1-old',
      tabs: [{ id: 3, url: 'https://old.example/' }]
    })
    others.push(old)
    await old.waitHost('connected')
    const welcome = await old.hello({ protocol: 99 })
    expect(welcome).toEqual({
      type: 'welcome',
      protocol: 1,
      ok: false,
      error: 'protocol-mismatch'
    })
    const listed = (await status()).browsers.find((b) => b.installId === 'inst-bridge-old')
    expect(listed).toMatchObject({ state: 'mismatch', protocol: 99, extensionVersion: '0.0.1-old' })
    const r = await old.request('tabSession.open', { tabId: 3, title: 'Old' })
    expect(r).toMatchObject({ ok: false, error: 'protocol-mismatch' })
    expect(tabSessionRows().length).toBe(before)
    // 旁边那个就绪的浏览器不受影响
    expect((await status()).browsers.find((b) => b.installId === 'inst-bridge-a')?.state).toBe(
      'ready'
    )
  }, 120_000)

  it('CBE-5 扩展关掉端口：本地组件自己退出（退出码 0），设置页里不再有这个浏览器', async () => {
    const leaving = startFakeChrome({
      home: app.home,
      installId: 'inst-bridge-leaving',
      tabs: [{ id: 2, url: 'https://leaving.example/' }]
    })
    await leaving.waitHost('connected')
    expect((await leaving.hello()).ok).toBe(true)
    await until(
      async () => (await status()).browsers.some((b) => b.installId === 'inst-bridge-leaving'),
      'leaving browser listed'
    )
    await leaving.close()
    expect(leaving.exitCode()).toBe(0)
    await until(
      async () => !(await status()).browsers.some((b) => b.installId === 'inst-bridge-leaving'),
      'leaving browser dropped from the status'
    )
  }, 120_000)
})

describe.skipIf(process.platform === 'win32')('桌面不在、桌面回来', () => {
  /** 桌面停着的时候才开的浏览器（Chrome 开着、ShuviX 关着） */
  let late: FakeChrome

  it('CBE-6 桌面停了：本地组件报「桌面不在」，扩展的请求由它当场回 desktop-offline', async () => {
    const since = chromeA.mark()
    await app.stop({ keepHome: true })

    await chromeA.waitHost('offline', { since })
    const t0 = Date.now()
    const r = await chromeA.request('channel.call', { path: 'message.list', args: [sidA5] })
    expect(r).toMatchObject({ type: 'response', ok: false, error: 'desktop-offline' })
    // 本地组件自己答的：不必等任何超时
    expect(Date.now() - t0).toBeLessThan(5_000)

    // 桌面没开时 Chrome 才拉起的本地组件：第一句就是「不在」，请求同样当场回错
    late = startFakeChrome({
      home: app.home,
      installId: 'inst-bridge-late',
      runId: 'run-late',
      tabs: [{ id: 9, title: 'Late Page', url: 'https://late.example/' }]
    })
    others.push(late)
    await late.waitHost('offline')
    expect(late.hostStatuses().map((h) => h.desktop)).toEqual(['offline'])
    const lr = await late.request('tabSession.open', { tabId: 9, title: 'Late Page' })
    expect(lr).toMatchObject({ ok: false, error: 'desktop-offline' })
    expect(late.exitCode()).toBeNull()
  }, 120_000)

  it('CBE-7 桌面回来：本地组件自己重连，扩展重新握手；挂在标签页上的对话还是那一条', async () => {
    const sinceA = chromeA.mark()
    const sinceLate = late.mark()
    app = await launchApp({ home: app.home })

    // 新的一次启动换了 token：本地组件每次连都重读，照样鉴权通过
    await chromeA.waitHost('connected', { since: sinceA, timeoutMs: 45_000 })
    await late.waitHost('connected', { since: sinceLate, timeoutMs: 45_000 })

    expect((await chromeA.hello()).ok).toBe(true)
    expect((await late.hello()).ok).toBe(true)
    const listed = (await status()).browsers.map((b) => b.installId).sort()
    expect(listed).toEqual(['inst-bridge-a', 'inst-bridge-late'])

    // 同一个浏览器的同一轮运行、标签页还开着：握手不清它，再开拿回的是同一条对话
    expect(await chromeA.openTabSession(5)).toBe(sidA5)
    const row = await app.main.eval<{ title: string } | null>(
      `window.api.session.getById(${JSON.stringify(sidA5)}).then((s) => s ?? null)`
    )
    expect(row?.title).toBe('Chrome · Bridge Page')
    // 桌面停着时发起的那个请求没有被悄悄补发：late 的标签页此刻才第一次开会话
    const lateSid = await late.openTabSession(9)
    expect(lateSid).not.toBe(sidA5)
    expect(tabSessionRows().filter((r) => r.installId === 'inst-bridge-late')).toEqual([
      { id: lateSid, installId: 'inst-bridge-late', tabId: 9 }
    ])
  }, 180_000)
})
