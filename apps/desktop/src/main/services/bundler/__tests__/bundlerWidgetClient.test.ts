/**
 * 界面打包里的 `shuvix/widget`（组件调自己 API 的客户端，设计稿 docs/widget-tool-design.md §4、§21）与随包的
 * `widget.esm.js`。真的 esbuild-wasm（与 bundlerBuildApi.test.ts 同样的搭法，afterAll 里 stop）；资源目录是仓库里的
 * `resources/bundler`。每条用例在临时目录里搭一个组件。
 *
 *   WC-70 界面入口与 components/List.tsx 都 `import { createClient } from 'shuvix/widget'`、用 use 与 call → 成功；
 *         产物里没有剩下的裸 import（react、react-dom、shuvix/widget）
 *   WC-71 只有一份 React（React 内部的标记出现次数与 react-all.esm.js 本身一样，不翻倍）；客户端只打进一次
 *         （两处 import，`The request failed.` 只出现一次）
 *   WC-72 产物放进手搭的 JSDOM（<base href="/w/abc-def/">、假 fetch / EventSource）里跑：界面渲染出取到的行
 *         （第二份 React 会抛「Invalid hook call」）；fetch 收到的是 `api/listBooks`，事件流是 `sse`
 *   WC-73 `import type Api from './api'` + `createClient<typeof Api>()`：api.ts 用 widget-api 与 zod → 成功，
 *         handler 里的标记字符串不在产物里
 *   WC-74 钉住：`import Api from './api'`（没写 type）只当 `typeof Api` 用 → 照样成功（esbuild 丢掉只当类型用的 import）
 *   WC-75 `import Api from './api'` 当值用 → 失败，错误说明 `"shuvix/widget-api" runs on ShuviX's side` 并给出
 *         `import type Api from './api'`
 *   WC-76 界面直接 import zod / shuvix/widget-api → 同样的说明，点名那个模块
 *   WC-77 组件的 tsconfig 开了 verbatimModuleSyntax，只当类型用的 `import Api` → 失败并给出说明（少写 type 的真实情形）
 *   WC-78 长得像的 `shuvix/widgets`、`shuvix/widget/x` → 普通的 Could not resolve；既不是客户端，也不是那句说明
 *   WC-80 用 bundle-widget-api.mjs 的选项（react 外置）重打 widgetClient.ts → 与 deps/widget.esm.js 逐字节相同
 *   WC-81 随包的 widget.esm.js：唯一的 import 是 react；没有 React 内部的东西；导出正好是 createClient、WidgetError、
 *         themeColor 与 useTheme；它从 react 取的每个名字（useSyncExternalStore …）随包的 react-all.esm.js 都导出
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { build as nativeBuild } from 'esbuild'
import { stop as stopEsbuild } from 'esbuild-wasm'
import { JSDOM } from 'jsdom'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BundlerService } from '../bundlerService'

/** apps/desktop */
const DESKTOP_DIR = resolve(__dirname, '../../../../..')
const RESOURCES = join(DESKTOP_DIR, 'resources/bundler')
const DEPS_DIR = join(RESOURCES, 'deps')
const CLIENT_SOURCE = join(DESKTOP_DIR, 'src/renderer/src/widgetClient/widgetClient.ts')

/** React 自己的一个稳定的内部字符串：出现次数翻倍 = 打进了两份 React */
const REACT_MARKER = 'react.transitional.element'
const API_SIDE = `runs on ShuviX's side, not in the widget's screen`

const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
const bundler = new BundlerService((p) => join(RESOURCES, p), silentLogger)

let root = ''
let widgetDir = ''

function put(name: string, content: string): string {
  const full = resolve(widgetDir, name)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
  return full
}

const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1

/** 产物里剩下的裸 import（`from"react"`、`from 'react-dom/client'`、`import "shuvix/widget"` …） */
const BARE_IMPORT = /(?:\bfrom|\bimport)\s*["'](?:react|react-dom|shuvix\/widget)(?:\/[^"']*)?["']/

/** 界面入口：列出书（use），子组件里加书（call） */
const INDEX_TSX = `import { createRoot } from 'react-dom/client'
import { createClient } from 'shuvix/widget'
import { List } from './components/List'

const api = createClient()

function App() {
  const { data, loading, error } = api.use('listBooks', { status: 'want' })
  if (error) return <p className="error">{error.code}</p>
  if (loading && !data) return <p>loading</p>
  return <List rows={(data as { title: string }[]) ?? []} />
}

const el = document.getElementById('root')
if (el) createRoot(el).render(<App />)
`

const LIST_TSX = `import { createClient } from 'shuvix/widget'

const api = createClient()

export function List({ rows }: { rows: { title: string }[] }) {
  return (
    <ul>
      {rows.map((r) => (
        <li key={r.title} onClick={() => void api.call('addBook', { title: r.title })}>
          {r.title}
        </li>
      ))}
    </ul>
  )
}
`

/** api.ts：handler 里有一个只该在 ShuviX 那边出现的标记 */
const MARKER = 'API_SIDE_ONLY_MARKER_7f3a'
const API_TS = `import { defineApi, op } from 'shuvix/widget-api'
import { z } from 'zod'

export default defineApi({
  listBooks: op.read({
    description: 'List books.',
    input: z.object({ status: z.enum(['want', 'done']).optional() }),
    output: z.array(z.object({ title: z.string() })),
    handler: async (_input, ctx) => {
      ctx.log('${MARKER}')
      return ctx.db.sql<{ title: string }>\`SELECT title FROM books\`
    }
  })
})
`

/** 界面入口以某种方式 import api.ts（`importLine` 与用法由用例给） */
const screenUsingApi = (importLine: string, usage: string): string => `${importLine}
import { createClient } from 'shuvix/widget'

const api = createClient<typeof Api>()
${usage}
export function useBooks() {
  return api.use('listBooks', {})
}
`

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'shuvix-widget-client-'))
  widgetDir = join(root, 'w-client')
  mkdirSync(widgetDir)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

afterAll(async () => {
  await stopEsbuild()
})

async function buildScreen(entry = 'index.tsx'): Promise<{
  success: boolean
  outputJS?: string
  errors?: string[]
}> {
  return bundler.build(join(widgetDir, entry), widgetDir)
}

// ────────────────────────────── 打包 ──────────────────────────────

describe('WC-70..72 界面里的 shuvix/widget', () => {
  it('WC-70 两个文件都 import shuvix/widget → 成功；没有剩下的裸 import', async () => {
    put('index.tsx', INDEX_TSX)
    put('components/List.tsx', LIST_TSX)

    const r = await buildScreen()

    expect(r.errors).toBeUndefined()
    expect(r.success).toBe(true)
    const js = r.outputJS ?? ''
    expect(js).not.toMatch(BARE_IMPORT)
    // 客户端确实打进来了（不是被当作外部模块留着）
    expect(js).toContain('api/')
    expect(js).toContain('sse')
  })

  it('WC-71 只有一份 React；客户端只打进一次', async () => {
    put('index.tsx', INDEX_TSX)
    put('components/List.tsx', LIST_TSX)

    const r = await buildScreen()
    expect(r.success).toBe(true)
    const js = r.outputJS ?? ''

    const reactAll = readFileSync(join(DEPS_DIR, 'react-all.esm.js'), 'utf8')
    expect(count(reactAll, REACT_MARKER)).toBeGreaterThan(0)
    expect(count(js, REACT_MARKER)).toBe(count(reactAll, REACT_MARKER))
    expect(count(js, 'The request failed.')).toBe(1)
  })

  it('WC-72 产物在 JSDOM 里跑：渲染出取到的行；fetch 收到 `api/listBooks`，事件流是 `sse`', async () => {
    put('index.tsx', INDEX_TSX)
    put('components/List.tsx', LIST_TSX)
    const r = await buildScreen()
    expect(r.success).toBe(true)
    const js = r.outputJS ?? ''
    // 当脚本执行：不能有 ESM 语法留下
    expect(js).not.toMatch(/^\s*(import|export)\b/m)
    expect(js).not.toContain('import.meta')

    const dom = new JSDOM(
      '<!doctype html><html><head><base href="/w/abc-def/"></head><body><div id="root"></div></body></html>',
      { url: 'http://127.0.0.1:1/w/abc-def/', runScripts: 'outside-only' }
    )
    const win = dom.window as unknown as Record<string, unknown> & {
      eval: (code: string) => unknown
      document: Document
    }
    const fetched: Array<{ url: string; body: unknown }> = []
    win.fetch = async (url: string, init: { body?: unknown }) => {
      fetched.push({ url, body: init?.body })
      return {
        ok: true,
        status: 200,
        json: async () => ({ result: [{ title: 'Dune' }, { title: 'Emma' }] })
      }
    }
    const sources: string[] = []
    win.EventSource = class {
      constructor(url: string) {
        sources.push(url)
      }
      addEventListener(): void {}
      removeEventListener(): void {}
      close(): void {}
    }
    const errors: unknown[] = []
    dom.window.addEventListener('error', (e) => errors.push(e.error ?? e.message))

    try {
      win.eval(js)
      const rootEl = win.document.getElementById('root')!
      const deadline = Date.now() + 5000
      while (!rootEl.textContent?.includes('Emma') && Date.now() < deadline) {
        await new Promise((res) => setTimeout(res, 20))
      }
      expect(errors).toEqual([])
      expect(Array.from(rootEl.querySelectorAll('li'), (li) => li.textContent)).toEqual([
        'Dune',
        'Emma'
      ])
      expect(fetched).toEqual([{ url: 'api/listBooks', body: '{"status":"want"}' }])
      // 相对地址按页面的 <base> 落到这个组件自己的路由
      expect(new URL(fetched[0].url, win.document.baseURI).pathname).toBe(
        '/w/abc-def/api/listBooks'
      )
      expect(sources).toEqual(['sse'])
    } finally {
      dom.window.close()
    }
  })
})

describe('WC-73..78 界面只取 API 的类型', () => {
  it('WC-73 `import type Api` + createClient<typeof Api>() → 成功；api.ts 的代码不进产物', async () => {
    put('api.ts', API_TS)
    put('index.tsx', screenUsingApi(`import type Api from './api'`, ''))

    const r = await buildScreen()

    expect(r.errors).toBeUndefined()
    expect(r.success).toBe(true)
    expect(r.outputJS).not.toContain(MARKER)
    expect(r.outputJS).not.toContain('defineApi')
  })

  it('WC-74 钉住：没写 type 但只当 `typeof Api` 用 → 照样成功，api.ts 不进产物', async () => {
    put('api.ts', API_TS)
    put('index.tsx', screenUsingApi(`import Api from './api'`, ''))

    const r = await buildScreen()

    expect(r.errors).toBeUndefined()
    expect(r.success).toBe(true)
    expect(r.outputJS).not.toContain(MARKER)
  })

  it('WC-75 `import Api from "./api"` 当值用 → 失败，说明 widget-api 在 ShuviX 那边、给出 import type 的写法', async () => {
    put('api.ts', API_TS)
    put('index.tsx', screenUsingApi(`import Api from './api'`, 'console.log(Api)\n'))

    const r = await buildScreen()

    expect(r.success).toBe(false)
    expect(r.outputJS).toBeUndefined()
    const text = (r.errors ?? []).join('\n')
    expect(text).toContain(`"shuvix/widget-api" ${API_SIDE}`)
    expect(text).toContain(`import type Api from './api'`)
    expect(text).toContain('createClient')
  })

  it.each(['zod', 'shuvix/widget-api'])(
    'WC-76 界面直接 import %j（当值用）→ 同样的说明，点名那个模块',
    async (spec) => {
      const name = spec === 'zod' ? 'z' : 'op'
      put('index.tsx', `import { ${name} } from ${JSON.stringify(spec)}\nconsole.log(${name})\n`)

      const r = await buildScreen()

      expect(r.success).toBe(false)
      const text = (r.errors ?? []).join('\n')
      expect(text).toContain(`"${spec}" ${API_SIDE}`)
      expect(text).toContain(`import type Api from './api'`)
    }
  )

  it('WC-77 组件 tsconfig 开了 verbatimModuleSyntax：只当类型用的 `import Api` 也失败，并给出说明', async () => {
    put('tsconfig.json', JSON.stringify({ compilerOptions: { verbatimModuleSyntax: true } }))
    put('api.ts', API_TS)
    put('index.tsx', screenUsingApi(`import Api from './api'`, ''))

    const r = await buildScreen()

    expect(r.success).toBe(false)
    const text = (r.errors ?? []).join('\n')
    expect(text).toContain(`"shuvix/widget-api" ${API_SIDE}`)
    expect(text).toContain(`import type Api from './api'`)

    // 对照：同一个 tsconfig 下写了 type 就成功
    put('index.tsx', screenUsingApi(`import type Api from './api'`, ''))
    const fixed = await buildScreen()
    expect(fixed.errors).toBeUndefined()
    expect(fixed.success).toBe(true)
  })

  it.each(['shuvix/widgets', 'shuvix/widget/x'])(
    'WC-78 长得像的 %j → 普通的 Could not resolve，不是客户端、也不是那句说明',
    async (spec) => {
      put(
        'index.tsx',
        `import { createClient } from ${JSON.stringify(spec)}\nconsole.log(createClient)\n`
      )

      const r = await buildScreen()

      expect(r.success).toBe(false)
      const text = (r.errors ?? []).join('\n')
      expect(text).toContain(`Could not resolve "${spec}"`)
      expect(text).not.toContain(API_SIDE)
    }
  )
})

// ────────────────────────────── 随包的 widget.esm.js ──────────────────────────────

describe('WC-80..81 随包的 widget.esm.js', () => {
  it('WC-80 用 bundle-widget-api.mjs 的选项重打 widgetClient.ts → 逐字节相同', async () => {
    // 选项抄自 scripts/bundle-widget-api.mjs 的 `common` + widget.esm.js 那一次（只把 write 关掉、日志静音）
    const result = await nativeBuild({
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      target: 'es2020',
      minify: true,
      mainFields: ['module', 'main'],
      conditions: ['import', 'default'],
      legalComments: 'none',
      logLevel: 'silent',
      entryPoints: [CLIENT_SOURCE],
      external: ['react'],
      outfile: join(DEPS_DIR, 'widget.esm.js'),
      write: false
    })
    expect(result.outputFiles).toHaveLength(1)
    const rebuilt = Buffer.from(result.outputFiles[0].contents)
    const shipped = readFileSync(join(DEPS_DIR, 'widget.esm.js'))
    expect(rebuilt.toString('utf8')).toBe(shipped.toString('utf8'))
    expect(rebuilt.equals(shipped)).toBe(true)
  })

  it('WC-81 唯一的 import 是 react；没有 React 内部；导出正好是 createClient、WidgetError、themeColor、useTheme', () => {
    const js = readFileSync(join(DEPS_DIR, 'widget.esm.js'), 'utf8')

    const sources = [...js.matchAll(/\bfrom\s*["']([^"']+)["']/g)].map((m) => m[1])
    expect(sources).toEqual(['react'])
    expect(js).not.toMatch(/\bimport\s*["']/)
    expect(js).not.toContain(REACT_MARKER)
    expect(js).not.toContain('__CLIENT_INTERNALS')

    const exportClause = /export\s*\{([^}]*)\}\s*;?\s*$/.exec(js)
    expect(exportClause).not.toBeNull()
    const names = exportClause![1]
      .split(',')
      .map((part) =>
        part
          .trim()
          .split(/\s+as\s+/)
          .pop()
      )
      .sort()
    expect(names).toEqual(['WidgetError', 'createClient', 'themeColor', 'useTheme'])
    expect(count(js, 'export')).toBe(1)
  })

  it('WC-81 它从 react 取的每个名字，随包的 react-all.esm.js 都导出（缺一个就是打包时的 No matching export）', () => {
    const js = readFileSync(join(DEPS_DIR, 'widget.esm.js'), 'utf8')
    const react = readFileSync(join(DEPS_DIR, 'react-all.esm.js'), 'utf8')

    const importClause = /import\s*\{([^}]*)\}\s*from\s*["']react["']/.exec(js)
    expect(importClause).not.toBeNull()
    const imported = importClause![1]
      .split(',')
      .map((part) => part.trim().split(/\s+as\s+/)[0])
      .filter(Boolean)
    expect(imported).toContain('useSyncExternalStore')

    const exported = new Set(
      [...react.matchAll(/export\s*\{([^}]*)\}/g)].flatMap((m) =>
        m[1].split(',').map((part) =>
          part
            .trim()
            .split(/\s+as\s+/)
            .pop()
        )
      )
    )
    for (const name of imported) expect(exported.has(name), name).toBe(true)
  })
})
