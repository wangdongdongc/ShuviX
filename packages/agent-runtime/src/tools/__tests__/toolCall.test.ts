/**
 * 一次工具调用交给安全模块的归属（`callOwnerOf`）。signal 也在里面：只展开它、不另传 signal 的 PEP（glob / grep / ls /
 * 文档 / 知识库 ……），审查和询问卡片才会随这次调用一起收尾（中止一个子对话时不留下等着的审查，SCOPE-U4）。
 */
import { describe, expect, it } from 'vitest'
import { callOwnerOf, type ToolCallScope } from '../toolCall'

function scope(over: Partial<ToolCallScope> = {}): ToolCallScope {
  return { taskId: 7, conversationId: 3, ...over } as ToolCallScope
}

describe('callOwnerOf', () => {
  it('SCOPE-U4 carries the task, the conversation and the call signal', () => {
    const { signal } = new AbortController()
    expect(callOwnerOf(scope({ signal }))).toStrictEqual({ taskId: 7, conversationId: 3, signal })
  })

  it('SCOPE-U4 no signal on the call: no signal key, so spreading it cannot overwrite one with undefined', () => {
    expect(callOwnerOf(scope())).toStrictEqual({ taskId: 7, conversationId: 3 })
    expect('signal' in callOwnerOf(scope())).toBe(false)
  })

  it('SCOPE-U4 no scope at all: an empty object', () => {
    expect(callOwnerOf(undefined)).toStrictEqual({})
  })
})
