/**
 * 任务列表（内置能力服务器 `plan`，docs/task-list-design.md §3）的契约 —— `taskList.ts`。不存状态：列表就是一个
 * 请求里所有成功调用的参数按顺序折叠出来的；server 与界面各自把手上的东西摊成同一种事件交给这一份折叠。
 *
 *   TL-C   常量
 *   TL-P   `parseTaskListUpdate`：参数 → 三种更新之一，或一句给模型读的错误（逐字）
 *   TL-A   `applyTaskListUpdate`：items 换整张、advance 推进、done / start 跳转；没有列表 / 越界 → 错误；不改输入
 *   TL-D   `describeTaskList`：成功调用的那一行状态（单步列表用单数口吻）
 *   TL-F   `foldTaskList`：request 清空；解析或套用失败的调用跳过、不清空
 *   TL-B   `startsTaskListRequest`：只有「用户发起一轮」的消息开始新请求
 *   TL-M   `taskListOfMessages`：从投影消息折出当前请求的列表 + 是否以终答收尾 + 开始这个请求的消息 id
 *   TL-H   `isHiddenTaskListBlock`：没失败的列表调用在卡片里不出行
 */
import { describe, expect, it } from 'vitest'
import {
  TASK_LIST_MAX_ITEMS,
  TASK_LIST_MAX_ITEM_CHARS,
  TASK_LIST_MCP_SERVER_NAME,
  TASK_LIST_TOOL,
  TASK_LIST_TOOL_NAME,
  applyTaskListUpdate,
  describeTaskList,
  foldTaskList,
  isHiddenTaskListBlock,
  parseTaskListUpdate,
  startsTaskListRequest,
  taskListOfMessages,
  type TaskListEvent,
  type TaskListItem,
  type TaskListStatus,
  type TaskListUpdate
} from './taskList'
import { midRunNoteDisplay } from './midRunNote'
import type {
  AssistantBlock,
  AssistantMessage,
  AssistantMeta,
  AssistantToolBlock,
  ChatMessage,
  ErrorEventMessage,
  InlineToken,
  UserTextMessage,
  UserTextMeta
} from './types/chatMessage'

// ─── 夹具 ───────────────────────────────────────────────

const SID = 's1'
const PLAN = 'mcp__plan__update'

const C: TaskListStatus = 'completed'
const I: TaskListStatus = 'in_progress'
const P: TaskListStatus = 'pending'

/** 按状态串出一张列表：步骤内容是 `step N` */
function list(...statuses: TaskListStatus[]): TaskListItem[] {
  return statuses.map((status, i) => ({ content: `step ${i + 1}`, status }))
}

const statusesOf = (items: readonly TaskListItem[]): TaskListStatus[] =>
  items.map((item) => item.status)

/** 应用后必须成功，交回列表 */
function applied(
  current: readonly TaskListItem[] | undefined,
  update: TaskListUpdate
): TaskListItem[] {
  const next = applyTaskListUpdate(current, update)
  if ('error' in next) throw new Error(`unexpected error: ${next.error}`)
  return next
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

function user(id: string, content: string, metadata: UserTextMeta | null = null): UserTextMessage {
  return {
    id,
    sessionId: SID,
    role: 'user',
    type: 'text',
    content,
    model: '',
    createdAt: 0,
    metadata
  }
}

/** 一条带插话说明的用户消息（投影里的样子：原文 + 标记，inlineTokens 里有说明 Token） */
function steer(id: string, text: string): UserTextMessage {
  const display = midRunNoteDisplay(text)
  return user(id, display.content, { inlineTokens: display.tokens })
}

function assistant(
  id: string,
  blocks: AssistantBlock[],
  metadata: AssistantMeta | null = null
): AssistantMessage {
  return {
    id,
    sessionId: SID,
    role: 'assistant',
    type: 'message',
    content: blocks
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join(''),
    model: 'm',
    createdAt: 0,
    blocks,
    metadata
  }
}

function errorRow(id: string): ErrorEventMessage {
  return {
    id,
    sessionId: SID,
    role: 'system_notify',
    type: 'error_event',
    content: 'boom',
    model: '',
    createdAt: 0,
    metadata: null
  }
}

function text(value: string): AssistantBlock {
  return { type: 'text', text: value }
}

/** 一个工具块；`result` 缺省 = 已成功（'ok'），传 null = 还在跑（没有 result） */
function tool(
  toolCallId: string,
  toolName: string,
  args: Record<string, unknown>,
  opts: { result?: string | null; isError?: boolean } = {}
): AssistantToolBlock {
  const result = opts.result === undefined ? 'ok' : opts.result
  return {
    type: 'tool',
    toolCallId,
    toolName,
    args,
    ...(result === null ? {} : { result }),
    ...(opts.isError === undefined ? {} : { isError: opts.isError })
  }
}

function planItems(
  id: string,
  items: TaskListItem[],
  opts?: Parameters<typeof tool>[3]
): AssistantToolBlock {
  return tool(id, PLAN, { items }, opts)
}

function planAdvance(id: string, opts?: Parameters<typeof tool>[3]): AssistantToolBlock {
  return tool(id, PLAN, { advance: true }, opts)
}

const X = list(I, P, P)
const Y = [
  { content: 'other 1', status: I },
  { content: 'other 2', status: P }
]

// ─── 常量 ───────────────────────────────────────────────

describe('常量', () => {
  it('TL-C-1 server / 工具名 / 上限', () => {
    expect(TASK_LIST_MCP_SERVER_NAME).toBe('plan')
    expect(TASK_LIST_TOOL).toBe('update')
    expect(TASK_LIST_TOOL_NAME).toBe('mcp__plan__update')
    expect(TASK_LIST_MAX_ITEMS).toBe(12)
    expect(TASK_LIST_MAX_ITEM_CHARS).toBe(200)
  })
})

// ─── parseTaskListUpdate ───────────────────────────────

describe('parseTaskListUpdate', () => {
  // 每行包成 [标签, 值]：一行若本身是数组，it.each 会把它摊成参数，`[]` 就测不到
  it.each([
    ['null', null],
    ['[]', []],
    ["'x'", 'x'],
    ['3', 3],
    ['undefined', undefined]
  ])('TL-P-1 %s 不是对象 → 错误', (_label, args) => {
    expect(parseTaskListUpdate(args)).toStrictEqual({ error: 'Arguments must be an object.' })
  })

  it.each([
    {},
    { items: X, advance: true },
    { advance: true, done: [1] },
    { advance: true, start: 2 },
    { items: X, start: 1 }
  ])('TL-P-2 %j 不是恰好一种 → 错误', (args) => {
    expect(parseTaskListUpdate(args)).toStrictEqual({
      error: 'Send exactly one of: `items`, `advance`, or `done` / `start`.'
    })
  })

  it.each([[[]], [{}], [null], ['a']])('TL-P-3 items = %j → 错误（null 也算写了）', (items) => {
    expect(parseTaskListUpdate({ items })).toStrictEqual({
      error: '`items` must be a non-empty array of steps.'
    })
  })

  it('TL-P-4 13 步 → 错误；12 步 → 可以', () => {
    const steps = (n: number): TaskListItem[] =>
      Array.from({ length: n }, (_, i) => ({ content: `s${i + 1}`, status: P }))
    expect(parseTaskListUpdate({ items: steps(13) })).toStrictEqual({
      error: 'The list has 13 steps; keep it to 12 or fewer.'
    })
    expect(parseTaskListUpdate({ items: steps(12) })).toStrictEqual({
      kind: 'items',
      items: steps(12)
    })
  })

  it.each(['x', null])('TL-P-5 第 2 步是 %j → 不是对象', (bad) => {
    expect(parseTaskListUpdate({ items: [{ content: 'a', status: P }, bad] })).toStrictEqual({
      error: 'Step 2 must be an object.'
    })
  })

  it.each([
    { content: '', status: P },
    { content: '   ', status: P },
    { content: 42, status: P },
    { status: P }
  ])('TL-P-5 第 3 步 %j → 要非空 content', (bad) => {
    expect(
      parseTaskListUpdate({
        items: [{ content: 'a', status: P }, { content: 'b', status: P }, bad]
      })
    ).toStrictEqual({ error: 'Step 3 needs a non-empty `content`.' })
  })

  it('TL-P-6 长度按 trim 之后算：201 → 错误，200 可以，两边带空格的 200 也可以；存 trim 后的', () => {
    expect(parseTaskListUpdate({ items: [{ content: 'a'.repeat(201), status: P }] })).toStrictEqual(
      { error: 'Step 1 is too long; keep each step to a few words.' }
    )
    expect(parseTaskListUpdate({ items: [{ content: 'a'.repeat(200), status: P }] })).toStrictEqual(
      { kind: 'items', items: [{ content: 'a'.repeat(200), status: P }] }
    )
    expect(
      parseTaskListUpdate({ items: [{ content: `  ${'b'.repeat(200)}  `, status: P }] })
    ).toStrictEqual({ kind: 'items', items: [{ content: 'b'.repeat(200), status: P }] })
    expect(parseTaskListUpdate({ items: [{ content: '  a  ', status: I }] })).toStrictEqual({
      kind: 'items',
      items: [{ content: 'a', status: I }]
    })
  })

  it.each(['done', 'IN_PROGRESS', 1])('TL-P-7 status = %j → 错误', (status) => {
    expect(parseTaskListUpdate({ items: [{ content: 'a', status }] })).toStrictEqual({
      error: 'Step 1 has an unknown status; use pending, in_progress or completed.'
    })
  })

  it('TL-P-7 没写 status → pending（宽松：发布的 schema 要求写）', () => {
    expect(parseTaskListUpdate({ items: [{ content: 'a' }] })).toStrictEqual({
      kind: 'items',
      items: [{ content: 'a', status: P }]
    })
  })

  it('TL-P-8 advance 只认 true', () => {
    expect(parseTaskListUpdate({ advance: true })).toStrictEqual({ kind: 'advance' })
    for (const advance of [false, 'true', 1]) {
      expect(parseTaskListUpdate({ advance }), String(advance)).toStrictEqual({
        error: '`advance` must be true.'
      })
    }
  })

  it('TL-P-9 done：步骤号数组 → jump（没有 start 键）；空数组也收', () => {
    const parsed = parseTaskListUpdate({ done: [2, 3] })
    expect(parsed).toStrictEqual({ kind: 'jump', done: [2, 3] })
    expect('start' in parsed).toBe(false)
    expect(parseTaskListUpdate({ done: [] })).toStrictEqual({ kind: 'jump', done: [] })
  })

  it.each([[[0]], [[1.5]], [['2']], ['2'], [[-1]]])('TL-P-9 done = %j → 错误', (done) => {
    expect(parseTaskListUpdate({ done })).toStrictEqual({
      error: '`done` must be an array of step numbers (1-based).'
    })
  })

  it('TL-P-10 start：只写 start → done 为空；与 done 一起写两样都在', () => {
    expect(parseTaskListUpdate({ start: 4 })).toStrictEqual({ kind: 'jump', done: [], start: 4 })
    expect(parseTaskListUpdate({ done: [1], start: 3 })).toStrictEqual({
      kind: 'jump',
      done: [1],
      start: 3
    })
  })

  it.each([0, '4', 2.5])('TL-P-10 start = %j → 错误', (start) => {
    expect(parseTaskListUpdate({ start })).toStrictEqual({
      error: '`start` must be a step number (1-based).'
    })
  })

  it('TL-P-11 多余的键解析器不管（schema 的 additionalProperties:false 在别处把关）', () => {
    expect(parseTaskListUpdate({ advance: true, foo: 1 })).toStrictEqual({ kind: 'advance' })
  })

  it('TL-P-12 交回的 done 是拷贝：之后改输入不影响结果', () => {
    const done = [1, 2]
    const parsed = parseTaskListUpdate({ done })
    done.push(3)
    done[0] = 9
    expect(parsed).toStrictEqual({ kind: 'jump', done: [1, 2] })
  })
})

// ─── applyTaskListUpdate ───────────────────────────────

describe('applyTaskListUpdate', () => {
  it('TL-A-1 items 换掉整张；结果是拷贝；没有当前列表也行', () => {
    const items = list(I, P)
    const update: TaskListUpdate = { kind: 'items', items }
    const fromNothing = applied(undefined, update)
    expect(fromNothing).toStrictEqual(items)
    expect(applied(list(C, C, C), update)).toStrictEqual(items)
    fromNothing[0].status = C
    fromNothing[0].content = 'hacked'
    expect(items).toStrictEqual(list(I, P))
  })

  it('TL-A-2 还没有列表时推进 / 跳转 → 错误', () => {
    const error = { error: 'No task list in this request yet: send `items` first.' }
    for (const current of [undefined, []]) {
      expect(applyTaskListUpdate(current, { kind: 'advance' })).toStrictEqual(error)
      expect(applyTaskListUpdate(current, { kind: 'jump', done: [1] })).toStrictEqual(error)
    }
  })

  it('TL-A-3 advance：进行中那步完成，下一个待做开始', () => {
    expect(statusesOf(applied(list(C, I, P, P), { kind: 'advance' }))).toEqual([C, C, I, P])
  })

  it('TL-A-4 advance 时没有进行中的：只开始第一个待做，什么都不完成（O3）', () => {
    expect(statusesOf(applied(list(C, P, P), { kind: 'advance' }))).toEqual([C, I, P])
  })

  it('TL-A-5 进行中的是最后一步、前面还有待做：绕回第一个待做（O3）', () => {
    expect(statusesOf(applied(list(P, C, I), { kind: 'advance' }))).toEqual([I, C, C])
  })

  it('TL-A-6 最后一步推进完 → 全部完成；全部完成再推进 → 不变', () => {
    expect(statusesOf(applied(list(C, C, I), { kind: 'advance' }))).toEqual([C, C, C])
    expect(statusesOf(applied(list(C, C, C), { kind: 'advance' }))).toEqual([C, C, C])
  })

  it('TL-A-7 done 标完成、不动没点名的进行中步骤', () => {
    expect(statusesOf(applied(list(P, I, P, P), { kind: 'jump', done: [1, 3] }))).toEqual([
      C,
      I,
      C,
      P
    ])
  })

  it('TL-A-7 start：别的进行中步骤退回待做，点名的那步开始', () => {
    expect(statusesOf(applied(list(C, I, I, P), { kind: 'jump', done: [], start: 4 }))).toEqual([
      C,
      P,
      P,
      I
    ])
  })

  it('TL-A-7 start 点名已完成的步骤 → 重新打开', () => {
    expect(statusesOf(applied(list(C, I, P), { kind: 'jump', done: [], start: 1 }))).toEqual([
      I,
      P,
      P
    ])
  })

  it('TL-A-7 done 与 start 点同一步 → 最后是进行中', () => {
    expect(statusesOf(applied(list(P, I, P), { kind: 'jump', done: [3], start: 3 }))).toEqual([
      P,
      P,
      I
    ])
  })

  it('TL-A-8 越界 → 错误：先按 done 的顺序，再看 start', () => {
    const five = list(I, P, P, P, P)
    expect(applyTaskListUpdate(five, { kind: 'jump', done: [7] })).toStrictEqual({
      error: 'Step 7 does not exist: the list has 5 steps.'
    })
    expect(applyTaskListUpdate(five, { kind: 'jump', done: [], start: 6 })).toStrictEqual({
      error: 'Step 6 does not exist: the list has 5 steps.'
    })
    expect(applyTaskListUpdate(five, { kind: 'jump', done: [9], start: 7 })).toStrictEqual({
      error: 'Step 9 does not exist: the list has 5 steps.'
    })
  })

  it('TL-A-9 从不改 current（深冻结的输入，推进与跳转都不抛）', () => {
    const current = deepFreeze(list(C, I, P))
    expect(() => applyTaskListUpdate(current, { kind: 'advance' })).not.toThrow()
    expect(() =>
      applyTaskListUpdate(current, { kind: 'jump', done: [1, 2], start: 3 })
    ).not.toThrow()
    expect(current).toStrictEqual(list(C, I, P))
  })

  it('TL-A-10 done 为空、没有 start → 内容不变的拷贝', () => {
    const current = list(C, I, P)
    const next = applied(current, { kind: 'jump', done: [] })
    expect(next).toStrictEqual(current)
    expect(next).not.toBe(current)
  })
})

// ─── describeTaskList ──────────────────────────────────

describe('describeTaskList', () => {
  it('TL-D-1 换整张：步骤数，一步用单数', () => {
    expect(describeTaskList(list(I, P, P, P, P), true)).toBe('Plan shown (5 steps).')
    expect(describeTaskList(list(I), true)).toBe('Plan shown (1 step).')
  })

  it('TL-D-2 有进行中的：报第几步；两步都在进行中报第一个', () => {
    expect(describeTaskList(list(C, I, P, P, P), false)).toBe(
      'Plan updated: step 2 of 5 is in progress.'
    )
    expect(describeTaskList(list(C, I, I, P, P), false)).toBe(
      'Plan updated: step 2 of 5 is in progress.'
    )
  })

  it('TL-D-3 全部完成', () => {
    expect(describeTaskList(list(C, C, C, C, C), false)).toBe('Plan updated: all 5 steps are done.')
  })

  it('TL-D-4 部分完成 / 一步都没完成', () => {
    expect(describeTaskList(list(C, C, P, P, P), false)).toBe(
      'Plan updated: 2 of 5 steps are done.'
    )
    expect(describeTaskList(list(P, P, P, P, P), false)).toBe(
      'Plan updated: 0 of 5 steps are done.'
    )
  })

  it('TL-D-5 只有一步的列表：单数口吻（S10）', () => {
    expect(describeTaskList(list(I), false)).toBe('Plan updated: step 1 of 1 is in progress.')
    expect(describeTaskList(list(C), false)).toBe('Plan updated: the step is done.')
    expect(describeTaskList(list(P), false)).toBe('Plan updated: the step is not started.')
    // 与 TL-D-1 一致：一步时不出现复数
    for (const items of [list(I), list(C), list(P)]) {
      expect(describeTaskList(items, false)).not.toMatch(/\bsteps\b/)
    }
  })
})

// ─── foldTaskList ──────────────────────────────────────

const REQUEST: TaskListEvent = { type: 'request' }
const update = (args: unknown): TaskListEvent => ({ type: 'update', args })

describe('foldTaskList', () => {
  it('TL-F-1 没有事件 / 只有 request → undefined', () => {
    expect(foldTaskList([])).toBeUndefined()
    expect(foldTaskList([REQUEST, REQUEST])).toBeUndefined()
  })

  it('TL-F-2 request, items A, advance → A 推进一步', () => {
    expect(foldTaskList([REQUEST, update({ items: X }), update({ advance: true })])).toStrictEqual(
      list(C, I, P)
    )
  })

  it('TL-F-3 新的 request 清空列表', () => {
    expect(foldTaskList([REQUEST, update({ items: X }), REQUEST])).toBeUndefined()
  })

  it('TL-F-4 清空之后的推进没有列表可推 → 仍是 undefined', () => {
    expect(
      foldTaskList([REQUEST, update({ items: X }), REQUEST, update({ advance: true })])
    ).toBeUndefined()
  })

  it('TL-F-5 解析不过的参数跳过，不清空', () => {
    expect(foldTaskList([update({ items: X }), update({ advance: false })])).toStrictEqual(X)
  })

  it('TL-F-6 套用失败的跳过：没有列表时推进 → undefined；越界 → 保持 A', () => {
    expect(foldTaskList([update({ advance: true })])).toBeUndefined()
    expect(foldTaskList([update({ items: X }), update({ done: [9] })])).toStrictEqual(X)
  })

  it('TL-F-7 任何可迭代对象都行，包括生成器', () => {
    function* events(): Generator<TaskListEvent> {
      yield REQUEST
      yield update({ items: X })
      yield update({ advance: true })
    }
    expect(foldTaskList(events())).toStrictEqual(list(C, I, P))
    expect(foldTaskList(new Set([update({ items: Y })]))).toStrictEqual(Y)
  })
})

// ─── startsTaskListRequest ─────────────────────────────

const cmdToken: InlineToken = { type: 'cmd', id: 'review', displayText: '/review', payload: 'p' }
const pasteToken: InlineToken = { type: 'paste', id: 'paste-1', displayText: '[p]', payload: 'p' }
const atToken: InlineToken = { type: 'at', id: 'src/a.ts', displayText: 'a.ts', payload: 'f' }

describe('startsTaskListRequest', () => {
  it('TL-B-1 普通的用户文本消息 → 开始新请求', () => {
    expect(startsTaskListRequest(user('u1', 'go'))).toBe(true)
  })

  it('TL-B-2 系统通知、指令注入、带插话说明的 → 不算', () => {
    expect(startsTaskListRequest(user('u1', 'n', { isSystemNotice: true }))).toBe(false)
    expect(startsTaskListRequest(user('u1', 'i', { isInstructionInjection: true }))).toBe(false)
    expect(startsTaskListRequest(steer('u1', 'pivot'))).toBe(false)
  })

  it('TL-B-3 别的用户 Token（cmd / paste / at）照样算；metadata 为 null 也算', () => {
    for (const token of [cmdToken, pasteToken, atToken]) {
      expect(
        startsTaskListRequest(
          user('u1', '{{shuvixInlineToken:t0}}', { inlineTokens: { t0: token } })
        ),
        token.type
      ).toBe(true)
    }
    expect(startsTaskListRequest(user('u1', 'go', null))).toBe(true)
  })

  it('TL-B-4 助手消息、错误行 → 不算', () => {
    expect(startsTaskListRequest(assistant('a1', [text('hi')]))).toBe(false)
    expect(startsTaskListRequest(errorRow('e1'))).toBe(false)
  })
})

// ─── taskListOfMessages ────────────────────────────────

describe('taskListOfMessages', () => {
  it('TL-M-1 没有列表调用 → undefined（别的工具不算）', () => {
    expect(
      taskListOfMessages([
        user('u1', 'go'),
        assistant('a1', [tool('c1', 'read', { path: 'a' }), tool('c2', 'mcp__ssh__exec', {})]),
        assistant('a2', [text('done')])
      ])
    ).toBeUndefined()
  })

  it('TL-M-2 items 成功、随后一条终答 → 列表 + endedWithAnswer:true + 开始请求的消息 id', () => {
    expect(
      taskListOfMessages([
        user('u1', 'go'),
        assistant('a1', [planItems('p1', X)]),
        assistant('a2', [text('done')])
      ])
    ).toStrictEqual({ items: X, endedWithAnswer: true, requestId: 'u1' })
  })

  it.each([
    ['还在跑（没有 result）', planItems('p1', X, { result: null })],
    ['失败（isError）', planItems('p1', X, { isError: true })],
    ['名字只叫 update', tool('p1', 'update', { items: X })],
    ['改了名的自定义 server', tool('p1', 'mcp__plan-custom__update', { items: X })],
    ['同 server 别的工具', tool('p1', 'mcp__plan__other', { items: X })],
    ['工具名多了后缀', tool('p1', 'mcp__plan__update_x', { items: X })]
  ])('TL-M-3 %s → 不折叠', (_label, block) => {
    expect(
      taskListOfMessages([user('u1', 'go'), assistant('a1', [block]), assistant('a2', [text('x')])])
    ).toBeUndefined()
  })

  it('TL-M-4 一条消息里多个调用按块顺序；跨消息按消息顺序', () => {
    const inOne = taskListOfMessages([
      user('u1', 'go'),
      assistant('a1', [planItems('p1', X), planAdvance('p2'), planAdvance('p3')])
    ])
    expect(inOne?.items).toStrictEqual(list(C, C, I))
    const across = taskListOfMessages([
      user('u1', 'go'),
      assistant('a1', [planItems('p1', X)]),
      assistant('a2', [planAdvance('p2')]),
      assistant('a3', [planItems('p3', Y)]),
      assistant('a4', [planAdvance('p4')])
    ])
    expect(across?.items).toStrictEqual([
      { content: 'other 1', status: C },
      { content: 'other 2', status: I }
    ])
  })

  it('TL-M-5 下一条用户消息开始新请求：之前的列表不算', () => {
    expect(
      taskListOfMessages([
        user('u1', 'go'),
        assistant('a1', [planItems('p1', X)]),
        user('u2', 'next'),
        assistant('a2', [text('ok')])
      ])
    ).toBeUndefined()
    expect(
      taskListOfMessages([
        user('u1', 'go'),
        assistant('a1', [planItems('p1', X)]),
        user('u2', 'next'),
        assistant('a2', [planItems('p2', Y)])
      ])
    ).toStrictEqual({ items: Y, endedWithAnswer: false, requestId: 'u2' })
  })

  it('TL-M-6 带插话说明的消息夹在中间：还是同一张列表', () => {
    expect(
      taskListOfMessages([
        user('u1', 'go'),
        assistant('a1', [planItems('p1', X)]),
        steer('u2', 'also this'),
        assistant('a2', [planAdvance('p2')]),
        assistant('a3', [text('done')])
      ])
    ).toStrictEqual({ items: list(C, I, P), endedWithAnswer: true, requestId: 'u1' })
  })

  it('TL-M-7 系统通知（自动续跑）或指令注入夹在中间：还是同一张列表', () => {
    for (const between of [
      user('n1', '<background-task pid="1" status="done">ok</background-task>', {
        isSystemNotice: true
      }),
      user('n1', 'instructions', { isInstructionInjection: true })
    ]) {
      expect(
        taskListOfMessages([
          user('u1', 'go'),
          assistant('a1', [planItems('p1', X)]),
          between,
          assistant('a2', [planAdvance('p2')])
        ])?.items
      ).toStrictEqual(list(C, I, P))
    }
  })

  it('TL-M-8 视野里没有开始一轮的用户消息（顶上只有压缩摘要）：从头折叠，requestId 为空', () => {
    expect(
      taskListOfMessages([
        assistant('cs', [text('summary')], { isCompactionSummary: true }),
        assistant('a1', [planItems('p1', X)]),
        assistant('a2', [planAdvance('p2')]),
        assistant('a3', [text('done')])
      ])
    ).toStrictEqual({ items: list(C, I, P), endedWithAnswer: true, requestId: '' })
  })

  describe('TL-M-9 endedWithAnswer', () => {
    const head: ChatMessage[] = [user('u1', 'go'), assistant('a1', [planItems('p1', X)])]

    it.each([
      ['最后一条带工具块', assistant('a2', [text('x'), tool('c2', 'read', { path: 'a' })])],
      ['最后一条是错误行', errorRow('e1')],
      ['最后一条是还没答的插话', steer('u2', 'wait')],
      ['最后一条是压缩摘要', assistant('cs', [text('summary')], { isCompactionSummary: true })]
    ])('%s → false', (_label, last) => {
      expect(taskListOfMessages([...head, last])?.endedWithAnswer).toBe(false)
    })

    it('只有思考块的助手消息 → true（钉住：思考卡不是常规输出）', () => {
      expect(
        taskListOfMessages([...head, assistant('a2', [{ type: 'thinking', text: 'hmm' }])])
          ?.endedWithAnswer
      ).toBe(true)
    })

    it('被中止 / 出错截断的正文（metadata.stopped）→ false（S1）', () => {
      expect(
        taskListOfMessages([...head, assistant('a2', [text('partial')], { stopped: true })])
          ?.endedWithAnswer
      ).toBe(false)
      // 同样的正文没有 stopped → 终答
      expect(
        taskListOfMessages([...head, assistant('a2', [text('partial')])])?.endedWithAnswer
      ).toBe(true)
    })
  })

  it('TL-M-10 snapshot 里的 items 是折叠后的值：推进 / 跳转的状态变化看得见', () => {
    const snapshot = taskListOfMessages([
      user('u1', 'go'),
      assistant('a1', [planItems('p1', list(I, P, P, P))]),
      assistant('a2', [planAdvance('p2')]),
      assistant('a3', [tool('p3', PLAN, { done: [2], start: 4 })])
    ])
    expect(statusesOf(snapshot!.items)).toEqual([C, C, P, I])
  })

  it('TL-M-11 不改输入数组', () => {
    const messages: ChatMessage[] = [
      user('u1', 'go'),
      assistant('a1', [planItems('p1', X)]),
      assistant('a2', [planAdvance('p2')])
    ]
    const before = structuredClone(messages)
    taskListOfMessages(messages)
    expect(messages).toStrictEqual(before)
  })

  it('TL-M-12 回退：消息截到更早的请求 → 那个请求的列表（状态跟着转写走）', () => {
    const messages: ChatMessage[] = [
      user('u1', 'go'),
      assistant('a1', [planItems('p1', X)]),
      assistant('a2', [text('done 1')]),
      user('u2', 'again'),
      assistant('a3', [planItems('p2', Y)]),
      assistant('a4', [text('done 2')])
    ]
    expect(taskListOfMessages(messages)).toStrictEqual({
      items: Y,
      endedWithAnswer: true,
      requestId: 'u2'
    })
    expect(taskListOfMessages(messages.slice(0, 3))).toStrictEqual({
      items: X,
      endedWithAnswer: true,
      requestId: 'u1'
    })
  })

  it('TL-M-13 最后一条是插话（会话已空闲）且之前有列表 → 列表还在，endedWithAnswer:false', () => {
    expect(
      taskListOfMessages([
        user('u1', 'go'),
        assistant('a1', [planItems('p1', X)]),
        assistant('a2', [text('done')]),
        steer('u2', 'one more thing')
      ])
    ).toStrictEqual({ items: X, endedWithAnswer: false, requestId: 'u1' })
  })

  it('TL-M-14 最后一条是「正文 + 成功的推进调用」→ endedWithAnswer:false（O4，钉住）', () => {
    expect(
      taskListOfMessages([
        user('u1', 'go'),
        assistant('a1', [planItems('p1', X)]),
        assistant('a2', [text('all done'), planAdvance('p2')])
      ])
    ).toStrictEqual({ items: list(C, I, P), endedWithAnswer: false, requestId: 'u1' })
  })

  it('TL-M-15 requestId：开始当前请求的那条用户消息；插话 / 通知不换它（O2：界面按请求记展开状态）', () => {
    const snapshot = taskListOfMessages([
      user('u1', 'first'),
      assistant('a1', [planItems('p1', Y)]),
      user('u2', 'second'),
      assistant('a2', [planItems('p2', X)]),
      steer('u3', 'pivot'),
      user('n1', '<session id="x">done</session>', { isSystemNotice: true }),
      assistant('a3', [planAdvance('p3')])
    ])
    expect(snapshot?.requestId).toBe('u2')
    expect(snapshot?.items).toStrictEqual(list(C, I, P))
  })
})

// ─── isHiddenTaskListBlock ─────────────────────────────

describe('isHiddenTaskListBlock', () => {
  it('TL-H-1 没失败的列表调用（在跑的、成功的）→ 隐藏', () => {
    expect(isHiddenTaskListBlock(planItems('p1', X, { result: null }))).toBe(true)
    expect(isHiddenTaskListBlock(planItems('p1', X))).toBe(true)
    expect(isHiddenTaskListBlock(planItems('p1', X, { isError: false }))).toBe(true)
  })

  it('TL-H-2 失败的列表调用 → 照常出（红行）', () => {
    expect(isHiddenTaskListBlock(planItems('p1', X, { isError: true }))).toBe(false)
  })

  it('TL-H-3 别的工具、正文块、思考块 → 不隐藏；非工具块带着列表工具名也不算', () => {
    expect(isHiddenTaskListBlock(tool('c1', 'read', { path: 'a' }))).toBe(false)
    expect(isHiddenTaskListBlock({ type: 'text', text: 'x' } as AssistantBlock)).toBe(false)
    expect(isHiddenTaskListBlock({ type: 'thinking', text: 'x' } as AssistantBlock)).toBe(false)
    expect(isHiddenTaskListBlock({ type: 'text', toolName: TASK_LIST_TOOL_NAME })).toBe(false)
  })
})
