/**
 * ChromeBridgeBackend —— 内置能力服务器 `chrome` 的后端：操作**用户真实的 Chrome**，经扩展执行。
 *
 * 每个标签页会话一台（会话挂着哪个标签页、属于哪个浏览器，从会话设置 `chromeTab` 读）：
 *   - tab 管理与读取走扩展的 chrome.tabs / chrome.scripting（不挂调试横幅）；
 *   - 交互 / 快照 / 截图 / 调试走 chrome.debugger 的 CDP 转发，操作实现全部委托共享的
 *     browserCdpOps（与桌面内置浏览器面板同一份配方）。
 *
 * 这是原来扩展里 `runtime/browserBackend.ts` 搬到桌面：扩展从此只执行，不做决定。
 *
 * caps 与原扩展一致：截图内联（没有落盘、全页、元素截图）、没有 pdf、没有 upload_file ——
 * 扩展的 chrome.debugger 下 `DOM.setFileInputFiles` 会回 "Not allowed"。
 */
import {
  browserCdpOps,
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
import { CHROME_GROUP_COLORS, type ChromeTabInfo } from '@shuvix/chat-protocol/chromeBridge'
import { chromeTabOf, type ChromeTabBinding } from '@shuvix/chat-protocol/chromeTabSession'
import { sessionRecords } from '../sessionRecords'
import { chromeBrowserState, requireConnection, type ChromeBrowserState } from './browserState'

export const CHROME_BROWSER_CAPS: BrowserCaps = {
  pdf: false,
  fullPageScreenshot: false,
  elementScreenshot: false,
  screenshotToFile: false,
  evaluate: true,
  network: true,
  console: true,
  rawCdp: true,
  upload: false
}

/** 新开页等加载完成的上限 —— agent 紧接着就会 snapshot，拍到加载一半的页面 uid 马上作废 */
const OPEN_TAB_LOAD_TIMEOUT_MS = 10_000
/** 截图的上限：后台标签页偶尔不出帧，宁可早点报错让 agent 换个做法 */
const SCREENSHOT_TIMEOUT_MS = 20_000
/** 问一个 tab 眼下在哪（站点门要用）：只是一次 chrome.tabs.get，答不上来就是连接出了问题 */
const TAB_URL_TIMEOUT_MS = 10_000

/** 标签组标题里带的页面标题长度 */
const GROUP_TITLE_PAGE_CHARS = 18

/** 会话 id → 稳定的组颜色（同一条会话的组颜色不随重建变） */
export function groupColorFor(sessionId: string): (typeof CHROME_GROUP_COLORS)[number] {
  let h = 0
  for (let i = 0; i < sessionId.length; i++) h = (h * 31 + sessionId.charCodeAt(i)) >>> 0
  return CHROME_GROUP_COLORS[h % CHROME_GROUP_COLORS.length]
}

/** 标签组标题：`ShuviX · <挂着的页的标题>` */
export function groupTitleFor(pageTitle: string | undefined): string {
  const title = (pageTitle ?? '').trim()
  if (!title) return 'ShuviX'
  const short =
    title.length > GROUP_TITLE_PAGE_CHARS ? `${title.slice(0, GROUP_TITLE_PAGE_CHARS - 1)}…` : title
  return `ShuviX · ${short}`
}

/** 一行标签页（给模型看的） */
export function formatTabLine(tab: ChromeTabInfo, tags: string[]): string {
  const flags = [...tags, tab.active ? 'active' : '', tab.audible ? 'audible' : ''].filter(Boolean)
  const tag = flags.length ? ` (${flags.join(', ')})` : ''
  return `[${tab.id}]${tag} ${tab.title || '(untitled)'} — ${tab.pendingUrl || tab.url || ''}`
}

/**
 * list_tabs 的正文：这条对话挂着的页排第一，其次是 agent 自己开的（本会话标签组里的），
 * 再是用户的其它标签页。
 */
export function formatTabList(
  tabs: ChromeTabInfo[],
  opts: { attachedTabId: number; groupId?: number }
): string {
  const attached = tabs.filter((t) => t.id === opts.attachedTabId)
  const own = tabs.filter(
    (t) => t.id !== opts.attachedTabId && opts.groupId !== undefined && t.groupId === opts.groupId
  )
  const rest = tabs.filter((t) => t.id !== opts.attachedTabId && !own.includes(t))
  const lines = [
    ...attached.map((t) => formatTabLine(t, ["this conversation's tab"])),
    ...own.map((t) => formatTabLine(t, ['opened by you'])),
    ...rest.map((t) => formatTabLine(t, []))
  ]
  return lines.join('\n') || '(no open tabs)'
}

export class ChromeBridgeBackend implements BrowserBackend {
  readonly caps = CHROME_BROWSER_CAPS

  constructor(private readonly sessionId: string) {}

  /** 会话挂着的标签页（每次现读：会话设置是事实源） */
  private binding(): ChromeTabBinding {
    const binding = chromeTabOf(sessionRecords.pickSettings(this.sessionId, ['chromeTab']))
    if (!binding) throw new Error('This conversation is not attached to a Chrome tab.')
    return binding
  }

  private state(): ChromeBrowserState {
    return chromeBrowserState(this.binding().installId)
  }

  private conn(): ReturnType<typeof requireConnection> {
    return requireConnection(this.binding().installId)
  }

  /** Chrome 的标签页 id 是非负整数；只认一串数字（`Number('')` 是 0，不能让空串变成 0 号标签页） */
  private tabNumber(tabId: string): number {
    const text = String(tabId).trim()
    const id = Number(text)
    if (!/^[0-9]+$/.test(text) || !Number.isSafeInteger(id)) {
      throw new Error(`Invalid tabId "${tabId}". Use a tab id from list_tabs / open_tab.`)
    }
    return id
  }

  private async session(tabId: string): Promise<TabCdpSession> {
    const id = this.tabNumber(tabId)
    const session = await this.state().cdp.session(String(id))
    // 对话框自动处理（幂等）：alert / confirm 弹出不会卡死自动化链
    await session.enableDialogHandling().catch(() => {})
    return session
  }

  // ── tab 管理 / 读取（chrome.tabs / chrome.scripting，无横幅） ──

  async listTabs(): Promise<BrowserOpOutput> {
    const binding = this.binding()
    const tabs = await this.conn().request('tabs.list', {})
    return {
      text: formatTabList(tabs, {
        attachedTabId: binding.tabId,
        groupId: this.state().groups.get(this.sessionId)
      })
    }
  }

  /**
   * 不 attach —— server 只是想知道这个 tab 眼下显示的是什么，据此按站点问。
   * 没连着 / Chrome 没答上来就抛（门得知道 tab 在哪才能放行）；没有这个 tab 才回 undefined。
   */
  async tabUrl(p: { tabId: string }): Promise<string | undefined> {
    let id: number
    try {
      id = this.tabNumber(p.tabId)
    } catch {
      return undefined // 不是标签页 id：操作自己会以同一句话失败
    }
    const tab = await this.conn().request(
      'tabs.get',
      { tabId: id },
      { timeoutMs: TAB_URL_TIMEOUT_MS }
    )
    return tab ? tab.url || tab.pendingUrl || undefined : undefined
  }

  async openTab(p: { url: string }): Promise<BrowserOpOutput> {
    const binding = this.binding()
    const conn = this.conn()
    const state = this.state()
    const anchor = await conn.request('tabs.get', { tabId: binding.tabId }).catch(() => null)
    const tab = await conn.request('tabs.create', { url: p.url, windowId: anchor?.windowId })
    // 放进本会话的标签组：组还在就并进去，不在了（浏览器重启 / 用户解散）就新建。同一会话串行 ——
    // 并发的两个 open_tab 各自看到「还没有组」，就会建出两个组
    await state
      .joinGroup(this.sessionId, async (current) => {
        const { groupId } = await conn.request('group.ensure', {
          groupId: current,
          tabIds: [tab.id],
          title: groupTitleFor(anchor?.title),
          color: groupColorFor(this.sessionId)
        })
        return groupId
      })
      .catch(() => {
        /* 分组失败不影响开页本身 */
      })
    const { loaded } = await conn
      .request('tabs.waitLoad', { tabId: tab.id, timeoutMs: OPEN_TAB_LOAD_TIMEOUT_MS })
      .catch(() => ({ loaded: false }))
    return {
      text: `Opened ${p.url} in background tab ${tab.id}${loaded ? '' : ' (still loading)'}. Use read_page / snapshot with this tab id.`,
      details: { url: p.url }
    }
  }

  async closeTab(p: { tabId: string }): Promise<BrowserOpOutput> {
    const id = this.tabNumber(p.tabId)
    if (id === this.binding().tabId) {
      throw new Error(
        `Tab ${id} is the tab this conversation is attached to; closing it would end the conversation. Close a different tab.`
      )
    }
    await this.conn().request('tabs.remove', { tabId: id })
    return { text: `Closed tab ${id}.` }
  }

  async readPage(p: { tabId: string }): Promise<BrowserOpOutput> {
    const id = this.tabNumber(p.tabId)
    // 连接 / 挂靠的问题原样抛：下面那句「这类页面读不了」只说页面本身
    const conn = this.conn()
    let extracted: ExtractedPage
    try {
      extracted = (await conn.request('page.extract', { tabId: id })) as ExtractedPage
      if (!extracted || typeof extracted.html !== 'string') throw new Error('no result')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(
        `Cannot read tab ${id}: ${msg}. (chrome:// pages, the Chrome Web Store and other extensions' pages cannot be read.)`
      )
    }
    const md = await htmlToMarkdown(extracted.html)
    return { text: formatReadPage(extracted, md) }
  }

  // ── 交互 / 快照 / 调试（chrome.debugger CDP，挂横幅；实现委托共享 cdpOps） ──

  async snapshot(p: { tabId: string; full?: boolean; viewer?: string }): Promise<BrowserOpOutput> {
    const id = this.tabNumber(p.tabId)
    const session = await this.session(p.tabId)
    const tab = await this.conn().request('tabs.get', { tabId: id })
    return browserCdpOps.snapshotOp(session, tab?.url ?? '', { full: p.full, viewer: p.viewer })
  }

  async screenshot(p: { tabId: string }): Promise<BrowserOpOutput> {
    const session = await this.session(p.tabId)
    await session.send('Page.enable').catch(() => {})
    const shot = session.send<{ data: string }>('Page.captureScreenshot', {
      format: 'jpeg',
      quality: 60
    })
    // 超时先到时，截图那一路之后才失败也不该成为未处理的拒绝
    shot.catch(() => {})
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `Tab ${p.tabId} did not produce a screenshot in time — Chrome may not be rendering it while it is in the background. Use snapshot or read_page instead.`
            )
          ),
        SCREENSHOT_TIMEOUT_MS
      )
    })
    try {
      const { data } = await Promise.race([shot, timeout])
      return {
        text: `Screenshot of tab ${p.tabId}.`,
        images: [{ data, mimeType: 'image/jpeg' }]
      }
    } finally {
      clearTimeout(timer)
    }
  }

  async navigate(p: { tabId: string; nav: NavKind; url?: string }): Promise<BrowserOpOutput> {
    return browserCdpOps.navigateOp(await this.session(p.tabId), p.nav, p.url)
  }

  async click(p: { tabId: string; uid: string }): Promise<BrowserOpOutput> {
    return browserCdpOps.clickOp(await this.session(p.tabId), p.uid)
  }

  async fill(p: { tabId: string; uid: string; text: string }): Promise<BrowserOpOutput> {
    return browserCdpOps.fillOp(await this.session(p.tabId), p.uid, p.text, {
      canUpload: this.caps.upload
    })
  }

  async type(p: {
    tabId: string
    text: string
    uid?: string
    submitKey?: string
  }): Promise<BrowserOpOutput> {
    return browserCdpOps.typeOp(await this.session(p.tabId), p.text, p.uid, p.submitKey)
  }

  async pressKey(p: { tabId: string; key: string }): Promise<BrowserOpOutput> {
    return browserCdpOps.pressKeyOp(await this.session(p.tabId), p.key)
  }

  async hover(p: { tabId: string; uid: string }): Promise<BrowserOpOutput> {
    return browserCdpOps.hoverOp(await this.session(p.tabId), p.uid)
  }

  async scroll(p: {
    tabId: string
    direction?: ScrollDirection
    amount?: number
    uid?: string
  }): Promise<BrowserOpOutput> {
    return browserCdpOps.scrollOp(await this.session(p.tabId), p)
  }

  async waitFor(p: {
    tabId: string
    text: string
    timeout?: number
    signal?: AbortSignal
  }): Promise<BrowserOpOutput> {
    return browserCdpOps.waitForOp(await this.session(p.tabId), p.text, p.timeout, p.signal)
  }

  async evaluate(p: { tabId: string; expression: string }): Promise<BrowserOpOutput> {
    return browserCdpOps.evaluateOp(await this.session(p.tabId), p.expression)
  }

  async network(p: { tabId: string; limit?: number }): Promise<BrowserOpOutput> {
    return browserCdpOps.networkOp(await this.session(p.tabId), p.limit)
  }

  async console(p: { tabId: string; limit?: number }): Promise<BrowserOpOutput> {
    return browserCdpOps.consoleOp(await this.session(p.tabId), p.limit)
  }

  /** 原生 CDP 逃生口。没有落盘语义，大结果内联截断（cdpOp 带截断提示） */
  async cdp(p: {
    tabId: string
    method: string
    params?: Record<string, unknown>
  }): Promise<BrowserOpOutput> {
    return browserCdpOps.cdpOp(await this.session(p.tabId), p.method, p.params)
  }

  async events(p: {
    tabId: string
    event?: string
    sinceSeq?: number
    limit?: number
  }): Promise<BrowserOpOutput> {
    return browserCdpOps.eventsOp(await this.session(p.tabId), p)
  }
}

export function createChromeBrowserBackend(sessionId: string): ChromeBridgeBackend {
  return new ChromeBridgeBackend(sessionId)
}
