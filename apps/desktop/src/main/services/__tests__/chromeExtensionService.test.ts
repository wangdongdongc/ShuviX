/**
 * Chrome 扩展的桌面侧编排 —— 装原生消息宿主、把「装好了没有、连着哪些浏览器」汇总给设置页。
 *
 * 桥模块、路径工具、应用事件总线都 mock 掉；每条用例重新导入模块（它有「最近一次安装结果」这份模块状态，
 * 还在导入时订阅 chromeBridge.onChange）。
 *
 *   HI-17  installChromeNativeHost 把平台（win32 / darwin / 其余都按 linux）、home、SHUVIX_ELECTRON、
 *          SHUVIX_CLI_JS 交给 installNativeHost；结果进 chromeExtensionStatus().install（装之前是 null）；
 *          装完（成功失败都）发 chromeExtension.changed；桥的连接变化也发
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { homedir } from 'os'

const h = vi.hoisted(() => ({
  changeListeners: [] as Array<() => void>,
  installNativeHost: vi.fn(),
  publish: vi.fn(),
  statuses: vi.fn(() => [] as unknown[]),
  listening: true
}))

vi.mock('../chromeBridge', () => ({
  chromeBridge: {
    get listening() {
      return h.listening
    },
    statuses: h.statuses,
    onChange: (fn: () => void) => {
      h.changeListeners.push(fn)
      return () => {}
    }
  },
  installNativeHost: h.installNativeHost
}))

vi.mock('../../utils/paths', () => ({
  getShuvixCliEnv: () => ({
    SHUVIX_ELECTRON: '/Applications/ShuviX.app/Contents/MacOS/ShuviX',
    SHUVIX_CLI_JS: '/Applications/ShuviX.app/Contents/Resources/app.asar/out/main/cli.js',
    SHUVIX_CLI: '/Applications/ShuviX.app/Contents/Resources/cli/shuvix'
  })
}))

vi.mock('../../utils/appEventBus', () => ({ appEventBus: { publish: h.publish } }))

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

type ServiceModule = typeof import('../chromeExtensionService')

const INSTALLED = {
  launcher: '/home/u/.shuvix/chrome-bridge/native-host',
  installed: ['Google Chrome'],
  failed: []
}

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!

function setPlatform(value: string): void {
  Object.defineProperty(process, 'platform', { ...realPlatform, value })
}

async function load(): Promise<ServiceModule> {
  vi.resetModules()
  return import('../chromeExtensionService')
}

beforeEach(() => {
  h.changeListeners.length = 0
  h.installNativeHost.mockReset()
  h.installNativeHost.mockResolvedValue(INSTALLED)
  h.publish.mockReset()
  h.statuses.mockReset()
  h.statuses.mockReturnValue([])
  h.listening = true
})

afterEach(() => {
  Object.defineProperty(process, 'platform', realPlatform)
})

describe('chromeExtensionService', () => {
  it('HI-17 installChromeNativeHost：交出平台 / home / electron / cli.js；结果回给调用方并进 status；发 chromeExtension.changed', async () => {
    setPlatform('darwin')
    const service = await load()
    const browsers = [
      {
        installId: 'i1',
        runId: 'r1',
        browser: 'Chrome 140',
        extensionVersion: '0.3.0',
        connectedAt: 1,
        state: 'ready',
        protocol: 1
      }
    ]
    h.statuses.mockReturnValue(browsers)

    expect(service.chromeExtensionStatus()).toEqual({ listening: true, browsers, install: null })

    const result = await service.installChromeNativeHost()

    expect(h.installNativeHost).toHaveBeenCalledTimes(1)
    expect(h.installNativeHost).toHaveBeenCalledWith({
      platform: 'darwin',
      home: homedir(),
      electron: '/Applications/ShuviX.app/Contents/MacOS/ShuviX',
      cliJs: '/Applications/ShuviX.app/Contents/Resources/app.asar/out/main/cli.js'
    })
    expect(result).toBe(INSTALLED)
    expect(service.chromeExtensionStatus()).toEqual({
      listening: true,
      browsers,
      install: INSTALLED
    })
    expect(h.publish).toHaveBeenCalledWith({ type: 'chromeExtension.changed' })
  })

  it.each([
    ['win32', 'win32'],
    ['darwin', 'darwin'],
    ['linux', 'linux'],
    ['freebsd', 'linux']
  ])('HI-17 平台映射：process.platform=%s → %s', async (platform, expected) => {
    setPlatform(platform)
    const service = await load()
    await service.installChromeNativeHost()
    expect(h.installNativeHost.mock.calls[0][0].platform).toBe(expected)
  })

  it('HI-17 装失败（结果里有 failed）也照样记下、照样发 chromeExtension.changed；listening 取自桥服务', async () => {
    const failed = {
      launcher: '/x/native-host',
      installed: [],
      failed: [{ browser: '*', error: 'EACCES' }]
    }
    h.installNativeHost.mockResolvedValue(failed)
    h.listening = false
    const service = await load()

    await expect(service.installChromeNativeHost()).resolves.toBe(failed)
    expect(service.chromeExtensionStatus()).toEqual({
      listening: false,
      browsers: [],
      install: failed
    })
    expect(h.publish).toHaveBeenCalledWith({ type: 'chromeExtension.changed' })
  })

  it('HI-17 导入时订阅桥的连接变化：每次变化都发 chromeExtension.changed', async () => {
    await load()
    expect(h.changeListeners).toHaveLength(1)
    expect(h.publish).not.toHaveBeenCalled()

    h.changeListeners[0]()
    h.changeListeners[0]()
    expect(h.publish).toHaveBeenCalledTimes(2)
    expect(h.publish).toHaveBeenLastCalledWith({ type: 'chromeExtension.changed' })
  })
})
