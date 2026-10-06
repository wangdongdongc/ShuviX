/**
 * P3-11-09（类型层）—— 排队输入在契约里的样子：
 *  - `SessionChannelApi['agent']['withdrawQueued']` = `({sessionId, submissionId}) => Promise<{result}>`，
 *    result 是四种之一（`closed` 不出现在契约里：网关收成 `not_found`，PIN-14）；
 *  - 「下一轮」那一档去掉了（Q-P3-09）：`agent.nextTurn` 与 `AgentNextTurnParams` 都不在。
 *
 * 断言都在编译期；运行时只跑一条恒真的样本，让 vitest 收得到它。
 */
import { describe, expect, expectTypeOf, it } from 'vitest'
import type {
  AgentWithdrawQueuedParams,
  SessionChannelApi,
  WithdrawQueuedResult
} from './chatApi'
// @ts-expect-error AgentNextTurnParams is gone end to end (Q-P3-09)
import type { AgentNextTurnParams } from './chatApi'

describe('P3-11-09 chat-protocol 的撤回契约', () => {
  it('P3-11-09 withdrawQueued 的形状；没有 nextTurn', () => {
    expectTypeOf<SessionChannelApi['agent']['withdrawQueued']>().toEqualTypeOf<
      (params: {
        sessionId: string
        submissionId: number
      }) => Promise<{ result: 'aborted' | 'already_placed' | 'settled' | 'not_found' }>
    >()
    expectTypeOf<AgentWithdrawQueuedParams>().toEqualTypeOf<{
      sessionId: string
      submissionId: number
    }>()
    expectTypeOf<'closed'>().not.toMatchTypeOf<WithdrawQueuedResult>()
    // @ts-expect-error nextTurn is gone end to end (Q-P3-09)
    expectTypeOf<SessionChannelApi['agent']['nextTurn']>().toBeAny()
    expectTypeOf<AgentNextTurnParams>().toBeAny()
    const sample: WithdrawQueuedResult = 'already_placed'
    expect(sample).toBe('already_placed')
  })
})
