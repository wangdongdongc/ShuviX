/**
 * browserViewService：tab 页面的渲染进程没了（崩溃 / 被杀）—— 告诉浏览器窗口（CR-U16）。
 *
 * 崩溃的 view 什么也不画，卡片不换的话就是一张空白卡片：`render-process-gone` 先熄灭 spinner
 * （崩溃不会有 did-stop-loading），再发一条 did-fail-load —— errorCode 0、errorDescription 是原因、
 * 带 `crashed: true`，卡片据此画「页面崩溃了」+ 重试。listTabs 的行带 `crashed`（读 webContents.isCrashed()）：
 * 浏览器窗口晚于崩溃才打开时，靠它把卡片画对。普通的主框架加载失败的 payload 没有 crashed 这个键。
 *
 * electron 换成 ./fakeElectron.ts（view 的 webContents.fire 手工触发事件、crashed 可拨）；宿主窗口是一个
 * 只有 send 间谍的假窗口（setHostWindow）；agentGuards 与 browserCdpService 是空壳。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeElectron } from './fakeElectron'

vi.mock('electron', async () => (await import('./fakeElectron')).fakeElectron().module)

// mock 路径按**测试文件**解析：被测模块在 services/browser/，测试在其 __tests__/ 下
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))
vi.mock('../../../dao/settingsDao', () => ({
  settingsDao: { findByKey: () => undefined, upsert: () => {} }
}))
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} })
}))
vi.mock('../../../i18n', () => ({ t: (key: string) => key }))
vi.mock('../../externalOpen', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../externalOpen')>()),
  guardAppWindow: () => {}
}))
vi.mock('../agentGuards', () => ({
  installAgentGuards: async () => {},
  uninstallAgentGuards: () => {},
  hasAgentGuards: () => false
}))
vi.mock('../browserCdpService', () => ({
  browserCdpManager: {
    session: async () => ({ enableDialogHandling: async () => {} }),
    handleExternalDetach: () => {},
    cdpState: () => ({ attached: false, intercepting: false }),
    detachAll: async () => {}
  }
}))

const fx = fakeElectron()

/** 浏览器窗口（宿主）：send 是间谍，其余够 applyLayout 用 */
function fakeHost(): {
  isDestroyed(): boolean
  webContents: { id: number; send: ReturnType<typeof vi.fn>; getZoomFactor(): number }
  contentView: { addChildView(): void; removeChildView(): void }
} {
  return {
    isDestroyed: () => false,
    webContents: {
      id: 999,
      send: vi.fn<(channel: string, payload: unknown) => void>(),
      getZoomFactor: () => 1
    },
    contentView: { addChildView() {}, removeChildView() {} }
  }
}

beforeEach(() => {
  vi.resetModules()
  fx.reset()
})

describe('tab 页面的渲染进程没了（CR-U16）', () => {
  it('CR-U16 render-process-gone → 先 did-stop-loading，再 did-fail-load{errorCode 0, 原因, 地址, crashed: true}；listTabs 的 crashed 跟着 isCrashed()', async () => {
    const svc = await import('../browserViewService')
    const host = fakeHost()
    svc.setHostWindow(host as never)
    const tabId = svc.createTab('https://x.test/')
    const wc = fx.views[0].webContents
    expect(svc.listTabs()[0].crashed).toBe(false)
    host.webContents.send.mockClear()

    wc.crashed = true
    wc.fire('render-process-gone', {}, { reason: 'oom', exitCode: -1 })
    expect(host.webContents.send.mock.calls).toStrictEqual([
      ['browser-view:did-stop-loading', { tabId }],
      [
        'browser-view:did-fail-load',
        {
          tabId,
          errorCode: 0,
          errorDescription: 'oom',
          url: 'https://x.test/',
          crashed: true
        }
      ]
    ])
    expect(svc.listTabs()[0]).toMatchObject({ id: tabId, crashed: true })

    // 页面被救回来
    wc.crashed = false
    expect(svc.listTabs()[0].crashed).toBe(false)
  })

  it('CR-U16 对照：普通的主框架加载失败（-105）的 payload 没有 crashed 这个键', async () => {
    const svc = await import('../browserViewService')
    const host = fakeHost()
    svc.setHostWindow(host as never)
    const tabId = svc.createTab('https://x.test/')
    const wc = fx.views[0].webContents
    host.webContents.send.mockClear()

    wc.fire('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://x.test/', true)
    const failed = host.webContents.send.mock.calls.filter(
      ([channel]) => channel === 'browser-view:did-fail-load'
    )
    expect(failed).toStrictEqual([
      [
        'browser-view:did-fail-load',
        {
          tabId,
          errorCode: -105,
          errorDescription: 'ERR_NAME_NOT_RESOLVED',
          url: 'https://x.test/'
        }
      ]
    ])
    expect(failed[0][1]).not.toHaveProperty('crashed')
  })
})
