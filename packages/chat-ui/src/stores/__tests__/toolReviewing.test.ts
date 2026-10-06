/**
 * 工具卡「审查中」的 store 一半（P3-08 起：执行记录由视图派生，`reviewing` 是 `tool_review` 事件的本地
 * 叠加，PIN-04）—— `setToolReviewing` 写叠加，`applySessionView` 把它叠到派生出的执行记录上。
 *
 * 钉的是几件 UI 上看不出、坏了却很贵的事：
 *   - **事件可能先于工具进度到**（F4）：先记下，视图里一出现那次调用就叠上（ST-4 反过来了）；
 *   - **不碰卡片**：messages 引用不变（卡片的重渲染由它驱动，审查中的来回不该让整张卡片重画）；
 *   - **值没变就不换引用**：zustand 按引用判等，重复置真 / 对从未审查的记录置假若每次都造新对象，
 *     整条对话流跟着白白重渲染；
 *   - **按会话隔离、不看当前会话**：后台会话里的审查照样记，切过去就看得见；
 *   - **结束即收**：工具做完（`toolRuns` 到 done）或本轮结束（视图离开 busy）把叠加清掉 —— 落定事件万一
 *     丢了也不留一个永远在转的标记。
 *
 * 不起 jsdom：纯 store 读写（同 pendingPrompt.test.ts）。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { SessionView, ToolRunView } from '@shuvix/chat-protocol/types/sessionView'
import { applySessionView, type ToolExecution } from '../chatStore'
import { V, assistant, resetStore, store, toolBlock } from '../../__tests__/support/views'

const A = 'sess-A'
const B = 'sess-B'

beforeEach(() => {
  resetStore(A)
})

/** 一份在跑的视图：每个 id 一个工具块（落在一张卡上）+ 对应的工具进度 */
function running(
  sessionId: string,
  runs: Record<string, ToolRunView['status']>,
  results: Record<string, { result?: string; isError?: boolean }> = {}
): SessionView {
  const ids = Object.keys(runs)
  return V(sessionId, {
    messages: [
      assistant(
        'a1',
        ids.map((id) => toolBlock(id, 'bash', { command: 'rm -rf build' }, results[id] ?? {})),
        sessionId
      )
    ],
    toolRuns: Object.fromEntries(ids.map((id) => [id, { status: runs[id] }])),
    run: { state: 'busy' }
  })
}

const recordOf = (sessionId: string, toolCallId: string): ToolExecution | undefined =>
  store().sessionToolExecutions[sessionId]?.find((t) => t.toolCallId === toolCallId)

describe('setToolReviewing — 派生执行记录上的「审查中」（PIN-04 叠加）', () => {
  it('ST-1 工具在跑：置真 / 置假反映到那条记录上', () => {
    applySessionView(A, running(A, { 'tc-1': 'running' }))
    store().setToolReviewing(A, 'tc-1', true)
    expect(recordOf(A, 'tc-1')?.reviewing).toBe(true)
    store().setToolReviewing(A, 'tc-1', false)
    expect(recordOf(A, 'tc-1')?.reviewing).toBeFalsy()
  })

  it.each([
    ['done', undefined],
    ['error', true]
  ] as const)('ST-2 工具做完（%s）→ 叠加一并清掉，记录不再是「审查中」', (status, isError) => {
    applySessionView(A, running(A, { 'tc-1': 'running' }))
    store().setToolReviewing(A, 'tc-1', true)
    applySessionView(
      A,
      running(A, { 'tc-1': 'done' }, { 'tc-1': { result: 'x', ...(isError ? { isError } : {}) } })
    )
    const rec = recordOf(A, 'tc-1')
    expect(rec?.status).toBe(status)
    expect(rec?.reviewing).toBeFalsy()
    expect(store().sessionToolReviewing[A]).toBeUndefined()
  })

  it('ST-3 没有视图 / 不在工具进度里的调用：只记叠加，执行记录引用不变、不新建键', () => {
    const before = store().sessionToolExecutions
    store().setToolReviewing(A, 'tc-1', true)
    expect(store().sessionToolExecutions).toBe(before)
    expect(A in store().sessionToolExecutions).toBe(false)

    applySessionView(A, running(A, { 'tc-1': 'running' }))
    const withRecord = store().sessionToolExecutions
    const list = withRecord[A]
    store().setToolReviewing(A, 'tc-other', true)
    expect(store().sessionToolExecutions[A]).toEqual(list)
    expect(recordOf(A, 'tc-other')).toBeUndefined()
  })

  it('ST-4 / P3-08-41 早于工具进度的事件被记下：之后出现的记录 reviewing 为真（ST-4 反过来）', () => {
    store().setToolReviewing(A, 'tc-1', true)
    applySessionView(A, running(A, { 'tc-1': 'running' }))
    expect(recordOf(A, 'tc-1')?.reviewing).toBe(true)
  })

  it('ST-5 不碰卡片：messages 引用不变', () => {
    applySessionView(A, running(A, { 'tc-1': 'running' }))
    const messages = store().messages
    store().setToolReviewing(A, 'tc-1', true)
    store().setToolReviewing(A, 'tc-1', false)
    expect(store().messages).toBe(messages)
  })

  it('ST-6 值没变就不换引用：连发两次 true 第二次不换；对从未审查的记录发 false 不换、也不写出 reviewing 键', () => {
    applySessionView(A, running(A, { 'tc-1': 'running', 'tc-2': 'running' }))

    store().setToolReviewing(A, 'tc-1', true)
    const afterFirst = store().sessionToolExecutions
    store().setToolReviewing(A, 'tc-1', true)
    expect(store().sessionToolExecutions).toBe(afterFirst)

    store().setToolReviewing(A, 'tc-2', false)
    expect(store().sessionToolExecutions).toBe(afterFirst)
    expect('reviewing' in recordOf(A, 'tc-2')!).toBe(false)
  })

  it('ST-7 按会话隔离、不看当前会话：当前是 A，B 里的记录照样置真；A 里同名调用不受影响', () => {
    applySessionView(A, running(A, { 'tc-1': 'running' }))
    applySessionView(B, running(B, { 'tc-1': 'running' }))
    expect(store().activeSessionId).toBe(A)

    store().setToolReviewing(B, 'tc-1', true)
    expect(recordOf(B, 'tc-1')?.reviewing).toBe(true)
    expect(recordOf(A, 'tc-1')?.reviewing).toBeFalsy()
  })

  it('ST-8 同一会话里其它记录的对象身份不变', () => {
    applySessionView(A, running(A, { 'tc-1': 'running', 'tc-2': 'running' }))
    const other = recordOf(A, 'tc-2')
    store().setToolReviewing(A, 'tc-1', true)
    expect(recordOf(A, 'tc-2')).toBe(other)
  })

  it('ST-9 本轮结束（视图离开 busy）→ 该会话的叠加整体清掉；别的会话不动', () => {
    applySessionView(A, running(A, { 'tc-1': 'running' }))
    applySessionView(B, running(B, { 'tc-1': 'running' }))
    store().setToolReviewing(A, 'tc-1', true)
    store().setToolReviewing(B, 'tc-1', true)

    applySessionView(A, { ...running(A, { 'tc-1': 'running' }), run: { state: 'idle' } })
    expect(store().sessionToolReviewing[A]).toBeUndefined()
    expect(recordOf(A, 'tc-1')?.reviewing).toBeFalsy()
    expect(recordOf(B, 'tc-1')?.reviewing).toBe(true)
  })
})
