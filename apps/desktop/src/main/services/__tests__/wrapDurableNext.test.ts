/**
 * P2-04（docs/pi-durable/p2-04-test-design.md，P2-04-24…27）—— 结果契约的 `next` 经桌面包装器
 * （`wrapDurableTool`）：L1 全工具门照过（P2-02 PIN-14：next 没有豁免），门的每种结局都不让 NextTool 捕获，
 * 放行之后 `details: {result}` 与 `control: {terminate}` 原样透出（审查放行的标记并进 details，读的一侧
 * `nextResultOf` 容忍它）。
 *
 * 安全门面的布置抄自 wrapToolOutputReview.test.ts 的 `makeSecurity`（真 createSecurityContext + 一条让每次
 * 调用都走 ask 档的用户策略「tool-gate」），这里直接调 `wrapDurableTool`（PIN-10：位置参数的 wrapToolOutput
 * 壳要删）。NextTool 是真的（`resultContractTools`）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EntryRecord } from '@earendil-works/pi-durable'
import {
  clearReviewState,
  clearSessionDecisions,
  createSecurityContext,
  nextResultOf,
  resultContractTools,
  type PermissionReviewAnswer,
  type SecurityContext,
  type SecurityHostProvider,
  type UserPolicyFile
} from '@shuvix/agent-runtime'
import { createInlinePolicyMdReader } from '@shuvix/agent-runtime/security/builtinPolicies/inlineSources'
import { invokeTool, resultText } from '@shuvix/agent-runtime/tools/testing/invokeTool'
import type { InputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'

vi.mock('../toolContext', () => ({ TOOL_ABORTED: 'Aborted' }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))
import { wrapDurableTool } from '../wrapToolOutput'

const SID = 'wrap-durable-next-session'
const INLINE_POLICY_MD = createInlinePolicyMdReader()

/** 结果契约的 schema（与 support/toolHostFixtures 的 S 相同） */
const S = { type: 'object', required: ['title'], properties: { title: { type: 'string' } } }

afterEach(() => {
  clearReviewState(SID)
  clearSessionDecisions(SID)
})

type Reviewer = NonNullable<SecurityHostProvider['onPermissionRequest']>

/**
 * 让每次工具调用（invocation）都走 ask 档的用户策略。规则不带条件 = 不约束任何维度（W-R 那份字面量里的
 * `object` 键不是 PolicyRuleSpec 的字段、引擎本来就不看它 —— 效果相同，这里按类型写）。
 */
const TOOL_GATE: UserPolicyFile = {
  name: 'tool-gate',
  displayName: 'tool-gate',
  description: '',
  rules: [{ effect: 'ask' }],
  body: ''
}

/**
 * 真 createSecurityContext（wrapToolOutputReview 的 makeSecurity）：`responses` 按次序回答询问（用完回
 * 允许），`policies` 缺省就是 tool-gate。
 */
function makeSecurity(opts: {
  review?: Reviewer
  responses?: InputResponse[]
  policies?: UserPolicyFile[]
}): {
  security: SecurityContext
  requestUserInput: ReturnType<typeof vi.fn<(req: InputRequest) => Promise<InputResponse>>>
} {
  const queue = [...(opts.responses ?? [])]
  const requestUserInput = vi.fn(
    async (_req: InputRequest): Promise<InputResponse> =>
      queue.shift() ?? { kind: 'ask', allowed: true }
  )
  const security = createSecurityContext(
    { kind: 'agent', sessionId: SID, agentKind: 'spawned' },
    { host: 'desktop', workspaceDir: '/ws' },
    {
      host: 'desktop',
      pathSep: '/',
      getVars: () => ({
        workspace: '/ws',
        toolResultsBase: '/tool-results',
        skillsDirs: ['/skills'],
        memoryDirs: [],
        knowledgeRoot: '/kb',
        knowledgeSessionDirs: [],
        home: '/home/u',
        systemDirs: []
      }),
      getSessionGrants: () => ({ allowList: [] }),
      readBuiltinPolicyMd: INLINE_POLICY_MD,
      getUserPolicies: () => opts.policies ?? [TOOL_GATE],
      requestUserInput,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      ...(opts.review ? { onPermissionRequest: opts.review } : {})
    }
  )
  return { security, requestUserInput }
}

/** 真 NextTool，经桌面包装器包一次（宿主的选项：会话、auto 落盘、门） */
function wrappedNext(security: SecurityContext): ReturnType<typeof wrapDurableTool> {
  return wrapDurableTool(resultContractTools({ schema: S })[0], {
    sessionId: SID,
    spill: 'auto',
    security
  })
}

const call = (
  tool: ReturnType<typeof wrapDurableTool>,
  args: Record<string, unknown>,
  callId: string
): ReturnType<typeof invokeTool> => invokeTool(tool, args as never, { callId })

describe('next through the desktop wrapper and the L1 gate', () => {
  it('P2-04-24 门问了、人拒绝：询问一次、点名 next；isError，没有 details / control；同一实例下一次放行照常捕获（拒绝的那次没捕获）', async () => {
    const { security, requestUserInput } = makeSecurity({
      responses: [{ kind: 'ask', allowed: false }]
    })
    const next = wrappedNext(security)

    const { result: denied } = await call(next, { title: 'nope' }, 'n-24a')
    expect(requestUserInput).toHaveBeenCalledTimes(1)
    expect(requestUserInput.mock.calls[0][0].toolName).toBe('next')
    expect(denied.isError).toBe(true)
    expect('details' in denied).toBe(false)
    expect('control' in denied).toBe(false)

    const { result: allowed } = await call(next, { title: 'x' }, 'n-24b')
    expect(requestUserInput).toHaveBeenCalledTimes(2)
    expect(allowed.details).toStrictEqual({ result: { title: 'x' } })
    expect(allowed.control).toStrictEqual({ terminate: true })
  })

  it('P2-04-25 人在门上写反馈（W-R9 的 other 形状）：文字是「没执行、用户反馈」；没有 details / control；没捕获（之后一次照常捕获）', async () => {
    const { security } = makeSecurity({ responses: [{ kind: 'other', text: 'use B' }] })
    const next = wrappedNext(security)

    const { result: feedback } = await call(next, { title: 'A' }, 'n-25a')
    expect(
      resultText(feedback).startsWith(
        'Tool was not executed. User responded with feedback instead:'
      )
    ).toBe(true)
    expect(resultText(feedback)).toContain('use B')
    expect('details' in feedback).toBe(false)
    expect('control' in feedback).toBe(false)

    const { result: later } = await call(next, { title: 'B' }, 'n-25b')
    expect(later.details).toStrictEqual({ result: { title: 'B' } })
  })

  it('P2-04-26 审查放行：不弹卡；details 恰为 {result, shuvixReview}；terminate 在；nextResultOf 从条目里读回结果', async () => {
    const answer: PermissionReviewAnswer = {
      verdict: { decision: 'allow', risk: 'low', summary: 'Finishes the task', reason: 'Ok' },
      source: 'auto-review'
    }
    const review = vi.fn<Reviewer>(async () => answer)
    const { security, requestUserInput } = makeSecurity({ review })
    const next = wrappedNext(security)

    const { result } = await call(next, { title: 'A' }, 'n-26')
    expect(review).toHaveBeenCalledTimes(1)
    expect(requestUserInput).not.toHaveBeenCalled()
    expect(result.details).toStrictEqual({
      result: { title: 'A' },
      shuvixReview: { risk: 'low', summary: 'Finishes the task' }
    })
    expect(result.control).toStrictEqual({ terminate: true })

    const entry = {
      kind: 'pi.tool-result',
      model: [{ role: 'toolResult', toolName: 'next', isError: false, details: result.details }]
    } as unknown as EntryRecord
    expect(nextResultOf(entry)).toStrictEqual({ title: 'A' })
  })

  it('P2-04-27 没有策略就是允许（P2-02 PIN-14）：只有出厂策略时 next 直接执行，不问人、不审查，details {result} 完好', async () => {
    const review = vi.fn<Reviewer>(async () => null)
    const { security, requestUserInput } = makeSecurity({ review, policies: [] })
    const next = wrappedNext(security)

    const { result } = await call(next, { title: 'plain' }, 'n-27')
    expect(requestUserInput).not.toHaveBeenCalled()
    expect(review).not.toHaveBeenCalled()
    expect(result.isError).toBeUndefined()
    expect(result.details).toStrictEqual({ result: { title: 'plain' } })
    expect(result.control).toStrictEqual({ terminate: true })
  })
})
