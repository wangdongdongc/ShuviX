/**
 * 原生消息宿主的安装 —— Windows 那半边：清单写一份到 `~/.shuvix/chrome-bridge/`，再由各浏览器的
 * HKCU 注册表项指过去（`reg add`）。
 *
 * `reg` 走 child_process.execFile，这里把它 mock 掉 —— 所以单独一个文件：hostInstaller.test 的 HI-6
 * 要用真的 execFile 执行启动脚本。在非 Windows 的机器上跑同样成立：platform 是参数，不读 process.platform。
 *
 *   HI-15  启动脚本（.cmd）与清单写在 <home>/.shuvix/chrome-bridge/；5 个浏览器各一次
 *          `reg add <key> /ve /t REG_SZ /d <清单路径> /f`（windowsHide）；某一次失败只记那个浏览器；
 *          清单本身写不成 → failed '*'、一次 reg 也不跑
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { execFile } from 'child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return { ...actual, execFile: vi.fn() }
})

vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

import {
  installNativeHost,
  launcherContent,
  manifestContent,
  nativeHostTargets
} from '../hostInstaller'

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void
const execFileMock = execFile as unknown as Mock<
  (file: string, args: string[], options: object, callback: ExecFileCallback) => void
>

const PATHS = {
  electron: 'C:\\Program Files\\ShuviX\\ShuviX.exe',
  cliJs: 'C:\\Program Files\\ShuviX\\resources\\app.asar\\out\\main\\cli.js'
}

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cb-'))
  execFileMock.mockReset()
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('installNativeHost —— Windows（reg 被 mock）', () => {
  it('HI-15 清单写在 ~/.shuvix/chrome-bridge/，path 指向 .cmd 启动脚本；5 个浏览器各 reg add 一次；某一次失败只记那个浏览器', async () => {
    execFileMock.mockImplementation((_file, args, _options, callback) => {
      const failing = args[1].includes('Microsoft')
      callback(failing ? new Error('ERROR: Access is denied.') : null, '', '')
    })

    const result = await installNativeHost({ platform: 'win32', home, ...PATHS })

    const bridgeHome = join(home, '.shuvix', 'chrome-bridge')
    const launcher = join(bridgeHome, 'native-host.cmd')
    const manifestPath = join(bridgeHome, 'com.shuvix.chrome_bridge.json')
    expect(readFileSync(launcher, 'utf-8')).toBe(launcherContent('win32', PATHS))
    expect(readFileSync(manifestPath, 'utf-8')).toBe(manifestContent(launcher))

    const targets = nativeHostTargets('win32', home)
    expect(execFileMock).toHaveBeenCalledTimes(targets.length)
    targets.forEach((target, i) => {
      expect(execFileMock.mock.calls[i].slice(0, 3)).toEqual([
        'reg',
        ['add', target.registryKey, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'],
        { windowsHide: true }
      ])
      expect(execFileMock.mock.calls[i][3]).toEqual(expect.any(Function))
    })

    expect(result).toStrictEqual({
      launcher,
      installed: ['Google Chrome', 'Chromium', 'Brave', 'Vivaldi'],
      failed: [{ browser: 'Microsoft Edge', error: 'ERROR: Access is denied.' }]
    })
  })

  it('HI-15 全部 reg add 成功：5 个浏览器都算装好', async () => {
    execFileMock.mockImplementation((_file, _args, _options, callback) => callback(null, '', ''))

    const result = await installNativeHost({ platform: 'win32', home, ...PATHS })

    expect(result.installed).toEqual([
      'Google Chrome',
      'Chromium',
      'Microsoft Edge',
      'Brave',
      'Vivaldi'
    ])
    expect(result.failed).toEqual([])
  })

  it("HI-15 清单写不成（那个路径是个目录）：failed 记 '*'，一次 reg 也不跑", async () => {
    mkdirSync(join(home, '.shuvix', 'chrome-bridge', 'com.shuvix.chrome_bridge.json'), {
      recursive: true
    })

    const result = await installNativeHost({ platform: 'win32', home, ...PATHS })

    expect(result).toStrictEqual({
      launcher: join(home, '.shuvix', 'chrome-bridge', 'native-host.cmd'),
      installed: [],
      failed: [{ browser: '*', error: expect.any(String) }]
    })
    expect(execFileMock).not.toHaveBeenCalled()
  })
})
