/**
 * 真的 Chrome —— 同一条链路上，唯一没法用假 Chrome 代替的那一段：
 * Chrome 自己按宿主清单拉起本地组件、扩展的 service worker 连上它、页面操作真的落在真实的
 * chrome.tabs / chrome.scripting / chrome.debugger 上。
 *
 * **要一个浏览器二进制才跑**：`SHUVIX_CHROME_BIN` 指向 Chromium 系浏览器的可执行文件，没给就整组跳过
 * （CI 与普通开发机上就是跳过）。拿 Chrome for Testing 最方便：
 *
 *   https://googlechromelabs.github.io/chrome-for-testing/ 下载对应平台的包，解压后
 *   `xattr -dr com.apple.quarantine <解压目录>`（macOS 对下载来的未签名 app 一律报 damaged），再
 *   SHUVIX_CHROME_BIN="…/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing" \
 *     npm run test:e2e:chrome
 *
 * 隔离照旧：桌面跑在假 HOME 上、独立 userData、独立 CDP 端口；浏览器用 `--user-data-dir` 指向假 HOME
 * 里的一个 profile，不碰用户自己的浏览器配置与登录态。扩展用 `--load-extension` 装
 * `apps/extension/dist`（跑之前先 `npm run build:ext`）。
 *
 * **两处不得不做的接线**（product 之外的胶水，就这两处）：
 *  - Chrome 自己必须跑在**真实 HOME** 上：改掉 HOME 它的网络服务起不来（标签页永远 loading、地址是空的）；
 *  - 而原生消息宿主是 Chrome 的子进程、继承它的环境，于是拿到真实 HOME、找不到隔离实例的 token 与
 *    socket。所以把桌面**自己写出来的**那份清单里的 `path` 换成一层薄包装（清单其余内容、
 *    `allowed_origins`、以及被包装的启动脚本本身，都还是桌面写的那一份）：包装只把 HOME 钉回假
 *    HOME，再原样 exec 它。读的是 `--user-data-dir` 下那一份清单，真实 HOME 一个字节都不碰。
 *
 * 断言分工：**浏览器这一侧**看真实 tab 与夹具服务器的请求记录（「点击真的发生了」由服务器作证），
 * **模型这一侧**看假提供商收到的消息（工具结果真的回到了模型），**桌面这一侧**看库里的会话行与
 * 安全决策日志。侧边栏就是真的侧边栏页面：消息在它的输入框里打字发出，询问卡片在它上面点。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CHROME_BRIDGE_HOST_NAME, CHROME_EXTENSION_ID } from '@shuvix/chat-protocol/chromeBridge'
import { connect, listTargets, sleep, until, type CdpClient } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import { startFakeProvider, type FakeProvider, type FakeRequest } from '../../harness/fakeProvider'
import {
  securityDecisions,
  seedFakeProvider,
  sqliteJson,
  waitRendererReady
} from '../../harness/seed'
import { startFixtureServer, uidOf, type FixtureServer } from '../../harness/browserFixtures'
import { scriptChromeRun } from '../../harness/chromeFixtures'

const CHROME_BIN = process.env.SHUVIX_CHROME_BIN ?? ''
const MODEL = 'e2e-model'
const BROWSER_PORT = 9333
/** 扩展产物（`npm run build:ext`） */
const EXTENSION_DIR = join(__dirname, '../../../../extension/dist')

let app: E2EApp
let provider: FakeProvider
let fixture: FixtureServer
let chrome: ChildProcess | undefined
/** 扩展 service worker 的 CDP 连接 —— 浏览器这一侧的所有操作都经它（就是扩展自己的 API） */
let sw: CdpClient
/** 侧边栏页面的 CDP 连接 */
let panel: CdpClient
/** 会话挂着的那个真实标签页 */
let tabId = 0
let sessionId = ''
/** 桌面安装器写出来的清单（装配时读下来，随后它的 path 被换成钉 HOME 的包装） */
let productManifest: { path: string; allowed_origins: string[] }

/** 浏览器里现在开着的标签页（扩展视角） */
interface SwTab {
  id: number
  url: string
  title: string
}
const queryTabs = (): Promise<SwTab[]> =>
  sw.eval<SwTab[]>(
    `chrome.tabs.query({}).then((ts) => ts.map((t) => ({ id: t.id, url: t.url, title: t.title })))`
  )

/** 这条会话在库里的行（标签页会话不进 session.list，直接看库） */
const tabSessionRows = (): Array<{ id: string; title: string; settings: string }> =>
  sqliteJson(app.home, 'SELECT id, title, settings FROM sessions')
    .map((r) => r as { id: string; title: string; settings: string })
    .filter((r) => (r.settings ?? '').includes('"chromeTab"'))

const contentText = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((c) => {
      const block = c as { type?: string; text?: string }
      return block?.type === 'text' && typeof block.text === 'string' ? block.text : ''
    })
    .join('')
}
const toolTextsOf = (req: FakeRequest): string[] =>
  (req.body.messages ?? []).filter((m) => m.role === 'tool').map((m) => contentText(m.content))
/** 这一轮里所有回给模型的工具结果 */
const allToolTexts = (): string => provider.chatRequests().flatMap(toolTextsOf).join('\n')

/** 在侧边栏的输入框里打字并发送（走的就是用户按回车那条路） */
async function sendInPanel(text: string): Promise<void> {
  const sent = await panel.eval<string>(`(() => {
    const ta = document.querySelector('textarea')
    if (!ta) return 'no textarea'
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, ${JSON.stringify(text)})
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    return 'sent'
  })()`)
  expect(sent).toBe('sent')
}

/** 侧边栏上的可见文字 */
const panelText = (): Promise<string> => panel.eval<string>('document.body.innerText')

/**
 * 这条链路卡住时的现场：侧边栏显示什么、SW 怎么看这条连接、桌面的日志与状态。
 *
 * SW 的状态没有导出口，但**从页面**连一条侧边栏端口，SW 会立刻把 linkState 回过来 ——
 * 于是「侧边栏说连接中、SW 说 ready」这类分歧一眼可见（这正是它抓到的那个订阅时序 bug）。
 */
async function linkForensics(): Promise<string> {
  const swState = await panel.eval<string>(`new Promise((resolve) => {
    const p = chrome.runtime.connect({ name: 'panel:999999' })
    p.onMessage.addListener((m) => {
      if (m && m.kind === 'status') { p.disconnect(); resolve(m.state) }
    })
    setTimeout(() => { p.disconnect(); resolve('no status in 2s') }, 2000)
  })`)
  const status = await app.main.eval<string>(
    'window.api.chromeExtension.status().then((s) => JSON.stringify(s))'
  )
  const log = app.mainLog().split('\n').slice(-25).join('\n')
  return [
    `--- 侧边栏上显示的是 ---\n${await panelText()}`,
    `--- SW 眼里的连接状态 ---\n${swState}`,
    `--- 桌面 status ---\n${status}`,
    `--- 桌面日志（末 25 行）---\n${log}`
  ].join('\n')
}

/** 一轮跑完 —— 收尾那句话出现在侧边栏上 */
const waitTurn = (closing: string): Promise<unknown> =>
  until(async () => (await panelText()).includes(closing), `panel shows "${closing}"`)

describe.skipIf(!CHROME_BIN)('真实浏览器', () => {
  beforeAll(async () => {
    expect(existsSync(CHROME_BIN), `SHUVIX_CHROME_BIN not found: ${CHROME_BIN}`).toBe(true)
    expect(
      existsSync(join(EXTENSION_DIR, 'manifest.json')),
      `扩展产物不在 ${EXTENSION_DIR}（先跑 npm run build:ext）`
    ).toBe(true)

    provider = await startFakeProvider()
    fixture = await startFixtureServer()
    app = await launchApp()
    await waitRendererReady(app.main)
    await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })

    // 浏览器的用户数据目录先存在，桌面的安装器才会把宿主清单写进去（它只给装了的浏览器写）
    const userData = join(app.home, 'Library/Application Support/Google/Chrome for Testing')
    mkdirSync(userData, { recursive: true })
    await app.main.eval('window.api.chromeExtension.repair()')

    // 桌面写出来的那一份（产品行为，RCB-1 断言它的内容）
    const manifestPath = join(userData, 'NativeMessagingHosts', `${CHROME_BRIDGE_HOST_NAME}.json`)
    productManifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      path: string
      allowed_origins: string[]
    }
    // 宿主是 Chrome 的子进程、继承它的环境（真实 HOME）——套一层只钉 HOME 的包装，
    // 它 exec 的还是桌面写的那个启动脚本（见文件头）
    const wrapper = join(app.home, '.shuvix/chrome-bridge/native-host-e2e')
    writeFileSync(
      wrapper,
      ['#!/bin/sh', `HOME='${app.home}' exec '${productManifest.path}' "$@"`, ''].join('\n'),
      'utf-8'
    )
    chmodSync(wrapper, 0o755)
    writeFileSync(
      manifestPath,
      JSON.stringify({ ...productManifest, path: wrapper }, null, 2) + '\n'
    )

    chrome = spawn(
      CHROME_BIN,
      [
        `--user-data-dir=${userData}`,
        `--remote-debugging-port=${BROWSER_PORT}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-timer-throttling',
        '--window-size=900,700',
        `--disable-extensions-except=${EXTENSION_DIR}`,
        `--load-extension=${EXTENSION_DIR}`,
        'about:blank'
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )

    // service worker 起来 = 扩展装上了
    const swTarget = await until(async () => {
      const targets = await listTargets(BROWSER_PORT).catch(() => [])
      return targets.find((t) => t.type === 'service_worker' && t.url.includes(CHROME_EXTENSION_ID))
    }, 'extension service worker')
    sw = await connect(swTarget.webSocketDebuggerUrl)
  }, 180_000)

  afterAll(async () => {
    sw?.close()
    panel?.close()
    chrome?.kill('SIGKILL')
    await app?.stop()
    await provider?.close()
    await fixture?.close()
  })

  it('RCB-1 Chrome 按桌面写下的宿主清单拉起本地组件，桥上出现这台浏览器', async () => {
    // 清单与启动脚本都是桌面自己写的，且只放行 ShuviX 扩展
    // （清单的 path 在装配时套了一层钉 HOME 的包装，包装 exec 的就是这个启动脚本，见文件头）
    const launcher = join(app.home, '.shuvix/chrome-bridge/native-host')
    expect(productManifest.path).toBe(launcher)
    expect(existsSync(launcher)).toBe(true)
    expect(productManifest.allowed_origins).toEqual([`chrome-extension://${CHROME_EXTENSION_ID}/`])

    // 桥上就绪（真 Chrome → 真原生宿主 → 桌面 socket 的握手）
    const status = await until(
      async () => {
        const s = await app.main.eval<{
          listening: boolean
          browsers: Array<{ state: string; browser: string; extensionVersion: string }>
        }>('window.api.chromeExtension.status()')
        return s.browsers.length > 0 && s.browsers[0].state === 'ready' ? s : undefined
      },
      'bridge sees the real browser',
      60_000
    )
    expect(status.listening).toBe(true)
    expect(status.browsers).toHaveLength(1)
    expect(status.browsers[0].browser.length).toBeGreaterThan(0)
    expect(status.browsers[0].extensionVersion.length).toBeGreaterThan(0)
  }, 120_000)

  it('RCB-2 在真标签页上打开侧边栏页 → 桌面建出这条标签页会话，且不进会话列表', async () => {
    const created = await sw.eval<SwTab>(
      `chrome.windows.getAll({}).then((ws) =>
         chrome.tabs.create({ url: ${JSON.stringify(fixture.url('/form.html'))}, active: true, windowId: ws[0]?.id })
       ).then((t) => ({ id: t.id, url: t.url, title: t.title }))`
    )
    tabId = created.id
    expect(tabId).toBeGreaterThan(0)
    await until(async () => {
      const tabs = await queryTabs()
      return tabs.some((t) => t.id === tabId && t.title === 'E2E Form')
    }, 'fixture page loaded')

    // 侧边栏的**容器**测不到：`chrome.sidePanel.open()` 只认真实的用户手势（点工具栏图标），
    // CDP 连 Runtime.evaluate 的 userGesture 都不算数（实测报「may only be called in response to a
    // user gesture」）。所以这里把同一个页面按 SW 给的那个地址当普通标签页打开 —— 页面、代码、
    // 整条链路完全一样，只有外壳不同；「点图标 → 在这一页右侧弹出侧边栏」那两行只能人工过一遍。
    // 能自动断的是它旁边那半：全局默认必须是关的，只有点过图标的标签页才有侧边栏。
    const globalPanel = await sw.eval<{ enabled?: boolean }>(
      'chrome.sidePanel.getOptions({}).then((o) => ({ enabled: o.enabled }))'
    )
    expect(globalPanel.enabled).toBe(false)
    await sw.eval(
      `chrome.windows.getAll({}).then((ws) =>
         chrome.tabs.create({ url: 'chrome-extension://${CHROME_EXTENSION_ID}/sidepanel.html?tabId=' + ${tabId}, active: true, windowId: ws[0]?.id })
       )`
    )
    const panelTarget = await until(async () => {
      const targets = await listTargets(BROWSER_PORT).catch(() => [])
      return targets.find(
        (t) => t.type === 'page' && t.url.includes(`sidepanel.html?tabId=${tabId}`)
      )
    }, 'side panel page')
    panel = await connect(panelTarget.webSocketDebuggerUrl)

    const row = await until(() => tabSessionRows()[0], 'tab session row', 60_000).catch(
      async (err: Error) => {
        throw new Error(`${err.message}\n${await linkForensics()}`)
      }
    )
    sessionId = row.id
    expect(row.title).toBe('Chrome · E2E Form')
    expect(JSON.parse(row.settings).chromeTab).toMatchObject({ tabId })
    const listed = await app.main.eval<Array<{ id: string }>>('window.api.session.list()')
    expect(listed.some((s) => s.id === sessionId)).toBe(false)
  }, 120_000)

  it('RCB-3 在侧边栏里发消息：模型收到带这一页的用户消息，list_tabs / read_page 的结果来自真实页面，回答显示在侧边栏上', async () => {
    provider.reset()
    scriptChromeRun(
      provider,
      [
        { id: 'rcb3_tabs', tool: 'list_tabs', args: {} },
        { id: 'rcb3_read', tool: 'read_page', args: { tabId: String(tabId) } }
      ],
      'read it'
    )
    await sendInPanel('这一页讲什么')
    await waitTurn('read it')

    const first = provider.chatRequests()[0]
    expect(first.lastUserText).toBe(
      `[Chrome tab ${tabId}: "E2E Form" — ${fixture.url('/form.html')}] 这一页讲什么`
    )
    const tools = allToolTexts()
    // list_tabs 看到的是真实标签页（挂着的那一页排第一），read_page 拿到的是真实页面的正文
    expect(tools).toContain(`[${tabId}] (this conversation's tab) E2E Form`)
    expect(tools).toContain('E2E Form Heading')
    expect(tools).toContain('A small form for the browser e2e.')
    // 询问卡片一张都没有：这一页是用户随消息带上的
    expect(await panelText()).not.toContain('http://127.0.0.1')
  }, 180_000)

  it('RCB-4 snapshot / fill / click 经 chrome.debugger 落在真实页面上（点击由夹具服务器作证）', async () => {
    provider.reset()
    scriptChromeRun(
      provider,
      [{ id: 'rcb4_snap', tool: 'snapshot', args: { tabId: String(tabId) } }],
      'snapped'
    )
    await sendInPanel('看看这一页有什么可以填的')
    await waitTurn('snapped')
    const snapshot = allToolTexts()
    const nameUid = uidOf(snapshot, 'textbox', 'Name')
    const submitUid = uidOf(snapshot, 'button', 'Submit')

    const submitsBefore = fixture.hits('/submit')
    provider.reset()
    // 同一轮里先重新 snapshot 再动手：一轮跑完调试就释放了（租约），上一轮的 uid 已经作废
    scriptChromeRun(
      provider,
      [
        { id: 'rcb4_resnap', tool: 'snapshot', args: { tabId: String(tabId) } },
        {
          id: 'rcb4_fill',
          tool: 'fill',
          args: { tabId: String(tabId), uid: nameUid, text: 'real chrome' }
        },
        { id: 'rcb4_click', tool: 'click', args: { tabId: String(tabId), uid: submitUid } }
      ],
      'filled and clicked'
    )
    await sendInPanel('填上 real chrome 然后提交')
    await waitTurn('filled and clicked')

    // 服务器这一侧：提交真的发生了，带着填进去的值
    await until(
      () => fixture.requests().some((r) => r.path.startsWith('/submit?name=real%20chrome')),
      `fixture server saw the submit; tool results were:\n${allToolTexts().slice(-1500)}`
    )
    expect(fixture.hits('/submit')).toBeGreaterThan(submitsBefore)
    // 页面这一侧：真实页面上确实写上了
    const out = await sw.eval<string>(
      `chrome.scripting.executeScript({ target: { tabId: ${tabId} }, func: () => document.getElementById('out').textContent }).then((r) => r[0].result)`
    )
    expect(out).toBe('hello real chrome')
  }, 240_000)

  it('RCB-5 没带上的新站点要问一次：卡片在侧边栏上，点了允许才开页', async () => {
    // localhost 与 127.0.0.1 是两个站点（站点按 host 算）
    const otherSite = fixture.url('/counter.html').replace('127.0.0.1', 'localhost')
    provider.reset()
    scriptChromeRun(
      provider,
      [{ id: 'rcb5_open', tool: 'open_tab', args: { url: otherSite } }],
      'opened'
    )
    await sendInPanel('打开那个计数器页面')

    await until(
      async () => (await panelText()).includes('localhost'),
      'ask card on the panel',
      60_000
    )
    // 问之前不许开
    expect((await queryTabs()).some((t) => t.url.includes('localhost'))).toBe(false)

    const clicked = await panel.eval<string>(`(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => b.className.includes('bg-accent'))
      if (!btn) return 'no allow button'
      btn.click()
      return 'clicked'
    })()`)
    expect(clicked).toBe('clicked')
    await waitTurn('opened')

    await until(
      async () => (await queryTabs()).some((t) => t.url.includes('localhost')),
      'the new site opened after allow'
    )
    const decisions = securityDecisions(app).filter((d) => d.toolCallId === 'rcb5_open')
    expect(decisions.some((d) => d.winning?.startsWith('ask-on-new-site'))).toBe(true)
  }, 240_000)

  it('RCB-6 关掉那个标签页 → 这条会话被删', async () => {
    await sw.eval(`chrome.tabs.remove(${tabId})`)
    await until(
      () => tabSessionRows().every((r) => r.id !== sessionId) || undefined,
      'tab session deleted',
      60_000
    )
    await sleep(200)
    const listed = await app.main.eval<Array<{ id: string }>>('window.api.session.list()')
    expect(listed.some((s) => s.id === sessionId)).toBe(false)
  }, 120_000)
})
