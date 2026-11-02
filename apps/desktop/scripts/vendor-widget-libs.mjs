/* eslint-disable @typescript-eslint/explicit-function-return-type */
/**
 * 把小组件界面可以 import 的库（src/main/services/bundler/widgetLibs.json）连同它们的依赖，从 node_modules 拷进
 * resources/bundler/vendor/node_modules —— 随应用一起发（electron-builder 整个带上 resources/bundler），
 * 打包器从这里解析（bundlerService.ts）。开发时用的也是这一份，所以开发能打包的组件，装好的应用也能。
 *
 * - 版本必须与表里一致（apps/desktop/package.json 精确钉住）：不一致直接失败，不发一份没测过的库
 * - 每个包默认拷 package.json、许可证文件、以及 test / docs / bin / examples 之外的 .js/.mjs/.cjs/.css；
 *   表里的 `files` 换掉这套默认（three 只要两份构建产物和几个 addon，lucide-react 只要 ESM）
 * - 依赖按 package.json 的 dependencies 递归带上（`skipDependencies` 除外：命令行工具、服务端渲染器），
 *   保持 node_modules 里的相对位置（嵌套的版本照样嵌套）
 * - `served` 的库：拷过来的 JS 补齐相对 import 用到的文件，再压缩（宿主直接发给浏览器，不经打包）
 * - 产物不进仓库（.gitignore）；根 postinstall 与打包脚本都会跑这一步
 *
 * Usage: node scripts/vendor-widget-libs.mjs
 */

import { transformSync } from 'esbuild'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  copyFileSync
} from 'fs'
import { dirname, join, posix, relative, resolve, sep } from 'path'
import { fileURLToPath } from 'url'

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const table = JSON.parse(
  readFileSync(join(appDir, 'src/main/services/bundler/widgetLibs.json'), 'utf-8')
)
const vendorDir = join(appDir, 'resources/bundler/vendor')
const outModules = join(vendorDir, 'node_modules')

const DEFAULT_EXTS = /\.(js|mjs|cjs|css)$/
const SKIPPED_EXTS = /\.(map|d\.ts|d\.mts|d\.cts)$/
const EXCLUDED_DIRS = new Set([
  'test',
  'tests',
  '__tests__',
  'docs',
  'bin',
  'examples',
  'node_modules',
  '.github'
])
const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\..*)?$/i
const skipDependencies = new Set(table.skipDependencies ?? [])

/** `**` 跨目录、`*` 不跨 —— 表里只用这两种 */
function globToRegExp(glob) {
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

/** 包目录下的文件（相对路径，`/` 分隔；不进嵌套的 node_modules） */
function listFiles(dir, rel = '') {
  const out = []
  for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const path = rel ? `${rel}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') out.push(...listFiles(dir, path))
    } else if (entry.isFile()) out.push(path)
  }
  return out
}

function filesOverride(name, libraryFiles) {
  if (libraryFiles) return libraryFiles
  for (const [pattern, files] of Object.entries(table.dependencyFiles ?? {})) {
    if (pattern === name || (pattern.endsWith('*') && name.startsWith(pattern.slice(0, -1)))) {
      return files
    }
  }
  return null
}

function selectFiles(pkgDir, override) {
  const all = listFiles(pkgDir)
  const keep = (path) => path === 'package.json' || (!path.includes('/') && LICENSE_FILE.test(path))
  if (override) {
    const res = override.filter((g) => !g.startsWith('!')).map(globToRegExp)
    const out = override.filter((g) => g.startsWith('!')).map((g) => globToRegExp(g.slice(1)))
    return all.filter(
      (p) => keep(p) || (res.some((re) => re.test(p)) && !out.some((re) => re.test(p)))
    )
  }
  return all.filter((p) => {
    if (keep(p)) return true
    if (!DEFAULT_EXTS.test(p) || SKIPPED_EXTS.test(p)) return false
    return !p.split('/').some((segment) => EXCLUDED_DIRS.has(segment))
  })
}

/** 从 `fromDir` 往上找 node_modules/<name>（与 Node 的查找一致，嵌套版本优先） */
function findPackageDir(name, fromDir) {
  let dir = fromDir
  for (;;) {
    const candidate = join(dir, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** 拷到 vendor 里的位置：保留它在最近那层 node_modules 之下的相对路径 */
function vendorPathOf(pkgDir) {
  const parts = pkgDir.split(sep)
  const first = parts.indexOf('node_modules')
  return join(outModules, ...parts.slice(first + 1).filter((p) => p !== ''))
}

/**
 * served 文件里按相对路径用到的文件：`from './x.js'` / `import './x.js'` / `import('./x.js')`，以及运行时按自己的位置取的
 * `new URL('../libs/x.wasm', import.meta.url)`（three 的 DRACOLoader、KTX2Loader 这样找解码器）
 */
function relativeImportsOf(source) {
  const out = new Set()
  const re = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.{1,2}\/[^'"]+)['"]/g
  for (const m of source.matchAll(re)) out.add(m[1])
  const urls = /\bnew URL\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g
  for (const m of source.matchAll(urls)) out.add(m[1])
  return [...out]
}

/** served 文件里经 import map 指回包里的 import（`three/addons/x.js`）→ 包里的路径 */
function servedImportsOf(source, served) {
  const out = new Set()
  const prefixes = Object.entries(served).filter(([key]) => key.endsWith('/'))
  for (const m of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"./][^'"]*)['"]/g)) {
    const hit = prefixes.find(([key]) => m[1].startsWith(key))
    if (hit) out.add(posix.normalize(hit[1] + m[1].slice(hit[0].length)))
  }
  return [...out]
}

const manifest = { libraries: {}, packages: {} }
const copied = new Set()
/** vendor 里的目标目录 → 拷进来的源目录：两份不同的源落到同一个目标（不同 node_modules 根下的同名包）就失败 */
const destinations = new Map()
let fileCount = 0
let byteCount = 0

function copyPackage(pkgDir, { libraryFiles, served } = {}) {
  if (copied.has(pkgDir)) return
  copied.add(pkgDir)
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf-8'))
  const dest = vendorPathOf(pkgDir)
  if (destinations.has(dest)) {
    throw new Error(
      `${pkg.name}: both ${destinations.get(dest)} and ${pkgDir} would be vendored to ${dest}`
    )
  }
  destinations.set(dest, pkgDir)
  const files = new Set(selectFiles(pkgDir, filesOverride(pkg.name, libraryFiles)))

  if (served) {
    // 浏览器直接按相对路径取：用到的文件必须都在
    const queue = [...files].filter((p) => p.endsWith('.js'))
    while (queue.length > 0) {
      const file = queue.pop()
      const source = readFileSync(join(pkgDir, file), 'utf-8')
      const targets = [
        ...relativeImportsOf(source).map((spec) => ({
          spec,
          target: posix.normalize(posix.join(posix.dirname(file), spec))
        })),
        ...servedImportsOf(source, served).map((target) => ({ spec: target, target }))
      ]
      for (const { spec, target } of targets) {
        if (target.startsWith('../')) {
          throw new Error(`${pkg.name}/${file} imports ${spec}, which is outside the package`)
        }
        if (files.has(target)) continue
        if (!existsSync(join(pkgDir, target))) {
          throw new Error(`${pkg.name}/${file} imports ${spec}, which does not exist`)
        }
        files.add(target)
        if (target.endsWith('.js')) queue.push(target)
      }
    }
  }

  for (const file of files) {
    const from = join(pkgDir, file)
    const to = join(dest, file)
    mkdirSync(dirname(to), { recursive: true })
    if (served && file.endsWith('.js')) {
      const { code } = transformSync(readFileSync(from, 'utf-8'), {
        loader: 'js',
        minify: true,
        legalComments: 'inline',
        target: 'es2020'
      })
      writeFileSync(to, code)
    } else {
      copyFileSync(from, to)
    }
    fileCount++
    byteCount += statSync(to).size
  }
  manifest.packages[relative(outModules, dest).split(sep).join('/')] = pkg.version

  for (const dep of Object.keys(pkg.dependencies ?? {})) {
    if (skipDependencies.has(dep)) continue
    const depDir = findPackageDir(dep, pkgDir)
    if (!depDir) throw new Error(`${pkg.name} depends on ${dep}, which is not installed`)
    copyPackage(depDir)
  }
}

// 先把每个库都核对一遍，再动 vendor：半路失败不留下一份缺库、没有清单的目录
const libraryDirs = Object.entries(table.libraries).map(([name, lib]) => {
  const pkgDir = findPackageDir(name, appDir)
  if (!pkgDir) {
    throw new Error(`${name} is not installed; run npm install (apps/desktop devDependencies)`)
  }
  const installed = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf-8')).version
  if (installed !== lib.version) {
    throw new Error(
      `${name} ${installed} is installed but widgetLibs.json says ${lib.version}; pin the same version in both`
    )
  }
  return { name, lib, pkgDir }
})

rmSync(vendorDir, { recursive: true, force: true })
mkdirSync(outModules, { recursive: true })

for (const { name, lib, pkgDir } of libraryDirs) {
  copyPackage(pkgDir, { libraryFiles: lib.files, served: lib.served })
  manifest.libraries[name] = lib.version
}

// afterPack 按它核对打进包的文件一个不少（electron-builder 对 node_modules 有默认排除规则）
manifest.fileCount = fileCount
writeFileSync(join(vendorDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(
  `vendor-widget-libs: ${Object.keys(manifest.libraries).length} libraries, ${copied.size} packages, ${fileCount} files, ${(byteCount / 1024 / 1024).toFixed(1)} MB → ${relative(appDir, vendorDir)}`
)
