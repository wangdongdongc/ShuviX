/**
 * BundlerService — esbuild-wasm 打包服务（插件版）
 *
 * 封装所有 esbuild-wasm 复杂性：
 * - Lazy 初始化 esbuild-wasm（加载 .wasm 二进制）
 * - 自定义 plugin 将 bare import 映射到预置 ESM bundle
 * - 提供 build/rebuild API
 * - 管理 per-session HTTP dev server（含 SSE live-reload）
 */

import * as esbuild from 'esbuild-wasm'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http'
import { resolve, dirname } from 'path'
import { existsSync, readFileSync, statSync } from 'fs'
import type { PluginLogger } from '../../plugin-api'

// ────────────────────── Types ──────────────────────

export interface BundleResult {
  success: boolean
  outputJS?: string
  outputCSS?: string
  errors?: string[]
  warnings?: string[]
  duration: number
}

export interface DevServerInfo {
  port: number
  url: string
}

interface DevServerEntry {
  server: Server
  port: number
  /** 当前打包产物（内存中） */
  latestJS: string
  latestCSS: string
  /** 最近一次构建是否成功 */
  buildSuccess: boolean
  /** 最近一次构建错误信息 */
  buildErrors: string[]
  /** SSE 客户端连接列表 */
  sseClients: Set<ServerResponse>
  /** 设计项目目录 */
  projectDir: string
}

// ────────────────────── Pre-shipped dependency mapping ──────────────────────

/** 需要拦截的 bare import 列表 */
const SHIPPED_SPECIFIERS = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  'react-router',
  'react-router-dom'
])

/** bundle 文件名 */
const ALL_IN_ONE_BUNDLE = 'react-all.esm.js'
const ROUTER_BUNDLE = 'react-router.esm.js'

/**
 * 每个 bare specifier 对应的 re-export wrapper
 * 从预置 bundle 中按需 re-export，确保所有模块共享同一个 React 实例
 */
const ROUTER_REEXPORTS = `export {
  createHashRouter, createBrowserRouter, createMemoryRouter,
  RouterProvider, Outlet, Link, NavLink, Navigate,
  useNavigate, useLocation, useParams, useSearchParams,
  useLoaderData, useRouteError, useOutletContext, useMatches,
  redirect, matchPath
} from '__ROUTER_BUNDLE__';`

const REEXPORT_WRAPPERS: Record<string, string> = {
  react: `export {
  React as default,
  Children, Component, Fragment, Profiler, PureComponent, StrictMode,
  Suspense, cloneElement, createContext, createElement, createRef,
  forwardRef, isValidElement, lazy, memo, cache,
  startTransition, use, useActionState, useCallback, useContext,
  useDebugValue, useDeferredValue, useEffect, useId,
  useImperativeHandle, useInsertionEffect, useLayoutEffect, useMemo,
  useOptimistic, useReducer, useRef, useState, useSyncExternalStore,
  useTransition, version
} from '__ALL_IN_ONE__';`,

  'react/jsx-runtime': `export { jsx, jsxs, _Fragment as Fragment, _jsxRuntime as default } from '__ALL_IN_ONE__';`,

  'react-dom': `export { _reactDOM as default, createPortal, flushSync } from '__ALL_IN_ONE__';`,

  'react-dom/client': `export { _reactDOMClient as default, createRoot, hydrateRoot } from '__ALL_IN_ONE__';`,

  'react-router': ROUTER_REEXPORTS,
  'react-router-dom': ROUTER_REEXPORTS
}

// ────────────────────── Host HTML template ──────────────────────

const HOST_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Design Preview</title>
  <script src="tailwind.js"></script>
  <link rel="stylesheet" href="bundle.css" />
</head>
<body>
  <div id="root"></div>
  <script type="module" src="bundle.js"></script>
  <script>
    // SSE live-reload
    const es = new EventSource('sse');
    es.addEventListener('reload', () => location.reload());
    es.onerror = () => setTimeout(() => location.reload(), 1000);
  </script>
</body>
</html>`

/** 构建错误时显示的 overlay HTML */
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

// ────────────────────── BundlerService ──────────────────────

export class BundlerService {
  private initialized = false
  private initPromise: Promise<void> | null = null
  private devServers = new Map<string, DevServerEntry>()
  /** 缓存 Tailwind CSS browser runtime 内容 */
  private tailwindContent: string | null = null

  constructor(
    private getResourcePath: (relativePath: string) => string,
    private log: PluginLogger
  ) {}

  // ── Resource paths ──

  /** 获取 Tailwind CSS browser runtime 内容（懒加载 + 缓存） */
  private getTailwindContent(): string {
    if (!this.tailwindContent) {
      const tailwindPath = resolve(this.getResourcePath('deps'), 'tailwindcss-browser.js')
      this.tailwindContent = readFileSync(tailwindPath, 'utf-8')
    }
    return this.tailwindContent
  }

  /** 预置 ESM 依赖目录 */
  private getDepsDir(): string {
    return this.getResourcePath('deps')
  }

  // ── Initialization ──

  /** 懒初始化 esbuild-wasm，全局只执行一次 */
  async ensureInitialized(): Promise<void> {
    if (this.initialized) return
    if (this.initPromise) return this.initPromise

    this.initPromise = (async () => {
      this.log.info('Initializing esbuild-wasm')

      // Node.js 环境下 esbuild-wasm 自动定位 wasm 二进制，无需指定 wasmURL/wasmModule
      await esbuild.initialize({})

      this.initialized = true
      this.log.info('esbuild-wasm initialized')
    })()

    return this.initPromise
  }

  // ── esbuild plugin ──

  /** 创建设计项目专用 esbuild 插件 */
  private createDesignPlugin(projectDir: string): esbuild.Plugin {
    const depsDir = this.getDepsDir()
    const allInOnePath = resolve(depsDir, ALL_IN_ONE_BUNDLE)
    const allInOneContent = readFileSync(allInOnePath, 'utf-8')

    // Router bundle（懒加载，可能不存在于旧安装中）
    const routerBundlePath = resolve(depsDir, ROUTER_BUNDLE)
    const routerBundleContent = existsSync(routerBundlePath)
      ? readFileSync(routerBundlePath, 'utf-8')
      : ''

    return {
      name: 'shuvix-design',
      setup(build) {
        // 1) bare specifier → namespace 'shipped-dep'
        build.onResolve(
          { filter: /^(react|react-dom|react-router|react-router-dom)(\/.*)?$/ },
          (args) => {
            if (SHIPPED_SPECIFIERS.has(args.path)) {
              return { path: args.path, namespace: 'shipped-dep' }
            }
            return undefined
          }
        )

        // 2a) shipped-dep 内部 __ALL_IN_ONE__ → react all-in-one bundle
        build.onResolve({ filter: /^__ALL_IN_ONE__$/, namespace: 'shipped-dep' }, () => {
          return { path: 'react-all', namespace: 'shipped-bundle' }
        })

        // 2b) shipped-dep 内部 __ROUTER_BUNDLE__ → react-router bundle
        build.onResolve({ filter: /^__ROUTER_BUNDLE__$/, namespace: 'shipped-dep' }, () => {
          return { path: 'react-router', namespace: 'shipped-router-bundle' }
        })

        // 2c) router bundle 内部的 react 引用 → 重定向回 shipped-dep（共享 React 实例）
        build.onResolve(
          { filter: /^(react|react-dom|react\/jsx-runtime)$/, namespace: 'shipped-router-bundle' },
          (args) => {
            return { path: args.path, namespace: 'shipped-dep' }
          }
        )

        // 3) onLoad: shipped-dep → 返回 re-export wrapper
        build.onLoad({ filter: /.*/, namespace: 'shipped-dep' }, (args) => {
          const wrapper = REEXPORT_WRAPPERS[args.path]
          if (wrapper) {
            return { contents: wrapper, loader: 'js' }
          }
          return undefined
        })

        // 4a) onLoad: shipped-bundle → react all-in-one bundle
        build.onLoad({ filter: /.*/, namespace: 'shipped-bundle' }, () => {
          return { contents: allInOneContent, loader: 'js' }
        })

        // 4b) onLoad: shipped-router-bundle → react-router bundle
        build.onLoad({ filter: /.*/, namespace: 'shipped-router-bundle' }, () => {
          return { contents: routerBundleContent, loader: 'js' }
        })

        // 5) relative imports → 自动补全扩展名
        build.onResolve({ filter: /^\./ }, (args) => {
          const base = args.importer ? dirname(args.importer) : projectDir
          // 先尝试原路径（可能已有扩展名）
          const direct = resolve(base, args.path)
          if (existsSync(direct) && !statSync(direct).isDirectory()) {
            return { path: direct }
          }
          // 补全扩展名
          const extensions = ['.tsx', '.ts', '.jsx', '.js', '.css']
          for (const ext of extensions) {
            const full = direct + ext
            if (existsSync(full)) return { path: full }
          }
          // 尝试 index 文件
          const indexExts = ['.tsx', '.ts', '.jsx', '.js']
          for (const ext of indexExts) {
            const indexPath = resolve(direct, 'index' + ext)
            if (existsSync(indexPath)) return { path: indexPath }
          }
          return undefined
        })
      }
    }
  }

  // ── Build ──

  /** 打包设计项目 */
  async build(entryPoint: string, projectDir: string): Promise<BundleResult> {
    await this.ensureInitialized()

    const start = Date.now()
    try {
      const result = await esbuild.build({
        entryPoints: [entryPoint],
        bundle: true,
        format: 'esm',
        write: false, // 输出到内存
        outdir: 'out', // 虚拟输出目录
        platform: 'browser',
        target: 'es2020',
        jsx: 'automatic',
        jsxImportSource: 'react',
        loader: {
          '.tsx': 'tsx',
          '.ts': 'ts',
          '.jsx': 'jsx',
          '.js': 'js',
          '.css': 'css',
          '.svg': 'dataurl',
          '.png': 'dataurl',
          '.jpg': 'dataurl',
          '.gif': 'dataurl'
        },
        plugins: [this.createDesignPlugin(projectDir)],
        logLevel: 'silent' // 我们自行处理错误
      })

      let outputJS = ''
      let outputCSS = ''
      for (const file of result.outputFiles ?? []) {
        if (file.path.endsWith('.js')) outputJS = file.text
        else if (file.path.endsWith('.css')) outputCSS = file.text
      }

      const warnings = result.warnings.map(
        (w) => esbuild.formatMessagesSync([w], { kind: 'warning' })[0]
      )

      return {
        success: true,
        outputJS,
        outputCSS,
        warnings: warnings.length > 0 ? warnings : undefined,
        duration: Date.now() - start
      }
    } catch (err) {
      const buildErr = err as esbuild.BuildFailure
      const errors = buildErr.errors
        ? buildErr.errors.map((e) => esbuild.formatMessagesSync([e], { kind: 'error' })[0])
        : [String(err)]

      return {
        success: false,
        errors,
        duration: Date.now() - start
      }
    }
  }

  // ── Dev Server ──

  /** 启动 per-session HTTP dev server */
  async startDevServer(sessionId: string, projectDir: string): Promise<DevServerInfo> {
    // 如果已有，先停止
    this.stopDevServer(sessionId)

    // 首次构建
    const result = await this.build(resolve(projectDir, 'index.tsx'), projectDir)
    if (!result.success) {
      this.log.warn('Initial build failed:', result.errors)
    } else {
      this.log.info(`Initial build OK (${result.duration}ms)`)
    }

    const entry: DevServerEntry = {
      server: null!,
      port: 0,
      latestJS: result.outputJS ?? '',
      latestCSS: result.outputCSS ?? '',
      buildSuccess: result.success,
      buildErrors: result.errors ?? [],
      sseClients: new Set(),
      projectDir
    }

    const server = createServer((req, res) => this.handleRequest(req, res, entry))
    entry.server = server

    // 使用 port 0 让系统分配可用端口
    await new Promise<void>((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => resolve())
      server.on('error', reject)
    })

    const addr = server.address()
    if (!addr || typeof addr === 'string') {
      throw new Error('Failed to get dev server address')
    }
    entry.port = addr.port

    this.devServers.set(sessionId, entry)

    const url = `http://127.0.0.1:${entry.port}`
    this.log.info(`Dev server started for session ${sessionId} at ${url}`)
    return { port: entry.port, url }
  }

  /** 停止 per-session dev server */
  stopDevServer(sessionId: string): void {
    const entry = this.devServers.get(sessionId)
    if (!entry) return

    // 关闭所有 SSE 连接
    for (const client of entry.sseClients) {
      client.end()
    }
    entry.sseClients.clear()

    entry.server.close()
    this.devServers.delete(sessionId)
    this.log.info(`Dev server stopped for session ${sessionId}`)
  }

  /** 获取 dev server 信息 */
  getDevServerInfo(sessionId: string): DevServerInfo | null {
    const entry = this.devServers.get(sessionId)
    if (!entry) return null
    return { port: entry.port, url: `http://127.0.0.1:${entry.port}` }
  }

  /** 重新打包并通知 iframe 刷新 */
  async rebuild(sessionId: string, projectDir: string): Promise<BundleResult> {
    const result = await this.build(resolve(projectDir, 'index.tsx'), projectDir)

    const entry = this.devServers.get(sessionId)
    if (entry) {
      entry.buildSuccess = result.success
      entry.buildErrors = result.errors ?? []
      if (result.success) {
        entry.latestJS = result.outputJS ?? ''
        entry.latestCSS = result.outputCSS ?? ''
      }
      // 无论成功失败都通知 SSE 客户端刷新
      this.notifySSEClients(entry)
    }

    if (result.success) {
      this.log.info(`Rebuild OK for session ${sessionId} (${result.duration}ms)`)
    } else {
      this.log.warn(`Rebuild failed for session ${sessionId}:`, result.errors)
    }

    return result
  }

  /** 清理所有资源 */
  dispose(): void {
    for (const sessionId of this.devServers.keys()) {
      this.stopDevServer(sessionId)
    }
  }

  // ── HTTP request handler ──

  private handleRequest(req: IncomingMessage, res: ServerResponse, entry: DevServerEntry): void {
    const url = req.url ?? '/'

    // CORS headers（Electron iframe 可能需要）
    res.setHeader('Access-Control-Allow-Origin', '*')

    if (url === '/sse') {
      // Server-Sent Events
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      })
      res.write(':\n\n') // 初始心跳
      entry.sseClients.add(res)
      req.on('close', () => entry.sseClients.delete(res))
      return
    }

    if (url === '/tailwind.js') {
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'public, max-age=31536000, immutable'
      })
      res.end(this.getTailwindContent())
      return
    }

    if (url === '/bundle.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' })
      res.end(entry.latestJS)
      return
    }

    if (url === '/bundle.css') {
      res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' })
      res.end(entry.latestCSS)
      return
    }

    // 默认：host HTML（构建失败时显示 error overlay）
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    if (!entry.buildSuccess) {
      res.end(
        errorOverlayHTML(
          entry.buildErrors.length > 0
            ? entry.buildErrors
            : ['Build failed. Check console for details.']
        )
      )
    } else {
      res.end(HOST_HTML)
    }
  }

  /** 通过 SSE 通知所有客户端重新加载 */
  private notifySSEClients(entry: DevServerEntry): void {
    for (const client of entry.sseClients) {
      client.write('event: reload\ndata: ok\n\n')
    }
  }
}
