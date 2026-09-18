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
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage, JSONRPCRequest } from '@modelcontextprotocol/sdk/types.js'
import type { McpServer } from '@shuvix/chat-protocol/types/mcp'
import type { BuiltinMcpScope } from '../builtinMcpRegistry'
import {
  McpManager,
  type McpAgentToolMeta,
  type McpDiscoveredTool,
  type McpStore
} from '../mcpManager'

// ─── 假件 ────────────────────────────────────────────────────────────────

const isRequest = (m: JSONRPCMessage): m is JSONRPCRequest => 'id' in m && 'method' in m

interface FakeOpts {
  /** tools/list 的应答 */
  tools?: McpDiscoveredTool[]
  /** 扣住请求不应答 —— 握手永不落定（超时 / 在途被断开类用例） */
  hold?: boolean
  /** close() 时同步回调 onclose：真 transport 就是这么干的，用来钉「失败原因不被它抹掉」 */
  notifyOnClose?: boolean
  /** close() 直接抛 —— 钉「一条实例释放失败不拖累同批的其余实例」 */
  throwOnClose?: boolean
}

/** 手写 JSON-RPC 应答器：只认 initialize / tools/list / tools/call，其余一律空 result */
class FakeTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void
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
  private held: JSONRPCRequest[] = []
  private holding: boolean

  constructor(
    readonly server: McpServer,
    private readonly opts: FakeOpts = {},
    /** 仅 inproc：造它时宿主传进来的会话上下文（外部服务器为 undefined） */
    readonly scope?: BuiltinMcpScope
  ) {
    this.holding = opts.hold === true
  }

  startCalls = 0

  /** 假件没有「启动」这回事：真 transport 在这里拉子进程 / 开连接，这里只记一笔 */
  async start(): Promise<void> {
    this.startCalls++
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!isRequest(message)) return // 通知（notifications/initialized 等）无需应答
    if (this.holding) {
      this.held.push(message)
      return
    }
    this.answer(message)
  }

  async close(): Promise<void> {
    this.closeCalls++
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
    if (message.method === 'tools/call') {
      const params = (message.params ?? {}) as {
        name?: string
        arguments?: unknown
        _meta?: Record<string, unknown>
      }
      this.toolCalls.push({
        name: params.name ?? '',
        args: (params.arguments ?? {}) as Record<string, unknown>
      })
      this.toolCallMetas.push(params._meta)
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
          : message.method === 'tools/call'
            ? // 回执带上自己的身份：跨会话串台时断言看到的是**另一条会话**的名字
              {
                content: [{ type: 'text', text: `handled by ${this.scope?.sessionId ?? 'global'}` }]
              }
            : {}
    queueMicrotask(() => this.onmessage?.({ jsonrpc: '2.0', id: message.id, result }))
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

  it('MCPL-U-11: ensureEnabled 全量并发，部分失败不拖累其余', async () => {
    const h = setup([
      row({ id: 'a-id', name: 'a' }),
      row({ id: 'b-id', name: 'b' }),
      row({ id: 'c-id', name: 'c', isEnabled: 0 }),
      row({ id: 'd-id', name: 'd' })
    ])
    h.plan.set('a', { tools: [tool('search')] })
    h.plan.set('b', new Error('server exploded'))
    h.plan.set('d', { tools: [tool('fetch')] })

    expect(await h.mgr.ensureServerByName('d')).toEqual({ ok: true })
    const beforeD = h.made('d').length

    const results = await h.mgr.ensureEnabled()
    expect(results.map((r) => r.name).sort()).toEqual(['a', 'b', 'd'])
    const byName = new Map(results.map((r) => [r.name, r.result]))
    expect(byName.get('a')).toEqual({ ok: true })
    expect(byName.get('b')?.ok).toBe(false)
    expect(byName.get('b')?.error).toBe('server exploded')
    expect(byName.get('d')).toEqual({ ok: true })
    // 已连上的那台不被重开
    expect(h.made('d')).toHaveLength(beforeD)
    // 停用的那台从没被尝试过
    expect(h.made('c')).toHaveLength(0)

    expect(
      h.mgr
        .getAllAgentTools()
        .map((t) => t.name)
        .sort()
    ).toEqual(['mcp__a__search', 'mcp__d__fetch'])
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
  it('MCPL-U-13: 掉线后状态回落、工具清空，已构建的 AgentTool 回错误结果而不是抛出；下次用到重连', async () => {
    const h = setup([row({ id: 'a-id', name: 'a' })])
    h.plan.set('a', { tools: [tool('search')] })
    expect(await h.mgr.ensureServerByName('a')).toEqual({ ok: true })

    // Agent 手里那份工具是创建那一刻拿到的，掉线之后它还在
    const held = h.mgr.serverToAgentTools('a-id')
    expect(held).toHaveLength(1)

    h.last('a').onclose?.()
    expect(h.mgr.getStatus('a-id')).toBe('disconnected')
    expect(h.mgr.serverToAgentTools('a-id')).toEqual([])

    const result = await held[0].execute('call-1', {}, new AbortController().signal)
    expect(result.details).toMatchObject({ type: 'mcp', server: 'a', isError: true })
    expect(JSON.stringify(result.content)).toContain('is not connected')

    // 下一次创建 Agent 会把它重新连起来
    expect(await h.mgr.ensureConnected('a-id')).toEqual({ ok: true })
    expect(h.mgr.getStatus('a-id')).toBe('connected')
    expect(h.mgr.serverToAgentTools('a-id')).toHaveLength(1)
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
      expect(h.mgr.serverToAgentTools('a-id'), outcome).toEqual([])
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
    expect(h.mgr.getAllAgentTools()).toEqual([])
    // 连接表里什么都没有 —— 也就不存在一份「谁都能捡走」的无主实例
    expect(h.mgr.getAgentToolsByServerName('ssh', 's1')).toEqual([])
  })

  it('MCPB-U-2: 外部服务器无会话照连，键仍是裸 serverId', async () => {
    const h = setup([row({ id: 'a-id', name: 'a' })])
    h.plan.set('a', { tools: [tool('search')] })

    expect(await h.mgr.ensureServerByName('a')).toEqual({ ok: true })
    // 键就是 serverId：能按裸 id 取到工具，说明没有被加上会话后缀
    expect(h.mgr.serverToAgentTools('a-id').map((t) => t.name)).toEqual(['mcp__a__search'])
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
    expect(h.mgr.serverToAgentTools('ssh-id#s1')).toHaveLength(1)
    expect(h.mgr.serverToAgentTools('ssh-id#s2')).toHaveLength(1)
    expect(h.mgr.serverToAgentTools('ssh-id')).toEqual([])
  })

  it('MCPB-U-5: 会话之间看不见彼此的工具', async () => {
    const h = setup([sshRow()])
    h.plan.set('ssh#s1', { tools: [tool('list-hosts')] })
    h.plan.set('ssh#s2', { tools: [tool('s2-only')] })

    await h.mgr.ensureServerByName('ssh', { sessionId: 's1' })
    await h.mgr.ensureServerByName('ssh', { sessionId: 's2' })

    expect(h.mgr.getAgentToolsByServerName('ssh', 's1').map((t) => t.name)).toEqual([
      'mcp__ssh__list-hosts'
    ])
    expect(h.mgr.getAgentToolsByServerName('ssh', 's2').map((t) => t.name)).toEqual([
      'mcp__ssh__s2-only'
    ])
  })

  it('MCPB-U-6: 工具闭包调的是自己那份实例', async () => {
    const h = setup([sshRow()])
    h.plan.set('ssh', { tools: [tool('list-hosts')] })
    await h.mgr.ensureServerByName('ssh', { sessionId: 's1' })
    await h.mgr.ensureServerByName('ssh', { sessionId: 's2' })

    const [t1] = h.mgr.getAgentToolsByServerName('ssh', 's1')
    const result = await t1.execute('call-1', { q: 'x' }, new AbortController().signal)

    // 闭包里记的是**连接键**，所以这一发只可能落在 s1 那份实例上
    expect(h.lastFor('ssh', 's1').toolCalls).toEqual([{ name: 'list-hosts', args: { q: 'x' } }])
    expect(h.lastFor('ssh', 's2').toolCalls).toEqual([])
    expect(JSON.stringify(result.content)).toContain('handled by s1')
  })

  it('MCPB-U-7: getAgentToolsByServerName 不传会话时回空 —— 绝不回落到别人的实例', async () => {
    const h = setup([sshRow()])
    h.plan.set('ssh', { tools: [tool('list-hosts')] })
    await h.mgr.ensureServerByName('ssh', { sessionId: 's1' })

    // 回落 = 把 s1 的 ssh 实例交给一个说不清自己是谁的调用方，比「少一个工具」严重得多
    expect(h.mgr.getAgentToolsByServerName('ssh')).toEqual([])
    expect(h.mgr.getAgentToolsByServerName('ssh', 's9')).toEqual([])
    expect(h.mgr.getAgentToolsByServerName('ssh', 's1')).toHaveLength(1)
  })

  it('MCPB-U-8: 外部服务器的工具与会话无关（同一份，谁问都一样）', async () => {
    const h = setup([row({ id: 'a-id', name: 'a' })])
    h.plan.set('a', { tools: [tool('search')] })
    await h.mgr.ensureServerByName('a')

    const names = ['s1', 's2', undefined].map((sid) =>
      h.mgr.getAgentToolsByServerName('a', sid).map((t) => t.name)
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
    expect(h.mgr.getAgentToolsByServerName('ssh', 's1')).toEqual([])
    expect(h.mgr.getAgentToolsByServerName('ssh', 's2')).toHaveLength(1)
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
    expect(h.mgr.serverToAgentTools('a-id')).toHaveLength(1)
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
    expect(h.mgr.getAgentToolsByServerName('ssh', 's1')).toEqual([])

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
    expect(h.mgr.getAllAgentTools()).toEqual([])
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
    const [stale] = h.mgr.getAgentToolsByServerName('ssh', 's1')

    await h.mgr.closeSession('s1')

    const result = await stale.execute('call-1', {}, new AbortController().signal)
    expect(result.details).toMatchObject({ type: 'mcp', server: 'ssh', isError: true })
    expect(JSON.stringify(result.content)).toContain('is not connected')
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
  it('MCPB-U-30 / 31: ensureEnabled 没有会话就跳过 inproc，有会话才带上', async () => {
    const h = setup([sshRow(), row({ id: 'a-id', name: 'a' })])

    // 扩展宿主全量装配，没有逐会话概念：跳过而不是报错
    const without = await h.mgr.ensureEnabled()
    expect(without.map((r) => r.name)).toEqual(['a'])
    expect(h.made('ssh')).toHaveLength(0)

    const withSession = await h.mgr.ensureEnabled({ sessionId: 's1' })
    expect(withSession.map((r) => r.name).sort()).toEqual(['a', 'ssh'])
    expect(withSession.every((r) => r.result.ok)).toBe(true)
    expect(h.madeFor('ssh', 's1')).toHaveLength(1)
  })

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
  tools: ReturnType<McpManager['serverToAgentTools']>,
  i = 0
): McpAgentToolMeta['mcpMeta'] => (tools[i] as unknown as McpAgentToolMeta).mcpMeta

describe('McpManager 的 annotations 可信规则', () => {
  it('MCPB-U-36: 可信 server 的四个 hint 原样落到工具事实上', async () => {
    const h = setup([sshRow()])
    h.plan.set('ssh', { tools: [annotated('list-hosts', FULL_HINTS)] })
    await h.mgr.ensureServerByName('ssh', { sessionId: 's1' })

    expect(metaOf(h.mgr.serverToAgentTools('ssh-id#s1'))).toEqual({
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
    expect(metaOf(h.mgr.serverToAgentTools('a-id'))).toEqual({
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

    const meta = metaOf(h.mgr.serverToAgentTools('ssh-id#s1'))
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

    expect(metaOf(h.mgr.serverToAgentTools('ssh-id#s1'))).toEqual({
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
      h.mgr
        .getAllAgentTools()
        .map((t) => [
          (t as unknown as McpAgentToolMeta).mcpMeta.server,
          (t as unknown as McpAgentToolMeta).mcpMeta
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

    expect(metaOf(h.mgr.serverToAgentTools('builtin-mcp-tavily'))).toMatchObject({
      server: 'tavily',
      trusted: false,
      readOnly: undefined
    })
  })
})

// ─── 工具桥接的其余契约 ──────────────────────────────────────────────────

describe('McpManager 的 MCP → AgentTool 桥接', () => {
  it('MCPB-U-42: pi 那边的 toolCallId 经 `_meta` 带给 server', async () => {
    const h = setup([sshRow()])
    h.plan.set('ssh', { tools: [tool('exec')] })
    await h.mgr.ensureServerByName('ssh', { sessionId: 's1' })

    const [t] = h.mgr.serverToAgentTools('ssh-id#s1')
    await t.execute('pi-call-42', { q: 'x' }, new AbortController().signal)

    // 询问卡片的路由键按约定就是 toolCallId —— 少了它，内置服务器的 ask 就对不上这次调用
    expect(h.lastFor('ssh', 's1').toolCallMetas).toEqual([
      { 'shuvix.dev/toolCallId': 'pi-call-42' }
    ])
  })

  it('MCPB-U-43: 没有 toolCallId 时 `_meta` 整个缺席，而不是一个空对象', async () => {
    const h = setup([sshRow()])
    h.plan.set('ssh', { tools: [tool('exec')] })
    await h.mgr.ensureServerByName('ssh', { sessionId: 's1' })

    // 直接走 callTool（AgentTool 那条路恒有 toolCallId）
    await h.mgr.callTool('ssh-id#s1', 'exec', { q: 'x' })

    // 空对象是个**存在的** `_meta`：规范要求其中的键带前缀，凭空一个 `{}` 只会让
    // 严格的 server 多一次校验分支
    expect(h.lastFor('ssh', 's1').toolCallMetas).toEqual([undefined])
  })

  it('MCPB-U-44: server 名里带 `__` 时，工具名拼接不影响事实里的那两个字段', async () => {
    const h = setup([row({ id: 'ab-id', name: 'a__b' })])
    h.plan.set('a__b', { tools: [tool('t')] })
    await h.mgr.ensureServerByName('a__b')

    const [t] = h.mgr.serverToAgentTools('ab-id')
    // 前缀是给 LLM 看的名字，切不回来也没关系：策略读的是 mcpMeta，不是拆名字
    expect(t.name).toBe('mcp__a__b__t')
    expect(metaOf(h.mgr.serverToAgentTools('ab-id'))).toMatchObject({ server: 'a__b', tool: 't' })
  })

  it('MCPB-U-45: mcpMeta 经原型链也读得到 —— wrapToolOutput 就是这么读的', async () => {
    const h = setup([sshRow()])
    h.plan.set('ssh', { tools: [annotated('list-hosts', FULL_HINTS)] })
    await h.mgr.ensureServerByName('ssh', { sessionId: 's1' })

    const [t] = h.mgr.serverToAgentTools('ssh-id#s1')
    // 包装器用 Object.create(tool) 保原型链（`{...tool}` 会把 class getter 静默丢掉），
    // 所以 mcpMeta 必须是能沿原型链查到的东西，而不是只在自身属性上
    const wrapped = Object.create(Object.create(t)) as McpAgentToolMeta
    expect(wrapped.mcpMeta).toBe((t as unknown as McpAgentToolMeta).mcpMeta)
    expect(wrapped.mcpMeta).toMatchObject({ server: 'ssh', trusted: true, readOnly: true })
  })
})
