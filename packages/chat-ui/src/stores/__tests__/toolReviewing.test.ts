/**
 * 工具卡「审查中」的 store 一半 —— `tool_review` 事件经 `setToolReviewing` 改执行记录上的
 * `reviewing`，`handleToolEnd` 一并收掉。
 *
 * 钉的是几件 UI 上看不出、坏了却很贵的事：
 *   - **只改已有的执行记录**：早于 tool_start 的事件不缓存、不凭空建记录（卡片由 tool_start 建）；
 *   - **不碰卡片**：messages 引用不变（卡片的重渲染由它驱动，审查中的来回不该让整张卡片重画）；
 *   - **值没变就不换引用**：zustand 按引用判等，重复置真 / 对从未审查的记录置假若每次都造新对象，
 *     整条对话流跟着白白重渲染；
 *   - **按会话隔离、不看当前会话**：后台会话里的审查照样记，切过去就看得见；
 *   - **结束即收**：tool_end（不论成败）把 reviewing 收成假 —— 落定事件万一丢了也不留一个永远在
 *     转的标记；finishStreaming 整体清掉该会话的记录。
 *
 * 不起 jsdom：纯 store 读写（同 pendingPrompt.test.ts）。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { useChatStore, type ToolExecution } from '../chatStore'

const A = 'sess-A'
const B = 'sess-B'

beforeEach(() => {
  useChatStore.setState({
    activeSessionId: A,
    sessionToolExecutions: {},
    sessionPendingInputs: {},
    sessionStreams: {},
    messages: []
  })
})

const state = (): ReturnType<typeof useChatStore.getState> => useChatStore.getState()

const exec = (toolCallId: string, extra: Partial<ToolExecution> = {}): ToolExecution => ({
  toolCallId,
  toolName: 'bash',
  args: { command: 'rm -rf build' },
  status: 'running',
  ...extra
})

const recordOf = (sessionId: string, toolCallId: string): ToolExecution | undefined =>
  state().sessionToolExecutions[sessionId]?.find((t) => t.toolCallId === toolCallId)

describe('setToolReviewing — 执行记录上的「审查中」', () => {
  it('ST-1 tool_start 之后置真 / 置假反映到那条记录上', () => {
    state().handleToolStart(A, exec('tc-1'))
    state().setToolReviewing(A, 'tc-1', true)
    expect(recordOf(A, 'tc-1')?.reviewing).toBe(true)
    state().setToolReviewing(A, 'tc-1', false)
    expect(recordOf(A, 'tc-1')?.reviewing).toBe(false)
  })

  it.each(['done', 'error'] as const)(
    'ST-2 handleToolEnd(%s) 一并把 reviewing 收成假',
    (status) => {
      state().handleToolStart(A, exec('tc-1'))
      state().setToolReviewing(A, 'tc-1', true)
      state().handleToolEnd(A, 'tc-1', { status, result: 'x' })
      const rec = recordOf(A, 'tc-1')
      expect(rec?.status).toBe(status)
      expect(rec?.reviewing).toBe(false)
    }
  )

  it('ST-3 找不到执行记录就什么也不做：会话无记录 → 引用不变、不新建键；toolCallId 不在其中 → 引用不变', () => {
    const before = state().sessionToolExecutions
    state().setToolReviewing(A, 'tc-1', true)
    expect(state().sessionToolExecutions).toBe(before)
    expect(A in state().sessionToolExecutions).toBe(false)

    state().handleToolStart(A, exec('tc-1'))
    const withRecord = state().sessionToolExecutions
    const list = withRecord[A]
    state().setToolReviewing(A, 'tc-other', true)
    expect(state().sessionToolExecutions).toBe(withRecord)
    expect(state().sessionToolExecutions[A]).toBe(list)
  })

  it('ST-4 早于 tool_start 的事件不缓存：之后建出的记录 reviewing 为假', () => {
    state().setToolReviewing(A, 'tc-1', true)
    state().handleToolStart(A, exec('tc-1'))
    expect(recordOf(A, 'tc-1')?.reviewing).toBeFalsy()
  })

  it('ST-5 不碰卡片：messages 引用不变', () => {
    state().handleToolStart(A, exec('tc-1'))
    const messages = state().messages
    state().setToolReviewing(A, 'tc-1', true)
    state().setToolReviewing(A, 'tc-1', false)
    expect(state().messages).toBe(messages)
  })

  it('ST-6 值没变就不换引用：连发两次 true 第二次不换；对从未审查的记录发 false 不换、也不写出 reviewing 键', () => {
    state().handleToolStart(A, exec('tc-1'))
    state().handleToolStart(A, exec('tc-2'))

    state().setToolReviewing(A, 'tc-1', true)
    const afterFirst = state().sessionToolExecutions
    state().setToolReviewing(A, 'tc-1', true)
    expect(state().sessionToolExecutions).toBe(afterFirst)

    state().setToolReviewing(A, 'tc-2', false)
    expect(state().sessionToolExecutions).toBe(afterFirst)
    expect('reviewing' in recordOf(A, 'tc-2')!).toBe(false)
  })

  it('ST-7 按会话隔离、不看当前会话：当前是 A，B 里的记录照样置真；A 里同名调用不受影响', () => {
    state().handleToolStart(A, exec('tc-1'))
    state().handleToolStart(B, exec('tc-1'))
    expect(state().activeSessionId).toBe(A)

    state().setToolReviewing(B, 'tc-1', true)
    expect(recordOf(B, 'tc-1')?.reviewing).toBe(true)
    expect(recordOf(A, 'tc-1')?.reviewing).toBeFalsy()
  })

  it('ST-8 同一会话里其它记录的对象身份不变', () => {
    state().handleToolStart(A, exec('tc-1'))
    state().handleToolStart(A, exec('tc-2'))
    const other = recordOf(A, 'tc-2')
    state().setToolReviewing(A, 'tc-1', true)
    expect(recordOf(A, 'tc-2')).toBe(other)
  })

  it('ST-9 finishStreaming 之后该会话的记录整体消失（别的会话不动）', () => {
    state().handleToolStart(A, exec('tc-1'))
    state().handleToolStart(B, exec('tc-1'))
    state().setToolReviewing(A, 'tc-1', true)

    state().finishStreaming(A)
    expect(A in state().sessionToolExecutions).toBe(false)
    expect(recordOf(B, 'tc-1')).toBeDefined()
  })
})
