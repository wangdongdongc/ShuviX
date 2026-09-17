/**
 * 内置能力服务器 `ssh` —— 隔着**真的 MCP 协议**看它。
 *
 * 用 `InMemoryTransport.createLinkedPair()` + SDK 的 `Client` 驱动，而不是直接调处理函数：
 * 这台 server 的产出全都要过一遍协议层（工具声明、`structuredContent` 对 outputSchema 的校验、
 * 未知工具的错误形态、断开的传播），绕过协议就等于把要测的那一层测没了。
 *
 * 钉的是四件事：
 *   85…87  **工具面**：无参工具显式只收空对象，annotations 如实声明 ——
 *          模型据此判断「这是不是一个可以随便调的工具」；
 *   88…94  **产出**：文本与 structuredContent 两份、空配置不是错误、人读行的格式、
 *          上限截断要**说出来**、以及每次调用现读配置（用户可能刚改过 ~/.ssh/config）；
 *   95…97  **边界**：未知工具是一条普通的错误结果而不是断连、枚举**绝不起进程**
 *          （`ssh -G` 会执行 `Match exec` 里的 shell 命令）、客户端断开会传到 server 侧的
 *          释放钩子上；
 *   98…126 **exec / disconnect**：别名的第二道复核、命令级安全门（客体与 opts 的契约、
 *          反馈 / 拒绝 / 灾难命令 / 没有输入面板）、询问卡片的路由键与目标机器、
 *          结果翻译（远端自己的退出码 vs ssh 连不上）、超时的取值与钳位、中止、
 *          状态条，以及会话释放今天的那个缺口。
 *
 * 另有一条装配期的对账：内置工厂表的键必须与迁移种下的那一行同名 —— 两边一旦对不上，
 * 会话里那台服务器会在建连的一瞬间抛「没注册」。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { InputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import { initShellParser } from '@shuvix/agent-runtime'

// mock 路径按**测试文件**解析：被测模块在 services/builtinMcp/，测试在其 __tests__/ 下
const logged = vi.hoisted(() => ({ lines: [] as string[] }))

/**
 * 安全门后面是**真的**安全模块。
 *
 * mock 掉的只是 `getDesktopSecurityContext` 那条会拉起 Electron app 与整个 service 图的
 * 取用路径；门后仍是 `createSecurityContext` 本体，主体/环境/变量表按 toolContext 的生产
 * 形态复刻，内置策略一条不少。换成「永远放行」的 stub 就等于在测那个 stub —— 而这一组问的
 * 恰恰是 exec 到底过没过那道门：**内置能力服务器相对第三方 server 的实质特权就是这一句**。
 */
const gate = vi.hoisted(() => ({
  /** enforceCommand 收到的实参 —— 契约就在这两个对象里 */
  calls: [] as Array<{ object: unknown; opts: unknown }>,
  /** 这条会话的用户策略；空 = 只有内置那套 */
  policies: [] as unknown[],
  /** 免询问开关（session-auto-allow 的 force-allow） */
  autoAllow: false
}))

vi.mock('../../toolContext', async () => {
  const { createSecurityContext, analyzeShellCommand } = await import('@shuvix/agent-runtime')
  type Ctx = Parameters<typeof import('../../toolContext').getDesktopSecurityContext>[0]
  return {
    TOOL_ABORTED: 'Aborted',
    getDesktopSecurityContext: (ctx: Ctx) => {
      const real = createSecurityContext(
        // J10：这里逐字复刻 toolContext 今天上报的主体 —— 固定 root，档案维度还没接线
        { kind: 'agent', sessionId: ctx.sessionId, agentKind: 'root' },
        { host: 'desktop', platform: process.platform, workspaceDir: '/ws' },
        {
          host: 'desktop',
          pathSep: '/',
          getVars: () => ({
            workspace: '/ws',
            toolResultsBase: '/tool-results',
            skillsDirs: ['/skills'],
            memoryDirs: [],
            knowledgeRoot: '/kb',
            knowledgeSessionDirs: [],
            home: '/home/u',
            botsDir: '/home/u/.shuvix/bots',
            builtinKnowledgeDir: '/opt/shuvix/Resources/knowledge',
            systemDirs: []
          }),
          getSessionGrants: () => ({ autoAllow: gate.autoAllow, allowList: [] }),
          getUserPolicies: () => gate.policies as never,
          shellParser: { ensureReady: async () => {}, analyze: analyzeShellCommand },
          // 询问通道由 scope 注入：缺席就是「这条会话没有输入面板」，fail-closed 用例靠它
          requestUserInput: ctx.requestUserInput
        }
      )
      return {
        ...real,
        enforceCommand: (object: never, opts: never) => {
          gate.calls.push({ object, opts })
          return real.enforceCommand(object, opts)
        }
      }
    }
  }
})
vi.mock('../../../utils/paths', () => ({ buildSpawnEnv: () => ({}) }))

/**
 * 连接层是假的 —— 这一组问的是 server 的判断，不是 ssh 的行为。
 *
 * 只换四个会真的起 ssh 的出口；`classifySshFailure` 走原件，因为「255 该不该翻译」
 * 正是 exec 要端到端回答的问题之一，换成假件就把要测的那一层测没了。
 */
const control = vi.hoisted(() => ({
  exec: [] as Array<Record<string, unknown>>,
  /** 下一次 sshExec 的应答；Error = 直接 reject（ssh 二进制不在等） */
  result: { stdout: '', stderr: '', exitCode: 0, timedOut: false } as
    | { stdout: string; stderr: string; exitCode: number; timedOut: boolean }
    | Error,
  disconnect: [] as Array<{ sessionId: string; alias: string }>,
  /** sshDisconnect 的返回值 = 「本来是否连着」 */
  wasConnected: true,
  /** sshConnectedAliases 眼里连着的别名 */
  connected: [] as string[],
  closeSession: [] as Array<{ sessionId: string; aliases: string[] }>
}))

vi.mock('../sshControl', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sshControl')>()
  return {
    ...actual,
    sshExec: async (opts: Record<string, unknown>) => {
      control.exec.push(opts)
      if (control.result instanceof Error) throw control.result
      return control.result
    },
    sshDisconnect: async (sessionId: string, alias: string) => {
      control.disconnect.push({ sessionId, alias })
      return control.wasConnected
    },
    sshConnectedAliases: (_sessionId: string, aliases: string[]) =>
      aliases.filter((a) => control.connected.includes(a)),
    sshCloseSession: async (sessionId: string, aliases: string[]) => {
      control.closeSession.push({ sessionId, aliases })
      return 0
    }
  }
})
vi.mock('../../../logger', () => ({
  createLogger: () => ({
    info: (m: string) => void logged.lines.push(m),
    warn: () => {},
    error: () => {}
  })
}))

/** 枚举阶段起进程 = 当场记一笔（今天根本不 import child_process，这是回归闸门） */
const cp = vi.hoisted(() => {
  const calls: string[] = []
  const rec =
    (name: string) =>
    (...args: unknown[]): never => {
      calls.push(`${name}(${String(args[0])})`)
      throw new Error(`ssh 别名枚举不该起进程：${name}`)
    }
  const api = {
    spawn: rec('spawn'),
    spawnSync: rec('spawnSync'),
    exec: rec('exec'),
    execSync: rec('execSync'),
    execFile: rec('execFile'),
    execFileSync: rec('execFileSync'),
    fork: rec('fork')
  }
  return { calls, factory: (): Record<string, unknown> => ({ ...api, default: api }) }
})
vi.mock('child_process', cp.factory)
vi.mock('node:child_process', cp.factory)

import { migrations } from '../../../dao/migrations'
import { BUILTIN_MCP_FACTORIES } from '../index'
import { createSshMcpServerFactory } from '../sshServer'

// ─── 素材 ────────────────────────────────────────────────────────────────

const roots: string[] = []
let sshDir = ''
let configPath = ''

/**
 * 真 tree-sitter-bash —— block-catastrophic-commands 是唯一读**结构事实**的内置策略，
 * 而「它在 ssh 通道上照样管用」正是这一组要端到端回答的问题。wasm 字节的定位同
 * shellParserService 的开发态分支（仓库根 node_modules，workspace hoist 后两个包都在那里）。
 */
beforeAll(async () => {
  const require = createRequire(import.meta.url)
  await initShellParser({
    runtime: new Uint8Array(readFileSync(require.resolve('web-tree-sitter/web-tree-sitter.wasm'))),
    grammar: new Uint8Array(readFileSync(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm')))
  })
})

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'shuvix-sshsrv-'))
  roots.push(root)
  sshDir = join(root, '.ssh')
  mkdirSync(sshDir, { recursive: true })
  configPath = join(sshDir, 'config')
  logged.lines.length = 0
  cp.calls.length = 0
  gate.calls.length = 0
  gate.policies.length = 0
  gate.autoAllow = false
  control.exec.length = 0
  control.disconnect.length = 0
  control.closeSession.length = 0
  control.connected.length = 0
  control.result = { stdout: '', stderr: '', exitCode: 0, timedOut: false }
  control.wasConnected = true
})

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

interface Session {
  client: Client
  clientTransport: Transport
  /** 这条会话弹出的询问卡片（安全门经 scope.requestUserInput 挂的那些） */
  asks: InputRequest[]
  /** 运行时状态条事件（连接状态 chip） */
  events: Array<Record<string, unknown>>
}

interface OpenOpts {
  sessionId?: string
  /** 询问应答；`null` = 这条会话没有输入面板（fail-closed 用例） */
  respond?: ((req: InputRequest) => Promise<InputResponse>) | null
}

/** 把一台 ssh server 接到一对真 InMemoryTransport 上，并连一个真 Client */
async function open(opts: OpenOpts = {}): Promise<Session> {
  const asks: InputRequest[] = []
  const events: Array<Record<string, unknown>> = []
  const respond =
    opts.respond === undefined
      ? async (): Promise<InputResponse> => ({ kind: 'ask', allowed: true })
      : opts.respond
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await createSshMcpServerFactory({ configPath })(
    {
      sessionId: opts.sessionId ?? 's1',
      requestUserInput: respond
        ? async (req: InputRequest): Promise<InputResponse> => {
            asks.push(req)
            return respond(req)
          }
        : undefined,
      emitChatEvent: (e) => void events.push(e as unknown as Record<string, unknown>)
    },
    serverTransport
  )
  const client = new Client({ name: 'test', version: '0.0.0' })
  await client.connect(clientTransport)
  return { client, clientTransport, asks, events }
}

function writeConfig(text: string): void {
  writeFileSync(configPath, text)
}

interface ListHostsResult {
  content: Array<{ type: string; text?: string }>
  structuredContent?: {
    configPath: string
    total: number
    truncated: boolean
    hosts: Array<{ alias: string; hostname?: string; user?: string; port?: number }>
  }
  isError?: boolean
}

const call = async (client: Client, name = 'list-hosts'): Promise<ListHostsResult> =>
  (await client.callTool({ name, arguments: {} })) as unknown as ListHostsResult

const textOf = (r: ListHostsResult): string =>
  r.content
    .map((c) => c.text ?? '')
    .join('\n')
    .trim()

// ─── 工具面 ──────────────────────────────────────────────────────────────

describe('ssh 内置服务器的工具声明', () => {
  it('SSHS-U-85: 工具面恰为 list-hosts / exec / disconnect', async () => {
    writeConfig('Host web\n')
    const { client } = await open()
    const { tools } = await client.listTools()

    // 文件传输（upload / download / sync）还没接上
    expect(tools.map((t) => t.name)).toEqual(['list-hosts', 'exec', 'disconnect'])
  })

  it('SSHS-U-86: 无参工具 —— 显式只接受空对象', async () => {
    writeConfig('')
    const { client } = await open()
    const [tool] = (await client.listTools()).tools

    expect(tool.inputSchema).toEqual({ type: 'object', additionalProperties: false })
    expect(tool.inputSchema.properties).toBeUndefined()
  })

  it('SSHS-U-87: annotations 如实声明「只读、不破坏、幂等、封闭世界」', async () => {
    writeConfig('')
    const { client } = await open()
    const [tool] = (await client.listTools()).tools

    // 这四位是模型判断「要不要先问用户」的依据，写错一位的代价在别处看不出来
    expect(tool.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    })
  })
})

// ─── 产出 ────────────────────────────────────────────────────────────────

describe('ssh 内置服务器的 list-hosts 产出', () => {
  it('SSHS-U-88: 文本与 structuredContent 两份都有', async () => {
    writeConfig('Host web\n  HostName 1.2.3.4\n')
    const { client } = await open()
    await client.listTools() // 先发现：之后 callTool 会拿 outputSchema 校验 structuredContent
    const result = await call(client)

    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toMatchObject({
      configPath,
      hosts: [{ alias: 'web', hostname: '1.2.3.4' }]
    })
    // 不读 structuredContent 的客户端也要能看懂 —— 规范要求带 outputSchema 的工具同时回文本
    expect(textOf(result)).toContain('web')
    expect(textOf(result)).toContain(configPath)
  })

  it('SSHS-U-89: 空配置不是错误，而是「去 ~/.ssh/config 里加一台」', async () => {
    const { client } = await open()
    const result = await call(client)

    expect(result.isError).toBeFalsy()
    expect(result.structuredContent?.hosts).toEqual([])
    expect(result.structuredContent?.total).toBe(0)
    // 这台 server 只能按别名寻址，所以空列表必须把下一步告诉用户，而不是干巴巴回一个空数组
    expect(textOf(result)).toContain('add a Host entry')
    expect(textOf(result)).toContain(configPath)
  })

  it('SSHS-U-90: 人读的一行是 `alias  →  user@hostname:port`', async () => {
    writeConfig('Host web\n  HostName 1.2.3.4\n  User bob\n  Port 2222\n')
    const { client } = await open()

    expect(textOf(await call(client))).toContain('web  →  bob@1.2.3.4:2222')
  })

  it('SSHS-U-91: 只写了别名的块，光秃秃地印出来（不留半截箭头）', async () => {
    writeConfig('Host bare\n')
    const { client } = await open()
    const lines = textOf(await call(client)).split('\n')

    expect(lines.some((l) => l.trim() === 'bare')).toBe(true)
    expect(textOf(await call(client))).not.toContain('→')
  })

  it('SSHS-U-92 / 93: 超过上限只回 200 条，并在文本与 structuredContent 里都说清楚', async () => {
    writeConfig(
      Array.from({ length: 250 }, (_, i) => `Host h${String(i).padStart(3, '0')}\n`).join('')
    )
    const { client } = await open()
    await client.listTools()
    const result = await call(client)

    expect(result.structuredContent?.hosts).toHaveLength(200)
    // 少了这一句，模型会以为自己看到了全部 —— 「配置里没有这台」的结论就是这么来的
    expect(textOf(result)).toContain('… 50 more not shown')
    expect(result.structuredContent).toMatchObject({ total: 250, truncated: true })
  })

  it('SSHS-U-93: 没被截断时 total 与 truncated 也如实回报', async () => {
    writeConfig('Host a\nHost b\n')
    const { client } = await open()
    await client.listTools()

    expect((await call(client)).structuredContent).toMatchObject({ total: 2, truncated: false })
  })

  it('SSHS-U-94: 每次调用现读配置 —— 用户可能刚改过 ~/.ssh/config', async () => {
    writeConfig('Host before\n')
    const { client } = await open()
    expect((await call(client)).structuredContent?.hosts.map((h) => h.alias)).toEqual(['before'])

    writeConfig('Host after\n')
    // 缓存在实例上只会让人困惑：改完配置要重启会话才看得到，没有任何道理
    expect((await call(client)).structuredContent?.hosts.map((h) => h.alias)).toEqual(['after'])
  })
})

// ─── 边界 ────────────────────────────────────────────────────────────────

describe('ssh 内置服务器的边界', () => {
  it('SSHS-U-95: 未知工具是一条普通的错误结果，连接照旧可用', async () => {
    writeConfig('Host web\n')
    const { client } = await open()

    const bad = await call(client, 'upload')
    expect(bad.isError).toBe(true)
    expect(textOf(bad)).toBe('Unknown tool: upload')

    // 不能把连接搞垮：模型试错一次就要重开一台 server，代价比错误本身大得多
    expect((await call(client)).structuredContent?.hosts.map((h) => h.alias)).toEqual(['web'])
  })

  it('SSHS-U-96: 配置里有 `Match exec` / `ProxyCommand` 也绝不起进程', async () => {
    const sentinel = join(sshDir, 'pwned')
    writeConfig(`Host web
  HostName 1.2.3.4
  ProxyCommand touch ${sentinel}
Match exec "touch ${sentinel}"
  User root
`)
    const { client } = await open()
    const result = await call(client)

    expect(cp.calls).toEqual([])
    expect(existsSync(sentinel)).toBe(false)
    expect(result.structuredContent?.hosts.map((h) => h.alias)).toEqual(['web'])
  })

  it('SSHS-U-97: 客户端断开传到 server 侧的释放钩子上', async () => {
    writeConfig('Host web\n')
    const { clientTransport } = await open({ sessionId: 's-close' })
    expect(logged.lines.some((l) => l.includes('ssh server ready session=s-close'))).toBe(true)

    await clientTransport.close()

    // 「会话结束 → McpManager 关连接 → 这里释放」只有这一条路径：本轮没有要释放的东西，
    // 但钩子必须真的被调到，否则 exec 的 control socket 将来会静默泄漏
    expect(logged.lines.some((l) => l.includes('ssh server closed session=s-close'))).toBe(true)
  })
})

// ─── exec / disconnect ───────────────────────────────────────────────────
//
// exec 是这台服务器唯一有副作用的工具，它的产出因此不是「一段文本」而是四个判断：
// 这个别名是不是用户自己配的（两道复核）、这条命令过没过安全门（**内置服务器相对第三方
// server 的实质特权**）、回来的非零码是远端的意思还是 ssh 自己连不上、以及等多久算超时。
// 每一条都只有在错了之后才看得见：别名放松一格是本地任意命令执行，门漏一次是一条没人批准
// 的远端命令，翻译错一次是让 agent 拿着「认证失败」去改一台其实是命令返回 255 的机器。

/** exec 的一组齐全实参 —— 用例按需覆写其中一两个 */
const execArgs = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  host: 'web',
  command: 'uptime',
  description: 'check load',
  ...patch
})

const callTool = async (
  client: Client,
  name: string,
  args: Record<string, unknown>,
  meta?: Record<string, unknown>
): Promise<ListHostsResult> =>
  (await client.callTool({
    name,
    arguments: args,
    ...(meta ? { _meta: meta } : {})
  })) as unknown as ListHostsResult

/** 一份用户策略（同 security/__tests__ 的 userPolicy） */
const userPolicy = (name: string, rules: unknown[]): unknown => ({
  name,
  displayName: name,
  description: '',
  rules,
  body: ''
})

/** 门后拿到的 opts（用例只关心其中一两个键时的取值口） */
const optsOf = (i = 0): Record<string, unknown> => gate.calls[i].opts as Record<string, unknown>

describe('ssh 内置服务器的别名复核', () => {
  it('SSHS-U-98: 不在配置里的别名被拒，并把可用的别名与配置路径一并说出来', async () => {
    writeConfig('Host web\nHost api\n')
    const { client, asks } = await open()

    const r = await callTool(client, 'exec', execArgs({ host: 'nope' }))
    expect(r.isError).toBe(true)
    expect(textOf(r)).toBe(
      `"nope" is not a host alias in ${configPath}. Only these aliases can be used: web, api.`
    )
    // 复核在安全门**之前**：一个连名字都不成立的目标不该惊动用户
    expect(control.exec).toEqual([])
    expect(gate.calls).toEqual([])
    expect(asks).toEqual([])
  })

  it('SSHS-U-99: 一台都没配时换一句话 —— 「去 ~/.ssh/config 里加一台」', async () => {
    writeConfig('')
    const { client } = await open()

    const r = await callTool(client, 'exec', execArgs({ host: 'nope' }))
    expect(r.isError).toBe(true)
    expect(textOf(r)).toBe(
      `No SSH host aliases are defined in ${configPath}, so "nope" cannot be reached. Ask the user to add a Host entry there.`
    )
    expect(control.exec).toEqual([])
  })

  it('SSHS-U-100: disconnect 走同一道复核，两句话逐字相同', async () => {
    writeConfig('Host web\n')
    const { client } = await open()
    expect(textOf(await callTool(client, 'disconnect', { host: 'nope' }))).toBe(
      `"nope" is not a host alias in ${configPath}. Only these aliases can be used: web.`
    )

    writeConfig('')
    expect(textOf(await callTool(client, 'disconnect', { host: 'nope' }))).toBe(
      `No SSH host aliases are defined in ${configPath}, so "nope" cannot be reached. Ask the user to add a Host entry there.`
    )
    expect(control.disconnect).toEqual([])
  })

  it('SSHS-U-101: host 缺席 / 不是字符串 / 只有空白 —— 同一句「必填」', async () => {
    writeConfig('Host web\n')
    const { client } = await open()

    for (const args of [
      { command: 'uptime', description: 'd' },
      execArgs({ host: 42 }),
      execArgs({ host: '   ' })
    ]) {
      const r = await callTool(client, 'exec', args)
      expect(r.isError).toBe(true)
      expect(textOf(r)).toBe('A `host` alias is required.')
    }
    expect(control.exec).toEqual([])
    expect(gate.calls).toEqual([])
  })

  it('SSHS-U-102: 空 command 直接回绝 —— 不起进程，也不为此弹一张卡', async () => {
    writeConfig('Host web\n')
    const { client, asks } = await open()

    const r = await callTool(client, 'exec', execArgs({ command: '   ' }))
    expect(r.isError).toBe(true)
    expect(textOf(r)).toBe('A `command` is required.')
    expect(control.exec).toEqual([])
    // 一张写着空命令的询问卡片，用户既看不懂也批不了
    expect(asks).toEqual([])
    expect(gate.calls).toEqual([])
  })

  it('SSHS-U-103: `-` 开头的记号即便写在配置里，第二道门也不认', async () => {
    // 枚举已经把它滤掉了（SSHC-U-85）；这里问的是**另一道**门 —— 两件事写在两处才叫两道
    writeConfig('Host -oProxyCommand=id\nHost web\n')
    const { client } = await open()

    const r = await callTool(client, 'exec', execArgs({ host: '-oProxyCommand=id' }))
    expect(r.isError).toBe(true)
    expect(textOf(r)).toBe('"-oProxyCommand=id" is not a usable host alias.')
    // 刻意不是「不在清单里」那句：它形状就不对，而不是碰巧没配
    expect(textOf(r)).not.toContain('Only these aliases')
    expect(control.exec).toEqual([])
  })
})

describe('ssh 内置服务器的命令安全门', () => {
  it('SSHS-U-104: 上报的客体恰是 {channel, command, host}，opts 恰是那六项', async () => {
    writeConfig('Host web\n')
    const { client } = await open()

    await callTool(client, 'exec', execArgs({ command: 'df -h', description: 'disk usage' }), {
      'shuvix.dev/toolCallId': 'tc-7'
    })

    expect(gate.calls).toHaveLength(1)
    // host 在客体上，策略才写得出「生产要问、测试放行」（J4）
    expect(gate.calls[0].object).toStrictEqual({
      channel: 'ssh',
      command: 'df -h',
      host: 'web'
    })
    expect(gate.calls[0].opts).toStrictEqual({
      toolCallId: 'tc-7',
      toolName: 'mcp__ssh__exec',
      description: 'disk usage',
      abortError: 'Aborted',
      onOther: 'return',
      // 没有输入面板时 fail-closed —— 一条远端命令不能因为「问不着」就自己跑了
      missingChannel: 'deny'
    })
  })

  it('SSHS-U-105: 用户改说「其它」→ 反馈逐字带回，是正常结果而不是错误，命令没跑', async () => {
    writeConfig('Host web\n')
    const { client } = await open({
      respond: async () => ({ kind: 'other', text: 'use the staging box instead' })
    })

    const r = await callTool(client, 'exec', execArgs())
    expect(r.isError).toBeFalsy()
    expect(textOf(r)).toBe(
      'Command was not executed. User responded with feedback instead:\nuse the staging box instead'
    )
    expect(control.exec).toEqual([])
  })

  it('SSHS-U-106: deny 拦住这次调用 —— 抛出归因，远端一条没跑', async () => {
    writeConfig('Host web\n')
    gate.policies.push(
      userPolicy('no-ssh', [
        { effect: 'deny', match: "object.type == 'command' && object.channel == 'ssh'" }
      ])
    )
    const { client } = await open()

    await expect(client.callTool({ name: 'exec', arguments: execArgs() })).rejects.toThrow(
      /Denied by security policy rule/
    )
    expect(control.exec).toEqual([])
  })

  it('SSHS-U-107: block-catastrophic-commands 在 ssh 通道上照样管用，免询问也压不过', async () => {
    writeConfig('Host web\n')
    // 这条策略读的是**结构事实**（object.commands），所以走的是真解析器
    gate.autoAllow = true
    const { client } = await open()

    await expect(
      client.callTool({ name: 'exec', arguments: execArgs({ command: 'rm -rf /' }) })
    ).rejects.toThrow(/block-catastrophic-commands#0/)
    expect(control.exec).toEqual([])
  })

  it('SSHS-U-108: 这条会话没有输入面板 → 拒绝（fail-closed），不是「问不着就放行」', async () => {
    writeConfig('Host web\n')
    const { client } = await open({ respond: null })

    await expect(client.callTool({ name: 'exec', arguments: execArgs() })).rejects.toThrow(
      'Access denied: this needs your confirmation but there is no way to ask: uptime'
    )
    expect(control.exec).toEqual([])
  })

  it('SSHS-U-109: `_meta` 里的 toolCallId 就是门与卡片用的路由键，卡片写着目标机器', async () => {
    writeConfig('Host web\n')
    const { client, asks } = await open()

    await callTool(client, 'exec', execArgs(), { 'shuvix.dev/toolCallId': 'pi-call-9' })

    expect(optsOf().toolCallId).toBe('pi-call-9')
    expect(asks).toHaveLength(1)
    // `ssh <alias>: <command>`：批准一条 rm 时必须看得见它要跑在哪台机器上（J4）
    expect(asks[0]).toMatchObject({
      id: 'pi-call-9',
      kind: 'ask',
      toolName: 'mcp__ssh__exec',
      command: 'ssh web: uptime',
      description: 'check load'
    })
  })

  it('SSHS-U-110: 客户端没带 `_meta` 时回落到 `ssh-<requestId>`，绝不是空串', async () => {
    writeConfig('Host web\n')
    const { client, asks } = await open()

    await callTool(client, 'exec', execArgs())

    const id = optsOf().toolCallId
    // 空串会让所有并发的 ask 挤在同一个路由键上 —— 用户答了 A 却放行了 B
    expect(id).toMatch(/^ssh-.+$/)
    expect(asks[0].id).toBe(id)
  })
})

describe('ssh 内置服务器 exec 的结果翻译', () => {
  it('SSHS-U-111: 远端命令自己的非零码原样带回，不加任何 ssh 解释', async () => {
    writeConfig('Host web\n')
    control.result = { stdout: 'boom', stderr: '', exitCode: 7, timedOut: false }
    const { client } = await open()

    const r = await callTool(client, 'exec', execArgs())
    // 非零 ≠ 出错：命令做了什么由 agent 自己判断，isError 是留给「这次调用没成立」的
    expect(r.isError).toBeFalsy()
    expect(textOf(r)).toBe('boom\n\n[Exit code: 7]')
  })

  it('SSHS-U-112: 255 + 主机密钥没认过 → 翻成可操作的说明（ShuviX 不代写 known_hosts）', async () => {
    writeConfig('Host web\n')
    control.result = {
      stdout: '',
      stderr: 'Host key verification failed.',
      exitCode: 255,
      timedOut: false
    }
    const { client } = await open()

    const r = await callTool(client, 'exec', execArgs())
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('ShuviX will not add it')
    expect(textOf(r)).toContain('in their own terminal')
  })

  it('SSHS-U-113: 255 但远端有输出 → 那是命令的意思，不翻译', async () => {
    writeConfig('Host web\n')
    // 远端确实连上了并打印了东西，255 只是它自己的退出码
    control.result = {
      stdout: 'exiting with 255 on purpose',
      stderr: 'Host key verification failed.',
      exitCode: 255,
      timedOut: false
    }
    const { client } = await open()

    const r = await callTool(client, 'exec', execArgs())
    expect(r.isError).toBeFalsy()
    expect(textOf(r)).toContain('[Exit code: 255]')
    expect(textOf(r)).not.toContain('ShuviX will not add it')
  })

  it('SSHS-U-114: 255 但认不出的 stderr → 原样加一行退出码，不硬编一个解释', async () => {
    writeConfig('Host web\n')
    control.result = {
      stdout: '',
      stderr: 'kex_exchange_identification: read: Connection reset by peer',
      exitCode: 255,
      timedOut: false
    }
    const { client } = await open()

    const r = await callTool(client, 'exec', execArgs())
    expect(r.isError).toBeFalsy()
    expect(textOf(r)).toBe(
      'kex_exchange_identification: read: Connection reset by peer\n\n[Exit code: 255]'
    )
  })

  it('SSHS-U-115: 超时说「超时」，不说「退出码 124」', async () => {
    writeConfig('Host web\n')
    control.result = { stdout: 'partial', stderr: '', exitCode: 124, timedOut: true }
    const { client } = await open()

    const r = await callTool(client, 'exec', execArgs({ timeout: 45 }))
    expect(textOf(r)).toBe('partial\n\n[Command timed out after 45s]')
    // 124 是本地这一侧编的，报给 agent 只会让它去查一个远端并不存在的退出码
    expect(textOf(r)).not.toContain('[Exit code: 124]')
  })

  it('SSHS-U-116: 输出全空时给一句 `(no output)`', async () => {
    writeConfig('Host web\n')
    const { client } = await open()

    expect(textOf(await callTool(client, 'exec', execArgs()))).toBe('(no output)')
  })

  it('SSHS-U-117: sshExec 自己起不来（没有 ssh 二进制）时，原因原样冒到调用方', async () => {
    writeConfig('Host web\n')
    control.result = new Error(
      'The `ssh` command was not found on this machine. Install OpenSSH and try again.'
    )
    const { client } = await open()

    await expect(client.callTool({ name: 'exec', arguments: execArgs() })).rejects.toThrow(
      /was not found on this machine/
    )
  })
})

describe('ssh 内置服务器 exec 的超时取值', () => {
  const timeoutOf = (i = 0): unknown => control.exec[i].timeoutSec

  it('SSHS-U-118: 缺省 120 秒，给了就用给的', async () => {
    writeConfig('Host web\n')
    const { client } = await open()

    await callTool(client, 'exec', execArgs())
    await callTool(client, 'exec', execArgs({ timeout: 30 }))

    expect([timeoutOf(0), timeoutOf(1)]).toEqual([120, 30])
  })

  it('SSHS-U-119: 离谱的大数被钳到 3600 秒', async () => {
    writeConfig('Host web\n')
    const { client } = await open()

    // 上限不是洁癖：setTimeout 超过 2^31-1 毫秒会被截成 1ms，
    // 于是「我要等很久」反而变成「立刻超时」—— 与模型的意图正好相反
    await callTool(client, 'exec', execArgs({ timeout: 999999999 }))
    expect(timeoutOf()).toBe(3600)

    // 另一端是同一类错误：floor 会把 0.5 变成 0，而 setTimeout(0) 同样立刻就烧
    await callTool(client, 'exec', execArgs({ timeout: 0.5 }))
    expect(timeoutOf(1)).toBe(1)
  })

  it('SSHS-U-120: 零 / 负数 / 不是数 —— 一律回落到 120', async () => {
    writeConfig('Host web\n')
    const { client } = await open()

    for (const timeout of [0, -5, 'abc']) {
      await callTool(client, 'exec', execArgs({ timeout }))
    }
    expect(control.exec.map((c) => c.timeoutSec)).toEqual([120, 120, 120])
  })
})

describe('ssh 内置服务器的中止', () => {
  it('SSHS-U-121: 用户在卡片上取消 → 这次调用以 Aborted 落定，远端一条没跑', async () => {
    writeConfig('Host web\n')
    const { client } = await open({ respond: async () => ({ kind: 'cancel', reason: 'aborted' }) })

    await expect(client.callTool({ name: 'exec', arguments: execArgs() })).rejects.toThrow(
      /Aborted/
    )
    expect(control.exec).toEqual([])
  })

  it('SSHS-U-122: 卡片还挂着时这次调用被取消 → 门放行了也不再跑', async () => {
    writeConfig('Host web\n')
    let release!: (r: InputResponse) => void
    const { client, asks } = await open({
      respond: () => new Promise<InputResponse>((r) => (release = r))
    })

    const ac = new AbortController()
    const pending = client.callTool({ name: 'exec', arguments: execArgs() }, undefined, {
      signal: ac.signal
    })
    // 等卡片真的挂起（门已经在等人答）
    while (asks.length === 0) await new Promise((r) => setTimeout(r, 1))

    ac.abort(new Error('user stopped the run'))
    await expect(pending).rejects.toThrow()

    release({ kind: 'ask', allowed: true })
    await new Promise((r) => setTimeout(r, 5))

    // 这才是可观测的契约：批准来晚了也不会补跑一条远端命令。
    // handleExec 那句 `return err('Aborted')` 本身走不到线上 —— SDK 对已取消的请求
    // 一律不发响应（protocol.ts 的 `if (abortController.signal.aborted) return`）。
    expect(control.exec).toEqual([])
  })
})

describe('ssh 内置服务器的 disconnect 与状态条', () => {
  it('SSHS-U-123: 本来连着 / 本来就没连，两种如实回报', async () => {
    writeConfig('Host web\n')
    const { client } = await open()

    control.wasConnected = true
    expect(textOf(await callTool(client, 'disconnect', { host: 'web' }))).toBe(
      'Closed the connection to "web".'
    )
    control.wasConnected = false
    expect(textOf(await callTool(client, 'disconnect', { host: 'web' }))).toBe(
      'There was no open connection to "web".'
    )
    expect(control.disconnect.map((d) => d.alias)).toEqual(['web', 'web'])
  })

  it('SSHS-U-124: 状态条 = 最后一条**成功**命令的主机；任何 disconnect 都清掉', async () => {
    writeConfig('Host web\n')
    const { client, events } = await open()

    await callTool(client, 'exec', execArgs())
    expect(events).toEqual([
      {
        type: 'runtime_event',
        runtimeId: 'ssh',
        status: { label: 'web', icon: 'Terminal', color: '#38bdf8' }
      }
    ])

    // J11（今天的行为，非缺陷）：非零退出不改状态条 —— 于是它写的是「最后一条跑成了的」，
    // 而不是「现在连着哪台」。连接本身其实还在（ControlPersist）。
    events.length = 0
    control.result = { stdout: 'nope', stderr: '', exitCode: 1, timedOut: false }
    await callTool(client, 'exec', execArgs())
    expect(events).toEqual([])

    // 同样是今天的行为：断开哪一台都把条清空，哪怕本来就没连着
    control.wasConnected = false
    await callTool(client, 'disconnect', { host: 'web' })
    expect(events).toEqual([{ type: 'runtime_event', runtimeId: 'ssh', status: null }])
  })

  it('SSHS-U-125: exec / disconnect 的 annotations 如实声明', async () => {
    writeConfig('Host web\n')
    const { client } = await open()
    const tools = (await client.listTools()).tools

    // 远端命令能做任何事 —— 别因为「多数命令只是看看」就把这两位调软
    expect(tools.find((t) => t.name === 'exec')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true
    })
    // 断开是本地记账：关两次和关一次一个样，也不碰远端
    expect(tools.find((t) => t.name === 'disconnect')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    })
  })

  it('SSHS-U-126: 会话释放只认**现在还在配置里**的别名 —— 今天的已知缺口（J9）', async () => {
    writeConfig('Host web\nHost api\n')
    const { clientTransport } = await open({ sessionId: 's-leak' })

    // 用户在会话期间把 web 从 ~/.ssh/config 里删了（改名、注释掉，都算）
    writeConfig('Host api\n')
    await clientTransport.close()
    await new Promise((r) => setTimeout(r, 5))

    expect(control.closeSession).toHaveLength(1)
    // 候选别名是**现读**配置得来的，而 socket 路径是 sessionId+别名哈希出来的：
    // 名字没了就再也算不回那条路径，那个 socket 于是留在 /tmp 里直到 ControlPersist 到期。
    // 这里钉的是今天的行为，不是它应该如此 —— 修法是把释放建立在会话自己的连接记账上。
    expect(control.closeSession[0]).toEqual({ sessionId: 's-leak', aliases: ['api'] })
  })
})

// ─── 装配期对账 ──────────────────────────────────────────────────────────

describe('内置能力服务器的清单', () => {
  it('SSHS-U-41: 工厂表的键与迁移 v22 种下的行同名（今天恰好只有 ssh）', () => {
    // 两边对不上 = 会话里勾了这台服务器、建连时 registry 抛「No builtin MCP server registered」。
    // 新增一台内置能力服务器 = 工厂表加一行 + 一条种子迁移，这条用例就是那对括号
    const seeded: string[] = []
    const db = {
      prepare: (sql: string) => ({
        run: (): void => {
          const m =
            /INSERT[\s\S]*INTO\s+mcp_servers[\s\S]*VALUES\s*\(\s*\?\s*,\s*'([^']+)'\s*,\s*'inproc'/i.exec(
              sql
            )
          if (m) seeded.push(m[1])
        }
      }),
      exec: (): void => {}
    }

    const v22 = migrations.find((m) => m.version === 22)
    expect(v22, '迁移 v22 应当存在（内置能力服务器的种子）').toBeDefined()
    v22!.up(db as unknown as Parameters<(typeof migrations)[number]['up']>[0])

    expect(seeded).toEqual(['ssh'])
    expect(Object.keys(BUILTIN_MCP_FACTORIES)).toEqual(seeded)
  })
})
