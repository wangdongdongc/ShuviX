/**
 * executeDecision × 无人值守的运行（docs/unattended-run-design.md §3）：询问通道当场以
 * `{ kind: 'cancel', reason: 'unattended' }` 落定时，执行层把它翻成给模型的那段话、记一种新的日志结果，
 * 别的什么都不动 —— 顺序仍是「策略 → 审查 → 通道」，没人在只会让事情做不成，不会让它不用问。
 *
 *   EN-U1   命令客体、没有审查：抛 `unattendedApprovalText(卡片上那一行)`
 *   EN-U2   路径读 / 路径写 / 会话 / 组件 / 扩展 / url：文字里的对象与交给通道的 `command` 是同一串
 *   EN-U3   决策日志：一条，effect ask、userResponse unattended、totalMs 有值、没有 review
 *   EN-U4   审查放行：通道根本没被问，照常放行
 *   EN-U5   审查拒绝：通道没被问，抛的是审查员那段话（不是无人值守的文字）
 *   EN-U6   审查答 ask：卡片带着审查意见交给通道 → 无人值守的文字；日志既有 review 又有 unattended
 *   EN-U7   审查因连续拒绝暂停：直接到通道 → 无人值守的文字
 *   EN-U8   deny / allow / 没有通道：与通道无关，照旧
 *   EN-U9   force-ask：不问审查，直接到通道 → 无人值守的文字
 *   EN-U10  onOther:'return' / missingChannel：无人值守照样抛（不变成 feedback、不变成放行）
 *   EN-U11  abortError：文字是无人值守的那段，不是 abortError
 *   EN-U12  不留副作用：连续拒绝计数不清零、没有人的回答 / 反馈记录、没有「允许并记住」
 *   EN-U13  别的取消原因：照旧 abortError ?? 'Aborted'，日志 cancel
 *   EN-U14  策略提示语只进卡片，不进给模型的文字
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { InputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import type {
  PermissionDecision,
  PermissionVerdict
} from '@shuvix/chat-protocol/types/permissionReview'
import { isUnattendedResult, unattendedApprovalText } from '@shuvix/chat-protocol/unattended'
import { clearSessionDecisions, getSessionDecisions } from '../decisionLog'
import { executeDecision } from '../enforce'
import {
  clearReviewState,
  humanFeedbackOf,
  reviewSuspended,
  takeHumanAnswers,
  takeReviewAllowed
} from '../reviewState'
import type {
  EnforceOpts,
  EnforceOutcome,
  PermissionReviewAnswer,
  SecurityDecision,
  SecurityHostProvider,
  SecurityObject,
  SecurityRequest
} from '../types'

const UNATTENDED: InputResponse = { kind: 'cancel', reason: 'unattended' }

const usedSids = new Set<string>()
let sidSeq = 0
const newSid = (): string => {
  const sid = `enforce-unattended-${++sidSeq}`
  usedSids.add(sid)
  return sid
}
afterEach(() => {
  for (const sid of usedSids) {
    clearReviewState(sid)
    clearSessionDecisions(sid)
  }
  usedSids.clear()
})

type Reviewer = NonNullable<SecurityHostProvider['onPermissionRequest']>

const COMMAND_OBJECT: SecurityObject = { type: 'command', channel: 'bash', command: 'rm -rf build' }
const PATH_OBJECT: SecurityObject = { type: 'path', path: '/ws/file.txt' }

const requestIn = (sid: string, overrides: Partial<SecurityRequest> = {}): SecurityRequest => ({
  subject: { kind: 'agent', sessionId: sid, agentKind: 'root' },
  action: 'read',
  object: PATH_OBJECT,
  environment: { host: 'desktop' },
  ...overrides
})

const ask = (
  askPart?: SecurityDecision['ask'],
  extra: Partial<SecurityDecision> = {}
): SecurityDecision => ({
  effect: 'ask',
  tier: 'ask',
  matched: ['a1'],
  winning: 'a1',
  ask: askPart,
  ...extra
})

const verdict = (decision: PermissionDecision, reason = 'r'): PermissionVerdict => ({
  decision,
  risk: 'low',
  summary: 's',
  reason
})
const answerOf = (decision: PermissionDecision, reason?: string): PermissionReviewAnswer => ({
  verdict: verdict(decision, reason),
  source: 'auto-review'
})

function rig(
  response: InputResponse = UNATTENDED,
  review?: Reviewer,
  overrides: Partial<SecurityHostProvider> = {}
): {
  provider: SecurityHostProvider
  requestUserInput: ReturnType<typeof vi.fn<(req: InputRequest) => Promise<InputResponse>>>
  persistGrant: ReturnType<typeof vi.fn>
  persistSessionGrant: ReturnType<typeof vi.fn>
  persistWidgetGrant: ReturnType<typeof vi.fn>
} {
  const requestUserInput = vi.fn(async (_req: InputRequest): Promise<InputResponse> => response)
  const persistGrant = vi.fn()
  const persistSessionGrant = vi.fn()
  const persistWidgetGrant = vi.fn()
  return {
    provider: {
      host: 'desktop',
      pathSep: '/',
      getVars: () => ({}),
      requestUserInput,
      persistGrant,
      persistSessionGrant,
      persistWidgetGrant,
      ...(review ? { onPermissionRequest: review } : {}),
      ...overrides
    },
    requestUserInput,
    persistGrant,
    persistSessionGrant,
    persistWidgetGrant
  }
}

const run = (
  provider: SecurityHostProvider,
  request: SecurityRequest,
  decision: SecurityDecision,
  opts: Partial<EnforceOpts> = {}
): Promise<EnforceOutcome> =>
  executeDecision({
    provider,
    request,
    decision,
    opts: { toolCallId: 'tc-1', toolName: 'bash', ...opts },
    evaluateMs: 0
  })

async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (e) {
    return (e as Error).message
  }
  throw new Error('expected the promise to reject')
}

describe('executeDecision — unattended run: the refusal text', () => {
  it('EN-U1 an ask on a command with no reviewer throws the unattended approval text for the card line', async () => {
    const sid = newSid()
    const { provider, requestUserInput } = rig()
    const message = await rejection(
      run(
        provider,
        requestIn(sid, { action: 'execute', object: COMMAND_OBJECT }),
        ask({ command: 'rm -rf build' })
      )
    )
    expect(message).toBe(unattendedApprovalText('rm -rf build'))
    expect(isUnattendedResult(message)).toBe(true)
    expect(requestUserInput).toHaveBeenCalledTimes(1)
  })

  const OBJECTS: [string, Partial<SecurityRequest>, SecurityDecision['ask']][] = [
    ['path read', { action: 'read', object: PATH_OBJECT }, { command: 'Read(/ws/file.txt)' }],
    ['path write', { action: 'write', object: PATH_OBJECT }, { command: 'Write(/ws/file.txt)' }],
    [
      'session',
      {
        action: 'write',
        object: { type: 'session', sessionId: 'X', title: 'Deploy notes', ownTurn: false }
      },
      { command: 'Send a message to "Deploy notes"', session: { title: 'Deploy notes' } } as never
    ],
    [
      'widget',
      {
        action: 'write',
        object: { type: 'widget', widgetId: 'W', name: 'Reading list', operation: 'addBook' }
      },
      { command: 'Reading list: addBook' }
    ],
    [
      'extension',
      { action: 'enable', object: { type: 'extension', server: 'browser', builtin: true } },
      { command: 'Turn on the extension "browser"' }
    ],
    [
      'url',
      {
        action: 'navigate',
        object: {
          type: 'url',
          url: 'https://example.com/a',
          scheme: 'https',
          host: 'example.com',
          origin: 'https://example.com'
        }
      },
      { command: 'Open https://example.com/a' }
    ]
  ]

  it.each(OBJECTS)(
    'EN-U2 %s: the text names exactly what the card line would have shown',
    async (_label, overrides, askPart) => {
      const sid = newSid()
      const { provider, requestUserInput } = rig()
      const message = await rejection(run(provider, requestIn(sid, overrides), ask(askPart)))
      const card = requestUserInput.mock.calls[0]![0] as { command?: string }
      expect(typeof card.command).toBe('string')
      expect(message).toBe(unattendedApprovalText(card.command!))
      expect(message.split('\n')[0]).toContain(card.command!)
    }
  )

  it('EN-U2b without an ask.command the display name of the object is used, for the card and for the text alike', async () => {
    const sid = newSid()
    const { provider, requestUserInput } = rig()
    const message = await rejection(run(provider, requestIn(sid), ask()))
    const card = requestUserInput.mock.calls[0]![0] as { command?: string }
    expect(card.command).toBeTruthy()
    expect(message).toBe(unattendedApprovalText(card.command!))
  })

  it('EN-U11 abortError does not replace the unattended text', async () => {
    const sid = newSid()
    const { provider } = rig()
    const message = await rejection(
      run(provider, requestIn(sid), ask({ command: 'Read(/ws/file.txt)' }), {
        abortError: 'TOOL_ABORTED'
      })
    )
    expect(message).toBe(unattendedApprovalText('Read(/ws/file.txt)'))
  })

  it('EN-U14 the policy prompt goes onto the card but never into the text the model reads', async () => {
    const sid = newSid()
    const { provider, requestUserInput } = rig()
    const prompt = {
      text: 'Writing replaces what is on disk. Check the target path first.',
      rules: ['ask-on-write#0'],
      policies: ['Ask Before Writing a File']
    }
    const message = await rejection(
      run(
        provider,
        requestIn(sid, { action: 'write' }),
        ask({ command: 'Write(/ws/file.txt)' }, { prompt })
      )
    )
    expect(requestUserInput.mock.calls[0]![0]).toMatchObject({
      policyPrompt: { text: prompt.text }
    })
    expect(message).toBe(unattendedApprovalText('Write(/ws/file.txt)'))
    expect(message).not.toContain('Writing replaces')
  })
})

describe('executeDecision — unattended run: the decision log', () => {
  it('EN-U3 one record: effect ask, userResponse unattended, totalMs set, no review', async () => {
    const sid = newSid()
    const { provider } = rig()
    await rejection(run(provider, requestIn(sid), ask({ command: 'Read(/ws/file.txt)' })))
    const logs = getSessionDecisions(sid)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ effect: 'ask', userResponse: 'unattended' })
    expect(typeof logs[0]!.totalMs).toBe('number')
    expect(logs[0]!.review).toBeUndefined()
  })

  it.each(['aborted', 'closed', 'superseded'] as const)(
    'EN-U13 cancel reason %s is still an abort: abortError ?? Aborted, logged as cancel',
    async (reason) => {
      const sid = newSid()
      const { provider } = rig({ kind: 'cancel', reason })
      const decision = ask({ command: 'Read(/ws/file.txt)' })
      expect(await rejection(run(provider, requestIn(sid), decision))).toBe('Aborted')
      expect(
        await rejection(run(provider, requestIn(sid), decision, { abortError: 'TOOL_ABORTED' }))
      ).toBe('TOOL_ABORTED')
      expect(getSessionDecisions(sid).map((log) => log.userResponse)).toEqual(['cancel', 'cancel'])
    }
  )
})

describe('executeDecision — unattended run: the reviewer still goes first', () => {
  it('EN-U4 reviewer allow: the channel is never consulted and the step runs', async () => {
    const sid = newSid()
    const review = vi.fn<Reviewer>(async () => answerOf('allow'))
    const { provider, requestUserInput } = rig(UNATTENDED, review)
    expect(await run(provider, requestIn(sid), ask({ command: 'Read(/ws/file.txt)' }))).toEqual({
      status: 'allowed'
    })
    expect(requestUserInput).not.toHaveBeenCalled()
    const logs = getSessionDecisions(sid)
    expect(logs).toHaveLength(1)
    expect(logs[0]!.userResponse).toBeUndefined()
    expect(logs[0]!.review?.decision).toBe('allow')
  })

  it('EN-U5 reviewer deny: the channel is never consulted and the text is the reviewer’s, not the unattended one', async () => {
    const sid = newSid()
    const review = vi.fn<Reviewer>(async () => answerOf('deny', 'reads a credential'))
    const { provider, requestUserInput } = rig(UNATTENDED, review)
    const message = await rejection(
      run(provider, requestIn(sid), ask({ command: 'Read(/ws/file.txt)' }))
    )
    expect(message).toMatch(/^Blocked by the reviewer: reads a credential/)
    expect(isUnattendedResult(message)).toBe(false)
    expect(requestUserInput).not.toHaveBeenCalled()
    expect(getSessionDecisions(sid)[0]!.userResponse).toBeUndefined()
  })

  it('EN-U6 reviewer ask: the card carries the review, the result is the unattended text, the log has both', async () => {
    const sid = newSid()
    const review = vi.fn<Reviewer>(async () => answerOf('ask', 'the user should decide'))
    const { provider, requestUserInput } = rig(UNATTENDED, review)
    const message = await rejection(
      run(provider, requestIn(sid), ask({ command: 'Read(/ws/file.txt)' }))
    )
    expect(message).toBe(unattendedApprovalText('Read(/ws/file.txt)'))
    expect(requestUserInput).toHaveBeenCalledTimes(1)
    expect(requestUserInput.mock.calls[0]![0]).toMatchObject({
      review: { risk: 'low', reason: 'the user should decide' }
    })
    const logs = getSessionDecisions(sid)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ userResponse: 'unattended', review: { decision: 'ask' } })
  })

  it('EN-U6b a reviewer that has no answer (null) falls through to the channel the same way', async () => {
    const sid = newSid()
    const review = vi.fn<Reviewer>(async () => null)
    const { provider, requestUserInput } = rig(UNATTENDED, review)
    const message = await rejection(
      run(provider, requestIn(sid), ask({ command: 'Read(/ws/file.txt)' }))
    )
    expect(message).toBe(unattendedApprovalText('Read(/ws/file.txt)'))
    expect(review).toHaveBeenCalledTimes(1)
    expect(requestUserInput).toHaveBeenCalledTimes(1)
    expect(getSessionDecisions(sid)[0]!.review).toBeUndefined()
  })

  it('EN-U7 with the review suspended after three consecutive denials, the ask goes straight to the channel', async () => {
    const sid = newSid()
    const review = vi.fn<Reviewer>(async () => answerOf('deny'))
    const { provider, requestUserInput } = rig(UNATTENDED, review)
    const decision = ask({ command: 'Read(/ws/file.txt)' })
    for (let i = 0; i < 3; i++) await rejection(run(provider, requestIn(sid), decision))
    expect(reviewSuspended(sid)).toBe(true)
    expect(requestUserInput).not.toHaveBeenCalled()

    const message = await rejection(run(provider, requestIn(sid), decision))
    expect(message).toBe(unattendedApprovalText('Read(/ws/file.txt)'))
    expect(review).toHaveBeenCalledTimes(3)
    expect(requestUserInput).toHaveBeenCalledTimes(1)
    // 没人答过：暂停照旧（只有人的回答能解除）
    expect(reviewSuspended(sid)).toBe(true)
  })

  it('EN-U9 force-ask skips the reviewer and is refused by the channel', async () => {
    const sid = newSid()
    const review = vi.fn<Reviewer>(async () => answerOf('allow'))
    const { provider, requestUserInput } = rig(UNATTENDED, review)
    const message = await rejection(
      run(provider, requestIn(sid), ask({ command: 'Read(/ws/file.txt)' }, { tier: 'force-ask' }))
    )
    expect(message).toBe(unattendedApprovalText('Read(/ws/file.txt)'))
    expect(review).not.toHaveBeenCalled()
    expect(requestUserInput).toHaveBeenCalledTimes(1)
  })
})

describe('executeDecision — unattended never becomes an allow and never masks a deny', () => {
  it('EN-U8 deny, allow and force-allow never consult the channel', async () => {
    const sid = newSid()
    const { provider, requestUserInput } = rig()
    const request = requestIn(sid)

    const denied = await rejection(
      run(provider, request, { effect: 'deny', matched: ['d1'], winning: 'd1', reason: 'no' })
    )
    expect(denied).toBe('no')
    expect(isUnattendedResult(denied)).toBe(false)

    expect(
      await run(provider, request, { effect: 'allow', matched: ['r1'], winning: 'r1' })
    ).toEqual({ status: 'allowed' })
    expect(
      await run(provider, request, {
        effect: 'allow',
        tier: 'force-allow',
        matched: ['f1'],
        winning: 'f1'
      })
    ).toEqual({ status: 'allowed' })
    expect(await run(provider, request, { effect: 'allow', matched: [], winning: '' })).toEqual({
      status: 'allowed'
    })
    expect(requestUserInput).not.toHaveBeenCalled()
  })

  it('EN-U10 onOther:return and missingChannel do not soften it: the unattended refusal still throws', async () => {
    const sid = newSid()
    const { provider } = rig()
    const decision = ask({ command: 'rm -rf build' })
    const request = requestIn(sid, { action: 'execute', object: COMMAND_OBJECT })
    for (const opts of [
      { onOther: 'return' },
      { missingChannel: 'allow' },
      { missingChannel: 'deny' },
      { onOther: 'return', missingChannel: 'allow' }
    ] as Partial<EnforceOpts>[]) {
      expect(await rejection(run(provider, request, decision, opts))).toBe(
        unattendedApprovalText('rm -rf build')
      )
    }
  })

  it('EN-U12 no side effects: the denial streak is not cleared, nothing is recorded as a human answer, nothing is remembered', async () => {
    const sid = newSid()
    // 两次审查拒绝 → 一次「审查答 ask、没人在」→ 再一次审查拒绝：若无人值守被当成「人答了」，计数会清零、不会暂停
    const decisions: PermissionDecision[] = ['deny', 'deny', 'ask', 'deny']
    const review = vi.fn<Reviewer>(async () => answerOf(decisions.shift() ?? 'allow'))
    const { provider, persistGrant, persistSessionGrant, persistWidgetGrant } = rig(
      UNATTENDED,
      review
    )
    const decision = ask({ command: 'Read(/ws/file.txt)', rememberEntry: 'Read(/ws/file.txt)' })
    const messages: string[] = []
    for (let i = 0; i < 4; i++)
      messages.push(await rejection(run(provider, requestIn(sid), decision)))

    expect(isUnattendedResult(messages[2])).toBe(true)
    expect(reviewSuspended(sid)).toBe(true)
    expect(humanFeedbackOf(sid)).toEqual([])
    expect(takeHumanAnswers(sid, 'tc-1')).toEqual([])
    expect(takeReviewAllowed(sid, 'tc-1')).toBeUndefined()
    expect(persistGrant).not.toHaveBeenCalled()
    expect(persistSessionGrant).not.toHaveBeenCalled()
    expect(persistWidgetGrant).not.toHaveBeenCalled()
  })

  it('EN-U8b a host with no ask channel keeps its own behaviour (missing-channel text / allow), not the unattended one', async () => {
    const sid = newSid()
    const provider: SecurityHostProvider = { host: 'desktop', pathSep: '/', getVars: () => ({}) }
    const decision = ask({ command: 'Read(/ws/file.txt)' })
    const message = await rejection(run(provider, requestIn(sid), decision))
    expect(isUnattendedResult(message)).toBe(false)
    expect(await run(provider, requestIn(sid), decision, { missingChannel: 'allow' })).toEqual({
      status: 'allowed'
    })
  })
})
