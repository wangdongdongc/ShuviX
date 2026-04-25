/**
 * Browser DevTools Actions — 各 devtools_action 的具体实现
 *
 * 每个 action 是独立的 async 函数，接收 browserCdpService + devtools_params，
 * 返回 AgentToolResult<BrowserToolDetails>。
 */

import { writeFile, mkdir } from 'fs/promises'
import { dirname, isAbsolute, join, resolve } from 'path'
import type { AgentToolResult } from '@mariozechner/pi-agent-core'
import type { BrowserToolDetails } from '../../../shared/types/chatMessage'
import { browserCdpService } from './browserCdpService'
import { getBrowserView } from './browserViewService'
import { assertSandboxWrite, resolveProjectConfig, type ToolContext } from '../toolContext'
import { getToolResultsDir } from '../../utils/paths'
import { createLogger } from '../../logger'

const log = createLogger('Browser:Devtools')

type Result = AgentToolResult<BrowserToolDetails>

// ====== Help 文本 ======

/** DevTools 操作的使用说明（参数错误、tools/browser 的 help action 都会引用） */
export const DEVTOOLS_HELP = `### DevTools Actions (action="devtools", devtools_action=...)

**Observation**
- **snapshot**: Capture accessibility tree with element UIDs. No params.
  Returns indented text tree, e.g. \`uid=e3 button "Submit"\`.
  Always take a snapshot before using click/fill/type.
- **screenshot**: Capture page image. Params: { fullPage?: boolean, uid?: string }.
  The PNG is saved to a session-scoped file under the app's tool_results directory; the tool returns ONLY that absolute path (no inline image data, to keep the conversation context small). Use the \`read\` tool on that path when you actually need to view the screenshot.
- **print_to_pdf**: Render the current page to a PDF file. Params: { outputPath } (required, absolute or workspace-relative).
  Optional: { pageSize: "A4"|"A3"|"A5"|"Letter"|"Legal" (default "A4"), landscape?: boolean, printBackground?: boolean (default true), scale?: number, margin?: { top, bottom, left, right } (inches, default 0.4), preferCSSPageSize?: boolean (default **true** — respect the page's @page CSS; set to false only when you explicitly want outer params to override the CSS) }
  Useful for exporting designed HTML templates (e.g. via the "kami" skill) to print-quality PDF. When the HTML declares @page (size + margin), keep preferCSSPageSize at its default — otherwise Chrome may over-shrink margins and push content onto an extra mostly-blank page.

**Interaction**
- **click**: Click element. Params: { uid } (required). uid comes from snapshot.
- **fill**: Fill input/select. Params: { uid, value } (required)
- **type**: Type into focused element. Params: { text } (required). Optional: { uid, submitKey }
- **press_key**: Press key combo. Params: { key } (required, e.g. "Enter", "Control+A")
- **scroll**: Scroll page. Optional: { direction: "up"|"down"|"left"|"right", amount: 500, uid }

**Navigation**
- **navigate**: Navigate page. Params: { navigateAction: "goto"|"back"|"forward"|"reload", url }

**Evaluation**
- **evaluate**: Execute JavaScript. Params: { expression } (required). Returns JSON result.

**Waiting**
- **wait_for**: Wait for text on page. Params: { text } (required). Optional: { timeout: 10000 }

**Debugging**
- **get_network_requests**: List captured HTTP requests since last navigation.
- **get_console_messages**: List captured console messages since last navigation.

### Typical Workflow
1. browser({ action: "open", url: "..." })
2. browser({ action: "devtools", devtools_action: "snapshot" })
3. browser({ action: "devtools", devtools_action: "click", devtools_params: { uid: "e7" } })
4. browser({ action: "devtools", devtools_action: "screenshot" })`

/** 参数错误时返回错误信息 + devtools 帮助文档 */
function paramError(devtoolsAction: string, message: string): Result {
  return {
    content: [{ type: 'text', text: `Error: ${message}\n\n${DEVTOOLS_HELP}` }],
    details: { type: 'browser', action: 'devtools', devtoolsAction, error: message }
  }
}

// ====== Snapshot ======

export async function snapshotAction(): Promise<Result> {
  const { text, elementCount } = await browserCdpService.buildSnapshot()
  return {
    content: [{ type: 'text', text }],
    details: { type: 'browser', action: 'devtools', devtoolsAction: 'snapshot', elementCount }
  }
}

// ====== Screenshot ======

/**
 * 截取当前浏览器面板页面为 PNG 并落盘到 session 的 tool_results 目录。
 *
 * 走 Electron 原生 `webContents.capturePage()`，不再用 CDP Page.captureScreenshot —
 * 后者在 WebContentsView 上常报 "Unable to capture screenshot"（视图未激活 / 布局未测量）。
 *
 * params:
 *   - fullPage (boolean)：是否截整张页面（含视口外）
 *       通过 Emulation.setDeviceMetricsOverride 把 CDP 虚拟视口扩大到 contentSize 再截
 *   - uid (string)：只截某个元素（从 snapshot 得到的 UID）
 *   - 都没传：截当前视口可见区域
 */
export async function screenshotAction(
  params: Record<string, unknown> = {},
  ctx?: ToolContext
): Promise<Result> {
  if (!ctx) {
    return paramError('screenshot', 'screenshot requires tool context (internal plumbing issue).')
  }
  const view = getBrowserView()
  if (!view) {
    return paramError(
      'screenshot',
      'Browser panel is not open. Use action="open" with a url first.'
    )
  }
  const wc = view.webContents

  const fullPage = params.fullPage === true
  const uid = params.uid as string | undefined
  const shotLabel = uid ? `element uid=${uid}` : fullPage ? 'full page' : 'viewport'
  log.info(`screenshot start: ${shotLabel}`)

  let pngBuffer: Buffer
  try {
    if (uid) {
      // 元素截图：CDP 拿到 bounding rect，再用 capturePage 传 rect 裁剪
      const rect = await browserCdpService.callOnElement<{
        x: number
        y: number
        width: number
        height: number
      }>(
        uid,
        'function(){ const r = this.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }'
      )
      const image = await wc.capturePage({
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.max(1, Math.round(rect.width)),
        height: Math.max(1, Math.round(rect.height))
      })
      pngBuffer = image.toPNG()
    } else if (fullPage) {
      // 全页截图：用 Emulation 临时把虚拟视口扩大到整页 contentSize，capturePage
      // 后再清除 override。这是 Electron 下最稳的"截长图"姿势。
      const metrics = await browserCdpService.sendCommand<{
        contentSize: { width: number; height: number }
        layoutViewport: { clientWidth: number; clientHeight: number }
      }>('Page.getLayoutMetrics')
      const width = Math.max(1, Math.ceil(metrics.contentSize.width))
      const height = Math.max(1, Math.ceil(metrics.contentSize.height))
      log.info(`screenshot fullPage: override viewport to ${width}x${height}`)
      await browserCdpService.sendCommand('Emulation.setDeviceMetricsOverride', {
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
        await browserCdpService.sendCommand('Emulation.clearDeviceMetricsOverride').catch(() => {})
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

  // 统一落盘到 session 的 tool_results 目录 —— 截图往往很大，内联会把对话上下文撑爆
  // agent 需要看时用 `read` 工具读该路径即可
  const dir = getToolResultsDir(ctx.sessionId)
  const filename = `screenshot-${Date.now()}.png`
  const absolutePath = join(dir, filename)
  await mkdir(dirname(absolutePath), { recursive: true })
  await writeFile(absolutePath, pngBuffer)
  log.info(`screenshot saved (${shotLabel}): ${absolutePath} (${pngBuffer.length} bytes)`)

  return {
    content: [
      {
        type: 'text',
        text: `Screenshot (${shotLabel}) saved to ${absolutePath}\nUse the \`read\` tool on this path when you actually need to view the image.`
      }
    ],
    details: { type: 'browser', action: 'devtools', devtoolsAction: 'screenshot' }
  }
}

// ====== Print to PDF ======

/**
 * 将当前浏览器面板的页面导出为 PDF。
 * 走 Electron 原生 `webContents.printToPDF()`（CDP 在 Electron debugger 里不暴露
 * `Page.printToPDF`，会报 "wasn't found"），不依赖 debugger.attach。
 *
 * params:
 *   - outputPath (required): PDF 输出路径（绝对或相对 workspace）
 *   - pageSize: 'A4' | 'A3' | 'A5' | 'Letter' | 'Legal' | 'Tabloid'（默认 A4）
 *               也接受 { width, height }（英寸）
 *   - landscape: boolean（默认 false）
 *   - printBackground: boolean（默认 true）
 *   - scale: number 0.1~2（默认 1）
 *   - margin: { top, bottom, left, right } 英寸（默认 0.4），或 'none' / 'default'
 *   - preferCSSPageSize: boolean（**默认 true**——尊重 HTML 里 @page 规则，pageSize/margin
 *     只作为 CSS 未声明时的 fallback。需要强制外层参数接管时显式传 false）
 */
export async function printToPdfAction(
  params: Record<string, unknown>,
  ctx: ToolContext
): Promise<Result> {
  const outputPath = params.outputPath as string | undefined
  if (!outputPath) {
    return paramError('print_to_pdf', '"outputPath" is required for print_to_pdf action.')
  }

  const view = getBrowserView()
  if (!view) {
    return paramError(
      'print_to_pdf',
      'Browser panel is not open. Use action="open" with a url first.'
    )
  }

  // 解析为绝对路径（相对路径按 workspace 解析）+ 沙箱检查
  const config = resolveProjectConfig(ctx.sessionId)
  const absolutePath = isAbsolute(outputPath)
    ? outputPath
    : resolve(config.workingDirectory, outputPath)
  await assertSandboxWrite(ctx, config, '', 'browser', absolutePath, outputPath)

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

  const rawPageSize = params.pageSize
  let pageSize: Electron.PrintToPDFOptions['pageSize'] = 'A4'
  if (typeof rawPageSize === 'string') {
    const matched = ALLOWED_PAGE_SIZES.find(
      (s) => s.toLowerCase() === rawPageSize.toLowerCase()
    ) as AllowedPageSize | undefined
    if (!matched) {
      return paramError(
        'print_to_pdf',
        `Unknown pageSize "${rawPageSize}". Allowed: ${ALLOWED_PAGE_SIZES.join(', ')}, or pass { width, height } in microns.`
      )
    }
    pageSize = matched
  } else if (
    rawPageSize &&
    typeof rawPageSize === 'object' &&
    typeof (rawPageSize as { width?: unknown }).width === 'number' &&
    typeof (rawPageSize as { height?: unknown }).height === 'number'
  ) {
    pageSize = rawPageSize as { width: number; height: number }
  }

  const rawMargin = params.margin as
    | { top?: number; bottom?: number; left?: number; right?: number }
    | 'none'
    | 'default'
    | undefined

  // Electron 的 margins 语义：marginType = 'default' | 'none' | 'printableArea' | 'custom'
  let margins: Electron.PrintToPDFOptions['margins']
  if (rawMargin === 'none' || rawMargin === 'default') {
    margins = { marginType: rawMargin }
  } else {
    const m = rawMargin ?? {}
    margins = {
      marginType: 'custom',
      top: m.top ?? 0.4,
      bottom: m.bottom ?? 0.4,
      left: m.left ?? 0.4,
      right: m.right ?? 0.4
    }
  }

  const opts: Electron.PrintToPDFOptions = {
    landscape: params.landscape === true,
    printBackground: params.printBackground !== false,
    pageSize,
    margins,
    // 默认尊重 HTML 里的 @page 规则（size / margin）——对 Kami 这种把 @page 精心
    // 布局过的模板，这能避免 Chrome 用外层 margin 覆盖导致的 1-3mm 溢出、多出一空白页
    preferCSSPageSize: params.preferCSSPageSize !== false
  }
  if (typeof params.scale === 'number') opts.scale = params.scale

  const pdfBuffer = await view.webContents.printToPDF(opts)

  await mkdir(dirname(absolutePath), { recursive: true })
  await writeFile(absolutePath, pdfBuffer)

  const sizeLabel = typeof pageSize === 'string' ? pageSize : 'custom'
  const desc = `Page exported to PDF: ${absolutePath} (${sizeLabel}${opts.landscape ? ', landscape' : ''})`
  return {
    content: [{ type: 'text', text: desc }],
    details: { type: 'browser', action: 'devtools', devtoolsAction: 'print_to_pdf' }
  }
}

// ====== Click ======

export async function clickAction(params: Record<string, unknown> = {}): Promise<Result> {
  const uid = params.uid as string | undefined
  if (!uid) {
    return paramError(
      'click',
      '"uid" is required for click action. Get UIDs by calling snapshot first.'
    )
  }

  const { x, y } = await browserCdpService.resolveCoordinates(uid)
  await browserCdpService.sendCommand('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button: 'left',
    clickCount: 1
  })
  await browserCdpService.sendCommand('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button: 'left',
    clickCount: 1
  })

  // 等待一小段时间让页面响应
  await sleep(100)

  const node = browserCdpService['nodeMap'].get(uid)
  const desc = node?.name?.value
    ? `Clicked ${node.role?.value || 'element'} "${node.name.value}" (uid=${uid}).`
    : `Clicked element uid=${uid}.`

  return {
    content: [{ type: 'text', text: desc }],
    details: { type: 'browser', action: 'devtools', devtoolsAction: 'click' }
  }
}

// ====== Fill ======

export async function fillAction(params: Record<string, unknown> = {}): Promise<Result> {
  const uid = params.uid as string | undefined
  const value = params.value as string | undefined
  if (!uid || value == null) {
    return paramError('fill', '"uid" and "value" are required for fill action.')
  }

  // Focus 元素
  await browserCdpService.focusElement(uid)
  // 清空现有值并填入新值
  await browserCdpService.callOnElement<void>(
    uid,
    `function(){ this.value = ''; this.dispatchEvent(new Event('input', { bubbles: true })); }`
  )
  await browserCdpService.sendCommand('Input.insertText', { text: value })
  // 触发 change 事件
  await browserCdpService.callOnElement<void>(
    uid,
    `function(){ this.dispatchEvent(new Event('change', { bubbles: true })); }`
  )

  return {
    content: [{ type: 'text', text: `Filled element uid=${uid} with "${truncate(value, 50)}".` }],
    details: { type: 'browser', action: 'devtools', devtoolsAction: 'fill' }
  }
}

// ====== Type ======

export async function typeAction(params: Record<string, unknown> = {}): Promise<Result> {
  const text = params.text as string | undefined
  const uid = params.uid as string | undefined
  const submitKey = params.submitKey as string | undefined

  if (!text) {
    return paramError('type', '"text" is required for type action.')
  }

  if (uid) {
    await browserCdpService.focusElement(uid)
  }

  await browserCdpService.sendCommand('Input.insertText', { text })

  if (submitKey) {
    await dispatchKey(submitKey)
  }

  const desc = uid
    ? `Typed "${truncate(text, 50)}" into element uid=${uid}.`
    : `Typed "${truncate(text, 50)}".`

  return {
    content: [{ type: 'text', text: desc + (submitKey ? ` Pressed ${submitKey}.` : '') }],
    details: { type: 'browser', action: 'devtools', devtoolsAction: 'type' }
  }
}

// ====== Press Key ======

export async function pressKeyAction(params: Record<string, unknown> = {}): Promise<Result> {
  const key = params.key as string | undefined
  if (!key) {
    return paramError('press_key', '"key" is required for press_key action.')
  }

  await dispatchKey(key)

  return {
    content: [{ type: 'text', text: `Pressed ${key}.` }],
    details: { type: 'browser', action: 'devtools', devtoolsAction: 'press_key' }
  }
}

// ====== Scroll ======

export async function scrollAction(params: Record<string, unknown> = {}): Promise<Result> {
  const direction = (params.direction as string) || 'down'
  const amount = (params.amount as number) || 500
  const uid = params.uid as string | undefined

  let dx = 0
  let dy = 0
  if (direction === 'down') dy = amount
  else if (direction === 'up') dy = -amount
  else if (direction === 'right') dx = amount
  else if (direction === 'left') dx = -amount

  if (uid) {
    await browserCdpService.callOnElement<void>(uid, `function(){ this.scrollBy(${dx}, ${dy}); }`)
  } else {
    await browserCdpService.sendCommand('Runtime.evaluate', {
      expression: `window.scrollBy(${dx}, ${dy})`,
      returnByValue: true
    })
  }

  return {
    content: [{ type: 'text', text: `Scrolled ${direction} by ${amount}px.` }],
    details: { type: 'browser', action: 'devtools', devtoolsAction: 'scroll' }
  }
}

// ====== Evaluate ======

export async function evaluateAction(params: Record<string, unknown> = {}): Promise<Result> {
  const expression = params.expression as string | undefined
  if (!expression) {
    return paramError('evaluate', '"expression" is required for evaluate action.')
  }

  const { result, exceptionDetails } = await browserCdpService.sendCommand<{
    result: { type: string; value?: unknown; description?: string }
    exceptionDetails?: { text: string; exception?: { description?: string } }
  }>('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  })

  if (exceptionDetails) {
    const errMsg = exceptionDetails.exception?.description || exceptionDetails.text
    return {
      content: [{ type: 'text', text: `Error: ${errMsg}` }],
      details: { type: 'browser', action: 'devtools', devtoolsAction: 'evaluate', error: errMsg }
    }
  }

  const text =
    result.value !== undefined
      ? JSON.stringify(result.value, null, 2)
      : result.description || '(undefined)'

  return {
    content: [{ type: 'text', text }],
    details: { type: 'browser', action: 'devtools', devtoolsAction: 'evaluate' }
  }
}

// ====== Wait For ======

export async function waitForAction(params: Record<string, unknown> = {}): Promise<Result> {
  const text = params.text as string | undefined
  const timeout = (params.timeout as number) || 10000

  if (!text) {
    return paramError('wait_for', '"text" is required for wait_for action.')
  }

  const interval = 500
  const maxAttempts = Math.ceil(timeout / interval)
  const escaped = text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")

  for (let i = 0; i < maxAttempts; i++) {
    const { result } = await browserCdpService.sendCommand<{
      result: { value: boolean }
    }>('Runtime.evaluate', {
      expression: `document.body && document.body.innerText.includes('${escaped}')`,
      returnByValue: true
    })
    if (result.value) {
      return {
        content: [{ type: 'text', text: `Found text "${truncate(text, 50)}" on page.` }],
        details: { type: 'browser', action: 'devtools', devtoolsAction: 'wait_for' }
      }
    }
    await sleep(interval)
  }

  return {
    content: [
      { type: 'text', text: `Timeout: text "${truncate(text, 50)}" not found after ${timeout}ms.` }
    ],
    details: { type: 'browser', action: 'devtools', devtoolsAction: 'wait_for', error: 'timeout' }
  }
}

// ====== Navigate ======

export async function navigateAction(params: Record<string, unknown> = {}): Promise<Result> {
  const action = (params.navigateAction as string) || 'goto'
  const url = params.url as string | undefined

  if (action === 'goto') {
    if (!url) {
      return paramError('navigate', '"url" is required for navigate with navigateAction="goto".')
    }
    await browserCdpService.sendCommand('Page.navigate', { url })
    // 等待导航完成
    await sleep(500)
    return {
      content: [{ type: 'text', text: `Navigated to ${url}.` }],
      details: { type: 'browser', action: 'devtools', devtoolsAction: 'navigate', url }
    }
  }

  if (action === 'back') {
    await browserCdpService.sendCommand('Page.navigateToHistoryEntry', await getHistoryEntry(-1))
    await sleep(300)
    return {
      content: [{ type: 'text', text: 'Navigated back.' }],
      details: { type: 'browser', action: 'devtools', devtoolsAction: 'navigate' }
    }
  }

  if (action === 'forward') {
    await browserCdpService.sendCommand('Page.navigateToHistoryEntry', await getHistoryEntry(1))
    await sleep(300)
    return {
      content: [{ type: 'text', text: 'Navigated forward.' }],
      details: { type: 'browser', action: 'devtools', devtoolsAction: 'navigate' }
    }
  }

  if (action === 'reload') {
    await browserCdpService.sendCommand('Page.reload')
    await sleep(500)
    return {
      content: [{ type: 'text', text: 'Page reloaded.' }],
      details: { type: 'browser', action: 'devtools', devtoolsAction: 'navigate' }
    }
  }

  return {
    content: [{ type: 'text', text: `Unknown navigateAction: "${action}".` }],
    details: {
      type: 'browser',
      action: 'devtools',
      devtoolsAction: 'navigate',
      error: 'unknown action'
    }
  }
}

// ====== Network ======

export async function getNetworkRequestsAction(): Promise<Result> {
  await browserCdpService.enableNetworkCapture()
  const entries = browserCdpService.getNetworkRequests()

  if (entries.length === 0) {
    return {
      content: [{ type: 'text', text: 'No network requests captured.' }],
      details: { type: 'browser', action: 'devtools', devtoolsAction: 'get_network_requests' }
    }
  }

  const lines = entries.map((e) => {
    const status = e.failed ? 'FAILED' : (e.status ?? '...')
    const size = e.size != null ? formatBytes(e.size) : ''
    return `[${e.method}] ${status} ${e.url}${size ? ' (' + size + ')' : ''}`
  })

  return {
    content: [{ type: 'text', text: `Network requests (${entries.length}):\n${lines.join('\n')}` }],
    details: { type: 'browser', action: 'devtools', devtoolsAction: 'get_network_requests' }
  }
}

// ====== Console ======

export async function getConsoleMessagesAction(): Promise<Result> {
  await browserCdpService.enableConsoleCapture()
  const entries = browserCdpService.getConsoleMessages()

  if (entries.length === 0) {
    return {
      content: [{ type: 'text', text: 'No console messages captured.' }],
      details: { type: 'browser', action: 'devtools', devtoolsAction: 'get_console_messages' }
    }
  }

  const lines = entries.map((e) => {
    const loc = e.url ? ` (${e.url}${e.lineNumber != null ? ':' + e.lineNumber : ''})` : ''
    return `[${e.type}] ${e.text}${loc}`
  })

  return {
    content: [{ type: 'text', text: `Console messages (${entries.length}):\n${lines.join('\n')}` }],
    details: { type: 'browser', action: 'devtools', devtoolsAction: 'get_console_messages' }
  }
}

// ====== 工具函数 ======

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 3) + '...'
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

// ====== 键盘辅助 ======

/** 常用键的 CDP 描述 */
const KEY_DEFS: Record<string, { key: string; code: string; keyCode: number }> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  Space: { key: ' ', code: 'Space', keyCode: 32 },
  ' ': { key: ' ', code: 'Space', keyCode: 32 }
}

const MODIFIER_KEYS: Record<string, number> = {
  Control: 2,
  Alt: 1,
  Shift: 8,
  Meta: 4
}

/** 分发键盘事件（支持组合键如 "Control+A", "Meta+Shift+R"） */
async function dispatchKey(combo: string): Promise<void> {
  const parts = combo.split('+')
  const mainKey = parts.pop()!
  const modifiers = parts

  // 计算 modifier 位掩码
  let modifierFlags = 0
  for (const mod of modifiers) {
    modifierFlags |= MODIFIER_KEYS[mod] || 0
  }

  // 解析主键
  const def = KEY_DEFS[mainKey]
  const key = def?.key ?? mainKey
  const code = def?.code ?? (mainKey.length === 1 ? `Key${mainKey.toUpperCase()}` : mainKey)
  const keyCode = def?.keyCode ?? mainKey.charCodeAt(0)

  // Press modifier keys
  for (const mod of modifiers) {
    await browserCdpService.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: mod,
      code: `${mod}Left`,
      modifiers: modifierFlags
    })
  }

  // Press main key
  await browserCdpService.sendCommand('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key,
    code,
    keyCode,
    modifiers: modifierFlags
  })
  await browserCdpService.sendCommand('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code,
    keyCode,
    modifiers: modifierFlags
  })

  // Release modifier keys (reverse order)
  for (const mod of modifiers.reverse()) {
    await browserCdpService.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: mod,
      code: `${mod}Left`,
      modifiers: 0
    })
  }
}

/** 获取历史条目 ID（用于 back/forward） */
async function getHistoryEntry(offset: number): Promise<{ entryId: number }> {
  const { currentIndex, entries } = await browserCdpService.sendCommand<{
    currentIndex: number
    entries: Array<{ id: number }>
  }>('Page.getNavigationHistory')
  const target = entries[currentIndex + offset]
  if (!target) throw new Error(`No navigation history entry at offset ${offset}.`)
  return { entryId: target.id }
}
