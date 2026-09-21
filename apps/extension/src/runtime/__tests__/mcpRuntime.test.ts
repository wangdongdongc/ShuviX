/**
 * 扩展端 MCP 运行时（mcpRuntime）的装配 —— 共享 McpManager + 内置 browser 能力服务器的扩展接线。
 *
 * 钉的是宿主这一侧写死的几件事：
 *   - **transport 工厂**：inproc 行必须带会话上下文（内置 server 按会话实例化，没有会话就没有它），
 *     名字没注册（桌面的 ssh）当场报出来；http 走 Streamable HTTP（header 写坏不炸）；stdio 在浏览器里
 *     不可能 → 抛错；
 *   - **browser server 的选项**：后端是用户真实的 Chrome 标签页；SDK Server 与 Client 都换成 CSP 安全的
 *     JSON Schema 校验器（MV3 下默认的 Ajv 会 eval）；list_tabs 后面接一段宿主说明；
 *   - **安全门三道**：导航按 url 客体（经共享的 `urlObjectOf` 规整：主机名小写、去结尾的点、去账号口令）
 *     过 enforceUrl，询问通道按会话 id 取；本地文件的读 / 写两道门**一律拒绝** —— 扩展的工作区没有能交给
 *     网页的本机路径，而原生 cdp 里等价的方法还在，不给门等于放行；
 *   - **tab 队列是宿主级的一份**：tab 属于整个 Chrome，不属于哪条会话，所以每条会话的 server 拿到的是
 *     同一个队列对象。
 *
 * 取装配面的办法：`@shuvix/agent-runtime` 部分顶掉 —— McpManager 换成记下选项的空壳，
 * createBrowserMcpServerFactory 换成记下 resolve 的替身（注册表本身用真件）。后端 / 安全上下文 /
 * 询问通道 / 存储都是替身：真件的 import 图带 chrome.debugger 与 chrome.storage。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type {
  BrowserGateContext,
  BrowserMcpServerOptions,
  BuiltinMcpScope,
  McpManagerOptions
} from '@shuvix/agent-runtime'
import type { McpServer } from '@shuvix/chat-protocol/types/mcp'
import type { InputRequest } from '@shuvix/chat-protocol/types/inputRequest'

const mocks = vi.hoisted(() => ({
  managerOptions: undefined as unknown,
  resolve: undefined as unknown,
  factory: vi.fn(),
  enforceUrl: vi.fn(),
  createSecurityContext: vi.fn(),
  requestUserInputFor: vi.fn(),
  backend: { caps: { pdf: false, upload: false }, id: 'extension-backend' },
  store: { id: 'mcp-store' }
}))

vi.mock('@shuvix/agent-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shuvix/agent-runtime')>()
  return {
    ...actual,
    McpManager: class {
      constructor(options: unknown) {
        mocks.managerOptions = options
      }
    },
    createBrowserMcpServerFactory: (resolve: unknown) => {
      mocks.resolve = resolve
      return mocks.factory
    }
  }
})
vi.mock('../browserBackend', () => ({ extensionBrowserBackend: mocks.backend }))
vi.mock('../securityProvider', () => ({
  createExtensionSecurityContext: mocks.createSecurityContext
}))
vi.mock('../userInputBroker', () => ({ requestUserInputFor: mocks.requestUserInputFor }))
vi.mock('../../storage/mcpStore', () => ({ mcpStore: mocks.store }))

import '../mcpRuntime'

const options = (): McpManagerOptions => {
  expect(mocks.managerOptions, 'mcpRuntime 应在加载期构造 McpManager').toBeDefined()
  return mocks.managerOptions as McpManagerOptions
}
const createTransport = (server: McpServer, scope?: BuiltinMcpScope): Promise<Transport> =>
  // 同步抛出与异步拒绝一并收成 rejection
  Promise.resolve().then(() => options().createTransport(server, scope))

const browserOptions = (sessionId: string): BrowserMcpServerOptions => {
  expect(mocks.resolve, 'browser 应注册成内置能力服务器').toBeTypeOf('function')
  return (mocks.resolve as (scope: BuiltinMcpScope) => BrowserMcpServerOptions)({ sessionId })
}

const row = (over: Partial<McpServer>): McpServer => ({
  id: 'builtin-mcp-browser',
  name: 'browser',
  type: 'inproc',
  command: '',
  args: '[]',
  env: '{}',
  url: '',
  headers: '{}',
  metadata: '{}',
  isEnabled: 1,
  isBuiltin: 1,
  cachedTools: '[]',
  createdAt: 0,
  updatedAt: 0,
  ...over
})

const CTX: BrowserGateContext = {
  toolCallId: 'tc-1',
  toolName: 'mcp__browser__open_tab',
  description: 'Open the page'
}

beforeEach(() => {
  mocks.factory.mockReset()
  mocks.enforceUrl.mockReset()
  mocks.createSecurityContext.mockReset()
  mocks.requestUserInputFor.mockReset()
  mocks.enforceUrl.mockResolvedValue(undefined)
  mocks.createSecurityContext.mockReturnValue({ enforceUrl: mocks.enforceUrl })
})

describe('McpManager 的扩展接线', () => {
  it('MR-0 store 是 chrome.storage 的 mcpStore；客户端也用 CSP 安全的校验器', () => {
    expect(options().store).toBe(mocks.store)
    expect(options().clientOptions?.jsonSchemaValidator).toBeInstanceOf(CfWorkerJsonSchemaValidator)
  })
})

describe('createTransport', () => {
  it('MR-1 inproc browser + 会话上下文 → 一条接好的 transport，工厂拿到的正是那份上下文', async () => {
    const transport = await createTransport(row({}), { sessionId: 's1' })
    expect(typeof transport.start).toBe('function')
    expect(typeof transport.send).toBe('function')
    expect(mocks.factory).toHaveBeenCalledTimes(1)
    expect(mocks.factory.mock.calls[0][0]).toEqual({ sessionId: 's1' })
    // 工厂拿到的是另一端（server side），不是交还给 McpManager 的这一端
    const serverSide = mocks.factory.mock.calls[0][1] as Transport
    expect(typeof serverSide.send).toBe('function')
    expect(serverSide).not.toBe(transport)
    await transport.close()
  })

  it('MR-2 inproc 没有会话上下文 → 拒绝，并点名是哪台 server；工厂不被调用', async () => {
    await expect(createTransport(row({}))).rejects.toThrow('browser')
    expect(mocks.factory).not.toHaveBeenCalled()
  })

  it('MR-2b inproc 的 ssh（扩展没有这台）→ No builtin MCP server registered under "ssh"', async () => {
    await expect(
      createTransport(row({ id: 'builtin-mcp-ssh', name: 'ssh' }), { sessionId: 's1' })
    ).rejects.toThrow('No builtin MCP server registered under "ssh"')
  })

  it('MR-3 http → StreamableHTTPClientTransport；header 的 JSON 写坏也不炸', async () => {
    const plain = await createTransport(
      row({ type: 'http', name: 'tavily', url: 'https://mcp.example/mcp', headers: '{"A":"1"}' })
    )
    expect(plain).toBeInstanceOf(StreamableHTTPClientTransport)
    const broken = await createTransport(
      row({ type: 'http', name: 'tavily', url: 'https://mcp.example/mcp', headers: '{not json' })
    )
    expect(broken).toBeInstanceOf(StreamableHTTPClientTransport)
  })

  it('MR-3b stdio → 拒绝（浏览器里跑不了本地进程）', async () => {
    await expect(
      createTransport(row({ type: 'stdio', name: 'fs', command: 'npx' }), { sessionId: 's1' })
    ).rejects.toThrow(/http/)
    expect(mocks.factory).not.toHaveBeenCalled()
  })
})

describe('browser server 的选项', () => {
  it('MR-4 后端是扩展的标签页后端；Server 用 CSP 安全的校验器；list_tabs 的宿主说明非空；三道门', () => {
    const opts = browserOptions('s1')
    expect(opts.backend).toBe(mocks.backend)
    expect(opts.serverOptions?.jsonSchemaValidator).toBeInstanceOf(CfWorkerJsonSchemaValidator)
    expect(opts.hostNote).toBeTypeOf('string')
    expect(opts.hostNote!.trim().length).toBeGreaterThan(0)
    expect(Object.keys(opts.gates ?? {}).sort()).toEqual(['fileRead', 'fileWrite', 'navigate'])
  })

  it('MR-5 每条会话的 server 拿到同一个 tab 队列对象（tab 属于整个 Chrome，不属于会话）', () => {
    const a = browserOptions('s1')
    const b = browserOptions('s2')
    expect(a.tabQueue).toBeDefined()
    expect(typeof a.tabQueue!.run).toBe('function')
    expect(b.tabQueue).toBe(a.tabQueue)
    // 门却是各会话各一份（询问通道按会话取）
    expect(b.gates).not.toBe(a.gates)
  })
})

describe('安全门', () => {
  it('MR-6 导航门：url 客体经 urlObjectOf 规整后交给 enforceUrl，选项里是扩展的取消文案与 fail-closed', async () => {
    const gates = browserOptions('s1').gates!
    await gates.navigate!('https://A.example:8443/x', CTX)
    expect(mocks.createSecurityContext).toHaveBeenCalledTimes(1)
    expect(mocks.createSecurityContext.mock.calls[0][0]).toBe('s1')
    expect(mocks.enforceUrl).toHaveBeenCalledTimes(1)
    expect(mocks.enforceUrl).toHaveBeenCalledWith(
      {
        url: 'https://a.example:8443/x',
        scheme: 'https',
        host: 'a.example',
        origin: 'https://a.example:8443'
      },
      {
        toolCallId: 'tc-1',
        toolName: 'mcp__browser__open_tab',
        description: 'Open the page',
        abortError: 'TOOL_ABORTED',
        missingChannel: 'deny'
      }
    )
  })

  it('MR-6b 主机名去结尾的点、地址去账号口令 —— 按 host 写的策略不会被一个点绕开', async () => {
    const gates = browserOptions('s1').gates!
    await gates.navigate!('https://user:pw@Evil.Example./login?next=1', CTX)
    expect(mocks.enforceUrl.mock.calls[0][0]).toEqual({
      url: 'https://evil.example/login?next=1',
      scheme: 'https',
      host: 'evil.example',
      origin: 'https://evil.example'
    })
  })

  it('MR-7 询问通道按会话 id 路由到 requestUserInputFor（s2 的门问 s2）', async () => {
    const reply = { kind: 'ask', allowed: true }
    mocks.requestUserInputFor.mockResolvedValue(reply)
    await browserOptions('s2').gates!.navigate!('https://a.example/', CTX)
    const [sessionId, channel] = mocks.createSecurityContext.mock.calls[0] as [
      string,
      (req: InputRequest) => Promise<unknown>
    ]
    expect(sessionId).toBe('s2')
    const req: InputRequest = {
      id: 'tc-1',
      kind: 'ask',
      toolName: 'mcp__browser__open_tab',
      command: 'https://a.example/',
      createdAt: 0
    }
    await expect(channel(req)).resolves.toBe(reply)
    expect(mocks.requestUserInputFor).toHaveBeenCalledWith('s2', req)
  })

  it('MR-8 enforceUrl 拒绝 → 导航门原样拒绝（错误文本就是回给模型的失败）', async () => {
    mocks.enforceUrl.mockRejectedValue(new Error("Denied by security policy rule 'host-gate#0'"))
    await expect(
      browserOptions('s1').gates!.navigate!('https://evil.example/', CTX)
    ).rejects.toThrow("Denied by security policy rule 'host-gate#0'")
  })

  it('MR-9 本地文件的读 / 写两道门一律拒绝（原生 cdp 里的上传 / 下载目录也就过不去），不去问安全上下文', async () => {
    const gates = browserOptions('s1').gates!
    await expect(gates.fileRead!('/Users/me/.ssh/id_rsa', CTX)).rejects.toThrow(
      'Local files cannot be handed to a web page from the extension — its workspace has no paths on this machine.'
    )
    await expect(gates.fileWrite!('/Users/me/Downloads', CTX)).rejects.toThrow(
      'The extension cannot choose where the browser saves files.'
    )
    expect(mocks.createSecurityContext).not.toHaveBeenCalled()
    expect(mocks.enforceUrl).not.toHaveBeenCalled()
  })
})
