/**
 * McpStdioTransport —— 桌面自己的 MCP stdio 客户端 transport（换掉 SDK 的 StdioClientTransport）。
 *
 * 换它为的是 SDK 做不到的两件事，这里逐条钉：
 *  1. **stderr 接管道、留最近一段**（McpStderrSource），而且要在 onclose **之前**就位 —— McpManager
 *     在 onclose 里读它拼进报错，晚一拍读到的就是空的；
 *  2. **子进程自成进程组，关闭（或 server 自己退出）时整组收掉** —— npx / uvx 只是包装器，真正的
 *     server 是它的子进程；工具调用发现掉线会原地重连，每留下一个孤儿就多一份。
 * 其余是 Transport 契约本身：换行分帧、坏行不断流、onclose 恰好一次、关闭顺序（先关 stdin 让 server
 * 自己退，再 SIGTERM，再 SIGKILL）。
 *
 * 跑的是真子进程（process.execPath + 临时目录里的 .cjs 夹具），用真时钟：要验证的恰恰是信号、管道
 * 与进程组这些 fake timers 模拟不了的东西。进程组相关的用例只在 POSIX 上跑。最后一组（MCPS-U-10）
 * 把它接到真 McpManager 上，走一遍「调用中途进程崩溃 → 带 stderr 报错 → 下一次调用起新进程」。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi, type Mock } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import type { McpServer } from '@shuvix/chat-protocol/types/mcp'
import { McpManager, type McpStore } from '@shuvix/agent-runtime'
import { McpStdioTransport, type McpStdioTransportOptions } from '../mcpStdioTransport'
import { executeTool, failureText } from '@shuvix/agent-runtime/tools/testing/invokeTool'

/** 进程组 / 信号语义只在 POSIX 上成立（Windows 走 taskkill /T） */
const ON_WINDOWS = process.platform === 'win32'

// ─── 夹具 ────────────────────────────────────────────────────────────────

/**
 * 行分隔 JSON-RPC 应答器（MCPS-U-1~9、12）。方法：
 *  - `echo` → `{params, env: FIXTURE_VAR}`
 *  - `burst {parts, delayMs}` → 把 parts 原样逐段写到 stdout（段间隔 delayMs），再作答
 *  - `stderr {text}` → 写到 stderr，写完再作答
 *  - `exit {code}` → 不作答直接退出
 *  - `spawnChild {stdio, ignoreTerm?, ready?}` → 起一个常驻孙进程（不 detached，与它同组），答 `{pid}`；
 *    `ready` 时孙进程装好信号处理后往（继承来的）stderr 写一行 `gc-ready`
 * 环境开关：MARKER=<文件>（stdin 结束写 `eof`、收到 SIGTERM 写 `term`）、IGNORE_EOF=1（stdin 结束
 * 不退出）、IGNORE_TERM=1（SIGTERM 不退出）。
 */
const ECHO_SOURCE = String.raw`'use strict'
const fs = require('node:fs')
const { spawn } = require('node:child_process')

const mark = (what) => {
  if (process.env.MARKER) fs.writeFileSync(process.env.MARKER, what)
}
const reply = (msg, result) =>
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n')

// 保活：事件循环里只剩 stdin 时，stdin 一结束进程就自己退了 —— IGNORE_EOF 要靠它留下来
setInterval(() => {}, 1000)

process.on('SIGTERM', () => {
  mark('term')
  if (process.env.IGNORE_TERM !== '1') process.exit(143)
})

function handle(msg) {
  const p = msg.params || {}
  switch (msg.method) {
    case 'echo':
      return reply(msg, { params: msg.params, env: process.env.FIXTURE_VAR })
    case 'burst': {
      let i = 0
      const next = () => {
        if (i < p.parts.length) {
          process.stdout.write(p.parts[i++])
          setTimeout(next, p.delayMs)
        } else {
          reply(msg, {})
        }
      }
      return next()
    }
    case 'stderr':
      return process.stderr.write(p.text, () => reply(msg, {}))
    case 'exit':
      return process.exit(p.code)
    case 'spawnChild': {
      const script =
        (p.ignoreTerm ? "process.on('SIGTERM', () => {});" : '') +
        'setInterval(() => {}, 1000);' +
        (p.ready ? "process.stderr.write('gc-ready\\n');" : '')
      const child = spawn(process.execPath, ['-e', script], { stdio: p.stdio })
      return reply(msg, { pid: child.pid })
    }
  }
}

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
    const line = buf.slice(0, i)
    buf = buf.slice(i + 1)
    if (line.trim()) handle(JSON.parse(line))
  }
})
process.stdin.on('end', () => {
  mark('eof')
  if (process.env.IGNORE_EOF !== '1') process.exit(0)
})
`

/**
 * 最小的 MCP server（MCPS-U-10）：initialize / tools/list / tools/call（`echo` 答 `echo:<pid>`；
 * `crash` 往 stderr 写 `panic: boom` 后不作答直接退出）。CALLS_FILE=<文件>：每次 tools/call 追加一行
 * 工具名；FAIL_FAST=1：启动即往 stderr 报错并退出。
 */
const MCP_SOURCE = String.raw`'use strict'
const fs = require('node:fs')
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')

function handle(msg) {
  if (msg.id === undefined) return // 通知
  const p = msg.params || {}
  switch (msg.method) {
    case 'initialize':
      return send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: p.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'mcp-fixture', version: '0.0.0' }
        }
      })
    case 'tools/list':
      return send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          tools: [
            { name: 'echo', inputSchema: { type: 'object' } },
            { name: 'crash', inputSchema: { type: 'object' } }
          ]
        }
      })
    case 'tools/call':
      if (process.env.CALLS_FILE) fs.appendFileSync(process.env.CALLS_FILE, p.name + '\n')
      if (p.name === 'crash') return process.stderr.write('panic: boom\n', () => process.exit(3))
      return send({
        jsonrpc: '2.0',
        id: msg.id,
        result: { content: [{ type: 'text', text: 'echo:' + process.pid }] }
      })
    default:
      return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } })
  }
}

if (process.env.FAIL_FAST === '1') {
  process.stderr.write('fatal: missing API key\n', () => process.exit(1))
} else {
  let buf = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buf += chunk
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (line.trim()) handle(JSON.parse(line))
    }
  })
  process.stdin.on('end', () => process.exit(0))
}
`

let dir = ''
let ECHO = ''
let MCP = ''

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shuvix-mcp-stdio-'))
  ECHO = path.join(dir, 'echo.cjs')
  MCP = path.join(dir, 'mcp-fixture.cjs')
  fs.writeFileSync(ECHO, ECHO_SOURCE)
  fs.writeFileSync(MCP, MCP_SOURCE)
})

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

// ─── 收尾：每个用例起的进程都不许活过这个用例 ────────────────────────────

const transports: McpStdioTransport[] = []
/** 夹具起的孙进程 —— transport 关不到它时（用例本身挂了）由这里兜底 */
const grandchildren: number[] = []

afterEach(async () => {
  await Promise.all(transports.splice(0).map((t) => t.close()))
  for (const pid of grandchildren.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // 已经没了
    }
  }
})

// ─── 工具 ────────────────────────────────────────────────────────────────

/** 进程还在吗（EPERM = 在，只是不归我们管） */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 每 20ms 看一眼，直到 `pred` 给出真值（返回它）；超时就带着说明挂掉 */
async function waitFor<T>(pred: () => T | undefined | null | false, ms = 3000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = pred()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`waitFor: ${ms}ms 内没等到 ${pred.toString()}`)
    await sleep(20)
  }
}

/** 本进程的环境 + 夹具开关（子进程的环境是整份替换，不是叠加） */
const envWith = (extra: Record<string, string> = {}): Record<string, string> => ({
  ...(process.env as Record<string, string>),
  ...extra
})

/** 一个 transport 与它吐出来的一切：消息、错误、onclose 次数 */
interface Probe {
  t: McpStdioTransport
  messages: JSONRPCMessage[]
  errors: unknown[]
  closes: number
  /** 发一条请求，等对应 id 的应答 */
  request(method: string, params?: Record<string, unknown>): Promise<JSONRPCMessage>
}

/** 造一个接着 echo 夹具的 transport（还没 start） */
function open(options: Partial<McpStdioTransportOptions> = {}): Probe {
  const t = new McpStdioTransport({ command: process.execPath, args: [ECHO], ...options })
  transports.push(t)
  let nextId = 1
  const probe: Probe = {
    t,
    messages: [],
    errors: [],
    closes: 0,
    async request(method, params = {}) {
      const id = nextId++
      await t.send({ jsonrpc: '2.0', id, method, params })
      return waitFor(() => probe.messages.find((m) => 'id' in m && m.id === id))
    }
  }
  t.onmessage = (m) => probe.messages.push(m)
  t.onerror = (e) => probe.errors.push(e)
  t.onclose = () => {
    probe.closes++
  }
  return probe
}

/** 一条不需要应答的请求（发出去就不管了：`exit` 这类） */
const fireAndForget = (method: string, params: Record<string, unknown> = {}): JSONRPCMessage => ({
  jsonrpc: '2.0',
  id: 9999,
  method,
  params
})

/** 夹具 stdout 上的通知（没有 id 的那些），按到达顺序 */
const notifications = (p: Probe): string[] =>
  p.messages.flatMap((m) => ('method' in m && !('id' in m) ? [m.method] : []))

/** 让夹具起一个孙进程，记下它的 pid 供收尾兜底 */
async function spawnGrandchild(
  p: Probe,
  opts: { stdio: 'ignore' | 'inherit'; ignoreTerm?: boolean; ready?: boolean }
): Promise<number> {
  const res = await p.request('spawnChild', opts)
  if (!('result' in res)) throw new Error(`spawnChild 没有成功：${JSON.stringify(res)}`)
  const pid = (res.result as { pid: number }).pid
  grandchildren.push(pid)
  if (opts.ready) await waitFor(() => p.t.stderrTail().includes('gc-ready'))
  return pid
}

// ─── 用例 ────────────────────────────────────────────────────────────────

describe('McpStdioTransport 收发', () => {
  it('MCPS-U-1: 一来一回；换行分帧经得起拆包、粘包与 \\r\\n', async () => {
    const p = open({ env: envWith({ FIXTURE_VAR: 'hello' }) })
    await p.t.start()
    expect(typeof p.t.pid).toBe('number')

    // 环境是整份交给子进程的（桌面传 buildSpawnEnv 的结果）
    expect(await p.request('echo', { a: 1 })).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { params: { a: 1 }, env: 'hello' }
    })

    // 两条粘在一个包里（第二条以 \r\n 结尾）、第三条被拆成两段、隔 30ms 才到齐
    await p.request('burst', {
      parts: [
        '{"jsonrpc":"2.0","method":"n1"}\n{"jsonrpc":"2.0","method":"n2"}\r\n{"jsonrpc":"2.0",',
        '"method":"n3"}\n'
      ],
      delayMs: 30
    })
    expect(notifications(p)).toEqual(['n1', 'n2', 'n3'])
    expect(p.errors).toEqual([])
  })

  it('MCPS-U-2: stdout 上一行不是 JSON-RPC —— 报 onerror，后面的消息照常到', async () => {
    const p = open()
    await p.t.start()

    // server 往 stdout 打了一行日志、又打了一行 JSON 但不是 JSON-RPC：两行各报一次，流不断
    await p.request('burst', {
      parts: ['hello from a server log\n{"foo":1}\n{"jsonrpc":"2.0","method":"after"}\n'],
      delayMs: 0
    })
    expect(p.errors).toHaveLength(2)
    for (const err of p.errors) expect(err).toBeInstanceOf(Error)
    expect(notifications(p)).toEqual(['after'])

    expect(await p.request('echo', { b: 2 })).toMatchObject({ id: 2, result: { params: { b: 2 } } })
    expect(p.closes).toBe(0)
  })
})

describe('McpStdioTransport 的 stderr 尾巴', () => {
  it('MCPS-U-3a: onclose 触发时 stderr 已经收齐 —— McpManager 就是在 onclose 里读它的', async () => {
    const p = open()
    let tailAtClose: string | undefined
    p.t.onclose = () => {
      tailAtClose = p.t.stderrTail()
      p.closes++
    }
    await p.t.start()
    expect(typeof p.t.stderrTail).toBe('function')

    await p.request('stderr', { text: 'boom: missing key\n' })
    await p.t.send(fireAndForget('exit', { code: 1 }))
    await waitFor(() => p.closes === 1)
    expect(tailAtClose).toContain('boom: missing key')
  })

  it('MCPS-U-3b: 只留尾部 maxStderrBytes 字节', async () => {
    const p = open({ maxStderrBytes: 64 })
    await p.t.start()

    await p.request('stderr', { text: 'A'.repeat(1000) + 'TAIL-END' })
    const tail = await waitFor(() => {
      const s = p.t.stderrTail()
      return s.endsWith('TAIL-END') ? s : undefined
    })
    expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(64)
  })

  it('MCPS-U-3c: 默认上限 16KB —— 写 40KB 只留最后一段', async () => {
    const p = open()
    await p.t.start()

    await p.request('stderr', { text: 'B'.repeat(40 * 1024) + 'TAIL-END' })
    const tail = await waitFor(() => {
      const s = p.t.stderrTail()
      return s.endsWith('TAIL-END') ? s : undefined
    })
    expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(16 * 1024)
  })
})

describe('McpStdioTransport 的生命周期', () => {
  it('MCPS-U-4a: server 自己退出 —— onclose 恰好一次，之后 close() 是空操作、send 拒绝', async () => {
    const p = open()
    await p.t.start()
    await p.request('echo')

    await p.t.send(fireAndForget('exit', { code: 0 }))
    await waitFor(() => p.closes === 1)
    await p.t.close()
    await p.t.close()
    expect(p.closes).toBe(1)
    await expect(p.t.send(fireAndForget('echo'))).rejects.toThrow(/^Not connected$/)
  })

  it('MCPS-U-4b: 关掉一个活着的 server —— close() 落定时 onclose 已触发一次，再关不重复', async () => {
    const p = open()
    await p.t.start()
    await p.request('echo')

    await p.t.close()
    expect(p.closes).toBe(1)
    await p.t.close()
    expect(p.closes).toBe(1)
    await expect(p.t.send(fireAndForget('echo'))).rejects.toThrow(/^Not connected$/)
  })

  it('MCPS-U-4c: 只能 start 一次；先 close 再 start 也不行', async () => {
    const p = open()
    await p.t.start()
    await expect(p.t.start()).rejects.toThrow('McpStdioTransport already started')

    const q = open()
    await q.t.close()
    await expect(q.t.start()).rejects.toThrow('McpStdioTransport is closed')
  })

  it('MCPS-U-5a: 关闭先关 stdin —— server 自己读到 EOF 退出，轮不到 SIGTERM', async () => {
    const marker = path.join(dir, 'marker-5a')
    const p = open({ env: envWith({ MARKER: marker }) })
    await p.t.start()
    await p.request('echo')
    const pid = p.t.pid!

    await p.t.close()
    expect(fs.readFileSync(marker, 'utf8')).toBe('eof')
    expect(isAlive(pid)).toBe(false)
  })

  it.skipIf(ON_WINDOWS)(
    'MCPS-U-5b: 无视 EOF 也无视 SIGTERM 的 server —— closeTimeoutMs 之后 SIGKILL，close() 不挂住',
    async () => {
      const p = open({ env: envWith({ IGNORE_EOF: '1', IGNORE_TERM: '1' }), closeTimeoutMs: 200 })
      await p.t.start()
      await p.request('echo') // 夹具的信号处理装好了
      const pid = p.t.pid!

      const started = Date.now()
      await p.t.close()
      expect(Date.now() - started).toBeLessThan(2000)
      await waitFor(() => !isAlive(pid))
      expect(p.closes).toBe(1)
    }
  )

  it('MCPS-U-9: 起不来（ENOENT）—— start() 带着错误码拒绝；之后 send 拒绝、close 照常落定', async () => {
    const p = open({ command: '/nonexistent/mcp-server-xyz', args: [] })

    await expect(p.t.start()).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(p.t.send(fireAndForget('echo'))).rejects.toThrow(/^Not connected$/)
    await p.t.close()
    await sleep(100)
    expect(p.closes).toBeLessThanOrEqual(1)
  })

  it.skipIf(ON_WINDOWS)(
    'MCPS-U-12: 管道写满时进程死了 —— 等 drain 的那次 send() 以 Not connected 失败，而不是一直悬着',
    async () => {
      // 一个从不读 stdin 的进程：一条大消息写下去，管道很快就满了
      const p = open({ args: ['-e', 'setInterval(() => {}, 1000)'] })
      await p.t.start()

      const big = fireAndForget('echo', { pad: 'x'.repeat(4 * 1024 * 1024) })
      const sent = p.t.send(big).then(
        () => 'resolved',
        (e: Error) => e.message
      )
      await sleep(100)
      expect(await Promise.race([sent, sleep(0).then(() => 'pending')])).toBe('pending')

      process.kill(p.t.pid!, 'SIGKILL')
      expect(await sent).toBe('Not connected')
    }
  )
})

describe('McpStdioTransport 的进程组（POSIX）', () => {
  for (const stdio of ['ignore', 'inherit'] as const) {
    it.skipIf(ON_WINDOWS)(
      `MCPS-U-6: close() 收掉整个进程组 —— 包括包装器底下的孙进程（孙进程 stdio: ${stdio}）`,
      async () => {
        // 无视 EOF：要等到 SIGTERM 才退（npx 这类包装器就是这样）
        const p = open({ env: envWith({ IGNORE_EOF: '1' }) })
        await p.t.start()
        const leader = p.t.pid!
        const gpid = await spawnGrandchild(p, { stdio })
        expect(isAlive(gpid)).toBe(true)

        await p.t.close()
        await waitFor(() => !isAlive(gpid))
        expect(isAlive(leader)).toBe(false)
      }
    )
  }

  it.skipIf(ON_WINDOWS)(
    'MCPS-U-7: server 自己退出 —— 组里剩下的进程也被收掉（没人调 close）',
    async () => {
      const p = open()
      await p.t.start()
      const gpid = await spawnGrandchild(p, { stdio: 'ignore' })
      expect(isAlive(gpid)).toBe(true)

      await p.t.send(fireAndForget('exit', { code: 0 }))
      await waitFor(() => p.closes === 1)
      await waitFor(() => !isAlive(gpid))
    }
  )

  it.skipIf(ON_WINDOWS)(
    'MCPS-U-8: 组长退了、孙进程还攥着管道 —— 连接仍算活着；close() 照样整组收掉',
    async () => {
      const p = open()
      await p.t.start()
      const leader = p.t.pid!
      const gpid = await spawnGrandchild(p, { stdio: 'inherit', ready: true })

      await p.t.send(fireAndForget('exit', { code: 0 }))
      await waitFor(() => !isAlive(leader))
      // 刻意的：管道还被组里的进程攥着 —— 真 server 可能正是它，还在这条管道上说话
      await sleep(200)
      expect(p.closes).toBe(0)
      expect(isAlive(gpid)).toBe(true)

      await p.t.close()
      await waitFor(() => !isAlive(gpid))
      expect(p.closes).toBe(1)
    }
  )

  it.skipIf(ON_WINDOWS)(
    'MCPS-U-8: 同上，但孙进程无视 SIGTERM —— closeTimeoutMs 之后 SIGKILL，close() 两秒内落定',
    async () => {
      const p = open({ closeTimeoutMs: 200 })
      await p.t.start()
      const leader = p.t.pid!
      const gpid = await spawnGrandchild(p, { stdio: 'inherit', ignoreTerm: true, ready: true })

      await p.t.send(fireAndForget('exit', { code: 0 }))
      await waitFor(() => !isAlive(leader))
      expect(p.closes).toBe(0)

      const started = Date.now()
      await p.t.close()
      const elapsed = Date.now() - started
      expect(elapsed).toBeLessThan(2000)
      // SIGTERM 被无视了：能让它退出的只有 closeTimeoutMs 之后的那一下 SIGKILL
      expect(elapsed).toBeGreaterThanOrEqual(150)
      await waitFor(() => !isAlive(gpid))
      expect(p.closes).toBe(1)
    }
  )
})

// ─── 接上真 McpManager ────────────────────────────────────────────────────

describe('McpStdioTransport × McpManager（真子进程）', () => {
  /** 本用例的管理器：收尾时断开全部连接（子进程随之收掉） */
  let active: McpManager | undefined

  afterEach(async () => {
    await active?.disconnectAll()
    active = undefined
  })

  /** 一张只有一台 stdio server `fx` 的内存表；`env` 是这一行配置的环境（JSON 对象） */
  function managerWith(env: Record<string, string>): {
    mgr: McpManager
    createTransport: Mock<(s: McpServer) => McpStdioTransport>
  } {
    const server: McpServer = {
      id: 'fx-id',
      name: 'fx',
      type: 'stdio',
      command: process.execPath,
      args: JSON.stringify([MCP]),
      env: JSON.stringify(env),
      url: '',
      headers: '{}',
      metadata: '{}',
      isEnabled: 1,
      isBuiltin: 0,
      cachedTools: '[]',
      createdAt: 0,
      updatedAt: 0
    }
    const store: McpStore = {
      findById: (id) => (id === server.id ? server : undefined),
      findEnabled: () => [server],
      findAll: () => [server],
      updateCachedTools: (_id, json) => {
        server.cachedTools = json
      }
    }
    const createTransport = vi.fn(
      (s: McpServer) =>
        new McpStdioTransport({
          command: process.execPath,
          args: [MCP],
          env: envWith(JSON.parse(s.env) as Record<string, string>)
        })
    )
    active = new McpManager({ store, createTransport })
    return { mgr: active, createTransport }
  }

  it('MCPS-U-10a: 启动即退出 —— 连接失败，报错末尾是进程打在 stderr 上的死因', async () => {
    const { mgr } = managerWith({ FAIL_FAST: '1' })

    const result = await mgr.connect('fx-id')
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/Connection closed\nfatal: missing API key$/)
    expect(mgr.getStatus('fx-id')).toBe('error')
  })

  it('MCPS-U-10b: 调用中途进程崩溃 —— 带 stderr 失败、不重发；下一次调用起一个新进程', async () => {
    const calls = path.join(dir, 'calls-10b.txt')
    const { mgr, createTransport } = managerWith({ CALLS_FILE: calls })
    expect(await mgr.ensureServerByName('fx')).toEqual({ ok: true })
    const tools = new Map(mgr.getAgentToolsByServerName('fx').map((t) => [t.name, t]))
    const firstPid = createTransport.mock.results[0].value.pid
    expect(typeof firstPid).toBe('number')
    const signal = new AbortController().signal

    // P1-04：失败收成 isError 结果（裁定 Q12），文字即原先抛出的消息
    const crashed = await failureText(executeTool(tools.get('mcp__fx__crash')!, 'c1', {}, signal))
    expect(crashed.startsWith('[MCP Error] ')).toBe(true)
    expect(crashed.endsWith('\npanic: boom')).toBe(true)
    // 请求到过 server 一次，没有被重发
    expect(fs.readFileSync(calls, 'utf8')).toBe('crash\n')
    expect(createTransport).toHaveBeenCalledTimes(1)
    expect(mgr.getStatus('fx-id')).toBe('disconnected')

    // 同一个工具闭包（Agent 没重建）：原地重连，起的是一个新进程
    const result = await executeTool(tools.get('mcp__fx__echo')!, 'c2', {}, signal)
    const [block] = result.content
    const echoed = block.type === 'text' ? block.text : ''
    expect(echoed).toMatch(/^echo:\d+$/)
    expect(echoed).not.toBe(`echo:${firstPid}`)
    expect(createTransport).toHaveBeenCalledTimes(2)
    expect(fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean)).toEqual(['crash', 'echo'])
  })
})
