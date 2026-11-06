/**
 * readPageRenderer —— read 工具的隐藏页面：从不显示的窗口、同一个内存 session、最多同时两个。
 *
 * electron 换成自己的小假货：窗口记下构造选项和 show / focus 一类的间谍，webContents 的每一步进一份调用日志（断先后用），
 * 页面的行为由 `fx` 按用例改。模块级状态（排队、session 配没配过）每条用例重新导入。计时器是假的。
 * 「抽出来的 HTML 里没有脚本」要真的跑那段代码，放进 jsdom 里跑。
 *
 *   RP-W*  窗口与 session：选项、没有 preload、从不显示 / 聚焦、offscreen 只看 rendersOffscreen、session 只配一次
 *   RP-F*  围栏：弹窗、非 http(s) 导航、静音、弹框脚本先于页面、载入顺序
 *   RP-T*  什么时候算好：够多的字 1s、很少的字 5s、还在载入不算、预算 15s、问不到只算还没好
 *   RP-R*  结果：HTML 去掉脚本等；载入失败 / 地址不是网页 / 太大 / 问不到 → null
 *   RP-D*  窗口在所有路径上都销毁
 *   RP-Q*  并发：最多两个、排队先来先走、排队时中止不开窗、失败也让位
 *   RP-A*  中止：窗口立刻没、结果是 null
 */
import { EventEmitter } from 'node:events'
import { JSDOM } from 'jsdom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface FakeWebContents extends EventEmitter {
  url: string
  loading: boolean
  destroyed: boolean
  openHandler?: (details: { url: string }) => { action: string }
  setAudioMuted: ReturnType<typeof vi.fn>
  setWindowOpenHandler: (handler: (details: { url: string }) => { action: string }) => void
  loadURL: (url: string) => Promise<void>
  executeJavaScript: (code: string) => Promise<unknown>
  getURL: () => string
  isLoadingMainFrame: () => boolean
  isDestroyed: () => boolean
  debugger: {
    attach: (version: string) => void
    sendCommand: (method: string, params?: unknown) => Promise<unknown>
  }
}

interface FakeWindow {
  options: Record<string, unknown>
  webContents: FakeWebContents
  destroyedFlag: boolean
  isDestroyed: () => boolean
  destroy: ReturnType<typeof vi.fn>
  show: ReturnType<typeof vi.fn>
  showInactive: ReturnType<typeof vi.fn>
  focus: ReturnType<typeof vi.fn>
}

const fx = vi.hoisted(() => ({
  windows: [] as unknown[],
  /** webContents 的每一步，按发生顺序 */
  log: [] as string[],
  offscreen: false,
  sessions: [] as string[],
  fakeSession: {
    setUserAgent: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    on: vi.fn()
  },
  /** 按用例改的行为 */
  hooks: {} as {
    textLength?: (wc: unknown) => number | undefined | Promise<number | undefined>
    html?: (wc: unknown) => unknown
    loadURL?: (url: string, wc: unknown) => Promise<void> | void
    attach?: () => void
  },
  makeWindow: null as unknown as (options: Record<string, unknown>) => unknown
}))

vi.mock('electron', () => ({
  app: { getLocale: () => 'ja' },
  session: {
    fromPartition: (partition: string) => {
      fx.sessions.push(partition)
      return fx.fakeSession
    }
  },
  BrowserWindow: class {
    constructor(options: Record<string, unknown>) {
      return fx.makeWindow(options) as object
    }
  }
}))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('../../utils/headless', () => ({
  rendersOffscreen: () => fx.offscreen
}))

const TARGET = 'https://example.test/page'
const LONG = 1000
const THIN = 10
const HTML = '<html><body><p>content</p></body></html>'

const isExtract = (code: string): boolean => code.includes('cloneNode')

function makeWebContents(): FakeWebContents {
  const wc = new EventEmitter() as FakeWebContents
  Object.assign(wc, {
    url: '',
    loading: false,
    destroyed: false,
    setAudioMuted: vi.fn(() => fx.log.push('setAudioMuted')),
    setWindowOpenHandler(handler: FakeWebContents['openHandler']) {
      wc.openHandler = handler
    },
    async loadURL(url: string) {
      fx.log.push(`loadURL ${url}`)
      wc.url = url
      await fx.hooks.loadURL?.(url, wc)
    },
    executeJavaScript: async (code: string): Promise<unknown> => {
      if (isExtract(code)) return (fx.hooks.html ?? (() => HTML))(wc)
      return (fx.hooks.textLength ?? (() => LONG))(wc)
    },
    getURL: () => wc.url,
    isLoadingMainFrame: () => wc.loading,
    isDestroyed: () => wc.destroyed,
    debugger: {
      attach(version: string) {
        fx.log.push(`attach ${version}`)
        fx.hooks.attach?.()
      },
      sendCommand: async (method: string) => {
        fx.log.push(method)
        return {}
      }
    }
  })
  return wc
}

function makeWindow(options: Record<string, unknown>): FakeWindow {
  fx.log.push('new window')
  const webContents = makeWebContents()
  const win: FakeWindow = {
    options,
    webContents,
    destroyedFlag: false,
    isDestroyed: () => win.destroyedFlag,
    destroy: vi.fn(() => {
      win.destroyedFlag = true
      webContents.destroyed = true
      fx.log.push('destroy')
    }),
    show: vi.fn(),
    showInactive: vi.fn(),
    focus: vi.fn()
  }
  fx.windows.push(win)
  return win
}

const windows = (): FakeWindow[] => fx.windows as FakeWindow[]

const load = async (): Promise<typeof import('../readPageRenderer')> => {
  vi.resetModules()
  return import('../readPageRenderer')
}

/** 一直变的字数：永远等不到「停止变化」 */
function everChanging(): () => number {
  let n = 0
  return () => (n += 1)
}

/** 记下 promise 落定没有（假计时器下不能 await 一个还没到点的 promise） */
function track<T>(p: Promise<T>): { settled: () => boolean; result: () => T | undefined } {
  let done = false
  let value: T | undefined
  p.then(
    (v) => {
      done = true
      value = v
    },
    () => {
      done = true
    }
  )
  return { settled: () => done, result: () => value }
}

/** 把页面跑到落定（足够长的假时间） */
async function finish<T>(p: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(60_000)
  return p
}

const originalChrome = Object.getOwnPropertyDescriptor(process.versions, 'chrome')

beforeEach(() => {
  vi.useFakeTimers()
  fx.windows.length = 0
  fx.log.length = 0
  fx.sessions.length = 0
  fx.offscreen = false
  fx.hooks = {}
  fx.makeWindow = makeWindow
  for (const spy of Object.values(fx.fakeSession)) spy.mockClear()
  Object.defineProperty(process.versions, 'chrome', {
    value: '142.0.7444.59',
    configurable: true
  })
})

afterEach(() => {
  vi.useRealTimers()
  if (originalChrome) Object.defineProperty(process.versions, 'chrome', originalChrome)
  else Reflect.deleteProperty(process.versions, 'chrome')
})

describe('窗口与 session', () => {
  it('RP-W1 窗口选项：从不显示、不可聚焦、不进任务栏、没有 preload、渲染进程在沙箱里', async () => {
    const { renderPage } = await load()
    await finish(renderPage(TARGET))
    const options = windows()[0].options
    expect(options).toMatchObject({
      show: false,
      focusable: false,
      skipTaskbar: true,
      frame: false,
      paintWhenInitiallyHidden: true
    })
    const web = options.webPreferences as Record<string, unknown>
    expect(web).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      disableDialogs: true,
      backgroundThrottling: false,
      session: fx.fakeSession
    })
    expect(web).not.toHaveProperty('preload')
    expect(web).not.toHaveProperty('offscreen')
  })

  it('RP-W2 窗口用的是 shuvix-read-url 分区', async () => {
    const { renderPage } = await load()
    await finish(renderPage(TARGET))
    expect(new Set(fx.sessions)).toEqual(new Set(['shuvix-read-url']))
  })

  it('RP-W3 从不显示、从不聚焦', async () => {
    const { renderPage } = await load()
    await finish(renderPage(TARGET))
    const win = windows()[0]
    expect(win.show).not.toHaveBeenCalled()
    expect(win.showInactive).not.toHaveBeenCalled()
    expect(win.focus).not.toHaveBeenCalled()
  })

  it('RP-W4 无头 Linux 才多一项 offscreen', async () => {
    fx.offscreen = true
    const { renderPage } = await load()
    await finish(renderPage(TARGET))
    expect(windows()[0].options.webPreferences).toMatchObject({ offscreen: true })
  })

  it('RP-W5 session 只配一次：UA、语言、权限全拒、下载全拦', async () => {
    const { readUrlSession } = await load()
    expect(readUrlSession()).toBe(fx.fakeSession)
    readUrlSession()
    expect(fx.fakeSession.setUserAgent).toHaveBeenCalledTimes(1)
    const [ua, languages] = fx.fakeSession.setUserAgent.mock.calls[0]
    expect(ua).toContain('Chrome/142.0.0.0')
    expect(ua).not.toMatch(/Electron|ShuviX/)
    expect(languages).toBe('ja,en;q=0.8')

    const callback = vi.fn()
    fx.fakeSession.setPermissionRequestHandler.mock.calls[0][0](null, 'notifications', callback)
    expect(callback).toHaveBeenCalledWith(false)
    expect(fx.fakeSession.setPermissionCheckHandler.mock.calls[0][0]()).toBe(false)

    expect(fx.fakeSession.on.mock.calls[0][0]).toBe('will-download')
    const preventDefault = vi.fn()
    fx.fakeSession.on.mock.calls[0][1]({ preventDefault })
    expect(preventDefault).toHaveBeenCalled()
  })

  it('RP-W6 UA 与语言', async () => {
    const { readUserAgent, readAcceptLanguage } = await load()
    expect(readUserAgent()).toContain('Chrome/142.0.0.0')
    expect(readAcceptLanguage()).toBe('ja,en;q=0.8')
  })
})

describe('围栏', () => {
  it('RP-F1 弹窗一律拒绝', async () => {
    const { renderPage } = await load()
    await finish(renderPage(TARGET))
    const handler = windows()[0].webContents.openHandler
    expect(handler?.({ url: 'https://evil.test/' })).toEqual({ action: 'deny' })
    expect(handler?.({ url: 'mailto:a@b.test' })).toEqual({ action: 'deny' })
  })

  it.each(['will-navigate', 'will-redirect'])(
    'RP-F2 %s：跳到非 http(s) 被拒，http(s) 放行',
    async (event) => {
      const { renderPage } = await load()
      await finish(renderPage(TARGET))
      const wc = windows()[0].webContents
      const fire = (target: string): boolean => {
        const preventDefault = vi.fn()
        wc.emit(event, { preventDefault }, target)
        return preventDefault.mock.calls.length > 0
      }
      for (const refused of [
        'file:///etc/hosts',
        'javascript:alert(1)',
        'mailto:a@b.test',
        'data:text/html,x',
        'about:blank',
        'shuvix://settings',
        'vscode://x',
        'chrome://settings'
      ]) {
        expect(fire(refused), refused).toBe(true)
      }
      for (const allowed of ['http://a.test/', 'https://a.test/', 'HTTPS://A.TEST/']) {
        expect(fire(allowed), allowed).toBe(false)
      }
    }
  )

  it('RP-F3 静音；先空白页、再挂弹框脚本、最后才载入目标', async () => {
    const { renderPage } = await load()
    const sent: Array<{ method: string; params: unknown }> = []
    fx.makeWindow = (options) => {
      const win = makeWindow(options)
      const original = win.webContents.debugger.sendCommand
      win.webContents.debugger.sendCommand = async (method, params) => {
        sent.push({ method, params })
        return original(method, params)
      }
      return win
    }
    await finish(renderPage(TARGET))
    const order = fx.log.filter((l) => !['new window', 'destroy'].includes(l))
    expect(order).toEqual([
      'setAudioMuted',
      'loadURL about:blank',
      'attach 1.3',
      'Page.enable',
      'Page.addScriptToEvaluateOnNewDocument',
      `loadURL ${TARGET}`
    ])
    expect(windows()[0].webContents.setAudioMuted).toHaveBeenCalledWith(true)
    const silence = sent.find((c) => c.method === 'Page.addScriptToEvaluateOnNewDocument')
    const source = (silence?.params as { source: string }).source

    // 真的跑一遍：alert / confirm / prompt / print 都成了空操作
    const dom = new JSDOM('', { runScripts: 'outside-only' })
    dom.window.eval(source)
    expect(dom.window.eval('alert("x")')).toBeUndefined()
    expect(dom.window.eval('confirm("x")')).toBe(false)
    expect(dom.window.eval('prompt("x")')).toBeNull()
    expect(dom.window.eval('print()')).toBeUndefined()
  })

  it('RP-F4 不等目标页的 load：load 事件永远不来也能出结果', async () => {
    fx.hooks.loadURL = (url) => (url === TARGET ? new Promise<void>(() => {}) : undefined)
    const { renderPage } = await load()
    await expect(finish(renderPage(TARGET))).resolves.toEqual({ html: HTML })
  })

  it('RP-F5 目标页的 loadURL 被拒（比如被导航打断）：不算未处理的拒绝，也不算失败', async () => {
    fx.hooks.loadURL = (url) =>
      url === TARGET ? Promise.reject(new Error('ERR_ABORTED')) : undefined
    const { renderPage } = await load()
    await expect(finish(renderPage(TARGET))).resolves.toEqual({ html: HTML })
  })
})

describe('什么时候算好', () => {
  it('RP-T1 字够多：稳定 1 秒就好', async () => {
    fx.hooks.textLength = () => 300
    const { renderPage } = await load()
    const state = track(renderPage(TARGET))
    await vi.advanceTimersByTimeAsync(1000)
    expect(state.settled()).toBe(false)
    await vi.advanceTimersByTimeAsync(500)
    expect(state.settled()).toBe(true)
  })

  it('RP-T2 字很少：稳定 5 秒才算好（验证页过几秒才跳走）', async () => {
    fx.hooks.textLength = () => 299
    const { renderPage } = await load()
    const state = track(renderPage(TARGET))
    await vi.advanceTimersByTimeAsync(5000)
    expect(state.settled()).toBe(false)
    await vi.advanceTimersByTimeAsync(500)
    expect(state.settled()).toBe(true)
  })

  it('RP-T3 验证页 3 秒后换成正文：拿到的是正文', async () => {
    let t = 0
    fx.hooks.textLength = () => {
      t += 250
      return t < 3000 ? THIN : LONG
    }
    fx.hooks.html = () => (t < 3000 ? '<p>challenge</p>' : '<p>real</p>')
    const { renderPage } = await load()
    await expect(finish(renderPage(TARGET))).resolves.toEqual({ html: '<p>real</p>' })
  })

  it('RP-T4 主框架还在载入：字再稳定也不算好', async () => {
    fx.makeWindow = (options) => {
      const win = makeWindow(options)
      win.webContents.loading = true
      return win
    }
    const { renderPage } = await load()
    const state = track(renderPage(TARGET))
    await vi.advanceTimersByTimeAsync(5000)
    expect(state.settled()).toBe(false)
    windows()[0].webContents.loading = false
    await vi.advanceTimersByTimeAsync(500)
    expect(state.settled()).toBe(true)
  })

  it('RP-T5 一直在变：到 15 秒拿当时的内容', async () => {
    fx.hooks.textLength = everChanging()
    const { renderPage } = await load()
    const state = track(renderPage(TARGET))
    await vi.advanceTimersByTimeAsync(14_500)
    expect(state.settled()).toBe(false)
    await vi.advanceTimersByTimeAsync(1000)
    expect(state.settled()).toBe(true)
    expect(state.result()).toEqual({ html: HTML })
  })

  it('RP-T6 问字数时被拒（页面正在跳转）：只算还没好，之后照常', async () => {
    let asks = 0
    fx.hooks.textLength = () => {
      asks++
      if (asks < 4) return Promise.reject(new Error('context destroyed'))
      return LONG
    }
    const { renderPage } = await load()
    await expect(finish(renderPage(TARGET))).resolves.toEqual({ html: HTML })
    expect(asks).toBeGreaterThan(4)
  })

  it('RP-T7 主线程卡住：问一次最多等 3 秒，算还没好；过了预算回 null', async () => {
    fx.makeWindow = (options) => {
      const win = makeWindow(options)
      win.webContents.executeJavaScript = () => new Promise(() => {})
      return win
    }
    const { renderPage } = await load()
    const state = track(renderPage(TARGET))
    await vi.advanceTimersByTimeAsync(25_000)
    expect(state.settled()).toBe(true)
    expect(state.result()).toBeNull()
    expect(windows()[0].destroy).toHaveBeenCalled()
  })
})

describe('结果', () => {
  it('RP-R1 回渲染后的 HTML，去掉 script / style / noscript / template', async () => {
    const page = `<!doctype html><html><head><title>T</title><style>p{}</style><script>var a=1</script></head>
      <body><p>keep me</p><noscript>enable js</noscript><template><p>tpl</p></template><script>x()</script><div><script>y()</script><style>a{}</style></div></body></html>`
    fx.makeWindow = (options) => {
      const win = makeWindow(options)
      const original = win.webContents.executeJavaScript
      win.webContents.executeJavaScript = (code) => {
        if (!isExtract(code)) return original(code)
        const dom = new JSDOM(page, { runScripts: 'outside-only' })
        return Promise.resolve(dom.window.eval(code))
      }
      return win
    }
    const { renderPage } = await load()
    const result = await finish(renderPage(TARGET))
    expect(result?.html).toContain('<p>keep me</p>')
    expect(result?.html).toContain('<title>T</title>')
    expect(result?.html).not.toMatch(/<script|<style|<noscript|<template/i)
    expect(result?.html).not.toContain('enable js')
    expect(result?.html).not.toContain('tpl')
  })

  it('RP-R2 主框架载入失败 → null', async () => {
    const { renderPage } = await load()
    const pending = renderPage(TARGET)
    await vi.advanceTimersByTimeAsync(50)
    windows()[0].webContents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', TARGET, true)
    await expect(finish(pending)).resolves.toBeNull()
    expect(windows()[0].destroy).toHaveBeenCalled()
  })

  it('RP-R3 子框架载入失败不算', async () => {
    const { renderPage } = await load()
    const pending = renderPage(TARGET)
    await vi.advanceTimersByTimeAsync(50)
    windows()[0].webContents.emit('did-fail-load', {}, -105, 'x', 'https://ads.test/', false)
    await expect(finish(pending)).resolves.toEqual({ html: HTML })
  })

  it('RP-R4 -3（被后来的导航打断）不算失败', async () => {
    const { renderPage } = await load()
    const pending = renderPage(TARGET)
    await vi.advanceTimersByTimeAsync(50)
    windows()[0].webContents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', TARGET, true)
    await expect(finish(pending)).resolves.toEqual({ html: HTML })
  })

  it.each(['chrome-error://chromewebdata/', 'file:///etc/hosts', 'about:blank'])(
    'RP-R5 最后的地址是 %s：不是网页，什么都不取 → null',
    async (finalUrl) => {
      const html = vi.fn(() => HTML)
      fx.hooks.html = html
      const { renderPage } = await load()
      const pending = renderPage(TARGET)
      await vi.advanceTimersByTimeAsync(50)
      windows()[0].webContents.url = finalUrl
      await expect(finish(pending)).resolves.toBeNull()
      expect(html).not.toHaveBeenCalled()
    }
  )

  it('RP-R6 跳到另一个 http(s) 地址：照常取', async () => {
    const { renderPage } = await load()
    const pending = renderPage(TARGET)
    await vi.advanceTimersByTimeAsync(50)
    windows()[0].webContents.url = 'https://elsewhere.test/landing'
    await expect(finish(pending)).resolves.toEqual({ html: HTML })
  })

  it('RP-R7 HTML 超过 5 MB → null；恰好 5 MB 照常', async () => {
    const limit = 5 * 1024 * 1024
    fx.hooks.html = () => 'x'.repeat(limit + 1)
    const first = await load()
    await expect(finish(first.renderPage(TARGET))).resolves.toBeNull()

    fx.hooks.html = () => 'x'.repeat(limit)
    const result = await finish(first.renderPage(TARGET))
    expect(result?.html.length).toBe(limit)
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['数字', 42],
    ['对象', { a: 1 }]
  ])('RP-R8 取回来的不是字符串（%s）→ null', async (_name, value) => {
    fx.hooks.html = () => value
    const { renderPage } = await load()
    await expect(finish(renderPage(TARGET))).resolves.toBeNull()
  })

  it('RP-R9 取 HTML 时被拒 → null', async () => {
    fx.hooks.html = () => Promise.reject(new Error('context destroyed'))
    const { renderPage } = await load()
    await expect(finish(renderPage(TARGET))).resolves.toBeNull()
  })
})

describe('窗口在所有路径上都销毁', () => {
  it('RP-D1 正常结束', async () => {
    const { renderPage } = await load()
    await finish(renderPage(TARGET))
    expect(windows()[0].destroy).toHaveBeenCalledTimes(1)
  })

  it('RP-D2 空白页载入失败：把错误抛给调用方，窗口销毁', async () => {
    fx.hooks.loadURL = (url) =>
      url === 'about:blank' ? Promise.reject(new Error('blank failed')) : undefined
    const { renderPage } = await load()
    const pending = renderPage(TARGET)
    const assertion = expect(pending).rejects.toThrow('blank failed')
    await vi.advanceTimersByTimeAsync(0)
    await assertion
    expect(windows()[0].destroy).toHaveBeenCalledTimes(1)
  })

  it('RP-D3 debugger 挂不上：把错误抛给调用方，窗口销毁', async () => {
    fx.hooks.attach = () => {
      throw new Error('Debugger is already attached')
    }
    const { renderPage } = await load()
    const pending = renderPage(TARGET)
    const assertion = expect(pending).rejects.toThrow('already attached')
    await vi.advanceTimersByTimeAsync(0)
    await assertion
    expect(windows()[0].destroy).toHaveBeenCalledTimes(1)
  })

  it('RP-D4 窗口被外面销毁了（比如应用退出）：回 null，不再销毁第二次', async () => {
    const { renderPage } = await load()
    const pending = renderPage(TARGET)
    await vi.advanceTimersByTimeAsync(50)
    ;(windows()[0].destroy as () => void)()
    await expect(finish(pending)).resolves.toBeNull()
    expect(windows()[0].destroy).toHaveBeenCalledTimes(1)
  })
})

describe('并发', () => {
  /** 字数一直在变，这一页要到预算（15s）才完，够看排队 */
  const slowPages = (): void => {
    fx.hooks.textLength = everChanging()
  }

  it('RP-Q1 最多同时两个；第三个等到有一个完了才开窗', async () => {
    slowPages()
    const { renderPage } = await load()
    const a = track(renderPage('https://a.test/'))
    const b = track(renderPage('https://b.test/'))
    const c = track(renderPage('https://c.test/'))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(windows()).toHaveLength(2)
    expect(c.settled()).toBe(false)

    await vi.advanceTimersByTimeAsync(5_500)
    expect(a.settled()).toBe(true)
    expect(b.settled()).toBe(true)
    await vi.advanceTimersByTimeAsync(100)
    expect(windows()).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(c.settled()).toBe(true)
  })

  it('RP-Q2 先来先走', async () => {
    slowPages()
    const { renderPage } = await load()
    const pages = ['a', 'b', 'c', 'd', 'e'].map((n) => renderPage(`https://${n}.test/`))
    await vi.advanceTimersByTimeAsync(120_000)
    await Promise.all(pages)
    const targets = fx.log.filter((l) => l.startsWith('loadURL https:'))
    expect(targets).toEqual(['a', 'b', 'c', 'd', 'e'].map((n) => `loadURL https://${n}.test/`))
  })

  it('RP-Q3 任何时刻窗口没销毁的不超过两个', async () => {
    slowPages()
    let peak = 0
    fx.makeWindow = (options) => {
      const win = makeWindow(options)
      peak = Math.max(peak, windows().filter((w) => !w.destroyedFlag).length)
      return win
    }
    const { renderPage } = await load()
    const pages = Array.from({ length: 7 }, (_, i) => renderPage(`https://p${i}.test/`))
    await vi.advanceTimersByTimeAsync(200_000)
    await Promise.all(pages)
    expect(windows()).toHaveLength(7)
    expect(peak).toBe(2)
  })

  it('RP-Q4 排队时中止：不开窗，回 null；前面的不受影响，后面的照跑', async () => {
    slowPages()
    const { renderPage } = await load()
    const a = track(renderPage('https://a.test/'))
    const b = track(renderPage('https://b.test/'))
    const controller = new AbortController()
    const queued = track(renderPage('https://queued.test/', controller.signal))
    const after = track(renderPage('https://after.test/'))
    await vi.advanceTimersByTimeAsync(1000)
    controller.abort()
    // 不等前面的渲染让出名额
    await vi.advanceTimersByTimeAsync(0)
    expect(queued.settled()).toBe(true)
    await vi.advanceTimersByTimeAsync(60_000)

    expect(a.settled() && b.settled()).toBe(true)
    expect(queued.result()).toBeNull()
    expect(after.result()).toEqual({ html: HTML })
    const targets = fx.log.filter((l) => l.startsWith('loadURL https:'))
    expect(targets).not.toContain('loadURL https://queued.test/')
    expect(targets).toContain('loadURL https://after.test/')
    expect(windows()).toHaveLength(3)
  })

  it('RP-Q6 页面卡死时到硬上限就放手：回 null、销毁窗口、让出名额', async () => {
    const deadline = new AbortController()
    const spy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
    try {
      const { renderPage } = await load()
      // 空白页载入永远不回：渲染自己的预算循环走不到，只有硬上限能结束它
      fx.hooks.loadURL = () => new Promise<void>(() => {})
      const a = track(renderPage('https://a.test/'))
      const b = track(renderPage('https://b.test/'))
      const after = track(renderPage('https://after.test/'))
      await vi.advanceTimersByTimeAsync(60_000)
      expect(a.settled() || b.settled()).toBe(false)
      expect(spy).toHaveBeenCalledWith(25_000)

      fx.hooks.loadURL = undefined
      deadline.abort()
      await vi.advanceTimersByTimeAsync(0)
      expect(a.result()).toBeNull()
      expect(b.result()).toBeNull()
      expect(windows()[0].destroy).toHaveBeenCalled()
      expect(windows()[1].destroy).toHaveBeenCalled()
      // 名额让出来了：排在后面的那个开始了
      expect(windows()).toHaveLength(3)
      expect(after.settled()).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  it('RP-Q5 开始之前就中止了：没有窗口', async () => {
    const { renderPage } = await load()
    const controller = new AbortController()
    controller.abort()
    await expect(renderPage(TARGET, controller.signal)).resolves.toBeNull()
    expect(windows()).toHaveLength(0)
  })

  it('RP-Q6 失败也让位：抛错的一个完了，排队的开窗', async () => {
    fx.hooks.loadURL = (url) =>
      url === 'about:blank' && windows().length === 1
        ? Promise.reject(new Error('first fails'))
        : undefined
    const { renderPage } = await load()
    const a = renderPage('https://a.test/').catch((e: Error) => e.message)
    const b = track(renderPage('https://b.test/'))
    const c = track(renderPage('https://c.test/'))
    await expect(finish(a)).resolves.toBe('first fails')
    expect(b.result()).toEqual({ html: HTML })
    expect(c.result()).toEqual({ html: HTML })
  })

  it('RP-Q7 全部结束后名额还回来了：又能同时两个', async () => {
    slowPages()
    const { renderPage } = await load()
    await finish(
      Promise.all([
        renderPage('https://a.test/'),
        renderPage('https://b.test/'),
        renderPage('https://c.test/')
      ])
    )
    expect(windows()).toHaveLength(3)

    const d = track(renderPage('https://d.test/'))
    const e = track(renderPage('https://e.test/'))
    const f = track(renderPage('https://f.test/'))
    await vi.advanceTimersByTimeAsync(1000)
    expect(windows()).toHaveLength(5)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(d.settled() && e.settled() && f.settled()).toBe(true)
    expect(windows()).toHaveLength(6)
  })
})

describe('中止', () => {
  it('RP-A1 等页面时中止：窗口立刻没，结果 null', async () => {
    fx.hooks.textLength = everChanging()
    const { renderPage } = await load()
    const controller = new AbortController()
    const state = track(renderPage(TARGET, controller.signal))
    await vi.advanceTimersByTimeAsync(1000)
    controller.abort()
    expect(windows()[0].destroy).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(300)
    expect(state.settled()).toBe(true)
    expect(state.result()).toBeNull()
  })

  it('RP-A2 空白页载入期间中止：窗口没了，不再往下走', async () => {
    let finishBlank: () => void = () => {}
    fx.hooks.loadURL = (url) =>
      url === 'about:blank' ? new Promise<void>((r) => (finishBlank = r)) : undefined
    const { renderPage } = await load()
    const controller = new AbortController()
    const pending = renderPage(TARGET, controller.signal)
    await vi.advanceTimersByTimeAsync(10)
    controller.abort()
    finishBlank()
    await expect(finish(pending)).resolves.toBeNull()
    expect(fx.log).not.toContain('attach 1.3')
    expect(fx.log).not.toContain(`loadURL ${TARGET}`)
  })

  it('RP-A3 挂脚本期间中止：不载入目标', async () => {
    const controller = new AbortController()
    fx.makeWindow = (options) => {
      const win = makeWindow(options)
      const original = win.webContents.debugger.sendCommand
      win.webContents.debugger.sendCommand = async (method, params) => {
        if (method === 'Page.addScriptToEvaluateOnNewDocument') controller.abort()
        return original(method, params)
      }
      return win
    }
    const { renderPage } = await load()
    await expect(finish(renderPage(TARGET, controller.signal))).resolves.toBeNull()
    expect(fx.log).not.toContain(`loadURL ${TARGET}`)
  })

  it('RP-A4 取 HTML 时中止：内容不交回去', async () => {
    const controller = new AbortController()
    fx.hooks.html = () => {
      controller.abort()
      return HTML
    }
    const { renderPage } = await load()
    await expect(finish(renderPage(TARGET, controller.signal))).resolves.toBeNull()
    expect(windows()[0].destroy).toHaveBeenCalledTimes(1)
  })

  it('RP-A5 正常结束后中止：不会再销毁第二次（监听摘掉了）', async () => {
    const { renderPage } = await load()
    const controller = new AbortController()
    await finish(renderPage(TARGET, controller.signal))
    controller.abort()
    expect(windows()[0].destroy).toHaveBeenCalledTimes(1)
  })
})
