/**
 * scripts/vendor-widget-libs.mjs —— 按 widgetLibs.json 把库连同依赖拷进 resources/bundler/vendor/node_modules。
 * vitest 只收 `src/main/**`，所以这份测试住在这里。
 *
 * **绝不对仓库里真的 vendor 跑这个脚本**：它会先 rmSync 整个 resources/bundler/vendor，别的测试都读那一份。
 * 脚本的一切都从自己的位置推出来（appDir = 脚本目录的上一级），所以每条用例在临时目录里搭一个「应用」：
 *   `<tmp>/app/scripts/vendor-widget-libs.mjs`  原样拷过去的脚本
 *   `<tmp>/app/src/main/services/bundler/widgetLibs.json`  夹具表
 *   `<tmp>/app/node_modules/esbuild` → 真的 esbuild 包目录的符号链接（Node 按真实路径解析，@esbuild/<平台> 照样找得到）
 *   `<tmp>/app/node_modules/…` 与 `<tmp>/node_modules/…`  夹具包（后者模拟提升到上层的包）
 * 产物落在 `<tmp>/app/resources/bundler/vendor`。macOS 上 os.tmpdir() 在 /var 下、真实路径是 /private/var：Node 按
 * 真实路径加载主模块，所以脚本眼里的 appDir（以及报错里的路径）是 /private/var 那条，断言路径时先 realpath。
 *
 * 夹具（包名取没人会装在上层的名字）：
 *   liba@1.0.0（app）  默认挑选的各种文件；依赖 depb、depc、skipme
 *   depb@1.0.0（<tmp>/node_modules）依赖 depc，嵌套的 depc@2.0.0 在 depb/node_modules 下；depc@1.0.0（app）
 *   skipme 没装，在 skipDependencies 里
 *   libo@2.0.0（app）  files = dist/**\/*.js、chunks/*.js；依赖 dw-one（dependencyFiles `dw-*` → src/**\/*.js）与 depc
 *   libs@3.0.0（app）  served：files 三个，main.js 相对 import core.js、core2.js（压缩写法）、import('./lazy.js')，
 *                     core.js 再 import ../shared/s.js；addons/x.js import 裸的 'libs'
 *
 *   VS-1  正常跑完：退出码 0，stdout 是 `vendor-widget-libs: 3 libraries, 7 packages, K files, … MB → resources/bundler/vendor`，
 *         K = manifest.fileCount
 *   VS-2  默认挑选（liba）：package.json、LICENSE、NOTICE、.js/.mjs/.cjs/.css 在；.d.ts、.map、README.md、LICENSE-MIT.txt、
 *         sub/LICENSE、test/、docs/、bin/、examples/、.github/ 不在
 *   VS-3  提升与嵌套照原样：manifest.packages 有 depb、depb/node_modules/depc（2.0.0）、depc（1.0.0），文件在对应位置
 *   VS-4  skipDependencies：没有关于 skipme 的报错，哪里都没有它
 *   VS-5  files 覆盖与 glob：`**` 跨目录、`*` 不跨；没匹配的不在；package.json 总在
 *   VS-6  dependencyFiles 的通配键：dw-one 只有 src 下的 .js
 *   VS-7  served 的相对 import 闭包与压缩：闭包里的文件都在；.js 压缩过（没有缩进、`// internal note` 没了，
 *         `/*! @license LibS *\/` 还在）；build/style.css 原样拷贝
 *   VS-8  版本对不上（liba 1.0.1）→ 退出码非 0，stderr 说 `liba 1.0.0 is installed but widgetLibs.json says 1.0.1; pin the same
 *         version in both`，没有 manifest.json
 *   VS-8b 先正常跑一次，再让表里**最后一个**库对不上 → 失败，上一次的 vendor 原封不动（先核对、再删，F-7）
 *   VS-9  库没装 → `nolib is not installed; run npm install`，非 0，没有 manifest；上一次的 vendor 原封不动
 *   VS-10 依赖没装（不在 skip 里）→ `liba depends on missing, which is not installed`
 *   VS-11 served 文件 import 不存在的相对文件 → `libs/build/main.js imports ./nope.js, which does not exist`
 *   VS-11b served 文件的相对 import 跑出包外 → `libs/build/main.js imports ../../outside.js, which is outside the package`，
 *         包外的文件没被拷进 vendor（F-8）
 *   VS-12 同名包在两个 node_modules 根下（app 里的 dup@2 给 liba，<tmp> 里的 dup@1 给提升上去的 libo）→ 非 0，
 *         stderr 说 `dup: both <源 1> and <源 2> would be vendored to <vendor 里同一个位置>`，没有 manifest（F-6）
 *   VS-13 重跑干净且稳定：种一个 vendor/node_modules/stale/x.js 再跑 → stale 没了，两次的文件清单、内容与 manifest 一样
 *   VS-14 两个库共用的 depc@1 只拷一次、只数一次：manifest.fileCount = 实际文件数
 */
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/** apps/desktop */
const DESKTOP_DIR = resolve(__dirname, '../../../../..')
const SCRIPT = join(DESKTOP_DIR, 'scripts/vendor-widget-libs.mjs')
const ESBUILD_DIR = dirname(createRequire(import.meta.url).resolve('esbuild/package.json'))

interface Fixture {
  tmp: string
  app: string
  vendor: string
  modules: string
}

interface RunResult {
  status: number | null
  stdout: string
  stderr: string
}

interface Manifest {
  libraries: Record<string, string>
  packages: Record<string, string>
  fileCount: number
}

const BASE_TABLE = {
  libraries: {
    liba: { version: '1.0.0' },
    libo: { version: '2.0.0', files: ['dist/**/*.js', 'chunks/*.js'] },
    libs: {
      version: '3.0.0',
      files: ['build/main.js', 'addons/x.js', 'build/style.css'],
      served: { libs: 'build/main.js', 'libs/addons/': 'addons/' }
    }
  },
  dependencyFiles: { 'dw-*': ['src/**/*.js'] },
  skipDependencies: ['skipme']
}

type Table = typeof BASE_TABLE & { libraries: Record<string, unknown> }

const MAIN_JS = `/*! @license LibS */
import a from './core.js'
import b from"./core2.js"
// internal note
export function run() {
    const lazy = import('./lazy.js')
    return [a, b, lazy]
}
`
const STYLE_CSS = `.libs {
    color: red;
}
`

function put(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function pkg(
  dir: string,
  name: string,
  version: string,
  dependencies: Record<string, string>,
  files: Record<string, string>
): void {
  put(join(dir, 'package.json'), JSON.stringify({ name, version, dependencies }, null, 2))
  for (const [file, content] of Object.entries(files)) put(join(dir, file), content)
}

function writeTable(fx: Fixture, table: Table): void {
  put(join(fx.app, 'src/main/services/bundler/widgetLibs.json'), JSON.stringify(table, null, 2))
}

/** 搭好整个临时「应用」：脚本、esbuild 链接、夹具表与夹具包 */
function makeFixture(): Fixture {
  const tmp = mkdtempSync(join(tmpdir(), 'shuvix-vendor-libs-'))
  const app = join(tmp, 'app')
  const fx: Fixture = {
    tmp,
    app,
    vendor: join(app, 'resources/bundler/vendor'),
    modules: join(app, 'resources/bundler/vendor/node_modules')
  }
  mkdirSync(join(app, 'scripts'), { recursive: true })
  copyFileSync(SCRIPT, join(app, 'scripts/vendor-widget-libs.mjs'))
  mkdirSync(join(app, 'node_modules'), { recursive: true })
  symlinkSync(ESBUILD_DIR, join(app, 'node_modules/esbuild'), 'dir')
  writeTable(fx, structuredClone(BASE_TABLE))

  const appModules = join(app, 'node_modules')
  const hoisted = join(tmp, 'node_modules')

  pkg(
    join(appModules, 'liba'),
    'liba',
    '1.0.0',
    { depb: '1.0.0', depc: '1.0.0', skipme: '1.0.0' },
    {
      'index.js': 'export default 1\n',
      'lib/util.js': 'export const u = 1\n',
      'style.css': '.a { color: red }\n',
      'mod.mjs': 'export const m = 1\n',
      'c.cjs': 'module.exports = 1\n',
      'index.d.ts': 'export {}\n',
      'index.js.map': '{}\n',
      'README.md': '# liba\n',
      LICENSE: 'MIT\n',
      NOTICE: 'notice\n',
      'LICENSE-MIT.txt': 'MIT\n',
      'sub/LICENSE': 'MIT\n',
      'test/t.js': 'test\n',
      'docs/d.js': 'docs\n',
      'bin/cli.js': 'cli\n',
      'examples/e.js': 'example\n',
      '.github/w.js': 'workflow\n'
    }
  )
  pkg(join(hoisted, 'depb'), 'depb', '1.0.0', { depc: '2.0.0' }, { 'index.js': 'b\n' })
  pkg(join(hoisted, 'depb/node_modules/depc'), 'depc', '2.0.0', {}, { 'index.js': 'c2\n' })
  pkg(join(appModules, 'depc'), 'depc', '1.0.0', {}, { 'index.js': 'c1\n' })
  pkg(
    join(appModules, 'libo'),
    'libo',
    '2.0.0',
    { 'dw-one': '1.0.0', depc: '1.0.0' },
    {
      'dist/a.js': 'a\n',
      'dist/sub/b.js': 'b\n',
      'dist/c.cjs': 'c\n',
      'chunks/x.js': 'x\n',
      'chunks/deep/y.js': 'y\n',
      'src/s.js': 's\n'
    }
  )
  pkg(
    join(appModules, 'dw-one'),
    'dw-one',
    '1.0.0',
    {},
    {
      'src/a.js': 'a\n',
      'src/n/b.js': 'b\n',
      'dist/z.js': 'z\n'
    }
  )
  pkg(
    join(appModules, 'libs'),
    'libs',
    '3.0.0',
    {},
    {
      'build/main.js': MAIN_JS,
      'build/core.js': "import s from '../shared/s.js'\nexport default s + 1\n",
      'build/core2.js': 'export default 2\n',
      'build/lazy.js': 'export const lazy = 3\n',
      'build/unused.js': 'export const unused = 4\n',
      'shared/s.js': 'export default 1\n',
      'addons/x.js': "import libs from 'libs'\nexport default libs\n",
      'build/style.css': STYLE_CSS
    }
  )
  return fx
}

function run(fx: Fixture): RunResult {
  const env = { ...process.env }
  delete env.NODE_OPTIONS
  const r = spawnSync(process.execPath, [join(fx.app, 'scripts/vendor-widget-libs.mjs')], {
    cwd: fx.tmp,
    env,
    encoding: 'utf8'
  })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

function manifestOf(fx: Fixture): Manifest {
  return JSON.parse(readFileSync(join(fx.vendor, 'manifest.json'), 'utf8')) as Manifest
}

/** 目录下的所有常规文件（相对路径，`/` 分隔，排好序） */
function listFiles(dir: string, rel = ''): string[] {
  if (!existsSync(join(dir, rel))) return []
  const out: string[] = []
  for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const path = rel ? `${rel}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...listFiles(dir, path))
    else if (entry.isFile()) out.push(path)
  }
  return out.sort()
}

/** 整个目录的快照：相对路径 → 内容 */
function snapshot(dir: string): Record<string, string> {
  return Object.fromEntries(listFiles(dir).map((p) => [p, readFileSync(join(dir, p), 'utf8')]))
}

const filesOf = (fx: Fixture, pkgKey: string): string[] => listFiles(join(fx.modules, pkgKey))

// ────────────────────────────── 正常跑一次 ──────────────────────────────

describe('VS-1..7, VS-14 正常跑完', () => {
  let fx: Fixture
  let result: RunResult

  beforeAll(() => {
    fx = makeFixture()
    result = run(fx)
  }, 60_000)

  afterAll(() => {
    rmSync(fx.tmp, { recursive: true, force: true })
  })

  it('VS-1 退出码 0；stdout 报库数、包数、文件数与去处', () => {
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    const m = result.stdout.match(
      /^vendor-widget-libs: 3 libraries, 7 packages, (\d+) files, \d+\.\d MB → resources\/bundler\/vendor\n$/
    )
    expect(m, result.stdout).not.toBeNull()
    expect(Number(m![1])).toBe(manifestOf(fx).fileCount)
    expect(manifestOf(fx).libraries).toEqual({ liba: '1.0.0', libo: '2.0.0', libs: '3.0.0' })
    expect(Object.keys(manifestOf(fx).libraries)).toEqual(['liba', 'libo', 'libs'])
  })

  it('VS-2 默认挑选：该在的在，类型、源映射、说明、测试、文档、命令行、示例、.github 不在', () => {
    expect(filesOf(fx, 'liba')).toEqual(
      [
        'LICENSE',
        'NOTICE',
        'c.cjs',
        'index.js',
        'lib/util.js',
        'mod.mjs',
        'package.json',
        'style.css'
      ].sort()
    )
    // 原样拷贝，不压缩（不是 served）
    expect(readFileSync(join(fx.modules, 'liba/index.js'), 'utf8')).toBe('export default 1\n')
  })

  it('VS-3 提升与嵌套照原样：depb、depb/node_modules/depc@2、depc@1', () => {
    const { packages } = manifestOf(fx)
    expect(packages.depb).toBe('1.0.0')
    expect(packages['depb/node_modules/depc']).toBe('2.0.0')
    expect(packages.depc).toBe('1.0.0')
    expect(readFileSync(join(fx.modules, 'depb/index.js'), 'utf8')).toBe('b\n')
    expect(readFileSync(join(fx.modules, 'depb/node_modules/depc/index.js'), 'utf8')).toBe('c2\n')
    expect(readFileSync(join(fx.modules, 'depc/index.js'), 'utf8')).toBe('c1\n')
    expect(JSON.parse(readFileSync(join(fx.modules, 'depc/package.json'), 'utf8')).version).toBe(
      '1.0.0'
    )
    expect(Object.keys(packages).sort()).toEqual(
      ['depb', 'depb/node_modules/depc', 'depc', 'dw-one', 'liba', 'libo', 'libs'].sort()
    )
  })

  it('VS-4 skipDependencies：没报 skipme，哪里都没有它', () => {
    expect(result.stderr).not.toContain('skipme')
    expect(result.stdout).not.toContain('skipme')
    expect(Object.keys(manifestOf(fx).packages)).not.toContain('skipme')
    expect(listFiles(fx.modules).some((p) => p.split('/').includes('skipme'))).toBe(false)
  })

  it('VS-5 files 覆盖：`**` 跨目录、`*` 不跨；package.json 总在', () => {
    expect(filesOf(fx, 'libo')).toEqual(
      ['chunks/x.js', 'dist/a.js', 'dist/sub/b.js', 'package.json'].sort()
    )
  })

  it('VS-6 dependencyFiles 的通配键：dw-one 只有 src 下的 .js', () => {
    expect(filesOf(fx, 'dw-one')).toEqual(['package.json', 'src/a.js', 'src/n/b.js'])
  })

  it('VS-7 served：相对 import 闭包都在，.js 压缩过且留着许可证注释，css 原样', () => {
    expect(filesOf(fx, 'libs')).toEqual(
      [
        'addons/x.js',
        'build/core.js',
        'build/core2.js',
        'build/lazy.js',
        'build/main.js',
        'build/style.css',
        'package.json',
        'shared/s.js'
      ].sort()
    )
    // 没被 import 到的不拷
    expect(existsSync(join(fx.modules, 'libs/build/unused.js'))).toBe(false)

    const main = readFileSync(join(fx.modules, 'libs/build/main.js'), 'utf8')
    expect(main).toContain('/*! @license LibS */')
    expect(main).not.toContain('internal note')
    expect(main).not.toMatch(/^ {2,}/m)
    expect(main.length).toBeLessThan(MAIN_JS.length)
    // 相对 import 还在（浏览器按它取文件）
    expect(main).toContain('./core.js')
    expect(main).toContain('./core2.js')
    expect(main).toContain('./lazy.js')
    for (const file of ['build/core.js', 'shared/s.js', 'addons/x.js']) {
      const code = readFileSync(join(fx.modules, 'libs', file), 'utf8')
      expect(code, file).not.toMatch(/^ {2,}/m)
    }
    expect(readFileSync(join(fx.modules, 'libs/addons/x.js'), 'utf8')).toMatch(/from\s*"libs"/)

    expect(readFileSync(join(fx.modules, 'libs/build/style.css'), 'utf8')).toBe(STYLE_CSS)
  })

  it('VS-14 两个库共用的 depc@1 只拷一次、只数一次：fileCount = 实际文件数', () => {
    const actual = listFiles(fx.modules)
    expect(manifestOf(fx).fileCount).toBe(actual.length)
    expect(actual.filter((p) => p.startsWith('depc/'))).toEqual([
      'depc/index.js',
      'depc/package.json'
    ])
  })
})

// ────────────────────────────── 失败的几种 ──────────────────────────────

describe('VS-8..13 失败要响亮、重跑要干净', () => {
  let fx: Fixture

  beforeEach(() => {
    fx = makeFixture()
  })

  afterEach(() => {
    rmSync(fx.tmp, { recursive: true, force: true })
  })

  const withTable = (edit: (t: Table) => void): void => {
    const table = structuredClone(BASE_TABLE) as Table
    edit(table)
    writeTable(fx, table)
  }

  it('VS-8 版本对不上 → 非 0，说清楚，没有 manifest', () => {
    withTable((t) => {
      t.libraries.liba = { version: '1.0.1' }
    })
    const r = run(fx)
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain(
      'liba 1.0.0 is installed but widgetLibs.json says 1.0.1; pin the same version in both'
    )
    expect(existsSync(join(fx.vendor, 'manifest.json'))).toBe(false)
    expect(listFiles(fx.vendor)).toEqual([])
  })

  it('VS-8b 表里最后一个库对不上 → 上一次的 vendor 原封不动（先核对再删）', () => {
    expect(run(fx).status).toBe(0)
    const before = snapshot(fx.vendor)
    expect(Object.keys(before)).toContain('manifest.json')

    withTable((t) => {
      t.libraries.libs = { ...t.libraries.libs, version: '3.0.1' }
    })
    const r = run(fx)
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain(
      'libs 3.0.0 is installed but widgetLibs.json says 3.0.1; pin the same version in both'
    )
    expect(snapshot(fx.vendor)).toEqual(before)
  })

  it('VS-9 库没装 → 非 0，说 run npm install，没有 manifest；上一次的 vendor 不动', () => {
    withTable((t) => {
      t.libraries.nolib = { version: '1.0.0' }
    })
    const fresh = run(fx)
    expect(fresh.status).not.toBe(0)
    expect(fresh.stderr).toContain('nolib is not installed; run npm install')
    expect(existsSync(join(fx.vendor, 'manifest.json'))).toBe(false)

    writeTable(fx, structuredClone(BASE_TABLE))
    expect(run(fx).status).toBe(0)
    const before = snapshot(fx.vendor)
    withTable((t) => {
      t.libraries.nolib = { version: '1.0.0' }
    })
    expect(run(fx).status).not.toBe(0)
    expect(snapshot(fx.vendor)).toEqual(before)
  })

  it('VS-10 依赖没装（不在 skip 里）→ 非 0，点名谁依赖了谁', () => {
    pkg(
      join(fx.app, 'node_modules/liba'),
      'liba',
      '1.0.0',
      { depb: '1.0.0', depc: '1.0.0', skipme: '1.0.0', missing: '1.0.0' },
      {}
    )
    const r = run(fx)
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('liba depends on missing, which is not installed')
    expect(existsSync(join(fx.vendor, 'manifest.json'))).toBe(false)
  })

  it('VS-11 served 文件 import 不存在的相对文件 → 非 0，点名文件与 specifier', () => {
    put(join(fx.app, 'node_modules/libs/build/main.js'), `${MAIN_JS}import './nope.js'\n`)
    const r = run(fx)
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('libs/build/main.js imports ./nope.js, which does not exist')
    expect(existsSync(join(fx.vendor, 'manifest.json'))).toBe(false)
  })

  it('VS-11b served 文件的相对 import 跑出包外 → 非 0，包外的文件不进 vendor', () => {
    // 文件真在（node_modules/outside.js），所以拦下它的是「出了包」而不是「不存在」
    put(join(fx.app, 'node_modules/outside.js'), 'export default 0\n')
    put(
      join(fx.app, 'node_modules/libs/build/main.js'),
      `${MAIN_JS}import o from '../../outside.js'\nconsole.log(o)\n`
    )
    const r = run(fx)
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain(
      'libs/build/main.js imports ../../outside.js, which is outside the package'
    )
    expect(existsSync(join(fx.vendor, 'manifest.json'))).toBe(false)
    expect(listFiles(fx.vendor).filter((p) => p.endsWith('outside.js'))).toEqual([])
  })

  it('VS-12 同名包在两个 node_modules 根下落到 vendor 的同一处 → 非 0，点名两份源，没有 manifest', () => {
    const appModules = join(fx.app, 'node_modules')
    const hoisted = join(fx.tmp, 'node_modules')
    pkg(join(appModules, 'dup'), 'dup', '2.0.0', {}, { 'index.js': 'dup2\n' })
    pkg(join(hoisted, 'dup'), 'dup', '1.0.0', {}, { 'index.js': 'dup1\n' })
    pkg(
      join(appModules, 'liba'),
      'liba',
      '1.0.0',
      { depb: '1.0.0', depc: '1.0.0', skipme: '1.0.0', dup: '2.0.0' },
      {}
    )
    // libo 提升到 <tmp>/node_modules：从那里找 dup 找到的是 1.0.0
    renameSync(join(appModules, 'libo'), join(hoisted, 'libo'))
    pkg(join(hoisted, 'libo'), 'libo', '2.0.0', { dup: '1.0.0' }, {})

    const r = run(fx)
    expect(r.status).not.toBe(0)
    // 脚本按真实路径看自己（/var → /private/var）
    const realTmp = realpathSync(fx.tmp)
    expect(r.stderr).toContain(
      `dup: both ${join(realTmp, 'app/node_modules/dup')} and ${join(realTmp, 'node_modules/dup')} would be vendored to ${join(realTmp, 'app/resources/bundler/vendor/node_modules/dup')}`
    )
    expect(existsSync(join(fx.vendor, 'manifest.json'))).toBe(false)
  })

  it('VS-13 重跑干净且稳定：种下的 stale 没了，两次的文件、内容与 manifest 一样', () => {
    expect(run(fx).status).toBe(0)
    const first = snapshot(fx.vendor)
    put(join(fx.modules, 'stale/x.js'), 'stale\n')

    const second = run(fx)
    expect(second.status).toBe(0)
    expect(existsSync(join(fx.modules, 'stale'))).toBe(false)
    expect(snapshot(fx.vendor)).toEqual(first)
  })
})
