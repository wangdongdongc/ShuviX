/**
 * 任务列表工具 `update_plan`（taskListTool.ts，2026-11-14 从实验的内置 MCP `plan` 转正）—— pi-durable 原生注册项。
 * 工具不存状态：推进类调用经注入的 `readTaskList` 读「这次调用之前」的列表（真的读者在 durable/taskListReader 里测，
 * 真会话上的一整轮在 durable/__tests__/taskListReader.session.test.ts 的 TTS），套上这次的参数、交回一行状态。
 * 调用经 invokeTool（假 durable api，不经 schema 校验，参数错误直达 execute 里的解析）。
 *
 *   TT-1   注册项形状：name / replay / label（缺省与自定义）/ 描述 / schema
 *   TT-2   schema：根与步骤都不收多余键、四个键都可选、条数上下限、状态恰三个字面量、done / start 是 1 起的整数
 *   TT-3   描述写着旧 server 的规则原文（含 `{"done": [2], "start": 4}`）；不提 `mcp__`
 *   TT-5   items：Plan shown (N steps) 的单复数、12 步照收；不读列表
 *   TT-6   advance 按调用 id 读一次列表；[I, P, P] → 第 2 步进行中
 *   TT-7   done / start / done + start 也按调用 id 读一次
 *   TT-8   读者交回 undefined / [] → 错误「还没有列表」
 *   TT-9   没给读者：推进类调用一律「还没有列表」，items 照常
 *   TT-10  读者抛错 → 「还没有列表」，onReadError 拿到那个错误原物（抛的字符串也原样）；没给 onReadError 照样
 *   TT-11  参数错误原文交回、是错误、不读列表（旧 TLS-9 那张表 + params 是 undefined / null）
 *   TT-12  步骤号越界（done 与 start）
 *   TT-13  全部完成 / 部分完成 / 单步的状态行
 *   TT-14  每个结果恰一个文本块、一行、没有 details、没有诊断
 *   TT-15  不存状态：同一实例先 items 再 advance（读者给 undefined）→ 还没有列表；两个实例互不相干
 *   TT-16  [WB] items 调用不碰读者：读者会抛也不调 onReadError
 *   TT-17  [WB] 读者交回深冻结的列表：不抛、不改它
 *   TT-18  [WB] context 已 abort 的失败调用 → 以抛错收场（取消语义），不是 isError 结果
 */
import { describe, expect, it, vi, type Mock } from 'vitest'
import {
  TASK_LIST_MAX_ITEMS,
  TASK_LIST_TOOL_NAME,
  type TaskListItem
} from '@shuvix/chat-protocol/taskList'
import {
  createTaskListTool,
  TASK_LIST_DESCRIPTION,
  TaskListParamsSchema,
  type CreateTaskListToolOptions,
  type TaskListReader
} from '../taskListTool'
import { invokeTool, resultText, type InvokedToolResult } from '../tools/testing/invokeTool'

// ─── 素材 ────────────────────────────────────────────────────────────────

const NO_LIST = 'No task list in this request yet: send `items` first.'

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

type Reader = Mock<TaskListReader>
const reads = (impl: TaskListReader): Reader => vi.fn(impl)

/** 调一次工具（参数不经 schema 校验） */
async function run(
  args: unknown,
  options: CreateTaskListToolOptions = {},
  callId = 'c1',
  signal?: AbortSignal
): Promise<InvokedToolResult> {
  const tool = createTaskListTool(options)
  return (await invokeTool(tool, args as never, { callId, signal })).result
}

type JsonSchema = Record<string, unknown>
const schemaOf = (): JsonSchema => TaskListParamsSchema as unknown as JsonSchema
const propsOf = (schema: JsonSchema): Record<string, JsonSchema> =>
  schema.properties as Record<string, JsonSchema>

// ─── 注册项 ──────────────────────────────────────────────────────────────

describe('TT · registration', () => {
  it('TT-1 name update_plan, replay safe, default label Task list, a custom label kept, description and schema are the exported ones', () => {
    const tool = createTaskListTool()
    expect(tool.name).toBe('update_plan')
    expect(tool.name).toBe(TASK_LIST_TOOL_NAME)
    expect(tool.replay).toBe('safe')
    expect(tool.label).toBe('Task list')
    expect(tool.description).toBe(TASK_LIST_DESCRIPTION)
    expect(tool.parameters).toBe(TaskListParamsSchema)

    expect(createTaskListTool({ label: '任务列表' }).label).toBe('任务列表')
  })

  it('TT-2 schema: no extra keys at the root or in a step, four optional keys, item bounds, the three status literals, 1-based integers', () => {
    const schema = schemaOf()
    expect(schema.type).toBe('object')
    expect(schema.additionalProperties).toBe(false)
    const props = propsOf(schema)
    expect(Object.keys(props).sort()).toEqual(['advance', 'done', 'items', 'start'])
    expect((schema.required as string[] | undefined) ?? []).toEqual([])

    expect(props.items).toMatchObject({
      type: 'array',
      minItems: 1,
      maxItems: TASK_LIST_MAX_ITEMS
    })
    const step = props.items.items as JsonSchema
    expect(step.type).toBe('object')
    expect(step.additionalProperties).toBe(false)
    expect([...(step.required as string[])].sort()).toEqual(['content', 'status'])
    const stepProps = propsOf(step)
    expect(Object.keys(stepProps).sort()).toEqual(['content', 'status'])
    expect(stepProps.content).toMatchObject({ type: 'string' })
    const variants = stepProps.status.anyOf as JsonSchema[]
    expect(variants.map((v) => v.const)).toEqual(['pending', 'in_progress', 'completed'])
    for (const v of variants) expect(v.type).toBe('string')

    expect(props.advance).toMatchObject({ type: 'boolean' })
    expect(props.done).toMatchObject({ type: 'array', items: { type: 'integer', minimum: 1 } })
    expect(props.start).toMatchObject({ type: 'integer', minimum: 1 })
  })

  it('TT-3 the description carries the rules of the old server word for word; it never says mcp__', () => {
    const description = TASK_LIST_DESCRIPTION
    expect(description).toContain('it is not an approval step')
    expect(description).toContain('in the same message as your first real tool call')
    expect(description).toContain('`{"advance": true}`')
    expect(description).toContain('`{"done": [2], "start": 4}`')
    expect(description).toContain('after the user sends a message mid-run')
    expect(description).toContain('Keep exactly one step `in_progress`')
    expect(description).toContain('Do not also write the plan')
    expect(description).toContain('No closing call is needed')
    expect(description).not.toContain('mcp__')
    // 进度显示，不是流程：不提审批关口，也不让模型产出文件
    expect(description).not.toMatch(/\bapprov(e|al) (gate|before)\b/i)
    expect(description).not.toMatch(/\b(plan|task|todo) file\b|\.md\b|(to|into) a file\b/i)
  })
})

// ─── 一次调用 ────────────────────────────────────────────────────────────

describe('TT · one call', () => {
  it('TT-5 items: three steps → Plan shown (3 steps). without reading; one step is singular; twelve are accepted', async () => {
    const reader = reads(async () => [I('x')])
    const r = await run(ITEMS3, { readTaskList: reader })
    expect(resultText(r)).toBe('Plan shown (3 steps).')
    expect(r.isError).not.toBe(true)
    expect(reader).not.toHaveBeenCalled()

    const one = await run({ items: [{ content: 'Only', status: 'in_progress' }] })
    expect(resultText(one)).toBe('Plan shown (1 step).')

    const twelve = await run({
      items: Array.from({ length: TASK_LIST_MAX_ITEMS }, (_, i) => ({
        content: `step ${i + 1}`,
        status: 'pending'
      }))
    })
    expect(twelve.isError).not.toBe(true)
    expect(resultText(twelve)).toBe('Plan shown (12 steps).')
  })

  it('TT-6 advance with call id c9 reads once with c9; [I, P, P] → step 2 of 3 in progress', async () => {
    const reader = reads(async () => [I('a'), P('b'), P('c')])
    const r = await run({ advance: true }, { readTaskList: reader }, 'c9')

    expect(reader).toHaveBeenCalledTimes(1)
    expect(reader).toHaveBeenCalledWith('c9')
    expect(resultText(r)).toBe('Plan updated: step 2 of 3 is in progress.')
    expect(r.isError).not.toBe(true)
  })

  it.each<[string, Record<string, unknown>, string]>([
    ['done', { done: [1] }, 'Plan updated: 1 of 3 steps are done.'],
    ['start', { start: 2 }, 'Plan updated: step 2 of 3 is in progress.'],
    ['done + start', { done: [1], start: 3 }, 'Plan updated: step 3 of 3 is in progress.']
  ])('TT-7 %s reads once with the call id', async (_l, args, line) => {
    const reader = reads(async () => [I('a'), P('b'), P('c')])
    const r = await run(args, { readTaskList: reader }, 'c5')

    expect(reader).toHaveBeenCalledTimes(1)
    expect(reader).toHaveBeenCalledWith('c5')
    expect(r.isError).not.toBe(true)
    expect(resultText(r)).toBe(line)
  })

  it.each<[string, TaskListItem[] | undefined]>([
    ['undefined', undefined],
    ['[]', []]
  ])('TT-8 the reader returns %s → isError, no list yet', async (_l, list) => {
    const reader = reads(async () => list)
    const r = await run({ advance: true }, { readTaskList: reader })
    expect(r.isError).toBe(true)
    expect(resultText(r)).toBe(NO_LIST)
    expect(reader).toHaveBeenCalledTimes(1)
  })

  it('TT-9 no reader: advance / done / start → no list yet; items still succeeds', async () => {
    for (const args of [{ advance: true }, { done: [1] }, { start: 1 }]) {
      const r = await run(args)
      expect(r.isError, JSON.stringify(args)).toBe(true)
      expect(resultText(r)).toBe(NO_LIST)
    }
    const shown = await run(ITEMS3)
    expect(shown.isError).not.toBe(true)
    expect(resultText(shown)).toBe('Plan shown (3 steps).')
  })

  it('TT-10 the reader throws → no list yet; onReadError gets that very error once', async () => {
    const boom = new Error('conversation gone')
    const onReadError = vi.fn()
    const r = await run(
      { advance: true },
      {
        readTaskList: async () => {
          throw boom
        },
        onReadError
      }
    )
    expect(r.isError).toBe(true)
    expect(resultText(r)).toBe(NO_LIST)
    expect(onReadError).toHaveBeenCalledTimes(1)
    expect(onReadError.mock.calls[0]![0]).toBe(boom)
  })

  it('TT-10 a thrown string reaches onReadError as is', async () => {
    const onReadError = vi.fn()
    const r = await run(
      { done: [1] },
      {
        readTaskList: async () => {
          throw 'storage exploded'
        },
        onReadError
      }
    )
    expect(resultText(r)).toBe(NO_LIST)
    expect(onReadError).toHaveBeenCalledTimes(1)
    expect(onReadError).toHaveBeenCalledWith('storage exploded')
  })

  it('TT-10 without onReadError a throwing reader still means no list yet', async () => {
    const r = await run(
      { advance: true },
      {
        readTaskList: async () => {
          throw new Error('x')
        }
      }
    )
    expect(r.isError).toBe(true)
    expect(resultText(r)).toBe(NO_LIST)
  })

  it.each<[string, unknown, string]>([
    ['nothing given', {}, 'Send exactly one of: `items`, `advance`, or `done` / `start`.'],
    [
      'params undefined',
      undefined,
      'Send exactly one of: `items`, `advance`, or `done` / `start`.'
    ],
    ['params null', null, 'Send exactly one of: `items`, `advance`, or `done` / `start`.'],
    [
      'items + advance',
      { ...ITEMS3, advance: true },
      'Send exactly one of: `items`, `advance`, or `done` / `start`.'
    ],
    [
      '13 steps',
      {
        items: Array.from({ length: 13 }, (_, i) => ({
          content: `step ${i + 1}`,
          status: 'pending'
        }))
      },
      'The list has 13 steps; keep it to 12 or fewer.'
    ],
    [
      'blank content',
      {
        items: [
          { content: 'ok', status: 'pending' },
          { content: '   ', status: 'pending' }
        ]
      },
      'Step 2 needs a non-empty `content`.'
    ],
    ['advance:false', { advance: false }, '`advance` must be true.'],
    ['empty items', { items: [] }, '`items` must be a non-empty array of steps.'],
    [
      'unknown status',
      { items: [{ content: 'a', status: 'done' }] },
      'Step 1 has an unknown status; use pending, in_progress or completed.'
    ],
    [
      'done is not a step number',
      { done: [0] },
      '`done` must be an array of step numbers (1-based).'
    ],
    ['start is not a step number', { start: '4' }, '`start` must be a step number (1-based).']
  ])(
    'TT-11 parameter error (%s): text verbatim, isError, the reader untouched',
    async (_l, args, expected) => {
      const reader = reads(async () => [I('a')])
      const r = await run(args, { readTaskList: reader })

      expect(r.isError).toBe(true)
      expect(resultText(r)).toBe(expected)
      expect(reader).not.toHaveBeenCalled()
    }
  )

  it('TT-12 a step number past the end: done:[7] and start:6 on five steps', async () => {
    const five = (): Reader => reads(async () => [I('a'), P('b'), P('c'), P('d'), P('e')])
    const done = await run({ done: [7] }, { readTaskList: five() })
    expect(done.isError).toBe(true)
    expect(resultText(done)).toBe('Step 7 does not exist: the list has 5 steps.')

    const start = await run({ start: 6 }, { readTaskList: five() })
    expect(start.isError).toBe(true)
    expect(resultText(start)).toBe('Step 6 does not exist: the list has 5 steps.')
  })

  it('TT-13 status lines: all done, some done, a single step', async () => {
    const all = await run({ advance: true }, { readTaskList: async () => [C('a'), C('b'), I('c')] })
    expect(all.isError).not.toBe(true)
    expect(resultText(all)).toBe('Plan updated: all 3 steps are done.')

    const some = await run({ done: [1] }, { readTaskList: async () => [I('a'), P('b'), P('c')] })
    expect(resultText(some)).toBe('Plan updated: 1 of 3 steps are done.')

    const oneDone = await run({ advance: true }, { readTaskList: async () => [I('only')] })
    expect(resultText(oneDone)).toBe('Plan updated: the step is done.')

    const oneOpen = await run({ start: 1 }, { readTaskList: async () => [P('only')] })
    expect(resultText(oneOpen)).toBe('Plan updated: step 1 of 1 is in progress.')

    const notStarted = await run({ done: [] }, { readTaskList: async () => [P('only')] })
    expect(resultText(notStarted)).toBe('Plan updated: the step is not started.')
  })

  it('TT-14 every result is exactly one text block on one line, with no details and no diagnostics', async () => {
    const reader = async (): Promise<TaskListItem[]> => [I('a'), P('b'), P('c'), P('d'), P('e')]
    const cases: Array<[unknown, CreateTaskListToolOptions]> = [
      [ITEMS3, { readTaskList: reader }],
      [{ advance: true }, { readTaskList: reader }],
      [{ done: [1, 2] }, { readTaskList: reader }],
      [{ start: 9 }, { readTaskList: reader }],
      [{}, { readTaskList: reader }],
      [{ advance: false }, { readTaskList: reader }],
      [{ items: [{ content: '', status: 'pending' }] }, { readTaskList: reader }],
      [{ advance: true }, {}],
      [
        { advance: true },
        {
          readTaskList: async () => {
            throw new Error('a\nb')
          }
        }
      ]
    ]
    for (const [args, options] of cases) {
      const label = JSON.stringify(args)
      const r = await run(args, options)
      expect(r.content, label).toHaveLength(1)
      expect(r.content[0]!.type, label).toBe('text')
      const text = resultText(r)
      expect(text.length, label).toBeGreaterThan(0)
      expect(text, label).not.toContain('\n')
      expect(r.details, label).toBeUndefined()
      expect(r.diagnostics, label).toBeUndefined()
    }
  })
})

// ─── 不存状态 ────────────────────────────────────────────────────────────

describe('TT · no state', () => {
  it('TT-15 one instance, items then advance with a reader that has nothing → no list yet: the tool remembers nothing', async () => {
    const reader = reads(async () => undefined)
    const tool = createTaskListTool({ readTaskList: reader })
    const shown = await invokeTool(tool, ITEMS3 as never, { callId: 'c1' })
    expect(resultText(shown.result)).toBe('Plan shown (3 steps).')
    const advanced = await invokeTool(tool, { advance: true } as never, { callId: 'c2' })
    expect(advanced.result.isError).toBe(true)
    expect(resultText(advanced.result)).toBe(NO_LIST)
    expect(reader.mock.calls).toEqual([['c2']])
  })

  it('TT-15 two instances are independent: each reader sees only its own call ids', async () => {
    const r1 = reads(async () => [I('x'), P('y')])
    const r2 = reads(async () => [C('x'), I('y'), P('z')])
    const a = createTaskListTool({ readTaskList: r1 })
    const b = createTaskListTool({ readTaskList: r2 })

    const ra = await invokeTool(a, { advance: true } as never, { callId: 'a-1' })
    const rb = await invokeTool(b, { advance: true } as never, { callId: 'b-1' })
    await invokeTool(a, { start: 1 } as never, { callId: 'a-2' })

    expect(resultText(ra.result)).toBe('Plan updated: step 2 of 2 is in progress.')
    expect(resultText(rb.result)).toBe('Plan updated: step 3 of 3 is in progress.')
    expect(r1.mock.calls).toEqual([['a-1'], ['a-2']])
    expect(r2.mock.calls).toEqual([['b-1']])
  })
})

// ─── 白盒 ────────────────────────────────────────────────────────────────

describe('TT · white box', () => {
  it('TT-16 [WB] an items call never touches the reader, so onReadError is not called even if the reader would throw', async () => {
    const reader = reads(async () => {
      throw new Error('would throw')
    })
    const onReadError = vi.fn()
    const r = await run(ITEMS3, { readTaskList: reader, onReadError })
    expect(resultText(r)).toBe('Plan shown (3 steps).')
    expect(reader).not.toHaveBeenCalled()
    expect(onReadError).not.toHaveBeenCalled()
  })

  it('TT-17 [WB] a deep-frozen list from the reader: no throw, and it is not mutated', async () => {
    const list = Object.freeze([
      Object.freeze(I('a')),
      Object.freeze(P('b')),
      Object.freeze(P('c'))
    ]) as unknown as TaskListItem[]
    const before = JSON.stringify(list)
    for (const args of [
      { advance: true },
      { done: [1, 2] },
      { start: 3 },
      { done: [1], start: 2 }
    ]) {
      const r = await run(args, { readTaskList: async () => list })
      expect(r.isError, JSON.stringify(args)).not.toBe(true)
    }
    expect(JSON.stringify(list)).toBe(before)
  })

  it('TT-18 [WB] a failing call whose context is already aborted rejects instead of returning isError', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(run({}, {}, 'c1', controller.signal)).rejects.toThrow(
      'Send exactly one of: `items`, `advance`, or `done` / `start`.'
    )
    await expect(run({ advance: true }, {}, 'c2', controller.signal)).rejects.toThrow(NO_LIST)
  })
})
