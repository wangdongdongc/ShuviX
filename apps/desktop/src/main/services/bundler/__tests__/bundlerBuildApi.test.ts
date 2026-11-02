/**
 * `BundlerService.buildApi` —— 把组件的 `api.ts` 打成给 QuickJS 执行的 IIFE（设计稿 docs/widget-tool-design.md §3、§6），
 * 以及界面打包 `build()` 的同一道「只许组件目录里的文件」门。
 * 真的 esbuild-wasm（与 cliWidgetBuild.test.ts 一样，afterAll 里 stop）；资源目录是仓库里的 `resources/bundler`
 * （`deps/widget-api.esm.js` / `deps/zod.esm.js`）。每条用例在临时目录里搭：
 *   <root>/outside.ts                 组件目录外的文件
 *   <root>/secret/data.ts             组件目录外的目录（给目录符号链接指）
 *   <root>/other-widget/api.ts        隔壁组件
 *   <root>/w-a/…                      被打包的组件
 *
 *   B-1 api.ts import `shuvix/widget-api`、`zod`、`./lib/helpers` → 成功；产物是 IIFE、没有顶层 import / export，
 *       最后一句是把默认导出交给运行时的那次调用
 *   B-2 产物放进 `node:vm`（给一个假的 `__host`）跑：`__widget.manifest()` 列出操作、没有「needs input: z.object」
 *       错误（zod 是同一个实例）；`__host` 从全局摘掉了；`__widget.call` 跑得通（辅助文件也打进去了）
 *   B-3 裸模块一律拒绝（`can only import …`）：react、fs、node:fs、zod/v4、zod/mini、shuvix/widget、@scope/pkg ——
 *       从相对路径的辅助文件里 import 也一样
 *   B-4 [安全] import 到组件目录之外 → 拒绝（`is outside this widget's directory`）：`../../outside.ts`（从子目录爬出去）、
 *       `../outside`、`../other-widget/api.ts`、绝对路径、目录里指向外面的文件符号链接 / 目录符号链接；界面的 `build()`
 *       同样拒绝，而界面入口本身（绝对路径）照常打包
 *   B-5 没有默认导出 / TS 语法错 → success false，错误是格式化好的文本，带文件名与行号
 *   B-6 用 scripts/bundle-widget-api.mjs 的选项重打 sandboxRuntime.ts → 与 resources/bundler/deps/widget-api.esm.js
 *       逐字节相同（改了运行时却没重跑脚本，这里就红）
 *
 * 打包从不带进组件目录外面的文件（后缀、package.json、符号链接、CSS 都绕不出去）。根目录下放 secret.txt / .json / .png、
 * o.css、only.ts、pkg（main）、pkgm（module）、sdir/f.txt，内容都带同一个标记；组件里放 link.txt、link.png、ldir（指向
 * 外面的符号链接）、opkg（main 指到外面）、bpkg（browser 字段把 ./m.js 映射到外面）。失败都断：success false、没有产物、
 * 错误里没有标记也没有它的 base64、错误带 file:line:col。
 *   BE-1  界面 import：`?a` / `#a` / `?a#b` 后缀、`../secret`（补 .json）、`../only.js`（TS 的 .js → .ts）、`../pkg`、`../pkgm`、
 *         `./sub/../../secret.txt?a`、`./link.txt?a`、`./ldir/f.txt?a`、`./opkg` → `"X" is outside this widget's directory`
 *   BE-2  `./bpkg` 的 index.ts import ./m.js，browser 字段映射到外面 → 拒绝，点名 ./m.js
 *   BE-3  别的写法：require、动态 import、export *、import './x.css' → 一样拒绝
 *   BE-4  裸写的 `a/../../secret.txt`，有没有 tsconfig baseUrl → 不可用，不带标记
 *   BE-5  api.ts：`?a`、`#a`、`../secret`、`../only.js`、`./link.txt?a`、`../secret.txt?raw` → 拒绝
 *   BE-6  api.ts：`../pkg`、`./opkg` → Could not resolve（neutral 平台不看 main），不带标记
 *   BE-7  CSS 的 url(…)：各种写法与符号链接 → 拒绝，位置在 st.css:1:…，产物里没有 base64
 *   BE-8  CSS 的 @import：`"../o.css?x"`、`"a/../../o.css"`、`url(a/../../o.css)` → 拒绝；`"a/../../o.css?x"` → 不可用
 *   BE-9  CSS 的 url(%2e%2e/…)、url(..%2F…) → Could not resolve，不漏内容
 *   BE-10 组件目录里的照常（JS）：`?a`、`#a`、`.json?x`、`./data`、`.png?v=1`、main 在里面的包、子目录、指向里面的符号链接带后缀。
 *         临时目录不 realpath（macOS 的 /var → /private/var 正好走到真实路径的比较）
 *   BE-11 组件目录里的照常（CSS）：url 带后缀 → image/png 的 data URL（只有纯 `#h` 留着），@import "s.css?x" 内联；
 *         url(#frag)、url(data:…)、url(https://…) 原样
 *   BE-12 api.ts：`./x.txt?a`、`./data` → 成功，内容在产物里
 *   BR-11 `?raw` 只给界面：api.ts 的 `./mod.js?raw` 走的是模块（`No matching export`），不是文本
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import vm from 'node:vm'
import { build as nativeBuild } from 'esbuild'
import { stop as stopEsbuild } from 'esbuild-wasm'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BundlerService } from '../bundlerService'

/** apps/desktop */
const DESKTOP_DIR = resolve(__dirname, '../../../../..')
const RESOURCES = join(DESKTOP_DIR, 'resources/bundler')
const DEPS_DIR = join(RESOURCES, 'deps')
const SANDBOX_RUNTIME = join(DESKTOP_DIR, 'src/main/services/widget/api/sandboxRuntime.ts')

const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
const bundler = new BundlerService((p) => join(RESOURCES, p), silentLogger)

let root = ''
/** 被打包的组件目录 */
let widgetDir = ''

/** 在组件目录（或以 `../` 开头时相对它）写文件 */
function put(name: string, content: string): string {
  const full = resolve(widgetDir, name)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
  return full
}

const HELPERS = 'export const twice = (n: number): number => n * 2\n'

/** 一份正常的 api.ts：op / defineApi 来自 widget-api，z 来自 zod，计算来自相对路径的辅助文件 */
const GOOD_API = `import { defineApi, op } from 'shuvix/widget-api'
import { z } from 'zod'
import { twice } from './lib/helpers'

export default defineApi({
  double: op.read({
    description: 'Double a number',
    input: z.object({ n: z.number() }),
    output: z.number(),
    handler: (input) => twice(input.n)
  }),
  addNote: op.write({
    description: 'Add a note',
    input: z.object({ text: z.string() }),
    handler: async (input, ctx) => ctx.db.sql\`INSERT INTO notes(text) VALUES (\${input.text}) RETURNING id\`
  })
})
`

/** 一个只 import 某个模块的 api.ts（模块拿来当默认导出，免得被 tree-shake 掉） */
const importing = (spec: string): string =>
  `import mod from ${JSON.stringify(spec)}\nexport default { mod }\n`

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'shuvix-buildapi-'))
  widgetDir = join(root, 'w-a')
  mkdirSync(widgetDir)
  writeFileSync(join(root, 'outside.ts'), 'export default 1\nexport const secret = "outside"\n')
  mkdirSync(join(root, 'secret'))
  writeFileSync(join(root, 'secret', 'data.ts'), 'export default "secret"\n')
  mkdirSync(join(root, 'other-widget'))
  writeFileSync(join(root, 'other-widget', 'api.ts'), 'export default { other: true }\n')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

afterAll(async () => {
  await stopEsbuild()
})

describe('B-1 / B-2 正常的 api.ts', () => {
  it('B-1 import widget-api、zod、相对辅助文件 → 成功；IIFE，没有顶层 import / export，末尾是安装调用', async () => {
    put('api.ts', GOOD_API)
    put('lib/helpers.ts', HELPERS)

    const r = await bundler.buildApi(widgetDir)

    expect(r.errors).toBeUndefined()
    expect(r.success).toBe(true)
    const js = r.outputJS ?? ''
    expect(js.length).toBeGreaterThan(0)
    // IIFE：整段是 `(() => { … })();`
    expect(js.trimStart().startsWith('(() => {')).toBe(true)
    expect(js.trimEnd().endsWith('})();')).toBe(true)
    // 没有顶层（不缩进的）import / export：QuickJS 按脚本执行，没有模块加载器
    expect(js).not.toMatch(/^(import|export)\b/m)
    // 生成的入口：最后一句把 api.ts 的默认导出交给运行时（运行时的名字被压缩过，只认调用的形状）
    expect(js).toMatch(/\n\s*[\w$]+\(api_default\);\s*\}\)\(\);\s*$/)
    // 运行时装 `__widget`、收走 `__host`
    expect(js).toContain('__widget')
    expect(js).toContain('__host')
  })

  it('B-2 产物在 node:vm 里跑：清单列出操作、没有 z.object 错误；__host 被摘掉；call 跑得通', async () => {
    put('api.ts', GOOD_API)
    put('lib/helpers.ts', HELPERS)
    const r = await bundler.buildApi(widgetDir)
    expect(r.success).toBe(true)

    const host = {
      db: vi.fn(() => '[]'),
      tx: vi.fn(() => 'sp'),
      log: vi.fn(),
      uuid: vi.fn(() => '00000000-0000-4000-8000-000000000000')
    }
    const sandbox = vm.createContext({ __host: host }) as Record<string, unknown>
    vm.runInContext(r.outputJS ?? '', sandbox)

    // 运行时把 __host 收进闭包、从全局摘掉
    expect('__host' in sandbox).toBe(false)
    const widget = sandbox.__widget as {
      manifest(): string
      call(name: string, args: string, caller: string): Promise<string>
    }
    const manifest = JSON.parse(widget.manifest()) as {
      ops: { name: string; mode: string; description: string; agent: boolean }[]
      errors: string[]
    }
    // zod 若是两份实例，`input instanceof z.ZodObject` 不成立 → 「needs input: z.object」
    expect(manifest.errors).toEqual([])
    expect(manifest.ops.map((o) => [o.name, o.mode, o.description, o.agent])).toEqual([
      ['double', 'read', 'Double a number', true],
      ['addNote', 'write', 'Add a note', true]
    ])

    // 辅助文件确实打进去了：double 调到 twice
    const out = await widget.call(
      'double',
      JSON.stringify({ n: 21 }),
      JSON.stringify({ kind: 'user', label: 'user' })
    )
    expect(JSON.parse(out)).toEqual({ ok: true, value: 42 })
    expect(host.db).not.toHaveBeenCalled()
  })
})

describe('B-3 裸模块一律拒绝', () => {
  const BARE = ['react', 'fs', 'node:fs', 'zod/v4', 'zod/mini', 'shuvix/widget', '@scope/pkg']

  it.each(BARE)('B-3 api.ts import %j → 失败，`can only import …`', async (spec) => {
    put('api.ts', importing(spec))

    const r = await bundler.buildApi(widgetDir)

    expect(r.success).toBe(false)
    expect(r.outputJS).toBeUndefined()
    const text = (r.errors ?? []).join('\n')
    expect(text).toContain('api.ts can only import "shuvix/widget-api", "zod"')
    expect(text).toContain(`(not "${spec}")`)
  })

  it.each(BARE)('B-3 相对辅助文件 import %j → 同样拒绝，错误指向那个辅助文件', async (spec) => {
    put(
      'api.ts',
      `import { defineApi } from 'shuvix/widget-api'\nimport helper from './lib/helper'\nexport default defineApi({ helper } as never)\n`
    )
    put('lib/helper.ts', importing(spec))

    const r = await bundler.buildApi(widgetDir)

    expect(r.success).toBe(false)
    const text = (r.errors ?? []).join('\n')
    expect(text).toContain(`(not "${spec}")`)
    expect(text).toMatch(/lib\/helper\.ts:1:\d+/)
  })
})

describe('B-4 [安全] 组件目录之外的 import 一律拒绝', () => {
  const OUTSIDE = "is outside this widget's directory"

  it.each([
    ['../outside', 'api.ts 直接爬出去'],
    ['../outside.ts', '带扩展名'],
    ['../other-widget/api.ts', '隔壁组件的 api.ts'],
    ['../other-widget/api', '隔壁组件、补扩展名']
  ])('B-4 api.ts import %j（%s）→ 拒绝', async (spec) => {
    put('api.ts', importing(spec))

    const r = await bundler.buildApi(widgetDir)

    expect(r.success).toBe(false)
    expect(r.outputJS).toBeUndefined()
    expect((r.errors ?? []).join('\n')).toContain(`"${spec}" ${OUTSIDE}`)
  })

  it('B-4 子目录里的辅助文件 `../../outside.ts` 爬出组件目录 → 拒绝', async () => {
    put('api.ts', `import x from './lib/deep'\nexport default { x }\n`)
    put('lib/deep.ts', importing('../../outside.ts'))

    const r = await bundler.buildApi(widgetDir)

    expect(r.success).toBe(false)
    expect((r.errors ?? []).join('\n')).toContain(`"../../outside.ts" ${OUTSIDE}`)
  })

  it('B-4 绝对路径的 import（哪怕指向组件目录里面）→ 拒绝', async () => {
    const inside = put('lib/helpers.ts', HELPERS)
    for (const target of [join(root, 'outside.ts'), inside]) {
      put('api.ts', importing(target))
      const r = await bundler.buildApi(widgetDir)
      expect(r.success, target).toBe(false)
      expect((r.errors ?? []).join('\n'), target).toContain(OUTSIDE)
    }
  })

  it('B-4 组件目录里指向外面的文件符号链接 / 目录符号链接 → 拒绝（按真实路径比）', async () => {
    mkdirSync(join(widgetDir, 'lib'))
    symlinkSync(join(root, 'outside.ts'), join(widgetDir, 'lib', 'link.ts'))
    symlinkSync(join(root, 'secret'), join(widgetDir, 'shared'))

    for (const spec of ['./lib/link', './lib/link.ts', './shared/data']) {
      put('api.ts', importing(spec))
      const r = await bundler.buildApi(widgetDir)
      expect(r.success, spec).toBe(false)
      expect((r.errors ?? []).join('\n'), spec).toContain(`"${spec}" ${OUTSIDE}`)
    }
  })

  it('B-4 组件目录里指向目录里文件的符号链接照常打包（对照：门只看真实路径落在哪）', async () => {
    put('lib/helpers.ts', HELPERS)
    symlinkSync(join(widgetDir, 'lib', 'helpers.ts'), join(widgetDir, 'alias.ts'))
    put('api.ts', `import { twice } from './alias'\nexport default { v: twice(2) }\n`)

    const r = await bundler.buildApi(widgetDir)

    expect(r.errors).toBeUndefined()
    expect(r.success).toBe(true)
  })

  it('B-4 界面 build()：入口（绝对路径）照常打包；import 到外面（相对 / 绝对 / 符号链接）→ 拒绝', async () => {
    const entry = put('index.tsx', `console.log('hello widget')\n`)
    const ok = await bundler.build(entry, widgetDir)
    expect(ok.errors).toBeUndefined()
    expect(ok.success).toBe(true)
    expect(ok.outputJS).toContain('hello widget')

    symlinkSync(join(root, 'outside.ts'), join(widgetDir, 'link.ts'))
    for (const spec of [
      '../outside',
      '../other-widget/api.ts',
      join(root, 'outside.ts'),
      './link'
    ]) {
      put('index.tsx', `import x from ${JSON.stringify(spec)}\nconsole.log(x)\n`)
      const r = await bundler.build(entry, widgetDir)
      expect(r.success, spec).toBe(false)
      expect(r.outputJS, spec).toBeUndefined()
      expect((r.errors ?? []).join('\n'), spec).toContain(OUTSIDE)
    }
  })
})

describe('B-5 编不过的 api.ts', () => {
  it('B-5 没有默认导出 → 失败，错误带生成入口的文件名与行号', async () => {
    put('api.ts', `export const notDefault = 1\n`)

    const r = await bundler.buildApi(widgetDir)

    expect(r.success).toBe(false)
    expect(r.outputJS).toBeUndefined()
    const text = (r.errors ?? []).join('\n')
    expect(text).toContain('No matching export')
    expect(text).toContain('"default"')
    expect(text).toMatch(/api-entry\.ts:1:\d+/)
  })

  it('B-5 TS 语法错 → 失败，错误带 api.ts 的行号与那一行', async () => {
    put('api.ts', `import { z } from 'zod'\n\nconst x: number = (\nexport default { z, x }\n`)

    const r = await bundler.buildApi(widgetDir)

    expect(r.success).toBe(false)
    expect(r.errors?.length).toBeGreaterThan(0)
    const text = (r.errors ?? []).join('\n')
    expect(text).toMatch(/\[ERROR\]/)
    expect(text).toMatch(/api\.ts:4:\d+/)
    expect(text).toContain('export default { z, x }')
  })

  it('B-5 组件目录里没有 api.ts → 失败（不是抛错）', async () => {
    const r = await bundler.buildApi(widgetDir)
    expect(r.success).toBe(false)
    expect((r.errors ?? []).join('\n')).toContain('api.ts')
  })
})

describe('B-6 随包的 widget-api.esm.js 与源码一致', () => {
  it('B-6 用 bundle-widget-api.mjs 的选项重打 sandboxRuntime.ts → 逐字节相同', async () => {
    // 选项抄自 scripts/bundle-widget-api.mjs 的 `common` + widget-api 那一次（只把 write 关掉、日志静音）
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
      entryPoints: [SANDBOX_RUNTIME],
      external: ['zod'],
      outfile: join(DEPS_DIR, 'widget-api.esm.js'),
      write: false
    })
    expect(result.outputFiles).toHaveLength(1)
    const rebuilt = Buffer.from(result.outputFiles[0].contents)
    const shipped = readFileSync(join(DEPS_DIR, 'widget-api.esm.js'))
    // 先比文本（失败时的 diff 可读），再比字节
    expect(rebuilt.toString('utf8')).toBe(shipped.toString('utf8'))
    expect(rebuilt.equals(shipped)).toBe(true)
  })
})

describe('BE 打包不带进组件目录外面的文件', () => {
  const MARKER = 'OUTSIDE_MARKER_Zq7'
  const MARKER_B64 = Buffer.from(MARKER).toString('base64')
  const OUTSIDE = (spec: string): string => `"${spec}" is outside this widget's directory`
  const INDEX_AT = /index\.tsx:1:\d+/

  /** 在根目录（组件目录外面）写文件 */
  const out = (name: string, content: string): void => {
    const full = join(root, name)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }

  beforeEach(() => {
    out('secret.txt', MARKER)
    out('secret.json', JSON.stringify({ m: MARKER }))
    out('secret.png', MARKER)
    out('o.css', `.o-${MARKER} { color: red }\n`)
    out('only.ts', `export default '${MARKER}'\n`)
    out('pkg/package.json', JSON.stringify({ main: 'lib.js' }))
    out('pkg/lib.js', `export default '${MARKER}'\n`)
    out('pkgm/package.json', JSON.stringify({ module: 'lib.js' }))
    out('pkgm/lib.js', `export default '${MARKER}'\n`)
    out('sdir/f.txt', MARKER)
    symlinkSync(join(root, 'secret.txt'), join(widgetDir, 'link.txt'))
    symlinkSync(join(root, 'secret.png'), join(widgetDir, 'link.png'))
    symlinkSync(join(root, 'sdir'), join(widgetDir, 'ldir'))
    put('opkg/package.json', JSON.stringify({ main: '../../secret.txt' }))
    put('bpkg/package.json', JSON.stringify({ browser: { './m.js': '../../secret.txt' } }))
    put('bpkg/index.ts', `import m from './m.js'\nexport default m\n`)
  })

  interface Built {
    success: boolean
    outputJS?: string
    outputCSS?: string
    errors?: string[]
  }

  const screen = (source: string): Promise<Built> => {
    const entry = put('index.tsx', source)
    return bundler.build(entry, widgetDir)
  }
  const importingAndLogging = (spec: string): string =>
    `import t from ${JSON.stringify(spec)}\nconsole.log(t)\n`
  /** 一份只引一个样式表的界面 */
  const styled = (css: string): Promise<Built> => {
    put('st.css', css)
    return screen(`import './st.css'\nconsole.log(1)\n`)
  }

  function expectRefused(r: Built, text: string, at: RegExp): void {
    const all = (r.errors ?? []).join('\n')
    expect(r.success, all).toBe(false)
    expect(r.outputJS).toBeUndefined()
    expect(r.outputCSS).toBeUndefined()
    expect(all).toContain(text)
    expect(all).toMatch(at)
    expect(all).not.toContain(MARKER)
    expect(all).not.toContain(MARKER_B64)
  }

  function expectBuilt(r: Built): { js: string; css: string } {
    expect(r.errors, (r.errors ?? []).join('\n')).toBeUndefined()
    expect(r.success).toBe(true)
    return { js: r.outputJS ?? '', css: r.outputCSS ?? '' }
  }

  it.each([
    '../secret.txt?a',
    '../secret.txt#a',
    '../secret.txt?a#b',
    '../secret',
    '../only.js',
    '../pkg',
    '../pkgm',
    './sub/../../secret.txt?a',
    './link.txt?a',
    './ldir/f.txt?a',
    './opkg'
  ])('BE-1 界面 import %j → 拒绝', async (spec) => {
    expectRefused(await screen(importingAndLogging(spec)), OUTSIDE(spec), INDEX_AT)
  })

  it('BE-2 browser 字段把 ./m.js 映射到外面 → 拒绝，点名 ./m.js', async () => {
    expectRefused(
      await screen(importingAndLogging('./bpkg')),
      OUTSIDE('./m.js'),
      /bpkg\/index\.ts:1:\d+/
    )
  })

  it.each([
    ['require', `const t = require('../secret.txt?a')\nconsole.log(t)\n`, '../secret.txt?a'],
    ['动态 import', `import('../secret.txt#a').then(console.log)\n`, '../secret.txt#a'],
    ['export *', `export * from '../secret.json?x'\n`, '../secret.json?x'],
    ['import 样式表', `import '../o.css?x'\n`, '../o.css?x']
  ])('BE-3 %s → 拒绝', async (_what, source, spec) => {
    expectRefused(await screen(source), OUTSIDE(spec), INDEX_AT)
  })

  it.each([
    ['没有 tsconfig', undefined],
    ['tsconfig baseUrl', JSON.stringify({ compilerOptions: { baseUrl: '.' } })]
  ])('BE-4 裸写的 a/../../secret.txt（%s）→ 不可用', async (_what, tsconfig) => {
    if (tsconfig) put('tsconfig.json', tsconfig)
    expectRefused(
      await screen(importingAndLogging('a/../../secret.txt')),
      '"a/../../secret.txt" is not available in widgets',
      INDEX_AT
    )
  })

  it.each([
    '../secret.txt?a',
    '../secret.txt#a',
    '../secret',
    '../only.js',
    './link.txt?a',
    '../secret.txt?raw'
  ])('BE-5 api.ts import %j → 拒绝', async (spec) => {
    put('api.ts', importing(spec))
    expectRefused(await bundler.buildApi(widgetDir), OUTSIDE(spec), /api\.ts:1:\d+/)
  })

  it.each(['../pkg', './opkg'])(
    'BE-6 api.ts import %j → Could not resolve（neutral 平台不看 main）',
    async (spec) => {
      put('api.ts', importing(spec))
      expectRefused(
        await bundler.buildApi(widgetDir),
        `Could not resolve "${spec}"`,
        /api\.ts:1:\d+/
      )
    }
  )

  it.each([
    '../secret.png',
    '../secret.png?v=1',
    '../secret.png#a',
    '"../secret.png?a#b"',
    'a/../../secret.png',
    './a/../../secret.png?x',
    'a/../../secret.png?x',
    'link.png',
    'link.png?x'
  ])('BE-7 CSS 的 url(%s) → 拒绝，位置在样式表里', async (written) => {
    const spec = written.replace(/"/g, '')
    expectRefused(
      await styled(`.a { background: url(${written}); }\n`),
      OUTSIDE(spec),
      /st\.css:1:\d+/
    )
  })

  it.each([
    ['"../o.css?x"', OUTSIDE('../o.css?x')],
    // esbuild 先按样式表旁边的文件试一遍：报错里是它补了 ./ 的那一次
    ['"a/../../o.css"', OUTSIDE('./a/../../o.css')],
    ['url(a/../../o.css)', OUTSIDE('./a/../../o.css')],
    ['"a/../../o.css?x"', '"a/../../o.css?x" is not available in widgets']
  ])('BE-8 CSS 的 @import %s → 拒绝', async (written, text) => {
    expectRefused(await styled(`@import ${written};\n.m { color: red; }\n`), text, /st\.css:1:\d+/)
  })

  it.each(['%2e%2e/secret.png', '..%2Fsecret.png'])(
    'BE-9 CSS 的 url(%s) → Could not resolve，不漏内容',
    async (written) => {
      expectRefused(
        await styled(`.a { background: url(${written}); }\n`),
        `Could not resolve "${written}"`,
        /st\.css:1:\d+/
      )
    }
  )

  describe('BE-10..12 组件目录里的照常', () => {
    const INSIDE = 'INSIDE_MARKER_k2'
    /** esbuild 的 data URL 取短的那种编码：这份内容不用 base64 */
    const PNG_URL = `data:image/png,${INSIDE}`

    beforeEach(() => {
      put('x.txt', INSIDE)
      put('data.json', JSON.stringify({ m: INSIDE }))
      put('img.png', INSIDE)
      put('ipkg/package.json', JSON.stringify({ main: 'lib.js' }))
      put('ipkg/lib.js', `export default '${INSIDE}'\n`)
      put('sub/k.txt', INSIDE)
      symlinkSync(join(widgetDir, 'x.txt'), join(widgetDir, 'alias.txt'))
    })

    it.each([
      ['./x.txt?a', INSIDE],
      ['./x.txt#a', INSIDE],
      ['./data.json?x', INSIDE],
      ['./data', INSIDE],
      ['./img.png?v=1', PNG_URL],
      ['./ipkg', INSIDE],
      ['./sub/k.txt?z', INSIDE],
      ['./alias.txt?a', INSIDE]
    ])('BE-10 界面 import %j → 成功，内容在产物里', async (spec, content) => {
      expect(expectBuilt(await screen(importingAndLogging(spec))).js).toContain(content)
    })

    it('BE-11 CSS：url 带后缀是 data URL，@import 带后缀内联；url(#frag)、data:、https: 原样', async () => {
      put('s.css', `.imported-${INSIDE} { color: blue }\n`)
      const svg = 'data:image/svg+xml,%3Csvg%3E%3C/svg%3E'
      const { css } = expectBuilt(
        await styled(`@import "s.css?x";
.a { background: url(img.png?v=1#h); }
.b { background: url(img.png#h); }
.c { background: url(./img.png?x); }
.d { fill: url(#frag); }
.e { background: url("${svg}"); }
.f { background: url(https://example.com/x.png); }
`)
      )
      /** 这条规则的 url(…) 里写的是什么 */
      const urlIn = (rule: string): string | undefined =>
        new RegExp(`\\${rule}\\s*\\{[^}]*url\\("?([^")]*)"?\\)`).exec(css)?.[1]
      expect(urlIn('.a')).toBe(PNG_URL)
      // 只有纯 `#` 片段留在 data URL 后面（SVG 精灵图靠它）；`?` 起头的后缀整段去掉
      expect(urlIn('.b')).toBe(`${PNG_URL}#h`)
      expect(urlIn('.c')).toBe(PNG_URL)
      expect(css).toContain('url(#frag)')
      expect(css).toContain(svg)
      expect(css).toContain('https://example.com/x.png')
    })

    it.each(['./x.txt?a', './data'])(
      'BE-12 api.ts import %j → 成功，内容在产物里',
      async (spec) => {
        put('api.ts', importing(spec))
        expect(expectBuilt(await bundler.buildApi(widgetDir)).js).toContain(INSIDE)
      }
    )
  })

  it('BR-11 `?raw` 只给界面：api.ts 的 ./mod.js?raw 仍是模块（No matching export）', async () => {
    put('mod.js', 'export const named = 1\n')
    put('api.ts', importing('./mod.js?raw'))
    const r = await bundler.buildApi(widgetDir)
    expect(r.success).toBe(false)
    expect(r.outputJS).toBeUndefined()
    expect((r.errors ?? []).join('\n')).toContain('No matching export')
  })
})
