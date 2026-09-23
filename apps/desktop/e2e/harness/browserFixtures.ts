/**
 * 内置浏览器（`mcp:browser` 能力服务器）e2e 的共用夹具 —— 两样东西：
 *
 *  1. **夹具网站**：spec 进程里起一台 `127.0.0.1:0` 的 HTTP 服务，记下每一个请求。内置浏览器
 *     打开的就是它 —— 「点击真的发生了」「被拒的地址一次都没请求过」都按服务器这一侧的记录断，
 *     不信工具自己的回报。同一个端口在 IPv6 回环 `::1` 上也听一份，于是 `http://localhost:<port>`
 *     （`localhostUrl`）是同一台服务器的**另一个站点** —— 要一次跨站导航（新渲染进程）时用它。
 *     **只用 http**：https 证书不受信时（且没开「忽略证书错误」），浏览器窗口正在前台有焦点的话
 *     主进程会弹 `dialog.showMessageBox`，CDP 关不掉它，整条 spec 会挂死（窗口不在前台时是静默拒绝，
 *     见 browserViewService 的证书处理）。
 *  2. **脚本化运行**：把一串 `mcp__browser__*` 调用排进假提供商（每个元素一轮 LLM 调用），
 *     经 IPC 发一条 prompt，等 `agent_end`，按 toolCallId 取回每个调用的 `tool_end`。
 *     元素 id（uid）要从上一步快照的结果里读，所以「打开 → 快照 → 点击」是三次运行，不是一次。
 *
 * 两条会让 spec 挂死的坑，写在这里免得再踩：
 *   - 永远别 `click` 一个 file input —— 那会弹原生文件选择框；上传走 `upload_file`；
 *   - 浏览器窗口不必打开：tab 不上墙时住在停放窗口里、一直可见、按 1280x800 排版，点击与截图照常
 *     （旧的「右侧面板要开着」已不成立 —— tab 永远不会被 setVisible(false)，见 browserViewService）。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { connect, listTargets, until, type CdpClient } from './cdp'
import type { FakeProvider, FakeTurn } from './fakeProvider'
import type { EventRecorder, RecordedEvent } from './seed'

/** 内置浏览器 server 的全部工具（桌面端能力全开，一个不少） */
export const BROWSER_TOOL_NAMES = [
  'list_tabs',
  'open_tab',
  'close_tab',
  'navigate',
  'snapshot',
  'read_page',
  'screenshot',
  'click',
  'fill',
  'type',
  'press_key',
  'hover',
  'upload_file',
  'scroll',
  'wait_for',
  'evaluate',
  'network',
  'console',
  'pdf',
  'cdp',
  'events',
  'cdp_recipes'
] as const

/** `mcp__browser__<tool>` —— 客户端给内置 server 的工具加的前缀 */
export const browserTool = (tool: string): string => `mcp__browser__${tool}`

// ─── 夹具网站 ───────────────────────────────────────────────────────────

/** 一次记下的请求（path 含 query） */
export interface FixtureRequest {
  method: string
  path: string
}

export interface FixtureServer {
  /** `http://127.0.0.1:<port>` */
  origin: string
  url(path: string): string
  /** `http://localhost:<port>`：同一台服务器，但对浏览器是另一个站点（跨站导航用） */
  localhostOrigin: string
  localhostUrl(path: string): string
  /** 全部请求（按到达顺序） */
  requests(): FixtureRequest[]
  /** path 以 prefix 开头的请求次数 */
  hits(prefix: string): number
  close(): Promise<void>
}

/** 表单页的 cookie 名 —— 设置页「已保存站点」列的就是写过 cookie 的 host */
export const FIXTURE_COOKIE = 'e2e_visit'

const page = (title: string, body: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`

/**
 * - `/form.html`：写一个持久 cookie；一个名为 Name 的输入框；Submit **同步**把 `hello <name>` 写进
 *   `#out` 再发 `fetch('/submit?name=…')`（服务器那一侧的 `/submit` 记录证明点击真的发生了）；
 *   一个名为 Attachment 的文件输入框（只许 upload_file，不许 click）。
 * - `/counter.html`：Add 往列表里追加 `item N`；前面垫六行静态文字，好让一次追加的变化量
 *   远低于快照差异的 50% 上限（超过就回全量，差异用例会假红）。
 * - `/ask-me.html`、`/deny.html`：url 策略用例的目标页，内容无关紧要。
 *
 * 「别打扰用户」（browser-no-disturb）的几页 —— 它们会去碰原生文件框 / 打印框 / 下拉菜单，所以每一页
 * 都自带保险，产品的防护万一失效也只会让用例变红，不会在开发者的屏幕上弹东西：
 * - `/upload.html`：单选 `#f`（Attachment）、多选 `#fm`（Attachments）两个文件输入框，各自的 click /
 *   change 计数（`__clicks` / `__changes`）；按钮 Attach later 在 1.5 秒后**由页面自己**点 `#f`
 *   （模拟点击之后异步打开文件框的页面）。只许在 spec 已经装好 `interceptFileChoosers` 之后点。
 * - `/print.html` 与它的 iframe `/print-child.html`：解析期就调 `window.print()` —— 但先检查 print 还是
 *   不是原生的（`Function.prototype.toString` 里有 `[native code]`）：是原生的就只把标题改成
 *   NATIVE-PRINT、**不调**，不是才调并记 `__printed`；子页面把自己看到的结论写到父页面的 `__child`。
 * - `/opener.html` → target=_blank 链接 → `/autoprint.html`：弹出页同样先查 print 是不是原生的，
 *   把结论报给服务器（`/report?native=<bool>`），只有不是原生的才调。
 * - `/select.html`：单选 `#s`（Fruit）、多选 `#m`（Colors）、输入框 `#after`、open shadow root 里的单选
 *   `#ss`、srcdoc iframe 里的单选 `#is`；捕获阶段的 keydown 记录器 `__keys`（iframe 里的键记作
 *   `frame:<key>`）。
 * - `/report`：像 `/submit` 一样回 200，只为留下请求记录。
 */
const PAGES: Record<string, () => { headers?: Record<string, string>; html: string }> = {
  '/form.html': () => ({
    headers: { 'Set-Cookie': `${FIXTURE_COOKIE}=1; Path=/; Max-Age=86400` },
    html: page(
      'E2E Form',
      [
        '<h1>E2E Form Heading</h1>',
        '<p>A small form for the browser e2e.</p>',
        '<input id="name" type="text" aria-label="Name">',
        '<button id="submit" type="button" onclick="(function () {',
        "  var v = document.getElementById('name').value;",
        "  document.getElementById('out').textContent = 'hello ' + v;",
        "  fetch('/submit?name=' + encodeURIComponent(v));",
        '})()">Submit</button>',
        '<input id="f" type="file" aria-label="Attachment">',
        '<div id="out"></div>'
      ].join('\n')
    )
  }),
  '/counter.html': () => ({
    html: page(
      'E2E Counter',
      [
        '<h1>Counter</h1>',
        '<p>Static line one.</p>',
        '<p>Static line two.</p>',
        '<p>Static line three.</p>',
        '<p>Static line four.</p>',
        '<p>Static line five.</p>',
        '<p>Static line six.</p>',
        '<button type="button" onclick="(function () {',
        "  var ul = document.getElementById('list');",
        "  var li = document.createElement('li');",
        "  li.textContent = 'item ' + (ul.children.length + 1);",
        '  ul.appendChild(li);',
        '})()">Add</button>',
        '<ul id="list"></ul>'
      ].join('\n')
    )
  }),
  '/ask-me.html': () => ({ html: page('Ask me', '<h1>Ask me page</h1>') }),
  '/deny.html': () => ({ html: page('Deny', '<h1>Deny page</h1>') }),
  '/upload.html': () => ({
    html: page(
      'E2E Upload',
      [
        '<h1>Upload</h1>',
        '<input id="f" type="file" aria-label="Attachment">',
        '<input id="fm" type="file" multiple aria-label="Attachments">',
        '<button id="later" type="button">Attach later</button>',
        '<script>',
        '  window.__clicks = 0;',
        '  window.__changes = 0;',
        "  document.querySelectorAll('input[type=file]').forEach(function (el) {",
        "    el.addEventListener('click', function () { window.__clicks++; });",
        "    el.addEventListener('change', function () { window.__changes++; });",
        '  });',
        "  document.getElementById('later').addEventListener('click', function () {",
        "    setTimeout(function () { document.getElementById('f').click(); }, 1500);",
        '  });',
        '</script>'
      ].join('\n')
    )
  }),
  '/print.html': () => ({
    html: page(
      'E2E Print',
      [
        '<h1>Print on load</h1>',
        '<script>',
        '  (function () {',
        "    var native = Function.prototype.toString.call(window.print).indexOf('[native code]') >= 0;",
        '    window.__native = native;',
        "    if (native) { document.title = 'NATIVE-PRINT'; return; }",
        '    window.print();',
        '    window.__printed = true;',
        '  })();',
        '</script>',
        '<iframe id="child" src="/print-child.html"></iframe>'
      ].join('\n')
    )
  }),
  '/print-child.html': () => ({
    html: page(
      'E2E Print Child',
      [
        '<p>child</p>',
        '<script>',
        '  (function () {',
        "    var native = Function.prototype.toString.call(window.print).indexOf('[native code]') >= 0;",
        "    parent.__child = native ? 'native' : 'override';",
        '    if (!native) window.print();',
        '  })();',
        '</script>'
      ].join('\n')
    )
  }),
  '/opener.html': () => ({
    html: page(
      'E2E Opener',
      '<h1>Opener</h1>\n<a id="pop" href="/autoprint.html" target="_blank">Open print version</a>'
    )
  }),
  '/autoprint.html': () => ({
    html: page(
      'E2E Autoprint',
      [
        '<h1>Print version</h1>',
        '<script>',
        '  (function () {',
        "    var native = Function.prototype.toString.call(window.print).indexOf('[native code]') >= 0;",
        "    fetch('/report?native=' + native);",
        '    if (!native) window.print();',
        '  })();',
        '</script>'
      ].join('\n')
    )
  }),
  '/select.html': () => ({
    html: page(
      'E2E Select',
      [
        '<h1>Select</h1>',
        '<select id="s" aria-label="Fruit"><option value="a">Apple</option><option value="b">Banana</option></select>',
        '<select id="m" multiple aria-label="Colors"><option value="r">Red</option><option value="g">Green</option></select>',
        '<input id="after" type="text" aria-label="After">',
        '<div id="host"></div>',
        "<iframe id=\"fr\" srcdoc=\"<select id='is' aria-label='Inner'><option value='x'>X</option><option value='y'>Y</option></select>",
        "<script>addEventListener('keydown', function (e) { parent.__keys.push('frame:' + e.key) }, true)</script>\"></iframe>",
        '<script>',
        '  window.__keys = [];',
        "  addEventListener('keydown', function (e) { window.__keys.push(e.key) }, true);",
        "  var root = document.getElementById('host').attachShadow({ mode: 'open' });",
        '  root.innerHTML = \'<select id="ss" aria-label="Shadow"><option value="p">P</option><option value="q">Q</option></select>\';',
        '</script>'
      ].join('\n')
    )
  })
}

export async function startFixtureServer(): Promise<FixtureServer> {
  const log: FixtureRequest[] = []
  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const path = req.url ?? '/'
    log.push({ method: req.method ?? 'GET', path })
    const pathname = path.split('?')[0]
    if (pathname === '/submit' || pathname === '/report') {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('ok')
      return
    }
    const def = PAGES[pathname]
    if (!def) {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('not found')
      return
    }
    const { headers, html } = def()
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...headers })
    res.end(html)
  }
  const server: Server = createServer(handle)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  // `localhost` 在 macOS 上先解析成 ::1：同一个端口在 IPv6 回环上也听一份。听不上（没有 IPv6、
  // 端口被占）就算了 —— Chromium 连 ::1 被拒后会回落到 127.0.0.1，只是慢一点
  const server6: Server = createServer(handle)
  const listening6 = await new Promise<boolean>((resolve) => {
    server6.once('error', () => resolve(false))
    server6.listen(port, '::1', () => resolve(true))
  })
  const origin = `http://127.0.0.1:${port}`
  const localhostOrigin = `http://localhost:${port}`
  const closeOne = (srv: Server): Promise<void> =>
    new Promise<void>((resolve) => {
      srv.closeAllConnections()
      srv.close(() => resolve())
    })
  return {
    origin,
    url: (path) => `${origin}${path}`,
    localhostOrigin,
    localhostUrl: (path) => `${localhostOrigin}${path}`,
    requests: () => [...log],
    hits: (prefix) => log.filter((r) => r.path.startsWith(prefix)).length,
    close: async () => {
      await Promise.all([closeOne(server), ...(listening6 ? [closeOne(server6)] : [])])
    }
  }
}

/**
 * 直接连上内置浏览器里某个 tab 的页面 target（DevTools 那条路，不经 agent 的工具）—— 读 tab 自己的
 * 视口（innerWidth）这类 agent 工具之外的事实。按页面地址认 tab；找不到回 null（配合 `until`）。
 * 调用方用完自己 close()。导航之后 target 可能换人，按新地址重连。
 */
export async function connectTabPage(
  port: number,
  match: (url: string) => boolean
): Promise<CdpClient | null> {
  const target = (await listTargets(port)).find((t) => t.type === 'page' && match(t.url))
  return target ? connect(target.webSocketDebuggerUrl) : null
}

/** 一个此刻没有任何进程在听的本机端口（开了马上关）—— 连接被拒的导航用 */
export async function closedPort(): Promise<number> {
  const srv = createServer()
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve))
  const port = (srv.address() as AddressInfo).port
  await new Promise<void>((resolve) => srv.close(() => resolve()))
  return port
}

export interface FileChooserNet {
  /** 这条会话收到过的 Page.fileChooserOpened 的 mode，按顺序 */
  opened(): string[]
  close(): void
}

/**
 * **保险**：在某个 tab 的页面 target 上另开一条 DevTools 会话，打开它自己的文件框拦截
 * （`Page.setInterceptFileChooserDialog`），一直开到 close。
 *
 * spec 要让页面打开文件框（点文件输入框）时先装上它：产品的防护万一失效，原生文件框也不会弹到开发者
 * 的屏幕上 —— 用例只会因为少了提示 / 少了日志而变红。两条会话都拦截时**两边都收到**
 * `Page.fileChooserOpened`、产品的判断照常，而只剩这一条拦截时文件框同样不弹（2026-09-23 用
 * Electron 39 的草稿探针实测过）。`opened()` 同时是「文件框真的打开了」的旁证，不依赖产品的回报。
 * 按页面地址认 tab；找不到或拦截没开成就抛错 —— 调用方此时绝不能去点文件输入框。
 */
export async function interceptFileChoosers(
  port: number,
  match: (url: string) => boolean
): Promise<FileChooserNet> {
  const target = await until(
    async () => (await listTargets(port)).find((t) => t.type === 'page' && match(t.url)),
    'tab page target for the file chooser safety net'
  )
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = () => reject(new Error(`file chooser net: connect failed ${target.url}`))
  })
  const modes: string[] = []
  const pending = new Map<number, (msg: { error?: unknown }) => void>()
  let nextId = 0
  ws.onmessage = (event) => {
    const msg = JSON.parse(String(event.data)) as {
      id?: number
      method?: string
      params?: { mode?: string }
      error?: unknown
    }
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)!(msg)
      pending.delete(msg.id)
    } else if (msg.method === 'Page.fileChooserOpened') {
      modes.push(String(msg.params?.mode))
    }
  }
  const send = (method: string, params: Record<string, unknown> = {}): Promise<void> =>
    new Promise((resolve, reject) => {
      const id = ++nextId
      pending.set(id, (msg) =>
        msg.error ? reject(new Error(`${method}: ${JSON.stringify(msg.error)}`)) : resolve()
      )
      ws.send(JSON.stringify({ id, method, params }))
    })
  try {
    await send('Page.enable')
    await send('Page.setInterceptFileChooserDialog', { enabled: true })
  } catch (err) {
    ws.close()
    throw err
  }
  return { opened: () => [...modes], close: () => ws.close() }
}

// ─── 脚本化运行 ─────────────────────────────────────────────────────────

/**
 * 一次脚本化的工具调用。`tool` 是浏览器工具的短名（`open_tab`）时自动补 `mcp__browser__`；
 * 其余名字原样发出（`read`、`mcp__ssh__exec`、退役的旧 `browser`）。
 */
export interface ScriptedCall {
  id: string
  tool: string
  args: Record<string, unknown>
}

/** 一次调用落定时的 `tool_end`（只声明断言会读的字段） */
export interface ToolEndEvent extends RecordedEvent {
  toolCallId: string
  toolName: string
  /** 广播给界面的结果文字（图片已换成占位） */
  result: string
  isError: boolean
  details?: Record<string, unknown>
}

/** 询问事件（`input_request`）里的请求 */
export interface AskRequest {
  id: string
  kind: string
  toolName: string
  command: string
  description?: string
  policyPrompt?: { text: string; policies: string[] } | null
}

export interface AskEvent extends RecordedEvent {
  request: AskRequest
}

/** 一次运行的产出：按 toolCallId 的 `tool_end`，以及这次运行开始时的事件序号 */
export interface RunOutcome {
  ends: Record<string, ToolEndEvent>
  since: number
}

const toolNameOf = (tool: string): string =>
  (BROWSER_TOOL_NAMES as readonly string[]).includes(tool) ? browserTool(tool) : tool

/**
 * 排一次 agent 运行：`turns` 的每个元素是一轮 LLM 调用（数组 = 这一轮里并发的几个调用），
 * 最后再排一轮收尾文字。用量写小数值，免得轮末触发自动压缩（见 fakeProvider 文件头）。
 */
export function scriptRun(
  provider: FakeProvider,
  turns: Array<ScriptedCall | ScriptedCall[]>,
  closing = 'done'
): void {
  const scripted: FakeTurn[] = turns.map((turn) => ({
    toolCalls: (Array.isArray(turn) ? turn : [turn]).map((c) => ({
      id: c.id,
      name: toolNameOf(c.tool),
      args: JSON.stringify(c.args)
    })),
    usage: { prompt: 90, completion: 6 }
  }))
  scripted.push({ text: closing, usage: { prompt: 110, completion: 4 } })
  provider.script(...scripted)
}

/** 经 IPC 发一条 prompt，**不等它跑完**（询问用例里整条链会停在等人应答上） */
export async function sendPrompt(main: CdpClient, sid: string, text: string): Promise<void> {
  await main.eval(
    `(() => {
      window.api.agent.prompt({ sessionId: ${JSON.stringify(sid)}, text: ${JSON.stringify(text)} })
        .catch(() => undefined)
      return true
    })()`
  )
}

export interface BrowserDriver {
  /** 排好脚本、发 prompt，回这次运行的起点序号（询问用例：随后 waitAsk / answer / finish） */
  start(sid: string, turns: Array<ScriptedCall | ScriptedCall[]>, prompt?: string): Promise<number>
  /** 等这次运行的 `agent_end`，回按 toolCallId 的 `tool_end` */
  finish(sid: string, since: number): Promise<RunOutcome>
  /** start + finish：一次不需要人应答的运行 */
  run(
    sid: string,
    turns: Array<ScriptedCall | ScriptedCall[]>,
    prompt?: string
  ): Promise<RunOutcome>
  /**
   * 等这次运行里**下一条还没取过的**询问 —— 一次运行里挂两张卡（导航被拒之后再走 cdp）时，
   * 连调两次拿到的是两张不同的卡。询问的 id 就是模型那边的 toolCallId，所以按 id 去重。
   */
  waitAsk(sid: string, since: number): Promise<AskRequest>
  /** 应答一条询问（`remember` = 「允许并记住」，只对路径询问有意义） */
  answer(sid: string, requestId: string, allowed: boolean, remember?: boolean): Promise<void>
  /** 起点之后这条会话的某类事件 */
  eventsSince<T extends RecordedEvent = RecordedEvent>(
    since: number,
    type: string,
    sid?: string
  ): Promise<T[]>
}

export function browserDriver(opts: {
  main: CdpClient
  provider: FakeProvider
  events: EventRecorder
}): BrowserDriver {
  const { main, provider, events } = opts
  /** waitAsk 已经交出去的询问 id */
  const taken = new Set<string>()
  const eventsSince = async <T extends RecordedEvent = RecordedEvent>(
    since: number,
    type: string,
    sid?: string
  ): Promise<T[]> =>
    (await events.allSince<T>(since)).filter(
      (e) => e.type === type && (sid === undefined || e.sessionId === sid)
    )
  const start = async (
    sid: string,
    turns: Array<ScriptedCall | ScriptedCall[]>,
    prompt = 'go'
  ): Promise<number> => {
    scriptRun(provider, turns)
    const since = await events.mark()
    await sendPrompt(main, sid, prompt)
    return since
  }
  const finish = async (sid: string, since: number): Promise<RunOutcome> => {
    await events.waitFor('agent_end', { sessionId: sid, since, timeoutMs: 60_000 })
    const ends: Record<string, ToolEndEvent> = {}
    for (const e of await eventsSince<ToolEndEvent>(since, 'tool_end', sid)) {
      ends[e.toolCallId] = e
    }
    return { ends, since }
  }
  return {
    start,
    finish,
    run: async (sid, turns, prompt) => finish(sid, await start(sid, turns, prompt)),
    waitAsk: async (sid, since) => {
      const ev = await until(
        async () =>
          (await eventsSince<AskEvent>(since, 'input_request', sid)).find(
            (e) => !taken.has(e.request.id)
          ),
        `next ask in session ${sid}`,
        30_000
      )
      taken.add(ev.request.id)
      return ev.request
    },
    answer: async (sid, requestId, allowed, remember = false) => {
      await main.eval(
        `window.api.agent.respondToInput(${JSON.stringify({
          sessionId: sid,
          requestId,
          response: {
            kind: 'ask',
            allowed,
            ...(remember ? { extra: { rememberPath: true } } : {})
          }
        })})`
      )
    },
    eventsSince
  }
}

/** `open_tab` 结果里的短号 tab id（`Opened <url> in new tab t3. …`） */
export function tabIdOf(result: string): string {
  const m = /in new tab (t\d+)/.exec(result)
  if (!m) throw new Error(`no tab id in open_tab result: ${result}`)
  return m[1]
}

/** 快照里某个可访问名字的元素 uid（行形如 `  - uid=e7 textbox "Name"`） */
export function uidOf(snapshot: string, role: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = new RegExp(`uid=(\\w+) ${role} "${escaped}"`).exec(snapshot)
  if (!m) throw new Error(`no ${role} "${name}" in snapshot:\n${snapshot}`)
  return m[1]
}
