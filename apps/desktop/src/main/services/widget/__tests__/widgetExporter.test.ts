/**
 * 导出（widgetExporter.ts）里 `shuvix/widget` 与 `shuvix/widget-api` 的那一部分（设计稿 docs/widget-tool-design.md §21）：
 * 导出模板带着两份生成的拷贝（客户端 `src/shuvix-widget.ts`、运行时 `src/shuvix-widget-api.ts`），Vite 别名与 tsconfig
 * paths 指向它们，EXPORT_NOTES 说明 API 在导出项目里不跑。
 * widgetService 换成替身（getById / getWidgetDir → 临时组件目录），bundler 的资源目录指到仓库里的 `resources/bundler`
 * （免得拉起 electron 的 app），logger 静音；目标 zip 落在临时目录，用 fflate 解开看。
 *
 *   WC-82 模板里的两份拷贝与源码同步（不用导出也能查）：客户端拷贝以 widgetClient.ts 的全文结尾、运行时拷贝以
 *         sandboxRuntime.ts 的全文结尾；前面只有 `//` 行，说明它解析自哪里、看 EXPORT_NOTES.md / tsconfig.json，
 *         以及「ShuviX 构建时」抄的
 *   WC-83 导出带 index.tsx、api.ts、widget.json、.git/x、node_modules/y 的组件：两份拷贝与模板逐字节相同；
 *         api.ts、index.tsx 原样；没有 widget.json、.git、node_modules
 *   WC-84 vite.config.ts 的别名 `'shuvix/widget'` → `/src/shuvix-widget.ts`；tsconfig.json 是 JSON，paths 给出两个模块，
 *         都指向归档里有的文件；package.json 的 dependencies 带 zod（EXPORTED_VERSIONS.zod）
 *   WC-85 EXPORT_NOTES.md：第 5 条讲 shuvix/widget、src/shuvix-widget.ts、api/<operation>、sse、shuvix/widget-api；
 *         第 4 条的 `/w/<id>/db/…` 是真的 id；`.tmpl` 生成的文件里没有剩下的 `{{`
 *   WC-86 组件自己也有 src/shuvix-widget.ts、vite.config.ts → 归档里是模板的（模板优先）
 *   WC-87 带 api.ts 的导出解开后 `tsc -b` 通过（仓库的 node_modules 链进去）；对照：界面传错参数类型 → tsc 报错
 *   WC-88 `src/shuvix-theme.css` = exportThemeCss()：themes.css 全文、页面底色字色那条 body 规则、WIDGET_TAILWIND_THEME
 *         依次在里面；`src/index.css` 在 `@import 'tailwindcss'` 之后引它
 *   WC-89 index.html：主题脚本排在 `/src/index.css` 那条 link 之前，正文 = themeBootScript(WIDGET_EXPORT_THEME)
 *   WC-90 EXPORT_NOTES 第 6 条点名 src/shuvix-theme.css、data-scheme、useTheme()、themeColor()；文件表里有 src/shuvix-theme.css
 *   WC-91 组件自己也有 src/shuvix-theme.css → 归档里是生成的那份
 *
 * 组件用到的库（bundler/widgetLibs.json）进导出项目的 package.json：
 *   X-1  librariesImportedBy 认 `from` / `import '…'` / `import\n'…'` / `import('…')` / `export … from`、库的子路径
 *        （`three/addons/…`、`highlight.js/lib/core`、`uplot/dist/…css`）；按表里的顺序、不重复
 *   X-2  只有非库的 import（react、react-dom/client、shuvix/widget、./local、zod、left-pad、`@dnd-kit`）→ []
 *   X-3  多行的具名 import 算；`import type` 算（多一个依赖无害）；裸字符串 `'three'` 不算；引号对不上不算
 *   X-4  withLibraryDependencies(模板插值后的 package.json, [three, d3, lucide-react])：dependencies / devDependencies
 *        = 模板的 + 库的精确版本 / 类型包，键按字母排；别的顶层键顺序与值不变；2 空格缩进、结尾换行
 *   X-5  已有 `three: '^0.1.0'` → 换成表里的版本
 *   X-6  输入没有 dependencies / devDependencies：只补 dependencies；库不带类型包就不写空的 devDependencies
 *        （带类型包的库照样补出 devDependencies）
 *   X-7  exportWidget：index.tsx 用 lucide-react、three/addons/…、d3、papaparse，components/Chart.tsx 用 chart.js，
 *        api.ts 用 zod → 解开的 package.json：模板的依赖值不变 + 这些库（表里的版本），三个类型包进 devDependencies，键都排好
 *   X-8  一个库都不用 → package.json 与模板插值后的逐字节相同（不重新序列化）
 *   X-9  库只出现在不扫的地方（notes.md、data.json、被模板盖掉的 src/shuvix-widget.ts、node_modules/）→ package.json 不变
 *   X-10 库只从组件的 .css 里 `@import "…"` / `@import url('…')` 引、或只经 `require('…')` 引 → 照样补进去
 *   X-11 只用自带类型的库（lucide-react、chart.js、dayjs、@tanstack/react-virtual）的导出解开后 `tsc -b` 通过
 *        （仓库的 node_modules 链进去；靠 exportTypes 的库仓库里没装类型包，查不了）
 *   X-12 EXPORT_NOTES 第 3 条（依赖）：不再说「只有 react、react-dom、react-router、spectacle」，说的是 ShuviX 随带的库
 *        与「这个组件 import 的那些」写在这里
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { unzipSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** apps/desktop */
const DESKTOP_DIR = resolve(__dirname, '../../../../..')
const REPO_DIR = resolve(DESKTOP_DIR, '../..')
const RESOURCES = join(DESKTOP_DIR, 'resources/bundler')
const TEMPLATE_DIR = join(RESOURCES, 'export-template/widget')
const CLIENT_SOURCE = join(DESKTOP_DIR, 'src/renderer/src/widgetClient/widgetClient.ts')
const RUNTIME_SOURCE = join(DESKTOP_DIR, 'src/main/services/widget/api/sandboxRuntime.ts')
const THEMES_CSS = join(REPO_DIR, 'packages/app-shell/src/themes.css')

const h = vi.hoisted(() => ({
  widgetDir: '',
  widget: null as null | { id: string; name: string; description: string }
}))

vi.mock('../widgetService', () => ({
  widgetService: {
    getById: (id: string) => (h.widget?.id === id ? h.widget : undefined),
    getWidgetDir: () => h.widgetDir
  }
}))
vi.mock('../../bundler', () => ({
  bundlerResourcePath: (p: string) => join(RESOURCES, p)
}))
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
}))

import {
  exportThemeCss,
  exportWidget,
  librariesImportedBy,
  withLibraryDependencies
} from '../widgetExporter'
import { EXPORTED_VERSIONS } from '../exportedVersions'
import { WIDGET_LIBRARIES, type WidgetLibrary } from '../../bundler/widgetLibs'
import {
  themeBootScript,
  widgetThemeCss,
  WIDGET_EXPORT_THEME,
  WIDGET_TAILWIND_THEME
} from '../widgetTheme'

const ID = 'reading-list'
let tmp = ''

function put(name: string, content: string): void {
  const full = join(h.widgetDir, name)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
}

const utf8 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('utf8')

/** 导出并解开：交回 `<id>/` 之下的相对路径 → 字节 */
async function exportAndUnzip(): Promise<Record<string, Uint8Array>> {
  const out = await exportWidget({ id: ID, targetPath: join(tmp, 'out') })
  const entries = unzipSync(new Uint8Array(readFileSync(out.zipPath)))
  const files: Record<string, Uint8Array> = {}
  for (const [path, bytes] of Object.entries(entries)) {
    expect(path.startsWith(`${ID}/`), path).toBe(true)
    files[path.slice(ID.length + 1)] = bytes
  }
  return files
}

/** 一份生成的拷贝：拆成开头的注释行与其后的正文 */
function splitHeader(text: string): { header: string[]; body: string } {
  const lines = text.split('\n')
  let i = 0
  while (i < lines.length && lines[i].startsWith('//')) i++
  return { header: lines.slice(0, i), body: lines.slice(i).join('\n') }
}

const API_TS = `import { defineApi, op } from 'shuvix/widget-api'
import { z } from 'zod'

const Book = z.object({ id: z.string(), title: z.string() })

export default defineApi({
  listBooks: op.read({
    description: 'List books.',
    input: z.object({ limit: z.number().default(50) }),
    output: z.array(Book),
    handler: ({ limit }, ctx) =>
      ctx.db.sql<z.infer<typeof Book>>\`SELECT id, title FROM books LIMIT \${limit}\`
  }),
  addBook: op.write({
    description: 'Add a book.',
    input: z.object({ title: z.string().min(1) }),
    output: Book,
    handler: async ({ title }, ctx) => {
      const [row] = await ctx.db.sql<z.infer<typeof Book>>\`INSERT INTO books (id, title) VALUES (\${ctx.uuid()}, \${title}) RETURNING id, title\`
      return row
    }
  })
})
`

/** 界面：只取 API 的类型，经 shuvix/widget 调它；`titleArg` 换成数字就是一个类型错误 */
const indexTsx = (titleArg = 'b.title'): string => `import { createRoot } from 'react-dom/client'
import { createClient } from 'shuvix/widget'
import type Api from './api'

const api = createClient<typeof Api>()

function App() {
  const { data, error, loading } = api.use('listBooks', {})
  if (error) return <p>{error.code}: {error.message}</p>
  return (
    <ul aria-busy={loading}>
      {(data ?? []).map((b) => (
        <li key={b.id} onClick={() => void api.call('addBook', { title: ${titleArg} })}>
          {b.title}
        </li>
      ))}
    </ul>
  )
}

const el = document.getElementById('root')
if (el) createRoot(el).render(<App />)
`

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'shuvix-widget-export-'))
  h.widgetDir = join(tmp, 'widgets', ID)
  mkdirSync(h.widgetDir, { recursive: true })
  h.widget = { id: ID, name: 'Reading list', description: 'Books to read.' }
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('WC-82 模板里的两份生成拷贝与源码同步', () => {
  it('WC-82 src/shuvix-widget.ts 以 widgetClient.ts 的全文结尾；前面只有说明它的注释行', () => {
    const copy = readFileSync(join(TEMPLATE_DIR, 'src/shuvix-widget.ts'), 'utf8')
    const { header, body } = splitHeader(copy)

    expect(body).toBe(readFileSync(CLIENT_SOURCE, 'utf8'))
    expect(header.length).toBeGreaterThan(0)
    const text = header.join('\n')
    expect(text).toContain('shuvix/widget')
    expect(text).toContain('EXPORT_NOTES.md')
    expect(text).toContain('when ShuviX was built')
  })

  it('WC-82 src/shuvix-widget-api.ts 以 sandboxRuntime.ts 的全文结尾；前面只有说明它的注释行', () => {
    const copy = readFileSync(join(TEMPLATE_DIR, 'src/shuvix-widget-api.ts'), 'utf8')
    const { header, body } = splitHeader(copy)

    expect(body).toBe(readFileSync(RUNTIME_SOURCE, 'utf8'))
    expect(header.length).toBeGreaterThan(0)
    const text = header.join('\n')
    expect(text).toContain('shuvix/widget-api')
    expect(text).toContain('tsconfig.json')
    expect(text).toContain('when ShuviX was built')
  })
})

describe('WC-83..86 导出的归档', () => {
  beforeEach(() => {
    put('index.tsx', indexTsx())
    put('api.ts', API_TS)
    put('widget.json', JSON.stringify({ id: ID }))
    put('.git/x', 'git internals')
    put('node_modules/y/index.js', 'module.exports = 1')
  })

  it('WC-83 两份拷贝与模板逐字节相同；源文件原样；没有 widget.json / .git / node_modules', async () => {
    const files = await exportAndUnzip()

    for (const copy of ['src/shuvix-widget.ts', 'src/shuvix-widget-api.ts']) {
      expect(files[copy], copy).toBeDefined()
      expect(Buffer.from(files[copy]).equals(readFileSync(join(TEMPLATE_DIR, copy))), copy).toBe(
        true
      )
    }
    expect(utf8(files['api.ts'])).toBe(API_TS)
    expect(utf8(files['index.tsx'])).toBe(indexTsx())
    const paths = Object.keys(files)
    expect(paths).not.toContain('widget.json')
    expect(
      paths.filter((p) => p.split('/').some((seg) => seg === '.git' || seg === 'node_modules'))
    ).toEqual([])
  })

  it('WC-84 vite 别名、tsconfig paths 指向归档里的拷贝；package.json 带 zod', async () => {
    const files = await exportAndUnzip()

    const vite = utf8(files['vite.config.ts'])
    expect(vite).toMatch(/alias:\s*\{\s*'shuvix\/widget':\s*'\/src\/shuvix-widget\.ts'\s*\}/)
    expect(files['src/shuvix-widget.ts']).toBeDefined()

    const tsconfig = JSON.parse(utf8(files['tsconfig.json'])) as {
      compilerOptions: { paths: Record<string, string[]> }
    }
    expect(tsconfig.compilerOptions.paths).toEqual({
      'shuvix/widget': ['./src/shuvix-widget.ts'],
      'shuvix/widget-api': ['./src/shuvix-widget-api.ts']
    })
    for (const [target] of Object.values(tsconfig.compilerOptions.paths)) {
      expect(files[target.replace(/^\.\//, '')], target).toBeDefined()
    }

    const pkg = JSON.parse(utf8(files['package.json'])) as {
      name: string
      dependencies: Record<string, string>
    }
    expect(pkg.name).toBe(ID)
    expect(pkg.dependencies.zod).toBe(EXPORTED_VERSIONS.zod)
    expect(pkg.dependencies.react).toBe(EXPORTED_VERSIONS.react)
  })

  it('WC-85 EXPORT_NOTES 第 4、5 条；.tmpl 生成的文件里没有剩下的 {{', async () => {
    const files = await exportAndUnzip()

    const notes = utf8(files['EXPORT_NOTES.md'])
    const item = (n: number): string => notes.split('\n').find((l) => l.startsWith(`${n}. `)) ?? ''
    const five = item(5)
    for (const needle of [
      'shuvix/widget',
      'src/shuvix-widget.ts',
      'api/<operation>',
      '`sse`',
      'shuvix/widget-api',
      'src/shuvix-widget-api.ts'
    ]) {
      expect(five, needle).toContain(needle)
    }
    expect(item(4)).toContain(`/w/${ID}/db/…`)

    const templated = ['package.json', 'vite.config.ts', 'EXPORT_NOTES.md', 'index.html']
    for (const name of templated) {
      expect(files[name], name).toBeDefined()
      expect(utf8(files[name]), name).not.toContain('{{')
    }
  })

  it('WC-86 组件自己的 src/shuvix-widget.ts、vite.config.ts → 归档里是模板的', async () => {
    put('src/shuvix-widget.ts', 'export const mine = true\n')
    put('vite.config.ts', 'export default { mine: true }\n')

    const files = await exportAndUnzip()

    expect(
      Buffer.from(files['src/shuvix-widget.ts']).equals(
        readFileSync(join(TEMPLATE_DIR, 'src/shuvix-widget.ts'))
      )
    ).toBe(true)
    expect(utf8(files['vite.config.ts'])).toContain("'shuvix/widget': '/src/shuvix-widget.ts'")
    expect(utf8(files['vite.config.ts'])).not.toContain('mine')
  })
})

describe('WC-88..91 主题跟着导出', () => {
  beforeEach(() => {
    put('index.tsx', indexTsx())
    put('api.ts', API_TS)
  })

  it('WC-88 src/shuvix-theme.css = exportThemeCss()（主题令牌、body、Tailwind 语义色名）；index.css 在 tailwindcss 之后引它', async () => {
    const files = await exportAndUnzip()

    const theme = utf8(files['src/shuvix-theme.css'])
    expect(theme).toBe(exportThemeCss())
    const themes = readFileSync(THEMES_CSS, 'utf8').trimEnd()
    expect(themes.length).toBeGreaterThan(1000)
    const at = {
      themes: theme.indexOf(themes),
      widgetVars: theme.indexOf(widgetThemeCss().trimEnd()),
      body: theme.indexOf(
        'body {\n  background: var(--theme-bg-primary);\n  color: var(--theme-text-primary);\n}'
      ),
      tailwind: theme.indexOf(WIDGET_TAILWIND_THEME)
    }
    for (const [what, i] of Object.entries(at)) expect(i, what).toBeGreaterThan(-1)
    expect(at.themes).toBe(at.widgetVars)
    expect(at.widgetVars).toBeLessThan(at.body)
    expect(at.body).toBeLessThan(at.tailwind)
    expect(theme.endsWith(WIDGET_TAILWIND_THEME)).toBe(true)
    // 11 套主题都带着（换 data-theme 就换）
    for (const id of ['github-dark', 'github-light', 'nord', 'solarized-light']) {
      expect(theme, id).toContain(`[data-theme='${id}']`)
    }

    const index = utf8(files['src/index.css'])
    const tw = index.indexOf("@import 'tailwindcss';")
    const own = index.indexOf("@import './shuvix-theme.css';")
    expect(tw).toBeGreaterThan(-1)
    expect(own).toBeGreaterThan(tw)
  })

  it('WC-89 index.html：主题脚本在 /src/index.css 之前，正文 = themeBootScript(WIDGET_EXPORT_THEME)', async () => {
    const files = await exportAndUnzip()
    const html = utf8(files['index.html'])

    const open = html.indexOf('<script>')
    const close = html.indexOf('</script>', open)
    const link = html.indexOf('<link rel="stylesheet" href="/src/index.css" />')
    expect(open).toBeGreaterThan(-1)
    expect(link).toBeGreaterThan(-1)
    expect(close).toBeLessThan(link)
    expect(html.slice(open + '<script>'.length, close)).toBe(themeBootScript(WIDGET_EXPORT_THEME))
    expect(html).toContain('var forced = null;')
    expect(html).toContain(
      `var state = ${JSON.stringify({ mode: 'system', light: 'github-light', dark: 'github-dark' })};`
    )
  })

  it('WC-90 EXPORT_NOTES 第 6 条讲主题；文件表里有 src/shuvix-theme.css', async () => {
    const files = await exportAndUnzip()
    const notes = utf8(files['EXPORT_NOTES.md'])
    const six = notes.split('\n').find((l) => l.startsWith('6. ')) ?? ''
    for (const needle of ['src/shuvix-theme.css', 'data-scheme', 'useTheme()', 'themeColor()']) {
      expect(six, needle).toContain(needle)
    }
    const rows = notes.split('\n').filter((l) => l.startsWith('| '))
    expect(rows.some((r) => r.startsWith('| `src/shuvix-theme.css` |'))).toBe(true)
  })

  it('WC-91 组件自己的 src/shuvix-theme.css → 归档里是生成的那份', async () => {
    put('src/shuvix-theme.css', '/* mine */ body { background: hotpink; }\n')
    const files = await exportAndUnzip()
    const theme = utf8(files['src/shuvix-theme.css'])
    expect(theme).toBe(exportThemeCss())
    expect(theme).not.toContain('hotpink')
  })
})

describe('WC-87 带 API 的导出能过类型检查', () => {
  /** 解开到 `<tmp>/unzipped/<id>/`，把仓库的 node_modules 链进去，跑 `tsc -b` → [退出码, 输出] */
  async function unzipAndTypecheck(): Promise<[number, string]> {
    const files = await exportAndUnzip()
    const dir = join(tmp, 'unzipped', ID)
    for (const [path, bytes] of Object.entries(files)) {
      const full = join(dir, path)
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, bytes)
    }
    symlinkSync(join(REPO_DIR, 'node_modules'), join(dir, 'node_modules'), 'dir')
    try {
      const out = execFileSync(
        process.execPath,
        [join(REPO_DIR, 'node_modules/typescript/bin/tsc'), '-b', '--pretty', 'false'],
        { cwd: dir, encoding: 'utf8', stdio: 'pipe' }
      )
      return [0, out]
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string }
      return [err.status ?? -1, `${err.stdout ?? ''}${err.stderr ?? ''}`]
    }
  }

  it.skipIf(process.platform === 'win32')(
    'WC-87 解开后 tsc -b 通过；界面传错参数类型 → tsc 报错（对照）',
    async () => {
      put('index.tsx', indexTsx())
      put('api.ts', API_TS)

      const [code, output] = await unzipAndTypecheck()
      expect(output).toBe('')
      expect(code).toBe(0)

      rmSync(join(tmp, 'unzipped'), { recursive: true, force: true })
      rmSync(join(tmp, 'out'), { recursive: true, force: true })
      put('index.tsx', indexTsx('42'))
      const [badCode, badOutput] = await unzipAndTypecheck()
      expect(badCode).not.toBe(0)
      expect(badOutput).toMatch(/index\.tsx\(\d+,\d+\): error TS2322/)
    },
    120_000
  )
})

// ────────────────────────────── 组件用到的库进 package.json ──────────────────────────────

describe('X-1..12 组件 import 的库进导出项目的 package.json', () => {
  /** 表里的库（按名字取；名字写错直接抛，免得断言落空） */
  const lib = (name: string): WidgetLibrary => {
    const found = WIDGET_LIBRARIES.find((l) => l.name === name)
    if (!found) throw new Error(`not in widgetLibs.json: ${name}`)
    return found
  }
  const names = (libs: readonly WidgetLibrary[]): string[] => libs.map((l) => l.name)

  /** 模板 package.json.tmpl 插值后的样子（与 exportWidget 第 1 步同一份输入；只用到这些占位符） */
  const renderedTemplatePackageJson = (): string => {
    const values: Record<string, string> = {
      WIDGET_ID: ID,
      WIDGET_DESCRIPTION: h.widget!.description,
      REACT_VERSION: EXPORTED_VERSIONS.react,
      REACT_DOM_VERSION: EXPORTED_VERSIONS['react-dom'],
      REACT_ROUTER_VERSION: EXPORTED_VERSIONS['react-router'],
      ZOD_VERSION: EXPORTED_VERSIONS.zod,
      TAILWINDCSS_VERSION: EXPORTED_VERSIONS.tailwindcss,
      TAILWINDCSS_VITE_VERSION: EXPORTED_VERSIONS['@tailwindcss/vite'],
      TYPES_REACT_VERSION: EXPORTED_VERSIONS['@types/react'],
      TYPES_REACT_DOM_VERSION: EXPORTED_VERSIONS['@types/react-dom'],
      VITEJS_PLUGIN_REACT_VERSION: EXPORTED_VERSIONS['@vitejs/plugin-react'],
      TYPESCRIPT_VERSION: EXPORTED_VERSIONS.typescript,
      VITE_VERSION: EXPORTED_VERSIONS.vite
    }
    const text = readFileSync(join(TEMPLATE_DIR, 'package.json.tmpl'), 'utf8').replace(
      /\{\{([A-Z_]+)\}\}/g,
      (match, key: string) => values[key] ?? match
    )
    expect(text).not.toContain('{{')
    return text
  }

  interface Pkg {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
    [key: string]: unknown
  }

  const SCREEN_WITHOUT_LIBRARIES = `import { createRoot } from 'react-dom/client'
const el = document.getElementById('root')
if (el) createRoot(el).render(<p>hi</p>)
`

  it('X-1 各种写法都认、按表里的顺序、不重复', () => {
    const sources = [
      `import { Plus } from 'lucide-react'
import { OrbitControls } from "three/addons/controls/OrbitControls.js"
import { useSortable } from '@dnd-kit/sortable'
import hljs from 'highlight.js/lib/core'
`,
      `import 'chart.js/auto'
const d3 = await import('d3')
import
'uplot/dist/uPlot.min.css'
export { default as dayjs } from 'dayjs'
import { Trash2 } from 'lucide-react'
`
    ]
    expect(names(librariesImportedBy(sources))).toEqual([
      'lucide-react',
      'chart.js',
      'uplot',
      'd3',
      'dayjs',
      '@dnd-kit/sortable',
      'highlight.js',
      'three'
    ])
    // 顺序就是表里的顺序（不是出现的顺序）
    const order = WIDGET_LIBRARIES.map((l) => l.name)
    const got = names(librariesImportedBy(sources)).map((n) => order.indexOf(n))
    expect(got).toEqual([...got].sort((a, b) => a - b))
  })

  it('X-2 只有非库的 import → []', () => {
    const source = `import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { createClient } from 'shuvix/widget'
import { List } from './local'
import { z } from 'zod'
import pad from 'left-pad'
import x from '@dnd-kit'
`
    expect(librariesImportedBy([source])).toEqual([])
    expect(librariesImportedBy([])).toEqual([])
  })

  it('X-3 多行具名 import 与 import type 算；裸字符串、引号对不上的不算', () => {
    expect(
      names(
        librariesImportedBy([
          `import {\n  Chart,\n  BarController,\n  BarElement,\n} from 'chart.js'\n`
        ])
      )
    ).toEqual(['chart.js'])
    expect(names(librariesImportedBy([`import type { Mesh } from 'three'\n`]))).toEqual(['three'])
    expect(librariesImportedBy([`const s = 'three'\nconsole.log(s)\n`])).toEqual([])
    expect(librariesImportedBy([`import dayjs from 'dayjs"\n`])).toEqual([])
  })

  it('X-4 补库与类型包：键按字母排，别的顶层键不动，2 空格、结尾换行', () => {
    const input = renderedTemplatePackageJson()
    const before = JSON.parse(input) as Pkg
    const out = withLibraryDependencies(input, [lib('three'), lib('d3'), lib('lucide-react')])

    expect(out.endsWith('}\n')).toBe(true)
    const pkg = JSON.parse(out) as Pkg
    expect(out).toBe(JSON.stringify(pkg, null, 2) + '\n')

    expect(Object.keys(pkg)).toEqual(Object.keys(before))
    for (const key of Object.keys(before)) {
      if (key === 'dependencies' || key === 'devDependencies') continue
      expect(pkg[key], key).toEqual(before[key])
    }

    expect(pkg.dependencies).toEqual({
      ...before.dependencies,
      three: lib('three').version,
      d3: lib('d3').version,
      'lucide-react': lib('lucide-react').version
    })
    expect(Object.keys(pkg.dependencies!)).toEqual([
      'd3',
      'lucide-react',
      'react',
      'react-dom',
      'react-router',
      'three',
      'zod'
    ])
    // 精确版本（不带 ^ ~）
    expect(pkg.dependencies!.three).toBe('0.187.0')
    expect(pkg.dependencies!.d3).toBe('7.9.0')
    expect(pkg.dependencies!['lucide-react']).toBe('0.564.0')

    expect(pkg.devDependencies).toEqual({
      ...before.devDependencies,
      ...lib('three').exportTypes,
      ...lib('d3').exportTypes
    })
    expect(pkg.devDependencies!['@types/three']).toBe('^0.187.0')
    expect(pkg.devDependencies!['@types/d3']).toBe('^7.4.3')
    expect(Object.keys(pkg.devDependencies!)).toEqual([
      '@tailwindcss/vite',
      '@types/d3',
      '@types/react',
      '@types/react-dom',
      '@types/three',
      '@vitejs/plugin-react',
      'tailwindcss',
      'typescript',
      'vite'
    ])
  })

  it('X-5 已有的旧版本换成表里的', () => {
    const input = JSON.stringify({ name: 'x', dependencies: { three: '^0.1.0', react: '^19' } })
    const pkg = JSON.parse(withLibraryDependencies(input, [lib('three')])) as Pkg
    expect(pkg.dependencies).toEqual({ react: '^19', three: lib('three').version })
  })

  it('X-6 输入没有依赖键：只补 dependencies；库不带类型包就不写空的 devDependencies', () => {
    const input = JSON.stringify({ name: 'x', private: true })

    const plain = JSON.parse(withLibraryDependencies(input, [lib('dayjs')])) as Pkg
    expect(plain).toEqual({ name: 'x', private: true, dependencies: { dayjs: '1.11.23' } })
    expect(Object.keys(plain)).toEqual(['name', 'private', 'dependencies'])
    expect('devDependencies' in plain).toBe(false)

    // 对照：带类型包的库照样补出 devDependencies
    const typed = JSON.parse(
      withLibraryDependencies(input, [lib('dayjs'), lib('papaparse')])
    ) as Pkg
    expect(typed.dependencies).toEqual({
      dayjs: lib('dayjs').version,
      papaparse: lib('papaparse').version
    })
    expect(typed.devDependencies).toEqual(lib('papaparse').exportTypes)
    expect(Object.keys(typed)).toEqual(['name', 'private', 'dependencies', 'devDependencies'])
  })

  it('X-7 exportWidget：界面与子组件用到的库都进 package.json，模板的依赖不变', async () => {
    put(
      'index.tsx',
      `import { createRoot } from 'react-dom/client'
import { Plus } from 'lucide-react'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { scaleLinear } from 'd3'
import Papa from 'papaparse'
import { Chart } from './components/Chart'

console.log(OrbitControls, scaleLinear, Papa)
const el = document.getElementById('root')
if (el) createRoot(el).render(<div><Plus /><Chart /></div>)
`
    )
    put(
      'components/Chart.tsx',
      `import { Chart as ChartJS } from 'chart.js'\nexport function Chart() {\n  console.log(ChartJS)\n  return <canvas />\n}\n`
    )
    put('api.ts', API_TS)

    const files = await exportAndUnzip()
    const template = JSON.parse(renderedTemplatePackageJson()) as Pkg
    const pkg = JSON.parse(utf8(files['package.json'])) as Pkg

    expect(Object.keys(pkg.dependencies!)).toEqual([
      'chart.js',
      'd3',
      'lucide-react',
      'papaparse',
      'react',
      'react-dom',
      'react-router',
      'three',
      'zod'
    ])
    for (const [name, version] of Object.entries(template.dependencies!)) {
      expect(pkg.dependencies![name], name).toBe(version)
    }
    for (const name of ['chart.js', 'd3', 'lucide-react', 'papaparse', 'three']) {
      expect(pkg.dependencies![name], name).toBe(lib(name).version)
    }

    expect(Object.keys(pkg.devDependencies!)).toEqual([
      '@tailwindcss/vite',
      '@types/d3',
      '@types/papaparse',
      '@types/react',
      '@types/react-dom',
      '@types/three',
      '@vitejs/plugin-react',
      'tailwindcss',
      'typescript',
      'vite'
    ])
    expect(pkg.devDependencies).toEqual({
      ...template.devDependencies,
      ...lib('d3').exportTypes,
      ...lib('papaparse').exportTypes,
      ...lib('three').exportTypes
    })
    // 别的顶层键照旧
    expect(pkg.name).toBe(ID)
    expect(pkg.scripts).toEqual(template.scripts)
  })

  it('X-8 一个库都不用 → package.json 与模板插值后逐字节相同', async () => {
    put('index.tsx', SCREEN_WITHOUT_LIBRARIES)
    put('api.ts', API_TS)

    const files = await exportAndUnzip()
    expect(utf8(files['package.json'])).toBe(renderedTemplatePackageJson())
    expect(utf8(files['package.json'])).not.toContain('lucide-react')
  })

  it('X-9 库只出现在不扫的地方 → package.json 不变', async () => {
    put('index.tsx', SCREEN_WITHOUT_LIBRARIES)
    put('notes.md', "```ts\nimport * as THREE from 'three'\n```\n")
    put('data.json', JSON.stringify({ code: "import { x } from 'three'" }))
    // 与模板同名：归档里是模板的那份，组件这份不扫
    put('src/shuvix-widget.ts', "import 'dayjs'\nexport const mine = true\n")
    // node_modules 不进归档，也不扫
    put('node_modules/x/index.js', "import * as THREE from 'three'\nexport default THREE\n")

    const files = await exportAndUnzip()
    expect(utf8(files['package.json'])).toBe(renderedTemplatePackageJson())
    expect(utf8(files['notes.md'])).toContain("from 'three'")
  })

  it('X-10 只从 .css 的 @import、或只经 require() 引的库照样补进去', async () => {
    put('index.tsx', `import './style.css'\n${SCREEN_WITHOUT_LIBRARIES}`)
    put('style.css', '@import "uplot/dist/uPlot.min.css";\n.box { color: red; }\n')
    put('more.css', "@import url('highlight.js/styles/github.css');\n")
    put('legacy.js', "const dayjs = require('dayjs')\nmodule.exports = dayjs\n")

    const files = await exportAndUnzip()
    const pkg = JSON.parse(utf8(files['package.json'])) as Pkg
    expect(pkg.dependencies!.uplot).toBe(lib('uplot').version)
    expect(pkg.dependencies!['highlight.js']).toBe(lib('highlight.js').version)
    expect(pkg.dependencies!.dayjs).toBe(lib('dayjs').version)

    // 纯函数上同样的三种写法
    expect(
      names(
        librariesImportedBy([
          '@import "uplot/dist/uPlot.min.css";',
          "@import url('highlight.js/styles/github.css');",
          '@import url("dayjs/x.css");',
          "const Papa = require('papaparse')"
        ])
      )
    ).toEqual(['uplot', 'papaparse', 'dayjs', 'highlight.js'])
  })

  it.skipIf(process.platform === 'win32')(
    'X-11 只用自带类型的库：解开后 tsc -b 通过',
    async () => {
      put(
        'index.tsx',
        `import { useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { Plus } from 'lucide-react'
import { Chart, BarController, BarElement, CategoryScale, LinearScale } from 'chart.js'
import dayjs from 'dayjs'
import { useVirtualizer } from '@tanstack/react-virtual'

Chart.register(BarController, BarElement, CategoryScale, LinearScale)

function App() {
  const parent = useRef<HTMLDivElement>(null)
  const rows = useVirtualizer({
    count: 100,
    getScrollElement: () => parent.current,
    estimateSize: () => 24
  })
  return (
    <div ref={parent}>
      <Plus className="size-4" />
      <span>{dayjs('2026-01-01').add(1, 'day').format('YYYY-MM-DD')}</span>
      {rows.getVirtualItems().map((r) => (
        <div key={r.key}>{r.index}</div>
      ))}
    </div>
  )
}

const el = document.getElementById('root')
if (el) createRoot(el).render(<App />)
`
      )
      const files = await exportAndUnzip()
      const pkg = JSON.parse(utf8(files['package.json'])) as Pkg
      expect(Object.keys(pkg.dependencies!)).toEqual(
        expect.arrayContaining(['lucide-react', 'chart.js', 'dayjs', '@tanstack/react-virtual'])
      )
      const dir = join(tmp, 'unzipped', ID)
      for (const [path, bytes] of Object.entries(files)) {
        const full = join(dir, path)
        mkdirSync(dirname(full), { recursive: true })
        writeFileSync(full, bytes)
      }
      symlinkSync(join(REPO_DIR, 'node_modules'), join(dir, 'node_modules'), 'dir')
      let code = 0
      let output = ''
      try {
        output = execFileSync(
          process.execPath,
          [join(REPO_DIR, 'node_modules/typescript/bin/tsc'), '-b', '--pretty', 'false'],
          { cwd: dir, encoding: 'utf8', stdio: 'pipe' }
        )
      } catch (e) {
        const err = e as { status?: number; stdout?: string; stderr?: string }
        code = err.status ?? -1
        output = `${err.stdout ?? ''}${err.stderr ?? ''}`
      }
      expect(output).toBe('')
      expect(code).toBe(0)
    },
    120_000
  )

  it('X-12 EXPORT_NOTES 第 3 条讲 ShuviX 随带的库，不再说只有 react … spectacle', async () => {
    put('index.tsx', SCREEN_WITHOUT_LIBRARIES)
    const files = await exportAndUnzip()
    const notes = utf8(files['EXPORT_NOTES.md'])
    const three = notes.split('\n').find((l) => l.startsWith('3. ')) ?? ''
    expect(three).toContain('**Dependencies**')
    expect(notes).not.toContain('spectacle')
    expect(three).not.toMatch(/Only `react`/)
    expect(three).toContain('the libraries ShuviX ships')
    expect(three).toContain('this widget imports')
    expect(three).toContain('type packages')
  })
})
