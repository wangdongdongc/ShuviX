/**
 * 把裁决（decision.ts）接到 electron 上：询问框、shell.openExternal，以及各窗口的守卫。
 *
 * 应用里通往操作系统的口子不止一个，这里是它们共同的那一道闸：
 *  - 每个自有窗口的弹窗与顶层导航（guardAppWindow）—— 主窗口、设置、悬浮聊天、widget；
 *  - 浏览器面板每个 tab 的弹窗（browserViewService 传 onWeb 自己接管 http(s)）；
 *  - 渲染进程的 `app:open-external`（用户点出来的链接）；
 *  - 页面导航到非网页协议时 Electron 问的 `openExternal` 权限（approveOpenExternalPermission）。
 *
 * 询问节流是进程级的一份（decision.ts 的 createExternalOpenAsk），因为模态框压住的是窗口：
 * 按窗口各算各的，页面多开一个窗口就绕过去了。
 */
import { BrowserWindow, dialog, shell, type WebContents } from 'electron'
import { createLogger } from '../../logger'
import { t } from '../../i18n'
import { clipUrl, createExternalOpenAsk, externalOpenDecision } from './decision'

const log = createLogger('ExternalOpen')

/** 询问框里「谁要开它」那一行；不给就只显示地址 */
export interface ExternalOpenSource {
  /** 文案的 i18n 键（externalOpen.from*）。存键不存译文：窗口可能在用户改语言之前就开着了 */
  labelKey: string
  /** 发起者：页面地址 / widget 名字 */
  value: string
}

export interface ExternalOpenOptions {
  /** 询问框挂在哪个窗口上。没有窗口就问不成，按拒绝处理 */
  parent?: BrowserWindow | null
  source?: ExternalOpenSource
  /** 用户亲手点出来的（`app:open-external`）：询问只保「一次一个」，不设静默期 */
  byUser?: boolean
}

interface AskRequest {
  url: string
  parent: BrowserWindow
  source?: ExternalOpenSource
}

async function confirmExternalOpen({ url, parent, source }: AskRequest): Promise<boolean> {
  if (parent.isDestroyed()) return false
  const lines = [clipUrl(url)]
  if (source) lines.push('', t(source.labelKey), clipUrl(source.value))
  lines.push('', t('externalOpen.hint'))
  const { response } = await dialog.showMessageBox(parent, {
    type: 'warning',
    buttons: [t('externalOpen.open'), t('externalOpen.cancel')],
    defaultId: 1,
    cancelId: 1,
    message: t('externalOpen.title'),
    // 地址与发起者是页面给的字符串，逐行拼接而不走 i18next 插值：插值按首次出现替换占位符，
    // 地址里写一个 `{{…}}` 就能把框里显示的内容顶掉，显示的就不是要打开的那个地址了
    detail: lines.join('\n')
  })
  return response === 0
}

/**
 * 内容触发的询问：拒绝后静默一阵，挡住循环弹窗。
 * 用户点出来的那一档单独一份：一次一个，但不静默 —— 点了取消之后下一次点击还得有反应。
 * 两份各有各的锁，所以「内容的框还开着，用户又在另一个窗口点了一个链接」会有两个框；
 * 这不是循环弹窗（用户那份要真的点一下才有），按可接受处理。
 */
const askFromContent = createExternalOpenAsk(confirmExternalOpen)
const askFromUser = createExternalOpenAsk(confirmExternalOpen, { quietMs: 0 })

function openExternally(url: string): void {
  shell.openExternal(url).catch((err) => log.warn(`openExternal failed: ${clipUrl(url)}`, err))
}

/** `ask` 那一档：问用户。没有窗口就问不成，按拒绝处理 */
async function askUser(url: string, opts: ExternalOpenOptions): Promise<boolean> {
  const { parent } = opts
  if (!parent || parent.isDestroyed()) {
    log.info(`external open not asked, no window: ${clipUrl(url)}`)
    return false
  }
  const ask = opts.byUser ? askFromUser : askFromContent
  const allowed = await ask({ url, parent, source: opts.source })
  if (!allowed) log.info(`external open declined or suppressed: ${clipUrl(url)}`)
  return allowed
}

/**
 * 过闸并执行：`web` 默认交给系统浏览器，面板传 `onWeb` 自己接管（在面板里新开 tab）。
 * 回 true = 这个地址过了闸、交出去了；系统那头能不能接（没有应用认这个协议）不在这里体现，
 * shell.openExternal 失败只记日志。
 *
 * 只有 `ask` 进异步：mailto 要在弹窗 handler 里当场交给系统、http(s) 当场新开 tab，
 * 与这道闸出现之前同一拍，免得把时序差异带进调用方。
 */
export function routeExternalUrl(
  raw: string,
  opts: ExternalOpenOptions & { onWeb?: (url: string) => void } = {}
): Promise<boolean> {
  const decision = externalOpenDecision(raw)
  switch (decision.action) {
    case 'web':
      if (opts.onWeb) opts.onWeb(decision.url)
      else openExternally(decision.url)
      return Promise.resolve(true)
    case 'open':
      openExternally(decision.url)
      return Promise.resolve(true)
    case 'refuse':
      log.info(`external open refused (${decision.reason}): ${clipUrl(raw)}`)
      return Promise.resolve(false)
    case 'ask':
      return askUser(decision.url, opts).then((allowed) => {
        if (allowed) openExternally(decision.url)
        return allowed
      })
  }
}

/**
 * 只过闸、不打开 —— 给权限处理器用：那条路准了之后由 Electron 自己交给系统。
 * `web` 在这条路上不会出现（http(s) 由 Chromium 自己加载），出现了也照放。
 */
export async function approveExternalUrl(
  raw: string,
  opts: ExternalOpenOptions = {}
): Promise<boolean> {
  const decision = externalOpenDecision(raw)
  switch (decision.action) {
    case 'web':
    case 'open':
      return true
    case 'refuse':
      log.info(`external open refused (${decision.reason}): ${clipUrl(raw)}`)
      return false
    case 'ask':
      return askUser(decision.url, opts)
  }
}

/**
 * 是不是开发环境自己那份渲染端地址（`${ELECTRON_RENDERER_URL}#hash` 也算）。
 * 按源比较：前缀比较会把 `http://localhost:5173.evil.example/` 和 `http://localhost:51739/`
 * 一起放行，而这条路放行意味着窗口真的导航过去、preload 照样挂在那个页面上。
 * 每次导航现读环境变量：装守卫的时机与 dev 服务器起来的时机没有固定先后。
 */
function isDevRendererUrl(url: string): boolean {
  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (!rendererUrl) return false
  try {
    return new URL(url).origin === new URL(rendererUrl).origin
  } catch {
    return false
  }
}

/**
 * 给应用自有窗口装上弹窗与顶层导航守卫 —— 主窗口、设置窗口、悬浮聊天窗口、widget 窗口都要装。
 *
 * 窗口里跑的是应用自己的页面，但页面上显示的链接、iframe 里的内容（PDF、widget 里模型写的 HTML）
 * 并不都是我们写的，所以这两条路一律不放行：
 *  - 弹窗（`window.open` / target=_blank，iframe 里发起的也归顶层 webContents）回 deny —— 面板
 *    之外的窗口从不真开新窗口；
 *  - **顶层**导航拦下 —— 否则窗口会被带去外站，而 preload 对新页面照样生效。子框架自己的导航不
 *    走这里（那是 will-frame-navigate），非网页协议的那种由会话权限里的 `openExternal` 兜底。
 *
 * 开发环境的 HMR 地址放行，不然渲染端一刷新就被自己的守卫挡住 —— 比的是**源**而不是前缀：
 * `http://localhost:5173.evil.example/` 也 startsWith 得了 `http://localhost:5173`。
 */
export function guardAppWindow(win: BrowserWindow, source?: ExternalOpenSource): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    void routeExternalUrl(url, { parent: win, source })
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (isDevRendererUrl(url)) return
    event.preventDefault()
    void routeExternalUrl(url, { parent: win, source })
  })
}

/**
 * 会话权限处理器里的 `openExternal` 分支：页面**导航**到非网页协议时 Electron 走这条路来问，
 * 准了就由它自己交给系统（不经 shell.openExternal），所以这里只答应不应答就等于放行。
 * 主窗口那份页面 CSP 的 `frame-src` 目前已经挡住了 iframe 往自定义协议跳，这道闸是它之外的兜底。
 */
export async function approveOpenExternalPermission(
  webContents: WebContents,
  details: { externalURL?: string },
  source?: ExternalOpenSource
): Promise<boolean> {
  const url = details.externalURL
  if (!url) return false
  const parent = BrowserWindow.fromWebContents(webContents)
  return approveExternalUrl(url, { parent, source })
}
