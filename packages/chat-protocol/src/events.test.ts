/**
 * P3-08-43 —— ChatEvent 缩成余项之后的类型层契约：
 *  - `ChatEvent['type']` 恰好是余项那几种（一份 `Record<type, true>` 字面量：多一种少一种都编译不过）；
 *  - `agent_end` 不带 message / usage，`reason` 必填（PIN-18）；
 *  - `ChatTokenUsage` / `ChatQueuedMessage` 不再导出。
 *
 * 解读：设计稿列的是 12 种；PIN-01 的裁决（`ask_count {sessionId, count}` 余项）再加一种 —— 一共 13 种。
 */
import { describe, expect, expectTypeOf, it } from 'vitest'
import type { ChatAgentEndEvent, ChatEvent } from './events'
// @ts-expect-error ChatTokenUsage 已删（用量在视图与 message.list 里）
import type { ChatTokenUsage } from './events'
// @ts-expect-error ChatQueuedMessage 已删（队列在视图里）
import type { ChatQueuedMessage } from './events'

const RESIDUE: Record<ChatEvent['type'], true> = {
  agent_start: true,
  agent_end: true,
  tool_review: true,
  runtime_event: true,
  browser_event: true,
  sub_session_register: true,
  sub_session_end: true,
  bg_task: true,
  agent_created: true,
  agent_closing: true,
  mcp_connecting: true,
  error: true,
  ask_count: true
}

describe('P3-08-43 ChatEvent 余项', () => {
  it('类型恰好是这 13 种', () => {
    expect(Object.keys(RESIDUE).sort()).toEqual(
      [
        'agent_closing',
        'agent_created',
        'agent_end',
        'agent_start',
        'ask_count',
        'bg_task',
        'browser_event',
        'error',
        'mcp_connecting',
        'runtime_event',
        'sub_session_end',
        'sub_session_register',
        'tool_review'
      ].sort()
    )
    expectTypeOf<'text_delta'>().not.toMatchTypeOf<ChatEvent['type']>()
    expectTypeOf<'user_message'>().not.toMatchTypeOf<ChatEvent['type']>()
    expectTypeOf<'input_request'>().not.toMatchTypeOf<ChatEvent['type']>()
    expectTypeOf<'queue_update'>().not.toMatchTypeOf<ChatEvent['type']>()
  })

  it('agent_end：reason 必填，没有 message / usage', () => {
    const end: ChatAgentEndEvent = { type: 'agent_end', sessionId: 's1', reason: 'ok' }
    // @ts-expect-error message 已删
    void end.message
    // @ts-expect-error usage 已删
    void end.usage
    // @ts-expect-error reason 必填（PIN-18）
    const missing: ChatAgentEndEvent = { type: 'agent_end', sessionId: 's1' }
    expect(missing.type).toBe('agent_end')
    expectTypeOf<ChatAgentEndEvent['reason']>().toEqualTypeOf<'ok' | 'aborted' | 'error'>()
  })

  it('已删的辅助类型导不出（编译期，见文件头的 @ts-expect-error）', () => {
    expectTypeOf<ChatTokenUsage>().toBeAny()
    expectTypeOf<ChatQueuedMessage>().toBeAny()
  })
})
