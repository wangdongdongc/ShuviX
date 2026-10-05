/**
 * wrapToolOutput × 自动审查 —— 工具卡上的「已审查」标记怎么落进工具结果。
 *
 * 安全模块在审查放行时记下一枚标记（noteReviewAllowed）；包装器在工具执行完之后取走它
 * （takeReviewAllowed），写进 details 的保留键 `shuvixReview`（withToolReview）—— 随 toolResult
 * 落盘，实时与重开会话看到的是同一张卡。所以要钉：
 *   - 审查放行 → details 带标记（工具自己的 details 原样保留），且标记已被取走（不留给下一次）；
 *   - 审查拒绝 / 转给人 / 根本没有审查 / 人写反馈 → 没有标记；
 *   - 主体会话与包装器会话不一致 → 不串；
 *   - 放行之后工具自己抛错 → 以失败结果收场（文字即原错误），标记当场丢掉。
 *
 * pi-durable：包装器收的、交出的都是 durable 注册项，经 invokeTool 调；假工具也是 durable 形状。
 * 抛错与门的拒绝从「reject」变成 isError 结果（裁定 Q12，模型看到的文字不变）。
 *
 * P1-06：L1 门把这次调用的 durable taskId / conversationId 交给安全模块，审查接缝收到的事件带着它们
 * （W-R11，审查按 (sessionId, taskId) 归属 —— 裁定 Q16）；其余用例的期望不变。
 *
 * mock 惯例同 wrapToolOutput.test.ts（toolContext 只给 TOOL_ABORTED、logger 置空；后处理不桩 ——
 * 'ran' 这样的短文本本来就原样通过，P1-06b 起后处理在 agent-runtime 的内核里调）；安全门面用真 createSecurityContext + 一条让 L1 invocation 走 ask 档的用户策略（用户策略的
 * ask 就是 tier 'ask'，会先交给审查），provider 上挂 onPermissionRequest。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AnyTool } from '@shuvix/agent-runtime'
import {
  executeTool,
  failureText,
  invokeTool,
  type InvokedToolResult
} from '@shuvix/agent-runtime/tools/testing/invokeTool'
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
import { wrapDurableTool } from '../wrapToolOutput'

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
  tool: AnyTool
  execute: ReturnType<typeof vi.fn>
} {
  const execute = vi.fn(async () => ({
    content: [{ type: 'text' as const, text: 'ran' }],
    details
  }))
  const tool = {
    name: 'ssh',
    label: 'ssh',
    description: 'test tool',
    parameters: {},
    replay: 'unsafe' as const,
    execute
  }
  return { tool: tool as unknown as AnyTool, execute }
}

const exec = (
  wrapped: AnyTool,
  toolCallId: string,
  params: unknown = { action: 'connect' }
): Promise<InvokedToolResult> => executeTool(wrapped, toolCallId, params as never)

describe('wrapToolOutput — 审查放行的调用在结果上留「已审查」标记', () => {
  it('W-R1 审查 allow/medium、工具 details undefined → details 恰为 {shuvixReview: {risk, summary}}；不弹卡；原 execute 恰一次', async () => {
    const review = reviewerOf(answer(verdict('allow', 'medium', 'Connects to the build host')))
    const { security, requestUserInput } = makeSecurity({ review })
    const { tool, execute } = makeTool(undefined)
    const wrapped = wrapDurableTool(tool, { sessionId: SID, spill: true, security })

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
    const wrapped = wrapDurableTool(tool, { sessionId: SID, spill: true, security })

    const result = await exec(wrapped, 'tc-R2')

    expect(result.details).toStrictEqual({ ...own, shuvixReview: { risk: 'high', summary: 's' } })
    expect(toolReviewOf(result.details)).toStrictEqual({ risk: 'high', summary: 's' })
  })

  it('W-R3 标记已被取走：跑完之后 take 为 undefined；同一 toolCallId 的另一次调用（另一个 task，审查没意见、人批准）→ 没有标记', async () => {
    const review = reviewerOf(answer(verdict('allow', 'low', 'first')), null)
    const { security, requestUserInput } = makeSecurity({ review })
    const { tool, execute } = makeTool(undefined)
    const wrapped = wrapDurableTool(tool, { sessionId: SID, spill: true, security })
    const run = async (taskId: number): Promise<InvokedToolResult> =>
      (await invokeTool(wrapped, { action: 'connect' } as never, { callId: 'tc-R', taskId })).result

    const first = await run(71)
    expect(toolReviewOf(first.details)).toStrictEqual({ risk: 'low', summary: 'first' })
    expect(takeReviewAllowed(SID, { toolCallId: 'tc-R', taskId: 71 })).toBeUndefined()
    expect(takeReviewAllowed(SID, 'tc-R')).toBeUndefined()

    const second = await run(72)
    expect(requestUserInput).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledTimes(2)
    expect(toolReviewOf(second.details)).toBeUndefined()
    expect(second.details).toBeUndefined()
  })

  it('W-R4 审查 deny → isError「Blocked by the reviewer」（原为 reject，裁定 Q12）；原 execute 未调；没有标记', async () => {
    const { security } = makeSecurity({
      review: reviewerOf(answer(verdict('deny', 'critical')))
    })
    const { tool, execute } = makeTool(undefined)
    const wrapped = wrapDurableTool(tool, { sessionId: SID, spill: true, security })

    const result = await exec(wrapped, 'tc-R4')
    expect(await failureText(Promise.resolve(result))).toMatch(/Blocked by the reviewer/)
    expect(toolReviewOf(result.details)).toBeUndefined()
    expect(execute).not.toHaveBeenCalled()
    expect(takeReviewAllowed(SID, 'tc-R4')).toBeUndefined()
  })

  it('W-R5 审查 ask → 卡片带 review；人批准之后照常执行、details 没有标记', async () => {
    const { security, requestUserInput } = makeSecurity({
      review: reviewerOf(answer(verdict('ask', 'high', 'Opens a shell')))
    })
    const own = { type: 'bash', exitCode: 0, truncated: false, cwd: '/w' }
    const { tool, execute } = makeTool(own)
    const wrapped = wrapDurableTool(tool, { sessionId: SID, spill: true, security })

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
    const wrapped = wrapDurableTool(tool, { sessionId: SID, spill: true, security })

    const result = await exec(wrapped, 'tc-R6')
    expect(requestUserInput).toHaveBeenCalledTimes(1)
    expect(result.details).toBeUndefined()
  })

  it('W-R6 不传 security（不设门）→ 没有标记，details 原样', async () => {
    const own = { type: 'bash', exitCode: 0, truncated: false, cwd: '/w' }
    const { tool } = makeTool(own)
    const wrapped = wrapDurableTool(tool, { sessionId: SID, spill: true })

    const result = await exec(wrapped, 'tc-R6b')
    expect(result.details).toStrictEqual(own)

    const bare = wrapDurableTool(makeTool(undefined).tool, { sessionId: SID, spill: true })
    expect((await exec(bare, 'tc-R6c')).details).toBeUndefined()
  })

  it('W-R7 安全门面的主体会话是 SID、包装器用 SID2 → 结果没有标记，SID 下那枚仍取得到', async () => {
    const { security } = makeSecurity({
      review: reviewerOf(answer(verdict('allow', 'low', 'other session'))),
      sessionId: SID
    })
    const { tool } = makeTool(undefined)
    const wrapped = wrapDurableTool(tool, { sessionId: SID2, spill: true, security })

    const result = await exec(wrapped, 'tc')
    expect(result.details).toBeUndefined()
    // P2-08 PIN-10：标记按这次调用的 taskId 记（executeTool 缺省 task 1）
    expect(takeReviewAllowed(SID, { toolCallId: 'tc', taskId: 1 })).toStrictEqual({
      risk: 'low',
      summary: 'other session'
    })
  })

  it('P2-08-32 同一个 provider id（call_0）的两次调用：根的 task 61 被放行后还在跑，子的 task 62（人批准）先跑完 → 子的结果没有标记，61 的有；人的回答只清自己那个 task 的标记', async () => {
    const review = reviewerOf(answer(verdict('allow', 'high', 'root call')), null)
    const { security, requestUserInput } = makeSecurity({ review })
    let release!: () => void
    const gate = { promise: new Promise<void>((resolve) => (release = resolve)) }
    const { tool, execute } = makeTool(undefined)
    // 第一次执行（task 61）扣住，第二次（task 62）立刻跑完
    execute.mockImplementationOnce(async () => {
      await gate.promise
      return { content: [{ type: 'text' as const, text: 'ran' }], details: undefined }
    })
    const wrapped = wrapToolOutput(tool, SID, 'middle', undefined, security)

    const root = invokeTool(wrapped, { action: 'connect' } as never, {
      callId: 'call_0',
      taskId: 61
    })
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1))
    const child = await invokeTool(wrapped, { action: 'connect' } as never, {
      callId: 'call_0',
      taskId: 62,
      conversationId: 2
    })
    expect(requestUserInput).toHaveBeenCalledTimes(1)
    expect(child.result.details).toBeUndefined()
    release()
    expect((await root).result.details).toStrictEqual({
      shuvixReview: { risk: 'high', summary: 'root call' }
    })
  })

  it('W-R8 工具 execute 抛错（没有审查）→ isError 结果、文字即原错误（原为 reject 原错误，裁定 Q12）', async () => {
    const { security } = makeSecurity({})
    const { tool, execute } = makeTool(undefined)
    const err = new Error('connection refused')
    execute.mockRejectedValueOnce(err)
    const wrapped = wrapDurableTool(tool, { sessionId: SID, spill: true, security })

    expect(await exec(wrapped, 'tc-R8')).toEqual({
      isError: true,
      content: [{ type: 'text', text: err.message }]
    })
  })

  it('W-R10 审查放行之后工具 execute 抛错 → isError 结果（文字即原错误、不带标记），且标记被当场丢掉', async () => {
    const { security } = makeSecurity({
      review: reviewerOf(answer(verdict('allow', 'high', 'will fail')))
    })
    const { tool, execute } = makeTool(undefined)
    const err = new Error('connection refused')
    execute.mockRejectedValueOnce(err)
    const wrapped = wrapDurableTool(tool, { sessionId: SID, spill: true, security })

    expect(await exec(wrapped, 'tc-R10')).toEqual({
      isError: true,
      content: [{ type: 'text', text: err.message }]
    })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(takeReviewAllowed(SID, 'tc-R10')).toBeUndefined()
  })

  it('W-R11 L1 门交给审查接缝的事件带着这次调用的 taskId / conversationId（toolCallId 相同的两次调用分得开）', async () => {
    const review = reviewerOf(
      answer(verdict('allow', 'low', 'first')),
      answer(verdict('allow', 'low', 'second'))
    )
    const { security } = makeSecurity({ review })
    const { tool } = makeTool(undefined)
    const wrapped = wrapDurableTool(tool, { sessionId: SID, spill: true, security })

    await invokeTool(wrapped, { action: 'connect' } as never, {
      callId: 'call_0',
      taskId: 61,
      conversationId: 5
    })
    await invokeTool(wrapped, { action: 'connect' } as never, { callId: 'call_0', taskId: 62 })

    expect(review).toHaveBeenCalledTimes(2)
    const owners = review.mock.calls.map(([event]) => ({
      toolCallId: event.toolCallId,
      taskId: event.taskId,
      conversationId: event.conversationId
    }))
    expect(owners).toEqual([
      { toolCallId: 'call_0', taskId: 61, conversationId: 5 },
      // invokeTool 缺省根对话（1）
      { toolCallId: 'call_0', taskId: 62, conversationId: 1 }
    ])
  })

  it('W-R9 人在 L1 卡上写反馈（other）→ 返回的 feedback 结果不带标记', async () => {
    const { security, requestUserInput } = makeSecurity({
      review: reviewerOf(answer(verdict('ask', 'medium'))),
      response: { kind: 'other', text: 'use the staging host' }
    })
    const { tool, execute } = makeTool(undefined)
    const wrapped = wrapDurableTool(tool, { sessionId: SID, spill: true, security })

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
