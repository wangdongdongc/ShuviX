/**
 * CdpAttachManager —— per-tab CDP 会话管理（宿主无关）。
 *
 * 统一桌面（webContents.debugger）与扩展（chrome.debugger）的 attach 生命周期：
 * 懒 attach + 每 tab 一个 TabCdpSession（CdpController UID 映射 + network/console 事件缓冲）。
 * 宿主只注入 CdpTabTransportFactory（真正执行 attach 并返回该 tab 的命令/事件通道），
 * 并在外部断开（用户点掉横幅 / tab 关闭）时回调 handleExternalDetach 清理本地状态。
 */
import { CdpController } from '../cdp/controller'

/** 一个已 attach 标签页的命令/事件通道（宿主实现） */
export interface CdpTabTransport {
  sendCommand<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>
  /** 订阅该 tab 的 CDP 事件流（network/console 采集）；返回退订函数 */
  onEvent(listener: (method: string, params: Record<string, unknown>) => void): () => void
  detach(): Promise<void>
}

export interface CdpTabTransportFactory {
  /** 执行真正的 attach：桌面 wc.debugger.attach('1.3')，扩展 chrome.debugger.attach({tabId},'1.3') */
  attach(tabId: string): Promise<CdpTabTransport>
}

/** 网络请求条目（从桌面 browserCdpService 搬入） */
export interface NetworkEntry {
  id: string
  url: string
  method: string
  status?: number
  mimeType?: string
  timestamp: number
  completed: boolean
  failed: boolean
  size?: number
}

/** 控制台消息条目 */
export interface ConsoleEntry {
  id: number
  type: string // log, error, warn, info, debug
  text: string
  url?: string
  lineNumber?: number
  timestamp: number
}

const MAX_NETWORK_ENTRIES = 200
const MAX_CONSOLE_ENTRIES = 200
const MAX_EVENT_ENTRIES = 1000

/** JSON.stringify 兜底（循环引用等异常返回占位串，避免采集抛错破坏事件流） */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return '[unserializable]'
  }
}
/** 单条事件参数序列化上限（超出截断，避免个别大事件撑爆缓冲） */
const MAX_EVENT_PARAM_CHARS = 4000

/** 通用事件缓冲条目（任意 enable 过的域的事件都落这里，带单调 seq 供增量拉取） */
export interface RawEventEntry {
  seq: number
  method: string
  params: Record<string, unknown>
  /** 参数被截断时的原始字符数（agent 据此知道有省略） */
  truncatedFrom?: number
}

/** 一个 tab 的自动化会话：controller（UID 映射）+ CDP 命令 + 事件缓冲（网络/控制台摘要 + 通用环形） */
export class TabCdpSession {
  readonly controller: CdpController

  private networkEnabled = false
  private consoleEnabled = false
  private networkEntries: NetworkEntry[] = []
  private networkMap = new Map<string, NetworkEntry>() // requestId → entry
  private consoleEntries: ConsoleEntry[] = []
  private consoleCounter = 0
  private unsubscribe: () => void

  // 通用事件环形缓冲：agent 经 cdp 发任意 *.enable 后，该域事件自动进此缓冲，供 events action 增量拉取
  private eventSeq = 0
  private eventBuffer: RawEventEntry[] = []
  /** 对话框自动处理开关（默认自动 dismiss，避免 alert/confirm 卡死自动化链） */
  private autoDismissDialogs = true
  private dialogEnabled = false

  constructor(private transport: CdpTabTransport) {
    this.controller = new CdpController(transport)
    this.unsubscribe = transport.onEvent((method, params) => this.onCdpMessage(method, params))
  }

  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    return this.transport.sendCommand<T>(method, params)
  }

  // ====== 通用事件缓冲 ======

  /** 增量拉取事件：可按事件名（= CDP 方法名）过滤、按 seq 起点过滤、限量（返回最新 limit 条） */
  getEvents(opts: { event?: string; sinceSeq?: number; limit?: number }): {
    entries: RawEventEntry[]
    nextSeq: number
  } {
    let filtered = this.eventBuffer
    if (opts.event) filtered = filtered.filter((e) => e.method === opts.event)
    if (opts.sinceSeq != null) filtered = filtered.filter((e) => e.seq > opts.sinceSeq!)
    const limit = opts.limit ?? 100
    const entries = filtered.slice(-limit)
    return { entries, nextSeq: this.eventSeq }
  }

  /** 确保对话框事件监听已开（attach 后由 backend 调一次；alert/confirm 弹出即自动处理） */
  async enableDialogHandling(): Promise<void> {
    if (this.dialogEnabled) return
    await this.send('Page.enable')
    this.dialogEnabled = true
  }

  /** 设置对话框自动处理策略（false = agent 用 cdp Page.handleJavaScriptDialog 显式接管） */
  setAutoDismissDialogs(on: boolean): void {
    this.autoDismissDialogs = on
  }

  private pushEvent(method: string, params: Record<string, unknown>): void {
    let stored = params
    let truncatedFrom: number | undefined
    const json = safeStringify(params)
    if (json.length > MAX_EVENT_PARAM_CHARS) {
      stored = { _truncated: json.slice(0, MAX_EVENT_PARAM_CHARS) }
      truncatedFrom = json.length
    }
    this.eventBuffer.push({ seq: ++this.eventSeq, method, params: stored, truncatedFrom })
    if (this.eventBuffer.length > MAX_EVENT_ENTRIES) this.eventBuffer.shift()
  }

  // ====== 网络收集 ======

  async enableNetworkCapture(): Promise<void> {
    if (this.networkEnabled) return
    await this.send('Network.enable')
    this.networkEnabled = true
  }

  getNetworkRequests(): NetworkEntry[] {
    return this.networkEntries
  }

  // ====== 控制台收集 ======

  async enableConsoleCapture(): Promise<void> {
    if (this.consoleEnabled) return
    await this.send('Runtime.enable')
    this.consoleEnabled = true
  }

  getConsoleMessages(): ConsoleEntry[] {
    return this.consoleEntries
  }

  // ====== 生命周期 ======

  /** 清理本地状态（不调 transport.detach）—— 外部断开时用 */
  disposeLocal(): void {
    this.unsubscribe()
    this.controller.reset()
    this.networkEntries = []
    this.networkMap.clear()
    this.consoleEntries = []
    this.consoleCounter = 0
    this.networkEnabled = false
    this.consoleEnabled = false
    this.eventBuffer = []
    this.eventSeq = 0
    this.dialogEnabled = false
  }

  /** 主动断开：清理本地状态 + detach transport */
  async dispose(): Promise<void> {
    this.disposeLocal()
    try {
      await this.transport.detach()
    } catch {
      // 可能已被用户取消 / tab 已关闭
    }
  }

  // ====== CDP 事件分发 ======

  private onCdpMessage(method: string, params: Record<string, unknown>): void {
    // 所有事件进通用缓冲（供 events action 增量拉取）
    this.pushEvent(method, params)

    // 对话框自动处理：alert/confirm/beforeunload 弹出即 dismiss，避免卡死后续 CDP 命令。
    // 关掉自动处理时（agent 显式接管）不动，等 agent 用 cdp Page.handleJavaScriptDialog 响应。
    if (method === 'Page.javascriptDialogOpening' && this.autoDismissDialogs) {
      const dtype = String(params.type ?? 'alert')
      // beforeunload accept（放行导航）；alert 无 cancel 语义须 accept；confirm/prompt dismiss
      const accept = dtype === 'beforeunload' || dtype === 'alert'
      void this.send('Page.handleJavaScriptDialog', { accept }).catch(() => {})
    }

    // 网络（预制摘要视图）
    if (method === 'Network.requestWillBeSent') {
      const reqId = params.requestId as string
      const req = params.request as { url: string; method: string }
      const entry: NetworkEntry = {
        id: reqId,
        url: req.url,
        method: req.method,
        timestamp: params.timestamp as number,
        completed: false,
        failed: false
      }
      this.networkMap.set(reqId, entry)
      this.networkEntries.push(entry)
      if (this.networkEntries.length > MAX_NETWORK_ENTRIES) {
        const removed = this.networkEntries.shift()!
        this.networkMap.delete(removed.id)
      }
    } else if (method === 'Network.responseReceived') {
      const reqId = params.requestId as string
      const entry = this.networkMap.get(reqId)
      if (entry) {
        const resp = params.response as { status: number; mimeType: string }
        entry.status = resp.status
        entry.mimeType = resp.mimeType
      }
    } else if (method === 'Network.loadingFinished') {
      const reqId = params.requestId as string
      const entry = this.networkMap.get(reqId)
      if (entry) {
        entry.completed = true
        entry.size = (params.encodedDataLength as number) || 0
      }
    } else if (method === 'Network.loadingFailed') {
      const reqId = params.requestId as string
      const entry = this.networkMap.get(reqId)
      if (entry) {
        entry.completed = true
        entry.failed = true
      }
    }

    // 控制台
    if (method === 'Runtime.consoleAPICalled') {
      const args = params.args as Array<{ type: string; value?: unknown; description?: string }>
      const text = args
        .map((a) => (a.value != null ? String(a.value) : a.description || ''))
        .join(' ')
      const stackTrace = params.stackTrace as
        | { callFrames: Array<{ url: string; lineNumber: number }> }
        | undefined
      const frame = stackTrace?.callFrames?.[0]
      this.consoleEntries.push({
        id: ++this.consoleCounter,
        type: params.type as string,
        text,
        url: frame?.url,
        lineNumber: frame?.lineNumber,
        timestamp: params.timestamp as number
      })
      if (this.consoleEntries.length > MAX_CONSOLE_ENTRIES) {
        this.consoleEntries.shift()
      }
    } else if (method === 'Runtime.exceptionThrown') {
      const details = params.exceptionDetails as {
        text: string
        exception?: { description?: string }
        lineNumber?: number
        url?: string
      }
      this.consoleEntries.push({
        id: ++this.consoleCounter,
        type: 'error',
        text: details.exception?.description || details.text,
        url: details.url,
        lineNumber: details.lineNumber,
        timestamp: params.timestamp as number
      })
      if (this.consoleEntries.length > MAX_CONSOLE_ENTRIES) {
        this.consoleEntries.shift()
      }
    }
  }
}

export class CdpAttachManager {
  private sessions = new Map<string, TabCdpSession>()
  private pending = new Map<string, Promise<TabCdpSession>>()

  constructor(private factory: CdpTabTransportFactory) {}

  /** 懒 attach + 缓存；每 tab 一个 TabCdpSession（并发调用共享同一次 attach） */
  async session(tabId: string): Promise<TabCdpSession> {
    const existing = this.sessions.get(tabId)
    if (existing) return existing
    const inflight = this.pending.get(tabId)
    if (inflight) return inflight

    const attaching = (async () => {
      const transport = await this.factory.attach(tabId)
      const session = new TabCdpSession(transport)
      this.sessions.set(tabId, session)
      return session
    })()
    this.pending.set(tabId, attaching)
    try {
      return await attaching
    } finally {
      this.pending.delete(tabId)
    }
  }

  /** 清掉某 tab 的 UID 状态（导航后调用，避免引用旧 backendNodeId） */
  resetController(tabId: string): void {
    this.sessions.get(tabId)?.controller.reset()
  }

  /** 主动释放某 tab */
  async detach(tabId: string): Promise<void> {
    const session = this.sessions.get(tabId)
    if (!session) return
    this.sessions.delete(tabId)
    await session.dispose()
  }

  /** 释放所有已接管的 tab（扩展轮末租约归零 / 桌面退出时调用） */
  async detachAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((tabId) => this.detach(tabId)))
  }

  /** 外部断开（用户点掉横幅 / 开 DevTools / tab 关闭）→ 只清本地状态 */
  handleExternalDetach(tabId: string): void {
    const session = this.sessions.get(tabId)
    if (!session) return
    this.sessions.delete(tabId)
    session.disposeLocal()
  }

  isAttached(tabId: string): boolean {
    return this.sessions.has(tabId)
  }
}
