/**
 * 页面自己关掉自己（`window.close()`）的 tab —— 登录弹出页授权完成、会话过期页……（假提供商脚本化；
 * 夹具网站记下每一个请求）。Electron 不问任何人就销毁那个 webContents；产品把它当作 tab 被关掉了：
 * 从 tab 表里摘掉、激活邻居、告诉卡片墙与顶栏徽标 —— 与 closeTab 同一份收尾。不收的话 tab 表里留着
 * 一个空壳：卡片空白、点关闭抛错、listTabs 抛错，永远关不掉。本 spec 按顺序走一个实例：
 *
 *   SC-2  agent 经 CDP 驱动过的 tab 自己关掉（浏览器窗口从没开过）：IPC listTabs 只剩 B、B 激活（右邻），
 *         徽标 2 → 1，窗口仍没出现；agent 的 list_tabs 不再列它，对它 snapshot / close_tab 回普通的
 *         「No browser tab」错误（不是「对象已销毁」），状态不变；留下的 B 照常快照 → 填 → 点（服务器
 *         收到一次提交）；主进程没有未捕获的异常；
 *   SC-2b 用户第一次点开浏览器窗口：墙上只有 B 一张、是激活的那张 —— 没有空白的幽灵卡片；
 *   SC-3  agent 的 click 当场让页面关掉自己（OAuth「授权」按钮的形状：同步发个 beacon 就 window.close()）：
 *         运行照常走到 agent_end，服务器收到 beacon，tab 从 IPC / list_tabs / 墙上消失，左邻激活，徽标
 *         对得上，没有未捕获的异常（click 自己的回报措辞不钉）；
 *   SC-1  墙开着、激活卡片的页面自己关掉（纯用户路径，没有 agent 的 CDP 会话）：右邻激活、墙上不留洞、
 *         徽标 −1、别的页面没重载；再对它点关闭（卡片上的 ✕ = IPC closeTab）静默无事；再关左边一张、
 *         最后一张：墙空、徽标消失，之后新开的 tab 照常上墙、是唯一激活的那张；
 *   SC-4  agent 点 target=_blank 打开的登录弹出页（开它的 tab 在 agent 手里，弹出页加载之前就接上了 CDP）
 *         加载 800ms 后自己关掉：开它的那张重新激活（左邻）、list_tabs 不再列它、徽标回原值，没有未捕获
 *         的异常。
 *
 * 每一段都先确认页面真的关了 —— DevTools 的 target 列表里没有它了（`waitTabPageGone`）—— 再断产品，
 * 把「Electron 没关它」与「产品没注意到」分开。页面关自己用 `pageClosesItself`：DevTools 只是让页面自己的
 * 代码过一小会儿调 window.close()，关的动作是页面自己的（不是 Target.closeTarget，也不是 closeTab）。
 * 窗口「开没开」一律问 IPC `isWindowOpen()`（理由见 browser-window.e2e.ts 文件头）。
 * 每条会话给显式标题（缺省标题会让自动起标题的 hook 抢走脚本里的轮次）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sleep, until, type CdpClient } from '../../harness/cdp'
import { launchApp, uncaughtExceptions, type E2EApp } from '../../harness/launch'
import { startFakeProvider, type FakeProvider } from '../../harness/fakeProvider'
import {
  eventRecorder,
  seedFakeProvider,
  waitRendererReady,
  type EventRecorder
} from '../../harness/seed'
import {
  browserWallPane,
  chatPane,
  openBrowserWindowButton,
  sidebarPane,
  type BrowserWallPane
} from '../../harness/pages'
import {
  BROWSER_TOOL_NAMES,
  browserDriver,
  browserTool,
  pageClosesItself,
  startFixtureServer,
  tabIdOf,
  uidOf,
  waitTabPageGone,
  type BrowserDriver,
  type FixtureServer,
  type ToolResultRecord
} from '../../harness/browserFixtures'

const MODEL = 'e2e-model'
const ALL_BROWSER_TOOLS = BROWSER_TOOL_NAMES.map(browserTool).sort()
/** 两列墙要的最小宽度：列数 = round(宽 / 620)，930 起才是 2（同 browser-window.e2e.ts 的 E5） */
const TWO_COLUMN_MIN_WIDTH = 930
/** 「对象已销毁」一类的报错 —— 自己关掉的 tab 在产品里留了空壳时，agent 工具碰到的就是它们 */
const DESTROYED_ERROR = /destroyed|Cannot read properties/

interface TabRow {
  id: string
  url: string
  title: string
  active: boolean
}

let app: E2EApp
let provider: FakeProvider
let events: EventRecorder
let fixture: FixtureServer
let driver: BrowserDriver
/** SC-2 / SC-3 / SC-4 共用的会话（勾了 mcp:browser） */
let sid = ''
/** 浏览器窗口页面的 CDP 客户端（SC-2b 连上，一直用到 afterAll） */
let bw: CdpClient | null = null
let wall: BrowserWallPane

// ─── IPC 助手 ───

const isWindowOpen = (): Promise<boolean> =>
  app.main.eval<boolean>('window.api.browserView.isWindowOpen()')
const listTabs = (): Promise<TabRow[]> =>
  app.main.eval<TabRow[]>('window.api.browserView.listTabs()')
const createTab = (url: string): Promise<string> =>
  app.main.eval<string>(`window.api.browserView.createTab(${JSON.stringify(url)})`)
const activateTab = (tabId: string): Promise<unknown> =>
  app.main.eval(`window.api.browserView.activateTab(${JSON.stringify(tabId)})`)
/** 卡片上的 ✕：用户关 tab 走的就是这条 IPC */
const closeTab = (tabId: string): Promise<unknown> =>
  app.main.eval(`window.api.browserView.closeTab(${JSON.stringify(tabId)})`)
const navigateTab = (tabId: string, url: string): Promise<unknown> =>
  app.main.eval(`window.api.browserView.navigate(${JSON.stringify(tabId)}, ${JSON.stringify(url)})`)
const openWindow = async (): Promise<void> => {
  await app.main.eval('window.api.browserView.openWindow()')
  await until(() => isWindowOpen(), 'browser window open')
}
const closeAllTabs = async (): Promise<void> => {
  for (const t of await listTabs()) await closeTab(t.id)
  await until(async () => (await listTabs()).length === 0, 'all browser tabs closed')
  await until(async () => (await wall.cardIds()).length === 0, 'browser wall emptied')
}
/** tab 表的形状：顺序 + 谁激活 */
const tabShape = async (): Promise<Array<{ id: string; active: boolean }>> =>
  (await listTabs()).map((t) => ({ id: t.id, active: t.active }))

/** 顶栏按钮（带 tab 计数徽标） */
const headerButton = (): ReturnType<typeof openBrowserWindowButton> =>
  openBrowserWindowButton(app.main)
const waitBadge = (n: number | null): Promise<unknown> =>
  until(async () => (await headerButton().count()) === n || null, `header badge = ${n}`)

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

/** 一次调用的结果：在、而且没出错 */
const ok = (ends: Record<string, ToolResultRecord>, id: string): ToolResultRecord => {
  const end = ends[id]
  expect(end, `${id}: no tool result`).toBeDefined()
  expect(end.isError, `${id}: ${end.result}`).toBe(false)
  return end
}
/** 一次调用的结果：在、而且出错了 */
const failed = (ends: Record<string, ToolResultRecord>, id: string): ToolResultRecord => {
  const end = ends[id]
  expect(end, `${id}: no tool result`).toBeDefined()
  expect(end.isError, `${id}: ${end.result}`).toBe(true)
  return end
}

/**
 * 反复读、直到断言全过；超时就把最后一次读数连同失败的断言一起抛出来（同 browser-window.e2e.ts）。
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

beforeAll(async () => {
  app = await launchApp()
  provider = await startFakeProvider()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(app.main)
  events = eventRecorder(app.main)
  await events.install()
  fixture = await startFixtureServer()
  driver = browserDriver({ main: app.main, provider, events })
}, 120_000)

afterAll(async () => {
  bw?.close()
  await provider?.close()
  await fixture?.close()
  await app?.stop()
})

describe('agent 驱动过的 tab 自己关掉，浏览器窗口从没开过（SC-2）', () => {
  const TITLE = 'SC self-close agent'
  let uuidB = ''

  beforeAll(async () => {
    sid = await tickedSession(TITLE)
    // 会话开在主窗界面上：徽标就在这个界面的顶栏里
    const sidebar = sidebarPane(app.main)
    await until(async () => (await sidebar.titles()).includes(TITLE), `sidebar row "${TITLE}"`)
    expect(await sidebar.openSession(TITLE)).toBe(true)
    await chatPane(app.main).ready()
  }, 120_000)

  /** 浏览器窗口没开、连 target 都没有（从没建过） */
  const expectNoWindow = async (when: string): Promise<void> => {
    expect(await isWindowOpen(), `${when}: browser window open`).toBe(false)
    expect(await app.browserWindow(), `${when}: #browser-window target exists`).toBeNull()
  }

  it('SC-2 agent 快照过的 A 自己关掉：IPC 只剩 B 且激活、徽标 2 → 1、窗口不出现；list_tabs 不列它，snapshot / close_tab 它回普通的 No browser tab；B 照常快照 → 填 → 点；没有未捕获的异常', async () => {
    await expectNoWindow('fresh instance')

    // ── 开 A（会自己关的页面）、B（表单）；再快照 A（A 激活，CDP 会话接上） ──
    provider.reset()
    const urlA = fixture.url('/closer.html?tag=sc2a')
    const urlB = fixture.url('/form.html?sc=2b')
    const opened = await driver.run(sid, [
      { id: 'sc2_open_a', tool: 'open_tab', args: { url: urlA } },
      { id: 'sc2_open_b', tool: 'open_tab', args: { url: urlB } }
    ])
    const tA = tabIdOf(ok(opened.ends, 'sc2_open_a').result)
    const tB = tabIdOf(ok(opened.ends, 'sc2_open_b').result)

    provider.reset()
    const snapA = await driver.run(sid, [
      { id: 'sc2_snap_a', tool: 'snapshot', args: { tabId: tA } }
    ])
    expect(ok(snapA.ends, 'sc2_snap_a').result).toContain('button "Close now"')

    const before = await listTabs()
    expect(before.map((t) => t.url)).toEqual([urlA, urlB])
    expect(before.map((t) => t.active)).toEqual([true, false])
    uuidB = before[1].id
    await waitBadge(2)
    await expectNoWindow('before the page closes itself')

    // ── A 的页面自己关掉 ──
    const isA = (u: string): boolean => u.includes('tag=sc2a')
    await pageClosesItself(app.port, isA)
    await waitTabPageGone(app.port, isA)

    // IPC listTabs 照常回（空壳会让它抛）、只剩 B、B 是右邻所以激活
    await eventually(
      () => tabShape(),
      (tabs) => expect(tabs).toEqual([{ id: uuidB, active: true }]),
      'only B left, active'
    )
    await waitBadge(1)
    await expectNoWindow('after the page closed itself')

    // ── agent 那一侧：list_tabs / 对 A 的操作 / 留下的 B（一轮一个调用） ──
    provider.reset()
    const r3 = await driver.run(sid, [
      { id: 'sc2_list', tool: 'list_tabs', args: {} },
      { id: 'sc2_snap_gone', tool: 'snapshot', args: { tabId: tA } },
      { id: 'sc2_close_gone', tool: 'close_tab', args: { tabId: tA } },
      { id: 'sc2_snap_b', tool: 'snapshot', args: { tabId: tB } }
    ])
    const listed = ok(r3.ends, 'sc2_list').result
    expect(listed).toContain(`[${tB}]`)
    expect(listed).toContain(urlB)
    expect(listed).not.toContain(`[${tA}]`)
    expect(listed).not.toContain('closer.html')
    // 自己关掉的 tab 与已经关掉的 tab 一样：普通的「没有这个 tab」，而不是碰到已销毁对象的报错
    const snapGone = failed(r3.ends, 'sc2_snap_gone').result
    expect(snapGone).toContain(`No browser tab "${tA}"`)
    expect(snapGone).not.toMatch(DESTROYED_ERROR)
    const closeGone = failed(r3.ends, 'sc2_close_gone').result
    expect(closeGone).toContain(`No browser tab "${tA}"`)
    expect(closeGone).not.toMatch(DESTROYED_ERROR)
    const snapB = ok(r3.ends, 'sc2_snap_b').result
    expect(snapB).toContain('textbox "Name"')
    // close_tab 一个不在的 tab 不动任何东西
    expect(await tabShape()).toEqual([{ id: uuidB, active: true }])
    expect(await headerButton().count()).toBe(1)

    // ── 留下的 B 照常干活：填 → 点，服务器收到一次提交 ──
    provider.reset()
    const r4 = await driver.run(sid, [
      {
        id: 'sc2_fill',
        tool: 'fill',
        args: { tabId: tB, uid: uidOf(snapB, 'textbox', 'Name'), text: 'after-close' }
      },
      {
        id: 'sc2_click',
        tool: 'click',
        args: { tabId: tB, uid: uidOf(snapB, 'button', 'Submit') }
      }
    ])
    ok(r4.ends, 'sc2_fill')
    ok(r4.ends, 'sc2_click')
    await until(
      () => fixture.hits('/submit?name=after-close') >= 1,
      'B form submitted to the server'
    )
    await sleep(300)
    expect(fixture.hits('/submit?name=after-close')).toBe(1)
    await expectNoWindow('after working on B')

    expect(uncaughtExceptions(app)).toBe('')
  }, 180_000)

  it('SC-2b 用户第一次点开浏览器窗口：墙上只有 B 一张、是激活的那张，没有幽灵卡片', async () => {
    await headerButton().click()
    bw = await until(() => app.browserWindow(), 'browser window page created by the header button')
    wall = browserWallPane(bw)
    await until(() => isWindowOpen(), 'browser window shown by the header button')
    await until(() => wall.mounted(), 'browser window shell ([data-browser-window]) mounted')
    await eventually(
      async () => ({ cards: await wall.cardIds(), active: await wall.activeCardIds() }),
      ({ cards, active }) => {
        expect(cards).toEqual([uuidB])
        expect(active).toEqual([uuidB])
      },
      'the wall shows B only, active'
    )
    // 晚到的也算：过一会儿再看一遍
    await sleep(500)
    expect(await wall.cardIds()).toEqual([uuidB])
    expect(await wall.activeCardIds()).toEqual([uuidB])
    expect(uncaughtExceptions(app)).toBe('')
  }, 60_000)
})

describe('agent 的 click 当场让页面关掉自己（SC-3）', () => {
  it('SC-3 点 Close now（同步 beacon + window.close()）：运行走到 agent_end，服务器收到 beacon，tab 从 IPC / list_tabs / 墙上消失，左邻激活，徽标对得上，没有未捕获的异常', async () => {
    expect(await isWindowOpen()).toBe(true)
    const [b] = await listTabs()

    provider.reset()
    const urlC = fixture.url('/closer.html?tag=sc3')
    const opened = await driver.run(sid, [
      { id: 'sc3_open', tool: 'open_tab', args: { url: urlC } }
    ])
    const tC = tabIdOf(ok(opened.ends, 'sc3_open').result)
    provider.reset()
    const snap = await driver.run(sid, [{ id: 'sc3_snap', tool: 'snapshot', args: { tabId: tC } }])
    const nowUid = uidOf(ok(snap.ends, 'sc3_snap').result, 'button', 'Close now')

    const uuidC = (await listTabs()).find((t) => t.url === urlC)?.id
    expect(uuidC, 'C in listTabs').toBeTruthy()
    await eventually(
      () => wall.cardIds(),
      (ids) => expect(ids).toEqual([b.id, uuidC]),
      'C on the wall next to B'
    )
    await waitBadge(2)

    // ── 点下去页面当场关掉；下一轮 list_tabs ──
    provider.reset()
    const run = await driver.run(sid, [
      { id: 'sc3_click', tool: 'click', args: { tabId: tC, uid: nowUid } },
      { id: 'sc3_list', tool: 'list_tabs', args: {} }
    ])
    await until(() => fixture.hits('/report?now=sc3') >= 1, 'the beacon sent by the click handler')
    await waitTabPageGone(app.port, (u) => u.includes('tag=sc3'))

    // click 自己落定了（措辞不钉：页面在它收尾时消失，回报成功或失败都行）
    expect(run.ends.sc3_click, 'sc3_click settled').toBeDefined()
    const listed = ok(run.ends, 'sc3_list').result
    expect(listed).not.toContain(`[${tC}]`)
    expect(listed).not.toContain('tag=sc3')

    await eventually(
      () => tabShape(),
      (tabs) => expect(tabs).toEqual([{ id: b.id, active: true }]),
      'C gone from listTabs, B (left neighbour) active'
    )
    await eventually(
      () => wall.cardIds(),
      (ids) => expect(ids).toEqual([b.id]),
      "C's card gone from the wall"
    )
    await waitBadge((await listTabs()).length)
    expect(uncaughtExceptions(app)).toBe('')
  }, 120_000)
})

describe('墙开着，激活卡片的页面自己关掉（SC-1，纯用户路径）', () => {
  it('SC-1 激活的 B 自己关掉：右邻 C 激活、墙上不留洞、徽标 −1、别的页面不重载；对 B 点关闭静默无事；再关 A、C：墙空、徽标消失；之后新开的 tab 照常', async () => {
    await closeAllTabs()
    await openWindow()

    const urlA = fixture.url('/counter.html?sc=1a')
    const urlB = fixture.url('/closer.html?tag=sc1b')
    const urlC = fixture.url('/counter.html?sc=1c')
    const a = await createTab(urlA)
    const b = await createTab(urlB)
    const c = await createTab(urlC)
    await activateTab(b)
    await until(
      async () =>
        JSON.stringify((await listTabs()).map((t) => t.url)) === JSON.stringify([urlA, urlB, urlC]),
      'three tabs on their pages'
    )
    await eventually(
      async () => ({
        cards: await wall.cardIds(),
        active: await wall.activeCardIds(),
        page: await wall.pageAreaRect(b)
      }),
      ({ cards, active, page }) => {
        expect(cards).toEqual([a, b, c])
        expect(active).toEqual([b])
        expect(page).not.toBeNull()
      },
      'A B C on the wall, B active with its page'
    )
    await waitBadge(3)
    const hitsA = fixture.hits('/counter.html?sc=1a')
    const hitsC = fixture.hits('/counter.html?sc=1c')
    expect([hitsA, hitsC]).toEqual([1, 1])

    // ── a：激活的 B 自己关掉 ──
    const isB = (u: string): boolean => u.includes('tag=sc1b')
    await pageClosesItself(app.port, isB)
    await waitTabPageGone(app.port, isB)

    await eventually(
      () => tabShape(),
      (tabs) =>
        expect(tabs).toEqual([
          { id: a, active: false },
          { id: c, active: true }
        ]),
      'A C left, C (right neighbour) active'
    )
    await eventually(
      async () => ({ cards: await wall.cardIds(), active: await wall.activeCardIds() }),
      ({ cards, active }) => {
        expect(cards).toEqual([a, c])
        expect(active).toEqual([c])
      },
      'the wall shows A C, C active'
    )
    expect(await wall.cardRect(b)).toBeNull()
    expect(await wall.cellRect(b)).toBeNull()
    // 不留洞：两列墙上 C 补到 A 旁边（同一行），而不是停在 B 走后的第二行
    await eventually(
      async () => ({
        wall: await wall.wallRect(),
        a: await wall.cellRect(a),
        c: await wall.cellRect(c)
      }),
      ({ wall: w, a: ra, c: rc }) => {
        expect(w && ra && rc).toBeTruthy()
        expect(
          w!.width,
          `browser window wall is ${w!.width}px wide; a 2-column wall needs ≥ ${TWO_COLUMN_MIN_WIDTH}px (display too small?)`
        ).toBeGreaterThanOrEqual(TWO_COLUMN_MIN_WIDTH)
        expect(Math.abs(rc!.top - ra!.top)).toBeLessThanOrEqual(1)
        expect(rc!.left).toBeGreaterThan(ra!.left)
      },
      'C moved up next to A (no hole)'
    )
    await waitBadge(2)
    // 别的页面没被重新加载过（重载是异步的 —— 给它时间发生，再看计数）
    await sleep(500)
    expect(fixture.hits('/counter.html?sc=1a')).toBe(hitsA)
    expect(fixture.hits('/counter.html?sc=1c')).toBe(hitsC)

    // 卡片上的 ✕ 晚到一步（对已经自己关掉的 B 再关一次）：静默，什么都不变
    await closeTab(b)
    await sleep(300)
    expect(await tabShape()).toEqual([
      { id: a, active: false },
      { id: c, active: true }
    ])
    expect(await wall.cardIds()).toEqual([a, c])
    expect(await wall.activeCardIds()).toEqual([c])
    expect(await headerButton().count()).toBe(2)

    // ── b：不激活的 A 导航到会自己关的页面、关掉；C 仍激活 ──
    const urlA2 = fixture.url('/closer.html?tag=sc1a')
    await navigateTab(a, urlA2)
    await until(
      async () => (await listTabs()).find((t) => t.id === a)?.url === urlA2,
      'A navigated to the closer page'
    )
    const isA = (u: string): boolean => u.includes('tag=sc1a')
    await pageClosesItself(app.port, isA)
    await waitTabPageGone(app.port, isA)
    await eventually(
      () => tabShape(),
      (tabs) => expect(tabs).toEqual([{ id: c, active: true }]),
      'C left, still active'
    )
    await eventually(
      async () => ({ cards: await wall.cardIds(), active: await wall.activeCardIds() }),
      ({ cards, active }) => {
        expect(cards).toEqual([c])
        expect(active).toEqual([c])
      },
      'the wall shows C only'
    )
    await waitBadge(1)

    // ── c：最后一张也自己关掉：墙空、徽标消失 ──
    const urlC2 = fixture.url('/closer.html?tag=sc1c')
    await navigateTab(c, urlC2)
    await until(
      async () => (await listTabs()).find((t) => t.id === c)?.url === urlC2,
      'C navigated to the closer page'
    )
    const isC = (u: string): boolean => u.includes('tag=sc1c')
    await pageClosesItself(app.port, isC)
    await waitTabPageGone(app.port, isC)
    await eventually(
      () => tabShape(),
      (tabs) => expect(tabs).toEqual([]),
      'no tabs left'
    )
    await eventually(
      () => wall.cardIds(),
      (ids) => expect(ids).toEqual([]),
      'the wall emptied'
    )
    await waitBadge(null)

    // 之后新开的 tab 照常：上墙、是唯一激活的那张
    const d = await createTab(fixture.url('/ask-me.html?sc=1d'))
    await eventually(
      async () => ({ cards: await wall.cardIds(), active: await wall.activeCardIds() }),
      ({ cards, active }) => {
        expect(cards).toEqual([d])
        expect(active).toEqual([d])
      },
      'a new tab is the only, active card'
    )
    expect(await tabShape()).toEqual([{ id: d, active: true }])
    await waitBadge(1)
    expect(uncaughtExceptions(app)).toBe('')
  }, 120_000)
})

describe('登录弹出页加载后自己关掉（SC-4）', () => {
  it('SC-4 agent 点 target=_blank 打开的弹出页 800ms 后自己关掉：开它的那张重新激活、list_tabs 不列它、徽标回原值，没有未捕获的异常', async () => {
    provider.reset()
    const urlO = fixture.url('/oauth.html')
    const opened = await driver.run(sid, [
      { id: 'sc4_open', tool: 'open_tab', args: { url: urlO } }
    ])
    const tO = tabIdOf(ok(opened.ends, 'sc4_open').result)
    const oauth = (await listTabs()).find((t) => t.url === urlO)
    expect(oauth?.active, 'the OAuth tab is active').toBe(true)
    const tabsBefore = (await listTabs()).length
    await waitBadge(tabsBefore)

    provider.reset()
    const snap = await driver.run(sid, [{ id: 'sc4_snap', tool: 'snapshot', args: { tabId: tO } }])
    const signIn = uidOf(ok(snap.ends, 'sc4_snap').result, 'link', 'Sign in')

    provider.reset()
    const clicked = await driver.run(sid, [
      { id: 'sc4_click', tool: 'click', args: { tabId: tO, uid: signIn } }
    ])
    ok(clicked.ends, 'sc4_click')

    // 弹出页真的加载了（文档已提交、脚本跑过 —— 此后 target 列表里认得出它），然后自己关掉了
    const popupPath = '/closer.html?after=800&tag=popup'
    await until(() => fixture.hits('/report?loaded=popup') >= 1, 'the popup loaded', 15_000)
    await waitTabPageGone(app.port, (u) => u.includes('tag=popup'))
    expect(fixture.hits(popupPath)).toBe(1)

    await eventually(
      () => listTabs(),
      (tabs) => {
        expect(tabs.some((t) => t.url.includes('tag=popup'))).toBe(false)
        expect(tabs.find((t) => t.id === oauth!.id)?.active).toBe(true)
        expect(tabs).toHaveLength(tabsBefore)
      },
      'the popup gone, the OAuth tab (left neighbour) active again'
    )
    await waitBadge(tabsBefore)

    provider.reset()
    const listed = await driver.run(sid, [{ id: 'sc4_list', tool: 'list_tabs', args: {} }])
    const text = ok(listed.ends, 'sc4_list').result
    expect(text).not.toContain('closer.html')
    expect(text).toContain(`[${tO}] (active)`)
    // 弹出页只加载过一次（没有被谁重新打开）
    await sleep(300)
    expect(fixture.hits(popupPath)).toBe(1)
    expect(uncaughtExceptions(app)).toBe('')
  }, 120_000)
})
