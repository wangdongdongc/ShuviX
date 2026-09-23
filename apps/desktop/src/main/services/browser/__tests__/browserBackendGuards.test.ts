/**
 * 桌面浏览器后端（browserBackend）与「别打扰用户」防护（agentGuards）的接线 —— 动作这一侧。
 *
 *   NG-U9   可能打开原生文件框的动作 —— click / fill / type / pressKey / hover / scroll / evaluate / cdp /
 *           navigate —— 都跑在防护里：配方开始之前拦截已经打开；配方进行中页面打开的文件框被拦下，
 *           工具回报在原文后面换行接上一句固定的提示（单选 / 多选各一种写法），details 与 images 原样保留；
 *           没打开文件框时回报原样不动。只读的 snapshot / readPage / waitFor / screenshot / uploadFile /
 *           network / console / events 不碰拦截。
 *   NG-U11  openTab：先建一个加载 about:blank 的 tab → 接 CDP（防护随 attach 装上）→ 给文档打标记 →
 *           CDP Page.navigate → 按标记等加载；目标地址从不交给 loadURL。回报的映射：
 *           net::ERR_ABORTED（下载 / 被取消）= 开了但没有新页面（成功，不等加载）；其余 errorText =
 *           加载失败（带原因，不等加载）；等到 failed = 加载失败（不带原因）；stopped / timeout /
 *           interactive / complete = 成功并带各自的说明；load.url 为 null 时回显请求的地址；
 *           about:blank 本身不导航、不打标记，按 allowBlank 等。
 *
 * 后端、tab 服务、停放窗口、**防护**都是真的（electron 是 ./fakeElectron.ts：view 的 webContents 带假
 * debugger）；CDP 会话是个空壳（browserCdpService 换掉，所以防护由用例自己装到 tab 的 UUID 上 ——
 * 与 browserCdpService 的 attach 装的是同一个函数）；browserCdpOps 的配方换成桩：桩在「配方进行中」
 * 以 debugger 事件的形状报一次 Page.fileChooserOpened。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserOpOutput } from '@shuvix/agent-runtime'
import { fakeElectron, type FakeDebugger } from './fakeElectron'

vi.mock('electron', async () => (await import('./fakeElectron')).fakeElectron().module)

type Out = BrowserOpOutput

const state = vi.hoisted(() => {
  const s = {
    ws: '',
    /** 当前 tab 的假 debugger（配方桩往它上面报文件框） */
    dbg: null as unknown as {
      message(method: string, params?: Record<string, unknown>): void
      sendCommand: { mock: { calls: Array<[string, Record<string, unknown>?]> } }
    },
    /** 配方进行中要报的文件框（null = 不报） */
    chooser: null as null | 'selectSingle' | 'selectMultiple',
    /** 每个配方桩开始时看到的拦截开关序列 */
    interceptAtStart: [] as boolean[][],
    /** 被调用过的配方名，按顺序 */
    opsCalled: [] as string[],
    /** CDP 会话的 send（Page.navigate 的回包可编程） */
    send: vi.fn(
      async (_method: string, _params?: Record<string, unknown>): Promise<unknown> => ({})
    ),
    enableDialogHandling: vi.fn(async () => {}),
    session: vi.fn(async (_uuid: string): Promise<unknown> => null),
    mark: { token: 'm', url: 'about:blank', seq: 0, frameId: 'F' },
    markDocument: vi.fn(async (_session: unknown): Promise<unknown> => null),
    waitForLoad: vi.fn(
      async (
        _session: unknown,
        _opts?: Record<string, unknown>
      ): Promise<{ state: string; url: string | null }> => ({
        state: 'complete',
        url: 'https://a.example/'
      })
    )
  }
  s.session.mockImplementation(async () => ({
    enableDialogHandling: s.enableDialogHandling,
    send: s.send
  }))
  s.markDocument.mockImplementation(async () => s.mark)
  return s
})

/** 配方桩：进行中按需报一次文件框，回一份带 details / images 的结果 */
function opStub(name: string) {
  return async (): Promise<Out> => {
    state.opsCalled.push(name)
    state.interceptAtStart.push(
      state.dbg.sendCommand.mock.calls
        .filter(([m]) => m === 'Page.setInterceptFileChooserDialog')
        .map(([, p]) => Boolean((p as { enabled?: boolean }).enabled))
    )
    if (state.chooser) {
      state.dbg.message('Page.fileChooserOpened', {
        frameId: 'F',
        mode: state.chooser,
        backendNodeId: 9
      })
    }
    return {
      text: `${name} done`,
      details: { op: name },
      images: [{ data: 'AAAA', mimeType: 'image/png' }]
    }
  }
}

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
    session: (uuid: string) => state.session(uuid),
    handleExternalDetach: vi.fn(),
    cdpState: () => ({ attached: false, intercepting: false }),
    detachAll: vi.fn(async () => {})
  }
}))
vi.mock('@shuvix/agent-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shuvix/agent-runtime')>()
  const ops = Object.fromEntries(
    [
      'clickOp',
      'fillOp',
      'typeOp',
      'pressKeyOp',
      'hoverOp',
      'scrollOp',
      'evaluateOp',
      'cdpOp',
      'navigateOp',
      'snapshotOp',
      'readPageOp',
      'waitForOp',
      'uploadFileOp',
      'networkOp',
      'consoleOp',
      'eventsOp'
    ].map((name) => [name, opStub(name)])
  )
  return {
    ...actual,
    browserCdpOps: {
      ...actual.browserCdpOps,
      ...ops,
      markDocument: (session: unknown) => state.markDocument(session),
      waitForLoad: (session: unknown, opts?: Record<string, unknown>) =>
        state.waitForLoad(session, opts)
    }
  }
})
vi.mock('../../../frontend/core', () => ({ chatFrontendRegistry: { broadcast: vi.fn() } }))
vi.mock('../../toolContext', () => ({
  resolveProjectConfig: () => ({ workingDirectory: state.ws })
}))
vi.mock('../../../utils/paths', () => ({ getToolResultsDir: () => join(state.ws, '.results') }))

import { browserCdpOps } from '@shuvix/agent-runtime'

const fx = fakeElectron()

type Backend = ReturnType<typeof import('../browserBackend').createDesktopBrowserBackend>

const INTERCEPT = 'Page.setInterceptFileChooserDialog'
const NOTE_ONE =
  "Note: this opened the page's file chooser (one file). ShuviX suppressed the native file dialog so it cannot pop up on the user’s screen. To attach files, call upload_file on the file input (take a snapshot to find its uid)."
const NOTE_MANY =
  "Note: this opened the page's file chooser (multiple files). ShuviX suppressed the native file dialog so it cannot pop up on the user’s screen. To attach files, call upload_file on the file input (take a snapshot to find its uid)."

beforeAll(() => {
  state.ws = mkdtempSync(join(tmpdir(), 'shuvix-guard-ws-'))
})

afterAll(() => {
  if (state.ws) rmSync(state.ws, { recursive: true, force: true })
})

beforeEach(() => {
  vi.resetModules()
  fx.reset()
  state.chooser = null
  state.interceptAtStart.length = 0
  state.opsCalled.length = 0
  for (const fn of [
    state.send,
    state.enableDialogHandling,
    state.session,
    state.markDocument,
    state.waitForLoad
  ]) {
    fn.mockClear()
  }
  state.send.mockImplementation(async () => ({}))
  state.waitForLoad.mockImplementation(async () => ({
    state: 'complete',
    url: 'https://a.example/'
  }))
})

/** 一个 tab 已在 agent 手里（防护装在它的 UUID 上），短号 t1 */
async function guardedTab(): Promise<{ backend: Backend; dbg: FakeDebugger; uuid: string }> {
  const views = await import('../browserViewService')
  const guards = await import('../agentGuards')
  const { createDesktopBrowserBackend } = await import('../browserBackend')
  const uuid = views.createTab('https://a.example/')
  const dbg = fx.views[0].webContents.debugger
  state.dbg = dbg as never
  await guards.installAgentGuards(uuid, fx.views[0].webContents as never)
  const backend = createDesktopBrowserBackend('s1')
  // 列一次 tab：懒分配短号，t1 就是它
  expect((await backend.listTabs()).text).toContain('[t1]')
  return { backend, dbg, uuid }
}

const intercepts = (dbg: FakeDebugger): boolean[] =>
  dbg.sendCommand.mock.calls
    .filter(([m]) => m === INTERCEPT)
    .map(([, p]) => Boolean((p as { enabled?: boolean }).enabled))

const GUARDED: Array<[string, string, (b: Backend) => Promise<Out>]> = [
  ['click', 'clickOp', (b) => b.click({ tabId: 't1', uid: 'e1' })],
  ['fill', 'fillOp', (b) => b.fill({ tabId: 't1', uid: 'e1', text: 'x' })],
  ['type', 'typeOp', (b) => b.type({ tabId: 't1', text: 'x', submitKey: 'Enter' })],
  ['pressKey', 'pressKeyOp', (b) => b.pressKey({ tabId: 't1', key: 'Enter' })],
  ['hover', 'hoverOp', (b) => b.hover({ tabId: 't1', uid: 'e1' })],
  ['scroll', 'scrollOp', (b) => b.scroll({ tabId: 't1', direction: 'down' })],
  ['evaluate', 'evaluateOp', (b) => b.evaluate!({ tabId: 't1', expression: 'f.click()' })],
  [
    'cdp',
    'cdpOp',
    (b) => b.cdp!({ tabId: 't1', method: 'Runtime.evaluate', params: { expression: 'f.click()' } })
  ],
  ['navigate', 'navigateOp', (b) => b.navigate({ tabId: 't1', nav: 'reload' })]
]

describe('可能打开文件框的动作都跑在防护里（NG-U9）', () => {
  it.each(GUARDED)(
    'NG-U9 %s：配方开始前拦截已打开；进行中打开的单选文件框 → 回报原文后换行接「one file」提示，details / images 原样',
    async (_label, opName, call) => {
      const { backend, dbg } = await guardedTab()
      state.chooser = 'selectSingle'
      const out = await call(backend)
      expect(state.opsCalled).toEqual([opName])
      expect(state.interceptAtStart).toEqual([[true]])
      expect(out.text).toBe(`${opName} done\n${NOTE_ONE}`)
      expect(out.details).toEqual({ op: opName })
      expect(out.images).toEqual([{ data: 'AAAA', mimeType: 'image/png' }])
      expect(intercepts(dbg)).toEqual([true])
      expect(fx.dialog.showOpenDialog).not.toHaveBeenCalled()
    }
  )

  it.each(GUARDED)(
    'NG-U9 %s：多选文件框 → 「multiple files」提示',
    async (_label, opName, call) => {
      const { backend } = await guardedTab()
      state.chooser = 'selectMultiple'
      const out = await call(backend)
      expect(out.text).toBe(`${opName} done\n${NOTE_MANY}`)
    }
  )

  it.each(GUARDED)(
    'NG-U9 %s：没打开文件框 → 回报原样（仍然打开过拦截）',
    async (_label, opName, call) => {
      const { backend, dbg } = await guardedTab()
      const out = await call(backend)
      expect(out).toEqual({
        text: `${opName} done`,
        details: { op: opName },
        images: [{ data: 'AAAA', mimeType: 'image/png' }]
      })
      expect(intercepts(dbg)).toEqual([true])
    }
  )

  it('NG-U9 提示的两种写法恰好就是 fileChooserNote 的输出（单选 / 多选，混着有多选算多选）', async () => {
    const { fileChooserNote } = await import('../agentGuards')
    expect(fileChooserNote([{ mode: 'selectSingle' }])).toBe(NOTE_ONE)
    expect(fileChooserNote([{ mode: 'selectMultiple' }])).toBe(NOTE_MANY)
    expect(fileChooserNote([{ mode: 'selectSingle' }, { mode: 'selectMultiple' }])).toBe(NOTE_MANY)
  })

  it.each([
    ['snapshot', (b: Backend) => b.snapshot({ tabId: 't1' })],
    ['readPage', (b: Backend) => b.readPage({ tabId: 't1' })],
    ['waitFor', (b: Backend) => b.waitFor({ tabId: 't1', text: 'hello' })],
    ['screenshot', (b: Backend) => b.screenshot({ tabId: 't1' })],
    [
      'uploadFile',
      (b: Backend) => b.uploadFile!({ tabId: 't1', uid: 'e1', paths: ['/tmp/a.txt'] })
    ],
    ['network', (b: Backend) => b.network!({ tabId: 't1' })],
    ['console', (b: Backend) => b.console!({ tabId: 't1' })],
    ['events', (b: Backend) => b.events!({ tabId: 't1' })]
  ])('NG-U9 %s 不碰文件框拦截，回报原样', async (_label, call) => {
    const { backend, dbg } = await guardedTab()
    const out = await call(backend)
    expect(intercepts(dbg)).toEqual([])
    expect(out.text).not.toContain('Note: this opened')
  })
})

describe('openTab：先空白、接上 CDP，再导航过去（NG-U11）', () => {
  async function fresh(): Promise<Backend> {
    const { createDesktopBrowserBackend } = await import('../browserBackend')
    return createDesktopBrowserBackend('s1')
  }

  const URL = 'https://target.example/page'

  it('NG-U11 顺序：createTab(about:blank) → session → markDocument → Page.navigate{url} → waitForLoad({mark})；地址从不交给 loadURL', async () => {
    const backend = await fresh()
    const out = await backend.openTab({ url: URL })
    expect(out.text).toBe(
      'Opened https://a.example/ in new tab t1. Use snapshot/read_page with this tab id.'
    )
    expect(out.details).toEqual({ url: 'https://a.example/' })

    const wc = fx.views[0].webContents
    expect(wc.loaded).toEqual(['about:blank'])
    const navAt = state.send.mock.calls.findIndex(([m]) => m === 'Page.navigate')
    expect(state.send.mock.calls[navAt]).toEqual(['Page.navigate', { url: URL }])
    expect(state.session).toHaveBeenCalledTimes(1)
    const seq = [
      wc.loadURL.mock.invocationCallOrder[0],
      state.session.mock.invocationCallOrder[0],
      state.markDocument.mock.invocationCallOrder[0],
      state.send.mock.invocationCallOrder[navAt],
      state.waitForLoad.mock.invocationCallOrder[0]
    ]
    expect(seq.every((n) => typeof n === 'number')).toBe(true)
    expect([...seq].sort((a, b) => a - b)).toEqual(seq)
    expect(state.waitForLoad.mock.calls[0][1]).toEqual({ mark: state.mark })
    expect(state.enableDialogHandling).toHaveBeenCalled()
  })

  it('NG-U11 about:blank：不打标记、不导航，按 allowBlank 等', async () => {
    const backend = await fresh()
    state.waitForLoad.mockResolvedValueOnce({ state: 'complete', url: 'about:blank' })
    const out = await backend.openTab({ url: 'about:blank' })
    expect(out.text).toBe(
      'Opened about:blank in new tab t1. Use snapshot/read_page with this tab id.'
    )
    expect(state.markDocument).not.toHaveBeenCalled()
    expect(state.send.mock.calls.map(([m]) => m)).not.toContain('Page.navigate')
    expect(state.waitForLoad.mock.calls[0][1]).toEqual({ allowBlank: true })
    expect(fx.views[0].webContents.loaded).toEqual(['about:blank'])
  })

  it('NG-U11 Page.navigate 回 net::ERR_ABORTED（下载 / 被取消）：成功，报「没有新页面」，不等加载', async () => {
    const backend = await fresh()
    state.send.mockImplementation(async (method) =>
      method === 'Page.navigate' ? { frameId: 'F', errorText: 'net::ERR_ABORTED' } : {}
    )
    const out = await backend.openTab({ url: URL })
    expect(out.text).toBe(
      `Opened ${URL} in new tab t1 (no new page was loaded — the request may have been a download or was cancelled). Use snapshot/read_page with this tab id.`
    )
    expect(out.details).toEqual({ url: URL })
    expect(out.details?.error).toBeUndefined()
    expect(state.waitForLoad).not.toHaveBeenCalled()
  })

  it('NG-U11 Page.navigate 回别的 errorText：失败，带原因，不等加载', async () => {
    const backend = await fresh()
    state.send.mockImplementation(async (method) =>
      method === 'Page.navigate' ? { frameId: 'F', errorText: 'net::ERR_NAME_NOT_RESOLVED' } : {}
    )
    const out = await backend.openTab({ url: URL })
    const error = `${URL} failed to load (net::ERR_NAME_NOT_RESOLVED) — tab t1 shows the browser's error page.`
    expect(out.text).toBe(`Error: ${error}`)
    expect(out.details).toEqual({ url: URL, error })
    expect(state.waitForLoad).not.toHaveBeenCalled()
  })

  it('NG-U11 等到 failed：失败，不带原因', async () => {
    const backend = await fresh()
    state.waitForLoad.mockResolvedValueOnce({
      state: 'failed',
      url: 'chrome-error://chromewebdata/'
    })
    const out = await backend.openTab({ url: URL })
    const error = `${URL} failed to load — tab t1 shows the browser's error page.`
    expect(out.text).toBe(`Error: ${error}`)
    expect(out.details).toEqual({ url: URL, error })
  })

  it.each(['stopped', 'timeout', 'interactive', 'complete'] as const)(
    'NG-U11 等到 %s：成功，带那个状态的说明；load.url 有值就回它',
    async (loadState) => {
      const backend = await fresh()
      state.waitForLoad.mockResolvedValueOnce({ state: loadState, url: 'https://final.example/' })
      const out = await backend.openTab({ url: URL })
      expect(out.text).toBe(
        `Opened https://final.example/ in new tab t1${browserCdpOps.loadNote(loadState)}. Use snapshot/read_page with this tab id.`
      )
      expect(out.details).toEqual({ url: 'https://final.example/' })
    }
  )

  it('NG-U11 load.url 为 null：回显请求的地址', async () => {
    const backend = await fresh()
    state.waitForLoad.mockResolvedValueOnce({ state: 'timeout', url: null })
    const out = await backend.openTab({ url: URL })
    expect(out.text).toBe(
      `Opened ${URL} in new tab t1${browserCdpOps.loadNote('timeout')}. Use snapshot/read_page with this tab id.`
    )
    expect(out.details).toEqual({ url: URL })
  })
})
