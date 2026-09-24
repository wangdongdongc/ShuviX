/**
 * 对话里的 ```interactive 交互图 —— 单测（interactiveFence.test.ts / interactiveBlock.dom.test.tsx /
 * customProtocols.test.ts / gate.test.ts）结构上够不着的那几件，全在真 Chromium + 真主进程里：
 *
 *   1. **边界本身**：不透明源、够不着父页面 / `window.api` / 存储、没有 eval、alert 不弹 —— jsdom 不跑
 *      srcdoc，这些只有真沙箱答得出来（E-1）；
 *   2. **没有网络出口**，连「块里自己写一条更宽的 meta CSP」「把自己导航走」都算上（E-2）。出口由
 *      spec 进程里的一台记录服务器判：它按 TCP 连接、HTTP 请求、WebSocket 升级三层记，一个都不该有；
 *   3. **库协议与主题**：`shuvix-lib://` 真的由 main 的协议处理器供出、Chart.js 真的被桥染成 `--viz-1`、
 *      切主题整块重挂载且拿到新颜色（E-3）；
 *   4. **接线**：流式标志 + 源文本经 AssistantBubble → ReactMarkdown → CodeBlock 一路传到块，围栏闭合
 *      那一刻（而不是整条消息写完）挂上（E-4）；落定之后不再重载（E-4b —— 它抓到过纯文字一轮收尾时
 *      整张卡重挂载，修在对话列表的 item key 上，见那条用例）；
 *   5. **认领 → 引用**：adopt 写出带 CSP 首行的 `.html`，```artifact 引用它走同一个沙箱（E-5）；
 *   6. **高度一次落定**：经典（占宽度的）滚动条下，按宽度定高的 Chart.js 图不让块高来回振荡 ——
 *      滚动条出没改宽度只在真 Chromium 的布局里发生（E-7）；
 *   7. **死循环冻不住应用**：沙箱跑在自己的进程里（E-6，放最后 —— 那个进程转到实例退出为止）。
 *
 * 块里的结果怎么读出来：沙箱是不透明源，主页面读不进它的 DOM，所以让块自己
 * `shuvix.sendPrompt('<前缀> ' + JSON.stringify(结果))` —— 那句话被宿主填进输入框（只填、不发），
 * spec 读 `chat.inputValue()`。这本身也是产品路径（桥 → postMessage → 来源比对 → 形状校验 → 输入框）。
 *
 * 一次 launchApp，**每条用例一个会话**（理由同 chat-mermaid：Virtuoso 不跟到底，叠几张卡之后新一轮
 * 落在渲染窗口之外）。选择器全部走 `harness/pages.ts` 的 `interactivePane` / `interactiveWatch`。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import ja from '@shuvix/chat-protocol/i18n/locales/ja.json'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import { SANDBOX_CSP } from '@shuvix/chat-protocol/utils/interactiveFence'
import { connect, listTargets, sleep, until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import { startFakeProvider, type FakeProvider } from '../../harness/fakeProvider'
import {
  createAgentSession,
  createProject,
  seedFakeProvider,
  waitRendererReady
} from '../../harness/seed'
import {
  chatPane,
  interactivePane,
  interactiveWatch,
  sidebarPane,
  type ChatPane,
  type InteractiveFrame,
  type InteractivePane,
  type InteractiveWatch,
  type SidebarPane
} from '../../harness/pages'

const MODEL = 'e2e-model'
/** 每条用例一个会话（标题即侧栏行文字） */
const SESSIONS = [
  'interactive-E1',
  'interactive-E2',
  'interactive-E3',
  'interactive-E4',
  'interactive-E4b',
  'interactive-E5',
  'interactive-E7',
  'interactive-E6',
  // 一条空会话：E-6 切过去卸下块（切回别的用例的会话，它们的块又会挂上）
  'interactive-idle'
]
const USAGE = { prompt: 90, completion: 20 }

/** 块之间必须留空行，否则 markdown 把它们并成一段 */
const doc = (...blocks: string[]): string => blocks.join('\n\n')
const fence = (code: string): string => `\`\`\`interactive\n${code}\n\`\`\``
/** 块源码按行写 —— 里面的 JS 字符串字面量要写 `\\n` 才是块里的 `\n` */
const block = (...lines: string[]): string => lines.join('\n')

/** 沙箱文档的开头：meta CSP 紧跟在 charset 之后、排在一切之前（interactiveFence.buildSandboxDocument） */
const SRCDOC_HEAD =
  '<!doctype html><html><head><meta charset="utf-8">\n' +
  `<meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}">`
/** html artifact 落盘时加的首行（artifacts/store.ts 的 withStandaloneCsp） */
const STANDALONE_CSP_LINE = `<meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}">`

let app: E2EApp
let provider: FakeProvider
let chat: ChatPane
let sidebar: SidebarPane
let watch: InteractiveWatch
let projectId = ''
/** 会话标题 → id（E-5 要按 id 找 artifact 目录） */
const sids = new Map<string, string>()
/** 每一轮各有一个开头标记；卡片按它认（见 pages.ts 的 assistantBodyWith） */
const cardOf = (marker: string): InteractivePane => interactivePane(app.main, marker)

beforeAll(async () => {
  app = await launchApp()
  provider = await startFakeProvider()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(app.main)

  const project = await createProject(app.main, { name: 'InteractiveProj', path: app.home })
  projectId = project.id
  for (const title of SESSIONS) {
    const sid = await app.main.eval<string>(
      `window.api.session.create(${JSON.stringify({ title, projectId })}).then((s) => s.id)`
    )
    sids.set(title, sid)
  }

  chat = chatPane(app.main)
  watch = interactiveWatch(app.main)
  sidebar = sidebarPane(app.main)
  // IPC 建的会话没有广播：点一次「新对话」让侧栏拉全量列表
  await sidebar.clickNewChat()
  await until(async () => {
    const titles = await sidebar.titles()
    return SESSIONS.every((t) => titles.includes(t))
  }, 'sidebar lists the interactive sessions')
}, 120_000)

afterAll(async () => {
  await watch?.stop()
  await provider?.close()
  await app?.stop()
})

/** 切到这条用例自己的会话 */
const openSession = async (title: string): Promise<void> => {
  expect(await sidebar.openSession(title)).toBe(true)
  await chat.ready()
}

/** 输入框里以 prefix 开头的那些行（块经 sendPrompt 填进来的结果） */
const composerLines = async (prefix: string): Promise<string[]> =>
  (await chat.inputValue()).split('\n').filter((l) => l.startsWith(prefix))

/** 等输入框里出现至少 n 行以 prefix 开头的结果 */
const waitComposerLines = (prefix: string, n = 1, timeoutMs = 20_000): Promise<string[]> =>
  until(
    async () => {
      const lines = await composerLines(prefix)
      return lines.length >= n ? lines : null
    },
    `${n} composer line(s) starting with ${JSON.stringify(prefix)}`,
    timeoutMs
  )

const payloadOf = <T>(line: string, prefix: string): T => JSON.parse(line.slice(prefix.length)) as T

const pageTargetCount = async (): Promise<number> =>
  (await listTargets(app.port)).filter((t) => t.type === 'page').length

const srcdocFrameTargets = async (): Promise<Array<{ webSocketDebuggerUrl: string }>> =>
  (await listTargets(app.port)).filter((t) => t.type === 'iframe' && t.url === 'about:srcdoc')

// ─── 出口记录服务器 ─────────────────────────────────────────────────────
//
// 不用 browserFixtures 的夹具网站：它只记 `request` 事件 —— WebSocket 握手走的是 `upgrade`、一个
// 被 CSP 放过却没发完请求的连接只有 `connection`，两样都到不了那份记录。「一个字节都没出去」要三层
// 一起记才站得住。

interface EgressServer {
  origin: string
  url(kind: string): string
  /** `METHOD path`，WebSocket 握手记成 `UPGRADE path` */
  hits(): string[]
  /** 接受过的 TCP 连接数 */
  connections(): number
  close(): Promise<void>
}

async function startEgressServer(): Promise<EgressServer> {
  const hits: string[] = []
  let connections = 0
  const server: Server = createServer((req, res) => {
    hits.push(`${req.method ?? 'GET'} ${req.url ?? '/'}`)
    res.writeHead(200, { 'Content-Type': 'text/plain', Connection: 'close' })
    res.end('ok')
  })
  server.on('connection', () => {
    connections++
  })
  server.on('upgrade', (req, socket) => {
    hits.push(`UPGRADE ${req.url ?? '/'}`)
    socket.destroy()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    origin,
    url: (kind) => `${origin}/?e=${kind}`,
    hits: () => [...hits],
    connections: () => connections,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}

// ─── 块源码 ──────────────────────────────────────────────────────────────

/** E-1：沙箱身份与隔离。每一项单独 try，抛了就记下异常名 */
const E1_BLOCK = block(
  '<title>E1 probe</title>',
  '<p>probing</p>',
  '<script>',
  '(function () {',
  '  var r = {};',
  "  function t(k, f) { try { r[k] = f(); } catch (e) { r[k] = 'threw:' + (e && e.name); } }",
  "  t('href', function () { return location.href; });",
  "  t('origin', function () { return self.origin; });",
  "  t('parentDoc', function () { return typeof parent.document; });",
  "  t('parentApi', function () { return typeof parent.api; });",
  "  t('localStorage', function () { return typeof localStorage; });",
  "  t('cookie', function () { return document.cookie; });",
  "  t('eval', function () { return eval('1+1'); });",
  "  t('fn', function () { return new Function('return 2')(); });",
  "  t('alert', function () { return String(alert('x')); });",
  "  t('frozen', function () { return Object.isFrozen(shuvix); });",
  "  t('keys', function () { return Object.keys(shuvix).sort(); });",
  "  shuvix.sendPrompt('PROBE ' + JSON.stringify(r));",
  '})();',
  '</script>'
)

/**
 * E-2：出口。开头先写一条**放宽**的 meta CSP（落在 body 里、按规范不生效；就算生效，CSP 也只能取交集），
 * 然后把能想到的出口全试一遍，每一条带 `?e=<种类>`，服务器那边一眼看得出是哪一条漏的。
 * 导航类（self / anchor / top）排在最后：真被放行的话文档就换了，后面的都不会跑。1.5 秒后报活 ——
 * 报得回来 = 自己的导航企图都没得逞。
 */
const e2Block = (egress: EgressServer): string =>
  block(
    `<head><meta http-equiv="Content-Security-Policy" content="default-src * 'unsafe-eval' 'unsafe-inline'"></head>`,
    '<title>E2 egress</title>',
    '<style>',
    `@import url("${egress.url('css-import')}");`,
    `.bg { background-image: url("${egress.url('css-url')}"); }`,
    `@font-face { font-family: E2Font; src: url("${egress.url('font')}"); }`,
    '.ff { font-family: E2Font; }',
    '</style>',
    '<div class="bg ff" style="width:40px;height:20px">x</div>',
    `<img src="${egress.url('img-tag')}" alt="">`,
    `<link rel="stylesheet" href="${egress.url('link-css')}">`,
    `<script src="${egress.url('script-src')}"></script>`,
    `<iframe src="${egress.url('iframe')}"></iframe>`,
    `<video src="${egress.url('video')}"></video>`,
    `<form id="f" action="${egress.url('form')}" method="post"><input name="a" value="1"></form>`,
    `<a id="self-link" href="${egress.url('anchor')}">self</a>`,
    `<a id="blank-link" href="${egress.url('anchor-blank')}" target="_blank">blank</a>`,
    '<script>',
    '(function () {',
    `  var U = ${JSON.stringify(egress.origin)};`,
    "  function q(k) { return U + '/?e=' + k; }",
    '  function t(f) { try { f(); } catch (e) {} }',
    "  setTimeout(function () { shuvix.sendPrompt('ALIVE ' + location.href); }, 1500);",
    "  t(function () { fetch(q('fetch')).catch(function () {}); });",
    "  t(function () { var x = new XMLHttpRequest(); x.open('GET', q('xhr')); x.send(); });",
    "  t(function () { new Image().src = q('image'); });",
    "  t(function () { navigator.sendBeacon(q('beacon'), 'x'); });",
    "  t(function () { new WebSocket(U.replace('http:', 'ws:') + '/?e=ws'); });",
    "  t(function () { new EventSource(q('sse')); });",
    "  t(function () { document.getElementById('f').submit(); });",
    "  t(function () { window.open(q('window-open')); });",
    "  t(function () { document.getElementById('blank-link').click(); });",
    "  t(function () { top.location = q('top'); });",
    "  t(function () { document.getElementById('self-link').click(); });",
    "  t(function () { location.href = q('self'); });",
    '})();',
    '</script>'
  )

/** E-3：库与主题。结果在 load 之后报（三条 `<script src>` 都有了结果） */
const E3_BLOCK = block(
  '<title>E3 libs</title>',
  '<canvas id="c"></canvas>',
  "<script>window.__nope = 'pending';</script>",
  '<script src="shuvix-lib://chart.js"></script>',
  '<script src="shuvix-lib://d3.js"></script>',
  `<script src="shuvix-lib://nope.js" onerror="window.__nope = 'error'" onload="window.__nope = 'load'"></script>`,
  '<script>',
  "window.addEventListener('load', function () {",
  '  var r = { chart: typeof Chart, d3: typeof d3, nope: window.__nope };',
  '  try {',
  "    var chart = new Chart(document.getElementById('c'), {",
  "      type: 'bar',",
  "      data: { labels: ['a', 'b'], datasets: [{ label: 'x', data: [1, 2] }] },",
  '      options: { animation: false }',
  '    });',
  '    r.dataset = String(chart.data.datasets[0].backgroundColor);',
  "  } catch (e) { r.dataset = 'threw:' + e.name; }",
  "  try { d3.csvParse('a,b\\n1,2'); r.csv = 'ok'; } catch (e) { r.csv = 'threw:' + e.name; }",
  "  r.viz1 = shuvix.color('--viz-1');",
  "  r.text = shuvix.color('--theme-text-primary');",
  '  r.body = getComputedStyle(document.body).color;',
  "  shuvix.sendPrompt('LIBS ' + JSON.stringify(r));",
  '});',
  '</script>'
)

/**
 * E-5：数一数文档里有几条 CSP meta —— 围栏里跑是 1（只有沙箱 head 那条），从 artifact 文件里跑是 2
 * （文件首行那条落在 body 里）。于是输入框里那行说得出「这一次是谁跑的」
 */
const E5_BLOCK = block(
  '<title>Growth</title>',
  '<p>growth</p>',
  '<script>',
  `shuvix.sendPrompt('RUNS ' + document.querySelectorAll('meta[http-equiv="Content-Security-Policy"]').length);`,
  '</script>'
)

/**
 * E-7：一张 responsive、缺省宽高比的折线图（不给任何尺寸选项 —— 正是按宽度定高的那种），上面一行
 * 带滑块的段落。开头那条样式给滚动条上了样式，Chromium 于是画**经典**滚动条（占布局宽度，同 macOS
 * 设成「总是显示滚动条」）；不加它，这台机器上的浮层滚动条不占宽度，振荡的环根本搭不起来，用例会
 * 空跑成绿的 —— 所以块里另拿一个 `overflow:scroll` 的探针量滚动条宽度，一并报回来。
 *
 * 行内插件只为报一次数、不碰尺寸：第一次画出像素后报 `CHART {…}`（图真的画进了 canvas）。
 */
const E7_BLOCK = block(
  '<title>E7 chart</title>',
  '<style>::-webkit-scrollbar{width:14px}::-webkit-scrollbar-thumb{background:gray}</style>',
  '<p><label>points <input type="range" min="2" max="10" value="10"></label></p>',
  '<canvas id="c"></canvas>',
  '<script src="shuvix-lib://chart.js"></script>',
  '<script>',
  '(function () {',
  "  var canvas = document.getElementById('c');",
  '  var sent = false;',
  '  function painted() {',
  "    var px = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;",
  '    var n = 0;',
  '    for (var i = 3; i < px.length; i += 4) if (px[i] > 0) n++;',
  '    return n;',
  '  }',
  '  function scrollbarWidth() {',
  "    var p = document.createElement('div');",
  "    p.style.cssText = 'position:absolute;top:0;left:0;width:100px;height:50px;overflow:scroll;visibility:hidden';",
  '    document.body.appendChild(p);',
  '    var w = p.offsetWidth - p.clientWidth;',
  '    p.remove();',
  '    return w;',
  '  }',
  '  new Chart(canvas, {',
  "    type: 'line',",
  '    data: {',
  '      labels: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],',
  "      datasets: [{ label: 'y', data: [3, 7, 4, 8, 6, 9, 5, 10, 7, 11] }]",
  '    },',
  '    plugins: [{',
  "      id: 'e7probe',",
  '      afterDraw: function (chart) {',
  '        if (sent) return;',
  '        var n = painted();',
  '        if (!n) return;',
  '        sent = true;',
  "        shuvix.sendPrompt('CHART ' + JSON.stringify({",
  '          chart: typeof Chart,',
  '          attached: Chart.getChart(canvas) === chart,',
  '          width: canvas.width,',
  '          cssHeight: canvas.clientHeight,',
  '          painted: n,',
  '          scrollbar: scrollbarWidth()',
  '        }));',
  '      }',
  '    }]',
  '  });',
  '})();',
  '</script>'
)

describe('对话里的 interactive 交互图', () => {
  it('E-0 真提示词：项目会话的根 Agent 学到 ```interactive、先读技能那一页、改块走 adopt（契约不常驻），笔记本会话学不到', async () => {
    mkdirSync(join(app.home, 'notes'), { recursive: true })
    writeFileSync(join(app.home, 'notes', 'e0.md'), '# e0\n')
    const work = await createAgentSession(app.main, { projectId, title: 'interactive-E0-work' })
    expect(work.systemPrompt).toContain('```interactive')
    expect(work.systemPrompt).toContain('references/interactive.md')
    expect(work.systemPrompt).toContain('`.html`')
    // 契约（库地址、桥）只在技能里 —— 常驻系统提示的只有「什么时候用 + 先加载技能」
    expect(work.systemPrompt).not.toContain('shuvix-lib://')
    expect(work.systemPrompt).not.toContain('shuvix.sendPrompt')

    const note = await createAgentSession(app.main, {
      projectId,
      title: 'interactive-E0-notebook',
      notebookPath: 'notes/e0.md'
    })
    expect(note.systemPrompt).not.toContain('```interactive')
    expect(note.systemPrompt).not.toContain('shuvix-lib://')
  })

  it('E-1 沙箱身份：allow-scripts 恰好、不透明源、够不着父页面与存储、没有 eval、alert 不弹；只填不发', async () => {
    await openSession('interactive-E1')
    provider.reset()
    provider.script({ text: doc('MARK-E1 a probe:', fence(E1_BLOCK)), usage: USAGE })
    await chat.typeAndSend('draw E1')
    await chat.waitIdle()
    const card = cardOf('MARK-E1')

    const shot = await card.waitFrame()
    expect(shot.frames).toBe(1)
    expect(shot.sandbox).toBe('allow-scripts')
    expect(shot.referrerPolicy).toBe('no-referrer')
    expect(shot.hasSrc).toBe(false)
    expect(shot.srcdocHead.startsWith(SRCDOC_HEAD), shot.srcdocHead).toBe(true)
    expect(shot.pending).toBe(false)
    expect(shot.unsupported).toBe(false)
    expect(shot.rerun && shot.toggle).toBe(true)
    // 围栏没给名字：工具栏与 iframe 的 title 用缺省文案（界面语言随环境，三语都认）
    expect([en, ja, zh].map((l) => l.message.interactive)).toContain(shot.toolbarTitle)
    expect([en, ja, zh].map((l) => l.message.interactiveFrameTitle)).toContain(shot.frameTitle)

    const [line] = await waitComposerLines('PROBE ')
    expect(payloadOf(line, 'PROBE ')).toEqual({
      href: 'about:srcdoc',
      origin: 'null',
      parentDoc: 'threw:SecurityError',
      parentApi: 'threw:SecurityError',
      localStorage: 'threw:SecurityError',
      cookie: 'threw:SecurityError',
      eval: 'threw:EvalError',
      fn: 'threw:EvalError',
      alert: 'undefined',
      frozen: true,
      keys: ['color', 'sendPrompt']
    })
    // 高度跟着内容报上来了，落在宿主的范围里
    const height = parseFloat((await card.shot())?.height ?? '')
    expect(height).toBeGreaterThanOrEqual(40)
    expect(height).toBeLessThanOrEqual(720)

    // 只填不发：再等一会儿，没有第二次请求、不在流式、那行还在输入框里、对话里只有一条用户消息
    await sleep(800)
    expect(provider.chatRequestCount()).toBe(1)
    expect(await chat.isBusy()).toBe(false)
    expect(await composerLines('PROBE ')).toEqual([line])
    expect((await chat.settledItems()).filter((i) => i.role === 'user')).toHaveLength(1)

    // 沙箱跑在自己的 CDP target 里（进程外 iframe）
    expect((await srcdocFrameTargets()).length).toBeGreaterThanOrEqual(1)
  }, 120_000)

  it('E-2 没有出口：CSP 覆盖的请求、放宽 CSP 的企图、弹窗与自我导航，服务器一个连接都没收到；块活着', async () => {
    const egress = await startEgressServer()
    try {
      // 正对照：记录服务器自己是通的（否则「零」可能只是它根本收不到）
      await fetch(egress.url('control')).then((r) => r.text())
      await until(() => egress.hits().length === 1, 'egress server saw the control request')
      const connectionsBefore = egress.connections()
      expect(egress.hits()).toEqual(['GET /?e=control'])

      await openSession('interactive-E2')
      provider.reset()
      const pagesBefore = await pageTargetCount()
      const mainHref = await app.main.eval<string>('location.href')
      provider.script({ text: doc('MARK-E2 egress:', fence(e2Block(egress))), usage: USAGE })
      await chat.typeAndSend('draw E2')
      await chat.waitIdle()
      const card = cardOf('MARK-E2')
      await card.waitFrame()
      await card.markFrame('E2')

      const [alive] = await waitComposerLines('ALIVE ', 1, 25_000)
      // 自我导航全被拦下：报活的还是 srcdoc 里那份文档
      expect(alive).toBe('ALIVE about:srcdoc')
      // 宽限：让任何慢一拍的请求有机会到
      await sleep(1500)
      expect(egress.hits()).toEqual(['GET /?e=control'])
      expect(egress.connections()).toBe(connectionsBefore)

      // 没有弹窗、主窗口没被带走、iframe 还是那个节点
      expect(await pageTargetCount()).toBe(pagesBefore)
      expect(await app.main.eval<string>('location.href')).toBe(mainHref)
      expect(await card.frameMark()).toBe('E2')
      // 自我导航是被 main 的 will-frame-navigate 守卫拦的（发起方是不透明源）—— 页面 CSP 的 frame-src
      // 为 widget 放行了 http://127.0.0.1:*，挡住它的不是 CSP。最后那一次（location.href）必然走到了守卫
      expect(app.mainLog()).toContain(
        `Blocked a sandboxed frame navigating to ${egress.url('self')}`
      )
    } finally {
      await egress.close()
    }
  }, 120_000)

  it('E-3 库与主题：shuvix-lib 供出 Chart.js / D3，未知名字加载失败；数据集缺省取 --viz-1；切主题整块重挂载、拿到新颜色', async () => {
    const themeBefore = await app.main.eval<string | null>(
      `window.api.settings.get('general.theme')`
    )
    try {
      await openSession('interactive-E3')
      provider.reset()
      provider.script({ text: doc('MARK-E3 libs:', fence(E3_BLOCK)), usage: USAGE })
      await chat.typeAndSend('draw E3')
      await chat.waitIdle()
      const card = cardOf('MARK-E3')
      await card.waitFrame()

      type Libs = {
        chart: string
        d3: string
        nope: string
        dataset: string
        csv: string
        viz1: string
        text: string
        body: string
      }
      const [first] = await waitComposerLines('LIBS ')
      const libs = payloadOf<Libs>(first, 'LIBS ')
      expect(libs.chart).toBe('function')
      expect(libs.d3).toBe('object')
      expect(libs.nope).toBe('error')
      // 没有 'unsafe-eval'：d3.csvParse 靠 new Function，抛
      expect(libs.csv.startsWith('threw:'), libs.csv).toBe(true)
      const hostViz1 = await card.hostTokenColor('--viz-1')
      expect(hostViz1).toMatch(/^rgb/)
      expect(libs.viz1).toBe(hostViz1)
      expect(libs.dataset).toBe(hostViz1)
      const hostText = await card.hostTokenColor('--theme-text-primary')
      expect(libs.text).toBe(hostText)
      expect(libs.body).toBe(hostText)

      // 切到另一种明暗：块整块重挂载（新节点），再报一行，颜色是新主题的
      await card.markFrame('before-theme')
      const themeIdBefore = await app.main.eval<string>(
        `document.documentElement.getAttribute('data-theme') ?? ''`
      )
      const nextMode = themeIdBefore.includes('light') ? 'dark' : 'light'
      await app.main.eval(`window.api.settings.set({ key: 'general.theme', value: '${nextMode}' })`)
      await until(
        () =>
          app.main.eval<boolean>(
            `(document.documentElement.getAttribute('data-theme') ?? '') !== ${JSON.stringify(themeIdBefore)}`
          ),
        `data-theme switched away from ${themeIdBefore}`
      )
      await until(async () => {
        const s = await card.shot()
        return s && s.frames === 1 && (await card.frameMark()) === null
      }, 'interactive iframe remounted after the theme switch')
      const lines = await waitComposerLines('LIBS ', 2)
      const second = payloadOf<Libs>(lines[lines.length - 1], 'LIBS ')
      const hostViz1After = await card.hostTokenColor('--viz-1')
      expect(hostViz1After).not.toBe(hostViz1)
      expect(second.viz1).toBe(hostViz1After)
      expect(second.dataset).toBe(hostViz1After)
      expect(second.body).toBe(await card.hostTokenColor('--theme-text-primary'))
    } finally {
      await app.main.eval(
        `window.api.settings.set({ key: 'general.theme', value: ${JSON.stringify(themeBefore || 'dark')} })`
      )
    }
  }, 120_000)

  /**
   * E-4 / E-4b 共用的一轮：围栏逐片写出（每片隔 300ms），整条消息挂在 holdMs 里，等块挂上后给它的
   * iframe 节点挂一个 expando，再放行、等落定。块加载一次就往输入框里填一行 LOADED
   */
  const streamLoadedBlock = async (
    title: string,
    head: string
  ): Promise<{ card: InteractivePane; frames: InteractiveFrame[]; busyAtMount: boolean }> => {
    await openSession(title)
    provider.reset()
    provider.script({
      text: [
        `${head} here it comes:\n\n`,
        '```interactive\n<title>E4</title>\n<script>\n',
        'shuvix.sendPrompt("LOADED")\n',
        '</script>\n```\n\n',
        `${head}-TAIL and that is all.`
      ],
      chunkDelayMs: 300,
      holdMs: 6000,
      usage: USAGE
    })
    await watch.start(head, `${head}-TAIL`)
    await chat.typeAndSend(`draw ${head}`)
    const card = cardOf(head)

    await card.waitFrame(8000)
    // 这一刻消息还挂在 holdMs 里：块是在流式期间挂上的，不是等整条消息写完
    const busyAtMount = await chat.isBusy()
    expect(await card.markFrame(head)).toBe(true)

    await until(() => provider.holding(), `provider holding the ${head} reply`)
    provider.release()
    await chat.waitIdle()
    // 给「落定时重挂载 → 再加载一次」留出发生的时间
    await sleep(1000)
    await watch.stop()
    return { card, frames: await watch.frames(), busyAtMount }
  }

  it('E-4 流式中：围栏没闭合只有占位（行数跟着长）；闭合那一刻就挂上，不等整条消息写完', async () => {
    const { card, frames, busyAtMount } = await streamLoadedBlock('interactive-E4', 'MARK-E4')
    expect(busyAtMount).toBe(true)

    const firstMount = frames.findIndex((f) => f.frame > 0)
    expect(firstMount, JSON.stringify(frames)).toBeGreaterThan(0)
    // 围栏写到一半时：只有占位（带行数、不减），没有 iframe
    const before = frames.slice(0, firstMount)
    const counts = before
      .filter((f) => f.pending)
      .map((f) => Number(/\d+/.exec(f.pendingText ?? '')?.[0] ?? NaN))
    expect(counts.length, JSON.stringify(frames)).toBeGreaterThan(0)
    expect(counts.every(Number.isFinite), JSON.stringify(frames)).toBe(true)
    expect(
      counts.every((n, i) => i === 0 || n >= counts[i - 1]),
      JSON.stringify(counts)
    ).toBe(true)
    expect(
      before.every((f) => f.frame === 0),
      JSON.stringify(frames)
    ).toBe(true)
    // 挂上那一帧：还在流式中，围栏之后的那一片还没上屏
    expect(frames[firstMount].busy, JSON.stringify(frames)).toBe(true)
    expect(frames[firstMount].tail, JSON.stringify(frames)).toBe(false)
    // 挂上之后再没回到占位
    expect(
      frames.slice(firstMount).every((f) => !f.pending),
      JSON.stringify(frames)
    ).toBe(true)

    // 落定之后：卡里恰好一个 iframe，块在跑（至少加载过一次，输入框里只有它填的行）
    expect(frames[frames.length - 1].busy, JSON.stringify(frames)).toBe(false)
    const settled = await card.shot()
    expect(settled?.frames).toBe(1)
    expect(settled?.pending).toBe(false)
    const composer = (await chat.inputValue()).split('\n')
    expect(
      composer.every((l) => l === 'LOADED'),
      JSON.stringify(composer)
    ).toBe(true)
    expect(provider.chatRequestCount()).toBe(1)
  }, 120_000)

  /**
   * 回归：**纯文字的一轮收尾时，整张卡曾被重挂载**。
   *
   * 2026-09-24 本条初写时是红的（当时 `.skip`）：流式期间卡片的 `data-msg-id` 是 `streaming-live`，
   * 落定后换成真实 entry id；Virtuoso 的 `[data-index]` 元素、消息元素、`.markdown-body`、
   * `[data-interactive-figure]` 与 iframe 全是新节点，watch 里 iframe 节点编号是 [1, 2]，输入框里是
   * `LOADED\nLOADED` —— 块跑了两遍。原因在对话列表的 item key：它取「组首消息 id」，而一轮只有正文
   * 时组里唯一的消息就是流式占位本身。修法是助手卡的 key 改按轮次起（conversationItems.ts，单测 K 组）。
   * 对 mermaid 那只是重画一遍；对交互图是副作用翻倍、块内状态（尾巴流完之前拖过的滑块）归零。
   */
  it('E-4b 落定后还是同一个 iframe 节点、块只加载过一次', async () => {
    const { card, frames } = await streamLoadedBlock('interactive-E4b', 'MARK-SETTLE')
    const nodes = [...new Set(frames.map((f) => f.frame).filter((n) => n > 0))]
    expect(nodes, JSON.stringify(frames)).toEqual([1])
    expect(await card.frameMark()).toBe('MARK-SETTLE')
    // 只加载过一次：重载会往输入框里再接一行
    expect(await chat.inputValue()).toBe('LOADED')
    expect(provider.chatRequestCount()).toBe(1)
  }, 120_000)

  it('E-5 认领 → 引用：adopt 写出 CSP 首行 + 原样源码的 growth.html；```artifact 引用它走同一个沙箱', async () => {
    const sid = sids.get('interactive-E5')!
    await openSession('interactive-E5')
    provider.reset()
    provider.script({ text: doc('MARK-E5A a growth block:', fence(E5_BLOCK)), usage: USAGE })
    await chat.typeAndSend('draw E5')
    await chat.waitIdle()
    await cardOf('MARK-E5A').waitFrame()
    await waitComposerLines('RUNS 1')

    provider.script(
      {
        toolCalls: [
          { id: 'call_adopt_e5', name: 'artifact', args: JSON.stringify({ action: 'adopt' }) }
        ],
        usage: USAGE
      },
      {
        text: doc('MARK-E5B adopted it:', '```artifact\ngrowth.html\n```'),
        usage: USAGE
      }
    )
    await chat.typeAndSend('adopt E5')
    await chat.waitIdle()

    // 工具回执进了下一次请求
    const followUp = provider.chatRequests().at(-1)
    expect(followUp?.raw ?? '').toContain('as growth.html')

    const file = join(app.home, '.shuvix', 'artifacts', sid, 'growth.html')
    await until(() => existsSync(file), 'growth.html written')
    const content = readFileSync(file, 'utf8')
    const [firstLine, ...rest] = content.split('\n')
    expect(firstLine).toBe(STANDALONE_CSP_LINE)
    expect(rest.join('\n')).toBe(E5_BLOCK.trim())

    const ref = cardOf('MARK-E5B')
    const shot = await ref.waitFrame()
    expect(shot.sandbox).toBe('allow-scripts')
    expect(shot.toolbarTitle).toBe('Growth')
    expect(shot.frameTitle).toBe('Growth')
    expect(shot.srcdocHead.startsWith(SRCDOC_HEAD), shot.srcdocHead).toBe(true)
    // 引用里跑的是文件那一份（文件首行的 meta 也在文档里，所以数到 2）
    await waitComposerLines('RUNS 2')
  }, 120_000)

  /**
   * 回归：**经典滚动条下，按宽度定高的图让块高来回振荡**。
   *
   * 用户看到的：块载入后约一秒里高度在两个值之间来回跳、滚动条一闪一闪，然后才停。环是这样搭起来的：
   * 块刚挂上时 iframe 还矮 → 内容溢出 → 出滚动条 → 页面变窄 → Chart.js 按宽度把图缩矮 → 上报的
   * 高度变了 → 宿主改 iframe 高度 → 不溢出了、滚动条消失 → 页面变宽 → 图又变高……修之前在这个
   * 隔离实例里量到 401px↔394px 变了 29 次、约 0.9s；修之后开始采样时高度就已经落定，只记到一条。
   * 修法（沙箱基础样式的 `scrollbar-gutter: stable`，见 interactiveFence.ts 的 BASE_STYLE）这里不看，
   * 只看结果：高度一次落定。
   */
  it('E-7 经典滚动条下按宽度定高的 Chart.js 图：块高一次落定，不来回振荡', async () => {
    const TRACE_MS = 3000
    const QUIET_MS = 1500
    await openSession('interactive-E7')
    provider.reset()
    provider.script({ text: doc('MARK-E7 a responsive chart:', fence(E7_BLOCK)), usage: USAGE })
    await chat.typeAndSend('draw E7')
    await chat.waitIdle()
    const card = cardOf('MARK-E7')
    await card.waitFrame()

    const trace = await card.heightTrace(TRACE_MS)
    const detail = JSON.stringify(trace)
    // 开始那一刻的值 + 至多一次落定（振荡时这里是几十条）
    expect(trace.length, detail).toBeGreaterThanOrEqual(1)
    expect(trace.length, detail).toBeLessThanOrEqual(2)
    // 最后 1.5s 纹丝不动
    const last = trace[trace.length - 1]
    expect(last.t, detail).toBeLessThanOrEqual(TRACE_MS - QUIET_MS)
    expect((await card.shot())?.height).toBe(last.height)

    type ChartReport = {
      chart: string
      attached: boolean
      width: number
      cssHeight: number
      painted: number
      scrollbar: number
    }
    const [line] = await waitComposerLines('CHART ')
    const report = payloadOf<ChartReport>(line, 'CHART ')
    // 前提：这里的滚动条真的占宽度 —— 否则振荡的环搭不起来，上面的断言是空过
    expect(report.scrollbar, line).toBeGreaterThan(0)
    // 块里真有一张 Chart.js 画进去的图
    expect(report.chart, line).toBe('function')
    expect(report.attached, line).toBe(true)
    expect(report.width, line).toBeGreaterThan(0)
    expect(report.painted, line).toBeGreaterThan(0)
    // 落定的高度装得下整张图（加上段落与内边距），不是挂载时那个占位高度
    expect(parseFloat(last.height), `${detail} ${line}`).toBeGreaterThan(report.cssHeight)
    expect(provider.chatRequestCount()).toBe(1)
  }, 120_000)

  // 放最后：那个死循环的进程一直转到实例退出
  it('E-6 块里的死循环冻不住应用：主窗口照常应答，切走会话把块卸下', async () => {
    await openSession('interactive-E6')
    provider.reset()
    provider.script({
      text: doc(
        'MARK-E6 a runaway block:',
        fence(
          block(
            '<title>Spin</title>',
            '<script>',
            "shuvix.sendPrompt('SPIN');",
            // 先让 SPIN 这条消息发出去，再开始转
            'setTimeout(function () { while (true) {} }, 50);',
            '</script>'
          )
        )
      ),
      usage: USAGE
    })
    await chat.typeAndSend('draw E6')
    await chat.waitIdle()
    const card = cardOf('MARK-E6')
    await card.waitFrame()
    await waitComposerLines('SPIN')

    // 确认它真的在转：沙箱自己的 target 上一条 evaluate 回不来
    const spinning = await until(
      async () => {
        for (const target of await srcdocFrameTargets()) {
          const client = await connect(target.webSocketDebuggerUrl)
          try {
            const answered = await Promise.race([
              // 回不来的那条在 close 时会被拒：接住，别成了未处理的 rejection
              client.eval<number>('1').then(
                () => true,
                () => false
              ),
              sleep(1500).then(() => false)
            ])
            if (!answered) return true
          } catch {
            /* target 不在了：换下一个 */
          } finally {
            client.close()
          }
        }
        return false
      },
      'the sandboxed frame is stuck in its loop',
      15_000
    )
    expect(spinning).toBe(true)

    // 主窗口照常应答：五次、隔开约 3 秒，每次都在 1 秒内
    for (let i = 0; i < 5; i++) {
      const t0 = Date.now()
      expect(await app.main.eval<number>('1 + 1')).toBe(2)
      expect(Date.now() - t0).toBeLessThan(1000)
      await sleep(600)
    }

    // 还能切会话；切走之后块卸下，沙箱的 target 也跟着没了
    await openSession('interactive-idle')
    expect(await card.shot()).toBeNull()
    await until(
      async () => (await srcdocFrameTargets()).length === 0,
      'sandbox frame target gone after leaving the session'
    )
  }, 120_000)
})
