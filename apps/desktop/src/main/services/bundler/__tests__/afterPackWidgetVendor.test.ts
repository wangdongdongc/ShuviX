/**
 * electron-builder 的 afterPack 钩子（build/afterPack.cjs）里核对小组件库进了包的那一步 —— `checkWidgetVendor(resourcesDir)`
 * 与默认导出按平台算出的 Resources 目录。vitest 只收 `src/main/**`，所以这份测试住在这里，经 createRequire 加载那个 .cjs。
 * 夹具是临时目录里手搭的 `<res>/bundler/vendor`（manifest.json + node_modules）；macOS 上 os.tmpdir() 在 /var 下、
 * 真实路径是 /private/var，钩子只拼路径不取真实路径，所以断言用的就是 mkdtemp 给的那条。
 *
 *   AP-1 清单、包（含 scoped 的 `@x/y` 与嵌套的 `a/node_modules/b`）、fileCount 都对 → 不抛；日志
 *        `[afterPack] widget libraries: N present`（N = 清单里的库数）
 *   AP-2 没有 manifest.json → 抛出，消息带清单的路径与 `is missing: run npm install`
 *   AP-3 清单里的包缺 package.json → `widget libraries missing from the package: <那个键>`；缺几个列几个
 *   AP-4 少一个文件 → `K-1 widget library files were packaged, K were vendored`
 *   AP-5 多一个文件 → 反过来（K+1 packaged）
 *   AP-6 仓库里真的 `apps/desktop/resources` → 不抛（开发树的自检，与 widgetLibs.test 的 VR-3 重叠）
 *   AP-7 默认导出：设了 CSC_LINK（不去调 codesign）；vendor 不在时 darwin 报
 *        `<appOutDir>/<productFilename>.app/Contents/Resources/bundler/vendor` 下的路径，linux / win32 报
 *        `<appOutDir>/resources/bundler/vendor` 下的路径；vendor 在时都正常结束
 */
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** apps/desktop */
const DESKTOP_DIR = resolve(__dirname, '../../../../..')

interface AfterPackContext {
  electronPlatformName: string
  appOutDir: string
  packager: { appInfo: { productFilename: string } }
}

const afterPack = createRequire(import.meta.url)(join(DESKTOP_DIR, 'build/afterPack.cjs')) as {
  checkWidgetVendor: (resourcesDir: string) => void
  default: (context: AfterPackContext) => Promise<void>
}

let tmp = ''

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'shuvix-afterpack-'))
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  rmSync(tmp, { recursive: true, force: true })
})

function put(path: string, content = 'x'): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

/**
 * 在 `<res>/bundler/vendor` 下搭一份：每个包写 package.json 加 `files` 里的文件，fileCount 照实数；
 * 交回 vendor 目录与 fileCount
 */
function makeVendor(
  res: string,
  packages: Record<string, { version: string; files?: string[] }>,
  libraries: Record<string, string>
): { vendor: string; fileCount: number } {
  const vendor = join(res, 'bundler', 'vendor')
  let fileCount = 0
  const manifestPackages: Record<string, string> = {}
  for (const [key, { version, files = [] }] of Object.entries(packages)) {
    const dir = join(vendor, 'node_modules', key)
    put(
      join(dir, 'package.json'),
      JSON.stringify({ name: key.split('node_modules/').pop(), version })
    )
    fileCount++
    for (const file of files) {
      put(join(dir, file), `// ${key}/${file}`)
      fileCount++
    }
    manifestPackages[key] = version
  }
  writeFileSync(
    join(vendor, 'manifest.json'),
    JSON.stringify({ libraries, packages: manifestPackages, fileCount }, null, 2) + '\n'
  )
  return { vendor, fileCount }
}

/** 一份完整的夹具：两个库、一个 scoped 包、一个嵌套包 */
function standardVendor(res: string): { vendor: string; fileCount: number } {
  return makeVendor(
    res,
    {
      a: { version: '1.0.0', files: ['index.js', 'lib/util.js'] },
      'a/node_modules/b': { version: '2.0.0', files: ['index.js'] },
      b: { version: '1.0.0', files: ['index.js'] },
      '@x/y': { version: '3.0.0', files: ['dist/esm/y.js', 'style.css', 'LICENSE'] }
    },
    { a: '1.0.0', '@x/y': '3.0.0' }
  )
}

describe('AP checkWidgetVendor', () => {
  it('AP-1 清单、包、fileCount 都对 → 不抛，日志报库数', () => {
    const res = join(tmp, 'res')
    standardVendor(res)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    expect(() => afterPack.checkWidgetVendor(res)).not.toThrow()

    expect(log).toHaveBeenCalledWith('[afterPack] widget libraries: 2 present')
  })

  it('AP-2 没有 manifest.json → 抛出，带清单路径与 run npm install', () => {
    const res = join(tmp, 'res')
    standardVendor(res)
    const manifestPath = join(res, 'bundler', 'vendor', 'manifest.json')
    unlinkSync(manifestPath)

    expect(() => afterPack.checkWidgetVendor(res)).toThrow(manifestPath)
    expect(() => afterPack.checkWidgetVendor(res)).toThrow('is missing: run npm install')
  })

  it('AP-2 整个 vendor 目录都不在 → 同一句', () => {
    const res = join(tmp, 'res')
    mkdirSync(res)
    expect(() => afterPack.checkWidgetVendor(res)).toThrow(
      `${join(res, 'bundler', 'vendor', 'manifest.json')} is missing: run npm install`
    )
  })

  it('AP-3 一个包缺 package.json → 点名那个键', () => {
    const res = join(tmp, 'res')
    const { vendor } = standardVendor(res)
    unlinkSync(join(vendor, 'node_modules', '@x/y', 'package.json'))

    expect(() => afterPack.checkWidgetVendor(res)).toThrow(
      '[afterPack] widget libraries missing from the package: @x/y'
    )
  })

  it('AP-3 缺几个列几个（嵌套的键照原样）', () => {
    const res = join(tmp, 'res')
    const { vendor } = standardVendor(res)
    rmSync(join(vendor, 'node_modules', 'a', 'node_modules'), { recursive: true })
    unlinkSync(join(vendor, 'node_modules', '@x/y', 'package.json'))

    let message = ''
    try {
      afterPack.checkWidgetVendor(res)
    } catch (e) {
      message = (e as Error).message
    }
    const listed = message.replace('[afterPack] widget libraries missing from the package: ', '')
    expect(listed.split(', ').sort()).toEqual(['@x/y', 'a/node_modules/b'])
  })

  it('AP-4 少一个文件 → K-1 packaged, K vendored', () => {
    const res = join(tmp, 'res')
    const { vendor, fileCount } = standardVendor(res)
    unlinkSync(join(vendor, 'node_modules', 'a', 'lib', 'util.js'))

    expect(() => afterPack.checkWidgetVendor(res)).toThrow(
      `[afterPack] ${fileCount - 1} widget library files were packaged, ${fileCount} were vendored`
    )
  })

  it('AP-5 多一个文件 → K+1 packaged, K vendored', () => {
    const res = join(tmp, 'res')
    const { vendor, fileCount } = standardVendor(res)
    put(join(vendor, 'node_modules', '@x/y', 'dist', 'extra.js'))

    expect(() => afterPack.checkWidgetVendor(res)).toThrow(
      `[afterPack] ${fileCount + 1} widget library files were packaged, ${fileCount} were vendored`
    )
  })

  it('AP-6 仓库里真的 resources → 不抛', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    // vendor 不在时这句自己就会说「run npm install」：开发检出没跑过 postinstall
    expect(() => afterPack.checkWidgetVendor(join(DESKTOP_DIR, 'resources'))).not.toThrow()
  })
})

describe('AP-7 默认导出按平台找 Resources', () => {
  const PRODUCT = 'ShuviX'
  const context = (platform: string, appOutDir: string): AfterPackContext => ({
    electronPlatformName: platform,
    appOutDir,
    packager: { appInfo: { productFilename: PRODUCT } }
  })

  beforeEach(() => {
    // 有证书 → 钩子不去调 codesign
    vi.stubEnv('CSC_LINK', 'test-certificate')
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  it('AP-7 darwin：vendor 不在 → 报 .app/Contents/Resources 下的路径', async () => {
    const out = join(tmp, 'mac')
    const expected = join(
      out,
      `${PRODUCT}.app`,
      'Contents',
      'Resources',
      'bundler',
      'vendor',
      'manifest.json'
    )
    await expect(afterPack.default(context('darwin', out))).rejects.toThrow(
      `${expected} is missing`
    )
  })

  it.each(['linux', 'win32'])('AP-7 %s：vendor 不在 → 报 resources 下的路径', async (platform) => {
    const out = join(tmp, platform)
    const expected = join(out, 'resources', 'bundler', 'vendor', 'manifest.json')
    await expect(afterPack.default(context(platform, out))).rejects.toThrow(
      `${expected} is missing`
    )
  })

  it('AP-7 darwin：vendor 在 → 正常结束（有证书，跳过重签）', async () => {
    const out = join(tmp, 'mac')
    standardVendor(join(out, `${PRODUCT}.app`, 'Contents', 'Resources'))
    await expect(afterPack.default(context('darwin', out))).resolves.toBeUndefined()
  })

  it.each(['linux', 'win32'])('AP-7 %s：vendor 在 → 正常结束', async (platform) => {
    const out = join(tmp, platform)
    standardVendor(join(out, 'resources'))
    await expect(afterPack.default(context(platform, out))).resolves.toBeUndefined()
  })
})
