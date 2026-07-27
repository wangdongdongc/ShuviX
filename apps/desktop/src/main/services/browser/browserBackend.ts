/**
 * DesktopBrowserBackend —— 统一 browser 工具的桌面端实现。
 *
 * 操作主窗口内嵌的多 tab WebContentsView 面板（隔离 partition，非用户系统浏览器）：
 *   - tab 管理走 browserViewService（真源）；每个带 tabId 的操作执行前隐式 activateTab，
 *     右侧面板跟随 agent 正在操作的页面；面板开/关经 browser_event 广播联动 renderer。
 *   - CDP 交互/快照/调试委托共享 browserCdpOps（与扩展同一份配方），per-tab 会话走
 *     browserCdpManager。
 *   - screenshot / pdf 走 Electron 原生 capturePage / printToPDF（CDP 在 WebContentsView
 *     上分别不稳定 / 不暴露），落盘 + 准入校验为桌面专属逻辑。
 *
 * agent 可见的 tabId 是 t1/t2/… 短号（UUID 36 字符在多轮对话里浪费 token 且易抄错），
 * 模块级映射到 browserViewService 的 UUID；对用户经 UI 开的 tab 懒分配短号。
 */

import { writeFile, mkdir } from 'fs/promises'
import { dirname, isAbsolute, join, resolve } from 'path'
import type { WebContentsView } from 'electron'
import {
  browserCdpOps,
  EXTRACT_PAGE_EXPR,
  formatReadPage,
  htmlToMarkdown,
  type BrowserBackend,
  type BrowserCaps,
  type BrowserOpOutput,
  type ExtractedPage,
  type NavKind,
  type ScrollDirection,
  type TabCdpSession
} from '@shuvix/agent-runtime'
import { chatFrontendRegistry } from '../../frontend/core'
import {
  isPathWithinWorkspace,
  isPathWithinReadwriteReferenceDirs,
  resolveProjectConfig
} from '../toolContext'
import { getToolResultsDir } from '../../utils/paths'
import { createLogger } from '../../logger'
import { browserCdpManager } from './browserCdpService'
import {
  activateTab,
  closeTab as closeTabView,
  createTab,
  getTabView,
  listTabs as listTabsService
} from './browserViewService'

const log = createLogger('Browser:Backend')

export const DESKTOP_BROWSER_CAPS: BrowserCaps = {
  pdf: true,
  fullPageScreenshot: true,
  elementScreenshot: true,
  screenshotToFile: true,
  evaluate: true,
  network: true,
  console: true,
  rawCdp: true
}

// ====== 短号映射（模块级：tab 真源是全局的，映射也全局） ======

let shortIdCounter = 0
const uuidToShort = new Map<string, string>()
const shortToUuid = new Map<string, string>()

/** 取（或懒分配）某 UUID 的短号 —— 用户经 UI 开的 tab 首次被 agent 看到时也拿到短号 */
function shortIdFor(uuid: string): string {
  let short = uuidToShort.get(uuid)
  if (!short) {
    short = `t${++shortIdCounter}`
    uuidToShort.set(uuid, short)
    shortToUuid.set(short, uuid)
  }
  return short
}

/** 解析 agent 传入的 tabId（短号或原始 UUID）→ UUID；不存在的 tab 给出可行动的错误 */
function resolveTabId(tabId: string): string {
  const uuid = shortToUuid.get(tabId) ?? tabId
  if (!getTabView(uuid)) {
    throw new Error(
      `No browser tab "${tabId}". Use list_tabs to see open tabs, or open_tab to open one.`
    )
  }
  return uuid
}

/** 解析 + 隐式激活（面板跟随 agent 操作）+ 返回 view */
function resolveAndActivate(tabId: string): { uuid: string; view: WebContentsView } {
  const uuid = resolveTabId(tabId)
  activateTab(uuid)
  return { uuid, view: getTabView(uuid)! }
}

class DesktopBrowserBackend implements BrowserBackend {
  readonly caps = DESKTOP_BROWSER_CAPS

  constructor(private sessionId: string) {}

  private async session(tabId: string): Promise<{ session: TabCdpSession; uuid: string }> {
    const { uuid } = resolveAndActivate(tabId)
    const session = await browserCdpManager.session(uuid)
    // 对话框自动处理（幂等）：alert/confirm 弹出不会卡死自动化链
    await session.enableDialogHandling().catch(() => {})
    return { session, uuid }
  }

  private broadcast(action: 'open' | 'close'): void {
    chatFrontendRegistry.broadcast({
      type: 'browser_event',
      sessionId: this.sessionId,
      action
    })
  }

  // ── tab 管理 ──

  async listTabs(): Promise<BrowserOpOutput> {
    const lines = listTabsService().map((t) => {
      const tag = t.active ? ' (active)' : ''
      return `[${shortIdFor(t.id)}]${tag} ${t.title || '(untitled)'} — ${t.url}`
    })
    return { text: lines.join('\n') || '(no open tabs — use open_tab to open one)' }
  }

  async openTab(p: { url: string }): Promise<BrowserOpOutput> {
    const uuid = createTab(p.url, { activate: true })
    const short = shortIdFor(uuid)
    // 通知 renderer 露出右侧浏览器面板（tab 已由主进程建好，经 browser-view:tab-* 镜像）
    this.broadcast('open')
    return {
      text: `Opened ${p.url} in new tab ${short}. Use snapshot/read_page with this tab id.`,
      details: { url: p.url }
    }
  }

  async closeTab(p: { tabId: string }): Promise<BrowserOpOutput> {
    const uuid = resolveTabId(p.tabId)
    closeTabView(uuid)
    if (listTabsService().length === 0) {
      // 关掉最后一个 tab → 收起面板
      this.broadcast('close')
    }
    return { text: `Closed tab ${p.tabId}.` }
  }

  // ── 读取 / 捕获 ──

  async readPage(p: { tabId: string }): Promise<BrowserOpOutput> {
    const { view } = resolveAndActivate(p.tabId)
    const extracted = (await view.webContents.executeJavaScript(EXTRACT_PAGE_EXPR)) as ExtractedPage
    const md = await htmlToMarkdown(extracted.html)
    return { text: formatReadPage(extracted, md) }
  }

  async snapshot(p: { tabId: string }): Promise<BrowserOpOutput> {
    const { session, uuid } = await this.session(p.tabId)
    const pageUrl = getTabView(uuid)?.webContents.getURL() ?? ''
    return browserCdpOps.snapshotOp(session, pageUrl)
  }

  /**
   * 截图走 Electron 原生 `capturePage()`（CDP Page.captureScreenshot 在 WebContentsView 上
   * 常报 "Unable to capture screenshot"），PNG 落盘到 session 的 tool_results 目录——
   * 截图往往很大，内联会把对话上下文撑爆；agent 需要看时用 `read` 工具读该路径。
   */
  async screenshot(p: {
    tabId: string
    fullPage?: boolean
    uid?: string
  }): Promise<BrowserOpOutput> {
    const { view, uuid } = resolveAndActivate(p.tabId)
    const wc = view.webContents
    const shotLabel = p.uid ? `element uid=${p.uid}` : p.fullPage ? 'full page' : 'viewport'
    log.info(`screenshot start: ${shotLabel}`)

    let pngBuffer: Buffer
    try {
      if (p.uid) {
        // 元素截图：CDP 拿到 bounding rect，再用 capturePage 传 rect 裁剪
        const session = await browserCdpManager.session(uuid)
        const rect = await session.controller.callOnElement<{
          x: number
          y: number
          width: number
          height: number
        }>(
          p.uid,
          'function(){ const r = this.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }'
        )
        const image = await wc.capturePage({
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.max(1, Math.round(rect.width)),
          height: Math.max(1, Math.round(rect.height))
        })
        pngBuffer = image.toPNG()
      } else if (p.fullPage) {
        // 全页截图：用 Emulation 临时把虚拟视口扩大到整页 contentSize，capturePage
        // 后再清除 override。这是 Electron 下最稳的"截长图"姿势。
        const session = await browserCdpManager.session(uuid)
        const metrics = await session.send<{
          contentSize: { width: number; height: number }
        }>('Page.getLayoutMetrics')
        const width = Math.max(1, Math.ceil(metrics.contentSize.width))
        const height = Math.max(1, Math.ceil(metrics.contentSize.height))
        log.info(`screenshot fullPage: override viewport to ${width}x${height}`)
        await session.send('Emulation.setDeviceMetricsOverride', {
          width,
          height,
          deviceScaleFactor: 0,
          mobile: false
        })
        try {
          // 留一帧让布局在虚拟视口下完成
          await new Promise((r) => setTimeout(r, 120))
          const image = await wc.capturePage()
          pngBuffer = image.toPNG()
        } finally {
          await session.send('Emulation.clearDeviceMetricsOverride').catch(() => {})
        }
      } else {
        // 普通视口截图
        const image = await wc.capturePage()
        pngBuffer = image.toPNG()
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error(`screenshot failed (${shotLabel}): ${msg}`)
      throw new Error(`Failed to capture screenshot (${shotLabel}): ${msg}`)
    }

    if (!pngBuffer || pngBuffer.length === 0) {
      log.error(`screenshot produced empty buffer (${shotLabel})`)
      throw new Error(
        `Screenshot produced empty image (${shotLabel}). The browser view may not be rendered yet — try wait_for before screenshot.`
      )
    }

    const dir = getToolResultsDir(this.sessionId)
    const filename = `screenshot-${Date.now()}.png`
    const absolutePath = join(dir, filename)
    await mkdir(dirname(absolutePath), { recursive: true })
    await writeFile(absolutePath, pngBuffer)
    log.info(`screenshot saved (${shotLabel}): ${absolutePath} (${pngBuffer.length} bytes)`)

    return {
      text: `Screenshot (${shotLabel}) saved to ${absolutePath}\nUse the \`read\` tool on this path when you actually need to view the image.`
    }
  }

  /**
   * 导出 PDF 走 Electron 原生 `printToPDF()`（CDP 在 Electron debugger 里不暴露
   * `Page.printToPDF`）。outputPath 准入校验：无 interactive approval 通道，越界直接拒绝。
   */
  async pdf(p: {
    tabId: string
    outputPath: string
    pageSize?: string
    landscape?: boolean
    scale?: number
  }): Promise<BrowserOpOutput> {
    const { view } = resolveAndActivate(p.tabId)

    // 解析为绝对路径（相对路径按 workspace 解析）+ 准入检查
    const config = resolveProjectConfig(this.sessionId)
    const absolutePath = isAbsolute(p.outputPath)
      ? p.outputPath
      : resolve(config.workingDirectory, p.outputPath)
    const inWorkspace = isPathWithinWorkspace(absolutePath, config.workingDirectory)
    const inReadwriteRef = isPathWithinReadwriteReferenceDirs(absolutePath, config.referenceDirs)
    if (!inWorkspace && !inReadwriteRef) {
      const error = `outputPath "${absolutePath}" is outside the session sandbox (workingDirectory + readwrite referenceDirs).`
      return { text: `Error: ${error}`, details: { error } }
    }

    const ALLOWED_PAGE_SIZES = [
      'A0',
      'A1',
      'A2',
      'A3',
      'A4',
      'A5',
      'A6',
      'Legal',
      'Letter',
      'Tabloid',
      'Ledger'
    ] as const
    type AllowedPageSize = (typeof ALLOWED_PAGE_SIZES)[number]

    let pageSize: Electron.PrintToPDFOptions['pageSize'] = 'A4'
    if (typeof p.pageSize === 'string') {
      const matched = ALLOWED_PAGE_SIZES.find(
        (s) => s.toLowerCase() === p.pageSize!.toLowerCase()
      ) as AllowedPageSize | undefined
      if (!matched) {
        const error = `Unknown pageSize "${p.pageSize}". Allowed: ${ALLOWED_PAGE_SIZES.join(', ')}.`
        return { text: `Error: ${error}`, details: { error } }
      }
      pageSize = matched
    }

    const opts: Electron.PrintToPDFOptions = {
      landscape: p.landscape === true,
      printBackground: true,
      pageSize,
      margins: { marginType: 'custom', top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 },
      // 尊重 HTML 里的 @page 规则（size / margin）——对把 @page 精心布局过的模板，
      // 这能避免 Chrome 用外层 margin 覆盖导致的 1-3mm 溢出、多出一空白页
      preferCSSPageSize: true
    }
    if (typeof p.scale === 'number') opts.scale = p.scale

    const pdfBuffer = await view.webContents.printToPDF(opts)
    await mkdir(dirname(absolutePath), { recursive: true })
    await writeFile(absolutePath, pdfBuffer)

    const sizeLabel = typeof pageSize === 'string' ? pageSize : 'custom'
    return {
      text: `Page exported to PDF: ${absolutePath} (${sizeLabel}${opts.landscape ? ', landscape' : ''})`
    }
  }

  // ── 交互 / 导航 / 调试（委托共享 cdpOps） ──

  async navigate(p: { tabId: string; nav: NavKind; url?: string }): Promise<BrowserOpOutput> {
    const { session } = await this.session(p.tabId)
    return browserCdpOps.navigateOp(session, p.nav, p.url)
  }

  async click(p: { tabId: string; uid: string }): Promise<BrowserOpOutput> {
    const { session } = await this.session(p.tabId)
    return browserCdpOps.clickOp(session, p.uid)
  }

  async fill(p: { tabId: string; uid: string; text: string }): Promise<BrowserOpOutput> {
    const { session } = await this.session(p.tabId)
    return browserCdpOps.fillOp(session, p.uid, p.text)
  }

  async type(p: {
    tabId: string
    text: string
    uid?: string
    submitKey?: string
  }): Promise<BrowserOpOutput> {
    const { session } = await this.session(p.tabId)
    return browserCdpOps.typeOp(session, p.text, p.uid, p.submitKey)
  }

  async pressKey(p: { tabId: string; key: string }): Promise<BrowserOpOutput> {
    const { session } = await this.session(p.tabId)
    return browserCdpOps.pressKeyOp(session, p.key)
  }

  async scroll(p: {
    tabId: string
    direction?: ScrollDirection
    amount?: number
    uid?: string
  }): Promise<BrowserOpOutput> {
    const { session } = await this.session(p.tabId)
    return browserCdpOps.scrollOp(session, p)
  }

  async waitFor(p: {
    tabId: string
    text: string
    timeout?: number
    signal?: AbortSignal
  }): Promise<BrowserOpOutput> {
    const { session } = await this.session(p.tabId)
    return browserCdpOps.waitForOp(session, p.text, p.timeout, p.signal)
  }

  async evaluate(p: { tabId: string; expression: string }): Promise<BrowserOpOutput> {
    const { session } = await this.session(p.tabId)
    return browserCdpOps.evaluateOp(session, p.expression)
  }

  async network(p: { tabId: string; limit?: number }): Promise<BrowserOpOutput> {
    const { session } = await this.session(p.tabId)
    return browserCdpOps.networkOp(session, p.limit)
  }

  async console(p: { tabId: string; limit?: number }): Promise<BrowserOpOutput> {
    const { session } = await this.session(p.tabId)
    return browserCdpOps.consoleOp(session, p.limit)
  }

  /** 原生 CDP 逃生口；大结果落盘到 session tool_results（agent 用 read/grep 钻取） */
  async cdp(p: {
    tabId: string
    method: string
    params?: Record<string, unknown>
  }): Promise<BrowserOpOutput> {
    const { session } = await this.session(p.tabId)
    const spill = async (content: string, ext: string): Promise<string> => {
      const dir = getToolResultsDir(this.sessionId)
      const path = join(dir, `cdp-${Date.now()}.${ext}`)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, content)
      return path
    }
    return browserCdpOps.cdpOp(session, p.method, p.params, spill)
  }

  async events(p: {
    tabId: string
    event?: string
    sinceSeq?: number
    limit?: number
  }): Promise<BrowserOpOutput> {
    const { session } = await this.session(p.tabId)
    return browserCdpOps.eventsOp(session, p)
  }
}

/**
 * 工厂：每会话一个 backend 实例（open/close 广播与 screenshot/pdf 落盘路径都要 sessionId）。
 * tab 面板本身是全局单例，多个会话共享同一组 tab 与短号映射。
 */
export function createDesktopBrowserBackend(sessionId: string): BrowserBackend {
  return new DesktopBrowserBackend(sessionId)
}
