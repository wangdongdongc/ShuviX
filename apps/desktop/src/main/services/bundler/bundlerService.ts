/**
 * BundlerService — esbuild-wasm 打包服务
 *
 * 封装所有 esbuild-wasm 复杂性：
 * - Lazy 初始化 esbuild-wasm（加载 .wasm 二进制）
 * - 自定义 plugin 将 bare import 映射到预置 ESM bundle
 * - 提供 build API
 */

import * as esbuild from 'esbuild-wasm'
import type * as childProcess from 'child_process'
import { createRequire } from 'module'
import { resolve, dirname, relative, isAbsolute } from 'path'
import { existsSync, readFileSync, realpathSync, statSync } from 'fs'
import type { Logger } from './types'

// 通过 createRequire 拿到 child_process 的 CJS exports 对象本身。
// 不要用 `import * as cp from 'child_process'`：rollup 会把它包成 frozen
// 的 ESM 命名空间（`[object Module]`），后续给 cp.spawn 赋值会触发
// "Cannot set property spawn ... which has only a getter"。
const cpModule = createRequire(__filename)('child_process') as typeof childProcess

// ────────────────────── Types ──────────────────────

export interface BundleResult {
  success: boolean
  outputJS?: string
  outputCSS?: string
  errors?: string[]
  warnings?: string[]
  duration: number
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
/**
 * 组件 API（`api.ts`）的预置依赖：`shuvix/widget-api`（沙箱运行时，见 services/widget/api/sandboxRuntime.ts）与 zod。
 * 两个文件都由 scripts/bundle-widget-api.mjs 生成；widget-api 把 zod 外置，打包时两边都解析到同一份 zod.esm.js
 */
const WIDGET_API_BUNDLE = 'widget-api.esm.js'
const ZOD_BUNDLE = 'zod.esm.js'
const WIDGET_API_SPECIFIER = 'shuvix/widget-api'
/**
 * 界面的预置依赖 `shuvix/widget`：调组件自己 API 的客户端（src/renderer/src/widgetClient/widgetClient.ts，同一个脚本
 * 生成）。它 import 的 react 解析回组件自己用的那一份（同一个 React 实例）
 */
const WIDGET_CLIENT_BUNDLE = 'widget.esm.js'
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

  'react-dom': `export { _reactDOM as default, createPortal, flushSync, unstable_batchedUpdates } from '__ALL_IN_ONE__';`,

  'react-dom/client': `export { _reactDOMClient as default, createRoot, hydrateRoot } from '__ALL_IN_ONE__';`,

  'react-router': ROUTER_REEXPORTS,
  'react-router-dom': ROUTER_REEXPORTS
}

/** `path` 是否在 `dir` 里面（都按真实路径比：组件目录里的符号链接不能把 import 带到外面） */
function isInsideDir(dir: string, path: string): boolean {
  let realDir: string
  let realPath: string
  try {
    realDir = realpathSync(dir)
    realPath = realpathSync(path)
  } catch {
    return false
  }
  const rel = relative(realDir, realPath)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** 打包时 import 到组件目录之外 → esbuild 的错误（组件只能打包自己目录里的文件，否则 build 成了读任意文件的路） */
function outsideWidgetError(path: string): esbuild.OnResolveResult {
  return {
    errors: [
      {
        text: `"${path}" is outside this widget's directory; a widget can only import its own files.`
      }
    ]
  }
}

/** 绝对路径的 import（`/…`、`C:\…`）：组件只用相对路径 */
const ABSOLUTE_IMPORT = /^(\/|[A-Za-z]:[\\/])/

/**
 * 相对路径的 import → 绝对路径：先原样，再补扩展名，再找目录里的 index 文件；都没有 → undefined（交给 esbuild 报错）。
 * 解析到组件目录之外 → 错误
 */
function resolveRelativeImport(
  path: string,
  importer: string,
  projectDir: string
): esbuild.OnResolveResult | undefined {
  const found = findRelativeImport(path, importer, projectDir)
  if (found && !isInsideDir(projectDir, found.path)) return outsideWidgetError(path)
  return found
}

function findRelativeImport(
  path: string,
  importer: string,
  projectDir: string
): { path: string } | undefined {
  const base = importer ? dirname(importer) : projectDir
  // 先尝试原路径（可能已有扩展名）
  const direct = resolve(base, path)
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
}

// ────────────────────── BundlerService ──────────────────────

export class BundlerService {
  private initialized = false
  private initPromise: Promise<void> | null = null

  constructor(
    private getResourcePath: (relativePath: string) => string,
    private log: Logger
  ) {}

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

      // esbuild-wasm 硬编码 spawn("node", [bin/esbuild]) 启动 WASM worker。
      // 打包后的 Electron 应用 PATH 中没有 node，会 ENOENT。
      // 临时把 "node" 重定向到 Electron 自身（ELECTRON_RUN_AS_NODE=1）作为 Node 运行。
      const originalSpawn = cpModule.spawn
      cpModule.spawn = ((
        command: string,
        args?: readonly string[] | childProcess.SpawnOptions,
        options?: childProcess.SpawnOptions
      ) => {
        if (command === 'node' && Array.isArray(args)) {
          const opts = options ?? {}
          const env = { ...(opts.env ?? process.env), ELECTRON_RUN_AS_NODE: '1' }
          return originalSpawn(process.execPath, args, { ...opts, env })
        }
        return (originalSpawn as (...a: unknown[]) => childProcess.ChildProcess)(
          command,
          args,
          options
        )
      }) as typeof cpModule.spawn

      try {
        await esbuild.initialize({})
      } finally {
        cpModule.spawn = originalSpawn
      }

      this.initialized = true
      this.log.info('esbuild-wasm initialized')
    })()

    return this.initPromise
  }

  // ── esbuild plugin ──

  /** 创建项目专用 esbuild 插件 */
  private createDesignPlugin(projectDir: string): esbuild.Plugin {
    const depsDir = this.getDepsDir()
    const allInOnePath = resolve(depsDir, ALL_IN_ONE_BUNDLE)
    const allInOneContent = readFileSync(allInOnePath, 'utf-8')

    // Router bundle（懒加载，可能不存在于旧安装中）
    const routerBundlePath = resolve(depsDir, ROUTER_BUNDLE)
    const routerBundleContent = existsSync(routerBundlePath)
      ? readFileSync(routerBundlePath, 'utf-8')
      : ''
    const clientBundlePath = resolve(depsDir, WIDGET_CLIENT_BUNDLE)
    const clientBundleContent = existsSync(clientBundlePath)
      ? readFileSync(clientBundlePath, 'utf-8')
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

        // 4c) `shuvix/widget` → 界面的 API 客户端；它里面的 react 回到 shipped-dep（共享 React 实例）
        build.onResolve({ filter: /^shuvix\/widget$/ }, () => ({
          path: 'shuvix/widget',
          namespace: 'shuvix-widget-client'
        }))
        build.onLoad({ filter: /.*/, namespace: 'shuvix-widget-client' }, () => ({
          contents: clientBundleContent,
          loader: 'js'
        }))
        build.onResolve({ filter: /^react$/, namespace: 'shuvix-widget-client' }, (args) => ({
          path: args.path,
          namespace: 'shipped-dep'
        }))
        // 4d) 界面里 import 了 API 那一侧的东西（多半是 `import Api from './api'` 少写了 `type`）：说清楚
        build.onResolve({ filter: /^(shuvix\/widget-api|zod)$/ }, (args) => ({
          errors: [
            {
              text: `"${args.path}" runs on ShuviX's side, not in the widget's screen. Import the API's type only (\`import type Api from './api'\`) and call it through \`createClient\` from "shuvix/widget".`
            }
          ]
        }))

        // 5) relative imports → 自动补全扩展名（只许组件目录里的文件）
        build.onResolve({ filter: /^\./ }, (args) =>
          resolveRelativeImport(args.path, args.importer, projectDir)
        )
        // 6) 绝对路径：一律不收（组件只 import 自己目录里的文件）
        build.onResolve({ filter: ABSOLUTE_IMPORT }, (args) =>
          // 入口文件本身是绝对路径，它也会经过 onResolve
          args.kind === 'entry-point' || args.namespace !== 'file'
            ? undefined
            : outsideWidgetError(args.path)
        )
      }
    }
  }

  /**
   * 组件 API 的插件：`shuvix/widget-api` 与 `zod` 映射到预置包，相对路径照常解析，别的裸模块一律报错 ——
   * API 跑在 QuickJS 里，没有 node_modules，也不该把 React 之类拖进去
   */
  private createApiPlugin(projectDir: string): esbuild.Plugin {
    const depsDir = this.getDepsDir()
    const widgetApiContent = readFileSync(resolve(depsDir, WIDGET_API_BUNDLE), 'utf-8')
    const zodContent = readFileSync(resolve(depsDir, ZOD_BUNDLE), 'utf-8')
    return {
      name: 'shuvix-widget-api',
      setup(build) {
        build.onResolve({ filter: /^shuvix\/widget-api$/ }, () => ({
          path: WIDGET_API_SPECIFIER,
          namespace: 'widget-api-dep'
        }))
        build.onResolve({ filter: /^zod$/ }, () => ({ path: 'zod', namespace: 'widget-api-zod' }))
        build.onLoad({ filter: /.*/, namespace: 'widget-api-dep' }, () => ({
          contents: widgetApiContent,
          loader: 'js'
        }))
        build.onLoad({ filter: /.*/, namespace: 'widget-api-zod' }, () => ({
          contents: zodContent,
          loader: 'js'
        }))
        build.onResolve({ filter: /^[^./]/ }, (args) => {
          if (args.namespace === 'widget-api-dep' || args.namespace === 'widget-api-zod') {
            return undefined
          }
          return {
            errors: [
              {
                text: `api.ts can only import "shuvix/widget-api", "zod" and files in this widget (not "${args.path}").`
              }
            ]
          }
        })
        // 相对路径：与界面打包同一套解析（自动补扩展名、index 文件，只许组件目录里的文件）；绝对路径不收
        build.onResolve({ filter: /^\./ }, (args) =>
          resolveRelativeImport(args.path, args.importer, projectDir)
        )
        build.onResolve({ filter: ABSOLUTE_IMPORT }, (args) => outsideWidgetError(args.path))
      }
    }
  }

  // ── Build ──

  /**
   * 打包组件的 API：一个生成的入口 import `api.ts` 的默认导出，交给 `shuvix/widget-api` 的运行时装好 `__widget`；
   * 产物是给 QuickJS 执行的 IIFE（没有模块加载器）
   */
  async buildApi(projectDir: string, apiFileName = 'api.ts'): Promise<BundleResult> {
    await this.ensureInitialized()
    const start = Date.now()
    // 相对路径 import（resolveDir = 组件目录）：绝对路径在 Windows 上以盘符开头，会被当成裸模块挡掉
    const entry = [
      `import api from ${JSON.stringify('./' + apiFileName)}`,
      `import { __installWidgetRuntime } from '${WIDGET_API_SPECIFIER}'`,
      '__installWidgetRuntime(api)'
    ].join('\n')
    try {
      const result = await esbuild.build({
        stdin: {
          contents: entry,
          resolveDir: projectDir,
          loader: 'ts',
          sourcefile: 'api-entry.ts'
        },
        bundle: true,
        format: 'iife',
        write: false,
        platform: 'neutral',
        target: 'es2020',
        loader: { '.ts': 'ts', '.js': 'js' },
        plugins: [this.createApiPlugin(projectDir)],
        logLevel: 'silent'
      })
      const outputJS = result.outputFiles?.[0]?.text ?? ''
      const warnings = result.warnings.map(
        (w) => esbuild.formatMessagesSync([w], { kind: 'warning' })[0]
      )
      return {
        success: true,
        outputJS,
        warnings: warnings.length > 0 ? warnings : undefined,
        duration: Date.now() - start
      }
    } catch (err) {
      const buildErr = err as esbuild.BuildFailure
      const errors = buildErr.errors
        ? buildErr.errors.map((e) => esbuild.formatMessagesSync([e], { kind: 'error' })[0])
        : [String(err)]
      return { success: false, errors, duration: Date.now() - start }
    }
  }

  /** 打包项目 */
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
}
