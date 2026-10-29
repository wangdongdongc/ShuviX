/**
 * WidgetServer — 所有 widget 共享的本地 HTTP 服务
 *
 * 路由：
 *   GET /w/<id>/              → host HTML
 *   GET /w/<id>/bundle.js     → 当前 widget 的 JS 打包产物
 *   GET /w/<id>/bundle.css
 *   GET /w/<id>/tailwind.js   → Tailwind browser runtime（共享）
 *   GET /w/<id>/theme.css     → 主题令牌（应用的 themes.css，见 widgetTheme.ts）
 *   GET /w/<id>/sse           → Server-Sent Events，推送 reload / data / theme 事件
 *   *   /w/<id>/db/<table>    → widget 数据库的 REST 接口（widgetDb.ts）
 *   GET /w/<id>/fs/file|list  → 读本机文件 / 列目录（widgetFiles.ts，路由表见 shared/widgetRoutes.ts）
 *   POST /w/<id>/api/<op>     → 组件自己的 API（api/widgetApi.ts；只有 SQLite 组件有，调用方是用户）
 *
 * SQLite 组件没有 `/db/`（读写都走 API，见 docs/widget-tool-design.md D10）；`/sse` 除了 `reload` 还推 `data`
 * （任何一次提交了写的 API 调用之后，不管调用方是界面还是 agent）和 `theme`（连上时一次，之后主题设置每变一次；
 * 页面骨架据此换 `data-theme`，见 widgetTheme.ts）。
 *
 * 门（每个请求都过）：
 *   - **Host** 必须是 `127.0.0.1:<端口>` 或 `localhost:<端口>`，否则 421 —— 挡 DNS 重绑定（恶意网页把自己的域名
 *     解析到 127.0.0.1，就和这里同源了）。网络服务转发时已经把 Host 换成 127.0.0.1:<端口>（widgetProxy.ts）。
 *   - **`fs/` 的应答不带 `Access-Control-Allow-Origin`**：别的路由沿用 `*`（数据库接口一直如此，已知遗留），
 *     但文件路由不限路径，带上 `*` 就是让用户浏览器里任何网页都能读走本机文件。桌面里 widget 是同源请求，
 *     用不着它；远程模式下 widget 是沙箱里的不透明源，由 widgetProxy 在转发时补上（那一面本来就不认证）。
 *   - **`/w/<id>/` 下的一切要这个 widget 的令牌**（widgetToken.ts，请求头 `x-shuvix-widget-token`）：没有、签名
 *     不对、是别的 widget 的 → 403。前两道挡网页，挡不住本机进程 —— 沙箱里的命令能直接 `curl` 这里。令牌由宿主
 *     补在请求头上（主进程给 widget 页面、网络服务的转发），不进 URL，widget 代码不用改。预检（OPTIONS）不要令牌。
 *   - **`preview` 令牌**（`widget` 工具的预览窗口）：页面在替发起预览的那条会话干活 —— `api/`、`db/` 按那条会话对
 *     这个组件的授权判，`fs/` 按它的权限表判读（只判不问，判定由宿主注入：setWidgetPreviewJudge；没注入 = 一律
 *     拒绝）。从前预览带 `ui` 令牌，改过界面再预览就能以用户身份写数据、读家目录的任何文件。
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
import { resolveWidgetFilePath, serveWidgetFiles } from './widgetFiles'
import { verifyWidgetToken, WIDGET_TOKEN_HEADER, type WidgetTokenClaims } from './widgetToken'
import {
  currentWidgetTheme,
  parseWidgetScheme,
  themeBootScript,
  widgetThemeCss,
  WIDGET_SCHEME_PARAM,
  WIDGET_TAILWIND_THEME,
  WIDGET_THEME_SETTING_KEYS,
  type WidgetScheme
} from './widgetTheme'
import { appEventBus } from '../../utils/appEventBus'
import {
  callWidgetOp,
  onWidgetDataChanged,
  readApiSnapshot,
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

/**
 * 预览页面的请求按发起预览的那条会话判（只判不问 —— 预览窗口没有人看着，弹不出询问）。宿主启动时注入
 * （main/index.ts：桌面安全模块的 judgeGate），本模块不反向依赖工具层
 */
export interface WidgetPreviewJudge {
  /** 这条会话能不能免询问地以 `access` 用这个组件（`operation` = 操作名或路由，只为记录） */
  widget(sessionId: string, access: 'read' | 'write', widgetId: string, operation: string): boolean
  /** 这条会话能不能免询问地读这个文件 */
  readPath(sessionId: string, path: string): boolean
}

let previewJudge: WidgetPreviewJudge | null = null

/** 注入预览请求的判定（main/index.ts）；null = 预览页面的 api / db / fs 一律拒绝 */
export function setWidgetPreviewJudge(judge: WidgetPreviewJudge | null): void {
  previewJudge = judge
}

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

/**
 * 页面骨架。主题脚本排在最前（首帧之前设好 `data-theme`），令牌在 Tailwind 运行时之前，语义色名紧跟运行时；
 * 底色与字色取主题令牌。`color-scheme` 由主题块给（meta 里的 `light dark` 只管 theme.css 到之前的那一帧）。
 * `forced` = 预览强制的明暗（URL 上的 shuvix-scheme）。
 */
function hostHTML(baseHref: string, title: string, forced: WidgetScheme | null): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="light dark" />
  <script>${themeBootScript(currentWidgetTheme(), forced)}</script>
  <base href="${baseHref}" />
  <title>${title}</title>
  <link rel="stylesheet" href="theme.css" />
  <script src="tailwind.js"></script>
  <style type="text/tailwindcss">
${WIDGET_TAILWIND_THEME}  </style>
  <link rel="stylesheet" href="bundle.css" />
  <style>
    html, body, #root { height: 100%; margin: 0; }
    body { background: var(--theme-bg-primary); color: var(--theme-text-primary); font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", "PingFang SC", "Hiragino Sans", sans-serif; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="bundle.js"></script>
  <script>
    const es = new EventSource('sse');
    // 界面的 API 客户端（shuvix/widget）收 data 事件也用这一条：所有组件共用一个主机，浏览器对它只开 6 条连接
    window.__shuvixEvents = es;
    es.addEventListener('reload', () => location.reload());
    // 主题设置变了（连上时也先来一次）：就地换 data-theme，不重载
    es.addEventListener('theme', (e) => {
      try { window.__shuvixSetTheme(JSON.parse(e.data)); } catch (_) {}
    });
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

/** SSE `theme` 事件：此刻的主题选择 */
function themeEvent(): string {
  return `event: theme\ndata: ${JSON.stringify(currentWidgetTheme())}\n\n`
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
  /** 主题设置的订阅（服务器在跑时才有；dispose 退订） */
  private offSettings: (() => void) | null = null

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
        this.offSettings ??= appEventBus.subscribe((event) => {
          if (event.type !== 'settings.changed') return
          // 没指明哪些键 = 消费者全量重取：也推一次（页面只在主题真变了时才动）
          if (!event.keys || event.keys.some((k) => WIDGET_THEME_SETTING_KEYS.includes(k))) {
            this.notifyTheme()
          }
        })
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
    this.offSettings?.()
    this.offSettings = null
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
    const claims = verifyWidgetToken(req.headers[WIDGET_TOKEN_HEADER], widgetId)
    if (!claims) {
      this.refuse(res, rest)
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
      this.handleApiRequest(req, res, widgetId, op, claims).catch((err) => {
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
      // 预览页面写老组件的表要那条会话的读写授权，读要只读授权
      const method = (req.method ?? 'GET').toUpperCase()
      const access = method === 'GET' ? 'read' : 'write'
      if (!this.previewAllowsWidget(claims, access, widgetId, `db/${table}`)) {
        this.refusePreview(
          res,
          rest,
          `This preview's session may not ${access === 'read' ? 'read' : 'change'} this widget's data.`
        )
        return
      }
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

    // /fs/file、/fs/list —— 读本机文件（令牌在上面验过；预览页面按发起预览的会话的权限表判）
    if (rest.startsWith(WIDGET_FILES_SEGMENT)) {
      const qsIdx = url.indexOf('?')
      const search = new URLSearchParams(qsIdx === -1 ? '' : url.slice(qsIdx + 1))
      if (claims.scope === 'preview') {
        const path = resolveWidgetFilePath(search.get('path'))
        const allowed =
          !!path && !!claims.sessionId && !!previewJudge?.readPath(claims.sessionId, path)
        if (!allowed && path) {
          this.refusePreview(
            res,
            rest,
            `This preview's session may not read ${path} without asking.`
          )
          return
        }
      }
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
      // 页面骨架送出之后、这条连上之前主题可能变过：连上就先对一次
      res.write(themeEvent())
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

    if (rest === '/theme.css') {
      res.writeHead(200, {
        'Content-Type': 'text/css; charset=utf-8',
        // 远程浏览器经网络服务转发时地址跨重启不变：应用升级换了主题令牌，不能被一年的缓存挡住
        'Cache-Control': 'no-cache'
      })
      res.end(widgetThemeCss())
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
    const qsIdx = url.indexOf('?')
    const forced = parseWidgetScheme(
      new URLSearchParams(qsIdx === -1 ? '' : url.slice(qsIdx + 1)).get(WIDGET_SCHEME_PARAM)
    )
    res.end(hostHTML(`/w/${widgetId}/`, widgetId, forced))
  }

  /** 主题设置变了：告诉所有组件开着的页面 */
  notifyTheme(): void {
    const event = themeEvent()
    for (const entry of this.entries.values()) {
      for (const c of entry.sseClients) c.write(event)
    }
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

  /** `preview` 令牌：那条会话能不能免询问地这样用这个组件。`ui` 令牌恒为真（调用方是用户） */
  private previewAllowsWidget(
    claims: WidgetTokenClaims,
    access: 'read' | 'write',
    widgetId: string,
    operation: string
  ): boolean {
    if (claims.scope === 'ui') return true
    return (
      !!claims.sessionId && !!previewJudge?.widget(claims.sessionId, access, widgetId, operation)
    )
  }

  private async handleApiRequest(
    req: IncomingMessage,
    res: ServerResponse,
    widgetId: string,
    op: string,
    claims: WidgetTokenClaims
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
    // 预览页面：调用方是发起预览的那条会话的 agent，按它对这个组件的授权判（操作认不得的交给 callWidgetOp 报）
    let expectedMode: 'read' | 'write' | undefined
    if (claims.scope === 'preview') {
      const entry = readApiSnapshot(widgetId)?.ops.find((o) => o.name === op)
      expectedMode = entry?.mode
      if (entry && !this.previewAllowsWidget(claims, entry.mode, widgetId, op)) {
        this.respondJson(res, 403, {
          error: {
            code: 'not_authorized',
            message: `This preview's session may not call ${entry.mode} operations of this widget without asking.`
          }
        })
        return
      }
    }
    try {
      // `ui` 令牌只在组件自己的页面上（调用方是用户）；`preview` 令牌是替那条会话的 agent 渲染的页面。两者都是组件
      // 自己的界面在调，所以纯界面的操作（`agent: false`）照样调得到
      const caller =
        claims.scope === 'preview'
          ? ({
              kind: 'agent',
              ...(claims.sessionId ? { sessionId: claims.sessionId } : {}),
              actor: 'preview',
              label: 'preview'
            } as const)
          : ({ kind: 'user', label: 'user' } as const)
      // 预览页面按这次读到的读 / 写判的授权：其间重新构建改了它，分发器拒绝（changed）
      const { result } = await callWidgetOp(widgetId, op, args ?? {}, caller, {
        allowUiOnly: true,
        ...(expectedMode ? { expectedMode } : {})
      })
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
   * 令牌不对的 403：`db/`、`api/` 与 `fs/list` 回 JSON `{ code, message }`（与它们别的错误同形，widget 照样
   * `res.json()`），其余回纯文本
   */
  private refuse(res: ServerResponse, rest: string): void {
    this.refusePreview(
      res,
      rest,
      `This widget route needs the widget's token in the ${WIDGET_TOKEN_HEADER} header; open the widget in ShuviX.`
    )
  }

  /** 403，形状同 refuse（预览页面越过了那条会话的授权也用它） */
  private refusePreview(res: ServerResponse, rest: string, message: string): void {
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
    case 'changed':
      return 409
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
