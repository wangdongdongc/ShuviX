/**
 * Chrome 扩展 e2e 的「假 Chrome」—— 桌面这一侧全是真的，只有浏览器是假的。
 *
 * 链路与真实部署逐段相同：假 Chrome 像 Chrome 那样**拉起本地组件**（`cli.js native-host`，
 * Electron 以 node 模式运行），在它的 stdin / stdout 上说原生消息帧（4 字节小端长度 + UTF-8 JSON），
 * 本地组件把每一帧转成一行 JSON 写进 `~/.shuvix/chrome-bridge.sock`，另一头是隔离实例里真的桥服务、
 * Chrome 前端、标签页会话与内置能力服务器 `chrome`。机器上没有 Chromium，这是离真东西最近的一层。
 *
 * **拉起的是安装器写出来的东西**：缺省按桌面启动时写的启动脚本 `~/.shuvix/chrome-bridge/native-host`
 * 拉起（`launcher` 可以换成宿主清单里的 `path` —— 那正是 Chrome 读清单之后做的事），参数是 Chrome
 * 会追加的调用方 origin。于是「安装器写对了没有、token 与 socket 路径两端算得一不一致」都在这一步里
 * 被真实地走一遍，而不是由测试替它拼命令行。
 *
 * 假 Chrome 里是一个很小的内存浏览器：标签页（id / 标题 / 地址 / 窗口 / 组）、`tabs.*`、`group.ensure`、
 * `page.extract`（按标签页当前地址查页面表，回 `{title, url, html}`）、`debugger.*`（记下来、缺省回 `{}`，
 * 个别 CDP 方法由用例挂处理器）。**桌面发来的每一个请求都记下来**：「操作到没到浏览器」一律按这一侧
 * 的记录断，不信工具自己的回报。收到的每一帧（含分片）也按到达顺序记序号，「先 A 后 B」可以断。
 *
 * 行为对齐扩展本身（`apps/extension/src/background/`）：`tabs.remove` 之后像 SW 那样补发 `tabs.removed`；
 * `debugger.attach` 幂等；桌面的分片用与扩展同一个组装器还原。握手不自动做 —— 扩展是收到
 * `host: connected` 才说 hello，用例显式调 `hello()`，时序看得见。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import {
  BridgeChunkAssembler,
  CHROME_BRIDGE_HOST_NAME,
  CHROME_BRIDGE_PROTOCOL,
  CHROME_EXTENSION_ID,
  CHROME_TAB_TOKEN_TYPE,
  chromeTabPayload,
  chromeTabTokenId,
  isBridgeMessage,
  type BridgeMessage,
  type BridgeResponse,
  type BridgeWelcome,
  type ChromeTabInfo
} from '@shuvix/chat-protocol/chromeBridge'
import type { InlineToken } from '@shuvix/chat-protocol/types/chatMessage'
import { makeTokenMarker } from '@shuvix/chat-protocol/utils/inlineTokens'
import { sleep, until } from './cdp'
import type { FakeProvider, FakeTurn } from './fakeProvider'

/** Chrome 拉起本地组件时追加的参数：调用方扩展的 origin */
export const CHROME_EXTENSION_ORIGIN = `chrome-extension://${CHROME_EXTENSION_ID}/`

/** 桌面每次启动写的启动脚本（hostInstaller.launcherPath 的 POSIX 形态） */
export function launcherOf(home: string): string {
  return join(home, '.shuvix', 'chrome-bridge', 'native-host')
}

/** 宿主清单的文件名 */
export const HOST_MANIFEST_FILE = `${CHROME_BRIDGE_HOST_NAME}.json`

/** `mcp__chrome__<tool>` —— 客户端给内置 server 的工具加的前缀 */
export const chromeTool = (tool: string): string => `mcp__chrome__${tool}`

/**
 * 内置能力服务器 `chrome` 的全部工具（桌面 caps：没有 pdf / upload_file —— 扩展的 chrome.debugger
 * 下文件交给网页本就不许，决定下载落点也不归 ShuviX）。
 */
export const CHROME_TOOL_NAMES = [
  'list_tabs',
  'open_tab',
  'close_tab',
  'navigate',
  'snapshot',
  'read_page',
  'screenshot',
  'click',
  'fill',
  'type',
  'press_key',
  'hover',
  'scroll',
  'wait_for',
  'evaluate',
  'network',
  'console',
  'cdp',
  'events',
  'cdp_recipes'
] as const

// ─── 内存浏览器 ─────────────────────────────────────────────────────────

/** 一个假标签页（ChromeTabInfo 的可写版本） */
export interface FakeTab {
  id: number
  windowId: number
  title: string
  url: string
  pendingUrl?: string
  active: boolean
  groupId: number
  status: 'loading' | 'complete'
}

/** 页面表里的一页：`page.extract` 按标签页此刻的地址来这里取 */
export interface FakePage {
  title: string
  /** body 的 innerHTML（extractPage 返回的就是它） */
  html: string
}

/** 桌面发给假 Chrome 的一次浏览器操作 */
export interface ChromeOp {
  /** 全局到达序号（与 chat.event / host 状态同一条序列） */
  seq: number
  method: string
  params: Record<string, unknown>
}

/** 一条收到的会话事件（`chat.event` 的载荷） */
export interface ChromeChatEvent {
  seq: number
  /** 信封上的会话 id —— 桌面按它把事件送给挂着这条会话的侧边栏 */
  sessionId: string
  event: { type: string; sessionId?: string; [key: string]: unknown }
}

/** 一条收到的应用事件（`app.event` 的载荷） */
export interface ChromeAppEvent {
  seq: number
  event: { type: string; [key: string]: unknown }
}

/** 本地组件报给扩展的桌面状态 */
export interface ChromeHostStatus {
  seq: number
  desktop: 'connected' | 'offline'
}

/**
 * 用例挂在某个 CDP 方法上的处理器：回这条命令的结果，可选地在应答之后再推几条 CDP 事件
 * （像真浏览器那样：`Network.enable` 之后才有网络事件）。
 */
export type CdpHandler = (
  params: Record<string, unknown>,
  tabId: number
) => {
  result?: unknown
  events?: Array<{ method: string; params: Record<string, unknown> }>
}

export interface FakeChromeOptions {
  /** 隔离实例的 fake HOME —— 本地组件据它找 token 与 socket（`os.homedir()` 读 $HOME） */
  home: string
  /** 要拉起的程序；缺省 = 桌面写的启动脚本 */
  launcher?: string
  installId: string
  runId?: string
  /** hello 里的浏览器名（只作展示） */
  browser?: string
  extensionVersion?: string
  /** 开局的标签页（id 与窗口可省：id 从 1 起递增，窗口缺省 1） */
  tabs?: Array<Partial<FakeTab> & { url: string }>
  /** 开局的页面表：地址 → 页面 */
  pages?: Record<string, FakePage>
}

export interface FakeChrome {
  readonly installId: string
  readonly runId: string
  readonly browser: string

  // ── 浏览器模型 ──
  tab(id: number): FakeTab | undefined
  tabList(): FakeTab[]
  /** 开一个标签页（只改模型，不发事件 —— 用户手动开的页，扩展不报） */
  addTab(tab: Partial<FakeTab> & { url: string }): FakeTab
  /** 标签页此刻显示的地址 / 标题变了（页面自己跳走、用户点了链接） */
  navigateTab(id: number, url: string, title?: string): void
  /** 标签页关了：从模型里拿掉，并像 SW 那样报 `tabs.removed` */
  closeTab(id: number): void
  setPage(url: string, page: FakePage): void
  /** 给某个 CDP 方法挂处理器（覆盖缺省的 `{}`） */
  onCdp(method: string, handler: CdpHandler): void
  /**
   * 某个浏览器操作**应答发出之后**同步跑一下（在桌面收到应答之前）—— 用来摆出「页面刚被读完就
   * 自己跳走了」这类时序，不靠 sleep 去赌。
   */
  afterOp(method: string, fn: (params: Record<string, unknown>) => void): void
  /** 调试被浏览器这边断开了（用户点掉横幅 / 开了 DevTools）：不再接管，并像 SW 那样报 `debugger.detached` */
  dismissDebugger(tabId: number, reason?: string): void

  // ── 协议 ──
  /** 本地组件报过的桌面状态（按到达顺序） */
  hostStatuses(): ChromeHostStatus[]
  /** 等本地组件报出某个状态（`since` 之后的，缺省从头看） */
  waitHost(
    desktop: 'connected' | 'offline',
    opts?: { since?: number; timeoutMs?: number }
  ): Promise<void>
  /** 说 hello，等 welcome */
  hello(opts?: { protocol?: number; openTabIds?: number[] }): Promise<BridgeWelcome>
  /** 发一个请求，回原样的应答（不论 ok 与否） */
  request(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<BridgeResponse>
  /** 发一个请求，ok 回 result，否则按 error 文本抛错 */
  call<T = unknown>(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<T>
  /** `tabSession.open`（标题缺省取模型里的页面标题），回会话 id */
  openTabSession(tabId: number, title?: string): Promise<string>
  /** `channel.call`，回原样的应答 */
  channel(path: string, ...args: unknown[]): Promise<BridgeResponse>
  /** `channel.call`，ok 回 result，否则抛错 */
  channelCall<T = unknown>(path: string, ...args: unknown[]): Promise<T>
  /**
   * 像侧边栏那样发一条消息：选中的标签页作为行内 token 并进正文（`withTabTokens` 的同一种写法），
   * 经 `channel.call('agent.prompt')` 发出。**不等它跑完**（询问用例里整条链停在等人应答上）——
   * 回这次发送的起点序号与那个应答的 promise。
   */
  prompt(
    sessionId: string,
    text: string,
    opts?: { tabs?: number[] }
  ): { since: number; response: Promise<BridgeResponse> }
  /** 在侧边栏里答一张询问卡片（`agent.respondToInput`） */
  answer(sessionId: string, requestId: string, allowed: boolean): Promise<BridgeResponse>
  /** 推一条扩展事件（`tabs.removed` / `debugger.event` / `debugger.detached`） */
  emitEvent(name: string, params: unknown): void

  // ── 记录 ──
  /** 当前到达序号（单调递增）—— 作为各种 `since` 的起点 */
  mark(): number
  /** 桌面发来的浏览器操作（可按方法、起点过滤） */
  ops(opts?: { method?: string; since?: number }): ChromeOp[]
  /** 等桌面发来某个操作（`match` 进一步筛参数） */
  waitOp(
    method: string,
    opts?: {
      since?: number
      match?: (params: Record<string, unknown>) => boolean
      timeoutMs?: number
    }
  ): Promise<ChromeOp>
  chatEvents(opts?: { sessionId?: string; type?: string; since?: number }): ChromeChatEvent[]
  waitChatEvent(
    type: string,
    opts?: {
      sessionId?: string
      since?: number
      match?: (event: ChromeChatEvent['event']) => boolean
      timeoutMs?: number
    }
  ): Promise<ChromeChatEvent>
  appEvents(opts?: { since?: number }): ChromeAppEvent[]
  /** 收到的每一帧的正文字节数（按到达顺序）—— 「没有一帧超过原生消息上限」按它断 */
  frameSizes(): number[]
  /** 收到的分片帧数 */
  chunkFrames(): number
  /** 本地组件的 stderr（日志只走 stderr：stdout 是帧通道） */
  stderr(): string
  /** 本地组件退出了（退出码；还活着为 null） */
  exitCode(): number | null
  /** 像扩展关掉端口那样收尾：结束 stdin，等本地组件自己退出 */
  close(): Promise<void>
}

/** 进程级兜底回收（beforeAll 中途抛错时 spec 来不及 close） */
const alive = new Set<ChildProcess>()
let reaperInstalled = false
function track(child: ChildProcess): void {
  alive.add(child)
  child.on('exit', () => alive.delete(child))
  if (reaperInstalled) return
  reaperInstalled = true
  process.on('exit', () => {
    for (const c of alive) {
      try {
        c.kill('SIGKILL')
      } catch {
        /* 已退出 */
      }
    }
  })
}

const DEFAULT_TIMEOUT_MS = 30_000

/** 一帧原生消息：4 字节小端长度 + UTF-8 正文 */
function frameOf(text: string): Buffer {
  const body = Buffer.from(text, 'utf8')
  const head = Buffer.alloc(4)
  head.writeUInt32LE(body.length, 0)
  return Buffer.concat([head, body])
}

/**
 * 选中的标签页 → 行内 token（与扩展 `tabSelection.withTabTokens` 同一种写法：uid `ctab<i>`，
 * 标记按选择顺序放在正文前面、空格分隔）。标题与地址取发送这一刻模型里的。
 */
export function withChromeTabTokens(
  text: string,
  tabs: Array<{ id: number; title: string; url: string }>
): { text: string; inlineTokens?: Record<string, InlineToken> } {
  if (tabs.length === 0) return { text }
  const inlineTokens: Record<string, InlineToken> = {}
  const markers: string[] = []
  tabs.forEach((tab, i) => {
    const uid = `ctab${i}`
    inlineTokens[uid] = {
      type: CHROME_TAB_TOKEN_TYPE,
      id: chromeTabTokenId(tab.id),
      displayText: tab.title || tab.url || `tab ${tab.id}`,
      payload: chromeTabPayload(tab),
      name: tab.title || undefined
    }
    markers.push(makeTokenMarker(uid))
  })
  return { text: `${markers.join(' ')} ${text}`, inlineTokens }
}

export function startFakeChrome(opts: FakeChromeOptions): FakeChrome {
  const installId = opts.installId
  const runId = opts.runId ?? 'run-1'
  const browser = opts.browser ?? 'E2E Chrome 1'
  const extensionVersion = opts.extensionVersion ?? '0.0.0-e2e'

  // ── 浏览器模型 ──
  const tabs = new Map<number, FakeTab>()
  const pages = new Map<string, FakePage>(Object.entries(opts.pages ?? {}))
  const cdpHandlers = new Map<string, CdpHandler>()
  const afterOps = new Map<string, (params: Record<string, unknown>) => void>()
  const attached = new Set<number>()
  const groups = new Map<number, { title: string; color: string }>()
  let nextTabId = 1
  let nextGroupId = 100

  const addTab = (tab: Partial<FakeTab> & { url: string }): FakeTab => {
    const id = tab.id ?? nextTabId
    nextTabId = Math.max(nextTabId, id + 1)
    const full: FakeTab = {
      id,
      windowId: tab.windowId ?? 1,
      title: tab.title ?? pages.get(tab.url)?.title ?? '',
      url: tab.url,
      pendingUrl: tab.pendingUrl,
      active: tab.active ?? false,
      groupId: tab.groupId ?? -1,
      status: tab.status ?? 'complete'
    }
    tabs.set(id, full)
    return full
  }
  for (const t of opts.tabs ?? []) addTab(t)

  const infoOf = (t: FakeTab): ChromeTabInfo => ({
    id: t.id,
    windowId: t.windowId,
    title: t.title,
    url: t.url,
    ...(t.pendingUrl ? { pendingUrl: t.pendingUrl } : {}),
    active: t.active,
    groupId: t.groupId,
    status: t.status
  })

  // ── 进程 ──
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: opts.home }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(opts.launcher ?? launcherOf(opts.home), [CHROME_EXTENSION_ORIGIN], {
    env,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  track(child)
  let exitCode: number | null = null
  let exited = false
  let stderrText = ''
  let spawnError = ''
  child.on('exit', (code) => {
    exited = true
    exitCode = code ?? -1
  })
  child.on('error', (err) => {
    spawnError = err.message
    exited = true
    exitCode = -1
  })
  child.stderr?.on('data', (c: Buffer) => (stderrText += c.toString('utf8')))
  // stdin 在进程退出后会 EPIPE —— 那是「写给一个已经退出的本地组件」，不是用例失败
  child.stdin?.on('error', () => undefined)

  // ── 记录 ──
  let seq = 0
  const opsLog: ChromeOp[] = []
  const chatLog: ChromeChatEvent[] = []
  const appLog: ChromeAppEvent[] = []
  const hostLog: ChromeHostStatus[] = []
  const welcomes: Array<{ seq: number; welcome: BridgeWelcome }> = []
  const frameSizes: number[] = []
  let chunkFrames = 0
  const responses = new Map<string, (r: BridgeResponse) => void>()
  const assembler = new BridgeChunkAssembler()
  let reqSeq = 0

  const diag = (): string =>
    `\n--- fake chrome ${installId} (exit=${exitCode}${spawnError ? `, spawn error: ${spawnError}` : ''}) stderr ---\n${stderrText.slice(-1500)}`

  const send = (message: BridgeMessage): void => {
    if (exited || !child.stdin || child.stdin.destroyed) return
    child.stdin.write(frameOf(JSON.stringify(message)))
  }

  const respond = (id: string, run: () => Promise<unknown>, after?: () => void): void => {
    void run().then(
      (result) => {
        send({ type: 'response', id, ok: true, result: result ?? null })
        after?.()
      },
      (err: unknown) =>
        send({
          type: 'response',
          id,
          ok: false,
          error: err instanceof Error ? err.message : String(err)
        })
    )
  }

  const tabOrThrow = (tabId: unknown): FakeTab => {
    const t = typeof tabId === 'number' ? tabs.get(tabId) : undefined
    if (!t) throw new Error(`No tab with id: ${String(tabId)}.`)
    return t
  }

  /** 一条浏览器操作（BrowserOpMap）—— 扩展 browserOps.ts 的假版本 */
  const runOp = async (method: string, p: Record<string, unknown>): Promise<unknown> => {
    switch (method) {
      case 'tabs.list':
        return [...tabs.values()].map(infoOf)
      case 'tabs.get': {
        const t = typeof p.tabId === 'number' ? tabs.get(p.tabId) : undefined
        return t ? infoOf(t) : null
      }
      case 'tabs.create': {
        const url = String(p.url)
        const t = addTab({
          url,
          windowId: typeof p.windowId === 'number' ? p.windowId : 1,
          groupId: typeof p.groupId === 'number' ? p.groupId : -1
        })
        return infoOf(t)
      }
      case 'tabs.remove': {
        const t = tabOrThrow(p.tabId)
        tabs.delete(t.id)
        attached.delete(t.id)
        // 真 Chrome 随后触发 tabs.onRemoved，SW 把它报给桌面
        setTimeout(() => send({ type: 'event', name: 'tabs.removed', params: { tabId: t.id } }), 0)
        return null
      }
      case 'tabs.waitLoad': {
        const t = tabOrThrow(p.tabId)
        t.status = 'complete'
        return { loaded: true }
      }
      case 'page.extract': {
        const t = tabOrThrow(p.tabId)
        const page = pages.get(t.url)
        return {
          title: page?.title ?? t.title,
          url: t.url,
          html: page?.html ?? `<p>${t.title || 'empty page'}</p>`
        }
      }
      case 'group.ensure': {
        const ids = Array.isArray(p.tabIds) ? (p.tabIds as number[]) : []
        let groupId = typeof p.groupId === 'number' ? p.groupId : -1
        if (!groups.has(groupId)) groupId = nextGroupId++
        groups.set(groupId, { title: String(p.title ?? ''), color: String(p.color ?? '') })
        for (const id of ids) {
          const t = tabs.get(id)
          if (t) t.groupId = groupId
        }
        return { groupId }
      }
      case 'debugger.attach': {
        const t = tabOrThrow(p.tabId)
        attached.add(t.id)
        return null
      }
      case 'debugger.detach': {
        attached.delete(Number(p.tabId))
        return null
      }
      case 'debugger.send': {
        const tabId = Number(p.tabId)
        if (!attached.has(tabId))
          throw new Error('Debugger is not attached to the tab with id: ' + tabId + '.')
        const cdpMethod = String(p.method)
        const handler = cdpHandlers.get(cdpMethod)
        if (!handler) return {}
        const out = handler((p.params as Record<string, unknown>) ?? {}, tabId)
        if (out.events?.length) {
          // 应答先走，事件随后 —— 真浏览器也是命令生效之后才开始推这个域的事件
          setTimeout(() => {
            for (const e of out.events ?? []) {
              send({
                type: 'event',
                name: 'debugger.event',
                params: { tabId, method: e.method, params: e.params }
              })
            }
          }, 0)
        }
        return out.result ?? {}
      }
      default:
        throw new Error(`Unknown browser operation "${method}".`)
    }
  }

  const onMessage = (message: BridgeMessage): void => {
    const at = ++seq
    switch (message.type) {
      case 'host':
        hostLog.push({ seq: at, desktop: message.desktop })
        return
      case 'welcome':
        welcomes.push({ seq: at, welcome: message })
        return
      case 'chunk': {
        chunkFrames++
        const whole = assembler.push(message)
        if (whole) onMessage(whole)
        return
      }
      case 'response': {
        const resolve = responses.get(message.id)
        if (resolve) {
          responses.delete(message.id)
          resolve(message)
        }
        return
      }
      case 'request': {
        const params = (message.params ?? {}) as Record<string, unknown>
        opsLog.push({ seq: at, method: message.method, params })
        const after = afterOps.get(message.method)
        respond(
          message.id,
          () => runOp(message.method, params),
          after ? () => after(params) : undefined
        )
        return
      }
      case 'event': {
        if (message.name === 'chat.event') {
          const p = (message.params ?? {}) as {
            sessionId?: string
            event?: ChromeChatEvent['event']
          }
          chatLog.push({
            seq: at,
            sessionId: String(p.sessionId ?? ''),
            event: p.event ?? { type: '?' }
          })
        } else if (message.name === 'app.event') {
          const p = (message.params ?? {}) as { event?: ChromeAppEvent['event'] }
          appLog.push({ seq: at, event: p.event ?? { type: '?' } })
        }
        return
      }
      default:
        return
    }
  }

  // stdout：按帧切（按字节攒齐一帧再解码 —— 不在这一侧制造 U+FFFD）
  let buf: Buffer = Buffer.alloc(0)
  child.stdout?.on('data', (chunk: Buffer) => {
    buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk])
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0)
      if (buf.length < 4 + len) break
      const text = buf.subarray(4, 4 + len).toString('utf8')
      buf = buf.subarray(4 + len)
      frameSizes.push(len)
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        stderrText += `\n[fake chrome] a frame that is not JSON (${len} bytes)`
        continue
      }
      if (isBridgeMessage(parsed)) onMessage(parsed)
    }
  })

  const request = (
    method: string,
    params?: unknown,
    ropts: { timeoutMs?: number } = {}
  ): Promise<BridgeResponse> => {
    const id = `p${++reqSeq}`
    const timeoutMs = ropts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    return new Promise<BridgeResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        responses.delete(id)
        reject(new Error(`fake chrome: no response to "${method}" within ${timeoutMs}ms${diag()}`))
      }, timeoutMs)
      responses.set(id, (r) => {
        clearTimeout(timer)
        resolve(r)
      })
      send({ type: 'request', id, method, params })
    })
  }

  const call = async <T>(
    method: string,
    params?: unknown,
    copts?: { timeoutMs?: number }
  ): Promise<T> => {
    const r = await request(method, params, copts)
    if (!r.ok) throw new Error(r.error ?? 'error')
    return r.result as T
  }

  const channel = (path: string, ...args: unknown[]): Promise<BridgeResponse> =>
    request('channel.call', { path, args })

  const waitHost = async (
    desktop: 'connected' | 'offline',
    wopts: { since?: number; timeoutMs?: number } = {}
  ): Promise<void> => {
    const since = wopts.since ?? 0
    await until(
      () => hostLog.some((h) => h.seq > since && h.desktop === desktop),
      `native host reports desktop ${desktop} (${installId})${diag()}`,
      wopts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    )
  }

  const chatEvents = (
    copts: { sessionId?: string; type?: string; since?: number } = {}
  ): ChromeChatEvent[] =>
    chatLog.filter(
      (e) =>
        e.seq > (copts.since ?? 0) &&
        (copts.sessionId === undefined || e.sessionId === copts.sessionId) &&
        (copts.type === undefined || e.event.type === copts.type)
    )

  return {
    installId,
    runId,
    browser,
    tab: (id) => tabs.get(id),
    tabList: () => [...tabs.values()],
    addTab,
    navigateTab: (id, url, title) => {
      const t = tabs.get(id)
      if (!t) throw new Error(`fake chrome: no tab ${id}`)
      t.url = url
      t.pendingUrl = undefined
      t.title = title ?? pages.get(url)?.title ?? t.title
    },
    closeTab: (id) => {
      tabs.delete(id)
      attached.delete(id)
      send({ type: 'event', name: 'tabs.removed', params: { tabId: id } })
    },
    setPage: (url, page) => pages.set(url, page),
    onCdp: (method, handler) => cdpHandlers.set(method, handler),
    afterOp: (method, fn) => afterOps.set(method, fn),
    dismissDebugger: (tabId, reason = 'canceled_by_user') => {
      attached.delete(tabId)
      send({ type: 'event', name: 'debugger.detached', params: { tabId, reason } })
    },

    hostStatuses: () => [...hostLog],
    waitHost,
    hello: async (hopts = {}) => {
      const since = seq
      send({
        type: 'hello',
        protocol: hopts.protocol ?? CHROME_BRIDGE_PROTOCOL,
        extensionVersion,
        installId,
        runId,
        browser,
        openTabIds: hopts.openTabIds ?? [...tabs.keys()]
      })
      const hit = await until(
        () => welcomes.find((w) => w.seq > since),
        `welcome for ${installId}${diag()}`,
        DEFAULT_TIMEOUT_MS
      )
      return hit.welcome
    },
    request,
    call,
    openTabSession: async (tabId, title) => {
      const r = await call<{ sessionId: string }>('tabSession.open', {
        tabId,
        title: title ?? tabs.get(tabId)?.title
      })
      return r.sessionId
    },
    channel,
    channelCall: async <T>(path: string, ...args: unknown[]): Promise<T> => {
      const r = await channel(path, ...args)
      if (!r.ok) throw new Error(r.error ?? 'error')
      return r.result as T
    },
    prompt: (sessionId, text, popts = {}) => {
      const since = seq
      const selected = (popts.tabs ?? [])
        .map((id) => tabs.get(id))
        .filter((t): t is FakeTab => !!t)
        .map((t) => ({ id: t.id, title: t.title, url: t.pendingUrl || t.url }))
      const merged = withChromeTabTokens(text, selected)
      // 一轮可能跑很久（等人应答），应答要等它跑完才回 —— 上限放宽
      const response = request(
        'channel.call',
        { path: 'agent.prompt', args: [{ sessionId, ...merged }] },
        { timeoutMs: 180_000 }
      )
      // 用例可能不等它；别让一个迟到的拒绝变成未处理的拒绝
      response.catch(() => undefined)
      return { since, response }
    },
    answer: (sessionId, requestId, allowed) =>
      channel('agent.respondToInput', {
        sessionId,
        requestId,
        response: { kind: 'ask', allowed }
      }),
    emitEvent: (name, params) => send({ type: 'event', name, params }),

    mark: () => seq,
    ops: (oopts = {}) =>
      opsLog.filter(
        (o) =>
          o.seq > (oopts.since ?? 0) && (oopts.method === undefined || o.method === oopts.method)
      ),
    waitOp: (method, wopts = {}) =>
      until(
        () =>
          opsLog.find(
            (o) =>
              o.seq > (wopts.since ?? 0) &&
              o.method === method &&
              (!wopts.match || wopts.match(o.params))
          ),
        `desktop asks fake chrome ${installId} for ${method}${diag()}`,
        wopts.timeoutMs ?? DEFAULT_TIMEOUT_MS
      ),
    chatEvents,
    waitChatEvent: (type, wopts = {}) =>
      until(
        () =>
          chatEvents({ sessionId: wopts.sessionId, type, since: wopts.since }).find(
            (e) => !wopts.match || wopts.match(e.event)
          ),
        `chat.event ${type} reaches fake chrome ${installId}${diag()}`,
        wopts.timeoutMs ?? 60_000
      ),
    appEvents: (aopts = {}) => appLog.filter((e) => e.seq > (aopts.since ?? 0)),
    frameSizes: () => [...frameSizes],
    chunkFrames: () => chunkFrames,
    stderr: () => stderrText,
    exitCode: () => exitCode,
    close: async () => {
      if (!exited) child.stdin?.end()
      const t0 = Date.now()
      while (!exited && Date.now() - t0 < 5000) await sleep(50)
      if (!exited) {
        child.kill('SIGKILL')
        const t1 = Date.now()
        while (!exited && Date.now() - t1 < 5000) await sleep(50)
      }
    }
  }
}

// ─── 脚本化运行 ─────────────────────────────────────────────────────────

/** 一次脚本化的工具调用。`tool` 是 chrome 工具的短名（`read_page`）时自动补 `mcp__chrome__` */
export interface ChromeScriptedCall {
  id: string
  tool: string
  args: Record<string, unknown>
}

const chromeToolNameOf = (tool: string): string =>
  (CHROME_TOOL_NAMES as readonly string[]).includes(tool) ? chromeTool(tool) : tool

/**
 * 排一次 agent 运行：`turns` 的每个元素是一轮 LLM 调用（数组 = 这一轮里并发的几个调用），
 * 最后再排一轮收尾文字。用量写小数值，免得轮末触发自动压缩（见 fakeProvider 文件头）。
 */
export function scriptChromeRun(
  provider: FakeProvider,
  turns: Array<ChromeScriptedCall | ChromeScriptedCall[]>,
  closing = 'done'
): void {
  const scripted: FakeTurn[] = turns.map((turn) => ({
    toolCalls: (Array.isArray(turn) ? turn : [turn]).map((c) => ({
      id: c.id,
      name: chromeToolNameOf(c.tool),
      args: JSON.stringify(c.args)
    })),
    usage: { prompt: 90, completion: 6 }
  }))
  scripted.push({ text: closing, usage: { prompt: 110, completion: 4 } })
  provider.script(...scripted)
}

/** 一次调用落定时的 `tool_end`（只声明断言会读的字段） */
export interface ChromeToolEnd {
  type: 'tool_end'
  sessionId: string
  toolCallId: string
  toolName?: string
  result?: string
  isError?: boolean
}

/** 询问卡片（`input_request` 里的请求） */
export interface ChromeAskRequest {
  id: string
  kind: string
  toolName: string
  command: string
  description?: string
  policyPrompt?: { text: string; policies: string[] } | null
}

/** 这次运行里（`since` 之后）按 toolCallId 的 `tool_end` —— 从假 Chrome 收到的 chat.event 里取 */
export function toolEndsOf(
  chrome: FakeChrome,
  sessionId: string,
  since: number
): Record<string, ChromeToolEnd> {
  const out: Record<string, ChromeToolEnd> = {}
  for (const e of chrome.chatEvents({ sessionId, type: 'tool_end', since })) {
    const end = e.event as unknown as ChromeToolEnd
    out[end.toolCallId] = end
  }
  return out
}

/** 等这次运行（`since` 之后）的下一张还没取过的询问卡片 —— 经 chat.event 到达侧边栏的那张 */
export async function waitAsk(
  chrome: FakeChrome,
  sessionId: string,
  since: number,
  taken: Set<string> = new Set()
): Promise<ChromeAskRequest> {
  const hit = await chrome.waitChatEvent('input_request', {
    sessionId,
    since,
    match: (e) => !taken.has((e.request as ChromeAskRequest).id)
  })
  const request = hit.event.request as ChromeAskRequest
  taken.add(request.id)
  return request
}
