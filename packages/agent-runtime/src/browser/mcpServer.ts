/**
 * 内置能力服务器 `browser` / `chrome` —— 进程内 MCP server，按会话实例化，一份实现跑两台：
 * `browser` 是桌面应用内的浏览器面板，`chrome` 是用户真实的 Chrome（经扩展执行，只有 Chrome
 * 标签页会话才带它）。
 *
 * 差异全在注入里：`BrowserBackend`（内嵌面板 / 经桥转发到扩展）、安全门（`BrowserMcpGates`：
 * 路径怎么解析、走哪条策略、要不要按站点问由宿主决定）、给 list_tabs 的宿主说明，以及 server 名。
 *
 * 用**低层 `Server`** 而不是 `McpServer`：后者的 `registerTool` 要 zod shape，而 zod 只是 SDK 的
 * 传递依赖；低层接口收纯 JSON Schema，与 ssh server、客户端侧的 `jsonSchemaToTypebox` 同一条路。
 *
 * 这台 server 在协议之上加的三件事：
 *  - **安全门**：`file://` 导航、上传的文件、pdf 的输出位置、原生 cdp 里等价的那几个方法，
 *    都先交给宿主的门（见 BrowserMcpGates）。浏览器第一次有了自己的安全客体。在一个正显示本地
 *    文件的 tab 上做任何事，也按读那个文件过门 —— 页面自己跳过去的也算（见 checkDocument）。
 *    宿主给了 site 门时，网页也照此办理：按 tab 此刻所在的站点过门，每个站点每个实例一次。
 *    参数一律在过门之前校验完：用户在询问卡片上点了允许，不该再因为一个类型错误白点。
 *  - **按 tab 排队**：同一个 tab 上的操作串行（两个 agent 同时点同一页、或模型在一条消息里
 *    并发发出同一 tab 的两个动作），不同 tab 互不等待。tab 是宿主全局的，所以队列由宿主给一份
 *    进程级的（BrowserTabQueue），不按会话各建一个。
 *  - **按调用方分账**：一份实例由根 agent 与它派出的 agent 共用；「距上次快照几次操作」与
 *    快照差异的基线都按调用方（`_meta['shuvix.dev/agentId']`）分开 —— 差异的前提是上一份
 *    快照还在**这个模型**的上下文里。
 */
import { Server, type ServerOptions } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult
} from '@modelcontextprotocol/sdk/types.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { BuiltinMcpFactory, BuiltinMcpScope } from '../builtinMcpRegistry'
import {
  PDF_PAGE_SIZES,
  PDF_SCALE_RANGE,
  type BrowserBackend,
  type BrowserCaps,
  type BrowserOpOutput,
  type NavKind,
  type PdfPageSize,
  type ScrollDirection
} from './backend'
import { browserToolSpec, browserToolsForCaps, type BrowserToolName } from './mcpTools'
import { blockedCdpReason } from './cdpPolicy'
import { devtoolsRecipes } from './devtoolsRecipes'

/** `mcp_servers.name` —— 也是客户端给工具名加的前缀（`mcp__browser__click`） */
export const BROWSER_MCP_SERVER_NAME = 'browser'

/**
 * 距上次快照隔多少次操作之内还允许回差异。
 *
 * 差异依赖模型上下文里还留着上一份快照，而自动压缩可能把它删掉、server 无从知道。
 * 隔得越久越危险，所以设一道上限。只数得到**这个调用方**自己的操作，所以是个近似 ——
 * 真正的兜底是输出自证是差异，外加模型可以传 full:true（见 cdp/snapshotDiff.ts）。
 */
const MAX_OPS_FOR_DIFF = 8

/** 一次门检查的上下文 —— 宿主拿它构造询问卡片 */
export interface BrowserGateContext {
  /** pi 那边的 toolCallId（询问卡片的路由键）；客户端没带时 server 自造一个 */
  toolCallId: string
  /** 完整工具名（`mcp__browser__upload_file`）—— 询问卡片与决策日志用 */
  toolName: string
  /** 给询问卡片的一句话：这次访问是去做什么 */
  description?: string
}

/** 站点门的上下文：多一个 tab —— 宿主可能按「是哪个 tab」区别对待（例如会话挂着的那个页） */
export interface BrowserSiteGateContext extends BrowserGateContext {
  tabId: string
}

/**
 * 宿主提供的安全门。**拒绝（deny / 用户取消 / 用户给了反馈）时抛错**，错误文本原样作为这次工具
 * 调用的失败回给模型。不提供某道门 = 这一类访问不设门（no policy = allow）。
 */
export interface BrowserMcpGates {
  /** 导航目标（open_tab / navigate goto / cdp Page.navigate）。`file://` 应当按读那个本地路径处理 */
  navigate?(url: string, ctx: BrowserGateContext): Promise<void>
  /**
   * 在一个显示网页（http / https）的 tab 上做任何事之前，按这个 tab **此刻**所在的站点（host）过门。
   * 给了这道门，server 就按站点记账：一个站点每个实例只过一次门 —— 导航到一个已经放行过的站点也
   * 不再问。不给 = 网页只在导航时过 `navigate`（内置浏览器面板即如此），不按站点记账。
   */
  site?(url: string, ctx: BrowserSiteGateContext): Promise<void>
  /** 将交给网页的本地文件（upload_file / cdp DOM.setFileInputFiles）；返回解析后的绝对路径 */
  fileRead?(path: string, ctx: BrowserGateContext): Promise<string>
  /** 将被写入的本地位置（pdf / cdp Page.setDownloadBehavior）；返回解析后的绝对路径 */
  fileWrite?(path: string, ctx: BrowserGateContext): Promise<string>
}

/**
 * 按 tab 串行的队列。tab 属于整个宿主（桌面的浏览器面板、扩展里用户的 Chrome），每条会话却各有
 * 一台 server —— 队列要是按实例建，两条会话同时操作同一页照样交错。宿主建一份进程级的传给每台。
 */
export interface BrowserTabQueue {
  run<T>(tabId: string, work: () => Promise<T>): Promise<T>
}

export function createBrowserTabQueue(): BrowserTabQueue {
  /** tabId → 该 tab 队尾（落定后自删，不必清理） */
  const tails = new Map<string, Promise<unknown>>()
  return {
    run<T>(tabId: string, work: () => Promise<T>): Promise<T> {
      const prev = tails.get(tabId) ?? Promise.resolve()
      const next = prev.then(work)
      const tail = next.catch(() => {})
      tails.set(tabId, tail)
      void tail.then(() => {
        if (tails.get(tabId) === tail) tails.delete(tabId)
      })
      return next
    }
  }
}

export interface BrowserMcpServerOptions {
  /**
   * `mcp_servers.name`（缺省 `browser`）—— 客户端给工具名加的前缀，也是询问卡片上的工具名。
   * 同一份 server 还跑在 `chrome`（用户真实的 Chrome，经扩展）上。
   */
  serverName?: string
  backend: BrowserBackend
  gates?: BrowserMcpGates
  /** 进程级的 tab 队列（见 BrowserTabQueue）；不给 = 这台 server 自己一份（只在本实例内串行） */
  tabQueue?: BrowserTabQueue
  /** 接在 list_tabs 描述后面的宿主说明（这是谁的浏览器、tab 与登录会不会留着） */
  hostNote?: string
  /** 透传给 SDK Server（扩展：CSP 安全的 jsonSchemaValidator） */
  serverOptions?: Omit<ServerOptions, 'capabilities'>
  /** 连接关闭（会话结束）时回调 */
  onClose?: () => void
}

type Args = Record<string, unknown>

/** 参数不合法 —— 与后端的业务失败一样，作为 isError 结果回给模型 */
class ArgError extends Error {}

function fail(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

/** details.error 置位 = 这次没做成（后端的业务失败不抛错） */
function failed(out: BrowserOpOutput): boolean {
  return !!out.details?.error
}

/** 后端输出 → MCP 结果。没做成的标 isError（客户端据此标红、加前缀） */
function toResult(out: BrowserOpOutput): CallToolResult {
  if (failed(out)) {
    const rawError = out.details!.error
    // 后端的业务失败文案形如「Error: …」；客户端会自己加 [MCP Error]，别叠两层
    const fallback = typeof rawError === 'string' ? rawError : String(rawError)
    return fail((out.text ?? '').replace(/^Error:\s*/, '') || fallback)
  }
  const content: CallToolResult['content'] = [{ type: 'text', text: out.text ?? '' }]
  for (const img of out.images ?? []) {
    content.push({ type: 'image', data: img.data, mimeType: img.mimeType })
  }
  return { content }
}

// ─── 参数读取（宽进：模型偶尔把数字写成字符串）────────────────────────────

function strArg(args: Args, key: string): string | undefined {
  const v = args[key]
  if (v == null) return undefined
  if (typeof v !== 'string') throw new ArgError(`"${key}" must be a string.`)
  return v
}

function numArg(args: Args, key: string): number | undefined {
  const v = args[key]
  if (v == null || (typeof v === 'string' && v.trim() === '')) return undefined
  const n = typeof v === 'string' ? Number(v) : v
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw new ArgError(`"${key}" must be a number.`)
  }
  return n
}

function boolArg(args: Args, key: string): boolean | undefined {
  const v = args[key]
  if (v == null) return undefined
  if (v === true || v === 'true') return true
  if (v === false || v === 'false') return false
  throw new ArgError(`"${key}" must be true or false.`)
}

function enumArg<T extends string>(args: Args, key: string, values: readonly T[]): T | undefined {
  const v = strArg(args, key)
  if (v === undefined || v === '') return undefined
  if (!(values as readonly string[]).includes(v)) {
    throw new ArgError(`"${key}" must be one of ${values.map((x) => `"${x}"`).join(', ')}.`)
  }
  return v as T
}

function stringListArg(args: Args, key: string): string[] {
  const v = args[key]
  if (!Array.isArray(v) || v.length === 0 || v.some((p) => typeof p !== 'string' || !p.trim())) {
    throw new ArgError(`"${key}" must be a non-empty list of file paths.`)
  }
  return v as string[]
}

function objectArg(args: Args, key: string): Record<string, unknown> | undefined {
  const v = args[key]
  if (v == null) return undefined
  if (typeof v !== 'object' || Array.isArray(v)) throw new ArgError(`"${key}" must be an object.`)
  return v as Record<string, unknown>
}

/**
 * 导航目标必须是带协议的绝对地址 —— 门要知道它去哪，后端也只认这种：
 *  - `example.com` 解析不了；`localhost:3000`、`example.com:8080` 解析得了，但「协议」是主机名
 *    —— 桌面会加载失败，扩展则会被 chrome.tabs 当成相对扩展自己的地址打开。
 *  - `javascript:` 不走导航：在页面里跑代码是 evaluate 的事，走这条路就绕开了它的开关与门。
 *  - `view-source:` 不走导航：`view-source:file:///…` 在门眼里是个叫 view-source 的协议，
 *    本地文件就这样绕开了路径门。
 */
function navigationTarget(url: string, caps: BrowserCaps): string {
  let parsed: URL | undefined
  try {
    parsed = new URL(url)
  } catch {
    parsed = undefined
  }
  const scheme = parsed ? parsed.protocol.slice(0, -1) : ''
  const hostAsScheme =
    !!parsed && (scheme.includes('.') || /^\d+(\/|$)/.test(url.slice(scheme.length + 1)))
  if (!parsed || hostAsScheme) {
    const hint = url.includes('://') ? '' : ` — include the scheme, e.g. https://${url}`
    throw new ArgError(`"${url}" is not an absolute URL${hint}.`)
  }
  if (scheme === 'javascript') {
    throw new ArgError(
      `javascript: URLs are not navigated to${caps.evaluate ? ' — run code in the page with evaluate' : ''}.`
    )
  }
  if (scheme === 'view-source') {
    throw new ArgError('view-source: URLs are not opened — open the page itself and read it.')
  }
  return url
}

/**
 * tab 显示的地址若是本地文件（`view-source:` 包着的也算）→ 交给门的地址与去重键；否则 undefined。
 * 去重键去掉 query、片段与结尾斜杠：同一个文件只问一次，浏览器给目录补上的 `/` 也不算新地址。
 */
function localDocument(raw: string | undefined): { url: string; key: string } | undefined {
  if (!raw) return undefined
  let u = raw.trim()
  while (/^view-source:/i.test(u)) u = u.slice('view-source:'.length)
  let parsed: URL
  try {
    parsed = new URL(u)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'file:') return undefined
  parsed.search = ''
  parsed.hash = ''
  return { url: parsed.href, key: parsed.href.replace(/\/+$/, '') }
}

/**
 * 网页地址的站点键（http / https 的 host，小写、去掉结尾的点 —— 与 url 客体同一种写法）；
 * 其余地址（about:blank、chrome://、data: …）没有站点，回 undefined —— 站点门不管它们。
 */
function webSiteOf(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  let parsed: URL
  try {
    parsed = new URL(raw.trim())
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
  const host = parsed.hostname.toLowerCase().replace(/\.+$/, '')
  return host || undefined
}

/** pdf 的纸张：大小写不敏感，回规范写法 */
function pdfPageSize(v: string | undefined): PdfPageSize | undefined {
  if (!v?.trim()) return undefined
  const match = PDF_PAGE_SIZES.find((s) => s.toLowerCase() === v.trim().toLowerCase())
  if (!match) throw new ArgError(`"pageSize" must be one of ${PDF_PAGE_SIZES.join(', ')}.`)
  return match
}

/** 不碰 tab 里文档的工具：不看它眼下显示的是什么（导航只回地址，不回内容） */
const DOCUMENT_FREE: ReadonlySet<BrowserToolName> = new Set<BrowserToolName>([
  'list_tabs',
  'open_tab',
  'close_tab',
  'navigate',
  'cdp_recipes'
])

/** 让一次后端操作与中止信号赛跑 —— 后端 promise 卡住时不能拖住这个 tab 的队列 */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // work 自己随后也会以 Aborted 落定 —— 先接住，别让它成为一条未处理的拒绝
    work.catch(() => {})
    return Promise.reject(new Error('Aborted'))
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Error('Aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

// ─── server ─────────────────────────────────────────────────────────────

/** 造一台 browser server 并接到 transport 上（每条会话一份） */
export async function connectBrowserMcpServer(
  opts: BrowserMcpServerOptions,
  transport: Transport
): Promise<void> {
  const { backend, gates, hostNote } = opts
  const serverName = opts.serverName ?? BROWSER_MCP_SERVER_NAME
  const caps = backend.caps
  const tabQueue = opts.tabQueue ?? createBrowserTabQueue()

  /** [调用方, tabId] → 距这个调用方上次**成功**快照该 tab 的操作数（没有记录 = 很久了） */
  const opsSinceSnapshot = new Map<string, number>()
  /** 这条会话里已经过了门的本地文件（localDocument 的去重键）—— 同一个文件不在每次操作上重复问 */
  const approvedLocal = new Set<string>()
  /** 这条会话里已经过了站点门的 host（只在宿主给了 site 门时记账） */
  const approvedSites = new Set<string>()

  const server = new Server(
    { name: `shuvix-${serverName}`, version: '1.0.0' },
    { ...opts.serverOptions, capabilities: { tools: {} } }
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: browserToolsForCaps(caps, hostNote)
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params.name
    const args = (request.params.arguments ?? {}) as Args
    const meta = request.params._meta as Record<string, unknown> | undefined
    // 客户端把 pi 那边的 toolCallId 放在 `_meta` 里（见 McpManager.callTool）—— 询问卡片用它做
    // 路由键；调用方身份只有内置 server 收得到，缺省为空串（「不区分调用方」）
    const toolCallId =
      typeof meta?.['shuvix.dev/toolCallId'] === 'string'
        ? (meta['shuvix.dev/toolCallId'] as string)
        : `browser-${String(extra.requestId)}`
    const caller =
      typeof meta?.['shuvix.dev/agentId'] === 'string' ? (meta['shuvix.dev/agentId'] as string) : ''

    const spec = browserToolSpec(name, caps)
    if (!spec) return fail(`Unknown tool "${name}".`)
    const missing = spec.required.filter((k) => {
      const v = args[k]
      return v == null || (v === '' && !spec.allowEmpty.includes(k))
    })
    if (missing.length > 0) {
      return fail(
        `Missing required parameter${missing.length > 1 ? 's' : ''} ${missing.map((m) => `"${m}"`).join(', ')}.`
      )
    }

    const tool = name as BrowserToolName
    const gateCtx = (description?: string): BrowserGateContext => ({
      toolCallId,
      toolName: `mcp__${serverName}__${tool}`,
      description
    })
    /**
     * 过一道门，并在放行之后复查取消：一张询问卡片可能挂很久，调用方早已放弃 ——
     * 那时再放行也不能往下做，否则这次被取消的操作会在同一个 tab 的下一次操作中途冒出来。
     */
    const passed = async <T>(gate: Promise<T>): Promise<T> => {
      const value = await gate
      if (extra.signal.aborted) throw new Error('Aborted')
      return value
    }
    /**
     * 导航目标过门；本地文件放行后记下，之后在显示它的 tab 上操作不再重复问。按站点记账时
     * （宿主给了 site 门），已经放行过的站点不再过导航门，放行后的站点也记下。
     */
    const gateNavigation = async (url: string): Promise<void> => {
      const site = gates?.site ? webSiteOf(url) : undefined
      if (site && approvedSites.has(site)) return
      if (gates?.navigate) await passed(gates.navigate(url, gateCtx(`Open ${url}`)))
      const local = localDocument(url)
      if (local) approvedLocal.add(local.key)
      if (site) approvedSites.add(site)
    }
    /**
     * 在一个显示本地文件的 tab 上做任何事，都是在读那个文件 —— 页面自己跳过去的（点了 file://
     * 链接、被 evaluate 改了 location）也一样，所以看的是 tab **此刻**的地址，而不是当初打开的。
     * 只看顶层文档：本地页面里再嵌的 iframe / 图片不在这道门里 —— 这是按工具参数问询的访问控制，
     * 不是沙箱（见 security 模块）。
     */
    const checkDocument = async (tabId: string): Promise<void> => {
      if ((!gates?.navigate && !gates?.site) || !backend.tabUrl) return
      const current = await backend.tabUrl({ tabId })
      const local = localDocument(current)
      if (local) {
        if (!gates?.navigate || approvedLocal.has(local.key)) return
        await passed(
          gates.navigate(local.url, gateCtx(`Read the local file shown in tab ${tabId}`))
        )
        approvedLocal.add(local.key)
        return
      }
      // 网页按站点过门（宿主给了 site 门才有）：页面自己跳去的新站点，也在下一步之前问
      const site = gates?.site ? webSiteOf(current) : undefined
      if (!current || !site || approvedSites.has(site)) return
      await passed(gates!.site!(current, { ...gateCtx(`Use ${site} in tab ${tabId}`), tabId }))
      approvedSites.add(site)
    }
    const cdpGates: CdpGates = {
      navigate: gateNavigation,
      fileRead: gates?.fileRead
        ? (p) => passed(gates.fileRead!(p, gateCtx('Upload to the web page')))
        : undefined,
      fileWrite: gates?.fileWrite
        ? (p) => passed(gates.fileWrite!(p, gateCtx('Save downloads here')))
        : undefined
    }

    const tabId = typeof args.tabId === 'string' ? args.tabId : ''
    const counterKey = JSON.stringify([caller, tabId])

    /**
     * 读完、校验完参数，回「真正去做」的那一步。这一步里才过门、才碰后端；读参数不排队 ——
     * 一个类型错误不必等这个 tab 上正在跑的操作。
     */
    const prepare = async (): Promise<() => Promise<BrowserOpOutput>> => {
      strArg(args, 'tabId')
      switch (tool) {
        case 'list_tabs':
          return () => backend.listTabs()
        case 'open_tab': {
          const url = navigationTarget(strArg(args, 'url')!, caps)
          return async () => {
            await gateNavigation(url)
            return backend.openTab({ url })
          }
        }
        case 'close_tab':
          return () => backend.closeTab({ tabId })
        case 'navigate': {
          const nav: NavKind = enumArg(args, 'nav', ['goto', 'back', 'forward', 'reload']) ?? 'goto'
          const url = strArg(args, 'url')
          if (nav !== 'goto') return () => backend.navigate({ tabId, nav, url: undefined })
          if (!url) throw new ArgError('"url" is required for navigate (goto).')
          const target = navigationTarget(url, caps)
          return async () => {
            await gateNavigation(target)
            return backend.navigate({ tabId, nav, url: target })
          }
        }
        case 'snapshot': {
          const forceFull = boolArg(args, 'full') === true
          return async () => {
            // 只在「这个调用方距上次快照没隔几次操作」时才试差异 —— server 自己能做的确定性判断，
            // 不依赖模型对自身上下文的自省。隔得久了、或模型明确要全量，就回全量。
            const since = opsSinceSnapshot.get(counterKey) ?? Infinity
            const full = forceFull || since > MAX_OPS_FOR_DIFF
            // 先记成「很久没快照」，成功落定才清零：这次若失败或被取消，控制器里的基线可能是
            // 一份模型没收到的快照 —— 下一次必须回全量，不能拿它做差异的起点
            opsSinceSnapshot.delete(counterKey)
            const out = await backend.snapshot({ tabId, full, viewer: caller })
            if (!failed(out) && !extra.signal.aborted) opsSinceSnapshot.set(counterKey, 0)
            return out
          }
        }
        case 'read_page':
          return () => backend.readPage({ tabId })
        case 'screenshot': {
          const fullPage = caps.fullPageScreenshot ? boolArg(args, 'fullPage') : undefined
          const uid = caps.elementScreenshot ? strArg(args, 'uid') || undefined : undefined
          return () => backend.screenshot({ tabId, fullPage, uid })
        }
        case 'click': {
          const uid = strArg(args, 'uid')!
          return () => backend.click({ tabId, uid })
        }
        case 'fill': {
          const uid = strArg(args, 'uid')!
          const text = strArg(args, 'text')!
          return () => backend.fill({ tabId, uid, text })
        }
        case 'type': {
          const text = strArg(args, 'text')!
          const uid = strArg(args, 'uid') || undefined
          const submitKey = strArg(args, 'submitKey') || undefined
          return () => backend.type({ tabId, text, uid, submitKey })
        }
        case 'press_key': {
          const key = strArg(args, 'key')!
          return () => backend.pressKey({ tabId, key })
        }
        case 'hover': {
          const uid = strArg(args, 'uid')!
          return () => backend.hover({ tabId, uid })
        }
        case 'upload_file': {
          const uid = strArg(args, 'uid')!
          const requested = stringListArg(args, 'paths')
          return async () => {
            const paths: string[] = []
            // 一个一个过：第二个被拒，第三个就不该再弹卡
            for (const p of requested) {
              paths.push(
                gates?.fileRead
                  ? await passed(
                      gates.fileRead(p, gateCtx(`Upload to the web page in tab ${tabId}`))
                    )
                  : p
              )
            }
            return backend.uploadFile!({ tabId, uid, paths })
          }
        }
        case 'scroll': {
          const direction = enumArg<ScrollDirection>(args, 'direction', [
            'up',
            'down',
            'left',
            'right'
          ])
          const amount = numArg(args, 'amount')
          const uid = strArg(args, 'uid') || undefined
          return () => backend.scroll({ tabId, direction, amount, uid })
        }
        case 'wait_for': {
          const text = strArg(args, 'text')!
          const timeout = numArg(args, 'timeout')
          return () => backend.waitFor({ tabId, text, timeout, signal: extra.signal })
        }
        case 'evaluate': {
          const expression = strArg(args, 'expression')!
          return () => backend.evaluate!({ tabId, expression })
        }
        case 'network': {
          const limit = numArg(args, 'limit')
          return () => backend.network!({ tabId, limit })
        }
        case 'console': {
          const limit = numArg(args, 'limit')
          return () => backend.console!({ tabId, limit })
        }
        case 'pdf': {
          const requested = strArg(args, 'outputPath')!
          const pageSize = pdfPageSize(strArg(args, 'pageSize'))
          const landscape = boolArg(args, 'landscape')
          const scale = numArg(args, 'scale')
          if (scale !== undefined && (scale < PDF_SCALE_RANGE.min || scale > PDF_SCALE_RANGE.max)) {
            throw new ArgError(
              `"scale" must be between ${PDF_SCALE_RANGE.min} and ${PDF_SCALE_RANGE.max}.`
            )
          }
          return async () => {
            const outputPath = gates?.fileWrite
              ? await passed(gates.fileWrite(requested, gateCtx('Save the page as a PDF')))
              : requested
            return backend.pdf!({ tabId, outputPath, pageSize, landscape, scale })
          }
        }
        case 'cdp': {
          const method = strArg(args, 'method')!
          // 越出 tab 边界 / 绕过用户级安全设置的方法直接拒绝
          const blocked = blockedCdpReason(method)
          if (blocked) throw new ArgError(`CDP method "${method}" is blocked: ${blocked}.`)
          const params = objectArg(args, 'params')
          // 先不带门走一遍：只做校验（地址、文件列表的形状）
          await gateCdpParams(method, params, caps, {})
          return async () => {
            const gated = await gateCdpParams(method, params, caps, cdpGates)
            return backend.cdp!({ tabId, method, params: gated })
          }
        }
        case 'events': {
          const event = strArg(args, 'event') || undefined
          const sinceSeq = numArg(args, 'sinceSeq')
          const limit = numArg(args, 'limit')
          return () => backend.events!({ tabId, event, sinceSeq, limit })
        }
        case 'cdp_recipes':
          return async () => ({ text: devtoolsRecipes(caps) })
      }
    }

    const run = async (exec: () => Promise<BrowserOpOutput>): Promise<BrowserOpOutput> => {
      if (extra.signal.aborted) throw new Error('Aborted')
      // 每个带 tabId 的非快照操作都给这个调用方记一笔 —— snapshot 据此判断能否回差异
      if (tabId && tool !== 'snapshot') {
        opsSinceSnapshot.set(counterKey, (opsSinceSnapshot.get(counterKey) ?? Infinity) + 1)
      }
      if (tabId && !DOCUMENT_FREE.has(tool)) await checkDocument(tabId)
      return exec()
    }

    try {
      const exec = await prepare()
      const out = tabId
        ? await tabQueue.run(tabId, () => raceAbort(run(exec), extra.signal))
        : await raceAbort(run(exec), extra.signal)
      return toResult(out)
    } catch (err) {
      // 客户端已经放弃了这次调用（取消 / 超时），SDK 不会再回任何东西 —— 抛出即可
      if (extra.signal.aborted) throw err
      return fail(err instanceof Error ? err.message : String(err))
    }
  })

  // InMemoryTransport 关一端会顺带关另一端、再回调到这里 —— 只收一次
  let closed = false
  transport.onclose = (): void => {
    if (closed) return
    closed = true
    opsSinceSnapshot.clear()
    approvedLocal.clear()
    approvedSites.clear()
    opts.onClose?.()
  }

  await server.connect(transport)
}

/** 本地文件列表：先全部校验是字符串，再逐个过门（校验失败时一张卡都不该弹） */
async function gateFiles(
  files: unknown[],
  gate: ((path: string) => Promise<string>) | undefined
): Promise<string[]> {
  if (files.some((f) => typeof f !== 'string')) {
    throw new ArgError('"files" must be a list of file paths.')
  }
  const out: string[] = []
  for (const f of files as string[]) out.push(gate ? await gate(f) : f)
  return out
}

/** gateCdpParams 用到的门，已包好询问上下文与取消复查；一个都不给 = 只校验参数 */
interface CdpGates {
  navigate?: (url: string) => Promise<void>
  fileRead?: (path: string) => Promise<string>
  fileWrite?: (path: string) => Promise<string>
}

/**
 * 原生 cdp 里与专门工具等价的那几个方法，过同一道门 —— 逃生口不能变成绕开门的旁路：
 *
 *  - `Page.navigate` ≡ navigate；`Network.loadNetworkResource` 按地址取资源，`file://` 就是读本地文件
 *  - `DOM.setFileInputFiles` ≡ upload_file；`Input.dispatchDragEvent` 的 `data.files` 是拖进页面的
 *    本地文件，同样是上传
 *  - `Page.setDownloadBehavior` 的 downloadPath ≡ 一次写（下载落到哪里）
 *
 * 其余方法不在这里看：它们的风险由 L1 门按工具名（`mcpTool == 'cdp'`）兜。
 */
async function gateCdpParams(
  method: string,
  params: Record<string, unknown> | undefined,
  caps: BrowserCaps,
  gates: CdpGates
): Promise<Record<string, unknown> | undefined> {
  if (!params) return params
  switch (method) {
    case 'Page.navigate':
    case 'Network.loadNetworkResource': {
      if (typeof params.url !== 'string') return params
      const url = navigationTarget(params.url, caps)
      if (gates.navigate) await gates.navigate(url)
      return params
    }
    case 'DOM.setFileInputFiles': {
      if (!Array.isArray(params.files)) return params
      return { ...params, files: await gateFiles(params.files, gates.fileRead) }
    }
    case 'Input.dispatchDragEvent': {
      const data = params.data as Record<string, unknown> | undefined
      if (!data || typeof data !== 'object' || !Array.isArray(data.files)) return params
      return { ...params, data: { ...data, files: await gateFiles(data.files, gates.fileRead) } }
    }
    case 'Page.setDownloadBehavior': {
      if (typeof params.downloadPath !== 'string') return params
      const downloadPath = gates.fileWrite
        ? await gates.fileWrite(params.downloadPath)
        : params.downloadPath
      return { ...params, downloadPath }
    }
    default:
      return params
  }
}

/**
 * 内置能力服务器工厂：宿主给出「这条会话的这台 server 用什么后端、什么门」，
 * 注册表按会话调用它（见 builtinMcpRegistry）。
 */
export function createBrowserMcpServerFactory<TScope extends BuiltinMcpScope>(
  resolve: (scope: TScope) => BrowserMcpServerOptions
): BuiltinMcpFactory<TScope> {
  return (scope, transport) => connectBrowserMcpServer(resolve(scope), transport)
}
