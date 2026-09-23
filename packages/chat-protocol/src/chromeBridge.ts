/**
 * Chrome 桥协议 —— 扩展（MV3 service worker）与桌面主进程之间的线协议。
 *
 * 链路：扩展 SW ⇄ 原生消息（stdio，4 字节长度前缀 + JSON）⇄ 本地组件（`cli.js native-host`，
 * Electron 以 node 模式运行）⇄ unix socket / named pipe（一行一条 JSON）⇄ 桌面 chromeBridge 服务。
 * **本地组件是透明转发**：它不解析业务消息，只在两种封帧之间搬运，外加自己报告「桌面连没连上」
 * （`host` 消息）。所以协议只有扩展与桌面两端，定义在这里、两端共用一份。
 *
 * 消息四种形状：
 *  - `request` / `response`：带 id 的一问一答。两个方向都有 —— 桌面向扩展要浏览器操作
 *    （{@link BrowserOpMap}），扩展（侧边栏）向桌面调对话接口（{@link PanelRequestMap}）。
 *  - `event`：单向通知。扩展 → 桌面是浏览器事件（{@link ExtensionEventMap}）；桌面 → 扩展是
 *    会话事件与应用事件（{@link DesktopEventMap}）。
 *  - `chunk`：一条超长消息拆成的片（见 {@link splitBridgeMessage}）。
 *  - `hello` / `welcome`：握手，扩展先说。
 *
 * **为什么要分片**：原生消息里宿主发给 Chrome 的单条消息上限是 1 MB（反方向 64 MiB）。桌面发往
 * 扩展的会话事件里有整张助手卡片、带截图的工具结果，可能超过。分片只在桌面 → 扩展这个方向做，
 * 组装器两端都能用。
 */

/** 协议版本。握手时两边比对，对不上就不接受命令（侧边栏与设置页提示「请更新扩展」） */
export const CHROME_BRIDGE_PROTOCOL = 1

/** 原生消息宿主名（宿主清单文件名 `<name>.json`，扩展 `connectNative(name)`） */
export const CHROME_BRIDGE_HOST_NAME = 'com.shuvix.chrome_bridge'

/**
 * 扩展的固定 id —— 由 `apps/extension/public/manifest.json` 的 `key` 推出（旁加载也固定）。
 * 宿主清单的 `allowed_origins` 写它：Chrome 只为这个扩展拉起本地组件。
 * 与 manifest 的一致性由守护用例钉住。
 */
export const CHROME_EXTENSION_ID = 'ndeoocbnfjcjbaimaogemlkanfbnjaim'

/**
 * 桌面桥服务监听的地址（本地组件去连它）。桌面与 CLI 各自算、必须一致，所以取值口径放在这里；
 * 协议包不引 Node，环境值由调用方传。POSIX 是 `~/.shuvix/chrome-bridge.sock`（0600），
 * Windows 是按用户名区分的 named pipe。
 */
export function chromeBridgeSocketPath(env: {
  home: string
  platform: string
  user: string
  /**
   * Windows 专用的随机后缀（桌面每次启动现生成）。命名管道没有 POSIX 那种 0600：Node 建出来的管道
   * 用的是默认安全描述符，名字又是可猜的，于是「谁都能来敲这个名字」。名字里带上随机后缀、真实
   * 地址写进用户目录下的地址文件（见 {@link chromeBridgeAddressFile}），敲门的前提就变成「读得到
   * 那个文件」——与 token 同一道门。POSIX 不需要它（socket 文件本身就是 0600）。
   */
  nonce?: string
}): string {
  if (env.platform === 'win32') {
    const suffix = env.nonce ? `-${env.nonce}` : ''
    return `\\\\.\\pipe\\shuvix-chrome-bridge-${env.user || 'shuvix'}${suffix}`
  }
  return `${env.home.replace(/\/+$/, '')}/.shuvix/chrome-bridge.sock`
}

/**
 * 桥服务实际监听的地址写在这里（桌面启动时写、退出时删；POSIX 上 0600）。本地组件每次重连都现读它 ——
 * 桌面重启后 Windows 的管道名会变。读不到就回落到 {@link chromeBridgeSocketPath} 的确定地址。
 */
export function chromeBridgeAddressFile(home: string): string {
  return `${home.replace(/\/+$/, '')}/.shuvix/chrome-bridge.addr`
}

/**
 * 本地组件与桌面之间的鉴权行（socket 上的第一行，不属于桥消息、不转给扩展）：
 * 本地组件发 `{ auth: <token> }`，token 即 `~/.shuvix/cli-token`（桌面每次启动重写，0600）；
 * 桌面核对通过回 `{ auth: 'ok' }`，否则直接断开。
 */
export interface BridgeAuthLine {
  auth: string
}

/** Chrome 对「宿主 → 扩展」单条原生消息的上限（字节） */
export const CHROME_NATIVE_MESSAGE_MAX_BYTES = 1024 * 1024

/**
 * 分片时每片取的 JSON 文本长度（UTF-16 码元）。一片的 `data` 是原消息 JSON 文本的一段，
 * 再作为字符串嵌进分片消息：引号 / 反斜杠转义成 2 字节，BMP 非 ASCII 字符 UTF-8 3 字节，
 * 所以一片编码后最多 3 × 300k ≈ 900 KB，加上外壳仍在 1 MB 以内。
 */
export const CHROME_BRIDGE_CHUNK_CHARS = 300_000

// ─────────────────────────── 消息形状 ───────────────────────────

/** 扩展连上后说的第一句 */
export interface BridgeHello {
  type: 'hello'
  protocol: number
  extensionVersion: string
  /** 扩展安装 id（chrome.storage.local）：区分不同浏览器 / profile，跨浏览器重启不变 */
  installId: string
  /** 本轮浏览器运行 id（chrome.storage.session）：浏览器重启即换 */
  runId: string
  /** 浏览器名与版本（userAgentData 能拿到多少给多少，只作展示） */
  browser: string
  /** 此刻开着的全部标签页 id —— 桌面据此清掉标签页已经不在的会话 */
  openTabIds: number[]
}

/** 桌面对 hello 的答复 */
export interface BridgeWelcome {
  type: 'welcome'
  protocol: number
  ok: boolean
  /** ok=false 时的原因（`protocol-mismatch` 等） */
  error?: string
}

export interface BridgeRequest {
  type: 'request'
  id: string
  method: string
  params?: unknown
}

export interface BridgeResponse {
  type: 'response'
  id: string
  ok: boolean
  result?: unknown
  error?: string
}

export interface BridgeEvent {
  type: 'event'
  name: string
  params?: unknown
}

/** 超长消息的一片。`data` 是原消息 JSON 文本的第 `seq` 段（0 起），共 `total` 段 */
export interface BridgeChunk {
  type: 'chunk'
  id: string
  seq: number
  total: number
  data: string
}

/**
 * 本地组件自己发给扩展的状态：桌面此刻连没连上。
 * `offline` 时扩展发出的请求由本地组件直接回错（{@link BRIDGE_ERROR_DESKTOP_OFFLINE}），
 * 侧边栏据此显示「打开 ShuviX 后即可使用」。
 */
export interface BridgeHostStatus {
  type: 'host'
  desktop: 'connected' | 'offline'
}

export type BridgeMessage =
  | BridgeHello
  | BridgeWelcome
  | BridgeRequest
  | BridgeResponse
  | BridgeEvent
  | BridgeChunk
  | BridgeHostStatus

/** 桌面没在运行 —— 本地组件替桌面回的错误码 */
export const BRIDGE_ERROR_DESKTOP_OFFLINE = 'desktop-offline'
/** 协议版本不符 */
export const BRIDGE_ERROR_PROTOCOL_MISMATCH = 'protocol-mismatch'

/**
 * 同一个扩展安装（installId）已经有一条**还活着**的连接 —— 新来的这条被拒。
 *
 * 顶替是静默的话，任何拿到 token 的本地进程报一个已在用的 installId 就能把真浏览器挤下线、
 * 接手它那些标签页会话的历史。所以顶替之前先探一下旧连接还答不答话（`bridge.ping`）：
 * 还答话就拒绝新的；不答话（浏览器关了、本地组件死了）才让位。
 */
export const BRIDGE_ERROR_ALREADY_CONNECTED = 'already-connected'

// ─────────────────────────── 浏览器操作（桌面 → 扩展） ───────────────────────────

/** 扩展交给桌面的标签页快照（chrome.tabs.Tab 的子集） */
export interface ChromeTabInfo {
  id: number
  windowId: number
  title: string
  url: string
  /** 导航进行中时的目标地址（url 还是旧的） */
  pendingUrl?: string
  favIconUrl?: string
  active: boolean
  /** 所属标签组；不在任何组里为 -1（chrome.tabGroups.TAB_GROUP_ID_NONE） */
  groupId: number
  status?: 'loading' | 'complete' | 'unloaded'
  audible?: boolean
}

/** Chrome 标签组的颜色（chrome.tabGroups.ColorEnum） */
export type ChromeGroupColor =
  | 'grey'
  | 'blue'
  | 'red'
  | 'yellow'
  | 'green'
  | 'pink'
  | 'purple'
  | 'cyan'
  | 'orange'

export const CHROME_GROUP_COLORS: readonly ChromeGroupColor[] = [
  'blue',
  'purple',
  'cyan',
  'green',
  'orange',
  'pink',
  'yellow',
  'red',
  'grey'
]

/**
 * 桌面向扩展要的浏览器操作。方法名 → 参数 / 结果。
 * 扩展只是执行者：选哪个标签页、要不要过门，全在桌面。
 */
export interface BrowserOpMap {
  /** 探活：只回 `{ ok: true }`，不碰浏览器。顶替一条连接之前用它确认旧的是不是真的还在 */
  'bridge.ping': { params: Record<string, never>; result: { ok: true } }
  'tabs.list': { params: Record<string, never>; result: ChromeTabInfo[] }
  /** 无副作用（不激活、不 attach）；标签页不存在回 null */
  'tabs.get': { params: { tabId: number }; result: ChromeTabInfo | null }
  /** 在后台开页（不抢焦点）；给了 groupId 就放进那个组 */
  'tabs.create': {
    params: { url: string; groupId?: number; windowId?: number }
    result: ChromeTabInfo
  }
  'tabs.remove': { params: { tabId: number }; result: null }
  /** 等 status=complete（不 attach、不挂调试横幅）；超时回 loaded=false */
  'tabs.waitLoad': { params: { tabId: number; timeoutMs: number }; result: { loaded: boolean } }
  /**
   * 在页面里跑 agent-runtime 的 `extractPage`（chrome.scripting，不挂横幅），回 `ExtractedPage`。
   * 协议包不依赖 agent-runtime，结果形状由桌面按 ExtractedPage 读。
   */
  'page.extract': { params: { tabId: number }; result: unknown }
  /**
   * 确保一个标签组存在并装着这些标签页：groupId 还在就把 tabIds 并进去，不在了（浏览器重启、
   * 用户解散了组）就新建一个。回最终的 groupId。
   */
  'group.ensure': {
    params: { groupId?: number; tabIds: number[]; title: string; color: ChromeGroupColor }
    result: { groupId: number }
  }
  'debugger.attach': { params: { tabId: number }; result: null }
  'debugger.detach': { params: { tabId: number }; result: null }
  'debugger.send': {
    params: { tabId: number; method: string; params?: Record<string, unknown> }
    result: unknown
  }
}

export type BrowserOpName = keyof BrowserOpMap

// ─────────────────────────── 扩展 → 桌面的事件 ───────────────────────────

export interface ExtensionEventMap {
  /** CDP 事件（network / console / events 缓冲的来源） */
  'debugger.event': { tabId: number; method: string; params: Record<string, unknown> }
  /** 调试会话被外部断开（用户点掉横幅、打开了 DevTools、标签页关了） */
  'debugger.detached': { tabId: number; reason: string }
  /** 标签页关了 —— 挂在它上面的会话随之结束 */
  'tabs.removed': { tabId: number }
}

// ─────────────────────────── 侧边栏 → 桌面的请求 ───────────────────────────

/**
 * 侧边栏会转给桌面的单会话对话接口（`SessionChannelApi` 的路径）。**桌面只接这张表里的**，而且每个
 * 带会话的调用都核对会话属于这条连接 —— 桥不是 `window.api` 的远程版：侧边栏只能碰自己标签页的会话。
 *
 * 不在表里的有意为之，侧边栏就地回空：文件浏览与 `@` 引用（`tab` 档案没有文件工具，临时工作区里
 * 没有东西可引）、斜杠命令（技能命令展开的模板会点名这类会话没有的工具）、知识库引用（侧边栏没有
 * 选库的地方）、朗读；子代理 / 子会话（`tab` 档案不带派发与 session 工具）；`bgTask.readLog`（按
 * toolCallId 寻址、无从核对归属，`tab` 档案也没有 bash）。
 */
export const CHROME_PANEL_CHANNEL_PATHS = [
  'agent.init',
  'agent.prompt',
  'agent.steer',
  'agent.followUp',
  'agent.nextTurn',
  'agent.abort',
  'agent.respondToInput',
  'session.getById',
  'message.list',
  'runtime.statuses',
  'bgTask.list',
  'tools.list',
  'tools.presentations',
  'tools.definitions',
  'shuvixMd.validate'
] as const

export type ChromePanelChannelPath = (typeof CHROME_PANEL_CHANNEL_PATHS)[number]

// ─────────────────────────── 随消息带上的标签页 ───────────────────────────

/**
 * 侧边栏输入卡片顶上那排标签页芯片：选中的标签页作为行内 token 带在消息里，
 * `{type: 'tab', id: 'chrome-tab:<tabId>', payload: chromeTabPayload(tab)}`。
 *
 * 桌面从 token 里认出用户选了哪些标签页（`chromeTabIdsOf`），把它们此刻所在的站点记为这条会话
 * 已同意的站点 —— 靠的是 token 的结构，不是去正文里找 `[Chrome tab …]` 字样：那一行里有页面
 * 自己定的标题，谁都能写出一行像模像样的来。
 */
export const CHROME_TAB_TOKEN_TYPE = 'tab'
const CHROME_TAB_TOKEN_ID_PREFIX = 'chrome-tab:'

export function chromeTabTokenId(tabId: number): string {
  return `${CHROME_TAB_TOKEN_ID_PREFIX}${tabId}`
}

/** 一条消息的行内 token 里带着的标签页 id（按出现顺序、去重）；不是标签页 token 的跳过 */
export function chromeTabIdsOf(
  tokens: Record<string, { type?: unknown; id?: unknown } | null | undefined> | null | undefined
): number[] {
  const out: number[] = []
  if (!tokens || typeof tokens !== 'object') return out
  for (const token of Object.values(tokens)) {
    if (!token || token.type !== CHROME_TAB_TOKEN_TYPE || typeof token.id !== 'string') continue
    if (!token.id.startsWith(CHROME_TAB_TOKEN_ID_PREFIX)) continue
    const rest = token.id.slice(CHROME_TAB_TOKEN_ID_PREFIX.length)
    if (!/^[0-9]+$/.test(rest)) continue
    const tabId = Number(rest)
    if (Number.isSafeInteger(tabId) && !out.includes(tabId)) out.push(tabId)
  }
  return out
}

/** 标题 / 地址在那一行里的长度上限（字符） */
const TAB_TITLE_MAX = 120
const TAB_URL_MAX = 500

/** 控制字符与行 / 段分隔符（C0、DEL、C1、U+2028、U+2029）—— 它们能让一行断成两行 */
function isLineBreaking(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029
}

/** 压成一行（控制字符、换行一律换成空格）并截断 —— 按码点截，不劈开 emoji */
function oneLine(text: string, max: number): string {
  let flat = ''
  for (const ch of text) flat += isLineBreaking(ch.codePointAt(0) ?? 0) ? ' ' : ch
  const chars = Array.from(flat.replace(/\s+/g, ' ').trim())
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('')
}

/**
 * 模型看到的那一行：`[Chrome tab 5: "Inbox" — https://mail.example/]`。
 *
 * 标题是页面自己定的，而这一行落在**用户的**消息里 —— 所以压成一行、截断、加引号（JSON 转义），
 * 让它只能读成一个标题，而不是用户接着说的话。
 */
export function chromeTabPayload(tab: { id: number; title: string; url: string }): string {
  const title = oneLine(tab.title ?? '', TAB_TITLE_MAX)
  const url = oneLine(tab.url ?? '', TAB_URL_MAX)
  return `[Chrome tab ${tab.id}: ${title ? JSON.stringify(title) : '(untitled)'} — ${url || '(no address)'}]`
}

/** 侧边栏外观（主题 / 字号 / 专注模式 / 语言）—— 取自桌面设置，侧边栏跟着桌面走 */
export interface ChromePanelAppearance {
  theme: 'dark' | 'light' | 'system'
  darkTheme: string
  lightTheme: string
  fontSize: number
  focusMode: boolean
  language: string
}

export interface PanelRequestMap {
  /** 取（没有就建）挂在这个标签页上的会话。title 是此刻的页面标题，只在新建时用 */
  'tabSession.open': { params: { tabId: number; title?: string }; result: { sessionId: string } }
  /** 调一个单会话对话接口；path 必须在 {@link CHROME_PANEL_CHANNEL_PATHS} 里 */
  'channel.call': { params: { path: ChromePanelChannelPath; args: unknown[] }; result: unknown }
  'panel.appearance': { params: Record<string, never>; result: ChromePanelAppearance }
}

// ─────────────────────────── 桌面 → 扩展的事件 ───────────────────────────

export interface DesktopEventMap {
  /** 一条会话事件（ChatEvent），只发给挂着这条会话的侧边栏 */
  'chat.event': { sessionId: string; event: unknown }
  /** 一条应用事件（AppEvent），已按会话归属过滤 */
  'app.event': { event: unknown }
}

// ─────────────────────────── 设置页看到的状态 ───────────────────────────

/** 一个已握手的浏览器（= 扩展的一个安装） */
export interface ChromeBrowserConnection {
  installId: string
  runId: string
  /** 浏览器名与版本（只作展示） */
  browser: string
  extensionVersion: string
  connectedAt: number
  /** mismatch = 扩展与桌面的协议版本对不上（要更新其中一方） */
  state: 'ready' | 'mismatch'
  protocol: number
}

/** 一次装原生消息宿主的结果 */
export interface ChromeNativeHostInstall {
  /** 启动脚本的路径 */
  launcher: string
  /** 写好 / 已是最新的浏览器 */
  installed: string[]
  /** 失败的浏览器与原因（`*` = 启动脚本本身没写成） */
  failed: Array<{ browser: string; error: string }>
}

/** 设置页（MCP 设置里内置 `chrome` 行的展开区）要的全部状态 */
export interface ChromeExtensionStatus {
  /** 桥服务在监听（本地组件连得进来） */
  listening: boolean
  browsers: ChromeBrowserConnection[]
  /** 最近一次装原生消息宿主的结果（还没装过为 null） */
  install: ChromeNativeHostInstall | null
}

// ─────────────────────────── 分片 ───────────────────────────

/**
 * 把一条消息按需拆成分片。序列化后的 UTF-8 字节数不超过 `maxBytes` 就原样回一条（已序列化的
 * 文本，调用方直接写出）；超过就回若干条分片消息的文本。`newId` 给这组分片一个共享 id。
 *
 * 字节数用调用方给的 `byteLength` 量（桌面是 `Buffer.byteLength`），协议包不绑 Node。
 */
export function splitBridgeMessage(
  message: BridgeMessage,
  opts: {
    newId: () => string
    byteLength: (text: string) => number
    maxBytes?: number
    chunkChars?: number
  }
): string[] {
  const text = JSON.stringify(message)
  const maxBytes = opts.maxBytes ?? CHROME_NATIVE_MESSAGE_MAX_BYTES
  if (opts.byteLength(text) <= maxBytes) return [text]
  const size = opts.chunkChars ?? CHROME_BRIDGE_CHUNK_CHARS
  const total = Math.ceil(text.length / size)
  const id = opts.newId()
  const out: string[] = []
  for (let seq = 0; seq < total; seq++) {
    const chunk: BridgeChunk = {
      type: 'chunk',
      id,
      seq,
      total,
      data: text.slice(seq * size, (seq + 1) * size)
    }
    out.push(JSON.stringify(chunk))
  }
  return out
}

/**
 * 分片组装器：逐条喂分片，收齐一组就回还原出的消息，否则回 null。
 * 同一组分片可能与别的消息交错到达（事件流不停），所以按 id 分开攒。
 */
/**
 * 同时攒着的分片组数上限。正常情况下一条连接上只会有一组在飞（一条消息的各片是连着写出去的），
 * 给到 4 只是留余量；超了就丢最老的那组。
 */
const MAX_PENDING_GROUPS = 4
/** 一组分片的片数上限（`total` 直接用来开数组，不设上限等于让对面决定分配多大） */
const MAX_CHUNK_PARTS = 4096
/** 所有未完成的组加起来能占的字符数上限 —— 永远凑不齐的分片不能把内存撑爆 */
const MAX_PENDING_CHARS = 64 * 1024 * 1024

export class BridgeChunkAssembler {
  private readonly pending = new Map<
    string,
    { total: number; parts: string[]; got: number; chars: number }
  >()
  private chars = 0

  /** @param onDrop 丢掉一组时说一声（上限撞上了、分片自相矛盾）——不给就是静默丢 */
  constructor(private readonly onDrop?: (reason: string) => void) {}

  /**
   * 喂一片；收齐回原消息，未齐回 null。分片与自身声明矛盾（total 变了、seq 越界）时丢掉整组。
   *
   * 三道上限（见常量）：片数、同时攒的组数、攒着的总字符数。对面是什么都可能发 —— 拿到 token 的
   * 本地进程可以一直发永远凑不齐的分片，没有上限就是一条撑爆内存的路。
   */
  push(chunk: BridgeChunk): BridgeMessage | null {
    if (!Number.isInteger(chunk.total) || chunk.total < 1 || chunk.total > MAX_CHUNK_PARTS) {
      return null
    }
    // 片的内容必须是字符串：不是的话既算不了长度也拼不起来 —— 不挡住就是主进程里的一次未捕获异常
    if (typeof chunk.data !== 'string') return null
    // seq 的合法性先于建组 / 挤掉别人判：拿越界的 seq 配个新 id，本来能把正常的组挤出去
    if (!Number.isInteger(chunk.seq) || chunk.seq < 0 || chunk.seq >= chunk.total) {
      if (this.pending.has(chunk.id)) this.drop(chunk.id, 'contradictory chunk')
      return null
    }
    let slot = this.pending.get(chunk.id)
    if (!slot) {
      // 组数超了：丢最老的那组（Map 按插入序）
      while (this.pending.size >= MAX_PENDING_GROUPS) {
        const oldest = this.pending.keys().next()
        if (oldest.done) break
        this.drop(oldest.value, 'too many incomplete chunk groups')
      }
      slot = { total: chunk.total, parts: new Array(chunk.total), got: 0, chars: 0 }
      this.pending.set(chunk.id, slot)
    }
    if (slot.total !== chunk.total) {
      this.drop(chunk.id, 'contradictory chunk')
      return null
    }
    if (slot.parts[chunk.seq] === undefined) {
      slot.parts[chunk.seq] = chunk.data
      slot.got++
      slot.chars += chunk.data.length
      this.chars += chunk.data.length
      // 攒得太多：从最老的开始丢，直到回到上限以内（自己这一组也可能被丢掉）
      while (this.chars > MAX_PENDING_CHARS) {
        const oldest = this.pending.keys().next()
        if (oldest.done) break
        this.drop(oldest.value, 'chunk buffer full')
        if (!this.pending.has(chunk.id)) return null
      }
    }
    if (slot.got < slot.total) return null
    this.drop(chunk.id, '')
    try {
      return JSON.parse(slot.parts.join('')) as BridgeMessage
    } catch {
      return null
    }
  }

  /** 攒着没齐的组数（连接断开时丢弃的就是这些） */
  get pendingCount(): number {
    return this.pending.size
  }

  clear(): void {
    this.pending.clear()
    this.chars = 0
  }

  /** 拿掉一组并退还它占的额度；`reason` 非空表示是被丢掉的（收齐取走时为空） */
  private drop(id: string, reason: string): void {
    const slot = this.pending.get(id)
    if (!slot) return
    this.chars -= slot.chars
    this.pending.delete(id)
    if (reason) this.onDrop?.(`${reason} (id=${id}, ${slot.got}/${slot.total} parts)`)
  }
}

/** 粗检一条收到的 JSON 是不是桥消息（只看 `type`，字段由各分支再核） */
export function isBridgeMessage(value: unknown): value is BridgeMessage {
  if (!value || typeof value !== 'object') return false
  const type = (value as { type?: unknown }).type
  return (
    type === 'hello' ||
    type === 'welcome' ||
    type === 'request' ||
    type === 'response' ||
    type === 'event' ||
    type === 'chunk' ||
    type === 'host'
  )
}
