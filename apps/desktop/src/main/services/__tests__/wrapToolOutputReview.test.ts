/**
 * wrapToolOutput × 自动审查 —— 工具卡上的「已审查」标记怎么落进工具结果。
 *
 * 安全模块在审查放行时记下一枚标记（noteReviewAllowed）；包装器在工具执行完之后取走它
 * （takeReviewAllowed），写进 details 的保留键 `shuvixReview`（withToolReview）—— 随 toolResult
 * 落盘，实时与重开会话看到的是同一张卡。所以要钉：
 *   - 审查放行 → details 带标记（工具自己的 details 原样保留），且标记已被取走（不留给下一次）；
 *   - 审查拒绝 / 转给人 / 根本没有审查 / 人写反馈 → 没有标记；
 *   - 主体会话与包装器会话不一致 → 不串；
 *   - 放行之后工具自己抛错 → 以失败结果收场（文字即原错误），标记当场丢掉；
 *   - 人在卡片上的回答（`shuvixAnswers`，W-A 系列）：不论工具成败都进 details；还原过占位符的调用不留「记住了什么」；
 *     被中止的调用丢掉，不留给下一次。
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
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AnyTool, SessionRedaction } from '@shuvix/agent-runtime'
import {
  executeTool,
  failureText,
  invokeTool,
  type InvokedToolResult
} from '@shuvix/agent-runtime/tools/testing/invokeTool'
import {
  callOwnerOf,
  clearReviewState,
  clearSessionDecisions,
  createSecurityContext,
  takeHumanAnswers,
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
        knowledgeRoot: '/kb',
        knowledgeSessionDirs: [],
        home: '/home/u',
        systemDirs: []
      }),
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
    output: [{ type: 'text' as const, text: 'ran' }],
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
    expect(second.details).toStrictEqual({ shuvixAnswers: [{ outcome: 'allowed' }] })
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
    expect(result.details).toStrictEqual({ ...own, shuvixAnswers: [{ outcome: 'allowed' }] })
    expect(toolReviewOf(result.details)).toBeUndefined()
  })

  it('W-R6 没有审查接缝、人批准 → 没有标记，details undefined 仍 undefined', async () => {
    const { security, requestUserInput } = makeSecurity({})
    const { tool } = makeTool(undefined)
    const wrapped = wrapDurableTool(tool, { sessionId: SID, spill: true, security })

    const result = await exec(wrapped, 'tc-R6')
    expect(requestUserInput).toHaveBeenCalledTimes(1)
    expect(result.details).toStrictEqual({ shuvixAnswers: [{ outcome: 'allowed' }] })
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
      return { output: [{ type: 'text' as const, text: 'ran' }], details: undefined }
    })
    const wrapped = wrapDurableTool(tool, { sessionId: SID, spill: true, security })

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
    expect(child.result.details).toStrictEqual({ shuvixAnswers: [{ outcome: 'allowed' }] })
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
      content: [{ type: 'text', text: err.message }],
      // 人批准过：工具自己失败了，这个决定仍然留在记录里
      details: { shuvixAnswers: [{ outcome: 'allowed' }] }
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
    expect(result.details).toStrictEqual({
      shuvixAnswers: [{ outcome: 'feedback', text: 'use the staging host' }]
    })
    expect(toolReviewOf(result.details)).toBeUndefined()
  })
})

describe('wrapToolOutput — 人在卡片上的回答写进工具结果（W-A）', () => {
  const REAL = '/ws/real-secret-path.txt'
  const PLACEHOLDER = 'REDACTED_PATH_1'
  const allowed = { outcome: 'allowed' }
  const denied = { outcome: 'denied' }

  type Rule = { effect: 'ask'; conditions: { 'object.type': string[] } }
  const asksOn = (type: string): Rule => ({ effect: 'ask', conditions: { 'object.type': [type] } })
  const L1 = asksOn('invocation')
  const PATHS = asksOn('path')

  /** 同 makeSecurity，但规则由用例给、卡片按次序作答（用完之后一律批准） */
  function gated(
    rules: Rule[],
    ...responses: Array<InputResponse | ((req: InputRequest) => Promise<InputResponse>)>
  ): {
    security: SecurityContext
    requestUserInput: ReturnType<typeof vi.fn<(req: InputRequest) => Promise<InputResponse>>>
  } {
    const queue = [...responses]
    const requestUserInput = vi.fn(async (req: InputRequest): Promise<InputResponse> => {
      const next = queue.shift() ?? { kind: 'ask', allowed: true }
      return typeof next === 'function' ? next(req) : next
    })
    const security = createSecurityContext(
      { kind: 'agent', sessionId: SID, agentKind: 'root' },
      { host: 'desktop', workspaceDir: '/ws' },
      {
        host: 'desktop',
        pathSep: '/',
        getVars: () => ({
          workspace: '/ws',
          toolResultsBase: '/tool-results',
          skillsDirs: ['/skills'],
          knowledgeRoot: '/kb',
          knowledgeSessionDirs: [],
          home: '/home/u',
          systemDirs: []
        }),
        readBuiltinPolicyMd: INLINE_POLICY_MD,
        getUserPolicies: () => [
          { name: 'gate', displayName: 'gate', description: '', rules, body: '' }
        ],
        requestUserInput,
        persistGrant: vi.fn(),
        logger: { info: () => {}, warn: () => {}, error: () => {} }
      } as unknown as SecurityHostProvider
    )
    return { security, requestUserInput }
  }

  /** 工具本体里过一道路径门（与 read / write 工具的写法相同：归属经 callOwnerOf 并进去），之后交回 details */
  function bodyGateTool(
    security: SecurityContext,
    details?: unknown,
    path = '/ws/a.txt'
  ): { tool: AnyTool; ran: ReturnType<typeof vi.fn> } {
    const ran = vi.fn()
    const tool = {
      name: 'read',
      label: 'read',
      description: 'test tool',
      parameters: {},
      replay: 'unsafe' as const,
      execute: async (
        _args: unknown,
        api: { callId: string; taskId: number; conversationId: number },
        context: { abortSignal?: AbortSignal }
      ) => {
        await security.enforcePath('read', path, {
          toolCallId: api.callId,
          ...callOwnerOf({ taskId: api.taskId, conversationId: api.conversationId } as never),
          toolName: 'read',
          abortError: 'Aborted',
          signal: context.abortSignal
        })
        ran()
        return { output: [{ type: 'text' as const, text: 'ran' }], details }
      }
    }
    return { tool: tool as unknown as AnyTool, ran }
  }

  const wrap = (tool: AnyTool, security: SecurityContext): AnyTool =>
    wrapDurableTool(tool, { sessionId: SID, spill: true, security })

  /** 参数里的占位符换回了真值的脱敏替身 */
  const restoring = (): SessionRedaction =>
    ({
      restoreJson: vi.fn(async () => ({
        value: { path: REAL },
        restored: ['PATH'],
        unavailable: []
      }))
    }) as unknown as SessionRedaction

  it('W-A1 L1 门上拒绝：isError，details 恰为 [denied]，工具没跑', async () => {
    const { security } = gated([L1], { kind: 'ask', allowed: false })
    const { tool, execute } = makeTool({ type: 'x' })
    const result = await exec(wrap(tool, security), 'tc-A1')

    expect(result.isError).toBe(true)
    expect(result.details).toStrictEqual({ shuvixAnswers: [denied] })
    expect(execute).not.toHaveBeenCalled()
  })

  it('W-A2 工具本体里的门上拒绝（在内核里抛错）：isError，文字是拒绝原文，记录在', async () => {
    const { security } = gated([PATHS], { kind: 'ask', allowed: false, reason: 'not this file' })
    const { tool, ran } = bodyGateTool(security)
    const result = await exec(wrap(tool, security), 'tc-A2')

    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'not this file' }])
    expect(result.details).toStrictEqual({ shuvixAnswers: [denied] })
    expect(ran).not.toHaveBeenCalled()
  })

  it('W-A3 工具本体的门交回反馈（bash 那条路）：不算错，工具自己的 details 在，记录并进去', async () => {
    const { security } = gated([asksOn('command')], { kind: 'other', text: 'use make' })
    const own = { type: 'bash', exitCode: 0 }
    const tool = {
      name: 'bash',
      label: 'bash',
      description: 'test tool',
      parameters: {},
      replay: 'unsafe' as const,
      execute: async (_args: unknown, api: { callId: string; taskId: number }) => {
        const outcome = await security.enforceCommand(
          { channel: 'bash', command: 'npm run build' },
          {
            toolCallId: api.callId,
            taskId: api.taskId,
            toolName: 'bash',
            abortError: 'Aborted',
            onOther: 'return'
          }
        )
        return {
          output: [{ type: 'text' as const, text: outcome.status }],
          details: own
        }
      }
    }
    const result = await exec(wrap(tool as unknown as AnyTool, security), 'tc-A3')

    expect(result.isError).toBeFalsy()
    expect(result.details).toStrictEqual({
      ...own,
      shuvixAnswers: [{ outcome: 'feedback', text: 'use make' }]
    })
  })

  it('W-A4 记住、没有还原占位符：记录带着记住的路径', async () => {
    const { security } = gated([PATHS], {
      kind: 'ask',
      allowed: true,
      extra: { rememberPath: true }
    })
    const { tool } = bodyGateTool(security)
    const result = await exec(wrap(tool, security), 'tc-A4')

    expect(result.details).toStrictEqual({
      shuvixAnswers: [{ outcome: 'remembered', target: '/ws/a.txt' }]
    })
  })

  it('W-A5 记住、参数里还原过占位符：记录只剩结局，整个结果里找不到真值（会话树里只该有占位符）', async () => {
    const { security } = gated([PATHS], {
      kind: 'ask',
      allowed: true,
      extra: { rememberPath: true }
    })
    const { tool } = bodyGateTool(security, undefined, REAL)
    const wrapped = wrapDurableTool(tool, {
      sessionId: SID,
      spill: true,
      security,
      redaction: restoring
    })
    const result = await exec(wrapped, 'tc-A5', { path: PLACEHOLDER })

    expect(result.details).toStrictEqual({ shuvixAnswers: [{ outcome: 'remembered' }] })
    expect(JSON.stringify(result)).not.toContain(REAL)
  })

  it('W-A6 还原过占位符、两道门（记住 + 反馈）：target 去掉，人写的 text 留着', async () => {
    const { security } = gated(
      [PATHS],
      { kind: 'ask', allowed: true, extra: { rememberPath: true } },
      { kind: 'other', text: 'stop here' }
    )
    const tool = {
      name: 'read',
      label: 'read',
      description: 'test tool',
      parameters: {},
      replay: 'unsafe' as const,
      execute: async (_args: unknown, api: { callId: string; taskId: number }) => {
        for (const path of [REAL, `${REAL}.2`]) {
          await security.enforcePath('read', path, {
            toolCallId: api.callId,
            taskId: api.taskId,
            toolName: 'read',
            abortError: 'Aborted'
          })
        }
        return { output: [{ type: 'text' as const, text: 'ran' }] }
      }
    }
    const wrapped = wrapDurableTool(tool as unknown as AnyTool, {
      sessionId: SID,
      spill: true,
      security,
      redaction: restoring
    })
    const result = await exec(wrapped, 'tc-A6', { path: PLACEHOLDER })

    expect(result.isError).toBe(true)
    expect(result.details).toStrictEqual({
      shuvixAnswers: [{ outcome: 'remembered' }, { outcome: 'feedback', text: 'stop here' }]
    })
    expect(JSON.stringify(result.details)).not.toContain(REAL)
  })

  it('W-A7 还原的只是别的参数（write 的 content）、记住的路径本身不是真值：target 照样去掉（按调用算，不按字段）', async () => {
    const { security } = gated([PATHS], {
      kind: 'ask',
      allowed: true,
      extra: { rememberPath: true }
    })
    const { tool } = bodyGateTool(security, undefined, '/ws/plain.txt')
    const wrapped = wrapDurableTool(tool, {
      sessionId: SID,
      spill: true,
      security,
      redaction: () =>
        ({
          restoreJson: async () => ({
            value: { path: '/ws/plain.txt', content: 'real value' },
            restored: ['EMAIL'],
            unavailable: []
          })
        }) as unknown as SessionRedaction
    })
    const result = await exec(wrapped, 'tc-A7', { path: '/ws/plain.txt', content: PLACEHOLDER })

    expect(result.details).toStrictEqual({ shuvixAnswers: [{ outcome: 'remembered' }] })
  })

  /** 卡片等着，直到信号落下才按取消交回（真宿主的做法） */
  const untilAborted = (controller: AbortController) => (): Promise<InputResponse> =>
    new Promise((done) =>
      controller.signal.addEventListener('abort', () =>
        done({ kind: 'cancel', reason: 'aborted' } as InputResponse)
      )
    )

  it('W-A8 在 L1 卡上等着时被中止：拒绝（不交回结果），之后取不到记录', async () => {
    const controller = new AbortController()
    const { security, requestUserInput } = gated([L1], untilAborted(controller))
    const { tool, execute } = makeTool()
    const pending = invokeTool(wrap(tool, security), { action: 'connect' } as never, {
      callId: 'tc-A8',
      taskId: 81,
      signal: controller.signal
    })
    await vi.waitFor(() => expect(requestUserInput).toHaveBeenCalledTimes(1))
    controller.abort()

    await expect(pending).rejects.toThrow()
    expect(execute).not.toHaveBeenCalled()
    expect(takeHumanAnswers(SID, { toolCallId: 'tc-A8', taskId: 81 })).toStrictEqual([])
  })

  it('W-A8b L1 卡上人拒绝的同时被中止（已记一条、信号也落了）：拒绝，那一条被丢掉，不留给 id 相同的下一次', async () => {
    const controller = new AbortController()
    const { security } = gated(
      [L1],
      async () => {
        controller.abort()
        return { kind: 'ask', allowed: false }
      },
      { kind: 'ask', allowed: true }
    )
    const wrapped = wrap(makeTool().tool, security)

    await expect(
      invokeTool(wrapped, { action: 'connect' } as never, {
        callId: 'tc-A8b',
        taskId: 82,
        signal: controller.signal
      })
    ).rejects.toThrow()
    expect(takeHumanAnswers(SID, { toolCallId: 'tc-A8b', taskId: 82 })).toStrictEqual([])
  })

  it('W-A9 L1 批准（已记一条）、本体里的门等着时被中止：抛出，那一条被丢掉', async () => {
    const controller = new AbortController()
    const { security, requestUserInput } = gated(
      [L1, PATHS],
      { kind: 'ask', allowed: true },
      untilAborted(controller)
    )
    const { tool, ran } = bodyGateTool(security)
    const pending = invokeTool(wrap(tool, security), {} as never, {
      callId: 'tc-A9',
      taskId: 91,
      signal: controller.signal
    })
    await vi.waitFor(() => expect(requestUserInput).toHaveBeenCalledTimes(2))
    controller.abort()

    await expect(pending).rejects.toThrow()
    expect(ran).not.toHaveBeenCalled()
    expect(takeHumanAnswers(SID, { toolCallId: 'tc-A9', taskId: 91 })).toStrictEqual([])
  })

  it('W-A10 批准之后工具因中止抛错：抛出，记录被丢掉；同 id 的下一次调用不继承它', async () => {
    const controller = new AbortController()
    const { security } = gated(
      [L1],
      { kind: 'ask', allowed: true },
      { kind: 'ask', allowed: false }
    )
    const { tool, execute } = makeTool()
    execute.mockImplementationOnce(async () => {
      controller.abort()
      throw new Error('Aborted')
    })
    const wrapped = wrap(tool, security)

    await expect(
      invokeTool(wrapped, { action: 'connect' } as never, {
        callId: 'tc-A10',
        taskId: 100,
        signal: controller.signal
      })
    ).rejects.toThrow('Aborted')
    expect(takeHumanAnswers(SID, { toolCallId: 'tc-A10', taskId: 100 })).toStrictEqual([])

    const next = await invokeTool(wrapped, { action: 'connect' } as never, {
      callId: 'tc-A10',
      taskId: 100
    })
    expect(next.result.details).toStrictEqual({ shuvixAnswers: [denied] })
  })

  it('W-A11 本体里的门被顶替（superseded，信号没落）：isError 结果，只有 L1 那条，被取消的卡不添记录', async () => {
    const { security } = gated([L1, PATHS], { kind: 'ask', allowed: true }, {
      kind: 'cancel',
      reason: 'superseded'
    } as InputResponse)
    const { tool } = bodyGateTool(security)
    const result = await exec(wrap(tool, security), 'tc-A11')

    expect(result.isError).toBe(true)
    expect(result.details).toStrictEqual({ shuvixAnswers: [allowed] })
  })

  it('W-A12 同一个 callId、不同 taskId 同时在等：各自的结果只有各自的记录', async () => {
    const answers: Record<string, (r: InputResponse) => void> = {}
    const { security, requestUserInput } = gated(
      [L1],
      () => new Promise((done) => (answers.first = done)),
      () => new Promise((done) => (answers.second = done))
    )
    const wrapped = wrap(makeTool().tool, security)
    const first = invokeTool(wrapped, { action: 'connect' } as never, {
      callId: 'call_0',
      taskId: 121
    })
    await vi.waitFor(() => expect(requestUserInput).toHaveBeenCalledTimes(1))
    const second = invokeTool(wrapped, { action: 'connect' } as never, {
      callId: 'call_0',
      taskId: 122,
      conversationId: 2
    })
    await vi.waitFor(() => expect(requestUserInput).toHaveBeenCalledTimes(2))

    answers.second({ kind: 'ask', allowed: false })
    expect((await second).result.details).toStrictEqual({ shuvixAnswers: [denied] })
    answers.first({ kind: 'ask', allowed: true })
    expect((await first).result.details).toStrictEqual({ shuvixAnswers: [allowed] })
  })

  it('W-A13 审查放行、人没出场：有「已审查」标记，没有 shuvixAnswers', async () => {
    const { security, requestUserInput } = makeSecurity({
      review: reviewerOf(answer(verdict('allow', 'low', 'fine')))
    })
    const { tool } = makeTool(undefined)
    const result = await exec(wrap(tool, security), 'tc-A13')

    expect(requestUserInput).not.toHaveBeenCalled()
    expect(result.details).toStrictEqual({ shuvixReview: { risk: 'low', summary: 'fine' } })
  })

  it('W-A14 第一道门人答、第二道门审查放行，工具成功：两个键都在', async () => {
    const review = reviewerOf(null, answer(verdict('allow', 'low', 'second gate')))
    const { security } = makeSecurity({ review })
    const tool = {
      name: 'ssh',
      label: 'ssh',
      description: 'test tool',
      parameters: {},
      replay: 'unsafe' as const,
      execute: async (_args: unknown, api: { callId: string; taskId: number }) => {
        // 第二道门：再过一次 invocation（第一道人答、这一道审查放行）
        await security.enforceInvocation({
          toolCallId: api.callId,
          taskId: api.taskId,
          toolName: 'ssh',
          abortError: 'Aborted',
          onOther: 'return'
        })
        return { output: [{ type: 'text' as const, text: 'ran' }] }
      }
    }
    const result = await exec(wrap(tool as unknown as AnyTool, security), 'tc-A14')

    expect(review).toHaveBeenCalledTimes(2)
    expect(result.details).toStrictEqual({
      shuvixReview: { risk: 'low', summary: 'second gate' },
      shuvixAnswers: [allowed]
    })
  })

  it('W-A15 没有哪道门响过：details 是工具自己那一份（同一个引用经过包装），不多键', async () => {
    const own = { type: 'bash', exitCode: 0 }
    const { security, requestUserInput } = gated([])
    const { tool } = makeTool(own)
    const result = await exec(wrap(tool, security), 'tc-A15')

    expect(requestUserInput).not.toHaveBeenCalled()
    expect(result.details).toStrictEqual(own)
    expect(result.details).not.toHaveProperty('shuvixAnswers')
  })

  /** 经 api.details 汇报、结果不带 details 的工具（agent 工具的写法，spawn.ts） */
  const reportingTool = (): AnyTool =>
    ({
      name: 'agent',
      label: 'agent',
      description: 'test tool',
      parameters: {},
      replay: 'unsafe' as const,
      execute: async (
        _args: unknown,
        api: { details: (v: unknown, c: unknown) => Promise<void> },
        context: unknown
      ) => {
        await api.details({ conversationId: 7, agentId: 'a' }, context)
        return { output: [{ type: 'text' as const, text: 'ran' }] }
      }
    }) as unknown as AnyTool

  it('W-A16 工具只经 api.details 汇报：没有门响 → 汇报的留着；人批准过 → 最终 details 只有记录（汇报的被替换，现状，已知）', async () => {
    // invokeTool 结算 details 的口径与 pi-durable harness/tool.js finalResult 相同：结果不带才回退到汇报的
    const quiet = await invokeTool(wrap(reportingTool(), gated([]).security), {} as never)
    expect(quiet.result.details).toStrictEqual({ conversationId: 7, agentId: 'a' })

    const answered = await invokeTool(
      wrap(reportingTool(), gated([L1], { kind: 'ask', allowed: true }).security),
      {} as never
    )
    expect(answered.details).toStrictEqual([{ conversationId: 7, agentId: 'a' }])
    expect(answered.result.details).toStrictEqual({ shuvixAnswers: [allowed] })
  })

  // ── W-A17：记录是否出现，全看执行点记下时用的 taskId 与包装器取走时用的是否同一个 ──

  it.each<[string, string, (s: SecurityContext, o: never) => Promise<unknown>]>([
    ['enforcePath read', 'path', (s, o) => s.enforcePath('read', '/ws/a', o)],
    ['enforcePath write', 'path', (s, o) => s.enforcePath('write', '/ws/a', o)],
    [
      'enforceCommand',
      'command',
      (s, o) => s.enforceCommand({ channel: 'ssh', command: 'ls', host: 'h' } as never, o)
    ],
    [
      'enforceGitOp',
      'gitTool',
      (s, o) =>
        s.enforceGitOp({ gitAction: 'init', command: 'git init', force: false, delete: false }, o)
    ],
    [
      'enforceDatabase',
      'database',
      (s, o) =>
        s.enforceDatabase({ sql: 'select 1', credential: 'c', dbType: 'mysql', readonly: false }, o)
    ],
    [
      'enforceSession',
      'session',
      (s, o) => s.enforceSession('read', { sessionId: 'X', title: 'T', ownTurn: false }, o)
    ],
    [
      'enforceWidget',
      'widget',
      (s, o) => s.enforceWidget('read', { widgetId: 'W', name: 'N', operation: 'op' }, o)
    ],
    [
      'enforceExtension',
      'extension',
      (s, o) => s.enforceExtension({ server: 'browser', builtin: true }, o)
    ]
  ])('W-A17 %s 带着调用归属：卡片答完，结果上有记录', async (_label, type, gate) => {
    const { security, requestUserInput } = gated([asksOn(type)])
    const tool = {
      name: 'probe',
      label: 'probe',
      description: 'test tool',
      parameters: {},
      replay: 'unsafe' as const,
      execute: async (
        _args: unknown,
        api: { callId: string; taskId: number; conversationId: number }
      ) => {
        await gate(security, {
          toolCallId: api.callId,
          ...callOwnerOf({ taskId: api.taskId, conversationId: api.conversationId } as never),
          toolName: 'probe',
          abortError: 'Aborted'
        } as never)
        return { output: [{ type: 'text' as const, text: 'ran' }] }
      }
    }
    const { result } = await invokeTool(wrap(tool as unknown as AnyTool, security), {} as never, {
      callId: 'same-id',
      taskId: 171
    })

    expect(requestUserInput).toHaveBeenCalledTimes(1)
    expect(result.details).toStrictEqual({ shuvixAnswers: [allowed] })
  })

  it.each([
    ['packages/agent-runtime/src/tools/fileToolSuite.ts', /\.\.\.callOwnerOf\(call\)/],
    ['packages/agent-runtime/src/knowledge/knowledgeTool.ts', /callOwnerOf\(call\)/],
    ['apps/desktop/src/main/tools/shellCommand.ts', /\.\.\.callOwnerOf\(call\)/],
    ['apps/desktop/src/main/tools/git.ts', /taskId: info\.taskId/],
    ['apps/desktop/src/main/tools/session.ts', /owner: callOwnerOf\(call\)/],
    ['apps/desktop/src/main/tools/widget.ts', /owner: callOwnerOf\(call\)/],
    ['apps/desktop/src/main/tools/toolSearch.ts', /owner: callOwnerOf\(call\)/],
    ['apps/desktop/src/main/tools/doc.ts', /\.\.\.callOwnerOf\(call\)/],
    ['apps/desktop/src/main/services/builtinMcp/sshServer.ts', /\.\.\.owner,/],
    ['apps/desktop/src/main/services/builtinMcp/databaseServer.ts', /\.\.\.owner,/],
    ['apps/desktop/src/main/services/builtinMcp/browserServer.ts', /taskId: ctx\.taskId/]
  ])('W-A17 源码：%s 的执行点把调用归属交给安全门', (file, plumbing) => {
    const repo = resolve(__dirname, '../../../../../..')
    expect(readFileSync(resolve(repo, file), 'utf8')).toMatch(plumbing)
  })
})
