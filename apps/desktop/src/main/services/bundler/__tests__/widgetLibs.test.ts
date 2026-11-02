/**
 * 小组件可以 import 的库：表（widgetLibs.json）与它的辅助函数（widgetLibs.ts）、仓库里拷好的 vendor 目录
 * （`resources/bundler/vendor`，postinstall 里 scripts/vendor-widget-libs.mjs 生成，只读）、版本钉与类型包。
 * vendor 那一组读真目录：没有 manifest.json（从没跑过 postinstall 的检出）就失败并说「run npm install」，
 * 不在空集上恒真。
 *
 *   WL-1  WIDGET_LIBRARIES 与 widgetLibs.json 一一对应：名字、顺序、version / served / exportTypes / blocked
 *   WL-2  packageNameOf：子路径、scope 包、只有 scope、普通名字
 *   WL-3  widgetLibraryOf：子路径找到库；大小写不同、名字前缀相同、只有 scope、shuvix/widget → undefined
 *   WL-4  blockedImportHint：`highlight.js` → 表里那句原文；`highlight.js/lib/core`、three、left-pad → undefined
 *   WL-5  servedFileOf：`three` / `three/addons/…` 的文件；目录本身、build/examples 直写、webgpu、不是 served 的库，
 *         以及带 `..` / `.` / 空段 / 反斜杠的 → null（F-3 修好之后）
 *   WL-6  servedLibraryBase(three) = `lib/three@0.187.0/`
 *   WL-7  widgetImportMap：键 = 每个 served 库的 served 键；值落在 `<base>lib/<name>@<ver>/…`；`/` 结尾的键值也 `/` 结尾
 *   WL-8  widgetLibraryNames：按表的顺序、逗号加空格
 *   WL-9  表的不变量：版本精确、blocked 键属于自己的库、served 键与目标形状一致、exportTypes 都是 @types/、
 *         files 的 glob 只用 `*` / `**`（`!` 只能在开头）、skipDependencies 里没有表里的库
 *   WL-10 served 库在 vendor 里的每个文件（package.json、LICENSE 除外，.wasm 也算）都能从库路由取到（F-1：`build/three.core.js`）
 *   WL-11 DRACOLoader / KTX2Loader 默认取解码器的地址（import map 的 three/addons/ + 它们自己的相对路径）经库路由落到 vendor
 *   VR-1  manifest.libraries = 表的 {name: version}，键按表的顺序
 *   VR-2  manifest.packages 的每个包都在，package.json 的 version / name 对得上
 *   VR-3  manifest.fileCount = vendor/node_modules 下的普通文件数（afterPack 核对的就是它）
 *   VR-4  依赖闭包完整：每个包的 dependencies（skipDependencies 除外）按 Node 的规则在 vendor 里找得到
 *   VR-5  skipDependencies 一个都不在
 *   VR-6  没有覆盖规则的包只带默认那套（package.json、许可证、.js/.mjs/.cjs/.css；没有 .map / .d.ts、test / docs …）
 *   VR-7  覆盖规则生效：lucide-react 只有 dist/esm（图标数与安装的一样）、chart.js 没有 cjs / umd、d3-* 只有 src
 *   VR-8  three 里该在的在（WebGL 能用的 addon、解码器的 loader、后处理、libs），不该在的不在（tsl、lines/webgpu、TTFLoader 等）
 *   VR-9  three 的 JS 压缩过（build/three.*.js 与 GLTFLoader.js 严格变小，别的最多大 1%：本来就压过的 libs）、原来有 @license 的
 *         保留、没有 sourceMappingURL；three.module.js 以许可证块开头
 *   VR-10 three 的 JS 里每个相对 import 都指向 vendor 里有的文件，而且库路由取得到（F-1 从另一头看）
 *   VR-11 不是 served 的文件逐字节拷贝
 *   VR-12 解码器都在：libs/draco/{draco_decoder.js,draco_decoder.wasm,draco_wasm_wrapper.js}、libs/draco/gltf/{draco_decoder.wasm,
 *         draco_wasm_wrapper.js}、libs/basis/{basis_transcoder.js,basis_transcoder.wasm}；.wasm 与安装的逐字节相同
 *   VR-13 vendor 里 three 的每个 .js（esbuild 解析，不用正则）：静态与字面量动态 import 只能是 three、存在的 three/addons/…、
 *         包里存在的相对路径；没有网址、three/webgpu、three/tsl
 *   VR-14 widgetLibs.json 里每条 `!`：安装的 three 里还有（升级时发现过期的）、vendor 里没有；要么顺着 import 碰到 webgpu、tsl、
 *         网址，要么在审过的名单上（exporters/DRACOExporter.js、loaders/3DMLoader.js）
 *   VR-15 完整：安装的 examples/jsm 下没进 vendor 的 .js，都得由同一条规则或审过的名单解释（Addons.js、physics/、transpiler/、
 *         exporters/DRACOExporter.js、loaders/3DMLoader.js、capabilities/WebGPU.js、lighting/、libs/）
 *   VR-16 vendor 的 JS 里每个 `new URL('<相对路径>', import.meta.url)` 都指向随包的文件（DRACOLoader 不给 decoder 路径也取得到）；
 *         解码器走的是这条闭包，表里没有它们的 glob
 *   VR-17 压缩之后解码器脚本仍定义 worker 调的全局：DracoDecoderModule、BASIS（new Function 里跑）
 *   PKG-1 根 package-lock.json 装的版本 = 表里的版本
 *   PKG-2 apps/desktop/package.json 精确钉住每个库（F-5 裁决：钉死，不带 ^）
 *   PKG-3 根 postinstall 先跑 vendor 脚本、不看 CI；electron-rebuild 仍看 CI；desktop 有 vendor:widget-libs
 *   PKG-4 vendor 目录被 git 忽略，没有文件进了仓库
 *   TY-1  每个库要么自带类型、要么表里有 exportTypes，二者恰居其一
 *   TY-2  exportTypes 的主版本对得上库（0.x 连次版本也对得上）
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join, posix, resolve } from 'node:path'
import { build as nativeBuild } from 'esbuild'
import { describe, expect, it } from 'vitest'
import table from '../widgetLibs.json'
import {
  blockedImportHint,
  packageNameOf,
  servedFileOf,
  servedLibraryBase,
  widgetImportMap,
  widgetLibraryNames,
  widgetLibraryOf,
  WIDGET_LIBRARIES
} from '../widgetLibs'
import { resolveWidgetLibFile } from '../../widget/widgetLibFiles'

/** apps/desktop */
const DESKTOP_DIR = resolve(__dirname, '../../../../..')
const REPO_DIR = resolve(DESKTOP_DIR, '../..')
const VENDOR = join(DESKTOP_DIR, 'resources/bundler/vendor')
const VENDOR_MODULES = join(VENDOR, 'node_modules')
const INSTALLED = join(REPO_DIR, 'node_modules')

interface TableEntry {
  version: string
  files?: string[]
  served?: Record<string, string>
  exportTypes?: Record<string, string>
  blocked?: Record<string, string>
}
const LIBS = table.libraries as Record<string, TableEntry>
const DEPENDENCY_FILES = table.dependencyFiles as Record<string, string[]>
const SKIP = table.skipDependencies as string[]
const three = WIDGET_LIBRARIES.find((lib) => lib.name === 'three')!

/** 与 scripts/vendor-widget-libs.mjs 同一条：served 文件里的相对 import */
const RELATIVE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.{1,2}\/[^'"]+)['"]/g
/** 与脚本同一条：顶层的许可证文件 */
const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\..*)?$/i

interface Manifest {
  libraries: Record<string, string>
  packages: Record<string, string>
  fileCount: number
}

function readManifest(): Manifest {
  const path = join(VENDOR, 'manifest.json')
  if (!existsSync(path)) {
    throw new Error(`${path} is missing: run npm install (it runs scripts/vendor-widget-libs.mjs)`)
  }
  return JSON.parse(readFileSync(path, 'utf8')) as Manifest
}

/** 目录下的文件（相对路径，`/` 分隔）；`skipNodeModules` = 不进嵌套的 node_modules（那是别的包） */
function listFiles(dir: string, skipNodeModules = true, rel = ''): string[] {
  const out: string[] = []
  for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const path = rel ? `${rel}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      if (!(skipNodeModules && entry.name === 'node_modules'))
        out.push(...listFiles(dir, skipNodeModules, path))
    } else if (entry.isFile()) out.push(path)
  }
  return out
}

/** 目录下所有子目录（绝对路径） */
function listDirs(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const full = join(dir, entry.name)
    out.push(full, ...listDirs(full))
  }
  return out
}

/** manifest 的键 `a/node_modules/b` → 包名 `b` */
const packageOfKey = (key: string): string => key.split('/node_modules/').pop()!

/** 脚本的 globToRegExp 的独立实现：`**` 跨目录、`*` 不跨 */
function globToRegExp(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*'
      i += glob[i + 2] === '/' ? 2 : 1
    } else if (c === '*') re += '[^/]*'
    else re += c.replace(/[.+^${}()|[\]\\?]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

const isKeptAlways = (path: string): boolean =>
  path === 'package.json' || (!path.includes('/') && LICENSE_FILE.test(path))

/** 这个包有没有覆盖默认挑法的 files 规则 */
function overrideOf(name: string): string[] | null {
  if (LIBS[name]?.files) return LIBS[name].files!
  for (const [pattern, files] of Object.entries(DEPENDENCY_FILES)) {
    if (pattern === name || (pattern.endsWith('*') && name.startsWith(pattern.slice(0, -1)))) {
      return files
    }
  }
  return null
}

const libRoute = (lib: { name: string; version: string }, file: string): string =>
  `/lib/${lib.name}@${lib.version}/${file}`

const VENDOR_THREE_JSM = join(VENDOR_MODULES, 'three/examples/jsm')
const INSTALLED_THREE_JSM = join(INSTALLED, 'three/examples/jsm')
/** 几百个文件各解析一次 */
const GRAPH_TIMEOUT = 120_000

const importCache = new Map<string, Promise<string[]>>()

/**
 * 这个文件的静态与字面量动态 import。用 esbuild 解析（只记不跟）：正则会把字符串与注释里的 `from '…'` 当成 import
 * （GLTFLoader.js 里就有一段）。解码器脚本里的 require 不算：它们不是模块，浏览器不走 import map
 */
function importsIn(file: string): Promise<string[]> {
  const cached = importCache.get(file)
  if (cached) return cached
  const found: string[] = []
  const done = nativeBuild({
    entryPoints: [file],
    bundle: true,
    write: false,
    format: 'esm',
    outdir: 'out',
    logLevel: 'silent',
    plugins: [
      {
        name: 'record-imports',
        setup(build) {
          build.onResolve({ filter: /.*/ }, (args) => {
            if (args.kind === 'entry-point') return undefined
            if (args.kind === 'import-statement' || args.kind === 'dynamic-import') {
              found.push(args.path)
            }
            return { path: args.path, external: true }
          })
        }
      }
    ]
  }).then(() => found)
  importCache.set(file, done)
  return done
}

/**
 * 这个 addon（安装的那份，相对 examples/jsm）为什么进不了 vendor：顺着 import 往下找 three/webgpu、three/tsl、网址
 * （served 文件只能 import 页面 import map 答得上来的东西）。都没有 → null
 */
async function leftOutBecause(file: string, seen = new Set<string>()): Promise<string | null> {
  if (seen.has(file)) return null
  seen.add(file)
  for (const spec of await importsIn(join(INSTALLED_THREE_JSM, file))) {
    if (spec === 'three/webgpu' || spec === 'three/tsl' || /^[a-z][a-z0-9+.-]*:/i.test(spec)) {
      return spec
    }
    const next = spec.startsWith('three/addons/')
      ? spec.slice('three/addons/'.length)
      : spec.startsWith('./') || spec.startsWith('../')
        ? posix.normalize(posix.join(posix.dirname(file), spec))
        : null
    if (!next || next.startsWith('../')) continue
    const reason = await leftOutBecause(next, seen)
    if (reason) return reason
  }
  return null
}

/** 表里 `!` 掉的、又不碰 webgpu / tsl / 网址的（要别处来的库）：审过 */
const REVIEWED_EXCLUSIONS = ['exporters/DRACOExporter.js', 'loaders/3DMLoader.js']
/** 没进 vendor、又不碰 webgpu / tsl / 网址的：审过 */
const REVIEWED_LEFT_OUT = [
  /^Addons\.js$/,
  /^physics\//,
  /^transpiler\//,
  /^exporters\/DRACOExporter\.js$/,
  /^loaders\/3DMLoader\.js$/,
  /^capabilities\/WebGPU\.js$/,
  /^lighting\//,
  /^libs\//,
  // 只给被排除的文件用的零件：MaterialXLoader、Inspector、WebGPU 的城市生成器
  /^loaders\/materialx\//,
  /^inspector\//,
  /^generators\//,
  // 没有人 import 的演示
  /^offscreen\//
]

// ────────────────────────────── A. 表与辅助函数 ──────────────────────────────

describe('WL 表与辅助函数（widgetLibs.ts）', () => {
  it('WL-1 WIDGET_LIBRARIES 与 widgetLibs.json 一一对应（名字、顺序、各字段）', () => {
    expect(WIDGET_LIBRARIES.map((lib) => lib.name)).toEqual(Object.keys(LIBS))
    expect(new Set(WIDGET_LIBRARIES.map((lib) => lib.name)).size).toBe(Object.keys(LIBS).length)
    for (const lib of WIDGET_LIBRARIES) {
      const entry = LIBS[lib.name]
      expect(lib.version, lib.name).toBe(entry.version)
      expect(lib.served, lib.name).toEqual(entry.served)
      expect(lib.exportTypes, lib.name).toEqual(entry.exportTypes)
      expect(lib.blocked, lib.name).toEqual(entry.blocked)
    }
  })

  it('WL-2 packageNameOf', () => {
    expect(packageNameOf('three/addons/x.js')).toBe('three')
    expect(packageNameOf('@dnd-kit/core/dist/x.js')).toBe('@dnd-kit/core')
    expect(packageNameOf('@dnd-kit')).toBe('@dnd-kit')
    expect(packageNameOf('react')).toBe('react')
    expect(packageNameOf('highlight.js/lib/core')).toBe('highlight.js')
  })

  it('WL-3 widgetLibraryOf：子路径找到库；长得像的 → undefined', () => {
    expect(widgetLibraryOf('highlight.js/lib/languages/x')?.name).toBe('highlight.js')
    expect(widgetLibraryOf('@dnd-kit/sortable')?.name).toBe('@dnd-kit/sortable')
    for (const spec of ['Three', 'three-stdlib', 'threex', '@dnd-kit', 'lucide', 'shuvix/widget']) {
      expect(widgetLibraryOf(spec), spec).toBeUndefined()
    }
  })

  it('WL-4 blockedImportHint：只挡 `highlight.js` 本身，提示是表里那句原文', () => {
    expect(blockedImportHint('highlight.js')).toBe(LIBS['highlight.js'].blocked!['highlight.js'])
    expect(blockedImportHint('highlight.js')).toMatch(/^Importing "highlight\.js" bundles/)
    for (const spec of ['highlight.js/lib/core', 'three', 'left-pad']) {
      expect(blockedImportHint(spec), spec).toBeUndefined()
    }
  })

  it('WL-5 servedFileOf：three 与 three/addons/… 的文件', () => {
    expect(servedFileOf('three')).toEqual({ lib: three, file: 'build/three.module.js' })
    expect(servedFileOf('three/addons/controls/OrbitControls.js')).toEqual({
      lib: three,
      file: 'examples/jsm/controls/OrbitControls.js'
    })
  })

  it.each([
    'three/addons/',
    'three/addons/controls/',
    'three/build/three.module.js',
    'three/examples/jsm/controls/OrbitControls.js',
    'three/webgpu',
    'chart.js',
    // F-3：`.` / `..` / 空段 / 反斜杠
    'three/addons/../build/three.core.js',
    'three/addons/controls/./OrbitControls.js',
    'three/addons/controls//OrbitControls.js',
    'three/addons/controls\\OrbitControls.js',
    'three/addons/controls/../../../../../../etc/hosts'
  ])('WL-5 servedFileOf(%j) → null', (spec) => {
    expect(servedFileOf(spec)).toBeNull()
  })

  it('WL-6 servedLibraryBase(three)', () => {
    expect(servedLibraryBase(three)).toBe('lib/three@0.187.0/')
  })

  it('WL-7 widgetImportMap：键是 served 键的并集，值落在库路由下，`/` 结尾的键值也 `/` 结尾', () => {
    const map = widgetImportMap('/w/abc-def/')
    const servedKeys = WIDGET_LIBRARIES.flatMap((lib) => Object.keys(lib.served ?? {}))
    expect(Object.keys(map.imports).sort()).toEqual([...servedKeys].sort())
    expect(map.imports).toEqual({
      three: '/w/abc-def/lib/three@0.187.0/build/three.module.js',
      'three/addons/': '/w/abc-def/lib/three@0.187.0/examples/jsm/'
    })
    for (const [key, value] of Object.entries(map.imports)) {
      expect(value.endsWith('/'), key).toBe(key.endsWith('/'))
    }
  })

  it('WL-8 widgetLibraryNames：按表的顺序，逗号加空格', () => {
    expect(widgetLibraryNames()).toBe(Object.keys(LIBS).join(', '))
    for (const name of Object.keys(LIBS)) expect(widgetLibraryNames()).toContain(name)
  })

  it('WL-9 表的不变量', () => {
    const names = new Set(Object.keys(LIBS))
    for (const [name, lib] of Object.entries(LIBS)) {
      // (a) 精确版本
      expect(lib.version, name).toMatch(/^\d+\.\d+\.\d+$/)
      // (b) blocked 键属于自己的库
      for (const key of Object.keys(lib.blocked ?? {})) expect(packageNameOf(key), key).toBe(name)
      // (c) served 键与目标形状一致
      for (const [key, target] of Object.entries(lib.served ?? {})) {
        expect(key === name || key.startsWith(`${name}/`), key).toBe(true)
        expect(target.endsWith('/'), key).toBe(key.endsWith('/'))
      }
      // (d) exportTypes 都是 @types/
      for (const key of Object.keys(lib.exportTypes ?? {})) expect(key, name).toMatch(/^@types\//)
    }
    // (e) glob 只用 `*` / `**`（脚本的 globToRegExp 只认这两种）
    const globs = [
      ...Object.values(LIBS).flatMap((lib) => lib.files ?? []),
      ...Object.values(DEPENDENCY_FILES).flat()
    ]
    expect(globs.length).toBeGreaterThan(0)
    for (const glob of globs) expect(glob.replace(/^!/, ''), glob).not.toMatch(/[?[\]{}!()+@]/)
    // (f) skipDependencies 里没有表里的库
    for (const dep of SKIP) expect(names.has(dep), dep).toBe(false)
  })

  it('WL-10 served 库在 vendor 里的每个文件（清单与许可证除外）都能从库路由取到（F-1）', () => {
    readManifest()
    const served = WIDGET_LIBRARIES.filter((lib) => lib.served)
    expect(served.length).toBeGreaterThan(0)
    for (const lib of served) {
      const files = listFiles(join(VENDOR_MODULES, lib.name)).filter((f) => !isKeptAlways(f))
      expect(files.length, lib.name).toBeGreaterThan(0)
      expect(files.some((f) => f.endsWith('.wasm')) || lib.name !== 'three', lib.name).toBe(true)
      for (const file of files) {
        expect(resolveWidgetLibFile(libRoute(lib, file), VENDOR), file).toBe(
          join(VENDOR_MODULES, lib.name, ...file.split('/'))
        )
      }
    }
    expect(resolveWidgetLibFile(libRoute(three, 'build/three.core.js'), VENDOR)).not.toBeNull()
  })

  it.each([
    ['loaders/DRACOLoader.js', '../libs/draco/draco_decoder.wasm'],
    ['loaders/DRACOLoader.js', '../libs/draco/draco_wasm_wrapper.js'],
    ['loaders/DRACOLoader.js', '../libs/draco/draco_decoder.js'],
    ['loaders/DRACOLoader.js', '../libs/draco/gltf/draco_decoder.wasm'],
    ['loaders/KTX2Loader.js', '../libs/basis/basis_transcoder.wasm'],
    ['loaders/KTX2Loader.js', '../libs/basis/basis_transcoder.js']
  ])('WL-11 %s 默认取的 %s 经 import map 与库路由落到 vendor', (loader, relative) => {
    readManifest()
    const base = `http://h${widgetImportMap('/w/a-b/').imports['three/addons/']}`
    const { pathname } = new URL(relative, new URL(loader, base))
    expect(pathname.startsWith('/w/a-b/lib/')).toBe(true)
    expect(resolveWidgetLibFile(pathname.slice('/w/a-b'.length), VENDOR)).toBe(
      join(VENDOR_MODULES, 'three/examples/jsm', ...relative.replace('../', '').split('/'))
    )
  })
})

// ────────────────────────────── B. 仓库里的 vendor 目录 ──────────────────────────────

describe('VR 仓库里拷好的 vendor 目录（只读）', () => {
  it('VR-1 manifest.libraries = 表的 {name: version}，键按表的顺序', () => {
    const manifest = readManifest()
    const expected = Object.fromEntries(Object.entries(LIBS).map(([n, l]) => [n, l.version]))
    expect(manifest.libraries).toEqual(expected)
    expect(Object.keys(manifest.libraries)).toEqual(Object.keys(expected))
  })

  it('VR-2 manifest.packages 的每个包都在，version / name 对得上', () => {
    const manifest = readManifest()
    const keys = Object.keys(manifest.packages)
    expect(keys.length).toBeGreaterThanOrEqual(Object.keys(LIBS).length)
    for (const [key, version] of Object.entries(manifest.packages)) {
      const pkgPath = join(VENDOR_MODULES, ...key.split('/'), 'package.json')
      expect(existsSync(pkgPath), key).toBe(true)
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name: string; version: string }
      expect(pkg.version, key).toBe(version)
      expect(pkg.name, key).toBe(packageOfKey(key))
    }
    // 每个库本身都在
    for (const name of Object.keys(LIBS))
      expect(manifest.packages[name], name).toBe(LIBS[name].version)
  })

  it('VR-3 manifest.fileCount = vendor/node_modules 下的普通文件数', () => {
    const manifest = readManifest()
    const files = listFiles(VENDOR_MODULES, false)
    expect(files.length).toBeGreaterThan(0)
    expect(manifest.fileCount).toBe(files.length)
  })

  it('VR-4 依赖闭包完整：按 Node 的规则在 vendor 里找得到，不出 vendor', () => {
    const manifest = readManifest()
    const unresolved: string[] = []
    let checked = 0
    for (const key of Object.keys(manifest.packages)) {
      const pkgDir = join(VENDOR_MODULES, ...key.split('/'))
      const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>
      }
      for (const dep of Object.keys(pkg.dependencies ?? {})) {
        if (SKIP.includes(dep)) continue
        checked++
        let found = false
        // pkgDir 往上，直到 vendor/node_modules（含）：名叫 node_modules 的目录直接放包，别的目录看它的 node_modules
        for (let dir = pkgDir; ; dir = dirname(dir)) {
          const candidate =
            basename(dir) === 'node_modules' ? join(dir, dep) : join(dir, 'node_modules', dep)
          if (existsSync(join(candidate, 'package.json'))) {
            found = true
            break
          }
          if (dir === VENDOR_MODULES) break
        }
        if (!found) unresolved.push(`${key} → ${dep}`)
      }
    }
    expect(checked).toBeGreaterThan(0)
    expect(unresolved).toEqual([])
  })

  it('VR-5 skipDependencies 一个都不在', () => {
    const manifest = readManifest()
    const dirs = listDirs(VENDOR_MODULES).map((d) => basename(d))
    for (const dep of SKIP) {
      expect(dirs, dep).not.toContain(dep)
      expect(
        Object.keys(manifest.packages).filter((k) => packageOfKey(k) === dep),
        dep
      ).toEqual([])
    }
  })

  it('VR-6 没有覆盖规则的包只带默认那套', () => {
    const manifest = readManifest()
    const excludedDirs = new Set([
      'test',
      'tests',
      '__tests__',
      'docs',
      'bin',
      'examples',
      '.github'
    ])
    const defaults = Object.keys(manifest.packages).filter((k) => !overrideOf(packageOfKey(k)))
    expect(defaults.length).toBeGreaterThan(0)
    expect(defaults).toContain('dayjs')
    const bad: string[] = []
    for (const key of defaults) {
      for (const file of listFiles(join(VENDOR_MODULES, ...key.split('/')))) {
        if (isKeptAlways(file)) continue
        const ok =
          /\.(js|mjs|cjs|css)$/.test(file) &&
          !/\.(map|d\.ts|d\.mts|d\.cts)$/.test(file) &&
          !file.split('/').some((seg) => excludedDirs.has(seg))
        if (!ok) bad.push(`${key}/${file}`)
      }
    }
    expect(bad).toEqual([])
    expect(existsSync(join(VENDOR_MODULES, 'marked/bin'))).toBe(false)
    expect(existsSync(join(INSTALLED, 'marked/bin'))).toBe(true)
  })

  it('VR-7 覆盖规则生效：lucide-react、chart.js、d3-*', () => {
    const manifest = readManifest()
    // lucide-react：只有 dist/esm 下的 .js
    const lucideRe = globToRegExp('dist/esm/**/*.js')
    const lucide = listFiles(join(VENDOR_MODULES, 'lucide-react'))
    expect(lucide.filter((f) => !isKeptAlways(f) && !lucideRe.test(f))).toEqual([])
    expect(existsSync(join(VENDOR_MODULES, 'lucide-react/dist/cjs'))).toBe(false)
    expect(existsSync(join(VENDOR_MODULES, 'lucide-react/dist/umd'))).toBe(false)
    const icons = (dir: string): number =>
      listFiles(join(dir, 'lucide-react/dist/esm/icons')).filter((f) => f.endsWith('.js')).length
    expect(icons(VENDOR_MODULES)).toBeGreaterThan(1000)
    expect(icons(VENDOR_MODULES)).toBe(icons(INSTALLED))

    // chart.js：没有 cjs / umd
    const chart = listFiles(join(VENDOR_MODULES, 'chart.js'))
    expect(chart).toContain('dist/chart.js')
    expect(chart).not.toContain('dist/chart.cjs')
    expect(chart).not.toContain('auto/auto.cjs')
    expect(chart.filter((f) => /^dist\/chart\.umd.*\.js$/.test(f))).toEqual([])

    // d3-*：只有 src/**/*.js
    const srcRe = globToRegExp('src/**/*.js')
    const d3s = Object.keys(manifest.packages).filter((k) => packageOfKey(k).startsWith('d3-'))
    expect(d3s.length).toBeGreaterThan(10)
    for (const key of d3s) {
      const files = listFiles(join(VENDOR_MODULES, ...key.split('/')))
      expect(
        files.filter((f) => !isKeptAlways(f) && !srcRe.test(f)),
        key
      ).toEqual([])
    }
  })

  it('VR-8 three 里该在的在、不该在的不在', () => {
    readManifest()
    const dir = join(VENDOR_MODULES, 'three')
    const jsm = (rel: string): string => `examples/jsm/${rel}`
    const shipped = (rel: string): boolean => existsSync(join(dir, rel))
    for (const file of [
      'package.json',
      'LICENSE',
      'build/three.module.js',
      'build/three.core.js',
      jsm('capabilities/WebGL.js'),
      jsm('controls/OrbitControls.js'),
      jsm('loaders/GLTFLoader.js'),
      jsm('loaders/FBXLoader.js'),
      jsm('loaders/HDRLoader.js'),
      jsm('loaders/ColladaLoader.js'),
      jsm('loaders/3MFLoader.js'),
      jsm('loaders/EXRLoader.js'),
      jsm('loaders/KTX2Loader.js'),
      jsm('loaders/DRACOLoader.js'),
      jsm('loaders/collada/ColladaParser.js'),
      jsm('postprocessing/EffectComposer.js'),
      jsm('postprocessing/UnrealBloomPass.js'),
      jsm('utils/BufferGeometryUtils.js'),
      jsm('utils/SkeletonUtils.js'),
      jsm('lighting/LightProbeGridWebGL.js'),
      jsm('libs/lil-gui.module.min.js'),
      jsm('libs/stats.module.js'),
      jsm('libs/tween.module.js'),
      jsm('libs/meshopt_decoder.module.js'),
      jsm('libs/mikktspace.module.js')
    ]) {
      expect(shipped(file), file).toBe(true)
    }
    for (const folder of ['interaction', 'webxr']) {
      const installed = listFiles(join(INSTALLED, 'three', jsm(folder))).filter((f) =>
        f.endsWith('.js')
      )
      expect(installed.length, folder).toBeGreaterThan(0)
      for (const file of installed) expect(shipped(jsm(`${folder}/${file}`)), file).toBe(true)
    }
    for (const gone of [
      jsm('tsl'),
      jsm('lines/webgpu'),
      jsm('loaders/TTFLoader.js'),
      jsm('loaders/3DMLoader.js'),
      jsm('exporters/DRACOExporter.js'),
      jsm('libs/demuxer_mp4.js'),
      jsm('physics'),
      jsm('Addons.js')
    ]) {
      expect(shipped(gone), gone).toBe(false)
    }
  })

  it('VR-9 three 的 JS 压缩过、许可证保留、没有 sourceMappingURL', () => {
    readManifest()
    const files = listFiles(join(VENDOR_MODULES, 'three')).filter((f) => f.endsWith('.js'))
    expect(files.length).toBeGreaterThan(5)
    for (const file of files) {
      const vendored = readFileSync(join(VENDOR_MODULES, 'three', file), 'utf8')
      const original = readFileSync(join(INSTALLED, 'three', file), 'utf8')
      expect(vendored.length, file).toBeLessThanOrEqual(original.length * 1.01)
      if (original.includes('@license')) expect(vendored, file).toContain('@license')
      expect(vendored, file).not.toContain('sourceMappingURL')
    }
    // 没压过的那些，压了一定变小（libs 里有本来就压过的，重压可能大一点点）
    for (const file of [
      'build/three.module.js',
      'build/three.core.js',
      'examples/jsm/loaders/GLTFLoader.js'
    ]) {
      const vendored = readFileSync(join(VENDOR_MODULES, 'three', file), 'utf8')
      const original = readFileSync(join(INSTALLED, 'three', file), 'utf8')
      expect(vendored.length, file).toBeLessThan(original.length)
    }
    for (const build of ['build/three.module.js', 'build/three.core.js']) {
      expect(readFileSync(join(VENDOR_MODULES, 'three', build), 'utf8'), build).toContain(
        '@license'
      )
    }
    expect(readFileSync(join(VENDOR_MODULES, 'three/build/three.module.js'), 'utf8')).toMatch(
      /^\/\*\*\n \* @license/
    )
  })

  it('VR-10 three 的 JS 里每个相对 import 都指向 vendor 里有的、库路由取得到的文件', () => {
    readManifest()
    const dir = join(VENDOR_MODULES, 'three')
    const files = listFiles(dir).filter((f) => f.endsWith('.js'))
    let imports = 0
    for (const file of files) {
      for (const m of readFileSync(join(dir, file), 'utf8').matchAll(RELATIVE_IMPORT)) {
        imports++
        const target = posix.normalize(posix.join(posix.dirname(file), m[1]))
        expect(target.startsWith('../'), `${file} → ${m[1]}`).toBe(false)
        expect(existsSync(join(dir, target)), `${file} → ${m[1]}`).toBe(true)
        expect(resolveWidgetLibFile(libRoute(three, target), VENDOR), `${file} → ${m[1]}`).toBe(
          join(dir, ...target.split('/'))
        )
      }
    }
    // three.module.js → ./three.core.js 至少这一条
    expect(imports).toBeGreaterThan(0)
  })

  it.each([
    'lucide-react/dist/esm/icons/plus.js',
    'chart.js/dist/chart.js',
    'd3-array/src/index.js',
    'dayjs/esm/index.js'
  ])('VR-11 不是 served 的文件逐字节拷贝：%s', (file) => {
    readManifest()
    const vendored = readFileSync(join(VENDOR_MODULES, file))
    const original = readFileSync(join(INSTALLED, file))
    expect(vendored.equals(original)).toBe(true)
  })

  it.each([
    'libs/draco/draco_decoder.js',
    'libs/draco/draco_decoder.wasm',
    'libs/draco/draco_wasm_wrapper.js',
    'libs/draco/gltf/draco_decoder.wasm',
    'libs/draco/gltf/draco_wasm_wrapper.js',
    'libs/basis/basis_transcoder.js',
    'libs/basis/basis_transcoder.wasm'
  ])('VR-12 解码器在：%s（.wasm 逐字节相同）', (file) => {
    readManifest()
    const vendored = join(VENDOR_THREE_JSM, file)
    expect(existsSync(vendored)).toBe(true)
    if (file.endsWith('.wasm')) {
      expect(readFileSync(vendored).equals(readFileSync(join(INSTALLED_THREE_JSM, file)))).toBe(
        true
      )
    }
  })

  it(
    'VR-13 vendor 里 three 的 JS 只 import 三种东西（three、存在的 addon、包里存在的相对路径）',
    async () => {
      readManifest()
      const dir = join(VENDOR_MODULES, 'three')
      const files = listFiles(dir).filter((f) => f.endsWith('.js'))
      const bad: string[] = []
      let imports = 0
      for (const file of files) {
        for (const spec of await importsIn(join(dir, file))) {
          imports++
          if (spec === 'three') continue
          let target: string
          if (spec.startsWith('three/addons/')) {
            target = `examples/jsm/${spec.slice('three/addons/'.length)}`
          } else if (spec.startsWith('./') || spec.startsWith('../')) {
            target = posix.normalize(posix.join(posix.dirname(file), spec))
          } else {
            bad.push(`${file} -> ${spec}`)
            continue
          }
          if (target.startsWith('../') || !existsSync(join(dir, target))) {
            bad.push(`${file} -> ${spec}`)
          }
        }
      }
      expect(imports).toBeGreaterThan(100)
      expect(bad).toEqual([])
    },
    GRAPH_TIMEOUT
  )

  it(
    'VR-14 每条 `!`：装的里面有、vendor 里没有，且说得出为什么',
    async () => {
      readManifest()
      const excluded = LIBS.three
        .files!.filter((g) => g.startsWith('!'))
        .map((g) => g.slice('!examples/jsm/'.length))
      expect(excluded.length).toBeGreaterThan(10)
      for (const file of excluded) {
        expect(existsSync(join(INSTALLED_THREE_JSM, file)), `stale: ${file}`).toBe(true)
        expect(existsSync(join(VENDOR_THREE_JSM, file)), `shipped: ${file}`).toBe(false)
        const reason = await leftOutBecause(file)
        expect(
          reason ?? (REVIEWED_EXCLUSIONS.includes(file) ? 'reviewed' : null),
          file
        ).not.toBeNull()
      }
    },
    GRAPH_TIMEOUT
  )

  it(
    'VR-15 没进 vendor 的 addon 都解释得了',
    async () => {
      readManifest()
      const installed = listFiles(INSTALLED_THREE_JSM).filter((f) => f.endsWith('.js'))
      expect(installed.length).toBeGreaterThan(300)
      const unexplained: string[] = []
      for (const file of installed) {
        if (existsSync(join(VENDOR_THREE_JSM, file))) continue
        if (REVIEWED_LEFT_OUT.some((re) => re.test(file))) continue
        if (await leftOutBecause(file)) continue
        unexplained.push(file)
      }
      expect(unexplained).toEqual([])
    },
    GRAPH_TIMEOUT
  )

  it('VR-16 每个 new URL(相对路径, import.meta.url) 都指向随包的文件', () => {
    readManifest()
    const dir = join(VENDOR_MODULES, 'three')
    const seen: string[] = []
    for (const file of listFiles(dir).filter((f) => f.endsWith('.js'))) {
      for (const m of readFileSync(join(dir, file), 'utf8').matchAll(
        /\bnew URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g
      )) {
        const target = posix.normalize(posix.join(posix.dirname(file), m[1]))
        seen.push(target)
        expect(existsSync(join(dir, target)), `${file} -> ${m[1]}`).toBe(true)
      }
    }
    expect(seen).toEqual(
      expect.arrayContaining([
        'examples/jsm/libs/draco/draco_decoder.wasm',
        'examples/jsm/libs/draco/draco_wasm_wrapper.js',
        'examples/jsm/libs/draco/draco_decoder.js',
        'examples/jsm/libs/draco/gltf/draco_decoder.wasm',
        'examples/jsm/libs/basis/basis_transcoder.wasm',
        'examples/jsm/libs/basis/basis_transcoder.js'
      ])
    )
    expect(LIBS.three.files!.filter((g) => /libs\/(draco|basis)/.test(g))).toEqual([])
  })

  it.each([
    ['libs/draco/draco_decoder.js', 'DracoDecoderModule'],
    ['libs/draco/draco_wasm_wrapper.js', 'DracoDecoderModule'],
    ['libs/draco/gltf/draco_wasm_wrapper.js', 'DracoDecoderModule'],
    ['libs/basis/basis_transcoder.js', 'BASIS']
  ])('VR-17 %s 压缩之后仍定义 %s', (file, global) => {
    readManifest()
    const source = readFileSync(join(VENDOR_THREE_JSM, file), 'utf8')
    expect(new Function(`${source}\n;return typeof ${global}`)()).toBe('function')
  })
})

// ────────────────────────────── J. 版本钉与类型包 ──────────────────────────────

describe('PKG / TY 版本钉、postinstall、git、类型包', () => {
  it('PKG-1 根 package-lock.json 装的版本 = 表里的版本', () => {
    const lock = JSON.parse(readFileSync(join(REPO_DIR, 'package-lock.json'), 'utf8')) as {
      packages: Record<string, { version?: string }>
    }
    for (const [name, lib] of Object.entries(LIBS)) {
      expect(lock.packages[`node_modules/${name}`]?.version, name).toBe(lib.version)
    }
  })

  it('PKG-2 apps/desktop/package.json 精确钉住每个库（F-5）', () => {
    const pkg = JSON.parse(readFileSync(join(DESKTOP_DIR, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    for (const [name, lib] of Object.entries(LIBS)) {
      const declared = pkg.dependencies?.[name] ?? pkg.devDependencies?.[name]
      expect(declared, name).toBe(lib.version)
    }
  })

  it('PKG-3 根 postinstall 先跑 vendor 脚本、不看 CI；electron-rebuild 仍看 CI；desktop 有 vendor:widget-libs', () => {
    const root = JSON.parse(readFileSync(join(REPO_DIR, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    const postinstall = root.scripts.postinstall
    expect(postinstall.startsWith('node apps/desktop/scripts/vendor-widget-libs.mjs')).toBe(true)
    const vendorPart = postinstall.slice(0, postinstall.indexOf('&&'))
    expect(vendorPart).not.toContain('CI')
    const rebuildAt = postinstall.indexOf('electron-rebuild')
    expect(rebuildAt).toBeGreaterThan(-1)
    expect(postinstall.slice(0, rebuildAt)).toContain('process.env.CI||')

    const desktop = JSON.parse(readFileSync(join(DESKTOP_DIR, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(desktop.scripts['vendor:widget-libs']).toBe('node scripts/vendor-widget-libs.mjs')
  })

  it('PKG-4 vendor 目录被 git 忽略，没有文件进了仓库', () => {
    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd: REPO_DIR, encoding: 'utf8', stdio: 'pipe' })
    expect(() =>
      git('check-ignore', 'apps/desktop/resources/bundler/vendor/manifest.json')
    ).not.toThrow()
    expect(git('ls-files', 'apps/desktop/resources/bundler/vendor').trim()).toBe('')
  })

  /** package.json 的 exports 里有没有 `types` 条件 */
  const hasTypesCondition = (exports: unknown): boolean =>
    !!exports &&
    typeof exports === 'object' &&
    (Object.keys(exports).includes('types') || Object.values(exports).some(hasTypesCondition))

  it('TY-1 每个库要么自带类型、要么表里有 exportTypes，恰居其一', () => {
    const withExportTypes: string[] = []
    for (const [name, lib] of Object.entries(LIBS)) {
      const pkg = JSON.parse(readFileSync(join(INSTALLED, name, 'package.json'), 'utf8')) as {
        types?: string
        typings?: string
        exports?: unknown
      }
      const ships = !!(pkg.types || pkg.typings) || hasTypesCondition(pkg.exports)
      expect(ships !== !!lib.exportTypes, name).toBe(true)
      if (lib.exportTypes) withExportTypes.push(name)
    }
    expect(withExportTypes.sort()).toEqual(['d3', 'papaparse', 'qrcode', 'three'])
  })

  it('TY-2 exportTypes 的主版本对得上库（0.x 连次版本也对得上）', () => {
    let checked = 0
    for (const [name, lib] of Object.entries(LIBS)) {
      const [major, minor] = lib.version.split('.')
      for (const [typesName, range] of Object.entries(lib.exportTypes ?? {})) {
        checked++
        const m = /^\^(\d+)\.(\d+)\.\d+$/.exec(range)
        expect(m, `${typesName} ${range}`).not.toBeNull()
        expect(m![1], `${name} ${typesName}`).toBe(major)
        if (major === '0') expect(m![2], `${name} ${typesName}`).toBe(minor)
      }
    }
    expect(checked).toBe(4)
    expect(LIBS.three.exportTypes).toEqual({ '@types/three': '^0.187.0' })
  })
})
