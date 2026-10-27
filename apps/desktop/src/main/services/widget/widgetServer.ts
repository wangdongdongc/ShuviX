/**
 * WidgetServer — 所有 widget 共享的本地 HTTP 服务
 *
 * 路由：
 *   GET /w/<id>/              → host HTML
 *   GET /w/<id>/bundle.js     → 当前 widget 的 JS 打包产物
 *   GET /w/<id>/bundle.css
 *   GET /w/<id>/tailwind.js   → Tailwind browser runtime（共享）
 *   GET /w/<id>/sse           → Server-Sent Events，推送 reload 事件
 *   *   /w/<id>/db/<table>    → widget 数据库的 REST 接口（widgetDb.ts）
 *   GET /w/<id>/fs/file|list  → 读本机文件 / 列目录（widgetFiles.ts，路由表见 shared/widgetRoutes.ts）
 *   POST /w/<id>/api/<op>     → 组件自己的 API（api/widgetApi.ts；只有 SQLite 组件有，调用方是用户）
 *
 * SQLite 组件没有 `/db/`（读写都走 API，见 docs/widget-tool-design.md D10）；`/sse` 除了 `reload` 还推 `data`
 * （任何一次提交了写的 API 调用之后，不管调用方是界面还是 agent）。
 *
 * 门（每个请求都过）：
 *   - **Host** 必须是 `127.0.0.1:<端口>` 或 `localhost:<端口>`，否则 421 —— 挡 DNS 重绑定（恶意网页把自己的域名
 *     解析到 127.0.0.1，就和这里同源了）。网络服务转发时已经把 Host 换成 127.0.0.1:<端口>（widgetProxy.ts）。
 *   - **`fs/` 的应答不带 `Access-Control-Allow-Origin`**：别的路由沿用 `*`（数据库接口一直如此，已知遗留），
 *     但文件路由不限路径，带上 `*` 就是让用户浏览器里任何网页都能读走本机文件。桌面里 widget 是同源请求，
 *     用不着它；远程模式下 widget 是沙箱里的不透明源，由 widgetProxy 在转发时补上（那一面本来就不认证）。
 *   - **`/w/<id>/` 下的一切要这个 widget 的令牌**（widgetToken.ts，请求头 `x-shuvix-widget-token`）：没有、签名
 *     不对、是别的 widget 的 → 403；`cli` 范围的令牌用不了 `fs/`。前两道挡网页，挡不住本机进程 —— 沙箱里的命令
 *     能直接 `curl` 这里。令牌由宿主补在请求头上（主进程给 widget 页面、网络服务的转发、CLI 交给命令），不进 URL，
 *     widget 代码不用改。预检（OPTIONS）不要令牌：它什么也不返回。
 *
 * 懒启动：首次 registerWidget / rebuild 触发 server 监听
 * 打包复用 esbuild 插件的 BundlerService（共享预置的 React/Router 依赖）
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http'
import { resolve } from 'path'
import { readFileSync } from 'fs'
import { bundlerService, bundlerResourcePath } from '../bundler'
import { createLogger } from '../../logger'
import { handleRestRequest, WidgetDbError, type RestMethod, type RestRequest } from './widgetDb'
import { serveWidgetFiles } from './widgetFiles'
import { WIDGET_TOKEN_HEADER, widgetTokenScope } from './widgetToken'
import {
  callWidgetOp,
  onWidgetDataChanged,
  WidgetApiError,
  widgetStorageOf,
  type WidgetDataChange
} from './api/widgetApi'
import {
  isWidgetFilesPath,
  WIDGET_FILES_SEGMENT,
  WIDGET_LIST_ROUTE
} from '../../../shared/widgetRoutes'

const log = createLogger('WidgetServer')

interface WidgetEntry {
  id: string
  projectDir: string
  entryFile: string
  latestJS: string
  latestCSS: string
  buildSuccess: boolean
  buildErrors: string[]
  sseClients: Set<ServerResponse>
  isBuilding: boolean
}

function hostHTML(baseHref: string, title: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="light dark" />
  <base href="${baseHref}" />
  <title>${title}</title>
  <script src="tailwind.js"></script>
  <link rel="stylesheet" href="bundle.css" />
  <style>
    :root { color-scheme: light dark; }
    html, body, #root { height: 100%; margin: 0; }
    /* 基础底色：浅色模式纯白，深色模式与 ShuviX github-dark 接近 */
    body { background: #ffffff; color: #0f172a; font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", "PingFang SC", "Hiragino Sans", sans-serif; }
    @media (prefers-color-scheme: dark) {
      body { background: #0d1117; color: #e6edf3; }
    }
  </style>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="bundle.js"></script>
  <script>
    const es = new EventSource('sse');
    es.addEventListener('reload', () => location.reload());
    es.onerror = () => setTimeout(() => location.reload(), 1500);
    window.onerror = function(msg, _src, _line, _col, err) {
      document.getElementById('root').innerHTML =
        '<pre style="color:#f38ba8;background:#1e1e2e;padding:2rem;margin:0;height:100%;font-size:13px;overflow:auto;">' +
        '<b>Runtime Error</b>\\n\\n' + (err ? err.stack : msg) + '</pre>';
    };
    window.addEventListener('unhandledrejection', function(e) {
      document.getElementById('root').innerHTML =
        '<pre style="color:#f38ba8;background:#1e1e2e;padding:2rem;margin:0;height:100%;font-size:13px;overflow:auto;">' +
        '<b>Unhandled Promise Rejection</b>\\n\\n' + (e.reason?.stack || e.reason) + '</pre>';
    });
    // Mount watchdog — ShuviX dev host only, not part of widget bundle.
    // If bundle loaded but #root is still empty after 300ms, surface a clear
    // diagnostic instead of leaving a blank page.
    setTimeout(function() {
      var r = document.getElementById('root');
      if (!r || r.childElementCount > 0) return;
      r.innerHTML =
        '<pre style="color:#f9e2af;background:#1e1e2e;padding:2rem;margin:0;height:100%;font-size:13px;line-height:1.6;overflow:auto;">' +
        '<b style="color:#fab387;">Widget did not mount anything to #root.</b>\\n\\n' +
        'The bundle loaded but nothing was rendered. This usually means\\n' +
        '<code>index.tsx</code> is missing the mount call:\\n\\n' +
        '  <span style="color:#a6e3a1;">import { createRoot } from \\'react-dom/client\\'</span>\\n' +
        '  <span style="color:#a6e3a1;">const root = document.getElementById(\\'root\\')</span>\\n' +
        '  <span style="color:#a6e3a1;">if (root) createRoot(root).render(&lt;YourComponent /&gt;)</span>\\n\\n' +
        'Add it at the bottom of <code>index.tsx</code> and rebuild.' +
        '</pre>';
    }, 300);
  </script>
</body>
</html>`
}

function errorOverlayHTML(errors: string[]): string {
  const escaped = errors.map((e) => e.replace(/&/g, '&amp;').replace(/</g, '&lt;')).join('\n\n')
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8" /></head>
<body style="margin:0;background:#1e1e2e;color:#f38ba8;font-family:monospace;padding:2rem;">
<h2 style="color:#cdd6f4;margin-top:0;">Build Error</h2>
<pre style="white-space:pre-wrap;font-size:13px;line-height:1.6;">${escaped}</pre>
<script>
  const es = new EventSource('sse');
  es.addEventListener('reload', () => location.reload());
</script>
</body></html>`
}

export class WidgetServer {
  private server: Server | null = null
  private port = 0
  private startPromise: Promise<void> | null = null
  private readonly entries = new Map<string, WidgetEntry>()
  private tailwindCache: string | null = null

  /** 首次使用时惰性启动 */
  ensureStarted(): Promise<void> {
    if (this.server) return Promise.resolve()
    if (this.startPromise) return this.startPromise
    this.startPromise = new Promise<void>((resolveStart, rejectStart) => {
      const server = createServer((req, res) => this.handleRequest(req, res))
      server.on('error', rejectStart)
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()
        if (!addr || typeof addr === 'string') {
          rejectStart(new Error('Failed to obtain widget server address'))
          return
        }
        this.server = server
        this.port = addr.port
        log.info(`Widget server listening at http://127.0.0.1:${this.port}`)
        resolveStart()
      })
    })
    return this.startPromise
  }

  /** 构建状态：由调用方（widgetService）获知成功与否后决定是否返回 URL */
  async registerAndBuild(
    id: string,
    projectDir: string,
    entryFile: string
  ): Promise<{ success: boolean; errors?: string[] }> {
    await this.ensureStarted()
    let entry = this.entries.get(id)
    if (!entry) {
      entry = {
        id,
        projectDir,
        entryFile,
        latestJS: '',
        latestCSS: '',
        buildSuccess: false,
        buildErrors: [],
        sseClients: new Set(),
        isBuilding: false
      }
      this.entries.set(id, entry)
    } else {
      // 路径可能更新（未来支持重命名）
      entry.projectDir = projectDir
      entry.entryFile = entryFile
    }
    return this.runBuild(entry)
  }

  /** 重新打包已注册的 widget；未注册则抛错 */
  async rebuild(id: string): Promise<{ success: boolean; errors?: string[] }> {
    const entry = this.entries.get(id)
    if (!entry) {
      return { success: false, errors: [`Widget ${id} not registered, call init first`] }
    }
    return this.runBuild(entry)
  }

  private async runBuild(entry: WidgetEntry): Promise<{ success: boolean; errors?: string[] }> {
    if (entry.isBuilding) {
      return { success: false, errors: ['Build already in progress for this widget'] }
    }
    entry.isBuilding = true
    try {
      const entryPath = resolve(entry.projectDir, entry.entryFile)
      const result = await bundlerService.build(entryPath, entry.projectDir)
      entry.buildSuccess = result.success
      entry.buildErrors = result.errors ?? []
      if (result.success) {
        entry.latestJS = result.outputJS ?? ''
        entry.latestCSS = result.outputCSS ?? ''
      }
      this.notifyReload(entry)
      return { success: result.success, errors: result.errors }
    } finally {
      entry.isBuilding = false
    }
  }

  unregisterWidget(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    for (const c of entry.sseClients) c.end()
    this.entries.delete(id)
  }

  hasWidget(id: string): boolean {
    return this.entries.has(id)
  }

  /** 上一次构建的错误（空 = 成功）；没注册 → undefined */
  lastBuildErrors(id: string): readonly string[] | undefined {
    return this.entries.get(id)?.buildErrors
  }

  /** 构建 URL（server 未启动则返回 null） */
  getUrl(id: string): string | null {
    if (!this.server) return null
    return `http://127.0.0.1:${this.port}/w/${id}/`
  }

  /** 当前服务器运行状态（供 UI 展示） */
  getStatus(): {
    running: boolean
    port: number
    widgetCount: number
    registeredIds: string[]
  } {
    return {
      running: this.server !== null,
      port: this.port,
      widgetCount: this.entries.size,
      registeredIds: Array.from(this.entries.keys())
    }
  }

  /** 手动停止服务器（下一次 open/init 会自动重启） */
  stop(): void {
    this.dispose()
  }

  dispose(): void {
    for (const entry of this.entries.values()) {
      for (const c of entry.sseClients) c.end()
    }
    this.entries.clear()
    if (this.server) {
      this.server.close()
      this.server = null
      this.port = 0
    }
    // 重置启动 Promise，下一次 ensureStarted 会重新监听端口
    this.startPromise = null
  }

  // ────── 私有 ──────

  private getTailwindContent(): string {
    if (this.tailwindCache) return this.tailwindCache
    const p = bundlerResourcePath('deps/tailwindcss-browser.js')
    this.tailwindCache = readFileSync(p, 'utf-8')
    return this.tailwindCache
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    if (!isOwnHost(req.headers.host, this.port)) {
      res.writeHead(421, { 'Content-Type': 'text/plain', Connection: 'close' })
      res.end('Misdirected request')
      return
    }
    const url = req.url ?? '/'
    // /w/<id>/<rest> —— 注意 rest 可能带 ?query，先剥离 query string
    const pathOnly = url.split('?')[0]

    // 文件路由不带 CORS 头（见文件头），也就没有预检：OPTIONS 落到 serveWidgetFiles 回 405
    if (!isWidgetFilesPath(pathOnly)) {
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

      if (req.method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
      }
    }

    const match = pathOnly.match(/^\/w\/([a-z0-9]+(?:-[a-z0-9]+)+)(\/.*)?$/)
    if (!match) {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('Not found')
      return
    }
    const widgetId = match[1]
    const rest = match[2] ?? '/'

    // 这个 widget 的令牌（见 widgetToken.ts）：先于「注册了没有」—— 不带令牌的人连哪些 widget 在都问不出来
    const scope = widgetTokenScope(req.headers[WIDGET_TOKEN_HEADER], widgetId)
    if (!scope || (scope === 'cli' && rest.startsWith(WIDGET_FILES_SEGMENT))) {
      this.refuse(res, rest, scope === 'cli')
      return
    }

    const entry = this.entries.get(widgetId)
    if (!entry) {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end(`Widget ${widgetId} not registered`)
      return
    }

    // /api/<op> —— 组件自己的 API（调用方是用户）
    if (rest.startsWith('/api/')) {
      const op = rest.slice(5)
      this.handleApiRequest(req, res, widgetId, op, scope).catch((err) => {
        log.warn(`unhandled api error widget=${widgetId} op=${op}:`, err)
        if (!res.headersSent) {
          this.respondJson(res, 500, {
            error: { code: 'internal', message: (err as Error).message ?? String(err) }
          })
        }
      })
      return
    }

    // /db/<table> —— widget DB REST API（只有老组件有：SQLite 组件的读写都走 API）
    if (rest.startsWith('/db/') && widgetStorageOf(widgetId) === 'sqlite') {
      this.respondJson(res, 404, {
        code: 'NO_DB_ROUTE',
        message: `This widget keeps its data in SQLite and has no /db route; call its API at /w/${widgetId}/api/<operation>.`
      })
      return
    }
    if (rest.startsWith('/db/')) {
      const table = rest.slice(4)
      this.handleDbRequest(req, res, widgetId, table, url).catch((err) => {
        log.warn(`unhandled db error widget=${widgetId} table=${table}:`, err)
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(
            JSON.stringify({ code: 'INTERNAL', message: (err as Error).message ?? String(err) })
          )
        }
      })
      return
    }

    // /fs/file、/fs/list —— 读本机文件（令牌在上面验过，`cli` 范围到不了这里）
    if (rest.startsWith(WIDGET_FILES_SEGMENT)) {
      const qsIdx = url.indexOf('?')
      const search = new URLSearchParams(qsIdx === -1 ? '' : url.slice(qsIdx + 1))
      serveWidgetFiles(rest, req, res, search).catch((err) => {
        log.warn(`unhandled fs error widget=${widgetId} route=${rest}:`, err)
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain' })
          res.end('Internal error')
        } else {
          res.destroy()
        }
      })
      return
    }

    if (rest === '/sse') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      })
      res.write(':\n\n')
      entry.sseClients.add(res)
      req.on('close', () => entry.sseClients.delete(res))
      return
    }

    if (rest === '/tailwind.js') {
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'public, max-age=31536000, immutable'
      })
      res.end(this.getTailwindContent())
      return
    }

    if (rest === '/bundle.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' })
      res.end(entry.latestJS)
      return
    }

    if (rest === '/bundle.css') {
      res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' })
      res.end(entry.latestCSS)
      return
    }

    // 默认：入口 HTML
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    if (!entry.buildSuccess) {
      res.end(
        errorOverlayHTML(
          entry.buildErrors.length > 0
            ? entry.buildErrors
            : ['Build failed. Check build output or call widget.build again.']
        )
      )
      return
    }
    res.end(hostHTML(`/w/${widgetId}/`, widgetId))
  }

  private notifyReload(entry: WidgetEntry): void {
    for (const c of entry.sseClients) {
      c.write('event: reload\ndata: ok\n\n')
    }
  }

  /** 一次提交了写的 API 调用之后：告诉这个组件所有开着的界面重新取数 */
  notifyData(change: WidgetDataChange): void {
    const entry = this.entries.get(change.widgetId)
    if (!entry) return
    const payload = JSON.stringify({ op: change.op, source: change.source })
    for (const c of entry.sseClients) {
      c.write(`event: data\ndata: ${payload}\n\n`)
    }
  }

  // ────── widget API ──────

  private async handleApiRequest(
    req: IncomingMessage,
    res: ServerResponse,
    widgetId: string,
    op: string,
    scope: 'ui' | 'cli'
  ): Promise<void> {
    if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
      this.respondJson(res, 405, {
        error: { code: 'method_not_allowed', message: 'Call a widget operation with POST.' }
      })
      return
    }
    let args: unknown
    try {
      args = await readJsonBody(req)
    } catch (e) {
      this.respondJson(res, 400, { error: { code: 'invalid_json', message: (e as Error).message } })
      return
    }
    try {
      // `ui` 令牌只在组件自己的页面上（调用方是用户）；`cli` 令牌在 agent 的 shell 里（curl 测试时）
      const caller =
        scope === 'cli'
          ? ({ kind: 'agent', actor: 'cli', label: 'cli' } as const)
          : ({ kind: 'user', label: 'user' } as const)
      const { result } = await callWidgetOp(widgetId, op, args ?? {}, caller)
      if (result.outcome.ok) {
        this.respondJson(res, 200, { result: result.outcome.value })
      } else {
        this.respondJson(res, apiErrorStatus(result.outcome.error.code), {
          error: result.outcome.error
        })
      }
    } catch (e) {
      if (e instanceof WidgetApiError) {
        this.respondJson(res, apiErrorStatus(e.code), {
          error: { code: e.code, message: e.message }
        })
        return
      }
      throw e
    }
  }

  // ────── widget DB REST API ──────

  private async handleDbRequest(
    req: IncomingMessage,
    res: ServerResponse,
    widgetId: string,
    table: string,
    fullUrl: string
  ): Promise<void> {
    const method = (req.method ?? 'GET').toUpperCase()
    if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(method)) {
      this.respondJson(res, 405, {
        code: 'METHOD_NOT_ALLOWED',
        message: `Method ${method} not allowed`
      })
      return
    }
    if (!table) {
      this.respondJson(res, 400, { code: 'NO_TABLE', message: 'Table name is required' })
      return
    }

    const qsIdx = fullUrl.indexOf('?')
    const searchParams = new URLSearchParams(qsIdx === -1 ? '' : fullUrl.slice(qsIdx + 1))

    let body: unknown = undefined
    if (method === 'POST' || method === 'PATCH') {
      try {
        body = await readJsonBody(req)
      } catch (e) {
        this.respondJson(res, 400, {
          code: 'INVALID_JSON',
          message: (e as Error).message
        })
        return
      }
    }

    const restReq: RestRequest = {
      widgetId,
      table,
      method: method as RestMethod,
      searchParams,
      body
    }

    try {
      const result = await handleRestRequest(restReq)
      this.respondJson(res, 200, result.rows)
    } catch (e) {
      if (e instanceof WidgetDbError) {
        this.respondJson(res, e.status, { code: e.code, message: e.message })
        return
      }
      const msg = (e as Error).message ?? String(e)
      log.warn(`db request failed widget=${widgetId} table=${table}: ${msg}`)
      this.respondJson(res, 500, { code: 'INTERNAL', message: msg })
    }
  }

  /**
   * 令牌不对的 403：`db/` 与 `fs/list` 回 JSON `{ code, message }`（与它们别的错误同形，widget 照样 `res.json()`），
   * 其余回纯文本。话写给在 shell 里 curl 的智能体看：令牌从哪来、带在哪
   */
  private refuse(res: ServerResponse, rest: string, cliOnFiles: boolean): void {
    const message = cliOnFiles
      ? 'The token from `shuvix widget build` cannot read files; fs/ works only inside the widget.'
      : `This widget route needs the widget's token in the ${WIDGET_TOKEN_HEADER} header. Open the widget in ShuviX, or pass the token that \`shuvix widget build\` returned.`
    if (rest.startsWith('/db/') || rest.startsWith('/api/') || rest === WIDGET_LIST_ROUTE) {
      this.respondJson(res, 403, { code: 'FORBIDDEN', message })
      return
    }
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end(message)
  }

  private respondJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }
}

/** API 调用失败的 HTTP 状态：参数 / 操作不对是 4xx，宿主出事是 5xx，handler 自己的 ctx.fail 是 422 */
function apiErrorStatus(code: string): number {
  switch (code) {
    case 'invalid_args':
      return 400
    case 'unknown_op':
    case 'no_api':
      return 404
    case 'timeout':
      return 504
    case 'interrupted':
    case 'host_exited':
    case 'host_unavailable':
    case 'host_stopped':
      return 503
    case 'internal':
    case 'bad_output':
    case 'too_large':
    case 'out_of_memory':
      return 500
    default:
      return 422
  }
}

/** `Host` 头是不是这台 widget 服务自己的（`127.0.0.1:<端口>` / `localhost:<端口>`，不分大小写） */
function isOwnHost(host: string | undefined, port: number): boolean {
  if (!host || port <= 0) return false
  const value = host.toLowerCase()
  return value === `127.0.0.1:${port}` || value === `localhost:${port}`
}

/** 收完请求体并解析为 JSON。空 body 视为 undefined。 */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const MAX_BYTES = 4 * 1024 * 1024 // 4MB
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer)
    total += buf.length
    if (total > MAX_BYTES) {
      throw new Error(`Request body too large (> ${MAX_BYTES} bytes)`)
    }
    chunks.push(buf)
  }
  const text = Buffer.concat(chunks).toString('utf-8').trim()
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch (e) {
    throw new Error(`Invalid JSON: ${(e as Error).message}`)
  }
}

export const widgetServer = new WidgetServer()

onWidgetDataChanged((change) => widgetServer.notifyData(change))
