/**
 * 库文件路由的纯函数部分（widgetLibFiles.ts）：`resolveWidgetLibFile(rest, vendorDir)` 决定 `/w/<id>/lib/…` 发哪个
 * vendor 文件，`acceptsGzip` 决定发不发 gzip。路由的接线、令牌、应答头在 widgetServerLib.test.ts。
 * 两种 vendor：仓库里拷好的真目录（`resources/bundler/vendor`，没跑过 postinstall 就失败并说 run npm install），
 * 与每条用例自己搭的假 vendor（临时目录；macOS 上 tmpdir 经 /var → /private/var 的符号链接，这里不 realpath，
 * 拼出来的路径就是给的那个前缀）。
 *
 *   L-1  three.module.js → vendor 里的绝对路径
 *   L-2  examples/jsm 下的 addon，以及闭包补进来的 utils/BufferGeometryUtils.js
 *   L-3  build/three.core.js（three.module.js 相对 import 的那份）→ 照发（F-1 修好之后）
 *   L-4  版本不对、带后缀、空版本、只有前缀、没有版本 → null
 *   L-5  不是 served 的库（vendor 里也有那个文件）→ null
 *   L-6  不认识的名字、大小写不同、scope 包 → null
 *   L-7  `..`、`.`、空段、反斜杠、`%2e%2e`（不解码）→ null
 *   L-8  served 库里不是 .js/.mjs/.css 的文件（package.json、LICENSE）→ null
 *   L-9  假 vendor：.js / .mjs / .css 与子目录里的发；.json / .html / 名叫 dir.js 的目录 / 不存在的 / 末尾带 `/` → null
 *   L-10 钉住：vendor 里指向外面的符号链接照发（statSync 跟着链接走；vendor 由安装控制，可以接受）
 *   L-11 解码器的 .wasm：真 vendor 里 draco、basis 的路由 → 绝对路径；假 vendor 里 x.wasm 发，没有的、名叫 dir.wasm 的目录 → null
 *   F-13 acceptsGzip：gzip / `*` 且 q 不是 0 才收；`gzip;q=0`、`x-gzip`、deflate / br、空的 → 不收
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
}))

import { acceptsGzip, resolveWidgetLibFile } from '../widgetLibFiles'

/** apps/desktop */
const DESKTOP_DIR = resolve(__dirname, '../../../../..')
const VENDOR = join(DESKTOP_DIR, 'resources/bundler/vendor')
const THREE = join(VENDOR, 'node_modules/three')

function requireVendor(): void {
  if (!existsSync(join(VENDOR, 'manifest.json'))) {
    throw new Error(`${VENDOR}/manifest.json is missing: run npm install`)
  }
}

let tmp = ''
let fixture = ''

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'shuvix-widget-lib-files-'))
  fixture = join(tmp, 'vendor')
  const jsm = join(fixture, 'node_modules/three/examples/jsm')
  const put = (path: string, content = 'x'): void => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
  put(join(fixture, 'node_modules/three/build/three.module.js'), 'export {}')
  for (const name of ['a.js', 'b.mjs', 'c.css', 'd.json', 'e.html', 'sub/f.js', 'x.wasm']) {
    put(join(jsm, name))
  }
  mkdirSync(join(jsm, 'dir.js'))
  mkdirSync(join(jsm, 'dir.wasm'))
  put(join(tmp, 'outside/secret.js'), 'outside the vendor')
  symlinkSync(join(tmp, 'outside/secret.js'), join(jsm, 'link.js'))
})

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('L resolveWidgetLibFile，仓库里的 vendor', () => {
  it('L-1 three.module.js → 绝对路径', () => {
    requireVendor()
    expect(resolveWidgetLibFile('/lib/three@0.187.0/build/three.module.js', VENDOR)).toBe(
      join(THREE, 'build/three.module.js')
    )
  })

  it('L-2 addon 与闭包补进来的 utils', () => {
    requireVendor()
    expect(
      resolveWidgetLibFile('/lib/three@0.187.0/examples/jsm/controls/OrbitControls.js', VENDOR)
    ).toBe(join(THREE, 'examples/jsm/controls/OrbitControls.js'))
    expect(
      resolveWidgetLibFile('/lib/three@0.187.0/examples/jsm/utils/BufferGeometryUtils.js', VENDOR)
    ).toBe(join(THREE, 'examples/jsm/utils/BufferGeometryUtils.js'))
  })

  it('L-3 build/three.core.js（three.module.js 相对 import 的那份）→ 照发（F-1）', () => {
    requireVendor()
    expect(resolveWidgetLibFile('/lib/three@0.187.0/build/three.core.js', VENDOR)).toBe(
      join(THREE, 'build/three.core.js')
    )
  })

  it.each([
    '/lib/three@0.186.0/build/three.module.js',
    '/lib/three@0.187.0-beta/build/three.module.js',
    '/lib/three@/build/three.module.js',
    '/lib/three@0.187.0/',
    '/lib/three/build/three.module.js'
  ])('L-4 版本不对或没有：%s → null', (rest) => {
    requireVendor()
    expect(resolveWidgetLibFile(rest, VENDOR)).toBeNull()
  })

  it.each([
    ['/lib/chart.js@4.6.1/dist/chart.js', 'chart.js/dist/chart.js'],
    ['/lib/lucide-react@0.564.0/dist/esm/lucide-react.js', 'lucide-react/dist/esm/lucide-react.js']
  ])('L-5 不是 served 的库：%s → null（vendor 里确实有）', (rest, file) => {
    requireVendor()
    expect(existsSync(join(VENDOR, 'node_modules', file))).toBe(true)
    expect(resolveWidgetLibFile(rest, VENDOR)).toBeNull()
  })

  it.each([
    '/lib/left-pad@1.0.0/index.js',
    '/lib/Three@0.187.0/build/three.module.js',
    '/lib/@scope/pkg@1/x.js'
  ])('L-6 不认识或大小写不同：%s → null', (rest) => {
    requireVendor()
    expect(resolveWidgetLibFile(rest, VENDOR)).toBeNull()
  })

  it.each([
    '/lib/three@0.187.0/examples/jsm/../../package.json',
    '/lib/three@0.187.0/examples/jsm/./controls/OrbitControls.js',
    '/lib/three@0.187.0/examples/jsm//controls/OrbitControls.js',
    '/lib/three@0.187.0/examples\\jsm\\controls\\OrbitControls.js',
    '/lib/three@0.187.0/examples/jsm/%2e%2e/%2e%2e/package.json',
    '/lib/three@0.187.0/build/../build/three.core.js'
  ])('L-7 穿越与怪段：%s → null', (rest) => {
    requireVendor()
    expect(resolveWidgetLibFile(rest, VENDOR)).toBeNull()
  })

  it.each(['/lib/three@0.187.0/package.json', '/lib/three@0.187.0/LICENSE'])(
    'L-8 served 库里不该发的文件：%s → null（vendor 里确实有）',
    (rest) => {
      requireVendor()
      expect(existsSync(join(THREE, rest.split('/').pop()!))).toBe(true)
      expect(resolveWidgetLibFile(rest, VENDOR)).toBeNull()
    }
  )

  it.each([
    'examples/jsm/libs/draco/draco_decoder.wasm',
    'examples/jsm/libs/draco/gltf/draco_decoder.wasm',
    'examples/jsm/libs/basis/basis_transcoder.wasm'
  ])('L-11 %s → 绝对路径', (file) => {
    requireVendor()
    expect(resolveWidgetLibFile(`/lib/three@0.187.0/${file}`, VENDOR)).toBe(join(THREE, file))
  })
})

describe('L resolveWidgetLibFile，假 vendor', () => {
  const base = '/lib/three@0.187.0/examples/jsm/'

  it.each(['a.js', 'b.mjs', 'c.css', 'sub/f.js', 'x.wasm'])('L-9 / L-11 %s → 绝对路径', (file) => {
    expect(resolveWidgetLibFile(base + file, fixture)).toBe(
      join(fixture, 'node_modules/three/examples/jsm', ...file.split('/'))
    )
  })

  it.each(['d.json', 'e.html', 'dir.js', 'missing.js', 'dir.wasm', 'missing.wasm'])(
    'L-9 / L-11 %s → null',
    (file) => {
      expect(resolveWidgetLibFile(base + file, fixture)).toBeNull()
    }
  )

  it('L-9 文件路径末尾带 `/` → null', () => {
    expect(resolveWidgetLibFile('/lib/three@0.187.0/build/three.module.js', fixture)).not.toBeNull()
    expect(resolveWidgetLibFile('/lib/three@0.187.0/build/three.module.js/', fixture)).toBeNull()
  })

  it('L-10 钉住：指向 vendor 外面的符号链接照发', () => {
    expect(resolveWidgetLibFile(`${base}link.js`, fixture)).toBe(
      join(fixture, 'node_modules/three/examples/jsm/link.js')
    )
  })

  it('vendor 目录不存在 → null', () => {
    expect(
      resolveWidgetLibFile('/lib/three@0.187.0/build/three.module.js', join(tmp, 'nope'))
    ).toBeNull()
  })
})

describe('F-13 acceptsGzip', () => {
  it.each<[string | string[] | undefined, boolean]>([
    ['gzip', true],
    ['gzip, deflate, br', true],
    ['br, gzip', true],
    ['GZIP', true],
    ['gzip;q=0.5', true],
    ['gzip; q=1', true],
    ['*', true],
    ['*;q=0.1', true],
    [['deflate', 'gzip'], true],
    ['gzip;q=0', false],
    ['gzip;q=0.0', false],
    ['*;q=0', false],
    ['x-gzip', false],
    ['deflate, br', false],
    ['identity', false],
    ['', false],
    [undefined, false]
  ])('acceptsGzip(%j) → %s', (header, expected) => {
    expect(acceptsGzip(header)).toBe(expected)
  })
})
