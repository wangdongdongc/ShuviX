/**
 * 内置能力服务器 `ssh` —— 隔着**真的 MCP 协议**看它。
 *
 * 用 `InMemoryTransport.createLinkedPair()` + SDK 的 `Client` 驱动，而不是直接调处理函数：
 * 这台 server 的产出全都要过一遍协议层（工具声明、`structuredContent` 对 outputSchema 的校验、
 * 未知工具的错误形态、断开的传播），绕过协议就等于把要测的那一层测没了。
 *
 * 钉的是三件事：
 *   85…87  **工具面**：只有一个只读工具，无参（显式空对象），annotations 如实声明 ——
 *          模型据此判断「这是不是一个可以随便调的工具」；
 *   88…94  **产出**：文本与 structuredContent 两份、空配置不是错误、人读行的格式、
 *          上限截断要**说出来**、以及每次调用现读配置（用户可能刚改过 ~/.ssh/config）；
 *   95…97  **边界**：未知工具是一条普通的错误结果而不是断连、枚举**绝不起进程**
 *          （`ssh -G` 会执行 `Match exec` 里的 shell 命令）、客户端断开会传到 server 侧的
 *          释放钩子上（本轮没有要释放的东西，但 exec 的 control socket 就挂在那里）。
 *
 * 另有一条装配期的对账：内置工厂表的键必须与迁移种下的那一行同名 —— 两边一旦对不上，
 * 会话里那台服务器会在建连的一瞬间抛「没注册」。
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'

// mock 路径按**测试文件**解析：被测模块在 services/builtinMcp/，测试在其 __tests__/ 下
const logged = vi.hoisted(() => ({ lines: [] as string[] }))
// toolContext / paths 会拉起 Electron app 与整个 service 图 —— 照 tools/__tests__ 与
// wrapToolOutput.test.ts 的惯例在测试里挡掉（生产代码直连真安全模块，见 sshServer 的注）
vi.mock('../../toolContext', () => ({
  TOOL_ABORTED: 'Aborted',
  getDesktopSecurityContext: () => ({
    enforceCommand: async () => ({ status: 'allowed' })
  })
}))
vi.mock('../../../utils/paths', () => ({ buildSpawnEnv: () => ({}) }))
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

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'shuvix-sshsrv-'))
  roots.push(root)
  sshDir = join(root, '.ssh')
  mkdirSync(sshDir, { recursive: true })
  configPath = join(sshDir, 'config')
  logged.lines.length = 0
  cp.calls.length = 0
})

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

interface Session {
  client: Client
  clientTransport: Transport
}

/** 把一台 ssh server 接到一对真 InMemoryTransport 上，并连一个真 Client */
async function open(sessionId = 's1'): Promise<Session> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await createSshMcpServerFactory({ configPath })({ sessionId }, serverTransport)
  const client = new Client({ name: 'test', version: '0.0.0' })
  await client.connect(clientTransport)
  return { client, clientTransport }
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
    const { clientTransport } = await open('s-close')
    expect(logged.lines.some((l) => l.includes('ssh server ready session=s-close'))).toBe(true)

    await clientTransport.close()

    // 「会话结束 → McpManager 关连接 → 这里释放」只有这一条路径：本轮没有要释放的东西，
    // 但钩子必须真的被调到，否则 exec 的 control socket 将来会静默泄漏
    expect(logged.lines.some((l) => l.includes('ssh server closed session=s-close'))).toBe(true)
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
