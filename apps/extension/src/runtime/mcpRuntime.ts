/**
 * 浏览器 MCP 运行时 —— 共享 McpManager 的扩展实例。
 *
 * 只注入宿主特定逻辑：store = chrome.storage 的 mcpStore；createTransport = http（Streamable
 * HTTP / SSE，基于 fetch）或 inproc（内置能力服务器，进程内 InMemoryTransport）。stdio 本地进程
 * 在浏览器里不可能 → 抛错。连接/发现/调用/AgentTool 转换等全部在共享 McpManager（与桌面同一套）。
 *
 * 内置能力服务器眼下只有 `browser`：server 本体在 agent-runtime（两端共用），这里给它扩展的后端
 * （用户真实的标签页）、安全门与 CSP 安全的 JSON Schema 校验器。
 */
import {
  BuiltinMcpRegistry,
  McpManager,
  BROWSER_MCP_SERVER_NAME,
  createBrowserMcpServerFactory,
  createBrowserTabQueue,
  urlObjectOf,
  type BrowserMcpGates,
  type BuiltinMcpScope
} from '@shuvix/agent-runtime'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { McpServer } from '@shuvix/chat-protocol/types/mcp'
import { mcpStore } from '../storage/mcpStore'
import { extensionBrowserBackend } from './browserBackend'
import { createExtensionSecurityContext } from './securityProvider'
import { requestUserInputFor } from './userInputBroker'

function parseHeaders(json: string): Record<string, string> {
  try {
    const parsed = JSON.parse(json)
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

/** 接在 list_tabs 描述后面：这是谁的浏览器、操作会留下什么痕迹 */
const EXTENSION_HOST_NOTE =
  'These are the user\'s real Chrome tabs, signed in as the user. Reading a tab (list_tabs, read_page) is silent; operating one (snapshot, click, type, screenshot, …) attaches a debugger and shows a "being debugged" banner on it until the turn ends. The ShuviX app tab itself cannot be targeted. Tab ids are Chrome\'s numeric tab ids.'

/**
 * 扩展的安全门。导航按 url 客体过门；`file://` 也只能当地址看 —— 扩展的安全模块里没有本机路径
 * 的概念。出厂没有任何 url 策略，这道门今天等于放行；接上它是为了两端的门是同一套。
 *
 * 本地文件的读写两道门**一律拒绝**：upload_file 与 pdf 在扩展里本就不在工具表上（caps 关着 ——
 * 工作区是 OPFS / 文件夹句柄，没有能交给网页的本机路径），但原生 cdp 里等价的方法
 * （DOM.setFileInputFiles、拖入文件、Page.setDownloadBehavior）还在。不给门 = 不设门 = 放行，
 * 所以这里要给一道「不」，而不是空着。
 */
function extensionBrowserGates(sessionId: string): BrowserMcpGates {
  return {
    async fileRead() {
      throw new Error(
        'Local files cannot be handed to a web page from the extension — its workspace has no paths on this machine.'
      )
    },
    async fileWrite() {
      throw new Error('The extension cannot choose where the browser saves files.')
    },
    async navigate(url, ctx) {
      // server 已校验过是绝对地址
      await createExtensionSecurityContext(sessionId, (req) =>
        requestUserInputFor(sessionId, req)
      ).enforceUrl(urlObjectOf(url), {
        toolCallId: ctx.toolCallId,
        toolName: ctx.toolName,
        description: ctx.description,
        abortError: 'TOOL_ABORTED',
        missingChannel: 'deny'
      })
    }
  }
}

/** 内置能力服务器注册表（名字 = mcp_servers.name）；实例按会话由 McpManager 记账 */
const builtinMcpRegistry = new BuiltinMcpRegistry<BuiltinMcpScope>()
/** 用户的 Chrome 标签页不属于哪条会话 —— 各会话的 server 共用这一条按 tab 的队列 */
const browserTabQueue = createBrowserTabQueue()
builtinMcpRegistry.register(
  BROWSER_MCP_SERVER_NAME,
  createBrowserMcpServerFactory<BuiltinMcpScope>((scope) => ({
    backend: extensionBrowserBackend,
    gates: extensionBrowserGates(scope.sessionId),
    hostNote: EXTENSION_HOST_NOTE,
    tabQueue: browserTabQueue,
    // SDK 的 Server 一构造就 new Ajv()，MV3 CSP 下与客户端同一个坑 —— 换成 CSP 安全的校验器
    serverOptions: { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() }
  }))
)

/** 扩展 transport 工厂：inproc（内置）/ http（Streamable HTTP，失败回退 SSE）；stdio 不支持 */
function createTransport(
  server: McpServer,
  scope?: BuiltinMcpScope
): Transport | Promise<Transport> {
  if (server.type === 'inproc') {
    // McpManager 保证 inproc 带会话上下文（没有会话就没有实例）
    if (!scope) throw new Error(`内置能力服务器 ${server.name} 需要会话上下文`)
    return builtinMcpRegistry.createClientTransport(server.name, scope)
  }
  if (server.type !== 'http') {
    throw new Error('扩展仅支持 http 类型 MCP（浏览器无法运行本地进程）')
  }
  const headers = parseHeaders(server.headers)
  try {
    return new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers } })
  } catch {
    return new SSEClientTransport(new URL(server.url), { requestInit: { headers } })
  }
}

export const mcpManager = new McpManager({
  store: mcpStore,
  createTransport,
  // CSP 安全的 JSON Schema 校验器（无 new Function）——避免 MV3 'unsafe-eval' 报错
  // （SDK 默认 ajv 会编译 schema 触发 eval）
  clientOptions: { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
  logger: {
    info: (m) => console.info('[shuvix-mcp]', m),
    warn: (m) => console.warn('[shuvix-mcp]', m),
    error: (m) => console.error('[shuvix-mcp]', m)
  }
})
