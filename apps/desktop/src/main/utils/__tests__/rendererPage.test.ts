/**
 * loadRendererPage —— 应用自己的窗口怎么加载渲染端页面（main / settings / pinned-chat / widget /
 * markdown / browser 六种窗口共用）。
 *
 * 契约：
 *  - **正式包**（不是 is.dev，或 ELECTRON_RENDERER_URL 为空 / 没设）：`loadFile(<main>/../renderer/
 *    index.html, hash ? {hash} : undefined)`；不开计时器、不重试；主框架加载失败（−3 除外）只记一条 warn。
 *  - **开发态**（is.dev + URL）：`loadURL(hash ? url#hash : url)`。发出加载后 5000ms 内没有 did-navigate
 *    → warn「page did not start loading within 5000ms」并立刻重发；主框架 did-fail-load（−3、子框架除外）
 *    → warn「page load failed (<code> <desc>)」，1000ms 后重发。重发（挂住与失败合计）连续到 10 次就
 *    log.error 收手。did-navigate 取消挂住计时器与待发的重发、计数清零（did-finish-load 不算：失败后
 *    Chromium 给错误页也发 did-finish-load）。窗口销毁后不再加载、不再排任何计时器；loadURL / loadFile
 *    的拒绝一律吞掉。
 *
 * 用例：
 *   RP-0   三个常量
 *   RP-1   正式包无 hash → 一次 loadFile(<dir>/../renderer/index.html, undefined)，不 loadURL
 *   RP-2   正式包 hash 原样传 {hash}
 *   RP-3   is.dev 但 URL 为空 / 没设 → loadFile；URL 有值但不是 is.dev → 也 loadFile
 *   RP-4   正式包不开计时器，60 秒后也没有日志
 *   RP-5   正式包主框架失败 → 一条 warn（码 + 地址），不重载、不开计时器
 *   RP-6   正式包 −3 / 子框架失败 → 不 warn
 *   RP-7   正式包 loadFile 拒绝 → 没有未处理的拒绝
 *   RP-8   开发态无 hash → loadURL(url) 原样，末尾没有 '#'
 *   RP-9   开发态 hash 原样拼在 '#' 之后
 *   RP-10  hash 为 '' 等同没有 hash（两种模式）
 *   RP-11  挂住：4999ms 仍 1 次、无 warn；5000ms 一条 warn 并立刻发第 2 次（同一地址）
 *   RP-12  4000ms 时 did-navigate → 1 次、无 warn，60 秒后也没有计时器
 *   RP-13  连着挂住在 0 / 5000 / 10000 重发；之后一次 did-navigate 让它停下
 *   RP-14  did-start-loading / did-stop-loading / did-navigate-in-page / did-frame-navigate、
 *          loadURL 以 ERR_FAILED 拒绝，都**不**取消挂住计时器
 *   RP-15  100ms 失败 → warn；1099ms 仍 1 次，1100ms 第 2 次、地址相同
 *   RP-16  4500ms 失败 → 5000ms 不重发、5500ms 重发；下一次挂住在 10500ms 重发（10499 没有）
 *   RP-17  −3 → 不 warn、不多加载；挂住计时器照样 5000ms 触发
 *   RP-18  子框架失败不理
 *   RP-19  100 / 200ms 两次失败 → 只在 1200ms 重发一次
 *   RP-20  一直挂住 → 一共 11 次 loadURL、一条 log.error，之后什么都没有、计时器清空
 *   RP-21  每次都失败 → 11 次后 error，之后什么都没有
 *   RP-22  5 次挂住 + 5 次失败再来一次 → 11 次后 error，没有第 12 次
 *   RP-23  重发 10 次后 did-navigate、再失败 → 1 秒后重发，并且又能重发 10 次才 error
 *   RP-24  11 次「失败 −102 紧跟 did-finish-load」（Chromium 的真实顺序）→ 照样封顶，没有第 12 次
 *   RP-25  2000ms 关窗（挂住计时器在途）→ 计时器清空，60 秒后仍 1 次、无 warn
 *   RP-26  失败后在 1 秒延迟里关窗 → 计时器清空、不再加载
 *   RP-27  窗口已销毁但没发 closed，过 5 秒 → 不 loadURL、不抛
 *   RP-28  closed 之后来 did-fail-load → 不 loadURL、没有计时器
 *   RP-29  loadURL 一直拒绝（ERR_FAILED / ERR_ABORTED）走完挂住 + 失败一轮 → 没有未处理的拒绝
 *   RP-30  两个窗口互不相干
 *   RP-31  环境变量每次调用现读；已发出的重发用的仍是调用时那个地址
 *   RP-32  100ms 失败、600ms（重发延迟中）did-navigate → 待发的重发取消，5 秒时仍 1 次、没有计时器
 */
import { EventEmitter } from 'node:events'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEV_COMMIT_TIMEOUT_MS,
  DEV_RETRY_DELAY_MS,
  DEV_RETRY_MAX,
  loadRendererPage
} from '../rendererPage'

const fx = vi.hoisted(() => ({
  isDev: false,
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))

// 真模块在导入时就读 electron.app.isPackaged —— 换成一个跟着 fx.isDev 走的 getter
vi.mock('@electron-toolkit/utils', () => ({
  is: {
    get dev() {
      return fx.isDev
    }
  }
}))
vi.mock('../../logger', () => ({ createLogger: () => fx.log }))

/** rendererPage.ts 所在目录（`__dirname` 在被测模块里就是它） */
const UTILS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RENDERER_HTML = join(UTILS_DIR, '../renderer/index.html')
const DEV_URL = 'http://localhost:5173'
const HANG_WARN = `page did not start loading within 5000ms: ${DEV_URL}`

/** 只换掉计时器：setImmediate / nextTick 留真的，好冲刷未处理拒绝 */
const FAKE_TIMERS = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] as const

class FakeWindow {
  destroyed = false
  private readonly events = new EventEmitter()
  readonly webContents = new EventEmitter()
  loadURL = vi.fn((_url: string): Promise<void> => Promise.resolve())
  loadFile = vi.fn((_file: string, _opts?: { hash?: string }): Promise<void> => Promise.resolve())

  /**
   * 两个加载函数都换成**不经 vi.fn** 的、每次都拒绝的函数，回一个读调用次数的函数。
   * vi.fn 会在它返回的 Promise 上挂 then（记 settledResults），等于替产品处理了拒绝 —— 拿它测
   * 「拒绝被吞掉」，删掉产品里的 `.catch` 也照样是绿的。
   */
  rejectEveryLoad(reason: (nth: number) => Error): () => number {
    let n = 0
    const reject = (): Promise<void> => Promise.reject(reason(n++))
    this.loadURL = reject as unknown as FakeWindow['loadURL']
    this.loadFile = reject as unknown as FakeWindow['loadFile']
    return () => n
  }

  isDestroyed(): boolean {
    return this.destroyed
  }
  on(event: string, fn: (...args: unknown[]) => void): this {
    this.events.on(event, fn)
    return this
  }
  once(event: string, fn: (...args: unknown[]) => void): this {
    this.events.once(event, fn)
    return this
  }
  /** 用户 / 程序关窗：先销毁，再发 closed（Electron 的顺序） */
  close(): void {
    this.destroyed = true
    this.events.emit('closed')
  }

  /** 主框架（缺省）或子框架的一次加载失败 */
  fail(code = -102, desc = 'ERR_CONNECTION_REFUSED', url = DEV_URL, isMainFrame = true): void {
    this.webContents.emit('did-fail-load', {}, code, desc, url, isMainFrame)
  }
  /** 主框架导航已提交（拿到页面了） */
  navigate(url = DEV_URL): void {
    this.webContents.emit('did-navigate', {}, url, 200, 'OK')
  }
}

const load = (win: FakeWindow, hash?: string): void =>
  loadRendererPage(win as unknown as Electron.BrowserWindow, hash)

/** 开发态：is.dev + URL */
function dev(url = DEV_URL): void {
  fx.isDev = true
  vi.stubEnv('ELECTRON_RENDERER_URL', url)
}

/** 正式包：不是 is.dev，URL 明确置空 */
function prod(): void {
  fx.isDev = false
  vi.stubEnv('ELECTRON_RENDERER_URL', '')
}

const advance = (ms: number): void => void vi.advanceTimersByTime(ms)

/**
 * 挂住重发是挂住计时器的回调里排的一个 0ms 计时器（「立刻」）。fake-timers 把**计时器回调里**排的
 * 0ms 计时器推后 1ms（防死循环），所以在假时钟上它落在到点之后 1ms —— 断言里的 `+ IMMEDIATE`
 * 就是这一步，不是真有 1ms 的延迟。
 */
const IMMEDIATE = 1

/** 一整次挂住：等满 5000ms，再让那个「立刻」的重发跑掉 */
function hang(): void {
  advance(DEV_COMMIT_TIMEOUT_MS)
  advance(IMMEDIATE)
}

/** 记下 process 级的未处理拒绝；冲刷两拍真的 setImmediate 后再看 */
function watchUnhandled(): { seen: unknown[]; settle: () => Promise<void>; stop: () => void } {
  const seen: unknown[] = []
  const onRejection = (reason: unknown): void => void seen.push(reason)
  process.on('unhandledRejection', onRejection)
  return {
    seen,
    settle: async () => {
      for (let i = 0; i < 3; i++) await new Promise<void>((r) => setImmediate(r))
    },
    stop: () => void process.off('unhandledRejection', onRejection)
  }
}

const loadError = (code: string, errno: number): Error =>
  Object.assign(new Error(`${code} (${errno}) loading '${DEV_URL}'`), { code, errno })

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: [...FAKE_TIMERS] })
  fx.isDev = false
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('常量（RP-0）', () => {
  it('RP-0 挂住 5000ms、失败后 1000ms 重发、最多连续重发 10 次', () => {
    expect(DEV_COMMIT_TIMEOUT_MS).toBe(5000)
    expect(DEV_RETRY_DELAY_MS).toBe(1000)
    expect(DEV_RETRY_MAX).toBe(10)
  })
})

describe('正式包：读本地文件，不看着（RP-1…7）', () => {
  it('RP-1 无 hash → 一次 loadFile(<dir>/../renderer/index.html)，第二个参数 undefined，不 loadURL', () => {
    prod()
    const win = new FakeWindow()
    load(win)
    expect(win.loadFile).toHaveBeenCalledTimes(1)
    expect(win.loadFile.mock.calls[0]).toEqual([RENDERER_HTML, undefined])
    expect(win.loadURL).not.toHaveBeenCalled()
  })

  it.each(['settings', 'settings/providers', 'markdown-window?sessionId=a%20b&path=%2Fx%2Fy.md'])(
    'RP-2 hash %j 原样作 {hash}',
    (hash) => {
      prod()
      const win = new FakeWindow()
      load(win, hash)
      expect(win.loadFile).toHaveBeenCalledTimes(1)
      expect(win.loadFile.mock.calls[0]).toEqual([RENDERER_HTML, { hash }])
      expect(win.loadURL).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['is.dev 但 URL 为空串', true, ''],
    ['is.dev 但 URL 没设', true, undefined],
    ['URL 有值但不是 is.dev', false, DEV_URL]
  ])('RP-3 %s → loadFile', (_label, isDev, url) => {
    fx.isDev = isDev
    vi.stubEnv('ELECTRON_RENDERER_URL', url)
    if (url === undefined) expect(process.env['ELECTRON_RENDERER_URL']).toBeUndefined()
    const win = new FakeWindow()
    load(win, 'settings')
    expect(win.loadFile).toHaveBeenCalledTimes(1)
    expect(win.loadFile.mock.calls[0]).toEqual([RENDERER_HTML, { hash: 'settings' }])
    expect(win.loadURL).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('RP-4 不开计时器；60 秒后也没有任何日志、没有再加载', () => {
    prod()
    const win = new FakeWindow()
    load(win)
    expect(vi.getTimerCount()).toBe(0)
    advance(60_000)
    expect(win.loadFile).toHaveBeenCalledTimes(1)
    expect(win.loadURL).not.toHaveBeenCalled()
    expect(fx.log.warn).not.toHaveBeenCalled()
    expect(fx.log.error).not.toHaveBeenCalled()
    expect(fx.log.info).not.toHaveBeenCalled()
  })

  it('RP-5 主框架加载失败 → 一条 warn（带码与地址），不重载、不开计时器', () => {
    prod()
    const win = new FakeWindow()
    load(win)
    const fileUrl = `file://${RENDERER_HTML}`
    win.fail(-6, 'ERR_FILE_NOT_FOUND', fileUrl)
    expect(fx.log.warn).toHaveBeenCalledTimes(1)
    const text = String(fx.log.warn.mock.calls[0][0])
    expect(text).toContain('-6')
    expect(text).toContain(fileUrl)
    expect(vi.getTimerCount()).toBe(0)
    advance(60_000)
    expect(win.loadFile).toHaveBeenCalledTimes(1)
    expect(win.loadURL).not.toHaveBeenCalled()
    expect(fx.log.error).not.toHaveBeenCalled()
  })

  it('RP-6 −3（被顶掉）与子框架失败都不 warn', () => {
    prod()
    const win = new FakeWindow()
    load(win)
    win.fail(-3, 'ERR_ABORTED', `file://${RENDERER_HTML}`)
    win.fail(-102, 'ERR_CONNECTION_REFUSED', 'http://127.0.0.1:1/frame', false)
    expect(fx.log.warn).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    expect(win.loadFile).toHaveBeenCalledTimes(1)
  })

  it('RP-7 loadFile 拒绝 → 没有未处理的拒绝', async () => {
    prod()
    const unhandled = watchUnhandled()
    try {
      const win = new FakeWindow()
      const loads = win.rejectEveryLoad(() => loadError('ERR_FILE_NOT_FOUND', -6))
      load(win)
      load(win, 'settings')
      await unhandled.settle()
      expect(loads()).toBe(2)
      expect(unhandled.seen).toEqual([])
    } finally {
      unhandled.stop()
    }
  })
})

describe('开发态：地址（RP-8…10）', () => {
  it('RP-8 无 hash → loadURL(url) 原样，末尾没有 #，不 loadFile', () => {
    dev()
    const win = new FakeWindow()
    load(win)
    expect(win.loadURL).toHaveBeenCalledTimes(1)
    expect(win.loadURL.mock.calls[0][0]).toBe(DEV_URL)
    expect(win.loadFile).not.toHaveBeenCalled()
  })

  it.each(['settings', 'settings/providers', 'pinned-chat?sessionId=s%201'])(
    'RP-9 hash %j 原样拼在 # 之后',
    (hash) => {
      dev()
      const win = new FakeWindow()
      load(win, hash)
      expect(win.loadURL.mock.calls[0][0]).toBe(`${DEV_URL}#${hash}`)
    }
  )

  it('RP-10 hash 为空串等同没有 hash（开发态不带 #，正式包第二个参数 undefined）', () => {
    dev()
    const d = new FakeWindow()
    load(d, '')
    expect(d.loadURL.mock.calls[0][0]).toBe(DEV_URL)

    prod()
    const p = new FakeWindow()
    load(p, '')
    expect(p.loadFile.mock.calls[0]).toEqual([RENDERER_HTML, undefined])
  })
})

describe('开发态：挂住重发（RP-11…14）', () => {
  it('RP-11 4999ms 仍 1 次、无 warn；5000ms 一条 warn 并立刻发第 2 次（同一地址）', () => {
    dev()
    const win = new FakeWindow()
    load(win, 'settings')
    advance(4999)
    expect(win.loadURL).toHaveBeenCalledTimes(1)
    expect(fx.log.warn).not.toHaveBeenCalled()
    advance(1)
    expect(fx.log.warn).toHaveBeenCalledTimes(1)
    advance(IMMEDIATE)
    expect(win.loadURL).toHaveBeenCalledTimes(2)
    expect(win.loadURL.mock.calls[1][0]).toBe(win.loadURL.mock.calls[0][0])
    expect(fx.log.warn).toHaveBeenCalledTimes(1)
    expect(fx.log.warn).toHaveBeenCalledWith(HANG_WARN)
  })

  it('RP-12 4000ms 时 did-navigate → 只有 1 次、无 warn，60 秒后也没有计时器', () => {
    dev()
    const win = new FakeWindow()
    load(win)
    advance(4000)
    win.navigate()
    expect(vi.getTimerCount()).toBe(0)
    advance(60_000)
    expect(win.loadURL).toHaveBeenCalledTimes(1)
    expect(fx.log.warn).not.toHaveBeenCalled()
    expect(fx.log.error).not.toHaveBeenCalled()
  })

  it('RP-13 连着挂住在 0 / 5000 / 10000 发出；第 3 次之后 did-navigate → 不再发', () => {
    dev()
    const win = new FakeWindow()
    load(win)
    advance(4999)
    expect(win.loadURL).toHaveBeenCalledTimes(1)
    advance(1 + IMMEDIATE)
    expect(win.loadURL).toHaveBeenCalledTimes(2)
    advance(4999)
    expect(win.loadURL).toHaveBeenCalledTimes(2)
    advance(1 + IMMEDIATE)
    expect(win.loadURL).toHaveBeenCalledTimes(3)
    advance(500)
    win.navigate()
    advance(60_000)
    expect(win.loadURL).toHaveBeenCalledTimes(3)
    expect(fx.log.warn).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('RP-14 其它导航事件与 loadURL 的拒绝都不取消挂住计时器（5000ms 照样重发）', async () => {
    dev()
    const win = new FakeWindow()
    win.loadURL.mockRejectedValueOnce(loadError('ERR_FAILED', -2))
    load(win)
    await Promise.resolve()
    advance(1000)
    win.webContents.emit('did-start-loading', {})
    win.webContents.emit('did-stop-loading', {})
    win.webContents.emit('did-navigate-in-page', {}, `${DEV_URL}#x`, true)
    win.webContents.emit('did-frame-navigate', {}, `${DEV_URL}/frame`, 200, 'OK', false)
    win.webContents.emit('dom-ready', {})
    advance(3999)
    expect(win.loadURL).toHaveBeenCalledTimes(1)
    advance(1 + IMMEDIATE)
    expect(win.loadURL).toHaveBeenCalledTimes(2)
    expect(fx.log.warn).toHaveBeenCalledWith(HANG_WARN)
  })
})

describe('开发态：失败重发（RP-15…19）', () => {
  it('RP-15 100ms 失败 → warn；1099ms 仍 1 次，1100ms 第 2 次、地址相同', () => {
    dev()
    const win = new FakeWindow()
    load(win, 'browser-window')
    advance(100)
    win.fail(-102, 'ERR_CONNECTION_REFUSED', `${DEV_URL}/#browser-window`)
    expect(fx.log.warn).toHaveBeenCalledTimes(1)
    expect(fx.log.warn).toHaveBeenCalledWith(
      `page load failed (-102 ERR_CONNECTION_REFUSED): ${DEV_URL}/#browser-window`
    )
    advance(999)
    expect(win.loadURL).toHaveBeenCalledTimes(1)
    advance(1)
    expect(win.loadURL).toHaveBeenCalledTimes(2)
    expect(win.loadURL.mock.calls[1][0]).toBe(`${DEV_URL}#browser-window`)
    expect(win.loadURL.mock.calls[1][0]).toBe(win.loadURL.mock.calls[0][0])
  })

  it('RP-16 4500ms 失败 → 5000ms 不重发、5500ms 重发；下一次挂住在 10500ms（10499 没有）', () => {
    dev()
    const win = new FakeWindow()
    load(win)
    advance(4500)
    win.fail()
    advance(500)
    expect(win.loadURL).toHaveBeenCalledTimes(1)
    expect(fx.log.warn).toHaveBeenCalledTimes(1)
    advance(500)
    expect(win.loadURL).toHaveBeenCalledTimes(2)
    advance(4999)
    expect(win.loadURL).toHaveBeenCalledTimes(2)
    expect(fx.log.warn).toHaveBeenCalledTimes(1)
    advance(1)
    expect(fx.log.warn).toHaveBeenCalledTimes(2)
    expect(fx.log.warn).toHaveBeenLastCalledWith(HANG_WARN)
    advance(IMMEDIATE)
    expect(win.loadURL).toHaveBeenCalledTimes(3)
  })

  it('RP-17 −3 → 不 warn、不多加载；挂住计时器照样 5000ms 触发', () => {
    dev()
    const win = new FakeWindow()
    load(win)
    advance(100)
    win.fail(-3, 'ERR_ABORTED')
    expect(fx.log.warn).not.toHaveBeenCalled()
    advance(1000)
    expect(win.loadURL).toHaveBeenCalledTimes(1)
    advance(3900 + IMMEDIATE)
    expect(win.loadURL).toHaveBeenCalledTimes(2)
    expect(fx.log.warn).toHaveBeenCalledTimes(1)
    expect(fx.log.warn).toHaveBeenCalledWith(HANG_WARN)
  })

  it('RP-18 子框架失败不理（不 warn、不重发；挂住计时器照旧）', () => {
    dev()
    const win = new FakeWindow()
    load(win)
    advance(100)
    win.fail(-102, 'ERR_CONNECTION_REFUSED', 'http://127.0.0.1:9/frame', false)
    expect(fx.log.warn).not.toHaveBeenCalled()
    advance(1000)
    expect(win.loadURL).toHaveBeenCalledTimes(1)
    advance(3900 + IMMEDIATE)
    expect(win.loadURL).toHaveBeenCalledTimes(2)
    expect(fx.log.warn).toHaveBeenCalledWith(HANG_WARN)
  })

  it('RP-19 100 / 200ms 两次失败 → 只在 1200ms 重发一次', () => {
    dev()
    const win = new FakeWindow()
    load(win)
    advance(100)
    win.fail()
    advance(100)
    win.fail()
    expect(fx.log.warn).toHaveBeenCalledTimes(2)
    advance(999)
    expect(win.loadURL).toHaveBeenCalledTimes(1)
    advance(1)
    expect(win.loadURL).toHaveBeenCalledTimes(2)
    // 下一次只会是这次加载自己的挂住重发（1200 + 5000）
    advance(4999)
    expect(win.loadURL).toHaveBeenCalledTimes(2)
  })
})

describe('开发态：上限（RP-20…24）', () => {
  it('RP-20 一直挂住 → 一共 11 次 loadURL、一条 log.error，之后什么都没有', () => {
    dev()
    const win = new FakeWindow()
    load(win)
    for (let i = 1; i <= 10; i++) {
      hang()
      expect(win.loadURL).toHaveBeenCalledTimes(i + 1)
    }
    expect(fx.log.error).not.toHaveBeenCalled()
    advance(DEV_COMMIT_TIMEOUT_MS)
    expect(win.loadURL).toHaveBeenCalledTimes(11)
    expect(fx.log.error).toHaveBeenCalledTimes(1)
    expect(fx.log.error).toHaveBeenCalledWith(`page still not loaded after 10 retries: ${DEV_URL}`)
    expect(fx.log.warn).toHaveBeenCalledTimes(11)
    expect(vi.getTimerCount()).toBe(0)
    advance(120_000)
    expect(win.loadURL).toHaveBeenCalledTimes(11)
    expect(fx.log.error).toHaveBeenCalledTimes(1)
    expect(fx.log.warn).toHaveBeenCalledTimes(11)
  })

  it('RP-21 每次都失败 → 11 次后 error，之后什么都没有', () => {
    dev()
    const win = new FakeWindow()
    load(win)
    for (let i = 1; i <= 10; i++) {
      win.fail()
      advance(DEV_RETRY_DELAY_MS)
      expect(win.loadURL).toHaveBeenCalledTimes(i + 1)
    }
    expect(fx.log.error).not.toHaveBeenCalled()
    win.fail()
    expect(fx.log.error).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    advance(120_000)
    expect(win.loadURL).toHaveBeenCalledTimes(11)
    expect(fx.log.error).toHaveBeenCalledTimes(1)
  })

  it('RP-22 5 次挂住 + 5 次失败，再来一次 → 11 次后 error，没有第 12 次', () => {
    dev()
    const win = new FakeWindow()
    load(win)
    for (let i = 0; i < 5; i++) hang()
    expect(win.loadURL).toHaveBeenCalledTimes(6)
    for (let i = 0; i < 5; i++) {
      win.fail()
      advance(DEV_RETRY_DELAY_MS)
    }
    expect(win.loadURL).toHaveBeenCalledTimes(11)
    expect(fx.log.error).not.toHaveBeenCalled()
    win.fail()
    expect(fx.log.error).toHaveBeenCalledTimes(1)
    advance(120_000)
    expect(win.loadURL).toHaveBeenCalledTimes(11)
    expect(fx.log.error).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('RP-23 重发 10 次后 did-navigate、再失败 → 1 秒后重发，并且又能重发 10 次才 error', () => {
    dev()
    const win = new FakeWindow()
    load(win)
    for (let i = 0; i < 10; i++) {
      win.fail()
      advance(DEV_RETRY_DELAY_MS)
    }
    expect(win.loadURL).toHaveBeenCalledTimes(11)
    win.navigate()
    // 拿到页面之后的一次失败（比如 HMR 整页刷新时 dev server 正好在重启）
    win.fail()
    expect(fx.log.error).not.toHaveBeenCalled()
    advance(DEV_RETRY_DELAY_MS - 1)
    expect(win.loadURL).toHaveBeenCalledTimes(11)
    advance(1)
    expect(win.loadURL).toHaveBeenCalledTimes(12)
    for (let i = 0; i < 9; i++) {
      win.fail()
      advance(DEV_RETRY_DELAY_MS)
    }
    expect(win.loadURL).toHaveBeenCalledTimes(21)
    expect(fx.log.error).not.toHaveBeenCalled()
    win.fail()
    expect(fx.log.error).toHaveBeenCalledTimes(1)
    advance(120_000)
    expect(win.loadURL).toHaveBeenCalledTimes(21)
  })

  it('RP-24 11 次「失败 −102 紧跟 did-finish-load」→ 照样封顶：error 一次，没有第 12 次', () => {
    dev()
    const win = new FakeWindow()
    load(win)
    for (let i = 0; i < 11; i++) {
      win.fail(-102, 'ERR_CONNECTION_REFUSED')
      // Chromium 给错误页发的 did-finish-load（没有 did-navigate）
      win.webContents.emit('did-finish-load', {})
      advance(DEV_RETRY_DELAY_MS)
    }
    expect(fx.log.error).toHaveBeenCalledTimes(1)
    expect(win.loadURL).toHaveBeenCalledTimes(11)
    advance(120_000)
    expect(win.loadURL).toHaveBeenCalledTimes(11)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('窗口没了（RP-25…28）', () => {
  it('RP-25 2000ms 关窗（挂住计时器在途）→ 计时器清空，60 秒后仍 1 次、无 warn', () => {
    dev()
    const win = new FakeWindow()
    load(win)
    advance(2000)
    win.close()
    expect(vi.getTimerCount()).toBe(0)
    advance(60_000)
    expect(win.loadURL).toHaveBeenCalledTimes(1)
    expect(fx.log.warn).not.toHaveBeenCalled()
  })

  it('RP-26 失败后在 1 秒延迟里关窗 → 计时器清空、不再加载', () => {
    dev()
    const win = new FakeWindow()
    load(win)
    win.fail()
    advance(500)
    win.close()
    expect(vi.getTimerCount()).toBe(0)
    advance(60_000)
    expect(win.loadURL).toHaveBeenCalledTimes(1)
  })

  it('RP-27 窗口已销毁但还没发 closed，过 5 秒 → 不 loadURL、不抛、不再排计时器', () => {
    dev()
    const win = new FakeWindow()
    load(win)
    win.destroyed = true
    expect(() => advance(DEV_COMMIT_TIMEOUT_MS)).not.toThrow()
    expect(win.loadURL).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    advance(60_000)
    expect(win.loadURL).toHaveBeenCalledTimes(1)
  })

  it('RP-28 closed 之后来的 did-fail-load → 不 loadURL、没有计时器', () => {
    dev()
    const win = new FakeWindow()
    load(win)
    win.close()
    expect(() => win.fail()).not.toThrow()
    expect(vi.getTimerCount()).toBe(0)
    advance(60_000)
    expect(win.loadURL).toHaveBeenCalledTimes(1)
  })
})

describe('拒绝与隔离（RP-29…32）', () => {
  it('RP-29 loadURL 一直拒绝（ERR_FAILED / ERR_ABORTED）走完挂住 + 失败一轮 → 没有未处理的拒绝', async () => {
    dev()
    const unhandled = watchUnhandled()
    try {
      const win = new FakeWindow()
      const loads = win.rejectEveryLoad((n) =>
        n % 2 ? loadError('ERR_ABORTED', -3) : loadError('ERR_FAILED', -2)
      )
      load(win)
      await unhandled.settle()
      hang() // 挂住 → 重发
      await unhandled.settle()
      win.fail(-2, 'ERR_FAILED')
      advance(DEV_RETRY_DELAY_MS) // 失败 → 重发
      await unhandled.settle()
      win.fail(-3, 'ERR_ABORTED') // 被顶掉：不重发
      hang() // 又挂住 → 重发
      await unhandled.settle()
      expect(loads()).toBe(4)
      expect(unhandled.seen).toEqual([])
    } finally {
      unhandled.stop()
    }
  })

  it('RP-30 两个窗口互不相干', () => {
    dev()
    const a = new FakeWindow()
    const b = new FakeWindow()
    load(a, 'settings')
    load(b, 'pinned-chat?sessionId=s1')
    advance(1000)
    a.navigate()
    b.fail()
    advance(DEV_RETRY_DELAY_MS)
    expect(a.loadURL).toHaveBeenCalledTimes(1)
    expect(b.loadURL).toHaveBeenCalledTimes(2)
    expect(b.loadURL.mock.calls[1][0]).toBe(`${DEV_URL}#pinned-chat?sessionId=s1`)
    a.close()
    hang()
    expect(a.loadURL).toHaveBeenCalledTimes(1)
    expect(b.loadURL).toHaveBeenCalledTimes(3)
    b.close()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('RP-31 环境变量每次调用现读；已在看着的那扇窗口重发时仍用调用时的地址', () => {
    dev('http://localhost:5173')
    const first = new FakeWindow()
    load(first)
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:6001')
    const second = new FakeWindow()
    load(second)
    expect(second.loadURL.mock.calls[0][0]).toBe('http://localhost:6001')
    vi.stubEnv('ELECTRON_RENDERER_URL', '')
    const third = new FakeWindow()
    load(third)
    expect(third.loadFile).toHaveBeenCalledTimes(1)
    expect(third.loadURL).not.toHaveBeenCalled()
    hang()
    expect(first.loadURL.mock.calls.map((c) => c[0])).toEqual([
      'http://localhost:5173',
      'http://localhost:5173'
    ])
    expect(second.loadURL.mock.calls.map((c) => c[0])).toEqual([
      'http://localhost:6001',
      'http://localhost:6001'
    ])
  })

  it('RP-32 100ms 失败、600ms（重发延迟中）did-navigate → 待发的重发取消，5 秒时仍 1 次、没有计时器', () => {
    dev()
    const win = new FakeWindow()
    load(win)
    advance(100)
    win.fail()
    advance(500)
    win.navigate()
    expect(vi.getTimerCount()).toBe(0)
    advance(4400)
    expect(win.loadURL).toHaveBeenCalledTimes(1)
    advance(60_000)
    expect(win.loadURL).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
