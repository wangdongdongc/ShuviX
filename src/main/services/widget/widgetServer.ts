/**
 * WidgetServer — 所有 widget 共享的本地 HTTP 服务
 *
 * 路由：
 *   GET /w/<id>/              → host HTML
 *   GET /w/<id>/bundle.js     → 当前 widget 的 JS 打包产物
 *   GET /w/<id>/bundle.css
 *   GET /w/<id>/tailwind.js   → Tailwind browser runtime（共享）
 *   GET /w/<id>/sse           → Server-Sent Events，推送 reload 事件
 *
 * 懒启动：首次 registerWidget / rebuild 触发 server 监听
 * 打包复用 esbuild 插件的 BundlerService（共享预置的 React/Router 依赖）
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http'
import { resolve } from 'path'
import { readFileSync } from 'fs'
import { bundlerService, bundlerResourcePath } from '../bundler'
import { createLogger } from '../../logger'

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

  /** 构建 URL（server 未启动则返回 null） */
  getUrl(id: string): string | null {
    if (!this.server) return null
    return `http://127.0.0.1:${this.port}/w/${id}/`
  }

  /** 当前服务器运行状态（供 UI 展示） */
  getStatus(): { running: boolean; port: number; widgetCount: number } {
    return {
      running: this.server !== null,
      port: this.port,
      widgetCount: this.entries.size
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
    const url = req.url ?? '/'
    res.setHeader('Access-Control-Allow-Origin', '*')

    // /w/<id>/<rest>
    const match = url.match(/^\/w\/([a-z0-9]+(?:-[a-z0-9]+)+)(\/.*)?$/)
    if (!match) {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('Not found')
      return
    }
    const widgetId = match[1]
    const rest = match[2] ?? '/'
    const entry = this.entries.get(widgetId)
    if (!entry) {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end(`Widget ${widgetId} not registered`)
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
}

export const widgetServer = new WidgetServer()
