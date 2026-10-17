/**
 * `shuvix widget preview <id>`：在看不见的窗口里按几种尺寸渲染一个小组件、各截一张图，交给 agent 自己看排版 ——
 * 它写界面时看不到效果，只靠规则时做出来的东西在某一端走样也不知道。不弹任何窗口、不抢焦点、不计「打开」。
 *
 * - 尺寸是小组件自己拿到的那一块（不含 ShuviX 的顶栏）：`panel` = 右侧面板（窄，鼠标），`window` = 独立窗口 /
 *   桌面浏览器的标签页（宽，鼠标），`phone` = 手机浏览器（窄，触屏：`pointer: coarse`、`hover: none` 都成立）。
 * - 渲染用一个从不显示的普通窗口（show:false、不可聚焦、不进任务栏），与内置浏览器的 staging 窗口同一条路：
 *   主进程启动时带着 `disable-backgrounding-occluded-windows`，没显示过的窗口照样出帧、capturePage 拿得到图。
 *   不用离屏渲染（offscreen）：它加 CDP 的设备模拟在这台机器上直接把主进程打崩（SIGSEGV，2026-10-17 实测）。
 *   视口、触屏与移动视口都经 CDP 的 Emulation 设，截图缩回 CSS 像素（高分屏上截出来是 2 倍） —— 先载入 about:blank 再设（没有
 *   渲染进程时 CDP 命令会挂住），设好的模拟随后续导航保留；颜色方案缺省跟应用（nativeTheme.themeSource 已按
 *   用户的主题设好），给了 `theme` 就改 prefers-color-scheme。
 * - 页面只能待在这个小组件自己的地址（`/w/<id>/` 之下）：弹窗、顶层导航到别处（别的小组件也算）、下载、权限
 *   请求一律拒绝，也不交给系统 —— 没人在看这个窗口，交给系统就是替 agent 去开外站。所以它不挂 guardAppWindow
 *   （那个会把外链交给系统打开）。会话是不落盘的独立分区。
 * - 弹框与打印：`disableDialogs`，再在每个文档开头把 alert / confirm / prompt / print 换成空操作 —— macOS 上
 *   窗口藏着时 alert 是整个应用的模态框，会弹到用户面前、还把预览挂住。
 * - 截图写进调用会话的 tool_results 目录（会话目录：read 工具与命令沙箱都读得到）下的 `widget-preview/`，同一个
 *   widget 同一个尺寸覆盖上一张。没有会话（在会话之外跑 CLI）就写进系统临时目录里新建的一个目录（每次新建：
 *   固定路径在多用户的机器上能被别人预先占住）。
 * - 一次只跑一个预览（排队）；每一步都有超时（页面主线程卡死时 executeJavaScript / capturePage 也会一直不回），
 *   超时即这个尺寸失败、窗口照样销毁，排在后面的预览不受连累；某个尺寸失败只记进 errors，别的照截。
 * - 无头模式（headless）不拒绝：预览的窗口从不显示，不违反「无头不开窗」的本意；截不到图时这个尺寸报失败。
 * - 页面在 console 里报的错误一并带回（errors）：运行时异常、请求失败，agent 看图之外还能看到原因。
 */
import { BrowserWindow, session as electronSession } from 'electron'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createLogger } from '../logger'
import { getToolResultsDir, isSafeSessionId } from '../utils/paths'
import { widgetServer, widgetService } from './widget'

const log = createLogger('WidgetPreview')

export type PreviewSize = 'panel' | 'window' | 'phone'
export type PreviewTheme = 'light' | 'dark'

/** 三种尺寸（小组件拿到的视口，CSS 像素）。按用户最常见的样子取：面板拉宽的人少，手机去掉浏览器与顶栏后约 780 高 */
export const PREVIEW_SIZES: Readonly<
  Record<PreviewSize, { width: number; height: number; touch: boolean }>
> = {
  panel: { width: 380, height: 760, touch: false },
  window: { width: 1280, height: 800, touch: false },
  phone: { width: 390, height: 780, touch: true }
}

/** 缺省全截，顺序固定 */
export const PREVIEW_SIZE_ORDER: readonly PreviewSize[] = ['panel', 'window', 'phone']

const PARTITION = 'widget-preview'
/** 页面加载（含 bundle）最多等多久 */
const LOAD_TIMEOUT_MS = 15_000
/** 等 #root 里出现东西最多多久（挂载失败时宿主页面自己会画一块诊断，那也照截） */
const MOUNT_WAIT_MS = 5_000
/** 挂上之后再等一会儿：从数据库 / 磁盘取数据、字体、首轮动效 */
const SETTLE_MS = 800
/** 页面报的错误最多带回几条（同一个错误在三个尺寸里各报一次是常事）；某个尺寸失败的那一行不占这个数 */
const MAX_PAGE_ERRORS = 12
/** 单个 CDP 命令 / executeJavaScript / capturePage 最多等多久 */
const STEP_TIMEOUT_MS = 5_000

/** 每个文档开头跑一遍：没人在看的窗口里，弹框与打印都不能真的出现 */
const SILENCE_DIALOGS = `(() => {
  const noop = () => undefined
  window.alert = noop
  window.confirm = () => false
  window.prompt = () => null
  window.print = noop
})()`

export interface PreviewImage {
  size: PreviewSize
  width: number
  height: number
  path: string
}

export interface PreviewResult {
  id: string
  /** 'app' = 跟应用当前的主题 */
  theme: PreviewTheme | 'app'
  images: PreviewImage[]
  errors: string[]
}

export interface PreviewOptions {
  sizes?: readonly PreviewSize[]
  theme?: PreviewTheme
  /** 调用的会话（截图写进它的 tool_results 目录） */
  sessionId?: string
}

/**
 * CLI 交来的 `--size`（逗号分隔，大小写不论）→ 尺寸表；空 / 缺省 = 全部。认不得的直接报错（列出可选的），
 * 免得 agent 以为截了其实没截
 */
export function parsePreviewSizes(raw: unknown): PreviewSize[] {
  if (raw === undefined || raw === null || raw === '') return [...PREVIEW_SIZE_ORDER]
  if (typeof raw !== 'string') throw new Error('size must be a comma-separated list')
  const picked = new Set<PreviewSize>()
  for (const part of raw.split(',')) {
    const name = part.trim().toLowerCase()
    if (!name) continue
    if (!(PREVIEW_SIZE_ORDER as readonly string[]).includes(name)) {
      throw new Error(`unknown size "${part.trim()}" (use ${PREVIEW_SIZE_ORDER.join(', ')})`)
    }
    picked.add(name as PreviewSize)
  }
  if (picked.size === 0) return [...PREVIEW_SIZE_ORDER]
  return PREVIEW_SIZE_ORDER.filter((s) => picked.has(s))
}

/** `--theme`：light / dark；缺省跟应用 */
export function parsePreviewTheme(raw: unknown): PreviewTheme | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined
  const name = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (name === 'light' || name === 'dark') return name
  throw new Error(`unknown theme "${String(raw)}" (use light or dark)`)
}

let chain: Promise<unknown> = Promise.resolve()

/** 预览一个小组件（排队，一次一个） */
export function previewWidget(id: string, options: PreviewOptions = {}): Promise<PreviewResult> {
  const run = chain.then(() => runPreview(id, options))
  chain = run.catch(() => undefined)
  return run
}

async function runPreview(id: string, options: PreviewOptions): Promise<PreviewResult> {
  widgetService.validateId(id)
  if (options.sessionId !== undefined && !isSafeSessionId(options.sessionId)) {
    throw new Error('invalid session id')
  }
  const sizes = options.sizes?.length ? options.sizes : PREVIEW_SIZE_ORDER
  const theme = options.theme
  // 没注册就注册并构建（不计打开）；已注册的用它上一次构建的结果 —— 改完先 build 再 preview
  const { url, buildSuccess } = await widgetService.startWidget(id)
  // 已注册的不重新构建：startWidget 这时总说成功，上一次构建失败要另问（不然截到的是三张错误页）
  if (!buildSuccess || (widgetServer.lastBuildErrors(id)?.length ?? 0) > 0) {
    return {
      id,
      theme: theme ?? 'app',
      images: [],
      errors: [`the widget does not build: run \`shuvix widget build ${id}\` and fix buildErrors`]
    }
  }
  if (!url) throw new Error(`widget "${id}" has no address`)

  let dir: string
  if (options.sessionId) {
    dir = join(getToolResultsDir(options.sessionId), 'widget-preview')
    mkdirSync(dir, { recursive: true })
  } else {
    dir = mkdtempSync(join(tmpdir(), 'shuvix-widget-preview-'))
  }
  const failures: string[] = []
  const pageErrors: string[] = []
  const images: PreviewImage[] = []
  for (const size of sizes) {
    try {
      const png = await captureOne(url, size, theme, (message) => {
        if (!pageErrors.includes(message)) pageErrors.push(message)
      })
      const path = join(dir, `${id}-${size}.png`)
      writeFileSync(path, png.data)
      images.push({ size, width: png.width, height: png.height, path })
    } catch (err) {
      failures.push(`[${size}] preview failed: ${(err as Error).message}`)
      log.warn(`preview ${id} ${size} failed: ${(err as Error).message}`)
    }
  }
  return {
    id,
    theme: theme ?? 'app',
    images,
    errors: [...failures, ...pageErrors.slice(0, MAX_PAGE_ERRORS)]
  }
}

let partitionReady = false

/** 预览用的分区：不落盘；权限请求、下载一律拒绝 */
function previewSession(): Electron.Session {
  const ses = electronSession.fromPartition(PARTITION)
  if (!partitionReady) {
    partitionReady = true
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
    ses.setPermissionCheckHandler(() => false)
    ses.on('will-download', (event) => event.preventDefault())
  }
  return ses
}

/** 目标还在这个小组件自己的地址之下（同源且路径在 `/w/<id>/` 里） */
function withinWidget(target: string, home: URL): boolean {
  try {
    const t = new URL(target)
    return t.origin === home.origin && t.pathname.startsWith(home.pathname)
  } catch {
    return false
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      }
    )
  })
}

async function captureOne(
  url: string,
  size: PreviewSize,
  theme: PreviewTheme | undefined,
  report: (message: string) => void
): Promise<{ data: Buffer; width: number; height: number }> {
  const spec = PREVIEW_SIZES[size]
  const win = new BrowserWindow({
    show: false,
    width: spec.width,
    height: spec.height,
    useContentSize: true,
    frame: false,
    skipTaskbar: true,
    focusable: false,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      disableDialogs: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      session: previewSession(),
      backgroundThrottling: false
    }
  })
  const wc = win.webContents
  try {
    const home = new URL(url)
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    wc.on('will-navigate', (event, target) => {
      if (!withinWidget(target, home)) event.preventDefault()
    })
    wc.on('console-message', (details) => {
      if (details.level !== 'error') return
      report(`[${size}] ${details.message}`.slice(0, 500))
    })
    wc.on('did-fail-load', (_e, code, description, failedUrl, isMainFrame) => {
      if (isMainFrame) report(`[${size}] failed to load ${failedUrl}: ${description} (${code})`)
    })

    // 先有一个渲染进程，CDP 命令才有人接
    await withTimeout(wc.loadURL('about:blank'), LOAD_TIMEOUT_MS, 'preparing the page')
    wc.debugger.attach('1.3')
    const cdp = (method: string, params: Record<string, unknown>): Promise<unknown> =>
      withTimeout(wc.debugger.sendCommand(method, params), STEP_TIMEOUT_MS, method)
    await cdp('Page.addScriptToEvaluateOnNewDocument', { source: SILENCE_DIALOGS })
    await cdp('Emulation.setDeviceMetricsOverride', {
      width: spec.width,
      height: spec.height,
      deviceScaleFactor: 1,
      mobile: spec.touch
    })
    if (spec.touch) {
      await cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    }
    if (theme) {
      await cdp('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: theme }]
      })
    }

    await withTimeout(wc.loadURL(url), LOAD_TIMEOUT_MS, 'loading the widget')
    const deadline = Date.now() + MOUNT_WAIT_MS
    while (Date.now() < deadline) {
      const mounted = await withTimeout(
        wc.executeJavaScript(
          `(() => { const r = document.getElementById('root'); return !!r && r.childElementCount > 0 })()`
        ),
        STEP_TIMEOUT_MS,
        'checking the page'
      )
      if (mounted) break
      await sleep(100)
    }
    await withTimeout(
      wc.executeJavaScript('document.fonts.ready.then(() => true)'),
      2_000,
      'waiting for fonts'
    ).catch(() => undefined)
    await sleep(SETTLE_MS)
    const captured = await withTimeout(wc.capturePage(), STEP_TIMEOUT_MS, 'capturing the page')
    if (captured.isEmpty()) throw new Error('the page rendered nothing to capture')
    // 高分屏上截出来是 2 倍（或更多）：缩回 CSS 像素，图小一半以上，看排版也够用
    const image =
      captured.getSize().width > spec.width
        ? captured.resize({ width: spec.width, height: spec.height, quality: 'best' })
        : captured
    const { width, height } = image.getSize()
    return { data: image.toPNG(), width, height }
  } finally {
    try {
      if (wc.debugger.isAttached()) wc.debugger.detach()
    } catch {
      // 页面已经没了
    }
    win.destroy()
  }
}
