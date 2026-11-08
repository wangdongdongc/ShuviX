/**
 * `shuvix` 工具改 ShuviX 自己的设置（docs/mcp-config-compat-design.md）：agent 经设置页同一套通道加 MCP 服务器，
 * 秘密值由用户在审批卡上填，**不进对话、不进模型、不落进会话记录**。真实例 + 假模型 + 真渲染：卡片经真 UI 答，
 * 值经 CDP 可信输入打进卡上的输入框。凭据送没送到从服务器那一侧读 —— stdio 夹具在 token 不对时直接退出，
 * 每次启动都往旁边的 starts.log 记一行，不信工具自己的回报。
 *
 *   SX-1  describe：结果里列着 mcp:add（改东西、要问）与 mcp:list（只读）
 *   SX-2  mcp:add 一台本地 stdio 服务器，env TOKEN 留空：卡上是设置行 + 一个打码的输入框；没填时允许那一行灰着、
 *         点了没用；经真 UI 打进 token 再批准 → 设置里有这一行、env 是那个值；工具结果说连上了、列出工具；
 *         token 不在会话存储、message.list、任何一次模型请求、主进程日志、答完之后的页面里
 *   SX-3  拒绝：工具结果说用户拒绝了；设置里没有这一行，夹具一次都没被启动
 *   SX-4  mcp:list：不出卡；env 只写 {TOKEN: 'set'}，从不给值
 *
 * 会话都不带项目（chat 基座，档案里有 `shuvix`）、标题不是缺省标题（不跑自动标题）。发送走 UI（卡片要摆在这条会话
 * 的对话流里）；请求按 `lastUserText` 认领。自动审查在 harness 里是关的，`ask-on-settings` 的 admin 改动本来也只由人答。
 * SX-4 读的是 SX-2 加下的那一行，用例之间有先后。
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sleep, until } from '../../harness/cdp'
import {
  startFakeProvider,
  toolTextsOf,
  type FakeProvider,
  type FakeRequest,
  type FakeTurn
} from '../../harness/fakeProvider'
import { launchApp, type E2EApp } from '../../harness/launch'
import {
  chatPane,
  settingsAskPane,
  sidebarPane,
  type ChatPane,
  type SettingsAskPane,
  type SettingsAskShot,
  type SidebarPane
} from '../../harness/pages'
import {
  durableStoragePathOf,
  eventRecorder,
  securityDecisions,
  seedFakeProvider,
  waitRendererReady,
  type EventRecorder
} from '../../harness/seed'

const MODEL = 'e2e-model'
const USAGE = { prompt: 90, completion: 4 }

/** 用户在卡上打的那个 token：拼出来的，每次不同 —— 只要它出现在不该出现的地方就是泄漏 */
const SECRET = `sx-e2e-${randomBytes(9).toString('hex')}`
const ADDED = 'e2e-token'
const DENIED = 'e2e-denied'

/** 卡上的字（实例的界面语言在 beforeAll 里钉成英文） */
const CARD = {
  head: 'Change ShuviX settings',
  addTitle: (name: string): string => `Add MCP server “${name}” to your settings`,
  missing: 'Fill in the field above first'
}

interface ListedServer {
  id: string
  name: string
  type: string
  command: string
  args: string
  env: string
}

let app: E2EApp
let provider: FakeProvider
let recorder: EventRecorder
let chat: ChatPane
let sidebar: SidebarPane
let settings: SettingsAskPane
let fixtureDir: string
let serverScript: string
let callSeq = 0

// ─── stdio 夹具 ───

/**
 * SDK 的 ESM 入口（绝对路径）：夹具脚本在隔离 HOME 里跑，那里没有 node_modules。按包的 exports 解析出 cjs 路径，
 * 再换成并排的 esm —— 夹具是 .mjs，用 ESM 版本免得赌 cjs 的具名导出能不能被认出来
 */
function sdkUrl(subpath: string): string {
  const cjs = createRequire(import.meta.url).resolve(`@modelcontextprotocol/sdk/${subpath}`)
  return pathToFileURL(cjs.replace(/\/dist\/cjs\//, '/dist/esm/')).href
}

/**
 * 只认 TOKEN 的 stdio 服务器：每次启动先在 starts.log 记下第一个参数（「有没有被启动过」从这里读），token 不对就往
 * stderr 说一句、退出；对了才握手、报一个工具。期望的值写死在脚本里 —— 脚本不在对话里，模型也看不到它
 */
function writeServerScript(dir: string): string {
  const file = join(dir, 'token-server.mjs')
  writeFileSync(
    file,
    [
      `import { appendFileSync } from 'node:fs'`,
      `import { Server } from ${JSON.stringify(sdkUrl('server/index.js'))}`,
      `import { StdioServerTransport } from ${JSON.stringify(sdkUrl('server/stdio.js'))}`,
      `import { ListToolsRequestSchema } from ${JSON.stringify(sdkUrl('types.js'))}`,
      `appendFileSync(new URL('./starts.log', import.meta.url), (process.argv[2] ?? '') + '\\n')`,
      `if (process.env.TOKEN !== ${JSON.stringify(SECRET)}) {`,
      `  process.stderr.write('TOKEN is missing or wrong\\n')`,
      `  process.exit(1)`,
      `}`,
      `const server = new Server({ name: 'token-server', version: '1.0.0' }, { capabilities: { tools: {} } })`,
      `server.setRequestHandler(ListToolsRequestSchema, async () => ({`,
      `  tools: [{ name: 'whoami', description: 'Says who you are', inputSchema: { type: 'object' } }]`,
      `}))`,
      `await server.connect(new StdioServerTransport())`,
      ''
    ].join('\n')
  )
  return file
}

/** 夹具被启动过的记录（第一个参数，一次一行） */
const starts = (): string[] => {
  try {
    return readFileSync(join(fixtureDir, 'starts.log'), 'utf8').split('\n').filter(Boolean)
  } catch {
    return []
  }
}

// ─── IPC 与存储 ───

const listServers = (): Promise<ListedServer[]> =>
  app.main.eval<ListedServer[]>(`window.api.mcp.list()`)

const serverNamed = async (name: string): Promise<ListedServer | undefined> =>
  (await listServers()).find((server) => server.name === name)

const listedText = async (sid: string): Promise<string> =>
  JSON.stringify(await app.main.eval<unknown>(`window.api.message.list(${JSON.stringify(sid)})`))

/** 会话存储（durable sqlite + WAL）里有没有这段文字：按字节找，不经产品代码（同 chat-ask-inline） */
const storeContains = (sid: string, needle: string): boolean => {
  const base = durableStoragePathOf(app.home, sid)
  return ['', '-wal', '-shm'].some((suffix) => {
    try {
      return readFileSync(base + suffix).includes(needle)
    } catch {
      return false
    }
  })
}

/** 建一条不带项目的会话并打开它（标题不是缺省标题：不跑自动标题） */
async function openChat(title: string): Promise<string> {
  const sid = await app.main.eval<string>(
    `window.api.session.create(${JSON.stringify({ title })}).then((s) => s.id)`
  )
  await until(async () => (await sidebar.titles()).includes(title), `sidebar row "${title}"`)
  expect(await sidebar.openSession(title)).toBe(true)
  await chat.ready()
  return sid
}

// ─── 脚本与请求 ───

const forPrompt =
  (text: string) =>
  (req: FakeRequest): boolean =>
    req.lastUserText === text

const shuvixTurn = (text: string, params: Record<string, unknown>): FakeTurn => ({
  when: forPrompt(text),
  toolCalls: [{ id: `call_shuvix_${++callSeq}`, name: 'shuvix', args: JSON.stringify(params) }],
  usage: USAGE
})

const answerTurn = (text: string): FakeTurn => ({
  when: forPrompt(text),
  text: 'done',
  usage: USAGE
})

/** agent 照着 README 翻出来的那一台：TOKEN 留空，等用户在卡上填 */
const addArgs = (name: string): Record<string, unknown> => ({
  name,
  type: 'stdio',
  command: process.execPath,
  args: [serverScript, name],
  env: { TOKEN: '' }
})

const requestsFor = (text: string): FakeRequest[] =>
  provider.chatRequests().filter((req) => req.lastUserText === text)

/** 等第 n 次请求发出（n 从 1 数）：它只有在上一个工具调用落定之后才发 */
const waitRequests = (text: string, n: number): Promise<FakeRequest[]> =>
  until(() => {
    const requests = requestsFor(text)
    return requests.length >= n ? requests : null
  }, `request ${n} for "${text}"`)

const waitSettingsCard = (): Promise<SettingsAskShot> =>
  until(() => settings.shot(), 'settings ask card')

/** 发一句；回发送前的事件游标 */
async function send(text: string): Promise<number> {
  const since = await recorder.mark()
  await chat.typeAndSend(text)
  return since
}

async function turnEnd(sid: string, since: number): Promise<void> {
  await recorder.waitFor('agent_end', { sessionId: sid, since, timeoutMs: 60_000 })
  await chat.waitIdle()
}

beforeAll(async () => {
  app = await launchApp()
  await waitRendererReady(app.main)
  await app.main.eval(`window.api.settings.set({ key: 'general.language', value: 'en' })`)
  provider = await startFakeProvider()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  recorder = eventRecorder(app.main)
  await recorder.install()
  chat = chatPane(app.main)
  sidebar = sidebarPane(app.main)
  settings = settingsAskPane(app.main)

  fixtureDir = join(app.home, 'mcp-fixture')
  mkdirSync(fixtureDir, { recursive: true })
  serverScript = writeServerScript(fixtureDir)
  appendFileSync(join(fixtureDir, 'starts.log'), '')
}, 120_000)

afterAll(async () => {
  await provider?.close()
  await app?.stop()
})

// ─── 用例 ───

describe('shuvix 工具：agent 加 MCP 服务器，秘密由用户在卡上填', () => {
  it('SX-1 + SX-2 describe 列出 mcp:add；加一台 stdio：卡上填 token、批准，连上了，token 哪儿都不在', async () => {
    const TEXT = 'SX-2 add the token server from its README'
    const sid = await openChat('SX-2 add a server')
    provider.reset()
    provider.script(
      shuvixTurn(TEXT, { action: 'describe' }),
      shuvixTurn(TEXT, { action: 'call', channel: 'mcp:add', args: addArgs(ADDED) }),
      answerTurn(TEXT)
    )

    const since = await send(TEXT)

    // SX-1：describe 的结果（第二次请求里的工具结果）列着能用的通道，读和改分得清
    const [, second] = await waitRequests(TEXT, 2)
    const described = toolTextsOf(second).at(-1)!
    expect(described).toContain('- mcp:add (change, asks the user)')
    expect(described).toContain('- mcp:list (read)')

    // 卡：顶行是「改设置」，预览是宿主写的行；值从不上卡，只写「你来填」
    const card = await waitSettingsCard()
    const head = await chat.pendingAskShot()
    expect(head?.title).toBe(CARD.head)
    expect(head?.icon).toBe('lucide-settings')
    expect(card.channel).toBe('mcp:add')
    expect(card.title).toBe(CARD.addTitle(ADDED))
    expect(card.rows).toEqual([
      { label: 'Name', value: ADDED },
      { label: 'Command', value: `${process.execPath} ${serverScript} ${ADDED}` },
      { label: 'Environment', value: 'TOKEN (you fill in)' }
    ])
    expect(card.fields).toEqual([
      { key: 'env.TOKEN', label: 'TOKEN', type: 'password', optional: false }
    ])
    // 角标是出厂策略的显示名（随界面语言变）
    expect(card.policy).toBe('Ask Before the Agent Changes Settings')

    // 没填：允许那一行灰着、说明为什么；点了没用 —— 卡还在，第三次请求没发，设置里也还没有它
    expect(card.allowDisabled).toBe(true)
    expect(card.allowDetail).toBe(CARD.missing)
    await chat.answerPendingAsk('allow')
    await sleep(500)
    expect(await settings.shot()).not.toBeNull()
    expect(requestsFor(TEXT)).toHaveLength(2)
    expect(await serverNamed(ADDED)).toBeUndefined()
    expect(starts()).toEqual([])

    // 经真 UI 打进去：允许亮了。输入框不受控 —— 值只在元素的 value 里，不在 DOM 的序列化里
    await settings.typeField('env.TOKEN', SECRET)
    const filled = await until(async () => {
      const shot = await settings.shot()
      return shot && !shot.allowDisabled ? shot : null
    }, 'allow enabled after typing')
    expect(filled.allowDetail).toBe('')
    expect(await settings.pageContains(SECRET)).toBe(true)
    expect(
      await app.main.eval<boolean>(
        `document.documentElement.outerHTML.includes(${JSON.stringify(SECRET)})`
      )
    ).toBe(false)

    await chat.answerPendingAsk('allow')
    await turnEnd(sid, since)

    // 设置里有这一行，env 是用户打的那个值（mcp.list 是设置页那条通道，值解密后原样回）
    const row = await serverNamed(ADDED)
    expect(row).toBeDefined()
    expect(row!.type).toBe('stdio')
    expect(JSON.parse(row!.env)).toEqual({ TOKEN: SECRET })
    // 服务器那一侧：带着对的 token 启动过（token 不对它会直接退出，连不上）
    expect(starts()).toContain(ADDED)

    // 工具结果：连上了，报回它的工具
    const third = requestsFor(TEXT)[2]
    expect(third).toBeDefined()
    const receipt = JSON.parse(toolTextsOf(third).at(-1)!) as {
      added?: string
      connected?: boolean
      tools?: string[]
    }
    expect(receipt.added).toBe(ADDED)
    expect(receipt.connected).toBe(true)
    expect(receipt.tools).toEqual(['whoami'])

    // token 哪儿都不在：会话存储（按字节）、message.list、发给模型的每一次请求、主进程日志、答完之后的页面
    expect(storeContains(sid, SECRET)).toBe(false)
    expect(await listedText(sid)).not.toContain(SECRET)
    for (const req of provider.requests()) expect(req.raw).not.toContain(SECRET)
    expect(app.mainLog()).not.toContain(SECRET)
    expect(await settings.shot()).toBeNull()
    expect(await settings.pageContains(SECRET)).toBe(false)
  })

  it('SX-3 拒绝：工具结果说用户拒绝了；设置里没有它，夹具没被启动', async () => {
    const TEXT = 'SX-3 add another server'
    const sid = await openChat('SX-3 deny the change')
    provider.reset()
    provider.script(
      shuvixTurn(TEXT, { action: 'call', channel: 'mcp:add', args: addArgs(DENIED) }),
      answerTurn(TEXT)
    )

    const since = await send(TEXT)
    const card = await waitSettingsCard()
    expect(card.title).toBe(CARD.addTitle(DENIED))
    // 拒绝不用先填：拒绝那一行不灰
    await chat.answerPendingAsk('deny')
    await turnEnd(sid, since)

    const [, second] = requestsFor(TEXT)
    expect(second).toBeDefined()
    const denied = toolTextsOf(second).at(-1)!
    expect(denied).toContain('User denied this change')
    expect(denied).toContain('mcp:add')
    expect(await serverNamed(DENIED)).toBeUndefined()
    expect(starts()).not.toContain(DENIED)
  })

  it('SX-4 mcp:list：不出卡；env 只说有没有值', async () => {
    const TEXT = 'SX-4 which MCP servers do I have'
    const sid = await openChat('SX-4 list servers')
    provider.reset()
    provider.script(
      shuvixTurn(TEXT, { action: 'call', channel: 'mcp:list', args: {} }),
      answerTurn(TEXT)
    )

    const decisionsBefore = securityDecisions(app).length
    const since = await send(TEXT)
    // 第二次请求发得出来，就是这次调用没停在卡上
    const [, second] = await waitRequests(TEXT, 2)
    await turnEnd(sid, since)
    expect(await chat.pendingAskShot()).toBeNull()
    const asked = securityDecisions(app)
      .slice(decisionsBefore)
      .filter((decision) => decision.sessionId === sid && decision.effect === 'ask')
    expect(asked).toEqual([])

    const listed = toolTextsOf(second).at(-1)!
    expect(listed).not.toContain(SECRET)
    const servers = JSON.parse(listed) as Array<{ name: string; env?: Record<string, string> }>
    const mine = servers.find((server) => server.name === ADDED)
    expect(mine).toBeDefined()
    expect(mine!.env).toEqual({ TOKEN: 'set' })
    for (const req of provider.requests()) expect(req.raw).not.toContain(SECRET)
    expect(storeContains(sid, SECRET)).toBe(false)
  })
})
