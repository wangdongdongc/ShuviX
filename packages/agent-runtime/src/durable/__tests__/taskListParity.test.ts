/**
 * 任务列表「两边必须一致」的契约（docs/task-list-design.md §3.2）：server 读已提交的条目
 * （`taskListEventsOfEntries` → `foldTaskList`），界面读投影出来的消息（`taskListOfMessages`）。同一份转写
 * 两边折出的列表必须深相等（都可以是 undefined）。
 *
 * **逐次调用的检查**：对每一次列表调用 c_k，server 当时读到的是「c_k 执行那一刻已提交的前缀」—— c_k 所在
 * assistant 条目之前的全部、它本身，再加紧跟其后、回答它前面兄弟调用的那些结果条目。server 在这个前缀上
 * 折出的「c_k 之前的列表」必须等于界面在同一前缀上、c_k 之前那些成功列表块的折叠（请求边界按
 * `startsTaskListRequest`）；把 c_k 的参数套上去，得到的就是界面把 c_k 也折进去之后的状态（c_k 成功时），
 * 或者 server 回错误、转写里它的结果就是错误（c_k 失败时）。
 *
 *   TLP-1  一个请求：列表、推进、终答          TLP-2  两个请求：只有第二个算
 *   TLP-3  插话（带说明）夹在调用之间          TLP-4  后台通知夹在调用之间
 *   TLP-5  失败的调用、带错误文案的失败轮      TLP-6  压缩切在请求中间
 *   TLP-7  一条消息里两次列表调用              TLP-8  跨消息重用 toolCallId
 *   TLP-9  中止截断的正文不算「以终答收尾」    TLP-11 带命令 Token 的用户消息开新请求
 *   TLP-12 带图的插话（带说明）不开新请求
 * （TLP-10「消息原文恰好以说明结尾」两边判法不同，是接受的已知偏差 S9，不写用例。）
 */
import type { EntryRecord, JsonObject } from '@earendil-works/pi-durable'
import {
  MID_RUN_NOTE_SEPARATOR,
  MID_RUN_NOTE_TEXT,
  midRunNoteDisplay
} from '@shuvix/chat-protocol/midRunNote'
import {
  applyTaskListUpdate,
  foldTaskList,
  parseTaskListUpdate,
  startsTaskListRequest,
  taskListOfMessages,
  TASK_LIST_TOOL_NAME,
  type TaskListEvent,
  type TaskListItem,
  type TaskListSnapshot
} from '@shuvix/chat-protocol/taskList'
import type { ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'
import { describe, expect, it } from 'vitest'
import { AssistantEntry, ToolResultEntry } from '@earendil-works/pi-durable'
import type { DisplayByEntry } from '../projection/project'
import { firstMessage } from '../projection/entryText'
import { taskListEventsOfEntries } from '../taskListReader'
import {
  A,
  C,
  IMAGE,
  K1,
  N,
  P,
  R,
  U,
  bg,
  call,
  display,
  text,
  wrap
} from '../projection/__tests__/support'

const PLAN = TASK_LIST_TOOL_NAME
const SUFFIX = `${MID_RUN_NOTE_SEPARATOR}${MID_RUN_NOTE_TEXT}`

const ITEMS: JsonObject = {
  items: [
    { content: 'Read the code', status: 'in_progress' },
    { content: 'Fix it', status: 'pending' },
    { content: 'Test it', status: 'pending' }
  ]
}
const OTHER: JsonObject = {
  items: [
    { content: 'Plan B one', status: 'in_progress' },
    { content: 'Plan B two', status: 'pending' }
  ]
}
const ADVANCE: JsonObject = { advance: true }
const OK = [text('ok')]
const FAILED = [text('failed')]

/** 一次列表调用（单独一条 assistant）+ 结果 */
const planned = (id: number, callId: string, args: JsonObject, isError = false): EntryRecord[] => [
  A(id, [call(PLAN, args, callId)], 0, { stopReason: 'toolUse' }),
  R(id + 1, callId, isError ? FAILED : OK, { isError })
]

/** 插话：模型文本 = 原文 + 说明；显示侧车 = 原文 + 说明标记（DurableSession.admitUser 写的形状） */
function steer(
  id: number,
  said: string
): { entry: EntryRecord; display: [number, ReturnType<typeof display>] } {
  const noted = midRunNoteDisplay(said)
  return { entry: U(id, `${said}${SUFFIX}`), display: [id, display(noted.content, noted.tokens)] }
}

interface PlanCall {
  entryIndex: number
  entryId: number
  block: number
  callId: string
  args: unknown
}

/** 工具真会执行的那些列表调用（失败轮塌成错误行，里面的调用从没执行过） */
function planCalls(entries: readonly EntryRecord[]): PlanCall[] {
  const out: PlanCall[] = []
  entries.forEach((entry, entryIndex) => {
    if (entry.kind !== AssistantEntry.kind) return
    const message = firstMessage(entry, 'assistant')
    if (message === undefined) return
    if (message.stopReason === 'error' && message.errorMessage) return
    message.content.forEach((block, index) => {
      if (block.type !== 'toolCall' || block.name !== PLAN) return
      out.push({
        entryIndex,
        entryId: entry.id,
        block: index,
        callId: block.id,
        args: block.arguments
      })
    })
  })
  return out
}

/** c 执行那一刻已提交的前缀：它所在条目为止，再加紧跟其后、回答它前面兄弟调用的结果 */
function prefixAt(entries: readonly EntryRecord[], c: PlanCall): EntryRecord[] {
  const prefix = entries.slice(0, c.entryIndex + 1)
  const owner = firstMessage(entries[c.entryIndex]!, 'assistant')!
  const earlier = new Set(
    owner.content
      .slice(0, c.block)
      .flatMap((block) => (block.type === 'toolCall' ? [block.id] : []))
  )
  for (const entry of entries.slice(c.entryIndex + 1)) {
    if (entry.kind !== ToolResultEntry.kind) break
    const result = firstMessage(entry, 'toolResult')
    if (result !== undefined && earlier.has(result.toolCallId)) prefix.push(entry)
  }
  return prefix
}

/** 界面口径：c 之前（消息序、块序）那些成功列表块的折叠；`through` = 连 c 一起（c 成功时） */
function uiFold(
  messages: readonly ChatMessage[],
  c: Pick<PlanCall, 'entryId' | 'callId'>,
  through: boolean
): TaskListItem[] | undefined {
  const events: TaskListEvent[] = []
  for (const message of messages) {
    if (message.role === 'user') {
      if (startsTaskListRequest(message)) events.push({ type: 'request' })
      continue
    }
    if (message.role !== 'assistant') continue
    for (const block of message.blocks) {
      if (block.type !== 'tool' || block.toolName !== PLAN) continue
      const isTarget = message.id === String(c.entryId) && block.toolCallId === c.callId
      if (isTarget && !through) return foldTaskList(events)
      if (block.result !== undefined && !block.isError)
        events.push({ type: 'update', args: block.args })
      if (isTarget) return foldTaskList(events)
    }
  }
  throw new Error(`plan call ${c.callId} of #${c.entryId} is not in the projected messages`)
}

interface Parity {
  server: TaskListItem[] | undefined
  ui: TaskListItem[] | undefined
  snapshot: TaskListSnapshot | undefined
}

/** 终态一致 + 逐次调用一致；交回两边的终态与界面快照 */
function expectParity(
  entries: readonly EntryRecord[],
  displays: DisplayByEntry = new Map()
): Parity {
  const server = foldTaskList(taskListEventsOfEntries(entries))
  const projected = P(entries, { display: displays }).messages
  const snapshot = taskListOfMessages(projected)
  expect(server, 'final list: server vs UI').toEqual(snapshot?.items)

  const calls = planCalls(entries)
  expect(calls.length, 'the scenario has plan calls to check').toBeGreaterThan(0)
  for (const c of calls) {
    const label = `call ${c.callId} of #${c.entryId}`
    const prefix = prefixAt(entries, c)
    const before = foldTaskList(taskListEventsOfEntries(prefix, c.callId))
    const prefixMessages = P(prefix, { display: displays }).messages
    expect(before, `${label}: state before it`).toEqual(uiFold(prefixMessages, c, false))

    // server 这次的回答 = 「之前」套上这次的参数；成功 → 正是界面折进它之后的状态，失败 → 转写里是错误结果
    const parsed = parseTaskListUpdate(c.args)
    const applied = 'error' in parsed ? parsed : applyTaskListUpdate(before, parsed)
    const block = projected
      .filter((m) => m.role === 'assistant' && m.id === String(c.entryId))
      .flatMap((m) => (m.role === 'assistant' ? m.blocks : []))
      .find((b) => b.type === 'tool' && b.toolCallId === c.callId)
    if (block?.type !== 'tool' || block.result === undefined) continue
    if ('error' in applied) {
      expect(block.isError, `${label}: the server refuses it, the transcript must say so`).toBe(
        true
      )
    } else {
      expect(block.isError ?? false, `${label}: the server accepts it`).toBe(false)
      expect(applied, `${label}: state after it`).toEqual(uiFold(projected, c, true))
    }
  }
  return { server, ui: snapshot?.items, snapshot }
}

const statuses = (items: TaskListItem[] | undefined): string[] | undefined =>
  items?.map((item) => item.status)

describe('TLP · server and UI fold the same list', () => {
  it('TLP-1 one request: items, advance, final answer', () => {
    const { server, snapshot } = expectParity([
      U(1, 'go'),
      ...planned(2, 'p1', ITEMS),
      ...planned(4, 'p2', ADVANCE),
      A(6, [text('All done.')])
    ])
    expect(statuses(server)).toEqual(['completed', 'in_progress', 'pending'])
    expect(snapshot).toMatchObject({ endedWithAnswer: true, requestId: '1' })
  })

  it('TLP-2 two requests, each with a list: only the second counts; a second request with no list yet gives undefined on both sides', () => {
    const { server } = expectParity([
      U(1, 'first'),
      ...planned(2, 'p1', ITEMS),
      A(4, [text('done')]),
      U(5, 'second'),
      ...planned(6, 'p2', OTHER),
      ...planned(8, 'p3', ADVANCE)
    ])
    expect(server).toEqual([
      { content: 'Plan B one', status: 'completed' },
      { content: 'Plan B two', status: 'in_progress' }
    ])
    const fresh = expectParity([
      U(1, 'first'),
      ...planned(2, 'p1', ITEMS),
      A(4, [text('done')]),
      U(5, 'second'),
      ...planned(6, 'p2', ADVANCE, true)
    ])
    expect(fresh.server).toBeUndefined()
  })

  it('TLP-3 a noted steer between calls keeps the list on both sides', () => {
    const s = steer(4, 'pivot to plan B')
    const { server, snapshot } = expectParity(
      [
        U(1, 'go'),
        ...planned(2, 'p1', ITEMS),
        s.entry,
        ...planned(5, 'p2', ADVANCE),
        A(7, [text('ok')])
      ],
      new Map([s.display])
    )
    expect(statuses(server)).toEqual(['completed', 'in_progress', 'pending'])
    expect(snapshot?.requestId).toBe('1')
  })

  it('TLP-4 a background notice between calls (a shuvix.notice entry, or a notice-shaped pi.user) keeps the list', () => {
    for (const notice of [N(4, bg('t1', 'exited 0')), U(4, bg('t1', 'exited 0'))]) {
      const { server } = expectParity([
        U(1, 'go'),
        ...planned(2, 'p1', ITEMS),
        notice,
        ...planned(5, 'p2', ADVANCE)
      ])
      expect(statuses(server), notice.kind).toEqual(['completed', 'in_progress', 'pending'])
    }
  })

  it('TLP-5 a failed call and an error entry with an errorMessage holding a plan call change nothing on either side', () => {
    const { server } = expectParity([
      U(1, 'go'),
      ...planned(2, 'p1', ITEMS),
      ...planned(4, 'p2', { done: [9] }, true),
      A(6, [call(PLAN, ADVANCE, 'p3')], 0, { stopReason: 'error', errorMessage: 'overloaded' }),
      R(7, 'p3', OK),
      A(8, [text('stopped here')])
    ])
    expect(server).toEqual(ITEMS.items)
  })

  it('TLP-6 compaction in the middle of a request: the kept window folds the same on both sides', () => {
    const lost = expectParity([
      C(10, 4, wrap('S')),
      ...planned(4, 'p2', ADVANCE, true),
      A(6, [text('x')])
    ])
    expect(lost.server).toBeUndefined()
    const kept = expectParity([
      C(10, 4, wrap('S')),
      ...planned(4, 'p1', ITEMS),
      ...planned(6, 'p2', ADVANCE),
      A(8, [text('done')])
    ])
    expect(statuses(kept.server)).toEqual(['completed', 'in_progress', 'pending'])
    // 开这个请求的用户消息被压缩掉了：从头折，请求 id 为空
    expect(kept.snapshot?.requestId).toBe('')
  })

  it('TLP-7 two plan calls in one assistant entry: [advance, advance] and [items, advance] agree at the end and call by call', () => {
    const twoAdvances = expectParity([
      U(1, 'go'),
      ...planned(2, 'p1', ITEMS),
      A(4, [call(PLAN, ADVANCE, 'p2'), call(PLAN, ADVANCE, 'p3')], 0, { stopReason: 'toolUse' }),
      R(5, 'p2', OK),
      R(6, 'p3', OK),
      A(7, [text('ok')])
    ])
    expect(statuses(twoAdvances.server)).toEqual(['completed', 'completed', 'in_progress'])
    const itemsThenAdvance = expectParity([
      U(1, 'go'),
      A(2, [call(PLAN, ITEMS, 'p1'), call('ls', {}, 'l1'), call(PLAN, ADVANCE, 'p2')], 0, {
        stopReason: 'toolUse'
      }),
      R(3, 'p1', OK),
      R(4, 'l1', OK),
      R(5, 'p2', OK)
    ])
    expect(statuses(itemsThenAdvance.server)).toEqual(['completed', 'in_progress', 'pending'])
  })

  it('TLP-8 toolCallIds reused across messages (call_0 every time) agree call by call', () => {
    const { server } = expectParity([
      U(1, 'go'),
      ...planned(2, 'call_0', ITEMS),
      ...planned(4, 'call_0', ADVANCE),
      ...planned(6, 'call_0', ADVANCE),
      A(8, [text('done')])
    ])
    expect(statuses(server)).toEqual(['completed', 'completed', 'in_progress'])
  })

  it('TLP-9 a text-only card cut short by an abort does not count as ending with an answer; neither does an error without a message', () => {
    const entries = [U(1, 'go'), ...planned(2, 'p1', ITEMS)]
    for (const stopReason of ['aborted', 'error'] as const) {
      const { server, snapshot } = expectParity([
        ...entries,
        A(4, [text('partial')], 0, { stopReason })
      ])
      expect(server, stopReason).toEqual(ITEMS.items)
      expect(snapshot!.endedWithAnswer, stopReason).toBe(false)
    }
    const answered = expectParity([
      ...entries,
      A(4, [text('All done.')], 0, { stopReason: 'stop' })
    ])
    expect(answered.snapshot!.endedWithAnswer).toBe(true)
  })

  it('TLP-11 a user message with a cmd-token display starts a request on both sides', () => {
    const displays: DisplayByEntry = new Map([
      [4, display('run {{shuvixInlineToken:k1}} please', K1)]
    ])
    const cleared = expectParity(
      [U(1, 'go'), ...planned(2, 'p1', ITEMS), U(4, 'run PAYLOAD-K1 please'), A(5, [text('ok')])],
      displays
    )
    expect(cleared.server).toBeUndefined()
    const fresh = expectParity(
      [
        U(1, 'go'),
        ...planned(2, 'p1', ITEMS),
        U(4, 'run PAYLOAD-K1 please'),
        ...planned(5, 'p2', OTHER)
      ],
      displays
    )
    expect(fresh.server).toEqual(OTHER.items)
    expect(fresh.snapshot?.requestId).toBe('4')
  })

  it('TLP-12 a steer with an image and the note (array content, the display holds the note) starts no request on either side', () => {
    const noted = midRunNoteDisplay('look at this')
    const displays: DisplayByEntry = new Map([[4, display(noted.content, noted.tokens)]])
    const { server, snapshot } = expectParity(
      [
        U(1, 'go'),
        ...planned(2, 'p1', ITEMS),
        U(4, [text('look at this'), IMAGE, text(SUFFIX)]),
        ...planned(5, 'p2', ADVANCE)
      ],
      displays
    )
    expect(statuses(server)).toEqual(['completed', 'in_progress', 'pending'])
    expect(snapshot?.requestId).toBe('1')
  })
})
