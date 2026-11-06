/**
 * read 工具的网络面：一个专用的内存 session，以及在它上面渲染网页的隐藏页面。
 *
 * - session 不能是 defaultSession：那上面挂着 widget token 注入，还放着应用自己的 cookie。也不是内置浏览器的分区：
 *   那里有用户的登录状态，而 read 不询问就能读。这个分区不落盘，跟随系统代理，退出就没了。
 * - 隐藏页面用一个从不显示的窗口（与 widget 预览同一条路，见 widgetPreviewService）：不抢焦点、不进任务栏，
 *   读完就销毁。主进程启动时带着 `disable-backgrounding-occluded-windows`，没显示过的窗口照样运行页面。
 * - 页面是模型指定的外站：弹窗、跳到非 http(s)、下载、权限请求一律拒绝，也不交给系统（没人在看，交给系统就是替 agent
 *   开东西）；弹框和打印是空操作；没有 preload，渲染进程在沙箱里。
 * - 什么时候算好：可见文字停止变化。文字够一页正文的量只等 1 秒；很少时等得更久，验证页通过后要过几秒才跳走。
 *   总时长有上限，到了就拿当时的内容。主线程卡死时问页面会超时，只算「还没好」。
 * - 最多同时渲染 RENDER_CONCURRENCY 个，多的排队；中止或出错时窗口照样销毁。
 */
import { app, BrowserWindow, session as electronSession } from 'electron'
import { createLogger } from '../logger'
import { rendersOffscreen } from '../utils/headless'
import { SILENCE_DIALOGS } from '../utils/silenceDialogs'
import { untilAborted } from '../utils/untilAborted'
import { chromeUserAgent, MAX_RESPONSE_BYTES } from '../utils/toolUtils/urlFetch'

const log = createLogger('ReadPageRenderer')

const READ_URL_PARTITION = 'shuvix-read-url'

const RENDER_CONCURRENCY = 2
const RENDER_BUDGET_MS = 15_000
/** 正常流程最多是预算加两次问页面，留点余量 */
const RENDER_DEADLINE_MS = 25_000
const POLL_MS = 250
const ASK_TIMEOUT_MS = 3_000
/** 文字够多时停止变化多久算好；文字很少时多等一会儿 */
const SETTLE_MS = 1_000
const SETTLE_THIN_MS = 5_000
const THIN_TEXT_CHARS = 300

/** 取渲染后的 HTML：脚本、样式和 noscript 对读内容没用（页面已经跑过了，noscript 里只会是「请开启 JS」） */
const EXTRACT_HTML = `(() => {
  const copy = document.documentElement.cloneNode(true)
  copy.querySelectorAll('script, style, noscript, template').forEach((el) => el.remove())
  return copy.outerHTML
})()`

const TEXT_LENGTH = `document.body ? document.body.innerText.length : 0`

export function readUserAgent(): string {
  return chromeUserAgent(process.platform, process.versions.chrome)
}

export function readAcceptLanguage(): string {
  return `${app.getLocale()},en;q=0.8`
}

let sessionReady = false

export function readUrlSession(): Electron.Session {
  const ses = electronSession.fromPartition(READ_URL_PARTITION)
  if (!sessionReady) {
    sessionReady = true
    ses.setUserAgent(readUserAgent(), readAcceptLanguage())
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
    ses.setPermissionCheckHandler(() => false)
    ses.on('will-download', (event) => event.preventDefault())
  }
  return ses
}

function isWebAddress(target: string): boolean {
  return /^https?:\/\//i.test(target)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 问页面；页面卡住或问的时候页面正在跳转，都只算「还没好」 */
function askPage<T>(wc: Electron.WebContents, code: string): Promise<T | undefined> {
  return Promise.race([
    wc.executeJavaScript(code).catch(() => undefined) as Promise<T | undefined>,
    sleep(ASK_TIMEOUT_MS).then(() => undefined)
  ])
}

async function renderOnce(url: string, signal?: AbortSignal): Promise<{ html: string } | null> {
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    frame: false,
    skipTaskbar: true,
    focusable: false,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      disableDialogs: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      session: readUrlSession(),
      backgroundThrottling: false,
      // Linux 上无头运行时不离屏的窗口一建就崩（见 rendersOffscreen）
      ...(rendersOffscreen() ? { offscreen: true } : {})
    }
  })
  const wc = win.webContents
  const onAbort = (): void => {
    if (!win.isDestroyed()) win.destroy()
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  const gone = (): boolean => win.isDestroyed() || wc.isDestroyed() || !!signal?.aborted
  try {
    wc.setAudioMuted(true)
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    const refuseNonWeb = (event: { preventDefault(): void }, target: string): void => {
      if (!isWebAddress(target)) event.preventDefault()
    }
    wc.on('will-navigate', refuseNonWeb)
    wc.on('will-redirect', refuseNonWeb)
    let mainFrameFailed = false
    wc.on('did-fail-load', (_e, code, description, _failedUrl, isMainFrame) => {
      // -3 = 被后来的导航打断，不是失败
      if (isMainFrame && code !== -3) {
        mainFrameFailed = true
        log.info(`render failed to load ${url}: ${description} (${code})`)
      }
    })

    // 先载入空白页才有渲染进程可以挂脚本
    await wc.loadURL('about:blank')
    if (gone()) return null
    wc.debugger.attach('1.3')
    await wc.debugger.sendCommand('Page.enable')
    await wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
      source: SILENCE_DIALOGS
    })
    if (gone()) return null

    // 不等 loadURL：有的页面的 load 事件永远不来，而正文早就在了
    void wc.loadURL(url).catch(() => undefined)

    const started = Date.now()
    let lastLength = -1
    let lastChange = started
    while (Date.now() - started < RENDER_BUDGET_MS) {
      await sleep(POLL_MS)
      if (gone()) return null
      if (mainFrameFailed) return null
      const length = await askPage<number>(wc, TEXT_LENGTH)
      if (gone()) return null
      if (length === undefined) continue
      if (length !== lastLength) {
        lastLength = length
        lastChange = Date.now()
        continue
      }
      const settle = length >= THIN_TEXT_CHARS ? SETTLE_MS : SETTLE_THIN_MS
      if (!wc.isLoadingMainFrame() && Date.now() - lastChange >= settle) break
    }

    if (!isWebAddress(wc.getURL())) return null
    const html = await askPage<string>(wc, EXTRACT_HTML)
    if (gone() || typeof html !== 'string') return null
    if (html.length > MAX_RESPONSE_BYTES) return null
    return { html }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    if (!win.isDestroyed()) win.destroy()
  }
}

let running = 0
const waiting: Array<() => void> = []

/** 拿一个渲染名额；排队时被中止就不再等，返回 false */
function acquireSlot(signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false)
  if (running < RENDER_CONCURRENCY) {
    running++
    return Promise.resolve(true)
  }
  return new Promise((resolve) => {
    const grant = (): void => {
      signal?.removeEventListener('abort', onAbort)
      resolve(true)
    }
    const onAbort = (): void => {
      waiting.splice(waiting.indexOf(grant), 1)
      resolve(false)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    waiting.push(grant)
  })
}

function releaseSlot(): void {
  const next = waiting.shift()
  if (next) next()
  else running--
}

/**
 * 在隐藏页面里渲染；拿不到内容就返回 null。
 * 硬上限兜底：页面卡死时调试命令和空白页载入都可能一直不回，不能让它永远占着名额。到点窗口照样销毁。
 */
export async function renderPage(
  url: string,
  signal?: AbortSignal
): Promise<{ html: string } | null> {
  if (!(await acquireSlot(signal))) return null
  const deadline = AbortSignal.timeout(RENDER_DEADLINE_MS)
  const stop = signal ? AbortSignal.any([signal, deadline]) : deadline
  try {
    return await untilAborted(renderOnce(url, stop), stop)
  } catch (err) {
    if (stop.aborted) return null
    throw err
  } finally {
    releaseSlot()
  }
}
