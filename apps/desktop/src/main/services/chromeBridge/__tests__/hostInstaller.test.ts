/**
 * 原生消息宿主的安装 —— 启动脚本 + 各浏览器的宿主清单（Windows 的注册表那半边在 hostInstallerWin.test）。
 *
 * 纯函数（落点、脚本内容、清单内容）三个平台都钉；有副作用的 installNativeHost 在临时目录当 home
 * 的真文件系统上跑（macOS / Linux 两条路径）。启动脚本还真的用 sh 执行一遍：路径里的空格与单引号、
 * 用户的 NODE_OPTIONS，这些只有跑起来才看得出对错。
 *
 *   HI-1~3   nativeHostTargets：darwin 15 个、linux 10 个（按表的顺序、真实的用户数据目录）；win32 5 个注册表项
 *   HI-4     launcherPath：~/.shuvix/chrome-bridge/native-host（Windows .cmd）
 *   HI-5~7   launcherContent：POSIX 逐行钉死、真跑一遍；Windows 行尾 CRLF、路径里的 % 写成 %%
 *   HI-8     manifestContent：名字、描述、path、stdio、只放行 ShuviX 扩展；末尾换行
 *   HI-9~11  installNativeHost：只给装了的浏览器写清单、不替没装的建目录；一个都没装也写启动脚本
 *   HI-12    幂等：内容没变不碰文件（mtime 不动）；electron 路径变了只重写启动脚本
 *   HI-13/14 某个浏览器失败只记它自己；启动脚本写不成 → failed '*'、不写任何清单、不抛
 *   HI-16    守护：CHROME_EXTENSION_ID 由扩展 manifest 的 key 推出（sha256 前 32 位 hex → a-p）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFile } from 'child_process'
import { createHash } from 'crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { promisify } from 'util'
import { CHROME_EXTENSION_ID } from '@shuvix/chat-protocol/chromeBridge'

vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

import {
  installNativeHost,
  launcherContent,
  launcherPath,
  manifestContent,
  nativeHostTargets
} from '../hostInstaller'

const HERE = dirname(fileURLToPath(import.meta.url))
/** `…/apps/desktop/src/main/services/chromeBridge/__tests__` 往上七层 */
const REPO_ROOT = resolve(HERE, '../../../../../../..')

const MANIFEST_NAME = 'com.shuvix.chrome_bridge.json'
const PATHS = {
  electron: '/Applications/ShuviX.app/Contents/MacOS/ShuviX',
  cliJs: '/Applications/ShuviX.app/Contents/Resources/app.asar/out/main/cli.js'
}

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cb-'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

/** 目录下（递归）所有叫 name 的文件 */
function findFiles(root: string, name: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) out.push(...findFiles(path, name))
    else if (entry.name === name) out.push(path)
  }
  return out.sort()
}

const macSupport = (): string => join(home, 'Library', 'Application Support')

describe('原生消息宿主：各平台的落点与内容（纯函数）', () => {
  it('HI-1 darwin：15 个浏览器、按表的顺序；用户数据目录在 ~/Library/Application Support 下，清单目录是它下面的 NativeMessagingHosts；没有注册表项', () => {
    const table: Array<[string, string[]]> = [
      ['Google Chrome', ['Google', 'Chrome']],
      ['Google Chrome Beta', ['Google', 'Chrome Beta']],
      ['Google Chrome Dev', ['Google', 'Chrome Dev']],
      ['Google Chrome Canary', ['Google', 'Chrome Canary']],
      ['Google Chrome for Testing', ['Google', 'Chrome for Testing']],
      ['Chromium', ['Chromium']],
      ['Microsoft Edge', ['Microsoft Edge']],
      ['Microsoft Edge Beta', ['Microsoft Edge Beta']],
      ['Microsoft Edge Dev', ['Microsoft Edge Dev']],
      ['Microsoft Edge Canary', ['Microsoft Edge Canary']],
      ['Brave', ['BraveSoftware', 'Brave-Browser']],
      ['Brave Beta', ['BraveSoftware', 'Brave-Browser-Beta']],
      ['Brave Nightly', ['BraveSoftware', 'Brave-Browser-Nightly']],
      ['Vivaldi', ['Vivaldi']],
      ['Arc', ['Arc', 'User Data']]
    ]
    const root = join('/Users/u', 'Library', 'Application Support')
    const targets = nativeHostTargets('darwin', '/Users/u')

    expect(targets).toStrictEqual(
      table.map(([browser, rel]) => {
        const baseDir = join(root, ...rel)
        return { browser, baseDir, manifestDir: join(baseDir, 'NativeMessagingHosts') }
      })
    )
    expect(targets[0].baseDir).toBe(join('/Users/u', 'Library/Application Support/Google/Chrome'))
    expect(targets[0].manifestDir).toBe(
      join('/Users/u', 'Library/Application Support/Google/Chrome/NativeMessagingHosts')
    )
    expect(targets.find((t) => t.browser === 'Arc')?.baseDir).toBe(
      join('/Users/u', 'Library/Application Support/Arc/User Data')
    )
  })

  it('HI-2 linux：10 个浏览器、都在 ~/.config 下', () => {
    const table: Array<[string, string[]]> = [
      ['Google Chrome', ['google-chrome']],
      ['Google Chrome Beta', ['google-chrome-beta']],
      ['Google Chrome Dev', ['google-chrome-unstable']],
      ['Google Chrome for Testing', ['google-chrome-for-testing']],
      ['Chromium', ['chromium']],
      ['Microsoft Edge', ['microsoft-edge']],
      ['Microsoft Edge Beta', ['microsoft-edge-beta']],
      ['Microsoft Edge Dev', ['microsoft-edge-dev']],
      ['Brave', ['BraveSoftware', 'Brave-Browser']],
      ['Vivaldi', ['vivaldi']]
    ]
    const root = join('/home/u', '.config')
    expect(nativeHostTargets('linux', '/home/u')).toStrictEqual(
      table.map(([browser, rel]) => {
        const baseDir = join(root, ...rel)
        return { browser, baseDir, manifestDir: join(baseDir, 'NativeMessagingHosts') }
      })
    )
  })

  it('HI-3 win32：5 个注册表项 HKCU\\Software\\<厂商>\\NativeMessagingHosts\\com.shuvix.chrome_bridge；baseDir 为空串', () => {
    const key = (vendor: string): string =>
      ['HKCU', 'Software', vendor, 'NativeMessagingHosts', 'com.shuvix.chrome_bridge'].join('\\')
    expect(nativeHostTargets('win32', 'C:\\Users\\u')).toStrictEqual([
      { browser: 'Google Chrome', baseDir: '', registryKey: key('Google\\Chrome') },
      { browser: 'Chromium', baseDir: '', registryKey: key('Chromium') },
      { browser: 'Microsoft Edge', baseDir: '', registryKey: key('Microsoft\\Edge') },
      { browser: 'Brave', baseDir: '', registryKey: key('BraveSoftware\\Brave-Browser') },
      { browser: 'Vivaldi', baseDir: '', registryKey: key('Vivaldi') }
    ])
    expect(key('Google\\Chrome')).toBe(
      String.raw`HKCU\Software\Google\Chrome\NativeMessagingHosts\com.shuvix.chrome_bridge`
    )
  })

  it('HI-4 launcherPath：~/.shuvix/chrome-bridge/native-host；Windows 是 native-host.cmd', () => {
    expect(launcherPath('darwin', '/Users/u')).toBe(
      join('/Users/u', '.shuvix', 'chrome-bridge', 'native-host')
    )
    expect(launcherPath('linux', '/home/u')).toBe(
      join('/home/u', '.shuvix', 'chrome-bridge', 'native-host')
    )
    expect(launcherPath('win32', 'C:\\Users\\u')).toBe(
      join('C:\\Users\\u', '.shuvix', 'chrome-bridge', 'native-host.cmd')
    )
  })

  it('HI-5 POSIX 启动脚本逐行钉死：sh、清掉 NODE_OPTIONS、以 node 模式 exec 两个带单引号的绝对路径并透传参数；路径里的单引号被转义', () => {
    const expected = (electron: string, cliJs: string): string =>
      [
        '#!/bin/sh',
        '# Generated by ShuviX at every start: launches the Chrome native messaging host.',
        'unset NODE_OPTIONS',
        `ELECTRON_RUN_AS_NODE=1 exec ${electron} ${cliJs} native-host "$@"`,
        ''
      ].join('\n')

    for (const platform of ['darwin', 'linux'] as const) {
      expect(launcherContent(platform, PATHS)).toBe(
        expected(`'${PATHS.electron}'`, `'${PATHS.cliJs}'`)
      )
    }
    expect(
      launcherContent('linux', { electron: "/opt/it's/electron", cliJs: '/opt/a b/cli.js' })
    ).toBe(expected(`'/opt/it'\\''s/electron'`, `'/opt/a b/cli.js'`))
  })

  it.skipIf(process.platform === 'win32')(
    'HI-6 真跑一遍：electron 路径带空格与单引号、cli.js 路径带空格、调用方设了 NODE_OPTIONS —— 进程看到 ELECTRON_RUN_AS_NODE=1、没有 NODE_OPTIONS、参数原样',
    async () => {
      const binDir = join(home, "it's here")
      mkdirSync(binDir, { recursive: true })
      const electron = join(binDir, 'fake electron')
      writeFileSync(
        electron,
        '#!/bin/sh\nprintf \'%s|%s|%s\' "$ELECTRON_RUN_AS_NODE" "${NODE_OPTIONS-unset}" "$*"\n',
        { mode: 0o755 }
      )
      const cliJs = join(home, 'my cli', 'cli.js')
      const launcher = join(home, 'native-host')
      writeFileSync(launcher, launcherContent('darwin', { electron, cliJs }), { mode: 0o755 })

      const { stdout } = await promisify(execFile)(launcher, ['chrome-extension://abc/'], {
        env: { ...process.env, NODE_OPTIONS: 'x', ELECTRON_RUN_AS_NODE: '' }
      })
      expect(stdout).toBe(`1|unset|${cliJs} native-host chrome-extension://abc/`)
    },
    // 首次执行一个刚写出来的脚本，macOS 上可能要等系统扫描
    20_000
  )

  it('HI-7 Windows 启动脚本：逐行钉死、行尾一律 CRLF（没有单独的 LF）；路径里的字面 % 写成 %%', () => {
    const electron = 'C:\\Program Files\\ShuviX\\ShuviX.exe'
    const cliJs = 'C:\\Program Files\\ShuviX\\resources\\app.asar\\out\\main\\cli.js'
    const content = launcherContent('win32', { electron, cliJs })

    expect(content).toBe(
      [
        '@echo off',
        'rem Generated by ShuviX at every start: launches the Chrome native messaging host.',
        'set NODE_OPTIONS=',
        'set ELECTRON_RUN_AS_NODE=1',
        `"${electron}" "${cliJs}" native-host %*`,
        ''
      ].join('\r\n')
    )
    expect(content.split('\r\n').join('')).not.toContain('\n')

    const withPercent = launcherContent('win32', {
      electron: 'C:\\Users\\100%user\\ShuviX.exe',
      cliJs: 'C:\\%PATH%\\cli.js'
    })
    expect(withPercent.split('\r\n')[4]).toBe(
      '"C:\\Users\\100%%user\\ShuviX.exe" "C:\\%%PATH%%\\cli.js" native-host %*'
    )
  })

  it('HI-8 宿主清单：name / description / path / stdio / 只放行 ShuviX 扩展（带结尾斜杠）；文本以换行结尾；Windows 路径转义得回来', () => {
    const launcher = join('/home/u', '.shuvix', 'chrome-bridge', 'native-host')
    const text = manifestContent(launcher)

    expect(JSON.parse(text)).toStrictEqual({
      name: 'com.shuvix.chrome_bridge',
      description: 'ShuviX desktop bridge for the ShuviX Chrome extension',
      path: launcher,
      type: 'stdio',
      allowed_origins: ['chrome-extension://ndeoocbnfjcjbaimaogemlkanfbnjaim/']
    })
    expect(text.endsWith('\n')).toBe(true)

    const winLauncher = 'C:\\Users\\u\\.shuvix\\chrome-bridge\\native-host.cmd'
    expect(JSON.parse(manifestContent(winLauncher)).path).toBe(winLauncher)
  })
})

describe('installNativeHost —— 临时 home 上的真文件系统', () => {
  it('HI-9 darwin：只装了 Chrome 与 Edge —— 启动脚本 0755、内容对；清单恰好写在这两处；不替没装的浏览器建目录', async () => {
    mkdirSync(join(macSupport(), 'Google', 'Chrome'), { recursive: true })
    mkdirSync(join(macSupport(), 'Microsoft Edge'), { recursive: true })

    const result = await installNativeHost({ platform: 'darwin', home, ...PATHS })

    const launcher = join(home, '.shuvix', 'chrome-bridge', 'native-host')
    expect(result).toStrictEqual({
      launcher,
      installed: ['Google Chrome', 'Microsoft Edge'],
      failed: []
    })
    expect(readFileSync(launcher, 'utf-8')).toBe(launcherContent('darwin', PATHS))
    expect(statSync(launcher).mode & 0o777).toBe(0o755)

    const manifests = [
      join(macSupport(), 'Google', 'Chrome', 'NativeMessagingHosts', MANIFEST_NAME),
      join(macSupport(), 'Microsoft Edge', 'NativeMessagingHosts', MANIFEST_NAME)
    ].sort()
    expect(findFiles(home, MANIFEST_NAME)).toEqual(manifests)
    for (const manifest of manifests) {
      expect(readFileSync(manifest, 'utf-8')).toBe(manifestContent(launcher))
    }
    expect(existsSync(join(macSupport(), 'Chromium'))).toBe(false)
    expect(existsSync(join(macSupport(), 'BraveSoftware'))).toBe(false)
    expect(readdirSync(macSupport()).sort()).toEqual(['Google', 'Microsoft Edge'])
    expect(readdirSync(join(macSupport(), 'Google'))).toEqual(['Chrome'])
  })

  it('HI-10 linux：只有 ~/.config/chromium → 只装 Chromium', async () => {
    mkdirSync(join(home, '.config', 'chromium'), { recursive: true })

    const result = await installNativeHost({ platform: 'linux', home, ...PATHS })

    expect(result.installed).toEqual(['Chromium'])
    expect(result.failed).toEqual([])
    expect(findFiles(home, MANIFEST_NAME)).toEqual([
      join(home, '.config', 'chromium', 'NativeMessagingHosts', MANIFEST_NAME)
    ])
    expect(readdirSync(join(home, '.config'))).toEqual(['chromium'])
  })

  it('HI-11 一个浏览器都没装：installed / failed 都空，启动脚本照写', async () => {
    const result = await installNativeHost({ platform: 'darwin', home, ...PATHS })

    expect(result).toStrictEqual({
      launcher: join(home, '.shuvix', 'chrome-bridge', 'native-host'),
      installed: [],
      failed: []
    })
    expect(readFileSync(result.launcher, 'utf-8')).toBe(launcherContent('darwin', PATHS))
    expect(findFiles(home, MANIFEST_NAME)).toEqual([])
    expect(existsSync(macSupport())).toBe(false)
  })

  it('HI-12 幂等：再装一遍内容与 mtime 都不动、结果相同；electron 路径变了（app 挪了 / 升级了）只重写启动脚本，清单不碰', async () => {
    mkdirSync(join(macSupport(), 'Google', 'Chrome'), { recursive: true })
    mkdirSync(join(macSupport(), 'Vivaldi'), { recursive: true })
    const first = await installNativeHost({ platform: 'darwin', home, ...PATHS })
    const launcher = first.launcher
    const manifests = findFiles(home, MANIFEST_NAME)
    expect(manifests).toHaveLength(2)
    const files = [launcher, ...manifests]
    const contents = files.map((file) => readFileSync(file, 'utf-8'))
    const old = new Date('2020-01-01T00:00:00Z')
    for (const file of files) utimesSync(file, old, old)

    const second = await installNativeHost({ platform: 'darwin', home, ...PATHS })
    expect(second).toStrictEqual(first)
    files.forEach((file, i) => {
      expect(readFileSync(file, 'utf-8')).toBe(contents[i])
      expect(statSync(file).mtimeMs).toBe(old.getTime())
    })

    const moved = { ...PATHS, electron: '/Applications/Moved/ShuviX.app/Contents/MacOS/ShuviX' }
    const third = await installNativeHost({ platform: 'darwin', home, ...moved })
    expect(third).toStrictEqual(first)
    expect(readFileSync(launcher, 'utf-8')).toBe(launcherContent('darwin', moved))
    expect(statSync(launcher).mtimeMs).not.toBe(old.getTime())
    expect(statSync(launcher).mode & 0o777).toBe(0o755)
    for (const manifest of manifests) {
      expect(readFileSync(manifest, 'utf-8')).toBe(manifestContent(launcher))
      expect(statSync(manifest).mtimeMs).toBe(old.getTime())
    }
  })

  it('HI-13 某个浏览器装不上（Chrome 的 NativeMessagingHosts 是个普通文件）：只记它失败，别的浏览器照装', async () => {
    mkdirSync(join(macSupport(), 'Google', 'Chrome'), { recursive: true })
    writeFileSync(join(macSupport(), 'Google', 'Chrome', 'NativeMessagingHosts'), 'not a directory')
    mkdirSync(join(macSupport(), 'Microsoft Edge'), { recursive: true })
    mkdirSync(join(macSupport(), 'Vivaldi'), { recursive: true })

    const result = await installNativeHost({ platform: 'darwin', home, ...PATHS })

    expect(result.failed).toEqual([{ browser: 'Google Chrome', error: expect.any(String) }])
    expect(result.failed[0].error.length).toBeGreaterThan(0)
    expect(result.installed).toEqual(['Microsoft Edge', 'Vivaldi'])
    expect(findFiles(home, MANIFEST_NAME)).toEqual(
      [
        join(macSupport(), 'Microsoft Edge', 'NativeMessagingHosts', MANIFEST_NAME),
        join(macSupport(), 'Vivaldi', 'NativeMessagingHosts', MANIFEST_NAME)
      ].sort()
    )
  })

  it("HI-14 启动脚本写不成（~/.shuvix/chrome-bridge 是个普通文件）：failed 记 '*'、一个清单都不写、不抛", async () => {
    mkdirSync(join(home, '.shuvix'), { recursive: true })
    writeFileSync(join(home, '.shuvix', 'chrome-bridge'), 'in the way')
    mkdirSync(join(macSupport(), 'Google', 'Chrome'), { recursive: true })

    const result = await installNativeHost({ platform: 'darwin', home, ...PATHS })

    expect(result).toStrictEqual({
      launcher: join(home, '.shuvix', 'chrome-bridge', 'native-host'),
      installed: [],
      failed: [{ browser: '*', error: expect.any(String) }]
    })
    expect(findFiles(home, MANIFEST_NAME)).toEqual([])
    expect(existsSync(join(macSupport(), 'Google', 'Chrome', 'NativeMessagingHosts'))).toBe(false)
  })
})

describe('守护：扩展 id 与 manifest 的 key 一致', () => {
  it('HI-16 CHROME_EXTENSION_ID = sha256(base64 解码后的 manifest key) 的前 32 个 hex 字符、0-f 映射成 a-p', () => {
    const manifest = JSON.parse(
      readFileSync(join(REPO_ROOT, 'apps', 'extension', 'public', 'manifest.json'), 'utf-8')
    ) as { key?: string }
    expect(typeof manifest.key).toBe('string')

    const hex = createHash('sha256')
      .update(Buffer.from(manifest.key!, 'base64'))
      .digest('hex')
      .slice(0, 32)
    const id = [...hex].map((h) => String.fromCharCode(0x61 + parseInt(h, 16))).join('')

    expect(id).toMatch(/^[a-p]{32}$/)
    expect(CHROME_EXTENSION_ID).toBe(id)
  })
})
