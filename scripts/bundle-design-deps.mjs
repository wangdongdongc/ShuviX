/**
 * 构建时脚本：将 React 全家桶打包为一个完整的 ESM bundle
 * 供 esbuild-wasm 在运行时作为预置依赖使用，实现完全离线打包
 *
 * 设计决策：
 * - 将 react + react/jsx-runtime + react-dom + react-dom/client 打包为 **单个** ESM 文件
 * - 避免跨文件 CJS require 导致的 ESM 兼容问题和 React 多实例问题
 * - 运行时 esbuild plugin 通过 namespace + onLoad 为不同的 import path
 *   返回对应的 re-export wrapper，全部指向同一个底层 bundle
 *
 * Usage: node scripts/bundle-design-deps.mjs
 */

import { build } from 'esbuild'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { mkdirSync, writeFileSync, copyFileSync } from 'fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const outdir = resolve(__dirname, '../resources/design-deps')

mkdirSync(outdir, { recursive: true })

// ── 打包 react 全家桶为单个 ESM 文件 ──

const allInOneWrapper = `
// React core
export { default as React } from 'react';
export {
  Children, Component, Fragment, Profiler, PureComponent, StrictMode,
  Suspense, cloneElement, createContext, createElement, createRef,
  forwardRef, isValidElement, lazy, memo, cache,
  startTransition, use, useActionState, useCallback, useContext,
  useDebugValue, useDeferredValue, useEffect, useId,
  useImperativeHandle, useInsertionEffect, useLayoutEffect, useMemo,
  useOptimistic, useReducer, useRef, useState, useSyncExternalStore,
  useTransition, version
} from 'react';

// JSX runtime
export { jsx, jsxs, Fragment as _Fragment } from 'react/jsx-runtime';
import _jsxRuntime from 'react/jsx-runtime';
export { _jsxRuntime };

// ReactDOM
export { createPortal, flushSync } from 'react-dom';
import _reactDOM from 'react-dom';
export { _reactDOM };

// ReactDOM/client
export { createRoot, hydrateRoot } from 'react-dom/client';
import _reactDOMClient from 'react-dom/client';
export { _reactDOMClient };
`

console.log('Bundling React all-in-one ESM bundle...\n')

await build({
  stdin: {
    contents: allInOneWrapper,
    resolveDir: resolve(__dirname, '..'),
    loader: 'js'
  },
  bundle: true,
  format: 'esm',
  outfile: resolve(outdir, 'react-all.esm.js'),
  platform: 'browser',
  target: 'es2020',
  minify: true,
  define: {
    'process.env.NODE_ENV': '"production"'
  },
  logLevel: 'info'
})

console.log('  ✓ react-all.esm.js\n')

// ── 打包 react-router 为独立 ESM 文件（externalize react 避免双实例） ──

const routerWrapper = `
export {
  createHashRouter, createBrowserRouter, createMemoryRouter,
  RouterProvider, Outlet, Link, NavLink, Navigate,
  useNavigate, useLocation, useParams, useSearchParams,
  useLoaderData, useRouteError, useOutletContext, useMatches,
  redirect, matchPath
} from 'react-router';
`

console.log('Bundling React Router ESM bundle...\n')

await build({
  stdin: {
    contents: routerWrapper,
    resolveDir: resolve(__dirname, '..'),
    loader: 'js'
  },
  bundle: true,
  format: 'esm',
  outfile: resolve(outdir, 'react-router.esm.js'),
  platform: 'browser',
  target: 'es2020',
  minify: true,
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  define: {
    'process.env.NODE_ENV': '"production"'
  },
  logLevel: 'info'
})

console.log('  ✓ react-router.esm.js\n')

// 写入 manifest — 运行时 plugin 用来知道哪些 bare import 需要拦截
const manifest = {
  shipped: [
    'react',
    'react/jsx-runtime',
    'react-dom',
    'react-dom/client',
    'react-router',
    'react-router-dom'
  ],
  bundles: {
    'react-all': 'react-all.esm.js',
    'react-router': 'react-router.esm.js'
  }
}
writeFileSync(resolve(outdir, 'manifest.json'), JSON.stringify(manifest, null, 2))
console.log('  ✓ manifest.json')

// ── 复制 Tailwind CSS browser runtime ──

const tailwindSrc = resolve(__dirname, '../node_modules/@tailwindcss/browser/dist/index.global.js')
const tailwindDst = resolve(outdir, 'tailwindcss-browser.js')
copyFileSync(tailwindSrc, tailwindDst)
console.log('  ✓ tailwindcss-browser.js (copied from @tailwindcss/browser)')

console.log('\nDone!')
