/**
 * ExtensionBrowserBackend —— 统一 browser 工具的扩展端实现。
 *
 * 操作用户真实已打开的任意标签页（扩展形态的「超能力」，能读登录态 / SPA）：
 *   - tab 管理与读取走 chrome.tabs / chrome.scripting（无调试横幅）；
 *   - 交互/快照/截图/调试走 chrome.debugger CDP（cdpManager per-tab 会话，挂横幅），
 *     操作实现全部委托共享 browserCdpOps（与桌面同一份配方）。
 * 接管的标签页由 tabLease 在轮末自动释放。
 */
import {
  browserCdpOps,
  extractPage,
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
import { cdpManager } from './cdp'

/** 本扩展页面的 URL 前缀（chrome-extension://<id>/）—— 用于识别并保护 ShuviX 自己的标签页 */
const SELF_PREFIX = chrome.runtime.getURL('')

/** 拒绝在 ShuviX 自己的整页标签页上操作（navigate 会把 ShuviX 自身替换掉/销毁 agent 循环） */
async function assertNotSelfTab(tabId: number): Promise<void> {
  let tab: chrome.tabs.Tab
  try {
    tab = await chrome.tabs.get(tabId)
  } catch {
    return // 标签页不存在，交由下游报错
  }
  if (tab.url && tab.url.startsWith(SELF_PREFIX)) {
    throw new Error(
      `Refusing to operate on the ShuviX app tab itself (tab ${tabId}). ` +
        `Use open_tab to open a new page, or target a content tab from list_tabs.`
    )
  }
}

/** 解析统一契约的 string tabId → chrome 的 number tabId，并做自保护检查 */
async function resolveTab(tabId: string): Promise<number> {
  const id = Number(tabId)
  if (!Number.isInteger(id)) {
    throw new Error(`Invalid tabId "${tabId}". Use a tab id from list_tabs / open_tab.`)
  }
  await assertNotSelfTab(id)
  return id
}

class ExtensionBrowserBackend implements BrowserBackend {
  readonly caps: BrowserCaps = {
    pdf: false,
    fullPageScreenshot: false,
    elementScreenshot: false,
    screenshotToFile: false,
    evaluate: true,
    network: true,
    console: true,
    rawCdp: true
  }

  private async session(tabId: string): Promise<TabCdpSession> {
    await resolveTab(tabId)
    const session = await cdpManager.session(String(Number(tabId)))
    // 对话框自动处理（幂等）：alert/confirm 弹出不会卡死自动化链
    await session.enableDialogHandling().catch(() => {})
    return session
  }

  // ── tab 管理 / 读取（chrome.tabs / chrome.scripting，无横幅） ──

  async listTabs(): Promise<BrowserOpOutput> {
    const tabs = await chrome.tabs.query({})
    const lines = tabs
      // 排除 ShuviX 自己的标签页，避免 agent 误把它当内容页操作
      .filter((t) => t.id != null && !(t.url ?? '').startsWith(SELF_PREFIX))
      .map((t) => {
        const flags = [t.active ? 'active' : '', t.audible ? 'audible' : ''].filter(Boolean)
        const tag = flags.length ? ` (${flags.join(', ')})` : ''
        return `[${t.id}]${tag} ${t.title ?? '(untitled)'} — ${t.url ?? ''}`
      })
    return { text: lines.join('\n') || '(no open content tabs)' }
  }

  async openTab(p: { url: string }): Promise<BrowserOpOutput> {
    const tab = await chrome.tabs.create({ url: p.url, active: true })
    return {
      text: `Opened ${p.url} in new tab ${tab.id}. Use read_page/snapshot with this tab id.`,
      details: { url: p.url }
    }
  }

  async closeTab(p: { tabId: string }): Promise<BrowserOpOutput> {
    const id = await resolveTab(p.tabId)
    await chrome.tabs.remove(id)
    return { text: `Closed tab ${id}.` }
  }

  async readPage(p: { tabId: string }): Promise<BrowserOpOutput> {
    const tabId = await resolveTab(p.tabId)
    let extracted: ExtractedPage
    try {
      const [inj] = await chrome.scripting.executeScript({ target: { tabId }, func: extractPage })
      extracted = inj?.result as ExtractedPage
      if (!extracted) throw new Error('no result')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(
        `无法读取标签页 ${tabId}：${msg}。（chrome://、Chrome 应用商店、其他扩展页等受限页面无法注入。）`
      )
    }
    const md = await htmlToMarkdown(extracted.html)
    return { text: formatReadPage(extracted, md) }
  }

  // ── 交互 / 快照 / 调试（chrome.debugger CDP，挂横幅；实现委托共享 cdpOps） ──

  async snapshot(p: { tabId: string }): Promise<BrowserOpOutput> {
    const id = await resolveTab(p.tabId)
    const session = await this.session(p.tabId)
    const pageUrl = (await chrome.tabs.get(id)).url ?? ''
    return browserCdpOps.snapshotOp(session, pageUrl)
  }

  async screenshot(p: { tabId: string }): Promise<BrowserOpOutput> {
    const session = await this.session(p.tabId)
    await session.send('Page.enable').catch(() => {})
    const { data } = await session.send<{ data: string }>('Page.captureScreenshot', {
      format: 'jpeg',
      quality: 60
    })
    return {
      text: `Screenshot of tab ${p.tabId}.`,
      images: [{ data, mimeType: 'image/jpeg' }]
    }
  }

  async navigate(p: { tabId: string; nav: NavKind; url?: string }): Promise<BrowserOpOutput> {
    return browserCdpOps.navigateOp(await this.session(p.tabId), p.nav, p.url)
  }

  async click(p: { tabId: string; uid: string }): Promise<BrowserOpOutput> {
    return browserCdpOps.clickOp(await this.session(p.tabId), p.uid)
  }

  async fill(p: { tabId: string; uid: string; text: string }): Promise<BrowserOpOutput> {
    return browserCdpOps.fillOp(await this.session(p.tabId), p.uid, p.text)
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

  /** 原生 CDP 逃生口。扩展端无沙箱落盘，大结果内联截断（cdpOp 带截断提示） */
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

/** 应用级单例（不绑定会话/项目，对所有会话含临时对话始终可用） */
export const extensionBrowserBackend = new ExtensionBrowserBackend()
