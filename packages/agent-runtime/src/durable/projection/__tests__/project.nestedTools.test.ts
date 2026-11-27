/**
 * Codemode Phase 1 · C. 嵌套工具调用（`pi.live.nestedTools`）视图投影（CM-PR-01..05）：
 *
 *   - CM-PR-01：`pending` / `running` / `sleeping` / `waiting` / `done` 及 `summary` 按 `parentCallId` 正确投影到 SessionView 与 AgentView
 *   - CM-PR-02：多个并行父调用各自拥有独立 `nestedCalls`，互不串扰
 *   - CM-PR-03：严格 JSON 约束 —— 无值为 `undefined` 的键；无嵌套调用时 `ToolRunView` 不含 `nestedCalls` 键
 *   - CM-PR-04：格式异常或 orphan（找不到父调用）条目安全跳过不抛错
 *   - CM-PR-05：`ProjectionMemo` 在 `tools` 与 `nestedTools` 引用未变时复用 `toolRuns`；仅 `nestedTools` 变化时失效并产出新对象
 */
import { describe, expect, it } from 'vitest'
import { ProjectionMemo } from '../project'
import { P, PA } from './support'

describe('Codemode Phase 1 · C. pi.live.nestedTools 投影', () => {
  it('CM-PR-01 所有状态（pending/running/sleeping/waiting/done）及 summary 按 parentCallId 投影到 SessionView 与 AgentView', () => {
    const live = {
      tools: [{ callId: 'cm-1', status: 'running' }],
      nestedTools: [
        { callId: 'n1', parentCallId: 'cm-1', name: 'read', status: 'pending' },
        { callId: 'n2', parentCallId: 'cm-1', name: 'grep', status: 'running' },
        { callId: 'n3', parentCallId: 'cm-1', name: 'bash', status: 'sleeping' },
        { callId: 'n4', parentCallId: 'cm-1', name: 'write', status: 'waiting' },
        {
          callId: 'n5',
          parentCallId: 'cm-1',
          name: 'edit',
          status: 'done',
          summary: { isError: false, durationMs: 42 }
        },
        {
          callId: 'n6',
          parentCallId: 'cm-1',
          name: 'boom',
          status: 'done',
          summary: { isError: true, durationMs: 17, error: 'disk full' }
        }
      ]
    }

    const expected = [
      { callId: 'n1', name: 'read', status: 'pending' },
      { callId: 'n2', name: 'grep', status: 'running' },
      { callId: 'n3', name: 'bash', status: 'sleeping' },
      { callId: 'n4', name: 'write', status: 'waiting' },
      { callId: 'n5', name: 'edit', status: 'done', isError: false, durationMs: 42 },
      {
        callId: 'n6',
        name: 'boom',
        status: 'done',
        isError: true,
        durationMs: 17,
        error: 'disk full'
      }
    ]

    const sessionView = P([], { live, runState: 'busy' })
    expect(sessionView.toolRuns['cm-1']?.nestedCalls).toStrictEqual(expected)

    const agentView = PA([], { live, runState: 'busy' })
    expect(agentView.toolRuns['cm-1']?.nestedCalls).toStrictEqual(expected)
  })

  it('CM-PR-02 多个并行父调用各自拥有独立的 nestedCalls，互不串扰', () => {
    const live = {
      tools: [
        { callId: 'call-A', status: 'running' },
        { callId: 'call-B', status: 'running' }
      ],
      nestedTools: [
        { callId: 'a1', parentCallId: 'call-A', name: 'read', status: 'done' },
        { callId: 'b1', parentCallId: 'call-B', name: 'grep', status: 'running' },
        { callId: 'a2', parentCallId: 'call-A', name: 'ls', status: 'pending' }
      ]
    }

    const view = P([], { live, runState: 'busy' })
    expect(view.toolRuns['call-A']?.nestedCalls).toStrictEqual([
      { callId: 'a1', name: 'read', status: 'done' },
      { callId: 'a2', name: 'ls', status: 'pending' }
    ])
    expect(view.toolRuns['call-B']?.nestedCalls).toStrictEqual([
      { callId: 'b1', name: 'grep', status: 'running' }
    ])
  })

  it('CM-PR-03 严格 JSON 约束：nestedCalls 与 ToolRunView 不含 undefined 键；无嵌套调用时不含 nestedCalls 键', () => {
    const live = {
      tools: [
        { callId: 'with-nested', status: 'running' },
        { callId: 'without-nested', status: 'running' }
      ],
      nestedTools: [
        {
          callId: 'n1',
          parentCallId: 'with-nested',
          name: 'read',
          status: 'done',
          summary: { isError: undefined, durationMs: undefined, error: undefined }
        }
      ]
    }

    // P() 与 PA() 内部已执行 expectJsonView（严格 JSON + JSON 往返深相等）
    const view = P([], { live, runState: 'busy' })
    const withNested = view.toolRuns['with-nested']!
    const withoutNested = view.toolRuns['without-nested']!

    expect('nestedCalls' in withoutNested).toBe(false)
    expect(withNested.nestedCalls).toHaveLength(1)
    const nested = withNested.nestedCalls![0]!
    expect(Object.keys(nested).sort()).toEqual(['callId', 'name', 'status'])
    for (const value of Object.values(nested)) {
      expect(value).not.toBeUndefined()
    }
  })

  it('CM-PR-04 格式异常或 orphan（parentCallId 不存在）的 nestedTools 条目安全跳过不抛错', () => {
    const live = {
      tools: [{ callId: 'parent-1', status: 'running' }],
      nestedTools: [
        null,
        undefined,
        'not-an-object',
        42,
        { parentCallId: 'parent-1', name: 'no-callId', status: 'running' },
        { callId: 'x1', name: 'no-parent', status: 'running' },
        { callId: 'x2', parentCallId: 'parent-1', status: 'running' },
        { callId: 'x3', parentCallId: 'parent-1', name: 'bad-status', status: 'unknown' },
        { callId: 'orphan', parentCallId: 'missing-parent', name: 'read', status: 'done' },
        {
          callId: 'valid',
          parentCallId: 'parent-1',
          name: 'ping',
          status: 'done',
          summary: { isError: 'not-bool', durationMs: 'not-num', error: 123 }
        }
      ]
    }

    const view = P([], { live, runState: 'busy' })
    expect(view.toolRuns['parent-1']?.nestedCalls).toStrictEqual([
      { callId: 'valid', name: 'ping', status: 'done' }
    ])
    expect(view.toolRuns['missing-parent']).toBeUndefined()

    // nestedTools 不是数组时同样安全跳过
    const nonArrayView = P([], {
      live: { tools: [{ callId: 'p', status: 'running' }], nestedTools: 'broken' },
      runState: 'busy'
    })
    expect('nestedCalls' in nonArrayView.toolRuns['p']!).toBe(false)
  })

  it('CM-PR-05 ProjectionMemo：tools 与 nestedTools 引用未变时复用 toolRuns；仅 nestedTools 变化时失效并产出新对象', () => {
    const memo = new ProjectionMemo()
    const tools = [{ callId: 'cm-1', status: 'running' }]
    const nested1 = [{ callId: 'n1', parentCallId: 'cm-1', name: 'read', status: 'running' }]

    const v1 = P([], { live: { tools, nestedTools: nested1 }, runState: 'busy', memo })
    // 同一对 tools 与 nestedTools 引用（即使外层 live 是新对象）→ 复用 toolRuns
    const v2 = P([], { live: { tools, nestedTools: nested1 }, runState: 'busy', memo })
    expect(v2.toolRuns).toBe(v1.toolRuns)

    // 仅 nestedTools 换新引用（tools 引用不变）→ 失效并产出新 toolRuns
    const nested2 = [
      {
        callId: 'n1',
        parentCallId: 'cm-1',
        name: 'read',
        status: 'done',
        summary: { isError: false, durationMs: 12 }
      }
    ]
    const v3 = P([], { live: { tools, nestedTools: nested2 }, runState: 'busy', memo })
    expect(v3.toolRuns).not.toBe(v1.toolRuns)
    expect(v3.toolRuns['cm-1']?.nestedCalls).toStrictEqual([
      { callId: 'n1', name: 'read', status: 'done', isError: false, durationMs: 12 }
    ])
  })
})
