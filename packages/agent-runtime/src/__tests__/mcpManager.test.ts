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
import { McpManager, type McpDiscoveredTool, type McpStore } from '../mcpManager'

// ─── 假件 ────────────────────────────────────────────────────────────────

const isRequest = (m: JSONRPCMessage): m is JSONRPCRequest => 'id' in m && 'method' in m

interface FakeOpts {
  /** tools/list 的应答 */
  tools?: McpDiscoveredTool[]
  /** 扣住请求不应答 —— 握手永不落定（超时 / 在途被断开类用例） */
  hold?: boolean
  /** close() 时同步回调 onclose：真 transport 就是这么干的，用来钉「失败原因不被它抹掉」 */
  notifyOnClose?: boolean
}

/** 手写 JSON-RPC 应答器：只认 initialize / tools/list，其余一律空 result */
class FakeTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void
  closeCalls = 0
  private held: JSONRPCRequest[] = []
  private holding: boolean

  constructor(
    readonly server: McpServer,
    private readonly opts: FakeOpts = {}
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
    const result =
      message.method === 'initialize'
        ? {
            protocolVersion: message.params?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'fake-mcp', version: '0.0.0' }
          }
        : message.method === 'tools/list'
          ? { tools: this.opts.tools ?? [] }
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

interface TestStore extends McpStore {
  /** 内存表，用例直接改行来模拟「设置页改了配置」 */
  rows: Map<string, McpServer>
  updateCachedTools: Mock<(id: string, toolsJson: string) => void>
}

interface Harness {
  mgr: McpManager
  store: TestStore
  createTransport: Mock<(server: McpServer) => Transport>
  /** 按 server 名（造出来的顺序）取假 transport */
  made(name: string): FakeTransport[]
  last(name: string): FakeTransport
  /** 下一次为该 server 名造 transport 时的行为；Error = createTransport 直接抛 */
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
  const createTransport = vi.fn((server: McpServer): Transport => {
    const p = plan.get(server.name) ?? {}
    if (p instanceof Error) throw p
    const t = new FakeTransport(server, p)
    all.push(t)
    return t
  })
  const made = (name: string): FakeTransport[] => all.filter((t) => t.server.name === name)
  return {
    mgr: new McpManager({ store, createTransport }),
    store,
    createTransport,
    made,
    last: (name) => {
      const list = made(name)
      const t = list[list.length - 1]
      if (!t) throw new Error(`no transport was created for "${name}"`)
      return t
    },
    plan
  }
}

/** 让微任务与已到期的定时器跑完（fake timers 下 advanceTimersByTimeAsync 会真让出事件循环） */
const settle = async (ms = 0): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms)
}

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
