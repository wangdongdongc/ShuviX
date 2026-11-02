/**
 * MCP server 的 env / headers 落库加密 —— 真实例上的整条线（无 LLM）。
 *
 * DAO 的单测（mcpDaoSecrets.test）拿假 BaseDao 钉住了每条规则；这里要证明的是单测替不了的：真的 better-sqlite3
 * 库文件里没有明文、这一版之前写下的旧行**不迁移也照常把凭据交到 server 手上**、解不开时存一次空表单不丢值、
 * 密钥回来后还能连上。凭据送没送到一律从 **server 那一侧**读：HTTP fixture 记下收到的请求头，stdio fixture 把
 * 自己进程里的环境变量写进文件 —— 不看工具的回报，也不把 token 从工具输出里带回来（那会落进 cachedTools）。
 *
 * harness 强制 `SHUVIX_ENCRYPTION=v1`（钥匙串不随假 HOME 隔离），所以这里只见 v1 密文，密钥是
 * `<home>/.shuvix/.session-state`；v2 只在单测里测。
 *
 * 四次启动串成一条线（「停机 → 改库 / 换密钥 → 同一个 HOME 再起」，`stop({ keepHome: true })` + `launchApp({ home })`）：
 *
 *   启动 1  SR-1  新加的 server 落库就是密文：库文件和 -wal 的字节里没有 token，主进程日志里也没有
 *   启动 2  SR-2  种三行旧明文行：列表读到的值完全一样，库里还是种下的字节
 *           SR-3  旧行照常连：http 收到 env 模板展开后的请求头，stdio 子进程拿到环境变量；cachedTools 写了、
 *                 启停切换了，env / headers 的字节都不变
 *           SR-4  真的保存才转：原样存回 → 库里是密文、没有 token，列表不变
 *   启动 3  SR-5  （密钥换成别的）转过的行列出来是 `{}`/`{}`，没转的 keep-plain 还是真值
 *           SR-6  这时存一次空表单：名字改了，密文字节不变
 *   启动 4  SR-8  （密钥换回来）列表是原值 + 新名字，从密文连上，两台 server 都拿到原来的 token
 */
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server as HttpServer
} from 'node:http'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Server as McpSdkServer } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchApp, type E2EApp } from '../../harness/launch'
import { dbPathOf, sqlite, sqliteJson, sqlLit } from '../../harness/seed'

const V1 = '$SHUVIX_ENC$v1$'
const ENC = '$SHUVIX_ENC$'

const HTTP_ID = 'e2e-http-a'
const STDIO_ID = 'e2e-stdio-a'
const PLAIN_ID = 'e2e-keep-plain'
const LEGACY_ENV_TOKEN = 'legacy-env-token'
const LEGACY_HEADER_LITERAL = 'legacy-header-literal'
const LEGACY_STDIO_TOKEN = 'legacy-stdio-token'
const LEGACY_KEEP_TOKEN = 'legacy-keep-token'
const LEGACY_KEEP_HEADER = 'legacy-keep-header'

const HTTP_ENV = JSON.stringify({ E2E_TOKEN: LEGACY_ENV_TOKEN })
const HTTP_HEADERS = JSON.stringify({
  Authorization: 'Bearer {{E2E_TOKEN}}',
  'X-Literal': LEGACY_HEADER_LITERAL
})
const STDIO_ENV = JSON.stringify({ E2E_STDIO_TOKEN: LEGACY_STDIO_TOKEN })
const PLAIN_ENV = JSON.stringify({ KEEP_TOKEN: LEGACY_KEEP_TOKEN })
const PLAIN_HEADERS = JSON.stringify({ 'X-Keep': LEGACY_KEEP_HEADER })

/** mcp_servers 的一行（sqlite3 -json 读出来的原样） */
interface StoredRow {
  id: string
  name: string
  env: string
  headers: string
  cachedTools: string
  isEnabled: number
}

/** `window.api.mcp.list()` 的一行 */
interface ListedRow {
  id: string
  name: string
  env: string
  headers: string
  toolCount: number
  status: string
}

let app: E2EApp | undefined
let home = ''
let fixtureDir = ''
let http: { server: HttpServer; port: number } | undefined
/** HTTP fixture 收到的每一个请求的请求头 */
const seenHeaders: IncomingHttpHeaders[] = []

const keyFile = (): string => join(home, '.shuvix', '.session-state')
const keyBackup = (): string => join(fixtureDir, 'session-state.bak')
const stdioOutFile = (): string => join(fixtureDir, 'stdio-env.txt')
const stdioScript = (): string => join(fixtureDir, 'stdio-server.cjs')

const stored = (id: string): StoredRow => {
  const [row] = sqliteJson<StoredRow>(
    home,
    `SELECT * FROM mcp_servers WHERE id = ${sqlLit(id)} LIMIT 1`
  )
  if (!row) throw new Error(`no stored row ${id}`)
  return row
}

const listed = async (id: string): Promise<ListedRow> => {
  const rows = await app!.main.eval<ListedRow[]>(`window.api.mcp.list()`)
  const row = rows.find((r) => r.id === id)
  if (!row) throw new Error(`no listed row ${id}`)
  return row
}

const mcpUpdate = (params: Record<string, unknown>): Promise<{ success: boolean }> =>
  app!.main.eval(`window.api.mcp.update(${JSON.stringify(params)})`)

const mcpConnect = (id: string): Promise<{ success: boolean; error?: string }> =>
  app!.main.eval(`window.api.mcp.connect(${JSON.stringify(id)})`)

const mcpDisconnect = (id: string): Promise<{ success: boolean }> =>
  app!.main.eval(`window.api.mcp.disconnect(${JSON.stringify(id)})`)

async function stopKeepingHome(): Promise<void> {
  if (!app) return
  await app.stop({ keepHome: true })
  app = undefined
}

async function relaunch(): Promise<void> {
  await stopKeepingHome()
  app = await launchApp({ home })
}

/** 无状态的 MCP HTTP server（同 sessions/mcp-lazy-connect 的写法），只多记一笔收到的请求头 */
function startHttpFixture(): Promise<{ server: HttpServer; port: number }> {
  const server = createServer((req, res) => {
    seenHeaders.push(req.headers)
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      let body: unknown
      try {
        body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined
      } catch {
        body = undefined
      }
      const mcp = new McpSdkServer(
        { name: 'e2e-http', version: '1.0.0' },
        { capabilities: { tools: {} } }
      )
      mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [{ name: 'ping', description: 'ping', inputSchema: { type: 'object' as const } }]
      }))
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      res.on('close', () => {
        void transport.close()
        void mcp.close()
      })
      void mcp
        .connect(transport)
        .then(() => transport.handleRequest(req as IncomingMessage, res, body))
        .catch(() => {
          if (!res.headersSent) {
            res.statusCode = 500
            res.end()
          }
        })
    })
  })
  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      port ? resolve({ server, port }) : reject(new Error('no port'))
    })
  })
}

/**
 * stdio fixture：换行分隔的 JSON-RPC，只答 initialize / tools/list。环境变量里的 token **写进文件**，
 * 不走工具输出（工具描述会进 cachedTools，那样库里就有明文了，和要测的东西打架）。
 */
const STDIO_SERVER = `
const { writeFileSync } = require('node:fs')
writeFileSync(process.argv[2], process.env.E2E_STDIO_TOKEN ?? '')
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  for (let i = buffer.indexOf('\\n'); i >= 0; i = buffer.indexOf('\\n')) {
    const line = buffer.slice(0, i).trim()
    buffer = buffer.slice(i + 1)
    if (!line) continue
    const msg = JSON.parse(line)
    if (msg.id === undefined) continue
    const reply = { jsonrpc: '2.0', id: msg.id }
    if (msg.method === 'initialize') {
      reply.result = {
        protocolVersion: msg.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'e2e-stdio', version: '1.0.0' }
      }
    } else if (msg.method === 'tools/list') {
      reply.result = {
        tools: [{ name: 'ping', description: 'ping', inputSchema: { type: 'object' } }]
      }
    } else {
      reply.error = { code: -32601, message: 'not found' }
    }
    process.stdout.write(JSON.stringify(reply) + '\\n')
  }
})
process.stdin.on('end', () => process.exit(0))
`

/** 这一版之前写下的三行：env / headers 都是明文 */
function seedLegacyRows(): void {
  const now = 1_000
  const rows = [
    {
      id: HTTP_ID,
      name: 'http-a',
      type: 'http',
      command: '',
      args: '[]',
      env: HTTP_ENV,
      url: `http://127.0.0.1:${http!.port}/mcp`,
      headers: HTTP_HEADERS
    },
    {
      id: STDIO_ID,
      name: 'stdio-a',
      type: 'stdio',
      command: process.execPath,
      args: JSON.stringify([stdioScript(), stdioOutFile()]),
      env: STDIO_ENV,
      url: '',
      headers: '{}'
    },
    {
      id: PLAIN_ID,
      name: 'keep-plain',
      type: 'http',
      command: '',
      args: '[]',
      env: PLAIN_ENV,
      // 永远不连它：它只负责从头到尾都不被转成密文
      url: 'http://127.0.0.1:9/keep',
      headers: PLAIN_HEADERS
    }
  ]
  for (const r of rows) {
    const cols = Object.keys(r) as Array<keyof typeof r>
    const values = cols.map((c) => sqlLit(r[c]))
    sqlite(
      home,
      `INSERT INTO mcp_servers (${cols.join(', ')}, isEnabled, cachedTools, createdAt, updatedAt)
       VALUES (${values.join(', ')}, 1, '[]', ${now}, ${now});`
    )
  }
}

/** 从 server 那一侧确认：这次连接把原来的 token 交到了两台 server 手上 */
async function expectDelivered(): Promise<void> {
  seenHeaders.length = 0
  rmSync(stdioOutFile(), { force: true })

  expect(await mcpConnect(HTTP_ID)).toMatchObject({ success: true })
  expect(await mcpConnect(STDIO_ID)).toMatchObject({ success: true })

  expect(seenHeaders.length).toBeGreaterThan(0)
  for (const headers of seenHeaders) {
    expect(headers.authorization).toBe(`Bearer ${LEGACY_ENV_TOKEN}`)
    expect(headers['x-literal']).toBe(LEGACY_HEADER_LITERAL)
  }
  expect(readFileSync(stdioOutFile(), 'utf8')).toBe(LEGACY_STDIO_TOKEN)

  expect((await listed(HTTP_ID)).toolCount).toBeGreaterThan(0)
  expect((await listed(STDIO_ID)).toolCount).toBeGreaterThan(0)
}

beforeAll(async () => {
  fixtureDir = mkdtempSync(join(tmpdir(), 'shuvix-e2e-mcp-secrets-'))
  writeFileSync(stdioScript(), STDIO_SERVER)
  http = await startHttpFixture()
  app = await launchApp()
  home = app.home
})

afterAll(async () => {
  // 不带 keepHome：HOME 由这最后一个 stop 收走；前面失败到实例已停的话手动收
  if (app) await app.stop()
  else if (home) rmSync(home, { recursive: true, force: true })
  if (http) {
    http.server.closeAllConnections()
    await new Promise<void>((resolve) => http!.server.close(() => resolve()))
  }
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true })
})

describe('启动 1：新加的 server', () => {
  it('SR-1 落库就是密文：库文件和 -wal 里没有 token，主进程日志里也没有', async () => {
    const envToken = `sr1-env-${randomBytes(8).toString('hex')}`
    const headerToken = `sr1-header-${randomBytes(8).toString('hex')}`
    const name = 'sr1-new-server'
    const env = { TOKEN: envToken }
    const headers = { Authorization: `Bearer ${headerToken}` }

    const added = await app!.main.eval<{ success: boolean; id: string }>(
      `window.api.mcp.add(${JSON.stringify({
        name,
        type: 'http',
        url: 'http://127.0.0.1:9/sr1',
        env,
        headers
      })})`
    )
    expect(added.success).toBe(true)

    const row = stored(added.id)
    expect(row.env.startsWith(V1)).toBe(true)
    expect(row.headers.startsWith(V1)).toBe(true)
    expect(JSON.stringify(row)).not.toContain(envToken)
    expect(JSON.stringify(row)).not.toContain(headerToken)
    // 经 IPC 读到的还是明文 JSON
    const shown = await listed(added.id)
    expect(shown.env).toBe(JSON.stringify(env))
    expect(shown.headers).toBe(JSON.stringify(headers))

    const log = app!.mainLog()
    expect(log).not.toContain(envToken)
    expect(log).not.toContain(headerToken)
    expect(log).not.toContain(ENC)

    await stopKeepingHome()

    const files = [dbPathOf(home), `${dbPathOf(home)}-wal`].filter((f) => existsSync(f))
    const bytes = Buffer.concat(files.map((f) => readFileSync(f)))
    // 对照：读的确实是这个库 —— server 的名字在里面
    expect(bytes.includes(name)).toBe(true)
    expect(bytes.includes(envToken)).toBe(false)
    expect(bytes.includes(headerToken)).toBe(false)
  })
})

describe('启动 2：这一版之前写下的旧行', () => {
  it('SR-2 列表读到的值和种下的完全一样，库里还是种下的字节', async () => {
    await stopKeepingHome()
    seedLegacyRows()
    await relaunch()

    expect(await listed(HTTP_ID)).toMatchObject({ env: HTTP_ENV, headers: HTTP_HEADERS })
    expect(await listed(STDIO_ID)).toMatchObject({ env: STDIO_ENV, headers: '{}' })
    expect(await listed(PLAIN_ID)).toMatchObject({ env: PLAIN_ENV, headers: PLAIN_HEADERS })

    expect(stored(HTTP_ID)).toMatchObject({ env: HTTP_ENV, headers: HTTP_HEADERS })
    expect(stored(STDIO_ID)).toMatchObject({ env: STDIO_ENV, headers: '{}' })
    expect(stored(PLAIN_ID)).toMatchObject({ env: PLAIN_ENV, headers: PLAIN_HEADERS })
  })

  it('SR-3 旧行照常把凭据交给 server；cachedTools 写了、启停切换了，env / headers 的字节都不变', async () => {
    await expectDelivered()

    for (const [id, env, headers] of [
      [HTTP_ID, HTTP_ENV, HTTP_HEADERS],
      [STDIO_ID, STDIO_ENV, '{}']
    ]) {
      const afterConnect = stored(id)
      expect(afterConnect.cachedTools).toContain('ping')
      expect(afterConnect).toMatchObject({ env, headers })

      expect(await mcpUpdate({ id, isEnabled: false })).toEqual({ success: true })
      expect(stored(id)).toMatchObject({ isEnabled: 0, env, headers })
      expect(await mcpUpdate({ id, isEnabled: true })).toEqual({ success: true })
      expect(stored(id)).toMatchObject({ isEnabled: 1, env, headers })
    }

    await mcpDisconnect(HTTP_ID)
    await mcpDisconnect(STDIO_ID)
  })

  it('SR-4 真的保存才转成密文：原样存回去，库里没有 token，列表不变', async () => {
    expect(
      await mcpUpdate({
        id: HTTP_ID,
        env: JSON.parse(HTTP_ENV),
        headers: JSON.parse(HTTP_HEADERS)
      })
    ).toEqual({ success: true })
    expect(await mcpUpdate({ id: STDIO_ID, env: JSON.parse(STDIO_ENV), headers: {} })).toEqual({
      success: true
    })

    const httpRow = stored(HTTP_ID)
    expect(httpRow.env.startsWith(V1)).toBe(true)
    expect(httpRow.headers.startsWith(V1)).toBe(true)
    expect(JSON.stringify(httpRow)).not.toContain(LEGACY_ENV_TOKEN)
    expect(JSON.stringify(httpRow)).not.toContain(LEGACY_HEADER_LITERAL)

    const stdioRow = stored(STDIO_ID)
    expect(stdioRow.env.startsWith(V1)).toBe(true)
    expect(stdioRow.headers).toBe('{}')
    expect(JSON.stringify(stdioRow)).not.toContain(LEGACY_STDIO_TOKEN)

    expect(await listed(HTTP_ID)).toMatchObject({ env: HTTP_ENV, headers: HTTP_HEADERS })
    expect(await listed(STDIO_ID)).toMatchObject({ env: STDIO_ENV, headers: '{}' })
    // 没保存过的那一行还是明文
    expect(stored(PLAIN_ID)).toMatchObject({ env: PLAIN_ENV, headers: PLAIN_HEADERS })
  })
})

describe('启动 3：密钥换成了别的（解不开）', () => {
  it('SR-5 转过的行列出来是 `{}`/`{}`，没转的 keep-plain 还是真值', async () => {
    await stopKeepingHome()
    copyFileSync(keyFile(), keyBackup())
    writeFileSync(keyFile(), randomBytes(32), { mode: 0o600 })
    await relaunch()

    expect(await listed(HTTP_ID)).toMatchObject({ env: '{}', headers: '{}' })
    expect(await listed(STDIO_ID)).toMatchObject({ env: '{}', headers: '{}' })
    expect(await listed(PLAIN_ID)).toMatchObject({ env: PLAIN_ENV, headers: PLAIN_HEADERS })
  })

  it('SR-6 这时存一次空表单：名字改了，密文字节不变', async () => {
    const httpBefore = stored(HTTP_ID)
    const stdioBefore = stored(STDIO_ID)
    expect(httpBefore.env.startsWith(V1)).toBe(true)

    expect(await mcpUpdate({ id: HTTP_ID, name: 'http-a-renamed', env: {}, headers: {} })).toEqual({
      success: true
    })
    expect(await mcpUpdate({ id: STDIO_ID, env: {}, headers: {} })).toEqual({ success: true })

    expect(stored(HTTP_ID)).toMatchObject({
      name: 'http-a-renamed',
      env: httpBefore.env,
      headers: httpBefore.headers
    })
    expect(stored(STDIO_ID)).toMatchObject({ env: stdioBefore.env, headers: stdioBefore.headers })
  })
})

describe('启动 4：密钥换回来', () => {
  it('SR-8 列表是原值 + 新名字；从密文连上，两台 server 都拿到原来的 token', async () => {
    await stopKeepingHome()
    copyFileSync(keyBackup(), keyFile())
    await relaunch()

    expect(await listed(HTTP_ID)).toMatchObject({
      name: 'http-a-renamed',
      env: HTTP_ENV,
      headers: HTTP_HEADERS
    })
    expect(await listed(STDIO_ID)).toMatchObject({ env: STDIO_ENV, headers: '{}' })
    expect(stored(HTTP_ID).env.startsWith(V1)).toBe(true)
    expect(stored(HTTP_ID).headers.startsWith(V1)).toBe(true)
    expect(stored(STDIO_ID).env.startsWith(V1)).toBe(true)

    await expectDelivered()

    await mcpDisconnect(HTTP_ID)
    await mcpDisconnect(STDIO_ID)
  })
})
