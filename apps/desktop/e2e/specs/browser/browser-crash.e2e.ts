/**
 * 内置浏览器里一个 tab 的页面渲染进程崩了（假提供商脚本化；夹具网站记下每一个请求）。崩溃页上发给页面的
 * CDP 命令会一直挂着（Runtime.evaluate / DOM / Accessibility / Page.enable …），直到有人重新加载页面 ——
 * 产品让 agent 的工具当场失败、说清怎么把它救回来（navigate reload / close_tab），把它救回来的那次导航
 * 照常等加载，卡片上显示「页面崩溃了」+ 重试。本 spec 按顺序走一个实例：
 *
 *   CR-E1 agent 正在驱动的 tab 崩了（浏览器窗口从没开过；崩溃落在上一个动作的文件框拦截宽限期里）：
 *         snapshot / evaluate / screenshot 各回恰好「[MCP Error] <那句话>」，wait_for 回「stopped waiting
 *         for text …: <那句话>」（不等满 20s），list_tabs 照常、只有它那一行标 (crashed)，这一轮不到 5s；
 *         主进程日志里「Tab renderer gone: <uuid> (crashed)」恰好一行；窗口没出现。nav reload 回恰好
 *         「Reloaded <url>. Take a snapshot before interacting.」、IPC 不再算崩着；之后点文件输入框照常被拦下
 *         （回报带提示、页面零文件、保险那条会话看到一次单选框），防护从没装失败、没有未捕获的异常；
 *   CR-E2 崩溃那一刻还在路上的命令（evaluate 一个永远不 resolve 的 promise）：回恰好「[MCP Error] <那句话>」，
 *         崩溃之后 5s 内落定；nav goto 把它救回来（恰好「Navigated to <url>. …」，服务器收到一次请求）；
 *   CR-E5 页面的 print 改写熬过崩溃：agent 开的打印页（主文档 + iframe 各打印一次 → 两行 dropped）崩了、
 *         reload 救回来 —— 新文档上 print 照样不是原生的、照样两行 dropped；
 *   CR-E3 接管之前就崩了的 tab、浏览器窗口晚于崩溃才打开：墙上它的卡片不给页面占位（「页面崩溃了」），
 *         别的卡片照常；list_tabs 标 (crashed)，snapshot 回那句话（不到 5s，日志「agent guards wait until the
 *         page is reloaded」恰好一行）；nav reload 救回来、卡片换回页面；之后点文件输入框照常被拦下；
 *   CR-E4 窗口开着时崩了：卡片不给页面占位；浏览器窗口自己重新加载之后（水合）仍是那样；IPC navigate（卡片上
 *         「重试」走的就是它）救回来：不再算崩着、服务器多一次请求、卡片换回页面。
 *
 * 崩溃一律由 `crashTab` 造：在那个 tab 的页面 target 上另开一条 DevTools 会话发 `Page.crash`（不等回包 ——
 * 渲染进程没了，回包永远不来），等 IPC listTabs 那一行报 crashed 再往下走。CR-E5 排在 CR-E3 之前：
 * 浏览器窗口一开（用户在看），打印就不再丢弃而是弹原生打印框。
 * **保险**同 browser-no-disturb：点文件输入框之前先在那个 tab 上装 `interceptFileChoosers`（页面救回来之后、
 * 点之前装）；打印页先查 print 是不是原生的，是原生的就不调。
 * 窗口「开没开」一律问 IPC `isWindowOpen()`。会话给显式标题（缺省标题会让自动起标题的 hook 抢走脚本里的轮次）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PAGE_CRASHED_MESSAGE } from '@shuvix/agent-runtime'
import { sleep, until, type CdpClient } from '../../harness/cdp'
import { launchApp, uncaughtExceptions, type E2EApp } from '../../harness/launch'
import { startFakeProvider, type FakeProvider } from '../../harness/fakeProvider'
import {
  eventRecorder,
  seedFakeProvider,
  waitRendererReady,
  type EventRecorder
} from '../../harness/seed'
import { browserWallPane, type BrowserWallPane } from '../../harness/pages'
import {
  BROWSER_TOOL_NAMES,
  browserDriver,
  browserTool,
  connectTabPage,
  interceptFileChoosers,
  startFixtureServer,
  tabIdOf,
  type BrowserDriver,
  type FileChooserNet,
  type FixtureServer,
  type ScriptedCall,
  type ToolResultRecord
} from '../../harness/browserFixtures'

const MODEL = 'e2e-model'
const TITLE = 'CR crashed tabs'
const ALL_BROWSER_TOOLS = BROWSER_TOOL_NAMES.map(browserTool).sort()
const S = PAGE_CRASHED_MESSAGE
const CRASHED_ERROR = `[MCP Error] ${S}`

/** 主进程日志里的几行（agentGuards.ts） */
const SUPPRESSED = 'file chooser opened while the browser window is not in front: suppressed'
const DROPPED = 'window.print() while the browser window is not in front: dropped'
const INSTALL_FAILED = 'installing agent guards on tab'

/** 工具回报里的提示（agentGuards.fileChooserNote；注意 user’s 是 U+2019） */
const NOTE_ONE =
  "Note: this opened the page's file chooser (one file). ShuviX suppressed the native file dialog so it cannot pop up on the user’s screen. To attach files, call upload_file on the file input (take a snapshot to find its uid)."

interface TabRow {
  id: string
  url: string
  title: string
  active: boolean
  crashed: boolean
}

let app: E2EApp
let provider: FakeProvider
let events: EventRecorder
let fixture: FixtureServer
let driver: BrowserDriver
let sid = ''
/** 浏览器窗口页面的 CDP 客户端（CR-E3 连上，一直用到 afterAll） */
let bw: CdpClient | null = null
let wall: BrowserWallPane
/** 各段装上的文件框保险（afterAll 收） */
const nets: FileChooserNet[] = []
/** CR-E2 救回来的那个 tab 的地址（CR-E3 拿它做对照：没崩的卡片照常有页面） */
let urlB2 = ''

// ─── IPC 助手 ───

const isWindowOpen = (): Promise<boolean> =>
  app.main.eval<boolean>('window.api.browserView.isWindowOpen()')
const listTabs = (): Promise<TabRow[]> =>
  app.main.eval<TabRow[]>('window.api.browserView.listTabs()')
const createTab = (url: string): Promise<string> =>
  app.main.eval<string>(`window.api.browserView.createTab(${JSON.stringify(url)})`)
const closeTab = (tabId: string): Promise<unknown> =>
  app.main.eval(`window.api.browserView.closeTab(${JSON.stringify(tabId)})`)
/** 卡片上的「重试」走的就是这条 IPC */
const navigateTab = (tabId: string, url: string): Promise<unknown> =>
  app.main.eval(`window.api.browserView.navigate(${JSON.stringify(tabId)}, ${JSON.stringify(url)})`)
const rowOf = async (url: string): Promise<TabRow | undefined> =>
  (await listTabs()).find((t) => t.url === url)
const countInLog = (needle: string): number => app.mainLog().split(needle).length - 1

/**
 * 让某个 tab 的页面渲染进程崩掉：在它的页面 target 上另开一条 DevTools 会话发 `Page.crash`（不等回包），
 * 等 IPC listTabs 那一行报 crashed，再关掉这条会话
 */
async function crashTab(match: (url: string) => boolean): Promise<void> {
  const page = await until(() => connectTabPage(app.port, match), 'tab page target to crash')
  try {
    await until(
      async () => (await page.eval<string>('document.readyState')) === 'complete',
      'the page to crash has loaded'
    )
    void page.send('Page.crash').catch(() => {})
    await until(
      async () => (await listTabs()).some((t) => match(t.url) && t.crashed),
      'IPC listTabs reports the tab crashed'
    )
  } finally {
    page.close()
  }
}

/** 建一条勾了 mcp:browser 的会话并让运行时起来，回会话 id */
const tickedSession = async (title: string): Promise<string> => {
  const id = await app.main.eval<string>(
    `window.api.session.create(${JSON.stringify({ title })}).then((s) => s.id)`
  )
  const wrote = await app.main.eval<{ success: boolean }>(
    `window.api.session.updateEnabledTools(${JSON.stringify({ id, enabledTools: ['mcp:browser'] })})`
  )
  expect(wrote.success).toBe(true)
  const info = await app.main.eval<{ tools: Array<{ name: string }> } | null>(
    `window.api.agent.getInfo(${JSON.stringify(id)}, { ensure: true })`
  )
  const browserTools = (info?.tools ?? [])
    .map((t) => t.name)
    .filter((n) => n.startsWith('mcp__browser__'))
    .sort()
  expect(browserTools).toEqual(ALL_BROWSER_TOOLS)
  return id
}

/** 一次不该有询问的运行：跑完，断言确实没有卡 */
const run = async (
  calls: Array<ScriptedCall | ScriptedCall[]>
): Promise<Record<string, ToolResultRecord>> => {
  provider.reset()
  const { ends, since } = await driver.run(sid, calls)
  expect(await driver.asksSince(since, sid)).toBe(0)
  return ends
}

/** 这次调用的结果（没有就判红，带上已有的调用 id） */
const endOf = (ends: Record<string, ToolResultRecord>, id: string): ToolResultRecord => {
  const end = ends[id]
  expect(end, `${id} (have: ${Object.keys(ends).join(', ')})`).toBeDefined()
  return end
}

/** 成功的一次调用 */
const ok = (ends: Record<string, ToolResultRecord>, id: string): ToolResultRecord => {
  const end = endOf(ends, id)
  expect(end.isError, `${id}: ${end.result}`).toBe(false)
  return end
}

/** 失败的一次调用 */
const failed = (ends: Record<string, ToolResultRecord>, id: string): ToolResultRecord => {
  const end = endOf(ends, id)
  expect(end.isError, `${id}: ${end.result}`).toBe(true)
  return end
}

/** evaluate 的结果（JSON.stringify(value, null, 2)）还原成值 */
const valueOf = (ends: Record<string, ToolResultRecord>, id: string): unknown =>
  JSON.parse(ok(ends, id).result)

/** 快照里某个可访问名字的元素 uid（角色不限，`"<name>"` 精确匹配） */
const uidNamed = (snapshot: string, name: string): string => {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = new RegExp(`uid=(\\w+)(?: [\\w-]+)? "${escaped}"`).exec(snapshot)
  if (!m) throw new Error(`no element named "${name}" in snapshot:\n${snapshot}`)
  return m[1]
}

/** list_tabs 结果里某个地址那一行的短号 */
const shortIdIn = (listed: string, url: string): string => {
  const line = listed.split('\n').find((l) => l.endsWith(` — ${url}`))
  const m = line ? /^\[(t\d+)\]/.exec(line) : null
  if (!m) throw new Error(`no line for ${url} in list_tabs:\n${listed}`)
  return m[1]
}

const evaluate = (id: string, tabId: string, expression: string): ScriptedCall => ({
  id,
  tool: 'evaluate',
  args: { tabId, expression }
})

/**
 * 反复读、直到断言全过；超时就把最后一次读数连同失败的断言一起抛出来（同 browser-self-close.e2e.ts）。
 */
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

/** 文件输入框那一段：装好保险 → 快照 → 点 Attachment → 读页面；回报带提示、页面零文件、保险看到一次单选框 */
async function clickAttachmentGuarded(label: string, url: string, tabId: string): Promise<void> {
  const net = await interceptFileChoosers(app.port, (u) => u === url)
  nets.push(net)
  const snap = await run([{ id: `${label}_snap`, tool: 'snapshot', args: { tabId } }])
  const snapshot = ok(snap, `${label}_snap`).result
  expect(snapshot).toContain('Attachment')
  const attachment = uidNamed(snapshot, 'Attachment')
  const clicked = await run([
    { id: `${label}_click`, tool: 'click', args: { tabId, uid: attachment } },
    evaluate(
      `${label}_state`,
      tabId,
      "({ clicks: window.__clicks, files: document.getElementById('f').files.length })"
    )
  ])
  expect(ok(clicked, `${label}_click`).result).toContain(`\n${NOTE_ONE}`)
  expect(valueOf(clicked, `${label}_state`)).toEqual({ clicks: 1, files: 0 })
  expect(net.opened()).toEqual(['selectSingle'])
}

beforeAll(async () => {
  app = await launchApp()
  provider = await startFakeProvider()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(app.main)
  events = eventRecorder(app.main)
  await events.install()
  fixture = await startFixtureServer()
  driver = browserDriver({ main: app.main, provider, events })
  sid = await tickedSession(TITLE)
}, 120_000)

afterAll(async () => {
  for (const net of nets) net.close()
  bw?.close()
  await provider?.close()
  await fixture?.close()
  await app?.stop()
})

describe('agent 正在驱动的 tab 崩了（CR-E1）', () => {
  it('CR-E1 读页面的工具当场回那句话、wait_for 不等、list_tabs 标 (crashed)；reload 救回来；之后文件框照常被拦下', async () => {
    expect(await isWindowOpen()).toBe(false)
    const urlA = fixture.url('/upload.html?cr=1')
    const opened = await run([{ id: 'cr1_open', tool: 'open_tab', args: { url: urlA } }])
    const tA = tabIdOf(ok(opened, 'cr1_open').result)
    const snap = await run([{ id: 'cr1_snap', tool: 'snapshot', args: { tabId: tA } }])
    expect(ok(snap, 'cr1_snap').result).toContain('Attachment')
    // 一个受防护的动作：打开文件框拦截，随后 5s 宽限期 —— 崩溃落在宽限期里
    const armed = await run([evaluate('cr1_arm', tA, '1')])
    const armedAt = Date.now()
    expect(valueOf(armed, 'cr1_arm')).toBe(1)
    const uuidA = (await rowOf(urlA))?.id
    expect(uuidA, 'A in IPC listTabs').toBeTruthy()

    await crashTab((u) => u === urlA)
    expect(Date.now() - armedAt, 'the crash should land inside the 5s grace').toBeLessThan(5_000)

    // ── 崩着：读页面的工具当场失败，说清怎么救；list_tabs 照常（一轮一个调用，计时） ──
    const t0 = Date.now()
    const r1 = await run([
      { id: 'cr1_snap_crashed', tool: 'snapshot', args: { tabId: tA } },
      evaluate('cr1_eval_crashed', tA, 'document.title'),
      { id: 'cr1_shot_crashed', tool: 'screenshot', args: { tabId: tA } },
      {
        id: 'cr1_wait_crashed',
        tool: 'wait_for',
        args: { tabId: tA, text: 'never-there', timeout: 20_000 }
      },
      { id: 'cr1_list', tool: 'list_tabs', args: {} }
    ])
    const tookMs = Date.now() - t0
    expect(failed(r1, 'cr1_snap_crashed').result).toBe(CRASHED_ERROR)
    expect(failed(r1, 'cr1_eval_crashed').result).toBe(CRASHED_ERROR)
    expect(failed(r1, 'cr1_shot_crashed').result).toBe(CRASHED_ERROR)
    expect(failed(r1, 'cr1_wait_crashed').result).toBe(
      `[MCP Error] stopped waiting for text "never-there": ${S}`
    )
    const listed = ok(r1, 'cr1_list').result
    const crashedLines = listed.split('\n').filter((l) => l.includes(' (crashed)'))
    expect(crashedLines).toHaveLength(1)
    expect(crashedLines[0].startsWith(`[${tA}] `)).toBe(true)
    expect(crashedLines[0]).toContain(urlA)
    expect(tookMs, `the crashed-tab run took ${tookMs}ms — something waited`).toBeLessThan(5_000)
    expect(countInLog(`Tab renderer gone: ${uuidA} (crashed)`)).toBe(1)
    expect(await isWindowOpen()).toBe(false)

    // ── nav reload 把它救回来 ──
    const r2 = await run([
      { id: 'cr1_reload', tool: 'navigate', args: { tabId: tA, nav: 'reload' } }
    ])
    expect(ok(r2, 'cr1_reload').result).toBe(
      `Reloaded ${urlA}. Take a snapshot before interacting.`
    )
    expect((await rowOf(urlA))?.crashed).toBe(false)

    // ── 救回来的页面上点文件输入框：照常被拦下、回报带提示 ──
    await clickAttachmentGuarded('cr1', urlA, tA)
    expect(countInLog(SUPPRESSED)).toBe(0)
    expect(countInLog(INSTALL_FAILED)).toBe(0)
    expect(await isWindowOpen()).toBe(false)
    expect(uncaughtExceptions(app)).toBe('')
  }, 180_000)
})

describe('崩溃那一刻还在路上的命令（CR-E2）', () => {
  it('CR-E2 evaluate 一个永远不 resolve 的 promise 时页面崩了：回恰好那句话、5s 内落定；nav goto 救回来', async () => {
    const urlB = fixture.url('/form.html?cr=2')
    const opened = await run([{ id: 'cr2_open', tool: 'open_tab', args: { url: urlB } }])
    const tB = tabIdOf(ok(opened, 'cr2_open').result)

    provider.reset()
    const since = await driver.start(sid, [
      evaluate('cr2_inflight', tB, '(window.__inflight = true, new Promise(() => {}))')
    ])
    const page = await until(
      () => connectTabPage(app.port, (u) => u === urlB),
      'form page target (DevTools)'
    )
    let t0 = 0
    try {
      await until(
        async () => (await page.eval<boolean>('window.__inflight === true')) || null,
        "the agent's evaluate is running on the page"
      )
      t0 = Date.now()
      void page.send('Page.crash').catch(() => {})
      const { ends } = await driver.finish(sid, since)
      const settledMs = Date.now() - t0
      expect(failed(ends, 'cr2_inflight').result).toBe(CRASHED_ERROR)
      expect(
        settledMs,
        `the in-flight evaluate settled ${settledMs}ms after the crash`
      ).toBeLessThan(5_000)
    } finally {
      page.close()
    }
    expect(await driver.asksSince(since, sid)).toBe(0)
    expect((await rowOf(urlB))?.crashed).toBe(true)

    // ── nav goto 把它救回来 ──
    urlB2 = fixture.url('/form.html?cr=2b')
    const r = await run([
      { id: 'cr2_goto', tool: 'navigate', args: { tabId: tB, nav: 'goto', url: urlB2 } },
      evaluate('cr2_title', tB, 'document.title')
    ])
    expect(ok(r, 'cr2_goto').result).toBe(
      `Navigated to ${urlB2}. Take a snapshot before interacting.`
    )
    expect(valueOf(r, 'cr2_title')).toBe('E2E Form')
    expect(fixture.hits('/form.html?cr=2b')).toBe(1)
    expect((await rowOf(urlB2))?.crashed).toBe(false)
    expect(uncaughtExceptions(app)).toBe('')
  }, 120_000)
})

describe('页面的 print 改写熬过崩溃（CR-E5）', () => {
  const PRINT_STATE =
    '({ native: window.__native, printed: window.__printed === true, child: window.__child === undefined ? null : window.__child })'
  /** 主文档 + 它的 iframe 各调一次 print：每加载一次多两行 dropped */
  const OVERRIDDEN = { native: false, printed: true, child: 'override' }

  // 之后的段会把浏览器窗口打开（用户在看 = 打印弹原生框）：打印页不留到那时
  afterAll(async () => {
    for (const t of await listTabs()) {
      if (t.url.includes('/print.html')) await closeTab(t.id)
    }
  })

  it('CR-E5 agent 开的打印页崩了、reload 救回来：新文档上 print 照样不是原生的，照样两行 dropped', async () => {
    expect(await isWindowOpen()).toBe(false)
    const url = fixture.url('/print.html?cr=5a')
    const before = countInLog(DROPPED)
    const opened = await run([{ id: 'cr5a_open', tool: 'open_tab', args: { url } }])
    const tab = tabIdOf(ok(opened, 'cr5a_open').result)
    await until(() => countInLog(DROPPED) >= before + 2, 'two dropped print lines', 15_000)
    const first = await run([evaluate('cr5a_state', tab, PRINT_STATE)])
    expect(valueOf(first, 'cr5a_state')).toEqual(OVERRIDDEN)
    expect(countInLog(DROPPED)).toBe(before + 2)

    await crashTab((u) => u === url)
    const reloaded = await run([
      { id: 'cr5a_reload', tool: 'navigate', args: { tabId: tab, nav: 'reload' } }
    ])
    expect(ok(reloaded, 'cr5a_reload').result).toBe(
      `Reloaded ${url}. Take a snapshot before interacting.`
    )
    await until(() => countInLog(DROPPED) >= before + 4, 'two more dropped print lines', 15_000)
    const after = await run([evaluate('cr5a_state_after', tab, PRINT_STATE)])
    expect(valueOf(after, 'cr5a_state_after')).toEqual(OVERRIDDEN)
    await sleep(300)
    expect(countInLog(DROPPED)).toBe(before + 4)
    expect(uncaughtExceptions(app)).toBe('')
  }, 120_000)
})

describe('接管之前就崩了的 tab，浏览器窗口晚于崩溃才打开（CR-E3）', () => {
  it('CR-E3 墙上的卡片不给页面占位；list_tabs 标 (crashed)、snapshot 回那句话；reload 救回来、卡片换回页面；之后文件框照常被拦下', async () => {
    const urlC = fixture.url('/upload.html?cr=3')
    const uuidC = await createTab(urlC)
    await until(async () => (await rowOf(urlC))?.id === uuidC, 'C on its page')
    await crashTab((u) => u === urlC)

    // ── 用户这时才打开浏览器窗口：崩了的卡片从水合里知道自己崩了 ──
    expect(await isWindowOpen()).toBe(false)
    await app.main.eval('window.api.browserView.openWindow()')
    await until(() => isWindowOpen(), 'browser window open')
    bw = await until(() => app.browserWindow(), 'browser window page')
    wall = browserWallPane(bw)
    await until(() => wall.mounted(), 'browser window shell mounted')
    const uuidB2 = (await rowOf(urlB2))?.id
    expect(uuidB2, 'B (rescued in CR-E2) in IPC listTabs').toBeTruthy()
    await eventually(
      async () => ({
        cards: await wall.cardIds(),
        crashedPage: await wall.pageAreaRect(uuidC),
        healthyPage: await wall.pageAreaRect(uuidB2!)
      }),
      ({ cards, crashedPage, healthyPage }) => {
        expect(cards).toContain(uuidC)
        expect(crashedPage).toBeNull()
        expect(healthyPage).not.toBeNull()
      },
      "C's card shows no page area, B's does"
    )
    await sleep(500)
    expect(await wall.pageAreaRect(uuidC)).toBeNull()

    // ── agent：list_tabs 标 (crashed)，snapshot 当场回那句话（接管时防护推迟、不挂住） ──
    const t0 = Date.now()
    const listed = await run([{ id: 'cr3_list', tool: 'list_tabs', args: {} }])
    const listText = ok(listed, 'cr3_list').result
    const lineC = listText.split('\n').find((l) => l.endsWith(` — ${urlC}`))
    expect(lineC, listText).toContain('(crashed)')
    const tC = shortIdIn(listText, urlC)
    const snapped = await run([{ id: 'cr3_snap_crashed', tool: 'snapshot', args: { tabId: tC } }])
    const tookMs = Date.now() - t0
    expect(failed(snapped, 'cr3_snap_crashed').result).toBe(CRASHED_ERROR)
    expect(tookMs, `the crashed-tab runs took ${tookMs}ms — something waited`).toBeLessThan(5_000)
    expect(
      countInLog(`Tab ${uuidC} is crashed: agent guards wait until the page is reloaded`)
    ).toBe(1)

    // ── nav reload 救回来：卡片换回页面 ──
    const reloaded = await run([
      { id: 'cr3_reload', tool: 'navigate', args: { tabId: tC, nav: 'reload' } }
    ])
    expect(ok(reloaded, 'cr3_reload').result).toBe(
      `Reloaded ${urlC}. Take a snapshot before interacting.`
    )
    expect((await rowOf(urlC))?.crashed).toBe(false)
    await eventually(
      () => wall.pageAreaRect(uuidC),
      (rect) => expect(rect).not.toBeNull(),
      "C's card shows its page again"
    )

    // ── 推迟装上的防护照常起作用 ──
    await clickAttachmentGuarded('cr3', urlC, tC)
    expect(countInLog(INSTALL_FAILED)).toBe(0)
    expect(uncaughtExceptions(app)).toBe('')
  }, 180_000)
})

describe('窗口开着时崩了，窗口重新加载，再点重试（CR-E4）', () => {
  it('CR-E4 卡片不给页面占位；浏览器窗口重新加载后仍是那样；IPC navigate（重试）救回来、卡片换回页面', async () => {
    expect(await isWindowOpen()).toBe(true)
    const urlD = fixture.url('/counter.html?cr=4')
    const uuidD = await createTab(urlD)
    await eventually(
      async () => ({ cards: await wall.cardIds(), page: await wall.pageAreaRect(uuidD) }),
      ({ cards, page }) => {
        expect(cards).toContain(uuidD)
        expect(page).not.toBeNull()
      },
      "D's card with its page"
    )
    const hitsD = fixture.hits('/counter.html?cr=4')
    expect(hitsD).toBe(1)

    await crashTab((u) => u === urlD)
    await eventually(
      async () => ({ cards: await wall.cardIds(), page: await wall.pageAreaRect(uuidD) }),
      ({ cards, page }) => {
        expect(cards).toContain(uuidD)
        expect(page).toBeNull()
      },
      "D's card shows no page area (live crash event)"
    )

    // ── 浏览器窗口自己重新加载：从 listTabs 水合，仍知道它崩着 ──
    await bw!.send('Page.reload')
    await until(() => wall.mounted(), 'browser window shell mounted again')
    await eventually(
      async () => ({ cards: await wall.cardIds(), page: await wall.pageAreaRect(uuidD) }),
      ({ cards, page }) => {
        expect(cards).toContain(uuidD)
        expect(page).toBeNull()
      },
      "D's card still shows no page area after the window reloaded"
    )
    await sleep(500)
    expect(await wall.pageAreaRect(uuidD)).toBeNull()

    // ── 重试（IPC navigate 到 loadError 的地址）：救回来 ──
    await navigateTab(uuidD, urlD)
    await eventually(
      async () => ({
        crashed: (await rowOf(urlD))?.crashed,
        hits: fixture.hits('/counter.html?cr=4'),
        page: await wall.pageAreaRect(uuidD)
      }),
      ({ crashed, hits, page }) => {
        expect(crashed).toBe(false)
        expect(hits).toBe(hitsD + 1)
        expect(page).not.toBeNull()
      },
      'D rescued by retry: page area back'
    )
    expect(uncaughtExceptions(app)).toBe('')
  }, 120_000)
})
