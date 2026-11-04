/**
 * 组件的 MCP 服务器（`widgetMcpServer.ts`）—— 每个有 API 的组件一台 `widget-<id>`，隔着**真的 MCP 协议**看它
 * （InMemoryTransport + SDK 的 Client，同 databaseServer.test）。
 *
 * 门后面是**真的**安全模块（出厂的 ask-on-widget-access 与真 enforceWidget），快照与分发器也是真的（数据根指到临时目录），
 * 只有组件宿主（handler 真正跑的地方）是替身 —— 「勾上算读的同意、写另外问」这件事要真的经过策略才算数。
 *
 *   行（widgetServerRows）
 *     WM-R1 活跃、有 API、至少一个能声明的操作 → 一行：inproc、启用、isBuiltin 1、cachedTools 与 tools/list 同形
 *     WM-R2 没有行：老组件、没有快照、只有纯界面的操作、只有声明不合格的操作
 *     WM-R3 5 秒内不重算；invalidate 或 5 秒之后重算
 *     WM-R4 列组件抛错 → 空表 + warn，不抛
 *   工具面（tools/list）
 *     WM-L1 操作名就是工具名；纯界面的不在；$schema 去掉、根是 object、没有 outputSchema；四个 annotations 都写、读写各对
 *     WM-L2 老快照里声明不合格的操作跳过（各 warn 一条），其余的照样在，真 Client 的校验不抛
 *     WM-L3 每次现读：快照换了，同一条连接再列就是新的
 *   调用（tools/call）
 *     WM-C1 读 + 勾着 + 没有行 → 不问，进分发器，调用方是 agent
 *     WM-C2 写 + 勾着 → 问（读写卡）；允许一次 → 跑；下一次写照问
 *     WM-C3 允许并记住 → 记读写行；之后读写都不问
 *     WM-C4 读 + 没勾（档案声明的不算同意）→ 问
 *     WM-C5 读 + 取消记号 → 问；两个记号同时在 → 问（取消赢）
 *     WM-C6 勾的是前缀相同的另一个组件 → 问
 *     WM-C7 勾选缺失 / null → 问；读勾选抛错 → 失败结果，不问不跑（fail closed）
 *     WM-C8 勾选在调用时现读：连上之后取消了就问，连上之后才勾的就不问
 *     WM-C9 拒绝 → 失败结果，不跑、不记；卡片挂着时放弃 → 之后放行也不跑
 *     WM-C10 客体恰是 {widgetId, name, operation, selected}：参数和 `_meta` 里的 selected 动不了它
 *     WM-C11 门的入参：toolCallId 来自 `_meta`（没有就兜底）、完整工具名、operation=call、归属、signal
 *     WM-C12 派生 agent 调：门的主体与写入的 actor 都是它
 *     WM-C13 归档了 / 删了：失败结果，不问
 *     WM-C14 没有的操作 / 纯界面的操作：失败结果列出看得见的，不问
 *     WM-C15 卡片挂着时被重新构建成写：changed，不跑
 *     WM-C16 真调用不回滚（没有回滚的说明，dryRun false）；没给 arguments → {}
 *     WM-C17 失败的文字（invalid_args 附 schema、ctx.fail、handler 抛错）；操作失败也算用过
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { InputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import type { OpManifest } from '../../widget/api/sandboxRuntime'

const h = vi.hoisted(() => ({
  dataRoot: '',
  /** 组件行（按 id）：archivedAt 非 0 = 归档了；listActive 只列没归档的 */
  widgets: new Map<string, Record<string, unknown>>(),
  /** 会话的勾选（pickSettings 的结果）；'throw' = 读的时候抛错 */
  selections: new Map<string, unknown>(),
  /** 会话权限表的组件行：read 含 write */
  aclRead: [] as string[],
  aclWrite: [] as string[],
  granted: [] as Array<{ mode: string; id: string }>,
  warns: [] as string[],
  gate: [] as Array<{ access: string; object: unknown; opts: Record<string, unknown> }>,
  subjects: [] as unknown[],
  runtime: {
    call: vi.fn(),
    forget: vi.fn(async () => {}),
    manifest: vi.fn(),
    query: vi.fn()
  },
  noteWidgetUse: vi.fn(),
  listActiveThrows: false,
  listActiveCalls: 0
}))

vi.mock('../../widget/api/widgetRuntime', () => ({
  widgetRuntime: h.runtime,
  WidgetRuntimeError: class extends Error {}
}))
vi.mock('../../bundler', () => ({ bundlerService: {} }))
vi.mock('../../../utils/paths', () => ({ getWidgetsDataDir: () => h.dataRoot }))
vi.mock('../../../logger', () => ({
  createLogger: () => ({
    info: () => {},
    warn: (m: string) => void h.warns.push(m),
    error: () => {},
    debug: () => {}
  })
}))
vi.mock('../../sessionRecords', () => ({
  sessionRecords: {
    pickSettings: (sessionId: string) => {
      const selection = h.selections.get(sessionId)
      if (selection === 'throw') throw new Error('malformed JSON')
      return h.selections.has(sessionId) ? { enabledTools: selection } : undefined
    }
  }
}))
vi.mock('../../widget/noteUse', () => ({ noteWidgetUse: h.noteWidgetUse }))
vi.mock('../../widget', async () => ({
  ...(await vi.importActual<object>('../../widget/api/widgetApi')),
  ...(await vi.importActual<object>('../../widget/agentCall')),
  widgetService: {
    getById: (id: string) => h.widgets.get(id),
    listActive: () => {
      h.listActiveCalls++
      if (h.listActiveThrows) throw new Error('scan failed')
      return [...h.widgets.values()].filter((w) => !w.archivedAt)
    }
  }
}))
// 门：真的 enforceWidget（出厂策略），入参抄一份；主体按这次调用的 conversationId 现认，同生产的 forCall
vi.mock('../../toolContext', async () => {
  const { createSecurityContext } = await import('@shuvix/agent-runtime')
  const { withCallAgent } = await import('../../toolAgent')
  const { createInlinePolicyMdReader } =
    await import('@shuvix/agent-runtime/security/builtinPolicies/inlineSources')
  const readBuiltinPolicyMd = createInlinePolicyMdReader()
  return {
    TOOL_ABORTED: 'Aborted',
    assertWidgetAccess: async (
      ctx: Parameters<typeof withCallAgent>[0] & {
        sessionId: string
        requestUserInput?: (request: InputRequest) => Promise<InputResponse>
      },
      access: 'read' | 'write',
      object: never,
      opts: Record<string, unknown> & { owner?: { conversationId?: number; taskId?: number } }
    ): Promise<void> => {
      h.gate.push({ access, object, opts })
      const agent = withCallAgent(ctx, opts.owner).agent
      const subject = {
        kind: 'agent' as const,
        sessionId: ctx.sessionId,
        agentKind: agent?.kind ?? ('root' as const),
        ...(agent?.profileName ? { profileName: agent.profileName } : {})
      }
      h.subjects.push(subject)
      const security = createSecurityContext(
        subject,
        { host: 'desktop', platform: process.platform, workspaceDir: '/ws' },
        {
          host: 'desktop',
          pathSep: '/',
          getVars: () => ({
            workspace: '/ws',
            toolResultsBase: '/tool-results',
            skillsDirs: [],
            knowledgeRoot: '/kb',
            knowledgeSessionDirs: [],
            home: '/home/u',
            botsDir: '/home/u/.shuvix/bots',
            builtinKnowledgeDir: '/opt/knowledge',
            systemDirs: [],
            aclWidgetRead: [...new Set([...h.aclRead, ...h.aclWrite])],
            aclWidgetWrite: [...h.aclWrite]
          }),
          readBuiltinPolicyMd,
          getUserPolicies: () => [],
          requestUserInput: ctx.requestUserInput,
          persistWidgetGrant: (mode: string, id: string) => {
            h.granted.push({ mode, id })
            if (mode === 'write') h.aclWrite.push(id)
            else h.aclRead.push(id)
          }
        }
      )
      await security.enforceWidget(access, object, {
        toolCallId: opts.toolCallId as string,
        ...opts.owner,
        toolName: opts.toolName as string,
        operation: opts.operation as string,
        ...(opts.signal ? { signal: opts.signal as AbortSignal } : {}),
        abortError: 'Aborted'
      })
    }
  }
})

import {
  createWidgetMcpServerFactory,
  invalidateWidgetServerRows,
  widgetServerRows
} from '../widgetMcpServer'
import type { DesktopBuiltinMcpScope } from '../types'
import { M1, M2, makeAgentOf } from './callIdentityFixtures'

// ─── 素材 ────────────────────────────────────────────────────────────────

const ID = 'reading-list'
const ENTRY = `mcp:widget-${ID}`
const NOW = 1_800_000_000_000

const op = (name: string, over: Partial<OpManifest> = {}): OpManifest => ({
  name,
  mode: 'read',
  description: `${name} description`,
  agent: true,
  input: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: { title: { type: 'string' } },
    additionalProperties: false
  },
  ...over
})

const LIST = op('listBooks')
const ADD = op('addBook', { mode: 'write' })
const LAYOUT = op('saveColumns', { mode: 'write', agent: false })

function addWidget(id: string, over: Record<string, unknown> = {}): void {
  h.widgets.set(id, {
    id,
    name: `${id} name`,
    description: `${id} description`,
    createdAt: 1,
    updatedAt: 2,
    archivedAt: 0,
    ...over
  })
}

/** SQLite 组件：数据目录 + 快照（`ops` 为 null = 没有快照；不写数据目录 = 老组件） */
function snapshot(id: string, ops: OpManifest[] | null): void {
  const dir = join(h.dataRoot, id)
  mkdirSync(dir, { recursive: true })
  if (ops === null) return
  writeFileSync(join(dir, 'api.json'), JSON.stringify({ hash: 'h1', builtAt: 1, ops }))
  writeFileSync(join(dir, 'api.js'), '/* bundle */')
}

const ok = (value: unknown = 'done'): unknown => ({
  outcome: { ok: true, value },
  wrote: false,
  logs: []
})

interface Session {
  client: Client
  clientTransport: Transport
  asks: InputRequest[]
}

interface OpenOpts {
  sessionId?: string
  respond?: (request: InputRequest) => Promise<InputResponse>
  agentOf?: DesktopBuiltinMcpScope['agentOf']
}

const opened: Session[] = []

async function open(opts: OpenOpts = {}, widgetId = ID): Promise<Session> {
  const asks: InputRequest[] = []
  const respond =
    opts.respond ?? (async (): Promise<InputResponse> => ({ kind: 'ask', allowed: true }))
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await createWidgetMcpServerFactory(widgetId)(
    {
      sessionId: opts.sessionId ?? 's1',
      requestUserInput: async (request) => {
        asks.push(request)
        return respond(request)
      },
      ...(opts.agentOf ? { agentOf: opts.agentOf } : {})
    },
    serverTransport
  )
  const client = new Client({ name: 'test', version: '0.0.0' })
  await client.connect(clientTransport)
  const session = { client, clientTransport, asks }
  opened.push(session)
  return session
}

interface CallOut {
  content: Array<{ type: string; text?: string }>
  isError?: boolean
}

const call = async (
  session: Session,
  name: string,
  args?: Record<string, unknown>,
  meta?: Record<string, unknown>
): Promise<{ text: string; isError: boolean }> => {
  const result = (await session.client.callTool({
    name,
    ...(args === undefined ? {} : { arguments: args }),
    ...(meta === undefined ? {} : { _meta: meta })
  })) as CallOut
  return { text: result.content[0]?.text ?? '', isError: result.isError === true }
}

const select = (...entries: string[]): void => void h.selections.set('s1', entries)

beforeEach(() => {
  h.dataRoot = mkdtempSync(join(tmpdir(), 'shuvix-widget-mcp-'))
  h.widgets.clear()
  h.selections.clear()
  h.aclRead = []
  h.aclWrite = []
  h.granted = []
  h.warns = []
  h.gate = []
  h.subjects = []
  h.runtime.call.mockReset().mockResolvedValue(ok())
  h.noteWidgetUse.mockReset()
  h.listActiveThrows = false
  h.listActiveCalls = 0
  invalidateWidgetServerRows()
  addWidget(ID)
  snapshot(ID, [LIST, ADD, LAYOUT])
})

afterEach(async () => {
  vi.restoreAllMocks()
  for (const session of opened.splice(0)) await session.client.close().catch(() => {})
  rmSync(h.dataRoot, { recursive: true, force: true })
})

// ─── 行 ──────────────────────────────────────────────────────────────────

describe('widgetServerRows', () => {
  it('WM-R1 一个活跃、有 API 的组件一行；cachedTools 不含纯界面的操作', () => {
    const rows = widgetServerRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: `widget-server:${ID}`,
      name: `widget-${ID}`,
      type: 'inproc',
      command: '',
      url: '',
      isEnabled: 1,
      isBuiltin: 1,
      createdAt: 1,
      updatedAt: 2
    })
    const tools = JSON.parse(rows[0].cachedTools) as Array<{ name: string; description: string }>
    expect(tools.map((tool) => tool.name)).toEqual(['listBooks', 'addBook'])
    expect(tools[0].description).toBe('listBooks description')
  })

  it.each<[string, () => void]>([
    ['归档了的', () => addWidget('b-b', { archivedAt: 5 })],
    ['老组件（没有数据目录）', () => addWidget('c-c')],
    [
      'SQLite 组件没有快照',
      () => {
        addWidget('d-d')
        snapshot('d-d', null)
      }
    ],
    [
      '只有纯界面的操作',
      () => {
        addWidget('e-e')
        snapshot('e-e', [LAYOUT])
      }
    ],
    [
      '只有声明不合格的操作',
      () => {
        addWidget('f-f')
        snapshot('f-f', [op('bad', { input: { type: 'string' } })])
      }
    ]
  ])('WM-R2 %s：没有行', (_l, arrange) => {
    arrange()
    expect(widgetServerRows().map((row) => row.name)).toEqual([`widget-${ID}`])
  })

  it('WM-R2 归档了的组件也不靠 listActive 之外的路进来：它有快照也没有行', () => {
    addWidget('b-b', { archivedAt: 5 })
    snapshot('b-b', [LIST])
    expect(widgetServerRows().map((row) => row.name)).toEqual([`widget-${ID}`])
  })

  it('WM-R3 5 秒内不重算；invalidate 立刻重算；5 秒之后重算', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(NOW)
    widgetServerRows()
    expect(h.listActiveCalls).toBe(1)

    now.mockReturnValue(NOW + 4999)
    widgetServerRows()
    expect(h.listActiveCalls).toBe(1)

    invalidateWidgetServerRows()
    widgetServerRows()
    expect(h.listActiveCalls).toBe(2)

    now.mockReturnValue(NOW + 4999 + 5000)
    widgetServerRows()
    expect(h.listActiveCalls).toBe(3)
  })

  it('WM-R4 列组件抛错 → 空表 + warn，不抛', () => {
    h.listActiveThrows = true
    expect(widgetServerRows()).toEqual([])
    expect(h.warns.some((line) => line.includes('scan failed'))).toBe(true)
  })
})

// ─── 工具面 ──────────────────────────────────────────────────────────────

describe('tools/list', () => {
  it('WM-L1 操作名就是工具名；纯界面的不在；$schema 去掉、根是 object、没有 outputSchema', async () => {
    snapshot(ID, [LIST, ADD, LAYOUT, op('withOutput', { output: { type: 'array' } })])
    const session = await open()
    const { tools } = await session.client.listTools()

    expect(tools.map((tool) => tool.name)).toEqual(['listBooks', 'addBook', 'withOutput'])
    for (const tool of tools) {
      expect(tool.inputSchema).toEqual({
        type: 'object',
        properties: { title: { type: 'string' } },
        additionalProperties: false
      })
      expect(tool).not.toHaveProperty('outputSchema')
    }
    expect(tools[0].description).toBe('listBooks description')
  })

  it('WM-L1 四个 annotations 都写：读是只读不破坏，写反过来；都不是幂等、都不碰外面', async () => {
    const session = await open()
    const { tools } = await session.client.listTools()
    expect(tools[0].annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    })
    expect(tools[1].annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false
    })
  })

  it('WM-L2 老快照：声明不合格的操作跳过、各 warn 一条；其余的照样在，真 Client 的校验不抛', async () => {
    const long = `o${'p'.repeat(60)}`
    snapshot(ID, [
      LIST,
      op('withRefs', {
        input: { type: 'object', properties: { x: { $ref: '#/$defs/X' } }, $defs: {} }
      }),
      op('notObject', { input: { type: 'string' } }),
      op(long),
      ADD,
      // 纯界面的不算「不合格」，不 warn
      op('uiOnly', { agent: false, input: { type: 'string' } })
    ])
    const session = await open()

    const { tools } = await session.client.listTools()

    expect(tools.map((tool) => tool.name)).toEqual(['listBooks', 'addBook'])
    const warned = h.warns.filter((line) => line.includes('not declared'))
    expect(warned).toHaveLength(3)
    expect(warned.join('\n')).toContain('withRefs')
    expect(warned.join('\n')).toContain('notObject')
    expect(warned.join('\n')).toContain(long)
    expect(warned.join('\n')).not.toContain('uiOnly')
  })

  it('WM-L3 每次现读：快照换了，同一条连接再列就是新的', async () => {
    const session = await open()
    expect((await session.client.listTools()).tools.map((t) => t.name)).toEqual([
      'listBooks',
      'addBook'
    ])
    snapshot(ID, [op('renamed')])
    expect((await session.client.listTools()).tools.map((t) => t.name)).toEqual(['renamed'])
  })
})

// ─── 调用 ────────────────────────────────────────────────────────────────

describe('tools/call 的同意', () => {
  it('WM-C1 读 + 勾着 + 没有行 → 不问；进分发器，调用方是 agent；记一笔', async () => {
    select(ENTRY)
    const session = await open()
    h.runtime.call.mockResolvedValue(ok([{ id: 1 }]))

    const out = await call(session, 'listBooks', { title: 'x' })

    expect(out).toEqual({ text: JSON.stringify([{ id: 1 }], null, 2), isError: false })
    expect(session.asks).toEqual([])
    expect(h.runtime.call).toHaveBeenCalledTimes(1)
    expect(h.runtime.call.mock.calls[0]![0]).toMatchObject({
      args: { title: 'x' },
      mode: 'read',
      dryRun: false,
      caller: {
        kind: 'agent',
        sessionId: 's1',
        actor: 'shuvix-agent/unknown',
        label: 'shuvix-agent/unknown'
      }
    })
    expect(h.granted).toEqual([])
    expect(h.noteWidgetUse).toHaveBeenCalledTimes(1)
    expect(h.noteWidgetUse).toHaveBeenCalledWith(ID, 's1')
  })

  it('WM-C2 写 + 勾着 → 问（写的卡，操作名）；允许一次才跑；下一次写照问', async () => {
    select(ENTRY)
    const session = await open()

    expect((await call(session, 'addBook', { title: 'x' })).isError).toBe(false)

    expect(session.asks).toHaveLength(1)
    expect(session.asks[0]).toMatchObject({
      kind: 'ask',
      command: `Widget(write, ${ID})`,
      toolName: `mcp__widget-${ID}__addBook`,
      widget: { widgetId: ID, name: `${ID} name`, access: 'write', operation: 'addBook' }
    })
    expect(h.runtime.call).toHaveBeenCalledTimes(1)
    expect(h.granted).toEqual([])

    await call(session, 'addBook', { title: 'y' })
    expect(session.asks).toHaveLength(2)
  })

  it('WM-C3 允许并记住 → 记一行读写；之后读写都不问', async () => {
    select(ENTRY)
    const session = await open({
      respond: async () => ({ kind: 'ask', allowed: true, extra: { remember: true } })
    })

    await call(session, 'addBook', { title: 'x' })
    expect(h.granted).toEqual([{ mode: 'write', id: ID }])
    expect(session.asks).toHaveLength(1)

    await call(session, 'addBook', { title: 'y' })
    await call(session, 'listBooks')
    expect(session.asks).toHaveLength(1)
    expect(h.runtime.call).toHaveBeenCalledTimes(3)
  })

  it('WM-C3 只读的行免不了写，就算勾着', async () => {
    select(ENTRY)
    h.aclRead = [ID]
    const session = await open()
    await call(session, 'addBook', { title: 'x' })
    expect(session.asks).toHaveLength(1)
  })

  it.each<[string, () => void]>([
    ['WM-C4 档案声明、勾选里没有（`[]`）', () => select()],
    ['WM-C5 只有取消记号', () => select(`-${ENTRY}`)],
    ['WM-C5 两个记号同时在（取消赢）', () => select(ENTRY, `-${ENTRY}`)],
    ['WM-C6 勾的是前缀相同的另一个组件', () => select(`${ENTRY}-2`)],
    ['WM-C7 勾选是 null', () => void h.selections.set('s1', null)],
    ['WM-C7 这条会话没有行', () => void h.selections.delete('s1')]
  ])('%s：读要问', async (_l, arrange) => {
    arrange()
    const session = await open()
    await call(session, 'listBooks')
    expect(session.asks).toHaveLength(1)
    expect(session.asks[0]).toMatchObject({
      command: `Widget(read, ${ID})`,
      widget: { access: 'read', operation: 'listBooks' }
    })
  })

  it('WM-C7 读勾选抛错（坏掉的设置）→ 失败结果，不问、不跑', async () => {
    h.selections.set('s1', 'throw')
    const session = await open()
    const out = await call(session, 'listBooks')
    expect(out).toEqual({ text: 'malformed JSON', isError: true })
    expect(session.asks).toEqual([])
    expect(h.runtime.call).not.toHaveBeenCalled()
    expect(h.noteWidgetUse).not.toHaveBeenCalled()
  })

  it('WM-C8 勾选在调用时现读：连上之后取消了就问；再勾上就不问', async () => {
    select(ENTRY)
    const session = await open()
    await call(session, 'listBooks')
    expect(session.asks).toHaveLength(0)

    select()
    await call(session, 'listBooks')
    expect(session.asks).toHaveLength(1)

    select(ENTRY)
    await call(session, 'listBooks')
    expect(session.asks).toHaveLength(1)
  })

  it('WM-C9 拒绝 → 失败结果带拒绝的话；不跑、不记', async () => {
    select()
    const session = await open({
      respond: async () => ({ kind: 'ask', allowed: false, reason: 'not this one' })
    })
    expect(await call(session, 'listBooks')).toEqual({ text: 'not this one', isError: true })
    expect(h.runtime.call).not.toHaveBeenCalled()
    expect(h.noteWidgetUse).not.toHaveBeenCalled()
  })

  it('WM-C9 卡片挂着时放弃：调用以失败收场；之后放行也不跑、不记', async () => {
    select()
    let answer: (response: InputResponse) => void = () => {}
    const session = await open({
      respond: () =>
        new Promise<InputResponse>((resolve) => {
          answer = resolve
        })
    })
    const controller = new AbortController()
    const pending = session.client.callTool({ name: 'listBooks' }, undefined, {
      signal: controller.signal
    })
    await vi.waitFor(() => expect(session.asks).toHaveLength(1))

    controller.abort()
    await expect(pending).rejects.toBeDefined()
    answer({ kind: 'ask', allowed: true })
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(h.runtime.call).not.toHaveBeenCalled()
    expect(h.noteWidgetUse).not.toHaveBeenCalled()
  })
})

describe('tools/call 的门', () => {
  it('WM-C10 客体恰是那四样；参数和 `_meta` 里的 selected 动不了它', async () => {
    select()
    const session = await open()
    await call(
      session,
      'listBooks',
      { selected: true },
      { selected: true, 'shuvix.dev/selected': 1 }
    )

    expect(h.gate).toHaveLength(1)
    expect(h.gate[0].access).toBe('read')
    expect(h.gate[0].object).toStrictEqual({
      widgetId: ID,
      name: `${ID} name`,
      operation: 'listBooks',
      selected: false
    })
    expect(session.asks).toHaveLength(1)
  })

  it('WM-C10 勾着时客体上 selected 是 true；写也如此（策略决定它不算数）', async () => {
    select(ENTRY)
    const session = await open()
    await call(session, 'addBook', { title: 'x' })
    expect(h.gate[0].access).toBe('write')
    expect(h.gate[0].object).toMatchObject({ operation: 'addBook', selected: true })
  })

  it('WM-C11 门的入参：`_meta` 的 toolCallId、完整工具名、operation=call、归属、signal', async () => {
    select(ENTRY)
    const session = await open({ agentOf: makeAgentOf() })
    await call(session, 'listBooks', {}, M1)

    const opts = h.gate[0].opts
    expect(opts).toMatchObject({
      toolCallId: 'tc-1',
      toolName: `mcp__widget-${ID}__listBooks`,
      operation: 'call',
      owner: { taskId: 20, conversationId: 1 }
    })
    expect(opts.signal).toBeInstanceOf(AbortSignal)
  })

  it('WM-C11 `_meta` 没带 toolCallId → 兜底一个 widget-<请求号>', async () => {
    select(ENTRY)
    const session = await open()
    await call(session, 'listBooks')
    expect(h.gate[0].opts.toolCallId).toMatch(/^widget-\d+$/)
    expect(h.gate[0].opts.owner).toEqual({})
  })

  it('WM-C12 派生 agent 调：门的主体与写入的 actor 都是它，不是根 agent', async () => {
    select(ENTRY)
    const session = await open({ agentOf: makeAgentOf() })
    await call(session, 'listBooks', {}, M2)

    expect(h.subjects[0]).toEqual({
      kind: 'agent',
      sessionId: 's1',
      agentKind: 'spawned',
      profileName: 'explore'
    })
    expect(h.runtime.call.mock.calls[0]![0]).toMatchObject({
      caller: { kind: 'agent', sessionId: 's1', actor: 'shuvix-explore/unknown' }
    })
  })

  it.each<[string, () => void]>([
    ['归档了', () => addWidget(ID, { archivedAt: 9 })],
    ['删了', () => void h.widgets.delete(ID)]
  ])('WM-C13 %s：失败结果说清楚；不问、不过门、不跑', async (_l, arrange) => {
    select(ENTRY)
    const session = await open()
    arrange()
    expect(await call(session, 'addBook', { title: 'x' })).toEqual({
      text: `The widget "${ID}" was archived or deleted.`,
      isError: true
    })
    expect(h.gate).toEqual([])
    expect(session.asks).toEqual([])
    expect(h.runtime.call).not.toHaveBeenCalled()
  })

  it.each(['nope', 'saveColumns'])(
    'WM-C14 %s：失败结果列出看得见的操作；不问、不跑',
    async (name) => {
      select(ENTRY)
      const session = await open()
      expect(await call(session, name)).toEqual({
        text: `Widget "${ID}" has no operation "${name}". Its operations: listBooks, addBook.`,
        isError: true
      })
      expect(h.gate).toEqual([])
      expect(session.asks).toEqual([])
      expect(h.runtime.call).not.toHaveBeenCalled()
      expect(h.noteWidgetUse).not.toHaveBeenCalled()
    }
  )

  it('WM-C15 卡片挂着时被重新构建成写：按读授权的那次不跑，说清楚', async () => {
    select()
    let answer: (response: InputResponse) => void = () => {}
    const session = await open({
      respond: () =>
        new Promise<InputResponse>((resolve) => {
          answer = resolve
        })
    })
    const pending = call(session, 'listBooks')
    await vi.waitFor(() => expect(session.asks).toHaveLength(1))

    snapshot(ID, [op('listBooks', { mode: 'write' })])
    answer({ kind: 'ask', allowed: true })

    const out = await pending
    expect(out.isError).toBe(true)
    expect(out.text).toContain('[changed]')
    expect(out.text).toContain('is now a write operation')
    expect(h.runtime.call).not.toHaveBeenCalled()
  })

  it('WM-C16 真调用不回滚：dryRun false、没有回滚的说明；没给 arguments → {}', async () => {
    select(ENTRY)
    const session = await open()
    const out = await call(session, 'listBooks')
    expect(out.text).not.toContain('rolled back')
    expect(h.runtime.call.mock.calls[0]![0]).toMatchObject({ args: {}, dryRun: false })
  })

  it.each<[string, unknown, string]>([
    [
      'invalid_args 附 input schema',
      {
        outcome: { ok: false, error: { code: 'invalid_args', message: 'title: Required' } },
        wrote: false,
        logs: []
      },
      `[invalid_args] title: Required\nInput schema: ${JSON.stringify(LIST.input)}`
    ],
    [
      'ctx.fail',
      {
        outcome: { ok: false, error: { code: 'not_found', message: 'No such book' } },
        wrote: false,
        logs: []
      },
      '[not_found] No such book'
    ],
    [
      'handler 抛错',
      {
        outcome: { ok: false, error: { code: 'internal', message: 'TypeError: x' } },
        wrote: false,
        logs: []
      },
      'Widget operation failed: TypeError: x'
    ]
  ])('WM-C17 %s：失败结果；过了门就算用过', async (_l, outcome, text) => {
    select(ENTRY)
    const session = await open()
    h.runtime.call.mockResolvedValue(outcome)
    expect(await call(session, 'listBooks')).toEqual({ text, isError: true })
    expect(h.noteWidgetUse).toHaveBeenCalledTimes(1)
  })
})
