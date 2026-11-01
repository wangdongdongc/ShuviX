/**
 * 界面打包（`BundlerService.build`）里小组件可以 import 的库（widgetLibs.json）：从 vendor 按包解析、能摇树、three 留给
 * 页面的 import map、别的裸模块一律报错；以及 `buildApi` 不受影响。真的 esbuild-wasm（与 bundlerWidgetClient.test.ts
 * 同样的搭法，afterAll 里 stop）；资源目录是仓库里的 `resources/bundler`（vendor 是 postinstall 拷好的那份，没有就
 * 失败并说 run npm install）。每条用例在临时目录里搭一个组件；假 vendor 的用例用
 * `new BundlerService((p) => p === 'vendor' ? <假 vendor> : …)`。
 *
 * 临时目录在 macOS 上经 /var → /private/var 的符号链接：esbuild 交回来的是真实路径，所以每条假 vendor 的用例同时
 * 走到了 `inVendor` 的 realVendorDir 那一支（B-5d 再显式地经一层符号链接）。这是有意的，别 realpath 掉。
 *
 *   B-1   每个库一个组件，用技能教的写法 import 并用上 → 成功；除 three 外产物里没有剩下它的裸 import（打进去了），
 *         three 剩 `from"three"`（外部模块）
 *   B-2   lucide 摇树：三个图标正好三次 createLucideIcon、没有别的图标；比只用 React 的基线多不到 40 KB
 *   B-3   只有一份 React：lucide、@dnd-kit 三件、@tanstack/react-virtual 一起用，React 的内部标记次数与 react-all 一样
 *   B-3r  B-3 的产物在 JSDOM 里跑：三行可排序的、一个 lucide 图标、一个虚拟列表；没有错误（Invalid hook call、
 *         process is not defined）
 *   B-4   表里的库只从 vendor 解析：组件目录里与它上面的 node_modules/dayjs 都不用
 *   B-4b  组件上面装着的不认识的包 → 不可用，那份文件不进产物
 *   B-4c  库里没拷进 vendor 的深路径（lucide-react/dist/cjs/…）→ 失败、点名它（开发检出里说 resolved outside）
 *   B-4d  库里没随包的资源（highlight.js/styles/github.css）→ Could not resolve，不拿仓库里那份
 *   B-5   假 vendor：库内部 import 一个只在 vendor 上面才有的包 → `resolved outside ShuviX's widget libraries`
 *   B-5b  vendor 里也有它 → 成功，两个标记都在
 *   B-5c  嵌套的版本优先
 *   B-5d  vendor 经符号链接给出 → B-5b 照样成功（真实路径与链接路径不一致不误报）
 *   B-6   库里相对 import 一个不存在的文件 → esbuild 自己的 Could not resolve，不是「组件目录之外」
 *   B-7   不可用：left-pad、fs、node:fs、three-stdlib、shuvix → 列出可用库的那句；`https://…` 是带协议的
 *         specifier → 「不能从网址 import」（带 scheme 的都是这句，`node:` 除外）
 *   B-8   React 包的别的子路径 → 「From React's packages a widget can import …」
 *   B-9   挡下的 `highlight.js`（静态、动态、export *）→ 错误正文就是表里那句
 *   B-9b  highlight.js/lib/core + 两个语言 → 成功，只带那两个语言
 *   B-9c  highlight.js/lib/common → 照样成功（F-9 裁决：只挡裸的 highlight.js）
 *   B-10  three 外置：three、OrbitControls、GLTFLoader 都留作外部模块；three 本身不进产物；比基线多不到 20 KB
 *   B-10b `await import('three')` → 留着 `import("three")`
 *   B-11  没随包的 addon → 「not among the three files … Available: …」，清单排好序、以 three 开头、每项 vendor 里都有
 *   B-12  别的写法（不带 .js、examples/jsm 直写、build 直写、webgpu、addons/ 本身）→ B-11 的形状，不内联那 1 MB
 *   B-12e 带 `..` 的 addon 路径 → B-11 的形状（F-3）
 *   B-13  process.env.NODE_ENV 换成 "production"：开发分支被摇掉，产物里一处 process.env 都没有
 *   B-14  压缩不改名字：`function keepThisName(a){return a+1}`
 *   B-15  vendor 目录不存在：只用 React 照样成功；dayjs、three → 「libraries are missing」；left-pad → B-7；
 *         highlight.js → 表里那句（F-4：three 也是 missing 那句）
 *   B-16  vendor 目录在、没有 node_modules → missing 那句
 *   B-17  uplot 的 CSS，从 TSX import 与在组件 .css 里 @import 两种 → 成功，outputCSS 带 .uplot
 *   B-18  组件 CSS 的 url(data:…)、url(#grad)、url(https://…) → 成功，原样留着（F-2）
 *   B-18c CSS `@import "x.css"` 先按样式表旁边的文件找；`@import "https://…"` 与 JS 的 `import 'https://…'` →
 *         「不能从网址 import」
 *   B-19  动态 import 一个打进去的库 → 内联，不剩 import("papaparse")
 *   B-20  JSDOM 里跑：papaparse、dayjs 插件、yaml、fuse.js、diff、d3、marked + DOMPurify、qrcode 的结果都对
 *   B-21  d3 摇树：只用 scaleLinear，力导向、地理、等高线都不在
 *   B-22  chart.js 按需注册比 chart.js/auto 小
 *   B-23  组件自己 tsconfig 的 paths 别名：落在组件目录里（不在 node_modules 下）→ 照收；指到外面或组件的
 *         node_modules → 不可用（F-12 裁决）
 *   B-24  bundlerWidgetClient.test.ts 的 WC-70..81 照旧（那边跑）
 *   BA-1  api.ts import 表里的库 → 照旧拒绝（库只给界面）
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { stop as stopEsbuild } from 'esbuild-wasm'
import { JSDOM } from 'jsdom'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BundlerService } from '../bundlerService'
import { WIDGET_LIBRARIES, widgetLibraryNames } from '../widgetLibs'
import table from '../widgetLibs.json'

/** apps/desktop */
const DESKTOP_DIR = resolve(__dirname, '../../../../..')
const RESOURCES = join(DESKTOP_DIR, 'resources/bundler')
const DEPS_DIR = join(RESOURCES, 'deps')
const VENDOR = join(RESOURCES, 'vendor')
const THREE_JSM = join(VENDOR, 'node_modules/three/examples/jsm')

const REACT_MARKER = 'react.transitional.element'
const HLJS_HINT = (table.libraries['highlight.js'] as { blocked: Record<string, string> }).blocked[
  'highlight.js'
]
const NOT_AVAILABLE = (spec: string): string =>
  `"${spec}" is not available in widgets. A widget's screen can import react, react-dom, react-router, shuvix/widget and these libraries: ${widgetLibraryNames()}.`
const FROM_URL = (spec: string): string =>
  `A widget cannot import from a URL ("${spec}"). Use the libraries ShuviX ships: ${widgetLibraryNames()}.`
const REACT_SUBPATH = (spec: string): string =>
  `"${spec}" is not available in widgets. From React's packages a widget can import react, react/jsx-runtime, react-dom, react-dom/client, react-router, react-router-dom.`
const NOT_SHIPPED = (spec: string): string =>
  `"${spec}" is not among the three files ShuviX ships for widgets.`
const MISSING = (vendor: string, spec: string): string =>
  `ShuviX's widget libraries are missing (${vendor}); "${spec}" cannot be bundled. Reinstall ShuviX, or run npm install in a development checkout.`
const OUTSIDE_WIDGET = `is outside this widget's directory`

const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
/**
 * esbuild-wasm 一个进程只能 initialize 一次，所以只有一个 BundlerService；假 vendor 的用例换的是它读到的 vendor 目录
 * （每次 build 都重新取 `getResourcePath('vendor')`），afterEach 换回仓库里的
 */
let vendorOverride: string | null = null
const bundler = new BundlerService(
  (p) => (p === 'vendor' && vendorOverride !== null ? vendorOverride : join(RESOURCES, p)),
  silentLogger
)
const bundlerWithVendor = (vendor: string): BundlerService => {
  vendorOverride = vendor
  return bundler
}

const T = 60_000

let root = ''
let widgetDir = ''

function put(name: string, content: string, base = widgetDir): string {
  const full = resolve(base, name)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
  return full
}

const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1

interface Built {
  success: boolean
  outputJS?: string
  outputCSS?: string
  errors?: string[]
}

async function build(
  files: Record<string, string>,
  b = bundler,
  entry = 'index.tsx'
): Promise<Built> {
  for (const [name, content] of Object.entries(files)) put(name, content)
  return b.build(join(widgetDir, entry), widgetDir)
}

/** esbuild 格式化好的错误 → 每条的正文（第一行去掉 `✘ [ERROR] ` 与 ` [plugin …]`） */
function messages(r: Built): string[] {
  return (r.errors ?? []).map((e) =>
    e
      .split('\n')[0]
      .replace(/^✘ \[ERROR\] /, '')
      .replace(/ \[plugin [^\]]+\]$/, '')
  )
}

function expectFails(r: Built, text: string): void {
  expect(r.success, (r.errors ?? []).join('\n')).toBe(false)
  expect(r.outputJS).toBeUndefined()
  expect(messages(r)).toContain(text)
}

function expectOk(r: Built): { js: string; css: string } {
  expect(r.errors, (r.errors ?? []).join('\n')).toBeUndefined()
  expect(r.success).toBe(true)
  return { js: r.outputJS ?? '', css: r.outputCSS ?? '' }
}

function requireVendor(): void {
  if (!existsSync(join(VENDOR, 'manifest.json'))) {
    throw new Error(`${VENDOR}/manifest.json is missing: run npm install`)
  }
}

/** 产物里剩下的对 `name`（含子路径）的 import */
const bareImportOf = (name: string): RegExp =>
  new RegExp(
    `(?:\\bfrom|\\bimport)\\s*\\(?\\s*["']${name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(?:/[^"']*)?["']`
  )

/** 只用 React 的组件（大小基线） */
const REACT_ONLY = `import { createRoot } from 'react-dom/client'
import { useState } from 'react'

function App() {
  const [n, setN] = useState(0)
  return <button onClick={() => setN(n + 1)}>{n}</button>
}

const el = document.getElementById('root')
if (el) createRoot(el).render(<App />)
`

/** React 基线之上加一段：`imports` 放在文件头，`body` 放进 App 的返回值前 */
const reactWith = (imports: string, body: string, jsx = '<p />'): string => `${imports}
import { createRoot } from 'react-dom/client'
import { useState } from 'react'

function App() {
  const [n, setN] = useState(0)
  ${body}
  return <div><button onClick={() => setN(n + 1)}>{n}</button>${jsx}</div>
}

const el = document.getElementById('root')
if (el) createRoot(el).render(<App />)
`

let baselineLength = 0
async function baseline(): Promise<number> {
  if (baselineLength > 0) return baselineLength
  const dir = mkdtempSync(join(tmpdir(), 'shuvix-widget-libs-baseline-'))
  try {
    writeFileSync(join(dir, 'index.tsx'), REACT_ONLY)
    const r = await bundler.build(join(dir, 'index.tsx'), dir)
    expect(r.success).toBe(true)
    baselineLength = (r.outputJS ?? '').length
    return baselineLength
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** WC-72 的 JSDOM 跑法：脚本跑在 window 里，收集 error 事件 */
function runInJsdom(js: string): {
  win: Window & Record<string, unknown>
  errors: unknown[]
  close: () => void
} {
  expect(js).not.toMatch(/^\s*(import|export)\b/m)
  const dom = new JSDOM(
    '<!doctype html><html><head><base href="/w/abc-def/"></head><body><div id="root"></div></body></html>',
    { url: 'http://127.0.0.1:1/w/abc-def/', runScripts: 'outside-only', pretendToBeVisual: true }
  )
  const win = dom.window as unknown as Window &
    Record<string, unknown> & { eval: (c: string) => unknown }
  // JSDOM 的 window 没有 TextEncoder（qrcode 用它）；浏览器里有
  win.TextEncoder = TextEncoder
  const errors: unknown[] = []
  dom.window.addEventListener('error', (e) => errors.push(e.error ?? e.message))
  const originalError = dom.window.console.error
  dom.window.console.error = (...args: unknown[]): void => {
    errors.push(args.map(String).join(' '))
    originalError.apply(dom.window.console, args)
  }
  try {
    win.eval(js)
  } catch (e) {
    errors.push(e)
  }
  return { win, errors, close: () => dom.window.close() }
}

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'shuvix-widget-libs-'))
  widgetDir = join(root, 'w-libs')
  mkdirSync(widgetDir)
})

afterEach(() => {
  vendorOverride = null
  rmSync(root, { recursive: true, force: true })
})

afterAll(async () => {
  await stopEsbuild()
})

// ────────────────────────────── 每个库都打得进 ──────────────────────────────

/** 技能（references/libraries.md）教的写法，以及一句用上它的代码 */
const CANONICAL: Record<string, { imports: string; use: string }> = {
  'lucide-react': {
    imports: `import { Plus, Trash2 } from 'lucide-react'`,
    use: 'console.log(Plus, Trash2)'
  },
  'chart.js': {
    imports: `import { Chart, LineController, LineElement, PointElement, LinearScale, CategoryScale } from 'chart.js'`,
    use: 'Chart.register(LineController, LineElement, PointElement, LinearScale, CategoryScale)'
  },
  uplot: {
    imports: `import uPlot from 'uplot'\nimport 'uplot/dist/uPlot.min.css'`,
    use: 'console.log(uPlot)'
  },
  d3: {
    imports: `import { scaleLinear, line, select } from 'd3'`,
    use: 'console.log(scaleLinear, line, select)'
  },
  papaparse: { imports: `import Papa from 'papaparse'`, use: 'console.log(Papa.parse)' },
  dayjs: { imports: `import dayjs from 'dayjs'`, use: 'console.log(dayjs())' },
  marked: { imports: `import { marked } from 'marked'`, use: 'console.log(marked)' },
  dompurify: { imports: `import DOMPurify from 'dompurify'`, use: 'console.log(DOMPurify)' },
  '@dnd-kit/core': {
    imports: `import { DndContext } from '@dnd-kit/core'`,
    use: 'console.log(DndContext)'
  },
  '@dnd-kit/sortable': {
    imports: `import { SortableContext, useSortable } from '@dnd-kit/sortable'`,
    use: 'console.log(SortableContext, useSortable)'
  },
  '@dnd-kit/utilities': {
    imports: `import { CSS } from '@dnd-kit/utilities'`,
    use: 'console.log(CSS)'
  },
  '@tanstack/react-virtual': {
    imports: `import { useVirtualizer } from '@tanstack/react-virtual'`,
    use: 'console.log(useVirtualizer)'
  },
  'fuse.js': { imports: `import Fuse from 'fuse.js'`, use: 'console.log(new Fuse([]))' },
  diff: {
    imports: `import { diffWords, diffLines } from 'diff'`,
    use: 'console.log(diffWords, diffLines)'
  },
  qrcode: { imports: `import QRCode from 'qrcode'`, use: 'console.log(QRCode.toDataURL)' },
  yaml: {
    imports: `import { parse, stringify } from 'yaml'`,
    use: 'console.log(parse, stringify)'
  },
  'highlight.js': {
    imports: `import hljs from 'highlight.js/lib/core'\nimport javascript from 'highlight.js/lib/languages/javascript'`,
    use: `hljs.registerLanguage('javascript', javascript)`
  },
  three: { imports: `import * as THREE from 'three'`, use: 'console.log(THREE.REVISION)' }
}

describe('B-1 每个库都打得进', () => {
  it('B-1 表里的每个库都有一份教的写法', () => {
    expect(Object.keys(CANONICAL).sort()).toEqual(WIDGET_LIBRARIES.map((l) => l.name).sort())
  })

  it.each(WIDGET_LIBRARIES.map((lib) => lib.name))(
    'B-1 %s → 成功；打进去了（three：留作外部模块）',
    async (name) => {
      requireVendor()
      const { imports, use } = CANONICAL[name]
      const { js } = expectOk(await build({ 'index.tsx': `${imports}\n${use}\n` }))
      if (name === 'three') {
        expect(js).toContain('from"three"')
      } else {
        expect(js).not.toMatch(bareImportOf(name))
        expect(js.length).toBeGreaterThan(200)
      }
    },
    T
  )
})

// ────────────────────────────── 摇树与一份 React ──────────────────────────────

describe('B-2..3 摇树、只有一份 React', () => {
  it(
    'B-2 lucide 只带用到的三个图标，比基线多不到 40 KB',
    async () => {
      requireVendor()
      const { js } = expectOk(
        await build({
          'index.tsx': reactWith(
            `import { Plus, Trash2, Camera } from 'lucide-react'`,
            '',
            '<Plus /><Trash2 /><Camera />'
          )
        })
      )
      expect(js).toContain('createLucideIcon("plus"')
      expect(js).toContain('createLucideIcon("trash-2"')
      expect(js).toContain('createLucideIcon("camera"')
      expect(count(js, 'createLucideIcon("')).toBe(3)
      expect(js).not.toContain('createLucideIcon("zap"')
      expect(js.length - (await baseline())).toBeLessThan(40 * 1024)
    },
    T
  )

  /** lucide、@dnd-kit 三件、@tanstack/react-virtual：三行可排序的、一个图标、一个虚拟列表 */
  const ONE_REACT = `import { createRoot } from 'react-dom/client'
import { useRef } from 'react'
import { Plus } from 'lucide-react'
import { DndContext } from '@dnd-kit/core'
import { SortableContext, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useVirtualizer } from '@tanstack/react-virtual'

function Row({ id }: { id: string }) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id })
  return (
    <li ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} {...attributes} {...listeners}>
      {id}
    </li>
  )
}

function List() {
  const parentRef = useRef<HTMLDivElement>(null)
  const v = useVirtualizer({
    count: 100,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 20,
    initialRect: { width: 300, height: 200 },
    observeElementRect: (_instance, cb) => {
      cb({ width: 300, height: 200 })
      return () => {}
    }
  })
  return (
    <div ref={parentRef} data-virtual="" style={{ height: 200, width: 300, overflow: 'auto' }}>
      <div style={{ height: v.getTotalSize(), position: 'relative' }}>
        {v.getVirtualItems().map((item) => (
          <div key={item.key} data-vrow="" style={{ position: 'absolute', top: item.start, height: 20 }}>
            row {item.index}
          </div>
        ))}
      </div>
    </div>
  )
}

function App() {
  const items = ['a', 'b', 'c']
  return (
    <div>
      <Plus />
      <DndContext>
        <SortableContext items={items}>
          <ul>{items.map((id) => <Row key={id} id={id} />)}</ul>
        </SortableContext>
      </DndContext>
      <List />
    </div>
  )
}

const el = document.getElementById('root')
if (el) createRoot(el).render(<App />)
`

  it(
    'B-3 只有一份 React（标记次数与 react-all.esm.js 一样）',
    async () => {
      requireVendor()
      const { js } = expectOk(await build({ 'index.tsx': ONE_REACT }))
      const reactAll = readFileSync(join(DEPS_DIR, 'react-all.esm.js'), 'utf8')
      expect(count(reactAll, REACT_MARKER)).toBeGreaterThan(0)
      expect(count(js, REACT_MARKER)).toBe(count(reactAll, REACT_MARKER))
    },
    T
  )

  it(
    'B-3r B-3 的产物在 JSDOM 里跑：没有错误，图标、三行可排序的、虚拟列表都在',
    async () => {
      requireVendor()
      const { js } = expectOk(await build({ 'index.tsx': ONE_REACT }))
      const page = runInJsdom(js)
      try {
        const doc = page.win.document
        await waitFor(() => doc.querySelectorAll('[aria-roledescription="sortable"]').length === 3)
        await waitFor(() => doc.querySelectorAll('[data-vrow]').length > 0)
        const text = page.errors.map(String).join('\n')
        expect(text).not.toContain('Invalid hook call')
        expect(text).not.toContain('process is not defined')
        expect(page.errors).toEqual([])
        expect(doc.querySelector('svg.lucide-plus')).not.toBeNull()
        expect(doc.querySelectorAll('[aria-roledescription="sortable"]')).toHaveLength(3)
        expect(doc.querySelectorAll('[data-vrow]').length).toBeGreaterThan(0)
      } finally {
        page.close()
      }
    },
    T
  )
})

// ────────────────────────────── 只从 vendor 解析 ──────────────────────────────

describe('B-4..6 表里的库只从 vendor 解析', () => {
  const fakePackage = (dir: string, name: string, marker: string): void => {
    put(
      join(dir, 'package.json'),
      JSON.stringify({ name, version: '9.9.9', main: 'index.js' }),
      '/'
    )
    put(join(dir, 'index.js'), `export default function fake() { return '${marker}' }\n`, '/')
  }

  it(
    'B-4 组件目录里与它上面的 node_modules/dayjs 都不用，用的是 vendor 里的',
    async () => {
      requireVendor()
      fakePackage(join(widgetDir, 'node_modules/dayjs'), 'dayjs', 'FAKE_DAYJS_IN_WIDGET')
      fakePackage(join(root, 'node_modules/dayjs'), 'dayjs', 'FAKE_DAYJS_ABOVE')
      const { js } = expectOk(
        await build({ 'index.tsx': `import dayjs from 'dayjs'\nconsole.log(dayjs())\n` })
      )
      expect(js).not.toContain('FAKE_DAYJS_IN_WIDGET')
      expect(js).not.toContain('FAKE_DAYJS_ABOVE')
      expect(js).toContain('"Invalid Date"')
    },
    T
  )

  it(
    'B-4b 组件上面装着的不认识的包 → 不可用，不进产物',
    async () => {
      fakePackage(join(root, 'node_modules/left-pad'), 'left-pad', 'FAKE_LEFT_PAD')
      fakePackage(join(widgetDir, 'node_modules/left-pad'), 'left-pad', 'FAKE_LEFT_PAD_IN')
      const r = await build({ 'index.tsx': `import pad from 'left-pad'\nconsole.log(pad())\n` })
      expectFails(r, NOT_AVAILABLE('left-pad'))
      expect((r.errors ?? []).join('\n')).not.toContain('FAKE_LEFT_PAD')
    },
    T
  )

  it(
    'B-4c 库里没拷进 vendor 的深路径 → 失败，点名它',
    async () => {
      requireVendor()
      const spec = 'lucide-react/dist/cjs/lucide-react.js'
      expect(existsSync(join(VENDOR, 'node_modules', spec))).toBe(false)
      const r = await build({ 'index.tsx': `import * as L from '${spec}'\nconsole.log(L)\n` })
      expect(r.success).toBe(false)
      expect(r.outputJS).toBeUndefined()
      const text = (r.errors ?? []).join('\n')
      expect(text).toContain(spec)
      // 开发检出：Node 的查找走出 vendor 进了仓库的 node_modules
      if (existsSync(resolve(DESKTOP_DIR, '../../node_modules', spec))) {
        expect(text).toContain(`"${spec}" resolved outside ShuviX's widget libraries`)
      }
    },
    T
  )

  it(
    'B-4d 库里没随包的资源（highlight.js/styles/github.css）→ Could not resolve',
    async () => {
      requireVendor()
      const r = await build({ 'index.tsx': `import 'highlight.js/styles/github.css'\n` })
      expect(r.success).toBe(false)
      expect(r.outputCSS).toBeUndefined()
      expect((r.errors ?? []).join('\n')).toContain('Could not resolve')
    },
    T
  )

  /** 假 vendor：dayjs（表里的名字）import ./util.js（标记 U）与 tslib */
  function fixtureVendor(): string {
    const vendor = join(root, 'vendor')
    const dayjs = join(vendor, 'node_modules/dayjs')
    put(
      join(dayjs, 'package.json'),
      JSON.stringify({ name: 'dayjs', version: '1.11.23', main: 'index.js' }),
      '/'
    )
    put(
      join(dayjs, 'index.js'),
      `import u from './util.js'\nimport t from 'tslib'\nexport default function dayjs() { return [u, t].join('|') }\n`,
      '/'
    )
    put(join(dayjs, 'util.js'), `export default 'MARKER_U_UTIL'\n`, '/')
    put(
      join(root, 'node_modules/tslib/package.json'),
      JSON.stringify({ name: 'tslib', version: '1.0.0', main: 'index.js' }),
      '/'
    )
    put(join(root, 'node_modules/tslib/index.js'), `export default 'MARKER_ABOVE_VENDOR'\n`, '/')
    return vendor
  }
  const tslibIn = (dir: string, marker: string): void => {
    put(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'tslib', version: '2.0.0', main: 'index.js' }),
      '/'
    )
    put(join(dir, 'index.js'), `export default '${marker}'\n`, '/')
  }
  const USES_DAYJS = `import dayjs from 'dayjs'\nconsole.log(dayjs())\n`

  it(
    'B-5 库内部 import 一个只在 vendor 上面才有的包 → resolved outside',
    async () => {
      const vendor = fixtureVendor()
      const r = await build({ 'index.tsx': USES_DAYJS }, bundlerWithVendor(vendor))
      expect(r.success).toBe(false)
      expect(
        messages(r).some((m) => m.startsWith(`"tslib" resolved outside ShuviX's widget libraries`))
      ).toBe(true)
      expect((r.errors ?? []).join('\n')).not.toContain('MARKER_ABOVE_VENDOR')
    },
    T
  )

  it(
    'B-5b vendor 里也有它 → 成功，两个标记都在',
    async () => {
      const vendor = fixtureVendor()
      tslibIn(join(vendor, 'node_modules/tslib'), 'MARKER_B_VENDOR')
      const { js } = expectOk(await build({ 'index.tsx': USES_DAYJS }, bundlerWithVendor(vendor)))
      expect(js).toContain('MARKER_U_UTIL')
      expect(js).toContain('MARKER_B_VENDOR')
      expect(js).not.toContain('MARKER_ABOVE_VENDOR')
    },
    T
  )

  it(
    'B-5c 嵌套的版本优先',
    async () => {
      const vendor = fixtureVendor()
      tslibIn(join(vendor, 'node_modules/tslib'), 'MARKER_B_VENDOR')
      tslibIn(join(vendor, 'node_modules/dayjs/node_modules/tslib'), 'MARKER_A_NESTED')
      const { js } = expectOk(await build({ 'index.tsx': USES_DAYJS }, bundlerWithVendor(vendor)))
      expect(js).toContain('MARKER_A_NESTED')
      expect(js).not.toContain('MARKER_B_VENDOR')
    },
    T
  )

  it(
    'B-5d vendor 经符号链接给出 → 照样成功',
    async () => {
      const vendor = fixtureVendor()
      tslibIn(join(vendor, 'node_modules/tslib'), 'MARKER_B_VENDOR')
      const link = join(root, 'vendor-link')
      symlinkSync(vendor, link, 'dir')
      const { js } = expectOk(await build({ 'index.tsx': USES_DAYJS }, bundlerWithVendor(link)))
      expect(js).toContain('MARKER_U_UTIL')
      expect(js).toContain('MARKER_B_VENDOR')
    },
    T
  )

  it(
    'B-6 库里相对 import 一个不存在的文件 → esbuild 自己的 Could not resolve',
    async () => {
      const vendor = fixtureVendor()
      tslibIn(join(vendor, 'node_modules/tslib'), 'MARKER_B_VENDOR')
      put(
        join(vendor, 'node_modules/dayjs/index.js'),
        `import n from './nope.js'\nexport default function dayjs() { return n }\n`,
        '/'
      )
      const r = await build({ 'index.tsx': USES_DAYJS }, bundlerWithVendor(vendor))
      expect(r.success).toBe(false)
      const text = (r.errors ?? []).join('\n')
      expect(text).toContain('Could not resolve "./nope.js"')
      expect(text).not.toContain(OUTSIDE_WIDGET)
    },
    T
  )
})

// ────────────────────────────── 不可用与挡下的 ──────────────────────────────

describe('B-7..9 不可用、React 子路径、挡下的', () => {
  it.each(['left-pad', 'fs', 'node:fs', 'three-stdlib', 'shuvix'])(
    'B-7 %j → 不可用，列出可用的库',
    async (spec) => {
      requireVendor()
      expectFails(
        await build({ 'index.tsx': `import x from '${spec}'\nconsole.log(x)\n` }),
        NOT_AVAILABLE(spec)
      )
    },
    T
  )

  it.each(['https://cdn.example.com/x.js', 'https://esm.sh/three'])(
    'B-7 带协议的 %j → 不能从网址 import',
    async (spec) => {
      expectFails(
        await build({ 'index.tsx': `import x from '${spec}'\nconsole.log(x)\n` }),
        FROM_URL(spec)
      )
    },
    T
  )

  it.each(['react-dom/server', 'react/jsx-dev-runtime', 'react-router-dom/server'])(
    'B-8 React 包的子路径 %j → 说明 React 那几个能用的',
    async (spec) => {
      expectFails(
        await build({ 'index.tsx': `import * as x from '${spec}'\nconsole.log(x)\n` }),
        REACT_SUBPATH(spec)
      )
    },
    T
  )

  it.each([
    ['静态', `import hljs from 'highlight.js'\nconsole.log(hljs)\n`],
    ['动态', `import('highlight.js').then((hljs) => console.log(hljs))\n`],
    ['export *', `export * from 'highlight.js'\n`]
  ])(
    'B-9 挡下的 highlight.js（%s）→ 正文就是表里那句',
    async (_what, source) => {
      const r = await build({ 'index.tsx': source })
      expect(r.success).toBe(false)
      expect(r.outputJS).toBeUndefined()
      expect(messages(r)).toEqual([HLJS_HINT])
    },
    T
  )

  it(
    'B-9b highlight.js/lib/core + javascript、typescript → 只带这两个语言',
    async () => {
      requireVendor()
      const { js } = expectOk(
        await build({
          'index.tsx': `import hljs from 'highlight.js/lib/core'
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('typescript', typescript)
console.log(hljs.highlight('const a = 1', { language: 'javascript' }).value)
`
        })
      )
      expect(js).toContain('name:"JavaScript"')
      expect(js).not.toContain('nonlocal')
    },
    T
  )

  it(
    'B-9c highlight.js/lib/common → 照样成功（F-9：只挡裸的 highlight.js）',
    async () => {
      requireVendor()
      const { js } = expectOk(
        await build({
          'index.tsx': `import hljs from 'highlight.js/lib/common'\nconsole.log(hljs.listLanguages())\n`
        })
      )
      expect(js).toContain('name:"JavaScript"')
      expect(js).toContain('nonlocal')
    },
    T
  )
})

// ────────────────────────────── three ──────────────────────────────

describe('B-10..12 three 留给页面的 import map', () => {
  it(
    'B-10 three、OrbitControls、GLTFLoader 都是外部模块；three 本身不进产物',
    async () => {
      requireVendor()
      const { js } = expectOk(
        await build({
          'index.tsx': reactWith(
            `import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'`,
            `const scene = new THREE.Scene()
  console.log(scene, OrbitControls, new GLTFLoader())`
          )
        })
      )
      expect(js).toContain('from"three"')
      expect(js).toContain('from"three/addons/controls/OrbitControls.js"')
      expect(js).toContain('from"three/addons/loaders/GLTFLoader.js"')
      expect(js).not.toContain('Three.js Authors')
      expect(js).not.toContain('class WebGLRenderer')
      expect(js.length - (await baseline())).toBeLessThan(20 * 1024)
    },
    T
  )

  it(
    'B-10b await import("three") → 留着 import("three")',
    async () => {
      requireVendor()
      const { js } = expectOk(
        await build({
          'index.tsx': `async function load() {\n  const T = await import('three')\n  console.log(T.REVISION)\n}\nload()\n`
        })
      )
      expect(js).toContain('import("three")')
    },
    T
  )

  /** B-11 那句的 Available 清单 */
  function availableOf(r: Built, spec: string): string[] {
    const message = messages(r).find((m) => m.startsWith(NOT_SHIPPED(spec)))
    expect(message, (r.errors ?? []).join('\n')).toBeDefined()
    const m = / Available: (.*)\.$/.exec(message!)
    expect(m, message).not.toBeNull()
    return m![1].split(', ')
  }

  it(
    'B-11 没随包的 addon → not among … Available: 排好序的清单，每项 vendor 里都有',
    async () => {
      requireVendor()
      const spec = 'three/addons/postprocessing/EffectComposer.js'
      const r = await build({
        'index.tsx': `import { EffectComposer } from '${spec}'\nconsole.log(EffectComposer)\n`
      })
      expect(r.success).toBe(false)
      expect(r.outputJS).toBeUndefined()
      const list = availableOf(r, spec)
      expect(list).toEqual([...list].sort())
      expect(list[0]).toBe('three')
      for (const addon of [
        'three/addons/controls/OrbitControls.js',
        'three/addons/loaders/GLTFLoader.js',
        'three/addons/utils/BufferGeometryUtils.js'
      ]) {
        expect(list).toContain(addon)
      }
      for (const addon of list.slice(1)) {
        expect(addon.startsWith('three/addons/'), addon).toBe(true)
        expect(existsSync(join(THREE_JSM, addon.slice('three/addons/'.length))), addon).toBe(true)
      }
      // vendor 里 examples/jsm 下的每个 .js 都列出来了
      const listed = (dir: string, rel = ''): string[] =>
        readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) => {
          const p = rel ? `${rel}/${e.name}` : e.name
          return e.isDirectory()
            ? listed(dir, p)
            : e.name.endsWith('.js')
              ? [`three/addons/${p}`]
              : []
        })
      expect(list.slice(1).sort()).toEqual(listed(THREE_JSM).sort())
    },
    T
  )

  it.each([
    'three/addons/controls/OrbitControls',
    'three/examples/jsm/controls/OrbitControls.js',
    'three/build/three.module.js',
    'three/webgpu',
    'three/addons/',
    // F-3
    'three/addons/../build/three.core.js',
    'three/addons/controls/../../../../../../etc/hosts'
  ])(
    'B-12 %j → B-11 的形状，不内联',
    async (spec) => {
      requireVendor()
      const r = await build({ 'index.tsx': `import * as X from '${spec}'\nconsole.log(X)\n` })
      expect(r.success).toBe(false)
      expect(r.outputJS).toBeUndefined()
      expect(availableOf(r, spec)[0]).toBe('three')
    },
    T
  )
})

// ────────────────────────────── 产物的形状 ──────────────────────────────

describe('B-13..14 NODE_ENV 与压缩', () => {
  it(
    'B-13 process.env.NODE_ENV → "production"：开发分支摇掉，产物里没有 process.env',
    async () => {
      requireVendor()
      const { js } = expectOk(
        await build({
          'index.tsx': reactWith(
            `import { useVirtualizer } from '@tanstack/react-virtual'
import { DndContext } from '@dnd-kit/core'
import dayjs from 'dayjs'
if (process.env.NODE_ENV !== 'production') console.log('DEV_ONLY_MARK')
console.log(process.env.NODE_ENV)`,
            `console.log(useVirtualizer, dayjs())`,
            '<DndContext><p /></DndContext>'
          )
        })
      )
      expect(js).not.toContain('DEV_ONLY_MARK')
      expect(js).not.toContain('process.env')
      expect(js).toContain('console.log("production")')
    },
    T
  )

  it(
    'B-14 压缩不改名字',
    async () => {
      const { js } = expectOk(
        await build({
          'math.ts': `export function keepThisName(a) {\n    return a   +   1\n}\n`,
          'index.tsx': `import { keepThisName } from './math'\nconsole.log(keepThisName(41))\n`
        })
      )
      expect(js).toContain('function keepThisName(a){return a+1}')
    },
    T
  )
})

describe('B-15..16 vendor 不在', () => {
  it(
    'B-15 vendor 目录不存在：React 照样成功；库 → missing；left-pad → 不可用；highlight.js → 表里那句',
    async () => {
      const vendor = join(root, 'no-vendor')
      const b = bundlerWithVendor(vendor)
      expectOk(await build({ 'index.tsx': REACT_ONLY }, b))
      const one = async (source: string): Promise<Built> => build({ 'index.tsx': source }, b)
      expectFails(
        await one(`import dayjs from 'dayjs'\nconsole.log(dayjs())\n`),
        MISSING(vendor, 'dayjs')
      )
      expectFails(
        await one(`import pad from 'left-pad'\nconsole.log(pad)\n`),
        NOT_AVAILABLE('left-pad')
      )
      expectFails(await one(`import hljs from 'highlight.js'\nconsole.log(hljs)\n`), HLJS_HINT)
      // F-4：three 也是 missing 那句
      expectFails(
        await one(`import * as THREE from 'three'\nconsole.log(THREE)\n`),
        MISSING(vendor, 'three')
      )
    },
    T
  )

  it(
    'B-16 vendor 在、没有 node_modules → missing',
    async () => {
      const vendor = join(root, 'vendor-empty')
      put(join(vendor, 'manifest.json'), '{}', '/')
      expectFails(
        await build(
          { 'index.tsx': `import dayjs from 'dayjs'\nconsole.log(dayjs())\n` },
          bundlerWithVendor(vendor)
        ),
        MISSING(vendor, 'dayjs')
      )
    },
    T
  )
})

// ────────────────────────────── CSS ──────────────────────────────

describe('B-17..18 样式表', () => {
  it(
    'B-17 uplot 的 CSS：从 TSX import',
    async () => {
      requireVendor()
      const { css } = expectOk(
        await build({
          'index.tsx': `import uPlot from 'uplot'\nimport 'uplot/dist/uPlot.min.css'\nconsole.log(uPlot)\n`
        })
      )
      expect(css).toContain('.uplot')
    },
    T
  )

  it(
    'B-17 uplot 的 CSS：在组件 .css 里 @import',
    async () => {
      requireVendor()
      const { css } = expectOk(
        await build({
          'style.css': `@import "uplot/dist/uPlot.min.css";\n.mine { color: red; }\n`,
          'index.tsx': `import './style.css'\nconsole.log(1)\n`
        })
      )
      expect(css).toContain('.uplot')
      expect(css).toContain('.mine')
    },
    T
  )

  it(
    'B-18 url(data:…)、url(#grad)、url(https://…) 照收，原样留着（F-2）',
    async () => {
      const { css } = expectOk(
        await build({
          'style.css': `.a { background: url("data:image/svg+xml,%3Csvg%3E%3C/svg%3E"); }
.b { fill: url(#grad); }
.c { background: url(https://example.com/x.png); }
`,
          'index.tsx': `import './style.css'\nconsole.log(1)\n`
        })
      )
      expect(css).toContain('data:image/svg+xml,%3Csvg%3E%3C/svg%3E')
      expect(css).toContain('url(#grad)')
      expect(css).toContain('https://example.com/x.png')
    },
    T
  )

  it(
    'B-18c CSS 的 @import "x.css" 先按旁边的文件找',
    async () => {
      const { css } = expectOk(
        await build({
          'parts/x.css': `.from-sibling { color: blue; }\n`,
          'parts/style.css': `@import "x.css";\n.main { color: red; }\n`,
          'index.tsx': `import './parts/style.css'\nconsole.log(1)\n`
        })
      )
      expect(css).toContain('.from-sibling')
      expect(css).toContain('.main')
    },
    T
  )

  it(
    'B-18c CSS 的 @import "https://…" → 不能从网址 import',
    async () => {
      const spec = 'https://cdn.example.com/x.css'
      expectFails(
        await build({
          'style.css': `@import "${spec}";\n.main { color: red; }\n`,
          'index.tsx': `import './style.css'\nconsole.log(1)\n`
        }),
        FROM_URL(spec)
      )
    },
    T
  )
})

// ────────────────────────────── 运行时与大小 ──────────────────────────────

describe('B-19..22 动态 import、跑起来、大小', () => {
  it(
    'B-19 动态 import 打进去的库 → 内联',
    async () => {
      requireVendor()
      const { js } = expectOk(
        await build({
          'index.tsx': `async function load() {\n  const { default: Papa } = await import('papaparse')\n  console.log(Papa.parse('a'))\n}\nload()\n`
        })
      )
      expect(js).not.toContain('import("papaparse")')
      expect(js).not.toMatch(bareImportOf('papaparse'))
    },
    T
  )

  it(
    'B-20 JSDOM 里跑：各个库的结果都对（CommonJS / UMD 互通、browser 字段）',
    async () => {
      requireVendor()
      const { js } = expectOk(
        await build({
          'index.tsx': `import Papa from 'papaparse'
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'
import { parse } from 'yaml'
import Fuse from 'fuse.js'
import { diffWords } from 'diff'
import { scaleLinear } from 'd3'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import QRCode from 'qrcode'

dayjs.extend(relativeTime)
const w = window as unknown as Record<string, unknown>
;(async () => {
  try {
    w.__results = [
      (Papa.parse('a,b\\n1,2', { header: true }).data[0] as Record<string, string>).a,
      dayjs('2026-01-01').add(1, 'day').format('YYYY-MM-DD'),
      parse('a: 1'),
      new Fuse(['apple', 'banana']).search('appl')[0].item,
      diffWords('a b', 'a c').map((p) => ({ value: p.value, added: !!p.added, removed: !!p.removed })),
      scaleLinear().domain([0, 10]).range([0, 100])(5),
      DOMPurify.sanitize(marked.parse('# Hi <img src=x onerror=alert(1)>', { async: false }) as string),
      await QRCode.toString('x', { type: 'svg' })
    ]
  } catch (e) {
    w.__error = String((e as Error)?.stack ?? e)
  }
})()
`
        })
      )
      const page = runInJsdom(js)
      try {
        await waitFor(() => page.win.__results !== undefined || page.win.__error !== undefined)
        expect(page.win.__error).toBeUndefined()
        expect(page.errors).toEqual([])
        const [papa, day, yaml, fuse, diff, scale, html, svg] = page.win.__results as unknown[]
        expect(papa).toBe('1')
        expect(day).toBe('2026-01-02')
        expect(yaml).toEqual({ a: 1 })
        expect(fuse).toBe('apple')
        const parts = diff as Array<{ added: boolean; removed: boolean }>
        expect(parts.some((p) => p.removed)).toBe(true)
        expect(parts.some((p) => p.added)).toBe(true)
        expect(scale).toBe(50)
        expect(html).toContain('<h1')
        expect(html).not.toContain('onerror')
        expect(typeof svg === 'string' && svg.startsWith('<svg')).toBe(true)
      } finally {
        page.close()
      }
    },
    T
  )

  it(
    'B-21 d3 摇树：只用 scaleLinear',
    async () => {
      requireVendor()
      const { js } = expectOk(
        await build({
          'index.tsx': `import { scaleLinear } from 'd3'\nconsole.log(scaleLinear().domain([0, 1])(0.5))\n`
        })
      )
      expect(js).not.toContain('forceSimulation')
      expect(js).not.toContain('geoMercator')
      expect(js).not.toContain('contourDensity')
      expect(js.length).toBeLessThan(150 * 1024)
    },
    T
  )

  it(
    'B-22 chart.js 按需注册比 chart.js/auto 小',
    async () => {
      requireVendor()
      const named = expectOk(
        await build({
          'index.tsx': `import { Chart, LineController, LineElement, PointElement, LinearScale, CategoryScale } from 'chart.js'
Chart.register(LineController, LineElement, PointElement, LinearScale, CategoryScale)
console.log(Chart)
`
        })
      ).js
      rmSync(widgetDir, { recursive: true, force: true })
      mkdirSync(widgetDir)
      const auto = expectOk(
        await build({ 'index.tsx': `import Chart from 'chart.js/auto'\nconsole.log(Chart)\n` })
      ).js
      expect(named.length).toBeLessThan(auto.length)
    },
    T
  )
})

// ────────────────────────────── 组件自己的 tsconfig paths ──────────────────────────────

describe('B-23 组件自己的 tsconfig paths 别名（F-12）', () => {
  it(
    'B-23 `@/…` 落在组件目录里 → 照收',
    async () => {
      const { js } = expectOk(
        await build({
          'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@/*': ['./*'] } } }),
          'components/X.tsx': `export const X = 'ALIAS_TARGET_MARK'\n`,
          'index.tsx': `import { X } from '@/components/X'\nconsole.log(X)\n`
        })
      )
      expect(js).toContain('ALIAS_TARGET_MARK')
    },
    T
  )

  it(
    'B-23 别名指到组件目录外面 → 不可用，外面的文件不进产物',
    async () => {
      put(join(root, 'outside/secret.ts'), `export const S = 'OUTSIDE_MARK'\n`, '/')
      const r = await build({
        'tsconfig.json': JSON.stringify({
          compilerOptions: { paths: { '~/*': ['../outside/*'] } }
        }),
        'index.tsx': `import { S } from '~/secret'\nconsole.log(S)\n`
      })
      expectFails(r, NOT_AVAILABLE('~/secret'))
    },
    T
  )

  it(
    'B-23 别名指到组件自己的 node_modules → 不可用',
    async () => {
      put(
        join(widgetDir, 'node_modules/pkg/index.ts'),
        `export const P = 'NODE_MODULES_MARK'\n`,
        '/'
      )
      const r = await build({
        'tsconfig.json': JSON.stringify({
          compilerOptions: { paths: { 'nm/*': ['./node_modules/*'] } }
        }),
        'index.tsx': `import { P } from 'nm/pkg'\nconsole.log(P)\n`
      })
      expectFails(r, NOT_AVAILABLE('nm/pkg'))
    },
    T
  )
})

// ────────────────────────────── API 打包 ──────────────────────────────

describe('BA API 打包不受影响', () => {
  it(
    'BA-1 api.ts import 表里的库 → 照旧拒绝',
    async () => {
      put(
        'api.ts',
        `import { defineApi, op } from 'shuvix/widget-api'
import { z } from 'zod'
import dayjs from 'dayjs'

export default defineApi({
  now: op.read({ description: 'Now.', input: z.object({}), handler: async () => dayjs().format() })
})
`
      )
      const r = await bundler.buildApi(widgetDir)
      expect(r.success).toBe(false)
      expect(messages(r)).toContain(
        `api.ts can only import "shuvix/widget-api", "zod" and files in this widget (not "dayjs").`
      )
    },
    T
  )
})
