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
 *   DT-3    openTab 等加载时会话结束了（页面一加载就关掉自己的 tab / 调试连接断了，waitForLoad 回 gone）：
 *           回「开了」+ 那个会话结束原因的那句（真的 tabGoneNote），不是失败，也不叫 agent 去 snapshot。
 *   CR-U15a 页面的渲染进程崩了的 tab：screenshot（视口 / 整页 / 元素）当场以那句话失败 —— 不 capturePage
 *           （崩溃页只会拍出一张空图）、不为截图接 CDP、不落盘；list_tabs 在 (active) 之后标 (crashed)。
 *
 * 后端、tab 服务、窗口服务、停放窗口都是真的，跑在 ./fakeElectron.ts 的假件上；CDP 会话是个空壳，
 * `browserCdpOps` 里用到的配方换成立即回答的桩 —— 这里只关心「窗口动没动」，不关心配方本身。
 * 截图真的落盘，落在临时目录里（capturePage 回假 PNG 字节）。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PAGE_CRASHED_MESSAGE } from '@shuvix/agent-runtime'
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
  waitForLoad: vi.fn(
    async (
      _session: unknown,
      _opts?: Record<string, unknown>
    ): Promise<{ state: string; url: string | null }> => ({
      state: 'complete',
      url: 'https://a.example/'
    })
  ),
  /** 假 CDP 会话的 ended（会话结束的原因；真的 tabGoneNote 读它） */
  ended: null as 'tab-closed' | 'detached' | null
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
      send: (method: string, params?: Record<string, unknown>) => state.send(method, params),
      get ended() {
        return state.ended
      }
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
  state.ended = null
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

describe('openTab：等加载时 tab 没了（DT-3）', () => {
  it.each([
    ['tab-closed', 'This tab closed and is gone — use list_tabs to see the open tabs.'],
    [
      'detached',
      'The browser detached from this tab, so what happened on the page could not be seen — take a new snapshot before further interaction.'
    ]
  ] as const)(
    'DT-3 会话以 %s 结束（登录回调页一加载就关掉自己）→ 回「开了」+ 那句，不算失败，也不叫 agent 去 snapshot',
    async (reason, note) => {
      const wins = await import('../browserWindowService')
      const { createDesktopBrowserBackend } = await import('../browserBackend')
      wins.initBrowserWindowService({ getThemeBgColor: () => '#000000' })
      state.ended = reason
      state.waitForLoad.mockResolvedValueOnce({ state: 'gone', url: null })

      const url = 'https://a.example/cb'
      const out = await createDesktopBrowserBackend('s1').openTab({ url })
      const m = /^Opened https:\/\/a\.example\/cb in new tab t\d+\. (.*)$/.exec(out.text ?? '')
      expect(m, out.text).not.toBeNull()
      expect(m?.[1]).toBe(note)
      expect(out.text).not.toContain('Use snapshot/read_page')
      expect(out.details).toEqual({ url })
      expect(out.details).not.toHaveProperty('error')
      expect(state.waitForLoad).toHaveBeenCalledTimes(1)
    }
  )
})

describe('页面崩了的 tab（CR-U15a）', () => {
  /** 截图落盘目录此刻的文件（没有目录 = 空） */
  const resultsFiles = (): string[] => {
    const dir = join(state.ws, '.results')
    return existsSync(dir) ? readdirSync(dir).sort() : []
  }

  it.each([
    ['视口', {}],
    ['整页', { fullPage: true }],
    ['元素', { uid: 'e1' }]
  ])(
    'CR-U15a screenshot（%s）→ 以那句话失败；不 capturePage、不为截图接 CDP、不落盘',
    async (_label, shot) => {
      const views = await import('../browserViewService')
      const { browserCdpManager } = await import('../browserCdpService')
      const { createDesktopBrowserBackend } = await import('../browserBackend')
      views.createTab('https://a.example/', { activate: true })
      const wc = fx.views[0].webContents
      wc.crashed = true
      const backend = createDesktopBrowserBackend('s1')
      expect((await backend.listTabs()).text).toContain('[t1]')
      const filesBefore = resultsFiles()
      vi.mocked(browserCdpManager.session).mockClear()

      await expect(backend.screenshot({ tabId: 't1', ...shot })).rejects.toThrow(
        PAGE_CRASHED_MESSAGE
      )
      expect(wc.capturePage).not.toHaveBeenCalled()
      expect(browserCdpManager.session).not.toHaveBeenCalled()
      expect(resultsFiles()).toEqual(filesBefore)
    }
  )

  it('CR-U15a list_tabs：崩了的 tab 在 (active) 之后标 (crashed)，没崩的不标', async () => {
    const views = await import('../browserViewService')
    const { createDesktopBrowserBackend } = await import('../browserBackend')
    views.createTab('https://a.test/')
    views.createTab('https://b.test/')
    views.createTab('https://c.test/', { activate: true })
    fx.views[1].webContents.crashed = true
    fx.views[2].webContents.crashed = true

    const lines = (await createDesktopBrowserBackend('s1').listTabs()).text?.split('\n')
    expect(lines).toEqual([
      '[t1] (untitled) — https://a.test/',
      '[t2] (crashed) (untitled) — https://b.test/',
      '[t3] (active) (crashed) (untitled) — https://c.test/'
    ])

    // 页面被救回来：标记跟着没了
    fx.views[2].webContents.crashed = false
    expect((await createDesktopBrowserBackend('s1').listTabs()).text?.split('\n')[2]).toBe(
      '[t3] (active) (untitled) — https://c.test/'
    )
  })
})
