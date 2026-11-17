/**
 * read 工具的网络面：读网页用内置浏览器的身份（它的分区：cookie、登录状态、通过过的人机验证都在），
 * 以及在那个分区上渲染网页的隐藏页面。
 *
 * - 用户裁定（2026-11-17）：读网页直接用内置浏览器 —— 成功率比速度要紧，内置浏览器本来就是给 agent 放开用的。
 *   所以 read 读到的是「用户在内置浏览器里打开这个地址会看到的那一页」，登录后才有的内容也读得到。
 *   请求和隐藏页面都用分区自己的 UA（有的验证通过凭据是绑 UA 的，换一个就白过了）。
 * - 不开 tab：tab 会在标签栏里闪一下、占 tab 上限、页面弹出的新页还会留下。隐藏页面同一个分区、同一份身份，
 *   弹窗 / 下载 / 弹框这些都关在里面。读过的地址照 agent 的访问记进浏览历史（记在发起的会话名下）。
 * - `readUrlSession` 那个不落盘的内存 session 还在：搜索 API 的请求走它（不带任何浏览器身份）。
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

/**
 * 浏览器模块按需加载：它一导入就带上窗口那一整套，而 read 工具被很多只碰文件的代码（和它们的测试）导入。
 * 真正读网页时才需要它。
 */
let loadedBrowserModule: Promise<typeof import('./browser')> | undefined
const browserModule = (): Promise<typeof import('./browser')> =>
  (loadedBrowserModule ??= import('./browser'))

const log = createLogger('ReadPageRenderer')

const READ_URL_PARTITION = 'shuvix-read-url'

const RENDER_CONCURRENCY = 3
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

/**
 * 内置浏览器的分区（用户的 cookie 和登录状态在这儿）。权限请求一律拒绝是分区自己的规矩（initBrowserSession，可重复调）。
 */
export async function browserReadSession(): Promise<Electron.Session> {
  const { BROWSER_PARTITION, initBrowserSession } = await browserModule()
  initBrowserSession()
  return electronSession.fromPartition(BROWSER_PARTITION)
}

/** 内置浏览器发请求用的 UA：read 的请求和它一致 */
export async function browserReadUserAgent(): Promise<string> {
  return (await browserReadSession()).getUserAgent()
}

/** read 读了这个地址：照 agent 的访问记进浏览历史 */
export async function noteReadVisit(sessionId: string | undefined, url: string): Promise<void> {
  if (!sessionId) return
  const { historyNoteAgentRead } = await browserModule()
  historyNoteAgentRead(sessionId, url)
}

function isWebAddress(target: string): boolean {
  return /^https?:\/\//i.test(target)
}

/** 同一个地址（不算锚点） */
function sameAddress(a: string, b: string): boolean {
  try {
    const x = new URL(a)
    const y = new URL(b)
    x.hash = ''
    y.hash = ''
    x.username = x.password = y.username = y.password = ''
    return x.href === y.href
  } catch {
    return false
  }
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
  const { historyNoteReadTitle, markUnattendedPage } = await browserModule()
  const browserSession = await browserReadSession()
  if (signal?.aborted) return null
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
      session: browserSession,
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
    // 分区上「用户正看着浏览器窗口就放行下载」的规矩对这张页面不适用：一律取消
    markUnattendedPage(wc)
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
    // 标题记到历史里那个地址上：空白页自己的、跳到别处之后的都不算（按地址写，写错了会盖掉用户自己访问留下的标题）
    wc.on('page-title-updated', (_e, title) => {
      if (sameAddress(wc.getURL(), url)) historyNoteReadTitle(url, title)
    })
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
