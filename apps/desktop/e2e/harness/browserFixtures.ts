/**
 * 内置浏览器（`mcp:browser` 能力服务器）e2e 的共用夹具 —— 两样东西：
 *
 *  1. **夹具网站**：spec 进程里起一台 `127.0.0.1:0` 的 HTTP 服务，记下每一个请求。浏览器面板
 *     打开的就是它 —— 「点击真的发生了」「被拒的地址一次都没请求过」都按服务器这一侧的记录断，
 *     不信工具自己的回报。**只用 http**：https 证书不受信时（且没开「忽略证书错误」）主进程会
 *     弹 `dialog.showMessageBox`，CDP 关不掉它，整条 spec 会挂死。
 *  2. **脚本化运行**：把一串 `mcp__browser__*` 调用排进假提供商（每个元素一轮 LLM 调用），
 *     经 IPC 发一条 prompt，等 `agent_end`，按 toolCallId 取回每个调用的 `tool_end`。
 *     元素 id（uid）要从上一步快照的结果里读，所以「打开 → 快照 → 点击」是三次运行，不是一次。
 *
 * 两条会让 spec 挂死的坑，写在这里免得再踩：
 *   - 永远别 `click` 一个 file input —— 那会弹原生文件选择框；上传走 `upload_file`；
 *   - 点击与截图时右侧面板要开着：藏起来的 WebContentsView 没有尺寸，点击的「最上层元素」核对
 *     会落空（见 cdpOps.clickOp）。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { until, type CdpClient } from './cdp'
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
  '/deny.html': () => ({ html: page('Deny', '<h1>Deny page</h1>') })
}

export async function startFixtureServer(): Promise<FixtureServer> {
  const log: FixtureRequest[] = []
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = req.url ?? '/'
    log.push({ method: req.method ?? 'GET', path })
    const pathname = path.split('?')[0]
    if (pathname === '/submit') {
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
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    origin,
    url: (path) => `${origin}${path}`,
    requests: () => [...log],
    hits: (prefix) => log.filter((r) => r.path.startsWith(prefix)).length,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
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
