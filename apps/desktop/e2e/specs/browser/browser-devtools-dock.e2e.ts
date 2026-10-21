/**
 * 浏览器窗口的停靠区（2026-10-21）：页面下方的原生 DevTools，与旁边 agent 的 devtool（调用记录 + agent 的网络 /
 * 控制台采集）。假提供商脚本化 agent 的调用，夹具网站记下每一个请求。一个实例按顺序走：
 *
 *   BD-E1  用户的 tab A 选中着：⋮ →「开发者工具」→ 停靠区出现、停在 DevTools 页签，listTabs 的 A 带
 *          devtools.panel = devtools；原生 DevTools 前端是一个 devtools://devtools/bundled/… 的调试目标；页面区
 *          变矮（A 的视口高度变小）。再点一次 → 停靠区没了、DevTools 目标也没了、视口高度回去；
 *   BD-E2  一条勾了 mcp:browser 的会话在自己开的 tab B 上：console、network、evaluate（打日志 + 发请求）、
 *          cdp Runtime.evaluate、cdp Browser.close（被拒）、network、console。agent 的动作从不打开停靠区
 *          （B 的 devtools 一直没有）；用户选中 B → 提示条多一个「Agent's DevTools activity (7)」→ 点它 →
 *          停靠区停在 Agent 页签：七行调用按顺序、被拒的那行是 failed；点开 evaluate 那行能看到表达式与 agent
 *          收到的 200；网络页有 /report?bd=1（200），控制台页有 bd-e2-marker；
 *   BD-E3  停靠区切到 DevTools 页签（原生前端建出来）期间 agent 再 evaluate：照常回 42，调用记录多一行；
 *          点 ✕ 关掉停靠区：DevTools 目标没了，agent 再 evaluate 照常；
 *   BD-E4  Agent 页签上「清空调用记录」：调用一行不剩，agent 的网络采集照旧（agent 的 network 仍列着 /report）。
 *
 * 不钉的：页面右键「检查」（原生 Menu.popup 是系统菜单，驱动不了）与 F12 / ⌥⌘I（只认真实键盘，CDP 发的键
 * 不触发 before-input-event）—— 两者的映射与守卫在单测里。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { listTargets, sleep, until, type CdpClient } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import { startFakeProvider, type FakeProvider } from '../../harness/fakeProvider'
import { eventRecorder, seedFakeProvider, waitRendererReady } from '../../harness/seed'
import { browserShellPane, type BrowserShellPane } from '../../harness/pages'
import {
  browserDriver,
  connectTabPage,
  startFixtureServer,
  tabIdOf,
  type BrowserDriver,
  type FixtureServer
} from '../../harness/browserFixtures'

const MODEL = 'e2e-model'
const SESSION_TITLE = 'BD devtools dock agent'
const DEVTOOLS_URL = 'devtools://devtools/bundled/'

interface TabRow {
  id: string
  url: string
  active: boolean
  devtools?: { panel: 'devtools' | 'agent' }
  agentDevtoolsCalls: number
}

interface DockShot {
  tabId: string
  panel: string
  calls: Array<{ tool: string; status: string }>
  infobarButton: string | null
}

let app: E2EApp
let provider: FakeProvider
let fixture: FixtureServer
let driver: BrowserDriver
let bw: CdpClient
let shell: BrowserShellPane
let sid = ''
/** BD-E1 用户的 tab */
let userTab = ''
/** BD-E2 agent 开的 tab（UUID 与 agent 看到的短号） */
let agentTab = ''
let agentShort = ''

const listTabs = (): Promise<TabRow[]> =>
  app.main.eval<TabRow[]>('window.api.browserView.listTabs()')
const rowOf = async (tabId: string): Promise<TabRow | undefined> =>
  (await listTabs()).find((t) => t.id === tabId)
const devtoolsTargets = async (): Promise<number> =>
  (await listTargets(app.port)).filter((t) => t.url.startsWith(DEVTOOLS_URL)).length

async function innerHeightOf(url: string): Promise<number | null> {
  const page = await connectTabPage(app.port, (u) => u === url)
  if (!page) return null
  try {
    return await page.eval<number>('innerHeight')
  } catch {
    return null
  } finally {
    page.close()
  }
}

/** 浏览器窗口外壳里停靠区此刻的样子 */
const dockShot = (): Promise<DockShot | null> =>
  bw.eval<DockShot | null>(`(() => {
    const dock = document.querySelector('[data-devtools-dock]')
    const button = document.querySelector('[data-agent-infobar-devtools]')
    if (!dock) return button ? { tabId: '', panel: '', calls: [], infobarButton: button.textContent } : null
    return {
      tabId: dock.getAttribute('data-devtools-dock'),
      panel: dock.getAttribute('data-panel'),
      calls: [...dock.querySelectorAll('[data-agent-call]')].map((el) => ({
        tool: el.getAttribute('data-tool'),
        status: el.getAttribute('data-status')
      })),
      infobarButton: button ? button.textContent : null
    }
  })()`)

async function click(selector: string, what: string): Promise<void> {
  const ok = await bw.eval<boolean>(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return false
    el.click()
    return true
  })()`)
  if (!ok) throw new Error(`${what} (${selector}) not in the browser window`)
}

const text = (selector: string): Promise<string | null> =>
  bw.eval<string | null>(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`)

/** 反复读到断言全过；超时连同最后一次读数一起抛出来 */
async function eventually<T>(
  read: () => Promise<T>,
  check: (value: T) => void,
  what: string,
  timeoutMs = 15_000
): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    const value = await read()
    try {
      check(value)
      return value
    } catch (err) {
      if (Date.now() - t0 > timeoutMs) {
        throw new Error(
          `${what}: ${(err as Error).message}\nlast reading: ${JSON.stringify(value)}`
        )
      }
    }
    await sleep(200)
  }
}

/** agent 在 B 上 evaluate 一次，回 agent 收到的文字 */
async function agentEvaluate(expression: string, id: string): Promise<string> {
  const run = await driver.run(sid, [
    { id, tool: 'evaluate', args: { tabId: agentShort, expression } }
  ])
  const end = run.ends[id]
  expect(end?.isError).toBe(false)
  return end.result
}

beforeAll(async () => {
  app = await launchApp()
  provider = await startFakeProvider()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(app.main)
  const events = eventRecorder(app.main)
  await events.install()
  fixture = await startFixtureServer()
  driver = browserDriver({ main: app.main, provider, events })

  await app.main.eval('window.api.browserView.openWindow()')
  await until(() => app.main.eval<boolean>('window.api.browserView.isWindowOpen()'), 'window open')
  bw = await until(() => app.browserWindow(), 'browser window page')
  shell = browserShellPane(bw)
  await until(
    () => bw.eval<boolean>(`!!document.querySelector('[data-browser-window]')`),
    'browser window shell mounted'
  )
}, 120_000)

afterAll(async () => {
  bw?.close()
  await provider?.close()
  await fixture?.close()
  await app?.stop()
})

describe('原生 DevTools 停靠在页面下方（BD-E1）', () => {
  it('BD-E1 ⋮ →「开发者工具」开 / 关：停靠区、listTabs、DevTools 调试目标、页面视口高度一起变', async () => {
    const url = fixture.url('/counter.html?bd=user')
    userTab = await app.main.eval<string>(
      `window.api.browserView.createTab(${JSON.stringify(url)})`
    )
    await eventually(
      () => innerHeightOf(url),
      (h) => expect(h).toBeGreaterThan(300),
      'user tab on screen'
    )
    // 选中的那页在屏幕上（停放窗口里的高度不同），先等它稳定
    await sleep(500)
    const fullHeight = (await innerHeightOf(url))!
    expect(await devtoolsTargets()).toBe(0)

    await shell.moreMenu('devtools')
    await eventually(
      dockShot,
      (d) => expect(d).toMatchObject({ tabId: userTab, panel: 'devtools' }),
      'dock open on the DevTools tab'
    )
    expect((await rowOf(userTab))?.devtools).toEqual({ panel: 'devtools' })
    await eventually(devtoolsTargets, (n) => expect(n).toBe(1), 'native DevTools frontend up')
    await eventually(
      () => innerHeightOf(url),
      (h) => expect(h!).toBeLessThan(fullHeight - 100),
      'page area got shorter'
    )

    await shell.moreMenu('devtools')
    await eventually(dockShot, (d) => expect(d).toBeNull(), 'dock closed')
    expect((await rowOf(userTab))?.devtools).toBeUndefined()
    await eventually(devtoolsTargets, (n) => expect(n).toBe(0), 'native DevTools frontend gone')
    await eventually(
      () => innerHeightOf(url),
      (h) => expect(h).toBe(fullHeight),
      'page area back to full height'
    )
  })
})

describe('agent 的 devtool：调用记录与采集（BD-E2）', () => {
  it('BD-E2 agent 的七次 devtool 调用都记下、从不打开停靠区；提示条入口 → Agent 页签：调用、网络、控制台', async () => {
    sid = await app.main.eval<string>(
      `window.api.session.create(${JSON.stringify({ title: SESSION_TITLE })}).then((s) => s.id)`
    )
    await app.main.eval(
      `window.api.session.updateEnabledTools(${JSON.stringify({ id: sid, enabledTools: ['mcp:browser'] })})`
    )
    const url = fixture.url('/counter.html?bd=agent')
    const opened = await driver.run(sid, [{ id: 'open', tool: 'open_tab', args: { url } }])
    agentShort = tabIdOf(opened.ends.open.result)
    agentTab = (await listTabs()).find((t) => t.url === url)!.id

    const run = await driver.run(sid, [
      { id: 'c1', tool: 'console', args: { tabId: agentShort } },
      { id: 'n1', tool: 'network', args: { tabId: agentShort } },
      {
        id: 'ev',
        tool: 'evaluate',
        args: {
          tabId: agentShort,
          expression: "console.log('bd-e2-marker'); fetch('/report?bd=1').then((r) => r.status)"
        }
      },
      {
        id: 'cdp',
        tool: 'cdp',
        args: {
          tabId: agentShort,
          method: 'Runtime.evaluate',
          params: { expression: '1+1', returnByValue: true }
        }
      },
      { id: 'blocked', tool: 'cdp', args: { tabId: agentShort, method: 'Browser.close' } },
      { id: 'n2', tool: 'network', args: { tabId: agentShort } },
      { id: 'c2', tool: 'console', args: { tabId: agentShort } }
    ])
    expect(run.ends.ev.result).toContain('200')
    expect(run.ends.blocked.isError).toBe(true)
    expect(run.ends.n2.result).toContain('/report?bd=1')

    // agent 的动作从不打开停靠区、从不选中它的页
    const row = await rowOf(agentTab)
    expect(row).toMatchObject({ active: false, agentDevtoolsCalls: 7 })
    expect(row?.devtools).toBeUndefined()

    await shell.clickTab(agentTab)
    const before = await eventually(
      dockShot,
      (d) => expect(d?.infobarButton).toBe("Agent's DevTools activity (7)"),
      'infobar offers the agent devtool'
    )
    expect(before?.panel).toBe('')

    await click('[data-agent-infobar-devtools]', 'infobar "Agent\'s DevTools activity"')
    const dock = await eventually(
      dockShot,
      (d) => {
        expect(d).toMatchObject({ tabId: agentTab, panel: 'agent' })
        expect(d!.calls).toHaveLength(7)
      },
      'dock open on the Agent tab with seven calls'
    )
    expect(dock!.calls).toEqual([
      { tool: 'console', status: 'ok' },
      { tool: 'network', status: 'ok' },
      { tool: 'evaluate', status: 'ok' },
      { tool: 'cdp', status: 'ok' },
      { tool: 'cdp', status: 'failed' },
      { tool: 'network', status: 'ok' },
      { tool: 'console', status: 'ok' }
    ])
    // 停在 Agent 页签不建原生 DevTools
    expect(await devtoolsTargets()).toBe(0)

    // 点开 evaluate 那行：表达式与 agent 收到的结果
    await click('[data-agent-call][data-tool="evaluate"] button', 'evaluate row')
    const detail = await eventually(
      () => text('[data-agent-call][data-tool="evaluate"] [data-agent-call-detail]'),
      (t) => expect(t).toContain('bd-e2-marker'),
      'evaluate detail open'
    )
    expect(detail).toContain(run.ends.ev.result.trim())

    await click('[data-agent-devtools-view="network"]', 'Network view')
    await eventually(
      () => text('[data-agent-network]'),
      (t) => {
        expect(t).toContain(fixture.url('/report?bd=1'))
        expect(t).toContain('200')
      },
      'network view lists the request the agent saw'
    )

    await click('[data-agent-devtools-view="console"]', 'Console view')
    await eventually(
      () => text('[data-agent-console]'),
      (t) => expect(t).toContain('bd-e2-marker'),
      'console view lists the message the agent saw'
    )
  })
})

describe('原生 DevTools 与 agent 的 CDP 并存（BD-E3）', () => {
  it('BD-E3 DevTools 页签开着时 agent 照常 evaluate、记录多一行；✕ 关掉之后 agent 照常', async () => {
    await click('[data-devtools-tab="devtools"]', 'DevTools tab')
    await eventually(
      dockShot,
      (d) => expect(d).toMatchObject({ tabId: agentTab, panel: 'devtools' }),
      'dock switched to DevTools'
    )
    await eventually(devtoolsTargets, (n) => expect(n).toBe(1), 'native DevTools frontend up')

    expect(await agentEvaluate('6*7', 'e3a')).toContain('42')
    await eventually(
      () => rowOf(agentTab),
      (r) => expect(r?.agentDevtoolsCalls).toBe(8),
      'call recorded while DevTools is open'
    )
    await eventually(
      () => text('[data-devtools-tab="agent"]'),
      (t) => expect(t).toContain('8'),
      'Agent tab badge counts it'
    )

    await click('[data-devtools-close]', 'dock close button')
    await eventually(dockShot, (d) => expect(d?.panel ?? '').toBe(''), 'dock closed')
    await eventually(devtoolsTargets, (n) => expect(n).toBe(0), 'native DevTools frontend gone')
    expect(await agentEvaluate('40+2', 'e3b')).toContain('42')
  })
})

describe('清空调用记录（BD-E4）', () => {
  it('BD-E4 清空只清调用记录：一行不剩，agent 的网络采集照旧', async () => {
    await click('[data-agent-infobar-devtools]', 'infobar "Agent\'s DevTools activity"')
    await eventually(
      dockShot,
      (d) => expect(d).toMatchObject({ tabId: agentTab, panel: 'agent' }),
      'dock on the Agent tab'
    )
    await click('[data-agent-devtools-view="calls"]', 'Calls view')
    await click('[data-agent-devtools-clear]', 'clear button')
    await eventually(dockShot, (d) => expect(d?.calls).toEqual([]), 'call log empty')
    expect((await rowOf(agentTab))?.agentDevtoolsCalls).toBe(0)

    const run = await driver.run(sid, [{ id: 'n3', tool: 'network', args: { tabId: agentShort } }])
    expect(run.ends.n3.result).toContain('/report?bd=1')
    // 这次 network 本身又记了一行
    await eventually(
      dockShot,
      (d) => expect(d?.calls).toEqual([{ tool: 'network', status: 'ok' }]),
      'the new call is recorded'
    )
  })
})
