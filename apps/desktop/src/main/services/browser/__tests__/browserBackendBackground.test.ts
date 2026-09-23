/**
 * 桌面浏览器后端在后台干活 —— agent 的任何浏览器动作都**不**把浏览器窗口弄出来。
 *
 *   ST-U10  浏览器窗口处于 (a) 从没建过 (b) 可见但没焦点 (c) 被关（隐藏）(d) 最小化且报告不可见
 *           时，openTab / listTabs / snapshot / click / type / fill / pressKey / scroll / evaluate /
 *           screenshot / navigate(reload) / closeTab 一整串做完：浏览器窗口数不变，没有哪个窗口被
 *           show / showInactive / focus / restore / moveTop，没有 app.focus，没有弹框；截图照常落盘；
 *           browser_event 只广播 open 一次、close 一次（web 平台的会话镜像靠它）。
 *   NG-U14  同一串动作里 openTab 先建一个**真的加载了** about:blank 的 tab、接上 CDP，再经 CDP 的
 *           Page.navigate 导航过去（地址从不交给 loadURL），按导航前的文档标记等加载；全程没有原生
 *           文件框（dialog.showOpenDialog）也没有原生打印（webContents.print）。
 *
 * 后端、tab 服务、窗口服务、停放窗口都是真的，跑在 ./fakeElectron.ts 的假件上；CDP 会话是个空壳，
 * `browserCdpOps` 里用到的配方换成立即回答的桩 —— 这里只关心「窗口动没动」，不关心配方本身。
 * 截图真的落盘，落在临时目录里（capturePage 回假 PNG 字节）。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FAKE_PNG, fakeElectron, type FakeWindow } from './fakeElectron'

vi.mock('electron', async () => (await import('./fakeElectron')).fakeElectron().module)

const state = vi.hoisted(() => ({
  /** 会话工作目录 / 截图落盘目录（真的临时目录） */
  ws: '',
  broadcast: vi.fn<(event: Record<string, unknown>) => void>(),
  /** 假 CDP 会话的 send：Page.navigate 回 {}（没有 errorText = 导航已提交） */
  send: vi.fn(async (_method: string, _params?: Record<string, unknown>) => ({})),
  /** markDocument 桩回的文档标记 */
  mark: { token: 'mark-1', url: 'about:blank', seq: 0, frameId: 'F' },
  waitForLoad: vi.fn(async (_session: unknown, _opts?: Record<string, unknown>) => ({
    state: 'complete',
    url: 'https://a.example/'
  }))
}))

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
vi.mock('../browserCdpService', () => ({
  browserCdpManager: {
    session: vi.fn(async () => ({
      enableDialogHandling: async () => {},
      send: (method: string, params?: Record<string, unknown>) => state.send(method, params)
    })),
    handleExternalDetach: vi.fn(),
    cdpState: () => ({ attached: false, intercepting: false }),
    detachAll: vi.fn(async () => {})
  }
}))
vi.mock('@shuvix/agent-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shuvix/agent-runtime')>()
  const ok = async (): Promise<{ text: string }> => ({ text: 'ok' })
  return {
    ...actual,
    browserCdpOps: {
      ...actual.browserCdpOps,
      markDocument: async () => state.mark,
      waitForLoad: (session: unknown, opts?: Record<string, unknown>) =>
        state.waitForLoad(session, opts),
      loadNote: () => '',
      snapshotOp: ok,
      clickOp: ok,
      typeOp: ok,
      fillOp: ok,
      pressKeyOp: ok,
      scrollOp: ok,
      evaluateOp: ok,
      navigateOp: ok
    }
  }
})
vi.mock('../../../frontend/core', () => ({
  chatFrontendRegistry: { broadcast: (event: Record<string, unknown>) => state.broadcast(event) }
}))
vi.mock('../../toolContext', () => ({
  resolveProjectConfig: () => ({ workingDirectory: state.ws })
}))
vi.mock('../../../utils/paths', () => ({ getToolResultsDir: () => join(state.ws, '.results') }))

const fx = fakeElectron()

beforeAll(() => {
  state.ws = mkdtempSync(join(tmpdir(), 'shuvix-bg-ws-'))
})

afterAll(() => {
  if (state.ws) rmSync(state.ws, { recursive: true, force: true })
})

beforeEach(() => {
  vi.resetModules()
  fx.reset()
  state.broadcast.mockClear()
  state.send.mockClear()
  state.waitForLoad.mockClear()
})

afterEach(() => {
  expect(fx.hiddenViews(), 'a tab view was setVisible(false)').toEqual([])
  expect(fx.doubleParented, 'a tab view hung on two windows at once').toEqual([])
})

const WINDOW_STATES = [
  ['a', 'never created'],
  ['b', 'visible, not focused'],
  ['c', 'hidden via close'],
  ['d', 'minimized, reporting visible:false']
] as const

describe('DesktopBrowserBackend：agent 的动作从不把浏览器窗口弄出来（ST-U10）', () => {
  it.each(WINDOW_STATES)(
    'ST-U10 (%s) 浏览器窗口 %s：openTab → … → closeTab 一整串，窗口数不变、谁都没被弄到眼前、不弹框；截图落盘；open / close 各广播一次',
    async (id) => {
      const wins = await import('../browserWindowService')
      const { createDesktopBrowserBackend } = await import('../browserBackend')
      wins.initBrowserWindowService({ getThemeBgColor: () => '#000000' })

      // 用户自己把浏览器窗口摆成这个状态
      let bw: FakeWindow | undefined
      if (id !== 'a') {
        wins.openBrowserWindow()
        bw = fx.browserWindows()[0]
        if (id === 'b') bw.focused = false
        if (id === 'c') bw.emit('close', { preventDefault: () => {} })
        if (id === 'd') {
          bw.minimized = true
          bw.visible = false
          bw.focused = false
        }
      }
      fx.clearCalls()
      const browserWindowsBefore = fx.browserWindows().length

      const backend = createDesktopBrowserBackend('s1')
      const opened = await backend.openTab({ url: 'https://a.example/' })
      expect(opened.text).toMatch(/^Opened https:\/\/a\.example\/ in new tab t\d+/)
      const tabId = /in new tab (t\d+)/.exec(opened.text ?? '')?.[1] ?? ''
      expect(tabId).not.toBe('')

      expect((await backend.listTabs()).text).toContain(`[${tabId}] (active)`)
      await backend.snapshot({ tabId })
      await backend.click({ tabId, uid: 'e1' })
      await backend.type({ tabId, text: 'typed' })
      await backend.fill({ tabId, uid: 'e1', text: 'filled' })
      await backend.pressKey({ tabId, key: 'Enter' })
      await backend.scroll({ tabId, direction: 'down' })
      await backend.evaluate!({ tabId, expression: '1 + 1' })
      const shot = await backend.screenshot({ tabId })
      expect(shot.text).toContain('Screenshot (viewport) saved to ')
      const png = /saved to (\S+\.png)/.exec(shot.text ?? '')?.[1] ?? ''
      expect(png.startsWith(join(state.ws, '.results'))).toBe(true)
      expect(existsSync(png)).toBe(true)
      expect(readFileSync(png)).toEqual(FAKE_PNG)
      await backend.navigate({ tabId, nav: 'reload' })
      const closed = await backend.closeTab({ tabId })
      expect(closed.text).toBe(`Closed tab ${tabId}.`)

      expect(fx.browserWindows()).toHaveLength(browserWindowsBefore)
      expect(fx.allSurfacing()).toEqual([])
      expect(fx.dialog.showMessageBox).not.toHaveBeenCalled()
      // tab 在停放窗口里出生、在那里被操作、在那里关掉
      expect(fx.staging()?.visible).toBe(false)
      expect(fx.views).toHaveLength(1)
      expect(fx.views[0].webContents.close).toHaveBeenCalledTimes(1)
      expect(fx.views[0].webContents.capturePage).toHaveBeenCalledTimes(1)
      // NG-U14 openTab：tab 先真的加载 about:blank（地址从不交给 loadURL），经 CDP 导航过去，
      // 按导航前的文档标记等加载；没有原生文件框、没有原生打印
      expect(fx.views[0].webContents.loaded).toEqual(['about:blank'])
      expect(state.send.mock.calls.filter(([m]) => m === 'Page.navigate')).toEqual([
        ['Page.navigate', { url: 'https://a.example/' }]
      ])
      expect(state.waitForLoad).toHaveBeenCalledTimes(1)
      expect(state.waitForLoad.mock.calls[0][1]).toEqual({ mark: state.mark })
      expect(fx.dialog.showOpenDialog).not.toHaveBeenCalled()
      expect(fx.views[0].webContents.print).not.toHaveBeenCalled()
      if (bw) expect(bw.children).toEqual([])
      if (id === 'c') expect(wins.isBrowserWindowOpen()).toBe(false)
      if (id === 'd') expect(bw?.minimized).toBe(true)

      expect(state.broadcast.mock.calls.map(([e]) => e)).toEqual([
        { type: 'browser_event', sessionId: 's1', action: 'open' },
        { type: 'browser_event', sessionId: 's1', action: 'close' }
      ])
    },
    30_000
  )
})
