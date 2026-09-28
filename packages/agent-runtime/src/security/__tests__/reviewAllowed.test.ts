/**
 * 「已审查」标记的会话内暂存（reviewState.ts 的 noteReviewAllowed / takeReviewAllowed）与它在执行层的
 * 写入点（enforce.ts 的 executeDecision）。
 *
 * 标记回答的只是「这一步没人看过，是审查员放行的」：执行层在审查 allow 时记下，宿主在工具执行完之后
 * 取走、写进工具结果（工具卡上的盾牌）。所以：
 *   RA-*  暂存本身 —— 取走即删、按会话分桶、同一调用留风险最高的那次、每会话 50 条旧的先丢；
 *   RE-*  执行层 —— 只有审查 allow 才记；审查 deny / 转给人 / 答不出 / force-ask 都不记；
 *         同一调用后来有人看过（另一道门交给了人），先前那枚作废；写给人看的两段话被截断。
 *
 * reviewState 是进程级的 Map：每条用例用自己的会话 id，afterEach 逐个 clearReviewState —— 否则
 * 连续 3 次审查拒绝会让后面的会话直接问人。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AskInputRequest,
  InputRequest,
  InputResponse
} from '@shuvix/chat-protocol/types/inputRequest'
import type {
  PermissionDecision,
  PermissionRisk,
  PermissionVerdict
} from '@shuvix/chat-protocol/types/permissionReview'
import { clearReviewState, noteReviewAllowed, takeReviewAllowed } from '../reviewState'
import { executeDecision } from '../enforce'
import { clearSessionDecisions } from '../decisionLog'
import type {
  EnforceOpts,
  EnforceOutcome,
  PermissionReviewAnswer,
  SecurityDecision,
  SecurityHostProvider,
  SecurityRequest
} from '../types'

const used = new Set<string>()
let seq = 0

/** 本条用例专用的会话 id（afterEach 清掉） */
function newSid(label = 'ra'): string {
  const sid = `review-allowed-${label}-${++seq}`
  used.add(sid)
  return sid
}

afterEach(() => {
  for (const sid of used) {
    clearReviewState(sid)
    clearSessionDecisions(sid)
  }
  used.clear()
})

const note = (
  risk: PermissionRisk,
  summary: string
): { risk: PermissionRisk; summary: string } => ({
  risk,
  summary
})

// ─── RA：暂存本身 ─────────────────────────────────────────

describe('reviewState — 审查放行过的调用', () => {
  it('RA-1 记下之后取得到；取走即删，第二次 take 返回 undefined', () => {
    const sid = newSid()
    noteReviewAllowed(sid, 'tc-1', note('low', 'a'))
    expect(takeReviewAllowed(sid, 'tc-1')).toStrictEqual({ risk: 'low', summary: 'a' })
    expect(takeReviewAllowed(sid, 'tc-1')).toBeUndefined()
  })

  it('RA-2 未知会话 / 未知调用 → undefined，不抛', () => {
    const sid = newSid()
    expect(() => takeReviewAllowed(`${sid}-never`, 'tc-1')).not.toThrow()
    expect(takeReviewAllowed(`${sid}-never`, 'tc-1')).toBeUndefined()
    noteReviewAllowed(sid, 'tc-1', note('low', 'a'))
    expect(takeReviewAllowed(sid, 'tc-unknown')).toBeUndefined()
    // 取错了的那次不影响真正那条
    expect(takeReviewAllowed(sid, 'tc-1')).toStrictEqual({ risk: 'low', summary: 'a' })
  })

  it('RA-3 同一调用依次记 low / high / medium → 留风险最高的 high', () => {
    const sid = newSid()
    noteReviewAllowed(sid, 'tc-1', note('low', 'a'))
    noteReviewAllowed(sid, 'tc-1', note('high', 'b'))
    noteReviewAllowed(sid, 'tc-1', note('medium', 'c'))
    expect(takeReviewAllowed(sid, 'tc-1')).toStrictEqual({ risk: 'high', summary: 'b' })
  })

  it('RA-4 先 high 后 low → 仍是 high', () => {
    const sid = newSid()
    noteReviewAllowed(sid, 'tc-1', note('high', 'b'))
    noteReviewAllowed(sid, 'tc-1', note('low', 'a'))
    expect(takeReviewAllowed(sid, 'tc-1')).toStrictEqual({ risk: 'high', summary: 'b' })
  })

  it('RA-5 同风险平局保留第一次（钉现状：只有更高才替换）', () => {
    const sid = newSid()
    noteReviewAllowed(sid, 'tc-1', note('medium', 'first'))
    noteReviewAllowed(sid, 'tc-1', note('medium', 'second'))
    expect(takeReviewAllowed(sid, 'tc-1')).toStrictEqual({ risk: 'medium', summary: 'first' })
  })

  it('RA-6 同一 toolCallId 在两个会话各记一份，各取各的', () => {
    const s1 = newSid()
    const s2 = newSid()
    noteReviewAllowed(s1, 'tc-1', note('low', 'in s1'))
    noteReviewAllowed(s2, 'tc-1', note('critical', 'in s2'))
    expect(takeReviewAllowed(s2, 'tc-1')).toStrictEqual({ risk: 'critical', summary: 'in s2' })
    expect(takeReviewAllowed(s1, 'tc-1')).toStrictEqual({ risk: 'low', summary: 'in s1' })
  })

  it('RA-7 空 toolCallId 不记，也不占 50 条配额', () => {
    const sid = newSid()
    noteReviewAllowed(sid, '', note('high', 'x'))
    expect(takeReviewAllowed(sid, '')).toBeUndefined()

    // 配额：先记满 50 条，再塞一条空 id —— 若它占了位，最旧的 c1 会被挤掉
    for (let i = 1; i <= 50; i++) noteReviewAllowed(sid, `c${i}`, note('low', `n${i}`))
    noteReviewAllowed(sid, '', note('high', 'x'))
    expect(takeReviewAllowed(sid, 'c1')).toStrictEqual({ risk: 'low', summary: 'n1' })
  })

  it('RA-8 每会话上限 50，旧的先丢：c1…c51 → c1 取不到、c2…c51 都在；别的会话记满不挤这边', () => {
    const sid = newSid()
    const other = newSid('other')
    for (let i = 1; i <= 51; i++) noteReviewAllowed(sid, `c${i}`, note('low', `n${i}`))
    // 另一会话记满 50：各会话配额独立
    for (let i = 1; i <= 50; i++) noteReviewAllowed(other, `o${i}`, note('low', `o${i}`))

    expect(takeReviewAllowed(sid, 'c1')).toBeUndefined()
    for (let i = 2; i <= 51; i++) {
      expect(takeReviewAllowed(sid, `c${i}`), `c${i}`).toStrictEqual({
        risk: 'low',
        summary: `n${i}`
      })
    }
    for (let i = 1; i <= 50; i++) {
      expect(takeReviewAllowed(other, `o${i}`), `o${i}`).toBeDefined()
    }
  })

  it('RA-9 升级算作「新」：c1 再记 high 挪到队尾，之后记 c51 被丢的是 c2', () => {
    const sid = newSid()
    noteReviewAllowed(sid, 'c1', note('low', 'n1'))
    for (let i = 2; i <= 50; i++) noteReviewAllowed(sid, `c${i}`, note('low', `n${i}`))
    noteReviewAllowed(sid, 'c1', note('high', 'n1-high'))
    noteReviewAllowed(sid, 'c51', note('low', 'n51'))

    expect(takeReviewAllowed(sid, 'c2')).toBeUndefined()
    expect(takeReviewAllowed(sid, 'c1')).toStrictEqual({ risk: 'high', summary: 'n1-high' })
    expect(takeReviewAllowed(sid, 'c51')).toBeDefined()
  })

  it('RA-9 对照：c1 再记同档 low（不升级不挪），之后记 c51 被丢的是 c1', () => {
    const sid = newSid()
    noteReviewAllowed(sid, 'c1', note('low', 'n1'))
    for (let i = 2; i <= 50; i++) noteReviewAllowed(sid, `c${i}`, note('low', `n${i}`))
    noteReviewAllowed(sid, 'c1', note('low', 'n1-again'))
    noteReviewAllowed(sid, 'c51', note('low', 'n51'))

    expect(takeReviewAllowed(sid, 'c1')).toBeUndefined()
    expect(takeReviewAllowed(sid, 'c2')).toStrictEqual({ risk: 'low', summary: 'n2' })
  })

  it('RA-10 clearReviewState(S) 清掉 S 下所有没取走的标记；S2 不受影响', () => {
    const s = newSid()
    const s2 = newSid()
    noteReviewAllowed(s, 'tc-1', note('low', 'a'))
    noteReviewAllowed(s, 'tc-2', note('high', 'b'))
    noteReviewAllowed(s2, 'tc-1', note('medium', 'c'))

    clearReviewState(s)

    expect(takeReviewAllowed(s, 'tc-1')).toBeUndefined()
    expect(takeReviewAllowed(s, 'tc-2')).toBeUndefined()
    expect(takeReviewAllowed(s2, 'tc-1')).toStrictEqual({ risk: 'medium', summary: 'c' })
  })
})

// ─── RE：执行层的写入点 ───────────────────────────────────

describe('executeDecision — 「已审查」标记只在审查放行时留下', () => {
  type Reviewer = NonNullable<SecurityHostProvider['onPermissionRequest']>

  const verdict = (
    decision: PermissionDecision,
    fields: Partial<PermissionVerdict> = {}
  ): PermissionVerdict => ({
    decision,
    risk: 'low',
    summary: 'Lists the files',
    reason: 'Ordinary work',
    ...fields
  })
  const answerOf = (value: unknown): PermissionReviewAnswer => ({
    verdict: value as PermissionVerdict,
    source: 'auto-review'
  })
  /** 固定回答的审查接缝 */
  const reviewer = (answer: PermissionReviewAnswer | null): ReturnType<typeof vi.fn<Reviewer>> =>
    vi.fn<Reviewer>(async () => answer)
  /** 按次序回答的审查接缝 */
  const scripted = (
    answers: Array<PermissionReviewAnswer | null>
  ): ReturnType<typeof vi.fn<Reviewer>> => {
    const queue = [...answers]
    return vi.fn<Reviewer>(async () => queue.shift() ?? null)
  }

  const COMMAND = 'rm -rf build'
  /** ask 档的命令询问（带询问材料 —— 用户策略 / 内置 ask 规则的产物形态） */
  const ASK: SecurityDecision = {
    effect: 'ask',
    tier: 'ask',
    matched: ['a1'],
    winning: 'a1',
    ask: { command: COMMAND }
  }

  const requestIn = (sid: string): SecurityRequest => ({
    subject: { kind: 'agent', sessionId: sid, agentKind: 'root' },
    action: 'execute',
    object: { type: 'command', channel: 'bash', command: COMMAND },
    environment: { host: 'desktop' }
  })

  function provider(
    review: Reviewer | undefined,
    response: InputResponse = { kind: 'ask', allowed: true }
  ): {
    provider: SecurityHostProvider
    requestUserInput: ReturnType<typeof vi.fn<(req: InputRequest) => Promise<InputResponse>>>
  } {
    const requestUserInput = vi.fn(async (_req: InputRequest): Promise<InputResponse> => response)
    return {
      provider: {
        host: 'desktop',
        pathSep: '/',
        getVars: () => ({}),
        getSessionGrants: () => ({ autoAllow: false, allowList: [] }),
        requestUserInput,
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        ...(review ? { onPermissionRequest: review } : {})
      },
      requestUserInput
    }
  }

  const run = (
    p: SecurityHostProvider,
    sid: string,
    decision: SecurityDecision = ASK,
    opts: Partial<EnforceOpts> = {}
  ): Promise<EnforceOutcome> =>
    executeDecision({
      provider: p,
      request: requestIn(sid),
      decision,
      opts: { toolCallId: 'tc-1', toolName: 'bash', ...opts },
      evaluateMs: 0
    })

  const onlyCard = (requestUserInput: ReturnType<typeof vi.fn>): AskInputRequest => {
    expect(requestUserInput).toHaveBeenCalledTimes(1)
    return requestUserInput.mock.calls[0][0] as AskInputRequest
  }

  it('RE-1 审查 allow/high：放行、不弹卡；取到的标记恰为 {risk, summary}（不带 reason / decision / source）', async () => {
    const sid = newSid('re')
    const { provider: p, requestUserInput } = provider(
      reviewer(answerOf(verdict('allow', { risk: 'high', summary: 'Deletes build' })))
    )
    await expect(run(p, sid)).resolves.toEqual({ status: 'allowed' })
    expect(requestUserInput).not.toHaveBeenCalled()
    expect(takeReviewAllowed(sid, 'tc-1')).toStrictEqual({ risk: 'high', summary: 'Deletes build' })
  })

  it('RE-2 审查 deny：以审查员的理由拒绝，不留标记', async () => {
    const sid = newSid('re')
    const { provider: p } = provider(reviewer(answerOf(verdict('deny', { risk: 'critical' }))))
    await expect(run(p, sid)).rejects.toThrow(/Blocked by the reviewer/)
    expect(takeReviewAllowed(sid, 'tc-1')).toBeUndefined()
  })

  it('RE-3 审查 ask：卡片带 {risk, summary, reason}、id 为 toolCallId；人批准之后没有标记', async () => {
    const sid = newSid('re')
    const { provider: p, requestUserInput } = provider(
      reviewer(
        answerOf(verdict('ask', { risk: 'medium', summary: 'Deletes build', reason: 'Unclear' }))
      )
    )
    await expect(run(p, sid)).resolves.toEqual({ status: 'allowed' })
    const card = onlyCard(requestUserInput)
    expect(card.id).toBe('tc-1')
    expect(card.review).toStrictEqual({
      risk: 'medium',
      summary: 'Deletes build',
      reason: 'Unclear'
    })
    expect(takeReviewAllowed(sid, 'tc-1')).toBeUndefined()
  })

  it.each<[string, Reviewer]>([
    ['接缝回 null', async () => null],
    [
      '接缝抛错',
      async () => {
        throw new Error('boom')
      }
    ],
    ["判决 risk 'severe'", async () => answerOf({ ...verdict('allow'), risk: 'severe' })]
  ])('RE-4 审查没给出可用结论（%s）：卡片无 review；人批准之后没有标记', async (_label, impl) => {
    const sid = newSid('re')
    const { provider: p, requestUserInput } = provider(vi.fn<Reviewer>(impl))
    await expect(run(p, sid)).resolves.toEqual({ status: 'allowed' })
    expect(onlyCard(requestUserInput).review).toBeUndefined()
    expect(takeReviewAllowed(sid, 'tc-1')).toBeUndefined()
  })

  it('RE-5 tier force-ask：不问审查、卡片无 review、不留标记', async () => {
    const sid = newSid('re')
    const review = reviewer(answerOf(verdict('allow', { risk: 'high' })))
    const { provider: p, requestUserInput } = provider(review)
    await expect(run(p, sid, { ...ASK, tier: 'force-ask' })).resolves.toEqual({ status: 'allowed' })
    expect(review).not.toHaveBeenCalled()
    expect(onlyCard(requestUserInput).review).toBeUndefined()
    expect(takeReviewAllowed(sid, 'tc-1')).toBeUndefined()
  })

  it.each<[string, PermissionRisk, PermissionRisk]>([
    ['先 low 后 high', 'low', 'high'],
    ['先 high 后 low', 'high', 'low']
  ])('RE-6 同一调用过两道门、审查都放行（%s）→ 取到 high', async (_label, first, second) => {
    const sid = newSid('re')
    const { provider: p } = provider(
      scripted([
        answerOf(verdict('allow', { risk: first, summary: first })),
        answerOf(verdict('allow', { risk: second, summary: second }))
      ])
    )
    await run(p, sid)
    await run(p, sid)
    expect(takeReviewAllowed(sid, 'tc-1')).toStrictEqual({ risk: 'high', summary: 'high' })
  })

  it("RE-7 toolCallId '' → 照常放行，不留标记", async () => {
    const sid = newSid('re')
    const { provider: p } = provider(reviewer(answerOf(verdict('allow', { risk: 'high' }))))
    await expect(run(p, sid, ASK, { toolCallId: '' })).resolves.toEqual({ status: 'allowed' })
    expect(takeReviewAllowed(sid, '')).toBeUndefined()
  })

  it('RE-8 审查期间工具调用被中止 → reject，不留标记（接缝随后才答 allow 也不算）', async () => {
    const sid = newSid('re')
    let resolveReview!: (answer: PermissionReviewAnswer | null) => void
    const review = vi.fn<Reviewer>(
      () =>
        new Promise<PermissionReviewAnswer | null>((resolve) => {
          resolveReview = resolve
        })
    )
    const { provider: p, requestUserInput } = provider(review)
    const controller = new AbortController()
    const pending = run(p, sid, ASK, { signal: controller.signal, abortError: 'Aborted' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(review).toHaveBeenCalledTimes(1)

    controller.abort()
    await expect(pending).rejects.toThrow('Aborted')
    resolveReview(answerOf(verdict('allow', { risk: 'high' })))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(requestUserInput).not.toHaveBeenCalled()
    expect(takeReviewAllowed(sid, 'tc-1')).toBeUndefined()
  })

  it.each<[string, SecurityDecision]>([
    ['allow', { effect: 'allow', tier: 'static-allow', matched: ['r1'], winning: 'r1' }],
    ['deny', { effect: 'deny', tier: 'deny', matched: ['d1'], winning: 'd1', reason: 'no' }]
  ])('RE-9 effect 直接是 %s → 不问审查、不留标记', async (effect, decision) => {
    const sid = newSid('re')
    const review = reviewer(answerOf(verdict('allow', { risk: 'high' })))
    const { provider: p } = provider(review)
    const outcome = run(p, sid, decision)
    if (effect === 'allow') await expect(outcome).resolves.toEqual({ status: 'allowed' })
    else await expect(outcome).rejects.toThrow('no')
    expect(review).not.toHaveBeenCalled()
    expect(takeReviewAllowed(sid, 'tc-1')).toBeUndefined()
  })

  describe('RE-10 同一调用两道门：后一道交给了人，先前的标记作废', () => {
    it.each<[string, InputResponse, 'allowed' | 'rejects' | 'feedback']>([
      ['人批准', { kind: 'ask', allowed: true }, 'allowed'],
      ['人拒绝', { kind: 'ask', allowed: false }, 'rejects'],
      ['人写 other（onOther:return）', { kind: 'other', text: 'use a temp dir' }, 'feedback']
    ])('第一道审查放行、第二道审查答 ask 且%s → 标记被撤掉', async (_label, response, expected) => {
      const sid = newSid('re')
      const { provider: p } = provider(
        scripted([
          answerOf(verdict('allow', { risk: 'medium', summary: 'first gate' })),
          answerOf(verdict('ask', { risk: 'high' }))
        ]),
        response
      )
      await run(p, sid)
      const second = run(p, sid, ASK, { onOther: 'return' })
      if (expected === 'allowed') await expect(second).resolves.toEqual({ status: 'allowed' })
      else if (expected === 'feedback') {
        await expect(second).resolves.toEqual({ status: 'feedback', text: 'use a temp dir' })
      } else await expect(second).rejects.toThrow()
      expect(takeReviewAllowed(sid, 'tc-1')).toBeUndefined()
    })

    it('第二道是没有审查的 ask 卡（force-ask）且人批准 → 标记同样被撤掉', async () => {
      const sid = newSid('re')
      const { provider: p } = provider(
        reviewer(answerOf(verdict('allow', { risk: 'medium', summary: 'first gate' })))
      )
      await run(p, sid)
      await run(p, sid, { ...ASK, tier: 'force-ask' })
      expect(takeReviewAllowed(sid, 'tc-1')).toBeUndefined()
    })

    it('顺序反过来（先人答、后审查放行）→ 标记留着（钉现状，已接受）', async () => {
      const sid = newSid('re')
      const { provider: p } = provider(
        scripted([
          answerOf(verdict('ask', { risk: 'high' })),
          answerOf(verdict('allow', { risk: 'low', summary: 'second gate' }))
        ])
      )
      await run(p, sid)
      await run(p, sid)
      expect(takeReviewAllowed(sid, 'tc-1')).toStrictEqual({ risk: 'low', summary: 'second gate' })
    })
  })

  describe('RE-11 审查员写给人看的两段话被截到上限', () => {
    const LONG_SUMMARY = 's'.repeat(301)
    const LONG_REASON = 'r'.repeat(1001)

    it('转给人：卡片上的 summary 截到 300、reason 截到 1000，都以 … 结尾', async () => {
      const sid = newSid('re')
      const { provider: p, requestUserInput } = provider(
        reviewer(answerOf(verdict('ask', { summary: LONG_SUMMARY, reason: LONG_REASON })))
      )
      await run(p, sid)
      const review = onlyCard(requestUserInput).review!
      expect(review.summary).toBe(`${'s'.repeat(300)}…`)
      expect(review.reason).toBe(`${'r'.repeat(1000)}…`)
    })

    it('恰在上限时不截、不加 …', async () => {
      const sid = newSid('re')
      const { provider: p, requestUserInput } = provider(
        reviewer(answerOf(verdict('ask', { summary: 's'.repeat(300), reason: 'r'.repeat(1000) })))
      )
      await run(p, sid)
      const review = onlyCard(requestUserInput).review!
      expect(review.summary).toBe('s'.repeat(300))
      expect(review.reason).toBe('r'.repeat(1000))
    })

    it('放行：标记上的 summary 同样截到 300 并以 … 结尾', async () => {
      const sid = newSid('re')
      const { provider: p } = provider(
        reviewer(answerOf(verdict('allow', { risk: 'low', summary: LONG_SUMMARY })))
      )
      await run(p, sid)
      expect(takeReviewAllowed(sid, 'tc-1')).toStrictEqual({
        risk: 'low',
        summary: `${'s'.repeat(300)}…`
      })
    })

    it('前后空白被 trim；只有空白的 summary 变成 ""', async () => {
      const sid = newSid('re')
      const { provider: p, requestUserInput } = provider(
        reviewer(answerOf(verdict('ask', { summary: '  Deletes build \n', reason: '\t why  ' })))
      )
      await run(p, sid)
      expect(onlyCard(requestUserInput).review).toStrictEqual({
        risk: 'low',
        summary: 'Deletes build',
        reason: 'why'
      })

      const sid2 = newSid('re')
      const { provider: p2 } = provider(
        reviewer(answerOf(verdict('allow', { risk: 'medium', summary: '   \n\t ' })))
      )
      await run(p2, sid2)
      expect(takeReviewAllowed(sid2, 'tc-1')).toStrictEqual({ risk: 'medium', summary: '' })
    })

    it('拒绝：抛给 agent 的文案里 reason 同样截到 1000', async () => {
      const sid = newSid('re')
      const { provider: p } = provider(reviewer(answerOf(verdict('deny', { reason: LONG_REASON }))))
      const message = await run(p, sid).then(
        () => '',
        (err: Error) => err.message
      )
      expect(message.startsWith(`Blocked by the reviewer: ${'r'.repeat(1000)}…\n\n`)).toBe(true)
      expect(message).not.toContain('r'.repeat(1001))
    })
  })
})
