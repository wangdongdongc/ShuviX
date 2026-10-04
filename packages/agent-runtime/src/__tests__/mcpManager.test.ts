/**
 * McpManager 的**惰性启动**语义 —— 「用到才连、失败留状态、重试发生在下一次用到它的时候」。
 *
 * 为什么值得单独测：改制前是「开机连全部 + 增改自动重连」，失败进后台重试；现在一台服务器的
 * 连接时机只剩两个（装配工具 / 用户手点），没有任何后台队列。这套语义全是时序，UI 上看不出来 ——
 * 少连一次表现为「工具凭空少了一个」，多连一次表现为 stdio 多起一个没人管的子进程，两者都要下一
 * 次对话才暴露。所以闸门必须钉在这一层。
 *
 * 两处宿主差异（store / createTransport）本来就是构造参数，于是整个管理器可以纯单测：假 store 是
 * 一张内存表，假 transport 是一个手写的 JSON-RPC 应答器 —— 手写而不是用 SDK 的 InMemoryTransport，
 * 因为超时/在途类用例要的是**永不应答的握手**，那是真 server 给不了的。
 *
 * 时钟用 fake timers：「静置期间没有后台重试」这类否定断言，只有 `vi.getTimerCount()` 能钉死
 * （等几百毫秒再看一眼证明不了「没有排队的定时器」）。微任务没被 fake，握手应答走 queueMicrotask，
 * 所以普通 await 照常推进，只有真超时才需要 advanceTimersByTimeAsync。
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage, JSONRPCRequest } from '@modelcontextprotocol/sdk/types.js'
import type { McpServer } from '@shuvix/chat-protocol/types/mcp'
import type { BuiltinMcpScope } from '../builtinMcpRegistry'
import {
  LAZY_CONNECT_TIMEOUT_MS,
  MAX_INLINE_IMAGE_BASE64,
  McpManager,
  STDERR_TAIL_CHARS,
  mcpContentToToolContent,
  type McpToolMeta,
  type McpDiscoveredTool,
  type McpRegistrationOptions,
  type McpStore,
  type McpToolDeclaration
} from '../mcpManager'
import {
  executeTool,
  failureText,
  invokeTool,
  type InvokedToolResult
} from '../tools/testing/invokeTool'
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from '../fileTools/truncate'

// ─── 假件 ────────────────────────────────────────────────────────────────

const isRequest = (m: JSONRPCMessage): m is JSONRPCRequest => 'id' in m && 'method' in m

/** 假 server 眼里的一次 tools/call（`callResult` 给函数时的入参） */
interface FakeCall {
  name: string
  args: Record<string, unknown>
  meta?: Record<string, unknown>
}

interface FakeOpts {
  /** tools/list 的应答 */
  tools?: McpDiscoveredTool[]
  /** 扣住请求不应答 —— 握手永不落定（超时 / 在途被断开类用例） */
  hold?: boolean
  /** close() 时同步回调 onclose：真 transport 就是这么干的，用来钉「失败原因不被它抹掉」 */
  notifyOnClose?: boolean
  /** close() 直接抛 —— 钉「一条实例释放失败不拖累同批的其余实例」 */
  throwOnClose?: boolean
  /**
   * tools/call 的应答（整份 result）；给函数就按这一次调用现算。不给 = 回一段
   * `handled by <会话>` —— 跨会话串台类用例（MCPB-U-6 / 33、MCPL-U-13）靠它认出是哪份实例接的。
   *
   * ⚠️ 这里给的东西要先过 SDK 的 CallToolResultSchema 才到得了 McpManager：形态不合规
   * （未知块类型、图片/音频缺 mimeType、data 不是 base64、resource_link 缺 name/uri、
   * null 项……）的整份结果会被拒成 `[MCP Error] <zod 报错>`，于是「没有图片块」之类的断言
   * 会因为错误的理由通过。规范之外的形态只能直接测 mcpContentToToolContent。
   */
  callResult?: Record<string, unknown> | ((call: FakeCall) => Record<string, unknown>)
  /**
   * 应答 initialize 时给自己挂上的会话 id（Streamable HTTP 的 `mcp-session-id`）。
   *
   * 只能在应答那一刻挂、不能在构造时：SDK 的 `Client.connect` 见到 transport 已有 sessionId
   * 就当成「续接旧会话」，整个跳过 initialize。404 会话过期类用例（MCPR-U-11~15）靠它。
   */
  sessionId?: string
  /**
   * 子进程 stderr 的替身。给了（哪怕是 `''`）实例才有 `stderrTail()`，读的是可变字段
   * `t.stderr` —— 用例中途改它 = 进程又往 stderr 打了几行；不给就**压根没有**这个方法，
   * 与 http / inproc transport 一样（McpManager 靠「有没有这个方法」分辨）。
   */
  stderr?: string
  /**
   * tools/call 发送失败（`n` = 这份实例上第几次 tools/call，从 1 数）。返回 Error 时请求
   * **已经发出去了**（照样记进 toolCalls），先 onerror 再让 send() 以它拒绝 —— SDK 的
   * StreamableHTTPClientTransport 就是这个顺序。
   */
  failCall?: (call: FakeCall, n: number) => Error | undefined
  /** tools/call 由 server 作答为 JSON-RPC 错误：请求到了、也答了，连接本身是好的 */
  callError?: { code: number; message: string }
  /**
   * 扣住 tools/call（握手不受影响；调用照样记进 toolCalls）：
   *  - `'send'`：send() 一直悬着 —— HTTP 的 POST 还在路上
   *  - `'reply'`：send() 照常落定但不应答 —— stdio server 还在干活
   * 扣下的每一发进 `heldCalls`，由用例逐个放行 / 判失败。
   */
  holdCalls?: 'send' | 'reply'
  /** close() 里同步跑一下（「进程临死前又往 stderr 打了几行」） */
  onCloseHook?: (t: FakeTransport) => void
}

/** 被 `holdCalls` 扣下的一发 tools/call */
interface HeldCall {
  /** 放行：（`'send'` 下先让 send() 落定）再按 callResult / callError 作答 */
  reply(): void
  /** 让悬着的 send() 以 `err` 拒绝（只对 `'send'` 有意义：`'reply'` 的请求早已发出） */
  fail(err: Error): void
}

/** 一条 tools/call 请求在假 server 眼里的样子 */
function callOf(message: JSONRPCRequest): FakeCall {
  const params = (message.params ?? {}) as {
    name?: string
    arguments?: unknown
    _meta?: Record<string, unknown>
  }
  return {
    name: params.name ?? '',
    args: (params.arguments ?? {}) as Record<string, unknown>,
    meta: params._meta
  }
}

/** 手写 JSON-RPC 应答器：只认 initialize / tools/list / tools/call，其余一律空 result */
class FakeTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void
  /** 应答 initialize 之后才有（见 FakeOpts.sessionId） */
  sessionId?: string
  closeCalls = 0
  /** 收到的 tools/call —— 「这次调用落在哪份实例上」只能从这里看出来 */
  toolCalls: Array<{ name: string; args: Record<string, unknown> }> = []
  /**
   * 每次 tools/call 的 `_meta`（与 toolCalls 同序）。
   *
   * 单独一个数组而不是并进 toolCalls：那边的 `toEqual` 断言写在别处，多一个键会连坐。
   * 内置能力服务器的询问卡片按 toolCallId 定位，而它只能经这条路进去。
   */
  toolCallMetas: Array<Record<string, unknown> | undefined> = []
  /** 被 `holdCalls` 扣下的 tools/call，按发出的先后 */
  heldCalls: HeldCall[] = []
  /** 子进程 stderr 的替身（见 FakeOpts.stderr）；只有给了那一项，stderrTail 才读得到它 */
  stderr = ''
  /** 只在给了 FakeOpts.stderr 时才挂上 —— `declare` 保证没给时连这个属性都没有 */
  declare stderrTail?: () => string
  private held: JSONRPCRequest[] = []
  private holding: boolean

  constructor(
    readonly server: McpServer,
    private readonly opts: FakeOpts = {},
    /** 仅 inproc：造它时宿主传进来的会话上下文（外部服务器为 undefined） */
    readonly scope?: BuiltinMcpScope
  ) {
    this.holding = opts.hold === true
    if (opts.stderr !== undefined) {
      this.stderr = opts.stderr
      this.stderrTail = () => this.stderr
    }
  }

  startCalls = 0

  /** 假件没有「启动」这回事：真 transport 在这里拉子进程 / 开连接，这里只记一笔 */
  async start(): Promise<void> {
    this.startCalls++
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!isRequest(message)) return // 通知（notifications/initialized 等）无需应答
    // 一发 tools/call 在 send() 被调到的那一刻就算「发出去了」—— 扣住、失败都照记
    if (message.method === 'tools/call') {
      const call = callOf(message)
      this.toolCalls.push({ name: call.name, args: call.args })
      this.toolCallMetas.push(call.meta)
      if (!this.holding) return this.sendCall(message, call)
    }
    if (this.holding) {
      this.held.push(message)
      return
    }
    this.answer(message)
  }

  /** tools/call 的发送：失败 / 扣住 / 照常作答 */
  private sendCall(message: JSONRPCRequest, call: FakeCall): Promise<void> | undefined {
    const failure = this.opts.failCall?.(call, this.toolCalls.length)
    if (failure) {
      this.onerror?.(failure)
      return Promise.reject(failure)
    }
    if (this.opts.holdCalls === 'send') {
      return new Promise<void>((resolve, reject) => {
        this.heldCalls.push({
          reply: () => {
            resolve()
            this.answer(message)
          },
          fail: (err) => {
            this.onerror?.(err)
            reject(err)
          }
        })
      })
    }
    if (this.opts.holdCalls === 'reply') {
      this.heldCalls.push({
        reply: () => this.answer(message),
        fail: () => {
          throw new Error('holdCalls: "reply" 的 send() 早已落定，没有可拒绝的发送')
        }
      })
      return undefined
    }
    this.answer(message)
    return undefined
  }

  async close(): Promise<void> {
    this.closeCalls++
    this.opts.onCloseHook?.(this)
    if (this.opts.throwOnClose) throw new Error('close failed')
    if (this.opts.notifyOnClose) this.onclose?.()
  }

  /** 放行被扣住的握手（成功） */
  release(): void {
    this.holding = false
    const held = this.held.splice(0)
    for (const m of held) this.answer(m)
  }

  /** 让被扣住的握手以错误落定（「超时返回之后原任务才失败」） */
  releaseWithError(message = 'late handshake failure'): void {
    this.holding = false
    const held = this.held.splice(0)
    for (const m of held) {
      queueMicrotask(() =>
        this.onmessage?.({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message } })
      )
    }
  }

  private answer(message: JSONRPCRequest): void {
    const isCall = message.method === 'tools/call'
    const callError = this.opts.callError
    if (isCall && callError) {
      queueMicrotask(() =>
        this.onmessage?.({ jsonrpc: '2.0', id: message.id, error: { ...callError } })
      )
      return
    }
    if (message.method === 'initialize' && this.opts.sessionId !== undefined) {
      this.sessionId = this.opts.sessionId
    }
    const result =
      message.method === 'initialize'
        ? {
            protocolVersion: message.params?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'fake-mcp', version: '0.0.0' }
          }
        : message.method === 'tools/list'
          ? { tools: this.opts.tools ?? [] }
          : isCall
            ? this.callResultFor(callOf(message))
            : {}
    queueMicrotask(() => this.onmessage?.({ jsonrpc: '2.0', id: message.id, result }))
  }

  private callResultFor(call: FakeCall): Record<string, unknown> {
    const spec = this.opts.callResult
    if (typeof spec === 'function') return spec(call)
    if (spec) return spec
    // 回执带上自己的身份：跨会话串台时断言看到的是**另一条会话**的名字
    return { content: [{ type: 'text', text: `handled by ${this.scope?.sessionId ?? 'global'}` }] }
  }
}

function row(patch: Partial<McpServer> & { id: string; name: string }): McpServer {
  return {
    type: 'http',
    command: '',
    args: '[]',
    env: '{}',
    url: 'http://127.0.0.1/mcp',
    headers: '{}',
    metadata: '{}',
    isEnabled: 1,
    isBuiltin: 0,
    cachedTools: '[]',
    createdAt: 0,
    updatedAt: 0,
    ...patch
  }
}

const tool = (name: string, description?: string): McpDiscoveredTool => ({
  name,
  ...(description === undefined ? {} : { description }),
  inputSchema: { type: 'object', properties: { q: { type: 'string' } } }
})

/** 带行为提示的工具声明（annotations 的可信规则那一组用） */
const annotated = (
  name: string,
  annotations: NonNullable<McpDiscoveredTool['annotations']>
): McpDiscoveredTool => ({ ...tool(name), annotations })

interface TestStore extends McpStore {
  /** 内存表，用例直接改行来模拟「设置页改了配置」 */
  rows: Map<string, McpServer>
  updateCachedTools: Mock<(id: string, toolsJson: string) => void>
}

interface Harness {
  mgr: McpManager
  store: TestStore
  createTransport: Mock<(server: McpServer, scope?: BuiltinMcpScope) => Transport>
  /** 按 server 名（造出来的顺序）取假 transport */
  made(name: string): FakeTransport[]
  last(name: string): FakeTransport
  /** 某台 inproc server 在某条会话名下造出来的实例（按会话分身，所以要连会话一起查） */
  madeFor(name: string, sessionId: string): FakeTransport[]
  lastFor(name: string, sessionId: string): FakeTransport
  /**
   * 下一次为该 server 名造 transport 时的行为；Error = createTransport 直接抛。
   * 键可以是 `name`，也可以是 `name#sessionId`（后者优先）—— inproc 用例要让
   * 两条会话的实例回不同的工具，才谈得上「会话之间互相看不见」。
   */
  plan: Map<string, FakeOpts | Error>
}

function setup(rows: McpServer[]): Harness {
  const map = new Map(rows.map((r) => [r.id, r]))
  const updateCachedTools = vi.fn((id: string, toolsJson: string) => {
    const s = map.get(id)
    if (s) s.cachedTools = toolsJson
  })
  const store = {
    rows: map,
    findById: (id: string) => map.get(id),
    findEnabled: () => [...map.values()].filter((s) => s.isEnabled === 1),
    findAll: () => [...map.values()],
    updateCachedTools
  }
  const plan = new Map<string, FakeOpts | Error>()
  const all: FakeTransport[] = []
  const createTransport = vi.fn((server: McpServer, scope?: BuiltinMcpScope): Transport => {
    const p =
      (scope ? plan.get(`${server.name}#${scope.sessionId}`) : undefined) ??
      plan.get(server.name) ??
      {}
    if (p instanceof Error) throw p
    const t = new FakeTransport(server, p, scope)
    all.push(t)
    return t
  })
  const made = (name: string): FakeTransport[] => all.filter((t) => t.server.name === name)
  const madeFor = (name: string, sessionId: string): FakeTransport[] =>
    all.filter((t) => t.server.name === name && t.scope?.sessionId === sessionId)
  const pickLast = (list: FakeTransport[], label: string): FakeTransport => {
    const t = list[list.length - 1]
    if (!t) throw new Error(`no transport was created for "${label}"`)
    return t
  }
  return {
    mgr: new McpManager({ store, createTransport }),
    store,
    createTransport,
    made,
    last: (name) => pickLast(made(name), name),
    madeFor,
    lastFor: (name, sessionId) => pickLast(madeFor(name, sessionId), `${name}#${sessionId}`),
    plan
  }
}

/**
 * 一条会话能拿到的全部 MCP 工具：全局 server 的，加这条会话自己那份 inproc 实例的。宿主按 server
 * 名逐台取（getRegistrationsByServerName），这里把表里每一台都取一遍拼起来 —— 不传会话就一台 inproc
 * 都拿不到，与宿主的取法同一条规则。
 */
function toolsFor(h: Harness, sessionId?: string, opts?: McpRegistrationOptions): McpTool[] {
  return [...h.store.rows.values()].flatMap((s) =>
    h.mgr.getRegistrationsByServerName(s.name, sessionId, opts)
  )
}

/** 让微任务与已到期的定时器跑完（fake timers 下 advanceTimersByTimeAsync 会真让出事件循环） */
const settle = async (ms = 0): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms)
}

/**
 * 「这份实例被释放过吗」。
 *
 * 一次释放在假件上不止一次 `close()`：closeConnection 先关 transport，随后 `client.close()`
 * 又会关一次自己的 transport。所以数次数没有意义，能钉的是**关过 / 没关过**，
 * 以及一批释放里某一份的次数**有没有再涨**（幂等）。
 */
const released = (t: FakeTransport): boolean => t.closeCalls > 0

const rejections: unknown[] = []
const onUnhandled = (reason: unknown): void => {
  rejections.push(reason)
}

beforeEach(() => {
  vi.useFakeTimers()
  rejections.length = 0
  process.on('unhandledRejection', onUnhandled)
})

afterEach(() => {
  process.off('unhandledRejection', onUnhandled)
  vi.useRealTimers()
})

// ─── 用例 ────────────────────────────────────────────────────────────────

describe('McpManager 惰性连接', () => {
  it('MCPL-U-1: 名字不在已启用列表 = 静默跳过（ok:false 且无 error），压根不造 transport', async () => {
    const h = setup([row({ id: 'a-id', name: 'a' }), row({ id: 'b-id', name: 'b', isEnabled: 0 })])

    // 停用的 / 不存在的名字 / 不存在的 id —— 三条都不是「连不上」，宿主据「有没有 error」决定报不报红
    expect(await h.mgr.ensureServerByName('b')).toEqual({ ok: false })
    expect(await h.mgr.ensureServerByName('nope')).toEqual({ ok: false })
    expect(await h.mgr.connect('unknown-id')).toEqual({ ok: false })
    for (const r of [
      await h.mgr.ensureServerByName('b'),
      await h.mgr.ensureServerByName('nope'),
      await h.mgr.connect('unknown-id')
    ]) {
      expect(r.error).toBeUndefined()
    }

    expect(h.createTransport).not.toHaveBeenCalled()
    expect(h.mgr.getStatus('a-id')).toBe('disconnected')
    expect(h.mgr.getStatus('b-id')).toBe('disconnected')
  })

  it('MCPL-U-2: 用到才连；已连上直接复用；手动 connect 强制重连（旧连接先收掉）', async () => {
    const h = setup([row({ id: 'a-id', name: 'a' })])

    expect(await h.mgr.ensureServerByName('a')).toEqual({ ok: true })
    expect(h.createTransport).toHaveBeenCalledTimes(1)
    expect(h.mgr.getStatus('a-id')).toBe('connected')

    // 已连上：第二次装配工具不重开连接
    expect(await h.mgr.ensureServerByName('a')).toEqual({ ok: true })
    expect(h.createTransport).toHaveBeenCalledTimes(1)

    // 设置页手点连接 = 强制重连：旧的先关掉，再开新的
    const old = h.last('a')
    expect(await h.mgr.connect('a-id')).toEqual({ ok: true })
    expect(h.createTransport).toHaveBeenCalledTimes(2)
    expect(old.closeCalls).toBeGreaterThan(0)
    expect(h.mgr.getStatus('a-id')).toBe('connected')
  })

  it('MCPL-U-3: 失败留状态 + 无后台重试；下次用到原地再试一次', async () => {
    const h = setup([row({ id: 'a-id', name: 'a' })])
    h.plan.set('a', new Error('spawn ENOENT'))

    const first = await h.mgr.ensureServerByName('a')
    expect(first.ok).toBe(false)
    expect(first.error).toBe('spawn ENOENT')
    expect(h.mgr.getStatus('a-id')).toBe('error')
    expect(h.mgr.getError('a-id')).toBe('spawn ENOENT')

    // 静置：没有重试队列，也没有排着的定时器 —— 这一条是「重试只在使用时」的反面
    await settle(10 * 60 * 1000)
    expect(h.createTransport).toHaveBeenCalledTimes(1)
    expect(h.mgr.getStatus('a-id')).toBe('error')
    expect(vi.getTimerCount()).toBe(0)

    // 下次用到它：原地再试（ensureConnected 对 error 一律重开）
    h.plan.set('a', {})
    expect(await h.mgr.ensureServerByName('a')).toEqual({ ok: true })
    expect(h.createTransport).toHaveBeenCalledTimes(2)
    expect(h.mgr.getStatus('a-id')).toBe('connected')
    expect(h.mgr.getError('a-id')).toBeUndefined()
  })

  it('MCPL-U-4: 配置改了只要断开 —— 下次用到按新配置连，期间没有额外尝试', async () => {
    const h = setup([row({ id: 'a-id', name: 'a', url: 'http://old/mcp' })])
    expect(await h.mgr.ensureServerByName('a')).toEqual({ ok: true })
    expect(h.createTransport).toHaveBeenCalledTimes(1)

    // mcp:update 的语义：改库 + 断开，不重连
    h.store.rows.get('a-id')!.url = 'http://new/mcp'
    await h.mgr.disconnect('a-id')
    expect(h.mgr.getStatus('a-id')).toBe('disconnected')
    await settle(10_000)
    expect(h.createTransport).toHaveBeenCalledTimes(1)

    expect(await h.mgr.ensureConnected('a-id')).toEqual({ ok: true })
    expect(h.createTransport).toHaveBeenCalledTimes(2)
    expect(h.createTransport.mock.calls[1][0]).toMatchObject({ url: 'http://new/mcp' })
  })

  it('MCPL-U-5: 并发合流 —— 同一台只拉起一次、不同台互不阻塞、落定后 pending 清空', async () => {
    const h = setup([row({ id: 'a-id', name: 'a' }), row({ id: 'b-id', name: 'b' })])
    h.plan.set('a', { hold: true })
    h.plan.set('b', { hold: true })

    // 「两条会话同时创建 Agent」= 同一台并发两次
    const first = h.mgr.ensureServerByName('a')
    const second = h.mgr.ensureServerByName('a')
    const other = h.mgr.ensureServerByName('b')
    await settle()

    expect(h.made('a')).toHaveLength(1)
    // 另一台不被这一台挡住：两台可以同时 connecting
    expect(h.mgr.getStatus('a-id')).toBe('connecting')
    expect(h.mgr.getStatus('b-id')).toBe('connecting')
    expect(h.made('b')).toHaveLength(1)

    h.last('a').release()
    h.last('b').release()
    const [r1, r2, r3] = await Promise.all([first, second, other])
    expect(r1).toEqual({ ok: true })
    expect(r2).toEqual(r1)
    expect(r3).toEqual({ ok: true })
    expect(h.made('a')).toHaveLength(1)
    expect(h.mgr.getStatus('b-id')).toBe('connected')

    // pending 在 finally 里删了：之后的手动连接是**新的**一次尝试，而不是被那条已落定的 promise 顶回
    h.plan.set('a', {})
    expect(await h.mgr.connect('a-id')).toEqual({ ok: true })
    expect(h.made('a')).toHaveLength(2)
  })

  it('MCPL-U-6: 搭车的一方沿用先发起那次的超时（已知副作用，钉成行为）', async () => {
    const h = setup([row({ id: 'a-id', name: 'a' })])
    h.plan.set('a', { hold: true })

    const lazy = h.mgr.ensureServerByName('a', { timeoutMs: 50 })
    // 手动连接撞上在途的惰性连接：不设限的那一方也会在 50ms 后失败，而不是无限等
    const manual = h.mgr.connect('a-id')
    await settle(50)

    const lazyResult = await lazy
    expect(lazyResult.ok).toBe(false)
    expect(lazyResult.error).toMatch(/timed out after 50ms/)
    expect(await manual).toEqual(lazyResult)
    expect(h.made('a')).toHaveLength(1)
  })

  it('MCPL-U-7: 惰性超时即失败、收掉 transport，且不留未捕获拒绝', async () => {
    const h = setup([row({ id: 'a-id', name: 'a' })])
    h.plan.set('a', { hold: true })

    const p = h.mgr.ensureServerByName('a', { timeoutMs: 20 })
    await settle(20)
    const result = await p
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/timed out after \d+ms/)
    expect(h.mgr.getStatus('a-id')).toBe('error')

    // 握手可能还在跑 —— transport 必须被收掉，否则 stdio 会留下一个没人管的子进程
    const t = h.last('a')
    expect(t.closeCalls).toBeGreaterThan(0)
    expect(t.onclose).toBeUndefined()
    expect(t.onerror).toBeUndefined()

    // 超时返回之后原握手才失败：不能冒成未捕获拒绝
    t.releaseWithError()
    await settle()
    await settle()
    expect(rejections).toEqual([])
    expect(h.mgr.getStatus('a-id')).toBe('error')
  })

  it('MCPL-U-7: 手动路径不设限（慢于阈值也照常连上），且成功收尾不留定时器', async () => {
    const h = setup([row({ id: 'a-id', name: 'a' }), row({ id: 'b-id', name: 'b' })])
    h.plan.set('a', { hold: true })

    const slow = h.mgr.connect('a-id') // 不传 timeoutMs
    await settle(30_000) // 远超惰性阈值：不设限就不该有任何东西把它打断
    h.last('a').release()
    expect(await slow).toEqual({ ok: true })
    expect(h.mgr.getStatus('a-id')).toBe('connected')

    // 一次干净的快速成功之后，时钟上不该剩下任何排队的定时器
    expect(await h.mgr.ensureServerByName('b', { timeoutMs: 5000 })).toEqual({ ok: true })
    await settle()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('MCPL-U-8: 失败原因不被 transport 自己的 onclose 抹掉', async () => {
    const h = setup([row({ id: 'a-id', name: 'a' })])
    // 握手失败 + close() 同步回调 onclose：摘回调的顺序反了，状态就会被改回 disconnected
    h.plan.set('a', { hold: true, notifyOnClose: true })

    const p = h.mgr.ensureServerByName('a')
    await settle()
    h.last('a').releaseWithError('handshake refused')
    const result = await p

    expect(result.ok).toBe(false)
    expect(result.error).toContain('handshake refused')
    expect(h.mgr.getStatus('a-id')).toBe('error')
    expect(h.mgr.getError('a-id')).toContain('handshake refused')
  })

  it('MCPL-U-9: {{ENV}} 缺值 = 带 error 的失败，且根本不造 transport；补上就连得上', async () => {
    const h = setup([
      row({
        id: 'a-id',
        name: 'a',
        url: 'https://example.test/mcp?key={{TOKEN}}',
        env: JSON.stringify({ TOKEN: '' })
      })
    ])

    expect(await h.mgr.ensureServerByName('a')).toEqual({
      ok: false,
      error: 'Missing required env variable: TOKEN'
    })
    expect(h.mgr.getStatus('a-id')).toBe('error')
    expect(h.createTransport).not.toHaveBeenCalled()

    h.store.rows.get('a-id')!.env = JSON.stringify({ TOKEN: 'secret' })
    expect(await h.mgr.ensureServerByName('a')).toEqual({ ok: true })
    expect(h.createTransport).toHaveBeenCalledTimes(1)
    expect(h.createTransport.mock.calls[0][0]).toMatchObject({
      url: 'https://example.test/mcp?key=secret'
    })
  })
})

describe('McpManager 可用性与批量装配', () => {
  it('MCPL-U-10: getEnabledToolNames 只看配置，不看连接状态', async () => {
    const h = setup([
      row({ id: 'a-id', name: 'a' }), // 启用，从没连过
      row({ id: 'b-id', name: 'b' }), // 启用，连失败过
      row({ id: 'c-id', name: 'c', isEnabled: 0 }), // 停用
      row({ id: 'd-id', name: 'd' }) // 启用，已连上
    ])
    h.plan.set('b', new Error('boom'))
    expect((await h.mgr.ensureServerByName('b')).ok).toBe(false)
    expect(await h.mgr.ensureServerByName('d')).toEqual({ ok: true })

    // 「还没连」是惰性启动下的常态而非不可用：按连接状态过滤会在创建 Agent 的前一刻抹掉用户的勾选
    expect(h.mgr.getEnabledToolNames()).toEqual(['mcp:a', 'mcp:b', 'mcp:d'])
  })

  it('MCPL-U-12: cachedTools 成功时写、失败时不清；状态映射喂给 mcp:list', async () => {
    const h = setup([
      row({ id: 'a-id', name: 'a' }),
      row({ id: 'z-id', name: 'z' }) // 从没连过
    ])
    h.plan.set('a', { tools: [tool('search', 'find things'), tool('ping')] })

    expect(await h.mgr.ensureServerByName('a')).toEqual({ ok: true })
    expect(h.store.updateCachedTools).toHaveBeenCalledTimes(1)
    const [id, json] = h.store.updateCachedTools.mock.calls[0]
    expect(id).toBe('a-id')
    // 归一化：description 缺省写成空串，其余字段不带进去
    expect(JSON.parse(json)).toEqual([
      { name: 'search', description: 'find things', inputSchema: tool('search').inputSchema },
      { name: 'ping', description: '', inputSchema: tool('ping').inputSchema }
    ])

    await h.mgr.disconnect('a-id')
    h.plan.set('a', new Error('gone'))
    expect((await h.mgr.ensureConnected('a-id')).ok).toBe(false)
    // 连不上不该把上次发现的工具抹掉 —— 设置页靠它显示「这台有几个工具」
    expect(h.store.updateCachedTools).toHaveBeenCalledTimes(1)

    const infos = h.mgr.getServerToolInfos('a-id')
    expect(infos).toHaveLength(2)
    expect(infos.every((i) => i.serverStatus === 'error')).toBe(true)

    const all = h.mgr.getAllToolInfos()
    expect(all.find((i) => i.name === 'mcp:z')?.serverStatus).toBe('disconnected')
    expect(all.find((i) => i.name === 'mcp:a')?.serverStatus).toBe('error')
  })

  it('UIF-U-7: statusByName 按名字读状态 —— 宿主据它决定报不报「正在连接」', async () => {
    // 装配工具时宿主只有 `mcp:<name>` 里的**名字**，没有 id；已连上的那台不报连接态
    // （它瞬间落定，报了只会闪一下），所以这个判断错一档，UI 上要么闪、要么整段不显示
    const h = setup([row({ id: 'a-id', name: 'a' }), row({ id: 'b-id', name: 'b' })])
    h.plan.set('b', new Error('Missing required env variable: TOKEN'))

    // 名字不存在也算 disconnected（不抛）—— 勾选里留着一台已被删掉的服务器是常态
    expect(h.mgr.statusByName('nope')).toBe('disconnected')
    expect(h.mgr.statusByName('a')).toBe('disconnected')

    expect(await h.mgr.ensureServerByName('a')).toEqual({ ok: true })
    expect(h.mgr.statusByName('a')).toBe('connected')

    await h.mgr.disconnect('a-id')
    expect(h.mgr.statusByName('a')).toBe('disconnected')

    expect((await h.mgr.ensureServerByName('b')).ok).toBe(false)
    expect(h.mgr.statusByName('b')).toBe('error')
  })
})

describe('McpManager 连接中途的意外', () => {
  it('MCPL-U-13: 掉线后状态回落、工具清空；已构建的注册项下一次调用原地重连一次再调', async () => {
    const h = setup([row({ id: 'a-id', name: 'a' })])
    h.plan.set('a', { tools: [tool('search')] })
    expect(await h.mgr.ensureServerByName('a')).toEqual({ ok: true })

    // Agent 手里那份工具是创建那一刻拿到的，掉线之后它还在（Agent 要等用户销毁才重建）
    const held = h.mgr.serverToRegistrations('a-id')
    expect(held).toHaveLength(1)

    const dropped = h.last('a')
    dropped.onclose?.()
    expect(h.mgr.getStatus('a-id')).toBe('disconnected')
    expect(h.mgr.serverToRegistrations('a-id')).toEqual([])

    const result = await executeTool(held[0], 'call-1', {}, new AbortController().signal)
    expect(onlyText(result.content)).toBe('handled by global')
    expect(h.made('a')).toHaveLength(2)
    expect(dropped.toolCalls).toEqual([])
    expect(h.last('a').toolCalls).toHaveLength(1)
    expect(h.mgr.getStatus('a-id')).toBe('connected')
    expect(h.mgr.serverToRegistrations('a-id')).toHaveLength(1)
  })

  it('MCPL-U-14: 连接在途时被断开 —— 握手无论成败都不留活连接', async () => {
    for (const outcome of ['success', 'failure'] as const) {
      const h = setup([row({ id: 'a-id', name: 'a' })])
      h.plan.set('a', { hold: true })

      const p = h.mgr.ensureServerByName('a')
      await settle()
      expect(h.mgr.getStatus('a-id')).toBe('connecting')

      // 用户在这一刻把它停用/删了：disconnect 摘掉条目时握手还在跑
      await h.mgr.disconnect('a-id')
      expect(h.mgr.getStatus('a-id')).toBe('disconnected')

      const t = h.last('a')
      const closedByDisconnect = t.closeCalls
      if (outcome === 'success') t.release()
      else t.releaseWithError()
      const result = await p

      expect(result.ok, outcome).toBe(false)
      // 握手落定后**自己**再收一次尾 —— disconnect 摘条目那一下可能还关不到 transport，
      // 少这一步 stdio 就会留下一个谁也管不到的子进程
      expect(t.closeCalls, outcome).toBeGreaterThan(closedByDisconnect)
      // 不能悄悄变回 connected：连接表里已经没有这一项了
      expect(h.mgr.getStatus('a-id'), outcome).toBe('disconnected')
      expect(h.mgr.serverToRegistrations('a-id'), outcome).toEqual([])
      // 「已经被断开的那次连接」不该把它发现的工具写回缓存
      expect(h.store.updateCachedTools, outcome).not.toHaveBeenCalled()
    }
  })
})

// ─── 内置能力服务器（inproc） ─────────────────────────────────────────────
//
// 记账上的全部差别只有一条：`inproc` 的连接键是 `serverId#sessionId`，外部（stdio/http）
// 还是裸 serverId。「一个会话一份 server 实例」落到实处就是这一行，于是下面每一条用例问的
// 都是同一个问题的不同侧面 —— **这份实例归谁**：没有会话就没有实例（拒连），两条会话就是
// 两份互不可见的实例，释放按会话走而不按运行时走，状态既能逐会话问也能整体问。
//
// 串台的代价不是「多一次连接」而是「A 会话的工具闭包操作了 B 会话的资源」（ssh 的 control
// socket、browser 的 tab），这在 UI 上完全看不出来，所以闸门只能钉在这一层。

/** 一台内置能力服务器的配置行（没有 command / url 可配，只有启用位） */
const sshRow = (patch: Partial<McpServer> = {}): McpServer =>
  row({ id: 'ssh-id', name: 'ssh', type: 'inproc', url: '', isBuiltin: 1, ...patch })

describe('McpManager 内置能力服务器：没有会话就没有实例', () => {
  it('MCPB-U-1: inproc 无 sessionId = 静默拒连（ok:false 且无 error），不造实例', async () => {
    const h = setup([sshRow()])

    // 「用错了 API」而不是「连不上」：宿主据「有没有 error」决定报不报红，这里不该报
    const result = await h.mgr.connect('ssh-id')
    expect(result).toEqual({ ok: false })
    expect(result.error).toBeUndefined()

    expect(h.createTransport).not.toHaveBeenCalled()
    expect(h.mgr.getStatus('ssh-id')).toBe('disconnected')
    expect(toolsFor(h)).toEqual([])
    // 连接表里什么都没有 —— 也就不存在一份「谁都能捡走」的无主实例
    expect(h.mgr.getRegistrationsByServerName('ssh', 's1')).toEqual([])
  })

  it('MCPB-U-2: 外部服务器无会话照连，键仍是裸 serverId', async () => {
    const h = setup([row({ id: 'a-id', name: 'a' })])
    h.plan.set('a', { tools: [tool('search')] })

    expect(await h.mgr.ensureServerByName('a')).toEqual({ ok: true })
    // 键就是 serverId：能按裸 id 取到工具，说明没有被加上会话后缀
    expect(h.mgr.serverToRegistrations('a-id').map((t) => t.name)).toEqual(['mcp__a__search'])
    expect(h.mgr.getStatus('a-id')).toBe('connected')
  })

  it('MCPB-U-3: ensureServerByName 不传会话时继承同一条拒绝', async () => {
    const h = setup([sshRow()])
    expect(await h.mgr.ensureServerByName('ssh')).toEqual({ ok: false })
    expect(h.createTransport).not.toHaveBeenCalled()
  })

  it('MCPB-U-35: sessionId 为空串不算会话 —— 同样拒连', async () => {
    const h = setup([sshRow()])
    // `''` 是「宿主以为自己有会话、其实没有」的典型形态：放行就会造出一份键为 `ssh-id#`
    // 的实例，谁的会话结束都关不到它
    expect(await h.mgr.connect('ssh-id', { sessionId: '' })).toEqual({ ok: false })
    expect(await h.mgr.ensureServerByName('ssh', { sessionId: '' })).toEqual({ ok: false })
    expect(h.createTransport).not.toHaveBeenCalled()
  })
})

describe('McpManager 内置能力服务器：一个会话一份实例', () => {
  it('MCPB-U-4: 两条会话 = 两份实例，键 `id#s1`/`id#s2`，工厂各拿到自己的会话', async () => {
    const h = setup([sshRow()])
    h.plan.set('ssh', { tools: [tool('list-hosts')] })

    expect(await h.mgr.ensureServerByName('ssh', { sessionId: 's1' })).toEqual({ ok: true })
    expect(await h.mgr.ensureServerByName('ssh', { sessionId: 's2' })).toEqual({ ok: true })

    expect(h.createTransport).toHaveBeenCalledTimes(2)
    expect(h.createTransport.mock.calls.map((c) => c[1]?.sessionId)).toEqual(['s1', 's2'])
    // 键带会话后缀：两条都能按键取到工具，而裸 id 取不到
    expect(h.mgr.serverToRegistrations('ssh-id#s1')).toHaveLength(1)
    expect(h.mgr.serverToRegistrations('ssh-id#s2')).toHaveLength(1)
    expect(h.mgr.serverToRegistrations('ssh-id')).toEqual([])
  })

  it('MCPB-U-5: 会话之间看不见彼此的工具', async () => {
    const h = setup([sshRow()])
    h.plan.set('ssh#s1', { tools: [tool('list-hosts')] })
    h.plan.set('ssh#s2', { tools: [tool('s2-only')] })

    await h.mgr.ensureServerByName('ssh', { sessionId: 's1' })
    await h.mgr.ensureServerByName('ssh', { sessionId: 's2' })

    expect(h.mgr.getRegistrationsByServerName('ssh', 's1').map((t) => t.name)).toEqual([
      'mcp__ssh__list-hosts'
    ])
    expect(h.mgr.getRegistrationsByServerName('ssh', 's2').map((t) => t.name)).toEqual([
      'mcp__ssh__s2-only'
    ])
  })

  it('MCPB-U-6: 工具闭包调的是自己那份实例', async () => {
    const h = setup([sshRow()])
    h.plan.set('ssh', { tools: [tool('list-hosts')] })
    await h.mgr.ensureServerByName('ssh', { sessionId: 's1' })
    await h.mgr.ensureServerByName('ssh', { sessionId: 's2' })

    const [t1] = h.mgr.getRegistrationsByServerName('ssh', 's1')
    const result = await executeTool(t1, 'call-1', { q: 'x' }, new AbortController().signal)

    // 闭包里记的是**连接键**，所以这一发只可能落在 s1 那份实例上
    expect(h.lastFor('ssh', 's1').toolCalls).toEqual([{ name: 'list-hosts', args: { q: 'x' } }])
    expect(h.lastFor('ssh', 's2').toolCalls).toEqual([])
    expect(JSON.stringify(result.content)).toContain('handled by s1')
  })

  it('MCPB-U-7: getRegistrationsByServerName 不传会话时回空 —— 绝不回落到别人的实例', async () => {
    const h = setup([sshRow()])
    h.plan.set('ssh', { tools: [tool('list-hosts')] })
    await h.mgr.ensureServerByName('ssh', { sessionId: 's1' })

    // 回落 = 把 s1 的 ssh 实例交给一个说不清自己是谁的调用方，比「少一个工具」严重得多
    expect(h.mgr.getRegistrationsByServerName('ssh')).toEqual([])
    expect(h.mgr.getRegistrationsByServerName('ssh', 's9')).toEqual([])
    expect(h.mgr.getRegistrationsByServerName('ssh', 's1')).toHaveLength(1)
  })

  it('MCPB-U-8: 外部服务器的工具与会话无关（同一份，谁问都一样）', async () => {
    const h = setup([row({ id: 'a-id', name: 'a' })])
    h.plan.set('a', { tools: [tool('search')] })
    await h.mgr.ensureServerByName('a')

    const names = ['s1', 's2', undefined].map((sid) =>
      h.mgr.getRegistrationsByServerName('a', sid).map((t) => t.name)
    )
    expect(names).toEqual([['mcp__a__search'], ['mcp__a__search'], ['mcp__a__search']])
  })

  it('MCPB-U-9: 同一条（服务器, 会话）复用同一份实例', async () => {
    const h = setup([sshRow()])
    expect(await h.mgr.ensureServerByName('ssh', { sessionId: 's1' })).toEqual({ ok: true })
    expect(await h.mgr.ensureServerByName('ssh', { sessionId: 's1' })).toEqual({ ok: true })
    expect(await h.mgr.ensureConnected('ssh-id', { sessionId: 's1' })).toEqual({ ok: true })
    expect(h.madeFor('ssh', 's1')).toHaveLength(1)
  })

  it('MCPB-U-10 / 11: 并发按**连接键**合流 —— 同会话合一次，跨会话各造各的', async () => {
    const h = setup([sshRow()])
    h.plan.set('ssh', { hold: true })

    const a = h.mgr.ensureServerByName('ssh', { sessionId: 's1' })
    const b = h.mgr.ensureServerByName('ssh', { sessionId: 's1' })
    const c = h.mgr.ensureServerByName('ssh', { sessionId: 's2' })
    await settle()

    // 同一条会话的两次请求搭同一班车；另一条会话不能搭 —— 它要的是自己那份实例
    expect(h.madeFor('ssh', 's1')).toHaveLength(1)
    expect(h.madeFor('ssh', 's2')).toHaveLength(1)

    h.lastFor('ssh', 's1').release()
    h.lastFor('ssh', 's2').release()
    const [r1, r2, r3] = await Promise.all([a, b, c])
    expect(r1).toEqual({ ok: true })
    expect(r2).toEqual(r1)
    expect(r3).toEqual({ ok: true })
    expect(h.made('ssh')).toHaveLength(2)
  })

  it('MCPB-U-34: cachedTools 按**配置行 id** 写（会话分身不该写出两份不同的缓存）', async () => {
    const h = setup([sshRow()])
    h.plan.set('ssh', { tools: [tool('list-hosts')] })
    await h.mgr.ensureServerByName('ssh', { sessionId: 's1' })
    await h.mgr.ensureServerByName('ssh', { sessionId: 's2' })

    expect(h.store.updateCachedTools).toHaveBeenCalledTimes(2)
    expect(h.store.updateCachedTools.mock.calls.map((c) => c[0])).toEqual(['ssh-id', 'ssh-id'])
  })
})

describe('McpManager 内置实例的释放', () => {
  /** 两条会话各连上一份 ssh，外加一台外部服务器 */
  async function twoSessions(): Promise<Harness> {
    const h = setup([sshRow(), row({ id: 'a-id', name: 'a' })])
    h.plan.set('ssh', { tools: [tool('list-hosts')] })
    h.plan.set('a', { tools: [tool('search')] })
    await h.mgr.ensureServerByName('ssh', { sessionId: 's1' })
    await h.mgr.ensureServerByName('ssh', { sessionId: 's2' })
    await h.mgr.ensureServerByName('a')
    return h
  }

  it('MCPB-U-12: closeSession 只关这条会话名下的实例', async () => {
    const h = await twoSessions()

    await h.mgr.closeSession('s1')

    expect(released(h.lastFor('ssh', 's1'))).toBe(true)
    expect(released(h.lastFor('ssh', 's2'))).toBe(false)
    expect(h.mgr.getRegistrationsByServerName('ssh', 's1')).toEqual([])
    expect(h.mgr.getRegistrationsByServerName('ssh', 's2')).toHaveLength(1)
    expect(h.mgr.getStatus('ssh-id', 's1')).toBe('disconnected')
    expect(h.mgr.getStatus('ssh-id', 's2')).toBe('connected')
  })

  it('MCPB-U-13: closeSession 不碰外部（stdio/http）服务器 —— 它们是跨会话共享的', async () => {
    const h = await twoSessions()

    await h.mgr.closeSession('s1')
    await h.mgr.closeSession('s2')

    // 一条会话结束就把别人的 MCP 服务器一起关掉，是这套记账最容易犯的错
    expect(released(h.last('a'))).toBe(false)
    expect(h.mgr.getStatus('a-id')).toBe('connected')
    expect(h.mgr.serverToRegistrations('a-id')).toHaveLength(1)
  })

  it('MCPB-U-14 / 15: 未知会话是空操作，重复调用幂等', async () => {
    const h = await twoSessions()

    await h.mgr.closeSession('nobody')
    expect(released(h.lastFor('ssh', 's1'))).toBe(false)
    expect(released(h.lastFor('ssh', 's2'))).toBe(false)

    await h.mgr.closeSession('s1')
    const afterFirst = h.lastFor('ssh', 's1').closeCalls
    expect(afterFirst).toBeGreaterThan(0)
    await h.mgr.closeSession('s1')
    // 第二次没有条目可关 —— 不重复 close，也不抛
    expect(h.lastFor('ssh', 's1').closeCalls).toBe(afterFirst)
  })

  it('MCPB-U-16: 连接在途时 closeSession —— 不留条目、收掉实例、不冒未捕获拒绝', async () => {
    const h = setup([sshRow()])
    h.plan.set('ssh', { hold: true })

    const p = h.mgr.ensureServerByName('ssh', { sessionId: 's1' })
    await settle()
    expect(h.mgr.getStatus('ssh-id', 's1')).toBe('connecting')

    await h.mgr.closeSession('s1')
    const t = h.lastFor('ssh', 's1')
    // 实例当场被收掉，条目当场摘掉 —— 不是「等握手落定再说」
    const closedByRelease = t.closeCalls
    expect(closedByRelease).toBeGreaterThan(0)
    expect(h.mgr.getStatus('ssh-id', 's1')).toBe('disconnected')
    expect(h.mgr.getRegistrationsByServerName('ssh', 's1')).toEqual([])

    // 握手随后才落定：它自己再收一次尾（见 MCPL-U-14），但绝不能悄悄变回 connected
    t.release()
    expect((await p).ok).toBe(false)
    expect(t.closeCalls).toBeGreaterThan(closedByRelease)
    await settle()
    expect(h.mgr.getStatus('ssh-id', 's1')).toBe('disconnected')
    expect(rejections).toEqual([])
  })

  it('MCPB-U-17: 一份实例关不掉不拖累另一条会话的释放', async () => {
    const h = setup([sshRow()])
    h.plan.set('ssh#s1', { throwOnClose: true })
    h.plan.set('ssh#s2', {})
    await h.mgr.ensureServerByName('ssh', { sessionId: 's1' })
    await h.mgr.ensureServerByName('ssh', { sessionId: 's2' })

    await expect(
      Promise.all([h.mgr.closeSession('s1'), h.mgr.closeSession('s2')])
    ).resolves.toBeDefined()

    expect(h.mgr.getStatus('ssh-id', 's1')).toBe('disconnected')
    expect(h.mgr.getStatus('ssh-id', 's2')).toBe('disconnected')
    expect(released(h.lastFor('ssh', 's2'))).toBe(true)
  })

  it('MCPB-U-18: disconnectAll 走连接键 —— 外部与每条会话的内置实例一个不剩', async () => {
    const h = await twoSessions()

    await h.mgr.disconnectAll()

    // 曾经的洞：disconnectAll 按 serverId 走，`ssh-id#s1` 谁也匹配不上，于是内置实例全留了下来
    expect(released(h.lastFor('ssh', 's1'))).toBe(true)
    expect(released(h.lastFor('ssh', 's2'))).toBe(true)
    expect(released(h.last('a'))).toBe(true)
    expect(toolsFor(h)).toEqual([])
    expect(h.mgr.getStatus('ssh-id')).toBe('disconnected')
    expect(h.mgr.getStatus('a-id')).toBe('disconnected')
  })

  it('MCPB-U-19: disconnect(serverId) 不带会话 = 这台的全部会话分身一起关', async () => {
    const h = await twoSessions()

    // 设置页停用 / 改配置是对**这台服务器整体**下的判断，不该只清掉其中一条会话的分身
    await h.mgr.disconnect('ssh-id')

    expect(released(h.lastFor('ssh', 's1'))).toBe(true)
    expect(released(h.lastFor('ssh', 's2'))).toBe(true)
    expect(h.mgr.getStatus('ssh-id')).toBe('disconnected')
    expect(h.mgr.getStatus('a-id')).toBe('connected')
  })

  it('MCPB-U-20: disconnect(serverId, sessionId) 只关那一条', async () => {
    const h = await twoSessions()
    await h.mgr.disconnect('ssh-id', 's2')

    expect(released(h.lastFor('ssh', 's1'))).toBe(false)
    expect(released(h.lastFor('ssh', 's2'))).toBe(true)
    expect(h.mgr.getStatus('ssh-id', 's1')).toBe('connected')
    expect(h.mgr.getStatus('ssh-id', 's2')).toBe('disconnected')
  })

  it('MCPB-U-21: 给外部服务器传 sessionId 是无意义的调用 —— 静默不动', async () => {
    const h = await twoSessions()

    // 外部服务器的键是裸 serverId，`a-id#s1` 根本不存在；这是「记账口径」而非「找不到就报错」
    await h.mgr.disconnect('a-id', 's1')

    expect(released(h.last('a'))).toBe(false)
    expect(h.mgr.getStatus('a-id')).toBe('connected')
  })

  it('MCPB-U-22: 重连一条会话只换它自己那份实例', async () => {
    const h = await twoSessions()
    const s2Before = h.lastFor('ssh', 's2')

    expect(await h.mgr.connect('ssh-id', { sessionId: 's1' })).toEqual({ ok: true })

    expect(h.madeFor('ssh', 's1')).toHaveLength(2)
    expect(h.madeFor('ssh', 's2')).toHaveLength(1)
    expect(released(s2Before)).toBe(false)
    expect(h.mgr.getStatus('ssh-id', 's1')).toBe('connected')
    expect(h.mgr.getStatus('ssh-id', 's2')).toBe('connected')
  })

  it('MCPB-U-33: 释放之后，会话手里的旧闭包只会报「没连上」，不会串到别人那份实例', async () => {
    const h = await twoSessions()
    const [stale] = h.mgr.getRegistrationsByServerName('ssh', 's1')

    await h.mgr.closeSession('s1')

    // P1-04：失败收成 isError 结果（裁定 Q12，原为抛错），文字不变
    expect(
      await failureText(executeTool(stale, 'call-1', {}, new AbortController().signal))
    ).toContain('[MCP Error] MCP server "ssh" is not connected')
    // 闭包记的是 `ssh-id#s1`，s2 那份实例没有理由收到任何东西
    expect(h.lastFor('ssh', 's2').toolCalls).toEqual([])
  })
})

describe('McpManager 内置服务器的状态查询', () => {
  it('MCPB-U-23: 外部服务器的状态与 sessionId 参数无关', async () => {
    const h = setup([sshRow(), row({ id: 'a-id', name: 'a' })])
    await h.mgr.ensureServerByName('a')
    await h.mgr.ensureServerByName('ssh', { sessionId: 's1' })
    await h.mgr.closeSession('s1')

    // 宿主对所有服务器一律传 sessionId（它不知道哪台是 inproc）—— 裸键优先这一分支就是为它写的
    for (const sid of [undefined, 's1', 's9']) {
      expect(h.mgr.getStatus('a-id', sid)).toBe('connected')
    }
  })

  it('MCPB-U-24: 一条会话都没连的内置服务器 = disconnected', async () => {
    const h = setup([sshRow()])
    expect(h.mgr.getStatus('ssh-id')).toBe('disconnected')
    expect(h.mgr.getStatus('ssh-id', 's1')).toBe('disconnected')
    expect(h.mgr.getError('ssh-id')).toBeUndefined()
  })

  it('MCPB-U-25 / 26 / 27: 不带会话时给聚合值（connected > connecting > error）', async () => {
    // 设置页问的是「这台能力在用吗」，不是某条会话的分身现在怎样
    const connected = setup([sshRow()])
    connected.plan.set('ssh#s2', new Error('boom'))
    await connected.mgr.ensureServerByName('ssh', { sessionId: 's1' })
    await connected.mgr.ensureServerByName('ssh', { sessionId: 's2' })
    expect(connected.mgr.getStatus('ssh-id')).toBe('connected')

    // connecting 压过 error，且与两条会话的**先后无关**
    for (const errorFirst of [false, true]) {
      const h = setup([sshRow()])
      h.plan.set('ssh#s1', { hold: true })
      h.plan.set('ssh#s2', new Error('boom'))
      if (errorFirst) await h.mgr.ensureServerByName('ssh', { sessionId: 's2' })
      void h.mgr.ensureServerByName('ssh', { sessionId: 's1' })
      await settle()
      if (!errorFirst) await h.mgr.ensureServerByName('ssh', { sessionId: 's2' })
      expect(h.mgr.getStatus('ssh-id'), String(errorFirst)).toBe('connecting')
    }

    const failed = setup([sshRow()])
    failed.plan.set('ssh', new Error('builtin exploded'))
    await failed.mgr.ensureServerByName('ssh', { sessionId: 's1' })
    expect(failed.mgr.getStatus('ssh-id')).toBe('error')
    expect(failed.mgr.getError('ssh-id')).toBe('builtin exploded')
  })

  it('MCPB-U-28: 带会话时逐条如实回报', async () => {
    const h = setup([sshRow()])
    h.plan.set('ssh#s2', { hold: true })
    h.plan.set('ssh#s3', new Error('boom'))

    await h.mgr.ensureServerByName('ssh', { sessionId: 's1' })
    void h.mgr.ensureServerByName('ssh', { sessionId: 's2' })
    await settle()
    await h.mgr.ensureServerByName('ssh', { sessionId: 's3' })

    expect(h.mgr.getStatus('ssh-id', 's1')).toBe('connected')
    expect(h.mgr.getStatus('ssh-id', 's2')).toBe('connecting')
    expect(h.mgr.getStatus('ssh-id', 's3')).toBe('error')
    expect(h.mgr.getStatus('ssh-id', 's4')).toBe('disconnected')
    expect(h.mgr.getError('ssh-id', 's3')).toBe('boom')
  })

  it('MCPB-U-29: statusByName 带会话问外部服务器时也读得到（裸键优先）', async () => {
    const h = setup([sshRow(), row({ id: 'a-id', name: 'a' })])
    await h.mgr.ensureServerByName('a')
    await h.mgr.ensureServerByName('ssh', { sessionId: 's1' })

    // 宿主装配工具时只有名字，且对所有服务器一律带上当前会话 —— 少了裸键那一步，
    // 一台连着的 stdio 会被报成「正在连接」，聊天里凭空多出一行提示
    expect(h.mgr.statusByName('a', 's1')).toBe('connected')
    expect(h.mgr.statusByName('a')).toBe('connected')
    expect(h.mgr.statusByName('ssh', 's1')).toBe('connected')
    expect(h.mgr.statusByName('ssh', 's2')).toBe('disconnected')
  })
})

describe('McpManager 内置服务器的可用性与批量装配', () => {
  it('MCPB-U-32: 可用性看配置不看连接 —— 一条会话都没连也照样在勾选列表里', async () => {
    const h = setup([sshRow(), row({ id: 'a-id', name: 'a' })])

    expect(h.mgr.getEnabledToolNames()).toEqual(['mcp:ssh', 'mcp:a'])

    const info = h.mgr.getAllToolInfos().find((i) => i.name === 'mcp:ssh')
    // isBuiltin 是前端把它渲染成「内置能力」而不是一台可编辑服务器的依据
    expect(info).toMatchObject({ isBuiltin: true, serverStatus: 'disconnected' })
  })
})

// ─── annotations 的可信规则 ──────────────────────────────────────────────
//
// MCP 规范要求客户端把**不可信 server** 的 annotations 当作不可信，而这里的做法是
// 「可信才给值」：第三方的四个 hint 一条都不落到客体上。判据是 **`type === 'inproc'`
// 且 isBuiltin** —— 光看 isBuiltin 不行，那一位的含义历来是「用户不可编辑/不可删除的
// 预置行」，v10 种下的 tavily 一度就是个 isBuiltin=1 的**远程 HTTP endpoint**（v24 已降级）。把一串
// 从网上收到的 `readOnlyHint` 当成保证，正好在最不可信的那批上开了口子。

const FULL_HINTS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
} as const

/** 某条连接上某个工具的 mcpMeta */
const metaOf = (
  tools: ReturnType<McpManager['serverToRegistrations']>,
  i = 0
): McpToolMeta['mcpMeta'] => (tools[i] as unknown as McpToolMeta).mcpMeta

describe('McpManager 的 annotations 可信规则', () => {
  it('MCPB-U-36: 可信 server 的四个 hint 原样落到工具事实上', async () => {
    const h = setup([sshRow()])
    h.plan.set('ssh', { tools: [annotated('list-hosts', FULL_HINTS)] })
    await h.mgr.ensureServerByName('ssh', { sessionId: 's1' })

    expect(metaOf(h.mgr.serverToRegistrations('ssh-id#s1'))).toEqual({
      server: 'ssh',
      tool: 'list-hosts',
      trusted: true,
      readOnly: true,
      destructive: false,
      idempotent: true,
      openWorld: false
    })
  })

  it('MCPB-U-37: 第三方 server 声明了四个 hint 也一条不落 —— 包括 readOnlyHint:false', async () => {
    const h = setup([row({ id: 'a-id', name: 'a' })])
    h.plan.set('a', { tools: [annotated('search', { ...FULL_HINTS, readOnlyHint: false })] })
    await h.mgr.ensureServerByName('a')

    // 连「它自称不是只读」都不收：策略于是只能写成 fail-safe 的
    // `has(object.mcpServer) && !(object.mcpTrusted && object.readOnly)`，
    // 而不会因为第三方少写/写反一个字段就改变判定
    expect(metaOf(h.mgr.serverToRegistrations('a-id'))).toEqual({
      server: 'a',
      tool: 'search',
      trusted: false,
      readOnly: undefined,
      destructive: undefined,
      idempotent: undefined,
      openWorld: undefined
    })
  })

  it('MCPB-U-38: 可信但没声明 annotations → 四位都是 undefined，trusted 仍为真', async () => {
    const h = setup([sshRow()])
    h.plan.set('ssh', { tools: [tool('list-hosts')] })
    await h.mgr.ensureServerByName('ssh', { sessionId: 's1' })

    const meta = metaOf(h.mgr.serverToRegistrations('ssh-id#s1'))
    // 「没说」不等于 false：把缺省当成「不是只读」会让 fail-safe 策略对内置工具也弹卡
    expect(meta).toEqual({
      server: 'ssh',
      tool: 'list-hosts',
      trusted: true,
      readOnly: undefined,
      destructive: undefined,
      idempotent: undefined,
      openWorld: undefined
    })
  })

  it('MCPB-U-39: 可信 server 只声明了一部分 —— 给了的落，没给的仍是 undefined', async () => {
    const h = setup([sshRow()])
    h.plan.set('ssh', { tools: [annotated('exec', { readOnlyHint: false, openWorldHint: true })] })
    await h.mgr.ensureServerByName('ssh', { sessionId: 's1' })

    expect(metaOf(h.mgr.serverToRegistrations('ssh-id#s1'))).toEqual({
      server: 'ssh',
      tool: 'exec',
      trusted: true,
      readOnly: false,
      destructive: undefined,
      idempotent: undefined,
      openWorld: true
    })
  })

  it('MCPB-U-40: 信任是**按连接**记的 —— 同一批工具里两台 server 各算各的', async () => {
    const h = setup([sshRow(), row({ id: 'a-id', name: 'a' })])
    h.plan.set('ssh', { tools: [annotated('list-hosts', FULL_HINTS)] })
    h.plan.set('a', { tools: [annotated('search', FULL_HINTS)] })
    await h.mgr.ensureServerByName('ssh', { sessionId: 's1' })
    await h.mgr.ensureServerByName('a')

    const byName = new Map(
      toolsFor(h, 's1').map((t) => [
        (t as unknown as McpToolMeta).mcpMeta.server,
        (t as unknown as McpToolMeta).mcpMeta
      ])
    )
    expect(byName.get('ssh')).toMatchObject({ trusted: true, readOnly: true })
    expect(byName.get('a')).toMatchObject({ trusted: false, readOnly: undefined })
  })

  it('MCPB-U-41: isBuiltin=1 的**远程** endpoint（v10~v23 的 tavily 形态）不可信', async () => {
    // 那一位的含义是「用户不可编辑」，不是「代码随产品发布」；两者混同一次，
    // 一台远程 server 就能用自述的 readOnlyHint 换来静默放行
    const h = setup([row({ id: 'builtin-mcp-tavily', name: 'tavily', type: 'http', isBuiltin: 1 })])
    h.plan.set('tavily', { tools: [annotated('search', FULL_HINTS)] })
    await h.mgr.ensureServerByName('tavily')

    expect(metaOf(h.mgr.serverToRegistrations('builtin-mcp-tavily'))).toMatchObject({
      server: 'tavily',
      trusted: false,
      readOnly: undefined
    })
  })
})

// ─── 工具桥接的其余契约 ──────────────────────────────────────────────────

describe('McpManager 的 MCP → durable 注册项', () => {
  it('MCPB-U-42: pi 那边的 toolCallId 经 `_meta` 带给 server', async () => {
    const h = setup([sshRow()])
    h.plan.set('ssh', { tools: [tool('exec')] })
    await h.mgr.ensureServerByName('ssh', { sessionId: 's1' })

    const [t] = h.mgr.serverToRegistrations('ssh-id#s1')
    await executeTool(t, 'pi-call-42', { q: 'x' }, new AbortController().signal)

    // 询问卡片的路由键按约定就是 toolCallId —— 少了它，内置服务器的 ask 就对不上这次调用。
    // （可信 server 另收 durable taskId：executeTool 缺省 taskId 1）
    expect(h.lastFor('ssh', 's1').toolCallMetas).toEqual([
      { 'shuvix.dev/toolCallId': 'pi-call-42', 'shuvix.dev/taskId': 1 }
    ])
  })

  it('MCPB-U-43: 没有 toolCallId 时 `_meta` 整个缺席，而不是一个空对象', async () => {
    const h = setup([sshRow()])
    h.plan.set('ssh', { tools: [tool('exec')] })
    await h.mgr.ensureServerByName('ssh', { sessionId: 's1' })

    // 直接走 callTool（注册项那条路恒有 toolCallId）
    await h.mgr.callTool('ssh-id#s1', 'exec', { q: 'x' })

    // 空对象是个**存在的** `_meta`：规范要求其中的键带前缀，凭空一个 `{}` 只会让
    // 严格的 server 多一次校验分支
    expect(h.lastFor('ssh', 's1').toolCallMetas).toEqual([undefined])
  })

  it('MCPB-U-44: server 名里带 `__` 时，工具名拼接不影响事实里的那两个字段', async () => {
    const h = setup([row({ id: 'ab-id', name: 'a__b' })])
    h.plan.set('a__b', { tools: [tool('t')] })
    await h.mgr.ensureServerByName('a__b')

    const [t] = h.mgr.serverToRegistrations('ab-id')
    // 前缀是给 LLM 看的名字，切不回来也没关系：策略读的是 mcpMeta，不是拆名字
    expect(t.name).toBe('mcp__a__b__t')
    expect(metaOf(h.mgr.serverToRegistrations('ab-id'))).toMatchObject({
      server: 'a__b',
      tool: 't'
    })
  })

  it('MCPB-U-45: mcpMeta 经原型链也读得到 —— wrapToolOutput 就是这么读的', async () => {
    const h = setup([sshRow()])
    h.plan.set('ssh', { tools: [annotated('list-hosts', FULL_HINTS)] })
    await h.mgr.ensureServerByName('ssh', { sessionId: 's1' })

    const [t] = h.mgr.serverToRegistrations('ssh-id#s1')
    // 包装器用 Object.create(tool) 保原型链（`{...tool}` 会把 class getter 静默丢掉），
    // 所以 mcpMeta 必须是能沿原型链查到的东西，而不是只在自身属性上
    const wrapped = Object.create(Object.create(t)) as McpToolMeta
    expect(wrapped.mcpMeta).toBe((t as unknown as McpToolMeta).mcpMeta)
    expect(wrapped.mcpMeta).toMatchObject({ server: 'ssh', trusted: true, readOnly: true })
  })
})

// ─── MCP 结果 content → pi content ───────────────────────────────────────
//
// 旧实现把整份结果压成一段文字：第三方 server 的截图于是成了 `[image: image/png]` 一行字，
// 从来到不了模型。现在图片原样过去 —— 反面随之而来：模型**收不下**的图（格式不对、太大）
// 原样送出去，整次请求就被拒；而工具结果进了会话树、每一轮都重发，这条会话之后的每一轮都失败。
// 所以这一组钉两件事：该过去的原样过去、不多不少；过不去的换成一行说得清的文字。
//
// 这一半直接喂纯函数：SDK 会先按 CallToolResultSchema 校验整份结果，规范之外的形态
// （未知块类型、缺 mime、null 项……）只能在这里测。文案只钉事实（mime、uri、大小、
// 「没转发」、单独一行），契约写死了的几处除外。

/** 1×1 PNG —— 合法 base64（SDK 拿 atob 校验），也足够有特征，便于断言「它没外泄」 */
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
/** JPEG 文件头（SOI + APP0） */
const JPEG = '/9j/4AAQSkZJRgAB'

const text = (t: string): { type: 'text'; text: string } => ({ type: 'text', text: t })
const img = (
  data = PNG,
  mimeType = 'image/png'
): { type: 'image'; data: string; mimeType: string } => ({ type: 'image', data, mimeType })

/** 结果恰好是**一个**文本块（没有图片块、也没被拆成几段）时，取它的文字 */
function onlyText(blocks: ReturnType<typeof mcpContentToToolContent>): string {
  expect(blocks).toHaveLength(1)
  const [block] = blocks
  expect(block.type).toBe('text')
  return block.type === 'text' ? block.text : ''
}

/** `haystack` 里依次出现 `facts`（每一条都在上一条之后）—— 措辞不钉，只钉事实与先后 */
function expectInOrder(haystack: string, facts: string[]): void {
  let from = 0
  for (const fact of facts) {
    const at = haystack.indexOf(fact, from)
    expect(at, `「${fact}」应出现在第 ${from} 个字符之后：\n${haystack}`).toBeGreaterThanOrEqual(0)
    from = at + fact.length
  }
}

describe('mcpContentToToolContent：MCP 结果 content → pi content', () => {
  it('MCPB-U-46: 相邻的文本块合成一块，按行拼接', () => {
    expect(mcpContentToToolContent([text('a'), text('b')])).toStrictEqual([text('a\nb')])
  })

  it('MCPB-U-47: 图片原样保留为图片块，与文字的先后不变；合并不跨过图片', () => {
    expect(mcpContentToToolContent([text('a'), img(), text('b')])).toStrictEqual([
      text('a'),
      img(),
      text('b')
    ])
    expect(
      mcpContentToToolContent([text('a'), text('b'), img(), text('c'), text('d')])
    ).toStrictEqual([text('a\nb'), img(), text('c\nd')])
  })

  it('MCPB-U-48: 只有图片时不多出空文本块', () => {
    expect(mcpContentToToolContent([img(), img(JPEG, 'image/jpeg')])).toStrictEqual([
      img(),
      img(JPEG, 'image/jpeg')
    ])
    expect(mcpContentToToolContent([img()])).toStrictEqual([img()])
  })

  it('MCPB-U-49: 图片块只带 type / data / mimeType —— annotations、_meta 不跟进模型上下文', () => {
    const decorated = {
      ...img(),
      annotations: { audience: ['user'], priority: 0.5 },
      _meta: { 'vendor.example/id': 'x' }
    }
    expect(mcpContentToToolContent([decorated])).toStrictEqual([
      { type: 'image', data: PNG, mimeType: 'image/png' }
    ])
  })

  it('MCPB-U-50: 单图上限卡在 MAX_INLINE_IMAGE_BASE64 —— 恰好等于放行，多一个字符就换成一行说明', () => {
    const atLimit = 'A'.repeat(MAX_INLINE_IMAGE_BASE64)
    expect(mcpContentToToolContent([img(atLimit)])).toStrictEqual([img(atLimit)])

    const note = onlyText(mcpContentToToolContent([img('A'.repeat(MAX_INLINE_IMAGE_BASE64 + 1))]))
    expect(note).not.toContain('\n')
    expect(note).toContain('image/png')
    // 报的是大约体积：让模型知道有过这张图、以及它为什么没看到
    expect(note).toMatch(/~\d+(\.\d)? MB/)
    expect(note).not.toContain('A'.repeat(16))
  })

  it('MCPB-U-51: 超限的图夹在文字中间 —— 说明占它那一行，前后文字照常合进同一块', () => {
    const over = img('A'.repeat(MAX_INLINE_IMAGE_BASE64 + 1))
    const lines = onlyText(mcpContentToToolContent([text('a'), over, text('b')])).split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toBe('a')
    expect(lines[1]).toContain('image/png')
    expect(lines[2]).toBe('b')
  })

  it('MCPB-U-52: data 为空的图不发出去，换成点名 mime 的一行说明', () => {
    const lines = onlyText(
      mcpContentToToolContent([text('a'), img('', 'image/webp'), text('b')])
    ).split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toBe('a')
    expect(lines[1]).toContain('image/webp')
    expect(lines[1]).toContain('empty')
    expect(lines[2]).toBe('b')
  })

  it('MCPB-U-53: 只放行模型收得下的四种格式；大小写与 image/jpg 归一', () => {
    // 其余格式原样送出去就是一次 400，而这条会话之后每一轮都会把它重发一遍
    const rejected: Array<[string, Record<string, unknown>]> = [
      ['image/svg+xml', img(PNG, 'image/svg+xml')],
      ['image/bmp', img(PNG, 'image/bmp')],
      ['no type', { type: 'image', data: PNG }]
    ]
    for (const [named, block] of rejected) {
      const note = onlyText(mcpContentToToolContent([block]))
      expect(note, named).toContain(named)
      expect(note, named).toContain('is not a format models accept')
      expect(note, named).not.toContain('\n')
    }

    expect(mcpContentToToolContent([img(PNG, 'IMAGE/PNG')])).toStrictEqual([img(PNG, 'image/png')])
    expect(mcpContentToToolContent([img(JPEG, 'image/jpg')])).toStrictEqual([
      img(JPEG, 'image/jpeg')
    ])
  })

  it('MCPB-U-54: 音频没有对应的模型输入 —— 一行说明它没被转发，base64 哪儿都不出现', () => {
    const WAV = 'UklGRiQAAABXQVZFZm10IGF1ZGlvLWJ5dGVzLWhlcmU='
    const out = mcpContentToToolContent([{ type: 'audio', data: WAV, mimeType: 'audio/wav' }])
    const line = onlyText(out)
    expect(line).not.toContain('\n')
    expect(line).toContain('audio/wav')
    expect(line).toMatch(/not forwarded/)
    expect(JSON.stringify(out)).not.toContain(WAV.slice(0, 16))
  })

  it('MCPB-U-55: resource_link —— title 优先于 name，mime 有才写，uri 不重复，缺 uri 不留空格', () => {
    const lineOf = (link: Record<string, unknown>): string =>
      onlyText(mcpContentToToolContent([{ type: 'resource_link', ...link }]))

    const titled = lineOf({
      uri: 'file:///w/report.pdf',
      name: 'q3-draft',
      title: 'Q3 Report',
      mimeType: 'application/pdf'
    })
    expect(titled.startsWith('[resource: Q3 Report')).toBe(true)
    expect(titled).not.toContain('q3-draft')
    expect(titled).toContain('(application/pdf)')
    expect(titled).toContain('file:///w/report.pdf')

    // 没有 title 用 name；没有 mime 就没有那对括号
    const named = lineOf({ uri: 'file:///w/a.txt', name: 'a.txt' })
    expect(named.startsWith('[resource: a.txt')).toBe(true)
    expect(named).not.toContain('(')
    expect(named).toContain('file:///w/a.txt')

    // 标签回落到 uri 时，uri 不在后面再重复一遍
    const bare = lineOf({ uri: 'file:///w/only.txt' })
    expect(bare.split('file:///w/only.txt')).toHaveLength(2)

    // 没有 uri：右括号前不留空格
    expect(lineOf({ name: 'n' })).toBe('[resource: n]')
  })

  it('MCPB-U-56: 内嵌文本资源给正文（有 uri 时先一行 `[resource: <uri>]`），与前后文字合进同一块', () => {
    expect(
      mcpContentToToolContent([
        text('a'),
        {
          type: 'resource',
          resource: { uri: 'file:///w/notes.md', mimeType: 'text/markdown', text: '# Notes\nbody' }
        },
        text('b')
      ])
    ).toStrictEqual([text('a\n[resource: file:///w/notes.md]\n# Notes\nbody\nb')])

    expect(
      mcpContentToToolContent([{ type: 'resource', resource: { text: 'plain body' } }])
    ).toStrictEqual([text('plain body')])
  })

  it('MCPB-U-57: 内嵌二进制资源只报解码后的字节数，不给 base64', () => {
    // 34 字节 → base64 结尾带 `==`：字节数要扣掉填充
    const BLOB = 'YmluYXJ5IHBheWxvYWQgdGhhdCBtdXN0IG5vdCBsZWFrIQ=='
    const out = mcpContentToToolContent([
      {
        type: 'resource',
        resource: { uri: 'file:///w/c.bin', mimeType: 'application/octet-stream', blob: BLOB }
      }
    ])
    const line = onlyText(out)
    expect(line).not.toContain('\n')
    expect(line).toContain('file:///w/c.bin')
    expect(line).toContain('application/octet-stream')
    expect(line).toContain('34 bytes')
    expect(line).toContain('binary not shown')
    expect(JSON.stringify(out)).not.toContain(BLOB.slice(0, 16))

    // 没有 mime：括号里直接是字节数
    const noMime = onlyText(
      mcpContentToToolContent([
        { type: 'resource', resource: { uri: 'file:///w/c.bin', blob: 'YWJj' } }
      ])
    )
    expect(noMime).toContain('(3 bytes, binary not shown)')

    // 扣填充：一个 `=`（hello → 5）、无填充（abc → 3）、两个 `=`（a → 1）
    for (const [blob, bytes] of [
      ['aGVsbG8=', 5],
      ['YWJj', 3],
      ['YQ==', 1]
    ] as const) {
      const padded = onlyText(
        mcpContentToToolContent([{ type: 'resource', resource: { uri: 'u', blob } }])
      )
      expect(padded, blob).toContain(`(${bytes} bytes`)
    }
  })

  it('MCPB-U-58: 不认识的块类型给它的 JSON，与前后文字合进同一块', () => {
    const foo = { type: 'foo', x: 1 }
    expect(mcpContentToToolContent([text('a'), foo, text('b')])).toStrictEqual([
      text(`a\n${JSON.stringify(foo)}\nb`)
    ])
  })

  it('MCPB-U-59: 空 content 给空数组；null / 非对象项不抛', () => {
    expect(mcpContentToToolContent([])).toStrictEqual([])
    expect(() => mcpContentToToolContent([null, 42])).not.toThrow()
  })
})

// ─── 执行结果：经假 server 的一次 tools/call ──────────────────────────────
//
// 上面那组的结论要在真正的调用路径上也成立：结果先过 SDK 的 schema 校验，再经注册项的
// execute 变成 pi 的结果。这里只喂 SDK 收得下的形态（见 FakeOpts.callResult 的注意事项）。

type McpTool = ReturnType<McpManager['serverToRegistrations']>[number]

/** 连上一份内置 ssh（会话 s1），它唯一的工具 `exec` 的 tools/call 回 `callResult` */
async function sshExecReturning(
  callResult: FakeOpts['callResult']
): Promise<{ h: Harness; exec: McpTool }> {
  const h = setup([sshRow()])
  h.plan.set('ssh', { tools: [tool('exec')], callResult })
  await h.mgr.ensureServerByName('ssh', { sessionId: 's1' })
  const [exec] = h.mgr.getRegistrationsByServerName('ssh', 's1')
  return { h, exec }
}

const run = (
  t: McpTool,
  toolCallId = 'pi-1',
  args: Record<string, unknown> = {}
): Promise<InvokedToolResult> => executeTool(t, toolCallId, args, new AbortController().signal)

/** 成功结果的 details：server 是配置行名、tool 不带前缀，没有 isError 这个键 */
const OK_DETAILS = { type: 'mcp', server: 'ssh', tool: 'exec' }

describe('McpManager 执行结果：经假 server 的一次 tools/call', () => {
  it('MCPB-U-60: 一张 PNG 原样到达 —— 图片块，而不是一行 `[image: image/png]`', async () => {
    const { exec } = await sshExecReturning({ content: [img()] })
    const result = await run(exec)
    expect(result.content).toStrictEqual([{ type: 'image', data: PNG, mimeType: 'image/png' }])
    expect(result.details).toStrictEqual(OK_DETAILS)
  })

  it('MCPB-U-61: 混排结果 —— 各类说明按原顺序合进图片前那块文字，图片与其后的文字各自成块', async () => {
    const { exec } = await sshExecReturning({
      content: [
        text('first'),
        { type: 'resource_link', uri: 'file:///w/a.txt', name: 'a.txt', mimeType: 'text/plain' },
        {
          type: 'resource',
          resource: { uri: 'file:///w/b.md', mimeType: 'text/markdown', text: 'B body' }
        },
        {
          type: 'resource',
          resource: { uri: 'file:///w/c.bin', mimeType: 'application/octet-stream', blob: 'YWJj' }
        },
        { type: 'audio', data: 'AAAA', mimeType: 'audio/wav' },
        img(),
        text('last')
      ]
    })
    const result = await run(exec)

    expect(result.content).toHaveLength(3)
    const [head, image, tail] = result.content
    expect(image).toStrictEqual(img())
    expect(tail).toStrictEqual(text('last'))
    const merged = onlyText([head])
    expectInOrder(merged, [
      'first',
      'a.txt',
      'text/plain',
      'file:///w/a.txt',
      'file:///w/b.md',
      'B body',
      'file:///w/c.bin',
      'application/octet-stream',
      '3 bytes',
      'binary not shown',
      'audio/wav',
      'not forwarded'
    ])
    // 每个块一行（文本资源是「uri 一行 + 正文」）：谁也没把谁拆开或吞掉
    expect(merged.split('\n')).toHaveLength(6)
    expect(merged).not.toContain('YWJj')
    expect(merged).not.toContain('AAAA')
    expect(result.details).toStrictEqual(OK_DETAILS)
  })

  it('MCPB-U-62: 空 content、以及压根没有 content 键 → 一个空文本块（不是空数组），也不算出错', async () => {
    const { exec } = await sshExecReturning((call) =>
      call.args.q === 'no-key' ? {} : { content: [] }
    )
    for (const q of ['empty', 'no-key']) {
      const result = await run(exec, 'pi-1', { q })
      expect(result.content, q).toStrictEqual([{ type: 'text', text: '' }])
      expect(result.details, q).toStrictEqual(OK_DETAILS)
    }
  })

  it('MCPB-U-63: 成功时 details 恰是 {type, server, tool} —— 没有连接键、没有前缀名、没有 isError', async () => {
    const { exec } = await sshExecReturning({ content: [text('ok')] })
    const result = await run(exec)
    // 不是连接键 `ssh-id#s1`，也不是 LLM 看到的 `mcp__ssh__exec`
    expect(result.details).toStrictEqual({ type: 'mcp', server: 'ssh', tool: 'exec' })
    expect(result.content).toStrictEqual([text('ok')])
  })

  // isError 的结果记成失败的调用（界面标红、不并进已完成的步骤组），失败的文字就是模型看到的内容。
  // P1-04 起桥接层不再靠抛出表达失败：抛出的消息由 durable 桥收成 `{ isError: true, content: [文字] }`
  // （裁定 Q12），文字与原先抛出的消息逐字相同
  const failureOf = (exec: McpTool): Promise<string> => failureText(run(exec))

  it('MCPB-U-64: isError 的结果只给文字 —— 图片写成 `[image: <mime>]`，base64 不外泄', async () => {
    const { exec } = await sshExecReturning({
      isError: true,
      content: [text('a'), img(), text('b')]
    })
    const message = await failureOf(exec)
    expect(message).toBe('[MCP Error] a\n[image: image/png]\nb')
    expect(message).not.toContain(PNG.slice(0, 24))
  })

  it('MCPB-U-65: isError 只有一段文字 → `[MCP Error] <文字>`', async () => {
    const { exec } = await sshExecReturning({ isError: true, content: [text('boom')] })
    expect(await failureOf(exec)).toBe('[MCP Error] boom')
  })

  it('MCPB-U-66: isError 却什么都没说 → `[MCP Error] (no details)`，而不是一个悬空的前缀', async () => {
    const { exec } = await sshExecReturning({ isError: true })
    expect(await failureOf(exec)).toBe('[MCP Error] (no details)')
  })

  it('MCPB-U-67: server 回的图模型收不下（超限 / svg）—— 一个图片块都不出，每张一行说明，不算出错', async () => {
    // 长度取 4 的倍数：SDK 用 atob 校验 base64，不合法的话整份结果会被拒成 [MCP Error]，
    // 那样「没有图片块」就是因为错误的理由成立的
    const huge = 'A'.repeat(MAX_INLINE_IMAGE_BASE64 + 4)
    const { exec } = await sshExecReturning({
      content: [text('shot:'), img(huge), img(PNG, 'image/svg+xml')]
    })
    const result = await run(exec)

    const lines = onlyText(result.content).split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toBe('shot:')
    expect(lines[1]).toContain('image/png')
    expect(lines[1]).toMatch(/~\d+(\.\d)? MB/)
    expect(lines[2]).toContain('image/svg+xml')
    expect(lines[2]).toContain('is not a format models accept')
    expect(JSON.stringify(result).length).toBeLessThan(1000)
    expect(result.details).toStrictEqual(OK_DETAILS)
  })
})

// ─── `_meta`：toolCallId 给所有 server，调用方 id 只给可信 server ──────────
//
// 一份内置实例由根 agent 与它派出的 agent 共用（实例按根会话取），实例里要按调用方分开的状态
// （浏览器「距上次快照几次操作」、快照差异的基线）只能靠每次调用带上的 `shuvix.dev/agentId`。
// 第三方 server 拿到它毫无用处，也就不该知道 ShuviX 内部的 id —— 可信的判据与 annotations
// 同一条：`type: 'inproc'` 且 isBuiltin。durable 的 tool task id（`shuvix.dev/taskId`，询问 /
// 审查归属按 (会话, taskId) 认人，裁定 Q16）走同一条规则。
//
// 断言一律对整个 `_meta` 用 toStrictEqual：`toHaveProperty('shuvix.dev/agentId')` 会把点号
// 当成路径，`toEqual` 又会放过值为 undefined 的键。

const TOOL_CALL = 'shuvix.dev/toolCallId'
const AGENT = 'shuvix.dev/agentId'
/** durable tool task id —— 与调用方 id 同一条规则，只给可信 server（run / executeTool 缺省 taskId 1） */
const TASK = 'shuvix.dev/taskId'

/** 连上一份内置 ssh（会话 s1，工具 `exec`） */
async function trustedSsh(): Promise<Harness> {
  const h = setup([sshRow()])
  h.plan.set('ssh', { tools: [tool('exec')] })
  await h.mgr.ensureServerByName('ssh', { sessionId: 's1' })
  return h
}

describe('McpManager 的 `_meta`：调用方 id 只给可信 server', () => {
  it('MCPB-U-68: 可信 server —— toolCallId 与调用方 id 一起带上', async () => {
    const h = await trustedSsh()
    const [exec] = h.mgr.getRegistrationsByServerName('ssh', 's1', { callerIdOf: () => 's1' })
    await run(exec, 'pi-1')
    expect(h.lastFor('ssh', 's1').toolCallMetas).toStrictEqual([
      { [TOOL_CALL]: 'pi-1', [AGENT]: 's1', [TASK]: 1 }
    ])
  })

  it('MCPB-U-69: 同一份实例、两个调用方 —— 每次调用各报各的，实例不因此多造一份', async () => {
    const h = await trustedSsh()
    const [root] = h.mgr.getRegistrationsByServerName('ssh', 's1', { callerIdOf: () => 's1' })
    const [spawned] = h.mgr.getRegistrationsByServerName('ssh', 's1', {
      callerIdOf: () => 'agent-7'
    })

    await run(root, 'pi-1')
    await run(spawned, 'pi-2')
    await run(root, 'pi-3')

    expect(h.made('ssh')).toHaveLength(1)
    const metas = h.lastFor('ssh', 's1').toolCallMetas
    expect(metas.map((m) => m?.[AGENT])).toEqual(['s1', 'agent-7', 's1'])
    expect(metas.map((m) => m?.[TOOL_CALL])).toEqual(['pi-1', 'pi-2', 'pi-3'])
  })

  it('MCPB-U-70: 不可信的行一律不带调用方 id —— 标了 isBuiltin 的 http/stdio、没标 isBuiltin 的 inproc 都算', async () => {
    const rows: Array<[string, McpServer]> = [
      ['http / isBuiltin 0', row({ id: 'h0-id', name: 'h0' })],
      ['http / isBuiltin 1', row({ id: 'h1-id', name: 'h1', isBuiltin: 1 })],
      [
        'stdio / isBuiltin 0',
        row({ id: 'p0-id', name: 'p0', type: 'stdio', command: 'node', url: '' })
      ],
      [
        'stdio / isBuiltin 1',
        row({ id: 'p1-id', name: 'p1', type: 'stdio', command: 'node', url: '', isBuiltin: 1 })
      ],
      ['inproc / isBuiltin 0', row({ id: 'i0-id', name: 'i0', type: 'inproc', url: '' })]
    ]
    for (const [label, server] of rows) {
      const h = setup([server])
      h.plan.set(server.name, { tools: [tool('exec')] })
      // inproc 要会话才连得上；外部服务器对 sessionId 视而不见
      expect(await h.mgr.ensureServerByName(server.name, { sessionId: 's1' }), label).toEqual({
        ok: true
      })
      const [t] = h.mgr.getRegistrationsByServerName(server.name, 's1', {
        callerIdOf: () => 'agent-x'
      })
      expect((t as unknown as McpToolMeta).mcpMeta.trusted, label).toBe(false)

      await run(t, 'pi-1')
      expect(h.last(server.name).toolCallMetas, label).toStrictEqual([{ [TOOL_CALL]: 'pi-1' }])
    }
  })

  it('MCPB-U-71: 不可信 server 直接走 callTool、只给了调用方 id → `_meta` 整个缺席', async () => {
    const h = setup([row({ id: 'a-id', name: 'a' })])
    h.plan.set('a', { tools: [tool('search')] })
    await h.mgr.ensureServerByName('a')

    await h.mgr.callTool('a-id', 'search', { q: 'x' }, undefined, { callerId: 'agent-x' })
    expect(h.last('a').toolCallMetas).toStrictEqual([undefined])
  })

  it('MCPB-U-72: 可信 server 没有 toolCallId、只有调用方 id → `_meta` 里恰好只有它', async () => {
    const h = await trustedSsh()
    await h.mgr.callTool('ssh-id#s1', 'exec', { q: 'x' }, undefined, { callerId: 'agent-x' })
    expect(h.lastFor('ssh', 's1').toolCallMetas).toStrictEqual([{ [AGENT]: 'agent-x' }])
  })

  it('MCPB-U-73: 空串算没有 —— 两个都空则 `_meta` 缺席，只有 toolCallId 非空则只带它', async () => {
    const h = await trustedSsh()
    await h.mgr.callTool('ssh-id#s1', 'exec', {}, undefined, { toolCallId: '', callerId: '' })
    await h.mgr.callTool('ssh-id#s1', 'exec', {}, undefined, { toolCallId: 'pi-1', callerId: '' })
    expect(h.lastFor('ssh', 's1').toolCallMetas).toStrictEqual([undefined, { [TOOL_CALL]: 'pi-1' }])
  })

  it('MCPB-U-74: 取工具时没给调用方 id → 可信 server 也不带（按名取、全量取都一样；taskId 照带）', async () => {
    const h = await trustedSsh()
    const [byName] = h.mgr.getRegistrationsByServerName('ssh', 's1')
    const [fromAll] = toolsFor(h, 's1')

    await run(byName, 'pi-1')
    await run(fromAll, 'pi-2')
    expect(h.lastFor('ssh', 's1').toolCallMetas).toStrictEqual([
      { [TOOL_CALL]: 'pi-1', [TASK]: 1 },
      { [TOOL_CALL]: 'pi-2', [TASK]: 1 }
    ])
  })
})

describe('McpManager 取工具的三条路都把调用方 id 带到调用上', () => {
  it('MCPB-U-75: 按连接键 / 按名 / 全量取 —— 每批工具报的是自己拿到的那个 id', async () => {
    const h = await trustedSsh()
    const [viaKey] = h.mgr.serverToRegistrations('ssh-id#s1', { callerIdOf: () => 'c1' })
    const [viaName] = h.mgr.getRegistrationsByServerName('ssh', 's1', { callerIdOf: () => 'c2' })
    const [viaAll] = toolsFor(h, 's1', { callerIdOf: () => 'c3' })

    await run(viaKey, 'pi-1')
    await run(viaName, 'pi-2')
    await run(viaAll, 'pi-3')
    expect(h.lastFor('ssh', 's1').toolCallMetas).toStrictEqual([
      { [TOOL_CALL]: 'pi-1', [AGENT]: 'c1', [TASK]: 1 },
      { [TOOL_CALL]: 'pi-2', [AGENT]: 'c2', [TASK]: 1 },
      { [TOOL_CALL]: 'pi-3', [AGENT]: 'c3', [TASK]: 1 }
    ])
  })

  it('MCPB-U-76: 全量取的一批里混着可信与不可信 —— 只有可信的那台收到调用方 id', async () => {
    const h = setup([sshRow(), row({ id: 'a-id', name: 'a' })])
    h.plan.set('ssh', { tools: [tool('exec')] })
    h.plan.set('a', { tools: [tool('search')] })
    await h.mgr.ensureServerByName('ssh', { sessionId: 's1' })
    await h.mgr.ensureServerByName('a')

    const byName = new Map(
      toolsFor(h, 's1', { callerIdOf: () => 'agent-7' }).map((t) => [t.name, t])
    )
    expect([...byName.keys()].sort()).toEqual(['mcp__a__search', 'mcp__ssh__exec'])
    await run(byName.get('mcp__ssh__exec')!, 'pi-1')
    await run(byName.get('mcp__a__search')!, 'pi-2')

    expect(h.lastFor('ssh', 's1').toolCallMetas).toStrictEqual([
      { [TOOL_CALL]: 'pi-1', [AGENT]: 'agent-7', [TASK]: 1 }
    ])
    expect(h.last('a').toolCallMetas).toStrictEqual([{ [TOOL_CALL]: 'pi-2' }])
  })
})

// ─── 一条会话能拿到的工具：会话范围 ─────────────────────────────────────────
//
// 按会话取工具不许回落到别人的实例：不传会话就一台 inproc 都不给，传了只给
// 这条会话自己那份。否则两条会话会拿到同名的两套工具，名字一样、闭包各指一份实例 ——
// 模型调到哪一个全凭顺序，操作的可能是另一条会话的 ssh / 浏览器。

const namesOf = (tools: McpTool[]): string[] => tools.map((t) => t.name).sort()

/** 一台外部服务器 a + 会话 s1 的一份内置 ssh */
async function globalAndS1(): Promise<Harness> {
  const h = setup([sshRow(), row({ id: 'a-id', name: 'a' })])
  h.plan.set('ssh', { tools: [tool('list-hosts')] })
  h.plan.set('a', { tools: [tool('search')] })
  await h.mgr.ensureServerByName('a')
  await h.mgr.ensureServerByName('ssh', { sessionId: 's1' })
  return h
}

describe('McpManager 按会话取工具的范围', () => {
  it('MCPB-U-77: 不传会话 → 只有全局服务器的工具，一台 inproc 都不给', async () => {
    const h = await globalAndS1()
    expect(namesOf(toolsFor(h))).toEqual(['mcp__a__search'])
  })

  it('MCPB-U-78: 传了会话 → 全局服务器 + 这条会话自己那份 inproc', async () => {
    const h = await globalAndS1()
    expect(namesOf(toolsFor(h, 's1'))).toEqual(['mcp__a__search', 'mcp__ssh__list-hosts'])
  })

  it('MCPB-U-79: 两条会话的实例工具不同 —— 各自只看见自己那份', async () => {
    const h = setup([sshRow()])
    h.plan.set('ssh#s1', { tools: [tool('list-hosts')] })
    h.plan.set('ssh#s2', { tools: [tool('s2-only')] })
    await h.mgr.ensureServerByName('ssh', { sessionId: 's1' })
    await h.mgr.ensureServerByName('ssh', { sessionId: 's2' })

    expect(namesOf(toolsFor(h, 's1'))).toEqual(['mcp__ssh__list-hosts'])
    expect(namesOf(toolsFor(h, 's2'))).toEqual(['mcp__ssh__s2-only'])
  })

  it('MCPB-U-80: 两条会话的实例工具同名 —— 各自恰好一个，调用落在自己那份实例上', async () => {
    const h = setup([sshRow()])
    h.plan.set('ssh', { tools: [tool('list-hosts')] })
    await h.mgr.ensureServerByName('ssh', { sessionId: 's1' })
    await h.mgr.ensureServerByName('ssh', { sessionId: 's2' })

    const s1Tools = toolsFor(h, 's1')
    expect(s1Tools.map((t) => t.name)).toEqual(['mcp__ssh__list-hosts'])
    expect(onlyText((await run(s1Tools[0])).content)).toBe('handled by s1')
    expect(h.lastFor('ssh', 's1').toolCalls).toHaveLength(1)
    expect(h.lastFor('ssh', 's2').toolCalls).toEqual([])

    // 反过来也一样
    const s2Tools = toolsFor(h, 's2')
    expect(s2Tools.map((t) => t.name)).toEqual(['mcp__ssh__list-hosts'])
    expect(onlyText((await run(s2Tools[0])).content)).toBe('handled by s2')
    expect(h.lastFor('ssh', 's2').toolCalls).toHaveLength(1)
    expect(h.lastFor('ssh', 's1').toolCalls).toHaveLength(1)
  })

  it('MCPB-U-81: 这条会话没有实例 → 只有全局服务器，不回落到 s1 那份', async () => {
    const h = await globalAndS1()
    expect(namesOf(toolsFor(h, 's9'))).toEqual(['mcp__a__search'])
  })

  it('MCPB-U-82: 释放了的、连接中的、连失败的实例都不出工具；别的会话不受影响', async () => {
    const h = setup([sshRow(), row({ id: 'a-id', name: 'a' })])
    h.plan.set('ssh', { tools: [tool('list-hosts')] })
    h.plan.set('a', { tools: [tool('search')] })
    h.plan.set('ssh#s3', { tools: [tool('list-hosts')], hold: true })
    h.plan.set('ssh#s4', new Error('boom'))
    await h.mgr.ensureServerByName('a')
    await h.mgr.ensureServerByName('ssh', { sessionId: 's1' })
    await h.mgr.ensureServerByName('ssh', { sessionId: 's2' })
    void h.mgr.ensureServerByName('ssh', { sessionId: 's3' })
    await settle()
    expect((await h.mgr.ensureServerByName('ssh', { sessionId: 's4' })).ok).toBe(false)
    expect(h.mgr.getStatus('ssh-id', 's3')).toBe('connecting')
    expect(h.mgr.getStatus('ssh-id', 's4')).toBe('error')

    await h.mgr.closeSession('s1')

    expect(namesOf(toolsFor(h, 's1'))).toEqual(['mcp__a__search'])
    expect(namesOf(toolsFor(h, 's2'))).toEqual(['mcp__a__search', 'mcp__ssh__list-hosts'])
    expect(namesOf(toolsFor(h, 's3'))).toEqual(['mcp__a__search'])
    expect(namesOf(toolsFor(h, 's4'))).toEqual(['mcp__a__search'])
  })
})

// ─── 工具闭包的原地重连 ─────────────────────────────────────────────────────
//
// Agent 的工具在创建那一刻就固定了，要等用户在 agent 芯片上销毁它才重建 —— 一台 server 中途掉线
// 之后，「下次创建 Agent 再连」等于让它的工具在余下的整段对话里一直报错。所以工具闭包在调用时
// 原地重连一次。这一组钉这条路的四条边：
//  - A1 重连只发生在**请求发出之前**；一次调用至多等 5 秒、随中止立刻结束，那次连接尝试照常跑完；
//  - A2 请求发出去之后的失败**一律不重发**（工具有副作用，server 可能已经执行了）—— 唯一的例外
//    是 HTTP 404 会话过期，按规范那次请求没有被执行；
//  - A3 不该再存在的（停用、删除、会话已关）不重连；
//  - A4 报错带上 stdio 进程临死前的 stderr —— 「Connection closed」本身说明不了任何事。
//
// 行类型要看清：`row()` 默认是 http，而「传输层失败标 error」「404 换会话重发」只对 http 行生效 ——
// 要 stdio 语义的用例一律显式 `type: 'stdio'`。

/** 外部服务器 `a`（http，row() 的默认） */
const httpA = (patch: Partial<McpServer> = {}): McpServer =>
  row({ id: 'a-id', name: 'a', ...patch })
/** 同一台 `a`，换成 stdio */
const stdioA = (patch: Partial<McpServer> = {}): McpServer =>
  row({ id: 'a-id', name: 'a', type: 'stdio', command: 'node', url: '', ...patch })

/** 只有一段文字的 tools/call 回执 —— 「这一发落在哪份实例上」靠它分辨 */
const says = (t: string): Record<string, unknown> => ({ content: [text(t)] })

/** server 已经不认这个会话了（规范要求回 404） */
const http404 = (): StreamableHTTPError =>
  new StreamableHTTPError(404, 'Error POSTing to endpoint: session not found')

/**
 * 连上 `name`，取它的工具闭包 —— Agent 创建那一刻拿到、之后一直攥着的那一份。
 * 外部服务器对 sessionId 视而不见；inproc 靠它找到这条会话自己的实例。
 */
async function connectHeld(h: Harness, name: string, sessionId?: string): Promise<McpTool[]> {
  expect(await h.mgr.ensureServerByName(name, { sessionId })).toEqual({ ok: true })
  const held = h.mgr.getRegistrationsByServerName(name, sessionId)
  expect(held.length).toBeGreaterThan(0)
  return held
}

/** 掉线：transport 自己报 onclose（stdio 进程退出、inproc 对端关了） */
const drop = (t: FakeTransport): void => t.onclose?.()

/** 经工具闭包调一次（pi 那边的 toolCallId 固定为 `call-x`） */
const exec = (
  t: McpTool,
  signal: AbortSignal = new AbortController().signal
): Promise<InvokedToolResult> => executeTool(t, 'call-x', {}, signal)

type ToolResult = InvokedToolResult
type Outcome = { ok: true; r: ToolResult } | { ok: false; msg: string }

/**
 * 一次调用的落定结果：失败也不冒未捕获拒绝；`settled` 让用例不 await 就能断言「还在等」
 * （settle() 会把微任务冲干净，所以读它的那一刻是准的）。
 */
function outcome(p: Promise<ToolResult>): Promise<Outcome> & { settled: boolean } {
  const o = Object.assign(
    p.then(
      // P1-04：工具失败收成 isError 结果（裁定 Q12，文字即原先抛出的消息）；取消照旧是拒绝
      (r): Outcome => (r.isError ? { ok: false, msg: onlyText(r.content) } : { ok: true, r }),
      (e: Error): Outcome => ({ ok: false, msg: e.message })
    ),
    { settled: false }
  )
  void o.then(() => {
    o.settled = true
  })
  return o
}

/** 这一发必须成功、且只回一段文字 —— 取那段文字（失败时带着错误文案挂掉） */
async function okText(p: Promise<Outcome>): Promise<string> {
  const o = await p
  if (!o.ok) expect.unreachable(`应当成功，实际失败：${o.msg}`)
  return onlyText(o.r.content)
}

/** 这一发必须失败 —— 取完整的错误文案（逐字断言用） */
async function failText(p: Promise<Outcome>): Promise<string> {
  const o = await p
  if (o.ok) expect.unreachable(`应当失败，实际成功：${JSON.stringify(o.r.content)}`)
  return o.msg
}

describe('McpManager 工具闭包原地重连：只在请求发出之前（A1）', () => {
  it('MCPR-U-1: 手动重连失败留下的 error —— 下一次调用原地重连一次再调', async () => {
    const h = setup([httpA()])
    h.plan.set('a', { tools: [tool('search')] })
    const [held] = await connectHeld(h, 'a')

    h.plan.set('a', new Error('spawn ENOENT'))
    expect(await h.mgr.connect('a-id')).toEqual({ ok: false, error: 'spawn ENOENT' })
    expect(h.mgr.getStatus('a-id')).toBe('error')

    h.plan.set('a', {})
    expect(await okText(outcome(exec(held)))).toBe('handled by global')
    expect(h.createTransport).toHaveBeenCalledTimes(3)
    expect(h.mgr.getStatus('a-id')).toBe('connected')
    expect(h.mgr.getError('a-id')).toBeUndefined()
  })

  it('MCPR-U-2: 设置页改了配置（只断开、行仍启用）—— 调用按**新**配置重连，不留尾巴', async () => {
    const h = setup([httpA({ url: 'http://old/mcp' })])
    h.plan.set('a', { tools: [tool('search')] })
    const [held] = await connectHeld(h, 'a')
    const old = h.last('a')

    // mcp:update 的语义：改库 + 断开，不重连
    h.store.rows.get('a-id')!.url = 'http://new/mcp'
    await h.mgr.disconnect('a-id')

    expect(await okText(outcome(exec(held)))).toBe('handled by global')
    expect(h.createTransport.mock.calls[1][0]).toMatchObject({ url: 'http://new/mcp' })
    expect(old.toolCalls).toEqual([])
    expect(h.last('a').toolCalls).toHaveLength(1)
    // 走的是与「创建 Agent 时连」同一条路：发现的工具照样写回缓存
    expect(h.store.updateCachedTools).toHaveBeenCalledTimes(2)

    await settle()
    expect(vi.getTimerCount()).toBe(0)
    expect(rejections).toEqual([])
  })

  it('MCPR-U-3: 掉线后并发的两次调用合用一次重连', async () => {
    const h = setup([stdioA()])
    h.plan.set('a', { tools: [tool('search'), tool('ping')] })
    const [search, ping] = await connectHeld(h, 'a')
    drop(h.last('a'))

    h.plan.set('a', { tools: [tool('search'), tool('ping')], hold: true })
    const first = outcome(exec(search))
    const second = outcome(exec(ping))
    await settle()
    // 原来那份 + 唯一一次重连：第二发搭上了第一发发起的那次
    expect(h.made('a')).toHaveLength(2)
    expect(h.mgr.getStatus('a-id')).toBe('connecting')

    h.last('a').release()
    expect(await okText(first)).toBe('handled by global')
    expect(await okText(second)).toBe('handled by global')
    expect(h.made('a')).toHaveLength(2)
    expect(
      h
        .last('a')
        .toolCalls.map((c) => c.name)
        .sort()
    ).toEqual(['ping', 'search'])
  })

  it('MCPR-U-4: 搭上一次不设限的手动连接 —— 这次调用至多等 5 秒；被放弃的那一发事后也不补发', async () => {
    const h = setup([httpA()])
    h.plan.set('a', { tools: [tool('search')] })
    const [held] = await connectHeld(h, 'a')

    h.plan.set('a', { tools: [tool('search')], hold: true })
    const manual = h.mgr.connect('a-id') // 设置页手点：不设限
    await settle()
    const o = outcome(exec(held))
    await settle(LAZY_CONNECT_TIMEOUT_MS - 1)
    expect(o.settled).toBe(false)

    await settle(1)
    expect(await failText(o)).toBe(
      '[MCP Error] MCP server "a" is not connected (reconnect failed): timed out after 5000ms'
    )
    // 结束的只是这次等待：没有第三次尝试，手动连接照常在跑
    expect(h.made('a')).toHaveLength(2)
    expect(h.mgr.getStatus('a-id')).toBe('connecting')

    h.last('a').release()
    expect(await manual).toEqual({ ok: true })
    await settle()
    expect(h.mgr.getStatus('a-id')).toBe('connected')
    // 放弃了的那一发不会在连上之后被悄悄补发 —— 模型已经把它当成失败了
    expect(h.last('a').toolCalls).toEqual([])

    expect(await okText(outcome(exec(held)))).toBe('handled by global')
    expect(h.made('a')).toHaveLength(2)
    expect(rejections).toEqual([])
  })

  it('MCPR-U-5: 中止立刻结束重连等待；那次连接照常跑完、留给下一次用', async () => {
    const h = setup([stdioA()])
    h.plan.set('a', { tools: [tool('search')] })
    const [held] = await connectHeld(h, 'a')
    drop(h.last('a'))

    h.plan.set('a', { tools: [tool('search')], hold: true })
    const ac = new AbortController()
    const o = outcome(exec(held, ac.signal))
    await settle(1000)
    ac.abort()
    // 不推进时钟：中止本身就该让这次等待落定，而不是等到 5 秒封顶
    expect(await failText(o)).toBe('[MCP] Aborted')
    expect(h.mgr.getStatus('a-id')).toBe('connecting')
    expect(h.made('a')).toHaveLength(2)

    h.last('a').release()
    await settle()
    expect(h.mgr.getStatus('a-id')).toBe('connected')
    expect(h.last('a').toolCalls).toEqual([])
    expect(await okText(outcome(exec(held)))).toBe('handled by global')
    expect(h.made('a')).toHaveLength(2)
    expect(vi.getTimerCount()).toBe(0)
    expect(rejections).toEqual([])
  })

  it('MCPR-U-5b: 已经中止的调用连重连都不发起', async () => {
    const h = setup([stdioA()])
    h.plan.set('a', { tools: [tool('search')] })
    const [held] = await connectHeld(h, 'a')
    drop(h.last('a'))

    const ac = new AbortController()
    ac.abort()
    expect(await failText(outcome(exec(held, ac.signal)))).toBe('[MCP] Aborted')
    expect(h.createTransport).toHaveBeenCalledTimes(1)
  })

  it('MCPR-U-6: 重连失败 —— 报错逐字、只试一次、事后没有后台重试', async () => {
    const h = setup([stdioA()])
    h.plan.set('a', { tools: [tool('search')] })
    const [held] = await connectHeld(h, 'a')
    drop(h.last('a'))

    h.plan.set('a', new Error('spawn ENOENT'))
    expect(await failText(outcome(exec(held)))).toBe(
      '[MCP Error] MCP server "a" is not connected (reconnect failed): spawn ENOENT'
    )
    expect(h.createTransport).toHaveBeenCalledTimes(2)
    expect(h.mgr.getStatus('a-id')).toBe('error')
    expect(h.mgr.getError('a-id')).toBe('spawn ENOENT')

    await settle(10 * 60 * 1000)
    expect(h.createTransport).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)

    // 下一次调用才再试
    h.plan.set('a', {})
    expect(await okText(outcome(exec(held)))).toBe('handled by global')
    expect(h.createTransport).toHaveBeenCalledTimes(3)
  })

  it('MCPR-U-7: 调用自己发起的重连握手不落定 —— 5 秒后这次调用失败，那次尝试随自己的超时收尾', async () => {
    const h = setup([stdioA()])
    h.plan.set('a', { tools: [tool('search')] })
    const [held] = await connectHeld(h, 'a')
    drop(h.last('a'))

    h.plan.set('a', { hold: true }) // 永不放行
    const o = outcome(exec(held))
    await settle(LAZY_CONNECT_TIMEOUT_MS)
    await settle()
    // 两个 5 秒的计时器同一刻到期：这次调用的等待先登记（尝试自己的超时要等 createTransport
    // 之后才挂上），所以报的是等待的超时；没给 stderr，后面也就什么都不拼
    expect(await failText(o)).toBe(
      '[MCP Error] MCP server "a" is not connected (reconnect failed): timed out after 5000ms'
    )
    expect(released(h.made('a')[1])).toBe(true)
    expect(h.mgr.getStatus('a-id')).toBe('error')
    expect(h.mgr.getError('a-id')).toMatch(/connect timed out after 5000ms/)
    expect(rejections).toEqual([])

    // 被放弃的 initialize 还挂着 SDK 自己的 60 秒请求超时：closeConnection 先摘回调再关，连同
    // Protocol 包在外面的那层 onclose 一起摘掉了，它的在途请求于是没被当场清掉（既有行为）。
    // 钉住的是它到期之后什么也不发生 —— 不重连、不冒未捕获拒绝、不留别的定时器
    await settle(60_000)
    expect(vi.getTimerCount()).toBe(0)
    expect(h.createTransport).toHaveBeenCalledTimes(2)
    expect(rejections).toEqual([])
  })
})

describe('McpManager 工具调用：请求发出去之后不重发（A2）', () => {
  it('MCPR-U-8: stdio 进程在调用中途退出 —— 带 stderr 尾巴失败、不重发；下一次调用重连', async () => {
    const h = setup([stdioA()])
    h.plan.set('a', { tools: [tool('search')], holdCalls: 'reply', stderr: '' })
    const [held] = await connectHeld(h, 'a')
    const t = h.last('a')

    const o = outcome(exec(held))
    await settle()
    t.stderr = 'panic: index out of range\n'
    drop(t)
    expect(await failText(o)).toBe(
      '[MCP Error] MCP error -32000: Connection closed\npanic: index out of range'
    )
    expect(h.made('a')).toHaveLength(1)
    expect(t.toolCalls).toHaveLength(1)
    expect(h.mgr.getStatus('a-id')).toBe('disconnected')
    expect(h.mgr.getError('a-id')).toBe('Connection closed\npanic: index out of range')

    h.plan.set('a', { tools: [tool('search')] })
    expect(await okText(outcome(exec(held)))).toBe('handled by global')
    expect(h.made('a')).toHaveLength(2)
    expect(h.made('a')[1].toolCalls).toHaveLength(1)
    expect(t.toolCalls).toHaveLength(1)
  })

  it.each([
    ['fetch 本身失败', (): Error => new TypeError('fetch failed')],
    ['500', (): Error => new StreamableHTTPError(500, 'Error POSTing to endpoint: boom')],
    [
      '400 —— server 重启后不按规范回 404',
      (): Error =>
        new StreamableHTTPError(400, 'Error POSTing to endpoint: Bad Request: No valid session ID')
    ]
  ])(
    'MCPR-U-9: HTTP 传输层失败（%s）—— 失败一次、不重发、标 error，下一次调用换新会话',
    async (_label, makeErr) => {
      const err = makeErr()
      const h = setup([httpA()])
      h.plan.set('a', {
        tools: [tool('search')],
        sessionId: 'sess-1',
        failCall: (_, n) => (n === 1 ? err : undefined)
      })
      const [held] = await connectHeld(h, 'a')
      const t = h.last('a')

      expect(await failText(outcome(exec(held)))).toBe(`[MCP Error] ${err.message}`)
      expect(h.made('a')).toHaveLength(1)
      expect(t.toolCalls).toHaveLength(1)
      expect(h.mgr.getStatus('a-id')).toBe('error')
      expect(h.mgr.getError('a-id')).toBe(err.message)

      h.plan.set('a', { tools: [tool('search')] })
      expect(await okText(outcome(exec(held)))).toBe('handled by global')
      expect(h.made('a')).toHaveLength(2)
      expect(released(t)).toBe(true)
      expect(h.mgr.getStatus('a-id')).toBe('connected')
    }
  )

  it.each([
    ['http', httpA, 'sess-1'],
    ['stdio', stdioA, undefined]
  ] as const)(
    'MCPR-U-10: server 作答的 JSON-RPC 错误 —— 不碰连接、不拼 stderr（%s）',
    async (_kind, server, sessionId) => {
      const h = setup([server()])
      h.plan.set('a', {
        tools: [tool('search')],
        sessionId,
        callError: { code: -32603, message: 'tool exploded' },
        stderr: 'some noise'
      })
      const [held] = await connectHeld(h, 'a')

      expect(await failText(outcome(exec(held)))).toBe(
        '[MCP Error] MCP error -32603: tool exploded'
      )
      expect(h.mgr.getStatus('a-id')).toBe('connected')
      expect(h.mgr.getError('a-id')).toBeUndefined()
      // 连接是好的：下一发还落在同一份实例上
      expect(await failText(outcome(exec(held)))).toBe(
        '[MCP Error] MCP error -32603: tool exploded'
      )
      expect(h.made('a')).toHaveLength(1)
      expect(h.last('a').toolCalls).toHaveLength(2)
    }
  )

  /** t1：会话 sess-1，第一发 tools/call 回 404 */
  const expiringOnFirstCall = (h: Harness): void => {
    h.plan.set('a', {
      tools: [tool('search')],
      sessionId: 'sess-1',
      failCall: (_, n) => (n === 1 ? http404() : undefined),
      callResult: says('from t1')
    })
  }

  it('MCPR-U-11a: 带着会话 id 的请求回 404 —— 换一个新会话恰好重发一次', async () => {
    const h = setup([httpA()])
    expiringOnFirstCall(h)
    const [held] = await connectHeld(h, 'a')
    const t1 = h.last('a')

    h.plan.set('a', { tools: [tool('search')], sessionId: 'sess-2', callResult: says('from t2') })
    expect(await okText(outcome(exec(held)))).toBe('from t2')
    const t2 = h.last('a')
    expect(h.made('a')).toHaveLength(2)
    expect(t1.toolCalls).toHaveLength(1)
    // 重发的是同一发：工具名、参数、toolCallId 都不变
    expect(t2.toolCalls).toHaveLength(1)
    expect(t2.toolCalls).toEqual(t1.toolCalls)
    expect(t2.toolCallMetas[0]?.[TOOL_CALL]).toBe('call-x')
    expect(released(t1)).toBe(true)
    expect(h.mgr.getStatus('a-id')).toBe('connected')
    expect(h.mgr.serverToRegistrations('a-id')).toHaveLength(1)
  })

  it('MCPR-U-11b: 新会话也回 404 —— 不再重发第二次，标 error', async () => {
    const h = setup([httpA()])
    expiringOnFirstCall(h)
    const [held] = await connectHeld(h, 'a')

    h.plan.set('a', {
      tools: [tool('search')],
      sessionId: 'sess-2',
      failCall: (_, n) => (n === 1 ? http404() : undefined),
      callResult: says('from t2')
    })
    expect(await failText(outcome(exec(held)))).toBe(
      '[MCP Error] Streamable HTTP error: Error POSTing to endpoint: session not found'
    )
    expect(h.made('a')).toHaveLength(2)
    expect(h.made('a').map((t) => t.toolCalls.length)).toEqual([1, 1])
    expect(h.mgr.getStatus('a-id')).toBe('error')
  })

  it('MCPR-U-12: 没带会话 id 的 404 是地址不对、不是会话过期 —— 不重发，标 error', async () => {
    const h = setup([httpA()])
    h.plan.set('a', {
      tools: [tool('search')],
      failCall: (_, n) => (n === 1 ? http404() : undefined),
      callResult: says('from t1')
    })
    const [held] = await connectHeld(h, 'a')
    const t1 = h.last('a')

    expect(await failText(outcome(exec(held)))).toBe(
      '[MCP Error] Streamable HTTP error: Error POSTing to endpoint: session not found'
    )
    expect(h.made('a')).toHaveLength(1)
    expect(t1.toolCalls).toHaveLength(1)
    expect(h.mgr.getStatus('a-id')).toBe('error')

    h.plan.set('a', { tools: [tool('search')], callResult: says('from t2') })
    expect(await okText(outcome(exec(held)))).toBe('from t2')
    expect(h.made('a')).toHaveLength(2)
  })

  /** t1（会话 sess-1）扣住 tools/call 的发送；连上后发出 A、B 两发，都悬在 t1 上 */
  async function twoInFlightOnT1(): Promise<{
    h: Harness
    held: McpTool
    t1: FakeTransport
    a: ReturnType<typeof outcome>
    b: ReturnType<typeof outcome>
  }> {
    const h = setup([httpA()])
    h.plan.set('a', {
      tools: [tool('search')],
      sessionId: 'sess-1',
      holdCalls: 'send',
      callResult: says('from t1')
    })
    const [held] = await connectHeld(h, 'a')
    const t1 = h.last('a')
    const a = outcome(exec(held))
    const b = outcome(exec(held))
    await settle()
    expect(t1.heldCalls).toHaveLength(2)
    return { h, held, t1, a, b }
  }

  it('MCPR-U-13: 会话过期时同一条连接上还有调用在途 —— 不掐断它，等它落定再关旧连接', async () => {
    const { h, held, t1, a, b } = await twoInFlightOnT1()

    h.plan.set('a', { tools: [tool('search')], sessionId: 'sess-2', callResult: says('from t2') })
    t1.heldCalls[1].fail(http404())
    await settle()
    expect(await okText(b)).toBe('from t2')
    expect(h.made('a')).toHaveLength(2)
    // A 还在 t1 上跑：此刻关掉 t1 会让它以「连接已关」失败
    expect(released(t1)).toBe(false)
    expect(a.settled).toBe(false)

    t1.heldCalls[0].reply()
    await settle()
    expect(await okText(a)).toBe('from t1')
    expect(released(t1)).toBe(true)
    expect(h.mgr.getStatus('a-id')).toBe('connected')
    // 之后的调用落在新会话上
    expect(await okText(outcome(exec(held)))).toBe('from t2')
    expect(h.made('a')[1].toolCalls).toHaveLength(2)
  })

  it('MCPR-U-14: 两发同时撞上 404 —— 合用一个新会话，各重发一次', async () => {
    const { h, t1, a, b } = await twoInFlightOnT1()

    h.plan.set('a', {
      tools: [tool('search')],
      sessionId: 'sess-2',
      callResult: says('from t2'),
      hold: true
    })
    t1.heldCalls[0].fail(http404())
    t1.heldCalls[1].fail(http404())
    await settle()
    expect(h.made('a')).toHaveLength(2)

    const t2 = h.last('a')
    t2.release()
    expect(await okText(a)).toBe('from t2')
    expect(await okText(b)).toBe('from t2')
    expect(t2.toolCalls).toHaveLength(2)
    expect(released(t1)).toBe(true)
  })

  it('MCPR-U-15: 已退役的连接上迟到的传输失败 —— 不标到新连接头上，也不重发', async () => {
    const { h, t1, a, b } = await twoInFlightOnT1()
    h.plan.set('a', { tools: [tool('search')], sessionId: 'sess-2', callResult: says('from t2') })
    t1.heldCalls[1].fail(http404())
    await settle()
    expect(await okText(b)).toBe('from t2')
    const t2 = h.last('a')

    t1.heldCalls[0].fail(new TypeError('fetch failed'))
    expect(await failText(a)).toBe('[MCP Error] fetch failed')
    expect(t2.toolCalls).toHaveLength(1)
    expect(h.mgr.getStatus('a-id')).toBe('connected')
    expect(h.mgr.getError('a-id')).toBeUndefined()
    expect(released(t1)).toBe(true)
  })

  it('MCPR-U-16: HTTP 连接因一发失败被标 error 时另一发还在途 —— 下一次调用的重连不掐断它', async () => {
    const h = setup([httpA()])
    h.plan.set('a', { tools: [tool('search')], holdCalls: 'send', callResult: says('from t1') })
    const [held] = await connectHeld(h, 'a')
    const t1 = h.last('a')
    const a = outcome(exec(held))
    const b = outcome(exec(held))
    await settle()
    expect(t1.heldCalls).toHaveLength(2)

    t1.heldCalls[1].fail(new TypeError('fetch failed'))
    expect(await failText(b)).toBe('[MCP Error] fetch failed')
    expect(h.mgr.getStatus('a-id')).toBe('error')

    h.plan.set('a', { tools: [tool('search')], callResult: says('from t2') })
    expect(await okText(outcome(exec(held)))).toBe('from t2')
    expect(released(t1)).toBe(false)

    t1.heldCalls[0].reply()
    expect(await okText(a)).toBe('from t1')
    expect(released(t1)).toBe(true)
  })

  it('MCPR-U-17: 中止一发在途的调用 —— 报 Aborted，不碰连接、不重发', async () => {
    const h = setup([httpA()])
    h.plan.set('a', { tools: [tool('search')], sessionId: 'sess-1', holdCalls: 'send' })
    const [held] = await connectHeld(h, 'a')

    const ac = new AbortController()
    const o = outcome(exec(held, ac.signal))
    await settle()
    ac.abort()
    expect(await failText(o)).toBe('[MCP] Aborted')
    expect(h.mgr.getStatus('a-id')).toBe('connected')
    expect(h.mgr.getError('a-id')).toBeUndefined()
    expect(h.made('a')).toHaveLength(1)
    expect(h.last('a').toolCalls).toHaveLength(1)
  })

  it.each([
    ['stdio', stdioA],
    ['http', httpA]
  ] as const)('MCPR-U-18: transport 单报 onerror 不等于连接断了（%s）', async (_kind, server) => {
    const h = setup([server()])
    h.plan.set('a', { tools: [tool('search')] })
    const [held] = await connectHeld(h, 'a')

    // stdio server 往 stdout 打了一行不是 JSON 的日志 —— 连接照样能用
    h.last('a').onerror?.(new SyntaxError('Unexpected token h in JSON'))
    expect(h.mgr.getStatus('a-id')).toBe('connected')
    expect(h.mgr.getError('a-id')).toBeUndefined()
    expect(h.mgr.serverToRegistrations('a-id')).toHaveLength(1)
    expect(await okText(outcome(exec(held)))).toBe('handled by global')
    expect(h.made('a')).toHaveLength(1)
  })

  it('MCPR-U-27: HTTP 上的结果过不了 SDK 的 schema 校验 —— 连接是好的，不标 error、不换连接', async () => {
    let n = 0
    const h = setup([httpA()])
    h.plan.set('a', {
      tools: [tool('search')],
      // 缺 data / mimeType 的图片块：整份结果被 CallToolResultSchema 拒掉
      callResult: () => (++n === 1 ? { content: [{ type: 'image' }] } : says('ok'))
    })
    const [held] = await connectHeld(h, 'a')

    expect(await failText(outcome(exec(held)))).toMatch(/^\[MCP Error\] /)
    expect(h.mgr.getStatus('a-id')).toBe('connected')
    expect(h.mgr.getError('a-id')).toBeUndefined()
    expect(await okText(outcome(exec(held)))).toBe('ok')
    expect(h.made('a')).toHaveLength(1)
  })

  it('MCPR-U-28: SDK 自己的请求超时 —— 说明的是工具慢、不是连接坏了：不重发、不标 error', async () => {
    const h = setup([httpA()])
    h.plan.set('a', { tools: [tool('search')], holdCalls: 'reply' })
    const [held] = await connectHeld(h, 'a')

    const o = outcome(exec(held))
    await settle(5 * 60_000)
    expect(await failText(o)).toBe('[MCP Error] MCP error -32001: Request timed out')
    expect(h.last('a').toolCalls).toHaveLength(1)
    expect(h.made('a')).toHaveLength(1)
    expect(h.mgr.getStatus('a-id')).toBe('connected')
  })
})

describe('McpManager 工具闭包：不该再存在的不重连（A3）', () => {
  it('MCPR-U-19 (i): 掉线之后被停用 —— 报「没连上」，一次尝试都不发起', async () => {
    const h = setup([stdioA()])
    h.plan.set('a', { tools: [tool('search')] })
    const [held] = await connectHeld(h, 'a')
    drop(h.last('a'))
    h.store.rows.get('a-id')!.isEnabled = 0

    expect(await failText(outcome(exec(held)))).toBe('[MCP Error] MCP server "a" is not connected')
    expect(h.createTransport).toHaveBeenCalledTimes(1)
  })

  it('MCPR-U-19 (ii): 设置页停用（改库 + 断开）', async () => {
    const h = setup([httpA()])
    h.plan.set('a', { tools: [tool('search')] })
    const [held] = await connectHeld(h, 'a')
    h.store.rows.get('a-id')!.isEnabled = 0
    await h.mgr.disconnect('a-id')

    expect(await failText(outcome(exec(held)))).toBe('[MCP Error] MCP server "a" is not connected')
    expect(h.createTransport).toHaveBeenCalledTimes(1)
  })

  it('MCPR-U-19 (iii): 停用内置服务器 —— 会话还在也不复活它的实例', async () => {
    const h = setup([sshRow()])
    h.plan.set('ssh', { tools: [tool('list-hosts')] })
    const [held] = await connectHeld(h, 'ssh', 's1')
    h.store.rows.get('ssh-id')!.isEnabled = 0
    await h.mgr.disconnect('ssh-id')

    expect(await failText(outcome(exec(held)))).toBe(
      '[MCP Error] MCP server "ssh" is not connected'
    )
    expect(h.createTransport).toHaveBeenCalledTimes(1)
  })

  it('MCPR-U-20 (i): 掉线之后配置行被删 —— 报「没连上」并叫得出名字，不发起尝试', async () => {
    const h = setup([stdioA()])
    h.plan.set('a', { tools: [tool('search')] })
    const [held] = await connectHeld(h, 'a')
    drop(h.last('a'))
    h.store.rows.delete('a-id')

    expect(await failText(outcome(exec(held)))).toBe('[MCP Error] MCP server "a" is not connected')
    expect(h.createTransport).toHaveBeenCalledTimes(1)
  })

  it('MCPR-U-20 (ii): 真实的 mcp:delete 顺序（先断开、再删行）—— 连接与配置行都没了，名字仍在', async () => {
    const h = setup([httpA()])
    h.plan.set('a', { tools: [tool('search')] })
    const [held] = await connectHeld(h, 'a')
    await h.mgr.disconnect('a-id')
    h.store.rows.delete('a-id')

    // 只剩闭包自己记得名字：报连接键 `a-id` 对模型和用户都没有意义
    expect(await failText(outcome(exec(held)))).toBe('[MCP Error] MCP server "a" is not connected')
    expect(h.createTransport).toHaveBeenCalledTimes(1)
  })

  it('MCPR-U-21: 会话还在的内置实例掉线 —— 只重连这条会话自己那份', async () => {
    const h = setup([sshRow()])
    h.plan.set('ssh', { tools: [tool('list-hosts')] })
    const [held1] = await connectHeld(h, 'ssh', 's1')
    await connectHeld(h, 'ssh', 's2')
    drop(h.lastFor('ssh', 's1'))

    expect(await okText(outcome(exec(held1)))).toBe('handled by s1')
    expect(h.madeFor('ssh', 's1')).toHaveLength(2)
    expect(h.createTransport.mock.calls.at(-1)?.[1]).toEqual({ sessionId: 's1' })
    expect(h.madeFor('ssh', 's2')).toHaveLength(1)
    expect(h.lastFor('ssh', 's2').toolCalls).toEqual([])
    expect(h.mgr.getStatus('ssh-id', 's1')).toBe('connected')
  })

  it('MCPR-U-22: closeSession 挡住复活 —— 那条会话已没有活条目时也挡，且只挡这一条', async () => {
    const h = setup([sshRow()])
    h.plan.set('ssh', { tools: [tool('list-hosts')] })
    const [held1] = await connectHeld(h, 'ssh', 's1')
    const [held2] = await connectHeld(h, 'ssh', 's2')

    // 设置页改了配置：全部会话分身摘掉，行仍启用
    await h.mgr.disconnect('ssh-id')
    // 随后会话 s1 被删 —— 它名下已经没有条目了（closeSession 提前返回的那条路）
    await h.mgr.closeSession('s1')

    expect(await failText(outcome(exec(held1)))).toBe(
      '[MCP Error] MCP server "ssh" is not connected'
    )
    expect(h.madeFor('ssh', 's1')).toHaveLength(1)

    expect(await okText(outcome(exec(held2)))).toBe('handled by s2')
    expect(h.madeFor('ssh', 's2')).toHaveLength(2)
  })

  it('MCPR-U-23: 闭包的重连还在途时会话被关 —— 连上了也不留，调用报「没连上」', async () => {
    const h = setup([sshRow()])
    h.plan.set('ssh', { tools: [tool('list-hosts')] })
    const [held1] = await connectHeld(h, 'ssh', 's1')
    drop(h.lastFor('ssh', 's1'))

    h.plan.set('ssh', { tools: [tool('list-hosts')], hold: true })
    const o = outcome(exec(held1))
    await settle()
    expect(h.madeFor('ssh', 's1')).toHaveLength(2)
    expect(h.mgr.getStatus('ssh-id', 's1')).toBe('connecting')

    await h.mgr.closeSession('s1')
    const t = h.lastFor('ssh', 's1')
    t.release()
    await settle()
    expect(await failText(o)).toBe('[MCP Error] MCP server "ssh" is not connected')
    expect(released(t)).toBe(true)
    expect(h.mgr.getStatus('ssh-id', 's1')).toBe('disconnected')
    expect(h.mgr.getRegistrationsByServerName('ssh', 's1')).toEqual([])
    expect(rejections).toEqual([])
  })
})

describe('McpManager 报错里的 stderr 尾巴（A4）', () => {
  /** stdio `a` 的握手扣住、以「Connection closed」失败 —— 连接报的错 */
  async function connectErrorWith(opts: FakeOpts): Promise<string | undefined> {
    const h = setup([stdioA()])
    h.plan.set('a', { hold: true, ...opts })
    const p = h.mgr.ensureServerByName('a')
    await settle()
    h.last('a').releaseWithError('Connection closed')
    return (await p).error
  }

  it('MCPR-U-24a: 连接失败 —— 拼上去掉首尾空白的 stderr，隔一个换行', async () => {
    const h = setup([stdioA()])
    h.plan.set('a', { hold: true, stderr: "\n  Error: Cannot find module 'foo'\n\n" })
    const p = h.mgr.ensureServerByName('a')
    await settle()
    h.last('a').releaseWithError('Connection closed')

    const expected = "MCP error -32000: Connection closed\nError: Cannot find module 'foo'"
    expect(await p).toEqual({ ok: false, error: expected })
    expect(h.mgr.getError('a-id')).toBe(expected)
  })

  it('MCPR-U-24b: 连接超时 —— 同样拼上', async () => {
    const h = setup([stdioA()])
    h.plan.set('a', { hold: true, stderr: 'still starting' })
    const p = h.mgr.ensureServerByName('a', { timeoutMs: 20 })
    await settle(20)

    expect((await p).error).toBe('connect timed out after 20ms\nstill starting')
  })

  it('MCPR-U-25: 尾巴的边界 —— 至多 STDERR_TAIL_CHARS 个字符、取最后那段；全是空白就不拼', async () => {
    expect(STDERR_TAIL_CHARS).toBe(2000)

    const long = (await connectErrorWith({ stderr: 'HEAD' + 'x'.repeat(5000) + 'END' })) ?? ''
    const cut = long.indexOf('\n')
    expect(long.slice(0, cut)).toBe('MCP error -32000: Connection closed')
    const tail = long.slice(cut + 1)
    expect(tail).toHaveLength(STDERR_TAIL_CHARS)
    // 取的是尾部：最后几行才是死因
    expect(tail.endsWith('END')).toBe(true)
    expect(tail).not.toContain('HEAD')

    // 空白不算线索：不留一个悬空的换行
    expect(await connectErrorWith({ stderr: '  \n\t ' })).toBe(
      'MCP error -32000: Connection closed'
    )
  })

  it('MCPR-U-25: stderr 在收掉 transport 之后才读 —— 进程临死前最后打的那几行也在', async () => {
    const h = setup([stdioA()])
    h.plan.set('a', {
      hold: true,
      stderr: '',
      // close() 不止一次（client.close() 会再关一遍 transport）：只在第一次时「临死前打一行」
      onCloseHook: (t) => {
        if (t.closeCalls === 1) t.stderr += 'last words'
      }
    })
    // 走超时：握手没失败，SDK 自己不会先关 transport —— 第一次 close() 只可能来自管理器的收尾
    const p = h.mgr.ensureServerByName('a', { timeoutMs: 20 })
    await settle(20)

    expect((await p).error).toBe('connect timed out after 20ms\nlast words')
  })

  it('MCPR-U-25: 调用里的重连等满 5 秒 —— 报错带上那次尝试此刻的 stderr', async () => {
    const h = setup([stdioA()])
    h.plan.set('a', { tools: [tool('search')] })
    const [held] = await connectHeld(h, 'a')
    drop(h.last('a'))

    h.plan.set('a', { hold: true, stderr: 'waiting for db' })
    const o = outcome(exec(held))
    await settle(LAZY_CONNECT_TIMEOUT_MS)

    expect(await failText(o)).toBe(
      '[MCP Error] MCP server "a" is not connected (reconnect failed): timed out after 5000ms\nwaiting for db'
    )
  })

  it('MCPR-U-26: 调用里的重连失败 —— 报错带上新进程的 stderr', async () => {
    const h = setup([stdioA()])
    h.plan.set('a', { tools: [tool('search')] })
    const [held] = await connectHeld(h, 'a')
    drop(h.last('a'))

    h.plan.set('a', { hold: true, stderr: 'fatal: missing API key' })
    const o = outcome(exec(held))
    await settle()
    h.last('a').releaseWithError('Connection closed')

    expect(await failText(o)).toBe(
      '[MCP Error] MCP server "a" is not connected (reconnect failed): MCP error -32000: Connection closed\nfatal: missing API key'
    )
  })
})

// ─── durable 注册项（P1-05）：形状、调用身份、失败口径、声明快照 ─────────────────
//
// MCP 工具是 pi-durable 的 `ToolRegistration`：`execute(args, api, context)`。这一组钉迁移带来的契约：
//  - 注册项本身：`replay: 'unsafe'`（有副作用，中断不重跑）、durable 兜底截断取 2× 缺省；
//  - 调用身份全从 api 来：toolCallId = `api.callId`，调用方 id 每次按 `api.conversationId` 现问
//    （`callerIdOf`），taskId = `api.taskId` —— 后两者只给可信 server；
//  - 失败**交回** isError 结果（裁定 Q12，文字与旧版抛出的相同），只有取消照旧是拒绝；
//  - 声明快照（`declarationsOf`）是纯 JSON，`registrationsFromDeclarations` 据此建注册项，不要求
//    连着 —— 第一次调用经「用到才连」原地连上。锁定的 agent 重开时就靠这条路重建 MCP 工具。

const SCHEMA = { type: 'object' as const, properties: { q: { type: 'string' } } }

describe('McpManager 的 durable 注册项：形状', () => {
  it('MCPD-1: replay unsafe、名字带前缀、label / description、durable 兜底截断（2× 缺省、留头）', async () => {
    const h = setup([row({ id: 'a-id', name: 'a' })])
    h.plan.set('a', { tools: [tool('search', 'Search the web'), tool('ping')] })
    await h.mgr.ensureServerByName('a')

    const [search, ping] = h.mgr.getRegistrationsByServerName('a')
    expect(search).toMatchObject({
      name: 'mcp__a__search',
      label: 'Search the web',
      description: 'Search the web',
      replay: 'unsafe',
      outputLimits: {
        maxBytes: 2 * DEFAULT_MAX_BYTES,
        maxLines: 2 * DEFAULT_MAX_LINES,
        retain: 'head'
      }
    })
    // 没有描述：label 落到工具名，description 是空串（不是 undefined）
    expect(ping).toMatchObject({ name: 'mcp__a__ping', label: 'ping', description: '' })
    // inputSchema 原样透传给 LLM
    expect(search.parameters).toMatchObject(SCHEMA)
  })
})

describe('McpManager 的 durable 注册项：调用身份随 api 走', () => {
  it('MCPD-2: callerIdOf 按每次调用的 api.conversationId 现问 —— 同一个注册项、两条对话各报各的', async () => {
    const h = await trustedSsh()
    const callerIdOf = vi.fn((conversationId: number) =>
      conversationId === 1 ? 's1' : `agent-${conversationId}`
    )
    const [exec] = h.mgr.getRegistrationsByServerName('ssh', 's1', { callerIdOf })

    await invokeTool(exec, {}, { callId: 'pi-1', taskId: 11, conversationId: 1 })
    await invokeTool(exec, {}, { callId: 'pi-2', taskId: 12, conversationId: 5 })

    expect(callerIdOf.mock.calls).toEqual([[1], [5]])
    expect(h.lastFor('ssh', 's1').toolCallMetas).toStrictEqual([
      { [TOOL_CALL]: 'pi-1', [AGENT]: 's1', [TASK]: 11 },
      { [TOOL_CALL]: 'pi-2', [AGENT]: 'agent-5', [TASK]: 12 }
    ])
  })

  it('MCPD-3: 不可信 server —— toolCallId 照带，调用方 id 与 taskId 都不带（哪怕给了 callerIdOf）', async () => {
    const h = setup([row({ id: 'a-id', name: 'a' })])
    h.plan.set('a', { tools: [tool('search')] })
    await h.mgr.ensureServerByName('a')
    const [search] = h.mgr.getRegistrationsByServerName('a', 's1', { callerIdOf: () => 'agent-7' })

    await invokeTool(search, {}, { callId: 'pi-1', taskId: 9, conversationId: 3 })
    expect(h.last('a').toolCallMetas).toStrictEqual([{ [TOOL_CALL]: 'pi-1' }])
  })

  it('MCPD-3b: callerIdOf 回 undefined → 可信 server 只带 toolCallId 与 taskId', async () => {
    const h = await trustedSsh()
    const [exec] = h.mgr.getRegistrationsByServerName('ssh', 's1', { callerIdOf: () => undefined })

    await invokeTool(exec, {}, { callId: 'pi-1', taskId: 4 })
    expect(h.lastFor('ssh', 's1').toolCallMetas).toStrictEqual([{ [TOOL_CALL]: 'pi-1', [TASK]: 4 }])
  })
})

describe('McpManager 的 durable 注册项：失败交回 isError，取消照旧抛', () => {
  it('MCPD-4: server 报 isError → 调用 resolve 成 isError 结果，文字 `[MCP Error] …`，不带 details', async () => {
    const { exec } = await sshExecReturning({ isError: true, content: [text('permission denied')] })

    const { result } = await invokeTool(exec, {})
    expect(result).toStrictEqual({
      isError: true,
      content: [{ type: 'text', text: '[MCP Error] permission denied' }]
    })
  })

  it('MCPD-5: 协议层失败（服务器已停用）→ 同样 resolve 成 isError，文字逐字', async () => {
    const h = await trustedSsh()
    const [exec] = h.mgr.getRegistrationsByServerName('ssh', 's1')
    h.store.rows.get('ssh-id')!.isEnabled = 0
    await h.mgr.disconnect('ssh-id')

    const { result } = await invokeTool(exec, {})
    expect(result).toStrictEqual({
      isError: true,
      content: [{ type: 'text', text: '[MCP Error] MCP server "ssh" is not connected' }]
    })
  })

  it('MCPD-6: 在途调用被中止 → 调用以拒绝收场（不是 isError 结果）；请求只发了一次、连接不动', async () => {
    const h = setup([httpA()])
    h.plan.set('a', { tools: [tool('search')], sessionId: 'sess-1', holdCalls: 'send' })
    const [held] = await connectHeld(h, 'a')

    const ac = new AbortController()
    const call = invokeTool(held, {}, { signal: ac.signal })
    call.catch(() => {})
    await settle()
    ac.abort()

    await expect(call).rejects.toThrow('[MCP] Aborted')
    expect(h.last('a').toolCalls).toHaveLength(1)
    expect(h.mgr.getStatus('a-id')).toBe('connected')
  })

  it('MCPD-6b: 调用前就已中止 → 拒绝，一发请求都没出', async () => {
    const h = await trustedSsh()
    const [exec] = h.mgr.getRegistrationsByServerName('ssh', 's1')
    const ac = new AbortController()
    ac.abort()

    await expect(invokeTool(exec, {}, { signal: ac.signal })).rejects.toThrow('[MCP] Aborted')
    expect(h.lastFor('ssh', 's1').toolCalls).toEqual([])
  })
})

describe('McpManager.declarationsOf：工具声明快照', () => {
  it('MCPD-7: 可信 server —— name / description / inputSchema / annotations 原样，trusted:true；顺序同注册项', async () => {
    const h = setup([sshRow()])
    h.plan.set('ssh', {
      tools: [annotated('list-hosts', FULL_HINTS), tool('exec', 'Run a command')]
    })
    await h.mgr.ensureServerByName('ssh', { sessionId: 's1' })

    const decls = h.mgr.declarationsOf('ssh', 's1')
    expect(decls).toStrictEqual([
      { name: 'list-hosts', inputSchema: SCHEMA, annotations: { ...FULL_HINTS }, trusted: true },
      { name: 'exec', description: 'Run a command', inputSchema: SCHEMA, trusted: true }
    ])
    expect(decls.map((d) => `mcp__ssh__${d.name}`)).toEqual(
      h.mgr.getRegistrationsByServerName('ssh', 's1').map((t) => t.name)
    )
  })

  it('MCPD-8: 不可信 server —— annotations 照原样记，trusted:false；建注册项时才不进安全客体', async () => {
    const h = setup([row({ id: 'a-id', name: 'a' })])
    h.plan.set('a', { tools: [annotated('read', FULL_HINTS)] })
    await h.mgr.ensureServerByName('a')

    const decls = h.mgr.declarationsOf('a')
    expect(decls).toStrictEqual([
      { name: 'read', inputSchema: SCHEMA, annotations: { ...FULL_HINTS }, trusted: false }
    ])
    const [t] = h.mgr.registrationsFromDeclarations('a', undefined, decls)
    expect(t.mcpMeta).toStrictEqual({
      server: 'a',
      tool: 'read',
      trusted: false,
      readOnly: undefined,
      destructive: undefined,
      idempotent: undefined,
      openWorld: undefined
    })
  })

  it('MCPD-9: 快照是纯 JSON、与活连接互不牵连 —— JSON 往返相等；改快照不影响之后取的声明与注册项', async () => {
    const h = setup([sshRow()])
    h.plan.set('ssh', { tools: [annotated('exec', FULL_HINTS)] })
    await h.mgr.ensureServerByName('ssh', { sessionId: 's1' })

    const snapshot = h.mgr.declarationsOf('ssh', 's1')
    expect(JSON.parse(JSON.stringify(snapshot))).toStrictEqual(snapshot)

    snapshot[0].name = 'tampered'
    snapshot[0].inputSchema.properties = {}
    snapshot[0].annotations!.readOnlyHint = false
    const again = h.mgr.declarationsOf('ssh', 's1')
    expect(again[0]).toMatchObject({ name: 'exec', inputSchema: SCHEMA })
    expect(again[0].annotations?.readOnlyHint).toBe(true)
    const [live] = h.mgr.getRegistrationsByServerName('ssh', 's1')
    expect(live.parameters).toMatchObject(SCHEMA)
    expect(live.mcpMeta.readOnly).toBe(true)
  })

  it('MCPD-10: 没连上 / 不是这条会话的实例 / 没这台 → 空表', async () => {
    const h = setup([sshRow()])
    h.plan.set('ssh', { tools: [tool('exec')] })
    expect(h.mgr.declarationsOf('ssh', 's1')).toEqual([])

    await h.mgr.ensureServerByName('ssh', { sessionId: 's1' })
    expect(h.mgr.declarationsOf('ssh', 's1')).toHaveLength(1)
    // inproc 按会话分身：别的会话、不带会话都拿不到 s1 那份
    expect(h.mgr.declarationsOf('ssh', 's2')).toEqual([])
    expect(h.mgr.declarationsOf('ssh')).toEqual([])
    expect(h.mgr.declarationsOf('nope', 's1')).toEqual([])
  })
})

describe('McpManager.registrationsFromDeclarations：按快照建，用到才连', () => {
  it('MCPD-11: 与活连接上取的注册项同名、同描述、同参数、同 mcpMeta、同 replay', async () => {
    const h = setup([sshRow()])
    h.plan.set('ssh', {
      tools: [annotated('list-hosts', FULL_HINTS), tool('exec', 'Run a command')]
    })
    await h.mgr.ensureServerByName('ssh', { sessionId: 's1' })

    const live = h.mgr.getRegistrationsByServerName('ssh', 's1')
    const rebuilt = h.mgr.registrationsFromDeclarations(
      'ssh',
      's1',
      h.mgr.declarationsOf('ssh', 's1')
    )
    const face = (t: (typeof live)[number]): unknown => ({
      name: t.name,
      label: t.label,
      description: t.description,
      parameters: t.parameters,
      replay: t.replay,
      outputLimits: t.outputLimits,
      mcpMeta: t.mcpMeta
    })
    expect(rebuilt.map(face)).toEqual(live.map(face))
  })

  it('MCPD-12: 建的时候不连；第一次调用原地连上、落在这条会话自己的实例上，身份照常带', async () => {
    const h = setup([sshRow()])
    h.plan.set('ssh', { tools: [tool('exec')] })
    const decls = [{ name: 'exec', inputSchema: SCHEMA, trusted: true }]

    const [exec] = h.mgr.registrationsFromDeclarations('ssh', 's1', decls, {
      callerIdOf: () => 's1'
    })
    expect(exec.name).toBe('mcp__ssh__exec')
    expect(h.createTransport).not.toHaveBeenCalled()
    expect(h.mgr.getStatus('ssh-id', 's1')).toBe('disconnected')

    const { result } = await invokeTool(exec, {}, { callId: 'pi-1', taskId: 3 })
    expect(result.isError).toBeUndefined()
    expect(onlyText(result.content)).toBe('handled by s1')
    expect(result.details).toEqual({ type: 'mcp', server: 'ssh', tool: 'exec' })
    expect(h.mgr.getStatus('ssh-id', 's1')).toBe('connected')
    expect(h.madeFor('ssh', 's1')).toHaveLength(1)
    expect(h.lastFor('ssh', 's1').toolCalls).toEqual([{ name: 'exec', args: {} }])
    expect(h.lastFor('ssh', 's1').toolCallMetas).toStrictEqual([
      { [TOOL_CALL]: 'pi-1', [AGENT]: 's1', [TASK]: 3 }
    ])
  })

  it('MCPD-13: 外部服务器掉线之后再调 —— 同样原地重连一次再调', async () => {
    const h = setup([stdioA()])
    h.plan.set('a', { tools: [tool('search')] })
    await h.mgr.ensureServerByName('a')
    const [search] = h.mgr.registrationsFromDeclarations('a', 's1', h.mgr.declarationsOf('a'))
    drop(h.last('a'))

    const { result } = await invokeTool(search, {})
    expect(onlyText(result.content)).toBe('handled by global')
    expect(h.made('a')).toHaveLength(2)
  })

  it.each([
    ['配置行删了', (h: Harness): unknown => h.store.rows.delete('a-id')],
    ['停用了', (h: Harness): unknown => (h.store.rows.get('a-id')!.isEnabled = 0)]
  ])('MCPD-14: %s → isError「没连上」，不去连', async (_label, change) => {
    const h = setup([httpA()])
    h.plan.set('a', { tools: [tool('search')] })
    const [search] = h.mgr.registrationsFromDeclarations('a', undefined, [
      { name: 'search', inputSchema: SCHEMA, trusted: false }
    ])
    change(h)

    const { result } = await invokeTool(search, {})
    expect(result).toStrictEqual({
      isError: true,
      content: [{ type: 'text', text: '[MCP Error] MCP server "a" is not connected' }]
    })
    expect(h.createTransport).not.toHaveBeenCalled()
  })

  it('MCPD-15: 会话已关 → 不把它的内置实例重新拉起来，报没连上', async () => {
    const h = setup([sshRow()])
    h.plan.set('ssh', { tools: [tool('exec')] })
    const [exec] = h.mgr.registrationsFromDeclarations('ssh', 's1', [
      { name: 'exec', inputSchema: SCHEMA, trusted: true }
    ])
    await h.mgr.closeSession('s1')

    const { result } = await invokeTool(exec, {})
    expect(result.isError).toBe(true)
    expect(onlyText(result.content)).toBe('[MCP Error] MCP server "ssh" is not connected')
    expect(h.createTransport).not.toHaveBeenCalled()
  })

  it('MCPD-16: 快照说可信、实际连上的那条不可信 → `_meta` 只带 toolCallId（看活连接）；mcpMeta 按快照', async () => {
    const h = setup([httpA()])
    h.plan.set('a', { tools: [tool('search')] })
    const [search] = h.mgr.registrationsFromDeclarations(
      'a',
      undefined,
      [{ name: 'search', inputSchema: SCHEMA, annotations: { readOnlyHint: true }, trusted: true }],
      { callerIdOf: () => 'agent-7' }
    )
    expect(search.mcpMeta).toMatchObject({ trusted: true, readOnly: true })

    await invokeTool(search, {}, { callId: 'pi-1', taskId: 2 })
    expect(h.last('a').toolCallMetas).toStrictEqual([{ [TOOL_CALL]: 'pi-1' }])
  })

  it('MCPD-17: 交进来的声明事后被改，不影响已经建好的注册项（建时各拷一份）', async () => {
    const h = setup([httpA()])
    h.plan.set('a', { tools: [tool('search')] })
    // 自己的一份 schema（改它不能连坐模块级的 SCHEMA）
    const decls: McpToolDeclaration[] = [
      {
        name: 'search',
        description: 'Search',
        inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
        trusted: false
      }
    ]
    const [search] = h.mgr.registrationsFromDeclarations('a', undefined, decls)

    decls[0].name = 'other'
    decls[0].inputSchema.properties = {}
    expect(search.name).toBe('mcp__a__search')
    expect(search.parameters).toMatchObject({ properties: { q: { type: 'string' } } })

    await invokeTool(search, { q: 'x' })
    expect(h.last('a').toolCalls).toEqual([{ name: 'search', args: { q: 'x' } }])
  })
})
