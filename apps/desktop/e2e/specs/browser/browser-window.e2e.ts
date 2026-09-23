/**
 * 内置浏览器的独立窗口 —— 窗口本身的语义（假提供商脚本化；夹具网站记下每一个请求）。
 *
 * 浏览器从主窗口右侧面板搬进了自己的窗口（`#browser-window`：BrowserWindowShell → BrowserWall
 * 卡片墙）。**agent 的浏览器动作绝不打扰主窗口里的用户**：窗口只由用户打开（侧栏按钮），tab 在一个
 * 从不显示的停放窗口里出生、不在墙上时也住在那里（1280×800、一直可见），agent 照常操作它们；关窗
 * 只隐藏。本 spec 按顺序走一个实例：
 *
 *   ST-E0 新实例、窗口从没开过：agent 开两个 tab（后开的叠在先开的上面），在被盖住的那个上快照 →
 *         打字 → 点（服务器收到提交）→ 读 → 量视口（1280×800）→ 截图（1.6 比例的 PNG），另一个上
 *         照样点；全程浏览器窗口不出现（target 都没有）、右侧面板不开，侧栏按钮上的徽标数着 tab；
 *   E1    侧栏按钮把窗口建出来并显示，墙是空的；
 *   E2    关窗 = 隐藏：`window.close()` 走真的 close → hide 拦截；tab 不动、target 还在；重开是同一张
 *         墙，页面一次都没重载（夹具的请求计数不变，外壳页面上打的标记还在）；
 *   E3    窗口隐藏时 agent 工具照常：快照 → 填 → 点（服务器收到提交）→ 读 → 截图（PNG），全程
 *         窗口仍隐藏；
 *   E4    隐藏时 open_tab：窗口不亮、徽标 +1、右侧面板不开；用户点侧栏按钮后新卡片是唯一激活的那张、
 *         整格露出，页面没有因为上墙而重载；
 *   E5    网格：一张铺满墙、两张并排各占一半、激活标记恰好一个；新 tab 落在视口之外时被滚进来；
 *   ST-E6 墙上两列（页面缩放 < 1）的 tab 被对话框覆盖层请下墙：停放时**保留卡片的页面缩放**（视口 =
 *         1280 / 缩放），跨站导航 → 快照 → 填 → 点 → 截图照常；覆盖层撤掉后回到卡片视口。
 *
 * 窗口「开没开」一律问 IPC `isWindowOpen()`：e2e 带着 `--disable-renderer-backgrounding` /
 * `--disable-backgrounding-occluded-windows` 启动，`document.visibilityState` 不反映窗口隐藏
 * （也看不见产品自己那个开关缺失 —— 那由单测钉住）；但一个 view 被 `setVisible(false)` 的回归
 * 在这里看得见：截图 / 点击会在停放的 tab 上失败。
 * 每条会话给显式标题（缺省标题会让自动起标题的 hook 抢走脚本里的轮次）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sleep, until, type CdpClient } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
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
  rightPanelPane,
  sidebarPane,
  type BrowserWallPane,
  type WallRect
} from '../../harness/pages'
import {
  BROWSER_TOOL_NAMES,
  browserDriver,
  browserTool,
  connectTabPage,
  startFixtureServer,
  tabIdOf,
  uidOf,
  type BrowserDriver,
  type FixtureServer
} from '../../harness/browserFixtures'

const MODEL = 'e2e-model'
const ALL_BROWSER_TOOLS = BROWSER_TOOL_NAMES.map(browserTool).sort()
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
/** 两列墙要的最小宽度：列数 = round(宽 / 620)，930 起才是 2 */
const TWO_COLUMN_MIN_WIDTH = 930
/** browserViewService 的 tab 上限 */
const MAX_TABS = 12
/** 停放窗口的内容区（= 停放中的 tab 的视口，CSS px @ 缩放 1） */
const STAGING = { width: 1280, height: 800 }
/** 卡片的逻辑宽度（tabUtils.CARD_LOGICAL_W）：墙上的页面按它排版再整体缩小 */
const CARD_LOGICAL_W = 1100
/** ST-E6 注入的对话框覆盖层（卡片墙见到 `.dialog-overlay` 就让所有 view 下墙） */
const OVERLAY_ID = '__e2e_dialog_overlay'

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
/** 浏览器窗口页面的 CDP 客户端（E1 连上，一直用到 afterAll；关窗只是隐藏，target 不变） */
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
const openWindow = async (): Promise<void> => {
  await app.main.eval('window.api.browserView.openWindow()')
  await until(() => isWindowOpen(), 'browser window open')
}
const closeAllTabs = async (): Promise<void> => {
  for (const t of await listTabs()) {
    await app.main.eval(`window.api.browserView.closeTab(${JSON.stringify(t.id)})`)
  }
  await until(async () => (await listTabs()).length === 0, 'all browser tabs closed')
  await until(async () => (await wall.cardIds()).length === 0, 'browser wall emptied')
}
/** 用户关浏览器窗口：页面里 window.close() —— 走真的 close 事件与「关窗 = 隐藏」拦截 */
const closeWindowLikeUser = async (): Promise<void> => {
  await bw!.eval('window.close()')
  await until(
    async () => !(await isWindowOpen()) || null,
    'browser window hidden by window.close()'
  )
}
/** 建一条勾了 mcp:browser 的会话并让运行时起来，回会话 id */
const tickedSession = async (title: string): Promise<string> => {
  const sid = await app.main.eval<string>(
    `window.api.session.create(${JSON.stringify({ title })}).then((s) => s.id)`
  )
  const wrote = await app.main.eval<{ success: boolean }>(
    `window.api.session.updateEnabledTools(${JSON.stringify({ id: sid, enabledTools: ['mcp:browser'] })})`
  )
  expect(wrote.success).toBe(true)
  const info = await app.main.eval<{ tools: Array<{ name: string }> } | null>(
    `window.api.agent.getInfo(${JSON.stringify(sid)}, { ensure: true })`
  )
  const browserTools = (info?.tools ?? [])
    .map((t) => t.name)
    .filter((n) => n.startsWith('mcp__browser__'))
    .sort()
  expect(browserTools).toEqual(ALL_BROWSER_TOOLS)
  return sid
}

/** 侧栏按钮（带 tab 计数徽标） */
const sidebarButton = (): ReturnType<typeof openBrowserWindowButton> =>
  openBrowserWindowButton(app.main)

/** 直接（经 DevTools，不经 agent）读某个 tab 的 innerWidth；按页面地址认 tab，找不到回 null */
const tabInnerWidth = async (url: string): Promise<number | null> => {
  const page = await connectTabPage(app.port, (u) => u === url)
  if (!page) return null
  try {
    return await page.eval<number>('innerWidth')
  } catch {
    return null
  } finally {
    page.close()
  }
}

/** 截图文件：会话 tool_results 下、PNG 签名对、IHDR 里的宽高 */
function pngAt(result: string, sid: string): { width: number; height: number } {
  const m = /saved to (\S+\.png)/.exec(result)
  expect(m, result).not.toBeNull()
  const png = m![1]
  expect(png.startsWith(join(app.home, 'userdata', 'tool_results', sid))).toBe(true)
  expect(existsSync(png)).toBe(true)
  const bytes = readFileSync(png)
  expect(bytes.subarray(0, 8)).toEqual(PNG_SIGNATURE)
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

/**
 * 反复读、直到断言全过；超时就把最后一次读数连同失败的断言一起抛出来。
 * 布局有过渡帧（ResizeObserver 回来之前行高是下限值），所以几何断言要等它落定 —— 但失败时要看得见
 * 落定成了什么，`until` 只会说「超时」。
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

/** a 完整落在 b 里（容 1px 的取整） */
const inside = (a: WallRect, b: WallRect): boolean =>
  a.top >= b.top - 1 && a.bottom <= b.bottom + 1 && a.left >= b.left - 1 && a.right <= b.right + 1

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

describe('agent 在后台用浏览器，窗口从不出现（ST-E0）', () => {
  const TITLE = 'BW background agent'
  let sid = ''

  beforeAll(async () => {
    sid = await tickedSession(TITLE)
    // 会话开在主窗界面上、右侧面板关着 —— 用户就在这里打字，什么都不该冒出来
    const sidebar = sidebarPane(app.main)
    await until(async () => (await sidebar.titles()).includes(TITLE), `sidebar row "${TITLE}"`)
    expect(await sidebar.openSession(TITLE)).toBe(true)
    await chatPane(app.main).ready()
    await rightPanelPane(app.main).close()
  }, 120_000)

  /** 浏览器窗口没开、连 target 都没有（从没建过）；右侧面板也没开 */
  const expectUndisturbed = async (when: string): Promise<void> => {
    expect(await isWindowOpen(), `${when}: browser window open`).toBe(false)
    expect(await app.browserWindow(), `${when}: #browser-window target exists`).toBeNull()
    expect(await rightPanelPane(app.main).isOpen(), `${when}: right panel open`).toBe(false)
  }

  it('ST-E0 两个 tab 在停放窗口里：被盖住的 A 上快照 → 打字 → 点 → 读 → 视口 1280×800 → 截图 1.6；B 上照样点；窗口从不出现，徽标数着 tab；关掉后徽标消失', async () => {
    await expectUndisturbed('fresh instance')
    expect(await sidebarButton().count()).toBeNull()

    // ── 开两个 tab：B 后进停放窗口，叠在 A 上面 ──
    provider.reset()
    const urlA = fixture.url('/form.html?st=a')
    const openedA = await driver.run(sid, [
      { id: 'st0_open_a', tool: 'open_tab', args: { url: urlA } }
    ])
    expect(openedA.ends.st0_open_a?.isError, openedA.ends.st0_open_a?.result).toBe(false)
    const tabA = tabIdOf(openedA.ends.st0_open_a.result)
    expect(fixture.hits('/form.html?st=a')).toBe(1)
    await expectUndisturbed('after open_tab A')

    provider.reset()
    const urlB = fixture.url('/counter.html?st=b')
    const openedB = await driver.run(sid, [
      { id: 'st0_open_b', tool: 'open_tab', args: { url: urlB } }
    ])
    expect(openedB.ends.st0_open_b?.isError, openedB.ends.st0_open_b?.result).toBe(false)
    const tabB = tabIdOf(openedB.ends.st0_open_b.result)
    expect(fixture.hits('/counter.html?st=b')).toBe(1)
    await expectUndisturbed('after open_tab B')

    // 用户知道 agent 开了页面的唯一地方：侧栏按钮的计数
    await until(async () => (await sidebarButton().count()) === 2, 'sidebar badge counts 2 tabs')
    expect(await sidebarButton().title()).toContain('2')

    // ── A（被 B 盖着）：快照 → 打字 → 点 → 读 → 视口 → 截图 ──
    provider.reset()
    const snapA = await driver.run(sid, [
      { id: 'st0_snap_a', tool: 'snapshot', args: { tabId: tabA } }
    ])
    expect(snapA.ends.st0_snap_a?.isError, snapA.ends.st0_snap_a?.result).toBe(false)
    const nameUid = uidOf(snapA.ends.st0_snap_a.result, 'textbox', 'Name')
    const submitUid = uidOf(snapA.ends.st0_snap_a.result, 'button', 'Submit')
    await expectUndisturbed('after snapshot A')

    provider.reset()
    const { ends } = await driver.run(sid, [
      { id: 'st0_type', tool: 'type', args: { tabId: tabA, uid: nameUid, text: 'bg' } },
      { id: 'st0_click', tool: 'click', args: { tabId: tabA, uid: submitUid } },
      {
        id: 'st0_out',
        tool: 'evaluate',
        args: { tabId: tabA, expression: "document.querySelector('#out').textContent" }
      },
      {
        id: 'st0_vp',
        tool: 'evaluate',
        args: { tabId: tabA, expression: '[innerWidth, innerHeight]' }
      },
      { id: 'st0_shot', tool: 'screenshot', args: { tabId: tabA } }
    ])
    for (const id of ['st0_type', 'st0_click', 'st0_out', 'st0_vp', 'st0_shot']) {
      expect(ends[id], id).toBeDefined()
      expect(ends[id].isError, `${id}: ${ends[id].result}`).toBe(false)
    }
    // 点击真的发生了、而且只发生了一次：按服务器那一侧的记录断
    await until(() => fixture.hits('/submit?name=bg') >= 1, 'form submitted to the server')
    await sleep(300)
    expect(fixture.hits('/submit?name=bg')).toBe(1)
    expect(ends.st0_out.result).toContain('"hello bg"')
    // 停放窗口的内容区就是视口：从没上过墙的站点缩放是 1
    const vp = /\[\s*(\d+),\s*(\d+)\s*\]/.exec(ends.st0_vp.result)
    expect(vp, ends.st0_vp.result).not.toBeNull()
    expect([Number(vp![1]), Number(vp![2])]).toEqual([STAGING.width, STAGING.height])
    const shot = pngAt(ends.st0_shot.result, sid)
    expect(shot.width, 'screenshot width').toBeGreaterThan(0)
    expect(Math.abs(shot.width / shot.height - STAGING.width / STAGING.height)).toBeLessThanOrEqual(
      0.01
    )
    await expectUndisturbed('after type / click / evaluate / screenshot on A')

    // ── B（在最上面）：快照 → 点 → 读 ──
    provider.reset()
    const snapB = await driver.run(sid, [
      { id: 'st0_snap_b', tool: 'snapshot', args: { tabId: tabB } }
    ])
    expect(snapB.ends.st0_snap_b?.isError, snapB.ends.st0_snap_b?.result).toBe(false)
    const addUid = uidOf(snapB.ends.st0_snap_b.result, 'button', 'Add')
    provider.reset()
    const onB = await driver.run(sid, [
      { id: 'st0_add', tool: 'click', args: { tabId: tabB, uid: addUid } },
      {
        id: 'st0_items',
        tool: 'evaluate',
        args: { tabId: tabB, expression: "document.querySelectorAll('#list li').length" }
      }
    ])
    expect(onB.ends.st0_add?.isError, onB.ends.st0_add?.result).toBe(false)
    expect(onB.ends.st0_items?.result.trim()).toBe('1')
    await expectUndisturbed('after working on B')

    // 异步冒出来的也算：过一会儿再看一遍
    await sleep(1000)
    await expectUndisturbed('a second later')
    expect(await sidebarButton().count()).toBe(2)
    // 两个页面都没被重新加载过
    expect(fixture.hits('/form.html?st=a')).toBe(1)
    expect(fixture.hits('/counter.html?st=b')).toBe(1)

    // ── 收尾：agent 关掉两个 tab，徽标消失，窗口照样没出现 ──
    provider.reset()
    const closed = await driver.run(sid, [
      { id: 'st0_close_a', tool: 'close_tab', args: { tabId: tabA } },
      { id: 'st0_close_b', tool: 'close_tab', args: { tabId: tabB } }
    ])
    expect(closed.ends.st0_close_a?.isError, closed.ends.st0_close_a?.result).toBe(false)
    expect(closed.ends.st0_close_b?.isError, closed.ends.st0_close_b?.result).toBe(false)
    await until(async () => (await sidebarButton().count()) === null, 'sidebar badge gone')
    expect(await listTabs()).toEqual([])
    await expectUndisturbed('after closing both tabs')
  }, 180_000)
})

describe('窗口的生命周期（E1 / E2）', () => {
  it('E1 ST-E0 之后仍然没有窗口、没有 tab、没有徽标；侧栏按钮把窗口建出来并显示，墙是空的', async () => {
    expect(await app.browserWindow()).toBeNull()
    expect(await isWindowOpen()).toBe(false)
    expect(await listTabs()).toEqual([])
    expect(await sidebarButton().count()).toBeNull()

    await openBrowserWindowButton(app.main).click()
    bw = await until(() => app.browserWindow(), 'browser window page created by the sidebar button')
    wall = browserWallPane(bw)
    await until(() => isWindowOpen(), 'browser window shown by the sidebar button')
    await until(() => wall.mounted(), 'browser window shell ([data-browser-window]) mounted')
    expect(await wall.cardIds()).toEqual([])
    expect(await listTabs()).toEqual([])
  }, 60_000)

  it('E2 关窗 = 隐藏：tab 不动、target 还在；重开是同一张墙，页面一次都没重载', async () => {
    const pathA = '/counter.html?bw=e2a'
    const pathB = '/ask-me.html?bw=e2b'
    const a = await createTab(fixture.url(pathA))
    const b = await createTab(fixture.url(pathB))
    await eventually(
      () => wall.cardIds(),
      (ids) => expect(ids).toEqual([a, b]),
      'two cards'
    )
    await until(
      () => fixture.hits(pathA) === 1 && fixture.hits(pathB) === 1,
      'both fixture pages requested once'
    )
    await until(
      async () =>
        JSON.stringify((await listTabs()).map((t) => t.url)) ===
        JSON.stringify([fixture.url(pathA), fixture.url(pathB)]),
      'both tabs on their pages'
    )
    const before = (await listTabs()).map((t) => ({ id: t.id, url: t.url }))
    // 外壳页面上打个标记：重开后还在 = 外壳也没重载
    await bw!.eval('window.__bwE2Mark = "kept"')

    await closeWindowLikeUser()
    expect((await listTabs()).map((t) => ({ id: t.id, url: t.url }))).toEqual(before)
    const target = await app.browserWindow()
    expect(target, '#browser-window target gone after close').not.toBeNull()
    target?.close()

    await openWindow()
    expect(await isWindowOpen()).toBe(true)
    expect(await wall.cardIds()).toEqual([a, b])
    expect(await bw!.eval<string>('window.__bwE2Mark')).toBe('kept')
    // 重载是异步的 —— 给它时间发生，再看计数
    await sleep(1000)
    expect(fixture.hits(pathA)).toBe(1)
    expect(fixture.hits(pathB)).toBe(1)
    expect((await listTabs()).map((t) => ({ id: t.id, url: t.url }))).toEqual(before)
  }, 60_000)
})

describe('隐藏的窗口与 agent（E3 / E4）', () => {
  const TITLE = 'BW hidden window tools'
  let sid = ''
  let tabId = ''

  beforeAll(async () => {
    // 从一面空墙开始：表单页独占整墙，卡片一定完整露出、挂着真页面
    await closeAllTabs()
    sid = await tickedSession(TITLE)
    // 会话开在主窗界面上、右侧面板关着 —— E4 要看「右侧面板不跟着开」
    const sidebar = sidebarPane(app.main)
    await until(async () => (await sidebar.titles()).includes(TITLE), `sidebar row "${TITLE}"`)
    expect(await sidebar.openSession(TITLE)).toBe(true)
    await chatPane(app.main).ready()
    await rightPanelPane(app.main).close()
  }, 120_000)

  it('E3 窗口隐藏时：snapshot → fill → click → evaluate → screenshot 全部照常，窗口一直隐藏', async () => {
    expect(await isWindowOpen()).toBe(true)
    provider.reset()
    const url = fixture.url('/form.html')
    const opened = await driver.run(sid, [{ id: 'e3_open', tool: 'open_tab', args: { url } }])
    expect(opened.ends.e3_open?.isError).toBe(false)
    tabId = tabIdOf(opened.ends.e3_open.result)
    const tab = (await listTabs()).find((t) => t.url === url)
    expect(tab?.active).toBe(true)

    // 窗口开着时卡片先落好位（页面区有了尺寸，view 叠了上去），再关窗
    await eventually(
      () => wall.activeCardIds(),
      (ids) => expect(ids).toEqual([tab!.id]),
      'form card active'
    )
    await eventually(
      () => wall.pageAreaRect(tab!.id),
      (r) => {
        expect(r).not.toBeNull()
        expect(r!.width).toBeGreaterThan(200)
        expect(r!.height).toBeGreaterThan(200)
      },
      'form card page area laid out'
    )
    await sleep(500) // 布局表走 rAF + IPC
    await closeWindowLikeUser()

    provider.reset()
    const snap = await driver.run(sid, [{ id: 'e3_snap', tool: 'snapshot', args: { tabId } }])
    expect(snap.ends.e3_snap?.isError).toBe(false)
    const snapshot = snap.ends.e3_snap.result
    expect(snapshot).toContain('button "Submit"')
    const nameUid = uidOf(snapshot, 'textbox', 'Name')
    const submitUid = uidOf(snapshot, 'button', 'Submit')

    provider.reset()
    const { ends } = await driver.run(sid, [
      { id: 'e3_fill', tool: 'fill', args: { tabId, uid: nameUid, text: 'hidden' } },
      { id: 'e3_click', tool: 'click', args: { tabId, uid: submitUid } },
      {
        id: 'e3_eval',
        tool: 'evaluate',
        args: { tabId, expression: "document.querySelector('#out').textContent" }
      },
      { id: 'e3_shot', tool: 'screenshot', args: { tabId } }
    ])
    for (const id of ['e3_fill', 'e3_click', 'e3_eval', 'e3_shot']) {
      expect(ends[id], id).toBeDefined()
      expect(ends[id].isError, `${id}: ${ends[id].result}`).toBe(false)
    }
    // 点击真的发生了：按服务器那一侧的记录断
    await until(() => fixture.hits('/submit?name=hidden') === 1, 'form submitted to the server')
    expect(ends.e3_eval.result).toContain('"hello hidden"')

    const m = /saved to (\S+\.png)/.exec(ends.e3_shot.result)
    expect(m, ends.e3_shot.result).not.toBeNull()
    const png = m![1]
    expect(png.startsWith(join(app.home, 'userdata', 'tool_results', sid))).toBe(true)
    expect(existsSync(png)).toBe(true)
    expect(readFileSync(png).subarray(0, 8)).toEqual(PNG_SIGNATURE)

    // agent 的工具没有哪个会把窗口弄出来：这一串做完，窗口还是隐藏的
    expect(await isWindowOpen()).toBe(false)
  }, 120_000)

  it('E4 窗口隐藏时 open_tab：窗口不亮、徽标 +1、右侧面板不开；用户点侧栏按钮后新卡片是唯一激活的那张、整格露出，上墙不重载', async () => {
    expect(await isWindowOpen()).toBe(false)
    expect(await rightPanelPane(app.main).isOpen()).toBe(false)
    const badgeBefore = (await sidebarButton().count()) ?? 0
    expect(badgeBefore).toBe((await listTabs()).length)

    provider.reset()
    const path = '/counter.html?bw=e4'
    const url = fixture.url(path)
    const { ends } = await driver.run(sid, [{ id: 'e4_open', tool: 'open_tab', args: { url } }])
    expect(ends.e4_open?.isError, ends.e4_open?.result).toBe(false)
    expect(fixture.hits(path)).toBe(1)
    const tab = (await listTabs()).find((t) => t.url === url)
    expect(tab?.active).toBe(true)

    // 窗口不亮：当场不亮，过一会儿也不亮
    expect(await isWindowOpen()).toBe(false)
    await sleep(1000)
    expect(await isWindowOpen()).toBe(false)
    await until(
      async () => (await sidebarButton().count()) === badgeBefore + 1,
      `sidebar badge ${badgeBefore} → ${badgeBefore + 1}`
    )
    expect(await rightPanelPane(app.main).isOpen()).toBe(false)

    // 用户自己点开
    await sidebarButton().click()
    await until(() => isWindowOpen(), 'browser window shown by the sidebar button')
    await eventually(
      () => wall.activeCardIds(),
      (ids) => expect(ids).toEqual([tab!.id]),
      'the new card is the only active one'
    )
    expect(await wall.cardIds()).toContain(tab!.id)
    await eventually(
      async () => ({ cell: await wall.cellRect(tab!.id), wall: await wall.wallRect() }),
      ({ cell, wall: w }) => {
        expect(cell && w).toBeTruthy()
        expect(inside(cell!, w!)).toBe(true)
      },
      'the new card fully inside the wall'
    )
    // 从停放窗口搬上墙不重新加载页面
    await sleep(1000)
    expect(fixture.hits(path)).toBe(1)
    expect(await rightPanelPane(app.main).isOpen()).toBe(false)
  }, 120_000)
})

describe('卡片墙（E5）', () => {
  it('E5 一张铺满墙；两张并排各占一半；激活标记恰好一个；新 tab 落在视口外时被滚进来', async () => {
    await closeAllTabs()
    await openWindow()

    // ── 一张：铺满整面墙 ──
    const a = await createTab(fixture.url('/deny.html?bw=e5-1'))
    const one = await eventually(
      async () => ({ wall: await wall.wallRect(), card: await wall.cardRect(a) }),
      ({ wall: w, card }) => {
        expect(w).not.toBeNull()
        expect(card).not.toBeNull()
        expect(Math.abs(card!.left - w!.left)).toBeLessThanOrEqual(10)
        expect(Math.abs(card!.right - w!.right)).toBeLessThanOrEqual(10)
        expect(Math.abs(card!.top - w!.top)).toBeLessThanOrEqual(10)
        expect(Math.abs(card!.bottom - w!.bottom)).toBeLessThanOrEqual(10)
      },
      'a single card spans the wall'
    )
    expect(
      one.wall!.width,
      `browser window wall is ${one.wall!.width}px wide; a 2-column wall needs ≥ ${TWO_COLUMN_MIN_WIDTH}px (display too small?)`
    ).toBeGreaterThanOrEqual(TWO_COLUMN_MIN_WIDTH)

    // ── 两张：同一行、左右并排、各占一半 ──
    const b = await createTab(fixture.url('/deny.html?bw=e5-2'))
    await eventually(
      async () => ({
        wall: await wall.wallRect(),
        a: await wall.cardRect(a),
        b: await wall.cardRect(b)
      }),
      ({ wall: w, a: ra, b: rb }) => {
        expect(w && ra && rb).toBeTruthy()
        expect(Math.abs(ra!.top - rb!.top)).toBeLessThanOrEqual(1)
        expect(rb!.left - ra!.left).toBeGreaterThan(w!.width / 4)
        expect(Math.abs(ra!.width - w!.width / 2)).toBeLessThanOrEqual(10)
        expect(Math.abs(rb!.width - w!.width / 2)).toBeLessThanOrEqual(10)
      },
      'two cards side by side, half the wall each'
    )

    // ── 激活标记：恰好一张，跟着 activateTab 走 ──
    await activateTab(a)
    await eventually(
      () => wall.activeCardIds(),
      (ids) => expect(ids).toEqual([a]),
      'A active'
    )
    await activateTab(b)
    await eventually(
      () => wall.activeCardIds(),
      (ids) => expect(ids).toEqual([b]),
      'B active'
    )

    // ── 新 tab 落在第一屏之外：激活时被滚进视口 ──
    // 每开一张之前先把墙滚回顶上：只有「激活把它滚进来」这一条路能让它完整露出
    let beyond = false
    for (let n = 3; n <= MAX_TABS && !beyond; n++) {
      await wall.scrollToTop()
      const id = await createTab(fixture.url(`/deny.html?bw=e5-${n}`))
      await eventually(
        () => wall.activeCardIds(),
        (ids) => expect(ids).toEqual([id]),
        `tab ${n} active`
      )
      // 这一格在滚动内容里的位置（与此刻滚到哪无关）：底边超出第一屏 = 不滚就露不全
      const geo = await bw!.eval<{ top: number; height: number; clientHeight: number }>(`(() => {
        const cell = document.querySelector('[data-wall-cell="${id}"]')
        const scroller = cell.parentElement
        const c = cell.getBoundingClientRect()
        const s = scroller.getBoundingClientRect()
        return { top: c.top - s.top + scroller.scrollTop, height: c.height, clientHeight: scroller.clientHeight }
      })()`)
      if (geo.top + geo.height <= geo.clientHeight + 1) continue // 还在第一屏里
      beyond = true
      await eventually(
        async () => ({ cell: await wall.cellRect(id), wall: await wall.wallRect() }),
        ({ cell, wall: w }) => {
          expect(cell && w).toBeTruthy()
          expect(inside(cell!, w!)).toBe(true)
        },
        `newest tab ${n} (beyond the first screen) scrolled fully into view`
      )
      expect(await wall.scrollTop()).toBeGreaterThan(0)
    }
    expect(beyond, `even ${MAX_TABS} tabs never overflowed the first screen of the wall`).toBe(true)
  }, 120_000)
})

describe('停放的 tab 保留卡片的页面缩放（ST-E6）', () => {
  const TITLE = 'BW parked zoom'
  let sid = ''
  const addOverlay = (): Promise<unknown> =>
    bw!.eval(`(() => {
      const d = document.createElement('div')
      d.className = 'dialog-overlay'
      d.id = '${OVERLAY_ID}'
      document.body.appendChild(d)
      return true
    })()`)
  const removeOverlay = (): Promise<unknown> =>
    bw!.eval(`document.getElementById('${OVERLAY_ID}')?.remove() ?? true`)

  beforeAll(async () => {
    await closeAllTabs()
    await openWindow()
    sid = await tickedSession(TITLE)
  }, 120_000)

  afterAll(async () => {
    await removeOverlay().catch(() => undefined)
  })

  it('ST-E6 两列墙上的 A 被覆盖层请下墙：视口 = 1280 / 卡片缩放（缩放没被重置）；停放时跨站导航 → 快照 → 填 → 点 → 截图照常；撤掉覆盖层回到卡片视口；窗口一直开着', async () => {
    provider.reset()
    const urlA = fixture.url('/form.html?st=e6a')
    const urlB = fixture.url('/form.html?st=e6b')
    const opened = await driver.run(sid, [
      { id: 'e6_open_a', tool: 'open_tab', args: { url: urlA } },
      { id: 'e6_open_b', tool: 'open_tab', args: { url: urlB } }
    ])
    expect(opened.ends.e6_open_a?.isError, opened.ends.e6_open_a?.result).toBe(false)
    expect(opened.ends.e6_open_b?.isError, opened.ends.e6_open_b?.result).toBe(false)
    const shortA = tabIdOf(opened.ends.e6_open_a.result)
    const tabs = await listTabs()
    const a = tabs.find((t) => t.url === urlA)!
    const b = tabs.find((t) => t.url === urlB)!

    // ── 两列：并排、卡片比逻辑宽度窄（页面缩放 < 1） ──
    await eventually(
      async () => ({ ra: await wall.pageAreaRect(a.id), rb: await wall.pageAreaRect(b.id) }),
      ({ ra, rb }) => {
        expect(ra && rb).toBeTruthy()
        expect(Math.abs(ra!.top - rb!.top)).toBeLessThanOrEqual(1)
        expect(rb!.left - ra!.left).toBeGreaterThan(200)
        expect(ra!.width).toBeLessThan(CARD_LOGICAL_W - 100)
      },
      'two cards side by side, narrower than the logical width'
    )

    // ── 墙上：A 按逻辑宽度排版（≈1100），再按卡片宽度缩小 ──
    const onWall = await eventually(
      () => tabInnerWidth(urlA),
      (w) => {
        expect(w).not.toBeNull()
        expect(w!).toBeGreaterThanOrEqual(1050)
        expect(w!).toBeLessThanOrEqual(1150)
      },
      "A's viewport while on the wall"
    )
    const cardWidth = (await wall.pageAreaRect(a.id))!.width
    const zoom = cardWidth / onWall!
    expect(zoom).toBeLessThan(0.95)
    const parkedWidth = Math.round(STAGING.width / zoom)

    // ── 请下墙：停放窗口 1280 宽 × 卡片那个缩放 ──
    await addOverlay()
    await eventually(
      () => tabInnerWidth(urlA),
      (w) => {
        expect(w).not.toBeNull()
        // 缩放被重置成 1 的话这里是 1280
        expect(Math.abs(w! - parkedWidth)).toBeLessThanOrEqual(3)
      },
      `A parked: viewport = ${STAGING.width} / ${zoom.toFixed(3)} ≈ ${parkedWidth}`
    )
    expect(await isWindowOpen()).toBe(true)

    // ── 停放中跨站导航（新渲染进程）：快照 / 填 / 点 / 截图照常 ──
    provider.reset()
    const urlX = fixture.localhostUrl('/form.html?st=e6x')
    const nav = await driver.run(sid, [
      { id: 'e6_nav', tool: 'navigate', args: { tabId: shortA, url: urlX } },
      { id: 'e6_snap', tool: 'snapshot', args: { tabId: shortA } }
    ])
    expect(nav.ends.e6_nav?.isError, nav.ends.e6_nav?.result).toBe(false)
    expect(nav.ends.e6_snap?.isError, nav.ends.e6_snap?.result).toBe(false)
    expect(fixture.hits('/form.html?st=e6x')).toBe(1)
    const nameUid = uidOf(nav.ends.e6_snap.result, 'textbox', 'Name')
    const submitUid = uidOf(nav.ends.e6_snap.result, 'button', 'Submit')

    provider.reset()
    const { ends } = await driver.run(sid, [
      { id: 'e6_fill', tool: 'fill', args: { tabId: shortA, uid: nameUid, text: 'parked' } },
      { id: 'e6_click', tool: 'click', args: { tabId: shortA, uid: submitUid } },
      { id: 'e6_shot', tool: 'screenshot', args: { tabId: shortA } }
    ])
    for (const id of ['e6_fill', 'e6_click', 'e6_shot']) {
      expect(ends[id], id).toBeDefined()
      expect(ends[id].isError, `${id}: ${ends[id].result}`).toBe(false)
    }
    await until(() => fixture.hits('/submit?name=parked') === 1, 'parked form submitted')
    expect(ends.e6_shot.result).not.toContain('empty image')
    const shot = pngAt(ends.e6_shot.result, sid)
    expect(shot.width).toBeGreaterThan(0)
    expect(shot.height).toBeGreaterThan(0)
    expect((await listTabs()).find((t) => t.id === a.id)?.url).toBe(urlX)
    expect(await isWindowOpen()).toBe(true)

    // ── 撤掉覆盖层：A 回到墙上，视口回到逻辑宽度 ──
    await removeOverlay()
    await eventually(
      () => tabInnerWidth(urlX),
      (w) => {
        expect(w).not.toBeNull()
        expect(w!).toBeGreaterThanOrEqual(1050)
        expect(w!).toBeLessThanOrEqual(1150)
      },
      "A's viewport back on the wall"
    )
    expect(await isWindowOpen()).toBe(true)
  }, 180_000)
})
