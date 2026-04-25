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
const outdir = resolve(__dirname, '../resources/bundler/deps')

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
export { createPortal, flushSync, unstable_batchedUpdates } from 'react-dom';
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

// ── 打包 Spectacle 为独立 ESM 文件（externalize react 避免双实例） ──

const spectacleWrapper = `
export {
  Deck, DeckContext, Slide, SlideContext, SlideLayout,
  Heading, Text, FitText, CodeSpan, Quote, Link,
  FlexBox, Grid, Box, Image, FullSizeImage,
  UnorderedList, OrderedList, ListItem,
  Table, TableHeader, TableBody, TableRow, TableCell,
  Appear, Stepper,
  Notes,
  CodePane, codePaneThemes,
  Markdown, MarkdownSlide, MarkdownSlideSet,
  DefaultTemplate, SpectacleLogo,
  AnimatedProgress, Progress, FullScreen, CommandBar,
  defaultTheme, defaultTransition, fadeTransition, slideTransition,
  indentNormalizer, removeNotes, isolateNotes, mdxComponentMap
} from 'spectacle';
`

console.log('Bundling Spectacle ESM bundle...\n')

// Spectacle 的部分依赖（styled-components 等）含 CJS require("react") 调用。
// platform: 'browser' 会生成 __require shim，在浏览器中对 external 模块的
// require() 调用会抛出 "Dynamic require not supported" 错误。
// 解决方案：用 esbuild plugin 在 CJS 的 require("react") 调用时提供 ESM re-export，
// 确保 spectacle bundle 内部所有 react 引用都走 ESM import。
await build({
  stdin: {
    contents: spectacleWrapper,
    resolveDir: resolve(__dirname, '..'),
    loader: 'js'
  },
  bundle: true,
  format: 'esm',
  outfile: resolve(outdir, 'spectacle-all.esm.js'),
  platform: 'browser',
  target: 'es2020',
  minify: true,
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  define: {
    'process.env.NODE_ENV': '"production"'
  },
  logLevel: 'info',
  // 为 CJS require("react") 注入一个 ESM 兼容垫片
  // 覆盖 esbuild 的 __require shim，让它返回 ESM import 的结果
  banner: {
    js: [
      'import __REACT_ESM__ from "react";',
      'import __REACT_DOM_ESM__ from "react-dom";',
      'import * as __JSX_RUNTIME_ESM__ from "react/jsx-runtime";',
      'var require = (function(origRequire) {',
      '  var mods = { "react": __REACT_ESM__, "react-dom": __REACT_DOM_ESM__, "react/jsx-runtime": __JSX_RUNTIME_ESM__ };',
      '  return function(id) {',
      '    if (mods[id]) return mods[id];',
      '    if (typeof origRequire === "function") return origRequire(id);',
      '    throw new Error("Cannot require " + id);',
      '  };',
      '})(typeof require !== "undefined" ? require : undefined);'
    ].join('\n')
  }
})

console.log('  ✓ spectacle-all.esm.js\n')

// 写入 manifest — 运行时 plugin 用来知道哪些 bare import 需要拦截
const manifest = {
  shipped: [
    'react',
    'react/jsx-runtime',
    'react-dom',
    'react-dom/client',
    'react-router',
    'react-router-dom',
    'spectacle'
  ],
  bundles: {
    'react-all': 'react-all.esm.js',
    'react-router': 'react-router.esm.js',
    'spectacle-all': 'spectacle-all.esm.js'
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
