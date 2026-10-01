/**
 * wrapToolOutput × 自动审查 —— 工具卡上的「已审查」标记怎么落进工具结果。
 *
 * 安全模块在审查放行时记下一枚标记（noteReviewAllowed）；包装器在工具执行完之后取走它
 * （takeReviewAllowed），写进 details 的保留键 `shuvixReview`（withToolReview）—— 随 toolResult
 * 落盘，实时与重开会话看到的是同一张卡。所以要钉：
 *   - 审查放行 → details 带标记（工具自己的 details 原样保留），且标记已被取走（不留给下一次）；
 *   - 审查拒绝 / 转给人 / 根本没有审查 / 人写反馈 → 没有标记；
 *   - 主体会话与包装器会话不一致 → 不串；
 *   - 放行之后工具自己抛错 → 原错误照抛，标记当场丢掉。
 *
 * mock 惯例同 wrapToolOutput.test.ts（toolContext 只给 TOOL_ABORTED、logger 置空、processToolOutput
 * 原样直通）；安全门面用真 createSecurityContext + 一条让 L1 invocation 走 ask 档的用户策略（用户策略的
 * ask 就是 tier 'ask'，会先交给审查），provider 上挂 onPermissionRequest。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import {
  clearReviewState,
  clearSessionDecisions,
  createSecurityContext,
  takeReviewAllowed,
  type PermissionReviewAnswer,
  type SecurityContext,
  type SecurityHostProvider
} from '@shuvix/agent-runtime'
import { createInlinePolicyMdReader } from '@shuvix/agent-runtime/security/builtinPolicies/inlineSources'
import type { InputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import type {
  PermissionDecision,
  PermissionRisk,
  PermissionVerdict
} from '@shuvix/chat-protocol/types/permissionReview'
import { toolReviewOf } from '@shuvix/chat-protocol/types/toolReview'

const INLINE_POLICY_MD = createInlinePolicyMdReader()

vi.mock('../toolContext', () => ({ TOOL_ABORTED: 'Aborted' }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('../../utils/toolUtils/processToolOutput', () => ({
  processToolOutput: vi.fn(async (opts: { fullText: string }) => ({
    text: opts.fullText,
    truncated: false,
    persisted: false
  }))
}))

import { wrapToolOutput } from '../wrapToolOutput'

const SID = 'wrap-tool-output-review-session'
const SID2 = 'wrap-tool-output-review-session-2'

afterEach(() => {
  for (const sid of [SID, SID2]) {
    clearReviewState(sid)
    clearSessionDecisions(sid)
  }
})

type Reviewer = NonNullable<SecurityHostProvider['onPermissionRequest']>

const verdict = (
  decision: PermissionDecision,
  risk: PermissionRisk = 'medium',
  summary = 'Connects to the build host'
): PermissionVerdict => ({ decision, risk, summary, reason: 'Ordinary work' })
const answer = (v: PermissionVerdict): PermissionReviewAnswer => ({
  verdict: v,
  source: 'auto-review'
})
/** 按次序回答的审查接缝（用完之后回 null = 没有意见） */
const reviewerOf = (
  ...answers: Array<PermissionReviewAnswer | null>
): ReturnType<typeof vi.fn<Reviewer>> => {
  const queue = [...answers]
  return vi.fn<Reviewer>(async () => queue.shift() ?? null)
}

/** 真 createSecurityContext：一条用户策略让所有工具调用（invocation）都走 ask 档 */
function makeSecurity(opts: { review?: Reviewer; response?: InputResponse; sessionId?: string }): {
  security: SecurityContext
  requestUserInput: ReturnType<typeof vi.fn<(req: InputRequest) => Promise<InputResponse>>>
} {
  const requestUserInput = vi.fn(
    async (_req: InputRequest): Promise<InputResponse> =>
      opts.response ?? { kind: 'ask', allowed: true }
  )
  const security = createSecurityContext(
    { kind: 'agent', sessionId: opts.sessionId ?? SID, agentKind: 'root' },
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
      getUserPolicies: () => [
        {
          name: 'tool-gate',
          displayName: 'tool-gate',
          description: '',
          rules: [{ effect: 'ask', object: { kind: 'invocation' } }],
          body: ''
        }
      ],
      requestUserInput,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      ...(opts.review ? { onPermissionRequest: opts.review } : {})
    }
  )
  return { security, requestUserInput }
}

/** 一个 execute 可编程的工具（缺省返回单文本块 'ran'，details 由用例给） */
function makeTool(details?: unknown): {
  tool: AgentTool
  execute: ReturnType<typeof vi.fn>
} {
  const execute = vi.fn(async () => ({
    content: [{ type: 'text' as const, text: 'ran' }],
    details
  }))
  const tool = { name: 'ssh', label: 'ssh', description: 'test tool', parameters: {}, execute }
  return { tool: tool as unknown as AgentTool, execute }
}

const exec = (
  wrapped: AgentTool,
  toolCallId: string,
  params: unknown = { action: 'connect' }
): ReturnType<AgentTool['execute']> => wrapped.execute(toolCallId, params as never)

describe('wrapToolOutput — 审查放行的调用在结果上留「已审查」标记', () => {
  it('W-R1 审查 allow/medium、工具 details undefined → details 恰为 {shuvixReview: {risk, summary}}；不弹卡；原 execute 恰一次', async () => {
    const review = reviewerOf(answer(verdict('allow', 'medium', 'Connects to the build host')))
    const { security, requestUserInput } = makeSecurity({ review })
    const { tool, execute } = makeTool(undefined)
    const wrapped = wrapToolOutput(tool, SID, 'middle', undefined, security)

    const result = await exec(wrapped, 'tc-R')

    expect(review).toHaveBeenCalledTimes(1)
    expect(requestUserInput).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledTimes(1)
    expect(result.details).toStrictEqual({
      shuvixReview: { risk: 'medium', summary: 'Connects to the build host' }
    })
  })

  it('W-R2 工具自己的 bash details（含 truncated）原样保留，标记并进去，toolReviewOf 读得出', async () => {
    const own = { type: 'bash', exitCode: 0, truncated: false, cwd: '/w' }
    const { security } = makeSecurity({ review: reviewerOf(answer(verdict('allow', 'high', 's'))) })
    const { tool } = makeTool(own)
    const wrapped = wrapToolOutput(tool, SID, 'middle', undefined, security)

    const result = await exec(wrapped, 'tc-R2')

    expect(result.details).toStrictEqual({ ...own, shuvixReview: { risk: 'high', summary: 's' } })
    expect(toolReviewOf(result.details)).toStrictEqual({ risk: 'high', summary: 's' })
  })

  it('W-R3 标记已被取走：跑完之后 take 为 undefined；同一 toolCallId 再跑一次（审查没意见、人批准）→ 没有标记', async () => {
    const review = reviewerOf(answer(verdict('allow', 'low', 'first')), null)
    const { security, requestUserInput } = makeSecurity({ review })
    const { tool, execute } = makeTool(undefined)
    const wrapped = wrapToolOutput(tool, SID, 'middle', undefined, security)

    const first = await exec(wrapped, 'tc-R')
    expect(toolReviewOf(first.details)).toStrictEqual({ risk: 'low', summary: 'first' })
    expect(takeReviewAllowed(SID, 'tc-R')).toBeUndefined()

    const second = await exec(wrapped, 'tc-R')
    expect(requestUserInput).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledTimes(2)
    expect(toolReviewOf(second.details)).toBeUndefined()
    expect(second.details).toBeUndefined()
  })

  it('W-R4 审查 deny → reject「Blocked by the reviewer」；原 execute 未调；没有标记', async () => {
    const { security } = makeSecurity({
      review: reviewerOf(answer(verdict('deny', 'critical')))
    })
    const { tool, execute } = makeTool(undefined)
    const wrapped = wrapToolOutput(tool, SID, 'middle', undefined, security)

    await expect(exec(wrapped, 'tc-R4')).rejects.toThrow(/Blocked by the reviewer/)
    expect(execute).not.toHaveBeenCalled()
    expect(takeReviewAllowed(SID, 'tc-R4')).toBeUndefined()
  })

  it('W-R5 审查 ask → 卡片带 review；人批准之后照常执行、details 没有标记', async () => {
    const { security, requestUserInput } = makeSecurity({
      review: reviewerOf(answer(verdict('ask', 'high', 'Opens a shell')))
    })
    const own = { type: 'bash', exitCode: 0, truncated: false, cwd: '/w' }
    const { tool, execute } = makeTool(own)
    const wrapped = wrapToolOutput(tool, SID, 'middle', undefined, security)

    const result = await exec(wrapped, 'tc-R5')

    expect(requestUserInput).toHaveBeenCalledTimes(1)
    expect((requestUserInput.mock.calls[0][0] as { review?: unknown }).review).toStrictEqual({
      risk: 'high',
      summary: 'Opens a shell',
      reason: 'Ordinary work'
    })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(result.details).toStrictEqual(own)
    expect(toolReviewOf(result.details)).toBeUndefined()
  })

  it('W-R6 没有审查接缝、人批准 → 没有标记，details undefined 仍 undefined', async () => {
    const { security, requestUserInput } = makeSecurity({})
    const { tool } = makeTool(undefined)
    const wrapped = wrapToolOutput(tool, SID, 'middle', undefined, security)

    const result = await exec(wrapped, 'tc-R6')
    expect(requestUserInput).toHaveBeenCalledTimes(1)
    expect(result.details).toBeUndefined()
  })

  it('W-R6 不传 security（不设门）→ 没有标记，details 原样', async () => {
    const own = { type: 'bash', exitCode: 0, truncated: false, cwd: '/w' }
    const { tool } = makeTool(own)
    const wrapped = wrapToolOutput(tool, SID, 'middle')

    const result = await exec(wrapped, 'tc-R6b')
    expect(result.details).toStrictEqual(own)

    const bare = wrapToolOutput(makeTool(undefined).tool, SID, 'middle')
    expect((await exec(bare, 'tc-R6c')).details).toBeUndefined()
  })

  it('W-R7 安全门面的主体会话是 SID、包装器用 SID2 → 结果没有标记，SID 下那枚仍取得到', async () => {
    const { security } = makeSecurity({
      review: reviewerOf(answer(verdict('allow', 'low', 'other session'))),
      sessionId: SID
    })
    const { tool } = makeTool(undefined)
    const wrapped = wrapToolOutput(tool, SID2, 'middle', undefined, security)

    const result = await exec(wrapped, 'tc')
    expect(result.details).toBeUndefined()
    expect(takeReviewAllowed(SID, 'tc')).toStrictEqual({ risk: 'low', summary: 'other session' })
  })

  it('W-R8 工具 execute 抛错（没有审查）→ reject 原错误', async () => {
    const { security } = makeSecurity({})
    const { tool, execute } = makeTool(undefined)
    const err = new Error('connection refused')
    execute.mockRejectedValueOnce(err)
    const wrapped = wrapToolOutput(tool, SID, 'middle', undefined, security)

    await expect(exec(wrapped, 'tc-R8')).rejects.toBe(err)
  })

  it('W-R10 审查放行之后工具 execute 抛错 → reject 原错误，且标记被当场丢掉', async () => {
    const { security } = makeSecurity({
      review: reviewerOf(answer(verdict('allow', 'high', 'will fail')))
    })
    const { tool, execute } = makeTool(undefined)
    const err = new Error('connection refused')
    execute.mockRejectedValueOnce(err)
    const wrapped = wrapToolOutput(tool, SID, 'middle', undefined, security)

    await expect(exec(wrapped, 'tc-R10')).rejects.toBe(err)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(takeReviewAllowed(SID, 'tc-R10')).toBeUndefined()
  })

  it('W-R9 人在 L1 卡上写反馈（other）→ 返回的 feedback 结果不带标记', async () => {
    const { security, requestUserInput } = makeSecurity({
      review: reviewerOf(answer(verdict('ask', 'medium'))),
      response: { kind: 'other', text: 'use the staging host' }
    })
    const { tool, execute } = makeTool(undefined)
    const wrapped = wrapToolOutput(tool, SID, 'middle', undefined, security)

    const result = await exec(wrapped, 'tc-R9')

    expect(requestUserInput).toHaveBeenCalledTimes(1)
    expect(execute).not.toHaveBeenCalled()
    expect(result.content).toEqual([
      {
        type: 'text',
        text: 'Tool was not executed. User responded with feedback instead:\nuse the staging host'
      }
    ])
    expect(result.details).toBeUndefined()
    expect(toolReviewOf(result.details)).toBeUndefined()
  })
})
