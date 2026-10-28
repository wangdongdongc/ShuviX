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

import { exportWidget } from '../widgetExporter'
import { EXPORTED_VERSIONS } from '../exportedVersions'

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
