/**
 * BundlerService — esbuild-wasm 打包服务
 *
 * 封装所有 esbuild-wasm 复杂性：
 * - Lazy 初始化 esbuild-wasm（加载 .wasm 二进制）
 * - 自定义 plugin 将 bare import 映射到预置 ESM bundle
 * - 提供 build API
 */

import * as esbuild from 'esbuild-wasm'
import * as childProcess from 'child_process'
import { resolve, dirname } from 'path'
import { existsSync, readFileSync, statSync } from 'fs'
import type { Logger } from './types'

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
      const cp = childProcess as { spawn: typeof childProcess.spawn }
      const originalSpawn = cp.spawn
      cp.spawn = ((
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
      }) as typeof childProcess.spawn

      try {
        await esbuild.initialize({})
      } finally {
        cp.spawn = originalSpawn
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
