/**
 * 任务列表的 server 侧读者（docs/task-list-design.md §3.2）—— 纯 `taskListEventsOfEntries`：手写条目 → 折叠事件。
 *
 *   TLR-1     user 开一个请求；列表调用 + 没出错的结果 = 一次更新（参数原样）
 *   TLR-2/3/4 哪些 user 条目不开请求（通知形状、空回复追问、通知条目、压缩、带插话说明的）、哪些照开
 *   TLR-5/6   哪些结果不算更新（出错、别的工具、孤儿、先于调用）；失败轮里的调用不登记
 *   TLR-7..9  `before`：只跳过转写里最后一个带这个 id 的列表调用，其余照折（同一条消息里排在前面的兄弟调用、
 *             重用 id 的更早调用都算）
 *   TLR-10/11 一条消息里两次调用按块序；同一 id 再登记以新的为准；多个请求只剩最后一个的列表
 *
 * 会话上的真流程（条目在工具执行前已落定、插话、回退）在 taskListReader.session.test.ts；与界面折叠的对照在
 * taskListParity.test.ts。
 */
import type { EntryRecord, JsonObject } from '@earendil-works/pi-durable'
import { MID_RUN_NOTE_SEPARATOR, MID_RUN_NOTE_TEXT } from '@shuvix/chat-protocol/midRunNote'
import {
  foldTaskList,
  TASK_LIST_TOOL_NAME,
  type TaskListEvent
} from '@shuvix/chat-protocol/taskList'
import { describe, expect, it } from 'vitest'
import { EMPTY_REPLY_NOTICE_TEXT } from '../emptyReply'
import { taskListEventsOfEntries } from '../taskListReader'
import { A, C, IMAGE, N, R, U, bg, call, text, wrap } from '../projection/__tests__/support'

const PLAN = TASK_LIST_TOOL_NAME
const NOTE = MID_RUN_NOTE_TEXT
const SUFFIX = `${MID_RUN_NOTE_SEPARATOR}${NOTE}`

const ITEMS_A: JsonObject = {
  items: [
    { content: 'Read the code', status: 'in_progress' },
    { content: 'Fix it', status: 'pending' },
    { content: 'Test it', status: 'pending' }
  ]
}
const ITEMS_B: JsonObject = { items: [{ content: 'Other plan', status: 'in_progress' }] }
const ADVANCE: JsonObject = { advance: true }

const ok = [text('Plan shown (3 steps).')]
const REQUEST: TaskListEvent = { type: 'request' }
const update = (args: unknown): TaskListEvent => ({ type: 'update', args })

/** 一条 assistant 里的一次列表调用 + 它的成功结果 */
const planned = (id: number, callId: string, args: JsonObject): EntryRecord[] => [
  A(id, [call(PLAN, args, callId)], 0, { stopReason: 'toolUse' }),
  R(id + 1, callId, ok)
]

describe('TLR · taskListEventsOfEntries', () => {
  it('TLR-1 a user message opens a request; a plan call with an ok result is one update carrying its args', () => {
    expect(taskListEventsOfEntries([U(1, 'go')])).toStrictEqual([REQUEST])
    const events = taskListEventsOfEntries([U(1, 'go'), ...planned(2, 'c1', ITEMS_A)])
    expect(events).toStrictEqual([REQUEST, update(ITEMS_A)])
    // 参数原样交给折叠（深相等）：折出的就是那张列表
    expect(foldTaskList(events)).toEqual(ITEMS_A.items)
    // 没有 user 条目：调用照样折（请求边界之外的调用不丢）
    expect(taskListEventsOfEntries(planned(1, 'c1', ITEMS_A))).toStrictEqual([update(ITEMS_A)])
  })

  it('TLR-2 no request: notice-shaped pi.user (background-task, session), the empty-reply nudge, a shuvix.notice entry, a compaction', () => {
    const quiet: EntryRecord[] = [
      U(10, bg('t1', 'done')),
      U(11, '<session id="s2" status="done">ok</session>'),
      U(12, EMPTY_REPLY_NOTICE_TEXT),
      N(13, 'the background task finished'),
      C(14, 1, wrap('summary'))
    ]
    for (const entry of quiet) {
      expect(taskListEventsOfEntries([entry]), String(entry.id)).toStrictEqual([])
    }
    // 夹在两次调用之间：列表留着
    const events = taskListEventsOfEntries([
      U(1, 'go'),
      ...planned(2, 'c1', ITEMS_A),
      ...quiet,
      ...planned(20, 'c2', ADVANCE)
    ])
    expect(events).toStrictEqual([REQUEST, update(ITEMS_A), update(ADVANCE)])
  })

  it('TLR-3 no request: a pi.user whose text ends with the mid-run note, as a string or as text blocks around an image', () => {
    expect(taskListEventsOfEntries([U(1, `pivot${SUFFIX}`)])).toStrictEqual([])
    expect(taskListEventsOfEntries([U(1, SUFFIX)])).toStrictEqual([])
    expect(
      taskListEventsOfEntries([U(1, [text('S'), IMAGE, text(SUFFIX)])]),
      'image between the text and the note'
    ).toStrictEqual([])
  })

  it('TLR-4 still a request: the note in the middle, the note without the separator, the note after a single newline', () => {
    for (const content of [
      `before ${NOTE} after`,
      `S${NOTE}`,
      NOTE,
      `S\n${NOTE}`,
      `\n${NOTE}`,
      `S${SUFFIX} and more`
    ]) {
      expect(taskListEventsOfEntries([U(1, content)]), JSON.stringify(content)).toStrictEqual([
        REQUEST
      ])
    }
  })

  it('TLR-5 no update: an isError result, a result for a non-plan call, an orphan result, a result before its call', () => {
    const failed = taskListEventsOfEntries([
      A(1, [call(PLAN, ADVANCE, 'c1')], 0, { stopReason: 'toolUse' }),
      R(2, 'c1', [text('No task list in this request yet')], { isError: true })
    ])
    expect(failed).toStrictEqual([])
    const otherTool = taskListEventsOfEntries([
      A(1, [call('ls', {}, 'l1'), call('mcp__plan__other', ITEMS_A, 'o1')], 0, {
        stopReason: 'toolUse'
      }),
      R(2, 'l1', ok),
      R(3, 'o1', ok)
    ])
    expect(otherTool).toStrictEqual([])
    const orphan = taskListEventsOfEntries([R(1, 'ghost', ok)])
    expect(orphan).toStrictEqual([])
    const early = taskListEventsOfEntries([
      R(1, 'c1', ok),
      A(2, [call(PLAN, ITEMS_A, 'c1')], 0, { stopReason: 'toolUse' })
    ])
    expect(early).toStrictEqual([])
  })

  it('TLR-6 an error entry with an errorMessage registers none of its plan calls; without an errorMessage (or an empty one) it does', () => {
    const withMessage = taskListEventsOfEntries([
      A(1, [call(PLAN, ITEMS_A, 'c1')], 0, { stopReason: 'error', errorMessage: 'boom' }),
      R(2, 'c1', ok)
    ])
    expect(withMessage).toStrictEqual([])
    for (const options of [
      { stopReason: 'error' as const },
      { stopReason: 'error' as const, errorMessage: '' }
    ]) {
      const events = taskListEventsOfEntries([
        A(1, [call(PLAN, ITEMS_A, 'c1')], 0, options),
        R(2, 'c1', ok)
      ])
      expect(events, JSON.stringify(options)).toStrictEqual([update(ITEMS_A)])
    }
  })

  it('TLR-7 before: that call is skipped (its result too) while the rest of the transcript keeps folding; an unknown or absent id skips nothing', () => {
    const entries = [
      U(1, 'go'),
      ...planned(2, 'c1', ITEMS_A),
      ...planned(4, 'c2', ADVANCE),
      U(6, 'next request'),
      ...planned(7, 'c3', ITEMS_B)
    ]
    const all = [REQUEST, update(ITEMS_A), update(ADVANCE), REQUEST, update(ITEMS_B)]
    expect(taskListEventsOfEntries(entries, 'c2')).toStrictEqual([
      REQUEST,
      update(ITEMS_A),
      REQUEST,
      update(ITEMS_B)
    ])
    expect(taskListEventsOfEntries(entries, 'nope')).toStrictEqual(all)
    expect(taskListEventsOfEntries(entries, undefined)).toStrictEqual(all)
    expect(taskListEventsOfEntries(entries)).toStrictEqual(all)
    // 只认列表调用：别的工具碰巧叫这个 id，不影响
    const shared = [
      U(1, 'go'),
      A(2, [call('ls', {}, 'x1'), call(PLAN, ITEMS_A, 'x2')], 0, { stopReason: 'toolUse' }),
      R(3, 'x1', ok),
      R(4, 'x2', ok)
    ]
    expect(taskListEventsOfEntries(shared, 'x1')).toStrictEqual([REQUEST, update(ITEMS_A)])
  })

  it('TLR-8 before = the second plan call of one assistant message: the first one’s result, committed after that message, still counts', () => {
    const entries = [
      U(1, 'go'),
      A(2, [call(PLAN, ITEMS_A, 'c1'), call(PLAN, ADVANCE, 'c2')], 0, { stopReason: 'toolUse' }),
      R(3, 'c1', ok)
    ]
    const events = taskListEventsOfEntries(entries, 'c2')
    expect(events).toStrictEqual([REQUEST, update(ITEMS_A)])
    expect(foldTaskList(events)).toEqual(ITEMS_A.items)
  })

  it('TLR-9 a reused toolCallId: before stops at the latest call carrying it, the older one folds normally', () => {
    const entries = [
      U(1, 'go'),
      ...planned(2, 'k:0', ITEMS_A),
      A(4, [call(PLAN, ADVANCE, 'k:0')], 0, { stopReason: 'toolUse' })
    ]
    const events = taskListEventsOfEntries(entries, 'k:0')
    expect(events).toStrictEqual([REQUEST, update(ITEMS_A)])
    expect(foldTaskList(events)).toEqual(ITEMS_A.items)
    // 三次都叫同一个 id：正在执行的是最后一次，前两次都算
    const three = [
      ...entries,
      R(5, 'k:0', ok),
      A(6, [call(PLAN, ADVANCE, 'k:0')], 0, { stopReason: 'toolUse' })
    ]
    expect(taskListEventsOfEntries(three, 'k:0')).toStrictEqual([
      REQUEST,
      update(ITEMS_A),
      update(ADVANCE)
    ])
  })

  it('TLR-10 two plan calls in one entry, both answered: two updates in block order; an id registered twice pairs its one result with the most recent call', () => {
    const both = taskListEventsOfEntries([
      A(1, [call(PLAN, ITEMS_A, 'c1'), call(PLAN, ADVANCE, 'c2')], 0, { stopReason: 'toolUse' }),
      R(2, 'c1', ok),
      R(3, 'c2', ok)
    ])
    expect(both).toStrictEqual([update(ITEMS_A), update(ADVANCE)])
    const reregistered = taskListEventsOfEntries([
      A(1, [call(PLAN, ITEMS_A, 'x')], 0, { stopReason: 'toolUse' }),
      A(2, [call(PLAN, ITEMS_B, 'x')], 0, { stopReason: 'toolUse' }),
      R(3, 'x', ok)
    ])
    expect(reregistered).toStrictEqual([update(ITEMS_B)])
    // 配过的那次调用不会再被同一 id 的第二个结果配上
    const twice = taskListEventsOfEntries([
      A(1, [call(PLAN, ITEMS_A, 'x')], 0, { stopReason: 'toolUse' }),
      R(2, 'x', ok),
      R(3, 'x', ok)
    ])
    expect(twice).toStrictEqual([update(ITEMS_A)])
  })

  it('TLR-11 several requests: the fold keeps only the last request’s list', () => {
    const events = taskListEventsOfEntries([
      U(1, 'first'),
      ...planned(2, 'c1', ITEMS_A),
      U(4, 'second'),
      ...planned(5, 'c2', ITEMS_B),
      ...planned(7, 'c3', ADVANCE)
    ])
    expect(events).toStrictEqual([
      REQUEST,
      update(ITEMS_A),
      REQUEST,
      update(ITEMS_B),
      update(ADVANCE)
    ])
    expect(foldTaskList(events)).toEqual([{ content: 'Other plan', status: 'completed' }])
    // 最后一个请求里还没有列表 → undefined（前一个请求的不会漏过来）
    expect(
      foldTaskList(
        taskListEventsOfEntries([U(1, 'first'), ...planned(2, 'c1', ITEMS_A), U(4, 'second')])
      )
    ).toBeUndefined()
  })
})
