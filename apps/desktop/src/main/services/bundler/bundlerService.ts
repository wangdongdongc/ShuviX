/**
 * BundlerService — esbuild-wasm 打包服务
 *
 * 封装所有 esbuild-wasm 复杂性：
 * - Lazy 初始化 esbuild-wasm（加载 .wasm 二进制）
 * - 自定义 plugin 将 bare import 映射到预置 ESM bundle（React 全家桶）
 * - widgetLibs.json 里的库从 vendor 目录按包解析（可摇树；three 留给页面的 import map），别的裸模块一律报错
 * - 提供 build API
 */

import * as esbuild from 'esbuild-wasm'
import type * as childProcess from 'child_process'
import { createRequire } from 'module'
import { resolve, dirname, relative, isAbsolute, join, sep } from 'path'
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, type Dirent } from 'fs'
import type { Logger } from './types'
import {
  blockedImportHint,
  packageNameOf,
  servedFileOf,
  widgetLibraryNames,
  widgetLibraryOf,
  type WidgetLibrary
} from './widgetLibs'

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

/** 上面那些 specifier 所在的包（它们别的子路径不给：`react-dom/server` 之类） */
const REACT_PACKAGES = new Set(['react', 'react-dom', 'react-router', 'react-router-dom'])

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

/** 网址形式的 specifier（`https:`、`data:` …）：组件的代码与样式表不从网上来。`node:fs` 不是网址，走「不可用」那句 */
const URL_SPECIFIER = /^(?!node:)[a-z][a-z0-9+.-]*:/i

/** 插件自己调 build.resolve 时带的标记：那一轮不再进路径的拦截，交给 esbuild 自己的解析 */
const NATIVE_RESOLVE = 'shuvixNativeResolve'

/** `./x?raw`：文件的文本，与导出的 Vite 项目同一个写法 */
const RAW_IMPORT = /^\.{1,2}\/.*\?raw$/

function importError(text: string): esbuild.OnResolveResult {
  return { errors: [{ text }] }
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

/** 浏览器能当模块加载的文件（不是目录，也不是解码器的 .wasm） */
function isModuleFile(path: string): boolean {
  return /\.m?js$/.test(path) && !!statSync(path, { throwIfNoEntry: false })?.isFile()
}

/** served 库在 vendor 里带了哪些 addon（报错时列给人看）：`three/addons/controls/OrbitControls.js` … */
function listServedAddons(vendorDir: string, name: string): string[] {
  const lib = widgetLibraryOf(name)
  const out: string[] = []
  for (const [key, target] of Object.entries(lib?.served ?? {})) {
    if (!key.endsWith('/')) {
      out.push(key)
      continue
    }
    const walk = (rel: string): void => {
      let entries: Dirent[]
      try {
        entries = readdirSync(join(vendorDir, 'node_modules', name, target, rel), {
          withFileTypes: true
        })
      } catch {
        return
      }
      for (const entry of entries) {
        const path = rel ? `${rel}/${entry.name}` : entry.name
        if (entry.isDirectory()) walk(path)
        else if (entry.name.endsWith('.js')) out.push(key + path)
      }
    }
    walk('')
  }
  return out.sort()
}

/**
 * 报错时列哪些：问的那个文件夹里的文件（清单有几百项，全列出来就是一大段）；问的不在任何文件夹里 → 不带文件夹的那几项，
 * 加上各个文件夹（`three/addons/loaders/`）
 */
function nearbyServedFiles(all: readonly string[], specifier: string): string[] {
  const folder = specifier.slice(0, specifier.lastIndexOf('/') + 1)
  const near = all.filter(
    (file) => file.startsWith(folder) && !file.slice(folder.length).includes('/')
  )
  if (folder && near.length > 0) return near
  const folderOf = (file: string): string => file.slice(0, file.lastIndexOf('/') + 1)
  return [
    ...all.filter((file) => !folderOf(file)),
    ...new Set(all.map(folderOf).filter(Boolean))
  ].sort()
}

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

/**
 * 上面解析不了的相对路径与 CSS 的 url(…) 交给 esbuild 自己解析（它还认 `?x` / `#x` 后缀、.json、目录里 package.json 的
 * main）：结果同样只许落在组件目录里，否则 `../secret.txt?x` 就把外面的文件打进了产物。解析不了或不是文件 → undefined，
 * 让 esbuild 自己接着走（报错带行号与代码框；`url(#x)`、`url(data:…)` 留在原地）
 */
async function refuseNativeEscape(
  build: esbuild.PluginBuild,
  args: esbuild.OnResolveArgs,
  projectDir: string
): Promise<esbuild.OnResolveResult | undefined> {
  const result = await build.resolve(args.path, {
    kind: args.kind,
    resolveDir: args.resolveDir,
    importer: args.importer,
    pluginData: { [NATIVE_RESOLVE]: true }
  })
  if (result.errors.length > 0 || result.external || result.namespace !== 'file') return undefined
  return isInsideDir(projectDir, result.path) ? undefined : outsideWidgetError(args.path)
}

/**
 * esbuild-wasm 的服务子进程没了（被杀、崩溃、起不来）时它给的错误。它不会自己重起：模块里一直挂着那个死掉的服务，
 * 之后每次调用都是这一句。它总是一个普通 Error（带插件的构建也是：插件在本进程里注册，不经过服务），
 * 编译错误则是带 `errors` 的 BuildFailure —— 只认前者，否则一条 import 路径里恰好有这句话的编译错误也会被当成服务没了
 */
const SERVICE_GONE = /^The service (?:is no longer running|was stopped)/

/** 是那种错误 → 那一句（`The service is no longer running: spawn node ENOENT`）；不是 → null */
function serviceGoneText(err: unknown): string | null {
  if (!(err instanceof Error) || 'errors' in err) return null
  return SERVICE_GONE.test(err.message) ? err.message : null
}

/** esbuild 格式化不了时的退路：`file:line:col: error: text`（加上 notes），真正的错误总要交回去 */
function plainMessage(message: esbuild.Message, kind: 'error' | 'warning'): string {
  const at = (loc: esbuild.Location | null): string =>
    loc ? `${loc.file}:${loc.line}:${loc.column}: ` : ''
  const notes = (message.notes ?? []).map((n) => `\n  ${at(n.location)}note: ${n.text}`)
  return `${at(message.location)}${kind}: ${message.text}${notes.join('')}`
}

// ────────────────────── BundlerService ──────────────────────

export class BundlerService {
  private initPromise: Promise<void> | null = null
  /** 第几个服务子进程：并发的几次构建同时撞上服务没了，只有用着当前这一个的那次去重起 */
  private generation = 0

  constructor(
    private getResourcePath: (relativePath: string) => string,
    private log: Logger
  ) {}

  /** 预置 ESM 依赖目录 */
  private getDepsDir(): string {
    return this.getResourcePath('deps')
  }

  /** 小组件可用的库（widgetLibs.json），scripts/vendor-widget-libs.mjs 拷好的 `<vendor>/node_modules` */
  private getVendorDir(): string {
    return this.getResourcePath('vendor')
  }

  // ── Initialization ──

  /** 懒初始化 esbuild-wasm：起一个服务子进程，之后的调用都走它；它没了由 restartService 换一个 */
  ensureInitialized(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.startService().catch((err) => {
        this.initPromise = null
        throw err
      })
    }
    return this.initPromise
  }

  private async startService(): Promise<void> {
    this.log.info('Initializing esbuild-wasm')

    // esbuild-wasm 硬编码 spawn("node", [bin/esbuild]) 启动 WASM worker。
    // 打包后的 Electron 应用 PATH 中没有 node，会 ENOENT。
    // 把 "node" 重定向到 Electron 自身（ELECTRON_RUN_AS_NODE=1）作为 Node 运行；子进程在 initialize() 里同步 spawn，
    // 调完就换回去
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

    let ready: Promise<void>
    try {
      ready = esbuild.initialize({})
    } finally {
      cpModule.spawn = originalSpawn
    }
    await ready

    this.log.info('esbuild-wasm initialized')
  }

  /**
   * 服务子进程没了 → 换一个。不换的话只有重启整个应用才能再打包。stop() 把死掉的服务摘掉并允许再 initialize 一次；
   * 两步同步做完，中间不让别的调用插进来 —— 那次调用会按 esbuild 的缺省去 spawn PATH 里的 `node`
   */
  private restartService(deadGeneration: number): Promise<void> {
    if (deadGeneration === this.generation) {
      this.generation++
      this.log.warn('esbuild-wasm service is no longer running; starting a new one')
      void esbuild.stop()
      this.initPromise = null
    }
    return this.ensureInitialized()
  }

  /** 跑一次 esbuild 调用；服务没了 → 换一个再跑一次（又没了就把错误照常抛出） */
  private async withService<T>(run: () => Promise<T>): Promise<T> {
    await this.ensureInitialized()
    const generation = this.generation
    try {
      return await run()
    } catch (err) {
      if (serviceGoneText(err) === null) throw err
      await this.restartService(generation)
      return run()
    }
  }

  /**
   * esbuild 的消息 → 带代码框的文本。走主服务的异步 formatMessages，不用 formatMessagesSync：同步版另起一个 worker 线程
   * 和一个 esbuild 子进程，那个子进程按缺省 spawn PATH 里的 `node`（上面的重定向够不着 worker 线程）—— 打包后的应用
   * PATH 里没有 node，它起不来，每次构建失败交回的都成了 "The service is no longer running: spawn node ENOENT"，
   * 真正的错误被盖掉。格式化本身失败 → plainMessage
   */
  private async formatMessages(
    messages: esbuild.Message[],
    kind: 'error' | 'warning'
  ): Promise<string[]> {
    if (messages.length === 0) return []
    try {
      return await esbuild.formatMessages(messages, { kind })
    } catch {
      return messages.map((m) => plainMessage(m, kind))
    }
  }

  /** 一次打包：成功 → 产物与格式化好的警告；失败 → 格式化好的错误 */
  private async bundle(
    options: esbuild.BuildOptions & { write: false }
  ): Promise<
    | { ok: true; outputFiles: esbuild.OutputFile[]; warnings?: string[] }
    | { ok: false; errors: string[] }
  > {
    try {
      const result = await this.withService(() => esbuild.build(options))
      const warnings = await this.formatMessages(result.warnings, 'warning')
      return {
        ok: true,
        outputFiles: result.outputFiles ?? [],
        warnings: warnings.length > 0 ? warnings : undefined
      }
    } catch (err) {
      const gone = serviceGoneText(err)
      if (gone !== null) {
        return {
          ok: false,
          errors: [
            `The bundler (esbuild) stopped during this build, and again after it was restarted (${gone}). ` +
              'The next build starts it again; if this keeps happening, something in this build is what stops it.'
          ]
        }
      }
      const failure = err as Partial<esbuild.BuildFailure>
      const errors = Array.isArray(failure.errors)
        ? await this.formatMessages(failure.errors, 'error')
        : [String(err)]
      return { ok: false, errors: errors.length > 0 ? errors : [String(err)] }
    }
  }

  // ── esbuild plugin ──

  /** 创建项目专用 esbuild 插件 */
  private createDesignPlugin(projectDir: string): esbuild.Plugin {
    const depsDir = this.getDepsDir()
    const vendorDir = this.getVendorDir()
    const realVendorDir = realpathOrNull(vendorDir)
    // esbuild 交来的路径已经是真实路径：前缀比一下就够（逐个 realpath 太贵，库一 import 就是上百个文件）
    const inVendor = (path: string | undefined): boolean =>
      !!path &&
      (path.startsWith(vendorDir + sep) ||
        (!!realVendorDir && path.startsWith(realVendorDir + sep)))
    const vendorMissingError = (specifier: string): esbuild.OnResolveResult =>
      importError(
        `ShuviX's widget libraries are missing (${vendorDir}); "${specifier}" cannot be bundled. Reinstall ShuviX, or run npm install in a development checkout.`
      )
    const servedHint = (lib: WidgetLibrary, specifier: string): string => {
      const available = nearbyServedFiles(listServedAddons(vendorDir, lib.name), specifier)
      return (
        (available.length > 0 ? ` Available: ${available.join(', ')}.` : '') +
        ` To use another file, copy it and the files it imports from ${lib.name}@${lib.version} into this widget and import it by a relative path.`
      )
    }
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

        // 5a) JS 里的 `./x?raw` → 文件的文本。esbuild 自己只会去掉后缀、照常解析那个文件（.js 成了模块），import 到的不是
        //     文本，所以找不到就报错，不往下走。CSS 里 `?raw` 只是个普通后缀
        build.onResolve({ filter: RAW_IMPORT }, (args) => {
          if (inVendor(args.importer) || args.pluginData?.[NATIVE_RESOLVE]) return undefined
          if (args.kind === 'url-token' || args.kind === 'import-rule') return undefined
          const found = resolveRelativeImport(
            args.path.slice(0, -'?raw'.length),
            args.importer,
            projectDir
          )
          if (!found) return importError(`Could not resolve "${args.path}"`)
          return found.path ? { path: found.path, namespace: 'widget-raw' } : found
        })
        build.onLoad({ filter: /.*/, namespace: 'widget-raw' }, (args) => ({
          contents: readFileSync(args.path),
          loader: 'text'
        }))
        // 5b) relative imports → 自动补全扩展名（只许组件目录里的文件）；库自己文件之间的相对 import 照常解析
        build.onResolve({ filter: /^\./ }, (args) => {
          if (inVendor(args.importer) || args.pluginData?.[NATIVE_RESOLVE]) return undefined
          return (
            resolveRelativeImport(args.path, args.importer, projectDir) ??
            refuseNativeEscape(build, args, projectDir)
          )
        })
        // 6) 绝对路径：一律不收（组件只 import 自己目录里的文件）
        build.onResolve({ filter: ABSOLUTE_IMPORT }, (args) =>
          // 入口文件本身是绝对路径，它也会经过 onResolve
          args.kind === 'entry-point' || args.namespace !== 'file'
            ? undefined
            : outsideWidgetError(args.path)
        )

        // 7) 别的裸模块：只认 widgetLibs.json 里的库，一律从 vendor 解析 —— 不往上找组件目录外的 node_modules
        //    （从前会找到 ~/.shuvix/node_modules、~/node_modules 里碰巧装着的包）
        const resolveInVendor = async (
          specifier: string,
          resolveDir: string,
          kind: esbuild.ImportKind
        ): Promise<esbuild.OnResolveResult> => {
          if (!existsSync(join(vendorDir, 'node_modules'))) return vendorMissingError(specifier)
          const result = await build.resolve(specifier, {
            kind,
            resolveDir,
            pluginData: { [NATIVE_RESOLVE]: true }
          })
          if (result.errors.length > 0) return { errors: result.errors }
          if (!inVendor(result.path)) {
            return importError(
              `"${specifier}" resolved outside ShuviX's widget libraries (${result.path}).`
            )
          }
          return {
            path: result.path,
            namespace: result.namespace,
            suffix: result.suffix,
            sideEffects: result.sideEffects
          }
        }
        // 组件自己 tsconfig 的 paths / baseUrl：解析落在组件目录里、又不在 node_modules 下才收
        const resolveLocalAlias = async (
          args: esbuild.OnResolveArgs
        ): Promise<esbuild.OnResolveResult | null> => {
          const result = await build.resolve(args.path, {
            kind: args.kind,
            resolveDir: args.resolveDir,
            importer: args.importer,
            pluginData: { [NATIVE_RESOLVE]: true }
          })
          if (result.errors.length > 0 || !result.path || result.external) return null
          if (!isInsideDir(projectDir, result.path)) return null
          if (result.path.split(sep).includes('node_modules')) return null
          return { path: result.path, namespace: result.namespace, suffix: result.suffix }
        }
        build.onResolve({ filter: /^[^./]/ }, async (args) => {
          if (args.kind === 'entry-point' || args.namespace !== 'file') return undefined
          if (ABSOLUTE_IMPORT.test(args.path) || args.pluginData?.[NATIVE_RESOLVE]) return undefined
          // CSS 的 url(…)（图片、字体、data:、#片段）照旧交给 esbuild，只是不许走到组件目录外面（`url(a/../../x.png)`）
          if (args.kind === 'url-token') return refuseNativeEscape(build, args, projectDir)
          // 库内部的 import（它的依赖、包内子路径）：只许落在 vendor 里
          if (inVendor(args.importer)) return resolveInVendor(args.path, args.resolveDir, args.kind)
          // 从网址拿代码或样式表：不收 —— 组件得能离线，网上来的代码还会带着组件读本机文件的权限跑
          if (URL_SPECIFIER.test(args.path)) {
            return importError(
              `A widget cannot import from a URL ("${args.path}"). Use the libraries ShuviX ships: ${widgetLibraryNames()}.`
            )
          }
          // CSS 的 `@import "x.css"`：esbuild 先当相对路径找
          if (args.kind === 'import-rule') {
            const local = resolveRelativeImport(`./${args.path}`, args.importer, projectDir)
            if (local) return local
          }

          const hint = blockedImportHint(args.path)
          if (hint) return importError(hint)
          const lib = widgetLibraryOf(args.path)
          if (!lib && REACT_PACKAGES.has(packageNameOf(args.path))) {
            return importError(
              `"${args.path}" is not available in widgets. From React's packages a widget can import ${[...SHIPPED_SPECIFIERS].join(', ')}.`
            )
          }
          if (!lib) {
            const local = await resolveLocalAlias(args)
            if (local) return local
            return importError(
              `"${args.path}" is not available in widgets. A widget's screen can import react, react-dom, react-router, shuvix/widget and these libraries: ${widgetLibraryNames()}.`
            )
          }
          if (!existsSync(join(vendorDir, 'node_modules'))) return vendorMissingError(args.path)
          if (lib.served) {
            // 由宿主单独发：留作外部模块（页面的 import map 指到 widget 服务），但文件得真在，否则运行时才 404
            const served = servedFileOf(args.path)
            const file = served && join(vendorDir, 'node_modules', lib.name, served.file)
            if (!file || !isModuleFile(file)) {
              return importError(
                `"${args.path}" is not among the ${lib.name} files ShuviX ships for widgets.${servedHint(lib, args.path)}`
              )
            }
            return { path: args.path, external: true }
          }
          return resolveInVendor(args.path, vendorDir, args.kind)
        })
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
        build.onResolve({ filter: /^\./ }, (args) => {
          if (args.pluginData?.[NATIVE_RESOLVE]) return undefined
          return (
            resolveRelativeImport(args.path, args.importer, projectDir) ??
            refuseNativeEscape(build, args, projectDir)
          )
        })
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
    const start = Date.now()
    // 相对路径 import（resolveDir = 组件目录）：绝对路径在 Windows 上以盘符开头，会被当成裸模块挡掉
    const entry = [
      `import api from ${JSON.stringify('./' + apiFileName)}`,
      `import { __installWidgetRuntime } from '${WIDGET_API_SPECIFIER}'`,
      '__installWidgetRuntime(api)'
    ].join('\n')
    const result = await this.bundle({
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
    if (!result.ok) return { success: false, errors: result.errors, duration: Date.now() - start }
    return {
      success: true,
      outputJS: result.outputFiles[0]?.text ?? '',
      warnings: result.warnings,
      duration: Date.now() - start
    }
  }

  /** 打包项目 */
  async build(entryPoint: string, projectDir: string): Promise<BundleResult> {
    const start = Date.now()
    const result = await this.bundle({
      entryPoints: [entryPoint],
      bundle: true,
      format: 'esm',
      write: false, // 输出到内存
      outdir: 'out', // 虚拟输出目录
      platform: 'browser',
      target: 'es2020',
      // 空白与语法压缩，变量名不动：报错的调用栈还能读。手机远程打开时 bundle 是不压缩直传的
      minifyWhitespace: true,
      minifySyntax: true,
      // 库里的 `process.env.NODE_ENV` 检查（@tanstack、@dnd-kit、dayjs …）在浏览器里没有 process
      define: { 'process.env.NODE_ENV': '"production"' },
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
    if (!result.ok) return { success: false, errors: result.errors, duration: Date.now() - start }

    let outputJS = ''
    let outputCSS = ''
    for (const file of result.outputFiles) {
      if (file.path.endsWith('.js')) outputJS = file.text
      else if (file.path.endsWith('.css')) outputCSS = file.text
    }
    return {
      success: true,
      outputJS,
      outputCSS,
      warnings: result.warnings,
      duration: Date.now() - start
    }
  }
}
