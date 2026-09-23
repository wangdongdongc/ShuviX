/**
 * agent 接管的 tab 上两道「别打扰用户」的防护：原生文件选择框、原生打印对话框。
 *
 * 这两样都是 Chromium 自己弹的系统级界面，不走 ShuviX 的任何闸：agent 在后台 tab 里点了上传按钮 /
 * 页面自己调了 window.print()，对话框就会弹在屏幕上、抢走用户正在主窗口里打字的焦点
 * （2026-09-23 实测，Electron 39）。防护只装在 agent 用 CDP 接管过的 tab 上 —— 用户自己开、
 * agent 从没碰过的 tab 行为完全不变。
 *
 * **文件选择框 —— 只拦 agent 的动作**：每次 agent 在 tab 上做动作时打开 CDP 的文件框拦截
 * （`Page.setInterceptFileChooserDialog`，依赖 `Page.enable`，没开的话拦截悄悄不生效），动作结束后
 * 再保持 FILE_CHOOSER_GRACE_MS —— Chromium 的用户激活约 5 秒有效，页面在点击之后异步打开的文件框
 * 也算 agent 的。动作进行中被拦下的记进结果，工具回报里告诉 agent 改用 upload_file；宽限期里被拦下的，
 * 若用户正看着浏览器窗口（多半是用户自己点的），由这里替用户弹原生文件框并把选中的文件交给那个
 * input，否则静默丢弃。其余时间拦截是关着的，用户自己点上传按钮走原生流程。
 *
 * **打印**：window.print 换成一个 CDP binding 调用（需要 `Runtime.enable`，否则 binding 装不进页面；
 * binding 缺席时 print 是空操作而不是退回原生，宁可不打印也不弹框）。两条路一起上：新文档注入脚本
 * （赶在页面脚本之前，含同步新建的无 src iframe），加上每个默认执行上下文出现时再注入一次
 * （`Runtime.enable` 会把接管前就在的上下文重放一遍 —— 接管前就有的 iframe 靠这条）。实测两条一起
 * 覆盖主文档、既有 iframe、同步新建的 iframe 与 document.write 之后的 iframe。收到调用时用户正看着
 * 浏览器窗口就用 webContents.print() 弹打印框，否则丢弃。
 */

import { dialog, type WebContents } from 'electron'
import { createLogger } from '../../logger'
import { browserWindowInFront } from './browserViewService'

const log = createLogger('BrowserGuards')

/** 页面里的 binding 名 —— 注入脚本经它把 print 请求交给主进程 */
export const PRINT_BINDING = '__shuvixPrintRequest'

/**
 * 注入到每个新文档（含 iframe）的脚本：window.print 改走 binding。
 * binding 在**调用时**才取 —— 注入脚本可能先于 binding 安装运行，预先取会取到 undefined。
 */
export const PRINT_OVERRIDE_SOURCE = `(() => {
  const name = ${JSON.stringify(PRINT_BINDING)};
  window.print = function print() {
    const call = globalThis[name];
    if (typeof call === 'function') call('');
  };
})()`

/** agent 动作结束后文件框拦截再保持多久（覆盖 Chromium 约 5 秒的用户激活有效期） */
export const FILE_CHOOSER_GRACE_MS = 5000

/** 一次被拦下的文件框 */
export interface SuppressedChooser {
  mode: 'selectSingle' | 'selectMultiple'
}

interface TabGuard {
  wc: WebContents
  /** agent 动作进行中的层数（同一 tab 的动作由 MCP server 的 tab 队列串行，通常是 0/1） */
  inflight: number
  armed: boolean
  disarmTimer: ReturnType<typeof setTimeout> | null
  /** 进行中的动作各自收集被拦下的文件框 */
  collectors: Set<SuppressedChooser[]>
  onMessage: (event: unknown, method: string, params: Record<string, unknown>) => void
}

const guards = new Map<string, TabGuard>()

function send(g: TabGuard, method: string, params?: Record<string, unknown>): Promise<unknown> {
  return g.wc.debugger.sendCommand(method, params)
}

/** 用户正看着浏览器窗口时替用户弹原生文件框，选中的文件交给那个 input */
async function chooseForUser(g: TabGuard, mode: string, backendNodeId: number): Promise<void> {
  const win = browserWindowInFront()
  if (!win) return
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    properties: mode === 'selectMultiple' ? ['openFile', 'multiSelections'] : ['openFile']
  })
  if (canceled || filePaths.length === 0 || g.wc.isDestroyed()) return
  await send(g, 'DOM.setFileInputFiles', { files: filePaths, backendNodeId })
}

function onFileChooser(g: TabGuard, params: Record<string, unknown>): void {
  const mode = params.mode === 'selectMultiple' ? 'selectMultiple' : 'selectSingle'
  if (g.collectors.size > 0) {
    // agent 的动作打开的：吞掉，记进动作结果
    for (const c of g.collectors) c.push({ mode })
    return
  }
  // 宽限期里：用户正看着浏览器窗口就当是用户自己点的，替他弹框；否则是 agent 动作的后续，丢弃
  if (browserWindowInFront()) {
    void chooseForUser(g, mode, Number(params.backendNodeId)).catch((err) =>
      log.warn('file chooser for the user failed', err)
    )
  } else {
    log.info('file chooser opened while the browser window is not in front: suppressed')
  }
}

/** 页面主世界的执行上下文（每个 frame 一个）一出现就换上 print 改写；隔离世界不管 */
function overrideInContext(g: TabGuard, params: Record<string, unknown>): void {
  const ctx = params.context as { id?: number; auxData?: { isDefault?: boolean } } | undefined
  if (!ctx?.auxData?.isDefault || typeof ctx.id !== 'number') return
  send(g, 'Runtime.evaluate', { expression: PRINT_OVERRIDE_SOURCE, contextId: ctx.id }).catch(
    () => {}
  )
}

function onPrintRequest(g: TabGuard): void {
  if (browserWindowInFront() && !g.wc.isDestroyed()) {
    g.wc.print({}, (ok, reason) => {
      if (!ok && reason && reason !== 'cancelled') log.warn(`print failed: ${reason}`)
    })
    return
  }
  log.info('window.print() while the browser window is not in front: dropped')
}

/**
 * CDP attach 之后装上防护（browserCdpService 的 attach 里调，赶在 agent 的第一个动作 / 第一次导航之前）。
 * 失败只记日志：防护装不上不该让 attach 失败 —— 那样 agent 连页面都操作不了。
 */
export async function installAgentGuards(tabId: string, wc: WebContents): Promise<void> {
  uninstallAgentGuards(tabId)
  const g: TabGuard = {
    wc,
    inflight: 0,
    armed: false,
    disarmTimer: null,
    collectors: new Set(),
    onMessage: (_event, method, params) => {
      if (method === 'Page.fileChooserOpened') onFileChooser(g, params)
      else if (method === 'Runtime.bindingCalled' && params.name === PRINT_BINDING)
        onPrintRequest(g)
      else if (method === 'Runtime.executionContextCreated') overrideInContext(g, params)
    }
  }
  guards.set(tabId, g)
  wc.debugger.on('message', g.onMessage)
  try {
    await send(g, 'Page.enable')
    await send(g, 'Runtime.enable')
    await send(g, 'Runtime.addBinding', { name: PRINT_BINDING })
    await send(g, 'Page.addScriptToEvaluateOnNewDocument', { source: PRINT_OVERRIDE_SOURCE })
  } catch (err) {
    log.warn(`installing agent guards on tab ${tabId} failed`, err)
  }
}

/** 这个 tab 是否装着防护（= agent 接管着它） */
export function hasAgentGuards(tabId: string): boolean {
  return guards.has(tabId)
}

/** detach / tab 关闭时摘掉 */
export function uninstallAgentGuards(tabId: string): void {
  const g = guards.get(tabId)
  if (!g) return
  guards.delete(tabId)
  if (g.disarmTimer) clearTimeout(g.disarmTimer)
  if (!g.wc.isDestroyed()) g.wc.debugger.off('message', g.onMessage)
}

async function arm(g: TabGuard): Promise<void> {
  if (g.disarmTimer) {
    clearTimeout(g.disarmTimer)
    g.disarmTimer = null
  }
  if (g.armed) return
  await send(g, 'Page.setInterceptFileChooserDialog', { enabled: true })
  g.armed = true
}

function scheduleDisarm(tabId: string, g: TabGuard): void {
  if (g.disarmTimer) clearTimeout(g.disarmTimer)
  g.disarmTimer = setTimeout(() => {
    g.disarmTimer = null
    if (g.inflight > 0 || guards.get(tabId) !== g || g.wc.isDestroyed()) return
    g.armed = false
    send(g, 'Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {})
  }, FILE_CHOOSER_GRACE_MS)
}

/**
 * 包一个 agent 动作：动作期间与之后 FILE_CHOOSER_GRACE_MS 内拦文件框。
 * 回动作结果 + 动作进行中被拦下的文件框（调用方据此在工具回报里提示 agent）。
 * 没装防护的 tab（不该发生：动作前必先 attach）原样执行。
 */
export async function withAgentGuards<T>(
  tabId: string,
  op: () => Promise<T>
): Promise<{ result: T; suppressed: SuppressedChooser[] }> {
  const g = guards.get(tabId)
  if (!g) return { result: await op(), suppressed: [] }
  await arm(g).catch((err) => log.warn(`arming the file chooser guard on tab ${tabId} failed`, err))
  const suppressed: SuppressedChooser[] = []
  g.collectors.add(suppressed)
  g.inflight++
  try {
    return { result: await op(), suppressed }
  } finally {
    g.inflight--
    g.collectors.delete(suppressed)
    scheduleDisarm(tabId, g)
  }
}

/** 工具回报里给 agent 的一句提示 */
export function fileChooserNote(suppressed: SuppressedChooser[]): string {
  const multiple = suppressed.some((s) => s.mode === 'selectMultiple')
  return (
    `Note: this opened the page's file chooser (${multiple ? 'multiple files' : 'one file'}). ` +
    'ShuviX suppressed the native file dialog so it cannot pop up on the user’s screen. ' +
    'To attach files, call upload_file on the file input (take a snapshot to find its uid).'
  )
}
