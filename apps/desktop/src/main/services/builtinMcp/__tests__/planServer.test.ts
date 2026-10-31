/**
 * 内置能力服务器 `plan`（任务列表，实验）—— 隔着**真的 MCP 协议**看它（与 databaseServer.test 同一个架子）。
 *
 * `InMemoryTransport.createLinkedPair()` + SDK 的 `Client`。server 不存状态：推进类调用经 scope 注入的
 * `readTaskList` 读「这次调用之前」的列表；这里把它换成 vi.fn（真的读者在 agent-runtime 的 taskListReader 里测）。
 * 换成假的只有日志。
 *
 * 钉的是：
 *   TLS-1…2   **工具面**：恰好一个工具 `update`、四项 annotations 显式写出、schema、描述里的规则；
 *   TLS-3…11  **一次调用**：items 不读列表、推进类调用按 toolCallId 读一次；读不到 / 读者缺席 / 读者抛
 *             都按「还没有列表」回错误；每个参数错误原文交回、不读列表；越界、完成与部分完成的状态行；
 *   TLS-12    未知工具；
 *   TLS-13…15 **无状态**、实例之间互不相干、工厂；
 *   TLS-16    结果恒是一个文本块、一行；
 *   TLS-17    **派出的 agent 被拒**（`_meta` 的 conversationId 经 scope.agentOf 认出 spawned）：任何形式都回错误、
 *             不读列表；认不出 / 宿主没接 / 没带 conversationId → 按根处理。
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { TaskListItem } from '@shuvix/chat-protocol/taskList'

// mock 路径按**测试文件**解析：被测模块在 services/builtinMcp/，测试在其 __tests__/ 下
const logged = vi.hoisted(() => ({ lines: [] as string[] }))

vi.mock('../../../logger', () => ({
  createLogger: () => ({
    info: (m: string) => void logged.lines.push(`info ${m}`),
    warn: (m: string) => void logged.lines.push(`warn ${m}`),
    error: (m: string) => void logged.lines.push(`error ${m}`)
  })
}))

import {
  createPlanMcpServer,
  createPlanMcpServerFactory,
  PLAN_MCP_SERVER_NAME
} from '../planServer'
import type { DesktopBuiltinMcpScope } from '../types'
import { HOOK_R, SPAWN_E, WORK, makeAgentOf, metaOf } from './callIdentityFixtures'

// ─── 素材 ────────────────────────────────────────────────────────────────

const NO_LIST = 'No task list in this request yet: send `items` first.'
const SPAWNED_REFUSAL_START = "The task list is shown only for the session's main agent"

type ReadTaskList = (beforeToolCallId?: string) => Promise<TaskListItem[] | undefined>
type Reader = Mock<ReadTaskList>

/** scope 上的 readTaskList 替身（类型与 DesktopBuiltinMcpScope 的那一项一致） */
const reads = (impl: ReadTaskList): Reader => vi.fn(impl)

const C = (content: string): TaskListItem => ({ content, status: 'completed' })
const I = (content: string): TaskListItem => ({ content, status: 'in_progress' })
const P = (content: string): TaskListItem => ({ content, status: 'pending' })

/** 三步的 items 参数（第一步进行中） */
const ITEMS3 = {
  items: [
    { content: 'Read the code', status: 'in_progress' },
    { content: 'Fix the bug', status: 'pending' },
    { content: 'Run the tests', status: 'pending' }
  ]
}

interface Session {
  client: Client
  clientTransport: Transport
  reader: Reader | undefined
}

interface OpenOpts {
  sessionId?: string
  /** scope 上的 readTaskList；`null` = 宿主没接（scope 上没有这个键） */
  reader?: Reader | null
  /** scope 上的 agentOf；缺省 = 宿主没接 */
  agentOf?: DesktopBuiltinMcpScope['agentOf']
  /** 经工厂接（TLS-15）而不是直接调 createPlanMcpServer */
  viaFactory?: boolean
}

const opened: Session[] = []

/** 把一台 plan server 接到一对真 InMemoryTransport 上，并连一个真 Client */
async function open(opts: OpenOpts = {}): Promise<Session> {
  const reader: Reader | undefined =
    opts.reader === null ? undefined : (opts.reader ?? reads(async () => undefined))
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const scope: DesktopBuiltinMcpScope = {
    sessionId: opts.sessionId ?? 's1',
    ...(reader ? { readTaskList: reader } : {}),
    ...(opts.agentOf ? { agentOf: opts.agentOf } : {})
  }
  if (opts.viaFactory) await createPlanMcpServerFactory()(scope, serverTransport)
  else await createPlanMcpServer(scope, serverTransport)
  const client = new Client({ name: 'test', version: '0.0.0' })
  await client.connect(clientTransport)
  const session = { client, clientTransport, reader }
  opened.push(session)
  return session
}

interface ToolResult {
  content: Array<{ type: string; text?: string }>
  isError?: boolean
}

const callTool = async (
  client: Client,
  args: Record<string, unknown> | undefined,
  meta?: Record<string, unknown>,
  name = 'update'
): Promise<ToolResult> =>
  (await client.callTool({
    name,
    ...(args === undefined ? {} : { arguments: args }),
    ...(meta ? { _meta: meta } : {})
  })) as unknown as ToolResult

const textOf = (r: ToolResult): string => r.content.map((c) => c.text ?? '').join('\n')

/** 只带 toolCallId 的 `_meta` */
const callMeta = (toolCallId: unknown): Record<string, unknown> => ({
  'shuvix.dev/toolCallId': toolCallId
})

beforeEach(() => {
  logged.lines.length = 0
})

afterEach(async () => {
  for (const s of opened.splice(0)) await s.clientTransport.close()
})

// ─── 工具面 ──────────────────────────────────────────────────────────────

describe('plan 内置服务器的工具声明', () => {
  it('TLS-1 恰好一个工具 update：标题、四项 annotations 显式写出、输入 schema', async () => {
    const { client } = await open()
    const tools = (await client.listTools()).tools

    expect(tools.map((t) => t.name)).toEqual(['update'])
    const tool = tools[0]
    expect(tool.title).toBe('Update the task list')
    expect(tool.annotations).toEqual({
      title: 'Update the task list',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    })

    const schema = tool.inputSchema as Record<string, unknown>
    expect(schema.type).toBe('object')
    expect(schema.additionalProperties).toBe(false)
    const props = schema.properties as Record<string, Record<string, unknown>>
    expect(Object.keys(props).sort()).toEqual(['advance', 'done', 'items', 'start'])

    expect(props.items).toMatchObject({ type: 'array', minItems: 1, maxItems: 12 })
    const step = props.items.items as Record<string, unknown>
    expect(step).toMatchObject({
      type: 'object',
      required: ['content', 'status'],
      additionalProperties: false
    })
    const stepProps = step.properties as Record<string, Record<string, unknown>>
    expect(stepProps.content).toMatchObject({ type: 'string' })
    expect(stepProps.status).toMatchObject({
      type: 'string',
      enum: ['pending', 'in_progress', 'completed']
    })

    expect(props.advance).toMatchObject({ type: 'boolean' })
    expect(props.done).toMatchObject({ type: 'array', items: { type: 'integer', minimum: 1 } })
    expect(props.start).toMatchObject({ type: 'integer', minimum: 1 })
  })

  it('TLS-2 描述写着规则：不是审批、与第一个真调用同一条消息、advance、插话后重发、一个进行中、不在回复里另写、不用收尾', async () => {
    const { client } = await open()
    const description = (await client.listTools()).tools[0].description ?? ''

    expect(description).toContain('it is not an approval step')
    expect(description).toContain('in the same message as your first real tool call')
    expect(description).toContain('`{"advance": true}`')
    expect(description).toContain('after the user sends a message mid-run')
    expect(description).toContain('Keep exactly one step `in_progress`')
    expect(description).toContain('Do not also write the plan')
    expect(description).toContain('No closing call is needed')
    // 进度显示，不是流程：不提审批关口，也不让模型产出文件（「edits files」只是举例哪种请求值得用它）
    expect(description).not.toMatch(/\bapprov(e|al) (gate|before)\b/i)
    expect(description).not.toMatch(/\b(plan|task|todo) file\b|\.md\b|(to|into) a file\b/i)
  })
})

// ─── 一次调用 ────────────────────────────────────────────────────────────

describe('plan：一次调用的结果', () => {
  it('TLS-3 items（三步）→ Plan shown (3 steps).，不是错误；不读列表', async () => {
    const { client, reader } = await open()
    const r = await callTool(client, ITEMS3, callMeta('c1'))

    expect(textOf(r)).toBe('Plan shown (3 steps).')
    expect(r.isError).toBeUndefined()
    expect(reader).not.toHaveBeenCalled()
  })

  it('TLS-4 advance 带 toolCallId c9：读一次列表、实参就是 c9；[I, P, P] 推进 → 第 2 步进行中', async () => {
    const reader = reads(async () => [I('a'), P('b'), P('c')])
    const { client } = await open({ reader })
    const r = await callTool(client, { advance: true }, callMeta('c9'))

    expect(reader).toHaveBeenCalledTimes(1)
    expect(reader).toHaveBeenCalledWith('c9')
    expect(textOf(r)).toBe('Plan updated: step 2 of 3 is in progress.')
    expect(r.isError).toBeUndefined()
  })

  it.each<[string, Record<string, unknown>]>([
    ['done', { done: [1] }],
    ['start', { start: 2 }],
    ['done + start', { done: [1], start: 3 }]
  ])('TLS-5 %s 也按 toolCallId 读一次列表', async (_l, args) => {
    const reader = reads(async () => [I('a'), P('b'), P('c')])
    const { client } = await open({ reader })
    const r = await callTool(client, args, callMeta('c5'))

    expect(reader).toHaveBeenCalledTimes(1)
    expect(reader).toHaveBeenCalledWith('c5')
    expect(r.isError).toBeUndefined()
  })

  it.each<[string, Record<string, unknown> | undefined]>([
    ['没有 _meta', undefined],
    ['toolCallId 是数字', callMeta(42)],
    ['toolCallId 是 null', callMeta(null)],
    ['_meta 里没有 toolCallId', { 'shuvix.dev/agentId': 's1' }]
  ])('TLS-6 %s → readTaskList(undefined)', async (_l, meta) => {
    const reader = reads(async () => [I('a'), P('b')])
    const { client } = await open({ reader })
    await callTool(client, { advance: true }, meta)

    expect(reader).toHaveBeenCalledTimes(1)
    expect(reader.mock.calls[0]).toEqual([undefined])
  })

  it('TLS-7 读者交回 undefined → 错误「还没有列表」', async () => {
    const reader = reads(async () => undefined)
    const { client } = await open({ reader })
    const r = await callTool(client, { advance: true }, callMeta('c1'))

    expect(r.isError).toBe(true)
    expect(textOf(r)).toBe(NO_LIST)
  })

  it('TLS-7 scope 上没有 readTaskList：推进类调用回「还没有列表」，items 照常', async () => {
    const { client } = await open({ reader: null })

    for (const args of [{ advance: true }, { done: [1] }, { start: 1 }]) {
      const r = await callTool(client, args, callMeta('c1'))
      expect(r.isError, JSON.stringify(args)).toBe(true)
      expect(textOf(r)).toBe(NO_LIST)
    }
    const shown = await callTool(client, ITEMS3, callMeta('c2'))
    expect(shown.isError).toBeUndefined()
    expect(textOf(shown)).toBe('Plan shown (3 steps).')
  })

  it('TLS-8 读者抛错：不是协议错误，这次调用回「还没有列表」；warn 记一行带 session=s1 与那个错误', async () => {
    const reader = reads(async () => {
      throw new Error('conversation gone')
    })
    const { client } = await open({ reader })
    const r = await callTool(client, { advance: true }, callMeta('c1'))

    expect(r.isError).toBe(true)
    expect(textOf(r)).toBe(NO_LIST)
    const warns = logged.lines.filter((l) => l.startsWith('warn '))
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('session=s1')
    expect(warns[0]).toContain('conversation gone')
  })

  it.each<[string, Record<string, unknown> | undefined, string]>([
    ['一个都没给', {}, 'Send exactly one of: `items`, `advance`, or `done` / `start`.'],
    [
      '没有 arguments（等同 {}）',
      undefined,
      'Send exactly one of: `items`, `advance`, or `done` / `start`.'
    ],
    [
      'items + advance',
      { ...ITEMS3, advance: true },
      'Send exactly one of: `items`, `advance`, or `done` / `start`.'
    ],
    [
      '13 步',
      {
        items: Array.from({ length: 13 }, (_, i) => ({
          content: `step ${i + 1}`,
          status: 'pending'
        }))
      },
      'The list has 13 steps; keep it to 12 or fewer.'
    ],
    [
      '空 content',
      {
        items: [
          { content: 'ok', status: 'pending' },
          { content: '   ', status: 'pending' }
        ]
      },
      'Step 2 needs a non-empty `content`.'
    ],
    ['advance:false', { advance: false }, '`advance` must be true.'],
    ['空 items', { items: [] }, '`items` must be a non-empty array of steps.'],
    [
      '未知状态',
      { items: [{ content: 'a', status: 'done' }] },
      'Step 1 has an unknown status; use pending, in_progress or completed.'
    ],
    ['done 不是步骤号', { done: [0] }, '`done` must be an array of step numbers (1-based).'],
    ['start 不是步骤号', { start: '4' }, '`start` must be a step number (1-based).']
  ])('TLS-9 参数错误（%s）原文交回、是错误、不读列表', async (_l, args, expected) => {
    const reader = reads(async () => [I('a')])
    const { client } = await open({ reader })
    const r = await callTool(client, args, callMeta('c1'))

    expect(r.isError).toBe(true)
    expect(textOf(r)).toBe(expected)
    expect(reader).not.toHaveBeenCalled()
  })

  it('TLS-10 步骤号越界 → Step 7 does not exist: the list has 5 steps.（错误）', async () => {
    const reader = reads(async () => [I('a'), P('b'), P('c'), P('d'), P('e')])
    const { client } = await open({ reader })
    const r = await callTool(client, { done: [7] }, callMeta('c1'))

    expect(r.isError).toBe(true)
    expect(textOf(r)).toBe('Step 7 does not exist: the list has 5 steps.')
  })

  it('TLS-11 全部完成 / 部分完成的状态行', async () => {
    const allDone = reads(async () => [C('a'), C('b'), I('c')])
    const a = await open({ reader: allDone })
    const done = await callTool(a.client, { advance: true }, callMeta('c1'))
    expect(done.isError).toBeUndefined()
    expect(textOf(done)).toBe('Plan updated: all 3 steps are done.')

    const partial = reads(async () => [I('a'), P('b'), P('c')])
    const b = await open({ reader: partial })
    const some = await callTool(b.client, { done: [1] }, callMeta('c2'))
    expect(some.isError).toBeUndefined()
    expect(textOf(some)).toBe('Plan updated: 1 of 3 steps are done.')
  })

  it('TLS-12 未知工具 foo → 错误 Unknown tool: foo', async () => {
    const { client, reader } = await open()
    const r = await callTool(client, { advance: true }, callMeta('c1'), 'foo')

    expect(r.isError).toBe(true)
    expect(textOf(r)).toBe('Unknown tool: foo')
    expect(reader).not.toHaveBeenCalled()
  })
})

// ─── 无状态、实例、工厂 ──────────────────────────────────────────────────

describe('plan：不存状态', () => {
  it('TLS-13 items A、items B、再 advance（读者交回 A）→ 按 A 算：server 不记得 B', async () => {
    const listA = [I('a1'), P('a2'), P('a3')]
    const reader = reads(async () => listA)
    const { client } = await open({ reader })

    await callTool(client, ITEMS3, callMeta('c1'))
    await callTool(
      client,
      {
        items: [
          { content: 'b1', status: 'completed' },
          { content: 'b2', status: 'completed' },
          { content: 'b3', status: 'completed' },
          { content: 'b4', status: 'completed' },
          { content: 'b5', status: 'in_progress' }
        ]
      },
      callMeta('c2')
    )
    const r = await callTool(client, { advance: true }, callMeta('c3'))

    // 按 B 算会是「all 5 steps are done」；按 A 算是第 2 步（共 3 步）
    expect(textOf(r)).toBe('Plan updated: step 2 of 3 is in progress.')
    expect(reader).toHaveBeenCalledTimes(1)
    expect(reader).toHaveBeenCalledWith('c3')
  })

  it('TLS-14 两份实例、两份 scope 互不相干：各自的读者只收到自己的调用 id', async () => {
    const r1 = reads(async () => [I('x'), P('y')])
    const r2 = reads(async () => [C('x'), I('y'), P('z')])
    const a = await open({ sessionId: 's1', reader: r1 })
    const b = await open({ sessionId: 's2', reader: r2 })

    const ra = await callTool(a.client, { advance: true }, callMeta('a-1'))
    const rb = await callTool(b.client, { advance: true }, callMeta('b-1'))
    await callTool(a.client, { start: 1 }, callMeta('a-2'))

    expect(textOf(ra)).toBe('Plan updated: step 2 of 2 is in progress.')
    expect(textOf(rb)).toBe('Plan updated: step 3 of 3 is in progress.')
    expect(r1.mock.calls).toEqual([['a-1'], ['a-2']])
    expect(r2.mock.calls).toEqual([['b-1']])
  })

  it('TLS-15 工厂接上的 server 是同一个工具；server 名是 plan', async () => {
    expect(PLAN_MCP_SERVER_NAME).toBe('plan')
    const reader = reads(async () => [I('a'), P('b')])
    const { client } = await open({ viaFactory: true, reader })

    const tools = (await client.listTools()).tools
    expect(tools.map((t) => t.name)).toEqual(['update'])
    expect(textOf(await callTool(client, ITEMS3, callMeta('c1')))).toBe('Plan shown (3 steps).')
    expect(textOf(await callTool(client, { advance: true }, callMeta('c2')))).toBe(
      'Plan updated: step 2 of 2 is in progress.'
    )
    expect(reader).toHaveBeenCalledWith('c2')
  })

  it('TLS-16 每个结果都是恰好一个文本块、一行（没有换行）', async () => {
    const reader = reads(async () => [I('a'), P('b'), P('c'), P('d'), P('e')])
    const { client } = await open({ reader })
    const calls: Array<[Record<string, unknown> | undefined, string]> = [
      [ITEMS3, 'update'],
      [{ advance: true }, 'update'],
      [{ done: [1, 2] }, 'update'],
      [{ start: 9 }, 'update'],
      [{}, 'update'],
      [{ advance: false }, 'update'],
      [{ items: [{ content: '', status: 'pending' }] }, 'update'],
      [{ advance: true }, 'foo']
    ]

    for (const [args, name] of calls) {
      const r = await callTool(client, args, callMeta('c1'), name)
      expect(r.content, JSON.stringify(args)).toHaveLength(1)
      expect(r.content[0].type).toBe('text')
      expect(r.content[0].text).not.toContain('\n')
      expect((r.content[0].text ?? '').length).toBeGreaterThan(0)
    }

    const noReader = await open({ reader: null })
    const r = await callTool(noReader.client, { advance: true }, callMeta('c1'))
    expect(r.content).toHaveLength(1)
    expect(r.content[0].text).not.toContain('\n')
  })
})

// ─── 只给根 agent ────────────────────────────────────────────────────────

describe('plan：派出的 agent 被拒（TLS-17）', () => {
  it.each<[string, Record<string, unknown>]>([
    ['items', ITEMS3],
    ['advance', { advance: true }],
    ['done / start', { done: [1], start: 2 }]
  ])(
    'TLS-17 对话认出是 spawned（%s）→ 错误、不读列表；agentOf 按 _meta 的 conversationId 现问',
    async (_l, args) => {
      const reader = reads(async () => [I('a'), P('b')])
      const agentOf = makeAgentOf()
      const { client } = await open({ reader, agentOf })
      const r = await callTool(client, args, metaOf('tc-2', 'sub-a1', 21, 2))

      expect(r.isError).toBe(true)
      expect(textOf(r).startsWith(SPAWNED_REFUSAL_START)).toBe(true)
      expect(r.content).toHaveLength(1)
      expect(textOf(r)).not.toContain('\n')
      expect(reader).not.toHaveBeenCalled()
      expect(agentOf).toHaveBeenCalledWith(2)
    }
  )

  it('TLS-17 hook 派出的审查员（也是 spawned）一样被拒', async () => {
    expect(HOOK_R.kind).toBe('spawned')
    const reader = reads(async () => [I('a'), P('b')])
    const { client } = await open({ reader, agentOf: makeAgentOf() })
    const r = await callTool(client, { advance: true }, metaOf('tc-3', 'sub-r1', 22, 3))

    expect(r.isError).toBe(true)
    expect(textOf(r).startsWith(SPAWNED_REFUSAL_START)).toBe(true)
    expect(reader).not.toHaveBeenCalled()
  })

  it('TLS-17 被拒的调用不留痕：同一实例里根 agent 随后的调用照常算', async () => {
    const reader = reads(async () => [I('a'), P('b'), P('c')])
    const { client } = await open({ reader, agentOf: makeAgentOf() })

    await callTool(client, { advance: true }, metaOf('tc-2', 'sub-a1', 21, 2))
    const r = await callTool(client, { advance: true }, metaOf('tc-1', 's1', 20, 1))

    expect(r.isError).toBeUndefined()
    expect(textOf(r)).toBe('Plan updated: step 2 of 3 is in progress.')
    expect(reader.mock.calls).toEqual([['tc-1']])
  })

  it.each<[string, Partial<OpenOpts>, Record<string, unknown>]>([
    ['认出是根（work）', { agentOf: makeAgentOf() }, metaOf('tc-1', 's1', 20, 1)],
    ['认不出（agentOf 交回 undefined）', { agentOf: makeAgentOf() }, metaOf('tc-9', 'x', 29, 9)],
    ['宿主没接 agentOf', {}, metaOf('tc-2', 'sub-a1', 21, 2)],
    ['没带 conversationId', { agentOf: makeAgentOf() }, metaOf('tc-4', 'sub-a1', 21, undefined)],
    [
      'conversationId 不是安全整数（字符串）',
      { agentOf: makeAgentOf() },
      metaOf('tc-5', 'sub-a1', 21, '2')
    ]
  ])('TLS-17 %s → 按根处理，照常读列表、照常回状态', async (_l, extra, meta) => {
    expect(WORK.kind).toBe('root')
    expect(SPAWN_E.kind).toBe('spawned')
    const reader = reads(async () => [I('a'), P('b')])
    const { client } = await open({ reader, ...extra })
    const r = await callTool(client, { advance: true }, meta)

    expect(r.isError).toBeUndefined()
    expect(textOf(r)).toBe('Plan updated: step 2 of 2 is in progress.')
    expect(reader).toHaveBeenCalledTimes(1)
    expect(reader).toHaveBeenCalledWith(meta['shuvix.dev/toolCallId'])
  })

  it('TLS-17 没带 conversationId / 带的不是整数：不去问 agentOf', async () => {
    const agentOf = makeAgentOf()
    const { client } = await open({ agentOf })
    await callTool(client, ITEMS3, metaOf('tc-4', 'sub-a1', 21, undefined))
    await callTool(client, ITEMS3, metaOf('tc-5', 'sub-a1', 21, '2'))
    await callTool(client, ITEMS3, metaOf('tc-6', 'sub-a1', 21, 2.5))

    expect(agentOf).not.toHaveBeenCalled()
  })
})
